import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standard React + Vite config. Builds to /dist (static files) — deploy that anywhere.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
});
