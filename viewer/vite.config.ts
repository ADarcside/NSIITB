import { defineConfig } from 'vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// AR guide page (ar.html, src/ar/): built only when VITE_AR=1, so a normal build is unchanged
const AR_ON = process.env.VITE_AR === '1';

/** AR builds: copies the AR page's offline worker (src/ar/ar_sw.js) to ar-sw.js next to ar.html */
const arOfflineWorker = {
  name: 'namma-ar-offline-worker',
  apply: 'build' as const,
  generateBundle(this: { emitFile(f: { type: 'asset'; fileName: string; source: string }): void }) {
    this.emitFile({ type: 'asset', fileName: 'ar-sw.js', source: readFileSync(path.resolve(__dirname, 'src/ar/ar_sw.js'), 'utf8') });
  },
};

export default defineConfig({
  // Relative asset paths: the built site works from any sub-path (GitHub Pages project site)
  base: './',
  // scripts/build_site.sh leaves out public/ (local test scenes) and adds one scene itself
  publicDir: process.env.NS_SITE_BUILD ? false : 'public',
  ...(AR_ON
    ? {
        plugins: [arOfflineWorker],
        build: {
          rolldownOptions: {
            input: {
              main: path.resolve(__dirname, 'index.html'),
              ar: path.resolve(__dirname, 'ar.html'),
            },
          },
        },
      }
    : {}),
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
