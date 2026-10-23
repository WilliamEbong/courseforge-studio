// an independent accessibility check (axe-core, WCAG 2.2 A/AA rules) of both editors and both
// published players, on the shipped samples. axe finds automated failures only; keyboard paths stay in their own specs.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../../packages/server/server.js';
import { publishWeb } from '../../packages/publisher/index.js';
import { normalize } from '../../packages/schema/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'a11y-token-0123456789abcdef';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
let server, base, root, out;
test.setTimeout(180_000); // axe runs the full rule set on large DOMs; the machine is shared

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-a11y-'));
  fs.cpSync(path.join(ROOT, 'samples'), root, { recursive: true, filter: (f) => !f.endsWith('.jsonl') && !f.endsWith('.scenario.json') });
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-a11y-pub-'));
  for (const name of ['lab-safety', 'lab-basics-lessons']) {
    const doc = normalize(JSON.parse(fs.readFileSync(path.join(root, `${name}.course.json`), 'utf8')));
    publishWeb(doc, path.join(out, name), { courseDir: root });
  }
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

async function expectNoViolations(page, where) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect.soft(summary, `${where}: axe violations`).toEqual([]);
}
const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');

test('editor: course picker, slides editor and lessons editor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?token=${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Courses' })).toBeVisible();
  await expectNoViolations(page, 'course picker');
  await page.goto(`${base}/?token=${TOKEN}#lab-safety`);
  await expect(page.locator('#stage .obj').first()).toBeVisible();
  await idle(page);
  await expectNoViolations(page, 'slides editor');
  await page.locator('#obj-o-w-intro').click();
  await expectNoViolations(page, 'slides editor with a selection');
  await page.goto(`${base}/?token=${TOKEN}#lab-basics-lessons`);
  await expect(page.locator('#lv-page')).toBeVisible();
  await idle(page);
  await expectNoViolations(page, 'lessons editor');
});

test('published players: slides and lessons', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(path.join(out, 'lab-safety', 'index.html')).href);
  await page.waitForLoadState('networkidle');
  await expectNoViolations(page, 'slides player');
  await page.goto(pathToFileURL(path.join(out, 'lab-basics-lessons', 'index.html')).href);
  await page.waitForLoadState('networkidle');
  await expectNoViolations(page, 'lessons player');
});
