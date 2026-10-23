// Editor E2E for the GUI builds sliders, dials, media, hotspot and drag-and-drop questions with the same
// registry commands an agent sends (parity). Every outbound request is blocked and fails the test.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse, validate } from '../../packages/schema/index.js';

const TOKEN = 'e2e-token-interactions-0123456789';
const SHOTS = fileURLToPath(new URL('../../.tmp/', import.meta.url));
let server, base, root;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-editor-ix-'));
  fs.mkdirSync(SHOTS, { recursive: true });
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});
const external = [];
test.beforeEach(async ({ context }) => {
  external.length = 0;
  await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => { external.push(route.request().url()); return route.abort(); });
});
test.afterEach(() => expect(external).toEqual([]));

const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
async function commit(locator, value) { await locator.fill(String(value)); await locator.press('Tab'); await idle(locator.page()); }
const fileOf = (name) => path.join(root, `${name}.course.json`);
const load = (name) => io.loadCourse(fileOf(name));
function seed(name, title, cmds = []) {
  const r = applyAll(emptyCourse({ title }), cmds);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  io.saveCourse(fileOf(name), r.doc);
}
async function open(page, name, title) {
  await page.goto(`${base}/?token=${TOKEN}#${name}`);
  await expect(page.locator('#course-title')).toHaveText(title);
  await idle(page);
}
// Every visible control has an accessible name and says what it does (data-cmd or data-ui), as in editor.spec.js.
async function audit(page) {
  const bad = await page.evaluate(() => [...document.querySelectorAll('button, input, select, textarea, a[href], [role=button], [role=tab]')]
    .filter((el) => el.getClientRects().length)
    .filter((el) => !(el.getAttribute('aria-label') || el.labels?.length || el.getAttribute('aria-labelledby') || el.textContent.trim()) || !(el.dataset.cmd || el.dataset.ui))
    .map((el) => el.outerHTML.slice(0, 140)));
  expect(bad).toEqual([]);
}

test('insert slider and dial (each gets a number variable), edit range, insert video with captions', async ({ page }) => {
  seed('ix-objects', 'Objects', [{ cmd: 'slide.add', args: { id: 's-1', title: 'One' } }]);
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../fixtures/synthetic/clip-2s.mp4', import.meta.url)), path.join(root, 'assets/clip.mp4'));
  fs.copyFileSync(fileURLToPath(new URL('../fixtures/synthetic/captions-2s.vtt', import.meta.url)), path.join(root, 'assets/clip.vtt'));
  await open(page, 'ix-objects', 'Objects');
  await page.getByRole('button', { name: 'Insert slider (adds a number variable)' }).click();
  await idle(page);
  let d = load('ix-objects');
  const slider = d.slides[0].objects.find((o) => o.type === 'slider');
  expect([slider.var, d.variables.find((v) => v.name === 'Slider1')]).toEqual(['Slider1', { name: 'Slider1', type: 'number', initial: 0 }]);
  await commit(page.getByLabel('End value'), 20);
  await commit(page.getByLabel('Step'), 5);
  await page.getByLabel('Update the variable while dragging').uncheck();
  await idle(page);
  d = load('ix-objects');
  expect(d.slides[0].objects.find((o) => o.id === slider.id)).toMatchObject({ max: 20, step: 5, live: false });
  await page.getByRole('button', { name: 'Insert dial (adds a number variable)' }).click();
  await idle(page);
  d = load('ix-objects');
  expect(d.slides[0].objects.find((o) => o.type === 'dial').var).toBe('Dial1');
  expect(d.variables.find((v) => v.name === 'Dial1').initial).toBe(6);
  await commit(page.getByLabel('Angle at end (degrees)'), 135);

  await page.getByRole('button', { name: /^Insert video/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Insert video' });
  await dlg.getByLabel('Video file path', { exact: true }).fill('assets/clip.mp4');
  await dlg.getByLabel('Description (accessible name)').fill('Test pattern');
  await dlg.getByLabel('Captions file (.vtt, optional)', { exact: true }).fill('assets/clip.vtt');
  await dlg.getByRole('button', { name: 'Insert video' }).click();
  await expect(page.locator('.obj.t-video')).toHaveCount(1); // the batch is sent after the dialog's close event
  await idle(page);
  d = load('ix-objects');
  const vid = d.slides[0].objects.find((o) => o.type === 'video');
  expect(d.assets.find((a) => a.id === vid.media).path).toBe('assets/clip.mp4');
  expect(d.assets.find((a) => a.id === vid.captions).path).toBe('assets/clip.vtt');
  expect(vid.alt).toBe('Test pattern');
  await page.getByLabel('Play automatically').check();
  await idle(page);
  await page.getByLabel('Show player controls').uncheck();
  await idle(page);
  d = load('ix-objects');
  expect(d.slides[0].objects.find((o) => o.id === vid.id)).toMatchObject({ autoplay: true, controls: false });
  await expect(page.locator(`#obj-${vid.id}`)).toContainText('clip.mp4 · CC · autoplay');
  await expect(page.locator(`#obj-${slider.id} .slider-thumb`)).toBeVisible();
  await page.getByRole('button', { name: 'Insert marker (a button that opens a label)' }).click();
  await idle(page);
  await commit(page.getByLabel('Label text (shown while the marker is open)'), 'Keep the sash low');
  d = load('ix-objects');
  expect(d.slides[0].objects.find((o) => o.type === 'marker')).toMatchObject({ text: 'Marker', detail: 'Keep the sash low', w: 48, h: 48 });
  await audit(page);
  await page.screenshot({ path: path.join(SHOTS, 'editor-ix-objects.png') });
  expect(validate(load('ix-objects'))).toEqual([]);
});

test('hotspot question: areas in the Question tab and dragged/resized on the canvas (question.set per gesture)', async ({ page }) => {
  seed('ix-hotspot', 'Hotspot', [{ cmd: 'slide.add', args: { id: 's-hs', title: 'Find it', objects: [{ id: 'o-pic', type: 'shape', x: 100, y: 120, w: 600, h: 400, text: 'picture' }] } }]);
  await open(page, 'ix-hotspot', 'Hotspot');
  await page.getByRole('tab', { name: 'Question' }).click();
  await page.getByRole('button', { name: 'Make this a question slide' }).click();
  await page.getByLabel('Question type').selectOption('hotspot');
  await page.getByLabel('Prompt').fill('Click the valve');
  await expect(page.getByLabel('Area 1 id')).toHaveValue('area-1');
  await expect(page.getByLabel('Correct area')).toBeChecked();
  await page.getByRole('button', { name: '+ Area' }).click();
  await page.getByLabel('Area 2 shape').selectOption('ellipse');
  await page.getByRole('button', { name: 'Save question' }).click();
  await idle(page);
  let q = load('ix-hotspot').slides[0].question;
  expect(q.type).toBe('hotspot');
  expect(q.areas.map((a) => [a.id, a.shape ?? 'rect', !!a.correct])).toEqual([['area-1', 'rect', true], ['area-2', 'ellipse', false]]);
  // Canvas: drag area 2 (on top, offset +30,+30 from area 1) by (50, 30) slide px, then resize it from its handle.
  const area = page.locator('.q-area').nth(1);
  const zoom = await page.evaluate(() => Number(getComputedStyle(document.getElementById('stage')).getPropertyValue('--zoom')));
  const b = await area.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 50 * zoom, b.y + b.height / 2 + 30 * zoom, { steps: 5 });
  await page.mouse.up();
  await idle(page);
  q = load('ix-hotspot').slides[0].question;
  expect([q.areas[0].x, q.areas[0].y, q.areas[1].x, q.areas[1].y]).toEqual([540, 285, 570 + 50, 315 + 30]);
  await expect(page.getByLabel('Area 2 X')).toHaveValue('620'); // the open form follows the canvas
  const hb = await area.locator('.handle').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 40 * zoom, hb.y + hb.height / 2 + 20 * zoom, { steps: 5 });
  await page.mouse.up();
  await idle(page);
  q = load('ix-hotspot').slides[0].question;
  expect([q.areas[1].w, q.areas[1].h, q.areas[1].shape]).toEqual([240, 170, 'ellipse']);
  await expect(page.locator('.q-banner')).toHaveText('Click the valve');
  await audit(page);
  await page.screenshot({ path: path.join(SHOTS, 'editor-ix-hotspot.png') });
});

test('matching rows and sequence order in the Question tab', async ({ page }) => {
  seed('ix-lists', 'Lists', [{ cmd: 'slide.add', args: { id: 's-m', title: 'Match' } }, { cmd: 'slide.add', args: { id: 's-s', title: 'Order' } }]);
  await open(page, 'ix-lists', 'Lists');
  await page.getByRole('tab', { name: 'Question' }).click();
  await page.getByRole('button', { name: 'Make this a question slide' }).click();
  await page.getByLabel('Question type').selectOption('matching');
  await page.getByLabel('Prompt').fill('Match the signs');
  await page.getByLabel('Choice 1 label').fill('Biohazard');
  await page.getByLabel('Choice 2 label').fill('Radiation');
  await expect(page.getByLabel('Correct', { exact: true })).toHaveCount(0); // matching keys live on the rows
  await page.getByRole('button', { name: '+ Row' }).click();
  await page.getByLabel('Row 1 statement').fill('Blood');
  await page.getByRole('button', { name: '+ Row' }).click();
  await page.getByLabel('Row 2 statement').fill('Isotope');
  await page.getByLabel('Row 2 correct choice').selectOption('b');
  await page.getByRole('button', { name: 'Save question' }).click();
  await idle(page);
  let q = load('ix-lists').slides[0].question;
  expect([q.type, q.rows, q.choices.map((c) => c.label)]).toEqual(['matching', [{ id: 'row-1', label: 'Blood', choice: 'a' }, { id: 'row-2', label: 'Isotope', choice: 'b' }], ['Biohazard', 'Radiation']]);
  await audit(page);
  await page.locator('#slide-s-s').click();
  await page.getByRole('button', { name: 'Make this a question slide' }).click();
  await page.getByLabel('Question type').selectOption('sequence');
  await page.getByLabel('Prompt').fill('Order the steps');
  await page.getByLabel('Choice 1 label').fill('Second');
  await page.getByLabel('Choice 2 label').fill('First');
  await page.getByRole('button', { name: 'Move choice 1 down' }).click();
  await page.getByRole('button', { name: 'Save question' }).click();
  await idle(page);
  q = load('ix-lists').slides[1].question;
  expect([q.type, q.choices.map((c) => c.label)]).toEqual(['sequence', ['First', 'Second']]);
  await audit(page);
  await page.screenshot({ path: path.join(SHOTS, 'editor-ix-sequence.png') });
});

test('drag-and-drop question: targets and items chosen from the slide objects; badges on the canvas', async ({ page }) => {
  seed('ix-dd', 'Drag', [{ cmd: 'slide.add', args: { id: 's-dd', title: 'Sort', objects: [
    { id: 'o-bin', type: 'shape', x: 100, y: 400, w: 300, h: 200, text: 'Bin' },
    { id: 'o-bag', type: 'shape', x: 600, y: 400, w: 300, h: 200, text: 'Bag' },
    { id: 'o-glass', type: 'shape', x: 100, y: 100, w: 160, h: 50, text: 'Glass' },
    { id: 'o-paper', type: 'shape', x: 300, y: 100, w: 160, h: 50, text: 'Paper' },
  ] } }]);
  await open(page, 'ix-dd', 'Drag');
  await page.getByRole('tab', { name: 'Question' }).click();
  await page.getByRole('button', { name: 'Make this a question slide' }).click();
  await page.getByLabel('Question type').selectOption('dragdrop');
  await page.getByLabel('Prompt').fill('Sort the waste');
  await page.getByRole('button', { name: '+ Target' }).click();
  await page.getByRole('button', { name: '+ Target' }).click();
  await page.getByLabel('Target 2 object').selectOption('o-bag');
  await page.getByLabel('Target 2 holds').selectOption('many');
  await page.getByRole('button', { name: '+ Item' }).click();
  await page.getByLabel('Item 1 object').selectOption('o-glass');
  await page.getByLabel('Item 1 correct target').selectOption('o-bin');
  await page.getByRole('button', { name: '+ Item' }).click();
  await page.getByLabel('Item 2 object').selectOption('o-paper');
  await page.getByRole('button', { name: 'Save question' }).click();
  await idle(page);
  const q = load('ix-dd').slides[0].question;
  expect([q.type, q.items, q.targets]).toEqual(['dragdrop', [{ object: 'o-glass', target: 'o-bin' }, { object: 'o-paper' }], [{ object: 'o-bin' }, { object: 'o-bag', capacity: 'many' }]]);
  await expect(page.locator('#obj-o-glass')).toHaveClass(/dd-item/);
  await expect(page.locator('#obj-o-bag')).toHaveClass(/dd-target/);
  await audit(page);
  await page.screenshot({ path: path.join(SHOTS, 'editor-ix-dragdrop.png') });
});
