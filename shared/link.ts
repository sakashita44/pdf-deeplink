export const LINK_VERSION = 1;

export const LIMITS = {
    rects: 64,
    page: 100000,
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

const PARAMETERS = ['v', 'src', 'sha256', 'rects', 'label', 'q'] as const;
const ZOTERO_SRC = /^zotero:[A-Z0-9]{8}$/;
const SHA256 = /^[0-9a-f]{16,64}$/;
const SHA256_LINK_LENGTH = 16;
const NUMBER = /^-?\d+(\.\d+)?$/;
const PAGE = /^[1-9]\d*$/;
const MIN_SIZE = 0.1;

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
    for (const name of PARAMETERS) {
        if (params.getAll(name).length > 1)
            return { ok: false, error: `duplicate parameter: ${name}` };
    }

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
    const parts = text.split('_');
    if (text === '' || parts.length > LIMITS.rects) return null;
    const regions: PageRects[] = [];
    for (const part of parts) {
        const separator = part.indexOf(':');
        let rectText = part;
        if (separator !== -1) {
            const pageText = part.slice(0, separator);
            const page = Number(pageText);
            const previous = regions.at(-1)?.page ?? 0;
            if (!PAGE.test(pageText) || page > LIMITS.page || page <= previous)
                return null;
            regions.push({ page, rects: [] });
            rectText = part.slice(separator + 1);
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
    const [x, y, w, h] = values.map((value) => Number(value) + 0) as [
        number,
        number,
        number,
        number,
    ];
    if ([x, y, w, h].some((value) => Math.abs(value) > LIMITS.coordinate))
        return null;
    if (w <= 0 || h <= 0) return null;
    return [x, y, w, h];
}

export function formatLink(link: PdfLink): string {
    const rects = link.regions
        .map(({ page, rects }) =>
            rects
                .map(([x, y, w, h]) =>
                    [
                        roundCoordinate(x),
                        roundCoordinate(y),
                        Math.max(MIN_SIZE, roundCoordinate(w)),
                        Math.max(MIN_SIZE, roundCoordinate(h)),
                    ].join(','),
                )
                .map((rect, index) => (index === 0 ? `${page}:${rect}` : rect))
                .join('_'),
        )
        .join('_');
    const text = new URLSearchParams();
    if (link.label) text.set('label', truncate(link.label, LIMITS.label));
    if (link.q) text.set('q', truncate(link.q, LIMITS.q));
    // src と rects の値は英数字と - . , : _ だけからなり、RFC 3986 のクエリにそのまま書けるため、読みやすさのために符号化しない。
    return [
        `src=${link.src}`,
        `sha256=${link.sha256.slice(0, SHA256_LINK_LENGTH)}`,
        `rects=${rects}`,
        text.toString(),
    ]
        .filter(Boolean)
        .join('&');
}

function truncate(text: string, limit: number): string {
    const chars = [...text];
    return chars.length > limit ? chars.slice(0, limit).join('') : text;
}
