import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';

let dir;
test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-composite-focus-'));
  const r = applyAll(emptyCourse({ id: 'composite-focus' }), [
    { cmd: 'player.set', args: { menu: false, resume: 'never' } },
    { cmd: 'var.add', args: { name: 'turn', type: 'number', initial: 0 } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [
      { id: 'before', type: 'button', text: 'Before', x: 40, y: 40, w: 200, h: 60 },
      { id: 'marker', type: 'marker', text: 'Marker', detail: 'Details', tabIndex: 2, x: 300, y: 150, w: 48, h: 48 },
      { id: 'dial', type: 'dial', name: 'Dial', var: 'turn', tabIndex: 1, x: 600, y: 150, w: 160, h: 160 },
      { id: 'after', type: 'button', text: 'After', x: 40, y: 400, w: 200, h: 60 },
    ] } },
  ]);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  publishWeb(r.doc, dir, { courseDir: dir });
  expect(validatePackage(dir)).toEqual([]);
  // Expose the real mounted player only in this disposable package to exercise rerenders.
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('window.CFPlayer.mount(', 'window.focusPlayer = window.CFPlayer.mount('));
});
test.afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test('marker and dial focus order belongs to the inner control and resets when removed', async ({ context, page }) => {
  const errors = [], remote = [];
  await context.route(/^(https?|wss?):\/\//, r => { remote.push(r.request().url()); return r.abort(); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href);
  const marker = page.locator('[data-id="marker"] button');
  const dial = page.locator('[data-id="dial"] input');
  const before = page.getByRole('button', { name: 'Before', exact: true });
  const after = page.getByRole('button', { name: 'After', exact: true });
  await expect(marker).toHaveAttribute('tabindex', '2');
  await expect(dial).toHaveAttribute('tabindex', '1');
  for (const id of ['marker', 'dial']) await expect(page.locator(`[data-id="${id}"]`)).not.toHaveAttribute('tabindex');
  await dial.focus();
  await page.keyboard.press('Tab');
  await expect(marker).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(before).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(after).toBeFocused(); // no second stop on either wrapper or child

  await page.evaluate(() => {
    for (const o of window.focusPlayer.rt.doc.slides[0].objects) if (['marker', 'dial'].includes(o.id)) o.tabIndex = -1;
    window.focusPlayer.render();
  });
  for (const control of [marker, dial]) await expect(control).toHaveAttribute('tabindex', '-1');
  await before.focus();
  await page.keyboard.press('Tab');
  await expect(after).toBeFocused();

  await page.evaluate(() => {
    for (const o of window.focusPlayer.rt.doc.slides[0].objects) delete o.tabIndex;
    window.focusPlayer.render();
  });
  for (const control of [marker, dial]) await expect(control).not.toHaveAttribute('tabindex');
  await before.focus();
  await page.keyboard.press('Tab');
  await expect(marker).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dial).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(after).toBeFocused();
  expect(remote).toEqual([]);
  expect(errors).toEqual([]);
});
