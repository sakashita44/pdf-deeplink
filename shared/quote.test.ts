import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeQuote } from './quote.ts';

const cases: [name: string, text: string, quote: string][] = [
    [
        '行の境目を空白にする',
        'push or pull in the same\ndirection',
        'push or pull in the same direction',
    ],
    [
        '英字の語を分けた行末のハイフンを除く',
        'con-\nfiguration',
        'configuration',
    ],
    ['大文字で始まる語を分けた行末のハイフンを除く', 'Robo-\ntics', 'Robotics'],
    ['数字が続く行末のハイフンは残す', 'COVID-\n19', 'COVID-19'],
    ['大文字が続く小文字の行末のハイフンは残す', 'foo-\nBar', 'foo-Bar'],
    [
        '漢字とかなの直後の改行は除く',
        '深層学習を\n用いた手法',
        '深層学習を用いた手法',
    ],
    ['空白をまとめて前後を除く', '  a \n\n b  ', 'a b'],
];

for (const [name, text, quote] of cases) {
    test(`normalizeQuote: ${name}`, () => {
        assert.equal(normalizeQuote(text), quote);
    });
}
