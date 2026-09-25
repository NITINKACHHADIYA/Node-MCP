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
