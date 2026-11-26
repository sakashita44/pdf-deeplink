import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatLink, parseLink, type PdfLink } from './link.ts';

interface Vectors {
    parse: { name: string; query: string; link?: PdfLink; error?: string }[];
    format: { name: string; link: PdfLink; query: string }[];
}

const vectors: Vectors = JSON.parse(
    readFileSync(new URL('../spec/link-vectors.json', import.meta.url), 'utf8'),
);

for (const vector of vectors.parse) {
    test(`parse: ${vector.name}`, () => {
        const result = parseLink(new URLSearchParams(vector.query));
        if (vector.error) {
            assert.deepEqual(result, { ok: false, error: vector.error });
        } else {
            assert.deepEqual(result, { ok: true, link: vector.link });
        }
    });
}

for (const vector of vectors.format) {
    test(`format: ${vector.name}`, () => {
        assert.equal(formatLink(vector.link), vector.query);
        const reparsed = parseLink(new URLSearchParams(vector.query));
        assert.ok(reparsed.ok);
    });
}
