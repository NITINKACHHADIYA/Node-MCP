import Router from '@koa/router';
import Koa, { type Context, type Next } from 'koa';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { koaMcp, mcpTool } from '../src/koa/index.js';
import { assertAdapterContract, baseUrlOf, TOKEN } from './helpers.js';

// Minimal JSON body parser so the test has no extra dependency.
async function jsonBody(ctx: Context, next: Next) {
  if (ctx.is('application/json') && ctx.path !== '/mcp') {
    let raw = '';
    for await (const chunk of ctx.req) raw += chunk;
    (ctx.request as { body?: unknown }).body = raw ? JSON.parse(raw) : {};
  }
  await next();
}

async function auth(ctx: Context, next: Next) {
  if (ctx.get('authorization') !== TOKEN) {
    ctx.status = 401;
    ctx.body = { message: 'Unauthorized' };
    return;
  }
  await next();
}

describe('koa adapter', () => {
  let server: Server;

  beforeAll(async () => {
    const app = new Koa();
    const router = new Router();

    router.get('/users/:id', mcpTool({ name: 'get_user', description: 'Get a user' }), auth, (ctx) => {
      ctx.body = { id: ctx.params.id, name: `User ${ctx.params.id}` };
    });
    router.post(
      '/users',
      mcpTool({ name: 'create_user', body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }),
      auth,
      (ctx) => {
        const body = (ctx.request as { body?: { name?: unknown } }).body ?? {};
        if (typeof body.name !== 'string') {
          ctx.status = 400;
          ctx.body = { message: 'name must be a string' };
          return;
        }
        ctx.status = 201;
        ctx.body = { id: 'new', name: body.name };
      },
    );
    router.get('/health', (ctx) => {
      ctx.body = { ok: true };
    });

    app.use(jsonBody);
    app.use(koaMcp({ name: 'koa-test', routers: [router] }));
    app.use(router.routes());
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('satisfies the adapter contract', async () => {
    await assertAdapterContract(`${baseUrlOf(server)}/mcp`, { get: 'get_user', create: 'create_user' });
  });
});
