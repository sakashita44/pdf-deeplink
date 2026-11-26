import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';
import { pipeline } from 'node:stream/promises';
import { isValidSrc } from '../shared/link.ts';
import { loadConfig } from './config.ts';
import { createStaticHandler } from './static.ts';
import {
    SORT_KEYS,
    UpstreamError,
    ZoteroSource,
    type SearchOptions,
    type SortKey,
} from './zotero.ts';

const config = loadConfig(process.env);
const zotero = new ZoteroSource(config.zotero);
const serveStatic = createStaticHandler(config.staticDir);

const DOCUMENT_ROUTE = /^\/app\/documents\/([^/]+)(\/file)?$/;
const SECURITY_HEADERS = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
};

class RequestError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

const server = createServer(async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => {
        if (!res.writableFinished) controller.abort();
    });
    try {
        const url = parseUrl(req.url);
        checkOrigin(req, url);
        if (req.method !== 'GET')
            throw new RequestError(405, 'method not allowed');
        if (!url.pathname.startsWith('/app/')) {
            if (serveStatic?.(url.pathname, res)) return;
            throw new RequestError(404, 'not found');
        }
        await handleApi(url, res, controller.signal);
    } catch (error) {
        if (controller.signal.aborted) return;
        if (res.headersSent) {
            res.destroy(error as Error);
            return;
        }
        if (error instanceof RequestError)
            return sendJson(res, error.status, { error: error.message });
        if (error instanceof UpstreamError) {
            console.error(error.message);
            if (error.status === 404)
                return sendJson(res, 404, { error: 'not found' });
            return sendJson(res, error.status === 504 ? 504 : 502, {
                error: 'the document source returned an error',
            });
        }
        console.error(error);
        return sendJson(res, 502, {
            error: 'the document source is unreachable',
        });
    }
});

async function handleApi(
    url: URL,
    res: ServerResponse,
    signal: AbortSignal,
): Promise<void> {
    if (url.pathname === '/app/documents') {
        return sendJson(
            res,
            200,
            await zotero.search(parseSearchOptions(url.searchParams), signal),
        );
    }
    const match = DOCUMENT_ROUTE.exec(url.pathname);
    if (!match) throw new RequestError(404, 'not found');
    const src = decodeSegment(match[1] ?? '');
    if (!isValidSrc(src)) throw new RequestError(400, 'invalid src');
    const key = src.slice('zotero:'.length);
    if (match[2]) {
        const upstream = await zotero.file(key, signal);
        res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'application/pdf',
            // ビューアは fetch() でバイト列を読む。この URL を直接開いた場合に、ブラウザが同一オリジン上で PDF をインライン表示しないようにする。
            'Content-Disposition': 'attachment',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            ...(upstream.length === undefined
                ? {}
                : { 'Content-Length': String(upstream.length) }),
        });
        await pipeline(upstream.stream, res, { signal });
        return;
    }
    const metadata = await zotero.metadata(key, signal);
    if (!metadata) throw new RequestError(404, 'not found');
    sendJson(res, 200, metadata);
}

// ループバックで待ち受けていても、DNS リバインディングや他サイトのページからブラウザ経由で要求が届く。Sec-Fetch-Site はスクリプトから設定できないヘッダである。
function checkOrigin(req: IncomingMessage, url: URL): void {
    const host = req.headers.host?.toLowerCase().replace(/:\d{1,5}$/, '');
    if (!host || !config.allowedHosts.has(host))
        throw new RequestError(403, 'host is not allowed');
    if (
        !url.pathname.startsWith('/app/') &&
        req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document'
    )
        return;
    const fetchSite = req.headers['sec-fetch-site'];
    if (
        fetchSite !== undefined &&
        fetchSite !== 'same-origin' &&
        fetchSite !== 'none'
    ) {
        throw new RequestError(403, 'cross-site requests are not accepted');
    }
}

function parseSearchOptions(params: URLSearchParams): SearchOptions {
    const sort = params.get('sort') ?? 'dateModified';
    const direction =
        params.get('direction') ??
        (sort === 'dateModified' || sort === 'dateAdded' ? 'desc' : 'asc');
    if (!(SORT_KEYS as readonly string[]).includes(sort))
        throw new RequestError(400, 'invalid sort');
    if (direction !== 'asc' && direction !== 'desc')
        throw new RequestError(400, 'invalid direction');
    return {
        query: params.get('q') ?? '',
        sort: sort as SortKey,
        direction,
        start: integerParam(params, 'start', 0, 0, 1_000_000),
        limit: integerParam(params, 'limit', 50, 1, 100),
    };
}

function integerParam(
    params: URLSearchParams,
    name: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const text = params.get(name);
    if (text === null || text === '') return fallback;
    const value = Number(text);
    if (!/^\d+$/.test(text) || value < min || value > max)
        throw new RequestError(400, `invalid ${name}`);
    return value;
}

function parseUrl(target: string | undefined): URL {
    try {
        return new URL(target ?? '/', 'http://localhost');
    } catch {
        throw new RequestError(400, 'invalid request target');
    }
}

function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        throw new RequestError(400, 'invalid src');
    }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(body));
}

if ('socketPath' in config.listen) {
    const { socketPath } = config.listen;
    if (existsSync(socketPath)) unlinkSync(socketPath);
    server.listen(socketPath, () => {
        chmodSync(socketPath, 0o660);
        console.log(`listening on unix:${socketPath}`);
    });
} else {
    const { host, port } = config.listen;
    server.listen(port, host, () =>
        console.log(`listening on http://${host}:${port}`),
    );
}
