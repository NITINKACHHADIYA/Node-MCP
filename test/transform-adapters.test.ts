import 'reflect-metadata';
import { AppFactory } from '@adonisjs/application/factories';
import type { HttpContext } from '@adonisjs/core/http';
import { ServerFactory } from '@adonisjs/http-server/factories';
import Router from '@koa/router';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  Param,
  UnauthorizedException,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import express, { type NextFunction, type Request, type Response } from 'express';
import Fastify from 'fastify';
import { Hono, type MiddlewareHandler } from 'hono';
import Koa, { type Context, type Next } from 'koa';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mountMcp as mountAdonis } from '../src/adonisjs/index.js';
import { mcpTool as expressTool, mountMcp as mountExpress } from '../src/express/index.js';
import { fastifyMcp } from '../src/fastify/index.js';
import { mcpTool as honoTool, mountMcp as mountHono } from '../src/hono/index.js';
import type { ResponseTransform } from '../src/index.js';
import { koaMcp, mcpTool as koaTool } from '../src/koa/index.js';
import { McpModule, McpTool } from '../src/nestjs/index.js';
import { baseUrlOf, callTool, TOKEN } from './helpers.js';

/**
 * Every app serves, behind its own auth:
 *   GET /orders/:id     -> { id, customerId, internal }   exposed as get_order (tool-level hook)
 *   GET /customers/:id  -> { id, name }                   exposed as get_customer (server-level hook only)
 */
const order = (id: string) => ({ id, customerId: 'c9', internal: 'hidden' });
const customer = (id: string) => ({ id, name: `Customer ${id}` });

/** Tool-level hook: drop `internal`, add the customer by calling another route through the app. */
const enrichOrder: ResponseTransform = async (res, ctx) => {
  if (!res.ok) return undefined;
  const { internal: _hidden, ...o } = res.json as ReturnType<typeof order>;
  const c = await ctx.callRoute({ path: '/customers/:id', params: { id: o.customerId } });
  return { ...o, customer: c.ok ? c.json : `unavailable (${c.status})` };
};
/** Server-level hook, used by tools without their own. */
const serverHook: ResponseTransform = (res) => (res.ok ? { data: res.json, via: 'server' } : undefined);

async function assertTransforms(mcpUrl: string) {
  const enriched = await callTool(mcpUrl, 'get_order', { id: '5' }, { authorization: TOKEN });
  expect(enriched.isError).toBeFalsy();
  // The customer came from a second route that also required auth: credentials were forwarded.
  expect(enriched.structuredContent).toEqual({
    id: '5',
    customerId: 'c9',
    customer: { id: 'c9', name: 'Customer c9' },
  });

  const viaServer = await callTool(mcpUrl, 'get_customer', { id: '3' }, { authorization: TOKEN });
  expect(viaServer.structuredContent).toEqual({ data: { id: '3', name: 'Customer 3' }, via: 'server' });

  // Unauthorized: the hook returns undefined, so the default 401 error comes through.
  const denied = await callTool(mcpUrl, 'get_order', { id: '5' });
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toContain('401');
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
function listen(server: Server): Promise<string> {
  cleanups.push(() => new Promise((r) => server.close(r)));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(baseUrlOf(server))));
}

describe('transformResponse on every adapter', () => {
  it('express', async () => {
    const app = express();
    const auth = (req: Request, res: Response, next: NextFunction) =>
      req.headers.authorization === TOKEN ? next() : res.status(401).json({ message: 'Unauthorized' });
    app.get('/orders/:id', expressTool({ name: 'get_order', transformResponse: enrichOrder }), auth, (req, res) => {
      res.json(order(req.params.id as string));
    });
    app.get('/customers/:id', expressTool({ name: 'get_customer' }), auth, (req, res) => {
      res.json(customer(req.params.id as string));
    });
    mountExpress(app, { name: 'x', transformResponse: serverHook });
    await assertTransforms(`${await listen(createServer(app))}/mcp`);
  });

  it('fastify', async () => {
    const app = Fastify();
    await app.register(fastifyMcp, { name: 'f', transformResponse: serverHook });
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith('/mcp')) return;
      if (req.headers.authorization !== TOKEN) return reply.code(401).send({ message: 'Unauthorized' });
    });
    app.get('/orders/:id', { config: { mcp: { name: 'get_order', transformResponse: enrichOrder } } }, async (req) =>
      order((req.params as { id: string }).id),
    );
    app.get('/customers/:id', { config: { mcp: { name: 'get_customer' } } }, async (req) =>
      customer((req.params as { id: string }).id),
    );
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    await assertTransforms(`${base}/mcp`);
  });

  it('koa', async () => {
    const app = new Koa();
    const router = new Router();
    const auth = async (ctx: Context, next: Next) => {
      if (ctx.get('authorization') !== TOKEN) {
        ctx.status = 401;
        ctx.body = { message: 'Unauthorized' };
        return;
      }
      await next();
    };
    router.get('/orders/:id', koaTool({ name: 'get_order', transformResponse: enrichOrder }), auth, (ctx) => {
      ctx.body = order(ctx.params.id!);
    });
    router.get('/customers/:id', koaTool({ name: 'get_customer' }), auth, (ctx) => {
      ctx.body = customer(ctx.params.id!);
    });
    app.use(koaMcp({ name: 'k', routers: [router], transformResponse: serverHook }));
    app.use(router.routes());
    await assertTransforms(`${await listen(createServer(app.callback()))}/mcp`);
  });

  it('hono (in-process dispatch)', async () => {
    const app = new Hono();
    const auth: MiddlewareHandler = async (c, next) => {
      if (c.req.header('authorization') !== TOKEN) return c.json({ message: 'Unauthorized' }, 401);
      await next();
    };
    app.get('/orders/:id', honoTool({ name: 'get_order', transformResponse: enrichOrder }), auth, (c) =>
      c.json(order(c.req.param('id'))),
    );
    app.get('/customers/:id', honoTool({ name: 'get_customer' }), auth, (c) => c.json(customer(c.req.param('id'))));
    mountHono(app, { name: 'h', transformResponse: serverHook });
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
    await assertTransforms(`${await listen(server)}/mcp`);
  });

  it('adonisjs', async () => {
    const application = new AppFactory().create(new URL('./', import.meta.url));
    await application.init();
    const app = new ServerFactory().merge({ app: application }).create();
    const router = app.getRouter();
    const auth = async (ctx: HttpContext, next: () => Promise<void>) => {
      if (ctx.request.header('authorization') !== TOKEN) return ctx.response.unauthorized({ message: 'no' });
      await next();
    };
    router
      .get('/orders/:id', (ctx: HttpContext) => order(ctx.params.id))
      .use(auth)
      .mcp({ name: 'get_order', transformResponse: enrichOrder });
    router
      .get('/customers/:id', (ctx: HttpContext) => customer(ctx.params.id))
      .use(auth)
      .mcp({ name: 'get_customer' });
    mountAdonis(router, { name: 'a', transformResponse: serverHook });
    await app.boot();
    await assertTransforms(`${await listen(createServer((req, res) => app.handle(req, res)))}/mcp`);
  });

  describe('nestjs', () => {
    @Injectable()
    class AuthGuard implements CanActivate {
      canActivate(ctx: ExecutionContext) {
        if (ctx.switchToHttp().getRequest().headers.authorization !== TOKEN) throw new UnauthorizedException();
        return true;
      }
    }

    @Controller()
    @UseGuards(AuthGuard)
    class ShopController {
      @Get('orders/:id')
      @McpTool({ name: 'get_order', transformResponse: enrichOrder })
      getOrder(@Param('id') id: string) {
        return order(id);
      }

      @Get('customers/:id')
      @McpTool({ name: 'get_customer' })
      getCustomer(@Param('id') id: string) {
        return customer(id);
      }
    }

    let app: INestApplication | undefined;
    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    for (const platform of ['express', 'fastify'] as const) {
      it(`${platform} platform with a global prefix`, async () => {
        @Module({
          imports: [McpModule.forRoot({ name: 'n', transformResponse: serverHook })],
          controllers: [ShopController],
        })
        class AppModule {}
        app =
          platform === 'fastify'
            ? await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false })
            : await NestFactory.create(AppModule, { logger: false });
        // Tool routes live under /api; callRoute gets app paths, so the hook uses /api too.
        app.setGlobalPrefix('api', { exclude: ['mcp'] });
        await app.listen(0, '127.0.0.1');
        const base = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');
        const url = `${base}/mcp`;

        const viaServer = await callTool(url, 'get_customer', { id: '3' }, { authorization: TOKEN });
        expect(viaServer.structuredContent).toEqual({ data: { id: '3', name: 'Customer 3' }, via: 'server' });
        // enrichOrder calls /customers/:id without the prefix, which 404s here: the hook
        // reports it instead of failing the call.
        const enriched = await callTool(url, 'get_order', { id: '5' }, { authorization: TOKEN });
        expect(enriched.structuredContent).toEqual({ id: '5', customerId: 'c9', customer: 'unavailable (404)' });
      });
    }

    it('express platform without a prefix', async () => {
      @Module({
        imports: [McpModule.forRoot({ name: 'n', transformResponse: serverHook })],
        controllers: [ShopController],
      })
      class AppModule {}
      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');
      await assertTransforms(`${base}/mcp`);
    });
  });
});
