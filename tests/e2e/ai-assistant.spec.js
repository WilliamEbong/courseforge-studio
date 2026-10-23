// Claude in the editor, with the fake provider (no network): the start screen says how to connect Claude; AI settings
// turn it on; a request from the panel shows a change card; Apply changes the course as one undo step; Discard does not.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../packages/server/server.js';
import { fakeProvider } from '../../packages/ai/assistant.js';
import * as io from '../../packages/cli/io.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'ai-token-0123456789abcdefgh';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const STEPS = [
  { batches: [[{ cmd: 'object.set', args: { id: 'o-w-start', text: "Let's begin" } }]], summary: 'Changed the Start button to "Let\'s begin".' },
  { batches: [[{ cmd: 'object.set', args: { id: 'o-w-start', text: 'Go' } }]], summary: 'Changed the Start button to "Go".' },
];
let server, base, root;

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-ai-e2e-'));
  fs.cpSync(path.join(ROOT, 'samples'), root, { recursive: true, filter: (f) => !f.endsWith('.jsonl') && !f.endsWith('.scenario.json') });
  server = createServer({ root, token: TOKEN, port: 0, dataDir: path.join(root, '.data'), aiProvider: fakeProvider(STEPS) });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });

const startText = () => io.loadCourse(path.join(root, 'lab-safety.course.json')).slides[0].objects.find((o) => o.id === 'o-w-start').text;

test('connect, ask, review the change card, Apply, Undo, then Discard a second proposal', async ({ page }) => {
  await page.goto(`${base}/?token=${TOKEN}`);
  await expect(page.locator('#ai-line')).toContainText('switched off');
  await page.getByRole('button', { name: 'Set up Claude' }).click();
  await page.getByLabel('Let Claude read and propose changes to the course you are working on').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('#ai-line')).toContainText('Claude is ready');

  await page.getByRole('button', { name: /Lab Safety Essentials/ }).click();
  await expect(page.locator('#course-title')).toHaveText('Lab Safety Essentials');
  await page.keyboard.press('Control+i');
  const panel = page.getByRole('complementary', { name: 'Claude' });
  await expect(panel).toBeVisible();
  await expect(page.locator('#ai-prompt')).toBeFocused();
  await page.locator('#ai-prompt').fill('Make the start button friendlier');
  await page.keyboard.press('Control+Enter');
  await expect(panel.getByText('Changed the Start button to "Let\'s begin".')).toBeVisible();
  await expect(panel.locator('.ai-diff .d-add')).toContainText("Let's begin");
  expect(startText()).toBe('Start'); // nothing changes before Apply
  const axe = await new AxeBuilder({ page }).include('#ai-panel').withTags(TAGS).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0].target}`)).toEqual([]);

  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(panel.getByText('Applied. Undo reverses it.')).toBeVisible();
  expect(startText()).toBe("Let's begin");
  await expect(page.locator('#btn-undo')).toHaveAttribute('title', /^Undo: AI: Changed the Start button/);
  await page.locator('#btn-undo').click();
  await expect.poll(startText).toBe('Start');

  await page.locator('#ai-prompt').fill('Shorter, please');
  await panel.getByRole('button', { name: 'Send' }).click();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect(panel.getByText('Discarded.')).toBeVisible();
  expect(startText()).toBe('Start');
  expect(fs.readdirSync(root).filter((f) => f.startsWith('.ai-draft'))).toEqual([]);
});
