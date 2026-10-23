// the canvas behaves like a mature slide editor (handles, zoom, marquee, snapping, object menu
// preview from here, scene order, labelled undo). Each gesture still sends one command batch.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';

const TOKEN = 'maturity-token-0123456789abcdef';
let server, base, root;
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-maturity-'));
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});
const fileOf = (name) => path.join(root, `${name}.course.json`);
const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
const obj = (name, id) => io.loadCourse(fileOf(name)).slides[0].objects.find((o) => o.id === id);
function seed(name) {
  const r = applyAll(emptyCourse({ title: name }), [
    { cmd: 'scene.add', args: { id: 'sc-2', title: 'Second' } },
    { cmd: 'slide.add', args: { id: 's-1', title: 'One', objects: [
      { id: 'o-a', type: 'shape', name: 'Box A', x: 100, y: 100, w: 200, h: 100 },
      { id: 'o-b', type: 'shape', name: 'Box B', x: 500, y: 300, w: 100, h: 100 },
    ] } },
  ]);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  io.saveCourse(fileOf(name), r.doc);
}
async function open(page, name) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?token=${TOKEN}#${name}`);
  await expect(page.locator('#course-title')).toHaveText(name);
  await idle(page);
}
const zoomOf = (page) => page.evaluate(() => Number(getComputedStyle(document.getElementById('stage')).getPropertyValue('--zoom')));
async function dragBy(page, locator, dx, dy, opts = {}) {
  const b = await locator.boundingBox();
  const z = await zoomOf(page);
  const x = b.x + (opts.atX ?? b.width / 2), y = b.y + (opts.atY ?? b.height / 2);
  if (opts.modifier) await page.keyboard.down(opts.modifier);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 5, y + 5, { steps: 2 });
  await page.mouse.move(x + dx * z, y + dy * z, { steps: 6 });
  await page.mouse.up();
  if (opts.modifier) await page.keyboard.up(opts.modifier);
  await idle(page);
}

test('names first in labels; eight handles; edge and corner resize; Shift keeps the aspect ratio', async ({ page }) => {
  seed('handles');
  await open(page, 'handles');
  await expect(page.locator('.tl-name')).toHaveText([/^Box B \(o-b\)$/, /^Box A \(o-a\)$/]); // front object first, name before id
  await page.locator('#obj-o-a').click();
  await expect(page.locator('#obj-o-a .handle')).toHaveCount(8);
  await dragBy(page, page.locator('#obj-o-a .handle.h-w'), -50, 0, { atX: 2, atY: 2 });
  const w1 = obj('handles', 'o-a');
  expect(w1.x + w1.w).toBe(300); // the right edge stays put
  expect(Math.abs(w1.x - 50)).toBeLessThanOrEqual(1);
  await dragBy(page, page.locator('#obj-o-a .handle.h-se'), 125, 0, { atX: 2, atY: 2, modifier: 'Shift' });
  const a = obj('handles', 'o-a');
  expect(a.w / a.h).toBeCloseTo(250 / 100, 1);
  await expect(page.locator('#btn-undo')).toHaveAttribute('title', 'Undo: Change object');
});

test('zoom: buttons and Ctrl+0 / Ctrl+= ; the canvas scrolls when larger than the window', async ({ page }) => {
  seed('zoom');
  await open(page, 'zoom');
  const fitZ = await zoomOf(page);
  await page.locator('#btn-zoom-100').click();
  await expect(page.locator('#zoom')).toHaveText('100%');
  expect(await page.evaluate(() => { const v = document.getElementById('viewport'); return v.scrollWidth > v.clientWidth; })).toBe(true);
  await page.locator('#btn-zoom-in').click();
  await expect(page.locator('#zoom')).toHaveText('125%');
  await page.locator('#obj-o-a').click();
  await page.keyboard.press('Control+0');
  expect(await zoomOf(page)).toBeCloseTo(fitZ, 3);
  await page.keyboard.press('Control+=');
  expect(await zoomOf(page)).toBeCloseTo(fitZ * 1.25, 3);
});

test('marquee selects the objects inside the box; snapping aligns edges, Alt turns it off', async ({ page }) => {
  seed('marquee');
  await open(page, 'marquee');
  const st = await page.locator('#stage').boundingBox();
  const z = await zoomOf(page);
  await page.mouse.move(st.x + 50 * z, st.y + 50 * z);
  await page.mouse.down();
  await page.mouse.move(st.x + 700 * z, st.y + 450 * z, { steps: 8 });
  await expect(page.locator('#stage .marquee')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.obj.sel')).toHaveCount(2);
  await page.mouse.click(st.x + 1000 * z, st.y + 600 * z); // empty canvas: clears
  await expect(page.locator('.obj.sel')).toHaveCount(0);

  // Box B's left edge (500) dropped 3 px from Box A's right edge (300) snaps to it.
  await dragBy(page, page.locator('#obj-o-b'), -197, -200);
  expect([obj('marquee', 'o-b').x, obj('marquee', 'o-b').y]).toEqual([300, 100]);
  await dragBy(page, page.locator('#obj-o-b'), 5, 0, { modifier: 'Alt' }); // 5 px from Box A: snapping would pull it back to 300
  expect(Math.abs(obj('marquee', 'o-b').x - 305)).toBeLessThanOrEqual(1);
});

test('object menu: right-click and Shift+F10, keyboard navigation, order and align commands', async ({ page }) => {
  seed('menu');
  await open(page, 'menu');
  await page.locator('#obj-o-a').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Duplicate' })).toBeFocused(); // Paste is disabled: nothing copied yet
  await menu.getByRole('menuitem', { name: 'Bring to front' }).click();
  await idle(page);
  expect(io.loadCourse(fileOf('menu')).slides[0].objects.map((o) => o.id)).toEqual(['o-b', 'o-a']);
  await page.locator('#obj-o-b').focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('#obj-o-b')).toBeFocused();
  await page.locator('#obj-o-b').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Align left' }).click();
  await idle(page);
  expect(obj('menu', 'o-b').x).toBe(0); // one object aligns to the slide
});

test('preview opens at the current slide; scenes move up and down', async ({ page }) => {
  const r = applyAll(emptyCourse({ title: 'flow' }), [
    { cmd: 'scene.add', args: { id: 'sc-2', title: 'Second' } },
    { cmd: 'slide.add', args: { id: 's-1', title: 'First slide' } },
    { cmd: 'slide.add', args: { id: 's-2', title: 'Later slide', scene: 'sc-2', objects: [{ id: 'o-t', type: 'text', text: 'You are on the later slide', x: 40, y: 40, w: 600, h: 60 }] } },
  ]);
  io.saveCourse(fileOf('flow'), r.doc);
  await open(page, 'flow');
  await page.locator('#slide-s-2').click();
  await page.getByRole('button', { name: 'Preview' }).click();
  const frame = page.frameLocator('dialog iframe');
  await expect(page.locator('dialog iframe')).toHaveAttribute('src', /&slide=s-2$/);
  await expect(frame.getByText('You are on the later slide')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Move scene Second up' }).click();
  await idle(page);
  expect(io.loadCourse(fileOf('flow')).scenes.map((s) => s.id)).toEqual(['sc-2', 'sc-1']);
});

test('paste after the original was deleted still pastes what was copied (Codex UX review 006 #7)', async ({ page }) => {
  seed('clip');
  await open(page, 'clip');
  await page.locator('#obj-o-a').click();
  await page.keyboard.press('Control+c');
  await page.locator('#obj-o-a').press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('#obj-o-a')).toHaveCount(0);
  await idle(page);
  await page.locator('#stage').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+v');
  await idle(page);
  const objs = io.loadCourse(fileOf('clip')).slides[0].objects;
  const copy = objs.find((o) => o.name === 'Box A');
  expect(copy).toBeTruthy();
  expect(copy.id).not.toBe('o-a');
  expect([copy.x, copy.y, copy.w, copy.h]).toEqual([120, 120, 200, 100]);
});

test('Codex review 007: nudges never mix across selections (#5), a refused text save keeps the text (#6), + Slide asks before dropping a draft (#7)', async ({ page }) => {
  seed('r007');
  const r = applyAll(io.loadCourse(fileOf('r007')), [{ cmd: 'slide.add', args: { id: 's-q', title: 'Quiz', question: { type: 'mc', prompt: 'Pick', choices: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B' }] } } }]);
  io.saveCourse(fileOf('r007'), r.doc);
  await open(page, 'r007');
  // #5: while saves are slow, A gets Right and B gets Down; each moves only its own way.
  await page.route('**/api/courses/r007/commands', async (route) => { await new Promise((res) => setTimeout(res, 400)); await route.continue(); });
  await page.locator('#obj-o-a').click();
  await page.keyboard.press('ArrowRight');
  await page.locator('#obj-o-b').click();
  await page.keyboard.press('ArrowDown');
  await idle(page);
  await page.waitForTimeout(500);
  await idle(page);
  expect([obj('r007', 'o-a').x, obj('r007', 'o-a').y, obj('r007', 'o-b').x, obj('r007', 'o-b').y]).toEqual([101, 100, 500, 301]);
  await page.unroute('**/api/courses/r007/commands');
  // #6: the server refuses the text; the field keeps what the author wrote.
  await page.locator('#obj-o-a').click();
  await page.getByRole('tab', { name: 'Properties' }).click();
  await page.route('**/api/courses/r007/commands', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, errors: [{ path: '/0/args/text', code: 'test', message: 'refused for the test' }] }) }));
  const field = page.getByRole('textbox', { name: 'Text (%name% shows a variable)' });
  await field.click();
  await page.keyboard.type('Words worth keeping');
  await page.locator('#p-name').click(); // leave the field: one save, refused
  await expect(page.getByRole('alert').filter({ hasText: 'refused for the test' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Text (%name% shows a variable)' })).toContainText('Words worth keeping');
  await page.unroute('**/api/courses/r007/commands');
  // #7: an unsaved question draft is confirmed before + Slide replaces it.
  await page.locator('#slide-s-q').click();
  await page.getByRole('tab', { name: 'Question' }).click();
  await page.locator('#q-prompt').fill('A draft prompt');
  const before = io.loadCourse(fileOf('r007')).slides.length;
  await page.getByRole('button', { name: 'Add slide' }).click();
  await expect(page.getByRole('dialog')).toContainText('Discard the unsaved question?');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await idle(page);
  expect(io.loadCourse(fileOf('r007')).slides.length).toBe(before);
  await expect(page.locator('#q-prompt')).toHaveValue('A draft prompt');
});

test('at 1440 px the top bar is one row and a long timeline never stretches the page', async ({ page }) => {
  const objects = Array.from({ length: 12 }, (_, i) => ({ id: `o-${i}`, type: 'text', name: `Line ${i + 1}`, text: `Line ${i + 1}`, x: 40, y: 40 + i * 50, w: 400, h: 40 }));
  const r = applyAll(emptyCourse({ title: 'lab-safety-essentials' }), [{ cmd: 'slide.add', args: { id: 's-1', title: 'One', objects } }]);
  io.saveCourse(fileOf('lab-safety-essentials'), r.doc);
  await open(page, 'lab-safety-essentials');
  await page.locator('#obj-o-0').click();
  for (let i = 0; i < 12; i++) { await page.keyboard.press('ArrowRight'); await idle(page); } // two-digit undo count, as on a real course
  expect(await page.locator('.tl-body').evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true); // more rows than the timeline shows
  expect(await page.evaluate(() => [document.querySelector('header').getBoundingClientRect().height, document.documentElement.scrollHeight - innerHeight])).toEqual([48, 0]);
});
