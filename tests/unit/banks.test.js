// question banks and draw slides (schema, commands, runtime draw rule, flow, scoring, retry, resume).
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse, validate, serialize, parse } from '../../packages/schema/index.js';
import { applyAll, describe } from '../../packages/core/index.js';
import { createRuntime, play, seededRng } from '../../packages/runtime/index.js';
import { toScormInteraction } from '../../packages/publisher/index.js';

const mc = (k, points = 10) => ({ type: 'mc', prompt: `Question ${k}`, points, shuffle: false, choices: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes', correct: true }] });
const build = (cmds) => {
  const r = applyAll(emptyCourse({ id: 'bk', title: 'Banks' }), cmds, { rng: seededRng(5) });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.doc;
};
const fails = (doc, cmds) => {
  const r = applyAll(doc, cmds);
  assert.equal(r.ok, false, 'expected the batch to fail');
  return r.errors[0];
};
// intro, a draw of `draw` from bank b1..b5, a direct question s-q, results
const course = (draw = {}, extra = []) => build([
  { cmd: 'slide.add', args: { id: 's-intro', title: 'Intro' } },
  { cmd: 'bank.add', args: { id: 'bk-1', title: 'Safety bank' } },
  ...[1, 2, 3, 4, 5].map((k) => ({ cmd: 'slide.add', args: { id: `s-b${k}`, bank: 'bk-1', title: `Bank ${k}`, question: mc(k) } })),
  { cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-1', count: 3, ...draw } },
  { cmd: 'slide.add', args: { id: 's-q', title: 'Direct', question: mc('direct') } },
  { cmd: 'slide.add', args: { id: 's-end', title: 'End' } },
  { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-draw', 's-q'], results: 's-end' } },
  ...extra,
]);
/** An rng that returns the given values in order and fails the test if anything asks for more. */
const script = (values) => { const v = [...values]; return () => { assert.ok(v.length, 'rng called more often than the draw needs'); return v.shift(); }; };
const run = (doc, rng, lms = null) => { const rt = createRuntime(doc, { rng, lms }); rt.start(); return rt; };

// ---------------- draw rule ----------------
test('draw rule replays the vendor rule: each slot takes item floor(r * remaining) of the remaining bank order', () => {
  // bank b1..b5, r = .5 -> index 2 of 5 (b3); r = 0 -> index 0 of 4 (b1); r = .99 -> index 2 of 3 (b5)
  const rt = run(course(), script([0.5, 0, 0.99]));
  rt.dispatch({ type: 'next' });
  assert.deepEqual(rt.state.draws['s-draw'], ['s-b3', 's-b1', 's-b5'], 'shuffle: pick order');
  assert.equal(rt.state.slide, 's-b3');
  assert.ok(rt.trace.includes('draw s-draw s-b3,s-b1,s-b5'));
  const keep = run(course({ shuffle: false }), script([0.5, 0, 0.99]));
  keep.dispatch({ type: 'next' });
  assert.deepEqual(keep.state.draws['s-draw'], ['s-b1', 's-b3', 's-b5'], 'no shuffle: the same picks in bank order');
});

test('always slides come first, never slides are not eligible; count 0 draws every eligible slide', () => {
  const rt = run(course({ always: ['s-b5'], never: ['s-b1'] }), script([0, 0]));
  rt.dispatch({ type: 'next' });
  assert.deepEqual(rt.state.draws['s-draw'], ['s-b5', 's-b2', 's-b3']);
  const all = run(course({ count: 0, never: ['s-b4'], shuffle: false }), script([0.9, 0.9, 0.9, 0.9]));
  all.dispatch({ type: 'next' });
  assert.deepEqual(all.state.draws['s-draw'], ['s-b1', 's-b2', 's-b3', 's-b5']);
  const big = run(course({ count: 9 }), seededRng(2)); // more than the bank holds: everything, once
  big.dispatch({ type: 'next' });
  assert.equal(new Set(big.state.draws['s-draw']).size, 5);
});

test('flow: Next walks the drawn slides then leaves the draw; Prev is history; progress n / N follows the flow', () => {
  const rt = run(course(), script([0, 0, 0])); // b1, b2, b3
  assert.deepEqual([rt.view().slide.index, rt.view().slide.count], [0, 4], 'an undrawn draw is one entry');
  rt.dispatch({ type: 'next' });
  assert.deepEqual([rt.state.slide, rt.view().slide.index, rt.view().slide.count], ['s-b1', 1, 6]);
  for (const id of ['s-b2', 's-b3', 's-q']) {
    rt.dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });
    assert.equal(rt.state.slide, id);
  }
  rt.dispatch({ type: 'menu', slide: 's-b2' }).dispatch({ type: 'prev' });
  assert.equal(rt.state.slide, 's-q', 'Prev = history back, not flow back');
  rt.dispatch({ type: 'menu', slide: 's-b4' });
  assert.equal(rt.state.slide, 's-q', 'a bank slide that was not drawn is refused');
  assert.ok(rt.trace.includes('warn s-b4 not drawn'));
  rt.dispatch({ type: 'menu', slide: 's-draw' });
  assert.equal(rt.state.slide, 's-b1', 'a jump to the draw enters its first drawn slide, no new draw');
  assert.equal(rt.trace.filter((l) => l.startsWith('draw ')).length, 1);
});

test('menu: a draw is one entry until drawn, then its drawn slides under the draw title', () => {
  const rt = run(course(), script([0, 0, 0]));
  const entry = () => rt.view().menu[0].slides.find((s) => s.id === 's-draw');
  assert.deepEqual(entry(), { id: 's-draw', title: 'Draw from Safety bank', viewed: false, current: false });
  rt.dispatch({ type: 'next' });
  assert.deepEqual(entry().slides.map((s) => [s.id, s.viewed, s.current]), [['s-b1', true, true], ['s-b2', false, false], ['s-b3', false, false]]);
  assert.equal(entry().current, true);
});

test('an empty draw (every slide excluded) is skipped; a draw first in the course is entered at start', () => {
  const empty = run(course({ count: 0, never: ['s-b1', 's-b2', 's-b3', 's-b4', 's-b5'] }), script([]));
  empty.dispatch({ type: 'next' });
  assert.equal(empty.state.slide, 's-q');
  const first = build([
    { cmd: 'bank.add', args: { id: 'bk-1' } },
    { cmd: 'slide.add', args: { id: 's-b1', bank: 'bk-1', question: mc(1) } },
    { cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-1' } },
  ]);
  assert.equal(run(first, script([0])).state.slide, 's-b1');
});

test('slides viewed counts the flow: drawn slides, not the draw or the rest of the bank', () => {
  const doc = course({}, [{ cmd: 'tracking.set', args: { complete: [{ slidesViewed: 100 }] } }]);
  const rt = run(doc, script([0, 0, 0]));
  rt.dispatch({ type: 'next' });
  const answer = () => rt.dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });
  for (let i = 0; i < 3; i++) answer();
  assert.equal(rt.state.slide, 's-q');
  assert.equal(rt.state.status, 'incomplete', '5 of 6 flow slides seen (the 2 undrawn bank slides do not count)');
  answer();
  assert.equal(rt.state.slide, 's-end');
  assert.equal(rt.state.status, 'completed');
});

// ---------------- scoring, retry, resume ----------------
test('scoring counts the drawn questions only; an undrawn draw counts nothing; interaction ids use the bank slide id', () => {
  const calls = [];
  const lms = { init: () => null, score: (x) => calls.push(`score ${x.raw}`), interaction: (r) => calls.push(`ix ${r.id} ${r.question}`), status() {}, save() {} };
  const rt = run(course({}, [{ cmd: 'tracking.set', args: { complete: [{ quiz: 'qz' }] } }]), script([0, 0, 0]), lms);
  rt.dispatch({ type: 'menu', slide: 's-q' }).dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' });
  assert.deepEqual(calls.splice(0), ['score 100', 'ix qz_s-q_0_0 s-q'], 'nothing drawn yet: 10 of 10');
  rt.dispatch({ type: 'continue' }).dispatch({ type: 'menu', slide: 's-draw' }).dispatch({ type: 'choose', choice: 'a' }).dispatch({ type: 'submit' });
  assert.deepEqual(calls.splice(0), ['score 25', 'ix qz_s-b1_0_0 s-b1'], 'three drawn + one direct = 40 points; 10 earned');
  rt.dispatch({ type: 'continue' }).dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' });
  assert.deepEqual(calls.splice(0), ['score 50', 'ix qz_s-b2_0_0 s-b2']);
  rt.dispatch({ type: 'continue' }).dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });
  assert.deepEqual(calls.splice(0), ['score 75', 'ix qz_s-b3_0_0 s-b3']);
  assert.equal(rt.state.slide, 's-q', 'Continue on the last drawn slide leaves the draw');
});

test('resetQuiz clears the drawn sets and their answers; the next entry draws again', () => {
  const doc = course({}, [{ cmd: 'trigger.add', args: { slide: 's-end', on: { event: 'key', key: 'r' }, do: [{ action: 'resetQuiz', quiz: 'qz' }] } }]);
  const ids = [];
  const rt = run(doc, script([0, 0, 0, 0.99, 0.99, 0.99]), { init: () => null, interaction: (r) => ids.push(r.id), score() {}, status() {}, save() {} });
  rt.dispatch({ type: 'next' });
  rt.dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });
  assert.deepEqual(rt.state.draws['s-draw'], ['s-b1', 's-b2', 's-b3']);
  rt.dispatch({ type: 'menu', slide: 's-end' }).dispatch({ type: 'key', key: 'r' });
  assert.deepEqual(rt.state.draws['s-draw'], ['s-b5', 's-b4', 's-b3'], 'retry draws a new set');
  assert.equal(rt.state.slide, 's-b5', 'and returns to the first question');
  assert.equal(rt.state.q['s-b1'], undefined, 'old answers are cleared');
  rt.dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' });
  assert.deepEqual(ids, ['qz_s-b1_0_0', 'qz_s-b5_1_0']);
});

test('resume restores the drawn set (compact bank indexes); hostile draw data is dropped', () => {
  const doc = course();
  let saved = null;
  const rt = run(doc, script([0.5, 0, 0.99]), { init: () => null, save: (s) => { saved = JSON.parse(JSON.stringify(s)); } });
  rt.dispatch({ type: 'next' }).dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });
  assert.deepEqual(saved.dr, { 's-draw': [2, 0, 4] });
  const back = createRuntime(doc, { rng: script([]), lms: { init: () => saved } });
  back.start({ resume: true });
  assert.deepEqual(back.state.draws, { 's-draw': ['s-b3', 's-b1', 's-b5'] });
  assert.equal(back.state.slide, 's-b1');
  assert.equal(back.state.q['s-b3'].result, 'correct');
  back.dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });
  assert.equal(back.state.slide, 's-b5', 'the flow continues through the restored set');

  const evil = (dr) => { const r = createRuntime(doc, { rng: seededRng(1), lms: { init: () => ({ ...saved, slide: 's-b4', dr }) } }); r.start({ resume: true }); return r; };
  let r = evil({ 's-draw': [1, 1, 99, -1, 's-b4', 's-nope', {}] }); // duplicates, out of range, foreign ids
  assert.deepEqual(r.state.draws, {}, 'a set this draw could not have drawn is dropped and drawn again on entry (review 005 #4)');
  assert.equal(r.state.slide, 's-intro');
  assert.equal(r.state.q['s-b3'], undefined, 'answers of undrawn bank slides are dropped with the set');
  r = evil({ 's-q': [0], constructor: [0], 's-draw': 'x' }); // not a draw / not an array
  assert.deepEqual(r.state.draws, {});
  assert.equal(r.state.slide, 's-intro', 'a bank slide outside the restored flow is not a resume target');
});

test('a snapshot with a 10-of-27 draw stays small', () => {
  const doc = build([
    { cmd: 'bank.add', args: { id: 'bk-1' } },
    ...Array.from({ length: 27 }, (_, k) => ({ cmd: 'slide.add', args: { id: `s-bank-question-${k}`, bank: 'bk-1', question: mc(k) } })),
    { cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-1', count: 10 } },
  ]);
  const rt = run(doc, seededRng(8));
  assert.ok(JSON.stringify(rt.snapshot().dr).length < 60);
});

test('every question type works when drawn (mc, mr, tf, fill, hotspot, dragdrop, matching, sequence)', () => {
  const two = [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B' }];
  const doc = build([
    { cmd: 'bank.add', args: { id: 'bk-1' } },
    { cmd: 'slide.add', args: { id: 's-mc', bank: 'bk-1', question: { type: 'mc', prompt: 'mc', shuffle: false, choices: two } } },
    { cmd: 'slide.add', args: { id: 's-mr', bank: 'bk-1', question: { type: 'mr', prompt: 'mr', shuffle: false, choices: two } } },
    { cmd: 'slide.add', args: { id: 's-tf', bank: 'bk-1', question: { type: 'tf', prompt: 'tf', shuffle: false, choices: [{ id: 't', label: 'True', correct: true }, { id: 'f', label: 'False' }] } } },
    { cmd: 'slide.add', args: { id: 's-fill', bank: 'bk-1', question: { type: 'fill', prompt: 'fill', answers: ['teal'] } } },
    { cmd: 'slide.add', args: { id: 's-hs', bank: 'bk-1', question: { type: 'hotspot', prompt: 'hs', areas: [{ id: 'v', x: 0, y: 0, w: 100, h: 100, correct: true }] } } },
    { cmd: 'slide.add', args: { id: 's-dd', bank: 'bk-1', objects: [{ id: 'o-item', type: 'button', text: 'i' }, { id: 'o-bin', type: 'shape', x: 300 }], question: { type: 'dragdrop', prompt: 'dd', items: [{ object: 'o-item', target: 'o-bin' }], targets: [{ object: 'o-bin' }] } } },
    { cmd: 'slide.add', args: { id: 's-match', bank: 'bk-1', question: { type: 'matching', prompt: 'm', shuffle: false, choices: two, rows: [{ id: 'r1', label: 'R', choice: 'a' }] } } },
    { cmd: 'slide.add', args: { id: 's-seq', bank: 'bk-1', question: { type: 'sequence', prompt: 's', shuffle: false, choices: two } } },
    { cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-1', shuffle: false } },
    { cmd: 'slide.add', args: { id: 's-end' } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-draw'] } },
  ]);
  const answer = {
    's-mc': [{ type: 'choose', choice: 'a' }], 's-mr': [{ type: 'choose', choice: 'a' }], 's-tf': [{ type: 'choose', choice: 't' }],
    's-fill': [{ type: 'input', answer: true, text: 'teal' }], 's-hs': [{ type: 'point', x: 50, y: 50 }],
    's-dd': [{ type: 'drop', item: 'o-item', target: 'o-bin' }], 's-match': [{ type: 'match', row: 'r1', choice: 'a' }], 's-seq': [],
  };
  const recs = [], scores = [];
  const rt = run(doc, seededRng(1), { init: () => null, interaction: (r) => recs.push(r), score: (x) => scores.push(x.raw), status() {}, save() {} });
  while (answer[rt.state.slide]) {
    for (const e of [...answer[rt.state.slide], { type: 'submit' }, { type: 'continue' }]) rt.dispatch(e);
  }
  assert.equal(rt.state.slide, 's-end');
  assert.deepEqual(recs.map((r) => [r.question, r.result]), Object.keys(answer).map((id) => [id, 'correct']));
  for (const r of recs) assert.ok(toScormInteraction(r), `${r.type} maps to SCORM`);
  assert.equal(scores.at(-1), 100);
});

// ---------------- schema and commands ----------------
test('validation errors are actionable (path, code, hint)', () => {
  const d = course();
  assert.deepEqual(validate(d), []);
  const bad = (mutate) => { const x = structuredClone(d); mutate(x); return validate(x); };
  const draw = (x) => x.slides.find((s) => s.id === 's-draw');
  let e = bad((x) => { draw(x).draw.bank = 'bk-nope'; });
  assert.deepEqual([e[0].code, e[0].path], ['ref', '/slides/6/draw/bank']);
  assert.match(e[0].hint, /banks: bk-1/);
  e = bad((x) => { draw(x).draw.always = ['s-q']; });
  assert.deepEqual([e[0].code, e[0].path], ['ref', '/slides/6/draw/always/0']);
  assert.match(e[0].hint, /bank slides: s-b1, s-b2/);
  e = bad((x) => { draw(x).draw.always = ['s-b1']; draw(x).draw.never = ['s-b1']; });
  assert.match(e[0].message, /both always and never/);
  e = bad((x) => { draw(x).draw.count = 1; draw(x).draw.always = ['s-b1', 's-b2']; });
  assert.deepEqual([e[0].code, e[0].path], ['range', '/slides/6/draw/always']);
  e = bad((x) => { draw(x).objects.push({ id: 'o-x', type: 'text' }); });
  assert.match(e[0].message, /draw slide "s-draw" has content/);
  e = bad((x) => { x.quizzes[0].questions.push('s-b2'); });
  assert.match(e[0].message, /in bank "bk-1"/);
  assert.match(e[0].hint, /list the draw slide instead: s-draw/);
  e = bad((x) => { x.scenes[0].slides.push('s-b1'); });
  assert.match(e[0].message, /already in scene/);
  e = bad((x) => { x.banks.push({ id: 'bk-2', slides: ['s-draw'] }); x.scenes[0].slides = x.scenes[0].slides.filter((s) => s !== 's-draw'); });
  assert.match(e.map((x) => x.message).join('\n'), /draw slide "s-draw" is in bank "bk-2"/);
  e = bad((x) => { x.banks.push({ id: 'sc-1' }); });
  assert.equal(e[0].code, 'dupe');
});

test('serialization: banks and draw defaults are omitted until used; a course with banks round-trips', () => {
  assert.ok(!serialize(emptyCourse()).includes('banks'));
  const d = course({ shuffle: true, count: 3 });
  const text = serialize(d);
  assert.match(text, /"draw": \{\n\s+"bank": "bk-1",\n\s+"count": 3\n\s+\}/);
  assert.equal(serialize(parse(text)), text);
});

test('bank commands: add, rename, remove (refused while a draw uses it; slides need force)', () => {
  const d = course();
  assert.match(fails(d, [{ cmd: 'bank.remove', args: { id: 'bk-1' } }]).message, /draw slide\(s\) s-draw draw from bank "bk-1"/);
  const r = applyAll(d, [{ cmd: 'bank.set', args: { id: 'bk-1', title: 'Renamed' } }, { cmd: 'slide.remove', args: { id: 's-draw', force: true } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.doc.banks[0].title, 'Renamed');
  assert.deepEqual(r.doc.quizzes[0].questions, ['s-q'], 'force removed the quiz entry of the draw');
  assert.match(fails(r.doc, [{ cmd: 'bank.remove', args: { id: 'bk-1' } }]).message, /still has 5 slide/);
  const gone = applyAll(r.doc, [{ cmd: 'bank.remove', args: { id: 'bk-1', force: true } }]);
  assert.ok(gone.ok);
  assert.deepEqual([gone.doc.banks, gone.doc.slides.map((s) => s.id)], [[], ['s-intro', 's-q', 's-end']]);
  assert.equal(fails(d, [{ cmd: 'slide.add', args: { bank: 'bk-x' } }]).hint, 'banks: bk-1; add one with bank.add');
  assert.match(fails(d, [{ cmd: 'slide.add', args: { bank: 'bk-1', scene: 'sc-1' } }]).message, /scene or bank, not both/);
});

test('slide.move into and out of a bank; guards for quiz entries and always/never', () => {
  const d = course({ always: ['s-b2'] });
  assert.match(fails(d, [{ cmd: 'slide.move', args: { id: 's-q', bank: 'bk-1' } }]).message, /question of quiz qz/);
  assert.match(fails(d, [{ cmd: 'slide.move', args: { id: 's-draw', bank: 'bk-1' } }]).message, /is a draw slide/);
  assert.match(fails(d, [{ cmd: 'slide.move', args: { id: 's-b2', scene: 'sc-1' } }]).message, /always\/never of draw s-draw/);
  let r = applyAll(d, [{ cmd: 'slide.move', args: { id: 's-intro', bank: 'bk-1', index: 0 } }, { cmd: 'slide.move', args: { id: 's-b1', scene: 'sc-1', index: 0 } }, { cmd: 'slide.move', args: { id: 's-b5', index: 1 } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.doc.banks[0].slides, ['s-intro', 's-b5', 's-b2', 's-b3', 's-b4'], 'index alone reorders within the bank');
  assert.equal(r.doc.scenes[0].slides[0], 's-b1', 'out of the bank into a scene');
  r = applyAll(d, [{ cmd: 'slide.duplicate', args: { id: 's-b3', newId: 's-b3c' } }]);
  assert.deepEqual(r.doc.banks[0].slides, ['s-b1', 's-b2', 's-b3', 's-b3c', 's-b4', 's-b5'], 'a copy stays in the bank');
  assert.match(fails(d, [{ cmd: 'slide.remove', args: { id: 's-b2' } }]).hint, /\/draw\/always\/0/);
  r = applyAll(d, [{ cmd: 'slide.remove', args: { id: 's-b2', force: true } }]);
  assert.deepEqual(r.doc.slides.find((s) => s.id === 's-draw').draw.always, []);
});

test('draw.add and draw.set; describe shows banks and draws', () => {
  const d = course();
  assert.match(fails(d, [{ cmd: 'draw.add', args: { bank: 'bk-x' } }]).hint, /banks: bk-1/);
  assert.match(fails(d, [{ cmd: 'draw.set', args: { id: 's-q', count: 2 } }]).message, /not a draw slide/);
  assert.match(fails(d, [{ cmd: 'draw.set', args: { id: 's-draw', count: 1, always: ['s-b1', 's-b2'] } }]).message, /always lists 2 slides but count is 1/);
  const r = applyAll(d, [
    { cmd: 'draw.set', args: { id: 's-draw', count: 0, shuffle: false, always: ['s-b1'], never: ['s-b5'], title: 'Check' } },
    { cmd: 'bank.add', args: { id: 'bk-2', title: 'Second' } },
    { cmd: 'slide.add', args: { id: 's-c1', bank: 'bk-2', question: mc('c') } },
    { cmd: 'draw.add', args: { id: 's-draw2', bank: 'bk-2', scene: 'sc-1', index: 1 } },
  ]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const text = describe(r.doc);
  assert.match(text, /draw s-draw "Check" bank=bk-1 count=all bank order always=s-b1 never=s-b5/);
  assert.match(text, /draw s-draw2 "Draw from Second" bank=bk-2 count=all shuffled/);
  assert.match(text, /bank bk-2 "Second"\n {2}slide s-c1/);
  const moved = applyAll(r.doc, [{ cmd: 'draw.set', args: { id: 's-draw', bank: 'bk-2' } }]);
  assert.ok(moved.ok, 'changing the bank clears always/never');
  assert.deepEqual(moved.doc.slides.find((s) => s.id === 's-draw').draw, { bank: 'bk-2', count: 0, shuffle: false, always: [], never: [] });
  assert.equal(play(r.doc, [{ type: 'next' }], { rng: seededRng(1) }).slide, 's-c1');
});
