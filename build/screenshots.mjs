// Regenerates the user-guide screenshots in docs/images from the sample courses, with a scripted (offline) Claude.
// Run: npm run screenshots
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from '../packages/server/server.js';
import { fakeProvider } from '../packages/ai/assistant.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'images');
const TOKEN = 'screenshots-token-0123456789';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-shots-'));
fs.cpSync(path.join(ROOT, 'samples'), root, { recursive: true, filter: (f) => !f.endsWith('.jsonl') && !f.endsWith('.scenario.json') });

const OUTLINE = '# Know the risks\n## What starts fires at work\nMost workplace fires start with electrical faults, heaters or waste near heat.\n- Overloaded sockets\n- Heaters near paper\n## Your part\nKeep exits clear and report hazards.\n# When the alarm sounds\n## Leave by the nearest exit\nStop work and go to the assembly point.\n? What do you do first when the alarm sounds?\n[x] Stop work and leave by the nearest exit\n[ ] Collect your belongings\n[ ] Finish the task';
const provider = fakeProvider((prompt) => prompt.startsWith('Course brief:')
  ? { structured: { title: 'Fire Safety at Work', outline: OUTLINE } }
  : { batches: [[{ cmd: 'object.set', args: { id: 'o-w-intro', text: 'Every experiment starts before you touch a flask. In fifteen minutes you will pick the right protective gear, handle a spill and check what you learned.' } }], [{ cmd: 'object.set', args: { id: 'o-w-start', text: "Let's begin" } }]],
      summary: 'Tightened the welcome text and changed the Start button to "Let\'s begin". Nothing else changed.', costUsd: 0.03 });
const server = createServer({ root, token: TOKEN, port: 0, dataDir: path.join(root, '.data'), aiProvider: provider });
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
await fetch(`${base}/api/ai`, { method: 'POST', headers: { 'x-cf-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
const shot = async (name, clip) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) }); console.log(name); };
const dialogShot = async (name) => { const b = await page.locator('dialog[open]').boundingBox(); await shot(name, { x: b.x - 16, y: b.y - 16, width: b.width + 32, height: Math.min(b.height + 32, 900 - b.y + 16) }); };
const open = async (hash) => { await page.goto(`${base}/?token=${TOKEN}${hash ? `#${hash}` : ''}`); await page.locator(hash ? '#course-title' : '.course-card').first().waitFor(); };
const tab = (name) => page.getByRole('tab', { name, exact: true }).click();
const obj = (id) => page.locator(`#stage .obj[data-id="${id}"]`);

await open();
await shot('courses');

await open('lab-safety');
await shot('editor');
await obj('o-w-start').click();
await shot('select');
await obj('o-w-start').click({ button: 'right' });
await shot('object-menu');
await page.keyboard.press('Escape');
await tab('States');
await shot('states');
await tab('Triggers');
await shot('triggers');
await page.getByRole('button', { name: /^Edit trigger/ }).first().click();
await shot('trigger-edit');
await page.locator('.trig-form').getByRole('button', { name: 'Cancel' }).click();
await page.locator('#slide-s-ppe').click();
await tab('Layers');
await page.getByRole('button', { name: /^Edit layer/ }).first().click();
await shot('layers');
await page.locator('#edit-layer').selectOption('');
await page.locator('#slide-s-q1').click();
await tab('Question');
await shot('question');
await tab('Course');
await shot('course-settings');
await page.getByRole('button', { name: 'Insert image (registers an asset)' }).click();
await dialogShot('insert-image');
await page.keyboard.press('Escape');
await page.locator('#btn-check').click();
await dialogShot('check');
await page.keyboard.press('Escape');
await page.locator('#btn-preview').click();
await page.waitForTimeout(800);
await shot('preview');
await page.keyboard.press('Escape');
await page.locator('#btn-storyline-export').click();
await dialogShot('export-storyline');
await page.keyboard.press('Escape');
await page.keyboard.press('Shift+?');
await dialogShot('shortcuts');
await page.keyboard.press('Escape');

await page.locator('#slide-s-welcome').click();
await page.keyboard.press('Control+i');
await page.locator('#ai-prompt').fill('Make the welcome text tighter and the start button friendlier');
await page.keyboard.press('Control+Enter');
await page.getByRole('button', { name: 'Apply' }).waitFor();
await shot('assistant');
await page.getByRole('button', { name: 'AI settings' }).click();
await dialogShot('ai-settings');
await page.keyboard.press('Escape');

await open('lab-basics-lessons');
await shot('lessons-editor');

await open();
await page.getByRole('button', { name: /Create with AI/ }).click();
await page.getByLabel('What should the course teach?').fill('Fire safety basics for office staff: preventing fires and what to do when the alarm sounds');
await page.getByLabel('Who is it for?').fill('All office staff');
await page.getByRole('button', { name: 'Draft the outline' }).click();
await page.getByRole('button', { name: 'Build the course' }).waitFor();
await dialogShot('create-ai');

await browser.close();
server.closeAllConnections();
server.close();
fs.rmSync(root, { recursive: true, force: true });
