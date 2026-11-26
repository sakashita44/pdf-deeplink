import {
    request as httpRequest,
    type IncomingMessage,
    type OutgoingHttpHeaders,
} from 'node:http';
import { request as httpsRequest } from 'node:https';

export type Endpoint =
    | { socketPath: string }
    | { protocol: 'http:' | 'https:'; host: string; port: number };

export class UpstreamError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export function parseEndpoint(value: string): Endpoint {
    if (value.startsWith('unix:'))
        return { socketPath: value.slice('unix:'.length) };
    const url = new URL(value);
    if (
        (url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.pathname !== '/'
    )
        throw new Error(`unsupported endpoint: ${value}`);
    return endpointOf(url);
}

export function endpointOf(url: URL): Endpoint {
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error(`unsupported protocol: ${url.protocol}`);
    return {
        protocol: url.protocol,
        host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    };
}

export interface GetOptions {
    headers: OutgoingHttpHeaders;
    timeoutMs: number;
    signal: AbortSignal;
    label: string;
}

export function get(
    endpoint: Endpoint,
    path: string,
    options: GetOptions,
): Promise<IncomingMessage> {
    const send =
        'protocol' in endpoint && endpoint.protocol === 'https:'
            ? httpsRequest
            : httpRequest;
    const target =
        'socketPath' in endpoint
            ? { socketPath: endpoint.socketPath }
            : { host: endpoint.host, port: endpoint.port };
    return new Promise((resolve, reject) => {
        const req = send(
            {
                ...target,
                path,
                method: 'GET',
                headers: options.headers,
                signal: options.signal,
            },
            resolve,
        );
        req.setTimeout(options.timeoutMs, () =>
            req.destroy(
                new UpstreamError(504, `request timed out: ${options.label}`),
            ),
        );
        req.on('error', reject);
        req.end();
    });
}

export async function readBody(
    response: IncomingMessage,
    maxBytes: number,
    label: string,
): Promise<Buffer> {
    const declared = Number(response.headers['content-length']);
    if (declared > maxBytes) {
        response.destroy();
        throw new UpstreamError(502, `response is too large for ${label}`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
            response.destroy();
            throw new UpstreamError(502, `response is too large for ${label}`);
        }
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
}
