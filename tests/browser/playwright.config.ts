import { defineConfig } from '@playwright/test';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  retries: 1,
  workers: 3,
  use: {
    baseURL: 'http://localhost:9876',
    headless: true,
  },
  webServer: {
    command: `node "${path.resolve(__dirname, 'server.cjs')}"`,
    port: 9876,
    reuseExistingServer: true,
    timeout: 10000,
  },
  projects: [
    { name: 'chromium',  use: { browserName: 'chromium' } },
    { name: 'firefox',   use: { browserName: 'firefox' } },
    { name: 'webkit',    use: { browserName: 'webkit' } },
  ],
});
