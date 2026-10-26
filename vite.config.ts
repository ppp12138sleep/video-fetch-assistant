import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = resolve(import.meta.dirname, 'src');

export default defineConfig({
  root,
  publicDir: resolve(import.meta.dirname, 'public'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(root, 'shared'),
      '@content': resolve(root, 'content'),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        background: resolve(root, 'background/service-worker.ts'),
        offscreen: resolve(root, 'offscreen/index.html'),
        preview: resolve(root, 'preview/index.html'),
        options: resolve(root, 'options/index.html'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
