// Regression tests for the 21 findings of the Codex adversarial review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emptyCourse, validate, serialize, parse } from '../../packages/schema/index.js';
import { apply, applyAll } from '../../packages/core/index.js';
import { createRuntime, play, seededRng } from '../../packages/runtime/index.js';
import { saveCourse, history, runCommands, loadCourse } from '../../packages/cli/io.js';

const ok = (cmds, base = emptyCourse()) => { const r = applyAll(base, cmds, { rng: seededRng(5) }); assert.ok(r.ok, JSON.stringify(r.errors)); return r.doc; };
const mcq = (id, pts, correct = 'a') => ({ cmd: 'slide.add', args: { id, question: { type: 'mc', prompt: id, points: pts, shuffle: false, choices: [{ id: 'a', label: 'A', correct: correct === 'a' }, { id: 'b', label: 'B', correct: correct === 'b' }] } } });
const answer = (c) => [{ type: 'choose', choice: c }, { type: 'submit' }, { type: 'continue' }];

test('#1 exact pass boundary survives float noise (29/50 = 58%)', () => {
  const d = ok([mcq('s-q1', 29), mcq('s-q2', 21), { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q1', 's-q2'], passPercent: 58 } }, { cmd: 'quiz.addResults', args: { quiz: 'qz', id: 's-r', track: true } }]);
  const r = play(d, [...answer('a'), ...answer('a')]); // second answer wrong (correct is a... make it wrong below)
  const r2 = play(d, [...answer('a'), ...answer('b')]);
  assert.equal(r2.vars['qz.scorePercent'], 58);
  assert.equal(r2.status, 'passed');
  assert.equal(r.vars['qz.scorePercent'], 100);
});

test('#2 snapshot keeps the live current-slide state and the feedback dialog', () => {
  const d = ok([
    { cmd: 'slide.add', args: { id: 's-1', revisit: 'resume', objects: [{ id: 'o-b', type: 'button' }] } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-1' } },
    { cmd: 'state.set', args: { target: 'o-b', state: 'selected', text: 'on' } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'setState', target: 'o-b', state: 'selected' }, { action: 'showLayer', layer: 'l-1' }] } },
    mcq('s-q', 10),
  ]);
  const rt = createRuntime(d); rt.start();
  rt.dispatch({ type: 'click', target: 'o-b' }).tick(700);
  const snap = JSON.parse(JSON.stringify(rt.snapshot()));
  const rt2 = createRuntime(d); rt2.restore(snap);
  assert.equal(rt2.state.obj['o-b'].state, 'selected');
  assert.deepEqual(rt2.state.layers, ['l-1']);
  assert.equal(rt2.state.clock['#base'], 700);
  // feedback survives
  const rt3 = createRuntime(d); rt3.start(); rt3.dispatch({ type: 'menu', slide: 's-q' }).dispatch({ type: 'choose', choice: 'a' }).dispatch({ type: 'submit' });
  const rt4 = createRuntime(d); rt4.restore(JSON.parse(JSON.stringify(rt3.snapshot())));
  assert.equal(rt4.view().feedback.kind, 'correct');
});

test('#3 redo restores the exact document (generated ids stay stable)', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-r3-')), 'c.course.json');
  saveCourse(f, emptyCourse());
  const r1 = runCommands(f, [{ cmd: 'slide.add', args: {} }]);
  const sid = r1.results[0].id;
  runCommands(f, [{ cmd: 'slide.set', args: { id: sid, title: 'Edited' } }]);
  history.undo(f); history.undo(f);
  history.redo(f); const back = history.redo(f);
  assert.equal(back.slides[0].id, sid);
  assert.equal(loadCourse(f).slides[0].title, 'Edited');
});

test('#4 prototype keys are ordinary data, never global mutations', () => {
  const d = ok([{ cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o', type: 'button' }] } }]);
  const r = apply(d, { cmd: 'state.set', args: { target: 'o', state: 'constructor', text: 'injected' } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(Object.prototype.text, undefined);
  assert.equal(parse(serialize(r.doc)).slides[0].objects[0].states.constructor.text, 'injected', 'survives serialization');
  const q = ok([mcq('constructor', 10)]);
  assert.doesNotThrow(() => { const rt = createRuntime(q); rt.start(); rt.view(); });
  assert.ok(validate({ ...emptyCourse(), variables: [{ name: '__proto__', type: 'number', initial: 1 }] }).some((e) => e.code === 'pattern'));
});

test('#5 non-finite or negative ticks are rejected, not looped on', () => {
  const d = ok([{ cmd: 'slide.add', args: { id: 's-1' } }]);
  const r = play(d, [{ type: 'tick', ms: Infinity }, { type: 'tick', ms: -5 }, { type: 'tick', ms: 'x' }]);
  assert.equal(r.trace.filter((l) => l.startsWith('warn bad tick')).length, 3);
});

test('#6 a layer called "base" has its own clock', () => {
  const d = ok([
    { cmd: 'slide.add', args: { id: 's-1', duration: 1000, advance: 'auto' } }, { cmd: 'slide.add', args: { id: 's-2' } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'base', duration: 200, hideOnEnd: true } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'timelineStart' }, do: [{ action: 'showLayer', layer: 'base' }] } },
  ]);
  const rt = createRuntime(d); rt.start(); rt.tick(300);
  assert.equal(rt.state.slide, 's-1'); assert.deepEqual(rt.state.layers, []);
  rt.tick(800); assert.equal(rt.state.slide, 's-2');
});

test('#7 retry after a pass resets status and quiz variables', () => {
  // The generated Retry button now sits on the Failed layer; an author-made retry after a pass still resets.
  const d = ok([mcq('s-q1', 10), { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q1'], passPercent: 100 } }, { cmd: 'quiz.addResults', args: { quiz: 'qz', id: 's-r', track: true } },
    { cmd: 'object.add', args: { slide: 's-r', id: 'o-again', type: 'button', text: 'Again' } },
    { cmd: 'trigger.add', args: { slide: 's-r', on: { event: 'click', target: 'o-again' }, do: [{ action: 'resetQuiz', quiz: 'qz' }] } }]);
  const r = play(d, [...answer('a'), { type: 'click', target: 'o-again' }]);
  assert.equal(r.status, 'incomplete');
  assert.equal(r.vars['qz.passed'], false);
  assert.equal(r.vars['qz.scorePercent'], 0);
  assert.ok(r.lms.includes('status incomplete'));
});

test('#8 the feedback dialog blocks resubmits and slide clicks', () => {
  const d = ok([
    { cmd: 'slide.add', args: { id: 's-q', objects: [{ id: 'o-skip', type: 'button' }], question: { type: 'mc', prompt: 'p', attempts: 2, shuffle: false, choices: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B' }] } } },
    { cmd: 'slide.add', args: { id: 's-2' } },
    { cmd: 'trigger.add', args: { slide: 's-q', on: { event: 'click', target: 'o-skip' }, do: [{ action: 'jump', to: 's-2' }] } },
  ]);
  const rt = createRuntime(d); rt.start();
  rt.dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' });
  rt.dispatch({ type: 'submit' }).dispatch({ type: 'click', target: 'o-skip' });
  assert.equal(rt.state.q['s-q'].attempts, 1);
  assert.equal(rt.state.slide, 's-q');
  assert.equal(rt.view().feedback.kind, 'tryAgain');
});

test('#9 malformed or stale snapshots fall back safely', () => {
  const d = ok([mcq('s-q', 10)]);
  assert.doesNotThrow(() => createRuntime(d, { lms: { init: () => ({ v: 1 }) } }).start({ resume: 'always' }));
  const stale = { v: 1, slide: 's-q', history: 'x', viewed: [1], q: { 's-q': { order: ['a', 'zzz'], selected: ['zzz'] } } };
  const rt = createRuntime(d); assert.doesNotThrow(() => { rt.restore(stale); rt.view(); });
  assert.deepEqual(rt.view().question.choices.map((c) => c.id).sort(), ['a', 'b']);
});

test('#10 partial tracking objects get defaults instead of crashing validation', () => {
  const d = { ...emptyCourse(), tracking: { status: 'passed-failed' } };
  assert.deepEqual(validate(d), []);
});

test('#11 state references and state images are validated', () => {
  const d = ok([{ cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o', type: 'button' }] } }]);
  assert.equal(apply(d, { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o' }, do: [{ action: 'setState', target: 'o', state: 'flipped' }] } }).errors[0].code, 'ref');
  assert.equal(apply(d, { cmd: 'state.set', args: { target: 'o', state: 'selected', image: 'a-missing' } }).errors[0].code, 'ref');
  const d2 = ok([{ cmd: 'state.set', args: { target: 'o', state: 'flipped', text: 'x' } }, { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o' }, do: [{ action: 'setState', target: 'o', state: 'flipped' }] } }], d);
  assert.equal(apply(d2, { cmd: 'state.remove', args: { target: 'o', state: 'flipped' } }).ok, false, 'cannot strand a trigger');
});

test('#12 question.set merges feedback', () => {
  const d = ok([{ cmd: 'slide.add', args: { id: 's-q', question: { type: 'tf', prompt: 'p', choices: [{ id: 't', label: 'T', correct: true }, { id: 'f', label: 'F' }], feedback: { correct: 'right', incorrect: 'wrong', tryAgain: 'retry' } } } }]);
  const r = apply(d, { cmd: 'question.set', args: { slide: 's-q', feedback: { correct: 'new' } } });
  assert.deepEqual(r.doc.slides[0].question.feedback, { correct: 'new', incorrect: 'wrong', tryAgain: 'retry' });
});

test('#13 variable rename updates question text', () => {
  const d = ok([{ cmd: 'var.add', args: { name: 'n', type: 'number' } }, { cmd: 'slide.add', args: { id: 's-q', question: { type: 'mc', prompt: 'Count %n%', choices: [{ id: 'a', label: '%n% apples', correct: true }, { id: 'b', label: 'none' }] } } }]);
  const r = apply(d, { cmd: 'var.set', args: { name: 'n', newName: 'count' } });
  assert.equal(r.doc.slides[0].question.prompt, 'Count %count%');
  assert.equal(r.doc.slides[0].question.choices[0].label, '%count% apples');
});

test('#14 duplicated slides jump to themselves, not the original', () => {
  const d = ok([{ cmd: 'slide.add', args: { id: 's', objects: [{ id: 'o', type: 'button' }] } }, { cmd: 'trigger.add', args: { slide: 's', on: { event: 'click', target: 'o' }, do: [{ action: 'jump', to: 's' }] } }]);
  const r = apply(d, { cmd: 'slide.duplicate', args: { id: 's', newId: 's-copy' } }, { rng: seededRng(2) });
  assert.equal(r.doc.slides.find((x) => x.id === 's-copy').triggers[0].do[0].to, 's-copy');
});

test('#15 forced removals clean scene jumps and quiz-variable references', () => {
  const d = ok([
    { cmd: 'scene.add', args: { id: 'sc-2' } }, { cmd: 'slide.add', args: { id: 's-1', scene: 'sc-1', objects: [{ id: 'o', type: 'button' }] } },
    { cmd: 'slide.add', args: { id: 's-2', scene: 'sc-2' } }, mcq('s-q', 10),
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o' }, do: [{ action: 'jumpScene', to: 'sc-2' }] } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q'] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o' }, if: { all: [{ var: 'qz.passed', op: '==', value: true }] }, do: [{ action: 'jump', to: 'next' }] } },
  ]);
  assert.ok(apply(d, { cmd: 'scene.remove', args: { id: 'sc-2', force: true } }).ok);
  assert.ok(apply(d, { cmd: 'quiz.remove', args: { id: 'qz', force: true } }).ok);
  assert.equal(apply(d, { cmd: 'quiz.remove', args: { id: 'qz' } }).errors[0].code, 'ref');
});

test('#16 a layer hidden during a step stops firing cues', () => {
  const d = ok([
    { cmd: 'var.add', args: { name: 'n', type: 'number' } }, { cmd: 'slide.add', args: { id: 's-1' } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l', hideOthers: false } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'timelineStart' }, do: [{ action: 'showLayer', layer: 'l' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'timeAt', ms: 100 }, do: [{ action: 'hideLayer', layer: 'l' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', layer: 'l', on: { event: 'timeAt', ms: 100 }, do: [{ action: 'setVar', var: 'n', op: 'add', value: 1 }] } },
  ]);
  assert.equal(play(d, [{ type: 'tick', ms: 150 }]).vars.n, 0);
});

test('#17 results do not depend on how time is chunked', () => {
  const d = ok([
    { cmd: 'slide.add', args: { id: 's-1', duration: 1, advance: 'auto' } }, { cmd: 'slide.add', args: { id: 's-2' } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'timeAt', ms: 0.5 }, do: [{ action: 'pauseTimeline' }] } },
  ]);
  assert.equal(play(d, [{ type: 'tick', ms: 1 }]).slide, 's-1');
  assert.equal(play(d, [{ type: 'tick', ms: 0.5 }, { type: 'tick', ms: 0.5 }]).slide, 's-1');
});

test('#18 layer triggers run in document order, not show order', () => {
  const d = ok([
    { cmd: 'var.add', args: { name: 'n', type: 'number' } }, { cmd: 'slide.add', args: { id: 's-1' } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-a', hideOthers: false } }, { cmd: 'layer.add', args: { slide: 's-1', id: 'l-b', hideOthers: false } },
    { cmd: 'trigger.add', args: { slide: 's-1', layer: 'l-a', on: { event: 'key', key: 'x' }, do: [{ action: 'setVar', var: 'n', op: 'set', value: 1 }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', layer: 'l-b', on: { event: 'key', key: 'x' }, do: [{ action: 'setVar', var: 'n', op: 'set', value: 2 }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'timelineStart' }, do: [{ action: 'showLayer', layer: 'l-b' }, { action: 'showLayer', layer: 'l-a' }] } },
  ]);
  // Key presses dispatch topmost layer first: by DOCUMENT order l-b is on top, so l-b runs first and
  // l-a last (n = 1). With show order, l-a (shown last) would be on top and the result would be 2.
  assert.equal(play(d, [{ type: 'key', key: 'x' }]).vars.n, 1);
});

test('#19 showing a visible layer restarts its timeline and start handlers', () => {
  const d = ok([
    { cmd: 'var.add', args: { name: 'n', type: 'number' } }, { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o', type: 'button' }] } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l' } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o' }, do: [{ action: 'showLayer', layer: 'l' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', layer: 'l', on: { event: 'timelineStart' }, do: [{ action: 'setVar', var: 'n', op: 'add', value: 1 }] } },
  ]);
  const rt = createRuntime(d); rt.start();
  rt.dispatch({ type: 'click', target: 'o' }).tick(100);
  rt.dispatch({ type: 'click', target: 'o' });
  assert.equal(rt.state.vars.n, 2); assert.equal(rt.state.clock.l, 0);
});

test('#20 disabled objects ignore hover', () => {
  const d = ok([
    { cmd: 'var.add', args: { name: 'n', type: 'number' } }, { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o', type: 'button', initialState: 'disabled' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'hoverEnter', target: 'o' }, do: [{ action: 'setVar', var: 'n', op: 'add', value: 1 }] } },
  ]);
  assert.equal(play(d, [{ type: 'hoverEnter', target: 'o' }]).vars.n, 0);
});

test('#21 cf test honours traceIncludes and rejects unknown expectations', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-r21-'));
  const sc = path.join(dir, 's.json');
  const run = (expect) => { fs.writeFileSync(sc, JSON.stringify({ events: [], expect })); return spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/cf.js'), 'test', path.join(ROOT, 'samples/lab-safety.course.json'), sc], { encoding: 'utf8' }).status; };
  assert.equal(run({ traceIncludes: ['THIS NEVER HAPPENED'] }), 1);
  assert.equal(run({ traceIncludess: ['typo'] }), 1);
  assert.equal(run({ traceIncludes: ['enter s-welcome'] }), 0);
});
