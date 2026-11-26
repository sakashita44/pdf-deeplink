import { fileURLToPath } from 'node:url';
import { parseEndpoint, type Endpoint } from './zotero.ts';

export type Listen = { socketPath: string } | { host: string; port: number };

export interface Config {
    listen: Listen;
    allowedHosts: Set<string>;
    staticDir: string;
    zotero: {
        endpoint: Endpoint;
        apiPath: string;
        filePath: string;
        timeoutMs: number;
    };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
    const filePath = env.PDF_DEEPLINK_ZOTERO_FILE_PATH;
    if (!filePath) throw new Error('PDF_DEEPLINK_ZOTERO_FILE_PATH is required');
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
            filePath,
            timeoutMs: positiveInteger(
                env.PDF_DEEPLINK_ZOTERO_TIMEOUT_MS ?? '30000',
                'PDF_DEEPLINK_ZOTERO_TIMEOUT_MS',
            ),
        },
    };
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
