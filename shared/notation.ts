import { sameVersion, type PageRects } from './link.ts';

export interface DocumentMetadata {
    src: string;
    title: string;
    creators: string;
    year: string;
    publication: string;
    doi: string;
}

export type LinkSituation = 'same' | 'updated' | 'missing';

export interface Notice {
    message: string;
    detail: string;
    canJump: boolean;
    canSearch: boolean;
}

export function firstPage(target: { regions: PageRects[] }): number {
    return target.regions[0]!.page;
}

export function lastPage(target: { regions: PageRects[] }): number {
    return target.regions.at(-1)!.page;
}

export function labelRange(
    regions: PageRects[],
    labelOf: (page: number) => string | undefined,
): string | undefined {
    const start = labelOf(firstPage({ regions }));
    const end = labelOf(lastPage({ regions }));
    if (!start || !end) return undefined;
    return start === end ? start : `${start}–${end}`;
}

export function pagesText(target: {
    regions: PageRects[];
    label?: string;
}): string {
    if (target.label) return `p.${target.label}`;
    const start = firstPage(target);
    const end = lastPage(target);
    return start === end ? `p.${start}` : `p.${start}–${end}`;
}

export function linkSituation(
    target: { regions: PageRects[]; sha256: string },
    numPages: number,
    pdfSha256: string,
): LinkSituation {
    if (lastPage(target) > numPages) return 'missing';
    return sameVersion(target.sha256, pdfSha256) ? 'same' : 'updated';
}

export function notice(
    target: { regions: PageRects[]; label?: string; q?: string },
    situation: Exclude<LinkSituation, 'same'>,
): Notice {
    const search = '「目印で検索」で該当箇所を探してください。';
    const message =
        situation === 'missing'
            ? `リンクが指すページがこの PDF にありません。PDF が差し替えられた可能性があります。${
                  target.q
                      ? search
                      : 'リンクの作成者に、指している箇所を確認してください。'
              }`
            : `この PDF はリンクの作成後に更新されています。${
                  target.q
                      ? `強調表示の位置がずれている場合は、${search}`
                      : '強調表示の位置がずれている可能性があります。'
              }`;
    return {
        message,
        detail: `作成時の箇所: ${pagesText(target)}${target.q ? `「${target.q}」` : ''}`,
        canJump: situation === 'updated',
        canSearch: Boolean(target.q),
    };
}

export function citation(
    meta: DocumentMetadata | null,
    pages: string,
    q: string | undefined,
): string {
    const parts = [
        meta
            ? [meta.creators, meta.year && `(${meta.year})`]
                  .filter(Boolean)
                  .join(' ')
            : '',
        meta?.title ?? '',
        meta?.publication ?? '',
        meta?.doi ? `https://doi.org/${meta.doi}` : '',
        pages,
        q ? `「${q}」` : '',
    ];
    return parts.filter(Boolean).join('. ');
}
