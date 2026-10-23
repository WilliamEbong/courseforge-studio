// P2.10 GUI parity: the editor's "From outline" dialog sends the same outline.add {text} an agent sends, in both
// modes. Ids come from the server's random generator, so the check compares structure, not ids.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse, validate } from '../../packages/schema/index.js';

const TOKEN = 'e2e-token-outline-0123456789';
const OUTLINE = ['# Basics', '## Why it matters', 'Most incidents start small.', '- Wear goggles', '- Label everything', '## Check', '? What first?', '[x] Goggles', '[ ] Coffee', '# Practice', '## Spills', '? Type stop', '= stop'].join('\n');
let server, base, root;
test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-editor-outline-'));
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });
test.beforeEach(async ({ context }) => { await context.route((u) => !['127.0.0.1', 'localhost'].includes(u.hostname), (r) => r.abort()); });

const shape = (doc) => doc.mode === 'lessons'
  ? doc.sections.map((s) => [s.title, s.lessons.map((l) => [l.title, l.blocks.map((b) => b.kind || b.type)])])
  : doc.scenes.map((sc) => [sc.title, sc.slides.map((id) => { const s = doc.slides.find((x) => x.id === id); return [s.title, s.question?.type ?? null]; })]);

for (const mode of ['slides', 'lessons']) {
  test(`From outline (${mode}): the dialog adds the same structure as outline.add {text}`, async ({ page }) => {
    const name = `outline-${mode}`;
    io.saveCourse(path.join(root, `${name}.course.json`), emptyCourse({ title: 'Outline', mode }));
    await page.goto(`${base}/?token=${TOKEN}#${name}`);
    const idle = () => page.waitForFunction(() => document.body.dataset.busy === '0');
    await idle();
    await page.getByRole('button', { name: 'From outline' }).click();
    const dlg = page.getByRole('dialog', { name: 'Create from an outline' });
    await dlg.getByLabel('Outline').fill(OUTLINE);
    await dlg.getByRole('button', { name: 'Add to course' }).click();
    await idle();
    await expect(dlg).toBeHidden();
    const got = io.loadCourse(path.join(root, `${name}.course.json`));
    const want = applyAll(emptyCourse({ title: 'Outline', mode }), [{ cmd: 'outline.add', args: { text: OUTLINE } }]).doc;
    expect(validate(got)).toEqual([]);
    expect(shape(got)).toEqual(shape(want));
  });
}

test('From outline: a syntax error is shown with its line and nothing changes', async ({ page }) => {
  io.saveCourse(path.join(root, 'outline-bad.course.json'), emptyCourse({ title: 'Outline' }));
  await page.goto(`${base}/?token=${TOKEN}#outline-bad`);
  await page.waitForFunction(() => document.body.dataset.busy === '0');
  await page.getByRole('button', { name: 'From outline' }).click();
  const dlg = page.getByRole('dialog', { name: 'Create from an outline' });
  await dlg.getByLabel('Outline').fill('# A\ntext before any item');
  await dlg.getByRole('button', { name: 'Add to course' }).click();
  await expect(page.getByText(/line 2: text before the first "## " item/).first()).toBeVisible(); // error panel (+ live region)
  expect(io.loadCourse(path.join(root, 'outline-bad.course.json')).slides).toEqual([]);
});
