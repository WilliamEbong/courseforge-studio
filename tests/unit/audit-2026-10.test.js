import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse, validate } from '../../packages/schema/index.js';
import { applyAll } from '../../packages/core/index.js';
import { seededRng } from '../../packages/runtime/index.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as claude from '../../packages/ai/claude.js';

const ctx = () => ({ rng: seededRng(7) });
const dragGroupCourse = () => {
  const r = applyAll(emptyCourse({ title: 'T' }), [
    { cmd: 'slide.add', args: { id: 's-a', objects: [
      { id: 'o-pic', type: 'text', text: 'Card' },
      { id: 'o-grp', type: 'hotspot', members: ['o-pic'] },
    ] } },
  ], ctx());
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.doc;
};

test('slide.duplicate remaps drag-group members to the copied objects', () => {
  const r = applyAll(dragGroupCourse(), [{ cmd: 'slide.duplicate', args: { id: 's-a', newId: 's-b' } }], ctx());
  assert.ok(r.ok, JSON.stringify(r.errors));
  const copy = r.doc.slides.find((s) => s.id === 's-b');
  const grp = copy.objects.find((o) => o.members);
  assert.deepEqual(grp.members, [copy.objects.find((o) => o.type === 'text').id]);
});

test('object.duplicate of a whole drag group remaps members to the copies', () => {
  const r = applyAll(dragGroupCourse(), [{ cmd: 'object.duplicate', args: { ids: ['o-pic', 'o-grp'], dx: 10 } }], ctx());
  assert.ok(r.ok, JSON.stringify(r.errors));
  const [pic, grp] = r.results[0].ids;
  assert.deepEqual(r.doc.slides[0].objects.find((o) => o.id === grp).members, [pic]);
  assert.deepEqual(validate(r.doc), []);
});

test('Claude output keeps a multi-byte character that straddles two stdout chunks', async () => {
  process.env.CF_CLAUDE_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/ai/fake-claude.mjs');
  process.env.FAKE_CLAUDE_MODE = 'split';
  try {
    const r = await claude.run({ system: 's', prompt: 'p', model: claude.MODELS.fast, cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-split-')) });
    assert.equal(r.text, 'Safety — basics');
  } finally { delete process.env.CF_CLAUDE_BIN; delete process.env.FAKE_CLAUDE_MODE; }
});

import { resolveInside } from '../../packages/lms-test-harness/serve.js';
import { validatePackage } from '../../packages/publisher/index.js';


test('a malformed %-escape is a 404 in the LMS harness and a problem entry in validatePackage', () => {
  assert.equal(resolveInside(os.tmpdir(), '/%E0'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-pkg-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(dir, 'imsmanifest.xml'), '<manifest><resources><resource href="index.html"><file href="a%ZZ.js"/></resource></resources></manifest>');
  assert.ok(validatePackage(dir).some((p) => /malformed %-escape/.test(p.message)));
});

import { createRuntime } from '../../packages/runtime/index.js';

test('lessons: an untracked quiz taken after the tracked one passes does not overwrite the LMS score', () => {
  const mcq = (id) => ({ id, type: 'question', kind: 'mc', prompt: 'Pick A', choices: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B' }] });
  const r = applyAll(emptyCourse({ id: 'les', title: 'L', mode: 'lessons' }), [
    { cmd: 'section.add', args: { id: 'sec-1', title: 'One' } },
    { cmd: 'lesson.add', args: { id: 'l-q', title: 'Tracked', kind: 'quiz', passPercent: 50, blocks: [mcq('q-1')] } },
    { cmd: 'lesson.add', args: { id: 'l-p', title: 'Practice', kind: 'quiz', passPercent: 50, blocks: [mcq('q-2')] } },
    { cmd: 'tracking.set', args: { complete: [{ quiz: 'l-q' }], status: 'passed-failed' } },
  ], ctx());
  assert.ok(r.ok, JSON.stringify(r.errors));
  const calls = [];
  const lms = { init: () => null, status: (s) => calls.push(`status ${s}`), score: (x) => calls.push(`score ${x.raw}`), interaction: () => {}, save: () => {}, exit: () => {} };
  const rt = createRuntime(r.doc, { rng: seededRng(3), lms });
  rt.start();
  for (const [lesson, choice] of [['l-q', 'a'], ['l-p', 'b']]) for (const e of [{ type: 'open', lesson }, { type: 'continue' }, { type: 'choose', choice }, { type: 'submit' }, { type: 'continue' }]) rt.dispatch(e);
  assert.deepEqual(calls, ['score 100', 'status passed']);
});

test('lessons: typing a fill-in answer does not save (and commit) on every keystroke', () => {
  const r = applyAll(emptyCourse({ id: 'les', title: 'L', mode: 'lessons' }), [
    { cmd: 'section.add', args: { id: 'sec-1', title: 'One' } },
    { cmd: 'lesson.add', args: { id: 'l-a', title: 'A', blocks: [{ id: 'b-f', type: 'question', kind: 'fill', prompt: 'Say hi', answers: ['hi'] }] } },
  ], ctx());
  assert.ok(r.ok, JSON.stringify(r.errors));
  let saves = 0;
  const rt = createRuntime(r.doc, { rng: seededRng(3), lms: { init: () => null, save: () => { saves++; } } });
  rt.start();
  rt.dispatch({ type: 'open', lesson: 'l-a' });
  const before = saves;
  for (const text of ['h', 'hi', 'hi!']) rt.dispatch({ type: 'input', text });
  assert.equal(saves, before);
  rt.dispatch({ type: 'submit' });
  assert.equal(saves, before + 1);
});

test('resume: a 60-question shuffled quiz fits SCORM suspend_data, and old id-list snapshots still restore', () => {
  const cmds = Array.from({ length: 60 }, (_, i) => ({ cmd: 'slide.add', args: { id: `s-q${i}`, question: { type: 'mc', prompt: 'Choose', shuffle: true,
    choices: Array.from({ length: 4 }, (_, j) => ({ id: `c-${i}-${j}-xxxxxxxx`, label: String(j), correct: j === 0 })) } } }));
  cmds.push({ cmd: 'quiz.add', args: { id: 'q-big', questions: cmds.map((c) => c.args.id) } }, { cmd: 'quiz.addResults', args: { quiz: 'q-big', id: 's-results', track: true } });
  const built = applyAll(emptyCourse(), cmds);
  assert.ok(built.ok, JSON.stringify(built.errors));
  const rt = createRuntime(built.doc, { rng: seededRng(3) }).start();
  for (const s of built.doc.slides.filter((x) => x.question)) for (const e of [{ type: 'menu', slide: s.id }, { type: 'choose', choice: s.question.choices[1].id }, { type: 'submit' }, { type: 'continue' }]) rt.dispatch(e);
  assert.equal(Object.keys(rt.state.q).length, 60);
  const snap = rt.snapshot();
  assert.ok(JSON.stringify(snap).length <= 4096, `snapshot ${JSON.stringify(snap).length} chars`);
  assert.deepEqual(createRuntime(built.doc).restore(JSON.parse(JSON.stringify(snap))).state.q, rt.state.q);
  const old = JSON.parse(JSON.stringify(snap)); // a v2 snapshot written before this change listed choice ids
  for (const [k, v] of Object.entries(old.q)) v[0] = [...rt.state.q[built.doc.slides[Number(k)].id].order];
  assert.deepEqual(createRuntime(built.doc).restore(old).state.q, rt.state.q);
  const changed = structuredClone(built.doc); // republished with one choice replaced: that answer must not land on it
  changed.slides[0].question.choices[1].id = 'c-0-1-replaced';
  const resumed = createRuntime(changed).restore(JSON.parse(JSON.stringify(snap))).state.q;
  assert.equal(resumed['s-q0'], undefined);
  assert.deepEqual(resumed['s-q1'], rt.state.q['s-q1']);
});
