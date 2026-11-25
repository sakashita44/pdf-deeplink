import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mergeLineRects, toLinkRect, toUserSpace, type PageGeometry, type Point } from './geometry.ts';
import type { Rect } from './link.ts';

interface Vectors {
    toLinkRect: { name: string; page: PageGeometry; a: Point; b: Point; rect: Rect }[];
    toUserSpace: { name: string; page: PageGeometry; rect: Rect; userSpace: number[] }[];
    mergeLineRects: { name: string; rects: Rect[]; merged: Rect[] }[];
}

const vectors: Vectors = JSON.parse(readFileSync(new URL('../spec/geometry-vectors.json', import.meta.url), 'utf8'));

for (const vector of vectors.toLinkRect) {
    test(`toLinkRect: ${vector.name}`, () => {
        assert.deepEqual(toLinkRect(vector.page, vector.a, vector.b), vector.rect);
    });
}

for (const vector of vectors.toUserSpace) {
    test(`toUserSpace: ${vector.name}`, () => {
        assert.deepEqual(toUserSpace(vector.page, vector.rect), vector.userSpace);
    });
}

for (const vector of vectors.mergeLineRects) {
    test(`mergeLineRects: ${vector.name}`, () => {
        assert.deepEqual(mergeLineRects(vector.rects), vector.merged);
    });
}
