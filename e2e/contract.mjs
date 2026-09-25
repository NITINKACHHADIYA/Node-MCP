/**
 * The behavioural contract every e2e scenario must satisfy, checked with the
 * official MCP TypeScript SDK client (the same client many AI apps embed).
 *
 * Every scenario app implements the same small "shop" API:
 *   search_products  GET     public      ?q=
 *   get_order        GET     auth        /orders/:id
 *   create_order     POST    auth        { sku: string, quantity: int 1..10 }  (app validates -> 400)
 *   cancel_order     DELETE  auth        /orders/:id
 *   whoami           GET     public      echoes the X-Mcp-Tool header
 *   (plus at least one route that is NOT exposed)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const TOKEN = 'Bearer e2e-token';
const EXPECTED_TOOLS = ['cancel_order', 'create_order', 'get_order', 'search_products', 'whoami'];

async function connect(url, headers = {}) {
  const client = new Client({ name: 'mcp-expose-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  return client;
}

function assert(cond, message, detail) {
  if (!cond) {
    const err = new Error(
      message + (detail === undefined ? '' : `\n      got: ${JSON.stringify(detail).slice(0, 400)}`),
    );
    throw err;
  }
}

const text = (r) => r.content?.map((c) => c.text).join('\n') ?? '';

/**
 * Runs all checks. Returns [{ name, ok, error? }]. Never throws.
 * @param {string} url MCP endpoint
 * @param {{ serverName?: string, rateLimit?: { tool: string, max: number } }} opts
 */
export async function runContract(url, opts = {}) {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
    }
  };

  let authed;
  let anon;
  await check('connect + initialize (official SDK client)', async () => {
    authed = await connect(url, { authorization: TOKEN });
    anon = await connect(url);
    const info = authed.getServerVersion();
    assert(info?.name === (opts.serverName ?? 'shop-api'), 'unexpected serverInfo', info);
    assert(authed.getServerCapabilities()?.tools, 'server does not advertise tools capability');
  });
  if (!authed) return results;

  let tools = [];
  await check('tools/list exposes exactly the marked routes', async () => {
    tools = (await authed.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    assert(JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), 'tool set mismatch', names);
  });
  const tool = (n) => tools.find((t) => t.name === n);

  await check('input schemas describe path params and body', async () => {
    assert(tool('get_order')?.inputSchema.required?.includes('id'), 'get_order must require id', tool('get_order'));
    const c = tool('create_order')?.inputSchema;
    assert(c?.properties?.sku && c?.properties?.quantity, 'create_order must have sku + quantity', c);
    assert(
      ['sku', 'quantity'].every((k) => c.required?.includes(k)),
      'sku + quantity must be required',
      c,
    );
  });

  await check('annotations derived from HTTP method', async () => {
    assert(
      tool('get_order')?.annotations?.readOnlyHint === true,
      'GET should be readOnly',
      tool('get_order')?.annotations,
    );
    assert(
      tool('cancel_order')?.annotations?.destructiveHint === true,
      'DELETE should be destructive',
      tool('cancel_order')?.annotations,
    );
  });

  await check('public tool call returns structured JSON', async () => {
    const r = await authed.callTool({ name: 'search_products', arguments: { q: 'key' } });
    assert(!r.isError, 'unexpected error', r);
    assert(Array.isArray(r.structuredContent?.items) && r.structuredContent.items.length > 0, 'expected items', r);
  });

  await check("app's auth rejects calls without credentials (401)", async () => {
    const r = await anon.callTool({ name: 'get_order', arguments: { id: '1' } });
    assert(r.isError === true && text(r).includes('401'), 'expected 401 tool error', r);
  });

  await check('Authorization header is forwarded to the route', async () => {
    const r = await authed.callTool({ name: 'get_order', arguments: { id: '1' } });
    assert(!r.isError && String(r.structuredContent?.id) === '1', 'expected order 1', r);
  });

  await check("app's validation errors reach the agent (400)", async () => {
    const r = await authed.callTool({ name: 'create_order', arguments: { sku: 'KB-01', quantity: 50 } });
    assert(r.isError === true && text(r).includes('400'), 'expected 400 tool error', r);
  });

  await check('POST body is built from arguments', async () => {
    const r = await authed.callTool({ name: 'create_order', arguments: { sku: 'KB-01', quantity: 2 } });
    assert(
      !r.isError && r.structuredContent?.sku === 'KB-01' && Number(r.structuredContent?.quantity) === 2,
      'bad create result',
      r,
    );
  });

  await check('DELETE with path param', async () => {
    const r = await authed.callTool({ name: 'cancel_order', arguments: { id: '1' } });
    assert(!r.isError && r.structuredContent?.status === 'cancelled', 'bad cancel result', r);
  });

  await check('X-Mcp-Tool header identifies agent traffic', async () => {
    const r = await authed.callTool({ name: 'whoami', arguments: {} });
    assert(r.structuredContent?.tool === 'whoami', 'header not seen by app', r);
  });

  await check('unknown tool is a JSON-RPC error', async () => {
    let threw = false;
    try {
      await authed.callTool({ name: 'does_not_exist', arguments: {} });
    } catch {
      threw = true;
    }
    assert(threw, 'expected an error');
  });

  await check('foreign browser Origin is rejected (403)', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert(res.status === 403, 'expected 403', res.status);
  });

  if (opts.rateLimit) {
    await check(`app's rate limiter applies to tool calls (429 after ${opts.rateLimit.max})`, async () => {
      let last;
      for (let i = 0; i <= opts.rateLimit.max; i++) {
        last = await authed.callTool({ name: opts.rateLimit.tool, arguments: { q: 'x' } });
      }
      assert(last.isError === true && text(last).includes('429'), 'expected 429 on the last call', last);
    });
  }

  await authed.close().catch(() => {});
  await anon?.close().catch(() => {});
  return results;
}
