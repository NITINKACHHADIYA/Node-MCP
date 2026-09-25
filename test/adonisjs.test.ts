import { AppFactory } from '@adonisjs/application/factories';
import { BodyParserMiddlewareFactory } from '@adonisjs/bodyparser/factories';
import type { HttpContext } from '@adonisjs/core/http';
import { ServerFactory } from '@adonisjs/http-server/factories';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpTool, mountMcp } from '../src/adonisjs/index.js';
import { assertAdapterContract, baseUrlOf, callTool, rpc, TOKEN } from './helpers.js';

// Real AdonisJS HTTP server (router, middleware pipeline, bodyparser) built
// with Adonis' own test factories.
describe('adonisjs adapter', () => {
  let httpServer: Server;
  let url: string;

  beforeAll(async () => {
    const application = new AppFactory().create(new URL('./', import.meta.url));
    await application.init();
    const app = new ServerFactory().merge({ app: application }).create();
    const router = app.getRouter();
    const bodyparser = new BodyParserMiddlewareFactory().create();
    const parseBody = (ctx: HttpContext, next: () => Promise<void>) => bodyparser.handle(ctx, next);
    const auth = async (ctx: HttpContext, next: () => Promise<void>) => {
      if (ctx.request.header('authorization') !== TOKEN) {
        return ctx.response.unauthorized({ message: 'Unauthorized' });
      }
      await next();
    };

    router
      .group(() => {
        router
          .get('/users/:id', ({ params }: HttpContext) => ({ id: params.id, name: `User ${params.id}` }))
          .use(auth)
          .mcp({ name: 'get_user', description: 'Get a user' });

        router
          .post('/users', (ctx: HttpContext) => {
            const { name } = ctx.request.body();
            if (typeof name !== 'string') return ctx.response.badRequest({ message: 'name must be a string' });
            return ctx.response.created({ id: 'new', name });
          })
          .use([parseBody, auth])
          .mcp({
            name: 'create_user',
            body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          });
      })
      .prefix('/api/v1');

    router.get('/health', () => ({ ok: true })); // not exposed

    mountMcp(router, { name: 'adonis-test' });
    await app.boot();

    httpServer = createServer((req, res) => app.handle(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    url = `${baseUrlOf(httpServer)}/mcp`;
  });

  afterAll(() => new Promise<void>((r) => httpServer.close(() => r())));

  it('satisfies the adapter contract', async () => {
    await assertAdapterContract(url, { get: 'get_user', create: 'create_user' });
  });

  it('applies group prefixes to tool routes', async () => {
    const res = await callTool(url, 'get_user', { id: '5' }, { authorization: TOKEN });
    expect(res.structuredContent).toEqual({ id: '5', name: 'User 5' });
  });

  it('only lists routes of its own router', async () => {
    // A route marked on another router instance must not leak into this server.
    const other = new ServerFactory().create().getRouter();
    mcpTool(
      other.get('/other', () => ({})),
      { name: 'other_route' },
    );
    const { body } = await rpc(url, 'tools/list');
    expect(body.result.tools.map((t: { name: string }) => t.name)).not.toContain('other_route');
  });
});
