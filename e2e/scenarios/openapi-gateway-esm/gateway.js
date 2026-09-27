import express from 'express';
import { createFetchDispatcher, toolsFromOpenApi } from 'mcp-expose';
import { mountMcp } from 'mcp-expose/express';
import { startUpstream } from './upstream.js';
import { jwtVerifier } from 'mcp-expose/oauth';

const port = Number(process.env.PORT);
const upstreamUrl = `http://127.0.0.1:${port + 1000}`;
await startUpstream(port + 1000);

// Load the upstream's OpenAPI document over HTTP, like a real gateway would.
const spec = await fetch(`${upstreamUrl}/openapi.json`).then((r) => r.json());
const tools = toolsFromOpenApi(spec, createFetchDispatcher({ baseUrl: upstreamUrl }));

// OAuth mode: e2e/run.mjs runs every scenario a second time with MCP_OAUTH_RESOURCE set.
// `e2e-token` stays valid (the routes' own auth expects it); other tokens must be JWTs signed by the test issuer.
const oauthResource = process.env.MCP_OAUTH_RESOURCE;
const verifyJwt = oauthResource
  ? jwtVerifier({ issuer: 'https://auth.e2e.test', jwks: JSON.parse(process.env.MCP_OAUTH_JWKS) })
  : undefined;
const oauth = oauthResource
  ? {
      resource: oauthResource,
      authorizationServers: ['https://auth.e2e.test'],
      requiredScopes: ['mcp'],
      verifyToken: (token, ctx) => (token === 'e2e-token' ? { token, scopes: ['mcp'] } : verifyJwt(token, ctx)),
    }
  : undefined;

const app = express();
mountMcp(app, { name: 'shop-api', tools, oauth });
app.listen(port, '127.0.0.1', () => console.log('READY'));
