import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@rvc/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
