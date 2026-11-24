import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const baseVersion = (JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }).version;
// CI sets APP_BUILD_NUMBER (GitHub run number), which increases with every deploy.
const buildNumber = process.env.APP_BUILD_NUMBER;
const appVersion = buildNumber ? `${baseVersion.split('.').slice(0, 2).join('.')}.${buildNumber}` : `${baseVersion}-dev`;

export default defineConfig({
  base: './',
  plugins: [{
    name: 'standalone-room-viewer',
    resolveId(id) {
      if (id === 'virtual:room-viewer-script') return '\0room-viewer-script';
    },
    async load(id) {
      if (id !== '\0room-viewer-script') return;
      const result = await build({ entryPoints: ['src/reports/standalone-room-viewer.ts'], bundle: true, minify: true, format: 'iife', platform: 'browser', write: false });
      return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
    },
  }],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
