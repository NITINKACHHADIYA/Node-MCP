import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildInputSchema,
  createRouteTool,
  defineTool,
  interpolatePath,
  McpServer,
  toolNameFromRoute,
  toolsFromOpenApi,
  type Dispatcher,
  type RouteRequest,
} from '../src/index.js';
import { discoverExpressRoutes, mcpTool } from '../src/express/index.js';

const ctx = { headers: { authorization: 'Bearer t', cookie: 'sid=1', 'x-other': 'no' }, clientIp: '10.0.0.1' };

function recorder() {
  const calls: RouteRequest[] = [];
  const dispatch: Dispatcher = async (req) => {
    calls.push(req);
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  };
  return { calls, dispatch };
}

describe('route helpers', () => {
  it('derives tool names from routes', () => {
    expect(toolNameFromRoute('GET', '/users/:id/orders')).toBe('get_users_by_id_orders');
    expect(toolNameFromRoute('post', '/v1/{tenant}/invoices')).toBe('post_v1_by_tenant_invoices');
  });

  it('interpolates and encodes path params, dropping missing optional ones', () => {
    expect(interpolatePath('/a/:id/{slug}', { id: 'x y', slug: 'z/1' })).toBe('/a/x%20y/z%2F1');
    expect(interpolatePath('/files/:name?', {})).toBe('/files');
  });

  it('flattens params, query and body into one input schema', () => {
    const { schema } = buildInputSchema(
      { method: 'PATCH', path: '/users/:id' },
      {
        query: { type: 'object', properties: { dryRun: { type: 'boolean' } } },
        body: z.object({ name: z.string(), age: z.number().optional() }),
      },
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Path parameter "id"' },
        dryRun: { type: 'boolean' },
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['id', 'name'],
    });
  });
});

describe('createRouteTool', () => {
  it('splits arguments into path, query and body and forwards auth headers', async () => {
    const { calls, dispatch } = recorder();
    const tool = createRouteTool(
      { method: 'PATCH', path: '/users/:id' },
      {
        query: { type: 'object', properties: { dryRun: { type: 'boolean' } } },
        body: { type: 'object', properties: { name: { type: 'string' } } },
      },
      dispatch,
    );
    const result = await tool.handler({ id: '5', dryRun: true, name: 'Ada' }, ctx);

    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/users/5',
      query: { dryRun: 'true' },
      body: { name: 'Ada' },
    });
    expect(calls[0]!.headers).toMatchObject({
      authorization: 'Bearer t',
      cookie: 'sid=1',
      'x-forwarded-for': '10.0.0.1',
      'x-mcp-tool': 'patch_users_by_id',
    });
    expect(calls[0]!.headers['x-other']).toBeUndefined();
    expect(result.structuredContent).toEqual({ ok: true });
  });

  it('sends unknown args to the query string for GET and to the body for POST', async () => {
    const { calls, dispatch } = recorder();
    const input = { type: 'object', properties: { q: { type: 'string' } } };
    await createRouteTool({ method: 'GET', path: '/search' }, { input }, dispatch).handler({ q: 'x' }, ctx);
    await createRouteTool({ method: 'POST', path: '/search' }, { input }, dispatch).handler({ q: 'x' }, ctx);
    expect(calls[0]).toMatchObject({ query: { q: 'x' }, body: undefined });
    expect(calls[1]).toMatchObject({ query: {}, body: { q: 'x' } });
  });

  it('reports missing required arguments without calling the API', async () => {
    const { calls, dispatch } = recorder();
    const tool = createRouteTool({ method: 'GET', path: '/users/:id' }, {}, dispatch);
    const res = await tool.handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('marks HTTP errors and truncates large bodies', async () => {
    const dispatch: Dispatcher = async () => ({ status: 200, headers: {}, body: 'x'.repeat(50) });
    const tool = createRouteTool({ method: 'GET', path: '/big' }, {}, dispatch, { maxResponseChars: 10 });
    const res = await tool.handler({}, ctx);
    expect(res.content[0]!.text).toContain('truncated 40 chars');
  });
});

describe('McpServer', () => {
  it('validates Standard Schema input before running a tool', async () => {
    const server = new McpServer({ name: 't' });
    server.addTool(
      defineTool({
        name: 'add',
        description: 'Add',
        input: z.object({ a: z.number(), b: z.number() }),
        handler: ({ a, b }) => a + b,
      }),
    );
    const ok = await server.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add', arguments: { a: 1, b: 2 } } },
      { headers: {} },
    );
    expect((ok as any).result.content[0].text).toBe('3');
    const bad = await server.handleMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add', arguments: { a: 'x' } } },
      { headers: {} },
    );
    expect((bad as any).result.isError).toBe(true);
    expect((bad as any).result.content[0].text).toMatch(/^Invalid arguments: a:/);
  });

  it('rejects duplicate tool names', () => {
    const server = new McpServer({ name: 't' });
    const t = defineTool({ name: 'x', description: 'x', handler: () => 1 });
    server.addTool(t);
    expect(() => server.addTool(t)).toThrow(/duplicate tool name/);
  });

  it('answers parse errors and unknown methods per JSON-RPC', async () => {
    const server = new McpServer({ name: 't' });
    const parse = await server.handleHttp({ method: 'POST', headers: {}, body: '{nope' }, { headers: {} });
    expect(parse.status).toBe(400);
    const unknown = await server.handleMessage({ jsonrpc: '2.0', id: 9, method: 'nope' }, { headers: {} });
    expect((unknown as any).error.code).toBe(-32601);
  });

  it('allows configured origins', async () => {
    const server = new McpServer({ name: 't', allowedOrigins: ['https://app.example'] });
    const res = await server.handleHttp(
      { method: 'POST', headers: { origin: 'https://app.example' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } },
      { headers: {} },
    );
    expect(res.status).toBe(200);
  });
});

describe('toolsFromOpenApi', () => {
  it('builds tools from operations marked with x-mcp', async () => {
    const { calls, dispatch } = recorder();
    const tools = toolsFromOpenApi(
      {
        paths: {
          '/pets/{petId}': {
            get: {
              operationId: 'getPet',
              summary: 'Get a pet',
              'x-mcp': true,
              parameters: [
                { name: 'petId', in: 'path', required: true, schema: { type: 'integer' } },
                { name: 'fields', in: 'query', schema: { type: 'string' } },
              ],
            },
            delete: { operationId: 'deletePet' },
          },
        },
      },
      dispatch,
    );
    expect(tools.map((t) => t.name)).toEqual(['getPet']);
    expect(tools[0]!.inputSchema.properties).toMatchObject({ petId: { type: 'integer' }, fields: { type: 'string' } });
    await tools[0]!.handler({ petId: 3, fields: 'name' }, ctx);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/pets/3', query: { fields: 'name' } });
  });
});

describe('express route discovery', () => {
  it('recovers Express 4 mount paths from layer regexps', () => {
    const marker = mcpTool({ name: 'list_orders' });
    const fakeExpress4App = {
      post() {},
      all() {},
      // Like Express 4: the legacy `app.router` getter throws.
      get router(): never {
        throw new Error("'app.router' is deprecated!");
      },
      _router: {
        stack: [
          {
            name: 'router',
            regexp: Object.assign(/^\/api\/v1\/?(?=\/|$)/i, { fast_slash: false }),
            handle: {
              stack: [{ route: { path: '/orders', methods: { get: true }, stack: [{ handle: marker }] } }],
            },
          },
        ],
      },
    };
    expect(discoverExpressRoutes(fakeExpress4App)).toEqual([
      { method: 'GET', path: '/api/v1/orders', options: { name: 'list_orders' } },
    ]);
  });
});
