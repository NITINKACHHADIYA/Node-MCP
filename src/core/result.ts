import type { ToolResult } from './types.js';

/** A ToolResult: `{ content: [{ type: 'text', ... }, ...] }`. Plain data with a `content` array is not one. */
export function isToolResult(value: unknown): value is ToolResult {
  const content = (value as ToolResult | undefined)?.content;
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((c) => !!c && typeof c === 'object' && typeof (c as { type?: unknown }).type === 'string')
  );
}

/** Turn a handler's return value (string, JSON value or ToolResult) into a ToolResult. */
export function toToolResult(value: unknown): ToolResult {
  if (isToolResult(value)) return value;
  if (typeof value === 'string') return { content: [{ type: 'text', text: value }] };
  const text = JSON.stringify(value ?? null);
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}
