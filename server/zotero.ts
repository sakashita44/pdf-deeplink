import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { FileSource } from './config.ts';
import {
    bodyOf,
    discard,
    fetchWebdavFile,
    followRedirects,
    openLocalFile,
    resolveRoots,
    type FileBody,
} from './files.ts';
import { get, readBody, UpstreamError, type Endpoint } from './http.ts';

export { UpstreamError };

export const SORT_KEYS = [
    'dateModified',
    'dateAdded',
    'title',
    'creator',
    'date',
] as const;
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
const MAX_JSON_BYTES = 32 * 1024 * 1024;
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
    apiKey?: string;
    file: FileSource;
    timeoutMs: number;
}

interface ZoteroItem {
    key: string;
    links?: { attachment?: { href: string; attachmentType?: string } };
    meta?: { numChildren?: number };
    data: {
        itemType: string;
        title?: string;
        date?: string;
        parentItem?: string;
        contentType?: string;
        filename?: string;
        publicationTitle?: string;
        DOI?: string;
        creators?: { firstName?: string; lastName?: string; name?: string }[];
    };
}

const ITEM_KEY = /^[A-Z0-9]{8}$/;

export class ZoteroSource {
    readonly #options: ZoteroSourceOptions;

    readonly #localRoots: string[];

    #attachmentIndex: {
        at: number;
        promise: Promise<Map<string, string>>;
    } | null = null;

    readonly #searchCache = new Map<
        string,
        { at: number; documents: DocumentSummary[]; truncated: boolean }
    >();

    constructor(options: ZoteroSourceOptions) {
        if (
            options.file.kind === 'template' &&
            !options.file.path.includes('{key}')
        )
            throw new Error('the file path must contain {key}');
        this.#options = {
            ...options,
            apiPath: options.apiPath.replace(/\/$/, ''),
        };
        this.#localRoots =
            options.file.kind === 'local'
                ? resolveRoots(options.file.dirs)
                : [];
    }

    async search(
        options: SearchOptions,
        signal: AbortSignal,
    ): Promise<SearchResult> {
        const { documents, truncated } = await this.#pdfDocuments(
            options,
            signal,
        );
        return {
            documents: documents.slice(
                options.start,
                options.start + options.limit,
            ),
            total: documents.length,
            truncated,
        };
    }

    async #pdfDocuments(
        options: SearchOptions,
        signal: AbortSignal,
    ): Promise<{ documents: DocumentSummary[]; truncated: boolean }> {
        const cacheKey = JSON.stringify([
            options.query,
            options.sort,
            options.direction,
        ]);
        const cached = this.#searchCache.get(cacheKey);
        if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached;
        const params = new URLSearchParams({
            sort: options.sort,
            direction: options.direction,
        });
        if (options.query) params.set('q', options.query);
        const { items, truncated } = await this.#scan(
            `${this.#options.apiPath}/items/top`,
            params,
            signal,
        );
        const index = items.some(needsAttachmentIndex)
            ? await this.#pdfAttachments(signal)
            : new Map<string, string>();
        const documents = items.flatMap((item) => pdfSummary(item, index));
        const entry = { at: Date.now(), documents, truncated };
        this.#searchCache.set(cacheKey, entry);
        if (this.#searchCache.size > SEARCH_CACHE_ENTRIES)
            this.#searchCache.delete(this.#searchCache.keys().next().value!);
        return entry;
    }

    async #scan(
        path: string,
        params: URLSearchParams,
        signal: AbortSignal,
    ): Promise<{ items: ZoteroItem[]; truncated: boolean }> {
        const items: ZoteroItem[] = [];
        let start = 0;
        let total = Infinity;
        while (start < total && start < MAX_SCANNED_ITEMS) {
            const page = new URLSearchParams(params);
            page.set('start', String(start));
            page.set('limit', String(PAGE_LIMIT));
            const { body, headers } = await this.#json<ZoteroItem[]>(
                `${path}?${page}`,
                signal,
            );
            items.push(...body);
            const reported = headers['total-results'];
            total =
                typeof reported === 'string' && /^d+$/.test(reported)
                    ? Number(reported)
                    : body.length < PAGE_LIMIT
                      ? start + body.length
                      : Infinity;
            if (body.length === 0) break;
            start += body.length;
        }
        return { items, truncated: start < total };
    }

    #pdfAttachments(signal: AbortSignal): Promise<Map<string, string>> {
        const cached = this.#attachmentIndex;
        if (cached && Date.now() - cached.at < SEARCH_CACHE_MS)
            return cached.promise;
        const promise = this.#scan(
            `${this.#options.apiPath}/items`,
            new URLSearchParams({
                itemType: 'attachment',
                sort: 'dateAdded',
                direction: 'asc',
            }),
            signal,
        ).then(({ items }) => {
            const index = new Map<string, string>();
            for (const item of items) {
                const parent = item.data.parentItem;
                if (parent && isPdf(item) && !index.has(parent))
                    index.set(parent, item.key);
            }
            return index;
        });
        this.#attachmentIndex = { at: Date.now(), promise };
        promise.catch(() => {
            if (this.#attachmentIndex?.promise === promise)
                this.#attachmentIndex = null;
        });
        return promise;
    }

    async metadata(
        key: string,
        signal: AbortSignal,
    ): Promise<DocumentMetadata | null> {
        const attachment = await this.#item(key, signal);
        if (!attachment || !isPdf(attachment)) return null;
        const parentKey = attachment.data.parentItem;
        const parent =
            parentKey && ITEM_KEY.test(parentKey)
                ? await this.#item(parentKey, signal)
                : null;
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

    async file(key: string, signal: AbortSignal): Promise<FileBody> {
        const attachment = await this.#item(key, signal);
        if (!attachment || !isPdf(attachment))
            throw new UpstreamError(404, `${key} is not a PDF attachment`);
        const source = this.#options.file;
        const { timeoutMs } = this.#options;
        const fileApiPath = `${this.#options.apiPath}/items/${key}/file`;
        switch (source.kind) {
            case 'template': {
                const response = await this.#request(
                    source.path.replace('{key}', key),
                    signal,
                );
                if (response.statusCode !== 200)
                    discard(response, 'file request');
                return bodyOf(response);
            }
            case 'local': {
                const response = await this.#request(fileApiPath, signal);
                response.resume();
                const location = response.headers.location;
                if (response.statusCode !== 302 || typeof location !== 'string')
                    throw new UpstreamError(
                        response.statusCode === 404 ? 404 : 502,
                        `file request returned ${response.statusCode}`,
                    );
                return openLocalFile(this.#localRoots, location, key);
            }
            case 'web':
                return followRedirects(
                    await this.#request(fileApiPath, signal),
                    timeoutMs,
                    signal,
                );
            case 'webdav':
                return fetchWebdavFile(
                    source.url,
                    source.credentials,
                    key,
                    attachment.data.filename,
                    timeoutMs,
                    signal,
                );
        }
    }

    async #item(key: string, signal: AbortSignal): Promise<ZoteroItem | null> {
        try {
            return (
                await this.#json<ZoteroItem>(
                    `${this.#options.apiPath}/items/${key}`,
                    signal,
                )
            ).body;
        } catch (error) {
            if (error instanceof UpstreamError && error.status === 404)
                return null;
            throw error;
        }
    }

    async #json<T>(
        path: string,
        signal: AbortSignal,
    ): Promise<{ body: T; headers: IncomingHttpHeaders }> {
        const response = await this.#request(path, signal);
        if (response.statusCode !== 200) {
            response.resume();
            throw new UpstreamError(
                response.statusCode ?? 502,
                `request returned ${response.statusCode} for ${path}`,
            );
        }
        const body = await readBody(response, MAX_JSON_BYTES, path);
        return {
            body: JSON.parse(body.toString('utf8')) as T,
            headers: response.headers,
        };
    }

    #request(path: string, signal: AbortSignal): Promise<IncomingMessage> {
        return get(this.#options.endpoint, path, {
            headers: {
                'Zotero-API-Version': '3',
                ...(this.#options.apiKey
                    ? { 'Zotero-API-Key': this.#options.apiKey }
                    : {}),
            },
            timeoutMs: this.#options.timeoutMs,
            signal,
            label: path,
        });
    }
}

function needsAttachmentIndex(item: ZoteroItem): boolean {
    return (
        !isPdf(item) &&
        item.links?.attachment === undefined &&
        (item.meta?.numChildren ?? 0) > 0
    );
}

function pdfSummary(
    item: ZoteroItem,
    index: Map<string, string>,
): DocumentSummary[] {
    if (isPdf(item)) return [summary(item, item.key)];
    const attachment = item.links?.attachment;
    if (attachment === undefined) {
        const key = index.get(item.key);
        return key ? [summary(item, key)] : [];
    }
    if (attachment.attachmentType !== 'application/pdf') return [];
    const key = /\/items\/([A-Z0-9]{8})$/.exec(attachment.href)?.[1];
    return key ? [summary(item, key)] : [];
}

function isPdf(item: ZoteroItem): boolean {
    return (
        item.data.itemType === 'attachment' &&
        item.data.contentType === 'application/pdf'
    );
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
    const names = (item.data.creators ?? []).map(
        (creator) =>
            creator.name ?? creator.lastName ?? creator.firstName ?? '',
    );
    if (names.length > 2) return `${names[0]} ほか`;
    return names.join(', ');
}

function year(item: ZoteroItem): string {
    return /\d{4}/.exec(item.data.date ?? '')?.[0] ?? '';
}
