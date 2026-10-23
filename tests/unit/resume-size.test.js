import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse } from '../../packages/schema/index.js';
import { applyAll } from '../../packages/core/index.js';
import { createRuntime, seededRng } from '../../packages/runtime/index.js';
import { createScorm12Api } from '../../packages/lms-test-harness/scorm12.js';
import '../../packages/publisher/cf-scorm.js';

function answeredCourse(bank = false) {
  const cmds = Array.from({ length: 24 }, (_, i) => ({ cmd: 'slide.add', args: {
    id: `s-${String(i).padStart(12, '0')}`, ...(bank ? { bank: 'bk-check' } : {}), question: { type: 'mc', prompt: 'Choose', shuffle: true,
      choices: Array.from({ length: 4 }, (_, j) => ({ id: `c-${String(i * 4 + j).padStart(12, '0')}`, label: String(j), correct: j === 0 })) },
  } }));
  const questions = cmds.map(c => c.args.id);
  if (bank) {
    cmds.unshift({ cmd: 'bank.add', args: { id: 'bk-check' } });
    cmds.push({ cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-check', count: 0 } });
  }
  cmds.push({ cmd: 'quiz.add', args: { id: 'q-check', questions: bank ? ['s-draw'] : questions } },
    { cmd: 'quiz.addResults', args: { quiz: 'q-check', id: 's-results', track: true } });
  const built = applyAll(emptyCourse(), cmds);
  assert.equal(built.ok, true, JSON.stringify(built.errors));
  const rt = createRuntime(built.doc, { rng: seededRng(3) }).start();
  for (const s of built.doc.slides.filter(s => s.question)) {
    rt.dispatch({ type: 'menu', slide: s.id });
    rt.dispatch({ type: 'choose', choice: s.question.choices[0].id });
    rt.dispatch({ type: 'submit' });
    rt.dispatch({ type: 'continue' });
  }
  rt.dispatch({ type: 'menu', slide: 's-results' });
  return { doc: built.doc, rt };
}

for (const bank of [false, true]) test(`long native-style quiz IDs fit SCORM resume and retain exact answers, order and scores (bank=${bank})`, () => {
  const { doc, rt } = answeredCourse(bank), snap = rt.snapshot();
  const text = JSON.stringify(snap);
  assert.ok(text.length <= 4096, `snapshot ${text.length} exceeds SCORM 1.2`);
  let stored;
  const api = createScorm12Api({ load: () => stored, save: value => { stored = structuredClone(value); } });
  const win = { API: api }; win.parent = win;
  const adapter = globalThis.CFScorm.createScormAdapter({ win, courseId: doc.id });
  adapter.init(); assert.equal(adapter.save(snap), true); adapter.exit();
  const resumed = createRuntime(doc).restore(JSON.parse(stored.suspend));
  assert.ok(snap.history.every(Number.isInteger), 'compact history indexes include bank slides');
  for (const key of ['q', 'quiz', 'slide', 'status', 'viewed', 'history', 'draws']) assert.deepEqual(resumed.state[key], rt.state[key], key);
  assert.deepEqual(adapter.warnings, []);
  if (bank) {
    rt.dispatch({ type: 'review', quiz: 'q-check' });
    const review = createRuntime(doc).restore(JSON.parse(JSON.stringify(rt.snapshot())));
    assert.deepEqual(review.state.review, rt.state.review);
    assert.equal(review.state.slide, rt.state.slide);
  }
});

test('compact question resume rejects malformed indexes and changed choice sets', () => {
  const { doc, rt } = answeredCourse(), snap = rt.snapshot(), sid = doc.slides[0].id;
  assert.equal(snap.v, 2);
  const question = snap.q[0];
  question[1] = [999, -1, '0', {}, 0];
  const resumed = createRuntime(doc).restore(JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(resumed.state.q[sid].selected, [question[0][0]]);
  question[0][0] = 'missing-choice';
  const changed = createRuntime(doc).restore(JSON.parse(JSON.stringify(snap)));
  assert.equal(changed.state.q[sid], undefined);
});
