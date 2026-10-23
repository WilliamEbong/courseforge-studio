// Behaviour tests: each scenario builds a small course in our format, replays learner actions and asserts the
// order and effects of triggers, layers, revisits and quiz reporting. We log by setting a text variable `probe`,
// so the trace shows `var probe=<tag>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { createRuntime, play, seededRng } from '../../packages/runtime/index.js';

const build = (cmds) => {
  const r = applyAll(emptyCourse({ id: 'diff', title: 'diff' }), cmds, { rng: seededRng(7) });
  assert.ok(r.ok, JSON.stringify(r.errors, null, 1));
  return r.doc;
};
const mark = (tag) => ({ action: 'setVar', var: 'probe', op: 'set', value: tag });
const probes = (trace) => trace.filter((l) => l.startsWith('var probe=')).map((l) => l.slice('var probe='.length));

// ---- trigger order, variable-change timing, show layer, jump cancels the rest ----
function s010Course({ withJump = true, revisit = 'auto' } = {}) {
  return build([
    { cmd: 'var.add', args: { name: 'probe', type: 'text', initial: '' } },
    { cmd: 'var.add', args: { name: 'n', type: 'number', initial: 0 } },
    { cmd: 'slide.add', args: { id: 's-1', title: 'Probe', revisit, objects: [{ id: 'o-probe', type: 'button', text: 'Probe' }] } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-1', title: 'Layer 1', objects: [{ id: 'o-l1', type: 'text', text: 'LAYER ONE' }] } },
    { cmd: 'slide.add', args: { id: 's-2', title: 'Two' } },
    { cmd: 'slide.add', args: { id: 's-3', title: 'Three' } },
    ...[
      { on: { event: 'click', target: 'o-probe' }, do: [mark('c1')] },
      { on: { event: 'click', target: 'o-probe' }, do: [{ action: 'setVar', var: 'n', op: 'add', value: 1 }] },
      { on: { event: 'click', target: 'o-probe' }, do: [mark('c3')] },
      { on: { event: 'click', target: 'o-probe' }, do: [{ action: 'showLayer', layer: 'l-1' }] },
      { on: { event: 'click', target: 'o-probe' }, do: [mark('c5')] },
      ...(withJump ? [{ on: { event: 'click', target: 'o-probe' }, do: [{ action: 'jump', to: 'next' }] }] : []),
      { on: { event: 'click', target: 'o-probe' }, do: [mark('c7')] },
      { on: { event: 'varChange', var: 'n' }, do: [mark('VARCHG')] },
      { on: { event: 'timelineStart' }, do: [mark('S1-start')] },
    ].map((t) => ({ cmd: 'trigger.add', args: { slide: 's-1', ...t } })),
    { cmd: 'trigger.add', args: { slide: 's-1', layer: 'l-1', on: { event: 'timelineStart' }, do: [mark('L1-start')] } },
    { cmd: 'trigger.add', args: { slide: 's-2', on: { event: 'timelineStart' }, do: [mark('S2-start')] } },
  ]);
}

test('panel order, synchronous var-change, layer start, jump cancels remaining triggers', () => {
  const r = play(s010Course(), [{ type: 'click', target: 'o-probe' }]);
  // Vendor: S1-start | c1 n=0 | VARCHG n=1 | c3 | L1-start | c5 | S2-start   (c7 never runs)
  assert.deepEqual(probes(r.trace), ['S1-start', 'c1', 'VARCHG', 'c3', 'L1-start', 'c5', 'S2-start']);
  assert.equal(r.slide, 's-2');
  assert.equal(r.vars.n, 1);
  assert.ok(r.trace.some((l) => l.startsWith('cancel ')) || !probes(r.trace).includes('c7'));
});

// ---- revisit modes ----
for (const [mode, expectAfterPrev, layerVisible] of [
  ['reset', ['S1-start'], false],
  ['resume', ['L1-start', 'S1-start'], true],
  ['auto', ['L1-start', 'S1-start'], true], // auto -> resume because the slide has a button
]) {
  test(` revisit ${mode}`, () => {
    const rt = createRuntime(s010Course({ withJump: false, revisit: mode }), { rng: seededRng(1) });
    rt.start();
    rt.dispatch({ type: 'click', target: 'o-probe' });
    assert.deepEqual(probes(rt.trace), ['S1-start', 'c1', 'VARCHG', 'c3', 'L1-start', 'c5', 'c7']); // c7 runs without a jump
    rt.dispatch({ type: 'next' });
    const before = probes(rt.trace).length;
    rt.dispatch({ type: 'prev' });
    assert.deepEqual(probes(rt.trace).slice(before), expectAfterPrev);
    assert.equal(rt.state.layers.includes('l-1'), layerVisible);
    assert.equal(rt.state.vars.n, 1, 'variables never reset on revisit');
  });
}

// ---- condition + else, toggle, text set, same-value assignment, disabled blocks clicks ----
test('condition/else, toggle, same-value assignment does not fire, disabled ignores clicks', () => {
  const doc = build([
    { cmd: 'var.add', args: { name: 'probe', type: 'text', initial: '' } },
    { cmd: 'var.add', args: { name: 'n', type: 'number', initial: 0 } },
    { cmd: 'var.add', args: { name: 't', type: 'text', initial: 'init' } },
    { cmd: 'var.add', args: { name: 'flag', type: 'boolean', initial: false } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-b', type: 'button', text: 'Probe' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [mark('A')] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'setVar', var: 'n', op: 'add', value: 1 }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, if: { all: [{ var: 'n', op: '==', value: 1 }] }, do: [{ action: 'setState', target: 'o-b', state: 'selected' }], else: [{ action: 'setState', target: 'o-b', state: 'disabled' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'setVar', var: 't', op: 'set', value: 'hello' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'setVar', var: 'flag', op: 'toggle' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'setVar', var: 't', op: 'set', value: 'hello' }, mark('end')] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'varChange', var: 'n' }, do: [mark('VARCHG')] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'varChange', var: 't' }, do: [mark('TCHG')] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'varChange', var: 'flag' }, do: [mark('FCHG')] } },
  ]);
  const rt = createRuntime(doc);
  rt.start();
  rt.dispatch({ type: 'click', target: 'o-b' });
  assert.deepEqual(probes(rt.trace), ['A', 'VARCHG', 'TCHG', 'FCHG', 'end']);
  assert.equal(rt.state.obj['o-b'].state, 'selected');
  let n = probes(rt.trace).length;
  rt.dispatch({ type: 'click', target: 'o-b' });
  assert.deepEqual(probes(rt.trace).slice(n), ['A', 'VARCHG', 'FCHG', 'end'], 'no TCHG: t already "hello"');
  assert.equal(rt.state.obj['o-b'].state, 'disabled');
  n = probes(rt.trace).length;
  rt.dispatch({ type: 'click', target: 'o-b' });
  assert.deepEqual(probes(rt.trace).slice(n), [], 'disabled object ignores clicks');
});

// ---- quiz attempt 1 (fail), retry, attempt 2 (pass), LMS reporting ----
function quizCourse() {
  return build([
    { cmd: 'slide.add', args: { id: 's-q1', title: 'Q1', question: { type: 'mc', prompt: 'pick Beta', choices: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta', correct: true }, { id: 'gamma', label: 'Gamma' }] } } },
    { cmd: 'slide.add', args: { id: 's-q2', title: 'Q2', question: { type: 'mr', prompt: 'pick One and Three', choices: [{ id: 'one', label: 'One', correct: true }, { id: 'two', label: 'Two' }, { id: 'three', label: 'Three', correct: true }] } } },
    { cmd: 'slide.add', args: { id: 's-q3', title: 'Q3', question: { type: 'fill', prompt: 'type teal', answers: ['teal', 'teal blue'] } } },
    { cmd: 'slide.add', args: { id: 's-res', title: 'Results', objects: [{ id: 'o-retry', type: 'button', text: 'Retry Quiz' }] } },
    { cmd: 'layer.add', args: { slide: 's-res', id: 'l-pass', title: 'Success' } },
    { cmd: 'layer.add', args: { slide: 's-res', id: 'l-fail', title: 'Failure' } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q1', 's-q2', 's-q3'], passPercent: 80, results: 's-res' } },
    { cmd: 'trigger.add', args: { slide: 's-res', on: { event: 'timelineStart' }, do: [{ action: 'submitQuiz', quiz: 'qz' }] } },
    { cmd: 'trigger.add', args: { slide: 's-res', on: { event: 'timelineStart' }, if: { all: [{ var: 'qz.passed', op: '==', value: true }] }, do: [{ action: 'showLayer', layer: 'l-pass' }], else: [{ action: 'showLayer', layer: 'l-fail' }] } },
    { cmd: 'trigger.add', args: { slide: 's-res', on: { event: 'click', target: 'o-retry' }, do: [{ action: 'resetQuiz', quiz: 'qz' }] } },
    { cmd: 'tracking.set', args: { complete: [{ quiz: 'qz' }], status: 'passed-failed' } },
  ]);
}
const answer = (q1, q2, q3) => [
  { type: 'choose', choice: q1 }, { type: 'submit' }, { type: 'continue' },
  ...q2.map((c) => ({ type: 'choose', choice: c })), { type: 'submit' }, { type: 'continue' },
  { type: 'input', answer: true, text: q3 }, { type: 'submit' }, { type: 'continue' },
];

test('running truncated score per submit, fail then retry then pass', () => {
  const calls = [];
  const lms = { init: () => null, status: (s) => calls.push(`status ${s}`), score: (x) => calls.push(`score ${x.raw}`), interaction: (r) => calls.push(`int ${r.question} ${r.result} ${r.id}`), save: () => {}, exit: () => {} };
  const rt = createRuntime(quizCourse(), { lms, rng: seededRng(3) });
  rt.start();
  for (const e of answer('alpha', ['one', 'three'], 'TEAL')) rt.dispatch(e); // TEAL: case-insensitive by default
  assert.equal(rt.state.slide, 's-res');
  assert.deepEqual(calls, [
    'score 0', 'int s-q1 incorrect qz_s-q1_0_0',
    'score 33.33', 'int s-q2 correct qz_s-q2_0_0',
    'score 66.66', 'int s-q3 correct qz_s-q3_0_0', // truncated, not rounded (vendor: 66.66)
    'status failed', // the results slide sends only the status (vendor, no second score.raw)
  ]);
  assert.deepEqual(rt.state.layers, ['l-fail']);
  calls.length = 0;
  rt.dispatch({ type: 'click', target: 'o-retry' });
  assert.equal(rt.state.slide, 's-q1', 'retry returns to the first question');
  assert.deepEqual(calls, ['status incomplete']);
  calls.length = 0;
  for (const e of answer('beta', ['one', 'three'], 'teal blue')) rt.dispatch(e);
  assert.deepEqual(calls, [
    'score 33.33', 'int s-q1 correct qz_s-q1_1_0', // quiz attempt, then question attempt, as in the vendor ids (_1_0)
    'score 66.66', 'int s-q2 correct qz_s-q2_1_0',
    'score 100', 'int s-q3 correct qz_s-q3_1_0',
    'status passed',
  ]);
  assert.deepEqual(rt.state.layers, ['l-pass']);
});

test('wrong answer with attempts left shows try-again and allows a second try', () => {
  const doc = quizCourse();
  doc.slides.find((s) => s.id === 's-q1').question.attempts = 2;
  const rt = createRuntime(doc, { rng: seededRng(3) });
  rt.start();
  rt.dispatch({ type: 'choose', choice: 'alpha' }).dispatch({ type: 'submit' });
  assert.equal(rt.view().feedback.kind, 'tryAgain');
  rt.dispatch({ type: 'continue' });
  assert.equal(rt.state.slide, 's-q1');
  rt.dispatch({ type: 'choose', choice: 'beta' }).dispatch({ type: 'submit' });
  assert.equal(rt.view().feedback.kind, 'correct');
  rt.dispatch({ type: 'continue' });
  assert.equal(rt.state.slide, 's-q2');
});

// + (2026-10-16): a 1.5 s hide-on-end layer shown at 0.6 s on a 3 s auto-advance slide. Vendor: with
// "Pause timeline of base layer" off the base still ends at ~3.0 s; with it on, the end moves by the layer's 1.5 s.
test('base timeline keeps running under a non-pausing layer and pauses under a pausing one', async () => {
  const { applyAll } = await import('../../packages/core/index.js');
  const { emptyCourse } = await import('../../packages/schema/index.js');
  const { createRuntime } = await import('../../packages/runtime/index.js');
  const endAt = (pauseBase) => {
    const r = applyAll(emptyCourse(), [
      { cmd: 'slide.add', args: { id: 's-1', duration: 3000, advance: 'auto', objects: [{ id: 'o-b', type: 'button', text: 'Show' }] } },
      { cmd: 'slide.add', args: { id: 's-2' } },
      { cmd: 'layer.add', args: { slide: 's-1', id: 'l-1', duration: 1500, hideOnEnd: true, pauseBase, hideOthers: false } },
      { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'showLayer', layer: 'l-1' }] } },
    ]);
    const rt = createRuntime(r.doc); rt.start();
    rt.tick(600); rt.dispatch({ type: 'click', target: 'o-b' });
    let t = 600;
    while (rt.state.slide === 's-1' && t < 10000) { rt.tick(10); t += 10; }
    return t;
  };
  assert.ok(Math.abs(endAt(false) - 3000) <= 20, `pause off: ${endAt(false)} ms`);
  assert.ok(Math.abs(endAt(true) - 4500) <= 20, `pause on: ${endAt(true)} ms`);
});

// ---- (Module 2, forced draw): the quiz total covers only the drawn questions ----
// Vendor: with the draw forced, correct answers worth 1, 11, 12 and 13 of the 19 drawn points sent score.raw 5, 58, 63, 68
// (roundUpScorePercent). Rebuilt: 12 bank questions, a draw of 10 forced to the first ten (19 points); the two undrawn
// questions are worth 50 each, so counting them would give other numbers.
test('drawn-only scoring (1, 11, 12, 13 of 19 points -> 5, 58, 63, 68) on a forced draw', () => {
  const points = [1, 10, 1, 1, 1, 1, 1, 1, 1, 1, 50, 50];
  const doc = build([
    { cmd: 'slide.add', args: { id: 's-intro', title: 'Intro' } },
    { cmd: 'bank.add', args: { id: 'bk-m2', title: 'Module bank' } },
    ...points.map((p, k) => ({ cmd: 'slide.add', args: { id: `s-b${k + 1}`, bank: 'bk-m2', question: { type: 'mc', prompt: `Q${k + 1}`, points: p, shuffle: false, choices: [{ id: 'a', label: 'right', correct: true }, { id: 'b', label: 'wrong' }] } } })),
    { cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-m2', count: 10, shuffle: false } },
    { cmd: 'slide.add', args: { id: 's-res', title: 'Results' } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-draw'], round: true, results: 's-res' } },
  ]);
  const scores = [], ids = [];
  const forced = () => 0; // the probe's forced Math.random: index 0 of the remaining list each time
  const rt = createRuntime(doc, { rng: forced, lms: { init: () => null, score: (x) => scores.push(x.raw), interaction: (r) => ids.push(r.question), status() {}, save() {} } });
  rt.start();
  rt.dispatch({ type: 'next' });
  assert.deepEqual(rt.state.draws['s-draw'], points.slice(0, 10).map((_, k) => `s-b${k + 1}`));
  for (let k = 0; k < 10; k++) rt.dispatch({ type: 'choose', choice: k < 4 ? 'a' : 'b' }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });
  assert.equal(rt.state.slide, 's-res');
  assert.deepEqual(scores, [5, 58, 63, 68], 'score.raw sent only when it changes');
  assert.equal(ids.length, 10, 'one interaction per drawn question, none for the bank remainder');
});
