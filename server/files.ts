import { constants, realpath, realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { endpointOf, get, readBody, UpstreamError } from './http.ts';
import { listEntries, readEntry, ZipError, type ZipEntry } from './zip.ts';

export interface FileBody {
    stream: Readable;
    length?: number;
}

export interface WebdavCredentials {
    username: string;
    password: string;
}

const realpathNative = promisify(realpath.native);
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export function bodyOf(response: IncomingMessage): FileBody {
    const length = Number(response.headers['content-length']);
    return {
        stream: response,
        ...(Number.isSafeInteger(length) && length >= 0 ? { length } : {}),
    };
}

export function discard(response: IncomingMessage, label: string): never {
    response.resume();
    throw new UpstreamError(
        response.statusCode ?? 502,
        `${label} returned ${response.statusCode}`,
    );
}

export function resolveRoots(dirs: string[]): string[] {
    return dirs.map((dir) => {
        const real = canonical(realpathSync.native(dir));
        if (!statSync(real).isDirectory())
            throw new Error(`not a directory: ${dir}`);
        return real;
    });
}

function canonical(value: string): string {
    return /^\\\\\?\\[A-Za-z]:\\/.test(value) ? value.slice(4) : value;
}

export function isInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

export function localPathOf(location: string): string | null {
    let url: URL;
    try {
        url = new URL(location);
    } catch {
        return null;
    }
    if (
        url.protocol !== 'file:' ||
        (url.hostname !== '' && url.hostname !== 'localhost') ||
        url.search ||
        url.hash
    )
        return null;
    let filePath: string;
    try {
        filePath = fileURLToPath(url);
    } catch {
        return null;
    }
    if (filePath.startsWith('\\\\') || filePath.startsWith('//')) return null;
    if (process.platform === 'win32' && filePath.slice(2).includes(':'))
        return null;
    return filePath;
}

export async function openLocalFile(
    roots: string[],
    location: string | undefined,
    key: string,
): Promise<FileBody> {
    const filePath = location ? localPathOf(location) : null;
    if (!filePath)
        throw new UpstreamError(
            502,
            `${key}: the file location is not a local path`,
        );
    let real: string;
    try {
        real = canonical(await realpathNative(filePath));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            throw new UpstreamError(404, `${key}: the file does not exist`);
        throw error;
    }
    if (!roots.some((root) => isInside(root, real)))
        throw new UpstreamError(
            403,
            `${key}: the file is outside the allowed directories`,
        );
    const flags =
        constants.O_NOFOLLOW === undefined
            ? constants.O_RDONLY
            : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const handle = await open(real, flags);
    try {
        const stats = await handle.stat();
        if (!stats.isFile())
            throw new UpstreamError(
                403,
                `${key}: the file is not a regular file`,
            );
        return { stream: handle.createReadStream(), length: stats.size };
    } catch (error) {
        await handle.close();
        throw error;
    }
}

export async function followRedirects(
    first: IncomingMessage,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<FileBody> {
    let response = first;
    for (let hop = 0; ; hop++) {
        if (response.statusCode === 200) return bodyOf(response);
        if (!REDIRECT_STATUSES.has(response.statusCode ?? 0))
            discard(response, hop === 0 ? 'file request' : 'file download');
        const location = response.headers.location;
        response.resume();
        if (hop >= MAX_REDIRECTS)
            throw new UpstreamError(
                502,
                'file download redirected too many times',
            );
        let url: URL;
        try {
            url = new URL(location ?? '');
        } catch {
            throw new UpstreamError(
                502,
                'file request redirected to an invalid location',
            );
        }
        if (url.protocol !== 'https:')
            throw new UpstreamError(
                502,
                'file request redirected to a non-HTTPS location',
            );
        response = await get(endpointOf(url), url.pathname + url.search, {
            headers: {},
            timeoutMs,
            signal,
            label: 'file download',
        });
    }
}

export function webdavArchiveUrl(base: URL, key: string): URL {
    const directory = new URL(base);
    if (!directory.pathname.endsWith('/')) directory.pathname += '/';
    return new URL(`zotero/${key}.zip`, directory);
}

export async function fetchWebdavFile(
    base: URL,
    credentials: WebdavCredentials | undefined,
    key: string,
    filename: string | undefined,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<FileBody> {
    const url = webdavArchiveUrl(base, key);
    const response = await get(endpointOf(url), url.pathname, {
        headers: credentials
            ? {
                  Authorization: `Basic ${Buffer.from(
                      `${credentials.username}:${credentials.password}`,
                  ).toString('base64')}`,
              }
            : {},
        timeoutMs,
        signal,
        label: 'WebDAV request',
    });
    if (response.statusCode !== 200) discard(response, 'WebDAV request');
    const archive = await readBody(
        response,
        MAX_ARCHIVE_BYTES,
        'WebDAV request',
    );
    try {
        const entry = pickEntry(listEntries(archive), filename);
        if (!entry)
            throw new UpstreamError(
                502,
                `${key}: the archive has no matching file`,
            );
        const content = readEntry(archive, entry, MAX_ARCHIVE_BYTES);
        return { stream: Readable.from([content]), length: content.length };
    } catch (error) {
        if (error instanceof ZipError)
            throw new UpstreamError(502, `${key}: ${error.message}`);
        throw error;
    }
}

export function entryName(entry: ZipEntry): string {
    return entry.name.endsWith('%ZB64')
        ? Buffer.from(entry.name.slice(0, -'%ZB64'.length), 'base64').toString(
              'utf8',
          )
        : entry.name;
}

export function pickEntry(
    entries: ZipEntry[],
    filename: string | undefined,
): ZipEntry | null {
    const files = entries
        .map((entry) => ({ entry, name: entryName(entry) }))
        .filter(
            ({ name }) => !name.endsWith('/') && !name.startsWith('.zotero'),
        );
    const matches = files.filter(({ name }) => name === filename);
    if (matches.length === 1) return matches[0]!.entry;
    if (matches.length === 0 && files.length === 1) return files[0]!.entry;
    return null;
}
