// Audit 2026-10 runtime regressions: view() cost on big slides, interaction latency past the slide duration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { createRuntime, seededRng } from '../../packages/runtime/index.js';

test('view() on an 800-object slide stays fast (object lookups are not quadratic)', () => {
  const objects = Array.from({ length: 800 }, (_, i) => ({ id: `o-${i}`, type: 'shape', x: i % 900, y: 40, w: 20, h: 20 }));
  const r = applyAll(emptyCourse(), [{ cmd: 'slide.add', args: { id: 's-big', objects } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const rt = createRuntime(r.doc, { rng: seededRng(3) }).start();
  for (let i = 0; i < 20; i++) rt.view(); // warm up the JIT
  let ms = Infinity; // best of 10: immune to GC pauses and a busy machine (it was ~100+ ms when quadratic)
  for (let i = 0; i < 10; i++) { const t0 = performance.now(); rt.view(); ms = Math.min(ms, performance.now() - t0); }
  assert.equal(rt.view().objects.length, 800);
  assert.ok(ms < 15, `view() took ${ms.toFixed(1)} ms`);
});

test('interaction latency counts the whole time on the slide, not the timeline clock that stops at its end', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'slide.add', args: { id: 's-q', question: { type: 'tf', prompt: 'Sky is blue?', choices: [{ id: 't', label: 'True', correct: true }, { id: 'f', label: 'False' }] } } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q'] } },
  ]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const ints = [];
  const rt = createRuntime(r.doc, { rng: seededRng(3), lms: { init: () => null, status: () => {}, score: () => {}, interaction: (x) => ints.push(x), save: () => {}, exit: () => {} } });
  rt.start(); rt.tick(90000); rt.dispatch({ type: 'choose', choice: 't' }).dispatch({ type: 'submit' });
  assert.equal(ints.length, 1);
  assert.equal(ints[0].latencyMs, 90000);
});
