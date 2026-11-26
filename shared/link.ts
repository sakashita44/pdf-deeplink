export const LINK_VERSION = 1;

export const LIMITS = {
    rects: 64,
    label: 64,
    q: 200,
    coordinate: 100000,
} as const;

export type Rect = readonly [x: number, y: number, w: number, h: number];

export interface PdfLink {
    src: string;
    sha256: string;
    page: number;
    rects: Rect[];
    label?: string;
    q?: string;
}

export type ParseResult =
    { ok: true; link: PdfLink } | { ok: false; error: string };

const ZOTERO_SRC = /^zotero:[A-Z0-9]{8}$/;
const SHA256 = /^[0-9a-f]{16,64}$/;
const SHA256_LINK_LENGTH = 16;
const NUMBER = /^-?\d+(\.\d+)?$/;

export function isValidSrc(src: string): boolean {
    return ZOTERO_SRC.test(src);
}

export function sameVersion(linkSha256: string, pdfSha256: string): boolean {
    return pdfSha256.startsWith(linkSha256);
}

export function roundCoordinate(value: number): number {
    const rounded = Math.round(value * 10) / 10;
    return Object.is(rounded, -0) ? 0 : rounded;
}

export function parseLink(params: URLSearchParams): ParseResult {
    const version = params.get('v') ?? String(LINK_VERSION);
    if (version !== String(LINK_VERSION)) {
        return { ok: false, error: `unsupported version: ${version}` };
    }

    const src = params.get('src') ?? '';
    if (!isValidSrc(src)) return { ok: false, error: 'invalid src' };

    const sha256 = params.get('sha256') ?? '';
    if (!SHA256.test(sha256)) return { ok: false, error: 'invalid sha256' };

    const pageText = params.get('page') ?? '';
    const page = Number(pageText);
    if (!/^[1-9]\d*$/.test(pageText) || !Number.isSafeInteger(page)) {
        return { ok: false, error: 'invalid page' };
    }

    const rects = parseRects(params.get('rects') ?? '');
    if (!rects) return { ok: false, error: 'invalid rects' };

    const link: PdfLink = { src, sha256, page, rects };
    const label = params.get('label');
    if (label !== null && label !== '') {
        if ([...label].length > LIMITS.label)
            return { ok: false, error: 'label too long' };
        link.label = label;
    }
    const q = params.get('q');
    if (q !== null && q !== '') {
        if ([...q].length > LIMITS.q) return { ok: false, error: 'q too long' };
        link.q = q;
    }
    return { ok: true, link };
}

function parseRects(text: string): Rect[] | null {
    const parts = text.split(';');
    if (text === '' || parts.length > LIMITS.rects) return null;
    const rects: Rect[] = [];
    for (const part of parts) {
        const values = part.split(',');
        if (values.length !== 4 || !values.every((value) => NUMBER.test(value)))
            return null;
        const [x, y, w, h] = values.map(Number) as [
            number,
            number,
            number,
            number,
        ];
        if ([x, y, w, h].some((value) => Math.abs(value) > LIMITS.coordinate))
            return null;
        if (w <= 0 || h <= 0) return null;
        rects.push([x, y, w, h]);
    }
    return rects;
}

export function formatLink(link: PdfLink): string {
    const params = new URLSearchParams();
    params.set('src', link.src);
    params.set('sha256', link.sha256.slice(0, SHA256_LINK_LENGTH));
    params.set('page', String(link.page));
    params.set(
        'rects',
        link.rects
            .map((rect) =>
                rect.map((value) => roundCoordinate(value)).join(','),
            )
            .join(';'),
    );
    if (link.label) params.set('label', truncate(link.label, LIMITS.label));
    if (link.q) params.set('q', truncate(link.q, LIMITS.q));
    // URLSearchParams は : , ; も符号化するが、これらは RFC 3986 のクエリにそのまま書け、解釈の結果も変わらないため、読みやすさのために戻す。
    return params
        .toString()
        .replace(/%3A|%2C|%3B/g, (escaped) => decodeURIComponent(escaped));
}

function truncate(text: string, limit: number): string {
    const chars = [...text];
    return chars.length > limit ? chars.slice(0, limit).join('') : text;
}
