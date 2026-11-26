import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
    EventBus,
    PDFFindController,
    PDFLinkService,
    PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { isValidSrc, parseLink } from '../shared/link.ts';
import {
    citation,
    pagesText,
    type DocumentMetadata,
} from '../shared/notation.ts';
import { setupLinkCreation } from './link-creation.ts';
import { showLink } from './link-display.ts';
import { createPages } from './pages.ts';
import { copy, showBanner } from './ui.ts';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
const PDFJS_ASSETS = new URL('/pdfjs/', location.origin).href;

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
    const pdfSha256 = await digest(data);

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
    const labelOf = (page: number) => pageLabels?.[page - 1] || undefined;
    const pages = createPages(viewer);

    eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'page-width';
        ui.pageLabel.textContent = `p.${labelOf(1) ?? 1} / ${pdf.numPages}`;
        if (!link) return;
        showLink(
            {
                pdf,
                pdfSha256,
                viewer,
                eventBus,
                linkService,
                pages,
                banner: ui.banner,
            },
            link,
        );
    });

    eventBus.on(
        'pagechanging',
        (event: { pageNumber: number; pageLabel?: string | null }) => {
            ui.pageLabel.textContent = `p.${event.pageLabel || event.pageNumber} / ${pdf.numPages}`;
        },
    );

    if (link) {
        ui.linkCitation.hidden = false;
        ui.linkCitation.addEventListener(
            'click',
            () =>
                void copy(
                    ui.toast,
                    citation(meta, pagesText(link), link.q),
                    '出典をコピーしました',
                ),
        );
    }

    setupLinkCreation({
        src,
        pdfSha256,
        meta,
        labelOf,
        pages,
        container: ui.container,
        popup: ui.popup,
        popupSummary: ui.popupSummary,
        popupInput: ui.popupInput,
        toast: ui.toast,
        modeButtons: ui.modeButtons,
    });
}

async function digest(data: Uint8Array<ArrayBuffer>): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}
