// long-duration, multi-device learner runs on published packages. A 100-slide course and a
// 60-lesson course (both scaffolded with outline.add) are played start to finish at 768 px, and their pages are checked
// for horizontal scroll at 375, 768 and 1440 px. Every non-local request is aborted and must never be attempted.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { seededRng } from '../../packages/runtime/index.js';

const WIDTHS = [[375, 812], [768, 1024], [1440, 900]];
const outline = (sections, items) => ({ sections: Array.from({ length: sections }, (_, s) => ({ title: `Part ${s + 1}`, items: Array.from({ length: items }, (_, i) => ({
  title: `Topic ${s * items + i + 1}`, text: `Body text for topic ${s * items + i + 1}. `.repeat(6), bullets: Array.from({ length: 8 }, (_, b) => `Point ${b + 1}`),
})) })) });
function build(mode, sections, items) {
  const first = mode === 'lessons' ? { cmd: 'course.set', args: { mode } } : { cmd: 'player.set', args: { resume: 'never' } }; // each load starts fresh
  const cmds = [first, { cmd: 'outline.add', args: outline(sections, items) }];
  const r = applyAll(emptyCourse({ id: `long-${mode}`, title: `Long ${mode} course` }), cmds, { rng: seededRng(11) });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cf-e2e-long-${mode}-`));
  publishWeb(r.doc, dir);
  expect(validatePackage(dir)).toEqual([]);
  return pathToFileURL(path.join(dir, 'index.html')).href;
}

let requests, errors;
test.beforeEach(async ({ context, page }) => {
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => r.abort());
  requests = []; errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
});
test.afterEach(async () => {
  expect(requests.filter((u) => !/^(file:|data:|blob:|http:\/\/127\.0\.0\.1[:/])/.test(u)), 'non-local requests').toEqual([]);
  expect(errors, 'page/console errors').toEqual([]);
});
const noHScroll = async (page, w, what) => expect(await page.evaluate(() => document.documentElement.scrollWidth), `${w}px ${what}`).toBeLessThanOrEqual(w);

test('100-slide course: played to the last slide at 768 px; the stage fits at 375, 768 and 1440', async ({ page }) => {
  test.setTimeout(120000);
  const url = build('slides', 10, 10);
  for (const [w, h] of WIDTHS) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(url);
    await expect(page.locator('.cf-progress')).toHaveText('1 / 100');
    await noHScroll(page, w, 'slide 1');
    const box = await page.locator('.cf-frame').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(w);
  }
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(url);
  const next = page.getByRole('button', { name: 'Next', exact: true });
  for (let i = 2; i <= 100; i++) {
    await next.click();
    await expect(page.locator('.cf-progress')).toHaveText(`${i} / 100`);
  }
  await expect(page.getByText('Topic 100', { exact: true }).first()).toBeVisible();
  await noHScroll(page, 768, 'slide 100');
});

test('60-lesson course: every lesson completed at 768 px reaches 100%; no horizontal scroll at 375, 768 and 1440', async ({ page }) => {
  test.setTimeout(120000);
  const url = build('lessons', 6, 10);
  for (const [w, h] of WIDTHS) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(url);
    await page.getByRole('button', { name: 'Start course' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Topic 1' })).toBeVisible();
    await noHScroll(page, w, 'lesson 1');
    await page.goto(url + '#/');
    const over = page.getByRole('button', { name: 'Start over' });
    if (await over.isVisible()) await over.click(); // the next width starts without saved progress
  }
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(url);
  await page.getByRole('button', { name: 'Start course' }).click();
  for (let i = 1; i <= 60; i++) {
    await expect(page.getByRole('heading', { level: 1, name: `Topic ${i}`, exact: true })).toBeVisible();
    await page.locator('.cfl-end').scrollIntoViewIfNeeded();
    if (i < 60) await page.getByRole('button', { name: /Next lesson/ }).click();
  }
  await expect(page.getByText('100% complete')).toBeVisible();
  await noHScroll(page, 768, 'lesson 60');
});
