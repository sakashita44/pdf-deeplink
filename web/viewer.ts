import * as pdfjsLib from 'pdfjs-dist';
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
    EventBus,
    PDFFindController,
    PDFLinkService,
    PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
    displayToUser,
    mergeSelectionRects,
    toLinkRect,
    toUserSpace,
    type PageGeometry,
    type Point,
    type ViewBox,
} from '../shared/geometry.ts';
import {
    formatLink,
    isValidSrc,
    LIMITS,
    parseLink,
    sameVersion,
    type PageRects,
    type PdfLink,
} from '../shared/link.ts';
import { normalizeQuote } from '../shared/quote.ts';

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
    regions: PageRects[];
    q: string;
    anchor: DOMRect;
}

interface PageInfo {
    page: number;
    view: PageViewLike;
    geometry: PageGeometry;
    origin: DOMRect;
}

interface PageViewLike {
    div: HTMLDivElement;
    pdfPage: { view: number[]; rotate: number } | null;
    viewport: PageViewport;
    setPdfPage(pdfPage: PDFPageProxy): void;
}

export async function renderViewer(
    app: HTMLElement,
    params: URLSearchParams,
): Promise<void> {
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
        modeButtons: [
            ...app.querySelectorAll<HTMLButtonElement>('[data-mode]'),
        ],
        linkCitation: app.querySelector<HTMLButtonElement>('.link-citation')!,
    };

    const parsed = parseLink(params);
    const link = parsed.ok ? parsed.link : null;
    const src = link?.src ?? params.get('src') ?? '';
    if (!isValidSrc(src)) {
        showBanner(ui.banner, 'リンクから文献を特定できませんでした。');
        return;
    }
    if (!link && [...params.keys()].some((key) => key !== 'src')) {
        showBanner(
            ui.banner,
            'リンクの一部が正しくないため、該当箇所を表示できません。文書の先頭を表示しています。',
        );
    }

    const base = `/app/documents/${encodeURIComponent(src)}`;
    const [metaResponse, fileResponse] = await Promise.all([
        fetch(base),
        fetch(`${base}/file`),
    ]);
    if (!fileResponse.ok) {
        showBanner(
            ui.banner,
            fileResponse.status === 404
                ? 'リンクが指す PDF が見つかりません。文献や PDF が削除されたか、別の PDF に差し替えられた可能性があります。'
                : `PDF を読み込めませんでした（HTTP ${fileResponse.status}）。`,
        );
        return;
    }
    const meta = metaResponse.ok
        ? ((await metaResponse.json()) as DocumentMetadata)
        : null;
    ui.title.textContent = meta
        ? [meta.title, [meta.creators, meta.year].filter(Boolean).join('・')]
              .filter(Boolean)
              .join(' — ')
        : src;
    document.title = meta?.title || 'PDF 箇所リンク';

    const data = new Uint8Array(await fileResponse.arrayBuffer());
    // getDocument() は data のバッファを Worker へ移譲し、メインスレッドからは読めなくなるため、先に SHA-256 を計算する。
    const sha256 = await digest(data);

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({
        container: ui.container,
        eventBus,
        linkService,
        findController,
    });
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

    const pageView = (page: number) =>
        viewer.getPageView(page - 1) as PageViewLike | undefined;
    const geometry = (page: {
        view: number[];
        rotate: number;
    }): PageGeometry => ({
        viewBox: page.view as unknown as ViewBox,
        rotation: page.rotate,
    });
    const labelOf = (page: number) => pageLabels?.[page - 1] || undefined;

    const firstPage = (target: { regions: PageRects[] }) =>
        target.regions[0]!.page;
    const lastPage = (target: { regions: PageRects[] }) =>
        target.regions.at(-1)!.page;
    const labelRange = (regions: PageRects[]) => {
        const start = labelOf(regions[0]!.page);
        const end = labelOf(regions.at(-1)!.page);
        if (!start || !end) return undefined;
        return start === end ? start : `${start}–${end}`;
    };
    const pagesText = (target: { regions: PageRects[]; label?: string }) => {
        if (target.label) return `p.${target.label}`;
        const start = firstPage(target);
        const end = lastPage(target);
        return start === end ? `p.${start}` : `p.${start}–${end}`;
    };

    let highlight: {
        regions: (PageRects & { geometry: PageGeometry })[];
        shownAt: number | null;
    } | null = null;
    let selection: Selection | null = null;
    let mode: 'text' | 'area' = 'text';

    eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'page-width';
        ui.pageLabel.textContent = `p.${labelOf(1) ?? 1} / ${pdf.numPages}`;
        if (!link) return;
        if (lastPage(link) > pdf.numPages) {
            showNotice(link, 'missing');
            return;
        }
        void showHighlight(link);
        if (!sameVersion(link.sha256, sha256)) {
            showNotice(link, 'updated');
        }
    });

    eventBus.on(
        'pagechanging',
        (event: { pageNumber: number; pageLabel?: string | null }) => {
            ui.pageLabel.textContent = `p.${event.pageLabel || event.pageNumber} / ${pdf.numPages}`;
        },
    );

    // 拡大率の変更などで PDF.js がページを描画し直すと、PDF.js 以外が追加した要素はページから取り除かれるため、描画のたびに強調を貼り直す。
    eventBus.on('pagerendered', (event: { pageNumber: number }) => {
        const region = highlight?.regions.find(
            ({ page }) => page === event.pageNumber,
        );
        if (region) drawHighlight(region);
    });

    async function showHighlight(target: PdfLink): Promise<void> {
        const regions = await Promise.all(
            target.regions.map(async (region) => {
                const pdfPage = await pdf.getPage(region.page);
                const view = pageView(region.page);
                // PDF.js は 2 ページ目以降のページ情報を遅れて設定し、それまでは 1 ページ目の寸法で位置を計算する。移動と強調の描画の前に、対象の各ページの情報を設定する。
                if (view && !view.pdfPage) view.setPdfPage(pdfPage);
                return { ...region, geometry: geometry(pdfPage) };
            }),
        );
        const first = regions[0]!;
        const [x, y] = first.rects[0]!;
        // XYZ の移動先は PDF のユーザー空間の座標で指定する。
        const [left, top] = displayToUser(first.geometry, [x - 24, y - 48]);
        viewer.scrollPageIntoView({
            pageNumber: first.page,
            destArray: [null, { name: 'XYZ' }, left, top, null],
            ignoreDestinationZoom: true,
        });
        highlight = { regions, shownAt: null };
        regions.forEach(drawHighlight);
    }

    function drawHighlight(
        region: PageRects & { geometry: PageGeometry },
    ): void {
        if (!highlight) return;
        const view = pageView(region.page);
        if (!view?.pdfPage) return;
        if (highlight.shownAt === null) {
            highlight.shownAt = Date.now();
            window.setTimeout(() => {
                highlight = null;
                ui.container
                    .querySelectorAll('.link-highlight')
                    .forEach((layer) => layer.remove());
            }, HIGHLIGHT_MS);
        }
        view.div.querySelector('.link-highlight')?.remove();
        const layer = document.createElement('div');
        layer.className = 'link-highlight';
        layer.style.setProperty(
            '--elapsed',
            `${Date.now() - highlight.shownAt}ms`,
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

    function showNotice(
        target: PdfLink,
        situation: 'updated' | 'missing',
    ): void {
        const where = pagesText(target);
        const message = document.createElement('p');
        const search = '「目印で検索」で該当箇所を探してください。';
        if (situation === 'missing') {
            message.textContent = `リンクが指すページがこの PDF にありません。PDF が差し替えられた可能性があります。${
                target.q
                    ? search
                    : 'リンクの作成者に、指している箇所を確認してください。'
            }`;
        } else {
            message.textContent = `この PDF はリンクの作成後に更新されています。${
                target.q
                    ? `強調表示の位置がずれている場合は、${search}`
                    : '強調表示の位置がずれている可能性があります。'
            }`;
        }
        const detail = document.createElement('p');
        detail.textContent = `作成時の箇所: ${where}${target.q ? `「${target.q}」` : ''}`;
        const actions = document.createElement('div');
        actions.className = 'banner-actions';
        if (situation === 'updated') {
            actions.append(
                button('作成時のページへ移動', () => {
                    linkService.page = firstPage(target);
                }),
            );
        }
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
        openBanner(ui.banner, [message, detail, actions]);
    }

    function pageOf(node: Node | null): PageInfo | null {
        const element = node instanceof Element ? node : node?.parentElement;
        const pageDiv = element?.closest<HTMLElement>('.page');
        const page = Number(pageDiv?.dataset.pageNumber);
        return page ? pageInfo(page) : null;
    }

    function pageInfo(page: number): PageInfo | null {
        const view = pageView(page);
        // ページ要素には PDF.js の CSS が枠を付けるため、枠の内側と一致する .canvasWrapper を座標の原点にする。
        const canvas = view?.div.querySelector('.canvasWrapper');
        if (!view?.pdfPage || !canvas) return null;
        return {
            page,
            view,
            geometry: geometry(view.pdfPage),
            origin: canvas.getBoundingClientRect(),
        };
    }

    function toPdfPoint(
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

    function handleTextSelection(): void {
        const current = document.getSelection();
        if (!current || current.isCollapsed || current.rangeCount === 0) return;
        const range = current.getRangeAt(0);
        // PDF.js は描画したページを一定数だけ保持し、古いページのテキストレイヤーを破棄する。長い選択の途中で端のページが破棄されると、選択の端はテキストレイヤーの外へ移り、そのページの文字が選択から抜け落ちる。
        if (
            !inTextLayer(range.startContainer) ||
            !inTextLayer(range.endContainer)
        ) {
            toast(
                ui.toast,
                '選択した範囲が大きすぎます。範囲を狭めてください。',
            );
            return;
        }
        const regions: PageRects[] = [];
        const texts: string[] = [];
        let anchor: DOMRect | undefined;
        for (const selected of selectedPages(range)) {
            const info = pageInfo(selected.page);
            if (!info) continue;
            const { page, view, geometry: pageGeometry, origin } = info;
            // PDF.js のテキストレイヤーは空白だけの要素を含み、getClientRects() が幅のない矩形を返すことがある。また CropBox の外にある文字も要素として置き、CSS で隠しているため、ページの表示領域と重ならない矩形も除く。
            const visible = (rect: DOMRect) =>
                rect.width > 0.5 &&
                rect.height > 0.5 &&
                rect.right > origin.left &&
                rect.left < origin.right &&
                rect.bottom > origin.top &&
                rect.top < origin.bottom;
            const parts = selected.parts
                .map(({ rects, text }) => ({
                    text,
                    rects: rects.filter(visible),
                }))
                .filter(({ rects, text }) => text === '\n' || rects.length);
            const inPage = parts.flatMap(({ rects }) => rects);
            const rects = mergeSelectionRects(
                inPage.map((rect) =>
                    toLinkRect(
                        pageGeometry,
                        toPdfPoint(view, origin, rect.left, rect.top),
                        toPdfPoint(view, origin, rect.right, rect.bottom),
                    ),
                ),
            );
            if (!rects.length) continue;
            regions.push({ page, rects });
            texts.push(parts.map(({ text }) => text).join(''));
            anchor = inPage.at(-1);
        }
        if (!regions.length || !anchor) return;
        if (regions.flatMap(({ rects }) => rects).length > LIMITS.rects) {
            toast(
                ui.toast,
                '選択した範囲が大きすぎます。範囲を狭めてください。',
            );
            return;
        }
        // PDFFindController はページごとに文字列を照合し、ページをまたいで一致しないため、目印は最初のページの部分から作る。
        const q = [...normalizeQuote(texts[0] ?? '')]
            .slice(0, QUOTE_CHARS)
            .join('');
        openPopup({ regions, q, anchor });
    }

    function openPopup(next: Selection): void {
        selection = next;
        const count = next.regions.flatMap(({ rects }) => rects).length;
        ui.popupSummary.textContent = `${pagesText({ regions: next.regions, label: labelRange(next.regions) })} の${mode === 'text' ? '文章' : '範囲'}（矩形 ${count} 個）`;
        ui.popupInput.value = next.q;
        ui.popup.hidden = false;
        const { innerWidth, innerHeight } = window;
        const width = ui.popup.offsetWidth;
        const height = ui.popup.offsetHeight;
        ui.popup.style.left = `${Math.max(8, Math.min(next.anchor.left, innerWidth - width - 8))}px`;
        const below = next.anchor.bottom + 8;
        const top =
            below + height > innerHeight ? next.anchor.top - height - 8 : below;
        ui.popup.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
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
            regions: selection.regions,
            ...(labelRange(selection.regions)
                ? { label: labelRange(selection.regions) }
                : {}),
            ...(q ? { q } : {}),
        };
    }

    async function copy(text: string, done: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            toast(ui.toast, done);
        } catch {
            window.prompt(
                'クリップボードにコピーできませんでした。表示されている内容を手動でコピーしてください。',
                text,
            );
        }
    }

    // ポップアップ内の mousedown で本文の選択が解除されると、selectionchange でポップアップが閉じ、選択した範囲も失われる。
    ui.popup.addEventListener('mousedown', (event) => {
        if (event.target !== ui.popupInput) event.preventDefault();
    });

    ui.popup.addEventListener('click', (event) => {
        const action = (event.target as HTMLElement).closest<HTMLElement>(
            '[data-action]',
        )?.dataset.action;
        const target = currentLink();
        if (action === 'close') closePopup();
        if (!target) return;
        if (action === 'copy-link') {
            void copy(
                `${location.origin}/view?${formatLink(target)}`,
                'リンクをコピーしました',
            );
        } else if (action === 'copy-citation') {
            void copy(
                citation(meta, pagesText(target), target.q),
                '出典をコピーしました',
            );
        }
    });

    if (link) {
        ui.linkCitation.hidden = false;
        ui.linkCitation.addEventListener(
            'click',
            () =>
                void copy(
                    citation(meta, pagesText(link), link.q),
                    '出典をコピーしました',
                ),
        );
    }

    ui.container.addEventListener('pointerup', () => {
        // pointerup の時点では、ブラウザが選択範囲をまだ確定していないことがあるため、次のタスクで読む。
        if (mode === 'text') window.setTimeout(handleTextSelection, 0);
    });
    document.addEventListener('selectionchange', () => {
        if (
            mode === 'text' &&
            document.getSelection()?.isCollapsed &&
            !ui.popup.contains(document.activeElement)
        )
            closePopup();
    });

    let drag: {
        page: number;
        view: PageViewLike;
        geometry: PageGeometry;
        origin: DOMRect;
        start: Point;
        startClient: Point;
        box: HTMLDivElement;
    } | null = null;
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
        const startX = clamp(
            event.clientX,
            target.origin.left,
            target.origin.right,
        );
        const startY = clamp(
            event.clientY,
            target.origin.top,
            target.origin.bottom,
        );
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
        const origin =
            current.view.div
                .querySelector('.canvasWrapper')
                ?.getBoundingClientRect() ?? current.origin;
        const x = clamp(event.clientX, origin.left, origin.right);
        const y = clamp(event.clientY, origin.top, origin.bottom);
        const rect = toLinkRect(
            current.geometry,
            current.start,
            toPdfPoint(current.view, origin, x, y),
        );
        if (rect[2] < 2 || rect[3] < 2) return;
        openPopup({
            regions: [{ page: current.page, rects: [rect] }],
            q: '',
            anchor,
        });
    });

    for (const modeButton of ui.modeButtons) {
        modeButton.addEventListener('click', () => {
            mode = modeButton.dataset.mode === 'area' ? 'area' : 'text';
            for (const other of ui.modeButtons)
                other.setAttribute(
                    'aria-pressed',
                    String(other === modeButton),
                );
            ui.container.classList.toggle('area-mode', mode === 'area');
            document.getSelection()?.removeAllRanges();
            closePopup();
        });
    }
}

function citation(
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

async function digest(data: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function inTextLayer(node: Node): boolean {
    const element = node instanceof Element ? node : node.parentElement;
    return !!element?.closest('.textLayer');
}

interface SelectedPart {
    rects: DOMRect[];
    text: string;
}

interface SelectedPage {
    page: number;
    parts: SelectedPart[];
}

// Range.getClientRects() は、範囲に含まれる要素の境界ボックスも返す。ページをまたぐ選択では PDF.js の .canvasWrapper や .annotationLayer がページ全体の矩形として含まれるため、テキストレイヤー内のテキストノードごとに矩形を取る。
function selectedPages(range: Range): SelectedPage[] {
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(
        root.nodeType === Node.TEXT_NODE ? root.parentNode! : root,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    );
    const pages = new Map<number, SelectedPage>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!range.intersectsNode(node)) continue;
        const layer = (
            node instanceof Element ? node : node.parentElement
        )?.closest('.textLayer');
        const page = Number(
            layer?.closest<HTMLElement>('.page')?.dataset.pageNumber,
        );
        if (!page) continue;
        if (!pages.has(page)) pages.set(page, { page, parts: [] });
        const selected = pages.get(page)!;
        // PDF.js のテキストレイヤーは行末に <br> を置き、行の文字列の末尾に空白を持たないことがある。
        if (node instanceof HTMLBRElement) {
            selected.parts.push({ rects: [], text: '\n' });
        } else if (node.nodeType === Node.TEXT_NODE) {
            const part = document.createRange();
            part.selectNodeContents(node);
            if (node === range.startContainer)
                part.setStart(node, range.startOffset);
            if (node === range.endContainer) part.setEnd(node, range.endOffset);
            selected.parts.push({
                rects: [...part.getClientRects()],
                text: part.toString(),
            });
        }
    }
    return [...pages.values()].sort((a, b) => a.page - b.page);
}

function showBanner(banner: HTMLElement, message: string): void {
    const text = document.createElement('p');
    text.textContent = message;
    openBanner(banner, [text]);
}

function openBanner(banner: HTMLElement, content: HTMLElement[]): void {
    const body = document.createElement('div');
    body.className = 'banner-body';
    body.append(...content);
    const close = button('×', () => {
        banner.hidden = true;
    });
    close.className = 'banner-close';
    close.setAttribute('aria-label', '閉じる');
    banner.replaceChildren(body, close);
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
