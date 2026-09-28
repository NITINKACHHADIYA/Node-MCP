const Koa = require('koa');
const Router = require('@koa/router');
const bodyParser = require('koa-bodyparser');
const { koaMcp, mcpTool } = require('mcp-expose/koa');
const { jwtVerifier } = require('mcp-expose/oauth');

const app = new Koa();
const router = new Router({ prefix: '/v1' });

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
const orders = new Map([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);

async function auth(ctx, next) {
  if (ctx.get('authorization') !== 'Bearer e2e-token') {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }
  await next();
}

router.get(
  '/products',
  mcpTool({
    name: 'search_products',
    description: 'Search products',
    query: { type: 'object', properties: { q: { type: 'string' } } },
  }),
  (ctx) => {
    const q = String(ctx.query.q || '').toLowerCase();
    ctx.body = { items: products.filter((p) => p.name.toLowerCase().includes(q)) };
  },
);

router.get('/orders/:id', mcpTool({ name: 'get_order', description: 'Get an order' }), auth, (ctx) => {
  ctx.body = orders.get(ctx.params.id) || { error: 'not found' };
});

router.post(
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
  (ctx) => {
    const { sku, quantity } = ctx.request.body || {};
    if (typeof sku !== 'string' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      ctx.status = 400;
      ctx.body = { error: 'quantity must be 1-10' };
      return;
    }
    const order = { id: String(orders.size + 1), sku, quantity, status: 'pending' };
    orders.set(order.id, order);
    ctx.status = 201;
    ctx.body = order;
  },
);

router.delete('/orders/:id', mcpTool({ name: 'cancel_order', description: 'Cancel an order' }), auth, (ctx) => {
  ctx.body = { id: ctx.params.id, status: 'cancelled' };
});

// transformResponse: enrich the response with data from another route (same credentials, same middleware).
const addProductCount = async (res, ctx) => {
  const products = await ctx.callRoute({ path: '/v1/products', query: { q: 'key' } });
  return { ...res.json, hooked: true, productCount: products.ok ? products.json.items.length : null };
};

router.get('/whoami', mcpTool({ name: 'whoami', description: 'Debug', transformResponse: addProductCount }), (ctx) => {
  ctx.body = { tool: ctx.get('x-mcp-tool') || null };
});

router.get('/admin/stats', auth, (ctx) => {
  ctx.body = { orders: orders.size };
}); // not exposed

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
app.use(koaMcp({ name: 'shop-api', routers: [router], oauth }));
app.use(router.routes()).use(router.allowedMethods());

app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('READY'));
