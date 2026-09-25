/**
 * Hono example (works the same on Bun, Deno and Cloudflare Workers).
 * Node run:  npm run build && npx tsx examples/hono/server.ts
 */
import { Hono } from 'hono';
import { createServer } from 'node:http';
import { z } from 'zod';
import { mcpTool, mountMcp } from 'mcp-expose/hono';

const app = new Hono();

app.post(
  '/notes',
  mcpTool({
    name: 'create_note',
    description: 'Save a note.',
    // zod (or valibot / arktype) schemas are accepted anywhere a schema is.
    body: z.object({ text: z.string().min(1).describe('Note text'), tags: z.array(z.string()).optional() }),
  }),
  async (c) => c.json({ id: crypto.randomUUID(), ...(await c.req.json()) }, 201),
);

mountMcp(app, { name: 'notes-api' });

// On Bun / Deno / Workers just `export default app`. On Node, a tiny bridge:
createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const response = await app.fetch(
    new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: body || undefined,
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(3000, () => console.log('MCP on http://localhost:3000/mcp'));
