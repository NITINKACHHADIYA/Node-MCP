// Internal: route discovery for Express 3, 4 and 5 (not part of the public API).
import { markerOf } from '../core/marker.js';
import { joinPaths } from '../core/route-tool.js';
import type { RouteToolOptions } from '../core/types.js';

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
  /** Express 3 route table: `{ get: [{ path, method, callbacks }], ... }`. */
  routes?: unknown;
}

type Express3Routes = Record<string, { path: string | RegExp; method: string; callbacks: unknown[] }[]>;

/** Express 3 keeps app-level routes in `app.routes`, keyed by method. */
function collectExpress3(routes: Express3Routes, out: Found[]) {
  for (const list of Object.values(routes)) {
    for (const r of list) {
      const marker = r.callbacks.map(markerOf).find(Boolean);
      if (marker && typeof r.path === 'string')
        out.push({ method: r.method.toUpperCase(), path: r.path, options: marker });
    }
  }
}

function stackOf(app: ExpressAppLike): ExpressLayer[] {
  // Express 4 keeps the router on `_router`; its `app.router` getter throws.
  // Express 5 exposes `app.router`.
  let router = app._router as { stack?: ExpressLayer[] } | undefined;
  if (!router) {
    try {
      router = app.router as typeof router;
    } catch {
      router = undefined;
    }
  }
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

export interface Found {
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
  if (!stack.length && app.routes && typeof app.routes === 'object') collectExpress3(app.routes as Express3Routes, out);
  if (unresolved.length) {
    throw new Error(
      `mcp-expose: cannot determine the mount path of a router containing MCP tools (${unresolved.join(', ')}). ` +
        `Pass it via the \`routers\` option, e.g. mountMcp(app, { routers: { '/api': apiRouter } }).`,
    );
  }
  return out;
}
