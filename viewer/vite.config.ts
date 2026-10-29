import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Relative asset paths: the built site works from any sub-path (GitHub Pages project site)
  base: './',
  // scripts/build_site.sh leaves out public/ (local test scenes) and adds one scene itself
  publicDir: process.env.NS_SITE_BUILD ? false : 'public',
  resolve: {
    alias: {
      '@sparkjsdev/spark': path.resolve(__dirname, 'node_modules/@sparkjsdev/spark'),
    },
  },
  test: {
    include: ['../tests/viewer/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    globals: true,
    server: {
      deps: {
        inline: ['@sparkjsdev/spark'],
      },
    },
  },
});
