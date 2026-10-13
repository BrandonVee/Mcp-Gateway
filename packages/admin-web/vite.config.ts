import { fileURLToPath } from 'node:url';
import tsconfig from '../../tsconfig.base.json';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxy = {
  '/api': {
    target: process.env.ADMIN_API_TARGET ?? 'http://localhost:9001',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
  '/gateway': {
    target: process.env.GATEWAY_TARGET ?? 'http://localhost:8000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/gateway/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  // One alias map for the editor, tsx scripts, Vite and server bundles.
  resolve: {
    alias: Object.entries(tsconfig.compilerOptions.paths).map(([name, [target]]) => ({
      find: name.slice(0, -2),
      replacement: fileURLToPath(new URL(`../../${target.slice(0, -2)}`, import.meta.url)),
    })),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy,
  },
  preview: { proxy },
});
