import router from '@adonisjs/core/services/router';
import { mountMcp } from 'mcp-expose/adonisjs';
import { middleware } from '#start/kernel';
import { createOrderValidator } from '#validators/order';

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
        // The VineJS validator doubles as the tool's input schema.
        router
          .post('orders', [OrdersController, 'store'])
          .mcp({ name: 'create_order', description: 'Create an order', body: createOrderValidator });
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
