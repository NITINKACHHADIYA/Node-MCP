const Koa = require('koa');
const Router = require('@koa/router');
const bodyParser = require('koa-bodyparser');
const { koaMcp, mcpTool } = require('mcp-expose/koa');

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

router.get('/products', mcpTool({ name: 'search_products', description: 'Search products', query: { type: 'object', properties: { q: { type: 'string' } } } }), (ctx) => {
  const q = String(ctx.query.q || '').toLowerCase();
  ctx.body = { items: products.filter((p) => p.name.toLowerCase().includes(q)) };
});

router.get('/orders/:id', mcpTool({ name: 'get_order', description: 'Get an order' }), auth, (ctx) => {
  ctx.body = orders.get(ctx.params.id) || { error: 'not found' };
});

router.post('/orders',
  mcpTool({
    name: 'create_order',
    description: 'Create an order',
    body: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer' } }, required: ['sku', 'quantity'] },
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
  });

router.delete('/orders/:id', mcpTool({ name: 'cancel_order', description: 'Cancel an order' }), auth, (ctx) => {
  ctx.body = { id: ctx.params.id, status: 'cancelled' };
});

router.get('/whoami', mcpTool({ name: 'whoami', description: 'Debug' }), (ctx) => {
  ctx.body = { tool: ctx.get('x-mcp-tool') || null };
});

router.get('/admin/stats', auth, (ctx) => { ctx.body = { orders: orders.size }; }); // not exposed

app.use(bodyParser());
app.use(koaMcp({ name: 'shop-api', routers: [router] }));
app.use(router.routes()).use(router.allowedMethods());

app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('READY'));
