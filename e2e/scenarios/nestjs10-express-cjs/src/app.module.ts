import { Module } from '@nestjs/common';
import { McpModule } from 'mcp-expose/nestjs';
import { DebugController, OrdersController, ProductsController } from './shop.controller.js';
import { jwtVerifier, type VerifyTokenContext } from 'mcp-expose/oauth';

// OAuth mode: e2e/run.mjs runs every scenario a second time with MCP_OAUTH_RESOURCE set.
// `e2e-token` stays valid (the routes' own auth expects it); other tokens must be JWTs signed by the test issuer.
const oauthResource = process.env.MCP_OAUTH_RESOURCE;
const verifyJwt = oauthResource
  ? jwtVerifier({ issuer: 'https://auth.e2e.test', jwks: JSON.parse(process.env.MCP_OAUTH_JWKS!) })
  : undefined;
const oauth = oauthResource
  ? {
      resource: oauthResource,
      authorizationServers: ['https://auth.e2e.test'],
      requiredScopes: ['mcp'],
      verifyToken: (token: string, ctx: VerifyTokenContext) =>
        token === 'e2e-token' ? { token, scopes: ['mcp'] } : verifyJwt!(token, ctx),
    }
  : undefined;

@Module({
  imports: [McpModule.forRoot({ name: 'shop-api', version: '1.0.0', oauth })],
  controllers: [ProductsController, OrdersController, DebugController],
})
export class AppModule {}
