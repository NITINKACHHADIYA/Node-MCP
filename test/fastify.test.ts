import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fastifyMcp } from '../src/fastify/index.js';
import { assertAdapterContract, callTool, rpc, TOKEN } from './helpers.js';

describe('fastify adapter', () => {
  let app: FastifyInstance;
  let url: string;
  const seenIps: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyMcp, { name: 'fastify-test' });

    app.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith('/users')) {
        seenIps.push(req.ip);
        if (req.headers.authorization !== TOKEN) return reply.code(401).send({ message: 'Unauthorized' });
      }
    });

    app.get(
      '/users/:id',
      {
        schema: { params: { type: 'object', properties: { id: { type: 'string', description: 'User id' } }, required: ['id'] } },
        config: { mcp: { name: 'get_user', description: 'Get a user' } },
      },
      async (req) => {
        const { id } = req.params as { id: string };
        return { id, name: `User ${id}` };
      },
    );
    app.post(
      '/users',
      {
        // Fastify's own schema becomes the tool schema AND validates the call.
        schema: { body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
        config: { mcp: { name: 'create_user', description: 'Create a user' } },
      },
      async (req, reply) => {
        const { name } = req.body as { name: string };
        if (/^\d+$/.test(name)) return reply.code(400).send({ message: 'name must not be numeric' });
        return reply.code(201).send({ id: 'new', name });
      },
    );
    app.get('/health', async () => ({ ok: true }));

    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    url = `${address}/mcp`;
  });

  afterAll(() => app.close());

  it('satisfies the adapter contract', async () => {
    await assertAdapterContract(url, { get: 'get_user', create: 'create_user' });
  });

  it('reuses route JSON schemas for tool input', async () => {
    const list = await rpc(url, 'tools/list');
    const get = list.body.result.tools.find((t: { name: string }) => t.name === 'get_user');
    expect(get.inputSchema.properties.id.description).toBe('User id');
  });

  it('forwards the MCP client IP to the injected request', async () => {
    seenIps.length = 0;
    await callTool(url, 'get_user', { id: '1' }, { authorization: TOKEN });
    expect(seenIps).toEqual(['127.0.0.1']);
  });
});
