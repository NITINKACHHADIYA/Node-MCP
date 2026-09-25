import 'reflect-metadata';
import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
  VersioningType,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { IsEmail, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { afterEach, describe, expect, it } from 'vitest';
import { defineTool } from '../src/index.js';
import { McpService, McpModule, McpTool } from '../src/nestjs/index.js';
import { assertAdapterContract, callTool, rpc, TOKEN } from './helpers.js';

@Injectable()
class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    if (req.headers.authorization !== TOKEN) throw new UnauthorizedException();
    return true;
  }
}

class CreateUserDto {
  @IsString()
  @MaxLength(50)
  name!: string;

  @IsEmail()
  @IsOptional()
  email?: string;
}

class ListUsersQuery {
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}

@Controller('users')
@UseGuards(AuthGuard)
class UsersController {
  @Get(':id')
  @McpTool({ name: 'get_user', description: 'Get a user by id' })
  findOne(@Param('id') id: string) {
    return { id, name: `User ${id}` };
  }

  @Post()
  @McpTool({ name: 'create_user', description: 'Create a user' })
  create(@Body() dto: CreateUserDto) {
    return { id: 'new', ...dto };
  }

  @Get()
  list(@Query() _q: ListUsersQuery) {
    return [];
  }
}

@Controller('health')
class HealthController {
  @Get()
  check() {
    return { ok: true };
  }
}

@Module({
  imports: [McpModule.forRoot({ name: 'nest-test', version: '1.2.3' })],
  controllers: [UsersController, HealthController],
})
class AppModule {}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(configure: (a: INestApplication) => void = () => {}, fastify = false) {
  app = fastify
    ? await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false })
    : await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  configure(app);
  await app.listen(0, '127.0.0.1');
  return `${await app.getUrl()}`.replace('[::1]', '127.0.0.1').replace('localhost', '127.0.0.1');
}

describe('nestjs adapter', () => {
  it('satisfies the adapter contract (express platform)', async () => {
    const base = await start();
    await assertAdapterContract(`${base}/mcp`, { get: 'get_user', create: 'create_user' });
  });

  it('satisfies the adapter contract (fastify platform)', async () => {
    const base = await start(() => {}, true);
    await assertAdapterContract(`${base}/mcp`, { get: 'get_user', create: 'create_user' });
  });

  it('derives the input schema from class-validator DTOs', async () => {
    const base = await start();
    const { body } = await rpc(`${base}/mcp`, 'tools/list');
    const create = body.result.tools.find((t: { name: string }) => t.name === 'create_user');
    expect(create.inputSchema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 50 },
        email: { type: 'string', format: 'email' },
      },
      required: ['name'],
    });
    expect(create.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('runs the ValidationPipe on tool calls', async () => {
    const base = await start();
    const res = await callTool(`${base}/mcp`, 'create_user', { name: 'Ada', email: 'nope' }, { authorization: TOKEN });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('email must be an email');
  });

  it('respects the global prefix and URI versioning', async () => {
    const base = await start((a) => {
      a.setGlobalPrefix('api', { exclude: ['mcp'] });
      a.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    });
    const res = await callTool(`${base}/mcp`, 'get_user', { id: '9' }, { authorization: TOKEN });
    expect(res.structuredContent).toEqual({ id: '9', name: 'User 9' });
  });

  it('lets providers register extra tools through McpService', async () => {
    const base = await start((a) => {
      a.get(McpService).server.addTool(
        defineTool({ name: 'server_time', description: 'Current server time', handler: () => ({ now: 'fixed' }) }),
      );
    });
    const res = await callTool(`${base}/mcp`, 'server_time', {});
    expect(res.structuredContent).toEqual({ now: 'fixed' });
  });

  it('reports server info', async () => {
    const base = await start();
    const { body } = await rpc(`${base}/mcp`, 'initialize', { protocolVersion: '1999-01-01' });
    expect(body.result.serverInfo).toEqual({ name: 'nest-test', version: '1.2.3' });
    expect(body.result.protocolVersion).toBe('2025-11-25');
  });
});
