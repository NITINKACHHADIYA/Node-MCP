import type { FastifyPluginCallback } from 'fastify';
import { buildUrl } from '../core/dispatch.js';
import { normalizeHeaders } from '../core/node.js';
import { createRouteTool } from '../core/route-tool.js';
import { McpServer } from '../core/server.js';
import type {
  Dispatcher,
  McpServerOptions,
  McpToolDefinition,
  RouteToolOptions,
  SchemaLike,
  ToolContext,
} from '../core/types.js';

/**
 * Per-route MCP config. Put it on the route's `config`:
 *
 *   fastify.get('/users/:id', { schema, config: { mcp: { description: 'Get a user' } } }, handler)
 *
 * `true` exposes the route with defaults. The route's own JSON `schema`
 * (params / querystring / body) becomes the tool's input schema automatically.
 */
export type FastifyMcpRouteConfig = boolean | RouteToolOptions;

declare module 'fastify' {
  interface FastifyContextConfig {
    mcp?: FastifyMcpRouteConfig;
  }
}

export interface FastifyMcpOptions extends McpServerOptions {
  /** Path of the MCP endpoint. @default '/mcp' */
  path?: string;
  /** Extra hand-written tools (see `defineTool`). */
  tools?: McpToolDefinition[];
  /** Fastify hooks for the MCP route, e.g. `{ onRequest: fastify.authenticate }`. */
  routeOptions?: Record<string, unknown>;
}

interface RouteOptionsLike {
  method: string | string[];
  url: string;
  config?: { mcp?: FastifyMcpRouteConfig };
  schema?: { params?: SchemaLike; querystring?: SchemaLike; query?: SchemaLike; body?: SchemaLike };
}

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
}

interface FastifyLike {
  addHook(name: 'onRoute', fn: (route: RouteOptionsLike) => void): unknown;
  route(opts: Record<string, unknown>): unknown;
  inject(opts: Record<string, unknown>): Promise<InjectResponse>;
  decorate(name: string, value: unknown): unknown;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The MCP server, e.g. to add tools with `app.mcpServer.addTool(defineTool(...))`. */
    mcpServer: import('../core/server.js').McpServer;
  }
}

/**
 * Fastify plugin. Register it BEFORE your routes so it can see them:
 *
 *   await app.register(fastifyMcp, { name: 'shop-api' })
 *
 * Tool calls use `fastify.inject()`: in-process, no network hop, and every
 * hook, validator and plugin (auth, rate limit, ...) still runs.
 */
export const fastifyMcp: FastifyPluginCallback<FastifyMcpOptions> = (instance, options, done) => {
  const fastify = instance as unknown as FastifyLike;
  const server = new McpServer(options);
  const path = options.path ?? '/mcp';

  const dispatch: Dispatcher = async (req, ctx) => {
    const url = new URL(buildUrl('http://localhost', req));
    const res = await fastify.inject({
      method: req.method,
      url: url.pathname + url.search,
      headers: req.headers,
      payload: req.body === undefined ? undefined : JSON.stringify(req.body),
      remoteAddress: ctx.clientIp,
    });
    return { status: res.statusCode, headers: normalizeHeaders(res.headers as Record<string, string>), body: res.body };
  };

  for (const t of options.tools ?? []) server.addTool(t);

  fastify.addHook('onRoute', (route) => {
    const mcp = route.config?.mcp;
    if (!mcp) return;
    const opts: RouteToolOptions = mcp === true ? {} : mcp;
    const methods = (Array.isArray(route.method) ? route.method : [route.method]).filter((m) => m !== 'HEAD');
    for (const method of methods) {
      server.addTool(
        createRouteTool(
          { method, path: route.url },
          {
            params: route.schema?.params,
            query: route.schema?.querystring ?? route.schema?.query,
            body: route.schema?.body,
            ...opts,
          },
          dispatch,
          options,
        ),
      );
    }
  });

  fastify.decorate('mcpServer', server);
  fastify.route({
    method: ['GET', 'POST', 'DELETE'],
    url: path,
    ...options.routeOptions,
    handler: async (
      request: { method: string; headers: Record<string, string>; body: unknown; ip: string },
      reply: { code(n: number): unknown; headers(h: Record<string, string>): unknown; send(b?: unknown): unknown },
    ) => {
      const ctx: ToolContext = { headers: normalizeHeaders(request.headers), clientIp: request.ip, raw: request };
      const out = await server.handleHttp({ method: request.method, headers: ctx.headers, body: request.body }, ctx);
      reply.code(out.status);
      reply.headers(out.headers);
      return reply.send(out.body);
    },
  });
  done();
};

// Equivalent of wrapping with `fastify-plugin`: don't encapsulate, so the
// onRoute hook sees routes registered on the root instance.
(fastifyMcp as unknown as Record<symbol | string, unknown>)[Symbol.for('skip-override')] = true;
(fastifyMcp as unknown as Record<symbol | string, unknown>)[Symbol.for('fastify.display-name')] = 'mcp-expose';

export default fastifyMcp;
