import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildZip, type Spec } from './zip.fixture.ts';
import { listEntries, readEntry, ZipError } from './zip.ts';

const pdf = Buffer.from('%PDF-1.7\n' + 'x'.repeat(1000));

test('readEntry: 圧縮したエントリと無圧縮のエントリを取り出す', () => {
    const archive = buildZip([
        { name: 'a.pdf', data: pdf },
        { name: 'b.pdf', data: pdf, method: 0 },
    ]);
    const entries = listEntries(archive);
    assert.deepEqual(
        entries.map((entry) => entry.name),
        ['a.pdf', 'b.pdf'],
    );
    for (const entry of entries)
        assert.deepEqual(readEntry(archive, entry, 1 << 20), pdf);
});

test('listEntries: 末尾にコメントがあっても中央ディレクトリを見つける', () => {
    const comment = Buffer.from('PK\x05\x06 looks like a signature');
    const archive = buildZip([{ name: 'a.pdf', data: pdf }], comment);
    const [entry] = listEntries(archive);
    assert.deepEqual(readEntry(archive, entry!, 1 << 20), pdf);
});

test('readEntry: ローカルヘッダの拡張フィールドの長さで本体の位置を決める', () => {
    const archive = buildZip([
        {
            name: 'a.pdf',
            data: pdf,
            localExtra: Buffer.alloc(12, 1),
            centralExtra: Buffer.alloc(4, 2),
        },
    ]);
    const [entry] = listEntries(archive);
    assert.deepEqual(readEntry(archive, entry!, 1 << 20), pdf);
});

test('readEntry: 壊れたエントリや対応しないエントリは取り出さない', () => {
    const cases: [string, Spec, number?][] = [
        ['CRC の不一致', { name: 'a', data: pdf, crc: 1 }],
        ['暗号化', { name: 'a', data: pdf, flags: 0x801 }],
        ['対応しない圧縮方式', { name: 'a', data: pdf, method: 12 }],
        [
            '無圧縮でサイズが食い違う',
            { name: 'a', data: pdf, method: 0, uncompressedSize: 10 },
        ],
        [
            '申告より大きく展開される',
            { name: 'a', data: pdf, uncompressedSize: 100 },
        ],
        ['上限を超える', { name: 'a', data: pdf }, 100],
        ['zip64', { name: 'a', data: pdf, uncompressedSize: 0xffffffff }],
    ];
    for (const [label, spec, max] of cases) {
        const archive = buildZip([spec]);
        const [entry] = listEntries(archive);
        assert.throws(
            () => readEntry(archive, entry!, max ?? 1 << 20),
            ZipError,
            label,
        );
    }
});

test('listEntries: zip でないデータや中央ディレクトリが壊れたデータは拒否する', () => {
    assert.throws(() => listEntries(Buffer.from('not a zip')), ZipError);
    const archive = buildZip([{ name: 'a.pdf', data: pdf }]);
    const broken = Buffer.from(archive);
    broken.writeUInt32LE(0, broken.length - 22 - 46 - 'a.pdf'.length);
    assert.throws(() => listEntries(broken), ZipError);
});
