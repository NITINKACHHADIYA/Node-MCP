import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { expect } from 'vitest';

export const TOKEN = 'Bearer secret';

export function baseUrlOf(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let nextId = 1;

/** Tiny MCP client: POST one JSON-RPC request to `url`. */
export async function rpc(url: string, method: string, params: object = {}, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

export const callTool = (url: string, name: string, args: object, headers?: Record<string, string>) =>
  rpc(url, 'tools/call', { name, arguments: args }, headers).then((r) => r.body.result);

/**
 * The same behavioural contract every adapter must satisfy, against an app with:
 *   GET  /users/:id  (auth required, exposed as `getUserTool`)
 *   POST /users      (auth required, validates `name`, exposed as `createUserTool`)
 *   GET  /health     (NOT exposed)
 */
export async function assertAdapterContract(mcpUrl: string, names: { get: string; create: string }) {
  const init = await rpc(mcpUrl, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  expect(init.status).toBe(200);
  expect(init.body.result.protocolVersion).toBe('2025-06-18');
  expect(init.body.result.capabilities.tools).toBeDefined();

  const note = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  expect(note.status).toBe(202);

  const list = await rpc(mcpUrl, 'tools/list');
  const tools = list.body.result.tools as { name: string; inputSchema: any; annotations?: any }[];
  expect(tools.map((t) => t.name).sort()).toEqual([names.create, names.get].sort());
  const getTool = tools.find((t) => t.name === names.get)!;
  expect(getTool.inputSchema.required).toContain('id');
  expect(getTool.annotations.readOnlyHint).toBe(true);
  const createTool = tools.find((t) => t.name === names.create)!;
  expect(createTool.inputSchema.properties.name).toBeDefined();

  // Auth is enforced by the app's own middleware/guard.
  const denied = await callTool(mcpUrl, names.get, { id: '7' });
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toContain('401');

  // ... and the MCP client's Authorization header is forwarded.
  const user = await callTool(mcpUrl, names.get, { id: '7' }, { authorization: TOKEN });
  expect(user.isError).toBeFalsy();
  expect(user.structuredContent).toMatchObject({ id: '7', name: 'User 7' });

  const created = await callTool(mcpUrl, names.create, { name: 'Ada' }, { authorization: TOKEN });
  expect(created.isError).toBeFalsy();
  expect(created.structuredContent).toMatchObject({ id: 'new', name: 'Ada' });

  // The app's own validation errors are returned to the agent.
  const invalid = await callTool(mcpUrl, names.create, { name: 42 }, { authorization: TOKEN });
  expect(invalid.isError).toBe(true);
  expect(invalid.content[0].text).toContain('400');

  const unknown = await rpc(mcpUrl, 'tools/call', { name: 'nope', arguments: {} });
  expect(unknown.body.error.code).toBe(-32602);

  // DNS-rebinding protection.
  const evil = await rpc(mcpUrl, 'tools/list', {}, { origin: 'https://evil.example' });
  expect(evil.status).toBe(403);
}

/** OAuth options used by the adapter tests: `Bearer secret` is valid, `Bearer noscope` lacks the `mcp` scope. */
export const OAUTH = {
  resource: 'https://mcp.example.com/mcp',
  authorizationServers: ['https://auth.example.com'],
  requiredScopes: ['mcp'],
  resourceName: 'Test API',
  verifyToken: (token: string) =>
    token === 'secret'
      ? { token, scopes: ['mcp'], subject: 'user-1' }
      : token === 'noscope'
        ? { token, scopes: [] }
        : undefined,
};

/**
 * OAuth behaviour every adapter must provide (MCP authorization spec):
 * public metadata on the well-known paths, 401/403 challenges on the MCP endpoint,
 * and a working tool call (with the token forwarded to the route) once authorized.
 */
export async function assertOAuthContract(base: string, getTool = 'get_user', mcpPath = '/mcp') {
  const metadataUrl = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const res = await fetch(base + path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toMatchObject({
      resource: OAUTH.resource,
      authorization_servers: OAUTH.authorizationServers,
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_name: 'Test API',
    });
    const preflight = await fetch(base + path, { method: 'OPTIONS' });
    expect(preflight.status, `OPTIONS ${path}`).toBe(204);
  }

  const mcpUrl = base + mcpPath;
  const anon = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(anon.status).toBe(401);
  expect(anon.headers.get('www-authenticate')).toBe(`Bearer scope="mcp", resource_metadata="${metadataUrl}"`);

  const bad = await rpc(mcpUrl, 'tools/list', {}, { authorization: 'Bearer forged' });
  expect(bad.status).toBe(401);
  expect(bad.body.error).toBe('invalid_token');

  const noScope = await fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer noscope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(noScope.status).toBe(403);
  expect(noScope.headers.get('www-authenticate')).toContain('error="insufficient_scope"');

  const list = await rpc(mcpUrl, 'tools/list', {}, { authorization: TOKEN });
  expect(list.status).toBe(200);
  expect(list.body.result.tools.map((t: { name: string }) => t.name)).toContain(getTool);

  // The verified token is forwarded, so the route's own auth still applies.
  const user = await callTool(mcpUrl, getTool, { id: '7' }, { authorization: TOKEN });
  expect(user.isError).toBeFalsy();
  expect(user.structuredContent).toMatchObject({ id: '7', name: 'User 7' });
}
