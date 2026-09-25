import type { IncomingMessage } from 'node:http';
import { createFetchDispatcher } from '../core/dispatch.js';
import { mark, markerOf } from '../core/marker.js';
import { loopbackBaseUrl, normalizeHeaders, readRawBody } from '../core/node.js';
import { createRouteTool } from '../core/route-tool.js';
import { McpServer } from '../core/server.js';
import type { McpServerOptions, McpToolDefinition, RouteToolOptions, ToolContext } from '../core/types.js';

interface KoaContext {
  method: string;
  path: string;
  ip: string;
  req: IncomingMessage;
  request: { body?: unknown };
  status: number;
  body: unknown;
  set(headers: Record<string, string>): void;
}
type KoaMiddleware = (ctx: KoaContext, next: () => Promise<unknown>) => Promise<unknown>;

/**
 * Mark a @koa/router route as an MCP tool:
 *
 *   router.get('/users/:id', mcpTool({ description: 'Get a user' }), auth, getUser)
 */
export function mcpTool(options: RouteToolOptions = {}): KoaMiddleware {
  return mark<KoaMiddleware>((_ctx, next) => next(), options);
}

interface RouterLike {
  stack: { path: string | RegExp; methods: string[]; stack: unknown[] }[];
}

export interface KoaMcpOptions extends McpServerOptions {
  /** Path of the MCP endpoint. @default '/mcp' */
  path?: string;
  /** @koa/router instances to scan for `mcpTool()` routes. */
  routers?: RouterLike[];
  /** Base URL for internal calls. Defaults to loopback on the incoming port. */
  baseUrl?: string;
  /** Routes to expose without touching the route definitions. */
  routes?: (RouteToolOptions & { method: string; path: string })[];
  tools?: McpToolDefinition[];
}

/** Returns `{ server, middleware }`. Mount the middleware with `app.use()`. */
export function createKoaMcp(options: KoaMcpOptions): { server: McpServer; middleware: KoaMiddleware } {
  const path = options.path ?? '/mcp';
  const server = new McpServer(options);
  const dispatch = createFetchDispatcher({
    baseUrl: options.baseUrl ?? ((ctx) => loopbackBaseUrl(ctx.raw as IncomingMessage)),
  });

  for (const t of options.tools ?? []) server.addTool(t);
  server.onLoad(() => {
    for (const router of options.routers ?? []) {
      for (const layer of router.stack) {
        const marker = layer.stack.map(markerOf).find(Boolean);
        if (!marker || typeof layer.path !== 'string') continue;
        for (const method of layer.methods.filter((m) => m !== 'HEAD')) {
          server.addTool(createRouteTool({ method, path: layer.path }, marker, dispatch, options));
        }
      }
    }
    for (const r of options.routes ?? []) server.addTool(createRouteTool(r, r, dispatch, options));
  });

  const middleware: KoaMiddleware = async (ctx, next) => {
    if (ctx.path !== path) return next();
    const body = ctx.request.body ?? (ctx.method === 'POST' ? await readRawBody(ctx.req) : undefined);
    const toolCtx: ToolContext = { headers: normalizeHeaders(ctx.req.headers), clientIp: ctx.ip, raw: ctx.req };
    const out = await server.handleHttp({ method: ctx.method, headers: toolCtx.headers, body }, toolCtx);
    ctx.status = out.status;
    ctx.set(out.headers);
    if (out.body !== undefined) ctx.body = out.body;
  };
  return { server, middleware };
}

/** Shortcut: `app.use(koaMcp({ name, routers: [router] }))`. */
export function koaMcp(options: KoaMcpOptions): KoaMiddleware {
  return createKoaMcp(options).middleware;
}

/**
 * Add the MCP endpoint to a Koa app and return the server:
 *
 *   mountMcp(app, { name: 'shop-api', routers: [router] })
 *   app.use(router.routes())
 *
 * Call it before mounting your routers, like any Koa middleware.
 */
export function mountMcp(app: { use(middleware: KoaMiddleware): unknown }, options: KoaMcpOptions): McpServer {
  const { server, middleware } = createKoaMcp(options);
  app.use(middleware);
  return server;
}

// ---------------------------------------------------------------------------
// Koa 1 (generator middleware, koa-router 5)
// ---------------------------------------------------------------------------

type LegacyMiddleware = (this: KoaContext, next: unknown) => Generator<unknown, void, unknown>;

/** Koa 1 variant of `mcpTool()` (a generator middleware for koa-router 5). */
export function mcpToolLegacy(options: RouteToolOptions = {}): LegacyMiddleware {
  return mark<LegacyMiddleware>(function* (next) {
    yield next;
  }, options);
}

/** Koa 1 variant of `koaMcp()`: `app.use(koaMcpLegacy({ name, routers: [router] }))`. */
export function koaMcpLegacy(options: KoaMcpOptions): LegacyMiddleware {
  const { middleware } = createKoaMcp(options);
  return function* (next) {
    let passThrough = false;
    // Koa 1 runs on co, which can yield promises.
    yield middleware(this, async () => {
      passThrough = true;
    });
    if (passThrough) yield next;
  };
}
