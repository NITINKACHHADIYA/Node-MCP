/**
 * OAuth 2.1 support per the MCP authorization spec: the MCP endpoint acts as an
 * OAuth *resource server*. It publishes Protected Resource Metadata (RFC 9728),
 * answers unauthenticated requests with a `WWW-Authenticate` challenge that
 * tells the client where to log in, and checks bearer tokens with a verifier
 * you provide (see `jwtVerifier` / `introspectionVerifier` in `mcp-expose/oauth`).
 *
 * Runtime-agnostic: no `node:*` imports.
 */

/** Who the access token belongs to and what it allows. Available to tools as `ctx.auth`. */
export interface AuthInfo {
  /** The raw access token. */
  token: string;
  /** Scopes granted to the token. */
  scopes: string[];
  /** Subject (user id), e.g. the JWT `sub` claim. */
  subject?: string;
  /** OAuth client the token was issued to. */
  clientId?: string;
  /** Expiry, in seconds since the epoch. Expired tokens are rejected. */
  expiresAt?: number;
  /** All claims / introspection fields. */
  claims?: Record<string, unknown>;
}

export interface VerifyTokenContext {
  /** The canonical resource URL (`oauth.resource`). Tokens must be issued for it (audience). */
  resource: string;
  /** Lower-cased headers of the MCP request. */
  headers: Record<string, string>;
}

/**
 * Checks an access token. Return its AuthInfo, or `undefined` / throw when the
 * token is invalid. It MUST check that the token was issued for this server
 * (audience = `ctx.resource`), or tokens meant for other services would be accepted.
 */
export type TokenVerifier = (
  token: string,
  ctx: VerifyTokenContext,
) => AuthInfo | undefined | null | Promise<AuthInfo | undefined | null>;

export interface OAuthOptions {
  /**
   * Canonical, public URL of the MCP endpoint, e.g. `https://api.example.com/mcp`.
   * Clients request tokens for this resource, and it must match the URL they connect to.
   */
  resource: string;
  /** Issuer URLs of the authorization servers that issue tokens for this server. */
  authorizationServers: string[];
  /** Checks bearer tokens. */
  verifyToken: TokenVerifier;
  /** Scopes every token needs to use the MCP endpoint at all. */
  requiredScopes?: string[];
  /** Scopes advertised in the metadata. @default requiredScopes plus every tool's `scopes` */
  scopesSupported?: string[];
  /** Human-readable name shown by clients. */
  resourceName?: string;
  /** URL of documentation for developers. */
  resourceDocumentation?: string;
  /** Extra fields merged into the Protected Resource Metadata document. */
  metadata?: Record<string, unknown>;
}

export const PROTECTED_RESOURCE_WELL_KNOWN = '/.well-known/oauth-protected-resource';

/**
 * Paths the metadata is served on, per RFC 9728: the well-known prefix with the
 * resource path appended (`/.well-known/oauth-protected-resource/mcp`), plus the
 * bare well-known path that older clients fall back to.
 */
export function protectedResourceMetadataPaths(resource: string): string[] {
  const pathname = new URL(resource).pathname.replace(/\/+$/, '');
  return pathname
    ? [PROTECTED_RESOURCE_WELL_KNOWN + pathname, PROTECTED_RESOURCE_WELL_KNOWN]
    : [PROTECTED_RESOURCE_WELL_KNOWN];
}

/** Absolute URL of the metadata document, used in `WWW-Authenticate`. */
export function protectedResourceMetadataUrl(resource: string): string {
  return new URL(protectedResourceMetadataPaths(resource)[0] as string, resource).href;
}

export function validateOAuthOptions(o: OAuthOptions): void {
  let url: URL;
  try {
    url = new URL(o.resource);
  } catch {
    throw new Error(`mcp-expose: oauth.resource must be an absolute URL, got ${JSON.stringify(o.resource)}`);
  }
  if (url.hash) throw new Error('mcp-expose: oauth.resource must not contain a fragment');
  if (!o.authorizationServers?.length) throw new Error('mcp-expose: oauth.authorizationServers must not be empty');
  if (typeof o.verifyToken !== 'function') throw new Error('mcp-expose: oauth.verifyToken is required');
}

const quote = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`;

/** Build a `WWW-Authenticate: Bearer ...` challenge (RFC 6750 + RFC 9728). */
export function bearerChallenge(
  resource: string,
  params: { error?: string; errorDescription?: string; scope?: string[] } = {},
): string {
  const parts: string[] = [];
  if (params.error) parts.push(`error=${quote(params.error)}`);
  if (params.errorDescription) parts.push(`error_description=${quote(params.errorDescription)}`);
  if (params.scope?.length) parts.push(`scope=${quote(params.scope.join(' '))}`);
  parts.push(`resource_metadata=${quote(protectedResourceMetadataUrl(resource))}`);
  return `Bearer ${parts.join(', ')}`;
}

/** Extract the token from `Authorization: Bearer <token>`. Tokens in the query string are never accepted. */
export function bearerToken(headers: Record<string, string>): string | undefined {
  const m = /^Bearer[ ]+([^\s,]+)\s*$/i.exec(headers.authorization ?? '');
  return m?.[1];
}

export type AuthOutcome =
  | { ok: true; auth: AuthInfo }
  | { ok: false; status: 401 | 403; challenge: string; error: string; description: string };

/** Authenticate one MCP request. */
export async function authenticate(o: OAuthOptions, headers: Record<string, string>): Promise<AuthOutcome> {
  const token = bearerToken(headers);
  if (!token) {
    // No credentials: a bare challenge pointing at the metadata starts the client's login flow.
    return {
      ok: false,
      status: 401,
      error: 'unauthorized',
      description: 'Authorization required',
      challenge: bearerChallenge(o.resource, { scope: o.requiredScopes }),
    };
  }

  let auth: AuthInfo | undefined | null;
  try {
    auth = await o.verifyToken(token, { resource: o.resource, headers });
  } catch {
    auth = undefined;
  }
  if (!auth) return deny(o, 401, 'invalid_token', 'The access token is invalid');
  if (auth.expiresAt !== undefined && auth.expiresAt * 1000 <= Date.now()) {
    return deny(o, 401, 'invalid_token', 'The access token has expired');
  }
  const missing = missingScopes(auth, o.requiredScopes);
  if (missing.length) {
    // Keep the scopes already granted in the challenge, so re-authorizing never drops access.
    const scope = [...new Set([...(auth.scopes ?? []), ...(o.requiredScopes ?? [])])];
    return deny(o, 403, 'insufficient_scope', `Missing scope: ${missing.join(' ')}`, scope);
  }
  return { ok: true, auth: { ...auth, scopes: auth.scopes ?? [] } };
}

/** A failed AuthOutcome with an RFC 6750 error challenge. */
export function deny(
  o: OAuthOptions,
  status: 401 | 403,
  error: string,
  description: string,
  scope?: string[],
): AuthOutcome & { ok: false } {
  return {
    ok: false,
    status,
    error,
    description,
    challenge: bearerChallenge(o.resource, { error, errorDescription: description, scope }),
  };
}

export function missingScopes(auth: AuthInfo | undefined, required: string[] | undefined): string[] {
  if (!required?.length) return [];
  const granted = new Set(auth?.scopes ?? []);
  return required.filter((s) => !granted.has(s));
}

/** Parse a space-separated `scope` string or an array of scopes. */
export function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(' ').filter(Boolean);
  return [];
}
