// Koa 1: generator middleware, koa-router 5, koa-bodyparser 2.
const koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const { koaMcpLegacy, mcpToolLegacy } = require('mcp-expose/koa');
const { jwtVerifier } = require('mcp-expose/oauth');

const app = koa();
const router = new Router({ prefix: '/v1' });

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
const orders = { 1: { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' } };

function* auth(next) {
  if (this.get('authorization') !== 'Bearer e2e-token') {
    this.status = 401;
    this.body = { error: 'Unauthorized' };
    return;
  }
  yield next;
}

router.get(
  '/products',
  mcpToolLegacy({
    name: 'search_products',
    description: 'Search products',
    query: { type: 'object', properties: { q: { type: 'string' } } },
  }),
  function* () {
    const q = String(this.query.q || '').toLowerCase();
    this.body = { items: products.filter((p) => p.name.toLowerCase().includes(q)) };
  },
);

router.get('/orders/:id', mcpToolLegacy({ name: 'get_order', description: 'Get an order' }), auth, function* () {
  this.body = orders[this.params.id] || { error: 'not found' };
});

router.post(
  '/orders',
  mcpToolLegacy({
    name: 'create_order',
    description: 'Create an order',
    body: {
      type: 'object',
      properties: { sku: { type: 'string' }, quantity: { type: 'integer' } },
      required: ['sku', 'quantity'],
    },
  }),
  auth,
  function* () {
    const body = this.request.body || {};
    if (typeof body.sku !== 'string' || !Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 10) {
      this.status = 400;
      this.body = { error: 'quantity must be 1-10' };
      return;
    }
    const order = {
      id: String(Object.keys(orders).length + 1),
      sku: body.sku,
      quantity: body.quantity,
      status: 'pending',
    };
    orders[order.id] = order;
    this.status = 201;
    this.body = order;
  },
);

router.del('/orders/:id', mcpToolLegacy({ name: 'cancel_order', description: 'Cancel an order' }), auth, function* () {
  this.body = { id: this.params.id, status: 'cancelled' };
});

// transformResponse: enrich the response with data from another route (same credentials, same middleware).
const addProductCount = async (res, ctx) => {
  const products = await ctx.callRoute({ path: '/v1/products', query: { q: 'key' } });
  return { ...res.json, hooked: true, productCount: products.ok ? products.json.items.length : null };
};

router.get(
  '/whoami',
  mcpToolLegacy({ name: 'whoami', description: 'Debug', transformResponse: addProductCount }),
  function* () {
    this.body = { tool: this.get('x-mcp-tool') || null };
  },
);

// Not exposed.
router.get('/admin/stats', auth, function* () {
  this.body = { orders: Object.keys(orders).length };
});

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

app.use(bodyParser());
app.use(koaMcpLegacy({ name: 'shop-api', routers: [router], oauth }));
app.use(router.routes());

app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('READY'));
