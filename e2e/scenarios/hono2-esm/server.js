import { createServer } from 'node:http';
import { Hono } from 'hono';
import { mcpTool, mountMcp } from 'mcp-expose/hono';

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
const orders = new Map([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);
const auth = async (c, next) => {
  if (c.req.header('authorization') !== 'Bearer e2e-token') return c.json({ error: 'Unauthorized' }, 401);
  await next();
};

const app = new Hono();
app.get(
  '/products',
  mcpTool({
    name: 'search_products',
    description: 'Search products',
    query: { type: 'object', properties: { q: { type: 'string' } } },
  }),
  (c) => {
    const q = (c.req.query('q') ?? '').toLowerCase();
    return c.json({ items: products.filter((p) => p.name.toLowerCase().includes(q)) });
  },
);
app.get('/orders/:id', mcpTool({ name: 'get_order', description: 'Get an order' }), auth, (c) =>
  c.json(orders.get(c.req.param('id')) ?? { error: 'not found' }),
);
app.post(
  '/orders',
  mcpTool({
    name: 'create_order',
    description: 'Create an order',
    body: {
      type: 'object',
      properties: { sku: { type: 'string' }, quantity: { type: 'integer' } },
      required: ['sku', 'quantity'],
    },
  }),
  auth,
  async (c) => {
    const { sku, quantity } = await c.req.json();
    if (typeof sku !== 'string' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10)
      return c.json({ error: 'invalid' }, 400);
    const order = { id: String(orders.size + 1), sku, quantity, status: 'pending' };
    orders.set(order.id, order);
    return c.json(order, 201);
  },
);
app.delete('/orders/:id', mcpTool({ name: 'cancel_order', description: 'Cancel an order' }), auth, (c) =>
  c.json({ id: c.req.param('id'), status: 'cancelled' }),
);
app.get('/whoami', mcpTool({ name: 'whoami', description: 'Debug' }), (c) =>
  c.json({ tool: c.req.header('x-mcp-tool') ?? null }),
);
app.get('/admin/stats', auth, (c) => c.json({ orders: orders.size })); // not exposed

mountMcp(app, { name: 'shop-api' });

createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const response = await app.fetch(
    new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: body || undefined }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('READY'));
