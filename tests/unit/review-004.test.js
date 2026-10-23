// Synthetic regressions for review 004. No vendor content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse } from '../../packages/schema/index.js';
import { applyAll } from '../../packages/core/index.js';
import { createRuntime } from '../../packages/runtime/index.js';

function course(type = 'mc') {
  const question = type === 'fill' ? { type, prompt: 'Name the colour', answers: ['blue'] }
    : { type, prompt: 'Choose blue', shuffle: false, choices: [{ id: 'a', label: 'Red' }, { id: 'b', label: 'Blue', correct: true }] };
  const r = applyAll(emptyCourse(), [{ cmd: 'slide.add', args: { id: 's-one', question, objects: [{ id: 'o-one', type: 'button', text: 'Inspect %final.scorePercent%' }] } }, { cmd: 'quiz.add', args: { id: 'final', questions: ['s-one'] } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.doc;
}

test('review004 #1: JSON object values in saved object states and answer text cannot crash resume', () => {
  const doc = course('fill');
  const first = createRuntime(doc); first.start();
  const snap = first.snapshot();
  snap.current.o = { 'o-one': { state: { toString: null } }, 'o-missing': 'selected' };
  snap.q['s-one'].text = { toString: null };
  const rt = createRuntime(doc);
  assert.doesNotThrow(() => { rt.restore(JSON.parse(JSON.stringify(snap))); rt.view(); });
  assert.equal(rt.view().objects[0].state, 'normal');
  assert.equal(rt.view().question.text, '');
  rt.dispatch({ type: 'input', text: 'blue' }); rt.dispatch({ type: 'submit' });
  assert.equal(rt.view().question.result, 'correct');
});

test('review004 #1: malformed attempts and derived score variables are discarded without coercion', () => {
  for (const field of ['attempts', 'quiz', 'vars']) {
    const doc = course();
    const first = createRuntime(doc); first.start();
    const snap = first.snapshot(), poison = { toString: null, valueOf: null };
    if (field === 'attempts') snap.q['s-one'].attempts = poison;
    if (field === 'quiz') snap.quiz.final = { attempt: poison };
    if (field === 'vars') snap.vars['final.scorePercent'] = poison;
    const rt = createRuntime(doc);
    assert.doesNotThrow(() => {
      rt.restore(JSON.parse(JSON.stringify(snap))); rt.view();
      rt.dispatch({ type: 'choose', choice: 'b' }); rt.dispatch({ type: 'submit' });
    }, field);
    assert.equal(rt.view().question.result, 'correct');
  }
});

test('review004 #2: duplicate choice ids in resume order cannot remove an answer', () => {
  const doc = course();
  const first = createRuntime(doc); first.start();
  const snap = first.snapshot(); snap.q['s-one'].order = ['a', 'a'];
  const rt = createRuntime(doc); rt.restore(snap);
  assert.deepEqual(rt.view().question.choices.map((c) => c.id), ['a', 'b']);
  rt.dispatch({ type: 'choose', choice: 'b' }); rt.dispatch({ type: 'submit' });
  assert.equal(rt.view().question.result, 'correct');
});
