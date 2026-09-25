import express from 'express';
import { createFetchDispatcher, toolsFromOpenApi } from 'mcp-expose';
import { mountMcp } from 'mcp-expose/express';
import { startUpstream } from './upstream.js';

const port = Number(process.env.PORT);
const upstreamUrl = `http://127.0.0.1:${port + 1000}`;
await startUpstream(port + 1000);

// Load the upstream's OpenAPI document over HTTP, like a real gateway would.
const spec = await fetch(`${upstreamUrl}/openapi.json`).then((r) => r.json());
const tools = toolsFromOpenApi(spec, createFetchDispatcher({ baseUrl: upstreamUrl }));

const app = express();
mountMcp(app, { name: 'shop-api', tools });
app.listen(port, '127.0.0.1', () => console.log('READY'));
