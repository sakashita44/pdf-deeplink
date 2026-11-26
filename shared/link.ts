export const LINK_VERSION = 1;

export const LIMITS = {
    rects: 64,
    label: 64,
    q: 200,
    coordinate: 100000,
} as const;

export type Rect = readonly [x: number, y: number, w: number, h: number];

export interface PageRects {
    page: number;
    rects: Rect[];
}

export interface PdfLink {
    src: string;
    sha256: string;
    regions: PageRects[];
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

    const regions = parseRegions(params.get('rects') ?? '');
    if (!regions) return { ok: false, error: 'invalid rects' };

    const link: PdfLink = { src, sha256, regions };
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

function parseRegions(text: string): PageRects[] | null {
    const parts = text.split(';');
    if (text === '' || parts.length > LIMITS.rects) return null;
    const regions: PageRects[] = [];
    for (const part of parts) {
        const prefixed = /^([1-9]\d*):(.*)$/.exec(part);
        let rectText = part;
        if (prefixed) {
            const page = Number(prefixed[1]);
            const previous = regions.at(-1)?.page ?? 0;
            if (!Number.isSafeInteger(page) || page <= previous) return null;
            regions.push({ page, rects: [] });
            rectText = prefixed[2]!;
        }
        const region = regions.at(-1);
        const rect = parseRect(rectText);
        if (!region || !rect) return null;
        region.rects.push(rect);
    }
    return regions;
}

function parseRect(text: string): Rect | null {
    const values = text.split(',');
    if (values.length !== 4 || !values.every((value) => NUMBER.test(value)))
        return null;
    const [x, y, w, h] = values.map(Number) as [number, number, number, number];
    if ([x, y, w, h].some((value) => Math.abs(value) > LIMITS.coordinate))
        return null;
    if (w <= 0 || h <= 0) return null;
    return [x, y, w, h];
}

export function formatLink(link: PdfLink): string {
    const params = new URLSearchParams();
    params.set('src', link.src);
    params.set('sha256', link.sha256.slice(0, SHA256_LINK_LENGTH));
    params.set(
        'rects',
        link.regions
            .map(({ page, rects }) =>
                rects
                    .map((rect) =>
                        rect.map((value) => roundCoordinate(value)).join(','),
                    )
                    .map((rect, index) =>
                        index === 0 ? `${page}:${rect}` : rect,
                    )
                    .join(';'),
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
