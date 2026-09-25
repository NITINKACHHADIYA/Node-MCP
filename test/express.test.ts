import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineTool } from '../src/index.js';
import { mcpTool, mountMcp } from '../src/express/index.js';
import { assertAdapterContract, baseUrlOf, callTool, rpc, TOKEN } from './helpers.js';

const auth = (req: Request, res: Response, next: NextFunction) =>
  req.headers.authorization === TOKEN ? next() : res.status(401).json({ message: 'Unauthorized' });

describe('express adapter', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());

    app.get('/users/:id', mcpTool({ name: 'get_user', description: 'Get a user' }), auth, (req, res) => {
      res.json({ id: req.params.id, name: `User ${req.params.id}` });
    });
    app.post(
      '/users',
      mcpTool({
        name: 'create_user',
        description: 'Create a user',
        body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      }),
      auth,
      (req, res) => {
        if (typeof req.body.name !== 'string') return res.status(400).json({ message: 'name must be a string' });
        res.status(201).json({ id: 'new', name: req.body.name });
      },
    );
    app.get('/health', (_req, res) => res.json({ ok: true }));

    const api = express.Router();
    api.get(
      '/orders',
      mcpTool({ description: 'List orders', query: { type: 'object', properties: { status: { type: 'string' } } } }),
      (req, res) => res.json({ status: req.query.status ?? 'any', orders: [] }),
    );
    app.use('/api', api);

    mountMcp(app, {
      name: 'express-test',
      routers: { '/api': api },
      tools: [defineTool({ name: 'echo', description: 'Echo', handler: (args) => args })],
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    url = `${baseUrlOf(server)}/mcp`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('exposes routes on nested routers and custom tools', async () => {
    const list = await rpc(url, 'tools/list');
    const names = list.body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['create_user', 'echo', 'get_api_orders', 'get_user']);

    const orders = await callTool(url, 'get_api_orders', { status: 'open' });
    expect(orders.structuredContent).toEqual({ status: 'open', orders: [] });

    const echo = await callTool(url, 'echo', { a: 1 });
    expect(echo.structuredContent).toEqual({ a: 1 });
  });

  it('rejects GET on the MCP endpoint with 405', async () => {
    const res = await fetch(url);
    expect(res.status).toBe(405);
  });

  it('satisfies the adapter contract', async () => {
    // The shared contract expects exactly two tools, so use a minimal app.
    const app = express();
    app.use(express.json());
    app.get('/users/:id', mcpTool({ name: 'get_user', description: 'Get a user' }), auth, (req, res) => {
      res.json({ id: req.params.id, name: `User ${req.params.id}` });
    });
    app.post(
      '/users',
      mcpTool({
        name: 'create_user',
        body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      }),
      auth,
      (req, res) => {
        if (typeof req.body.name !== 'string') return res.status(400).json({ message: 'name must be a string' });
        res.status(201).json({ id: 'new', name: req.body.name });
      },
    );
    mountMcp(app, { name: 'contract' });
    const s = await new Promise<Server>((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    try {
      await assertAdapterContract(`${baseUrlOf(s)}/mcp`, { get: 'get_user', create: 'create_user' });
    } finally {
      s.close();
    }
  });
});
