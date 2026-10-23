// T5 design audit: on a phone the slide stage is scaled to about a quarter, so a question form drawn inside it had
// ~8 px text and ~20 px targets. Form questions now sit under the stage at reading size; desktop keeps them on the slide.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publishWeb } from '../../packages/publisher/index.js';
import { normalize } from '../../packages/schema/index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let url;
test.beforeAll(() => {
  const doc = normalize(JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/lab-safety.course.json'), 'utf8')));
  doc.player.resume = 'never';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-e2e-phoneq-'));
  publishWeb(doc, dir, { courseDir: path.join(ROOT, 'samples') });
  url = pathToFileURL(path.join(dir, 'index.html')).href;
});
test.beforeEach(async ({ context }) => { await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => r.abort()); });

async function openQuestion(page) {
  await page.goto(url);
  const toggle = page.getByRole('button', { name: 'Menu' });
  await expect(page.locator('.cf-progress')).toHaveText(/^1 \//);
  const nav = page.getByRole('navigation', { name: 'Course menu' });
  if (!(await nav.isVisible())) await toggle.click(); // a sidebar on desktop, an overlay on phones
  await nav.getByRole('button', { name: /Question 1/ }).click();
  return page.locator('.cf-choice').first();
}

test('phone: question choices are readable, 44 px+ targets, no horizontal scroll; answering still works', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  const choice = await openQuestion(page);
  const box = await choice.boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await choice.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole('radio', { name: 'Goggles' }).check();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('desktop: the question form stays on the slide', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const choice = await openQuestion(page);
  expect(await choice.evaluate((el) => !!el.closest('.cf-stage'))).toBe(true);
});
