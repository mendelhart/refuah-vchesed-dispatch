import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@rvc/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_API_URL ?? 'http://127.0.0.1:8080', changeOrigin: true } },
  },
  // `vite preview` serves the production build for the browser suite, and needs
  // the same proxy — otherwise every API call 404s against the static server.
  preview: {
    port: 4173,
    proxy: {
      '/api': { target: process.env.VITE_API_URL ?? 'http://127.0.0.1:8080', changeOrigin: true },
      '/webhooks': { target: process.env.VITE_API_URL ?? 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
