// Published player end to end: web package from file:// and 127.0.0.1, keyboard-only run, SCORM run in
// the mock LMS with relaunch/resume. Every non-local request is aborted and must never be attempted.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { publishWeb, publishScorm12, previewHtml, validatePackage } from '../../packages/publisher/index.js';
import { createServer } from '../../packages/lms-test-harness/serve.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, '.tmp');

function buildCourse() {
  const r = applyAll(emptyCourse({ id: 'e2e', title: 'E2E Course' }), [
    { cmd: 'var.add', args: { name: 'clicks', type: 'number', initial: 0 } },
    { cmd: 'var.add', args: { name: 'learner', type: 'text', initial: '' } },
    { cmd: 'asset.add', args: { id: 'a-pic', path: 'assets/pic.png', alt: 'Synthetic test pattern' } },
    { cmd: 'slide.add', args: { id: 's-intro', title: 'Welcome', background: '#f6f7fb', objects: [
      { id: 'o-title', type: 'text', x: 80, y: 56, w: 1120, h: 80, text: 'Welcome to the E2E course', style: { fontSize: 48, bold: true, color: '#1c1f24' } },
      { id: 'o-count', type: 'text', x: 80, y: 150, w: 600, h: 44, text: 'Clicks: %clicks%', style: { color: '#555a62' } },
      { id: 'o-name', type: 'input', x: 80, y: 230, w: 420, h: 60, var: 'learner', placeholder: 'Your name', alt: 'Your name' },
      { id: 'o-hello', type: 'text', x: 80, y: 310, w: 600, h: 44, text: 'Hello, %learner%' },
      { id: 'o-pic', type: 'image', x: 820, y: 210, w: 300, h: 180, image: 'a-pic' },
      { id: 'o-dot', type: 'shape', shape: 'ellipse', x: 1130, y: 590, w: 70, h: 70, style: { fill: '#f0b429' } },
      { id: 'o-show', type: 'button', x: 80, y: 420, w: 300, h: 72, text: 'Show details', states: { hover: { style: { fill: '#1f2a66' } } } },
    ] } },
    { cmd: 'layer.add', args: { slide: 's-intro', id: 'l-info', title: 'Details', modal: true, objects: [
      { id: 'o-panel', type: 'shape', shape: 'rounded', x: 340, y: 170, w: 600, h: 380, style: { fill: '#ffffff', shadow: true } },
      { id: 'o-info', type: 'text', x: 380, y: 210, w: 520, h: 180, text: 'Details layer: you clicked %clicks% time(s).', style: { fontSize: 30 } },
      { id: 'o-close', type: 'button', x: 540, y: 440, w: 200, h: 64, text: 'Close' },
    ] } },
    { cmd: 'trigger.add', args: { slide: 's-intro', on: { event: 'click', target: 'o-show' }, do: [{ action: 'setVar', var: 'clicks', op: 'add', value: 1 }, { action: 'showLayer', layer: 'l-info' }] } },
    { cmd: 'trigger.add', args: { slide: 's-intro', on: { event: 'key', key: 'd' }, do: [{ action: 'showLayer', layer: 'l-info' }] } },
    { cmd: 'trigger.add', args: { slide: 's-intro', layer: 'l-info', on: { event: 'click', target: 'o-close' }, do: [{ action: 'hideLayer' }] } },
    { cmd: 'slide.add', args: { id: 's-q1', title: 'Question 1', question: { type: 'mc', prompt: 'What color is a clear daytime sky?', shuffle: false, choices: [{ id: 'c-green', label: 'Green' }, { id: 'c-blue', label: 'Blue', correct: true }, { id: 'c-red', label: 'Red' }] } } },
    { cmd: 'slide.add', args: { id: 's-q2', title: 'Question 2', question: { type: 'fill', prompt: 'Type the word teal', answers: ['teal'] } } },
    { cmd: 'slide.add', args: { id: 's-res', title: 'Results', objects: [
      { id: 'o-score', type: 'text', x: 80, y: 120, w: 1120, h: 80, text: 'Your score: %qz.scorePercent%%', style: { fontSize: 48, bold: true } },
      { id: 'o-passed', type: 'text', x: 80, y: 220, w: 1120, h: 50, text: 'Passed: %qz.passed%' },
    ] } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q1', 's-q2'], passPercent: 80, results: 's-res' } },
    { cmd: 'trigger.add', args: { slide: 's-res', on: { event: 'timelineStart' }, do: [{ action: 'submitQuiz', quiz: 'qz' }] } },
    { cmd: 'tracking.set', args: { complete: [{ quiz: 'qz' }], status: 'passed-failed' } },
  ]);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}

let webDir, scormDir;
const servers = [];
async function serve(dir) {
  const s = createServer(dir);
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
let webUrl, scormUrl;

test.beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-e2e-'));
  const courseDir = path.join(base, 'course');
  fs.mkdirSync(path.join(courseDir, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tests/fixtures/synthetic/synthetic-200x120.png'), path.join(courseDir, 'assets/pic.png'));
  const doc = buildCourse();
  webDir = path.join(base, 'web');
  scormDir = path.join(base, 'scorm');
  publishWeb(doc, webDir, { courseDir });
  publishScorm12(doc, scormDir, { courseDir });
  expect(validatePackage(webDir)).toEqual([]);
  expect(validatePackage(scormDir)).toEqual([]);
  webUrl = await serve(webDir);
  scormUrl = await serve(scormDir);
  fs.mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => { for (const s of servers) await new Promise((res) => s.close(res)); });

// Abort anything that is not local, record every request, and collect page errors and console errors (CSP too).
let requests, errors;
test.beforeEach(async ({ context, page }) => {
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => r.abort());
  requests = [];
  errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
});
test.afterEach(async () => {
  expect(requests.filter((u) => !/^(file:|data:|http:\/\/127\.0\.0\.1[:/])/.test(u)), 'non-local requests').toEqual([]);
  expect(errors, 'page/console errors').toEqual([]);
});

const origins = { 'file://': () => pathToFileURL(path.join(webDir, 'index.html')).href, '127.0.0.1': () => `${webUrl}/index.html` };

// Press Tab (or Shift+Tab) until focus is on one of the elements `target` matches.
async function tabTo(page, target, back = false) {
  for (let i = 0; i < 40; i++) {
    if (await target.evaluateAll((els) => els.includes(document.activeElement))) return;
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`keyboard focus never reached ${target}`);
}

for (const [name, url] of Object.entries(origins)) {
  test(`web package from ${name}: renders, clicks, layers, input binding, hover, key trigger, questions, results`, async ({ page }) => {
    await page.goto(url());
    await expect(page.getByRole('heading', { level: 1, name: 'E2E Course' })).toBeVisible();
    await expect(page.getByText('Welcome to the E2E course')).toBeVisible();
    const img = page.getByRole('img', { name: 'Synthetic test pattern' });
    await expect(img).toBeVisible();
    expect(await img.evaluate((el) => el.complete && el.naturalWidth)).toBe(200);
    const box = await page.locator('.cf-frame').boundingBox();
    expect(Math.abs(box.width / box.height - 1280 / 720)).toBeLessThan(0.01);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'player-slide1.png'), animations: 'disabled' });

    await page.getByRole('textbox', { name: 'Your name' }).fill('Ada');
    await expect(page.getByText('Hello, Ada')).toBeVisible();

    const show = page.getByRole('button', { name: 'Show details' });
    const before = await show.evaluate((el) => getComputedStyle(el).backgroundColor);
    await show.hover();
    await expect.poll(() => show.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(31, 42, 102)');
    expect(before).not.toBe('rgb(31, 42, 102)');
    await show.click();
    await expect(page.getByText('Details layer: you clicked 1 time(s).')).toBeVisible();
    await expect(page.getByText('Clicks: 1')).toBeAttached();
    await expect(show).toBeDisabled(); // modal layer blocks the base
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'player-layer.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText(/Details layer/)).toBeHidden();
    await page.locator('.cf-stage').focus();
    await page.keyboard.press('d'); // key trigger
    await expect(page.getByText(/Details layer/)).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByRole('group', { name: 'What color is a clear daytime sky?' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit' })).toBeDisabled();
    await page.getByRole('radio', { name: 'Green' }).check();
    await page.getByRole('button', { name: 'Submit' }).click();
    const dlg = page.getByRole('dialog', { name: 'Incorrect' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Continue' })).toBeFocused();
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'player-feedback.png'), animations: 'disabled' });
    await dlg.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('textbox', { name: 'Answer' }).fill('teal');
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'player-fill.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.getByRole('dialog', { name: 'Correct' }).getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Your score: 50%')).toBeVisible();
    await expect(page.getByText('Passed: false')).toBeVisible();
    if (name === 'file://') await page.screenshot({ path: path.join(SHOTS, 'player-results.png'), animations: 'disabled' });

    const nav = page.getByRole('navigation', { name: 'Course menu' });
    await expect(nav.getByRole('button', { name: /Results/ })).toHaveCount(0); // results slides are not listed
    await expect(nav.getByRole('button', { name: 'Welcome (viewed)' })).toBeVisible();
    await nav.getByRole('button', { name: /Welcome/ }).click();
    await expect(page.getByText('Clicks: 1')).toBeVisible();
    await expect(page.getByText('Hello, Ada')).toBeVisible();
  });

  test(`web package from ${name}: keyboard-only run (Tab, Enter, arrows, Escape)`, async ({ page }) => {
    await page.goto(url());
    const show = page.getByRole('button', { name: 'Show details' });
    await tabTo(page, show);
    await page.keyboard.press('Enter');
    await expect(page.getByText('Details layer: you clicked 1 time(s).')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Details layer/)).toBeHidden();
    await expect(show).toBeFocused(); // focus returns to the opener

    await tabTo(page, page.getByRole('button', { name: 'Next' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: 'What color is a clear daytime sky?' })).toBeVisible();
    await tabTo(page, page.getByRole('radio'), true);
    const blue = page.getByRole('radio', { name: 'Blue' });
    for (let i = 0; i < 4 && !(await blue.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    await expect(blue).toBeChecked();
    await tabTo(page, page.getByRole('button', { name: 'Submit' }));
    await page.keyboard.press('Enter');
    const ok = page.getByRole('dialog', { name: 'Correct' });
    await expect(ok.getByRole('button', { name: 'Continue' })).toBeFocused();
    await page.keyboard.press('Enter');

    const answer = page.getByRole('textbox', { name: 'Answer' });
    await tabTo(page, answer, true);
    await page.keyboard.type('teal');
    await page.keyboard.press('Enter'); // implicit form submission
    await expect(page.getByRole('dialog', { name: 'Correct' })).toBeVisible();
    await page.keyboard.press('Escape'); // Escape = Continue
    await expect(page.getByText('Your score: 100%')).toBeVisible();
    await expect(page.getByText('Passed: true')).toBeVisible();
  });
}

test('web resume prompt (localStorage): Escape on a fresh page resumes, Restart starts over', async ({ page }) => {
  await page.goto(origins['127.0.0.1']());
  await page.getByRole('button', { name: 'Show details' }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.cf-progress')).toHaveText('2 / 4');
  await page.reload(); // new document: no user activation, so Escape closes the dialog natively
  const ask = page.getByRole('dialog', { name: 'Resume where you left off?' });
  await expect(ask.getByRole('button', { name: 'Resume' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ask).toBeHidden();
  await expect(page.locator('.cf-progress')).toHaveText('2 / 4');
  await page.reload();
  await ask.getByRole('button', { name: 'Restart' }).click();
  await expect(page.locator('.cf-progress')).toHaveText('1 / 4');
  await expect(page.getByText('Clicks: 0')).toBeVisible(); // a restart is a fresh runtime: initial variable values
});

test('dark scheme at phone width: chrome adapts, stage fits without horizontal scroll', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(origins['file://']());
  await expect(page.getByText('Welcome to the E2E course')).toBeVisible();
  expect(await page.locator('.cf-bar').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(27, 30, 36)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const box = await page.locator('.cf-frame').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await expect(page.getByRole('navigation', { name: 'Course menu' })).toBeHidden(); // collapsed on narrow screens
  await page.screenshot({ path: path.join(SHOTS, 'player-dark-phone.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Course menu' })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'player-dark-phone-menu.png'), animations: 'disabled' });
});

test('previewHtml: single page plays the course; debug panel shows state and trace (?debug and toggle)', async ({ page }) => {
  const file = path.join(webDir, '..', 'preview.html');
  fs.writeFileSync(file, previewHtml(buildCourse(), { assetsBase: pathToFileURL(webDir).href + '/' }));
  await page.goto(pathToFileURL(file).href + '?debug');
  const panel = page.getByRole('complementary', { name: 'Debug' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('slide: s-intro');
  expect(await page.getByRole('img', { name: 'Synthetic test pattern' }).evaluate((el) => el.naturalWidth)).toBe(200);
  await page.getByRole('button', { name: 'Show details' }).click();
  await expect(panel).toContainText('layers: l-info');
  await expect(panel).toContainText('clicks = 1');
  await expect(panel).toContainText('layer+ l-info');
  await page.screenshot({ path: path.join(SHOTS, 'player-preview-debug.png'), animations: 'disabled' });
  const toggle = page.getByRole('button', { name: 'Debug' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(panel).toBeHidden();
  await page.goto(pathToFileURL(file).href);
  await expect(page.getByText('Welcome to the E2E course')).toBeVisible();
  await expect(panel).toBeHidden();
});

test('SCORM 1.2 package in the mock LMS: status, spec-valid interactions, relaunch resumes from suspend_data', async ({ page }) => {
  await page.goto(`${scormUrl}/__lms/?course=e2e`);
  const sco = page.frameLocator('#sco');
  await sco.getByRole('button', { name: 'Show details' }).click();
  await sco.getByRole('button', { name: 'Close' }).click();
  await sco.getByRole('button', { name: 'Next' }).click();
  await expect(sco.getByRole('group', { name: 'What color is a clear daytime sky?' })).toBeVisible();

  await page.getByRole('button', { name: 'Exit & relaunch' }).click();
  const resume = sco.getByRole('dialog', { name: 'Resume where you left off?' });
  await expect(resume).toBeVisible();
  await expect(resume.getByRole('button', { name: 'Resume' })).toBeFocused();
  await page.screenshot({ path: path.join(SHOTS, 'player-scorm-resume.png'), animations: 'disabled' });
  await resume.getByRole('button', { name: 'Resume' }).click();
  await expect(sco.getByRole('group', { name: 'What color is a clear daytime sky?' })).toBeVisible();
  await expect(sco.locator('.cf-progress')).toHaveText('2 / 4');
  const menuBtn = sco.getByRole('button', { name: 'Menu' });
  if ((await menuBtn.getAttribute('aria-expanded')) !== 'true') await menuBtn.click();
  const nav = sco.getByRole('navigation', { name: 'Course menu' });
  await nav.getByRole('button', { name: /Welcome/ }).click();
  await expect(sco.getByText('Clicks: 1')).toBeVisible(); // variables restored from suspend_data
  await nav.getByRole('button', { name: /Question 1/ }).click();

  await sco.getByRole('radio', { name: 'Green' }).check();
  await sco.getByRole('button', { name: 'Submit' }).click();
  await sco.getByRole('dialog', { name: 'Incorrect' }).getByRole('button', { name: 'Continue' }).click();
  await sco.getByRole('textbox', { name: 'Answer' }).fill('teal');
  await sco.getByRole('button', { name: 'Submit' }).click();
  await sco.getByRole('dialog', { name: 'Correct' }).getByRole('button', { name: 'Continue' }).click();
  await expect(sco.getByText('Your score: 50%')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'player-scorm-results.png'), animations: 'disabled' });

  const log = await page.evaluate(() => window.__lmsLog);
  const sets = log.filter((e) => e.fn === 'LMSSetValue');
  expect(sets.filter((e) => e.ret !== 'true'), 'every LMSSetValue accepted by the mock').toEqual([]);
  const set = (el, v) => sets.some((e) => e.args[0] === el && (v === undefined || e.args[1] === v));
  expect(set('cmi.core.lesson_status', 'incomplete')).toBe(true);
  expect(set('cmi.core.lesson_status', 'failed')).toBe(true);
  expect(set('cmi.core.score.raw', '50')).toBe(true);
  expect(set('cmi.suspend_data')).toBe(true);
  expect(log.filter((e) => e.fn === 'LMSInitialize').map((e) => e.session)).toEqual([1, 2]);
  const resumed = log.find((e) => e.session === 2 && e.fn === 'LMSGetValue' && e.args[0] === 'cmi.suspend_data');
  expect(JSON.parse(resumed.ret)).toMatchObject({ v: 1, slide: 's-q1', vars: { clicks: 1 } });

  const ix = {};
  for (const e of sets) {
    const m = /^cmi\.interactions\.(\d+)\.(.+)$/.exec(e.args[0]);
    if (m) (ix[m[1]] = ix[m[1]] || {})[m[2]] = e.args[1];
  }
  expect(Object.keys(ix)).toEqual(['0', '1']);
  for (const r of Object.values(ix)) {
    expect(r.id).toMatch(/^[A-Za-z0-9_.-]{1,255}$/);
    expect(r.time).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(r.weighting).toBe('10');
  }
  expect(ix[0]).toMatchObject({ type: 'choice', student_response: 'a', 'correct_responses.0.pattern': 'b', result: 'wrong' });
  expect(ix[1]).toMatchObject({ type: 'fill-in', student_response: 'teal', 'correct_responses.0.pattern': 'teal', result: 'correct' });
});

test('ids named "constructor" render and work; a modal layer is a labelled dialog (review 002 #8, #9)', async ({ page }) => {
  const docs = [
    [{ id: 'constructor', type: 'button', text: 'Open', x: 80, y: 80, w: 240, h: 64 }, 'constructor', 'l-pop'],
    [{ id: 'o-open', type: 'button', text: 'Open', x: 80, y: 80, w: 240, h: 64 }, 'o-open', 'constructor'],
  ].map(([btn, target, layer]) => {
    const r = applyAll(emptyCourse({ id: 'proto', title: 'Proto ids' }), [
      { cmd: 'slide.add', args: { id: 's-1', title: 'One', objects: [btn] } },
      { cmd: 'layer.add', args: { slide: 's-1', id: layer, title: 'Popup', modal: true, objects: [{ id: 'o-close', type: 'button', text: 'Close', x: 80, y: 220, w: 240, h: 64 }] } },
      { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target }, do: [{ action: 'showLayer', layer }] } },
    ]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.doc;
  });
  for (const [i, doc] of docs.entries()) {
    const file = path.join(webDir, '..', `proto-${i}.html`);
    fs.writeFileSync(file, previewHtml(doc));
    await page.goto(pathToFileURL(file).href);
    await page.getByRole('button', { name: 'Open' }).click();
    const dlg = page.getByRole('dialog', { name: 'Popup' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Close' })).toBeFocused();
  }
});

test('V4: with a modal layer open, Tab never reaches base-layer objects; focus starts inside the layer and returns on close', async ({ page }) => {
  await page.goto(`${webUrl}/index.html`);
  const show = page.getByRole('button', { name: 'Show details' });
  await show.focus();
  await page.keyboard.press('Enter');
  const close = page.getByRole('button', { name: 'Close' });
  await expect(close).toBeFocused();
  const visited = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    visited.push(await page.evaluate(() => document.activeElement?.getAttribute('data-id') || document.activeElement?.textContent?.trim().slice(0, 20) || document.activeElement?.tagName));
  }
  for (const base of ['o-show', 'o-name', 'o-pic']) expect(visited, `Tab reached base object ${base}`).not.toContain(base);
  await close.focus();
  await page.keyboard.press('Enter');
  await expect(show).toBeFocused();
});
