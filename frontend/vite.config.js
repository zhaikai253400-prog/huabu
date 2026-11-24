import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [vue()],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:17890',
      '/media': 'http://127.0.0.1:17890',
      '/thumb': 'http://127.0.0.1:17890',
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../web/dist'),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
});
