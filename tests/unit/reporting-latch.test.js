// terminal LMS reporting is independent of the learner's live quiz grade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse } from '../../packages/schema/index.js';
import { applyAll } from '../../packages/core/index.js';
import { createRuntime } from '../../packages/runtime/index.js';
import { toScormInteraction } from '../../packages/publisher/index.js';
import { createScorm12Api } from '../../packages/lms-test-harness/scorm12.js';
import '../../packages/publisher/cf-scorm.js';

function course({ count = 2, threshold, mode = 'passed-failed', second = false } = {}) {
  const commands = Array.from({ length: count }, (_, i) => ({ cmd: 'slide.add', args: {
    id: `s-${i}`, question: { type: 'mc', prompt: 'Choose', shuffle: false,
      choices: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B' }] },
  } }));
  commands.push({ cmd: 'quiz.add', args: { id: 'q-one', questions: commands.map(c => c.args.id) } });
  if (second) commands.push({ cmd: 'quiz.add', args: { id: 'q-two', questions: ['s-0'] } });
  commands.push({ cmd: 'quiz.addResults', args: { quiz: 'q-one', id: 's-results', track: true } });
  for (const id of [...Array.from({ length: count }, (_, i) => `s-${i}`), 's-results']) {
    for (const [key, quiz] of [['1', 'q-one'], ...(second ? [['2', 'q-two']] : [])]) commands.push({ cmd: 'trigger.add', args: {
      slide: id, on: { event: 'key', key }, do: [{ action: 'resetQuiz', quiz }],
    } });
  }
  const built = applyAll(emptyCourse(), commands);
  assert.ok(built.ok, JSON.stringify(built.errors));
  built.doc.tracking = { status: mode, complete: [...(threshold === undefined ? [] : [{ slidesViewedCount: threshold }]), { quiz: 'q-one' }] };
  return built.doc;
}
function launch(doc, store = { record: null }) {
  const calls = [];
  const api = createScorm12Api({ load: () => store.record, save: r => { store.record = structuredClone(r); } }, e => calls.push(e));
  const win = { API: api }; win.parent = win;
  const ad = globalThis.CFScorm.createScormAdapter({ win, courseId: doc.id, tracking: doc.tracking });
  const rt = createRuntime(doc, { lms: { ...ad, interaction: r => ad.interaction(toScormInteraction(r)) } });
  return { rt, ad, api, calls, store };
}
function answer(rt, choice = 'a') {
  rt.dispatch({ type: 'choose', choice }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });
}
const scores = x => x.calls.filter(e => e.fn === 'LMSSetValue' && e.args[0] === 'cmi.core.score.raw').map(e => e.args[1]);

test('view-first completion keeps LMS score absent while every answer and 100% result still report; resume keeps it absent', () => {
  const doc = course({ threshold: 1 }), first = launch(doc);
  first.rt.start(); answer(first.rt); answer(first.rt);
  assert.equal(first.rt.state.quiz['q-one'].percent, 100);
  assert.equal(first.api._record().status, 'passed');
  assert.equal(first.api._record().interactions.length, 2);
  assert.deepEqual(scores(first), []);
  first.ad.exit();
  const back = launch(doc, first.store); back.rt.start({ resume: true });
  assert.equal(back.rt.state.slide, 's-results');
  assert.equal(back.rt.state.quiz['q-one'].percent, 100);
  assert.deepEqual(scores(back), []);
  back.rt.dispatch({ type: 'key', key: '1' }); answer(back.rt);
  assert.deepEqual(scores(back), [], 'retry without a score owner does not unlock view completion');
});

test('mid-quiz view completion freezes the last reported score, not the visible final grade', () => {
  const x = launch(course({ count: 4, threshold: 3 })); x.rt.start();
  for (let i = 0; i < 4; i++) answer(x.rt);
  assert.deepEqual(scores(x), ['25', '50']);
  assert.equal(x.api._record().raw, '50');
  assert.equal(x.rt.state.quiz['q-one'].percent, 100);
  assert.equal(x.api._record().interactions.length, 4);
});

for (const [mode, choice, status] of [['passed-failed', 'a', 'passed'], ['passed-failed', 'b', 'failed'], ['completed-incomplete', 'a', 'completed']]) {
  test(`quiz-first ${status} reports score before status and owner retry unlocks`, () => {
    const x = launch(course({ count: 1, mode })); x.rt.start(); answer(x.rt, choice);
    assert.equal(x.api._record().status, status);
    const writes = x.calls.filter(e => e.fn === 'LMSSetValue');
    assert.ok(writes.findIndex(e => e.args[0] === 'cmi.core.score.raw') < writes.findIndex(e => e.args[0] === 'cmi.core.lesson_status' && e.args[1] === status));
    x.rt.dispatch({ type: 'key', key: '1' }); answer(x.rt, choice === 'a' ? 'b' : 'a');
    assert.deepEqual(scores(x), choice === 'a' ? ['100', '0'] : ['0', '100']);
  });
}

test('equal score from a second quiz does not transfer ownership; incomplete alone does not unlock', () => {
  const x = launch(course({ count: 1, second: true })); x.rt.start(); answer(x.rt);
  x.rt.dispatch({ type: 'key', key: '2' }); answer(x.rt, 'b');
  assert.deepEqual(scores(x), ['100']);
  assert.equal(x.api._record().interactions.length, 4, 'both quizzes keep their question reports');
  x.rt.dispatch({ type: 'key', key: '1' }); answer(x.rt, 'b');
  assert.deepEqual(scores(x), ['100', '0']);
});

test('failure mapped to incomplete keeps score reporting open', () => {
  const x = launch(course({ count: 1, mode: 'passed-incomplete', second: true })); x.rt.start(); answer(x.rt, 'b');
  assert.equal(x.api._record().status, 'incomplete');
  x.rt.dispatch({ type: 'key', key: '2' }); answer(x.rt);
  assert.deepEqual(scores(x), ['0', '100']);
});

test('resume retains frozen nonempty score and owner retry; rejecting resume starts fresh', () => {
  const doc = course({ count: 4, threshold: 3 }), first = launch(doc); first.rt.start();
  for (let i = 0; i < 4; i++) answer(first.rt);
  first.ad.exit();
  const back = launch(doc, first.store); back.rt.start({ resume: true });
  assert.deepEqual(scores(back), []);
  assert.equal(back.api._record().raw, '50');
  back.rt.dispatch({ type: 'key', key: '1' }); answer(back.rt);
  // View completion is still satisfied, so entry relatches before the next answer.
  assert.deepEqual(scores(back), []);
  back.ad.exit();
  const fresh = launch(doc, first.store); fresh.rt.start({ resume: false }); answer(fresh.rt);
  assert.deepEqual(scores(fresh), ['25']);
});

test('resumed failed quiz can retry its score owner; malformed reporting metadata is ignored', () => {
  const doc = course({ count: 1 }), first = launch(doc); first.rt.start(); answer(first.rt, 'b'); first.ad.exit();
  const back = launch(doc, first.store); back.rt.start({ resume: true });
  assert.deepEqual(scores(back), []);
  back.rt.dispatch({ type: 'key', key: '1' }); answer(back.rt);
  assert.deepEqual(scores(back), ['100']);
  const snap = back.rt.snapshot();
  for (const rp of [null, [false, -1, 'q-one', false], [false, 50, 'unknown', false], [false, '100', 'q-one', false]]) {
    const restored = createRuntime(doc).restore({ ...snap, rp });
    assert.equal(restored.state.scoreClosed, true);
    assert.equal(restored.state.scoreOwner, 'q-one');
  }
});

test('legacy and malformed reporting snapshots reconstruct failed quiz ownership so retry can pass', () => {
  const doc = course({ count: 1 });
  for (const rp of [undefined, [true, 0, 'missing', false]]) {
    const first = launch(doc); first.rt.start(); answer(first.rt, 'b'); first.ad.exit();
    const snap = JSON.parse(first.store.record.suspend);
    if (rp === undefined) delete snap.rp; else snap.rp = rp;
    first.store.record.suspend = JSON.stringify(snap);
    const back = launch(doc, first.store); back.rt.start({ resume: true });
    back.rt.dispatch({ type: 'key', key: '1' }); answer(back.rt);
    assert.deepEqual(scores(back), ['0', '100']);
    assert.equal(back.api._record().status, 'passed');
  }
});

test('saved criterion order selects logical status while the first terminal LMS report stays frozen', () => {
  const built = applyAll(course({ count: 1 }), [{ cmd: 'slide.add', args: { id: 's-end' } }]);
  assert.ok(built.ok);
  const doc = built.doc;
  doc.tracking.complete = [{ slidesViewedCount: 3 }, { quiz: 'q-one' }];
  const x = launch(doc); x.rt.start(); answer(x.rt, 'b');
  assert.equal(x.rt.state.status, 'failed');
  x.rt.dispatch({ type: 'menu', slide: 's-end' });
  assert.equal(x.rt.state.status, 'completed');
  assert.equal(x.api._record().status, 'failed', 'later view completion does not overwrite the terminal LMS report');
});

test('manual completion keeps precedence through resume and subsequent quiz scoring', () => {
  const built = applyAll(course({ count: 1 }), [{ cmd: 'trigger.add', args: {
    slide: 's-0', on: { event: 'key', key: 'c' }, do: [{ action: 'completeCourse' }],
  } }]);
  assert.ok(built.ok);
  const first = launch(built.doc); first.rt.start(); first.rt.dispatch({ type: 'key', key: 'c' }); first.ad.save(first.rt.snapshot()); first.ad.exit();
  const back = launch(built.doc, first.store); back.rt.start({ resume: true }); answer(back.rt, 'b');
  assert.equal(back.rt.state.status, 'completed');
  assert.equal(back.rt.state.quiz['q-one'].percent, 0);
  assert.equal(back.api._record().status, 'passed');
  assert.deepEqual(scores(back), []);
});
