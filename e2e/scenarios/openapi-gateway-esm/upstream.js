// A framework-less upstream API (stands in for a Go/Java/Python service).
import { createServer } from 'node:http';

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
const orders = new Map([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);

export const openapi = {
  openapi: '3.0.3',
  info: { title: 'Shop', version: '1.0.0' },
  paths: {
    '/products': {
      get: {
        operationId: 'search_products',
        summary: 'Search products',
        'x-mcp': true,
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
      },
    },
    '/orders': {
      post: {
        operationId: 'create_order',
        summary: 'Create an order',
        'x-mcp': true,
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } },
                required: ['sku', 'quantity'],
              },
            },
          },
        },
      },
    },
    '/orders/{id}': {
      get: {
        operationId: 'get_order',
        summary: 'Get an order',
        'x-mcp': true,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
      delete: {
        operationId: 'cancel_order',
        summary: 'Cancel an order',
        'x-mcp': true,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
    '/whoami': { get: { operationId: 'whoami', summary: 'Debug', 'x-mcp': true } },
    '/admin/stats': { get: { operationId: 'admin_stats', summary: 'Not exposed' } },
  },
};

export function startUpstream(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const authed = req.headers.authorization === 'Bearer e2e-token';
    const orderMatch = url.pathname.match(/^\/orders\/([^/]+)$/);

    if (url.pathname === '/openapi.json') return send(200, openapi);
    if (url.pathname === '/products' && req.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return send(200, { items: products.filter((p) => p.name.toLowerCase().includes(q)) });
    }
    if (url.pathname === '/whoami') return send(200, { tool: req.headers['x-mcp-tool'] ?? null });
    if (!authed) return send(401, { error: 'Unauthorized' });
    if (url.pathname === '/orders' && req.method === 'POST') {
      const { sku, quantity } = JSON.parse(body || '{}');
      if (typeof sku !== 'string' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10)
        return send(400, { error: 'invalid order' });
      const order = { id: String(orders.size + 1), sku, quantity, status: 'pending' };
      orders.set(order.id, order);
      return send(201, order);
    }
    if (orderMatch && req.method === 'GET') return send(200, orders.get(orderMatch[1]) ?? { error: 'not found' });
    if (orderMatch && req.method === 'DELETE') return send(200, { id: orderMatch[1], status: 'cancelled' });
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
