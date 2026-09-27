import { authenticate, deny, missingScopes, protectedResourceMetadataPaths, validateOAuthOptions } from './oauth.js';
import type { McpServerOptions, McpToolDefinition, ToolContext, ToolResult } from './types.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0] as string;

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: JsonRpcId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/** Minimal HTTP request/response shapes, so each adapter can bridge its own framework. */
export interface McpHttpRequest {
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or the raw string. */
  body: unknown;
}
export interface McpHttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A stateless MCP server speaking the Streamable HTTP transport (JSON responses).
 * Holds the tool registry and answers JSON-RPC messages.
 */
export class McpServer {
  private readonly tools = new Map<string, McpToolDefinition>();
  private loaders: (() => void | Promise<void>)[] = [];

  constructor(readonly options: McpServerOptions) {
    if (options.oauth) validateOAuthOptions(options.oauth);
  }

  /** Register a tool. Throws on duplicate names. */
  addTool(tool: McpToolDefinition): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`mcp-expose: duplicate tool name "${tool.name}". Set an explicit \`name\`.`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** Register a function that adds tools lazily, right before the first MCP request is served. */
  onLoad(loader: () => void | Promise<void>): this {
    this.loaders.push(loader);
    return this;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.load();
    return [...this.tools.values()];
  }

  private async load() {
    if (!this.loaders.length) return;
    const loaders = this.loaders;
    this.loaders = [];
    for (const l of loaders) await l();
  }

  /** Handle one JSON-RPC message (or a batch). Returns null when no response is due. */
  async handleMessage(message: unknown, ctx: ToolContext): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(message)) {
      const results = (await Promise.all(message.map((m) => this.handleOne(m, ctx)))).filter(
        (r): r is JsonRpcResponse => r !== null,
      );
      return results.length ? results : null;
    }
    return this.handleOne(message, ctx);
  }

  private async handleOne(message: unknown, ctx: ToolContext): Promise<JsonRpcResponse | null> {
    const msg = message as Partial<JsonRpcRequest>;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
      return fail(null, INVALID_REQUEST, 'Invalid JSON-RPC message');
    }
    // Responses from the client or notifications: acknowledge, no reply.
    if (typeof msg.method !== 'string' || msg.id === undefined) return null;
    const id = msg.id;
    const params = msg.params ?? {};

    await this.load();
    switch (msg.method) {
      case 'initialize': {
        const requested = params.protocolVersion as string | undefined;
        const protocolVersion =
          requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.options.name, version: this.options.version ?? '1.0.0' },
          ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        });
      case 'tools/call': {
        const tool = this.tools.get(params.name as string);
        if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
        return ok(id, await this.callTool(tool, (params.arguments ?? {}) as Record<string, unknown>, ctx));
      }
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });
      default:
        return fail(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
    }
  }

  private async callTool(
    tool: McpToolDefinition,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      if (tool.validate) {
        const v = await tool.validate(args);
        if (!v.ok) return { isError: true, content: [{ type: 'text', text: `Invalid arguments: ${v.message}` }] };
        args = v.value as Record<string, unknown>;
      }
      return await tool.handler(args, ctx);
    } catch (err) {
      // Tool failures are reported in-band so the model can react to them.
      return { isError: true, content: [{ type: 'text', text: `Tool error: ${(err as Error).message}` }] };
    }
  }

  /** Check the Origin header (DNS rebinding protection). */
  isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return true;
    const allowed = this.options.allowedOrigins;
    if (allowed === '*') return true;
    return (allowed ?? []).includes(origin);
  }

  /**
   * Paths on which adapters serve the OAuth Protected Resource Metadata
   * (empty when `oauth` is not configured). They must be public: no auth middleware.
   */
  get oauthMetadataPaths(): string[] {
    return this.options.oauth ? protectedResourceMetadataPaths(this.options.oauth.resource) : [];
  }

  /** The OAuth Protected Resource Metadata document (RFC 9728). */
  async protectedResourceMetadata(): Promise<Record<string, unknown>> {
    const o = this.options.oauth;
    if (!o) throw new Error('mcp-expose: the oauth option is not configured');
    await this.load();
    const scopes = o.scopesSupported ?? [
      ...new Set([...(o.requiredScopes ?? []), ...[...this.tools.values()].flatMap((t) => t.scopes ?? [])]),
    ];
    return {
      resource: o.resource,
      authorization_servers: o.authorizationServers,
      ...(scopes.length ? { scopes_supported: scopes } : {}),
      bearer_methods_supported: ['header'],
      ...(o.resourceName ? { resource_name: o.resourceName } : {}),
      ...(o.resourceDocumentation ? { resource_documentation: o.resourceDocumentation } : {}),
      ...o.metadata,
    };
  }

  /** HTTP handler for the metadata paths. Public and CORS-enabled so browser-based clients can read it. */
  async handleMetadataHttp(req: Pick<McpHttpRequest, 'method'>): Promise<McpHttpResponse> {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
    const method = req.method.toUpperCase();
    if (!this.options.oauth) return { status: 404, headers: {} };
    if (method === 'OPTIONS') return { status: 204, headers: { ...cors, 'access-control-allow-headers': '*' } };
    if (method !== 'GET' && method !== 'HEAD') return { status: 405, headers: { allow: 'GET, OPTIONS' } };
    const body = JSON.stringify(await this.protectedResourceMetadata());
    return {
      status: 200,
      headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
      body: method === 'HEAD' ? undefined : body,
    };
  }

  /**
   * Framework-neutral Streamable HTTP handler. Adapters convert their request
   * into McpHttpRequest, call this, and write the McpHttpResponse back.
   */
  async handleHttp(req: McpHttpRequest, ctx: ToolContext): Promise<McpHttpResponse> {
    const json = { 'content-type': 'application/json' };
    if (!this.isOriginAllowed(req.headers.origin)) {
      return { status: 403, headers: json, body: JSON.stringify(fail(null, INVALID_REQUEST, 'Origin not allowed')) };
    }
    const oauth = this.options.oauth;
    if (oauth) {
      const outcome = await authenticate(oauth, req.headers);
      if (!outcome.ok) return authError(outcome);
      ctx = { ...ctx, auth: outcome.auth };
    }
    if (req.method.toUpperCase() !== 'POST') {
      // Stateless server: no standalone SSE stream and no sessions to delete.
      return { status: 405, headers: { allow: 'POST' } };
    }
    let body = req.body;
    if (typeof body === 'string' || body instanceof Uint8Array) {
      try {
        body = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
      } catch {
        return { status: 400, headers: json, body: JSON.stringify(fail(null, PARSE_ERROR, 'Parse error')) };
      }
    }
    if (oauth) {
      // Per-tool scopes: answer 403 so the client can ask the user for more access (step-up).
      await this.load();
      const calls = (Array.isArray(body) ? body : [body]) as Partial<JsonRpcRequest>[];
      for (const m of calls) {
        if (m?.method !== 'tools/call') continue;
        const tool = this.tools.get(m.params?.name as string);
        const missing = missingScopes(ctx.auth, tool?.scopes);
        if (missing.length) {
          // Include the scopes already granted, so re-authorizing never drops access the user gave before.
          const scope = [
            ...new Set([...(ctx.auth?.scopes ?? []), ...(oauth.requiredScopes ?? []), ...(tool?.scopes ?? [])]),
          ];
          return authError(
            deny(oauth, 403, 'insufficient_scope', `Tool "${tool!.name}" needs scope: ${missing.join(' ')}`, scope),
          );
        }
      }
    }
    const response = await this.handleMessage(body, ctx);
    if (response === null) return { status: 202, headers: {} };
    return { status: 200, headers: json, body: JSON.stringify(response) };
  }
}

function authError(o: { status: number; challenge: string; error: string; description: string }): McpHttpResponse {
  return {
    status: o.status,
    headers: { 'content-type': 'application/json', 'www-authenticate': o.challenge },
    body: JSON.stringify({ error: o.error, error_description: o.description }),
  };
}
