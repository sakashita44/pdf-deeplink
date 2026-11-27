import { crc32, deflateRawSync } from 'node:zlib';

export interface Spec {
    name: string;
    data: Buffer;
    method?: number;
    flags?: number;
    localExtra?: Buffer;
    centralExtra?: Buffer;
    crc?: number;
    uncompressedSize?: number;
}

export function buildZip(specs: Spec[], comment = Buffer.alloc(0)): Buffer {
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
