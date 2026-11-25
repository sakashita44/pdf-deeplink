import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';

export const SORT_KEYS = ['dateModified', 'dateAdded', 'title', 'creator', 'date'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface SearchOptions {
    query: string;
    sort: SortKey;
    direction: 'asc' | 'desc';
    start: number;
    limit: number;
}

export interface SearchResult {
    documents: DocumentSummary[];
    total: number;
    truncated: boolean;
}

const PAGE_LIMIT = 100;
const MAX_SCANNED_ITEMS = 5000;
const SEARCH_CACHE_MS = 60_000;
const SEARCH_CACHE_ENTRIES = 16;

export interface DocumentSummary {
    src: string;
    title: string;
    creators: string;
    year: string;
}

export interface DocumentMetadata {
    src: string;
    title: string;
    creators: string;
    year: string;
    publication: string;
    doi: string;
}

export interface ZoteroSourceOptions {
    endpoint: Endpoint;
    apiPath: string;
    filePath: string;
    timeoutMs: number;
}

export class UpstreamError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

interface ZoteroItem {
    key: string;
    links?: { attachment?: { href: string; attachmentType?: string } };
    data: {
        itemType: string;
        title?: string;
        date?: string;
        parentItem?: string;
        contentType?: string;
        publicationTitle?: string;
        DOI?: string;
        creators?: { firstName?: string; lastName?: string; name?: string }[];
    };
}

const ITEM_KEY = /^[A-Z0-9]{8}$/;

export type Endpoint = { socketPath: string } | { host: string; port: number };

export function parseEndpoint(value: string): Endpoint {
    if (value.startsWith('unix:')) return { socketPath: value.slice('unix:'.length) };
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.pathname !== '/') throw new Error(`unsupported endpoint: ${value}`);
    return { host: url.hostname, port: Number(url.port || 80) };
}

export class ZoteroSource {
    readonly #options: ZoteroSourceOptions;

    readonly #searchCache = new Map<string, { at: number; documents: DocumentSummary[]; truncated: boolean }>();

    constructor(options: ZoteroSourceOptions) {
        if (!options.filePath.includes('{key}')) throw new Error('the file path must contain {key}');
        this.#options = { ...options, apiPath: options.apiPath.replace(/\/$/, '') };
    }

    async search(options: SearchOptions, signal: AbortSignal): Promise<SearchResult> {
        const { documents, truncated } = await this.#pdfDocuments(options, signal);
        return {
            documents: documents.slice(options.start, options.start + options.limit),
            total: documents.length,
            truncated,
        };
    }

    async #pdfDocuments(options: SearchOptions, signal: AbortSignal): Promise<{ documents: DocumentSummary[]; truncated: boolean }> {
        const cacheKey = JSON.stringify([options.query, options.sort, options.direction]);
        const cached = this.#searchCache.get(cacheKey);
        if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached;
        const documents: DocumentSummary[] = [];
        let start = 0;
        let total = Infinity;
        while (start < total && start < MAX_SCANNED_ITEMS) {
            const params = new URLSearchParams({ start: String(start), limit: String(PAGE_LIMIT), sort: options.sort, direction: options.direction });
            if (options.query) params.set('q', options.query);
            // items/top は子の添付を含まないため、添付のキーは links.attachment から得る。
            const { body: items, headers } = await this.#json<ZoteroItem[]>(`${this.#options.apiPath}/items/top?${params}`, signal);
            documents.push(...items.flatMap(pdfSummary));
            const reported = Number(headers['total-results']);
            total = Number.isFinite(reported) ? reported : items.length < PAGE_LIMIT ? start + items.length : Infinity;
            if (items.length === 0) break;
            start += items.length;
        }
        const entry = { at: Date.now(), documents, truncated: start < total };
        this.#searchCache.set(cacheKey, entry);
        if (this.#searchCache.size > SEARCH_CACHE_ENTRIES) this.#searchCache.delete(this.#searchCache.keys().next().value!);
        return entry;
    }

    async metadata(key: string, signal: AbortSignal): Promise<DocumentMetadata | null> {
        const attachment = await this.#item(key, signal);
        if (!attachment || !isPdf(attachment)) return null;
        const parentKey = attachment.data.parentItem;
        const parent = parentKey && ITEM_KEY.test(parentKey) ? await this.#item(parentKey, signal) : null;
        const source = parent ?? attachment;
        return {
            src: `zotero:${key}`,
            title: source.data.title ?? '',
            creators: formatCreators(source),
            year: year(source),
            publication: source.data.publicationTitle ?? '',
            doi: source.data.DOI ?? '',
        };
    }

    async file(key: string, signal: AbortSignal): Promise<IncomingMessage> {
        const response = await this.#request(this.#options.filePath.replace('{key}', key), signal);
        if (response.statusCode !== 200) {
            response.resume();
            throw new UpstreamError(response.statusCode ?? 502, `file request returned ${response.statusCode}`);
        }
        return response;
    }

    async #item(key: string, signal: AbortSignal): Promise<ZoteroItem | null> {
        try {
            return (await this.#json<ZoteroItem>(`${this.#options.apiPath}/items/${key}`, signal)).body;
        } catch (error) {
            if (error instanceof UpstreamError && error.status === 404) return null;
            throw error;
        }
    }

    async #json<T>(path: string, signal: AbortSignal): Promise<{ body: T; headers: IncomingHttpHeaders }> {
        const response = await this.#request(path, signal);
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(chunk as Buffer);
        if (response.statusCode !== 200) {
            throw new UpstreamError(response.statusCode ?? 502, `request returned ${response.statusCode} for ${path}`);
        }
        return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T, headers: response.headers };
    }

    #request(path: string, signal: AbortSignal): Promise<IncomingMessage> {
        return new Promise((resolve, reject) => {
            const req = request(
                { ...this.#options.endpoint, path, method: 'GET', headers: { 'Zotero-API-Version': '3' }, signal },
                resolve,
            );
            req.setTimeout(this.#options.timeoutMs, () => req.destroy(new UpstreamError(504, `request timed out: ${path}`)));
            req.on('error', reject);
            req.end();
        });
    }
}

function pdfSummary(item: ZoteroItem): DocumentSummary[] {
    if (isPdf(item)) return [summary(item, item.key)];
    const attachment = item.links?.attachment;
    if (attachment?.attachmentType !== 'application/pdf') return [];
    const key = /\/items\/([A-Z0-9]{8})$/.exec(attachment.href)?.[1];
    return key ? [summary(item, key)] : [];
}

function isPdf(item: ZoteroItem): boolean {
    return item.data.itemType === 'attachment' && item.data.contentType === 'application/pdf';
}

function summary(item: ZoteroItem, attachmentKey: string): DocumentSummary {
    return {
        src: `zotero:${attachmentKey}`,
        title: item.data.title ?? '',
        creators: formatCreators(item),
        year: year(item),
    };
}

function formatCreators(item: ZoteroItem): string {
    const names = (item.data.creators ?? []).map((creator) => creator.name ?? creator.lastName ?? creator.firstName ?? '');
    if (names.length > 2) return `${names[0]} ほか`;
    return names.join(', ');
}

function year(item: ZoteroItem): string {
    return /\d{4}/.exec(item.data.date ?? '')?.[0] ?? '';
}
