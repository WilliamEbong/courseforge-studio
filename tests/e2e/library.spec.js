// SC-2: an image chosen on the Library tab of the editors' image dialog shows in the editor (slides canvas
// lesson page) and in the published package opened from file:// with zero non-local requests. Every library image
// renders. Screenshots of the Library tab in both editors.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';
import { applyAll, query } from '../../packages/core/index.js';
import { emptyCourse, serialize } from '../../packages/schema/index.js';

const TOKEN = 'e2e-library-token-0123456789';
const SHOTS = fileURLToPath(new URL('../../.tmp/', import.meta.url));
const LIBRARY = query(null, 'library.list').data;
const entry = (id) => LIBRARY.find((x) => x.id === id);
let server, base, root;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-library-e2e-'));
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
let requests, errors;
test.beforeEach(async ({ context, page }) => {
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => r.abort());
  requests = []; errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
});
test.afterEach(() => {
  expect(requests.filter((u) => !/^(file:|data:|blob:|http:\/\/127\.0\.0\.1[:/])/.test(u)), 'non-local requests').toEqual([]);
  expect(errors, 'page errors').toEqual([]);
});

const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
const saved = (name) => JSON.parse(fs.readFileSync(path.join(root, `${name}.course.json`), 'utf8'));
const loaded = (img) => img.evaluate((el) => el.complete && el.naturalWidth);
function seed(name, doc, cmds) {
  const r = applyAll(doc, cmds);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  io.saveCourse(path.join(root, `${name}.course.json`), r.doc);
  return r.doc;
}
async function open(page, name, title) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?token=${TOKEN}#${name}`);
  await expect(page.locator('#course-title')).toHaveText(title);
  await idle(page);
}
/** The Library tab of the open image dialog: every image renders; search and tag filter go through library.list. */
async function libraryTab(page, shot) {
  const dlg = page.locator('#dlg');
  await dlg.getByRole('tab', { name: 'Library' }).click();
  await expect(dlg.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true');
  const items = dlg.locator('.lib-item');
  await expect(items).toHaveCount(LIBRARY.length);
  await expect.poll(() => items.locator('img').evaluateAll((imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 240).length)).toBe(LIBRARY.length);
  const unnamed = await dlg.evaluate((d) => [...d.querySelectorAll('button, input, select, [role=tab]')].filter((el) => el.getClientRects().length)
    .filter((el) => !(el.getAttribute('aria-label') || el.labels?.length || el.textContent.trim()) || !(el.dataset.cmd || el.dataset.ui)).map((el) => el.outerHTML.slice(0, 120)));
  expect(unnamed, 'every dialog control has an accessible name and data-cmd/data-ui').toEqual([]);
  await page.keyboard.press('ArrowLeft'); // arrow keys move between the File and Library tabs
  await expect(dlg.getByRole('tab', { name: 'File' })).toBeFocused();
  await expect(dlg.locator('#dlg-panel-file')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(dlg.locator('#dlg-panel-lib')).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, shot) });
  await dlg.getByLabel('Tag').selectOption('ppe');
  await expect(items).toHaveCount(4);
  await dlg.getByLabel('Search the library').fill('MICRO');
  await expect(items).toHaveCount(0);
  await expect(dlg.getByRole('status')).toHaveText('0 images');
  await dlg.getByLabel('Tag').selectOption('');
  await expect(items).toHaveCount(1);
}

test('slides: Insert Image > Library adds a library image; it shows on the canvas and in the published package from file://', async ({ page, context }) => {
  const doc = seed('lib-slides', emptyCourse({ id: 'lib-slides', title: 'Library slides' }), [{ cmd: 'slide.add', args: { id: 's-1', title: 'One' } }]);
  await open(page, 'lib-slides', 'Library slides');
  await page.getByRole('button', { name: 'Insert image (registers an asset)' }).click();
  await expect(page.locator('#dlg')).toBeVisible();
  await libraryTab(page, 'library-tab-slides.png');
  await page.locator('#dlg').getByLabel('Search the library').fill('goggles');
  await page.locator('#dlg').getByRole('button', { name: 'Safety goggles' }).click();
  await expect.poll(() => saved('lib-slides').assets?.length).toBe(1); // the dialog closes before the batch is sent
  await idle(page);
  await expect(page.locator('#dlg')).toBeHidden();
  const after = saved('lib-slides');
  const asset = after.assets[0];
  expect(asset).toEqual({ id: asset.id, path: 'library/goggles.svg', alt: entry('goggles').alt });
  const obj = after.slides[0].objects[0];
  expect(obj).toMatchObject({ type: 'image', image: asset.id, alt: entry('goggles').alt });
  // The saved file is exactly what the same two commands produce for an agent.
  const { id, slide, ...rest } = { ...obj, slide: 's-1' };
  const ref = applyAll(doc, [{ cmd: 'asset.add', args: { id: asset.id, library: 'goggles' } }, { cmd: 'object.add', args: { slide, id, ...rest } }]);
  expect(after).toEqual(JSON.parse(serialize(ref.doc)));
  const canvasImg = page.locator(`#obj-${obj.id} img`);
  expect(await loaded(canvasImg)).toBe(240);
  await page.screenshot({ path: path.join(SHOTS, 'library-slides-canvas.png') });

  await page.getByRole('button', { name: 'Publish Web' }).click();
  await idle(page);
  const out = path.join(root, 'dist', 'lib-slides-web');
  expect(fs.readFileSync(path.join(out, 'library/goggles.svg'))).toEqual(fs.readFileSync(fileURLToPath(new URL('../../packages/library/goggles.svg', import.meta.url))));
  const player = await context.newPage();
  player.on('request', (r) => requests.push(r.url()));
  player.on('pageerror', (e) => errors.push(String(e)));
  await player.goto(pathToFileURL(path.join(out, 'index.html')).href);
  const img = player.getByRole('img', { name: entry('goggles').alt });
  await expect(img).toBeVisible();
  expect(await loaded(img)).toBe(240);
  expect(requests.filter((u) => u.startsWith('file:')).some((u) => u.endsWith('/library/goggles.svg'))).toBe(true);
  await player.screenshot({ path: path.join(SHOTS, 'library-slides-published.png') });
});

test('lessons: Insert block > Image > Library and a gallery\'s "Add an image" use library images on the lesson page', async ({ page }) => {
  seed('lib-lessons', emptyCourse({ id: 'lib-lessons', title: 'Library lessons', mode: 'lessons' }), [
    { cmd: 'section.add', args: { id: 'sec-a', title: 'Basics' } },
    { cmd: 'lesson.add', args: { id: 'l-a', section: 'sec-a', title: 'Equipment', blocks: [{ id: 'b-t', type: 'text', text: 'Know your kit.' }] } }]);
  await open(page, 'lib-lessons', 'Library lessons');
  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  await page.locator('#lv-mi-image').click();
  await expect(page.locator('#dlg')).toBeVisible();
  await libraryTab(page, 'library-tab-lessons.png');
  await page.locator('#dlg').getByRole('button', { name: 'Microscope' }).click();
  await expect.poll(() => saved('lib-lessons').assets?.length).toBe(1);
  await idle(page);
  let doc = saved('lib-lessons');
  const a = doc.assets[0];
  expect(a).toEqual({ id: a.id, path: 'library/microscope.svg', alt: entry('microscope').alt });
  const block = doc.sections[0].lessons[0].blocks[1];
  expect(block).toMatchObject({ type: 'image', image: a.id });
  expect(await loaded(page.locator(`#lv-card-${block.id} img`))).toBe(240);
  expect(query(doc, 'a11y').data.filter((x) => x.code === 'alt-missing')).toEqual([]); // the library alt text counts

  await page.getByRole('button', { name: 'Insert block', exact: true }).click();
  await page.locator('#lv-mi-gallery').click();
  await expect(page.locator('.lv-card')).toHaveCount(3);
  await idle(page);
  await page.getByRole('button', { name: 'Add an image to the gallery from a file or the library' }).click();
  await page.locator('#dlg').getByRole('tab', { name: 'Library' }).click();
  await page.locator('#dlg').getByRole('button', { name: 'Trophy' }).click();
  await expect.poll(() => saved('lib-lessons').assets.length).toBe(2);
  await idle(page);
  doc = saved('lib-lessons');
  const trophy = doc.assets.find((x) => x.path === 'library/trophy.svg');
  const gallery = doc.sections[0].lessons[0].blocks[2];
  expect(gallery.items.at(-1)).toEqual({ image: trophy.id, alt: entry('trophy').alt });
  await expect.poll(() => page.locator(`#lv-card-${gallery.id} img`).evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth === 240))).toBe(true);
  await page.screenshot({ path: path.join(SHOTS, 'library-lessons-page.png') });

  await page.locator('#lv-tab-course').click(); // the cover picker offers the library too
  await page.getByRole('button', { name: 'Add a new file or a library image for the cover' }).click();
  await page.locator('#dlg').getByRole('tab', { name: 'Library' }).click();
  await page.locator('#dlg').getByRole('button', { name: 'Flask' }).click();
  await expect.poll(() => saved('lib-lessons').cover?.image).toBeTruthy();
  await idle(page);
  doc = saved('lib-lessons');
  expect(doc.assets.find((x) => x.id === doc.cover.image).path).toBe('library/flask.svg');
  expect(doc.cover.alt).toBe(entry('flask').alt);
});
