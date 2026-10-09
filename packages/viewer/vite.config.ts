import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:7420' },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
