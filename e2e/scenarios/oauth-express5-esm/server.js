// An Express 5 API protected by OAuth, plus a tiny authorization server in the
// same process (in real life: Auth0, Okta, Keycloak, Entra ID, ...).
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, createLocalJWKSet } from 'jose';
import { mcpTool, mountMcp } from 'mcp-expose/express';
import { jwtVerifier } from 'mcp-expose/oauth';

const PORT = Number(process.env.PORT);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const RESOURCE = `${ORIGIN}/mcp`;

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] };

const app = express();
app.use(express.json());

// ---------------------------------------------------------------- authorization server
// Authorization code + PKCE with dynamic client registration, like the flow
// Claude / Cursor / VS Code run. The "user" (alice) approves every request.
const clients = new Map();
const codes = new Map();
const tokensIssued = [];

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    registration_endpoint: `${ORIGIN}/oauth/register`,
    jwks_uri: `${ORIGIN}/oauth/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});
app.get('/oauth/jwks', (_req, res) => res.json(jwks));

app.post('/oauth/register', (req, res) => {
  const client = { ...req.body, client_id: `client-${clients.size + 1}`, token_endpoint_auth_method: 'none' };
  clients.set(client.client_id, client);
  res.status(201).json(client);
});

app.get('/oauth/authorize', (req, res) => {
  const q = req.query;
  const client = clients.get(q.client_id);
  if (!client || !client.redirect_uris.includes(q.redirect_uri)) return res.status(400).send('unknown client');
  if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) {
    return res.status(400).send('PKCE S256 required');
  }
  const code = randomUUID();
  codes.set(code, { ...q });
  const to = new URL(q.redirect_uri);
  to.searchParams.set('code', code);
  if (q.state) to.searchParams.set('state', q.state);
  res.redirect(302, to.href);
});

app.post('/oauth/token', express.urlencoded({ extended: false }), async (req, res) => {
  const b = req.body;
  const grant = codes.get(b.code);
  codes.delete(b.code);
  if (b.grant_type !== 'authorization_code' || !grant) return res.status(400).json({ error: 'invalid_grant' });
  const challenge = createHash('sha256').update(String(b.code_verifier)).digest('base64url');
  if (challenge !== grant.code_challenge || b.redirect_uri !== grant.redirect_uri || b.client_id !== grant.client_id) {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  // RFC 8707: the token's audience is the resource the client asked for.
  if (b.resource !== grant.resource) return res.status(400).json({ error: 'invalid_target' });
  const scope = grant.scope ?? '';
  const token = await new SignJWT({ scope, client_id: grant.client_id })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ORIGIN)
    .setAudience(grant.resource ?? 'missing-resource')
    .setSubject('user:alice')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  tokensIssued.push(scope);
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 300, scope });
});
app.get('/oauth/issued', (_req, res) => res.json(tokensIssued));

// ---------------------------------------------------------------- the existing API
const keySet = createLocalJWKSet(jwks);
async function requireJwt(req, res, next) {
  try {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    req.user = (await jwtVerify(token, keySet, { issuer: ORIGIN, audience: RESOURCE })).payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

const orders = { 1: { id: '1', sku: 'KB-01', quantity: 1, status: 'paid' } };
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: true, legacyHeaders: false });

app.get(
  '/orders/:id',
  mcpTool({ name: 'get_order', description: 'Get an order' }),
  apiLimiter,
  requireJwt,
  (req, res) => {
    res.json({ ...(orders[req.params.id] ?? { error: 'not found' }), requestedBy: req.user.sub });
  },
);
app.delete(
  '/orders/:id',
  mcpTool({ name: 'cancel_order', description: 'Cancel an order', scopes: ['orders:write'] }),
  apiLimiter,
  requireJwt,
  (req, res) => res.json({ id: req.params.id, status: 'cancelled' }),
);
app.get('/admin/stats', apiLimiter, requireJwt, (_req, res) => res.json({ orders: Object.keys(orders).length }));

mountMcp(app, {
  name: 'shop-api',
  oauth: {
    resource: RESOURCE,
    authorizationServers: [ORIGIN],
    requiredScopes: ['mcp:tools'],
    resourceName: 'Shop API',
    verifyToken: jwtVerifier({ issuer: ORIGIN }),
  },
});

app.listen(PORT, '127.0.0.1', () => console.log('READY'));
