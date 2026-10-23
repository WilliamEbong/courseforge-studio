import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { publishWeb } from '../../packages/publisher/index.js';

const TOKEN = 'rich-e2e-0123456789abcdef';
let root, server, base;
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-rich-'));
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});
test.beforeEach(async ({ context }) => {
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => r.abort());
});
const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');
function seed(name, rich) {
  const r = applyAll(emptyCourse({ title: name }), [
    { cmd: 'var.add', args: { name: 'learner', type: 'text', initial: 'Ada' } },
    { cmd: 'slide.add', args: { id: 's-one', title: 'Text' } },
    { cmd: 'object.add', args: { slide: 's-one', id: 'o-text', type: 'text', x: 50, y: 50, w: 800, h: 400, text: 'First item\nSecond item', ...(rich ? { rich } : {}) } },
  ]);
  expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  const file = path.join(root, `${name}.course.json`);
  io.saveCourse(file, r.doc);
  return file;
}
async function open(page, name) {
  await page.goto(`${base}/?token=${TOKEN}#${name}`);
  await page.locator('#obj-o-text').click();
  await expect(page.locator('#p-text')).toHaveAttribute('contenteditable', 'true');
}
async function selectAll(page) {
  await page.locator('#p-text').focus();
  await page.keyboard.press('Control+a');
}

test('format selection, commit once, reload, preview and publish', async ({ page }) => {
  const file = seed('rich-edit');
  await open(page, 'rich-edit');
  const before = io.history.depth(file).undo;
  await selectAll(page);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.keyboard.press('Control+i');
  await page.getByRole('button', { name: 'Bullets', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept('https://example.com/learn'));
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  expect(io.history.depth(file).undo).toBe(before);
  await page.locator('#p-alt').focus();
  await idle(page);
  expect(io.history.depth(file).undo).toBe(before + 1);
  const object = io.loadCourse(file).slides[0].objects[0];
  expect(object.rich).toHaveLength(2);
  expect(object.rich.every((p) => p.list === 'bullet' && p.runs.every((r) => r.b && r.i && r.link === 'https://example.com/learn'))).toBe(true);
  await page.reload();
  await page.locator('#obj-o-text').click();
  await expect(page.locator('#obj-o-text strong')).toHaveCount(2);
  await expect(page.locator('#p-text ul li')).toHaveCount(2);
  await page.locator('#btn-preview').click();
  const preview = page.frameLocator('iframe.preview-frame');
  await expect(preview.locator('.cf-stage strong')).toHaveCount(2);
  await expect(preview.locator('.cf-stage ul li')).toHaveCount(2);
  const out = path.join(root, 'published-rich');
  publishWeb(io.loadCourse(file), out, { courseDir: root });
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  await expect(page.locator('.cf-stage strong')).toHaveCount(2);
  await expect(page.locator('.cf-stage ul li a')).toHaveCount(2);
});

test('keyboard toolbar retains selection; plain paste and supported styles survive serialization', async ({ page }) => {
  const file = seed('rich-keyboard', [{ align: 'right', runs: [{ text: 'Preserved', s: true, color: '#123456', size: 23, font: 'Georgia' }] }]);
  await open(page, 'rich-keyboard');
  await selectAll(page);
  // Toolbar precedes the field. Shift+Tab reaches Clear, then Link, Numbering, Bullets, Underline, Italic, Bold.
  for (let i = 0; i < 7; i++) await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+i');
  await page.keyboard.press('Control+u');
  await page.locator('#p-alt').focus();
  await idle(page);
  expect(io.loadCourse(file).slides[0].objects[0].rich).toEqual([{ align: 'right', runs: [{ text: 'Preserved', b: true, i: true, u: true, s: true, color: '#123456', size: 23, font: 'Georgia' }] }]);
  await selectAll(page);
  await page.locator('#p-text').evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', '<script>plain</script>');
    data.setData('text/html', '<img src=x onerror="window.injected=true"><b>HTML</b>');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.locator('#p-alt').focus();
  await idle(page);
  expect(io.loadCourse(file).slides[0].objects[0].text).toBe('<script>plain</script>');
  await expect(page.locator('#obj-o-text script, #obj-o-text img')).toHaveCount(0);
});

test('published renderer escapes text, substitutes variables, nests lists and keeps safe links', async ({ page }) => {
  const file = seed('rich-player', [
    { runs: [{ text: '<script>window.injected=true</script> %learner%', b: true }] },
    { list: 'bullet', level: 1, runs: [{ text: 'Parent' }] },
    { list: 'number', level: 2, runs: [{ text: 'Child', link: 'mailto:author@example.com' }] },
  ]);
  const out = path.join(root, 'published-player');
  publishWeb(io.loadCourse(file), out, { courseDir: root });
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  await expect(page.locator('.cf-stage p').first()).toHaveText('<script>window.injected=true</script> Ada');
  expect(await page.locator('.cf-stage strong').evaluateAll((nodes) => nodes.map((node) => node.textContent).join(''))).toBe('<script>window.injected=true</script> Ada');
  await expect(page.locator('.cf-stage script')).toHaveCount(0);
  await expect(page.locator('.cf-stage ul > li > ol > li > a')).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('strict serializer rejects unsupported markup and links; renderer round trips nested lists', async ({ page }) => {
  await page.goto(`${base}/?token=${TOKEN}`);
  const result = await page.evaluate(async () => {
    const { serializeRich } = await import('/packages/editor/rich-field.js');
    const { renderRich } = await import('/packages/player/rich.js');
    const fragment = document.createElement('template');
    fragment.innerHTML = '<p onclick="evil()"><strong>Safe</strong><a href="javascript:evil()"> link</a><script>evil()</script><img src="x"><span style="background-image:url(x);color:rgb(18,52,86)"> colour</span></p>';
    const rich = [
      { runs: [{ text: 'Title', b: true, i: true, u: true, s: true, color: '#123456', size: 24, font: 'Georgia', link: 'https://example.com' }], align: 'center' },
      { runs: [{ text: 'Parent' }], list: 'bullet', level: 1 },
      { runs: [{ text: 'Child' }], list: 'number', level: 2 },
      { runs: [{ text: 'Sibling' }], list: 'bullet', level: 1 },
      { runs: [{ text: '' }] },
    ];
    const rendered = document.createElement('div');
    renderRich(rendered, rich);
    return { sanitized: serializeRich(fragment.content), rich, roundTrip: serializeRich(rendered) };
  });
  expect(result.sanitized).toEqual([{ runs: [{ text: 'Safe', b: true }, { text: ' link' }, { text: ' colour', color: '#123456' }] }]);
  expect(result.roundTrip).toEqual(result.rich);
});

test('keyboard numbering and link, then clear formatting preserves text', async ({ page }) => {
  const file = seed('rich-clear');
  await open(page, 'rich-clear');
  await selectAll(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Numbering', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Link', exact: true })).toBeFocused();
  page.once('dialog', (dialog) => dialog.accept('HTTPS://example.com'));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+b');
  await page.locator('#p-alt').focus();
  await idle(page);
  expect(io.loadCourse(file).slides[0].objects[0].rich.every((p) => p.list === 'number' && p.runs.every((r) => r.b && r.link === 'https://example.com'))).toBe(true);
  await selectAll(page);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Clear formatting', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.locator('#p-alt').focus();
  await idle(page);
  const object = io.loadCourse(file).slides[0].objects[0];
  expect(object.text).toBe('First item\nSecond item');
  expect(object.rich.every((p) => !p.list && (!p.align || p.align === 'left') && p.runs.every((r) => Object.keys(r).length === 1))).toBe(true);
});

test('canvas link activation keeps the author in the editor', async ({ page }) => {
  seed('rich-canvas-link', [{ runs: [{ text: 'Edit this link', link: 'https://example.com' }] }]);
  await open(page, 'rich-canvas-link');
  const url = page.url();
  const popups = [];
  page.on('popup', (popup) => { popups.push(popup); });
  const prevented = await page.locator('#obj-o-text a').evaluate((link) => !link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(prevented).toBe(true);
  await page.locator('#obj-o-text a').press('Enter');
  await expect(page.locator('#obj-o-text')).toHaveAttribute('aria-pressed', 'true');
  expect(popups).toHaveLength(0);
  expect(page.url()).toBe(url);
});
