# Contributing to mcp-expose

Thanks for your interest in improving mcp-expose. Bug reports, docs fixes, new framework adapters and
MCP features are all welcome.

## Getting started

```bash
git clone https://github.com/NITINKACHHADIYA/Node-MCP.git
cd node-mcp
nvm use            # Node 22 (see .nvmrc)
npm install
npm run build
npm test
```

## Useful scripts

| Script                                    | What it does                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                           | Build ESM + CJS + type definitions into `dist/`                                                                      |
| `npm test`                                | Unit and integration tests (vitest, real HTTP servers)                                                               |
| `npm run test:e2e`                        | Pack the library, install it into a fresh project per framework/version, drive each with the official MCP SDK client |
| `npm run typecheck`                       | Type-check `src`, `test` and `examples` (run `build` first)                                                          |
| `npm run lint` / `npm run lint:fix`       | ESLint                                                                                                               |
| `npm run format` / `npm run format:check` | Prettier                                                                                                             |
| `npm run check:package`                   | `publint` + `are-the-types-wrong` on the packed tarball                                                              |
| `npm run example:<name>`                  | Run an example: `express`, `fastify`, `koa`, `hono`, `nestjs`, `gateway`                                             |

## Project layout

- `src/core`: framework-agnostic MCP server, route→tool mapping, schemas and dispatchers. Keep it free of
  `node:*` imports (except `core/node.ts`) so it runs on edge runtimes.
- `src/<framework>`: one thin adapter per framework. An adapter only has to (1) find the marked routes,
  (2) call `createRouteTool(route, options, dispatcher)`, and (3) bridge its request/response to
  `server.handleHttp()`.
- `test/`: `assertAdapterContract()` in `test/helpers.ts` is the shared behaviour every adapter must pass.
- `e2e/`: developer-style tests. See [e2e/README.md](e2e/README.md).

## Adding a framework adapter

1. Add `src/<framework>/index.ts`, and add the entry to `tsup.config.ts`, `exports` and `typesVersions` in `package.json`.
2. Add the framework as an optional peer dependency.
3. Add `test/<framework>.test.ts` that runs `assertAdapterContract()`.
4. Add at least one `e2e/scenarios/<framework>-*` project.
5. Add a guide section to the README.

## Pull requests

- Keep PRs focused, and add tests for every behaviour change.
- Run `npm run lint`, `npm run format:check`, `npm test` and, for adapter or packaging changes, `npm run test:e2e`.
- Add a line under **Unreleased** in `CHANGELOG.md`.
- Use clear commit messages in the imperative mood ("Add Koa router prefix support").

## Releasing (maintainers)

1. Move the **Unreleased** changelog entries under a new version heading.
2. `npm version <patch|minor|major>` (creates the commit and the `vX.Y.Z` tag).
3. `git push --follow-tags`. The Release workflow tests, publishes to npm with provenance and creates the GitHub release.

By contributing you agree that your contributions are licensed under the MIT License and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
