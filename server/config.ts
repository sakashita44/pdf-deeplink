import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebdavCredentials } from './files.ts';
import { parseEndpoint, type Endpoint } from './http.ts';

export type Listen = { socketPath: string } | { host: string; port: number };

export type FileSource =
    | { kind: 'template'; path: string }
    | { kind: 'local'; dirs: string[] }
    | { kind: 'web' }
    | { kind: 'webdav'; url: URL; credentials?: WebdavCredentials };

export interface Config {
    listen: Listen;
    allowedHosts: Set<string>;
    staticDir: string;
    zotero: {
        endpoint: Endpoint;
        apiPath: string;
        apiKey?: string;
        file: FileSource;
        timeoutMs: number;
    };
}

const PREFIX = 'PDF_DEEPLINK_ZOTERO_';
const FILE_SOURCE_VARIABLES: Record<FileSource['kind'], string[]> = {
    template: ['FILE_PATH'],
    local: ['LOCAL_DIRS'],
    web: [],
    webdav: [
        'WEBDAV_URL',
        'WEBDAV_USERNAME',
        'WEBDAV_PASSWORD',
        'WEBDAV_PASSWORD_FILE',
    ],
};

export function loadConfig(env: NodeJS.ProcessEnv): Config {
    const apiKey = secret(env, 'API_KEY');
    return {
        listen: parseListen(env.PDF_DEEPLINK_LISTEN ?? '127.0.0.1:8787'),
        allowedHosts: new Set(
            (env.PDF_DEEPLINK_ALLOWED_HOSTS ?? 'localhost,127.0.0.1')
                .split(',')
                .map((host) => host.trim().toLowerCase())
                .filter(Boolean),
        ),
        staticDir:
            env.PDF_DEEPLINK_STATIC_DIR ??
            fileURLToPath(new URL('../dist/', import.meta.url)),
        zotero: {
            endpoint: parseEndpoint(
                env.PDF_DEEPLINK_ZOTERO_ENDPOINT ?? 'http://127.0.0.1:23119',
            ),
            apiPath: env.PDF_DEEPLINK_ZOTERO_API_PATH ?? '/api/users/0',
            ...(apiKey === undefined ? {} : { apiKey }),
            file: parseFileSource(env),
            timeoutMs: positiveInteger(
                env.PDF_DEEPLINK_ZOTERO_TIMEOUT_MS ?? '30000',
                'PDF_DEEPLINK_ZOTERO_TIMEOUT_MS',
            ),
        },
    };
}

function parseFileSource(env: NodeJS.ProcessEnv): FileSource {
    const kind = fileSourceKind(env);
    for (const [other, names] of Object.entries(FILE_SOURCE_VARIABLES)) {
        if (other === kind) continue;
        for (const name of names) {
            if (env[PREFIX + name] !== undefined)
                throw new Error(
                    `${PREFIX}${name} is not used with ${PREFIX}FILE_SOURCE=${kind}`,
                );
        }
    }
    switch (kind) {
        case 'template': {
            const filePath = env.PDF_DEEPLINK_ZOTERO_FILE_PATH;
            if (!filePath) throw new Error(`${PREFIX}FILE_PATH is required`);
            if (!filePath.includes('{key}'))
                throw new Error(`${PREFIX}FILE_PATH must contain {key}`);
            return { kind, path: filePath };
        }
        case 'local':
            return {
                kind,
                dirs: parseDirs(env.PDF_DEEPLINK_ZOTERO_LOCAL_DIRS),
            };
        case 'web':
            return { kind };
        case 'webdav': {
            const credentials = webdavCredentials(env);
            return {
                kind,
                url: parseWebdavUrl(env.PDF_DEEPLINK_ZOTERO_WEBDAV_URL),
                ...(credentials ? { credentials } : {}),
            };
        }
    }
}

function fileSourceKind(env: NodeJS.ProcessEnv): FileSource['kind'] {
    const value = env.PDF_DEEPLINK_ZOTERO_FILE_SOURCE;
    if (value === undefined) {
        if (env.PDF_DEEPLINK_ZOTERO_FILE_PATH !== undefined) return 'template';
        throw new Error(
            `${PREFIX}FILE_SOURCE is required (template, local, web or webdav)`,
        );
    }
    if (!Object.hasOwn(FILE_SOURCE_VARIABLES, value))
        throw new Error(`invalid ${PREFIX}FILE_SOURCE: ${value}`);
    return value as FileSource['kind'];
}

function parseDirs(value: string | undefined): string[] {
    if (!value) throw new Error(`${PREFIX}LOCAL_DIRS is required`);
    const dirs = value.split(path.delimiter);
    for (const dir of dirs) {
        if (!path.isAbsolute(dir))
            throw new Error(
                `${PREFIX}LOCAL_DIRS must list absolute paths separated by "${path.delimiter}"`,
            );
    }
    return dirs;
}

function parseWebdavUrl(value: string | undefined): URL {
    if (!value) throw new Error(`${PREFIX}WEBDAV_URL is required`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${PREFIX}WEBDAV_URL is not a valid URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error(`${PREFIX}WEBDAV_URL must be an http or https URL`);
    if (url.username || url.password)
        throw new Error(
            `${PREFIX}WEBDAV_URL must not contain credentials; use ${PREFIX}WEBDAV_USERNAME and ${PREFIX}WEBDAV_PASSWORD`,
        );
    if (url.search || url.hash)
        throw new Error(
            `${PREFIX}WEBDAV_URL must not contain a query or fragment`,
        );
    return url;
}

function webdavCredentials(
    env: NodeJS.ProcessEnv,
): WebdavCredentials | undefined {
    const username = env.PDF_DEEPLINK_ZOTERO_WEBDAV_USERNAME;
    const password = secret(env, 'WEBDAV_PASSWORD');
    if (username === undefined && password === undefined) return undefined;
    if (!username || password === undefined)
        throw new Error(
            `${PREFIX}WEBDAV_USERNAME and ${PREFIX}WEBDAV_PASSWORD must be set together`,
        );
    if (username.includes(':'))
        throw new Error(`${PREFIX}WEBDAV_USERNAME must not contain ":"`);
    return { username, password };
}

function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const direct = env[PREFIX + name];
    const file = env[`${PREFIX}${name}_FILE`];
    if (direct !== undefined && file !== undefined)
        throw new Error(
            `set either ${PREFIX}${name} or ${PREFIX}${name}_FILE, not both`,
        );
    let value: string;
    if (file !== undefined) {
        try {
            value = readFileSync(file, 'utf8');
        } catch {
            throw new Error(`cannot read ${PREFIX}${name}_FILE`);
        }
        value = value.replace(/^\u{FEFF}/u, '').replace(/\r?\n$/, '');
    } else if (direct !== undefined) {
        value = direct;
    } else {
        return undefined;
    }
    if (value === '') throw new Error(`${PREFIX}${name} is empty`);
    if (/[\r\n]/.test(value))
        throw new Error(`${PREFIX}${name} must be a single line`);
    return value;
}

function parseListen(value: string): Listen {
    if (value.startsWith('unix:'))
        return { socketPath: value.slice('unix:'.length) };
    const match = /^(.+):(\d{1,5})$/.exec(value);
    if (!match) throw new Error(`invalid PDF_DEEPLINK_LISTEN: ${value}`);
    return { host: match[1]!, port: Number(match[2]) };
}

function positiveInteger(value: string, name: string): number {
    const number = Number(value);
    if (!/^\d+$/.test(value) || number <= 0)
        throw new Error(`invalid ${name}: ${value}`);
    return number;
}
