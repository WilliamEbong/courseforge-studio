import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse, validate, serialize, parse, normalize, jsonSchema } from '../../packages/schema/index.js';
import { apply, applyAll, describe, query, commands } from '../../packages/core/index.js';
import { createRuntime, play, seededRng } from '../../packages/runtime/index.js';

const ctx = () => ({ rng: seededRng(42) });
const base = () => {
  const r = applyAll(emptyCourse({ title: 'T' }), [
    { cmd: 'var.add', args: { name: 'score', type: 'number' } },
    { cmd: 'var.add', args: { name: 'name', type: 'text', initial: 'Ana' } },
    { cmd: 'slide.add', args: { id: 's-a', title: 'A', objects: [{ id: 'o-btn', type: 'button', text: 'Go' }, { id: 'o-txt', type: 'text', text: 'Hi %name%, score %score%' }] } },
    { cmd: 'slide.add', args: { id: 's-b', title: 'B' } },
    { cmd: 'layer.add', args: { slide: 's-a', id: 'l-pop', title: 'Pop' } },
    { cmd: 'trigger.add', args: { slide: 's-a', id: 't-go', on: { event: 'click', target: 'o-btn' }, do: [{ action: 'setVar', var: 'score', op: 'add', value: 5 }, { action: 'jump', to: 's-b' }] } },
  ], ctx());
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.doc;
};
const errCodes = (r) => r.errors.map((e) => `${e.code}:${e.path}`);

// ---------------- schema ----------------
test('empty course is valid and serializes compactly and stably', () => {
  const d = emptyCourse({ title: 'X' });
  assert.deepEqual(validate(d), []);
  const text = serialize(d);
  assert.ok(!text.includes('"player"'), 'defaults omitted');
  assert.equal(serialize(parse(text)), text, 'idempotent round trip');
});
test('serialize is canonical regardless of key order', () => {
  const a = base();
  const shuffled = JSON.parse(JSON.stringify(a), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
  assert.equal(serialize(shuffled), serialize(a));
});
for (const [label, mutate, code] of [
  ['wrong schema tag', (d) => { d.schema = 'x'; }, 'enum'],
  ['bad id pattern', (d) => { d.slides[0].id = 'Bad Id'; }, 'pattern'],
  ['duplicate id', (d) => { d.slides[1].id = 's-a'; }, 'dupe'],
  ['unknown property', (d) => { d.slides[0].colour = 'red'; }, 'unknown'],
  ['slide not in a scene', (d) => { d.scenes[0].slides.pop(); }, 'semantic'],
  ['scene refs missing slide', (d) => { d.scenes[0].slides.push('s-zz'); }, 'ref'],
  ['trigger target missing', (d) => { d.slides[0].triggers[0].on.target = 'o-zz'; }, 'ref'],
  ['jump target missing', (d) => { d.slides[0].triggers[0].do[1].to = 's-zz'; }, 'ref'],
  ['undefined variable', (d) => { d.slides[0].triggers[0].do[0].var = 'nope'; }, 'ref'],
  ['add on text variable', (d) => { d.slides[0].triggers[0].do[0].var = 'name'; }, 'semantic'],
  ['toggle on number', (d) => { d.slides[0].triggers[0].do[0].op = 'toggle'; }, 'semantic'],
  ['set wrong type', (d) => { Object.assign(d.slides[0].triggers[0].do[0], { op: 'set', value: 'x' }); }, 'type'],
  ['initial value wrong type', (d) => { d.variables[0].initial = 'zero'; }, 'type'],
  ['unknown event', (d) => { d.slides[0].triggers[0].on.event = 'clik'; }, 'enum'],
  ['unknown action', (d) => { d.slides[0].triggers[0].do[0].action = 'teleport'; }, 'enum'],
  ['showLayer missing layer', (d) => { d.slides[0].triggers[0].do.push({ action: 'showLayer', layer: 'l-zz' }); }, 'ref'],
  ['hideLayer outside layer without id', (d) => { d.slides[0].triggers[0].do.push({ action: 'hideLayer' }); }, 'required'],
  ['mc with two correct', (d) => { d.slides[1].question = { type: 'mc', prompt: 'p', choices: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B', correct: true }] }; }, 'semantic'],
  ['fill without answers', (d) => { d.slides[1].question = { type: 'fill', prompt: 'p' }; }, 'semantic'],
  ['image object without asset', (d) => { d.slides[0].objects.push({ id: 'o-img', type: 'image' }); }, 'required'],
  ['end before start', (d) => { Object.assign(d.slides[0].objects[0], { start: 2000, end: 1000 }); }, 'range'],
  ['submit on non-question slide', (d) => { d.slides[0].triggers[0].do.push({ action: 'submit' }); }, 'semantic'],
  ['quiz references non-question slide', (d) => { d.quizzes.push({ id: 'qz-x', questions: ['s-b'] }); }, 'semantic'],
  ['openUrl javascript: blocked', (d) => { d.slides[0].triggers[0].do.push({ action: 'openUrl', url: 'javascript:alert(1)' }); }, 'pattern'],
  ['input bound to number var', (d) => { d.slides[0].objects.push({ id: 'o-in', type: 'input', var: 'score' }); }, 'type'],
]) {
  test(`validate rejects: ${label}`, () => {
    const d = structuredClone(base());
    mutate(d);
    const errs = validate(d);
    assert.ok(errs.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(errs)}`);
    assert.ok(errs.every((e) => e.path.startsWith('/')), 'paths are JSON pointers');
  });
}
test('jsonSchema is exported for agents', () => {
  const s = jsonSchema();
  assert.equal(s.type, 'object');
  assert.ok(s.properties.slides.items.properties.triggers.items.properties.on.oneOf.length >= 10);
});

// ---------------- commands ----------------
test('apply is pure and returns an inverse that restores the document', () => {
  const d = base();
  const before = serialize(d);
  const r = apply(d, { cmd: 'object.set', args: { id: 'o-btn', x: 300, style: { fill: '#000000' } } });
  assert.ok(r.ok);
  assert.equal(serialize(d), before, 'input untouched');
  assert.equal(r.doc.slides[0].objects[0].x, 300);
  assert.equal(serialize(apply(r.doc, r.inverse).doc), before);
});
test('applyAll is atomic and reports the failing index', () => {
  const d = base();
  const r = applyAll(d, [{ cmd: 'slide.add', args: { id: 's-c' } }, { cmd: 'object.add', args: { slide: 's-zz', type: 'text' } }]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].index, 1);
  assert.match(r.errors[0].hint, /s-a, s-b/);
});
test('unknown command and bad args give actionable errors', () => {
  assert.match(apply(base(), { cmd: 'slide.ad' }).errors[0].hint, /slide\.add/);
  const r = apply(base(), { cmd: 'slide.set', args: { id: 's-a', advance: 'later' } });
  assert.deepEqual(errCodes(r), ['enum:/args/advance']);
});
test('remove guards references unless force', () => {
  const d = base();
  assert.equal(apply(d, { cmd: 'slide.remove', args: { id: 's-b' } }).errors[0].code, 'ref');
  const r = apply(d, { cmd: 'slide.remove', args: { id: 's-b', force: true } });
  assert.ok(r.ok);
  assert.equal(r.doc.slides[0].triggers.length, 0, 'trigger that jumped to s-b removed');
  assert.equal(apply(d, { cmd: 'object.remove', args: { id: 'o-btn' } }).errors[0].code, 'ref');
  assert.equal(apply(d, { cmd: 'var.remove', args: { name: 'score' } }).errors[0].code, 'ref');
});
test('var rename updates triggers and %interpolation%', () => {
  const r = apply(base(), { cmd: 'var.set', args: { name: 'score', newName: 'points' } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.doc.slides[0].triggers[0].do[0].var, 'points');
  assert.match(r.doc.slides[0].objects[1].text, /%points%/);
});
test('slide.duplicate re-ids inner objects and remaps references', () => {
  const r = apply(base(), { cmd: 'slide.duplicate', args: { id: 's-a', newId: 's-a2' } }, ctx());
  assert.ok(r.ok, JSON.stringify(r.errors));
  const copy = r.doc.slides.find((s) => s.id === 's-a2');
  assert.notEqual(copy.objects[0].id, 'o-btn');
  assert.equal(copy.triggers[0].on.target, copy.objects[0].id);
  assert.deepEqual(r.doc.scenes[0].slides, ['s-a', 's-a2', 's-b']);
});
test('object.move changes z-order and container', () => {
  let r = apply(base(), { cmd: 'object.move', args: { id: 'o-txt', index: 0 } });
  assert.deepEqual(r.doc.slides[0].objects.map((o) => o.id), ['o-txt', 'o-btn']);
  r = apply(r.doc, { cmd: 'object.move', args: { id: 'o-txt', layer: 'l-pop' } });
  assert.equal(r.doc.slides[0].layers[0].objects[0].id, 'o-txt');
});
test('generated ids are deterministic with a seeded rng and never collide', () => {
  const a = apply(base(), { cmd: 'slide.add', args: {} }, ctx());
  const b = apply(base(), { cmd: 'slide.add', args: {} }, ctx());
  assert.equal(a.result.id, b.result.id);
  assert.match(a.result.id, /^s-[0-9a-f]{12}$/);
});
test('every command has a summary, args schema and runnable examples on a rich doc', () => {
  for (const c of Object.values(commands)) {
    assert.ok(c.summary && c.args && Array.isArray(c.examples), c.name);
    assert.ok(query(base(), 'commands.help', { name: c.name }).ok);
  }
});
test('describe is compact and mentions triggers in sentence form', () => {
  const text = describe(base());
  assert.match(text, /t-go: click o-btn → score \+= 5; jump s-b/);
  assert.ok(text.length < 800);
});
test('queries: find, slide.get, validate, unknown', () => {
  assert.equal(query(base(), 'find', { text: 'go' }).data[0].id, 'o-btn');
  assert.equal(query(base(), 'slide.get', { id: 's-b' }).data.title, 'B');
  assert.deepEqual(query(base(), 'validate').data, []);
  assert.equal(query(base(), 'nope').ok, false);
});

// ---------------- runtime ----------------
test('runtime: click, variable math, interpolation, jump', () => {
  const rt = createRuntime(base());
  rt.start();
  const txt = rt.view().objects.find((o) => o.id === 'o-txt');
  assert.equal(txt.text, 'Hi Ana, score 0');
  rt.dispatch({ type: 'click', target: 'o-btn' });
  assert.equal(rt.state.vars.score, 5);
  assert.equal(rt.state.slide, 's-b');
  assert.deepEqual(rt.view().nav, { prev: true, next: false, submit: false });
});
test('runtime: timeline cues, object start/end visibility, timelineEnd, auto-advance', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'var.add', args: { name: 'hits', type: 'number' } },
    { cmd: 'slide.add', args: { id: 's-1', duration: 3000, advance: 'auto', objects: [{ id: 'o-late', type: 'text', text: 'late', start: 1000, end: 2000 }] } },
    { cmd: 'slide.add', args: { id: 's-2' } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'timeAt', ms: 1500 }, do: [{ action: 'setVar', var: 'hits', op: 'add', value: 1 }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'timelineEnd' }, do: [{ action: 'setVar', var: 'hits', op: 'add', value: 10 }] } },
  ]);
  const rt = createRuntime(r.doc);
  rt.start();
  const vis = () => rt.view().objects[0].visible;
  assert.equal(vis(), false);
  rt.tick(1200); assert.equal(vis(), true); assert.equal(rt.state.vars.hits, 0);
  rt.tick(400); assert.equal(rt.state.vars.hits, 1);
  rt.tick(500); assert.equal(vis(), false);
  rt.tick(5000); assert.equal(rt.state.vars.hits, 11); assert.equal(rt.state.slide, 's-2');
});
test('runtime: modal layer blocks base clicks; pauseBase pauses base clock; hideOnEnd hides layer', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'var.add', args: { name: 'n', type: 'number' } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-base', type: 'button' }, { id: 'o-open', type: 'button' }] } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-m', modal: true, pauseBase: true, hideOnEnd: true, duration: 1000, objects: [{ id: 'o-close', type: 'button' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-base' }, do: [{ action: 'setVar', var: 'n', op: 'add', value: 1 }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-open' }, do: [{ action: 'showLayer', layer: 'l-m' }] } },
  ]);
  const rt = createRuntime(r.doc);
  rt.start();
  rt.tick(500);
  rt.dispatch({ type: 'click', target: 'o-open' });
  rt.dispatch({ type: 'click', target: 'o-base' });
  assert.equal(rt.state.vars.n, 0, 'modal blocks base');
  rt.tick(600);
  assert.equal(rt.state.clock['#base'], 500, 'base paused while layer visible');
  assert.deepEqual(rt.state.layers, ['l-m']);
  rt.tick(500);
  assert.deepEqual(rt.state.layers, [], 'hideOnEnd');
  assert.equal(rt.state.clock['#base'], 600, 'base resumes for the rest of the tick');
  rt.dispatch({ type: 'click', target: 'o-base' });
  assert.equal(rt.state.vars.n, 1);
});
test('runtime: playerNext override, menu navigation, input binding, key event, exit', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'var.add', args: { name: 'who', type: 'text' } },
    { cmd: 'var.add', args: { name: 'k', type: 'boolean' } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-in', type: 'input', var: 'who' }] } },
    { cmd: 'slide.add', args: { id: 's-2' } },
    { cmd: 'slide.add', args: { id: 's-3' } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'playerNext' }, do: [{ action: 'jump', to: 's-3' }] } },
    { cmd: 'trigger.add', args: { slide: 's-3', on: { event: 'key', key: 'k' }, do: [{ action: 'setVar', var: 'k', op: 'toggle' }, { action: 'exitCourse' }] } },
  ]);
  const out = play(r.doc, [{ type: 'input', target: 'o-in', text: 'Bo' }, { type: 'next' }, { type: 'key', key: 'K' }, { type: 'menu', slide: 's-2' }]);
  assert.equal(out.vars.who, 'Bo');
  assert.equal(out.vars.k, true);
  assert.equal(out.slide, 's-3', 'exit stops further navigation');
  assert.ok(out.trace.includes('exit'));
});
test('runtime: slidesViewed tracking reports completed once; snapshot/restore resumes position and vars', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'var.add', args: { name: 'n', type: 'number' } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-b', type: 'button' }] } },
    { cmd: 'slide.add', args: { id: 's-2' } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'setVar', var: 'n', op: 'set', value: 7 }] } },
  ]);
  const statuses = [];
  let saved = null;
  const lms = { init: () => saved, status: (s) => statuses.push(s), score: () => {}, interaction: () => {}, save: (s) => { saved = s; }, exit: () => {} };
  const rt = createRuntime(r.doc, { lms });
  rt.start();
  rt.dispatch({ type: 'click', target: 'o-b' }).dispatch({ type: 'next' }).dispatch({ type: 'prev' }).dispatch({ type: 'next' });
  assert.deepEqual(statuses, ['completed']);
  const rt2 = createRuntime(r.doc, { lms });
  rt2.start({ resume: 'always' });
  assert.equal(rt2.state.slide, 's-2');
  assert.equal(rt2.state.vars.n, 7);
  assert.deepEqual(rt2.state.history, ['s-1']);
});
test('runtime: deterministic replay (same events, same trace)', () => {
  const ev = [{ type: 'click', target: 'o-btn' }, { type: 'prev' }, { type: 'tick', ms: 6000 }];
  assert.deepEqual(play(base(), ev, { rng: seededRng(9) }).trace, play(base(), ev, { rng: seededRng(9) }).trace);
});
test('runtime: varChange recursion is capped', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'var.add', args: { name: 'x', type: 'number' } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-b', type: 'button' }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'varChange', var: 'x' }, do: [{ action: 'setVar', var: 'x', op: 'add', value: 1 }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'setVar', var: 'x', op: 'add', value: 1 }] } },
  ]);
  const out = play(r.doc, [{ type: 'click', target: 'o-b' }]);
  assert.ok(out.trace.some((l) => l.startsWith('warn depth limit')));
  assert.ok(out.vars.x > 1 && out.vars.x <= 40);
});

test('quiz.addResults builds a working results slide in one command', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'slide.add', args: { id: 's-q1', question: { type: 'tf', prompt: 'Sky is blue?', choices: [{ id: 't', label: 'True', correct: true }, { id: 'f', label: 'False' }] } } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q1'], passPercent: 100 } },
    { cmd: 'quiz.addResults', args: { quiz: 'qz', id: 's-res', track: true } },
  ]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const fail = play(r.doc, [{ type: 'choose', choice: 'f' }, { type: 'submit' }, { type: 'continue' }]);
  assert.equal(fail.slide, 's-res'); assert.equal(fail.status, 'failed'); assert.deepEqual(fail.layers, ['s-res-fail']);
  assert.match(fail.view.objects.find((o) => o.id === 's-res-score').text, /Your score: 0%/);
  const retry = play(r.doc, [{ type: 'choose', choice: 'f' }, { type: 'submit' }, { type: 'continue' }, { type: 'click', target: 's-res-retry' }, { type: 'choose', choice: 't' }, { type: 'submit' }, { type: 'continue' }]);
  assert.equal(retry.status, 'passed'); assert.deepEqual(retry.layers, ['s-res-pass']);
});

test('a11y query flags missing names/alt/labels, low contrast and duplicate tab order, with fix commands', async () => {
  const { contrast } = await import('../../packages/core/a11y.js');
  assert.equal(contrast('#000000', '#ffffff'), 21);
  const r = applyAll(emptyCourse(), [
    { cmd: 'asset.add', args: { id: 'a-1', path: 'assets/x.png' } },
    { cmd: 'slide.add', args: { id: 's-1', title: 'One', objects: [
      { id: 'o-img', type: 'image', image: 'a-1' }, { id: 'o-hot', type: 'hotspot' }, { id: 'o-in', type: 'input' },
      { id: 'o-t', type: 'text', text: 'faint', style: { color: '#cccccc', fontSize: 14 } },
      { id: 'o-b1', type: 'button', text: 'A', tabIndex: 1 }, { id: 'o-b2', type: 'button', text: 'B', tabIndex: 1 }] } },
  ]);
  const issues = query(r.doc, 'a11y').data;
  const codes = issues.map((x) => `${x.code}:${x.path.split('/').pop()}`).sort();
  assert.deepEqual(codes, ['alt-missing:0', 'contrast:3', 'label-missing:2', 'name-missing:1', 'tab-order:5']);
  assert.ok(issues.every((x) => x.fix.startsWith('object.set')));
});
