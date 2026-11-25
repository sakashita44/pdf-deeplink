interface DocumentSummary {
    src: string;
    title: string;
    creators: string;
    year: string;
}

interface SearchResult {
    documents: DocumentSummary[];
    total: number;
    truncated: boolean;
}

const ORDERS = [
    { value: 'dateModified-desc', label: '更新日（新しい順）' },
    { value: 'dateAdded-desc', label: '追加日（新しい順）' },
    { value: 'title-asc', label: 'タイトル（昇順）' },
    { value: 'creator-asc', label: '著者（昇順）' },
    { value: 'date-desc', label: '発行年（新しい順）' },
    { value: 'date-asc', label: '発行年（古い順）' },
] as const;

const PAGE_SIZES = [20, 50, 100] as const;

interface ListState {
    q: string;
    order: string;
    size: number;
    page: number;
}

export function renderList(app: HTMLElement): void {
    app.innerHTML = `
        <main class="list">
            <div class="list-controls">
                <h1>PDF 箇所リンク</h1>
                <form class="search" role="search">
                    <input type="search" name="q" placeholder="タイトル・著者・年で検索" aria-label="検索語" />
                    <button type="submit">検索</button>
                </form>
                <div class="list-options">
                    <label>並び順 <select name="order"></select></label>
                    <label>表示件数 <select name="size"></select></label>
                </div>
                <p class="hint">PDF が添付されている文献だけを表示しています。</p>
            </div>
            <p class="status" role="status"></p>
            <ul class="documents"></ul>
            <nav class="pagination" aria-label="ページ"></nav>
        </main>`;
    const form = app.querySelector<HTMLFormElement>('form')!;
    const input = form.querySelector<HTMLInputElement>('input')!;
    const orderSelect = app.querySelector<HTMLSelectElement>('select[name=order]')!;
    const sizeSelect = app.querySelector<HTMLSelectElement>('select[name=size]')!;
    const status = app.querySelector<HTMLElement>('.status')!;
    const list = app.querySelector<HTMLUListElement>('.documents')!;
    const pagination = app.querySelector<HTMLElement>('.pagination')!;

    for (const order of ORDERS) orderSelect.append(new Option(order.label, order.value));
    for (const size of PAGE_SIZES) sizeSelect.append(new Option(`${size} 件`, String(size)));

    let state = readState(new URLSearchParams(location.search));
    let latest = 0;

    const render = async () => {
        const request = ++latest;
        input.value = state.q;
        orderSelect.value = state.order;
        sizeSelect.value = String(state.size);
        status.textContent = '読み込んでいます…';
        const [sort, direction] = state.order.split('-') as [string, string];
        const params = new URLSearchParams({
            q: state.q,
            sort,
            direction,
            start: String((state.page - 1) * state.size),
            limit: String(state.size),
        });
        let result: SearchResult;
        try {
            const response = await fetch(`/app/documents?${params}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            result = (await response.json()) as SearchResult;
        } catch (error) {
            if (request !== latest) return;
            const detail = error instanceof Error ? `（${error.message}）` : '';
            status.textContent = `文献を読み込めませんでした${detail}。時間をおいて、もう一度お試しください。`;
            return;
        }
        if (request !== latest) return;
        const pages = Math.max(1, Math.ceil(result.total / state.size));
        if (state.page > pages) {
            navigate({ ...state, page: pages });
            return;
        }
        list.replaceChildren(...result.documents.map(documentItem));
        const first = (state.page - 1) * state.size + 1;
        const last = first + result.documents.length - 1;
        status.textContent =
            result.total === 0
                ? '該当する文献はありません。'
                : `全 ${result.total} 件中 ${first}〜${last} 件を表示${result.truncated ? '（検索対象が多いため、一部の文献だけを対象にしています）' : ''}`;
        renderPagination(pagination, state.page, pages, (page) => navigate({ ...state, page }));
    };

    const navigate = (next: ListState) => {
        state = next;
        history.replaceState(null, '', writeState(state));
        void render();
        window.scrollTo({ top: 0 });
    };

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        navigate({ ...state, q: input.value.trim(), page: 1 });
    });
    orderSelect.addEventListener('change', () => navigate({ ...state, order: orderSelect.value, page: 1 }));
    sizeSelect.addEventListener('change', () => navigate({ ...state, size: Number(sizeSelect.value), page: 1 }));
    void render();
}

function readState(params: URLSearchParams): ListState {
    const order = params.get('order') ?? '';
    const size = Number(params.get('size'));
    const page = Number(params.get('page'));
    return {
        q: params.get('q') ?? '',
        order: ORDERS.some((candidate) => candidate.value === order) ? order : ORDERS[0].value,
        size: (PAGE_SIZES as readonly number[]).includes(size) ? size : PAGE_SIZES[1],
        page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    };
}

function writeState(state: ListState): string {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.order !== ORDERS[0].value) params.set('order', state.order);
    if (state.size !== PAGE_SIZES[1]) params.set('size', String(state.size));
    if (state.page !== 1) params.set('page', String(state.page));
    return params.size ? `/?${params}` : '/';
}

function renderPagination(nav: HTMLElement, current: number, pages: number, go: (page: number) => void): void {
    nav.replaceChildren();
    if (pages <= 1) return;
    const add = (label: string, page: number | null, options: { current?: boolean; ariaLabel?: string } = {}) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        if (options.ariaLabel) button.setAttribute('aria-label', options.ariaLabel);
        if (options.current) button.setAttribute('aria-current', 'page');
        if (page === null || options.current) {
            button.disabled = true;
        } else {
            button.addEventListener('click', () => go(page));
        }
        nav.append(button);
    };
    add('前へ', current > 1 ? current - 1 : null, { ariaLabel: '前のページ' });
    let previous = 0;
    for (const page of visiblePages(current, pages)) {
        if (page - previous > 1) {
            const gap = document.createElement('span');
            gap.textContent = '…';
            gap.className = 'gap';
            nav.append(gap);
        }
        add(String(page), page, { current: page === current, ariaLabel: `${page} ページ目` });
        previous = page;
    }
    add('次へ', current < pages ? current + 1 : null, { ariaLabel: '次のページ' });
}

function visiblePages(current: number, pages: number): number[] {
    const candidates = new Set([1, pages, current - 1, current, current + 1]);
    return [...candidates].filter((page) => page >= 1 && page <= pages).sort((a, b) => a - b);
}

function documentItem(doc: DocumentSummary): HTMLLIElement {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = `/view?${new URLSearchParams({ src: doc.src })}`;
    link.textContent = doc.title || '（無題）';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [doc.creators, doc.year].filter(Boolean).join('・');
    item.append(link, meta);
    return item;
}
