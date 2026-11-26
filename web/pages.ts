import type { PageViewport, PDFPageProxy } from 'pdfjs-dist';
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import type { PageGeometry, Point, ViewBox } from '../shared/geometry.ts';

export interface PageViewLike {
    div: HTMLDivElement;
    pdfPage: { view: number[]; rotate: number } | null;
    viewport: PageViewport;
    setPdfPage(pdfPage: PDFPageProxy): void;
}

export interface PageInfo {
    page: number;
    view: PageViewLike;
    geometry: PageGeometry;
    origin: DOMRect;
}

export interface Pages {
    view(page: number): PageViewLike | undefined;
    info(page: number): PageInfo | null;
    of(node: Node | null): PageInfo | null;
}

export function geometryOf(page: {
    view: number[];
    rotate: number;
}): PageGeometry {
    return {
        viewBox: page.view as unknown as ViewBox,
        rotation: page.rotate,
    };
}

export function toPdfPoint(
    view: PageViewLike,
    origin: DOMRect,
    x: number,
    y: number,
): Point {
    const [px, py] = view.viewport.convertToPdfPoint(
        x - origin.left,
        y - origin.top,
    ) as [number, number];
    return [px, py];
}

// ページ要素には PDF.js の CSS が枠を付けるため、枠の内側と一致する .canvasWrapper を座標の原点にする。
export function pageOrigin(view: PageViewLike): DOMRect | undefined {
    return view.div.querySelector('.canvasWrapper')?.getBoundingClientRect();
}

export function createPages(viewer: PDFViewer): Pages {
    const view = (page: number) =>
        viewer.getPageView(page - 1) as PageViewLike | undefined;
    const info = (page: number): PageInfo | null => {
        const pageView = view(page);
        const origin = pageView && pageOrigin(pageView);
        if (!pageView?.pdfPage || !origin) return null;
        return {
            page,
            view: pageView,
            geometry: geometryOf(pageView.pdfPage),
            origin,
        };
    };
    return {
        view,
        info,
        of(node) {
            const element =
                node instanceof Element ? node : node?.parentElement;
            const page = Number(
                element?.closest<HTMLElement>('.page')?.dataset.pageNumber,
            );
            return page ? info(page) : null;
        },
    };
}
