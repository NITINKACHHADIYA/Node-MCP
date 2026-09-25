import router from '@adonisjs/core/services/router';
import { mountMcp } from 'mcp-expose/adonisjs';
import { middleware } from '#start/kernel';

const ProductsController = () => import('#controllers/products_controller');
const OrdersController = () => import('#controllers/orders_controller');

router
  .group(() => {
    router.get('products', [ProductsController, 'index']).mcp({
      name: 'search_products',
      description: 'Search products by name',
      query: { type: 'object', properties: { q: { type: 'string' } } },
    });

    router
      .group(() => {
        router.get('orders/:id', [OrdersController, 'show']).mcp({ name: 'get_order', description: 'Get an order' });
        // VineJS 3 cannot export JSON Schema, so describe the body explicitly
        // (with VineJS 4 / AdonisJS 7 you can pass the validator itself).
        router.post('orders', [OrdersController, 'store']).mcp({
          name: 'create_order',
          description: 'Create an order',
          body: {
            type: 'object',
            properties: { sku: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 10 } },
            required: ['sku', 'quantity'],
          },
        });
        router
          .delete('orders/:id', [OrdersController, 'destroy'])
          .mcp({ name: 'cancel_order', description: 'Cancel an order' });
        router.get('admin/stats', [OrdersController, 'stats']); // not exposed
      })
      .use(middleware.auth());

    router
      .get('whoami', ({ request }) => ({ tool: request.header('x-mcp-tool') ?? null }))
      .mcp({ name: 'whoami', description: 'Debug' });
  })
  .prefix('/api/v1');

mountMcp(router, { name: 'shop-api' });
