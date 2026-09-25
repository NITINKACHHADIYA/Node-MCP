import type { JsonSchema, McpToolDefinition, SchemaLike } from './types.js';

interface StandardSchemaV1 {
  '~standard': {
    validate?: (value: unknown) => unknown;
    jsonSchema?: { input?: (opts: { target: string }) => unknown };
  };
}

function isStandard(s: unknown): s is StandardSchemaV1 {
  return typeof s === 'object' && s !== null && '~standard' in s;
}

/** Convert any supported schema flavour into a plain JSON Schema object. */
export function toJsonSchema(schema: SchemaLike | undefined): JsonSchema | undefined {
  if (schema === undefined || schema === null) return undefined;
  let out: unknown;
  if (isStandard(schema) && typeof schema['~standard'].jsonSchema?.input === 'function') {
    out = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
  } else if (typeof (schema as { toJSONSchema?: unknown }).toJSONSchema === 'function') {
    out = (schema as { toJSONSchema(): unknown }).toJSONSchema();
  } else if (isStandard(schema)) {
    throw new Error(
      'mcp-expose: this schema library does not support JSON Schema export. Pass a plain JSON Schema instead.',
    );
  } else {
    out = schema;
  }
  const { $schema: _ignored, ...rest } = out as JsonSchema;
  return rest;
}

/** Build a validator from a Standard Schema, if the input is one. */
export function toValidator(schema: SchemaLike | undefined): McpToolDefinition['validate'] {
  if (!isStandard(schema) || typeof schema['~standard'].validate !== 'function') return undefined;
  const validate = schema['~standard'].validate;
  return async (value) => {
    const result = (await validate(value)) as {
      value?: unknown;
      issues?: { message: string; path?: (PropertyKey | { key: PropertyKey })[] }[];
    };
    if (!result.issues) return { ok: true, value: result.value };
    const message = result.issues
      .map((i) => {
        const path = (i.path ?? []).map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.');
        return path ? `${path}: ${i.message}` : i.message;
      })
      .join('; ');
    return { ok: false, message };
  };
}

/** Very small structural check used when no Standard Schema validator exists. */
export function checkRequired(schema: JsonSchema, args: Record<string, unknown>): string | undefined {
  const missing = (schema.required ?? []).filter((k) => args[k] === undefined);
  return missing.length ? `Missing required argument(s): ${missing.join(', ')}` : undefined;
}
