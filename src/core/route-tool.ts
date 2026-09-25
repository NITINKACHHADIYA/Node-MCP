import { checkRequired, toJsonSchema, toValidator } from './schema.js';
import type {
  Dispatcher,
  JsonSchema,
  McpServerOptions,
  McpToolDefinition,
  RouteResponse,
  RouteSpec,
  RouteToolOptions,
  ToolAnnotations,
  ToolContext,
  ToolResult,
} from './types.js';

export const DEFAULT_FORWARD_HEADERS = ['authorization', 'cookie', 'x-api-key', 'accept-language'];
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const PARAM_RE = /:([A-Za-z0-9_]+)\??|\{([A-Za-z0-9_]+)\}/g;

/** Names of the path parameters in a route path (`/a/:id/{slug}` -> ['id', 'slug']). */
export function pathParams(path: string): string[] {
  return [...path.matchAll(PARAM_RE)].map((m) => (m[1] ?? m[2]) as string);
}

/**
 * Encode one path-parameter value. Rejects empty, `.` and `..` values: after URL
 * normalisation they would change which route is called (e.g. `/orders/../admin`),
 * letting an agent reach routes that were never exposed as tools.
 */
function encodeSegment(name: string, value: unknown): string {
  const raw = String(value);
  if (raw === '' || raw === '.' || raw === '..') {
    throw new Error(`Invalid value for path parameter "${name}": ${JSON.stringify(raw)}`);
  }
  return encodeURIComponent(raw);
}

/** Replace path placeholders with URL-encoded values. Missing optional params drop their segment. */
export function interpolatePath(path: string, values: Record<string, unknown>): string {
  return path
    .replace(/\/:([A-Za-z0-9_]+)\?/g, (_, k: string) =>
      values[k] === undefined ? '' : `/${encodeSegment(k, values[k])}`,
    )
    .replace(PARAM_RE, (_, a?: string, b?: string) => {
      const k = (a ?? b) as string;
      return encodeSegment(k, values[k]);
    });
}

/** Join path segments, normalising slashes. */
export function joinPaths(...parts: (string | undefined)[]): string {
  const joined = parts
    .filter((p): p is string => !!p && p !== '/')
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

/** `GET /users/:id/orders` -> `get_users_by_id_orders` */
export function toolNameFromRoute(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      const m = /^(?::([A-Za-z0-9_]+)\??|\{([A-Za-z0-9_]+)\})$/.exec(s);
      return m ? `by_${m[1] ?? m[2]}` : s;
    });
  return sanitizeToolName([method.toLowerCase(), ...segments].join('_'));
}

export function sanitizeToolName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);
}

function defaultAnnotations(method: string): ToolAnnotations {
  switch (method) {
    case 'GET':
    case 'HEAD':
      return { readOnlyHint: true, openWorldHint: false };
    case 'DELETE':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
    case 'PUT':
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    default:
      return { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  }
}

interface ArgMapping {
  params: string[];
  query: Set<string>;
  body: Set<string>;
  /** Body schema is not an object: the whole body is passed under the `body` key. */
  wholeBody: boolean;
  bodyMethod: boolean;
}

/**
 * Build the flat input schema an agent sees, and remember which argument goes
 * to the path, query string or body when the tool is called.
 */
export function buildInputSchema(
  route: RouteSpec,
  opts: RouteToolOptions,
): { schema: JsonSchema; mapping: ArgMapping } {
  const method = route.method.toUpperCase();
  const params = pathParams(route.path);
  const mapping: ArgMapping = {
    params,
    query: new Set(),
    body: new Set(),
    wholeBody: false,
    bodyMethod: BODY_METHODS.has(method),
  };

  if (opts.input) {
    const schema = toJsonSchema(opts.input) as JsonSchema;
    return { schema: { type: 'object', ...schema }, mapping };
  }

  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();

  const paramSchema = toJsonSchema(opts.params);
  for (const p of params) {
    properties[p] = paramSchema?.properties?.[p] ?? { type: 'string', description: `Path parameter "${p}"` };
    if (!route.path.includes(`:${p}?`)) required.add(p);
  }

  const querySchema = toJsonSchema(opts.query);
  for (const [k, v] of Object.entries(querySchema?.properties ?? {})) {
    properties[k] = v;
    mapping.query.add(k);
  }
  for (const k of querySchema?.required ?? []) required.add(k);

  const bodySchema = toJsonSchema(opts.body);
  if (bodySchema) {
    if (bodySchema.properties && (bodySchema.type === undefined || bodySchema.type === 'object')) {
      for (const [k, v] of Object.entries(bodySchema.properties)) {
        properties[k] = v;
        mapping.body.add(k);
      }
      for (const k of bodySchema.required ?? []) required.add(k);
    } else {
      properties.body = bodySchema;
      required.add('body');
      mapping.wholeBody = true;
    }
  }

  const schema: JsonSchema = { type: 'object', properties };
  if (required.size) schema.required = [...required];
  return { schema, mapping };
}

function splitArgs(args: Record<string, unknown>, mapping: ArgMapping) {
  const pathValues: Record<string, unknown> = {};
  const query: Record<string, string | string[]> = {};
  let body: Record<string, unknown> | unknown | undefined;

  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (mapping.params.includes(k)) {
      pathValues[k] = v;
    } else if (mapping.wholeBody && k === 'body') {
      body = v;
    } else if (mapping.query.has(k) || (!mapping.body.has(k) && !mapping.bodyMethod)) {
      query[k] = Array.isArray(v) ? v.map(String) : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
    } else {
      body = { ...((body as Record<string, unknown>) ?? {}), [k]: v };
    }
  }
  if (body === undefined && mapping.bodyMethod) body = {};
  return { pathValues, query, body };
}

export function responseToResult(res: RouteResponse, maxChars: number): ToolResult {
  let text = res.body;
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
  const isError = res.status >= 400;
  const result: ToolResult = {
    content: [{ type: 'text', text: isError ? `HTTP ${res.status}\n${text}` : text || `HTTP ${res.status}` }],
  };
  if (isError) {
    result.isError = true;
    return result;
  }
  if ((res.headers['content-type'] ?? '').includes('json') && text === res.body) {
    try {
      const parsed = JSON.parse(res.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result.structuredContent = parsed;
    } catch {
      /* not JSON after all */
    }
  }
  return result;
}

export function pickForwardHeaders(ctx: ToolContext, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = ctx.headers[name.toLowerCase()];
    if (v !== undefined) out[name.toLowerCase()] = v;
  }
  return out;
}

/**
 * Turn an HTTP route + options into an MCP tool whose handler calls the route
 * through `dispatch`, so auth guards, validation and rate limits all still apply.
 */
export function createRouteTool(
  route: RouteSpec,
  opts: RouteToolOptions,
  dispatch: Dispatcher,
  serverOpts: Pick<McpServerOptions, 'forwardHeaders' | 'maxResponseChars'> = {},
): McpToolDefinition {
  const method = route.method.toUpperCase();
  const name = sanitizeToolName(opts.name ?? toolNameFromRoute(method, route.path));
  const { schema, mapping } = buildInputSchema(route, opts);
  const forward = serverOpts.forwardHeaders ?? DEFAULT_FORWARD_HEADERS;
  const maxChars = serverOpts.maxResponseChars ?? 100_000;

  return {
    name,
    title: opts.title,
    description: opts.description ?? `${method} ${route.path}`,
    inputSchema: schema,
    annotations: { ...defaultAnnotations(method), ...opts.annotations },
    validate: toValidator(opts.input),
    async handler(args, ctx) {
      const missing = opts.input ? undefined : checkRequired(schema, args);
      if (missing) return { isError: true, content: [{ type: 'text', text: missing }] };

      const { pathValues, query, body } = splitArgs(args, mapping);
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...pickForwardHeaders(ctx, forward),
        ...opts.headers,
        'x-mcp-tool': name,
      };
      if (ctx.clientIp) headers['x-forwarded-for'] = ctx.clientIp;
      if (body !== undefined) headers['content-type'] = 'application/json';

      let path: string;
      try {
        path = interpolatePath(route.path, pathValues);
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
      }
      const res = await dispatch({ method, path, query, body, headers }, ctx);
      return responseToResult(res, maxChars);
    },
  };
}
