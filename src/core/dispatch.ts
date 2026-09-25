import type { Dispatcher, RouteRequest, ToolContext } from './types.js';

export function buildUrl(base: string, req: Pick<RouteRequest, 'path' | 'query'>): string {
  const url = new URL(base.replace(/\/+$/, '') + req.path);
  for (const [k, v] of Object.entries(req.query)) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  return url.toString();
}

export interface FetchDispatcherOptions {
  /**
   * Base URL of the API, e.g. `http://127.0.0.1:3000` or `https://api.example.com/v1`.
   * A function lets adapters resolve it per call (e.g. from the local port).
   */
  baseUrl: string | ((ctx: ToolContext) => string);
  /** Custom fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. @default 30_000 */
  timeoutMs?: number;
}

/**
 * Dispatches tool calls as real HTTP requests. Used for loopback calls into the
 * host app (Express, Koa, NestJS) and for standalone gateways in front of any API.
 */
export function createFetchDispatcher(opts: FetchDispatcherOptions): Dispatcher {
  const doFetch = opts.fetch ?? fetch;
  return async (req, ctx) => {
    const base = typeof opts.baseUrl === 'function' ? opts.baseUrl(ctx) : opts.baseUrl;
    const res = await doFetch(buildUrl(base, req), {
      method: req.method,
      headers: req.headers,
      body:
        req.body === undefined || req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, body: await res.text() };
  };
}
