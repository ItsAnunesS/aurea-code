import { defineConfig } from 'vite';
export default defineConfig({ clearScreen: false, server: { port: 1420, strictPort: true }, envPrefix: ['VITE_'], build: { target: 'es2022', rollupOptions: { input: { ide: 'index.html', updater: 'updater.html' } } } });
