/**
 * Express example.  Run:  npm run build && npx tsx examples/express/server.ts
 * MCP endpoint:           http://localhost:3000/mcp
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { mcpTool, mountMcp } from 'mcp-expose/express';

const app = express();
app.use(express.json());
// Internal tool calls come from loopback; trust it so req.ip is the real agent IP
// (keeps per-IP rate limiting accurate).
app.set('trust proxy', 'loopback');

// Your existing auth middleware: unchanged.
function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization !== 'Bearer dev-token') return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const products = [
  { id: '1', name: 'Keyboard', price: 49 },
  { id: '2', name: 'Mouse', price: 19 },
];

app.get(
  '/products',
  mcpTool({
    name: 'search_products',
    description: 'Search the product catalog by name. Returns id, name and price.',
    query: { type: 'object', properties: { q: { type: 'string', description: 'Text to search for' } } },
  }),
  (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase();
    res.json({ items: products.filter((p) => p.name.toLowerCase().includes(q)) });
  },
);

app.post(
  '/orders',
  mcpTool({
    name: 'create_order',
    description: 'Place an order for a product. Requires authentication.',
    body: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
      },
      required: ['productId', 'quantity'],
    },
  }),
  requireApiKey,
  (req, res) => {
    const { productId, quantity } = req.body;
    if (!products.some((p) => p.id === productId)) return res.status(404).json({ error: 'Unknown product' });
    res.status(201).json({ orderId: 'ord_123', productId, quantity });
  },
);

// Not marked -> never visible to agents.
app.delete('/admin/cache', requireApiKey, (_req, res) => res.sendStatus(204));

mountMcp(app, {
  name: 'shop-api',
  version: '1.0.0',
  instructions: 'Use search_products before create_order to find valid product ids.',
});

app.listen(3000, () => console.log('API on http://localhost:3000, MCP on http://localhost:3000/mcp'));
