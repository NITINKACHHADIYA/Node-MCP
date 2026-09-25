import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is used so NestJS tests get real `emitDecoratorMetadata` output.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['test/**/*.test.ts'], testTimeout: 20_000 },
});
