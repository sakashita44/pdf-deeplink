import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    citation,
    labelRange,
    linkSituation,
    notice,
    pagesText,
} from './notation.ts';

const one = [{ page: 3, rects: [[0, 0, 1, 1] as const] }];
const two = [
    { page: 3, rects: [[0, 0, 1, 1] as const] },
    { page: 4, rects: [[0, 0, 1, 1] as const] },
];
const labels = ['i', 'ii', '1', '2'];
const labelOf = (page: number) => labels[page - 1];

test('pagesText: ページラベルがあればそれを使う', () => {
    assert.equal(pagesText({ regions: two, label: '1–2' }), 'p.1–2');
});

test('pagesText: ページラベルがなければページ番号の範囲にする', () => {
    assert.equal(pagesText({ regions: one }), 'p.3');
    assert.equal(pagesText({ regions: two }), 'p.3–4');
});

test('labelRange: 最初と最後のページのラベルを結ぶ', () => {
    assert.equal(labelRange(one, labelOf), '1');
    assert.equal(labelRange(two, labelOf), '1–2');
});

test('labelRange: どちらかのページにラベルがなければ返さない', () => {
    assert.equal(
        labelRange([...two, { page: 5, rects: [[0, 0, 1, 1]] }], labelOf),
        undefined,
    );
    assert.equal(
        labelRange(two, () => undefined),
        undefined,
    );
});

test('linkSituation: 最後のページが PDF のページ数を超えると missing', () => {
    assert.equal(
        linkSituation({ regions: two, sha256: 'ab' }, 3, 'abcd'),
        'missing',
    );
});

test('linkSituation: SHA-256 の先頭が一致すれば same、しなければ updated', () => {
    assert.equal(
        linkSituation({ regions: two, sha256: 'ab' }, 4, 'abcd'),
        'same',
    );
    assert.equal(
        linkSituation({ regions: two, sha256: 'ff' }, 4, 'abcd'),
        'updated',
    );
});

test('notice: 更新された PDF では移動でき、目印があれば検索できる', () => {
    assert.deepEqual(notice({ regions: two, q: '図2' }, 'updated'), {
        message:
            'この PDF はリンクの作成後に更新されています。強調表示の位置がずれている場合は、「目印で検索」で該当箇所を探してください。',
        detail: '作成時の箇所: p.3–4「図2」',
        canJump: true,
        canSearch: true,
    });
});

test('notice: ページがない PDF では移動できず、目印がなければ作成者への確認を促す', () => {
    assert.deepEqual(notice({ regions: one }, 'missing'), {
        message:
            'リンクが指すページがこの PDF にありません。PDF が差し替えられた可能性があります。リンクの作成者に、指している箇所を確認してください。',
        detail: '作成時の箇所: p.3',
        canJump: false,
        canSearch: false,
    });
});

test('citation: 値がある項目だけをつなぐ', () => {
    assert.equal(
        citation(
            {
                src: 'zotero:ABCD1234',
                title: 'Title',
                creators: 'Roy ほか',
                year: '2009',
                publication: '',
                doi: '10.1/x',
            },
            'p.3–4',
            '図2',
        ),
        'Roy ほか (2009). Title. https://doi.org/10.1/x. p.3–4. 「図2」',
    );
    assert.equal(citation(null, 'p.3', undefined), 'p.3');
});
