// Express 3 (legacy): app-level routes and the bundled connect body parser.
const express = require('express');
const { mcpTool, mountMcp } = require('mcp-expose/express');

const app = express();
app.use(express.json());

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
const orders = { 1: { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' } };

function auth(req, res, next) {
  if (req.headers.authorization !== 'Bearer e2e-token') return res.json(401, { error: 'Unauthorized' });
  next();
}

app.get(
  '/products',
  mcpTool({
    name: 'search_products',
    description: 'Search products',
    query: { type: 'object', properties: { q: { type: 'string' } } },
  }),
  function (req, res) {
    const q = String(req.query.q || '').toLowerCase();
    res.json({ items: products.filter((p) => p.name.toLowerCase().includes(q)) });
  },
);

app.get('/orders/:id', mcpTool({ name: 'get_order', description: 'Get an order' }), auth, function (req, res) {
  res.json(orders[req.params.id] || { error: 'not found' });
});

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
  function (req, res) {
    const body = req.body || {};
    const quantity = body.quantity;
    if (typeof body.sku !== 'string' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return res.json(400, { error: 'quantity must be 1-10' });
    }
    const order = { id: String(Object.keys(orders).length + 1), sku: body.sku, quantity, status: 'pending' };
    orders[order.id] = order;
    res.json(201, order);
  },
);

app.del('/orders/:id', mcpTool({ name: 'cancel_order', description: 'Cancel an order' }), auth, function (req, res) {
  res.json({ id: req.params.id, status: 'cancelled' });
});

app.get('/whoami', mcpTool({ name: 'whoami', description: 'Debug' }), function (req, res) {
  res.json({ tool: req.headers['x-mcp-tool'] || null });
});

// Not exposed.
app.get('/admin/stats', auth, function (req, res) {
  res.json({ orders: Object.keys(orders).length });
});

mountMcp(app, { name: 'shop-api' });

app.listen(Number(process.env.PORT), '127.0.0.1', function () {
  console.log('READY');
});
