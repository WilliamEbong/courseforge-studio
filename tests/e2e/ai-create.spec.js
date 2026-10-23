// Create with AI through the UI (fake provider): brief with a Word document, editable outline, build, open, review,
// then publish the new course to SCORM 1.2.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../../packages/server/server.js';
import { fakeProvider } from '../../packages/ai/assistant.js';
import { zipDir } from '../../packages/publisher/zip.js';
import * as io from '../../packages/cli/io.js';

const TOKEN = 'ai-create-token-0123456789ab';
const OUTLINE = '# Know the risks\n## What starts fires\nMost fires start with electrical faults.\n- Overloaded sockets\n# When the alarm sounds\n## Leave now\nStop work and leave by the nearest exit.\n? What do you do first?\n[x] Leave by the nearest exit\n[ ] Collect your bag';
let server, base, root;
const prompts = [];

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-create-e2e-'));
  const provider = fakeProvider((prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith('Course brief:') && prompt.includes('<document')) return { structured: { title: 'Fire Safety at Work', outline: OUTLINE } };
    if (prompt.startsWith('Course outline:')) return { structured: { findings: [{ title: 'Add feedback', detail: 'The alarm question has no feedback.', fix: 'Add feedback to the alarm question.', severity: 'medium' }] } };
    const scene = /Build scene (\S+)/.exec(prompt)?.[1];
    return { batches: [[{ cmd: 'scene.set', args: { id: scene, title: `${prompt.includes('alarm') ? 'When the alarm sounds' : 'Know the risks'} (built)` } }]], summary: 'Built.' };
  });
  server = createServer({ root, token: TOKEN, port: 0, dataDir: path.join(root, '.data'), aiProvider: provider });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/api/ai`, { method: 'POST', headers: { 'x-cf-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); });

test('brief with a Word document → outline → build → open and review → publish SCORM', async ({ page }) => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-docx-'));
  fs.mkdirSync(path.join(src, 'word'));
  fs.writeFileSync(path.join(src, 'word', 'document.xml'), '<w:document><w:body><w:p><w:r><w:t>Fire policy: leave at once when the alarm sounds.</w:t></w:r></w:p></w:body></w:document>');
  const docx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-docx-out-')), 'Fire Policy.docx');
  fs.writeFileSync(docx, zipDir(src));

  await page.goto(`${base}/?token=${TOKEN}`);
  await page.getByRole('button', { name: /Create with AI/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Create a course with AI' });
  await dlg.getByLabel('What should the course teach?').fill('Fire safety for office staff');
  await dlg.getByLabel('Length').selectOption('10');
  await dlg.getByLabel('Source documents (optional)').setInputFiles(docx);
  await dlg.getByRole('button', { name: 'Draft the outline' }).click();
  await expect(dlg.getByLabel('Course title')).toHaveValue('Fire Safety at Work');
  expect(prompts[0]).toContain('Fire policy: leave at once when the alarm sounds.');
  await expect(dlg.getByLabel('File name')).toHaveValue('fire-safety-at-work');
  await expect(dlg.locator('#cr-count')).toContainText('2 slides; up to 3 suit 10 minutes');
  await dlg.getByRole('button', { name: 'Build the course' }).click();
  await expect(dlg.getByText('Fire Safety at Work is ready.')).toBeVisible();
  await dlg.getByRole('button', { name: 'Open and review it' }).click();

  await expect(page.locator('#course-title')).toHaveText('Fire Safety at Work');
  const panel = page.getByRole('complementary', { name: 'Claude' });
  await expect(panel.getByText('Add feedback', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Fix with Claude' })).toBeVisible();

  const file = path.join(root, 'fire-safety-at-work.course.json');
  const doc = io.loadCourse(file);
  expect(doc.scenes.map((s) => s.title)).toEqual(['Know the risks (built)', 'When the alarm sounds (built)']);
  expect(fs.readdirSync(root).filter((f) => f.startsWith('.ai-draft'))).toEqual([]);

  const pub = await (await fetch(`${base}/api/courses/fire-safety-at-work/publish`, { method: 'POST', headers: { 'x-cf-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ target: 'scorm12', zip: true }) })).json();
  expect(pub.ok).toBe(true);
  expect(fs.existsSync(path.join(root, 'dist', 'fire-safety-at-work-scorm12', 'imsmanifest.xml'))).toBe(true);
});
