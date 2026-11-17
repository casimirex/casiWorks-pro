import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // The local library server (npm run server); /api/ itself is the generated API reference
    proxy: { '/api/v1': 'http://127.0.0.1:5180' },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  build: {
    // three.js alone is ~670 kB minified; it ships as its own long-cached vendor chunk
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Split heavy vendor libraries into separately cached chunks
        codeSplitting: {
          groups: [
            { name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/, priority: 30 },
            { name: 'r3f', test: /[\\/]node_modules[\\/]@react-three[\\/]/, priority: 20 },
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler|zustand|immer)[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  // The FEA solver worker is an ES module (it imports three.js and the engine)
  worker: { format: 'es' },
  optimizeDeps: {
    include: ['three', 'zustand', 'immer'],
  },
});
