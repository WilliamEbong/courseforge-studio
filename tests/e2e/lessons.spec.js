// Lessons mode end to end: the published Lab Basics sample from file:// and 127.0.0.1, a keyboard-only path
// 375/768/1440 layouts, back/forward/refresh, restricted navigation, media captions, preview, and SCORM 1.2 in the mock
// LMS with relaunch resume. Every non-local request is aborted and must never be attempted.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { normalize } from '../../packages/schema/index.js';
import { publishWeb, publishScorm12, previewHtml, validatePackage } from '../../packages/publisher/index.js';
import { createServer } from '../../packages/lms-test-harness/serve.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, '.tmp');
const SAMPLE = normalize(JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/lab-basics-lessons.course.json'), 'utf8')));

function variant(cmds) {
  const r = applyAll(SAMPLE, cmds);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}
// Restricted navigation, a theme token and a captioned video, for the checks the free-navigation sample cannot make.
const restricted = () => variant([
  { cmd: 'player.set', args: { navigation: 'restricted', theme: { accent: '#0b5d5d' } } },
  { cmd: 'asset.add', args: { id: 'a-vid', path: 'assets/pattern-1s.webm' } },
  { cmd: 'asset.add', args: { id: 'a-vtt', path: 'assets/pattern-1s.vtt' } },
  { cmd: 'block.add', args: { lesson: 'l-welcome', id: 'b-w-video', index: 2, type: 'video', media: 'a-vid', captions: 'a-vtt', title: 'A one-second test pattern' } },
]);

let webDir, scormDir, strictDir, webUrl, scormUrl, strictUrl;
const servers = [];
async function serve(dir) {
  const s = createServer(dir);
  await new Promise((res) => s.listen(0, '127.0.0.1', res));
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}
test.beforeAll(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-e2e-lessons-'));
  const courseDir = path.join(base, 'course');
  fs.mkdirSync(path.join(courseDir, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'samples/assets/lab-bench.svg'), path.join(courseDir, 'assets/lab-bench.svg'));
  for (const f of ['pattern-1s.webm', 'pattern-1s.vtt']) fs.copyFileSync(path.join(ROOT, 'tests/fixtures/synthetic', f), path.join(courseDir, 'assets', f));
  webDir = path.join(base, 'web'); scormDir = path.join(base, 'scorm'); strictDir = path.join(base, 'strict');
  publishWeb(SAMPLE, webDir, { courseDir });
  publishScorm12(SAMPLE, scormDir, { courseDir });
  publishWeb({ ...restricted(), id: 'lab-strict' }, strictDir, { courseDir });
  for (const d of [webDir, scormDir, strictDir]) expect(validatePackage(d)).toEqual([]);
  webUrl = await serve(webDir); scormUrl = await serve(scormDir); strictUrl = await serve(strictDir);
  fs.mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => { for (const s of servers) await new Promise((res) => s.close(res)); });

let requests, errors;
test.beforeEach(async ({ context, page }) => {
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => r.abort());
  requests = []; errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
});
test.afterEach(async () => {
  expect(requests.filter((u) => !/^(file:|data:|http:\/\/127\.0\.0\.1[:/])/.test(u)), 'non-local requests').toEqual([]);
  expect(errors, 'page/console errors').toEqual([]);
});

const origins = { 'file://': () => pathToFileURL(path.join(webDir, 'index.html')).href, '127.0.0.1': () => `${webUrl}/index.html` };
const outline = (page) => page.getByRole('navigation', { name: 'Course outline' });
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `lessons-${name}.png`), fullPage: true, animations: 'disabled' });
async function reachEnd(page) { await page.locator('.cfl-end').scrollIntoViewIfNeeded(); }
async function tabTo(page, target, back = false) {
  for (let i = 0; i < 80; i++) {
    if (await target.evaluateAll((els) => els.includes(document.activeElement))) return;
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`keyboard focus never reached ${target}`);
}
async function passQuiz(page, scope = page) {
  await scope.getByRole('button', { name: 'Start quiz' }).click();
  await scope.getByRole('radio', { name: 'Safety goggles' }).check();
  await scope.getByRole('button', { name: 'Submit' }).click();
  await expect(scope.getByRole('status').filter({ hasText: 'Correct' })).toBeVisible();
  await scope.getByRole('button', { name: 'Next question' }).click();
  await scope.getByRole('checkbox', { name: 'Warn people nearby' }).check();
  await scope.getByRole('checkbox', { name: 'Step back' }).check();
  await scope.getByRole('button', { name: 'Submit' }).click();
  await scope.getByRole('button', { name: 'Next question' }).click();
  await scope.getByRole('textbox', { name: 'Your answer' }).fill('Eyewash');
  await scope.getByRole('button', { name: 'Submit' }).click();
  await scope.getByRole('button', { name: 'Next question' }).click();
  await scope.getByRole('combobox', { name: 'Goggles' }).selectOption({ label: 'Protect your eyes' });
  await scope.getByRole('combobox', { name: 'Gloves' }).selectOption({ label: 'Protect your hands' });
  await scope.getByRole('combobox', { name: 'Spill kit' }).selectOption({ label: 'Clean up small spills' });
  await scope.getByRole('button', { name: 'Submit' }).click();
  await scope.getByRole('button', { name: 'See results' }).click();
  await expect(scope.getByRole('heading', { name: 'You passed' })).toBeVisible();
  await expect(scope.locator('.cfl-score-num')).toHaveText('100%');
}

for (const [name, url] of Object.entries(origins)) {
  test(`lessons web package from ${name}: cover, gates, blocks, knowledge check, outline progress, quiz`, async ({ page }) => {
    await page.goto(url());
    await expect(page.getByRole('heading', { level: 1, name: 'Lab Basics' })).toBeVisible();
    const cover = page.getByRole('img', { name: /A lab bench with safety goggles/ });
    expect(await cover.evaluate((el) => el.complete && el.naturalWidth)).toBe(800);
    if (name === 'file://') await shot(page, 'cover-1280');
    await page.getByRole('button', { name: 'Start course' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome to the lab' })).toBeFocused();
    await expect(page).toHaveURL(/#\/l-welcome$/);
    await reachEnd(page);
    await expect(outline(page).getByRole('link', { name: /Welcome to the lab \(complete\)/ })).toBeVisible();
    await expect(page.getByText('25% complete')).toBeVisible();

    await page.getByRole('button', { name: /Next lesson/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Protective equipment' })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0); // hidden behind the first gate
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('.cfl-gate-hint')).toHaveText('Complete the activity above to continue.');
    for (const t of ['Safety goggles', 'Gloves', 'Lab coat']) {
      const head = page.getByRole('button', { name: new RegExp('^' + t) });
      await head.click();
      await expect(head).toHaveAttribute('aria-expanded', 'true');
    }
    await expect(page.getByRole('region', { name: /Gloves/ })).toContainText('Match the glove material');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('tab', { name: /Before/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: /During/ }).click();
    await page.getByRole('tab', { name: /After/ }).click();
    await expect(page.getByRole('tabpanel')).toContainText('take gloves off last');
    for (const c of ['Splash risk', 'Torn glove', 'Leaving the lab']) {
      const card = page.locator('.cfl-card', { hasText: c }); // the visible face names the button
      await card.click();
      await expect(card).toHaveAttribute('aria-pressed', 'true');
    }
    if (name === 'file://') await shot(page, 'ppe-1280');
    await page.getByRole('button', { name: 'I have explored both' }).click();
    const kc = page.getByRole('group', { name: 'You are about to heat a solution. Which item is essential?' });
    await kc.getByRole('radio', { name: 'Sandals' }).check();
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Incorrect' })).toContainText('Open shoes are never safe');
    await page.getByRole('button', { name: 'Take again' }).click();
    await kc.getByRole('radio', { name: 'Safety goggles' }).check();
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Correct' })).toContainText('Heated liquids can spit');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Next, you will put these habits to work on a spill.')).toBeVisible();
    await reachEnd(page);
    await expect(outline(page).getByRole('link', { name: /Protective equipment \(complete\)/ })).toBeVisible();

    // search (free navigation only)
    await page.getByRole('searchbox', { name: 'Search lessons' }).fill('eyewash');
    await expect(page.getByText('2 lessons match')).toBeVisible();
    await outline(page).getByRole('link', { name: /Final quiz/ }).click();
    await expect(page).toHaveURL(/#\/l-quiz$/);
    await passQuiz(page);
    if (name === 'file://') await shot(page, 'results-1280');
    await expect(outline(page).getByRole('link', { name: /Final quiz \(complete\)/ })).toBeVisible();
  });
}

test('keyboard only: skip link, Start, accordion, gate, tabs with arrow keys, flashcards, knowledge check, next lesson', async ({ page }) => {
  await page.goto(origins['127.0.0.1']() + '#/l-ppe');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to lesson content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Protective equipment' })).toBeFocused();
  for (const t of ['Safety goggles', 'Gloves', 'Lab coat']) {
    const head = page.getByRole('button', { name: new RegExp('^' + t) });
    await tabTo(page, head);
    await page.keyboard.press('Enter');
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await expect(head).toBeFocused(); // focus survives the re-render
  }
  await tabTo(page, page.getByRole('button', { name: 'Continue' }));
  await page.keyboard.press('Enter');
  const before = page.getByRole('tab', { name: /Before/ });
  await tabTo(page, before);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /During/ })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /After/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(before).toBeFocused(); // wraps
  await expect(page.getByRole('tab', { name: /During/ })).toHaveAttribute('tabindex', '-1'); // roving tabindex
  for (const c of ['Splash risk', 'Torn glove', 'Leaving the lab']) {
    const card = page.locator('.cfl-card', { hasText: c }); // the visible face names the button
    await tabTo(page, card);
    await page.keyboard.press('Space');
    await expect(card).toHaveAttribute('aria-pressed', 'true');
  }
  await tabTo(page, page.getByRole('button', { name: 'I have explored both' }));
  await page.keyboard.press('Enter');
  const goggles = page.getByRole('radio', { name: 'Safety goggles' });
  await tabTo(page, page.getByRole('radio'));
  for (let i = 0; i < 4 && !(await goggles.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(goggles).toBeChecked();
  await page.keyboard.press('Enter'); // implicit form submission
  await expect(page.getByRole('status').filter({ hasText: 'Correct' })).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Continue' }));
  await page.keyboard.press('Enter');
  await tabTo(page, page.getByRole('button', { name: /Next lesson/ }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Handling a spill' })).toBeFocused();
  await tabTo(page, page.getByRole('button', { name: 'Start' }));
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight'); // D [KB]: Left/Right change process steps
  await expect(page.getByText('Step 2 of 4')).toBeVisible();
});

test('responsive at 375, 768 and 1440: no horizontal scroll; the outline collapses to a toggle below 768', async ({ page }) => {
  for (const [w, h] of [[375, 812], [768, 1024], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const lesson of ['', 'l-welcome', 'l-ppe', 'l-spill', 'l-quiz']) {
      await page.goto(origins['127.0.0.1']() + '#/' + lesson);
      await expect(page.locator('.cfl-main h1')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${w}px #/${lesson}`).toBeLessThanOrEqual(w);
    }
    await page.goto(origins['127.0.0.1']() + '#/');
    const over = page.getByRole('button', { name: 'Start over' });
    if (await over.isVisible()) await over.click(); // each width starts without saved progress
    await page.goto(origins['127.0.0.1']() + '#/l-spill');
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: /Marker 3/ }).click();
    await expect(page.getByRole('region', { name: 'Marker details' })).toContainText('Spill kit');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await shot(page, `spill-${w}`);
    const nav = outline(page);
    if (w < 768) {
      await expect(nav).toBeHidden();
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      await menu.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(nav).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, 'lessons-menu-375.png'), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(nav).toBeHidden();
      await expect(menu).toBeFocused();
    } else {
      await expect(nav).toBeVisible();
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeHidden();
    }
  }
});

test('back, forward and refresh keep the position and progress (L24); Start over clears it', async ({ page }) => {
  await page.goto(origins['127.0.0.1']());
  await page.getByRole('button', { name: 'Start course' }).click();
  await reachEnd(page);
  await page.getByRole('button', { name: /Next lesson/ }).click();
  for (const t of ['Safety goggles', 'Gloves', 'Lab coat']) await page.getByRole('button', { name: new RegExp('^' + t) }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to the lab' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Protective equipment' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Before/ })).toBeVisible(); // the gate stays passed
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Protective equipment' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Before/ })).toBeVisible();
  await expect(outline(page).getByRole('link', { name: /Welcome to the lab \(complete\)/ })).toBeVisible();
  await page.goto(origins['127.0.0.1']()); // leave and return: a fresh page with no lesson in the address
  await expect(page.getByRole('heading', { level: 1, name: 'Protective equipment' })).toBeVisible(); // resumes without a prompt (C
  await outline(page).getByRole('link', { name: 'Lab Basics' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.getByRole('button', { name: 'Start over' }).click();
  await expect(page.getByRole('button', { name: 'Start course' })).toBeVisible();
  await expect(page.getByText('0% complete')).toBeVisible();
});

test('restricted navigation locks later lessons and hides search; theme tokens apply; captioned video completes', async ({ page }) => {
  await page.goto(`${strictUrl}/index.html#/l-quiz`);
  await expect(page.getByRole('heading', { level: 1, name: 'Lab Basics' })).toBeVisible(); // locked: stays on the cover
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole('searchbox')).toBeHidden();
  const quizLink = outline(page).getByText('Final quiz');
  await expect(quizLink.locator('xpath=ancestor::a')).toHaveAttribute('aria-disabled', 'true');
  const start = page.getByRole('button', { name: 'Start course' });
  expect(await start.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(11, 93, 93)');
  await start.click();
  const next = page.getByRole('button', { name: /Next lesson/ });
  await expect(next).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('Complete this lesson to unlock the next one.')).toBeVisible();
  const video = page.locator('video');
  await expect(video.locator('track[kind="captions"]')).toHaveAttribute('default', '');
  expect(await video.evaluate((v) => new Promise((res) => { const t = v.textTracks[0]; t.mode = 'showing'; const done = () => res(t.cues ? t.cues.length : 0); if (t.cues && t.cues.length) done(); else v.querySelector('track').addEventListener('load', done); }))).toBe(1);
  await video.evaluate((v) => { v.muted = true; return v.play(); });
  await expect(page.getByText('Played to the end')).toBeVisible({ timeout: 10000 });
  await reachEnd(page);
  await expect(next).not.toHaveAttribute('aria-disabled', 'true');
  await shot(page, 'restricted-welcome-1280');
});

test('previewHtml plays a lessons course; the debug panel shows the lesson', async ({ page }) => {
  const file = path.join(webDir, '..', 'preview-lessons.html');
  fs.writeFileSync(file, previewHtml(SAMPLE, { assetsBase: pathToFileURL(webDir).href + '/' }));
  await page.goto(pathToFileURL(file).href + '?debug');
  await page.getByRole('button', { name: 'Start course' }).click();
  const panel = page.getByRole('complementary', { name: 'Debug' });
  await expect(panel).toContainText('lesson: l-welcome');
  await expect(panel).toContainText('enter l-welcome');
});

test('SCORM 1.2 in the mock LMS: lesson progress resumes on relaunch; quiz sends score, status and spec-valid interactions', async ({ page }) => {
  await page.goto(`${scormUrl}/__lms/?course=lab-basics`);
  const sco = page.frameLocator('#sco');
  await sco.getByRole('button', { name: 'Start course' }).click();
  await sco.locator('.cfl-end').scrollIntoViewIfNeeded();
  await expect(sco.getByRole('link', { name: /Welcome to the lab \(complete\)/ })).toBeVisible();
  await sco.getByRole('button', { name: /Next lesson/ }).click();
  await expect(sco.getByRole('heading', { level: 1, name: 'Protective equipment' })).toBeVisible();

  await page.getByRole('button', { name: 'Exit & relaunch' }).click();
  await expect(sco.getByRole('heading', { level: 1, name: 'Protective equipment' })).toBeVisible(); // no prompt (C
  await expect(sco.getByRole('link', { name: /Welcome to the lab \(complete\)/ })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, 'lessons-scorm-resume.png'), animations: 'disabled' });
  await sco.getByRole('link', { name: /Final quiz/ }).click();
  await passQuiz(page, sco);

  const log = await page.evaluate(() => window.__lmsLog);
  const sets = log.filter((e) => e.fn === 'LMSSetValue');
  expect(sets.filter((e) => e.ret !== 'true'), 'every LMSSetValue accepted').toEqual([]);
  const set = (el, v) => sets.some((e) => e.args[0] === el && (v === undefined || e.args[1] === v));
  expect(set('cmi.core.lesson_status', 'incomplete')).toBe(true);
  expect(set('cmi.core.lesson_status', 'passed')).toBe(true);
  expect(set('cmi.core.score.raw', '100')).toBe(true);
  expect(log.filter((e) => e.fn === 'LMSInitialize').map((e) => e.session)).toEqual([1, 2]);
  const resumed = log.find((e) => e.session === 2 && e.fn === 'LMSGetValue' && e.args[0] === 'cmi.suspend_data');
  expect(JSON.parse(resumed.ret)).toMatchObject({ v: 1, mode: 'lessons', lesson: 'l-ppe', done: ['l-welcome'] });
  const ix = {};
  for (const e of sets) { const m = /^cmi\.interactions\.(\d+)\.(.+)$/.exec(e.args[0]); if (m) (ix[m[1]] = ix[m[1]] || {})[m[2]] = e.args[1]; }
  expect(Object.values(ix).map((r) => r.type)).toEqual(['choice', 'choice', 'fill-in', 'matching']);
  expect(ix[0]).toMatchObject({ id: 'l-quiz_q-heat_0', student_response: 'a', 'correct_responses.0.pattern': 'a', result: 'correct', weighting: '1' });
  expect(ix[1]).toMatchObject({ student_response: 'a,b', 'correct_responses.0.pattern': '{a,b}', result: 'correct' });
  expect(ix[3]).toMatchObject({ student_response: '0.a,1.b,2.c', 'correct_responses.0.pattern': '0.a,1.b,2.c', result: 'correct' });
});
