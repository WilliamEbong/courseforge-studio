// Every AI-built question teaches through its feedback: the build checks for missing or generic feedback and runs one
// targeted pass; the full outline (change card, review) shows feedback so it is never reported missing by mistake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlow, questionsWithoutFeedback } from '../../packages/ai/create.js';
import { createSettings } from '../../packages/ai/settings.js';
import { fakeProvider } from '../../packages/ai/assistant.js';
import { applyAll, describe } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import * as io from '../../packages/cli/io.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-fb-'));
const OUTLINE = '# Learn\n## Why goggles\nEyes are exposed.\n# Check\n## Quick check\n? What protects your eyes?\n[x] Goggles\n[ ] Gloves\n## Second check\n? Which gloves for acids?\n[x] Nitrile\n[ ] Cotton';
const GOOD = { correct: 'Right: goggles seal around the eyes, so splashes cannot reach them.', incorrect: 'Gloves protect hands, not eyes. Goggles are the only item here that shields your eyes.' };
const LESSONS = fileURLToPath(new URL('../../samples/lab-basics-lessons.course.json', import.meta.url));

test('questionsWithoutFeedback: default or missing feedback is flagged; explanatory or per-choice feedback is not', () => {
  const d = applyAll(emptyCourse({ title: 'T' }), [{ cmd: 'outline.add', args: { text: OUTLINE } }]).doc;
  const qs = d.slides.filter((s) => s.question).map((s) => s.id);
  assert.deepEqual(questionsWithoutFeedback(d).map((m) => m.id), qs, 'new questions carry the default "Correct!" / "Not quite."');
  const fixed = applyAll(d, [
    { cmd: 'question.set', args: { slide: qs[0], feedback: GOOD } },
    { cmd: 'question.set', args: { slide: qs[1], feedback: { correct: 'Yes: nitrile resists most acids.', incorrect: 'Not quite.' } } },
  ]).doc;
  assert.deepEqual(questionsWithoutFeedback(fixed).map((m) => m.id), [qs[1]], 'a generic "Not quite." still needs writing');
  assert.deepEqual(questionsWithoutFeedback(applyAll(fixed, [{ cmd: 'question.set', args: { slide: qs[1], feedback: { incorrect: 'Cotton soaks acids up against your skin.' } } }]).doc), []);
  const blocks = applyAll(emptyCourse({ title: 'L', mode: 'lessons' }), [{ cmd: 'outline.add', args: { text: OUTLINE } }]).doc;
  const block = questionsWithoutFeedback(blocks)[0].id;
  const perChoice = applyAll(blocks, [{ cmd: 'block.set', args: { id: block, choices: blocks.sections.flatMap((s) => s.lessons.flatMap((l) => l.blocks)).find((b) => b.id === block).choices.map((c) => ({ ...c, feedback: `Because of ${c.label}.` })) } }]).doc;
  assert.ok(!questionsWithoutFeedback(perChoice).some((m) => m.id === block), 'per-choice feedback on a lesson question counts');
  const lessons = applyAll(emptyCourse({ title: 'L', mode: 'lessons' }), [{ cmd: 'outline.add', args: { text: OUTLINE } }]).doc;
  const missing = questionsWithoutFeedback(lessons);
  assert.equal(missing.length, 2);
  assert.ok(missing.every((m) => m.kind === 'block'));
});

test('full outline shows question feedback (slides and lesson blocks); the agent outline stays compact', () => {
  const d = applyAll(emptyCourse({ title: 'T' }), [{ cmd: 'outline.add', args: { text: OUTLINE } }]).doc;
  const q = d.slides.find((s) => s.question).id;
  const withFb = applyAll(d, [{ cmd: 'question.set', args: { slide: q, feedback: GOOD } }]).doc;
  assert.match(describe(withFb, { full: true }), /feedback correct: "Right: goggles seal/);
  assert.doesNotMatch(describe(withFb), /feedback/);
  assert.match(describe(io.loadCourse(LESSONS), { full: true }), /question "You are about to heat a solution[^\n]*feedback choice a: "Right\./);
});

test('build: questions left without feedback get one targeted pass, and the result reports none missing', async () => {
  const root = tmp(), dataDir = tmp(), prompts = [];
  const settings = createSettings(dataDir);
  settings.set({ enabled: true });
  const provider = fakeProvider((prompt) => {
    prompts.push(prompt);
    const ids = /Write feedback for these questions: (.*)\./.exec(prompt)?.[1].split(', ').map((x) => x.split(' ')[1]);
    return ids ? { batches: [ids.map((slide) => ({ cmd: 'question.set', args: { slide, feedback: GOOD } }))], summary: 'Wrote feedback.' } : { summary: 'Built.' };
  });
  const flow = createFlow({ root, dataDir, settings, provider });
  const r = await flow.build({ name: 'fb', title: 'Feedback', outline: OUTLINE });
  assert.equal(prompts.filter((p) => p.startsWith('Write feedback')).length, 1);
  assert.match(prompts.at(-1), /slide s-\w+, slide s-\w+/);
  assert.equal(r.missingFeedback, 0);
  assert.deepEqual(questionsWithoutFeedback(io.loadCourse(path.join(root, 'fb.course.json'))), []);

  prompts.length = 0; // a course without questions needs no feedback pass
  const r2 = await flow.build({ name: 'nofb', title: 'No questions', outline: '# Learn\n## Why goggles\nEyes are exposed.' });
  assert.equal(r2.missingFeedback, 0);
  assert.equal(prompts.filter((p) => p.startsWith('Write feedback')).length, 0);
});
