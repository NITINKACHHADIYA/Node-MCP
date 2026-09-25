# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Multi-version maintenance: `v<major>.x` maintenance branches, automatic npm dist-tags (`latest`,
  `latest-<major>`, `next`), one-click releases from any supported branch, label-driven backports.
  See RELEASING.md.

## [0.1.0] - 2026-09-25

### Added

- Framework-agnostic core: stateless MCP Streamable HTTP server (protocol 2024-11-05 → 2025-11-25),
  route→tool mapping, JSON Schema / zod / Standard Schema inputs, header forwarding, Origin validation.
- Adapters: NestJS (`@McpTool()`, `McpModule`, DTO → JSON Schema), Express (`mcpTool()`, `mountMcp()`),
  Fastify (`config.mcp`, route schemas reused), Koa (`mcpTool()`, `koaMcp()`), Hono (`mcpTool()`, `mountMcp()`).
- `toolsFromOpenApi()` and `createFetchDispatcher()` for standalone gateways in front of any HTTP API.
- `defineTool()` for code-only tools.
- End-to-end test suite covering NestJS 10/11/12, Express 4/5, Fastify 4/5, Koa 2/3, Hono and an OpenAPI gateway.

### Fixed

- Express 4: route discovery no longer touches the deprecated `app.router` getter.
- TypeScript projects using `moduleResolution: "node"` (classic `nest new`) can resolve subpath types.

[Unreleased]: https://github.com/NITINKACHHADIYA/Node-MCP/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NITINKACHHADIYA/Node-MCP/releases/tag/v0.1.0
