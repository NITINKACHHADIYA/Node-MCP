import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFetchDispatcher } from '../core/dispatch.js';
import { mark, markerOf } from '../core/marker.js';
import { loopbackBaseUrl, normalizeHeaders, readRawBody, writeNodeResponse } from '../core/node.js';
import { createRouteTool, joinPaths } from '../core/route-tool.js';
import { McpServer } from '../core/server.js';
import type { McpServerOptions, McpToolDefinition, RouteToolOptions, ToolContext } from '../core/types.js';

type Req = IncomingMessage & { body?: unknown; ip?: string };
type Next = (err?: unknown) => void;
type Middleware = (req: Req, res: ServerResponse, next: Next) => void;

/**
 * Mark an Express route as an MCP tool. Put it first in the route's handler list:
 *
 *   app.get('/users/:id', mcpTool({ description: 'Get a user' }), auth, getUser)
 *
 * It is a no-op at request time; it only carries metadata.
 */
export function mcpTool(options: RouteToolOptions = {}): Middleware {
  return mark<Middleware>((_req, _res, next) => next(), options);
}

export interface ExpressMcpOptions extends McpServerOptions {
  /** Path of the MCP endpoint. @default '/mcp' */
  path?: string;
  /**
   * Base URL for internal calls. Defaults to the address/port the MCP request
   * arrived on (loopback), so no configuration is needed in most setups.
   */
  baseUrl?: string;
  /**
   * Prefixes of mounted routers, e.g. `{ '/api': apiRouter }`. Express 5 does
   * not keep mount paths, so routers mounted with a path must be listed here.
   * (Express 4 mount paths are detected automatically.)
   */
  routers?: Record<string, unknown>;
  /** Routes to expose without touching the route definitions. */
  routes?: (RouteToolOptions & { method: string; path: string })[];
  /** Extra hand-written tools (see `defineTool`). */
  tools?: McpToolDefinition[];
  /**
   * Middleware run before the MCP endpoint, e.g. your auth middleware, to
   * protect tools/list as well as tools/call.
   */
  middleware?: Middleware[];
}

interface ExpressLayer {
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  name?: string;
  handle?: { stack?: ExpressLayer[] };
  regexp?: RegExp & { fast_slash?: boolean };
}

/** Structural type for an Express 4/5 app (or Router). Kept loose on purpose. */
export interface ExpressAppLike {
  all: Function;
  router?: unknown;
  _router?: unknown;
}

function stackOf(app: ExpressAppLike): ExpressLayer[] {
  const router = (app.router ?? app._router) as { stack?: ExpressLayer[] } | undefined;
  return router?.stack ?? [];
}

/** Recover an Express 4 mount path from a layer regexp (best effort). */
function express4Prefix(layer: ExpressLayer): string | undefined {
  const re = layer.regexp;
  if (!re) return undefined;
  if (re.fast_slash) return '';
  const m = /^\/\^((?:\\[.*+?^${}()|[\]\\/]|[^.*+?^${}()|[\]\\/])*)\\\/\?\(\?=\\\/\|\$\)\/i?$/.exec(re.toString());
  return m ? (m[1] as string).replace(/\\(.)/g, '$1') : undefined;
}

interface Found {
  method: string;
  path: string;
  options: RouteToolOptions;
}

function collect(
  stack: ExpressLayer[],
  prefix: string,
  routers: Map<unknown, string>,
  out: Found[],
  unresolved: string[],
) {
  for (const layer of stack) {
    if (layer.route) {
      const marker = layer.route.stack.map((l) => markerOf(l.handle)).find(Boolean);
      if (!marker) continue;
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const method of Object.keys(layer.route.methods).filter((m) => m !== '_all')) {
        for (const p of paths) out.push({ method: method.toUpperCase(), path: joinPaths(prefix, p), options: marker });
      }
    } else if (layer.handle?.stack) {
      const known = routers.get(layer.handle);
      const sub = known ?? express4Prefix(layer);
      if (sub === undefined) {
        // Only complain if this router actually contains MCP tools.
        const inner: Found[] = [];
        collect(layer.handle.stack, '', routers, inner, unresolved);
        if (inner.length) unresolved.push(...inner.map((f) => `${f.method} ${f.path}`));
        continue;
      }
      collect(layer.handle.stack, joinPaths(prefix, sub), routers, out, unresolved);
    }
  }
}

/** Find every route marked with `mcpTool()` in an Express app. */
export function discoverExpressRoutes(app: ExpressAppLike, routers: Record<string, unknown> = {}): Found[] {
  const stack = stackOf(app);
  const byRouter = new Map(Object.entries(routers).map(([prefix, r]) => [r, prefix]));
  const out: Found[] = [];
  const unresolved: string[] = [];
  collect(stack, '', byRouter, out, unresolved);
  if (unresolved.length) {
    throw new Error(
      `mcp-expose: cannot determine the mount path of a router containing MCP tools (${unresolved.join(', ')}). ` +
        `Pass it via the \`routers\` option, e.g. mountMcp(app, { routers: { '/api': apiRouter } }).`,
    );
  }
  return out;
}

/**
 * Add an MCP endpoint (default `POST /mcp`) to an Express app. Tools are
 * discovered lazily on the first MCP request, so call this before or after
 * defining routes. Returns the underlying McpServer.
 */
export function mountMcp(app: ExpressAppLike, options: ExpressMcpOptions): McpServer {
  const path = options.path ?? '/mcp';
  const server = new McpServer(options);
  const dispatch = createFetchDispatcher({
    baseUrl: options.baseUrl ?? ((ctx) => loopbackBaseUrl(ctx.raw as IncomingMessage)),
  });

  for (const t of options.tools ?? []) server.addTool(t);
  server.onLoad(() => {
    const found = discoverExpressRoutes(app, options.routers);
    for (const r of options.routes ?? []) found.push({ method: r.method, path: r.path, options: r });
    for (const f of found) server.addTool(createRouteTool({ method: f.method, path: f.path }, f.options, dispatch, options));
  });

  const handler: Middleware = (req, res, next) => {
    (async () => {
      const body = req.method === 'POST' && req.body === undefined ? await readRawBody(req) : req.body;
      const ctx: ToolContext = { headers: normalizeHeaders(req.headers), clientIp: req.ip ?? req.socket.remoteAddress, raw: req };
      const out = await server.handleHttp({ method: req.method ?? 'POST', headers: ctx.headers, body }, ctx);
      writeNodeResponse(res, out);
    })().catch(next);
  };
  (app.all as (path: string, ...h: Middleware[]) => void).call(app, path, ...(options.middleware ?? []), handler);
  return server;
}
