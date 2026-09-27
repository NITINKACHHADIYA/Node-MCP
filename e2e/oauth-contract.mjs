/**
 * OAuth contract, checked with the official MCP SDK client and its own OAuth
 * implementation (the code path AI apps use to sign in to MCP servers):
 *   - discovery: 401 challenge -> Protected Resource Metadata -> authorization server metadata
 *   - dynamic client registration, authorization code + PKCE, RFC 8707 resource indicator
 *     (the flow Claude, Cursor and VS Code run; the "browser" here follows the redirect itself)
 *   - scope step-up after a 403 insufficient_scope on a tool that needs more access
 *
 * The scenario app exposes get_order (JWT required by the app itself) and
 * cancel_order (tool scope `orders:write`), requires `mcp:tools` for the MCP
 * endpoint, and lists the scopes of every token it issued at GET /oauth/issued.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  extractResourceMetadataUrl,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function assert(cond, message, detail) {
  if (!cond)
    throw new Error(message + (detail === undefined ? '' : `\n      got: ${JSON.stringify(detail).slice(0, 400)}`));
}

/** An OAuth client provider whose "browser" opens the authorize URL and captures the code. */
class HeadlessBrowserProvider {
  authorizeUrls = [];
  code;
  get redirectUrl() {
    return 'http://127.0.0.1:1/callback';
  }
  get clientMetadata() {
    return {
      client_name: 'mcp-expose e2e',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation() {
    return this.client;
  }
  saveClientInformation(client) {
    this.client = client;
  }
  tokens() {
    return this.savedTokens;
  }
  saveTokens(tokens) {
    this.savedTokens = tokens;
  }
  saveCodeVerifier(verifier) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  async redirectToAuthorization(url) {
    this.authorizeUrls.push(url);
    const res = await fetch(url, { redirect: 'manual' });
    this.code = new URL(res.headers.get('location')).searchParams.get('code');
  }
}

/** Run `fn`; when the SDK stops for a user login, finish it like the redirect page would, then retry. */
async function withLogin(transport, provider, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !provider.code) throw e;
    const code = provider.code;
    provider.code = undefined;
    await transport.finishAuth(code);
    return fn();
  }
}

export async function runOAuthContract(url) {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
    }
  };
  const origin = new URL(url).origin;

  await check('401 challenge points to the resource metadata', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert(res.status === 401, 'expected 401', res.status);
    const metadataUrl = extractResourceMetadataUrl(res);
    assert(
      metadataUrl?.href === `${origin}/.well-known/oauth-protected-resource/mcp`,
      'bad resource_metadata',
      metadataUrl?.href,
    );
  });

  await check('SDK discovers the protected resource and authorization server', async () => {
    const prm = await discoverOAuthProtectedResourceMetadata(url);
    assert(prm.resource === url, 'resource must equal the MCP URL', prm);
    assert(prm.authorization_servers?.[0] === origin, 'authorization server missing', prm);
    assert(prm.scopes_supported?.includes('orders:write'), 'tool scopes should be advertised', prm);
    const asMeta = await discoverAuthorizationServerMetadata(prm.authorization_servers[0]);
    assert(asMeta?.token_endpoint, 'no token endpoint', asMeta);
  });

  await check('forged token is rejected (401 invalid_token)', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer forged.token.value' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert(
      res.status === 401 && /invalid_token/.test(res.headers.get('www-authenticate') ?? ''),
      'expected invalid_token',
      res.status,
    );
  });

  const provider = new HeadlessBrowserProvider();
  let client;
  let transport;
  await check('SDK client registers, signs the user in (code + PKCE) and lists tools', async () => {
    const connect = async () => {
      transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
      client = new Client({ name: 'mcp-expose-e2e', version: '1.0.0' });
      await client.connect(transport);
    };
    try {
      await connect();
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      await transport.finishAuth(provider.code);
      provider.code = undefined;
      await connect();
    }
    assert(provider.client?.client_id, 'client was not registered');
    const login = provider.authorizeUrls[0];
    assert(login?.searchParams.get('scope') === 'mcp:tools', 'login should ask for the challenged scope', login?.href);
    assert(login.searchParams.get('resource') === url, 'login should carry the resource indicator', login.href);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert(JSON.stringify(names) === '["cancel_order","get_order"]', 'tool set mismatch', names);
  });
  if (!client?.getServerVersion()) return results;

  await check("token is forwarded; the app's own JWT check passes", async () => {
    const r = await client.callTool({ name: 'get_order', arguments: { id: '1' } });
    assert(!r.isError && r.structuredContent?.requestedBy === 'user:alice', 'bad result', r);
  });

  await check('403 insufficient_scope makes the client ask for orders:write (step-up)', async () => {
    const r = await withLogin(transport, provider, () =>
      client.callTool({ name: 'cancel_order', arguments: { id: '1' } }),
    );
    assert(!r.isError && r.structuredContent?.status === 'cancelled', 'bad result', r);
    const issued = await (await fetch(`${origin}/oauth/issued`)).json();
    assert(issued.length === 2, 'expected exactly two logins', issued);
    assert(issued[0] === 'mcp:tools', 'first token should only have mcp:tools', issued);
    assert(issued[1].split(' ').includes('orders:write'), 'second token should have orders:write', issued);
  });

  await client.close().catch(() => {});
  return results;
}
