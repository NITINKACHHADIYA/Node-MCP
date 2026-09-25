import type { JsonSchema } from '../core/types.js';

interface ValidationMetadata {
  type: string;
  name?: string;
  propertyName: string;
  constraints?: unknown[];
  each?: boolean;
}

export interface ClassValidatorStorage {
  getTargetValidationMetadatas(
    target: Function,
    targetSchema: string,
    always: boolean,
    strictGroups: boolean,
  ): ValidationMetadata[];
}

declare const Reflect: { getMetadata?(key: string, target: object, prop?: string | symbol): unknown };

const PRIMITIVES = new Map<unknown, JsonSchema>([
  [String, { type: 'string' }],
  [Number, { type: 'number' }],
  [Boolean, { type: 'boolean' }],
  [Date, { type: 'string', format: 'date-time' }],
  [Array, { type: 'array' }],
  [Object, { type: 'object' }],
]);

export function primitiveSchema(type: unknown): JsonSchema | undefined {
  const s = PRIMITIVES.get(type);
  return s ? { ...s } : undefined;
}

/** Apply one class-validator rule to a (property or `items`) schema. */
function applyRule(s: JsonSchema, name: string, c: unknown[] = []): void {
  switch (name) {
    case 'isString':
      s.type = 'string';
      break;
    case 'isNumber':
    case 'isNumberString':
      s.type = name === 'isNumber' ? 'number' : 'string';
      break;
    case 'isInt':
      s.type = 'integer';
      break;
    case 'isBoolean':
      s.type = 'boolean';
      break;
    case 'isDate':
    case 'isDateString':
    case 'isISO8601':
      s.type = 'string';
      s.format = 'date-time';
      break;
    case 'isEmail':
      s.type = 'string';
      s.format = 'email';
      break;
    case 'isUrl':
      s.type = 'string';
      s.format = 'uri';
      break;
    case 'isUUID':
      s.type = 'string';
      s.format = 'uuid';
      break;
    case 'isPositive':
      s.exclusiveMinimum = 0;
      break;
    case 'isNegative':
      s.exclusiveMaximum = 0;
      break;
    case 'min':
      s.minimum = c[0];
      break;
    case 'max':
      s.maximum = c[0];
      break;
    case 'minLength':
      s.minLength = c[0];
      break;
    case 'maxLength':
      s.maxLength = c[0];
      break;
    case 'length':
      s.minLength = c[0];
      if (c[1] !== undefined) s.maxLength = c[1];
      break;
    case 'matches':
      if (c[0] instanceof RegExp) s.pattern = c[0].source;
      break;
    case 'isIn':
      s.enum = c[0] as unknown[];
      break;
    case 'isEnum':
      s.enum = (c[1] as unknown[]) ?? Object.values(c[0] as object);
      break;
    case 'isNotEmpty':
      if (s.type === 'string') s.minLength = Math.max(1, Number(s.minLength ?? 0));
      break;
    case 'isArray':
      s.type = 'array';
      break;
    case 'arrayMinSize':
      s.minItems = c[0];
      break;
    case 'arrayMaxSize':
      s.maxItems = c[0];
      break;
    case 'isObject':
      s.type = 'object';
      break;
  }
}

/**
 * Derive a JSON Schema from a class-validator DTO. Only used to *describe* the
 * tool to the agent: the real validation still happens in your ValidationPipe.
 */
export function dtoToJsonSchema(dto: Function, storage: ClassValidatorStorage | undefined, depth = 0): JsonSchema {
  const schema: JsonSchema = { type: 'object', properties: {} };
  if (!storage || depth > 5) return schema;
  const metas = storage.getTargetValidationMetadatas(dto, '', true, false);
  const properties: Record<string, JsonSchema> = {};
  const optional = new Set<string>();

  for (const m of metas) {
    const prop = (properties[m.propertyName] ??= initial(dto, m.propertyName));
    if (m.type === 'conditionalValidation' && m.name === 'isOptional') {
      optional.add(m.propertyName);
    } else if (m.type === 'nestedValidation') {
      const nestedType = Reflect.getMetadata?.('design:type', dto.prototype, m.propertyName);
      if (typeof nestedType === 'function' && !PRIMITIVES.has(nestedType)) {
        Object.assign(prop, dtoToJsonSchema(nestedType, storage, depth + 1));
      }
    } else if (m.type === 'customValidation' && m.name) {
      if (m.each) {
        prop.type = 'array';
        const items = (prop.items ??= {}) as JsonSchema;
        applyRule(items, m.name, m.constraints);
      } else {
        applyRule(prop, m.name, m.constraints);
      }
    }
  }

  schema.properties = properties;
  const required = Object.keys(properties).filter((p) => !optional.has(p));
  if (required.length) schema.required = required;
  return schema;
}

function initial(dto: Function, prop: string): JsonSchema {
  const designType = Reflect.getMetadata?.('design:type', dto.prototype, prop);
  const s: JsonSchema = primitiveSchema(designType) ?? {};
  // Pick up @nestjs/swagger @ApiProperty() descriptions/examples when present.
  const api = Reflect.getMetadata?.('swagger/apiModelProperties', dto.prototype, prop) as
    { description?: string; example?: unknown; enum?: unknown } | undefined;
  if (api?.description) s.description = api.description;
  if (api?.example !== undefined) s.examples = [api.example];
  if (Array.isArray(api?.enum)) s.enum = api.enum;
  return s;
}
