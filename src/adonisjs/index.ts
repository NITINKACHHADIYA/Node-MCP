import { Route } from '@adonisjs/core/http';
import type { IncomingMessage } from 'node:http';
import { createFetchDispatcher } from '../core/dispatch.js';
import { loopbackBaseUrl, normalizeHeaders, readRawBody } from '../core/node.js';
import { createRouteTool } from '../core/route-tool.js';
import { McpServer } from '../core/server.js';
import type { McpServerOptions, McpToolDefinition, RouteToolOptions, ToolContext } from '../core/types.js';

declare module '@adonisjs/core/http' {
  interface Route {
    /**
     * Expose this route as an MCP tool:
     *
     *   router.get('/orders/:id', [OrdersController, 'show']).use(middleware.auth()).mcp({ description: 'Get an order' })
     */
    mcp(options?: RouteToolOptions): this;
  }
}

/** Routes marked with `.mcp()`, keyed by route instance. */
const marked = new Map<Route, RouteToolOptions>();

Route.macro('mcp', function (this: Route, options: RouteToolOptions = {}) {
  marked.set(this, options);
  return this;
});

/** Mark a route without the macro (same as `route.mcp(options)`). */
export function mcpTool<T extends Route>(route: T, options: RouteToolOptions = {}): T {
  marked.set(route, options);
  return route;
}

interface RouterLike {
  any(pattern: string, handler: (ctx: AdonisContext) => unknown): { as(name: string): unknown };
  toJSON(): Record<string, { pattern: string; methods: string[] }[]>;
}

interface AdonisContext {
  request: {
    request: IncomingMessage;
    method(): string;
    ip(): string;
    headers(): Record<string, string | string[] | undefined>;
    body(): unknown;
    raw(): string | null;
  };
  response: {
    status(code: number): unknown;
    header(key: string, value: string): unknown;
    send(body: unknown): unknown;
  };
}

export interface AdonisMcpOptions extends McpServerOptions {
  /** Path of the MCP endpoint. @default '/mcp' */
  path?: string;
  /** Base URL for internal calls. Defaults to loopback on the port the MCP request arrived on. */
  baseUrl?: string;
  /** Extra hand-written tools (see `defineTool`). */
  tools?: McpToolDefinition[];
  /**
   * Called with the MCP route so you can add middleware to the endpoint itself,
   * e.g. `(route) => route.use(middleware.auth())`.
   */
  configureRoute?: (route: Route) => void;
}

function isEmptyObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
}

/**
 * Add an MCP endpoint to an AdonisJS (v6 / v7) router, usually in `start/routes.ts`:
 *
 *   import router from '@adonisjs/core/services/router'
 *   import { mountMcp } from 'mcp-expose/adonisjs'
 *
 *   router.get('/orders/:id', [OrdersController, 'show']).use(middleware.auth()).mcp({ description: 'Get an order' })
 *   mountMcp(router, { name: 'shop-api' })
 *
 * Group prefixes, route middleware (auth, throttle) and VineJS validators all
 * apply, because every tool call goes through the router like a normal request.
 */
export function mountMcp(router: RouterLike, options: AdonisMcpOptions): McpServer {
  const path = options.path ?? '/mcp';
  const server = new McpServer(options);
  const dispatch = createFetchDispatcher({
    baseUrl: options.baseUrl ?? ((ctx) => loopbackBaseUrl(ctx.raw as IncomingMessage)),
  });

  for (const t of options.tools ?? []) server.addTool(t);
  server.onLoad(() => {
    // Only routes registered on this router (after commit, with group prefixes applied).
    const registered = new Set<string>();
    for (const routes of Object.values(router.toJSON())) {
      for (const r of routes) for (const m of r.methods) registered.add(`${m} ${r.pattern}`);
    }
    const seen = new Set<string>();
    for (const [route, opts] of marked) {
      if (route.isDeleted()) continue;
      const { pattern, methods } = route.toJSON();
      for (const method of methods) {
        const key = `${method} ${pattern}`;
        if (method === 'HEAD' || !registered.has(key) || seen.has(key)) continue;
        seen.add(key);
        server.addTool(createRouteTool({ method, path: pattern }, opts, dispatch, options));
      }
    }
  });

  const route = router.any(path, async (ctx: AdonisContext) => {
    const req = ctx.request.request;
    let body = ctx.request.body();
    if (ctx.request.method() === 'POST' && (body === undefined || isEmptyObject(body))) {
      // No bodyparser for this route (or a non-JSON content type): read it ourselves.
      const raw = ctx.request.raw();
      body = raw ?? (req.readable && !req.readableEnded ? await readRawBody(req) : body);
    }
    const toolCtx: ToolContext = {
      headers: normalizeHeaders(ctx.request.headers()),
      clientIp: ctx.request.ip(),
      raw: req,
    };
    const out = await server.handleHttp({ method: ctx.request.method(), headers: toolCtx.headers, body }, toolCtx);
    ctx.response.status(out.status);
    for (const [k, v] of Object.entries(out.headers)) ctx.response.header(k, v);
    ctx.response.send(out.body ?? '');
  }) as unknown as Route;
  route.as('mcp_expose.endpoint');
  options.configureRoute?.(route);
  return server;
}
