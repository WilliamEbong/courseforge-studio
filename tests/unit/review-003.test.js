// Regression tests for Codex review 003: one test per finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pkg, storyXml } from '../fixtures/synthetic/story-builder.js';
import { importStory, importStoryFile, parseXml } from '../../packages/import-story/index.js';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { play, seededRng } from '../../packages/runtime/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-r003-'));
const ok = (cmds, doc = emptyCourse()) => { const r = applyAll(doc, cmds); assert.ok(r.ok, JSON.stringify(r.errors)); return r.doc; };

test('#1 a second import whose name maps to the same assets/report is refused, the first course is untouched', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.story'), pkg());
  importStoryFile(path.join(dir, 'a.story'), path.join(dir, 'new.json'));
  const report = fs.readFileSync(path.join(dir, 'new.import-report.json'), 'utf8');
  assert.throws(() => importStoryFile(path.join(dir, 'a.story'), path.join(dir, 'new.course.json')), (e) => e.errors?.[0].code === 'dupe');
  assert.equal(fs.readFileSync(path.join(dir, 'new.import-report.json'), 'utf8'), report);
});

test('#2 an assets folder that is a junction/symlink to outside the course folder is refused; nothing is written outside', () => {
  const dir = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(dir, 'a.story'), pkg());
  fs.symlinkSync(outside, path.join(dir, 'assets'), 'junction');
  assert.throws(() => importStoryFile(path.join(dir, 'a.story'), path.join(dir, 'x.course.json')), (e) => /outside the course folder/.test(e.message));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('#3 deeply nested XML is refused quickly instead of blocking the process', () => {
  const deep = '<a>'.repeat(5000) + '</a>'.repeat(5000);
  const t0 = performance.now();
  assert.throws(() => parseXml(deep), /nested deeper than 256/);
  assert.ok(performance.now() - t0 < 500);
  const okDepth = '<a>'.repeat(200) + '</a>'.repeat(200);
  assert.doesNotThrow(() => parseXml(okDepth));
});

test('#4 the score cache is shared by all quizzes (one LMS score field)', () => {
  const q = (id) => ({ cmd: 'slide.add', args: { id, question: { type: 'mc', prompt: id, shuffle: false, choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', correct: true }] } } });
  const d = ok([q('s1'), q('s2'), q('s3'), { cmd: 'quiz.add', args: { id: 'q1', questions: ['s1', 's3'] } }, { cmd: 'quiz.add', args: { id: 'q2', questions: ['s2'] } }]);
  d.tracking.complete = [{ quiz: 'q1' }]; // exercise the cache before completion freezes LMS reporting
  const calls = [];
  const lms = { init: () => null, status: () => {}, score: (x) => calls.push(x.raw), interaction: () => {}, save: () => {}, exit: () => {} };
  play(d, [{ type: 'choose', choice: 'b' }, { type: 'submit' }, { type: 'continue' }, { type: 'choose', choice: 'b' }, { type: 'submit' }, { type: 'continue' }, { type: 'choose', choice: 'a' }, { type: 'submit' }], { lms });
  assert.deepEqual(calls, [50, 100, 50]);
});

test('#5 roundUpScorePercent="true" imports as quiz.round', () => {
  const story = storyXml().replace('<quiz g=', '<quiz roundUpScorePercent="true" g=');
  const { doc } = importStory(pkg({ story }));
  assert.equal(doc.quizzes[0].round, true);
});

test('#6 the failure replay reuses the fast pass random draws: the right command is blamed', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'slide.add', args: { title: 'gen' } },
    { cmd: 'slide.add', args: { id: 's-b', title: 'b' } },
    { cmd: 'trigger.add', args: { slide: 's-b', on: { event: 'timelineStart' }, do: [{ action: 'jump', to: 's-missing' }] } },
  ], { rng: seededRng(7) });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].index, 2, JSON.stringify(r.errors));
});

test('#7 course.replace with an invalid document is a structured error (index 0), never a crash', () => {
  const r = applyAll(emptyCourse(), [{ cmd: 'course.replace', args: { doc: { ...emptyCourse(), slides: [null] } } }, { cmd: 'object.set', args: { id: 'o-x', x: 1 } }]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].index, 0);
  assert.match(r.errors[0].message, /replacement document is invalid/);
});

test('#8 pasting a Submit button onto a non-question slide copies the button and skips its submit trigger', () => {
  const d = ok([
    { cmd: 'slide.add', args: { id: 's-q', question: { type: 'mc', prompt: 'p', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', correct: true }] }, objects: [{ id: 'o-sub', type: 'button', text: 'Submit' }] } },
    { cmd: 'trigger.add', args: { slide: 's-q', id: 't-sub', on: { event: 'click', target: 'o-sub' }, do: [{ action: 'submit' }] } },
    { cmd: 'slide.add', args: { id: 's-plain' } },
  ]);
  const r = applyAll(d, [{ cmd: 'object.duplicate', args: { ids: ['o-sub'], slide: 's-plain' } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.results[0].skipped, ['t-sub']);
  assert.equal(r.doc.slides.find((s) => s.id === 's-plain').objects.length, 1);
});

test('#9 distribute keeps the first and last objects (by position) in place even when widths overlap', () => {
  const d = ok([{ cmd: 'slide.add', args: { id: 's', objects: [{ id: 'o-a', type: 'shape', x: 0, w: 200 }, { id: 'o-b', type: 'shape', x: 100, w: 1000 }, { id: 'o-c', type: 'shape', x: 200, w: 50 }] } }]);
  const r = applyAll(d, [{ cmd: 'object.distribute', args: { ids: ['o-a', 'o-b', 'o-c'], axis: 'horizontal' } }]);
  const x = Object.fromEntries(r.doc.slides[0].objects.map((o) => [o.id, o.x]));
  assert.equal(x['o-a'], 0);
  assert.equal(x['o-c'], 200);
});
