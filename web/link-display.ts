import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    EventBus,
    PDFLinkService,
    PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import {
    displayToUser,
    toUserSpace,
    type PageGeometry,
} from '../shared/geometry.ts';
import type { PageRects, PdfLink } from '../shared/link.ts';
import { firstPage, linkSituation, notice } from '../shared/notation.ts';
import { geometryOf, type Pages } from './pages.ts';
import { button, openBanner } from './ui.ts';

const HIGHLIGHT_MS = 8000;

// PDF.js の RenderingStates.FINISHED
const RENDERING_FINISHED = 3;

type Region = PageRects & {
    geometry: PageGeometry;
    shownAt: number | null;
    expired: boolean;
};

export interface LinkDisplayContext {
    pdf: PDFDocumentProxy;
    pdfSha256: string;
    viewer: PDFViewer;
    eventBus: EventBus;
    linkService: PDFLinkService;
    pages: Pages;
    banner: HTMLElement;
}

export function showLink(context: LinkDisplayContext, link: PdfLink): void {
    const { pdf, pdfSha256, viewer, eventBus, pages } = context;
    const situation = linkSituation(link, pdf.numPages, pdfSha256);
    if (situation === 'missing') {
        showNotice(context, link, situation);
        return;
    }

    let regions: Region[] = [];

    // 拡大率の変更などで PDF.js がページを描画し直すと、PDF.js 以外が追加した要素はページから取り除かれるため、描画のたびに強調を貼り直す。
    eventBus.on('pagerendered', (event: { pageNumber: number }) => {
        const region = regions.find(({ page }) => page === event.pageNumber);
        if (region) draw(region, true);
    });

    void (async () => {
        const loaded = await Promise.all(
            link.regions.map(async (region) => {
                const pdfPage = await pdf.getPage(region.page);
                const view = pages.view(region.page);
                // PDF.js は 2 ページ目以降のページ情報を遅れて設定し、それまでは 1 ページ目の寸法で位置を計算する。移動と強調の描画の前に、対象の各ページの情報を設定する。
                if (view && !view.pdfPage) view.setPdfPage(pdfPage);
                return {
                    ...region,
                    geometry: geometryOf(pdfPage),
                    shownAt: null,
                    expired: false,
                };
            }),
        );
        const first = loaded[0]!;
        const [x, y] = first.rects[0]!;
        // XYZ の移動先は PDF のユーザー空間の座標で指定する。
        const [left, top] = displayToUser(first.geometry, [x - 24, y - 48]);
        viewer.scrollPageIntoView({
            pageNumber: first.page,
            destArray: [null, { name: 'XYZ' }, left, top, null],
            ignoreDestinationZoom: true,
        });
        regions = loaded;
        for (const region of regions)
            draw(
                region,
                pages.view(region.page)?.renderingState === RENDERING_FINISHED,
            );
    })();

    if (situation === 'updated') showNotice(context, link, situation);

    // 強調を消すまでの時間は、ページごとに、そのページが描画された時点から数える。離れたページを指すリンクでも、移動した先のページで強調が見えるようにする。
    function draw(region: Region, rendered: boolean): void {
        if (region.expired) return;
        const view = pages.view(region.page);
        if (!view?.pdfPage) return;
        if (region.shownAt === null && rendered) {
            region.shownAt = Date.now();
            window.setTimeout(() => {
                region.expired = true;
                pages
                    .view(region.page)
                    ?.div.querySelector('.link-highlight')
                    ?.remove();
            }, HIGHLIGHT_MS);
        }
        view.div.querySelector('.link-highlight')?.remove();
        const layer = document.createElement('div');
        layer.className = 'link-highlight';
        layer.style.setProperty(
            '--elapsed',
            `${region.shownAt === null ? 0 : Date.now() - region.shownAt}ms`,
        );
        for (const rect of region.rects) {
            const [x1, y1, x2, y2] = toUserSpace(region.geometry, rect);
            const [a, b] = view.viewport.convertToViewportPoint(x1, y1) as [
                number,
                number,
            ];
            const [c, d] = view.viewport.convertToViewportPoint(x2, y2) as [
                number,
                number,
            ];
            const box = document.createElement('div');
            box.style.left = `${Math.min(a, c)}px`;
            box.style.top = `${Math.min(b, d)}px`;
            box.style.width = `${Math.abs(c - a)}px`;
            box.style.height = `${Math.abs(d - b)}px`;
            layer.append(box);
        }
        view.div.append(layer);
    }
}

function showNotice(
    { eventBus, linkService, banner }: LinkDisplayContext,
    link: PdfLink,
    situation: 'updated' | 'missing',
): void {
    const content = notice(link, situation);
    const message = document.createElement('p');
    message.textContent = content.message;
    const detail = document.createElement('p');
    detail.textContent = content.detail;
    const actions = document.createElement('div');
    actions.className = 'banner-actions';
    if (content.canJump) {
        actions.append(
            button('作成時のページへ移動', () => {
                linkService.page = firstPage(link);
            }),
        );
    }
    if (content.canSearch && link.q) {
        const query = link.q;
        let searched = false;
        actions.append(
            button('目印で検索', () => {
                eventBus.dispatch('find', {
                    source: null,
                    type: searched ? 'again' : '',
                    query,
                    caseSensitive: false,
                    entireWord: false,
                    highlightAll: true,
                    findPrevious: false,
                    matchDiacritics: true,
                });
                searched = true;
            }),
        );
    }
    openBanner(banner, [message, detail, actions]);
}
