import {
  All,
  Controller,
  Inject,
  Injectable,
  Module,
  Req,
  Res,
  SetMetadata,
  UseGuards,
  VERSION_NEUTRAL,
  type CanActivate,
  type DynamicModule,
  type Type,
} from '@nestjs/common';
import { ApplicationConfig, DiscoveryModule, DiscoveryService } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import { createFetchDispatcher } from '../core/dispatch.js';
import { loopbackBaseUrl, normalizeHeaders } from '../core/node.js';
import { createRouteTool, joinPaths, sanitizeToolName } from '../core/route-tool.js';
import { McpServer } from '../core/server.js';
import type { JsonSchema, McpServerOptions, McpToolDefinition, RouteToolOptions, ToolContext } from '../core/types.js';
import { dtoToJsonSchema, primitiveSchema, type ClassValidatorStorage } from './dto-schema.js';

export { dtoToJsonSchema } from './dto-schema.js';

// Nest's metadata keys (stable across Nest 8 – 12).
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const ROUTE_ARGS_METADATA = '__routeArguments__';
const VERSION_METADATA = '__version__';
const REQUEST_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
const PARAMTYPE_BODY = 3;
const PARAMTYPE_QUERY = 4;
const PARAMTYPE_PARAM = 5;

export const MCP_TOOL_METADATA = 'mcp-expose:tool';
export const MCP_MODULE_OPTIONS = Symbol('MCP_MODULE_OPTIONS');

declare const Reflect: {
  getMetadata(key: unknown, target: object, prop?: string | symbol): any;
};

/**
 * Expose a controller method as an MCP tool.
 *
 *   @Get(':id')
 *   @McpTool({ description: 'Get a user by id' })
 *   findOne(@Param('id') id: string) { ... }
 *
 * The input schema is derived from `@Param()`, `@Query()` and `@Body()` DTOs
 * (class-validator rules and @ApiProperty descriptions), unless you pass
 * `input` / `body` / `query` / `params` yourself.
 */
export function McpTool(options: RouteToolOptions = {}): MethodDecorator {
  return SetMetadata(MCP_TOOL_METADATA, options);
}

export interface McpModuleOptions extends McpServerOptions {
  /**
   * Path of the MCP endpoint. @default 'mcp'
   * The app's global prefix applies to it unless you exclude it.
   */
  path?: string;
  /** Guards for the MCP endpoint itself, e.g. `[JwtAuthGuard]`. Global guards apply too. */
  guards?: (Type<CanActivate> | CanActivate)[];
  /**
   * Base URL for internal calls. Defaults to loopback on the port the MCP
   * request arrived on.
   */
  baseUrl?: string;
  /**
   * Prefix added to every tool route. Normally not needed: the app's global
   * prefix and URI versioning are detected automatically.
   */
  pathPrefix?: string;
  /** Extra hand-written tools (see `defineTool`). */
  tools?: McpToolDefinition[];
  /**
   * class-validator's metadata storage, used to turn DTOs into JSON Schema.
   * Loaded automatically from `class-validator` when installed.
   */
  classValidatorStorage?: ClassValidatorStorage;
}

interface ControllerWrapper {
  metatype?: Function | null;
  instance?: object;
}

/** Holds the MCP server and discovers `@McpTool()` handlers. Inject it to add tools at runtime. */
export class McpService {
  readonly server: McpServer;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly appConfig: ApplicationConfig,
    private readonly options: McpModuleOptions,
  ) {
    this.server = new McpServer(options);
    for (const t of options.tools ?? []) this.server.addTool(t);
    const dispatch = createFetchDispatcher({
      baseUrl: options.baseUrl ?? ((ctx) => loopbackBaseUrl(ctx.raw as IncomingMessage)),
    });
    this.server.onLoad(async () => {
      const storage = options.classValidatorStorage ?? (await loadClassValidator());
      for (const t of this.discover(storage)) {
        this.server.addTool(createRouteTool(t.route, t.options, dispatch, options));
      }
    });
  }

  private globalPrefix(): string {
    return this.appConfig.getGlobalPrefix?.() ?? '';
  }

  private versionSegment(controller: Function, handler: Function): string | undefined {
    const versioning = (this.appConfig as { getVersioning?(): { type: number; prefix?: string | false; defaultVersion?: unknown } | undefined })
      .getVersioning?.();
    if (!versioning || versioning.type !== 0 /* VersioningType.URI */) return undefined;
    let version =
      Reflect.getMetadata(VERSION_METADATA, handler) ??
      Reflect.getMetadata(VERSION_METADATA, controller) ??
      versioning.defaultVersion;
    if (Array.isArray(version)) version = version[0];
    if (version === undefined || typeof version === 'symbol') return undefined;
    const prefix = versioning.prefix === false ? '' : (versioning.prefix ?? 'v');
    return `${prefix}${String(version)}`;
  }

  private discover(storage: ClassValidatorStorage | undefined) {
    const found: { route: { method: string; path: string }; options: RouteToolOptions }[] = [];
    for (const wrapper of this.discovery.getControllers() as ControllerWrapper[]) {
      const controller = wrapper.metatype;
      if (!controller?.prototype) continue;
      const proto = controller.prototype;
      const ctrlPaths = toArray(Reflect.getMetadata(PATH_METADATA, controller) ?? '/');
      const ctrlName = controller.name.replace(/Controller$/, '');

      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === 'constructor') continue;
        const handler = Object.getOwnPropertyDescriptor(proto, key)?.value;
        if (typeof handler !== 'function') continue;
        const meta: RouteToolOptions | undefined = Reflect.getMetadata(MCP_TOOL_METADATA, handler);
        if (!meta) continue;
        const method = REQUEST_METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as number] ?? 'GET';
        const methodPath = toArray(Reflect.getMetadata(PATH_METADATA, handler) ?? '/')[0] as string;
        const path = joinPaths(
          this.globalPrefix(),
          this.versionSegment(controller, handler),
          this.options.pathPrefix,
          ctrlPaths[0] as string,
          methodPath,
        );
        found.push({
          route: { method: method === 'ALL' ? 'POST' : method, path },
          options: {
            name: sanitizeToolName(`${toSnake(ctrlName)}_${toSnake(key)}`),
            ...describeArgs(controller, key, storage),
            ...meta,
          },
        });
      }
    }
    return found;
  }
}

/** Derive params/query/body schemas from the handler's decorated arguments. */
function describeArgs(controller: Function, key: string, storage: ClassValidatorStorage | undefined): RouteToolOptions {
  const args: Record<string, { index: number; data?: unknown }> =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, key) ?? {};
  const types: unknown[] = Reflect.getMetadata('design:paramtypes', controller.prototype, key) ?? [];
  const params: JsonSchema = { type: 'object', properties: {} };
  const query: JsonSchema = { type: 'object', properties: {}, required: [] };
  let body: JsonSchema | undefined;

  const schemaFor = (t: unknown): JsonSchema =>
    primitiveSchema(t) ?? (typeof t === 'function' ? dtoToJsonSchema(t, storage) : {});

  for (const [k, arg] of Object.entries(args)) {
    const paramtype = Number(k.split(':')[0]);
    const t = types[arg.index];
    const field = typeof arg.data === 'string' ? arg.data : undefined;
    if (paramtype === PARAMTYPE_PARAM && field) {
      params.properties![field] = primitiveSchema(t) ?? { type: 'string' };
    } else if (paramtype === PARAMTYPE_QUERY) {
      if (field) query.properties![field] = primitiveSchema(t) ?? { type: 'string' };
      else Object.assign(query, mergeObject(query, schemaFor(t)));
    } else if (paramtype === PARAMTYPE_BODY) {
      if (field) {
        body ??= { type: 'object', properties: {}, required: [] };
        body.properties![field] = schemaFor(t);
        (body.required as string[]).push(field);
      } else {
        body = mergeObject(body, schemaFor(t));
      }
    }
  }
  const out: RouteToolOptions = { params };
  if (Object.keys(query.properties!).length) out.query = query;
  if (body) out.body = body;
  return out;
}

function mergeObject(a: JsonSchema | undefined, b: JsonSchema): JsonSchema {
  if (!a) return b;
  return {
    type: 'object',
    properties: { ...a.properties, ...b.properties },
    required: [...(a.required ?? []), ...(b.required ?? [])],
  };
}

async function loadClassValidator(): Promise<ClassValidatorStorage | undefined> {
  try {
    const cv = (await import('class-validator')) as { getMetadataStorage?: () => ClassValidatorStorage };
    return cv.getMetadataStorage?.();
  } catch {
    return undefined;
  }
}

function toArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function toSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
}

// Decorators are applied by hand so this package builds without
// `experimentalDecorators` / `emitDecoratorMetadata`.
Injectable()(McpService);
Inject(DiscoveryService)(McpService, undefined as never, 0);
Inject(ApplicationConfig)(McpService, undefined as never, 1);
Inject(MCP_MODULE_OPTIONS)(McpService, undefined as never, 2);

interface AnyReq {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
  raw?: IncomingMessage;
  socket?: unknown;
}
interface AnyRes {
  // Express
  status?(code: number): AnyRes;
  set?(headers: Record<string, string>): AnyRes;
  // Fastify
  code?(code: number): AnyRes;
  headers?(headers: Record<string, string>): AnyRes;
  send(body?: unknown): unknown;
  end?(body?: unknown): unknown;
}

function createMcpController(options: McpModuleOptions): Type<unknown> {
  class McpController {
    constructor(readonly mcp: McpService) {}

    async handle(req: AnyReq, res: AnyRes) {
      const nodeReq = (req.raw ?? req) as IncomingMessage;
      const headers = normalizeHeaders(req.headers);
      const ctx: ToolContext = { headers, clientIp: req.ip, raw: nodeReq };
      const out = await this.mcp.server.handleHttp({ method: req.method, headers, body: req.body }, ctx);
      if (typeof res.code === 'function') {
        res.code(out.status).headers!(out.headers).send(out.body);
      } else {
        res.status!(out.status).set!(out.headers);
        if (out.body === undefined) res.end!();
        else res.send(out.body);
      }
    }
  }
  const proto = McpController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'handle')!;
  // Version-neutral so URI versioning never moves the endpoint to /v1/mcp.
  Controller({ path: options.path ?? 'mcp', version: VERSION_NEUTRAL })(McpController);
  Inject(McpService)(McpController, undefined as never, 0);
  All()(proto, 'handle', descriptor);
  Req()(proto, 'handle', 0);
  Res()(proto, 'handle', 1);
  if (options.guards?.length) UseGuards(...options.guards)(McpController);
  return McpController;
}

/**
 * Adds an MCP endpoint to a NestJS app (Express or Fastify platform):
 *
 *   @Module({ imports: [McpModule.forRoot({ name: 'shop-api' })] })
 *
 * Remember to exclude the MCP path from your global prefix if you want it at
 * `/mcp`: `app.setGlobalPrefix('api', { exclude: ['mcp'] })`.
 */
export class McpModule {
  static forRoot(options: McpModuleOptions): DynamicModule {
    return {
      module: McpModule,
      global: true,
      imports: [DiscoveryModule],
      controllers: [createMcpController(options)],
      providers: [{ provide: MCP_MODULE_OPTIONS, useValue: options }, McpService],
      exports: [McpService],
    };
  }
}
Module({})(McpModule);
