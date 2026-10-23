// autosave and recovery. Every edit is persisted atomically when the server applies it
// a server crash/restart loses nothing, an edit sent while the server is down is refused (never half-applied),
// and the open editor keeps working after the restart because `cf serve` reuses its token (DIR/.cf-token).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as io from '../../packages/cli/io.js';
import { emptyCourse } from '../../packages/schema/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8511;
let root, child;

async function startServer() {
  child = spawn(process.execPath, [path.join(ROOT, 'packages/server/server.js'), '--root', root, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => { if (/CourseForge Studio editor/.test(String(b))) resolve(); });
    child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
}
const stopServer = () => new Promise((r) => { child.removeAllListeners('exit'); child.once('exit', r); child.kill(); });
const slides = () => io.loadCourse(path.join(root, 'demo.course.json')).slides.length;
const idle = (page) => page.waitForFunction(() => document.body.dataset.busy === '0');

test.beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-recovery-'));
  io.saveCourse(path.join(root, 'demo.course.json'), emptyCourse({ title: 'Demo' }));
});
test.afterAll(async () => { if (child && child.exitCode === null && child.signalCode === null) await stopServer(); fs.rmSync(root, { recursive: true, force: true }); });

test('server restart mid-session: nothing lost, the edit made while it was down is refused, the editor keeps working', async ({ page }) => {
  await startServer();
  const token = fs.readFileSync(path.join(root, '.cf-token'), 'utf8').trim();
  await page.goto(`http://127.0.0.1:${PORT}/?token=${token}#demo`);
  await expect(page.locator('body')).toHaveAttribute('data-live', '1');
  const addSlide = page.getByRole('button', { name: 'Add slide', exact: true });
  await addSlide.click(); await idle(page);
  expect(slides()).toBe(1);

  await stopServer(); // crash/restart
  expect(slides(), 'the saved edit survives the server going away').toBe(1);
  await addSlide.click(); await idle(page);
  await expect(page.getByRole('alert').filter({ hasText: /unreachable/i }).first()).toBeVisible();
  expect(slides(), 'an edit sent while the server is down changes nothing').toBe(1);

  await startServer(); // same root: same token, so the open page is still authorized
  expect(fs.readFileSync(path.join(root, '.cf-token'), 'utf8').trim()).toBe(token);
  await expect(page.locator('body')).toHaveAttribute('data-live', '1', { timeout: 10000 }); // EventSource reconnected
  await addSlide.click(); await idle(page);
  expect(slides(), 'editing continues after the restart').toBe(2);
  await stopServer();
});

test('a crash during a save leaves the previous file intact (atomic temp + rename)', () => {
  const file = path.join(root, 'demo.course.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(`${file}.99999.tmp`, '{"half written'); // what a crash between write and rename leaves behind
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(io.loadCourse(file).title).toBe('Demo');
  const r = io.runCommands(file, [{ cmd: 'slide.add', args: { title: 'After crash' } }]);
  expect(r.ok).toBe(true);
  expect(io.loadCourse(file).slides.at(-1).title).toBe('After crash');
});
