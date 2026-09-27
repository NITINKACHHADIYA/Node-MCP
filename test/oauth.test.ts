import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearerToken } from '../src/core/oauth.js';
import {
  bearerChallenge,
  defineTool,
  McpServer,
  protectedResourceMetadataPaths,
  type OAuthOptions,
} from '../src/index.js';
import { introspectionVerifier, jwtVerifier } from '../src/oauth/index.js';
import { baseUrlOf } from './helpers.js';

const RESOURCE = 'https://api.example.com/mcp';
const ISSUER = 'https://auth.example.com';

function oauth(overrides: Partial<OAuthOptions> = {}): OAuthOptions {
  return {
    resource: RESOURCE,
    authorizationServers: [ISSUER],
    verifyToken: (token) => {
      if (token === 'reader') return { token, scopes: ['orders:read'], subject: 'u1' };
      if (token === 'writer') return { token, scopes: ['orders:read', 'orders:write'], subject: 'u2' };
      if (token === 'expired') return { token, scopes: [], expiresAt: Math.floor(Date.now() / 1000) - 10 };
      if (token === 'boom') throw new Error('verifier crashed');
      return undefined;
    },
    ...overrides,
  };
}

function post(server: McpServer, body: unknown, token?: string) {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return server.handleHttp({ method: 'POST', headers, body }, { headers });
}
const call = (name: string, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

describe('oauth core', () => {
  const server = new McpServer({ name: 't', oauth: oauth() });
  server.addTool(
    defineTool({ name: 'whoami', description: 'Who am I', handler: (_args, ctx) => ({ sub: ctx.auth?.subject }) }),
  );
  server.addTool(
    defineTool({ name: 'cancel', description: 'Cancel', scopes: ['orders:write'], handler: () => 'cancelled' }),
  );

  it('validates its options', () => {
    expect(() => new McpServer({ name: 't', oauth: oauth({ resource: 'not a url' }) })).toThrow(/absolute URL/);
    expect(() => new McpServer({ name: 't', oauth: oauth({ authorizationServers: [] }) })).toThrow(/not be empty/);
    expect(() => new McpServer({ name: 't', oauth: oauth({ resource: `${RESOURCE}#x` }) })).toThrow(/fragment/);
  });

  it('computes the RFC 9728 metadata paths and challenge', () => {
    expect(protectedResourceMetadataPaths('https://a.com/mcp')).toEqual([
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]);
    expect(protectedResourceMetadataPaths('https://a.com/')).toEqual(['/.well-known/oauth-protected-resource']);
    expect(protectedResourceMetadataPaths('https://a.com/v1/mcp/')).toContain(
      '/.well-known/oauth-protected-resource/v1/mcp',
    );
    expect(bearerChallenge('https://a.com/mcp', { error: 'invalid_token', errorDescription: 'say "hi"' })).toBe(
      'Bearer error="invalid_token", error_description="say \\"hi\\"", resource_metadata="https://a.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('only accepts bearer tokens from the Authorization header', () => {
    expect(bearerToken({ authorization: 'Bearer abc' })).toBe('abc');
    expect(bearerToken({ authorization: 'bearer abc' })).toBe('abc');
    expect(bearerToken({ authorization: 'Basic abc' })).toBeUndefined();
    expect(bearerToken({ authorization: 'Bearer a b' })).toBeUndefined();
    expect(bearerToken({})).toBeUndefined();
  });

  it('challenges requests without a token', async () => {
    const res = await post(server, call('whoami'));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('rejects invalid, expired and crashing tokens with invalid_token', async () => {
    for (const token of ['nope', 'expired', 'boom']) {
      const res = await post(server, call('whoami'), token);
      expect(res.status, token).toBe(401);
      expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
    }
  });

  it('also protects non-POST requests', async () => {
    const res = await server.handleHttp({ method: 'GET', headers: {}, body: undefined }, { headers: {} });
    expect(res.status).toBe(401);
  });

  it('passes the verified token to tools as ctx.auth', async () => {
    const res = await post(server, call('whoami'), 'reader');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!).result.structuredContent).toEqual({ sub: 'u1' });
  });

  it('answers 403 insufficient_scope for tools that need more scopes (step-up)', async () => {
    const res = await post(server, call('cancel'), 'reader');
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toContain('error="insufficient_scope"');
    expect(res.headers['www-authenticate']).toContain('scope="orders:write"');

    const batch = await post(server, [call('whoami', 1), call('cancel', 2)], 'reader');
    expect(batch.status).toBe(403);

    const ok = await post(server, call('cancel'), 'writer');
    expect(JSON.parse(ok.body!).result.content[0].text).toBe('cancelled');
  });

  it('enforces requiredScopes on every request', async () => {
    const strict = new McpServer({ name: 't', oauth: oauth({ requiredScopes: ['orders:write'] }) });
    const res = await post(strict, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'reader');
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toContain('scope="orders:write"');
    expect((await post(strict, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'writer')).status).toBe(200);
  });

  it('serves the metadata, advertising every scope in use', async () => {
    const res = await server.handleMetadataHttp({ method: 'GET' });
    expect(JSON.parse(res.body!)).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ['orders:write'],
      bearer_methods_supported: ['header'],
    });
    expect((await server.handleMetadataHttp({ method: 'HEAD' })).body).toBeUndefined();
    expect((await server.handleMetadataHttp({ method: 'POST' })).status).toBe(405);

    const custom = new McpServer({
      name: 't',
      oauth: oauth({ scopesSupported: ['a'], resourceDocumentation: 'https://docs', metadata: { x: 1 } }),
    });
    expect(JSON.parse((await custom.handleMetadataHttp({ method: 'GET' })).body!)).toMatchObject({
      scopes_supported: ['a'],
      resource_documentation: 'https://docs',
      x: 1,
    });
    expect((await new McpServer({ name: 'plain' }).handleMetadataHttp({ method: 'GET' })).status).toBe(404);
    expect(new McpServer({ name: 'plain' }).oauthMetadataPaths).toEqual([]);
  });
});

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

describe('jwtVerifier', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwk: Record<string, unknown>;
  let as: Server;
  let issuer: string;
  const ctx = { resource: RESOURCE, headers: {} };

  const sign = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.iss ?? issuer)
      .setAudience(opts.aud ?? RESOURCE)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    // A minimal authorization server: RFC 8414 metadata + JWKS.
    as = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      } else if (req.url === '/jwks') {
        res.end(JSON.stringify({ keys: [jwk] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => as.listen(0, '127.0.0.1', () => r()));
    issuer = baseUrlOf(as);
  });
  afterAll(() => new Promise<void>((r) => as.close(() => r())));

  it('verifies tokens with keys discovered from the issuer', async () => {
    const verify = jwtVerifier({ issuer });
    const info = await verify(await sign({ scope: 'orders:read orders:write', client_id: 'cli' }), ctx);
    expect(info).toMatchObject({ subject: 'user-1', clientId: 'cli', scopes: ['orders:read', 'orders:write'] });
    expect(info!.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('requires the audience to be this resource (no token passthrough)', async () => {
    const verify = jwtVerifier({ issuer, jwks: { keys: [jwk] } });
    await expect(verify(await sign({}, { aud: 'https://other-api.example.com' }), ctx)).rejects.toThrow();
    const custom = jwtVerifier({ issuer, jwks: { keys: [jwk] }, audience: 'https://other-api.example.com' });
    await expect(custom(await sign({}, { aud: 'https://other-api.example.com' }), ctx)).resolves.toBeTruthy();
  });

  it('rejects other issuers, tampered tokens and symmetric algorithms', async () => {
    const verify = jwtVerifier({ issuer, jwks: { keys: [jwk] } });
    await expect(verify(await sign({}, { iss: 'https://evil.example' }), ctx)).rejects.toThrow();
    const token = await sign({ scope: 'a' });
    const [h, , s] = token.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ iss: issuer, aud: RESOURCE, scope: 'admin' })).toString('base64url')}.${s}`;
    await expect(verify(forged, ctx)).rejects.toThrow();
    const hs = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setAudience(RESOURCE)
      .sign(new TextEncoder().encode('x'.repeat(32)));
    await expect(verify(hs, ctx)).rejects.toThrow();
  });

  it('reads scp claims and runs custom validation', async () => {
    const verify = jwtVerifier({ issuer, jwks: { keys: [jwk] }, validate: (c) => c.tenant === 'acme' });
    expect(await verify(await sign({ scp: ['a', 'b'], tenant: 'acme' }), ctx)).toMatchObject({ scopes: ['a', 'b'] });
    expect(await verify(await sign({ tenant: 'other' }), ctx)).toBeUndefined();
  });

  it('works end to end as the oauth verifier', async () => {
    const server = new McpServer({
      name: 't',
      oauth: { resource: RESOURCE, authorizationServers: [issuer], verifyToken: jwtVerifier({ issuer }) },
    });
    const good = await post(server, { jsonrpc: '2.0', id: 1, method: 'ping' }, await sign({}));
    expect(good.status).toBe(200);
    const bad = await post(server, { jsonrpc: '2.0', id: 1, method: 'ping' }, await sign({}, { aud: 'x' }));
    expect(bad.status).toBe(401);
  });
});

describe('introspectionVerifier', () => {
  let as: Server;
  let issuer: string;
  let calls = 0;
  let lastAuth: string | undefined;
  const ctx = { resource: RESOURCE, headers: {} };

  beforeAll(async () => {
    as = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/.well-known/oauth-authorization-server') {
        return res.end(JSON.stringify({ issuer, introspection_endpoint: `${issuer}/introspect` }));
      }
      calls++;
      lastAuth = req.headers.authorization;
      const token = new URLSearchParams(await readBody(req)).get('token');
      const exp = Math.floor(Date.now() / 1000) + 300;
      const responses: Record<string, object> = {
        good: { active: true, aud: RESOURCE, scope: 'orders:read', sub: 'u1', client_id: 'c1', exp, iss: issuer },
        other_aud: { active: true, aud: ['https://other.example'], exp },
        no_aud: { active: true, exp },
        wrong_iss: { active: true, aud: RESOURCE, iss: 'https://evil.example' },
      };
      res.end(JSON.stringify(responses[token!] ?? { active: false }));
    });
    await new Promise<void>((r) => as.listen(0, '127.0.0.1', () => r()));
    issuer = baseUrlOf(as);
  });
  afterAll(() => new Promise<void>((r) => as.close(() => r())));

  it('accepts active tokens for this resource and authenticates to the endpoint', async () => {
    const verify = introspectionVerifier({ issuer, clientId: 'rs', clientSecret: 's3cret' });
    expect(await verify('good', ctx)).toMatchObject({ subject: 'u1', clientId: 'c1', scopes: ['orders:read'] });
    expect(lastAuth).toBe(`Basic ${Buffer.from('rs:s3cret').toString('base64')}`);
  });

  it('rejects inactive tokens, other audiences and other issuers', async () => {
    const verify = introspectionVerifier({ issuer });
    expect(await verify('revoked', ctx)).toBeUndefined();
    expect(await verify('other_aud', ctx)).toBeUndefined();
    expect(await verify('wrong_iss', ctx)).toBeUndefined();
    expect(await verify('no_aud', ctx)).toBeTruthy();
    const strict = introspectionVerifier({ issuer, requireAudience: true });
    expect(await strict('no_aud', ctx)).toBeUndefined();
  });

  it('caches positive results', async () => {
    const verify = introspectionVerifier({ introspectionEndpoint: `${issuer}/introspect` });
    const before = calls;
    await verify('good', ctx);
    await verify('good', ctx);
    expect(calls - before).toBe(1);
  });
});
