// Scenario block end to end: a published lessons course with a branching scenario played by mouse and by
// keyboard from file:// (every non-local request aborted and asserted absent), at 1440 and 375, with reduced motion; then
// the editor builds a scenario through its form and the saved file must equal the same content sent as one command batch.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { normalize, emptyCourse, serialize, validate } from '../../packages/schema/index.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(ROOT, '.tmp');
const ASSETS = path.join(ROOT, 'samples/assets');
const TOKEN = 'e2e-scenario-token-0123456789';
const SAMPLE = normalize(JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/lab-basics-lessons.course.json'), 'utf8')));
const ROBIN = 'Robin, a lab technician wearing goggles';
const SCEN = {
  id: 'b-t-scn', type: 'scenario', ending: 'Robin thanks you. Spills are routine when everyone knows the steps.',
  scenes: [
    { id: 'sc-spill', title: 'The spill', background: 'a-bench', backgroundAlt: '', character: 'a-tech', characterAlt: ROBIN, items: [
      { id: 'i-ask', kind: 'dialogue', text: 'I just knocked over a beaker of dilute acid. What should I do first?', responses: [
        { id: 'a', text: 'Warn the people nearby and step back.', feedback: 'Right: people first, then the spill.', goTo: 'i-kit' },
        { id: 'b', text: 'Wipe it up quickly with paper towels.', feedback: 'Not yet. Paper towels and bare hands spread the acid.', goTo: 'retry' }] },
      { id: 'i-kit', kind: 'text', text: 'Robin steps back and points at the red spill kit by the door.' }] },
    { id: 'sc-clean', title: 'Cleaning up', background: 'a-bench', backgroundAlt: '', items: [
      { id: 'i-clean', kind: 'dialogue', text: 'The kit is open. What next?', responses: [
        { id: 'a', text: 'Put on gloves and use the absorbent pads.', feedback: 'Yes. The pads soak it up and go in the labelled waste bin.', goTo: 'end' },
        { id: 'b', text: 'Go back and start again.', goTo: 'sc-spill' }] }] },
  ],
};
const r = applyAll(SAMPLE, [
  { cmd: 'asset.add', args: { id: 'a-tech', path: 'assets/lab-tech.svg' } },
  { cmd: 'lesson.add', args: { id: 'l-talk', section: 'sec-practice', title: 'Talk it through', blocks: [
    { id: 'b-t-intro', type: 'text', text: 'Robin has a spill. Help them handle it.' }, SCEN,
    { id: 'b-t-gate', type: 'continue', require: 'above' }, { id: 'b-t-end', type: 'text', text: 'You kept the lab safe.' }] } },
]);
if (!r.ok) throw new Error(JSON.stringify(r.errors));
const COURSE = r.doc;

let webUrl, server, base, root;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-e2e-scenario-'));
  const web = path.join(tmp, 'web');
  publishWeb(COURSE, web, { courseDir: path.join(ROOT, 'samples') });
  expect(validatePackage(web)).toEqual([]);
  webUrl = pathToFileURL(path.join(web, 'index.html')).href;
  root = path.join(tmp, 'editor');
  fs.cpSync(ASSETS, path.join(root, 'assets'), { recursive: true });
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  fs.mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise((res) => server.close(res)); });

let requests, errors, aborted;
test.beforeEach(async ({ context, page }) => {
  requests = []; errors = []; aborted = [];
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (x) => { aborted.push(x.request().url()); return x.abort(); });
  page.on('request', (x) => requests.push(x.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
});
test.afterEach(() => {
  expect(aborted, 'aborted non-local requests').toEqual([]);
  expect(requests.filter((u) => !/^(file:|data:|blob:|http:\/\/127\.0\.0\.1[:/])/.test(u)), 'non-local requests').toEqual([]);
  expect(errors, 'page/console errors').toEqual([]);
});

const shot = (page, name, full = true) => page.screenshot({ path: path.join(SHOTS, `scenario-${name}.png`), fullPage: full, animations: 'disabled' });
async function tabTo(page, target) {
  for (let i = 0; i < 80; i++) {
    if (await target.evaluateAll((els) => els.includes(document.activeElement))) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`keyboard focus never reached ${target}`);
}
const parts = (page) => {
  const scn = page.locator('.cfl-b-scenario');
  return { scn, say: scn.locator('.cfl-scn-say'), responses: scn.getByRole('group', { name: 'Your response' }), next: scn.getByRole('button', { name: /^(Continue|Finish)$/ }) };
};

test('player by mouse from file://: feedback, retry, item and scene jumps, Finish, ending, gate, Start over (1440)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${webUrl}#/l-talk`);
  await expect(page.getByRole('heading', { level: 1, name: 'Talk it through' })).toBeVisible();
  const { scn, say, responses, next } = parts(page);
  const robin = scn.getByRole('img', { name: ROBIN });
  await expect(robin).toBeVisible();
  expect(await robin.evaluate((el) => el.complete && el.naturalWidth)).toBe(300);
  await expect(say).toHaveText('I just knocked over a beaker of dilute acid. What should I do first?');
  await expect(responses.getByRole('button')).toHaveCount(2);
  const gate = page.locator('.cfl-b-continue').getByRole('button', { name: 'Continue' });
  await gate.click();
  await expect(page.locator('.cfl-gate-hint')).toHaveText('Complete the activity above to continue.');
  await expect(page.getByText('You kept the lab safe.')).toHaveCount(0);
  await shot(page, 'player-line-1440');

  await responses.getByRole('button', { name: 'Wipe it up quickly with paper towels.' }).click();
  await expect(say).toBeFocused();
  await expect(say).toContainText('Your response');
  await expect(say).toContainText('Paper towels and bare hands spread the acid.');
  await shot(page, 'player-feedback-1440');
  await next.click(); // retry: back to the start of the scene
  await expect(say).toHaveText(/^I just knocked over/);
  await expect(say).toBeFocused();
  await responses.getByRole('button', { name: 'Warn the people nearby and step back.' }).click();
  await next.click(); // -> item i-kit
  await expect(say).toHaveText('Robin steps back and points at the red spill kit by the door.');
  await expect(next).toHaveText('Continue');
  await next.click(); // next -> the next scene
  await expect(say).toHaveText('The kit is open. What next?');
  await expect(scn.locator('.cfl-scn-char')).toHaveCount(0); // the second scene has no character
  await responses.getByRole('button', { name: 'Go back and start again.' }).click(); // -> scene 1
  await expect(say).toHaveText(/^I just knocked over/);
  await responses.getByRole('button', { name: /^Warn/ }).click();
  await next.click();
  await next.click();
  await responses.getByRole('button', { name: /^Put on gloves/ }).click();
  await expect(next).toHaveText('Finish'); // this feedback leads to the end
  await next.click();
  await expect(say).toBeFocused();
  await expect(say).toContainText('End of the scenario');
  await expect(say).toContainText('Robin thanks you.');
  await shot(page, 'player-end-1440');
  await gate.click();
  await expect(page.getByText('You kept the lab safe.')).toBeVisible();
  await scn.getByRole('button', { name: 'Start over' }).click();
  await expect(say).toBeFocused();
  await expect(say).toHaveText(/^I just knocked over/);
  await expect(page.getByText('You kept the lab safe.')).toBeVisible(); // starting over keeps the block complete
});

test('player by keyboard from file:// at 375: Tab to a response, Enter, focus follows every step; no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${webUrl}#/l-talk`);
  const { scn, say, next } = parts(page);
  await expect(scn.getByRole('img', { name: ROBIN })).toBeVisible();
  await scn.scrollIntoViewIfNeeded();
  await shot(page, 'player-line-375');
  await tabTo(page, page.getByRole('button', { name: 'Warn the people nearby and step back.' }));
  await page.keyboard.press('Enter');
  await expect(say).toBeFocused();
  await expect(say).toContainText('Right: people first');
  await shot(page, 'player-feedback-375');
  await page.keyboard.press('Tab');
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(say).toBeFocused();
  await expect(say).toHaveText(/^Robin steps back/);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(say).toBeFocused();
  await expect(say).toHaveText('The kit is open. What next?');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: /^Put on gloves/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(next).toHaveText('Finish');
  await page.keyboard.press('Enter');
  await expect(say).toBeFocused();
  await expect(say).toContainText('End of the scenario');
  await page.keyboard.press('Tab');
  await expect(scn.getByRole('button', { name: 'Start over' })).toBeFocused();
  await shot(page, 'player-end-375');
  await tabTo(page, page.locator('.cfl-b-continue').getByRole('button', { name: 'Continue' }));
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-block="b-t-end"]')).toBeFocused(); // the gate moves focus to what it reveals
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('reduced motion: a new step fades in only when motion is welcome', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${webUrl}#/l-talk`);
  const panel = page.locator('.cfl-scn-panel');
  expect(await panel.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  expect(await panel.evaluate((el) => getComputedStyle(el).animationName)).toBe('cfl-in');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.cfl-b-scenario').scrollIntoViewIfNeeded();
  await shot(page, 'player-dark-1440', false);
});

// ---------------- editor ----------------
const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
async function commit(locator, value) { await locator.fill(String(value)); await locator.press('Tab'); await idle(locator.page()); }
async function choose(locator, value) { await locator.selectOption(String(value)); await idle(locator.page()); }
async function click(locator) { await locator.click(); await idle(locator.page()); }
const fileOf = (name) => path.join(root, `${name}.course.json`);
async function audit(page) { // every visible control has an accessible name and a data-cmd/data-ui
  const bad = await page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea, a[href], [role=button], [role=tab]')]
    .filter((el) => el.getClientRects().length)
    .filter((el) => !(el.getAttribute('aria-label') || el.labels?.length || el.getAttribute('aria-labelledby') || el.textContent.trim()) || !(el.dataset.cmd || el.dataset.ui))
    .map((el) => el.outerHTML.slice(0, 160)));
  expect(bad).toEqual([]);
}

test('editor: a scenario built through the form equals the command batch; card preview; Preview plays it; 1440, 1024 and 375', async ({ page }) => {
  test.setTimeout(120000);
  const SEED = [
    { cmd: 'asset.add', args: { id: 'a-tech', path: 'assets/lab-tech.svg' } },
    { cmd: 'section.add', args: { id: 'sec-1', title: 'Practice' } },
    { cmd: 'lesson.add', args: { id: 'l-1', title: 'Talk it through' } },
  ];
  const seeded = applyAll(emptyCourse({ title: 'Scenario lab', mode: 'lessons' }), SEED);
  io.saveCourse(fileOf('scn'), seeded.doc);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?token=${TOKEN}#scn`);
  await expect(page.locator('#lapp')).toBeVisible();
  await idle(page);

  await page.locator('#lv-next-id').fill('b-scn');
  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  await expect(page.locator('#lv-mi-scenario')).toContainText('Scenario');
  await click(page.locator('#lv-mi-scenario'));
  await expect(page.locator('#lv-card-b-scn')).toHaveClass(/sel/);
  await expect(page.locator('#lv-card-b-scn')).toContainText('A good response'); // the schema's starter

  await commit(page.getByLabel('Scene 1 title (authors only)', { exact: true }), 'The spill');
  await choose(page.getByLabel('Scene 1 character (optional)', { exact: true }), 'a-tech');
  await expect(page.getByText('This character image has no alt text.')).toBeVisible();
  await commit(page.getByLabel('Scene 1 character alt text (who is speaking)', { exact: true }), 'Robin, a lab technician');
  await expect(page.getByText('This character image has no alt text.')).toHaveCount(0);
  await commit(page.getByLabel('Scene 1 item 1 line (what the character says)', { exact: true }), 'I spilled acid. What first?');
  await commit(page.getByLabel('Scene 1 item 1 response 1 text', { exact: true }), 'Warn people and step back.');
  await commit(page.getByLabel('Scene 1 item 1 response 1 feedback (optional)', { exact: true }), 'Right: people first.');
  await commit(page.getByLabel('Scene 1 item 1 response 2 text', { exact: true }), 'Wipe it up.');
  await commit(page.getByLabel('Scene 1 item 1 response 2 feedback (optional)', { exact: true }), 'Not yet.');
  await click(page.getByRole('button', { name: 'Add an item to scene 1', exact: true }));
  await choose(page.getByLabel('Scene 1 item 2 kind', { exact: true }), 'text');
  await commit(page.getByLabel('Scene 1 item 2 text', { exact: true }), 'Robin fetches the spill kit.');
  await choose(page.getByLabel('Scene 1 item 1 response 1 goes to', { exact: true }), 'i2');
  await click(page.getByRole('button', { name: 'Add a scene', exact: true }));
  await commit(page.getByLabel('Scene 2 title (authors only)', { exact: true }), 'Cleaning up');
  await commit(page.getByLabel('Scene 2 item 1 line (what the character says)', { exact: true }), 'The kit is open. What next?');
  await commit(page.getByLabel('Scene 2 item 1 response 1 text', { exact: true }), 'Use the absorbent pads.');
  await choose(page.getByLabel('Scene 2 item 1 response 1 goes to', { exact: true }), 'end');
  await click(page.getByRole('button', { name: 'Add a response to scene 2 item 1 (up to 3)', exact: true }));
  await commit(page.getByLabel('Scene 2 item 1 response 2 text', { exact: true }), 'Start again.');
  await choose(page.getByLabel('Scene 2 item 1 response 2 goes to', { exact: true }), 's1');
  await click(page.getByRole('button', { name: 'Add an item to scene 2', exact: true }));
  await click(page.getByRole('button', { name: 'Remove scene 2 item 2', exact: true }));
  await commit(page.getByLabel('Ending text (optional; shown above Start over)', { exact: true }), 'Robin thanks you.');

  const ref = applyAll(seeded.doc, [{ cmd: 'block.add', args: { lesson: 'l-1', id: 'b-scn', type: 'scenario', ending: 'Robin thanks you.', scenes: [
    { id: 's1', title: 'The spill', character: 'a-tech', characterAlt: 'Robin, a lab technician', items: [
      { id: 'i1', kind: 'dialogue', text: 'I spilled acid. What first?', responses: [
        { id: 'a', text: 'Warn people and step back.', feedback: 'Right: people first.', goTo: 'i2' },
        { id: 'b', text: 'Wipe it up.', feedback: 'Not yet.', goTo: 'retry' }] },
      { id: 'i2', kind: 'text', text: 'Robin fetches the spill kit.' }] },
    { id: 's2', title: 'Cleaning up', items: [
      { id: 'i3', kind: 'dialogue', text: 'The kit is open. What next?', responses: [
        { id: 'a', text: 'Use the absorbent pads.', goTo: 'end' }, { id: 'b', text: 'Start again.', goTo: 's1' }] }] },
  ] } }]);
  expect(ref.ok, JSON.stringify(ref.errors)).toBe(true);
  const saved = JSON.parse(fs.readFileSync(fileOf('scn'), 'utf8'));
  expect(saved).toEqual(JSON.parse(serialize(ref.doc)));
  expect(validate(saved)).toEqual([]);

  const card = page.locator('#lv-b-b-scn');
  await expect(card).toHaveAttribute('aria-describedby', 'lv-b-b-scn-lbl'); // named by its visible content; position and summary describe it
  await expect(page.locator('#lv-b-b-scn-lbl')).toHaveText(/Scenario b-scn\. 2 scenes, 3 items: I spilled acid\. What first\?/);
  await expect(page.locator('#lv-card-b-scn .cfl-scn-char')).toBeVisible();
  await audit(page);
  await page.screenshot({ path: path.join(SHOTS, 'scenario-editor-1440.png') });
  await page.setViewportSize({ width: 1024, height: 768 }); // the editor's narrowest supported width
  await audit(page);
  await page.screenshot({ path: path.join(SHOTS, 'scenario-editor-1024.png') });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByText('CourseForge Studio is laid out for windows 1024 pixels wide or more.')).toBeVisible(); // the editor asks for 1024 px; the player is the phone surface
  await page.screenshot({ path: path.join(SHOTS, 'scenario-editor-375.png') });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole('button', { name: 'Preview' }).click();
  const frame = page.frameLocator('dialog iframe');
  await frame.getByRole('button', { name: 'Start course' }).click();
  await frame.getByRole('button', { name: 'Wipe it up.' }).click();
  await expect(frame.locator('.cfl-scn-say')).toContainText('Not yet.');
  await frame.getByRole('button', { name: 'Continue' }).click();
  await frame.getByRole('button', { name: 'Warn people and step back.' }).click();
  await frame.getByRole('button', { name: 'Continue' }).click();
  await expect(frame.locator('.cfl-scn-say')).toHaveText('Robin fetches the spill kit.');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
});
