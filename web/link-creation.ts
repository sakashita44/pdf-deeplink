import {
    mergeSelectionRects,
    toLinkRect,
    type PageGeometry,
    type Point,
} from '../shared/geometry.ts';
import {
    formatLink,
    LIMITS,
    type PageRects,
    type PdfLink,
} from '../shared/link.ts';
import {
    citation,
    labelRange,
    pagesText,
    type DocumentMetadata,
} from '../shared/notation.ts';
import { normalizeQuote } from '../shared/quote.ts';
import {
    pageOrigin,
    toPdfPoint,
    type PageInfo,
    type Pages,
    type PageViewLike,
} from './pages.ts';
import { clamp, copy, toast } from './ui.ts';

const QUOTE_CHARS = 100;
const TOO_LARGE = '選択した範囲が大きすぎます。範囲を狭めてください。';

interface Selection {
    regions: PageRects[];
    q: string;
    anchor: DOMRect;
    source?: Range;
}

export interface LinkCreationContext {
    src: string;
    pdfSha256: string;
    meta: DocumentMetadata | null;
    labelOf: (page: number) => string | undefined;
    pages: Pages;
    container: HTMLElement;
    popup: HTMLElement;
    popupSummary: HTMLElement;
    popupInput: HTMLInputElement;
    toast: HTMLElement;
    modeButtons: HTMLButtonElement[];
}

export function setupLinkCreation(context: LinkCreationContext): void {
    const { pages, container, popup, popupSummary, popupInput } = context;
    let selection: Selection | null = null;
    let mode: 'text' | 'area' = 'text';

    function openPopup(next: Selection): void {
        selection = next;
        const count = next.regions.flatMap(({ rects }) => rects).length;
        const where = pagesText({
            regions: next.regions,
            label: labelRange(next.regions, context.labelOf),
        });
        popupSummary.textContent = `${where} の${mode === 'text' ? '文章' : '範囲'}（矩形 ${count} 個）`;
        popupInput.value = next.q;
        popup.hidden = false;
        const { innerWidth, innerHeight } = window;
        const width = popup.offsetWidth;
        const height = popup.offsetHeight;
        popup.style.left = `${Math.max(8, Math.min(next.anchor.left, innerWidth - width - 8))}px`;
        const below = next.anchor.bottom + 8;
        const top =
            below + height > innerHeight ? next.anchor.top - height - 8 : below;
        popup.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
        if (mode === 'area') popupInput.focus();
    }

    function closePopup(): void {
        selection = null;
        popup.hidden = true;
    }

    function currentLink(): PdfLink | null {
        if (!selection) return null;
        const q = popupInput.value.trim();
        const label = labelRange(selection.regions, context.labelOf);
        return {
            src: context.src,
            sha256: context.pdfSha256,
            regions: selection.regions,
            ...(label ? { label } : {}),
            ...(q ? { q } : {}),
        };
    }

    function bodySelection(): Range | null {
        const current = document.getSelection();
        if (!current || current.isCollapsed || current.rangeCount === 0)
            return null;
        const range = current.getRangeAt(0);
        return container.contains(range.commonAncestorContainer) ? range : null;
    }

    function handleTextSelection(): void {
        const range = bodySelection();
        if (!range) return;
        const result = selectionToLink(range, pages);
        if (result === 'too-large') {
            closePopup();
            toast(context.toast, TOO_LARGE);
            return;
        }
        if (!result) {
            closePopup();
            return;
        }
        openPopup({ ...result, source: range.cloneRange() });
    }

    function selectionChanged(): boolean {
        const source = selection?.source;
        const range = bodySelection();
        if (!source || !range) return false;
        return (
            range.compareBoundaryPoints(Range.START_TO_START, source) !== 0 ||
            range.compareBoundaryPoints(Range.END_TO_END, source) !== 0
        );
    }

    // ポップアップ内の mousedown で本文の選択が解除されると、selectionchange でポップアップが閉じ、選択した範囲も失われる。
    popup.addEventListener('mousedown', (event) => {
        if (event.target !== popupInput) event.preventDefault();
    });

    popup.addEventListener('click', (event) => {
        const action = (event.target as HTMLElement).closest<HTMLElement>(
            '[data-action]',
        )?.dataset.action;
        if (action === 'close') {
            closePopup();
            return;
        }
        if (selectionChanged()) {
            handleTextSelection();
            return;
        }
        const target = currentLink();
        if (!target) return;
        if (action === 'copy-link') {
            void copy(
                context.toast,
                `${location.origin}/view?${formatLink(target)}`,
                'リンクをコピーしました',
            );
        } else if (action === 'copy-citation') {
            void copy(
                context.toast,
                citation(context.meta, pagesText(target), target.q),
                '出典をコピーしました',
            );
        }
    });

    container.addEventListener('pointerup', () => {
        // pointerup の時点では、ブラウザが選択範囲をまだ確定していないことがあるため、次のタスクで読む。
        if (mode === 'text') window.setTimeout(handleTextSelection, 0);
    });
    document.addEventListener('keyup', (event) => {
        if (
            mode === 'text' &&
            event.shiftKey &&
            !popup.contains(event.target as Node)
        )
            window.setTimeout(handleTextSelection, 0);
    });
    document.addEventListener('selectionchange', () => {
        if (
            mode === 'text' &&
            document.getSelection()?.isCollapsed &&
            !popup.contains(document.activeElement)
        )
            closePopup();
    });

    let drag:
        | (PageInfo & {
              start: Point;
              startClient: Point;
              box: HTMLDivElement;
          })
        | null = null;
    container.addEventListener('pointerdown', (event) => {
        if (mode !== 'area' || event.button !== 0) return;
        const target = pages.of(event.target as Node);
        if (!target) return;
        event.preventDefault();
        closePopup();
        container.setPointerCapture(event.pointerId);
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
    container.addEventListener('pointercancel', () => {
        drag?.box.remove();
        drag = null;
    });
    container.addEventListener('pointermove', (event) => {
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
    container.addEventListener('pointerup', (event) => {
        if (!drag) return;
        const current = drag;
        drag = null;
        const anchor = current.box.getBoundingClientRect();
        current.box.remove();
        const origin = pageOrigin(current.view) ?? current.origin;
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

    for (const modeButton of context.modeButtons) {
        modeButton.addEventListener('click', () => {
            mode = modeButton.dataset.mode === 'area' ? 'area' : 'text';
            for (const other of context.modeButtons)
                other.setAttribute(
                    'aria-pressed',
                    String(other === modeButton),
                );
            container.classList.toggle('area-mode', mode === 'area');
            document.getSelection()?.removeAllRanges();
            closePopup();
        });
    }
}

function selectionToLink(
    range: Range,
    pages: Pages,
): Selection | 'too-large' | null {
    // PDF.js は描画したページを一定数だけ保持し、古いページのテキストレイヤーを破棄する。長い選択の途中で端のページが破棄されると、選択の端はテキストレイヤーの外へ移り、そのページの文字が選択から抜け落ちる。
    if (!inTextLayer(range.startContainer) || !inTextLayer(range.endContainer))
        return 'too-large';
    const regions: PageRects[] = [];
    const texts: string[] = [];
    let anchor: DOMRect | undefined;
    for (const selected of selectedPages(range)) {
        const info = pages.info(selected.page);
        if (!info) continue;
        const parts = visibleParts(selected.parts, info.origin);
        const inPage = parts.flatMap(({ rects }) => rects);
        const rects = mergeSelectionRects(
            inPage.map((rect) => toRect(info, rect)),
        );
        if (!rects.length) continue;
        regions.push({ page: info.page, rects });
        texts.push(parts.map(({ text }) => text).join(''));
        anchor = inPage.at(-1);
    }
    if (!regions.length || !anchor) return null;
    if (regions.flatMap(({ rects }) => rects).length > LIMITS.rects)
        return 'too-large';
    // PDFFindController はページごとに文字列を照合し、ページをまたいで一致しないため、検索用テキストは最初のページの部分から作る。
    const q = [...normalizeQuote(texts[0] ?? '')]
        .slice(0, QUOTE_CHARS)
        .join('');
    return { regions, q, anchor };
}

function toRect(
    {
        view,
        geometry,
        origin,
    }: { view: PageViewLike; geometry: PageGeometry; origin: DOMRect },
    rect: DOMRect,
) {
    return toLinkRect(
        geometry,
        toPdfPoint(view, origin, rect.left, rect.top),
        toPdfPoint(view, origin, rect.right, rect.bottom),
    );
}

// PDF.js のテキストレイヤーは空白だけの要素を含み、getClientRects() が幅のない矩形を返すことがある。また CropBox の外にある文字も要素として置き、CSS で隠しているため、ページの表示領域と重ならない矩形も除く。
function visibleParts(parts: SelectedPart[], origin: DOMRect): SelectedPart[] {
    const sized = (rect: DOMRect) => rect.width > 0.5 && rect.height > 0.5;
    const inside = (rect: DOMRect) =>
        rect.left >= origin.left - 1 &&
        rect.right <= origin.right + 1 &&
        rect.top >= origin.top - 1 &&
        rect.bottom <= origin.bottom + 1;
    return parts
        .map((part) => {
            const rects = part.rects.filter(sized);
            if (!part.range || rects.every(inside)) return { ...part, rects };
            return visibleCharacters(part.range, inside);
        })
        .filter(({ rects, text }) => text === '\n' || rects.length);
}

// 表示領域の境界をまたぐテキストノードは、1 文字ずつ位置を調べ、表示領域に収まる文字だけを残す。
function visibleCharacters(
    range: Range,
    inside: (rect: DOMRect) => boolean,
): SelectedPart {
    const node = range.startContainer;
    const rects: DOMRect[] = [];
    let text = '';
    const character = document.createRange();
    for (let offset = range.startOffset; offset < range.endOffset; offset++) {
        character.setStart(node, offset);
        character.setEnd(node, offset + 1);
        const rect = character.getBoundingClientRect();
        if (rect.width > 0.5 && rect.height > 0.5 && !inside(rect)) continue;
        text += character.toString();
        if (rect.width > 0.5 && rect.height > 0.5) rects.push(rect);
    }
    return { rects, text };
}

function inTextLayer(node: Node): boolean {
    const element = node instanceof Element ? node : node.parentElement;
    return !!element?.closest('.textLayer');
}

interface SelectedPart {
    rects: DOMRect[];
    text: string;
    range?: Range;
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
                range: part,
            });
        }
    }
    return [...pages.values()].sort((a, b) => a.page - b.page);
}
