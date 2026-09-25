/**
 * Fastify example.  Run:  npm run build && npx tsx examples/fastify/server.ts
 */
import Fastify from 'fastify';
import { fastifyMcp } from 'mcp-expose/fastify';

const app = Fastify({ logger: true });

// 1. Register BEFORE your routes so the plugin can see them.
await app.register(fastifyMcp, { name: 'todo-api', version: '1.0.0' });

app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/todos') && req.headers.authorization !== 'Bearer dev-token') {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
});

const todos: { id: number; title: string; done: boolean }[] = [];

// 2. Add `config.mcp`. The route's JSON schema IS the tool schema. No duplication.
app.get(
  '/todos',
  {
    schema: { querystring: { type: 'object', properties: { done: { type: 'boolean' } } } },
    config: { mcp: { name: 'list_todos', description: 'List todos, optionally filtered by completion.' } },
  },
  async (req) => {
    const { done } = req.query as { done?: boolean };
    return { todos: done === undefined ? todos : todos.filter((t) => t.done === done) };
  },
);

app.post(
  '/todos',
  {
    schema: {
      body: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1, description: 'What needs doing' } },
        required: ['title'],
      },
    },
    config: { mcp: { name: 'add_todo', description: 'Add a todo item.' } },
  },
  async (req, reply) => {
    const todo = { id: todos.length + 1, title: (req.body as { title: string }).title, done: false };
    todos.push(todo);
    return reply.code(201).send(todo);
  },
);

await app.listen({ port: 3000 });
