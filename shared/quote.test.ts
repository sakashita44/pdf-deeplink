import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeQuote } from './quote.ts';

const cases: [name: string, text: string, quote: string][] = [
    [
        '行の境界を空白に置き換える',
        'push or pull in the same\ndirection',
        'push or pull in the same direction',
    ],
    [
        '英単語を分割する行末のハイフンを除去する',
        'con-\nfiguration',
        'configuration',
    ],
    [
        '大文字で始まる英単語を分割する行末のハイフンを除去する',
        'Robo-\ntics',
        'Robotics',
    ],
    ['行頭が数字の場合は行末のハイフンを保持する', 'COVID-\n19', 'COVID-19'],
    [
        '小文字の後で行頭が大文字の場合は行末のハイフンを保持する',
        'foo-\nBar',
        'foo-Bar',
    ],
    [
        '漢字と仮名の直後の改行は空白に置き換えずに除去する',
        '深層学習を\n用いた手法',
        '深層学習を用いた手法',
    ],
    [
        '連続する空白を 1 つにまとめ、前後の空白を除去する',
        '  a \n\n b  ',
        'a b',
    ],
    [
        '結合文字の直後の行末のハイフンを除去する',
        'cafe\u0301-\nteria',
        'cafe\u0301teria',
    ],
    ['結合用の濁点の直後の改行を除去する', 'か\u3099\nき', 'か\u3099き'],
];

for (const [name, text, quote] of cases) {
    test(`normalizeQuote: ${name}`, () => {
        assert.equal(normalizeQuote(text), quote);
    });
}
