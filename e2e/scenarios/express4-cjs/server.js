// Plain JavaScript + CommonJS: the most common legacy Express setup.
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { mcpTool, mountMcp } = require('mcp-expose/express');

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json());

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }, { id: '2', name: 'Mouse', sku: 'MS-01' }];
const orders = new Map([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);

const auth = (req, res, next) =>
  req.headers.authorization === 'Bearer e2e-token' ? next() : res.status(401).json({ error: 'Unauthorized' });
const searchLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });

const api = express.Router();

api.get('/products',
  mcpTool({ name: 'search_products', description: 'Search products by name', query: { type: 'object', properties: { q: { type: 'string' } } } }),
  searchLimiter,
  (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    res.json({ items: products.filter((p) => p.name.toLowerCase().includes(q)) });
  });

api.get('/orders/:id', mcpTool({ name: 'get_order', description: 'Get an order' }), auth, (req, res) => {
  const order = orders.get(req.params.id);
  order ? res.json(order) : res.status(404).json({ error: 'Not found' });
});

api.post('/orders',
  mcpTool({
    name: 'create_order',
    description: 'Create an order',
    body: {
      type: 'object',
      properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['sku', 'quantity'],
    },
  }),
  auth,
  (req, res) => {
    const { sku, quantity } = req.body;
    if (typeof sku !== 'string' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return res.status(400).json({ error: 'quantity must be an integer between 1 and 10' });
    }
    const order = { id: String(orders.size + 1), sku, quantity, status: 'pending' };
    orders.set(order.id, order);
    res.status(201).json(order);
  });

api.delete('/orders/:id', mcpTool({ name: 'cancel_order', description: 'Cancel an order' }), auth, (req, res) => {
  res.json({ id: req.params.id, status: 'cancelled' });
});

api.get('/whoami', mcpTool({ name: 'whoami', description: 'Debug' }), (req, res) => {
  res.json({ tool: req.headers['x-mcp-tool'] || null, ip: req.ip });
});

api.get('/admin/stats', auth, (req, res) => res.json({ orders: orders.size })); // not exposed

app.use('/api', api);
mountMcp(app, { name: 'shop-api' });

app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('READY'));
