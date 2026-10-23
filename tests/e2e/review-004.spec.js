import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emptyCourse } from '../../packages/schema/index.js';
import { applyAll } from '../../packages/core/index.js';
import { publishWeb } from '../../packages/publisher/index.js';

test('review004 #3: lessons captions load from a file URL, including after revisiting', async ({ page, context }, info) => {
  const blocked = [], errors = [];
  await context.route(/^(https?|wss?):\/\/(?!127\.0\.0\.1[:/])/, (r) => { blocked.push(r.request().url()); return r.abort(); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const root = info.outputPath('caption-course');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  for (const f of ['pattern-1s.webm', 'pattern-1s.vtt']) fs.copyFileSync(fileURLToPath(new URL(`../fixtures/synthetic/${f}`, import.meta.url)), path.join(root, 'assets', f));
  const r = applyAll(emptyCourse({ mode: 'lessons', title: 'Offline caption review' }), [
    { cmd: 'asset.add', args: { id: 'vid', path: 'assets/pattern-1s.webm' } },
    { cmd: 'asset.add', args: { id: 'cc', path: 'assets/pattern-1s.vtt' } },
    { cmd: 'section.add', args: { id: 'sec' } },
    { cmd: 'lesson.add', args: { id: 'lesson', title: 'Caption check', blocks: [{ id: 'video', type: 'video', media: 'vid', captions: 'cc', title: 'Test pattern' }] } },
    { cmd: 'lesson.add', args: { id: 'end', title: 'End' } },
  ]);
  expect(r.ok).toBe(true);
  const out = path.join(root, 'web');
  publishWeb(r.doc, out, { courseDir: root });
  await page.goto(pathToFileURL(path.join(out, 'index.html')).href);
  await page.getByRole('button', { name: 'Start course' }).click();
  const cues = () => page.locator('video').evaluate((v) => { v.textTracks[0].mode = 'showing'; return v.textTracks[0].cues?.length ?? 0; });
  await expect.poll(cues).toBe(1);
  await page.getByRole('button', { name: /Next lesson/ }).click();
  await page.getByRole('button', { name: /Previous lesson/ }).click();
  await expect.poll(cues).toBe(1);
  expect(blocked).toEqual([]);
  expect(errors).toEqual([]);
});
