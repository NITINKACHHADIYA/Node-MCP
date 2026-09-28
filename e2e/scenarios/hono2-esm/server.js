import { createServer } from 'node:http';
import { Hono } from 'hono';
import { mcpTool, mountMcp } from 'mcp-expose/hono';
import { jwtVerifier } from 'mcp-expose/oauth';

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
// transformResponse: enrich the response with data from another route (same credentials, same middleware).
const addProductCount = async (res, ctx) => {
  const products = await ctx.callRoute({ path: '/products', query: { q: 'key' } });
  return { ...res.json, hooked: true, productCount: products.ok ? products.json.items.length : null };
};

app.get('/whoami', mcpTool({ name: 'whoami', description: 'Debug', transformResponse: addProductCount }), (c) =>
  c.json({ tool: c.req.header('x-mcp-tool') ?? null }),
);
app.get('/admin/stats', auth, (c) => c.json({ orders: orders.size })); // not exposed

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

mountMcp(app, { name: 'shop-api', oauth });

createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const response = await app.fetch(
    new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: body || undefined }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('READY'));
