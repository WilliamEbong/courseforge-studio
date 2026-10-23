// (P2.4) end to end: entrance/exit effects in the published player (timing: fade in from the object's
// start, fade out ending at its end; fly in from below the stage), reduced motion, and the editor's Animation group
// building the same object.set command an agent sends. Every non-local request is aborted and fails the test.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';

const EFFECTS = [
  { cmd: 'slide.add', args: { id: 's-1', title: 'Effects', duration: 3000, objects: [
    { id: 'o-text', type: 'text', text: 'Faded text', x: 200, y: 120, w: 600, h: 80, start: 1000, end: 2000, enter: { effect: 'fade', duration: 0.5 }, exit: { effect: 'fade', duration: 0.25 } },
    { id: 'o-btn', type: 'button', text: 'Flown button', x: 200, y: 400, w: 300, h: 60, enter: { effect: 'fly', duration: 0.75 } },
  ] } },
  { cmd: 'slide.add', args: { id: 's-2', title: 'After' } },
];
let url;
test.beforeAll(() => {
  const r = applyAll(emptyCourse({ id: 'fx', title: 'Effects' }), [{ cmd: 'player.set', args: { resume: 'never' } }, ...EFFECTS]);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-e2e-fx-'));
  publishWeb(r.doc, dir);
  expect(validatePackage(dir)).toEqual([]);
  url = pathToFileURL(path.join(dir, 'index.html')).href;
});
const external = [];
test.beforeEach(async ({ context }) => {
  external.length = 0;
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => { external.push(r.request().url()); return r.abort(); });
});
test.afterEach(() => expect(external).toEqual([]));

/** Opacity of the text and the button's vertical offset, every frame until the text has appeared and left. */
async function sample(page) {
  return page.evaluate(() => new Promise((done) => {
    const text = [...document.querySelectorAll('.cf-obj')].find((e) => e.textContent === 'Faded text');
    const btn = [...document.querySelectorAll('.cf-obj')].find((e) => e.textContent === 'Flown button');
    const out = [], t0 = performance.now();
    (function frame() {
      const t = performance.now() - t0;
      out.push({ t, shown: !text.hidden, op: Number(getComputedStyle(text).opacity), ty: btn.getBoundingClientRect().top });
      const seen = out.some((x) => x.shown), gone = seen && text.hidden;
      if (!gone && t < 8000) requestAnimationFrame(frame); else done(out); // until the text has come and gone (a loaded CPU can start late)
    })();
  }));
}

test('published player: fade in from the start, fade out ending at the end, fly in from below', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(url);
  const s = await sample(page);
  const first = s.find((x) => x.shown);
  expect(first, 'the text appears').toBeTruthy();
  // Shape, not wall-clock windows (frames stretch under a loaded CPU): rising, then fully opaque, then falling.
  const shown = s.filter((x) => x.shown);
  const full = shown.findIndex((x) => x.op === 1);
  expect(full, 'reaches full opacity').toBeGreaterThan(0);
  expect(shown[0].op).toBeLessThan(0.6); // starts transparent: a linear 0.5 s fade
  expect(shown.slice(0, full).every((x, i, a) => i === 0 || x.op >= a[i - 1].op)).toBe(true);
  expect(shown.at(-1).op).toBeLessThan(1); // the 0.25 s exit is running before the end
  expect(shown.at(-1).t - shown[0].t).toBeGreaterThan(700); // still about a 1 s object: effects do not change visibility
  expect(shown.at(-1).t - shown[0].t).toBeLessThan(1400);
  expect(s[0].ty).toBeGreaterThan(s.at(-1).ty + 20); // the button started lower and moved up
});

test('reduced motion: objects appear and leave at the same times, without effects', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  const s = await sample(page);
  const first = s.find((x) => x.shown);
  expect(s.find((x) => x.t >= first.t + 60).op).toBe(1);
  expect(Math.max(...s.map((x) => x.ty)) - Math.min(...s.map((x) => x.ty))).toBeLessThan(1);
});

test('editor: the Animation group sets the entrance and exit with object.set (same file as the command batch)', async ({ page }) => {
  const TOKEN = 'e2e-token-animations-0123456789';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-editor-fx-'));
  const seed = [{ cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-t', type: 'text', text: 'Hello', x: 100, y: 100, w: 400, h: 80, end: 3000 }] } }];
  io.saveCourse(path.join(root, 'fx.course.json'), applyAll(emptyCourse({ title: 'FX' }), seed).doc);
  const server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/?token=${TOKEN}#fx`);
    const idle = () => page.waitForFunction(() => document.body.dataset.busy === '0');
    await idle();
    await page.locator('[data-id="o-t"]').click();
    await page.getByLabel('Entrance effect').selectOption('fly');
    await idle();
    await page.getByLabel('Fly in from').selectOption('l');
    await idle();
    await page.getByLabel('Entrance duration (s)').fill('0.5');
    await page.getByLabel('Entrance duration (s)').press('Tab');
    await idle();
    await page.getByLabel('Exit effect').selectOption('fade');
    await idle();
    await page.screenshot({ path: fileURLToPath(new URL('../../.tmp/editor-animation.png', import.meta.url)) });
    const want = applyAll(applyAll(emptyCourse({ title: 'FX' }), seed).doc, [
      { cmd: 'object.set', args: { id: 'o-t', enter: { effect: 'fly', duration: 0.5, direction: 'l' } } },
      { cmd: 'object.set', args: { id: 'o-t', exit: { effect: 'fade' } } },
    ]).doc;
    const got = io.loadCourse(path.join(root, 'fx.course.json'));
    expect(got.slides[0].objects[0].enter).toEqual(want.slides[0].objects[0].enter);
    expect(got.slides[0].objects[0].exit).toEqual(want.slides[0].objects[0].exit);
    await page.getByLabel('Entrance effect').selectOption('');
    await idle();
    expect(io.loadCourse(path.join(root, 'fx.course.json')).slides[0].objects[0].enter).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
