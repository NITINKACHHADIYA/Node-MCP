import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'express/index': 'src/express/index.ts',
    'nestjs/index': 'src/nestjs/index.ts',
    'fastify/index': 'src/fastify/index.ts',
    'koa/index': 'src/koa/index.ts',
    'hono/index': 'src/hono/index.ts',
    'adonisjs/index': 'src/adonisjs/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  splitting: false,
  external: [/^@nestjs\//, /^@adonisjs\//, 'class-validator', 'fastify', 'express', 'koa', 'hono'],
});
