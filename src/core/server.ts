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

  constructor(readonly options: McpServerOptions) {}

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
   * Framework-neutral Streamable HTTP handler. Adapters convert their request
   * into McpHttpRequest, call this, and write the McpHttpResponse back.
   */
  async handleHttp(req: McpHttpRequest, ctx: ToolContext): Promise<McpHttpResponse> {
    const json = { 'content-type': 'application/json' };
    if (!this.isOriginAllowed(req.headers.origin)) {
      return { status: 403, headers: json, body: JSON.stringify(fail(null, INVALID_REQUEST, 'Origin not allowed')) };
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
    const response = await this.handleMessage(body, ctx);
    if (response === null) return { status: 202, headers: {} };
    return { status: 200, headers: json, body: JSON.stringify(response) };
  }
}
