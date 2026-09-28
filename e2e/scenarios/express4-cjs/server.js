// Plain JavaScript + CommonJS: the most common legacy Express setup.
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { mcpTool, mountMcp } = require('mcp-expose/express');
const { jwtVerifier } = require('mcp-expose/oauth');

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json());

const products = [
  { id: '1', name: 'Keyboard', sku: 'KB-01' },
  { id: '2', name: 'Mouse', sku: 'MS-01' },
];
const orders = new Map([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);

// Rate-limit authenticated routes (also for agent traffic, which arrives through the same routes).
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 1000, standardHeaders: true, legacyHeaders: false });

const auth = (req, res, next) =>
  req.headers.authorization === 'Bearer e2e-token' ? next() : res.status(401).json({ error: 'Unauthorized' });
const searchLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });

const api = express.Router();

api.get(
  '/products',
  mcpTool({
    name: 'search_products',
    description: 'Search products by name',
    query: { type: 'object', properties: { q: { type: 'string' } } },
  }),
  searchLimiter,
  (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    res.json({ items: products.filter((p) => p.name.toLowerCase().includes(q)) });
  },
);

api.get('/orders/:id', mcpTool({ name: 'get_order', description: 'Get an order' }), apiLimiter, auth, (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

api.post(
  '/orders',
  mcpTool({
    name: 'create_order',
    description: 'Create an order',
    body: {
      type: 'object',
      properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['sku', 'quantity'],
    },
  }),
  apiLimiter,
  auth,
  (req, res) => {
    const { sku, quantity } = req.body;
    if (typeof sku !== 'string' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return res.status(400).json({ error: 'quantity must be an integer between 1 and 10' });
    }
    const order = { id: String(orders.size + 1), sku, quantity, status: 'pending' };
    orders.set(order.id, order);
    res.status(201).json(order);
  },
);

api.delete(
  '/orders/:id',
  mcpTool({ name: 'cancel_order', description: 'Cancel an order' }),
  apiLimiter,
  auth,
  (req, res) => {
    res.json({ id: req.params.id, status: 'cancelled' });
  },
);

// transformResponse: enrich the response with data from another route (same credentials, same middleware).
const addProductCount = async (res, ctx) => {
  const products = await ctx.callRoute({ path: '/api/products', query: { q: 'key' } });
  return { ...res.json, hooked: true, productCount: products.ok ? products.json.items.length : null };
};

api.get(
  '/whoami',
  mcpTool({ name: 'whoami', description: 'Debug', transformResponse: addProductCount }),
  (req, res) => {
    res.json({ tool: req.headers['x-mcp-tool'] || null, ip: req.ip });
  },
);

api.get('/admin/stats', apiLimiter, auth, (req, res) => res.json({ orders: orders.size })); // not exposed

// OAuth mode: e2e/run.mjs runs every scenario a second time with MCP_OAUTH_RESOURCE set.
// `e2e-token` stays valid (the routes' own auth expects it); other tokens must be JWTs signed by the test issuer.
const oauthResource = process.env.MCP_OAUTH_RESOURCE;
const verifyJwt = oauthResource
  ? jwtVerifier({ issuer: 'https://auth.e2e.test', jwks: JSON.parse(process.env.MCP_OAUTH_JWKS) })
  : undefined;
const oauth = oauthResource
  ? {
      resource: oauthResource,
      authorizationServers: ['https://auth.e2e.test'],
      requiredScopes: ['mcp'],
      verifyToken: (token, ctx) => (token === 'e2e-token' ? { token, scopes: ['mcp'] } : verifyJwt(token, ctx)),
    }
  : undefined;

app.use('/api', api);
mountMcp(app, { name: 'shop-api', oauth });

app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('READY'));
