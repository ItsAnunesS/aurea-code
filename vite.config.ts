import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
export default defineConfig({ clearScreen: false, plugins: [{
  name: 'pdfjs-local-assets',
  writeBundle() {
    for (const folder of ['cmaps', 'standard_fonts']) cpSync(resolve('node_modules/pdfjs-dist', folder), resolve('dist/pdfjs', folder), { recursive: true });
  },
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (request.url?.startsWith('/pdfjs/')) request.url = '/node_modules/pdfjs-dist/' + request.url.slice('/pdfjs/'.length);
      next();
    });
  },
}], server: { port: 1420, strictPort: true }, envPrefix: ['VITE_'], build: { target: 'es2022', rollupOptions: { input: { ide: 'index.html', updater: 'updater.html' } } } });
