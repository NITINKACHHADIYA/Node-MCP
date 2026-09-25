# End-to-end tests

`npm run test:e2e` tests the library the way a developer uses it:

1. `npm pack`: the exact tarball that would be published.
2. For each folder in `scenarios/`, a fresh project is created in a temp dir and the tarball is
   installed together with the scenario's real framework dependencies from npm.
3. TypeScript scenarios are compiled with their own `tsc`, which checks the published `.d.ts` files.
4. The app is started as a separate process (`npm start`, `PORT` env var).
5. The official `@modelcontextprotocol/sdk` client connects and runs the checks in `contract.mjs`.

| Scenario               | What it covers                                                              |
| ---------------------- | --------------------------------------------------------------------------- |
| `express4-cjs`         | Express 4, CommonJS, auto-detected router mount path, express-rate-limit    |
| `express5-esm-ts`      | Express 5, strict TypeScript ESM, zod, `routers` option                     |
| `nestjs10-express-cjs` | NestJS 10, classic `nest new` tsconfig (CommonJS + node10 resolution), DTOs |
| `nestjs11-fastify-cjs` | NestJS 11 on Fastify, v11 tsconfig (nodenext), @nestjs/throttler            |
| `nestjs12-express-esm` | NestJS 12 (ESM-only), global prefix + URI versioning                        |
| `fastify4-cjs`         | Fastify 4, CommonJS, route JSON schemas, preHandler auth                    |
| `fastify5-esm-ts`      | Fastify 5, TypeScript ESM, @fastify/rate-limit, typed `app.mcpServer`       |
| `koa2-cjs`             | Koa 2, @koa/router 12, koa-bodyparser                                       |
| `koa3-esm`             | Koa 3, @koa/router 15, @koa/bodyparser, custom MCP path                     |
| `hono-node-esm-ts`     | Hono on @hono/node-server, bearer-auth, sub-app routing                     |
| `openapi-gateway-esm`  | Standalone gateway in front of a separate upstream API via OpenAPI          |

Run a subset with `npm run test:e2e -- nestjs koa`. Set `E2E_KEEP=1` to keep the generated projects.

To add a scenario, create a folder with a `package.json` that has a `start` script (and optionally `build`),
serve the shop API described at the top of `contract.mjs` on `process.env.PORT`, and optionally add an
`e2e.json` file (`description`, `mcpPath`, `rateLimit`).
