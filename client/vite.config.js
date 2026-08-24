import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Lets the dev client call the API at /api without CORS or env juggling.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } }
  },
  build: { outDir: 'dist', sourcemap: false }
});
