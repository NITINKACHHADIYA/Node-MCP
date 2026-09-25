# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-09-25

First stable release. The public API (`mcp-expose` and `mcp-expose/<framework>` exports, tool and server
options, default tool naming) now follows Semantic Versioning.

### Added

- Framework-agnostic core: stateless MCP Streamable HTTP server (protocol 2024-11-05 → 2025-11-25),
  route→tool mapping, JSON Schema / zod / Standard Schema inputs, auth-header forwarding, Origin validation.
- Adapters, each supporting the current and two previous framework majors:
  - **NestJS** 10 / 11 / 12: `@McpTool()`, `McpModule.forRoot()` / `forRootAsync()`, `McpService`,
    class-validator DTO → JSON Schema, global prefix and URI versioning detection, Express and Fastify platforms.
  - **Express** 3 / 4 / 5: `mcpTool()`, `mountMcp()`, nested routers.
  - **Fastify** 3 / 4 / 5: `fastifyMcp` plugin with `config.mcp`; route JSON schemas reused; `inject()` dispatch.
  - **Koa** 1 / 2 / 3: `mcpTool()`, `mountMcp()`, `koaMcp()`; `mcpToolLegacy()` / `koaMcpLegacy()` for Koa 1.
  - **Hono** 2 / 3 / 4: `mcpTool()`, `mountMcp()`; in-process `app.request()` dispatch on any runtime.
  - **AdonisJS** 6 / 7: `.mcp()` route macro, `mcpTool()`, `mountMcp()`; VineJS 4 validators usable as schemas.
- `toolsFromOpenApi()` and `createFetchDispatcher()` for standalone gateways in front of any HTTP API.
- `defineTool()` for code-only tools.
- Node.js 20, 22 and 24 support.
- End-to-end suite: 18 real projects (every supported framework major) driven by the official MCP SDK client.
- Multi-version maintenance: `v<major>.x` branches, automatic npm dist-tags, one-click releases and
  label-driven backports (see RELEASING.md).

### Security

- Path parameters that are empty, `.` or `..` are rejected, so an agent cannot use them to reach routes
  that were never exposed as tools (for example `/orders/../admin`).

[Unreleased]: https://github.com/NITINKACHHADIYA/Node-MCP/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/NITINKACHHADIYA/Node-MCP/releases/tag/v1.0.0
