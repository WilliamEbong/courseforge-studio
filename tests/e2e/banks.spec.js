// end to end: the editor builds a question bank and a draw (saved file == the command batch), and the published
// course plays only the drawn questions (web from file://, SCORM 1.2 in the mock LMS). Non-local requests are aborted.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../../packages/server/server.js';
import { createServer as createLms } from '../../packages/lms-test-harness/serve.js';
import * as io from '../../packages/cli/io.js';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse, serialize } from '../../packages/schema/index.js';
import { publishWeb, publishScorm12, validatePackage } from '../../packages/publisher/index.js';

const TOKEN = 'e2e-token-banks-0123456789';
const SHOTS = fileURLToPath(new URL('../../.tmp/', import.meta.url));
let server, base, root, lms, lmsUrl, webDir;

test.describe.configure({ mode: 'serial' });
const Q = (k) => ({ type: 'mc', prompt: `Bank question ${k}`, shuffle: false, choices: [{ id: 'a', label: `Right ${k}`, correct: true }, { id: 'b', label: `Wrong ${k}` }] });
const PLAYER = [ // intro, a draw of 2 from 4 bank questions, results (submit on start)
  { cmd: 'slide.add', args: { id: 's-intro', title: 'Welcome', objects: [{ id: 'o-hi', type: 'text', x: 80, y: 80, w: 900, h: 80, text: 'Two questions are drawn from a bank of four.' }] } },
  { cmd: 'bank.add', args: { id: 'bk-1', title: 'Safety bank' } },
  ...[1, 2, 3, 4].map((k) => ({ cmd: 'slide.add', args: { id: `s-b${k}`, bank: 'bk-1', title: `Bank question ${k}`, question: Q(k) } })),
  { cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-1', count: 2, title: 'Safety check' } },
  { cmd: 'slide.add', args: { id: 's-res', title: 'Results', objects: [{ id: 'o-score', type: 'text', x: 80, y: 120, w: 1100, h: 80, text: 'Your score: %qz.scorePercent%%', style: { fontSize: 44 } }] } },
  { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-draw'], results: 's-res' } },
  { cmd: 'trigger.add', args: { slide: 's-res', on: { event: 'timelineStart' }, do: [{ action: 'submitQuiz', quiz: 'qz' }] } },
  { cmd: 'tracking.set', args: { complete: [{ quiz: 'qz' }], status: 'passed-failed' } },
];

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-banks-e2e-'));
  fs.mkdirSync(SHOTS, { recursive: true });
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const r = applyAll(emptyCourse({ id: 'banks', title: 'Banks E2E' }), PLAYER);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  webDir = path.join(root, 'web');
  const scormDir = path.join(root, 'scorm');
  publishWeb(r.doc, webDir);
  publishScorm12(r.doc, scormDir);
  expect(validatePackage(webDir)).toEqual([]);
  expect(validatePackage(scormDir)).toEqual([]);
  lms = createLms(scormDir);
  await new Promise((res) => lms.listen(0, '127.0.0.1', res));
  lmsUrl = `http://127.0.0.1:${lms.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await new Promise((r) => lms.close(r));
  fs.rmSync(root, { recursive: true, force: true });
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
  expect(requests.filter((u) => !/^(file:|data:|http:\/\/127\.0\.0\.1[:/])/.test(u)), 'non-local requests').toEqual([]);
  expect(errors.filter((e) => !/status of 400/.test(e)), 'page/console errors (a refused command answers 400)').toEqual([]);
});

const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
async function commit(locator, value) { await locator.fill(String(value)); await locator.press('Tab'); await idle(locator.page()); }
async function audit(page) { // every visible control: an accessible name and data-cmd (registry command) or data-ui (navigation)
  const bad = await page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea, a[href], [role=button], [role=tab]')]
    .filter((el) => el.getClientRects().length)
    .filter((el) => !(el.getAttribute('aria-label') || el.labels?.length || el.getAttribute('aria-labelledby') || el.textContent.trim()) || !(el.dataset.cmd || el.dataset.ui))
    .map((el) => el.outerHTML.slice(0, 140)));
  expect(bad).toEqual([]);
}

test('editor: Banks panel and Insert draw build the same course as the command batch (parity)', async ({ page }) => {
  const SEED = [
    { cmd: 'slide.add', args: { id: 's-intro', title: 'Intro' } },
    { cmd: 'slide.add', args: { id: 's-extra', title: 'Extra', question: Q(9) } },
    { cmd: 'slide.add', args: { id: 's-end', title: 'End' } },
  ];
  const seeded = applyAll(emptyCourse({ title: 'Banks Course' }), SEED);
  io.saveCourse(path.join(root, 'banks.course.json'), seeded.doc);
  await page.goto(`${base}/?token=${TOKEN}#banks`);
  await expect(page.locator('#course-title')).toHaveText('Banks Course');
  await idle(page);

  await page.getByLabel('Next id').fill('bk-ppe');
  await page.getByRole('button', { name: 'Add question bank' }).click();
  await idle(page);
  await commit(page.getByLabel('Bank title (bk-ppe)'), 'PPE questions');
  for (const id of ['s-b1', 's-b2']) {
    await page.getByLabel('Next id').fill(id);
    await page.getByRole('button', { name: 'Add a question slide to bank PPE questions' }).click();
    await idle(page);
    await expect(page.locator(`#slide-${id}`)).toHaveAttribute('aria-current', 'true');
  }
  await expect(page.getByRole('tab', { name: 'Question' })).toHaveAttribute('aria-selected', 'true');
  await page.locator('#slide-s-extra').click();
  await page.getByLabel('Move slide to').selectOption('bank:bk-ppe');
  await idle(page);
  await expect(page.getByRole('region', { name: 'Bank PPE questions' }).locator('.slide-btn')).toHaveCount(3);

  await page.locator('#slide-s-intro').click();
  await page.getByLabel('Next id').fill('s-draw');
  await page.getByRole('button', { name: 'Insert draw from bank' }).click();
  await idle(page);
  await expect(page.locator('#slide-s-draw')).toHaveAttribute('aria-current', 'true');
  await commit(page.getByLabel('Slides to draw (0 = all)'), 2);
  await page.getByLabel('Random order').uncheck();
  await idle(page);
  await page.getByLabel('Question 2 (s-b2)', { exact: true }).selectOption('always');
  await idle(page);
  await expect(page.locator('.draw-card')).toContainText('2 of 3 slides from "PPE questions"');
  await expect(page.locator('.draw-card')).toContainText('Always included: Question 2');
  await expect(page.getByRole('button', { name: 'Insert text', exact: true })).toBeDisabled();
  await audit(page);
  await page.screenshot({ path: path.join(SHOTS, 'editor-banks.png') });

  await page.getByRole('tab', { name: 'Course' }).click();
  await page.getByLabel('Quiz ID (optional)').fill('qz');
  await page.locator('button[data-cmd="quiz.add"]').click();
  await idle(page);
  await expect(page.getByLabel('Draw from PPE questions (s-draw, draw)')).toBeChecked();

  const ref = applyAll(emptyCourse({ title: 'Banks Course' }), [...SEED,
    { cmd: 'bank.add', args: { id: 'bk-ppe', title: 'Question bank 1' } },
    { cmd: 'bank.set', args: { id: 'bk-ppe', title: 'PPE questions' } },
    ...[1, 2].map((k) => ({ cmd: 'slide.add', args: { id: `s-b${k}`, bank: 'bk-ppe', title: `Question ${k}`, question: { type: 'mc', prompt: 'New question', choices: [{ id: 'a', label: 'Answer A', correct: true }, { id: 'b', label: 'Answer B' }] } } })),
    { cmd: 'slide.move', args: { id: 's-extra', bank: 'bk-ppe' } },
    { cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-ppe', scene: 'sc-1', index: 1 } },
    { cmd: 'draw.set', args: { id: 's-draw', count: 2 } },
    { cmd: 'draw.set', args: { id: 's-draw', shuffle: false } },
    { cmd: 'draw.set', args: { id: 's-draw', always: ['s-b2'], never: [] } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-draw'] } },
  ]);
  expect(ref.ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'banks.course.json'), 'utf8'))).toEqual(JSON.parse(serialize(ref.doc)));

  await page.locator('#slide-s-draw').click();
  await page.getByRole('button', { name: 'Delete bank PPE questions' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.toast.error')).toContainText('draw slide(s) s-draw draw from bank "bk-ppe"');
});

/** Answer the drawn question on screen; returns its bank slide id. */
async function answer(frame, correct) {
  await expect(frame.getByRole('group', { name: /^Bank question \d$/ })).toBeVisible();
  const k = (await frame.locator('fieldset legend').textContent()).match(/\d$/)[0];
  await frame.getByRole('radio', { name: `${correct ? 'Right' : 'Wrong'} ${k}` }).check();
  await frame.getByRole('button', { name: 'Submit' }).click();
  await frame.getByRole('dialog', { name: correct ? 'Correct' : 'Incorrect' }).getByRole('button', { name: 'Continue' }).click();
  return `s-b${k}`;
}
const drawnInMenu = async (frame) => {
  const menuBtn = frame.getByRole('button', { name: 'Menu' });
  if ((await menuBtn.getAttribute('aria-expanded')) !== 'true') await menuBtn.click();
  return frame.getByRole('navigation', { name: 'Course menu' }).getByRole('list', { name: 'Safety check' }).getByRole('button').evaluateAll((els) => els.map((el) => el.dataset.slide));
};

test('player from file://: the draw is one menu entry until reached, then its drawn questions; score covers them only', async ({ page }) => {
  await page.goto(pathToFileURL(path.join(webDir, 'index.html')).href);
  await expect(page.getByText('Two questions are drawn from a bank of four.')).toBeVisible();
  await expect(page.locator('.cf-progress')).toHaveText('1 / 3');
  const menuBtn = page.getByRole('button', { name: 'Menu' });
  if ((await menuBtn.getAttribute('aria-expanded')) !== 'true') await menuBtn.click();
  const nav = page.getByRole('navigation', { name: 'Course menu' });
  await expect(nav.getByRole('button', { name: /Safety check/ })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('.cf-progress')).toHaveText('2 / 4');
  const drawn = await drawnInMenu(page);
  expect(drawn).toHaveLength(2);
  await expect(nav.getByRole('list', { name: 'Safety check' }).getByRole('button').first()).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: path.join(SHOTS, 'player-draw-menu.png'), animations: 'disabled' });
  const seen = [await answer(page, true), await answer(page, true)];
  expect(seen).toEqual(drawn);
  await expect(page.getByText('Your score: 100%')).toBeVisible();
});

test('SCORM 1.2 in the mock LMS: only the drawn questions are reported as interactions', async ({ page }) => {
  await page.goto(`${lmsUrl}/__lms/?course=banks`);
  const sco = page.frameLocator('#sco');
  await sco.getByRole('button', { name: 'Next' }).click();
  const drawn = await drawnInMenu(sco);
  const seen = [await answer(sco, true), await answer(sco, false)];
  expect(seen).toEqual(drawn);
  await expect(sco.getByText('Your score: 50%')).toBeVisible();
  const log = await page.evaluate(() => window.__lmsLog);
  const sets = log.filter((e) => e.fn === 'LMSSetValue');
  expect(sets.filter((e) => e.ret !== 'true'), 'every LMSSetValue accepted by the mock').toEqual([]);
  const ids = sets.filter((e) => /^cmi\.interactions\.\d+\.id$/.test(e.args[0])).map((e) => e.args[1]);
  expect(ids).toEqual(drawn.map((id) => `qz_${id}_0_0`));
  expect(sets.some((e) => e.args[0] === 'cmi.core.score.raw' && e.args[1] === '50')).toBe(true);
  expect(sets.some((e) => e.args[0] === 'cmi.core.lesson_status' && e.args[1] === 'failed')).toBe(true);
  const suspend = sets.filter((e) => e.args[0] === 'cmi.suspend_data').at(-1);
  expect(Object.keys(JSON.parse(suspend.args[1]).dr)).toEqual(['s-draw']);
});
