import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFetchDispatcher } from '../core/dispatch.js';
import { mark } from '../core/marker.js';
import { loopbackBaseUrl, normalizeHeaders, readRawBody, writeNodeResponse } from '../core/node.js';
import { createRouteTool } from '../core/route-tool.js';
import { McpServer } from '../core/server.js';
import type { McpServerOptions, McpToolDefinition, RouteToolOptions, ToolContext } from '../core/types.js';
import { discoverExpressRoutes, type ExpressAppLike } from './discover.js';

export type { ExpressAppLike } from './discover.js';

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
    for (const f of found)
      server.addTool(createRouteTool({ method: f.method, path: f.path }, f.options, dispatch, options));
  });

  const handler: Middleware = (req, res, next) => {
    (async () => {
      const body = req.method === 'POST' && req.body === undefined ? await readRawBody(req) : req.body;
      const ctx: ToolContext = {
        headers: normalizeHeaders(req.headers),
        clientIp: req.ip ?? req.socket.remoteAddress,
        raw: req,
      };
      const out = await server.handleHttp({ method: req.method ?? 'POST', headers: ctx.headers, body }, ctx);
      writeNodeResponse(res, out);
    })().catch(next);
  };
  (app.all as (path: string, ...h: Middleware[]) => void).call(app, path, ...(options.middleware ?? []), handler);
  return server;
}
