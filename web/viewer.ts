import * as pdfjsLib from 'pdfjs-dist';
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { displayToUser, mergeLineRects, toLinkRect, toUserSpace, type PageGeometry, type Point, type ViewBox } from '../shared/geometry.ts';
import { formatLink, isValidSrc, LIMITS, parseLink, type PdfLink, type Rect } from '../shared/link.ts';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
const PDFJS_ASSETS = new URL('/pdfjs/', location.origin).href;

const HIGHLIGHT_MS = 8000;
const QUOTE_CHARS = 100;

interface DocumentMetadata {
    src: string;
    title: string;
    creators: string;
    year: string;
    publication: string;
    doi: string;
}

interface Selection {
    page: number;
    rects: Rect[];
    q: string;
    anchor: DOMRect;
}

interface PageViewLike {
    div: HTMLDivElement;
    pdfPage: { view: number[]; rotate: number } | null;
    viewport: PageViewport;
    setPdfPage(pdfPage: PDFPageProxy): void;
}

export async function renderViewer(app: HTMLElement, params: URLSearchParams): Promise<void> {
    app.innerHTML = `
        <div class="viewer-app">
            <header class="toolbar">
                <a class="back" href="/">一覧</a>
                <div class="doc-title"></div>
                <div class="tools" role="group" aria-label="選択の方法">
                    <button type="button" data-mode="text" aria-pressed="true">文章</button>
                    <button type="button" data-mode="area" aria-pressed="false">範囲</button>
                </div>
                <button type="button" class="link-citation" hidden>出典をコピー</button>
                <span class="page-label" aria-live="polite"></span>
            </header>
            <div class="banner" role="alert" hidden></div>
            <div class="viewer-stage"><div class="viewer-container"><div class="pdfViewer"></div></div></div>
            <div class="popup" role="dialog" aria-label="リンクの作成" hidden>
                <p class="popup-summary"></p>
                <label>目印 <input type="text" name="q" maxlength="200" placeholder="引用、図表番号、メモ" /></label>
                <div class="popup-actions">
                    <button type="button" data-action="copy-link">リンクをコピー</button>
                    <button type="button" data-action="copy-citation">出典をコピー</button>
                    <button type="button" data-action="close">閉じる</button>
                </div>
            </div>
            <div class="toast" role="status"></div>
        </div>`;

    const ui = {
        title: app.querySelector<HTMLElement>('.doc-title')!,
        banner: app.querySelector<HTMLElement>('.banner')!,
        container: app.querySelector<HTMLDivElement>('.viewer-container')!,
        pageLabel: app.querySelector<HTMLElement>('.page-label')!,
        popup: app.querySelector<HTMLElement>('.popup')!,
        popupSummary: app.querySelector<HTMLElement>('.popup-summary')!,
        popupInput: app.querySelector<HTMLInputElement>('.popup input')!,
        toast: app.querySelector<HTMLElement>('.toast')!,
        modeButtons: [...app.querySelectorAll<HTMLButtonElement>('[data-mode]')],
        linkCitation: app.querySelector<HTMLButtonElement>('.link-citation')!,
    };

    const parsed = parseLink(params);
    const link = parsed.ok ? parsed.link : null;
    const src = link?.src ?? params.get('src') ?? '';
    if (!isValidSrc(src)) {
        showBanner(ui.banner, 'リンクの形式が正しくありません。');
        return;
    }
    if (!link && [...params.keys()].some((key) => key !== 'src')) {
        showBanner(ui.banner, `リンクの形式が正しくありません（${parsed.ok ? '' : parsed.error}）。文書だけを開きます。`);
    }

    const base = `/app/documents/${encodeURIComponent(src)}`;
    const [metaResponse, fileResponse] = await Promise.all([fetch(base), fetch(`${base}/file`)]);
    if (!fileResponse.ok) {
        showBanner(ui.banner, `PDF を取得できませんでした（HTTP ${fileResponse.status}）。`);
        return;
    }
    const meta = metaResponse.ok ? ((await metaResponse.json()) as DocumentMetadata) : null;
    ui.title.textContent = meta ? [meta.title, [meta.creators, meta.year].filter(Boolean).join('・')].filter(Boolean).join(' — ') : src;
    document.title = meta?.title || 'PDF 箇所リンク';

    const data = new Uint8Array(await fileResponse.arrayBuffer());
    // getDocument() は data のバッファを Worker へ移譲し、メインスレッドからは読めなくなるため、先に SHA-256 を計算する。
    const sha256 = await digest(data);

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({ container: ui.container, eventBus, linkService, findController });
    linkService.setViewer(viewer);

    // PDF.js は各 URL の末尾にファイル名を連結して取得するため、URL は / で終える。
    const pdf = await pdfjsLib.getDocument({
        data,
        cMapUrl: `${PDFJS_ASSETS}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_ASSETS}standard_fonts/`,
        wasmUrl: `${PDFJS_ASSETS}wasm/`,
        iccUrl: `${PDFJS_ASSETS}iccs/`,
    }).promise;
    const pageLabels = await pdf.getPageLabels();
    viewer.setDocument(pdf);
    linkService.setDocument(pdf);
    if (pageLabels) viewer.setPageLabels(pageLabels);

    const pageView = (page: number) => viewer.getPageView(page - 1) as PageViewLike | undefined;
    const geometry = (page: { view: number[]; rotate: number }): PageGeometry => ({
        viewBox: page.view as unknown as ViewBox,
        rotation: page.rotate,
    });
    const labelOf = (page: number) => pageLabels?.[page - 1] || undefined;

    let highlight: { page: number; rects: Rect[]; geometry: PageGeometry; shownAt: number | null } | null = null;
    let selection: Selection | null = null;
    let mode: 'text' | 'area' = 'text';

    eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'page-width';
        ui.pageLabel.textContent = `p.${labelOf(1) ?? 1} / ${pdf.numPages}`;
        if (!link) return;
        if (link.sha256 === sha256 && link.page <= pdf.numPages) {
            void showHighlight(link);
        } else {
            showMismatch(link);
        }
    });

    eventBus.on('pagechanging', (event: { pageNumber: number; pageLabel?: string | null }) => {
        ui.pageLabel.textContent = `p.${event.pageLabel || event.pageNumber} / ${pdf.numPages}`;
    });

    // 拡大率の変更などで PDF.js がページを描画し直すと、PDF.js 以外が追加した要素はページから取り除かれるため、描画のたびに強調を貼り直す。
    eventBus.on('pagerendered', (event: { pageNumber: number }) => {
        if (highlight?.page === event.pageNumber) drawHighlight();
    });

    async function showHighlight(target: PdfLink): Promise<void> {
        const pdfPage = await pdf.getPage(target.page);
        const view = pageView(target.page);
        // PDF.js は 2 ページ目以降のページ情報を遅れて設定し、それまでは 1 ページ目の寸法で位置を計算する。移動の前に対象ページの情報を設定する。
        if (view && !view.pdfPage) view.setPdfPage(pdfPage);
        const pageGeometry = geometry(pdfPage);
        const [x, y] = target.rects[0]!;
        // XYZ の移動先は PDF のユーザー空間の座標で指定する。
        const [left, top] = displayToUser(pageGeometry, [x - 24, y - 48]);
        viewer.scrollPageIntoView({
            pageNumber: target.page,
            destArray: [null, { name: 'XYZ' }, left, top, null],
            ignoreDestinationZoom: true,
        });
        highlight = { page: target.page, rects: target.rects, geometry: pageGeometry, shownAt: null };
        drawHighlight();
    }

    function drawHighlight(): void {
        if (!highlight) return;
        const view = pageView(highlight.page);
        if (!view?.pdfPage) return;
        if (highlight.shownAt === null) {
            highlight.shownAt = Date.now();
            window.setTimeout(() => {
                highlight = null;
                ui.container.querySelectorAll('.link-highlight').forEach((layer) => layer.remove());
            }, HIGHLIGHT_MS);
        }
        view.div.querySelector('.link-highlight')?.remove();
        const layer = document.createElement('div');
        layer.className = 'link-highlight';
        layer.style.setProperty('--elapsed', `${Date.now() - highlight.shownAt}ms`);
        for (const rect of highlight.rects) {
            const [x1, y1, x2, y2] = toUserSpace(highlight.geometry, rect);
            const [a, b] = view.viewport.convertToViewportPoint(x1, y1) as [number, number];
            const [c, d] = view.viewport.convertToViewportPoint(x2, y2) as [number, number];
            const box = document.createElement('div');
            box.style.left = `${Math.min(a, c)}px`;
            box.style.top = `${Math.min(b, d)}px`;
            box.style.width = `${Math.abs(c - a)}px`;
            box.style.height = `${Math.abs(d - b)}px`;
            layer.append(box);
        }
        view.div.append(layer);
    }

    function showMismatch(target: PdfLink): void {
        const where = `p.${target.label ?? target.page}`;
        ui.banner.replaceChildren();
        const message = document.createElement('p');
        message.textContent =
            target.page > pdf.numPages && target.sha256 === sha256
                ? 'リンクのページがこの PDF にありません。'
                : 'この PDF はリンクの作成後に差し替えられたため、範囲を表示していません。';
        const detail = document.createElement('p');
        detail.textContent = `作成時の箇所: ${where}${target.q ? `「${target.q}」` : ''}`;
        const actions = document.createElement('div');
        actions.className = 'banner-actions';
        const jump = button(`${where} へ移動`, () => {
            linkService.page = Math.min(target.page, pdf.numPages);
        });
        actions.append(jump);
        if (target.q) {
            const query = target.q;
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
        ui.banner.append(message, detail, actions);
        ui.banner.hidden = false;
    }

    function pageOf(node: Node | null): { page: number; view: PageViewLike; geometry: PageGeometry; origin: DOMRect } | null {
        const element = node instanceof Element ? node : node?.parentElement;
        const pageDiv = element?.closest<HTMLElement>('.page');
        const page = Number(pageDiv?.dataset.pageNumber);
        const view = page ? pageView(page) : undefined;
        // ページ要素には PDF.js の CSS が枠を付けるため、枠の内側と一致する .canvasWrapper を座標の原点にする。
        const canvas = view?.div.querySelector('.canvasWrapper');
        if (!view?.pdfPage || !canvas) return null;
        return { page, view, geometry: geometry(view.pdfPage), origin: canvas.getBoundingClientRect() };
    }

    function toPdfPoint(view: PageViewLike, origin: DOMRect, x: number, y: number): Point {
        const [px, py] = view.viewport.convertToPdfPoint(x - origin.left, y - origin.top) as [number, number];
        return [px, py];
    }

    function handleTextSelection(): void {
        const current = document.getSelection();
        if (!current || current.isCollapsed || current.rangeCount === 0) return;
        const range = current.getRangeAt(0);
        const target = pageOf(range.startContainer);
        if (!target) return;
        if (pageOf(range.endContainer)?.page !== target.page) {
            toast(ui.toast, 'ページをまたぐ選択からはリンクを作れません。ページごとに選択してください。');
            return;
        }
        const { page, view, geometry: pageGeometry, origin } = target;
        // PDF.js のテキストレイヤーは空の要素や終端の要素を含み、getClientRects() が幅のない矩形やページ外の矩形を返すことがあるため除く。
        const clientRects = [...range.getClientRects()].filter(
            (rect) => rect.width > 0.5 && rect.height > 0.5 && rect.top >= origin.top - 1 && rect.bottom <= origin.bottom + 1,
        );
        const rects = mergeLineRects(
            clientRects.map((rect) =>
                toLinkRect(pageGeometry, toPdfPoint(view, origin, rect.left, rect.top), toPdfPoint(view, origin, rect.right, rect.bottom)),
            ),
        );
        if (!rects.length) return;
        if (rects.length > LIMITS.rects) {
            toast(ui.toast, `選択が長すぎます。${LIMITS.rects} 行以内に狭めてください。`);
            return;
        }
        const text = current.toString().replace(/\s+/g, ' ').trim();
        const q = [...text].slice(0, QUOTE_CHARS).join('');
        openPopup({ page, rects, q, anchor: clientRects.at(-1)! });
    }

    function openPopup(next: Selection): void {
        selection = next;
        ui.popupSummary.textContent = `p.${labelOf(next.page) ?? next.page} の${mode === 'text' ? '文章' : '範囲'}（矩形 ${next.rects.length} 個）`;
        ui.popupInput.value = next.q;
        ui.popup.hidden = false;
        const { innerWidth, innerHeight } = window;
        const width = ui.popup.offsetWidth;
        const height = ui.popup.offsetHeight;
        ui.popup.style.left = `${Math.max(8, Math.min(next.anchor.left, innerWidth - width - 8))}px`;
        const below = next.anchor.bottom + 8;
        ui.popup.style.top = `${below + height > innerHeight ? Math.max(8, next.anchor.top - height - 8) : below}px`;
        if (mode === 'area') ui.popupInput.focus();
    }

    function closePopup(): void {
        selection = null;
        ui.popup.hidden = true;
    }

    function currentLink(): PdfLink | null {
        if (!selection) return null;
        const q = ui.popupInput.value.trim();
        return {
            src,
            sha256,
            page: selection.page,
            rects: selection.rects,
            ...(labelOf(selection.page) ? { label: labelOf(selection.page) } : {}),
            ...(q ? { q } : {}),
        };
    }

    async function copy(text: string, done: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            toast(ui.toast, done);
        } catch {
            window.prompt('コピーしてください', text);
        }
    }

    // ポップアップ内の mousedown で本文の選択が解除されると、selectionchange でポップアップが閉じ、選択した範囲も失われる。
    ui.popup.addEventListener('mousedown', (event) => {
        if (event.target !== ui.popupInput) event.preventDefault();
    });

    ui.popup.addEventListener('click', (event) => {
        const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
        const target = currentLink();
        if (action === 'close') closePopup();
        if (!target) return;
        if (action === 'copy-link') {
            void copy(`${location.origin}/view?${formatLink(target)}`, 'リンクをコピーしました');
        } else if (action === 'copy-citation') {
            void copy(citation(meta, target), '出典をコピーしました');
        }
    });

    if (link) {
        ui.linkCitation.hidden = false;
        ui.linkCitation.addEventListener('click', () => void copy(citation(meta, link), '出典をコピーしました'));
    }

    ui.container.addEventListener('pointerup', () => {
        // pointerup の時点では、ブラウザが選択範囲をまだ確定していないことがあるため、次のタスクで読む。
        if (mode === 'text') window.setTimeout(handleTextSelection, 0);
    });
    document.addEventListener('selectionchange', () => {
        if (mode === 'text' && document.getSelection()?.isCollapsed && document.activeElement !== ui.popupInput) closePopup();
    });

    let drag: { page: number; view: PageViewLike; geometry: PageGeometry; origin: DOMRect; start: Point; startClient: Point; box: HTMLDivElement } | null = null;
    ui.container.addEventListener('pointerdown', (event) => {
        if (mode !== 'area' || event.button !== 0) return;
        const target = pageOf(event.target as Node);
        if (!target) return;
        event.preventDefault();
        closePopup();
        ui.container.setPointerCapture(event.pointerId);
        const box = document.createElement('div');
        box.className = 'rubber-band';
        document.body.append(box);
        const startX = clamp(event.clientX, target.origin.left, target.origin.right);
        const startY = clamp(event.clientY, target.origin.top, target.origin.bottom);
        drag = {
            ...target,
            start: toPdfPoint(target.view, target.origin, startX, startY),
            startClient: [startX, startY],
            box,
        };
    });
    ui.container.addEventListener('pointercancel', () => {
        drag?.box.remove();
        drag = null;
    });
    ui.container.addEventListener('pointermove', (event) => {
        if (!drag) return;
        const [sx, sy] = drag.startClient;
        const x = clamp(event.clientX, drag.origin.left, drag.origin.right);
        const y = clamp(event.clientY, drag.origin.top, drag.origin.bottom);
        Object.assign(drag.box.style, {
            left: `${Math.min(sx, x)}px`,
            top: `${Math.min(sy, y)}px`,
            width: `${Math.abs(x - sx)}px`,
            height: `${Math.abs(y - sy)}px`,
        });
    });
    ui.container.addEventListener('pointerup', (event) => {
        if (!drag) return;
        const current = drag;
        drag = null;
        const anchor = current.box.getBoundingClientRect();
        current.box.remove();
        const origin = current.view.div.querySelector('.canvasWrapper')?.getBoundingClientRect() ?? current.origin;
        const x = clamp(event.clientX, origin.left, origin.right);
        const y = clamp(event.clientY, origin.top, origin.bottom);
        const rect = toLinkRect(current.geometry, current.start, toPdfPoint(current.view, origin, x, y));
        const rects = mergeLineRects([rect]);
        if (!rects.length || rect[2] < 2 || rect[3] < 2) return;
        openPopup({ page: current.page, rects, q: '', anchor });
    });

    for (const modeButton of ui.modeButtons) {
        modeButton.addEventListener('click', () => {
            mode = modeButton.dataset.mode === 'area' ? 'area' : 'text';
            for (const other of ui.modeButtons) other.setAttribute('aria-pressed', String(other === modeButton));
            ui.container.classList.toggle('area-mode', mode === 'area');
            document.getSelection()?.removeAllRanges();
            closePopup();
        });
    }
}

function citation(meta: DocumentMetadata | null, target: Pick<PdfLink, 'page' | 'label' | 'q'>): string {
    const parts = [
        meta ? [meta.creators, meta.year && `(${meta.year})`].filter(Boolean).join(' ') : '',
        meta?.title ?? '',
        meta?.publication ?? '',
        meta?.doi ? `https://doi.org/${meta.doi}` : '',
        `p.${target.label ?? target.page}`,
        target.q ? `「${target.q}」` : '',
    ];
    return parts.filter(Boolean).join('. ');
}

async function digest(data: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function showBanner(banner: HTMLElement, message: string): void {
    banner.textContent = message;
    banner.hidden = false;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', onClick);
    return element;
}

function toast(element: HTMLElement, message: string): void {
    element.textContent = message;
    element.classList.add('visible');
    window.setTimeout(() => element.classList.remove('visible'), 2000);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
