import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { fastifyMcp } from 'mcp-expose/fastify';

const app = Fastify();
await app.register(fastifyMcp, { name: 'shop-api' });
await app.register(rateLimit, { global: false });

type Order = { id: string; sku: string; quantity: number; status: string };
const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
const orders = new Map<string, Order>([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);

app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/orders') && req.headers.authorization !== 'Bearer e2e-token') {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
});

app.get<{ Querystring: { q?: string } }>(
  '/products',
  {
    schema: { querystring: { type: 'object', properties: { q: { type: 'string' } } } },
    config: {
      mcp: { name: 'search_products', description: 'Search products' },
      rateLimit: { max: 5, timeWindow: 60_000 },
    },
  },
  async (req) => ({ items: products.filter((p) => p.name.toLowerCase().includes((req.query.q ?? '').toLowerCase())) }),
);

app.get<{ Params: { id: string } }>(
  '/orders/:id',
  { config: { mcp: { name: 'get_order', description: 'Get an order' } } },
  async (req, reply) => orders.get(req.params.id) ?? reply.code(404).send({ error: 'Not found' }),
);

app.post<{ Body: { sku: string; quantity: number } }>(
  '/orders',
  {
    schema: {
      body: {
        type: 'object',
        properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['sku', 'quantity'],
      },
    },
    config: { mcp: { name: 'create_order', description: 'Create an order' } },
  },
  async (req, reply) => {
    const order = { id: String(orders.size + 1), ...req.body, status: 'pending' };
    orders.set(order.id, order);
    return reply.code(201).send(order);
  },
);

app.delete<{ Params: { id: string } }>(
  '/orders/:id',
  { config: { mcp: { name: 'cancel_order', description: 'Cancel an order' } } },
  async (req) => ({ id: req.params.id, status: 'cancelled' }),
);

app.get('/whoami', { config: { mcp: { name: 'whoami', description: 'Debug' } } }, async (req) => ({
  tool: req.headers['x-mcp-tool'] ?? null,
}));

app.get('/admin/stats', async () => ({ orders: orders.size })); // not exposed

// Typed access to the decorated server.
app.mcpServer.options.instructions = 'Search before ordering.';

await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
console.log('READY');
