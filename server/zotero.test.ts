import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
    createServer,
    type IncomingHttpHeaders,
    type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { FileSource } from './config.ts';
import { buildZip } from './zip.fixture.ts';
import { UpstreamError, ZoteroSource } from './zotero.ts';

const PDF = '%PDF-1.7 body';
const KEY = 'ABCD2345';

type Handler = (
    url: string,
    headers: IncomingHttpHeaders,
    res: ServerResponse,
) => void;

interface Upstream {
    origin: URL;
    requests: { url: string; headers: IncomingHttpHeaders }[];
}

async function upstream(t: TestContext, handle: Handler): Promise<Upstream> {
    const requests: Upstream['requests'] = [];
    const server = createServer((req, res) => {
        requests.push({ url: req.url ?? '', headers: req.headers });
        handle(req.url ?? '', req.headers, res);
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
    );
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    const { port } = server.address() as AddressInfo;
    return { origin: new URL(`http://127.0.0.1:${port}/`), requests };
}

function zoteroItems(filename = 'paper.pdf'): Handler {
    return (url, _headers, res) => {
        const item = (key: string, data: object) =>
            JSON.stringify({ key, data: { itemType: 'attachment', ...data } });
        if (url === `/api/items/${KEY}`) {
            res.writeHead(200);
            res.end(item(KEY, { contentType: 'application/pdf', filename }));
        } else if (url === '/api/items/HTML2345') {
            res.writeHead(200);
            res.end(item('HTML2345', { contentType: 'text/html' }));
        } else {
            res.writeHead(404);
            res.end();
        }
    };
}

function source(origin: URL, file: FileSource, apiKey?: string): ZoteroSource {
    return new ZoteroSource({
        endpoint: {
            protocol: 'http:',
            host: origin.hostname,
            port: Number(origin.port),
        },
        apiPath: '/api',
        file,
        timeoutMs: 5000,
        ...(apiKey ? { apiKey } : {}),
    });
}

const signal = () => AbortSignal.timeout(5000);
const status = (expected: number) => (error: unknown) =>
    error instanceof UpstreamError && error.status === expected;

test('file: PDF 以外の添付や存在しないキーは、取得方法によらず PDF を取りに行かない', async (t) => {
    const zotero = await upstream(t, zoteroItems());
    const files = source(zotero.origin, { kind: 'template', path: '/f/{key}' });
    for (const key of ['HTML2345', 'NONE2345'])
        await assert.rejects(files.file(key, signal()), status(404));
    assert.ok(zotero.requests.every(({ url }) => !url.startsWith('/f/')));
});

test('file(template): 経路のテンプレートにキーを入れて PDF を取得する', async (t) => {
    const zotero = await upstream(t, (url, headers, res) => {
        if (url === `/f/${KEY}`) {
            res.writeHead(200, { 'Content-Length': PDF.length });
            res.end(PDF);
        } else zoteroItems()(url, headers, res);
    });
    const body = await source(zotero.origin, {
        kind: 'template',
        path: '/f/{key}',
    }).file(KEY, signal());
    assert.equal(body.length, PDF.length);
    assert.equal(await text(body.stream), PDF);
});

test('file(local): Local API が返す file:// のパスを読む', async (t) => {
    const base = mkdtempSync(path.join(tmpdir(), 'pdf-deeplink-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(path.join(base, KEY));
    const pdfPath = path.join(base, KEY, 'paper.pdf');
    writeFileSync(pdfPath, PDF);
    const zotero = await upstream(t, (url, headers, res) => {
        if (url === `/api/items/${KEY}/file`) {
            res.writeHead(302, { Location: pathToFileURL(pdfPath).href });
            res.end();
        } else zoteroItems()(url, headers, res);
    });
    const files = source(zotero.origin, { kind: 'local', dirs: [base] });
    assert.equal(await text((await files.file(KEY, signal())).stream), PDF);
});

test('file(web): API キーを付けて要求し、HTTPS でない転送先には従わない', async (t) => {
    let location = 'http://127.0.0.1:1/file.pdf';
    const zotero = await upstream(t, (url, headers, res) => {
        if (url === `/api/items/${KEY}/file`) {
            res.writeHead(302, { Location: location });
            res.end();
        } else zoteroItems()(url, headers, res);
    });
    const files = source(zotero.origin, { kind: 'web' }, 'test-key');
    await assert.rejects(files.file(KEY, signal()), status(502));
    assert.ok(zotero.requests.length > 0);
    for (const { headers } of zotero.requests)
        assert.equal(headers['zotero-api-key'], 'test-key');
    location = 'relative/file.pdf';
    await assert.rejects(files.file(KEY, signal()), status(502));
});

test('file(webdav): 設定画面の URL の下の zotero/<キー>.zip から PDF を取り出す', async (t) => {
    const name = '松田-2025-入門.pdf';
    let archive = buildZip([
        { name: '.zotero-ft-cache', data: Buffer.from('cache') },
        {
            name: `${Buffer.from(name).toString('base64')}%ZB64`,
            data: Buffer.from(PDF),
            flags: 0,
        },
    ]);
    const zotero = await upstream(t, zoteroItems(name));
    const dav = await upstream(t, (url, headers, res) => {
        if (headers.authorization !== `Basic ${btoa('zotero: p a s s ')}`) {
            res.writeHead(401);
            res.end();
        } else if (url === `/dav/zotero/${KEY}.zip`) {
            res.writeHead(200);
            res.end(archive);
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    const webdav = (password: string) =>
        source(zotero.origin, {
            kind: 'webdav',
            url: new URL('dav', dav.origin),
            credentials: { username: 'zotero', password },
        });

    const body = await webdav(' p a s s ').file(KEY, signal());
    assert.equal(body.length, PDF.length);
    assert.equal(await text(body.stream), PDF);

    archive = Buffer.from('not a zip');
    await assert.rejects(webdav(' p a s s ').file(KEY, signal()), status(502));
});

test('file(webdav): 上限を超えるサイズを申告する応答は読まずに失敗とする', async (t) => {
    const zotero = await upstream(t, zoteroItems());
    const dav = await upstream(t, (_url, _headers, res) => {
        res.writeHead(200, { 'Content-Length': String(1024 * 1024 * 1024) });
        res.flushHeaders();
    });
    await assert.rejects(
        source(zotero.origin, {
            kind: 'webdav',
            url: dav.origin,
        }).file(KEY, signal()),
        status(502),
    );
});
