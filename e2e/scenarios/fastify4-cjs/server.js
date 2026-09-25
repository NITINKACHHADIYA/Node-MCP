const Fastify = require('fastify');
const { fastifyMcp } = require('mcp-expose/fastify');

async function main() {
  const app = Fastify();
  await app.register(fastifyMcp, { name: 'shop-api' });

  const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
  const orders = new Map([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);
  const auth = async (req, reply) => {
    if (req.headers.authorization !== 'Bearer e2e-token') return reply.code(401).send({ error: 'Unauthorized' });
  };
  const idParams = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

  app.get('/products', {
    schema: { querystring: { type: 'object', properties: { q: { type: 'string' } } } },
    config: { mcp: { name: 'search_products', description: 'Search products' } },
  }, async (req) => ({ items: products.filter((p) => p.name.toLowerCase().includes((req.query.q || '').toLowerCase())) }));

  app.get('/orders/:id', {
    schema: { params: idParams },
    preHandler: auth,
    config: { mcp: { name: 'get_order', description: 'Get an order' } },
  }, async (req, reply) => orders.get(req.params.id) || reply.code(404).send({ error: 'Not found' }));

  app.post('/orders', {
    schema: {
      body: {
        type: 'object',
        properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['sku', 'quantity'],
      },
    },
    preHandler: auth,
    config: { mcp: { name: 'create_order', description: 'Create an order' } },
  }, async (req, reply) => {
    const order = { id: String(orders.size + 1), ...req.body, status: 'pending' };
    orders.set(order.id, order);
    return reply.code(201).send(order);
  });

  app.delete('/orders/:id', {
    schema: { params: idParams },
    preHandler: auth,
    config: { mcp: { name: 'cancel_order', description: 'Cancel an order' } },
  }, async (req) => ({ id: req.params.id, status: 'cancelled' }));

  app.get('/whoami', { config: { mcp: { name: 'whoami', description: 'Debug' } } }, async (req) => ({ tool: req.headers['x-mcp-tool'] || null }));

  app.get('/admin/stats', { preHandler: auth }, async () => ({ orders: orders.size })); // not exposed

  await app.listen({ port: Number(process.env.PORT), host: '127.0.0.1' });
  console.log('READY');
}
main();
