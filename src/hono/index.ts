import { buildUrl } from '../core/dispatch.js';
import { mark, markerOf } from '../core/marker.js';
import { createRouteTool } from '../core/route-tool.js';
import { McpServer } from '../core/server.js';
import type { Dispatcher, McpServerOptions, McpToolDefinition, RouteToolOptions, ToolContext } from '../core/types.js';

interface HonoContextLike {
  req: { method: string; raw: Request; header(): Record<string, string> };
  env?: unknown;
}
type HonoMiddleware = (c: HonoContextLike, next: () => Promise<void>) => Promise<void | Response>;

interface HonoLike {
  routes: { method: string; path: string; handler: unknown }[];
  request(input: string, init?: RequestInit, env?: unknown): Response | Promise<Response>;
  on(method: string[], path: string, handler: (c: HonoContextLike) => Promise<Response>): unknown;
}

/**
 * Mark a Hono route as an MCP tool:
 *
 *   app.get('/users/:id', mcpTool({ description: 'Get a user' }), auth, (c) => ...)
 */
export function mcpTool(options: RouteToolOptions = {}): HonoMiddleware {
  return mark<HonoMiddleware>(async (_c, next) => {
    await next();
  }, options);
}

export interface HonoMcpOptions extends McpServerOptions {
  /** Path of the MCP endpoint. @default '/mcp' */
  path?: string;
  routes?: (RouteToolOptions & { method: string; path: string })[];
  tools?: McpToolDefinition[];
}

/**
 * Add an MCP endpoint to a Hono app. Works on every Hono runtime (Node, Bun,
 * Deno, Cloudflare Workers). Tool calls use `app.request()`: in-process, with
 * all middleware applied. Call this AFTER defining your routes... or not:
 * discovery is lazy, on the first MCP request.
 */
export function mountMcp(app: HonoLike, options: HonoMcpOptions): McpServer {
  const path = options.path ?? '/mcp';
  const server = new McpServer(options);

  const dispatch: Dispatcher = async (req, ctx) => {
    const res = await app.request(
      buildUrl('http://localhost', req),
      {
        method: req.method,
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      },
      (ctx.raw as HonoContextLike | undefined)?.env,
    );
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, body: await res.text() };
  };

  for (const t of options.tools ?? []) server.addTool(t);
  server.onLoad(() => {
    const seen = new Set<string>();
    for (const r of app.routes) {
      const marker = markerOf(r.handler);
      const key = `${r.method} ${r.path}`;
      if (!marker || seen.has(key) || r.method === 'ALL') continue;
      seen.add(key);
      server.addTool(createRouteTool({ method: r.method, path: r.path }, marker, dispatch, options));
    }
    for (const r of options.routes ?? []) server.addTool(createRouteTool(r, r, dispatch, options));
  });

  app.on(['GET', 'POST', 'DELETE'], path, async (c) => {
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k] = v));
    const ctx: ToolContext = { headers, raw: c };
    const body = c.req.method === 'POST' ? await c.req.raw.text() : undefined;
    const out = await server.handleHttp({ method: c.req.method, headers, body }, ctx);
    return new Response(out.body ?? null, { status: out.status, headers: out.headers });
  });
  return server;
}
