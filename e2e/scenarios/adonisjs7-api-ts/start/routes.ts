import router from '@adonisjs/core/services/router';
import { mountMcp } from 'mcp-expose/adonisjs';
import { middleware } from '#start/kernel';
import { createOrderValidator } from '#validators/order';
import { jwtVerifier, type VerifyTokenContext } from 'mcp-expose/oauth';
import type { ResponseTransform } from 'mcp-expose';

const ProductsController = () => import('#controllers/products_controller');
const OrdersController = () => import('#controllers/orders_controller');

// transformResponse: enrich the response with data from another route (same credentials, same middleware).
const addProductCount: ResponseTransform = async (res, ctx) => {
  const products = await ctx.callRoute({ path: '/api/v1/products', query: { q: 'key' } });
  return {
    ...(res.json as object),
    hooked: true,
    productCount: products.ok ? (products.json as { items: unknown[] }).items.length : null,
  };
};

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
      .mcp({ name: 'whoami', description: 'Debug', transformResponse: addProductCount });
  })
  .prefix('/api/v1');

// OAuth mode: e2e/run.mjs runs every scenario a second time with MCP_OAUTH_RESOURCE set.
// `e2e-token` stays valid (the routes' own auth expects it); other tokens must be JWTs signed by the test issuer.
const oauthResource = process.env.MCP_OAUTH_RESOURCE;
const verifyJwt = oauthResource
  ? jwtVerifier({ issuer: 'https://auth.e2e.test', jwks: JSON.parse(process.env.MCP_OAUTH_JWKS!) })
  : undefined;
const oauth = oauthResource
  ? {
      resource: oauthResource,
      authorizationServers: ['https://auth.e2e.test'],
      requiredScopes: ['mcp'],
      verifyToken: (token: string, ctx: VerifyTokenContext) =>
        token === 'e2e-token' ? { token, scopes: ['mcp'] } : verifyJwt!(token, ctx),
    }
  : undefined;

mountMcp(router, { name: 'shop-api', oauth });
