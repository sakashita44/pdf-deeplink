import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { listEntries, readEntry, ZipError } from './zip.ts';

interface Spec {
    name: string;
    data: Buffer;
    method?: number;
    flags?: number;
    localExtra?: Buffer;
    centralExtra?: Buffer;
    crc?: number;
    uncompressedSize?: number;
}

function buildZip(specs: Spec[], comment = Buffer.alloc(0)): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const spec of specs) {
        const method = spec.method ?? 8;
        const body = method === 8 ? deflateRawSync(spec.data) : spec.data;
        const name = Buffer.from(spec.name, 'utf8');
        const localExtra = spec.localExtra ?? Buffer.alloc(0);
        const centralExtra = spec.centralExtra ?? Buffer.alloc(0);
        const crc = spec.crc ?? crc32(spec.data);
        const size = spec.uncompressedSize ?? spec.data.length;
        const flags = spec.flags ?? 0x800;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(localExtra.length, 28);
        locals.push(local, name, localExtra, body);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(centralExtra.length, 30);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name, centralExtra);
        offset += 30 + name.length + localExtra.length + body.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(specs.length, 8);
    end.writeUInt16LE(specs.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(comment.length, 20);
    return Buffer.concat([...locals, directory, end, comment]);
}

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
