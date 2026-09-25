/**
 * NestJS example. Needs decorator metadata, so run it with SWC:
 *   npm run build && node --import @swc-node/register/esm-register examples/nestjs/main.ts
 */
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const app = await NestFactory.create(AppModule);
app.setGlobalPrefix('api', { exclude: ['mcp'] }); // tools call /api/..., MCP stays at /mcp
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
await app.listen(3000);
console.log('API on http://localhost:3000/api, MCP on http://localhost:3000/mcp');
