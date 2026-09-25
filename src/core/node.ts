import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpHttpResponse } from './server.js';

/** Flatten Node's IncomingHttpHeaders into lower-cased single strings. */
export function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/** Read and return the raw body of a Node request (for frameworks without a JSON body parser). */
export function readRawBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Base URL that reaches the same server the MCP request arrived on. */
export function loopbackBaseUrl(req: IncomingMessage): string {
  const socket = req.socket as IncomingMessage['socket'] & {
    encrypted?: boolean;
    server?: { address(): { address: string } | string | null };
  };
  const port = socket.localPort;
  const encrypted = socket.encrypted;
  // Prefer the address the server is bound to: when it listens on all
  // interfaces this yields 127.0.0.1, so internal calls come from loopback
  // (which `trust proxy: 'loopback'` style settings rely on).
  const bound = socket.server?.address();
  let host = (typeof bound === 'object' && bound?.address) || socket.localAddress || '127.0.0.1';
  if (host.startsWith('::ffff:')) host = host.slice(7);
  if (host === '::' || host === '0.0.0.0') host = '127.0.0.1';
  if (host.includes(':')) host = `[${host}]`;
  return `${encrypted ? 'https' : 'http'}://${host}:${port}`;
}

export function writeNodeResponse(res: ServerResponse, out: McpHttpResponse): void {
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.end(out.body);
}
