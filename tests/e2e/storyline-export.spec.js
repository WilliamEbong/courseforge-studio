import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { exportCourse } from '../fixtures/synthetic/storyline-export.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { createServer as serveStatic } from '../../packages/lms-test-harness/serve.js';
import { createServer as serveEditor } from '../../packages/server/server.js';
import { saveCourse } from '../../packages/cli/io.js';

let root, web, editor, webUrl, editorUrl;
const token = 'storyline-export-e2e-token';
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-export-e2e-'));
  const doc = exportCourse();
  publishWeb(doc, path.join(root, 'web'));
  expect(validatePackage(path.join(root, 'web'))).toEqual([]);
  saveCourse(path.join(root, 'demo.course.json'), doc);
  fs.writeFileSync(path.join(root, 'host.html'), '<!doctype html><html><head><title>Web Object host</title><link rel="icon" href="data:,"></head><body><h1>Host stays here</h1><iframe title="Web Object" src="web/index.html" width="960" height="540"></iframe></body></html>');
  web = serveStatic(root); web.listen(0, '127.0.0.1'); await once(web, 'listening');
  editor = serveEditor({ root, token, port: 0 }); await once(editor, 'listening');
  webUrl = `http://127.0.0.1:${web.address().port}`;
  editorUrl = `http://127.0.0.1:${editor.address().port}`;
});
test.afterAll(async () => {
  for (const s of [web, editor]) { s.closeAllConnections(); await new Promise(r => s.close(r)); }
  fs.rmSync(root, { recursive: true, force: true });
});

for (const origin of ['http', 'file']) test(`web folder in stage-size iframe reaches completion (${origin})`, async ({ page, context }) => {
  const remote = [], errors = [], failed = [];
  await context.route(url => /^https?:$/.test(url.protocol) && url.hostname !== '127.0.0.1', route => { remote.push(route.request().url()); return route.abort(); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('requestfailed', r => failed.push(r.url()));
  const url = origin === 'http' ? webUrl + '/host.html' : pathToFileURL(path.join(root, 'host.html')).href;
  await page.goto(url);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Open details', exact: true }).click();
  await expect(frame.getByText('Layer preserved in the Web Object')).toBeVisible();
  await frame.getByRole('button', { name: 'Go to question', exact: true }).click();
  await frame.getByRole('radio', { name: 'Ellipse', exact: true }).check();
  await frame.getByRole('button', { name: 'Submit', exact: true }).click();
  await frame.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(frame.getByText('Course finished')).toBeVisible();
  const status = await page.frames()[1].evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    return JSON.parse(localStorage.getItem('cf:storyline-export'));
  });
  expect(status.status).toBe('completed');
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('heading', { name: 'Host stays here' })).toBeVisible();
  const size = await page.locator('iframe').evaluate(el => ({ w: el.clientWidth, h: el.clientHeight }));
  expect(size).toEqual({ w: 960, h: 540 });
  expect(remote).toEqual([]); expect(errors).toEqual([]); expect(failed).toEqual([]);
});

test('editor Export for Storyline dialog publishes all formats and reports omissions', async ({ page }) => {
  await page.goto(`${editorUrl}/?token=${token}#demo`);
  await expect(page.locator('#course-title')).toHaveText('Storyline export smoke check');
  await page.getByRole('button', { name: 'Export for Storyline', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export for Storyline' });
  await expect(dialog.getByText(/Insert > Web Object/)).toBeVisible();
  for (const [label, file] of [['Export PowerPoint', 'demo-pptx.pptx'], ['Export questions (Excel)', 'demo-questions.xlsx'], ['Export questions (text)', 'demo-questions.txt'], ['Publish Web folder', 'demo-web']]) {
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText(file);
    expect(fs.existsSync(path.join(root, 'dist', file))).toBe(true);
    if (file.includes('.')) expect(fs.existsSync(path.join(root, 'dist', file + '.export-report.json'))).toBe(true);
  }
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Export for Storyline', exact: true })).toBeFocused();
});
