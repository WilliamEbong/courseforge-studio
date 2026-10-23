// SC-2: theme presets in both published players (computed colours at 375 and 1440, no horizontal scroll
// presets as explicit schemes under prefers-color-scheme) and the editors' Theme control (one undoable theme.apply per
// choice; the saved file equals the command result). Every non-local request is aborted and must never be attempted.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse, normalize, serialize } from '../../packages/schema/index.js';
import { PRESETS, FONTS } from '../../packages/schema/themes.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, '.tmp');
const SAMPLE = normalize(JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/lab-basics-lessons.course.json'), 'utf8')));
const C = PRESETS.charcoal.tokens;
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const ok = (doc, cmds) => { const r = applyAll(doc, cmds); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r.doc; };

const slidesCourse = (preset) => ok(emptyCourse({ id: `themed-${preset}`, title: 'Themed slides' }), [
  { cmd: 'slide.add', args: { id: 's-1', title: 'Welcome', objects: [
    { id: 'o-title', type: 'text', x: 80, y: 60, w: 1120, h: 80, text: 'A themed course', style: { fontSize: 44, bold: true } },
    { id: 'o-go', type: 'button', x: 80, y: 520, w: 260, h: 64, text: 'Next step' }] } },
  { cmd: 'slide.add', args: { id: 's-2', title: 'Second' } },
  ...(preset === 'auto' ? [] : [{ cmd: 'theme.apply', args: { preset } }]),
]);
const dirs = {};
test.beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-e2e-themes-'));
  const courseDir = path.join(base, 'course');
  fs.mkdirSync(path.join(courseDir, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'samples/assets/lab-bench.svg'), path.join(courseDir, 'assets/lab-bench.svg'));
  for (const p of ['charcoal', 'light', 'auto']) { dirs[p] = path.join(base, p); publishWeb(slidesCourse(p), dirs[p], { courseDir }); }
  dirs.lessons = path.join(base, 'lessons');
  publishWeb(ok(SAMPLE, [{ cmd: 'theme.apply', args: { preset: 'charcoal', font: 'serif' } }]), dirs.lessons, { courseDir });
  for (const d of Object.values(dirs)) expect(validatePackage(d)).toEqual([]);
  fs.mkdirSync(SHOTS, { recursive: true });
});

let requests, errors;
test.beforeEach(async ({ context, page }) => {
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => r.abort());
  requests = []; errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
});
test.afterEach(() => {
  expect(requests.filter((u) => !/^(file:|data:|blob:|http:\/\/127\.0\.0\.1[:/])/.test(u)), 'non-local requests').toEqual([]);
  expect(errors, 'page/console errors').toEqual([]);
});

const open = (page, dir) => page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
const css = (loc, prop) => loc.evaluate((el, p) => getComputedStyle(el)[p], prop);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);

for (const [w, h] of [[1440, 900], [375, 812]]) {
  test(`slides player with the charcoal preset at ${w}: chrome, stage and buttons use the preset colours`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await open(page, dirs.charcoal);
    await expect(page.getByText('A themed course')).toBeVisible();
    expect(await css(page.locator('.cf-player'), 'backgroundColor')).toBe(rgb(C.bg));
    expect(await css(page.locator('.cf-bar'), 'backgroundColor')).toBe(rgb(C.surface));
    expect(await css(page.locator('.cf-title'), 'color')).toBe(rgb(C.ink));
    const next = page.locator('.cf-nav .cf-btn.cf-primary').first();
    expect(await css(next, 'backgroundColor')).toBe(rgb(C.accent));
    expect(await css(next, 'color')).toBe(rgb(C['accent-ink']));
    expect(await css(page.locator('.cf-stage'), 'backgroundColor')).toBe(rgb(C['stage-bg']));
    expect(await css(page.getByRole('button', { name: 'Next step' }), 'backgroundColor')).toBe(rgb(C['stage-accent']));
    expect(await noHScroll(page)).toBe(true);
    await page.screenshot({ path: path.join(SHOTS, `theme-slides-charcoal-${w}.png`) });
  });

  test(`lessons player with charcoal and the serif font at ${w}: page, outline, buttons and type use the preset`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await open(page, dirs.lessons);
    const root = page.locator('.cfl');
    await expect(page.getByRole('heading', { level: 1, name: SAMPLE.title })).toBeVisible();
    expect(await css(root, 'backgroundColor')).toBe(rgb(C.bg));
    expect(await css(root, 'color')).toBe(rgb(C.ink));
    expect(await css(root, 'fontFamily')).toBe(FONTS.serif.stack);
    const start = page.locator('.cfl-start');
    expect(await css(start, 'backgroundColor')).toBe(rgb(C.accent));
    expect(await css(start, 'color')).toBe(rgb(C['accent-ink']));
    expect(await css(page.locator(w > 900 ? '.cfl-side' : '.cfl-topbar'), 'backgroundColor')).toBe(rgb(C.side));
    expect(await noHScroll(page)).toBe(true);
    await page.screenshot({ path: path.join(SHOTS, `theme-lessons-charcoal-${w}.png`) });
    await start.click();
    await expect(page.locator('.cfl-lesson-title')).toBeVisible();
    expect(await css(page.locator('.cfl-lesson-title'), 'color')).toBe(rgb(C.ink));
    expect(await noHScroll(page)).toBe(true);
    await page.screenshot({ path: path.join(SHOTS, `theme-lessons-charcoal-${w}-lesson.png`) });
  });
}

test('presets are explicit schemes: the device light/dark setting changes only the automatic theme', async ({ page }) => {
  const bg = async (dir, scheme) => { await page.emulateMedia({ colorScheme: scheme }); await open(page, dir); await expect(page.locator('.cf-stage')).toBeVisible(); return css(page.locator('.cf-player'), 'backgroundColor'); };
  expect(await bg(dirs.charcoal, 'light')).toBe(rgb(C.bg));
  expect(await bg(dirs.charcoal, 'dark')).toBe(rgb(C.bg));
  expect(await bg(dirs.light, 'dark')).toBe(rgb(PRESETS.light.tokens.bg));
  await page.screenshot({ path: path.join(SHOTS, 'theme-slides-light-under-dark.png') });
  const auto = [await bg(dirs.auto, 'light'), await bg(dirs.auto, 'dark')];
  expect(auto[0]).not.toBe(auto[1]); // the automatic theme follows the device
});

// ---------- editors ----------
const TOKEN = 'e2e-themes-token-0123456789';
let server, base, root;
test.describe('editor Theme control', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-themes-editor-e2e-'));
    server = createServer({ root, token: TOKEN, port: 0 });
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  test.afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });

  const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
  const saved = (name) => JSON.parse(fs.readFileSync(path.join(root, `${name}.course.json`), 'utf8'));
  const built = (doc) => JSON.parse(serialize(doc));
  async function audit(page) { // every visible control has an accessible name and says what it does
    const bad = await page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea, a[href], [role=button], [role=tab]')]
      .filter((el) => el.getClientRects().length)
      .filter((el) => !(el.getAttribute('aria-label') || el.labels?.length || el.getAttribute('aria-labelledby') || el.textContent.trim()) || !(el.dataset.cmd || el.dataset.ui))
      .map((el) => el.outerHTML.slice(0, 160)));
    expect(bad).toEqual([]);
  }

  test('slides editor: preset and font through the Course tab equal theme.apply; undo restores; the editor chrome stays', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const seed = ok(emptyCourse({ title: 'Theme slides' }), [{ cmd: 'slide.add', args: { id: 's-1', title: 'One' } }]);
    io.saveCourse(path.join(root, 'th-slides.course.json'), seed);
    await page.goto(`${base}/?token=${TOKEN}#th-slides`);
    await expect(page.locator('#course-title')).toHaveText('Theme slides');
    await idle(page);
    const chrome = await css(page.locator('body'), 'backgroundColor');
    await page.getByRole('tab', { name: 'Course' }).click();
    await expect(page.getByRole('radio', { name: /Default \(player style/ })).toBeChecked();
    await page.getByRole('radio', { name: 'Ocean' }).check();
    await idle(page);
    await page.getByLabel('Font').selectOption('rounded');
    await idle(page);
    const expected = ok(seed, [{ cmd: 'theme.apply', args: { preset: 'ocean' } }, { cmd: 'theme.apply', args: { font: 'rounded' } }]);
    expect(saved('th-slides')).toEqual(built(expected));
    await expect(page.getByRole('radio', { name: 'Ocean' })).toBeChecked();
    expect(await css(page.locator('.th-preview .cfl-btn'), 'backgroundColor')).toBe(rgb(PRESETS.ocean.tokens.accent));
    expect(await css(page.locator('body'), 'backgroundColor')).toBe(chrome);
    await audit(page);
    await page.locator('#tabpanel').getByRole('heading', { name: 'Theme' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, 'editor-theme-slides.png') });
    await page.getByRole('button', { name: 'Undo' }).click();
    await idle(page);
    expect(saved('th-slides')).toEqual(built(ok(seed, [{ cmd: 'theme.apply', args: { preset: 'ocean' } }])));
  });

  test('lessons editor: a preset from the Course tab equals theme.apply and recolours the lesson page preview', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const seed = ok(emptyCourse({ title: 'Theme lessons', mode: 'lessons' }), [
      { cmd: 'section.add', args: { id: 'sec-a', title: 'Basics' } },
      { cmd: 'lesson.add', args: { id: 'l-a', section: 'sec-a', title: 'First lesson', blocks: [{ id: 'b-t', type: 'text', text: 'Hello.' }] } }]);
    io.saveCourse(path.join(root, 'th-lessons.course.json'), seed);
    await page.goto(`${base}/?token=${TOKEN}#th-lessons`);
    await expect(page.locator('#lapp')).toBeVisible();
    await idle(page);
    await page.locator('#lv-tab-course').click();
    await page.getByRole('radio', { name: 'High contrast (dark)' }).check();
    await idle(page);
    await page.getByRole('radio', { name: 'Charcoal (dark)' }).check();
    await idle(page);
    expect(saved('th-lessons')).toEqual(built(ok(seed, [{ cmd: 'theme.apply', args: { preset: 'high-contrast' } }, { cmd: 'theme.apply', args: { preset: 'charcoal' } }])));
    expect(await css(page.locator('#lv-page'), 'backgroundColor')).toBe(rgb(C.bg));
    await expect(page.locator('#ct-accent')).toHaveValue(C.accent); // the custom colour fields show the preset
    await audit(page);
    await page.screenshot({ path: path.join(SHOTS, 'editor-theme-lessons.png') });
  });
});
