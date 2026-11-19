import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

const baseVersion = (JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }).version;
// CI sets APP_BUILD_NUMBER (GitHub run number), which increases with every deploy.
const buildNumber = process.env.APP_BUILD_NUMBER;
const appVersion = buildNumber ? `${baseVersion.split('.').slice(0, 2).join('.')}.${buildNumber}` : `${baseVersion}-dev`;

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  test: {
    environment: 'jsdom',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
