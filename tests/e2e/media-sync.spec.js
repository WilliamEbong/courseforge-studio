// P2.5 media sync (documented, doc-findings: "base timeline and audio pause while the layer is visible, then resume
// where they stopped when it closes"): a base-layer video holds while a Pause-base layer is open and resumes after.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { publishWeb } from '../../packages/publisher/index.js';

const FIX = fileURLToPath(new URL('../fixtures/synthetic/', import.meta.url));
let url;
test.beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-e2e-msync-'));
  const courseDir = path.join(base, 'course');
  fs.mkdirSync(path.join(courseDir, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'clip-2s.mp4'), path.join(courseDir, 'assets/clip.mp4'));
  const r = applyAll(emptyCourse({ id: 'msync', title: 'Media sync' }), [
    { cmd: 'player.set', args: { resume: 'never' } },
    { cmd: 'asset.add', args: { id: 'a-clip', path: 'assets/clip.mp4', alt: 'Synthetic test pattern' } },
    { cmd: 'slide.add', args: { id: 's-1', title: 'Video', duration: 60000, objects: [
      { id: 'o-vid', type: 'video', media: 'a-clip', autoplay: true, loop: true, x: 160, y: 60, w: 640, h: 360 },
      { id: 'o-open', type: 'button', text: 'Open details', x: 160, y: 460, w: 260, h: 60 },
    ], layers: [{ id: 'l-info', title: 'Details', pauseBase: true, objects: [{ id: 'o-close', type: 'button', text: 'Close details', x: 900, y: 460, w: 260, h: 60 }] }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-open' }, do: [{ action: 'showLayer', layer: 'l-info' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', layer: 'l-info', on: { event: 'click', target: 'o-close' }, do: [{ action: 'hideLayer' }] } },
  ]);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const out = path.join(base, 'web');
  publishWeb(r.doc, out, { courseDir });
  url = pathToFileURL(path.join(out, 'index.html')).href;
});
test.beforeEach(async ({ context }) => { await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => r.abort()); });

test('a Pause-base layer holds the base video; closing it resumes where it stopped', async ({ page }) => {
  await page.goto(url);
  const go = page.getByRole('button', { name: 'Start course' });
  if (await go.isVisible()) await go.click(); // autoplay behind the click-to-start overlay
  const video = page.locator('video');
  const now = () => video.evaluate((v) => ({ t: v.currentTime, paused: v.paused }));
  await expect.poll(async () => (await now()).t, { timeout: 15000 }).toBeGreaterThan(0.3);
  await page.getByRole('button', { name: 'Open details' }).click();
  await expect.poll(async () => (await now()).paused).toBe(true);
  const held = (await now()).t;
  await page.waitForTimeout(700);
  expect((await now()).t).toBeCloseTo(held, 2);
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect.poll(async () => (await now()).paused).toBe(false);
  await expect.poll(async () => (await now()).t, { timeout: 15000 }).not.toBeCloseTo(held, 1);
});
