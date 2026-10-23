// Create with AI (fake provider): outline limits and retry, document text, a resumable build that publishes only
// when complete, and the review's findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFlow, maxItems, documentText } from '../../packages/ai/create.js';
import { createSettings } from '../../packages/ai/settings.js';
import { fakeProvider } from '../../packages/ai/assistant.js';
import { zipDir } from '../../packages/publisher/zip.js';
import * as io from '../../packages/cli/io.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-create-'));
const OUTLINE = '# Before you start\n## Why goggles\nEyes are the most exposed.\n- Splash risk\n## Gloves\nPick nitrile for most chemicals.\n# Check\n## Quick check\n? What protects your eyes?\n[x] Goggles\n[ ] Gloves';
function setup(script) {
  const root = tmp(), dataDir = tmp();
  const settings = createSettings(dataDir);
  settings.set({ enabled: true });
  const prompts = [];
  const provider = fakeProvider((prompt, n) => { prompts.push(prompt); return script(prompt, n); });
  return { root, dataDir, settings, prompts, flow: createFlow({ root, dataDir, settings, provider }) };
}

test('maxItems: about three minutes per item, between 3 and 40', () => {
  assert.deepEqual([maxItems(5), maxItems(15), maxItems(60), maxItems(500), maxItems()], [3, 5, 20, 40, 5]);
});

test('documentText: Markdown as is, Word paragraphs as lines, other files left to Claude', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.md'), '# Policy\nWear goggles.');
  assert.equal(documentText(path.join(dir, 'a.md')), '# Policy\nWear goggles.');
  const src = tmp();
  fs.mkdirSync(path.join(src, 'word'));
  fs.writeFileSync(path.join(src, 'word', 'document.xml'), '<w:document><w:body><w:p><w:r><w:t>Spill &amp; splash</w:t></w:r></w:p><w:p><w:r><w:t>Step 2</w:t></w:r></w:p></w:body></w:document>');
  fs.writeFileSync(path.join(dir, 'b.docx'), zipDir(src));
  assert.equal(documentText(path.join(dir, 'b.docx')), 'Spill & splash\nStep 2');
  assert.equal(documentText(path.join(dir, 'c.pdf')), null);
});

test('outline: an oversized outline is retried once with the reason; attachments are included as documents', async () => {
  const big = Array.from({ length: 12 }, (_, i) => `## Item ${i}\nText.`).join('\n');
  const s = setup((_p, n) => ({ structured: n === 0 ? { title: 'Lab PPE', outline: `# A\n${big}` } : { title: 'Lab PPE', outline: OUTLINE } }));
  fs.mkdirSync(path.join(s.root, 'imports'));
  fs.writeFileSync(path.join(s.root, 'imports', 'policy.md'), 'Goggles are required in every lab.');
  const r = await s.flow.outline({ brief: { topic: 'Lab protective equipment', audience: 'new lab staff', minutes: 10, mode: 'slides' }, attachments: ['imports/policy.md'] });
  assert.deepEqual([r.title, r.items, r.limit], ['Lab PPE', 3, 3]);
  assert.match(s.prompts[0], /<document name="policy.md">\nGoggles are required/);
  assert.match(s.prompts[1], /not usable \(12 items, more than the limit of 3\)/);
  await assert.rejects(s.flow.outline({ brief: { topic: 'x' } }), (e) => e.errors[0].code === 'required');
  await assert.rejects(s.flow.outline({ brief: { topic: 'Lab' }, attachments: ['../secret.md'] }), (e) => e.errors[0].code === 'path');
});

test('build: one session per scene on a hidden draft; a failure resumes where it stopped; the course appears only when done', async () => {
  let failOnce = true;
  const s = setup((prompt) => {
    const scene = /Build scene (\S+)/.exec(prompt)?.[1];
    if (!scene) return { summary: 'Feedback left as is.' }; // the post-build feedback pass
    if (prompt.includes('"Check"') && failOnce) { failOnce = false; return { error: { code: 'busy', message: 'Claude is busy.' } }; }
    return { batches: [[{ cmd: 'scene.set', args: { id: scene, title: prompt.includes('"Check"') ? 'Check your understanding' : 'Before you start' } }]], summary: 'Built it.' };
  });
  const args = { name: 'lab-ppe', title: 'Lab PPE', mode: 'slides', outline: OUTLINE, brief: { topic: 'Lab PPE' } };
  const events = [];
  await assert.rejects(s.flow.build({ ...args, onEvent: (e) => events.push(e) }), (e) => e.errors[0].code === 'busy');
  assert.equal(fs.existsSync(path.join(s.root, 'lab-ppe.course.json')), false, 'nothing published while incomplete');
  assert.equal(s.flow.inProgress('lab-ppe'), true);
  const r = await s.flow.build(args);
  assert.deepEqual([r.file, r.parts], ['lab-ppe.course.json', 2]);
  assert.equal(s.prompts.filter((p) => p.includes('"Before you start"')).length, 1, 'the finished scene is not rebuilt');
  const doc = io.loadCourse(path.join(s.root, 'lab-ppe.course.json'));
  assert.deepEqual(doc.scenes.map((x) => x.title), ['Before you start', 'Check your understanding']);
  assert.equal(doc.slides.length, 4, 'three items; the question item adds its question slide');
  assert.deepEqual(fs.readdirSync(s.root).filter((f) => f.startsWith('.ai-draft')), []);
  assert.equal(s.flow.inProgress('lab-ppe'), false);
  assert.ok(events.some((e) => e.type === 'part'));
  await assert.rejects(s.flow.build(args), (e) => e.errors[0].code === 'dupe');
  await assert.rejects(s.flow.build({ ...args, name: 'Bad Name' }), (e) => e.errors[0].code === 'pattern');
});

test('review: findings come back with a fix for the assistant, using the fast model', async () => {
  const s = setup(() => ({ structured: { findings: [{ title: 'Ambiguous question', detail: 'Slide s-q1 has two defensible answers.', fix: 'On slide s-q1, make Gloves clearly wrong.', severity: 'high' }] } }));
  const file = path.join(s.root, 'lab.course.json');
  fs.copyFileSync(new URL('../../samples/lab-safety.course.json', import.meta.url), file);
  const r = await s.flow.review({ file });
  assert.equal(r.findings[0].severity, 'high');
  assert.match(s.prompts[0], /Course outline:\ncourse lab-safety/);
});

test('attachments: only Word, PDF, Markdown or text files inside the courses folder (no other drives, no escapes)', async () => {
  const s = setup(() => ({ structured: { title: 'T', outline: OUTLINE } }));
  fs.writeFileSync(path.join(s.root, 'notes.exe'), 'x');
  const outside = path.join(tmp(), 'secret.md');
  fs.writeFileSync(outside, 'secret');
  for (const bad of ['notes.exe', outside, String.raw`D:\secret.md`, String.raw`\\server\share\notes.md`, '../x.md']) {
    await assert.rejects(s.flow.outline({ brief: { topic: 'Lab safety' }, attachments: [bad] }), (e) => e.errors[0].code === 'path', bad);
  }
});

test('build: an edited outline starts over; one build per name at a time; never over a course created meanwhile or a .story', async () => {
  let release, gate = new Promise((r) => { release = r; });
  const s = setup((prompt) => (prompt.includes('"Check"') ? gate.then(() => ({ summary: 'ok' })) : { summary: 'ok' }));
  const args = { name: 'ppe', title: 'PPE', mode: 'slides', outline: OUTLINE };
  const first = s.flow.build(args);
  await assert.rejects(s.flow.build(args), (e) => e.errors[0].code === 'busy');
  fs.copyFileSync(new URL('../../samples/lab-safety.course.json', import.meta.url), path.join(s.root, 'ppe.course.json')); // created while building
  release();
  await assert.rejects(first, (e) => e.errors[0].code === 'dupe');
  assert.equal(io.loadCourse(path.join(s.root, 'ppe.course.json')).title, 'Lab Safety Essentials', 'the other course is untouched');
  fs.rmSync(path.join(s.root, 'ppe.course.json'));
  const edited = await s.flow.build({ ...args, outline: OUTLINE.replace('# Check', '# Check\n## Extra item\nMore.') });
  assert.equal(io.loadCourse(path.join(s.root, 'ppe.course.json')).slides.length, 5, 'the edited outline was built, not the old draft');
  assert.equal(edited.parts, 2);
  fs.writeFileSync(path.join(s.root, 'other.story'), 'x');
  await assert.rejects(s.flow.build({ ...args, name: 'other' }), (e) => e.errors[0].code === 'dupe');
});
