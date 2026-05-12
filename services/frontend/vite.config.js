import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    proxy: {
      '/digitizer': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/spotify': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
