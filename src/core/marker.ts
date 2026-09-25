import type { RouteToolOptions } from './types.js';

/** Symbol under which marker middleware carries its tool options. */
export const MCP_TOOL = Symbol.for('mcp-expose.tool');

export type Marked<T> = T & { [MCP_TOOL]: RouteToolOptions };

export function markerOf(fn: unknown): RouteToolOptions | undefined {
  return typeof fn === 'function' ? (fn as Partial<Marked<object>>)[MCP_TOOL] : undefined;
}

export function mark<T extends object>(fn: T, opts: RouteToolOptions): Marked<T> {
  Object.defineProperty(fn, MCP_TOOL, { value: opts, enumerable: false });
  return fn as Marked<T>;
}
