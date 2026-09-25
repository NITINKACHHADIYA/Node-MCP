/**
 * Standalone MCP gateway in front of ANY HTTP API (any language), driven by its
 * OpenAPI document.  Run:  npm run build && npx tsx examples/openapi-gateway/server.ts
 */
import express from 'express';
import { createFetchDispatcher, toolsFromOpenApi } from 'mcp-expose';
import { mountMcp } from 'mcp-expose/express';

const API_BASE_URL = process.env.API_BASE_URL ?? 'https://petstore3.swagger.io/api/v3';
const spec = await fetch(`${API_BASE_URL}/openapi.json`).then((r) => r.json());

const tools = toolsFromOpenApi(spec, createFetchDispatcher({ baseUrl: API_BASE_URL }), {
  // Expose only safe, read-only operations.
  include: ({ method }) => method === 'get',
});

const app = express();
mountMcp(app, { name: 'petstore-gateway', tools });
app.listen(3000, () => console.log(`${tools.length} tools on http://localhost:3000/mcp`));
