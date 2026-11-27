import assert from 'node:assert/strict';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { text } from 'node:stream/consumers';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { openLocalFile, resolveRoots } from './files.ts';
import { UpstreamError } from './http.ts';

const status = (expected: number) => (error: unknown) =>
    error instanceof UpstreamError && error.status === expected;

test('openLocalFile: 許可ディレクトリの中の通常のファイルだけを読む', async (t) => {
    const base = mkdtempSync(path.join(tmpdir(), 'pdf-deeplink-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const storage = path.join(base, 'storage');
    const sibling = path.join(base, 'storage2');
    mkdirSync(path.join(storage, 'KEY'), { recursive: true });
    mkdirSync(sibling);
    writeFileSync(path.join(storage, 'KEY', 'a b.pdf'), '%PDF-inside');
    writeFileSync(path.join(storage, '..draft.pdf'), '%PDF-draft');
    writeFileSync(path.join(sibling, 'b.pdf'), '%PDF-outside');
    symlinkSync(sibling, path.join(storage, 'link'), 'junction');
    const roots = resolveRoots([storage]);
    const url = (file: string) => pathToFileURL(file).href;

    for (const [file, content] of [
        [path.join(storage, 'KEY', 'a b.pdf'), '%PDF-inside'],
        [path.join(storage, '..draft.pdf'), '%PDF-draft'],
    ] as const) {
        const body = await openLocalFile(roots, url(file), 'KEY');
        assert.equal(body.length, content.length);
        assert.equal(await text(body.stream), content);
    }

    for (const target of [
        path.join(sibling, 'b.pdf'),
        path.join(storage, 'link', 'b.pdf'),
        path.join(storage, 'KEY'),
    ])
        await assert.rejects(
            openLocalFile(roots, url(target), 'KEY'),
            status(403),
            target,
        );

    for (const location of [
        'file://server/share/a.pdf',
        `${url(path.join(storage, 'KEY', 'a b.pdf'))}?x=1`,
        'https://example.com/a.pdf',
    ])
        await assert.rejects(
            openLocalFile(roots, location, 'KEY'),
            status(502),
            location,
        );
});
