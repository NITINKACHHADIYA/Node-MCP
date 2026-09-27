/**
 * Ready-made token verifiers for the `oauth` option:
 *
 *   - `jwtVerifier()`           JWT access tokens, checked against the issuer's JWKS
 *                               (Auth0, Okta, Keycloak, Entra ID, Clerk, Cognito, WorkOS, ...).
 *                               Needs the `jose` package.
 *   - `introspectionVerifier()` opaque tokens, checked with RFC 7662 token introspection.
 *
 * Both check the audience: a token is only accepted when it was issued for this
 * MCP server (`oauth.resource`), so tokens meant for other services are refused.
 */
import { parseScopes } from '../core/oauth.js';
import type { AuthInfo, TokenVerifier } from '../core/oauth.js';
import type * as JoseModule from 'jose';

export type { AuthInfo, TokenVerifier, VerifyTokenContext } from '../core/oauth.js';

export interface JwtVerifierOptions {
  /** Expected `iss` claim, e.g. `https://your-tenant.auth0.com/`. */
  issuer: string;
  /**
   * Expected `aud` claim(s). Defaults to `oauth.resource`, the URL of your MCP endpoint,
   * as the MCP spec requires. Set it when your authorization server uses a different
   * audience identifier (e.g. an Auth0 API identifier).
   */
  audience?: string | string[];
  /** JWKS URL. Discovered from the issuer's metadata when omitted. */
  jwksUri?: string;
  /** A static JWKS (`{ keys: [...] }`) instead of fetching one. */
  jwks?: { keys: Record<string, unknown>[] };
  /** Allowed signing algorithms. @default asymmetric algorithms only (RS*, PS*, ES*, EdDSA) */
  algorithms?: string[];
  /** Allowed clock skew in seconds. @default 30 */
  clockTolerance?: number;
  /** Claim that holds the scopes. @default 'scope', then 'scp' */
  scopeClaim?: string;
  /** Extra checks on the verified claims; return false to reject the token. */
  validate?: (claims: Record<string, unknown>) => boolean | Promise<boolean>;
}

const ASYMMETRIC = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'Ed25519',
];

type Jose = typeof JoseModule;
let josePromise: Promise<Jose> | undefined;
function loadJose(): Promise<Jose> {
  josePromise ??= import('jose').catch((err: unknown) => {
    josePromise = undefined;
    throw new Error(`mcp-expose: jwtVerifier() needs the "jose" package. Run: npm install jose (${String(err)})`);
  });
  return josePromise;
}

/**
 * Authorization server metadata (RFC 8414), falling back to OpenID Connect discovery.
 * Tries the path-inserted and appended forms, as MCP clients do.
 */
export async function discoverAuthorizationServer(issuer: string): Promise<Record<string, unknown>> {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${path}`, url.origin).href,
    new URL(`/.well-known/openid-configuration${path}`, url.origin).href,
    ...(path ? [`${url.origin}${path}/.well-known/openid-configuration`] : []),
  ];
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { headers: { accept: 'application/json' } });
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(`mcp-expose: could not load authorization server metadata for ${issuer}`);
}

function toAuthInfo(token: string, claims: Record<string, unknown>, scopeClaim?: string): AuthInfo {
  const scopes = scopeClaim ? parseScopes(claims[scopeClaim]) : parseScopes(claims.scope ?? claims.scp);
  return {
    token,
    scopes,
    subject: typeof claims.sub === 'string' ? claims.sub : undefined,
    clientId: [claims.client_id, claims.azp, claims.cid].find((v): v is string => typeof v === 'string'),
    expiresAt: typeof claims.exp === 'number' ? claims.exp : undefined,
    claims,
  };
}

/**
 * Verify JWT access tokens with the issuer's public keys:
 *
 *   oauth: {
 *     resource: 'https://api.example.com/mcp',
 *     authorizationServers: ['https://example.auth0.com/'],
 *     verifyToken: jwtVerifier({ issuer: 'https://example.auth0.com/' }),
 *   }
 *
 * Checks signature, `iss`, `aud` (defaults to the resource), `exp` and `nbf`.
 */
export function jwtVerifier(options: JwtVerifierOptions): TokenVerifier {
  let keySet: Promise<Parameters<Jose['jwtVerify']>[1]> | undefined;
  const getKeys = () => {
    keySet ??= (async () => {
      const jose = await loadJose();
      if (options.jwks) return jose.createLocalJWKSet(options.jwks as Parameters<Jose['createLocalJWKSet']>[0]);
      const jwksUri = options.jwksUri ?? ((await discoverAuthorizationServer(options.issuer)).jwks_uri as string);
      if (!jwksUri) throw new Error(`mcp-expose: no jwks_uri in the metadata of ${options.issuer}`);
      return jose.createRemoteJWKSet(new URL(jwksUri));
    })().catch((err: unknown) => {
      keySet = undefined; // retry discovery on the next request
      throw err;
    });
    return keySet;
  };

  return async (token, ctx) => {
    const jose = await loadJose();
    const { payload } = await jose.jwtVerify(token, await getKeys(), {
      issuer: options.issuer,
      audience: options.audience ?? ctx.resource,
      algorithms: options.algorithms ?? ASYMMETRIC,
      clockTolerance: options.clockTolerance ?? 30,
    });
    const claims = payload as Record<string, unknown>;
    if (options.validate && !(await options.validate(claims))) return undefined;
    return toAuthInfo(token, claims, options.scopeClaim);
  };
}

export interface IntrospectionVerifierOptions {
  /** Token introspection endpoint. Discovered from `issuer` when omitted. */
  introspectionEndpoint?: string;
  /** Issuer URL, used to discover the endpoint and to check `iss` when present. */
  issuer?: string;
  /** Credentials of this resource server at the authorization server (HTTP Basic). */
  clientId?: string;
  clientSecret?: string;
  /** Or any headers, e.g. `{ authorization: 'Bearer <token>' }`. */
  headers?: Record<string, string>;
  /**
   * Expected audience. Defaults to `oauth.resource`. Checked when the response
   * has an `aud` field; set `requireAudience: true` to reject responses without one.
   */
  audience?: string | string[];
  requireAudience?: boolean;
  /** Cache positive results for this many seconds (never past the token expiry). @default 60 */
  cacheSeconds?: number;
  /** Extra checks on the introspection response; return false to reject. */
  validate?: (response: Record<string, unknown>) => boolean | Promise<boolean>;
}

/** Verify opaque (or any) tokens with RFC 7662 token introspection. */
export function introspectionVerifier(options: IntrospectionVerifierOptions): TokenVerifier {
  if (!options.introspectionEndpoint && !options.issuer) {
    throw new Error('mcp-expose: introspectionVerifier needs introspectionEndpoint or issuer');
  }
  let endpoint: Promise<string> | undefined;
  const getEndpoint = () => {
    endpoint ??= (async () => {
      if (options.introspectionEndpoint) return options.introspectionEndpoint;
      const meta = await discoverAuthorizationServer(options.issuer!);
      if (typeof meta.introspection_endpoint !== 'string') {
        throw new Error(`mcp-expose: no introspection_endpoint in the metadata of ${options.issuer}`);
      }
      return meta.introspection_endpoint;
    })().catch((err: unknown) => {
      endpoint = undefined;
      throw err;
    });
    return endpoint;
  };

  const cacheMs = (options.cacheSeconds ?? 60) * 1000;
  const cache = new Map<string, { info: AuthInfo; until: number }>();

  return async (token, ctx) => {
    const now = Date.now();
    const hit = cache.get(token);
    if (hit && hit.until > now) return hit.info;
    cache.delete(token);

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...options.headers,
    };
    if (options.clientId) {
      const basic = `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret ?? '')}`;
      headers.authorization = `Basic ${btoa(basic)}`;
    }
    const res = await fetch(await getEndpoint(), {
      method: 'POST',
      headers,
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
    });
    if (!res.ok) throw new Error(`token introspection failed: HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (data.active !== true) return undefined;

    if (options.issuer && typeof data.iss === 'string' && data.iss !== options.issuer) return undefined;
    const expected = [options.audience ?? ctx.resource].flat();
    const aud = data.aud === undefined ? undefined : [data.aud].flat().map(String);
    if (aud ? !aud.some((a) => expected.includes(a)) : options.requireAudience) return undefined;
    if (options.validate && !(await options.validate(data))) return undefined;

    const info = toAuthInfo(token, data);
    if (cacheMs > 0) {
      const until = Math.min(now + cacheMs, info.expiresAt ? info.expiresAt * 1000 : Infinity);
      if (cache.size > 10_000) cache.clear();
      cache.set(token, { info, until });
    }
    return info;
  };
}
