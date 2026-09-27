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
import { generateKeyPair, SignJWT } from 'jose';

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

/**
 * Extra checks for a regular scenario started in OAuth mode (`oauth` option with a
 * jwtVerifier for issuer https://auth.e2e.test). Tokens are signed with `signer`.
 */
export async function runOAuthModeChecks(url, signer) {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name: `oauth: ${name}`, ok: true });
    } catch (e) {
      results.push({ name: `oauth: ${name}`, ok: false, error: e.message });
    }
  };
  const { origin, pathname } = new URL(url);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource${pathname}`;
  const jwt = (claims = {}, { aud = url, iss = signer.issuer, exp = '5m', key = signer.privateKey } = {}) =>
    new SignJWT({ scope: 'mcp', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: signer.kid })
      .setIssuer(iss)
      .setAudience(aud)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key);
  const post = (headers = {}, target = url) =>
    fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  const challenge = (res) => res.headers.get('www-authenticate') ?? '';

  await check('metadata served on both well-known paths (public, CORS)', async () => {
    for (const path of [metadataUrl, `${origin}/.well-known/oauth-protected-resource`]) {
      const res = await fetch(path);
      assert(res.status === 200, `GET ${path}`, res.status);
      assert(res.headers.get('access-control-allow-origin') === '*', 'missing CORS header');
      const body = await res.json();
      assert(body.resource === url && body.authorization_servers?.[0] === signer.issuer, 'bad metadata', body);
      assert(JSON.stringify(body.scopes_supported) === '["mcp"]', 'bad scopes_supported', body);
      const pre = await fetch(path, { method: 'OPTIONS' });
      assert(pre.status === 204 || pre.status === 200, `OPTIONS ${path}`, pre.status);
    }
  });

  await check('SDK discovers the metadata', async () => {
    const prm = await discoverOAuthProtectedResourceMetadata(url);
    assert(prm.resource === url, 'resource mismatch', prm);
  });

  await check('no token: 401 challenge (POST and GET)', async () => {
    const res = await post();
    assert(res.status === 401, 'expected 401', res.status);
    assert(extractResourceMetadataUrl(res)?.href === metadataUrl, 'bad resource_metadata', challenge(res));
    assert(challenge(res).includes('scope="mcp"'), 'challenge should name the required scope', challenge(res));
    const get = await fetch(url);
    assert(get.status === 401, 'GET should be challenged too', get.status);
  });

  await check('rejects forged, foreign, expired and misplaced tokens', async () => {
    const other = await generateKeyPair('RS256');
    const cases = {
      'wrong audience (token passthrough)': await jwt({}, { aud: 'https://other-api.example.com/mcp' }),
      'wrong issuer': await jwt({}, { iss: 'https://evil.example' }),
      'unknown signing key': await jwt({}, { key: other.privateKey }),
      expired: await jwt({}, { exp: Math.floor(Date.now() / 1000) - 120 }),
      garbage: 'not-a-jwt',
    };
    for (const [label, token] of Object.entries(cases)) {
      const res = await post({ authorization: `Bearer ${token}` });
      assert(res.status === 401 && challenge(res).includes('invalid_token'), `${label}: expected 401 invalid_token`, [
        res.status,
        challenge(res),
      ]);
    }
    const query = await post({}, `${url}?access_token=${await jwt()}`);
    assert(query.status === 401, 'tokens in the query string must be ignored', query.status);
  });

  await check('valid token without the required scope: 403 insufficient_scope', async () => {
    const res = await post({ authorization: `Bearer ${await jwt({ scope: 'profile' })}` });
    assert(res.status === 403 && challenge(res).includes('insufficient_scope'), 'expected 403', [
      res.status,
      challenge(res),
    ]);
  });

  await check('valid JWT: SDK client works and the token is forwarded to routes', async () => {
    const client = new Client({ name: 'mcp-expose-e2e', version: '1.0.0' });
    const token = await jwt();
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      assert(tools.length === 5, 'expected 5 tools', tools);
      // whoami is public and not rate-limited (the contract already used up search_products' limit).
      const pub = await client.callTool({ name: 'whoami', arguments: {} });
      assert(!pub.isError && pub.structuredContent?.tool === 'whoami', 'public tool failed', pub);
      // The route's own auth only knows `e2e-token`, so it must see (and reject) the JWT: proof it was forwarded.
      const guarded = await client.callTool({ name: 'get_order', arguments: { id: '1' } });
      const text = guarded.content?.map((c) => c.text).join('') ?? '';
      assert(guarded.isError && text.includes('401'), 'route should have received the JWT', guarded);
    } finally {
      await client.close().catch(() => {});
    }
  });
  return results;
}
