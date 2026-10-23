// -rows: runtime corrections found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { play, createRuntime } from '../../packages/runtime/index.js';

const ok = (cmds) => { const r = applyAll(emptyCourse(), cmds); assert.ok(r.ok, JSON.stringify(r.errors)); return r.doc; };

test('V3: key triggers run topmost layer first, then lower layers, then the slide; nothing below a modal layer', () => {
  const base = [
    { cmd: 'var.add', args: { name: 'log', type: 'text' } },
    { cmd: 'slide.add', args: { id: 's-1' } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-low', hideOthers: false } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-top', hideOthers: false } },
    ...['s', 'l-low', 'l-top'].map((c) => ({ cmd: 'trigger.add', args: { slide: 's-1', ...(c === 's' ? {} : { layer: c }), on: { event: 'key', key: 'k' }, do: [{ action: 'setVar', var: 'log', op: 'set', fromVar: 'log' }, { action: 'setVar', var: 'log', op: 'set', value: c }] } })),
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'timelineStart' }, do: [{ action: 'showLayer', layer: 'l-low' }, { action: 'showLayer', layer: 'l-top' }] } },
  ];
  const order = (d) => play(d, [{ type: 'key', key: 'k' }]).trace.filter((t) => t.startsWith('var log=')).map((t) => t.slice(8));
  assert.deepEqual(order(ok(base)), ['l-top', 'l-low', 's']);
  const modal = ok([...base, { cmd: 'layer.set', args: { id: 'l-low', modal: true } }]);
  assert.deepEqual(order(modal), ['l-top', 'l-low'], 'the slide (below the modal layer) does not hear the key');
});

test('V5: a jump that goes nowhere still ends the rest of the action list', () => {
  const d = ok([
    { cmd: 'var.add', args: { name: 'n', type: 'number' } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o', type: 'button' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o' }, do: [{ action: 'jump', to: 'next' }, { action: 'setVar', var: 'n', op: 'set', value: 1 }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o' }, do: [{ action: 'setVar', var: 'n', op: 'set', value: 2 }] } },
  ]);
  const r = play(d, [{ type: 'click', target: 'o' }]);
  assert.equal(r.vars.n, 0);
  assert.ok(r.trace.includes('warn no next slide'));
  assert.ok(r.trace.some((t) => t.startsWith('cancel ')));
});

// Example-course runtime (Q1): every submit is reported, Try Again keeps the answers
// unlimited attempts, score sent only on change; quiz "Round score percentage" option (vendor Quiz Settings).
function quizCourse({ attempts = 2, round = false, n = 1 } = {}) {
  const cmds = [];
  for (let i = 1; i <= n; i++) cmds.push({ cmd: 'slide.add', args: { id: `s-q${i}`, question: { type: 'mc', prompt: `Q${i}`, shuffle: false, attempts, choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', correct: true }] } } });
  cmds.push({ cmd: 'quiz.add', args: { id: 'qz', questions: Array.from({ length: n }, (_, i) => `s-q${i + 1}`), round } });
  const doc = ok(cmds);
  doc.tracking.complete = [{ quiz: 'qz' }]; // a one-slide quiz must not complete by views before its first answer
  return doc;
}
const lmsLog = () => { const calls = []; return { calls, lms: { init: () => null, status: (s) => calls.push(`status ${s}`), score: (x) => calls.push(`score ${x.raw}`), interaction: (r) => calls.push(`int ${r.id} ${r.result}`), save: () => {}, exit: () => {} } }; };

test('V1/V10: every submit sends an interaction (question-attempt suffix); the score only when it changes', () => {
  const { calls, lms } = lmsLog();
  play(quizCourse({ attempts: 3 }), [{ type: 'choose', choice: 'a' }, { type: 'submit' }, { type: 'continue' }, { type: 'submit' }, { type: 'continue' }, { type: 'choose', choice: 'a' }, { type: 'choose', choice: 'b' }, { type: 'submit' }], { lms });
  assert.deepEqual(calls.filter((c) => !c.startsWith('status')), ['score 0', 'int qz_s-q1_0_0 incorrect', 'int qz_s-q1_0_1 incorrect', 'score 100', 'int qz_s-q1_0_2 correct']);
});

test('V2: Try Again keeps the learner\'s answer; only the feedback closes', () => {
  const r = play(quizCourse({ attempts: 2 }), [{ type: 'choose', choice: 'a' }, { type: 'submit' }, { type: 'continue' }]);
  assert.equal(r.view.feedback, null);
  assert.deepEqual(r.view.question.choices.filter((c) => c.selected).map((c) => c.id), ['a']);
  assert.equal(r.view.question.result, null, 'still answerable');
});

test('V7: attempts 0 = unlimited; the result is final only when correct', () => {
  const evs = [];
  for (let i = 0; i < 6; i++) evs.push({ type: 'choose', choice: 'a' }, { type: 'submit' }, { type: 'continue' });
  const r = play(quizCourse({ attempts: 0 }), evs);
  assert.equal(r.view.question.result, null);
  assert.equal(r.view.question.attempts, 6);
  assert.equal(r.trace.filter((t) => t === 'submit s-q1 tryAgain').length, 6);
});

test('V9: quiz.round rounds the score percent; default keeps two truncated decimals', () => {
  const evs = [{ type: 'choose', choice: 'b' }, { type: 'submit' }, { type: 'continue' }, { type: 'choose', choice: 'a' }, { type: 'submit' }, { type: 'continue' }, { type: 'choose', choice: 'a' }, { type: 'submit' }];
  const scoreOf = (round) => { const { calls, lms } = lmsLog(); play(quizCourse({ attempts: 1, round, n: 3 }), evs, { lms }); return calls.filter((c) => c.startsWith('score')).at(-1); };
  assert.equal(scoreOf(false), 'score 33.33');
  assert.equal(scoreOf(true), 'score 33');
});

// fixes.
test('Next/Prev do not skip an unanswered question; the view hides them until answered', () => {
  const d = ok([
    { cmd: 'slide.add', args: { id: 's-0' } },
    { cmd: 'slide.add', args: { id: 's-q', question: { type: 'mc', prompt: 'p', shuffle: false, choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', correct: true }] } } },
    { cmd: 'slide.add', args: { id: 's-2' } },
  ]);
  const r = play(d, [{ type: 'next' }, { type: 'next' }, { type: 'prev' }]);
  assert.equal(r.slide, 's-q');
  assert.equal(r.trace.filter((t) => t === 'warn answer the question first').length, 2);
  assert.deepEqual([r.view.nav.next, r.view.nav.prev, r.view.nav.submit], [false, false, true]);
  const after = play(d, [{ type: 'next' }, { type: 'choose', choice: 'b' }, { type: 'submit' }, { type: 'continue' }]);
  assert.equal(after.slide, 's-2');
});

test('interactions carry latency (slide clock) and the quiz as objective; Retry keeps menu viewed marks', async () => {
  const { toScormInteraction } = await import('../../packages/publisher/index.js');
  const { createRuntime } = await import('../../packages/runtime/index.js');
  const ints = [];
  const d = quizCourse({ attempts: 1 });
  const rt = createRuntime(d, { lms: { init: () => null, status: () => {}, score: () => {}, interaction: (x) => ints.push(x), save: () => {}, exit: () => {} } });
  rt.start(); rt.tick(1234); rt.dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' });
  assert.equal(ints[0].latencyMs, 1234);
  assert.equal(ints[0].objective, 'qz');
  const sc = toScormInteraction(ints[0]);
  assert.equal(sc.latencyMs, 1234); assert.equal(sc.objective, 'qz');
  rt.dispatch({ type: 'continue' });
  const viewed = [...rt.state.viewed];
  rt.dispatch({ type: 'tick', ms: 1 });
  assert.ok(viewed.includes('s-q1'));
});

test('the generated Retry button shows only after a fail', () => {
  const d = ok([
    { cmd: 'slide.add', args: { id: 's-q1', question: { type: 'mc', prompt: 'p', shuffle: false, choices: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B' }] } } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q1'], passPercent: 100 } }, { cmd: 'quiz.addResults', args: { quiz: 'qz', id: 's-r' } },
  ]);
  const visibleRetry = (choice) => play(d, [{ type: 'choose', choice }, { type: 'submit' }, { type: 'continue' }]).view.objects.find((o) => o.id === 's-r-retry').visible;
  assert.equal(visibleRetry('a'), false, 'passed: no Retry');
  assert.equal(visibleRetry('b'), true, 'failed: Retry on the Failed layer');
});

test('the menu does not list a quiz results slide (vendor); a scene left empty drops out', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'slide.add', args: { id: 's-q', title: 'Q', question: { type: 'mc', prompt: 'p', choices: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B' }] } } },
    { cmd: 'scene.add', args: { id: 'sc-r', title: 'Results scene' } },
    { cmd: 'slide.add', args: { id: 's-res', title: 'Quiz Results', scene: 'sc-r' } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q'], results: 's-res' } },
  ]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const rt = createRuntime(r.doc); rt.start();
  const menu = rt.view().menu;
  assert.deepEqual(menu.map((sc) => sc.slides.map((x) => x.id)), [['s-q']]);
});
