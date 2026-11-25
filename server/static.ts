import { createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.wasm': 'application/wasm',
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.icc': 'application/vnd.iccprofile',
};

export function createStaticHandler(
    root: string,
): ((pathname: string, res: ServerResponse) => boolean) | null {
    const base = resolve(root);
    const index = join(base, 'index.html');
    if (!existsSync(index)) return null;
    return (pathname, res) => {
        const file =
            resolveFile(base, pathname) ??
            (pathname === '/' || pathname === '/view' ? index : null);
        if (!file) return false;
        const immutable = file.startsWith(join(base, 'assets') + sep);
        res.writeHead(200, {
            'Content-Type':
                CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
            'Cache-Control': immutable
                ? 'public, max-age=31536000, immutable'
                : 'no-cache',
            'X-Content-Type-Options': 'nosniff',
        });
        createReadStream(file).pipe(res);
        return true;
    };
}

function resolveFile(base: string, pathname: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    const file = join(base, normalize(decoded));
    if (
        !file.startsWith(base + sep) ||
        !existsSync(file) ||
        !statSync(file).isFile()
    )
        return null;
    return file;
}
