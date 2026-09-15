import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@rvc/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts') } },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    // The suite runs against one real Postgres database. Parallel files would
    // fight over the same rows, so they run in sequence; within a file the
    // concurrency tests do their own real parallelism, which is the point.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
