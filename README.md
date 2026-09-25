# mcp-expose

**Make your existing Node.js API agent-ready in minutes.**
`mcp-expose` turns selected HTTP routes of your **NestJS, Express, Fastify, Koa or Hono** app into
[Model Context Protocol (MCP)](https://modelcontextprotocol.io) tools, so AI agents such as Claude, Cursor,
VS Code Copilot and ChatGPT can call them. Your existing **auth guards, DTO validation, rate limits and
logging keep working** because every tool call runs through your app's normal request pipeline.

```ts
// NestJS
@Get(':id')
@McpTool({ description: 'Get an order by id' })
findOne(@Param('id') id: string) { ... }

// Express / Koa / Hono
app.get('/orders/:id', mcpTool({ description: 'Get an order by id' }), auth, getOrder);

// Fastify
app.get('/orders/:id', { schema, config: { mcp: { description: 'Get an order by id' } } }, getOrder);
```

- One decorator or marker per route, then add the module/plugin. No wrapper code to write.
- Zero runtime dependencies. Dual ESM/CJS. Node ≥ 18, plus Bun, Deno and Workers for Hono.
- Speaks MCP Streamable HTTP (protocol `2024-11-05` → `2025-11-25`), stateless, so it scales horizontally and runs serverless.

---

## Table of contents

1. [Why this library?](#why-this-library)
2. [How it works](#how-it-works)
3. [Supported frameworks](#supported-frameworks)
4. [Installation](#installation)
5. [Framework guides](#framework-guides)
   - [NestJS](#nestjs) · [Express](#express) · [Fastify](#fastify) · [Koa](#koa) · [Hono](#hono) · [Any API via OpenAPI](#any-api-via-openapi-standalone-gateway)
6. [Connect an AI client](#connect-an-ai-client)
7. [Defining tool inputs (schemas)](#defining-tool-inputs-schemas)
8. [Configuration reference](#configuration-reference)
9. [Custom (non-HTTP) tools](#custom-non-http-tools)
10. [Security checklist](#security-checklist)
11. [Writing tools agents use well](#writing-tools-agents-use-well)
12. [Limitations and roadmap](#limitations-and-roadmap)
13. [Development](#development)

---

## Why this library?

Many companies now want their APIs to be "agent-ready". The usual approach is a separate, hand-written MCP
server that re-implements each endpoint as a tool:

| Hand-written MCP wrapper | `mcp-expose` |
| --- | --- |
| Duplicates every endpoint's input schema, auth and error handling | Reuses the route that already exists. The route is the tool. |
| Needs its own auth. The easy path is often one over-privileged API key | Forwards the caller's `Authorization`/cookies, so **your guards decide** per user |
| Validation logic drifts from the real API | Your `ValidationPipe`, Fastify schema, zod or Joi runs on every call |
| Rate limits and audit logs are bypassed or re-implemented | Every tool call is a real request through your middleware |
| A second service to deploy, version and monitor | Mounted at `/mcp` inside the app you already run |
| Tied to one framework | Same concepts for NestJS, Express, Fastify, Koa and Hono |

**Benefits for developers**

- **Minutes, not days.** Add `@McpTool()` to the endpoints you want to expose and import one module.
- **Single source of truth.** Schemas come from your DTOs, Fastify JSON schemas, zod or OpenAPI. Change the endpoint and the tool changes with it.
- **Secure by default.** Routes are opt-in. The app's own auth applies to each tool call. `Origin` checks protect against DNS rebinding.
- **Agent-friendly errors.** Your API's 400/401/404 responses are returned to the model as tool errors, so it can correct itself (for example "quantity must not be greater than 10").
- **Framework-agnostic core.** Moving from Express to Fastify, or to a NestJS monolith, keeps the same tool model.

## How it works

```
 AI client (Claude, Cursor, …)
        │  POST /mcp  {"method":"tools/call","params":{"name":"create_order","arguments":{…}}}
        │  Authorization: Bearer <user token>
        ▼
 ┌──────────────────────── your app ────────────────────────┐
 │  /mcp endpoint (mcp-expose)                               │
 │    1. finds the route behind "create_order"               │
 │    2. maps arguments → path params / query / JSON body    │
 │    3. forwards Authorization, Cookie, X-Api-Key, IP       │
 │    4. dispatches:  POST /orders  ────────────┐            │
 │                                              ▼            │
 │     middleware → auth guard → rate limit → validation → handler
 │                                              │            │
 │    5. HTTP response → MCP tool result ◄──────┘            │
 │       (2xx → content + structuredContent, 4xx/5xx → isError)
 └───────────────────────────────────────────────────────────┘
```

Dispatch uses the fastest option each framework supports safely:

- **Fastify** uses `fastify.inject()`, in process, with every hook, schema and plugin applied.
- **Hono** uses `app.request()`, in process, and runs on any runtime.
- **Express, Koa and NestJS** use a loopback HTTP request to the port the MCP call arrived on, so the full stack runs, including anything outside the framework such as a reverse proxy module.

Tools are discovered **lazily on the first MCP request**, so the order you register routes and the MCP endpoint rarely matters (Fastify is the exception, see its guide).

## Supported frameworks

| Framework | Import | How you mark a route | Schema source | Dispatch |
| --- | --- | --- | --- | --- |
| NestJS 10+ (Express or Fastify platform) | `mcp-expose/nestjs` | `@McpTool()` decorator | class-validator DTOs (+ `@ApiProperty` descriptions) | loopback |
| Express 4 / 5 | `mcp-expose/express` | `mcpTool()` middleware | options (JSON Schema / zod) | loopback |
| Fastify 4 / 5 | `mcp-expose/fastify` | `config: { mcp }` on the route | the route's own `schema` | `inject()` |
| Koa 2 / 3 + @koa/router | `mcp-expose/koa` | `mcpTool()` middleware | options | loopback |
| Hono 4 | `mcp-expose/hono` | `mcpTool()` middleware | options | `app.request()` |
| Any HTTP API (any language) | `mcp-expose` | OpenAPI `x-mcp: true` | OpenAPI document | `fetch` |

End-to-end tested (see [`e2e/`](e2e/README.md)) by installing the packed library into fresh projects and driving them with the official MCP SDK client:
NestJS 10 / 11 / 12 (Express and Fastify platforms, CommonJS and ESM), Express 4 / 5, Fastify 4 / 5, Koa 2 / 3, Hono 4 on Node, and an OpenAPI gateway.

## Installation

```bash
npm install mcp-expose
# or: pnpm add mcp-expose / yarn add mcp-expose / bun add mcp-expose
```

Framework packages are optional peer dependencies. Use the ones you already have.
For NestJS DTO → schema generation, `class-validator` should be installed. Most Nest apps already have it.

---

## Framework guides

Each guide follows the same three steps: **1) install, 2) mark routes, 3) mount the endpoint**. Then
[connect a client](#connect-an-ai-client).

### NestJS

**Step 1: import the module** (once, in your root module):

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { McpModule } from 'mcp-expose/nestjs';

@Module({
  imports: [
    McpModule.forRoot({
      name: 'orders-api',           // shown to the AI client
      version: '1.0.0',
      instructions: 'Tools for looking up and placing orders.',
      // path: 'mcp',               // default endpoint: /mcp
      // guards: [JwtAuthGuard],    // protect the MCP endpoint itself (tools/list too)
    }),
    OrdersModule,
  ],
})
export class AppModule {}
```

**Step 2: decorate the endpoints you want to expose:**

```ts
// orders.controller.ts
import { McpTool } from 'mcp-expose/nestjs';

export class CreateOrderDto {
  @IsString() sku!: string;
  @IsInt() @Min(1) @Max(10) quantity!: number;
  @IsString() @IsOptional() note?: string;
}

@Controller('orders')
@UseGuards(JwtAuthGuard)                 // ← still enforced for every tool call
export class OrdersController {
  @Get(':id')
  @McpTool({ description: 'Get one order by its id.' })
  findOne(@Param('id', ParseIntPipe) id: number) { … }

  @Post()
  @McpTool({ name: 'create_order', description: 'Create an order. quantity must be 1-10.' })
  create(@Body() dto: CreateOrderDto) { … }   // ← input schema generated from the DTO

  @Post(':id/refund')                    // ← no @McpTool: invisible to agents
  refund(@Param('id') id: string) { … }
}
```

The generated tool input for `create_order`:

```json
{
  "type": "object",
  "properties": {
    "sku": { "type": "string" },
    "quantity": { "type": "integer", "minimum": 1, "maximum": 10 },
    "note": { "type": "string" }
  },
  "required": ["sku", "quantity"]
}
```

**Step 3: bootstrap as usual:**

```ts
// main.ts
const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api', { exclude: ['mcp'] });  // optional: keep MCP at /mcp
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
await app.listen(3000);   // MCP: http://localhost:3000/mcp
```

Notes

- Default tool names are `<controller>_<method>` in snake_case, for example `orders_find_one`. Set `name` to override.
- The global prefix (`/api`) and URI versioning (`/v1`) are detected automatically. The MCP endpoint is version-neutral.
- Works with `@nestjs/platform-express` and `@nestjs/platform-fastify`.
- Inject `McpService` to add tools at runtime: `mcpService.server.addTool(defineTool({...}))`.
- Global guards also apply to `/mcp`. If you use a global JWT guard, MCP clients must send a token, which is usually what you want. Mark the endpoint public with your own decorator mechanism if not.

### Express

```ts
import express from 'express';
import { z } from 'zod';
import { mcpTool, mountMcp } from 'mcp-expose/express';

const app = express();
app.use(express.json());
app.set('trust proxy', 'loopback');   // req.ip = real agent IP for tool calls (rate limiting)

// Step 1: add mcpTool() as the FIRST handler of the routes to expose
app.get('/products', mcpTool({
  name: 'search_products',
  description: 'Search the product catalog by name.',
  query: { type: 'object', properties: { q: { type: 'string' } } },
}), searchProducts);

app.post('/orders', mcpTool({
  name: 'create_order',
  description: 'Place an order.',
  body: z.object({ productId: z.string(), quantity: z.number().int().min(1) }),  // zod works too
}), requireAuth, rateLimit, createOrder);

// Step 2: mount the endpoint (before or after the routes)
mountMcp(app, { name: 'shop-api', version: '1.0.0' });

app.listen(3000);   // MCP: http://localhost:3000/mcp
```

**Routers mounted with a path:** Express 5 does not record mount paths, so pass them explicitly.
Express 4 detects them automatically.

```ts
const api = express.Router();
api.get('/orders', mcpTool({ description: 'List orders' }), listOrders);
app.use('/api', api);

mountMcp(app, { name: 'shop-api', routers: { '/api': api } });
```

**No-touch mode:** expose routes without editing them:

```ts
mountMcp(app, {
  name: 'shop-api',
  routes: [{ method: 'GET', path: '/orders/:id', description: 'Get an order' }],
});
```

### Fastify

```ts
import Fastify from 'fastify';
import { fastifyMcp } from 'mcp-expose/fastify';

const app = Fastify();

// Step 1: register the plugin BEFORE your routes (it listens to onRoute)
await app.register(fastifyMcp, { name: 'todo-api', version: '1.0.0' });

// Step 2: add `config.mcp` to routes. Their JSON `schema` becomes the tool schema.
app.post('/todos', {
  schema: {
    body: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, description: 'What needs doing' } },
      required: ['title'],
    },
  },
  config: { mcp: { name: 'add_todo', description: 'Add a todo item.' } },   // or `mcp: true`
}, addTodo);

await app.listen({ port: 3000 });   // MCP: http://localhost:3000/mcp
```

Protect the MCP endpoint itself with Fastify hooks: `register(fastifyMcp, { name, routeOptions: { onRequest: app.authenticate } })`.
The server is available as `app.mcpServer`.

### Koa

```ts
import Koa from 'koa';
import Router from '@koa/router';
import { koaMcp, mcpTool } from 'mcp-expose/koa';

const app = new Koa();
const router = new Router({ prefix: '/api' });

// Step 1: mark routes
router.get('/weather/:city', mcpTool({ description: 'Current weather for a city.' }), getWeather);

// Step 2: mount the endpoint and list the routers to scan
app.use(koaMcp({ name: 'weather-api', routers: [router] }));
app.use(router.routes());

app.listen(3000);   // MCP: http://localhost:3000/mcp
```

Set `app.proxy = true` if your rate limiter keys on `ctx.ip`, so the forwarded agent IP is used.

### Hono

Works on Node, Bun, Deno, Cloudflare Workers and Vercel Edge. Tool calls use `app.request()`, so no network hop is involved.

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { mcpTool, mountMcp } from 'mcp-expose/hono';

const app = new Hono();

app.post('/notes',
  mcpTool({ name: 'create_note', description: 'Save a note.', body: z.object({ text: z.string() }) }),
  bearerAuth({ token }),
  async (c) => c.json(await saveNote(await c.req.json()), 201));

mountMcp(app, { name: 'notes-api' });

export default app;   // MCP: https://<your-worker>/mcp
```

### Any API via OpenAPI (standalone gateway)

Put an MCP gateway in front of **any** HTTP API, whatever language it is written in, using its OpenAPI 3 document.
By default only operations marked `x-mcp: true` are exposed. You can also pass an `include` filter.

```ts
import express from 'express';
import { createFetchDispatcher, toolsFromOpenApi } from 'mcp-expose';
import { mountMcp } from 'mcp-expose/express';

const spec = await fetch('https://api.example.com/openapi.json').then((r) => r.json());
const tools = toolsFromOpenApi(spec, createFetchDispatcher({ baseUrl: 'https://api.example.com' }), {
  include: ({ method }) => method === 'get',   // e.g. only read-only operations
});

const app = express();
mountMcp(app, { name: 'example-gateway', tools });
app.listen(3000);
```

This also works with `@nestjs/swagger`, `@fastify/swagger`, tsoa and hono-openapi documents. Pass a dereferenced document, because `$ref`s are not resolved.

---

## Connect an AI client

Start your app, then point a client at `http://localhost:3000/mcp`. Pass the same credentials a normal API
client would use. They are forwarded to your routes.

**Claude Code**

```bash
claude mcp add --transport http shop-api http://localhost:3000/mcp \
  --header "Authorization: Bearer <token>"
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "shop-api": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**VS Code (Copilot agent mode)** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "shop-api": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${input:token}" }
    }
  },
  "inputs": [{ "id": "token", "type": "promptString", "description": "API token", "password": true }]
}
```

**Claude Desktop.** For a deployed server, add it under *Settings → Connectors* using its public URL.
For a local server, bridge it with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shop-api": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3000/mcp", "--header", "Authorization: Bearer ${API_TOKEN}"],
      "env": { "API_TOKEN": "<token>" }
    }
  }
}
```

**Debug with MCP Inspector**

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: http://localhost:3000/mcp
```

**curl smoke test**

```bash
curl -s localhost:3000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Defining tool inputs (schemas)

The agent sees **one flat object** of arguments. mcp-expose maps each argument back to the right place:

| Argument | Sent as |
| --- | --- |
| name matches a path placeholder (`:id`, `{id}`) | path segment (URL-encoded) |
| declared in `query` | query string |
| declared in `body` | JSON body property |
| undeclared, route is `GET`/`DELETE` | query string |
| undeclared, route is `POST`/`PUT`/`PATCH` | JSON body property |
| `body` is a non-object schema (for example an array) | the whole body, under the `body` argument |

Every schema option accepts:

- a plain **JSON Schema** object,
- a **zod 4** schema (`z.object({...})`),
- any **Standard Schema** library with JSON Schema export (valibot, arktype, …). These are also validated before the request is sent.

Sources, from highest to lowest precedence:

1. `input` in the tool options: the full schema, used as is.
2. `params` / `query` / `body` in the tool options.
3. Framework metadata: NestJS DTOs and `@Param`/`@Query` types, or Fastify route `schema`.
4. Path placeholders, as string parameters.

Your app's own validation always runs as well. The schema tells the agent what to send, and your API decides what it accepts.

## Configuration reference

### Server options (all adapters)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | required | Server name shown to clients. |
| `version` | `string` | `'1.0.0'` | Server version. |
| `instructions` | `string` | none | Guidance for the model on how to use the tools together. |
| `path` | `string` | `'/mcp'` | Endpoint path. |
| `allowedOrigins` | `string[] \| '*'` | `[]` | Browser origins allowed to call the endpoint. Requests without `Origin` (CLIs, IDEs, servers) are always allowed. |
| `forwardHeaders` | `string[]` | `['authorization','cookie','x-api-key','accept-language']` | Headers copied from the MCP request to the internal API call. |
| `maxResponseChars` | `number` | `100000` | Longer API responses are truncated before reaching the model. |
| `tools` | `McpToolDefinition[]` | `[]` | Extra hand-written tools. |
| `baseUrl` | `string` | loopback | *Express/Koa/Nest.* Where internal calls go. Set it for HTTPS with self-signed certs, unix sockets, or a separate API host. |
| `routes` | `{method,path,...}[]` | `[]` | *Express/Koa/Hono.* Expose routes without editing them. |
| `routers` | see guide | none | *Express:* `{ '/prefix': router }`. *Koa:* `[router]`. |
| `middleware` | `Middleware[]` | `[]` | *Express.* Middleware in front of `/mcp`, such as auth. |
| `guards` | `CanActivate[]` | `[]` | *NestJS.* Guards on the MCP controller. |
| `pathPrefix` | `string` | none | *NestJS.* Extra prefix for tool routes. Global prefix and URI versioning are automatic. |
| `routeOptions` | `object` | none | *Fastify.* Extra route options for `/mcp`, such as `onRequest` hooks. |

### Tool options (`@McpTool()`, `mcpTool()`, `config.mcp`)

| Option | Description |
| --- | --- |
| `name` | Tool name (`[A-Za-z0-9_-]`, max 64). Default is derived from the route, e.g. `get_users_by_id`. |
| `description` | **The most important field.** Tells the model what the tool does and when to use it. |
| `title` | Human-friendly display name. |
| `input` / `params` / `query` / `body` | Schemas, see [above](#defining-tool-inputs-schemas). |
| `annotations` | MCP hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Defaults come from the HTTP method (GET → read-only, DELETE → destructive). |
| `headers` | Static headers added to the internal request. |

Each internal request also carries `X-Mcp-Tool: <tool name>`, so you can log or meter agent traffic separately.

## Custom (non-HTTP) tools

Not everything needs a route:

```ts
import { defineTool } from 'mcp-expose';
import { z } from 'zod';

const convert = defineTool({
  name: 'convert_currency',
  description: 'Convert an amount between currencies using today\'s rate.',
  input: z.object({ amount: z.number(), from: z.string().length(3), to: z.string().length(3) }),
  handler: async ({ amount, from, to }, ctx) => ({ result: await fx.convert(amount, from, to) }),
});

mountMcp(app, { name: 'shop-api', tools: [convert] });
```

Handlers can return a string, any JSON value, or a full MCP `ToolResult`. `ctx.headers` holds the MCP request's headers, so you can authenticate there too.

## Security checklist

- **Opt-in only.** Nothing is exposed unless you mark it. Review marked routes the way you review a public API, because an LLM can call them with any arguments.
- **Use per-user credentials.** Clients send their own token, the token is forwarded, and your guards authorise the call. Avoid one shared super-token.
- **Protect discovery too** if tool names are sensitive (`guards`, `middleware`, `routeOptions`).
- **Rate limits and IPs:** the agent IP is sent as `X-Forwarded-For`. For loopback adapters, trust loopback only: Express `app.set('trust proxy', 'loopback')`, Koa `app.proxy = true` behind a proxy that overwrites the header, Nest (Express) `app.set('trust proxy', 'loopback')`. Fastify `inject()` sets the IP directly.
- **Browser access:** keep `allowedOrigins` empty unless a browser app must call `/mcp` directly.
- **Annotations are hints, not security.** A `readOnlyHint` never prevents a call. Enforce permissions in your API.
- **Destructive actions:** clients may use `destructiveHint` to decide when to ask the user for confirmation. Keep it accurate, and require stronger auth for dangerous routes.
- **Response size:** tune `maxResponseChars`, and prefer endpoints that paginate.

## Writing tools agents use well

- Describe **when** to use the tool, not only what it does: *"Search products by name. Use this before `create_order` to find a valid `productId`."*
- Document units, formats and limits in schema `description`s (`"price in cents"`, `"ISO 8601 date"`).
- Prefer a few task-shaped tools (`search_orders`) over many CRUD primitives.
- Return clear 4xx messages. They go straight to the model, which uses them to retry correctly.
- Use `instructions` on the server for cross-tool workflow hints.

## Limitations and roadmap

Current scope (v0.1):

- Stateless Streamable HTTP with JSON responses. No server-initiated SSE stream or sessions. The spec allows this, and it keeps the server horizontally scalable.
- Tools only. `resources/list` and `prompts/list` return empty lists.
- NestJS: URI versioning is detected. Header and media-type versioning need `headers` on the tool.
- Express 5 routers mounted with a path must be listed in `routers`.

Planned:

- OAuth 2.1 protected-resource metadata (RFC 9728) helpers for remote MCP auth
- Adapters for Hapi, AdonisJS and Elysia
- Streaming long-running responses over SSE
- CLI to preview generated tools (`npx mcp-expose inspect`)
- Resources from GET routes, and prompts

Contributions are welcome. See [Development](#development).

## Development

```bash
npm install
npm test            # vitest: core + all five adapters (real servers, real HTTP)
npm run test:e2e    # pack → install into 11 fresh framework projects → official MCP SDK client
npm run typecheck
npm run build       # ESM + CJS + .d.ts into dist/

# run an example (after npm run build)
npm run example:express     # or example:fastify / example:koa / example:hono / example:nestjs
```

Project layout:

```
src/
  core/        framework-agnostic: MCP JSON-RPC server, route→tool mapping, schemas, dispatchers
  express/     mcpTool() + mountMcp()
  nestjs/      @McpTool() + McpModule + DTO → JSON Schema
  fastify/     fastifyMcp plugin (config.mcp)
  koa/         mcpTool() + koaMcp()
  hono/        mcpTool() + mountMcp()
examples/      runnable apps for every framework + an OpenAPI gateway
e2e/           developer-style end-to-end tests (one project per framework/version)
test/          one shared behavioural contract, verified against every adapter
```

Adding an adapter: find the marked routes, then call `createRouteTool(route, options, dispatcher)` and
`server.handleHttp()`. Reuse `test/helpers.ts#assertAdapterContract` to test it.

## License

MIT © Nitin Kachhadiya
