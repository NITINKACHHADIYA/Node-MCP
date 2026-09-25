import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { mcpTool, mountMcp } from 'mcp-expose/hono';
import { z } from 'zod';

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
const orders = new Map<string, object>([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);
const CreateOrder = z.object({ sku: z.string(), quantity: z.number().int().min(1).max(10) });
const auth = bearerAuth({ token: 'e2e-token' });

const api = new Hono();
api.get('/products', mcpTool({ name: 'search_products', description: 'Search products', query: z.object({ q: z.string().optional() }) }), (c) => {
  const q = (c.req.query('q') ?? '').toLowerCase();
  return c.json({ items: products.filter((p) => p.name.toLowerCase().includes(q)) });
});
api.get('/orders/:id', mcpTool({ name: 'get_order', description: 'Get an order' }), auth, (c) =>
  c.json(orders.get(c.req.param('id')) ?? { error: 'not found' }),
);
api.post('/orders', mcpTool({ name: 'create_order', description: 'Create an order', body: CreateOrder }), auth, async (c) => {
  const parsed = CreateOrder.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const order = { id: String(orders.size + 1), ...parsed.data, status: 'pending' };
  orders.set(order.id, order);
  return c.json(order, 201);
});
api.delete('/orders/:id', mcpTool({ name: 'cancel_order', description: 'Cancel an order' }), auth, (c) =>
  c.json({ id: c.req.param('id'), status: 'cancelled' }),
);
api.get('/whoami', mcpTool({ name: 'whoami', description: 'Debug' }), (c) => c.json({ tool: c.req.header('x-mcp-tool') ?? null }));
api.get('/admin/stats', auth, (c) => c.json({ orders: orders.size })); // not exposed

const app = new Hono();
app.route('/api', api);
mountMcp(app, { name: 'shop-api' });

serve({ fetch: app.fetch, port: Number(process.env.PORT), hostname: '127.0.0.1' }, () => console.log('READY'));
