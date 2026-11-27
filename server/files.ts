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

// fs.realpath の JavaScript 実装は Windows の 8.3 形式の短い名前や大文字小文字を正規化しないため、OS の API を呼ぶ native 版を用いる。
const realpathNative = promisify(realpath.native);
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export function bodyOf(response: IncomingMessage): FileBody {
    const length = Number(response.headers['content-length']);
    return {
        stream: response,
        ...(Number.isSafeInteger(length) && length >= 0 ? { length } : {}),
    };
}

export function discard(response: IncomingMessage, label: string): never {
    // Node.js の IncomingMessage は本文を読み切らないとソケットが解放されないため、例外を投げる前に読み捨てる。
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

// Windows の realpath.native は長いパスなどで拡張プレフィックス \\?\ を付けて返す場合があるため、ドライブ文字付きのパスから取り除く。
function canonical(value: string): string {
    return /^\\\\\?\\[A-Za-z]:\\/.test(value) ? value.slice(4) : value;
}

function isInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        // Windows で root と target が異なるドライブにある場合、path.relative は ".." で始まらない絶対パスを返す。
        !path.isAbsolute(relative)
    );
}

function localPathOf(location: string): string | null {
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
    // fileURLToPath は Windows で file://localhost/... を UNC パス（\\...）へ、POSIX で file:////... を "//" で始まるパスへ変換する。
    if (filePath.startsWith('\\\\') || filePath.startsWith('//')) return null;
    // NTFS はドライブ文字より後ろの ":" を代替データストリームの区切りとして解釈し、fileURLToPath もこれを拒否しない。
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
    // Windows の fs.constants には O_NOFOLLOW がない。O_NOFOLLOW は realpath の後でのシンボリックリンクへの差し替えを防ぎ、O_NONBLOCK は FIFO を開いたときに書き込み側を待って止まるのを防ぐ。
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
        // Zotero Web API の /file は署名付きの URL へ転送するため、転送先には Zotero-API-Key を送らない。
        response = await get(endpointOf(url), url.pathname + url.search, {
            headers: {},
            timeoutMs,
            signal,
            label: 'file download',
        });
    }
}

function webdavArchiveUrl(base: URL, key: string): URL {
    const directory = new URL(base);
    if (!directory.pathname.endsWith('/')) directory.pathname += '/';
    // Zotero の WebDAV 同期は、設定画面に入れた URL の下の zotero/<キー>.zip に添付を置く。
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

function entryName(entry: ZipEntry): string {
    // Zotero は zip の中のファイル名が %ZB64 で終わる場合、それを除いた部分を UTF-8 の Base64 として解読する。
    return entry.name.endsWith('%ZB64')
        ? Buffer.from(entry.name.slice(0, -'%ZB64'.length), 'base64').toString(
              'utf8',
          )
        : entry.name;
}

function pickEntry(
    entries: ZipEntry[],
    filename: string | undefined,
): ZipEntry | null {
    const files = entries
        .map((entry) => ({ entry, name: entryName(entry) }))
        // Zotero も展開するときに .zotero で始まるエントリ（全文検索の索引など）を読み飛ばす。
        .filter(
            ({ name }) => !name.endsWith('/') && !name.startsWith('.zotero'),
        );
    const matches = files.filter(({ name }) => name === filename);
    if (matches.length === 1) return matches[0]!.entry;
    // Zotero も、zip の中のファイルが 1 つだけなら、添付のファイル名と一致しなくてもそのファイルを使う。
    if (matches.length === 0 && files.length === 1) return files[0]!.entry;
    return null;
}
