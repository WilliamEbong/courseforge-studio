// end to end: a synthetic .story (line, arrow, no own background, a master footer bar) is imported through
// the shared importStoryFile, published, and opened from file:// at 1440 px; the editor shows the same objects.
// The story is built from the documented structure; no vendor file is used.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { importStoryFile } from '../../packages/import-story/index.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';
import { G, ID, obj, slide, pkg } from '../fixtures/synthetic/story-builder.js';

const TOKEN = 'shapes-e2e-0123456789abcdef';
const SHOTS = fileURLToPath(new URL('../../.tmp/', import.meta.url));
const LINE = ID('o', 201), ARROW = ID('o', 202), FOOTER = ID('o', 501);
const stroke = (hex, w, end = 'none') => `<bG><noFill/><solidLine><clr><srgbClr val="${hex}"/></clr></solidLine><lineStyle w="${w}"><arrow><begin type="none"/><end type="${end}"/></arrow></lineStyle></bG>`;

function storyPackage() {
  const story = `<story id="${G(1)}"><mediaLst><mediaLst /></mediaLst><sceneLst><scene g="${G(30)}"><sldIdLst><sldId>R1</sldId></sldIdLst></scene></sceneLst>`
    + '<propLst><prop id="5">Shapes and masters</prop><prop id="15"><sz w="1280" h="720" /></prop></propLst></story>';
  const shapes = obj('textBox', 203, { at: [100, 80, 900, 140], plain: 'Imported lines and arrows' })
    + obj('line', 201, { at: [100, 400, 600, 400], fill: stroke('C0392B', 4) })
    + obj('arrow', 202, { at: [800, 120, 800, 520], fill: stroke('1F5F9F', 6, 'triangle') });
  return pkg({ story, parts: [slide(101, { name: 'Shapes', shapes, attrs: `resetMode="auto" advMode="user" layoutG="${G(90)}"` })], extra: [
    ['story/slideLayouts/slideLayout2.xml', `<layout g="${G(90)}" internalG="${G(91)}"><bg /><shapeLst /></layout>`],
    ['story/slideMasters/slideMaster.xml', `<master g="${G(92)}"><bg><solidFill><clr><srgbClr val="EAF2E3"/></clr></solidFill></bg>`
      + `<shapeLst>${obj('rect', 501, { at: [0, 660, 1280, 720], fill: '<bG><solidFill><clr><srgbClr val="F0B429"/></clr></solidFill></bG>' })}</shapeLst><layoutIdLst><sldId>RL</sldId></layoutIdLst></master>`],
    ['story/slideMasters/_rels/slideMaster.xml.rels', '<Relationships><Relationship Type="slideLayout" Id="RL" Target="/story/slideLayouts/slideLayout2.xml"/></Relationships>'],
  ] });
}

let root, file, webDir, server, base;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shapes-'));
  fs.mkdirSync(SHOTS, { recursive: true });
  const story = path.join(root, 'source-shapes.story');
  fs.writeFileSync(story, storyPackage());
  file = path.join(root, 'shapes.course.json');
  const r = importStoryFile(story, file);
  expect(r.ok).toBe(true);
  webDir = path.join(root, 'web');
  publishWeb(io.loadCourse(file), webDir, { courseDir: root });
  expect(validatePackage(webDir)).toEqual([]);
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(root, { recursive: true, force: true });
});
let external, errors;
test.beforeEach(async ({ context, page }) => {
  external = [];
  errors = [];
  await context.route((url) => url.protocol !== 'file:' && url.protocol !== 'data:' && !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => { external.push(route.request().url()); return route.abort(); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
});
test.afterEach(() => { expect(external).toEqual([]); expect(errors).toEqual([]); });
const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');

test('published page from file:// at 1440 px: SVG line and arrow, inherited background, master footer behind', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(pathToFileURL(path.join(webDir, 'index.html')).href);
  await expect(page.getByText('Imported lines and arrows')).toBeVisible();
  const line = page.locator(`.cf-obj[data-id="${LINE}"] svg line`);
  await expect(line).toHaveAttribute('stroke', '#c0392b');
  await expect(line).toHaveAttribute('stroke-width', '4');
  const arrow = page.locator(`.cf-obj[data-id="${ARROW}"]`);
  await expect(arrow.locator('svg polygon')).toHaveAttribute('fill', '#1f5f9f');
  const lb = await page.locator(`.cf-obj[data-id="${LINE}"] svg`).boundingBox();
  expect(lb.width).toBeGreaterThan(lb.height * 20); // horizontal
  const ab = await arrow.locator('svg').boundingBox();
  expect(ab.height).toBeGreaterThan(ab.width * 5); // rotated to point down
  const tip = await arrow.locator('svg polygon').boundingBox();
  expect(tip.y + tip.height).toBeGreaterThan(ab.y + ab.height * 0.9); // head at the bottom end
  await expect(page.locator('.cf-stage')).toHaveCSS('background-color', 'rgb(234, 242, 227)');
  const footer = page.locator(`.cf-obj[data-id="${FOOTER}"]`);
  await expect(footer).toHaveCSS('background-color', 'rgb(240, 180, 41)');
  expect(await page.locator('.cf-layer[data-layer="base"] > .cf-obj').first().getAttribute('data-id')).toBe(FOOTER); // behind the slide's own objects
  await page.screenshot({ path: path.join(SHOTS, 'import-shapes-1440.png'), animations: 'disabled' });
});

test('editor: line and arrow drawn as SVG, arrow in the Shape list, locked master object stays put, Insert Shape works', async ({ page }) => {
  await page.goto(`${base}/?token=${TOKEN}#shapes`);
  await expect(page.locator('#course-title')).toHaveText('Shapes and masters');
  await idle(page);
  await expect(page.locator(`#obj-${LINE} svg line`)).toHaveAttribute('stroke', '#c0392b');
  await expect(page.locator(`#obj-${ARROW} svg polygon`)).toHaveAttribute('fill', '#1f5f9f');
  await page.locator(`#obj-${ARROW}`).click();
  await idle(page);
  await expect(page.locator('#p-shape')).toHaveValue('arrow');
  expect(await page.locator('#p-shape option').allTextContents()).toEqual(expect.arrayContaining(['line', 'arrow']));
  const before = io.loadCourse(file).slides[0].objects.find((o) => o.id === FOOTER);
  expect(before.locked).toBe(true);
  const fb = await page.locator(`#obj-${FOOTER}`).boundingBox();
  await page.mouse.move(fb.x + 40, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.mouse.move(fb.x + 90, fb.y + fb.height / 2 - 30, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('ArrowUp');
  await idle(page);
  const after = io.loadCourse(file).slides[0].objects.find((o) => o.id === FOOTER);
  expect([after.x, after.y]).toEqual([before.x, before.y]);
  await expect(page.locator('#p-locked')).toBeChecked();
  const shapes = await page.locator('#stage .obj.t-shape').count();
  await page.getByRole('button', { name: 'Insert shape' }).click();
  await idle(page);
  await expect(page.locator('#stage .obj.t-shape')).toHaveCount(shapes + 1);
  const added = io.loadCourse(file).slides[0].objects.at(-1);
  expect([added.type, added.shape ?? 'rect', added.locked]).toEqual(['shape', 'rect', undefined]);
  await page.screenshot({ path: path.join(SHOTS, 'import-shapes-editor.png') });
});
