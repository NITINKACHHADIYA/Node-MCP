import { describe, expect, it } from 'vitest';
import {
  createRouteTool,
  defineTool,
  McpServer,
  toolsFromOpenApi,
  type Dispatcher,
  type RouteRequest,
  type ToolResult,
} from '../src/index.js';

const ctx = { headers: { authorization: 'Bearer t', cookie: 'sid=1' }, clientIp: '10.0.0.1' };

/** A fake app: GET /orders/:id, GET /customers/:id (needs auth), anything else 404. */
function fakeApp() {
  const calls: RouteRequest[] = [];
  const dispatch: Dispatcher = async (req) => {
    calls.push(req);
    const json = (status: number, body: unknown) => ({
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const order = /^\/orders\/([^/]+)$/.exec(req.path);
    if (order) {
      if (order[1] === 'missing') return json(404, { message: 'Order not found' });
      return json(200, { id: order[1], customerId: 'c1', total: 1999, internalNotes: 'secret', sku: 'KB-01' });
    }
    const customer = /^\/customers\/([^/]+)$/.exec(req.path);
    if (customer) {
      if (req.headers.authorization !== 'Bearer t') return json(401, { message: 'Unauthorized' });
      return json(200, { id: decodeURIComponent(customer[1]!), name: 'Ada' });
    }
    if (req.path === '/text') return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'plain' };
    return json(404, { message: 'not found' });
  };
  return { calls, dispatch };
}

const run = (tool: ReturnType<typeof createRouteTool>, args: Record<string, unknown>) => tool.handler(args, ctx);

describe('transformResponse', () => {
  it('shapes the JSON the agent sees', async () => {
    const { dispatch } = fakeApp();
    const tool = createRouteTool(
      { method: 'GET', path: '/orders/:id' },
      {
        transformResponse: (res) => {
          const { internalNotes: _hidden, total, ...order } = res.json as Record<string, unknown>;
          return { ...order, total: `$${(Number(total) / 100).toFixed(2)}` };
        },
      },
      dispatch,
    );
    const result = await run(tool, { id: '42' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: '42', customerId: 'c1', sku: 'KB-01', total: '$19.99' });
    expect(result.content[0]!.text).not.toContain('secret');
  });

  it('enriches the response with other routes, with the same credentials', async () => {
    const { dispatch, calls } = fakeApp();
    const tool = createRouteTool(
      { method: 'GET', path: '/orders/:id' },
      {
        name: 'get_order',
        transformResponse: async (res, c) => {
          const order = res.json as { customerId: string };
          const customer = await c.callRoute({ path: '/customers/:id', params: { id: order.customerId } });
          return { ...order, customer: customer.json };
        },
      },
      dispatch,
    );
    const result = await run(tool, { id: '1' });
    expect(result.structuredContent).toMatchObject({ id: '1', customer: { id: 'c1', name: 'Ada' } });
    const sub = calls[1]!;
    expect(sub).toMatchObject({ method: 'GET', path: '/customers/c1', query: {} });
    expect(sub.headers).toMatchObject({ authorization: 'Bearer t', cookie: 'sid=1', 'x-mcp-tool': 'get_order' });
    expect(sub.headers['x-forwarded-for']).toBe('10.0.0.1');
    expect(sub.headers['content-type']).toBeUndefined();
  });

  it('sends a JSON body, query and extra headers with callRoute', async () => {
    const { dispatch, calls } = fakeApp();
    const tool = createRouteTool(
      { method: 'GET', path: '/text' },
      {
        transformResponse: async (_res, c) => {
          await c.callRoute({
            method: 'post',
            path: '/audit',
            query: { a: '1' },
            body: { x: 1 },
            headers: { 'x-e': 'y' },
          });
          return 'done';
        },
      },
      dispatch,
    );
    expect((await run(tool, {})).content[0]!.text).toBe('done');
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/audit', query: { a: '1' }, body: { x: 1 } });
    expect(calls[1]!.headers).toMatchObject({ 'content-type': 'application/json', 'x-e': 'y' });
  });

  it('encodes callRoute params and refuses paths that could escape to other routes', async () => {
    const { dispatch, calls } = fakeApp();
    const attempt = (path: string, params?: Record<string, unknown>) =>
      run(
        createRouteTool(
          { method: 'GET', path: '/text' },
          { transformResponse: (_r, c) => c.callRoute({ path, params }).then((r) => r.json) },
          dispatch,
        ),
        {},
      );
    await expect(attempt('/customers/:id', { id: 'a/b' })).resolves.toMatchObject({
      structuredContent: { id: 'a/b' },
    });
    expect(calls.at(-1)!.path).toBe('/customers/a%2Fb');
    await expect(attempt('/customers/:id', { id: '..' })).rejects.toThrow(/Invalid value for path parameter/);
    await expect(attempt('/customers/../admin')).rejects.toThrow(/must not contain/);
    await expect(attempt('/customers/%2e%2e/admin')).rejects.toThrow(/must not contain/);
    await expect(attempt('customers/1')).rejects.toThrow(/must start with/);
    await expect(attempt('/customers/:id')).rejects.toThrow(/missing params for \/customers\/:id: id/);
  });

  it('keeps the default result when the hook returns undefined', async () => {
    const { dispatch } = fakeApp();
    let seen: unknown;
    const tool = createRouteTool(
      { method: 'GET', path: '/orders/:id' },
      {
        transformResponse: (res, c) => {
          seen = { ok: res.ok, status: res.status, args: c.args, path: c.request.path, tool: c.tool };
          return undefined;
        },
      },
      dispatch,
    );
    const result = await run(tool, { id: '7' });
    expect(result.structuredContent).toMatchObject({ id: '7', internalNotes: 'secret' });
    expect(seen).toEqual({ ok: true, status: 200, args: { id: '7' }, path: '/orders/7', tool: 'get_orders_by_id' });
  });

  it('keeps HTTP errors as errors when returning a plain value', async () => {
    const { dispatch } = fakeApp();
    const tool = createRouteTool(
      { method: 'GET', path: '/orders/:id' },
      {
        transformResponse: (res) =>
          res.ok ? res.json : `No order with that id. Use list_orders to find one. (${String(res.status)})`,
      },
      dispatch,
    );
    const result = await run(tool, { id: 'missing' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]!.text).toBe('No order with that id. Use list_orders to find one. (404)');
  });

  it('uses a returned ToolResult as is, and exposes the default result', async () => {
    const { dispatch } = fakeApp();
    const tool = createRouteTool(
      { method: 'GET', path: '/orders/:id' },
      {
        transformResponse: (_res, c): ToolResult => {
          const base = c.defaultResult();
          return { ...base, content: [...base.content, { type: 'text', text: 'Tip: amounts are in cents.' }] };
        },
      },
      dispatch,
    );
    const result = await run(tool, { id: 'missing' });
    // The default result for a 404 is an error; the hook kept it.
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text)).toEqual([
      expect.stringContaining('HTTP 404'),
      'Tip: amounts are in cents.',
    ]);
  });

  it('truncates long transformed output and then drops structuredContent', async () => {
    const { dispatch } = fakeApp();
    const tool = createRouteTool(
      { method: 'GET', path: '/orders/:id' },
      { transformResponse: () => ({ big: 'x'.repeat(500) }) },
      dispatch,
      { maxResponseChars: 100 },
    );
    const result = await run(tool, { id: '1' });
    expect(result.content[0]!.text).toContain('…[truncated');
    expect(result.content[0]!.text.length).toBeLessThan(150);
    expect(result.structuredContent).toBeUndefined();
  });

  it('applies the server-level hook to every route tool; a tool-level hook wins', async () => {
    const { dispatch } = fakeApp();
    const serverOpts = {
      transformResponse: (res: { json?: unknown }) => {
        const { internalNotes: _hidden, ...rest } = res.json as Record<string, unknown>;
        return rest;
      },
    };
    const plain = createRouteTool({ method: 'GET', path: '/orders/:id' }, {}, dispatch, serverOpts);
    expect((await run(plain, { id: '1' })).structuredContent).not.toHaveProperty('internalNotes');
    const own = createRouteTool(
      { method: 'GET', path: '/orders/:id' },
      { transformResponse: () => 'own' },
      dispatch,
      serverOpts,
    );
    expect((await run(own, { id: '1' })).content[0]!.text).toBe('own');
  });

  it('reports hook errors to the agent as tool errors', async () => {
    const { dispatch } = fakeApp();
    const server = new McpServer({ name: 't' });
    server.addTool(
      createRouteTool(
        { method: 'GET', path: '/orders/:id' },
        {
          name: 'get_order',
          transformResponse: () => {
            throw new Error('enrichment failed');
          },
        },
        dispatch,
      ),
    );
    server.addTool(defineTool({ name: 'noop', description: 'noop', handler: () => 'ok' }));
    const res = await server.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_order', arguments: { id: '1' } } },
      ctx,
    );
    expect(res).toMatchObject({
      result: { isError: true, content: [{ type: 'text', text: 'Tool error: enrichment failed' }] },
    });
  });

  it('works for tools built from OpenAPI', async () => {
    const { dispatch } = fakeApp();
    const [tool] = toolsFromOpenApi(
      { paths: { '/orders/{id}': { get: { operationId: 'get_order', 'x-mcp': true } } } },
      dispatch,
      { transformResponse: (res) => ({ enriched: true, id: (res.json as { id: string }).id }) },
    );
    expect((await run(tool!, { id: '9' })).structuredContent).toEqual({ enriched: true, id: '9' });
  });

  it('treats data with its own content array as data, not as a ToolResult', async () => {
    const { dispatch } = fakeApp();
    const tool = createRouteTool(
      { method: 'GET', path: '/orders/:id' },
      { transformResponse: () => ({ title: 'Post', content: ['para 1', 'para 2'] }) },
      dispatch,
    );
    const result = await run(tool, { id: '1' });
    expect(result.structuredContent).toEqual({ title: 'Post', content: ['para 1', 'para 2'] });
  });
});
