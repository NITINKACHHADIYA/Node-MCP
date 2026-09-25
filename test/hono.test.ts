import { Hono, type MiddlewareHandler } from 'hono';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mcpTool, mountMcp } from '../src/hono/index.js';
import { assertAdapterContract, baseUrlOf, TOKEN } from './helpers.js';

const auth: MiddlewareHandler = async (c, next) => {
  if (c.req.header('authorization') !== TOKEN) return c.json({ message: 'Unauthorized' }, 401);
  await next();
};

function buildApp() {
  const app = new Hono();
  app.get('/users/:id', mcpTool({ name: 'get_user', description: 'Get a user' }), auth, (c) =>
    c.json({ id: c.req.param('id'), name: `User ${c.req.param('id')}` }),
  );
  app.post(
    '/users',
    // zod schemas work anywhere a schema is accepted.
    mcpTool({ name: 'create_user', body: z.object({ name: z.string().describe('Display name') }) }),
    auth,
    async (c) => {
      const body = await c.req.json();
      if (typeof body.name !== 'string') return c.json({ message: 'name must be a string' }, 400);
      return c.json({ id: 'new', name: body.name }, 201);
    },
  );
  app.get('/health', (c) => c.json({ ok: true }));
  mountMcp(app, { name: 'hono-test' });
  return app;
}

/** Serve a fetch handler with node:http (avoids depending on @hono/node-server). */
function serve(app: Hono): Promise<Server> {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const response = await app.fetch(
      new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: body && req.method !== 'GET' ? body : undefined,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('hono adapter', () => {
  let server: Server;
  let app: Hono;

  beforeAll(async () => {
    app = buildApp();
    server = await serve(app);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('satisfies the adapter contract', async () => {
    await assertAdapterContract(`${baseUrlOf(server)}/mcp`, { get: 'get_user', create: 'create_user' });
  });

  it('works without any HTTP server (edge runtimes)', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: TOKEN },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_user', arguments: { id: '3' } } }),
    });
    const json = await res.json();
    expect(json.result.structuredContent).toEqual({ id: '3', name: 'User 3' });
  });

  it('turns zod descriptions into JSON Schema', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const { result } = await res.json();
    const create = result.tools.find((t: { name: string }) => t.name === 'create_user');
    expect(create.inputSchema.properties.name).toMatchObject({ type: 'string', description: 'Display name' });
    expect(create.inputSchema.required).toEqual(['name']);
  });
});
