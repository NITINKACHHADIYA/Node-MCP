import { createRouteTool } from './route-tool.js';
import { toJsonSchema, toValidator } from './schema.js';
import type {
  Dispatcher,
  JsonSchema,
  McpServerOptions,
  McpToolDefinition,
  RouteToolOptions,
  SchemaLike,
  ToolAnnotations,
  ToolContext,
  ToolResult,
} from './types.js';

export interface DefineToolOptions {
  name: string;
  title?: string;
  description: string;
  input?: SchemaLike;
  annotations?: ToolAnnotations;
  /** Return a string, any JSON value, or a full ToolResult. */
  handler: (args: any, ctx: ToolContext) => unknown;
}

/** Define a code-only tool that is not backed by an HTTP route. */
export function defineTool(opts: DefineToolOptions): McpToolDefinition {
  return {
    name: opts.name,
    title: opts.title,
    description: opts.description,
    inputSchema: { type: 'object', ...(toJsonSchema(opts.input) ?? { properties: {} }) },
    annotations: opts.annotations,
    validate: toValidator(opts.input),
    async handler(args, ctx) {
      return toToolResult(await opts.handler(args, ctx));
    },
  };
}

export function toToolResult(value: unknown): ToolResult {
  if (value && typeof value === 'object' && Array.isArray((value as ToolResult).content)) return value as ToolResult;
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  const text = JSON.stringify(value ?? null);
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: JsonSchema }[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  'x-mcp'?: boolean | RouteToolOptions;
}

export interface FromOpenApiOptions {
  /**
   * Which operations to expose. Defaults to operations marked with `x-mcp: true`
   * (or an `x-mcp` options object). Pass `() => true` to expose everything.
   */
  include?: (op: { method: string; path: string; operation: OpenApiOperation }) => boolean;
}

/**
 * Build tools from an OpenAPI 3.x document. Works with any framework that can
 * emit OpenAPI (e.g. @nestjs/swagger, @fastify/swagger, tsoa, hono-openapi).
 * `$ref`s are not resolved, so pass a dereferenced document.
 */
export function toolsFromOpenApi(
  doc: { paths?: Record<string, Record<string, OpenApiOperation>> },
  dispatch: Dispatcher,
  opts: FromOpenApiOptions & Pick<McpServerOptions, 'forwardHeaders' | 'maxResponseChars'> = {},
): McpToolDefinition[] {
  const include = opts.include ?? (({ operation }) => !!operation['x-mcp']);
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  const tools: McpToolDefinition[] = [];

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of methods) {
      const operation = item[method];
      if (!operation || !include({ method, path, operation })) continue;
      const extra = typeof operation['x-mcp'] === 'object' ? operation['x-mcp'] : {};

      const query: JsonSchema = { type: 'object', properties: {}, required: [] };
      const params: JsonSchema = { type: 'object', properties: {} };
      for (const p of operation.parameters ?? []) {
        const s = { ...(p.schema ?? { type: 'string' }), ...(p.description ? { description: p.description } : {}) };
        if (p.in === 'query') {
          query.properties![p.name] = s;
          if (p.required) query.required!.push(p.name);
        } else if (p.in === 'path') params.properties![p.name] = s;
      }
      const body = operation.requestBody?.content?.['application/json']?.schema;

      tools.push(
        createRouteTool(
          { method, path },
          {
            name: operation.operationId,
            description: operation.description ?? operation.summary,
            params,
            query,
            body,
            ...extra,
          },
          dispatch,
          opts,
        ),
      );
    }
  }
  return tools;
}
