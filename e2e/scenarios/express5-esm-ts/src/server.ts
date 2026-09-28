import express, { type NextFunction, type Request, type Response } from 'express';
import type { ResponseTransform } from 'mcp-expose';
import { mcpTool, mountMcp } from 'mcp-expose/express';
import { z } from 'zod';
import { jwtVerifier, type VerifyTokenContext } from 'mcp-expose/oauth';

const app = express();
app.use(express.json());

const products = [{ id: '1', name: 'Keyboard', sku: 'KB-01' }];
const orders = new Map([['1', { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' }]]);

const CreateOrder = z.object({ sku: z.string(), quantity: z.number().int().min(1).max(10) });

function auth(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization !== 'Bearer e2e-token') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

const shop = express.Router();

shop.get(
  '/products',
  mcpTool({ name: 'search_products', description: 'Search products', query: z.object({ q: z.string().optional() }) }),
  (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase();
    res.json({ items: products.filter((p) => p.name.toLowerCase().includes(q)) });
  },
);

shop.get('/orders/:id', mcpTool({ name: 'get_order', description: 'Get an order' }), auth, (req, res) => {
  const order = orders.get(req.params.id as string);
  if (!order) return void res.status(404).json({ error: 'Not found' });
  res.json(order);
});

shop.post(
  '/orders',
  mcpTool({ name: 'create_order', description: 'Create an order', body: CreateOrder }),
  auth,
  (req, res) => {
    const parsed = CreateOrder.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues });
    const order = { id: String(orders.size + 1), ...parsed.data, status: 'pending' };
    orders.set(order.id, order);
    res.status(201).json(order);
  },
);

shop.delete('/orders/:id', mcpTool({ name: 'cancel_order', description: 'Cancel an order' }), auth, (req, res) => {
  res.json({ id: req.params.id, status: 'cancelled' });
});

// transformResponse: enrich the response with data from another route (same credentials, same middleware).
const addProductCount: ResponseTransform = async (res, ctx) => {
  const products = await ctx.callRoute({ path: '/shop/products', query: { q: 'key' } });
  return { ...(res.json as object), hooked: true, productCount: (products.json as { items: unknown[] }).items.length };
};

shop.get(
  '/whoami',
  mcpTool({ name: 'whoami', description: 'Debug', transformResponse: addProductCount }),
  (req, res) => {
    res.json({ tool: req.headers['x-mcp-tool'] ?? null });
  },
);

shop.get('/internal/metrics', (_req, res) => res.json({ ok: true })); // not exposed

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

app.use('/shop', shop);
mountMcp(app, { name: 'shop-api', routers: { '/shop': shop }, oauth });

app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('READY'));
