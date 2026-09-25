/**
 * Shared types for mcp-expose. Everything in `core` is runtime-agnostic
 * (no `node:*` imports) so it also works on Bun, Deno and edge runtimes.
 */

/** A JSON Schema object. Kept intentionally loose. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

/**
 * Anything we can turn into a JSON Schema:
 *  - a plain JSON Schema object
 *  - a Standard Schema / Standard JSON Schema object (zod >= 4.2, valibot, arktype, ...)
 *  - any object with a `toJSONSchema()` method (zod 4)
 */
export type SchemaLike = JsonSchema | { '~standard': unknown } | { toJSONSchema(): unknown };

/** MCP tool annotations (hints for clients, never trusted for security). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type TextContent = { type: 'text'; text: string };

export interface ToolResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Per-call context, derived from the incoming MCP HTTP request. */
export interface ToolContext {
  /** Lower-cased headers of the MCP request (used for auth forwarding). */
  headers: Record<string, string>;
  /** IP address of the MCP client, if known. Forwarded as `X-Forwarded-For`. */
  clientIp?: string;
  /** Framework-specific raw request object (Express req, Koa ctx, Hono context...). */
  raw?: unknown;
}

/** A fully resolved MCP tool. */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /** Optional validator run before the handler (from Standard Schema inputs). */
  validate?: (args: unknown) => Promise<{ ok: true; value: unknown } | { ok: false; message: string }>;
}

/**
 * Options a developer attaches to a route to expose it as a tool.
 * Used by every framework adapter (`@McpTool()`, `mcpTool()`, `config.mcp`, ...).
 */
export interface RouteToolOptions {
  /** Tool name. Defaults to a name derived from the route (e.g. `get_users_by_id`). */
  name?: string;
  title?: string;
  /** What the tool does. Agents read this to decide when to call it. Write it well. */
  description?: string;
  /** Full input schema. Overrides `params` / `query` / `body`. */
  input?: SchemaLike;
  /** Schema for path parameters (`:id`). Defaults to string params. */
  params?: SchemaLike;
  /** Schema for the query string. */
  query?: SchemaLike;
  /** Schema for the JSON request body. */
  body?: SchemaLike;
  annotations?: ToolAnnotations;
  /** Extra static headers sent with the internal request. */
  headers?: Record<string, string>;
}

/** HTTP route that backs a tool. `path` may use `:param` or `{param}` placeholders. */
export interface RouteSpec {
  method: string;
  path: string;
}

/** Internal request produced by a tool call, handed to a Dispatcher. */
export interface RouteRequest {
  method: string;
  /** Interpolated path, e.g. `/users/42`. */
  path: string;
  query: Record<string, string | string[]>;
  body?: unknown;
  headers: Record<string, string>;
}

export interface RouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Sends a RouteRequest through the host application. Adapters pick the best
 * strategy: in-process injection (Fastify, Hono) or loopback HTTP (Express, Koa, NestJS).
 * Either way the request runs through the app's full middleware/guard/pipe stack.
 */
export type Dispatcher = (req: RouteRequest, ctx: ToolContext) => Promise<RouteResponse>;

/** Options shared by every adapter. */
export interface McpServerOptions {
  /** Server name reported to MCP clients. */
  name: string;
  /** Server version reported to MCP clients. */
  version?: string;
  /** Optional instructions shown to the model about how to use this server. */
  instructions?: string;
  /**
   * Allowed values of the `Origin` header. Requests carrying any other Origin
   * are rejected (DNS-rebinding protection, required by the MCP spec).
   * Requests without an Origin header (CLI/desktop clients, server-to-server) are always allowed.
   * Use `'*'` to disable the check.
   */
  allowedOrigins?: string[] | '*';
  /**
   * Request headers copied from the MCP request to the internal API request.
   * This is how your existing auth (JWT, sessions, API keys) keeps working.
   * @default ['authorization', 'cookie', 'x-api-key', 'accept-language']
   */
  forwardHeaders?: string[];
  /** Max characters of an API response returned to the model. @default 100_000 */
  maxResponseChars?: number;
}
