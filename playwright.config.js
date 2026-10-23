// E2E tests use the installed Google Chrome (no browser download). Each spec blocks non-local requests itself
// (context.route) and asserts none were attempted.
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  expect: { timeout: 10000 }, // 80+ specs on a shared machine: a cold editor load can pass 5 s
  workers: 2, // timing-sensitive player specs (animations, media, SCORM resume) flake with 4 workers here
  use: { channel: 'chrome', headless: true, viewport: { width: 1280, height: 800 } },
  reporter: 'list',
});
