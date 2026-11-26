import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
    entryName,
    followRedirects,
    isInside,
    localPathOf,
    openLocalFile,
    pickEntry,
    resolveRoots,
    webdavArchiveUrl,
} from './files.ts';
import { get, UpstreamError } from './http.ts';
import type { ZipEntry } from './zip.ts';

const entry = (name: string): ZipEntry => ({
    name,
    flags: 0,
    method: 8,
    crc: 0,
    compressedSize: 0,
    uncompressedSize: 0,
    localOffset: 0,
});

test('entryName: %ZB64 で終わる名前を Base64 として解読する', () => {
    const name = '松田-2025-入門.pdf';
    const encoded = `${Buffer.from(name).toString('base64')}%ZB64`;
    assert.equal(entryName(entry(encoded)), name);
    assert.equal(entryName(entry('plain.pdf')), 'plain.pdf');
});

test('pickEntry: 添付のファイル名と一致するエントリを選ぶ', () => {
    const entries = [entry('a.pdf'), entry('b.pdf')];
    assert.equal(pickEntry(entries, 'b.pdf'), entries[1]);
});

test('pickEntry: 一致するものがなければ唯一のファイルを選び、候補が複数なら選ばない', () => {
    const only = [entry('.zotero-ft-cache'), entry('dir/'), entry('x.pdf')];
    assert.equal(pickEntry(only, 'renamed.pdf'), only[2]);
    assert.equal(pickEntry(only, undefined), only[2]);
    assert.equal(pickEntry([entry('a.pdf'), entry('b.pdf')], 'c.pdf'), null);
    assert.equal(pickEntry([entry('a.pdf'), entry('a.pdf')], 'a.pdf'), null);
});

test('isInside: 許可ディレクトリの中だけを真とする', () => {
    const root = path.resolve('/data/storage');
    assert.equal(isInside(root, path.join(root, 'KEY', 'a.pdf')), true);
    assert.equal(isInside(root, path.join(root, '..draft.pdf')), true);
    assert.equal(isInside(root, root), false);
    assert.equal(isInside(root, path.resolve('/data/storage2/a.pdf')), false);
    assert.equal(isInside(root, path.resolve('/data/other/a.pdf')), false);
    if (process.platform === 'win32')
        assert.equal(isInside('C:\\data', 'D:\\data\\a.pdf'), false);
});

test('localPathOf: ホストやクエリを含む file URL と file 以外の URL を拒否する', () => {
    const file = path.resolve('/data/storage/KEY/a b.pdf');
    assert.equal(localPathOf(pathToFileURL(file).href), file);
    assert.equal(localPathOf('file://server/share/a.pdf'), null);
    assert.equal(localPathOf(`${pathToFileURL(file).href}?x=1`), null);
    assert.equal(localPathOf('https://example.com/a.pdf'), null);
    assert.equal(localPathOf('not a url'), null);
});

test('webdavArchiveUrl: 設定画面の URL の下の zotero/<キー>.zip を指す', () => {
    for (const base of ['https://dav.example/dav', 'https://dav.example/dav/'])
        assert.equal(
            webdavArchiveUrl(new URL(base), 'ABCD2345').href,
            'https://dav.example/dav/zotero/ABCD2345.zip',
        );
    assert.equal(
        webdavArchiveUrl(new URL('https://dav.example'), 'ABCD2345').href,
        'https://dav.example/zotero/ABCD2345.zip',
    );
});

test('openLocalFile: 許可ディレクトリの外を指すファイルとリンクは読まない', async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'pdf-deeplink-'));
    const storage = path.join(base, 'storage');
    const outside = path.join(base, 'storage2');
    mkdirSync(path.join(storage, 'KEY'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(storage, 'KEY', 'a.pdf'), '%PDF-inside');
    writeFileSync(path.join(outside, 'b.pdf'), '%PDF-outside');
    symlinkSync(outside, path.join(storage, 'link'), 'junction');
    const roots = resolveRoots([storage]);
    const url = (file: string) => pathToFileURL(file).href;

    const body = await openLocalFile(
        roots,
        url(path.join(storage, 'KEY', 'a.pdf')),
        'KEY',
    );
    assert.equal(body.length, '%PDF-inside'.length);
    body.stream.destroy();

    for (const target of [
        path.join(outside, 'b.pdf'),
        path.join(storage, 'link', 'b.pdf'),
        path.join(storage, 'KEY'),
    ]) {
        await assert.rejects(
            openLocalFile(roots, url(target), 'KEY'),
            (error: unknown) =>
                error instanceof UpstreamError && error.status === 403,
            target,
        );
    }
    await assert.rejects(
        openLocalFile(roots, url(path.join(storage, 'none.pdf')), 'KEY'),
        (error: unknown) =>
            error instanceof UpstreamError && error.status === 404,
    );
});

test('followRedirects: HTTPS 以外への転送には従わない', async () => {
    const server = createServer((req, res) => {
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: 'http://127.0.0.1/a.pdf' });
            res.end();
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const endpoint = { protocol: 'http:' as const, host: '127.0.0.1', port };
    const fetchFrom = async (path: string) =>
        followRedirects(
            await get(endpoint, path, {
                headers: {},
                timeoutMs: 5000,
                signal: AbortSignal.timeout(5000),
                label: path,
            }),
            5000,
            AbortSignal.timeout(5000),
        );
    try {
        await assert.rejects(fetchFrom('/redirect'), /non-HTTPS/);
        await assert.rejects(
            fetchFrom('/missing'),
            (error: unknown) =>
                error instanceof UpstreamError && error.status === 404,
        );
    } finally {
        server.close();
    }
});
