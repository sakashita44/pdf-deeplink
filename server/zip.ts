import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
    name: string;
    flags: number;
    method: number;
    crc: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
}

export class ZipError extends Error {}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

export function listEntries(archive: Buffer): ZipEntry[] {
    const eocd = findEndOfCentralDirectory(archive);
    const count = archive.readUInt16LE(eocd + 10);
    const size = archive.readUInt32LE(eocd + 12);
    const offset = archive.readUInt32LE(eocd + 16);
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
        throw new ZipError('zip64 archives are not supported');
    const end = offset + size;
    if (end > eocd) throw new ZipError('the central directory is out of range');
    const entries: ZipEntry[] = [];
    let p = offset;
    for (let i = 0; i < count; i++) {
        if (p + 46 > end || archive.readUInt32LE(p) !== CENTRAL_SIGNATURE)
            throw new ZipError('the central directory is broken');
        const flags = archive.readUInt16LE(p + 8);
        const nameLength = archive.readUInt16LE(p + 28);
        const next =
            p +
            46 +
            nameLength +
            archive.readUInt16LE(p + 30) +
            archive.readUInt16LE(p + 32);
        if (next > end) throw new ZipError('the central directory is broken');
        entries.push({
            // ZIP の仕様では汎用ビットフラグの bit 11 が立っていればファイル名は UTF-8 である。立っていなければ本来は CP437 だが、Buffer は CP437 を扱えないため、バイト値を保つ latin1 で読む。
            name: archive.toString(
                flags & 0x800 ? 'utf8' : 'latin1',
                p + 46,
                p + 46 + nameLength,
            ),
            flags,
            method: archive.readUInt16LE(p + 10),
            crc: archive.readUInt32LE(p + 16),
            compressedSize: archive.readUInt32LE(p + 20),
            uncompressedSize: archive.readUInt32LE(p + 24),
            localOffset: archive.readUInt32LE(p + 42),
        });
        p = next;
    }
    return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
    // EOCD の後ろには最大 65,535 バイトのコメントが続き、コメントの中に同じシグネチャが現れうるため、末尾から探してコメント長と末尾の位置が合うものを採る。
    const lowest = Math.max(0, archive.length - EOCD_SIZE - MAX_COMMENT);
    for (let p = archive.length - EOCD_SIZE; p >= lowest; p--) {
        if (
            archive.readUInt32LE(p) === EOCD_SIGNATURE &&
            p + EOCD_SIZE + archive.readUInt16LE(p + 20) === archive.length
        )
            return p;
    }
    throw new ZipError('not a zip archive');
}

export function readEntry(
    archive: Buffer,
    entry: ZipEntry,
    maxBytes: number,
): Buffer {
    if (entry.flags & 0x1)
        throw new ZipError('encrypted entries are not supported');
    if (
        entry.compressedSize === 0xffffffff ||
        entry.uncompressedSize === 0xffffffff ||
        entry.localOffset === 0xffffffff
    )
        throw new ZipError('zip64 entries are not supported');
    if (entry.uncompressedSize > maxBytes)
        throw new ZipError('the entry is too large');
    const p = entry.localOffset;
    if (p + 30 > archive.length || archive.readUInt32LE(p) !== LOCAL_SIGNATURE)
        throw new ZipError('the local header is broken');
    // 拡張フィールドの長さは中央ディレクトリとローカルヘッダで異なりうるため、本体の位置はローカルヘッダの長さから求める。サイズと CRC は、データ記述子を使う場合にローカルヘッダで 0 になるため中央ディレクトリの値を使う。
    const start =
        p + 30 + archive.readUInt16LE(p + 26) + archive.readUInt16LE(p + 28);
    const end = start + entry.compressedSize;
    if (end > archive.length) throw new ZipError('the entry is out of range');
    const data = archive.subarray(start, end);
    let content: Buffer;
    if (entry.method === 0) {
        if (entry.compressedSize !== entry.uncompressedSize)
            throw new ZipError('the stored entry has inconsistent sizes');
        content = data;
    } else if (entry.method === 8) {
        try {
            content = inflateRawSync(data, {
                // ZIP の圧縮方式 8 は zlib ヘッダのない Deflate である。maxOutputLength は 0 を受け付けないため、0 バイトのエントリに備えて下限を 1 とする。
                maxOutputLength: Math.max(1, entry.uncompressedSize),
            });
        } catch {
            throw new ZipError('the entry cannot be inflated');
        }
    } else {
        throw new ZipError(
            `compression method ${entry.method} is not supported`,
        );
    }
    if (content.length !== entry.uncompressedSize)
        throw new ZipError('the entry size does not match');
    if (crc32(content) >>> 0 !== entry.crc)
        throw new ZipError('the entry checksum does not match');
    return content;
}
