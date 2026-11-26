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

test('pagesText: ページラベルが存在する場合はページラベルを使用する', () => {
    assert.equal(pagesText({ regions: two, label: '1–2' }), 'p.1–2');
});

test('pagesText: ページラベルが存在しない場合はページ番号の範囲で表す', () => {
    assert.equal(pagesText({ regions: one }), 'p.3');
    assert.equal(pagesText({ regions: two }), 'p.3–4');
});

test('pagesText: 連続しないページは、連続する部分ごとに範囲として列挙する', () => {
    const page = (n: number) => ({ page: n, rects: [[0, 0, 1, 1] as const] });
    assert.equal(
        pagesText({ regions: [page(3), page(4), page(10)] }),
        'p.3–4, 10',
    );
    assert.equal(pagesText({ regions: [page(3), page(10)] }), 'p.3, 10');
});

test('labelRange: 最初のページと最後のページのページラベルを範囲として結合する', () => {
    assert.equal(labelRange(one, labelOf), '1');
    assert.equal(labelRange(two, labelOf), '1–2');
});

test('labelRange: いずれかのページにページラベルが存在しない場合は未定義とする', () => {
    assert.equal(
        labelRange([...two, { page: 5, rects: [[0, 0, 1, 1]] }], labelOf),
        undefined,
    );
    assert.equal(
        labelRange(two, () => undefined),
        undefined,
    );
});

test('linkSituation: 最後のページが PDF のページ数を超える場合は missing と判定する', () => {
    assert.equal(
        linkSituation({ regions: two, sha256: 'ab' }, 3, 'abcd'),
        'missing',
    );
});

test('linkSituation: SHA-256 の先頭が一致する場合は same、一致しない場合は updated と判定する', () => {
    assert.equal(
        linkSituation({ regions: two, sha256: 'ab' }, 4, 'abcd'),
        'same',
    );
    assert.equal(
        linkSituation({ regions: two, sha256: 'ff' }, 4, 'abcd'),
        'updated',
    );
});

test('notice: 更新された PDF では作成時のページへの移動を、検索用テキストが存在する場合は一致する箇所の検索を提示する', () => {
    assert.deepEqual(notice({ regions: two, q: '図2' }, 'updated'), {
        message:
            'この PDF はリンクの作成後に更新されています。強調表示の位置がずれている場合は、「一致する箇所を検索」を押すと、検索用テキストと一致する箇所へ移動できます。',
        detail: '作成時の指定位置: p.3–4「図2」',
        canJump: true,
        canSearch: true,
    });
});

test('notice: ページが存在しない PDF では移動を提示せず、検索用テキストが存在しない場合は作成者への確認を案内する', () => {
    assert.deepEqual(notice({ regions: one }, 'missing'), {
        message:
            'リンクが指すページがこの PDF にありません。PDF が差し替えられた可能性があります。リンクの作成者に、指している箇所を確認してください。',
        detail: '作成時の指定位置: p.3',
        canJump: false,
        canSearch: false,
    });
});

test('citation: 値が存在する項目のみを連結する', () => {
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
