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
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
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
import { koaMcp, mcpTool as koaTool } from '../src/koa/index.js';
import { McpModule, McpTool } from '../src/nestjs/index.js';
import { assertOAuthContract, baseUrlOf, OAUTH, rpc, TOKEN } from './helpers.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function listen(server: Server): Promise<string> {
  cleanups.push(() => new Promise((r) => server.close(r)));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(baseUrlOf(server))));
}

describe('OAuth on every adapter', () => {
  it('express: endpoint middleware does not protect the metadata', async () => {
    const app = express();
    mountExpress(app, {
      name: 'x',
      oauth: OAUTH,
      middleware: [(_req, res) => void ((res.statusCode = 418), res.end())],
    });
    const base = await listen(createServer(app));
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(418);
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
  });

  it('express', async () => {
    const app = express();
    const auth = (req: Request, res: Response, next: NextFunction) =>
      req.headers.authorization === TOKEN ? next() : res.status(401).json({ message: 'Unauthorized' });
    app.get('/users/:id', expressTool({ name: 'get_user' }), auth, (req, res) => {
      res.json({ id: req.params.id, name: `User ${req.params.id}` });
    });
    mountExpress(app, { name: 'x', oauth: OAUTH });
    await assertOAuthContract(await listen(createServer(app)));
  });

  it('fastify', async () => {
    const app = Fastify();
    await app.register(fastifyMcp, {
      name: 'f',
      oauth: OAUTH,
      // Hooks on the MCP route must not protect the metadata.
      routeOptions: { onRequest: async () => {} },
    });
    app.get('/users/:id', { config: { mcp: { name: 'get_user' } } }, async (req, reply) => {
      if (req.headers.authorization !== TOKEN) return reply.code(401).send({ message: 'Unauthorized' });
      const { id } = req.params as { id: string };
      return { id, name: `User ${id}` };
    });
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    await assertOAuthContract(base);
  });

  it('koa', async () => {
    const app = new Koa();
    const router = new Router();
    router.get('/users/:id', koaTool({ name: 'get_user' }), async (ctx: Context, next: Next) => {
      if (ctx.get('authorization') !== TOKEN) {
        ctx.status = 401;
        return;
      }
      ctx.body = { id: ctx.params.id, name: `User ${ctx.params.id}` };
      await next();
    });
    app.use(koaMcp({ name: 'k', oauth: OAUTH, routers: [router] }));
    app.use(router.routes());
    await assertOAuthContract(await listen(createServer(app.callback())));
  });

  it('hono', async () => {
    const app = new Hono();
    const auth: MiddlewareHandler = async (c, next) => {
      if (c.req.header('authorization') !== TOKEN) return c.json({ message: 'Unauthorized' }, 401);
      await next();
    };
    app.get('/users/:id', honoTool({ name: 'get_user' }), auth, (c) =>
      c.json({ id: c.req.param('id'), name: `User ${c.req.param('id')}` }),
    );
    mountHono(app, { name: 'h', oauth: OAUTH });
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
    await assertOAuthContract(await listen(server));
  });

  it('adonisjs', async () => {
    const application = new AppFactory().create(new URL('./', import.meta.url));
    await application.init();
    const app = new ServerFactory().merge({ app: application }).create();
    const router = app.getRouter();
    router
      .get('/users/:id', (ctx: HttpContext) => {
        if (ctx.request.header('authorization') !== TOKEN) return ctx.response.unauthorized({ message: 'no' });
        return { id: ctx.params.id, name: `User ${ctx.params.id}` };
      })
      .mcp({ name: 'get_user' });
    mountAdonis(router, {
      name: 'a',
      oauth: OAUTH,
      // Middleware on the MCP route must not protect the metadata.
      configureRoute: (route) => route.use(async (_ctx, next) => next()),
    });
    await app.boot();
    await assertOAuthContract(await listen(createServer((req, res) => app.handle(req, res))));
  });

  describe('nestjs', () => {
    const IS_PUBLIC = 'isPublic';
    const Public = () => SetMetadata(IS_PUBLIC, true);

    @Injectable()
    class AuthGuard implements CanActivate {
      canActivate(ctx: ExecutionContext) {
        if (ctx.switchToHttp().getRequest().headers.authorization !== TOKEN) throw new UnauthorizedException();
        return true;
      }
    }

    /** A typical global guard: everything needs a session unless marked @Public(). */
    @Injectable()
    class GlobalGuard implements CanActivate {
      constructor(private readonly reflector: Reflector) {}
      canActivate(ctx: ExecutionContext) {
        if (this.reflector.getAllAndOverride(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
        if (ctx.switchToHttp().getRequest().headers.authorization !== TOKEN) throw new UnauthorizedException();
        return true;
      }
    }

    @Controller('users')
    @UseGuards(AuthGuard)
    class UsersController {
      @Get(':id')
      @McpTool({ name: 'get_user' })
      findOne(@Param('id') id: string) {
        return { id, name: `User ${id}` };
      }
    }

    @Module({
      imports: [McpModule.forRoot({ name: 'n', oauth: OAUTH, decorators: [Public()] })],
      controllers: [UsersController],
      providers: [{ provide: APP_GUARD, useClass: GlobalGuard }],
    })
    class AppModule {}

    let app: INestApplication | undefined;
    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    for (const platform of ['express', 'fastify'] as const) {
      it(`${platform} platform, global prefix, global guard`, async () => {
        app =
          platform === 'fastify'
            ? await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false })
            : await NestFactory.create(AppModule, { logger: false });
        // The metadata stays at the root, outside the global prefix.
        app.setGlobalPrefix('api', { exclude: ['mcp'] });
        await app.listen(0, '127.0.0.1');
        const base = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');
        await assertOAuthContract(base);
      });
    }

    it('without the Public() decorator a global guard hides the challenge', async () => {
      @Module({
        imports: [McpModule.forRoot({ name: 'n', oauth: OAUTH })],
        controllers: [UsersController],
        providers: [{ provide: APP_GUARD, useClass: GlobalGuard }],
      })
      class GuardedModule {}
      app = await NestFactory.create(GuardedModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');
      const res = await rpc(`${base}/mcp`, 'tools/list');
      expect(res.status).toBe(401);
      // Metadata is still public: it is served outside Nest's guards.
      expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
    });
  });
});
