// scenario block: validation, registry (default, refs, import, describe, a11y), branching runtime, completion and
// gates, snapshot/restore hardening, deterministic replay through the ESM runtime and the published bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { emptyCourse, validate, serialize, parse, normalize } from '../../packages/schema/index.js';
import { applyAll, describe, query } from '../../packages/core/index.js';
import { createRuntime, play, seededRng } from '../../packages/runtime/index.js';
import { runtimeBundle } from '../../packages/publisher/bundle.js';

const ok = (r) => { assert.ok(r.ok, JSON.stringify(r.errors, null, 1)); return r.doc; };
const SCEN = {
  id: 'b-sc', type: 'scenario', ending: 'You handled the spill.',
  scenes: [
    { id: 'sc-door', title: 'At the door (authors only)', background: 'a-bg', character: 'a-sam', characterAlt: 'Sam, the lab manager', items: [
      { id: 'i-hello', kind: 'dialogue', text: 'A beaker just broke. What do you do first?', responses: [
        { id: 'a', text: 'Warn people nearby', feedback: 'Good: people first.', goTo: 'i-kit' },
        { id: 'b', text: 'Mop it up with paper towels', feedback: 'Not yet: protect yourself first.', goTo: 'retry' },
        { id: 'c', text: 'Walk to the bench', goTo: 'sc-bench' }] },
      { id: 'i-kit', kind: 'text', text: 'You fetch the spill kit.' }] },
    { id: 'sc-bench', title: 'At the bench', items: [
      { id: 'i-clean', kind: 'dialogue', text: 'How do you clean it up?', responses: [
        { id: 'a', text: 'Absorbent pads, then the waste bin', goTo: 'end' },
        { id: 'b', text: 'Back to the door', goTo: 'sc-door' }] }] },
  ],
};
function course(scen = SCEN) {
  return ok(applyAll(emptyCourse({ id: 'scn', title: 'Scenario', mode: 'lessons' }), [
    { cmd: 'asset.add', args: { id: 'a-bg', path: 'assets/bench.svg' } },
    { cmd: 'asset.add', args: { id: 'a-sam', path: 'assets/sam.svg' } },
    { cmd: 'section.add', args: { id: 'sec', title: 'One' } },
    { cmd: 'lesson.add', args: { id: 'l-a', title: 'Spill', blocks: [
      { id: 'b-h', type: 'heading', text: 'A spill' }, scen, { id: 'g-1', type: 'continue', require: 'above' }, { id: 'b-after', type: 'text', text: 'Well done.' }] } },
  ]));
}
const run = (events, doc = course()) => { const rt = createRuntime(doc, { rng: seededRng(5) }); rt.start(); rt.dispatch({ type: 'next' }); for (const e of events) rt.dispatch(e); return rt; };
const viewOf = (rt) => rt.view().lesson.blocks.find((b) => b.id === 'b-sc');
const R = (response) => ({ type: 'respond', block: 'b-sc', response });
const C = { type: 'continue', block: 'b-sc' };

// ---------------- schema and registry ----------------
test('scenario: block.add with no fields is a valid starter; round trip; describe counts; a gate can require it', () => {
  const doc = ok(applyAll(emptyCourse({ mode: 'lessons' }), [
    { cmd: 'section.add', args: { id: 's' } }, { cmd: 'lesson.add', args: { id: 'l' } },
    { cmd: 'block.add', args: { lesson: 'l', id: 'b-x', type: 'scenario' } },
    { cmd: 'block.add', args: { lesson: 'l', type: 'continue', require: 'above' } },
  ]));
  const b = doc.sections[0].lessons[0].blocks[0];
  assert.equal(b.scenes[0].items[0].kind, 'dialogue');
  assert.deepEqual(validate(doc), []);
  const text = serialize(doc);
  assert.equal(serialize(parse(text)), text);
  assert.match(describe(course()), /b-sc scenario 2 scenes 3 items\n/);
  const rt = createRuntime(doc); rt.start(); rt.dispatch({ type: 'next' });
  rt.dispatch({ type: 'respond', block: 'b-x', response: 'a' }); rt.dispatch({ type: 'continue', block: 'b-x' });
  assert.ok(rt.trace.includes('complete b-x'), 'the starter reaches its end');
});

const at = (d) => d.sections[0].lessons[0].blocks[1];
for (const [label, mutate, code, where] of [
  ['scene and item share an id', (b) => { b.scenes[1].items[0].id = 'sc-door'; }, 'dupe', '/scenes/1/items/0/id'],
  ['reserved id', (b) => { b.scenes[0].items[1].id = 'end'; }, 'semantic', '/scenes/0/items/1/id'],
  ['goTo to nowhere', (b) => { b.scenes[0].items[0].responses[0].goTo = 'i-nope'; }, 'ref', '/scenes/0/items/0/responses/0/goTo'],
  ['dialogue without responses', (b) => { delete b.scenes[0].items[0].responses; }, 'required', '/scenes/0/items/0/responses'],
  ['four responses', (b) => { b.scenes[0].items[0].responses.push({ id: 'd', text: 'x' }); }, 'range', '/scenes/0/items/0/responses'],
  ['text item with responses', (b) => { b.scenes[0].items[1].responses = [{ id: 'a', text: 'x' }]; }, 'semantic', '/scenes/0/items/1/responses'],
  ['goTo on a dialogue item', (b) => { b.scenes[0].items[0].goTo = 'end'; }, 'semantic', '/scenes/0/items/0/goTo'],
  ['response id repeated', (b) => { b.scenes[0].items[0].responses[1].id = 'a'; }, 'dupe', '/scenes/0/items/0/responses/1/id'],
  ['unknown asset', (b) => { b.scenes[1].character = 'a-ghost'; }, 'ref', '/scenes/1/character'],
  ['no scenes', (b) => { b.scenes = []; }, 'range', '/scenes'],
  ['a scene without items', (b) => { b.scenes[1].items = []; }, 'range', '/scenes/1/items'],
  ['no path reaches the end', (b) => { b.scenes[1].items[0].responses.forEach((r) => { r.goTo = 'retry'; }); }, 'semantic', '/scenes'],
]) {
  test(`scenario validation: ${label} -> ${code}`, () => {
    const d = structuredClone(course());
    mutate(at(d));
    const errs = validate(d);
    const hit = errs.find((e) => e.code === code && e.path === '/sections/0/lessons/0/blocks/1' + where);
    assert.ok(hit, JSON.stringify(errs, null, 1));
    if (code !== 'range') assert.ok(hit.hint, 'actionable hint');
  });
}

test('scenario assets: asset.remove is refused while a scene uses it; force drops the image and its alt; import remaps', () => {
  const doc = course();
  const r = applyAll(doc, [{ cmd: 'asset.remove', args: { id: 'a-sam' } }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].hint, /scenes\/0\/character/);
  const forced = ok(applyAll(doc, [{ cmd: 'asset.remove', args: { id: 'a-sam', force: true } }]));
  const scene = at(forced).scenes[0];
  assert.equal(scene.character, undefined);
  assert.equal(scene.characterAlt, undefined);
  const pkg = query(doc, 'lesson.export', { id: 'l-a' }).data;
  assert.deepEqual(pkg.assets.map((a) => a.id).sort(), ['a-bg', 'a-sam']);
  const other = ok(applyAll(emptyCourse({ mode: 'lessons' }), [
    { cmd: 'asset.add', args: { id: 'a-sam', path: 'assets/other.png' } }, { cmd: 'section.add', args: { id: 's' } },
    { cmd: 'lesson.import', args: { data: pkg, section: 's' } }]));
  const imported = other.sections[0].lessons[0].blocks[1].scenes[0];
  const sam = other.assets.find((a) => a.path === 'assets/sam.svg');
  assert.equal(imported.character, sam.id);
  assert.notEqual(sam.id, 'a-sam', 'the colliding id was remapped');
  assert.deepEqual(validate(other), []);
});

test('scenario a11y: a character image without alt text is an error', () => {
  const d = structuredClone(course());
  delete at(d).scenes[0].characterAlt;
  const issues = query(d, 'a11y').data.filter((x) => x.code === 'alt-missing');
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /scenario b-sc/);
  assert.equal(query(course(), 'a11y').data.filter((x) => x.code === 'alt-missing').length, 0);
});

// ---------------- runtime ----------------
test('scenario runtime: feedback before the move; retry restarts the scene; item, next-into-scene, scene targets; end completes', () => {
  const rt = run([R('b')]);
  let v = viewOf(rt);
  assert.deepEqual(v.feedback, { response: 'b', text: 'Mop it up with paper towels', feedback: 'Not yet: protect yourself first.', last: false });
  assert.equal(v.item.id, 'i-hello');
  rt.dispatch(R('a')); // ignored while feedback shows
  assert.ok(rt.trace.includes('warn b-sc is not waiting for a response'));
  rt.dispatch(C);
  v = viewOf(rt);
  assert.equal(v.item.id, 'i-hello', 'retry restarts the scene');
  assert.equal(v.feedback, null);
  rt.dispatch(R('a')); rt.dispatch(C);
  v = viewOf(rt);
  assert.deepEqual([v.scene, v.item.id, v.item.kind, v.item.responses], ['sc-door', 'i-kit', 'text', []]);
  rt.dispatch(R('a'));
  assert.ok(rt.trace.at(-1).startsWith('warn b-sc is not waiting'), 'a text item takes no response');
  rt.dispatch(C); // missing goTo = next: the first item of the next scene
  v = viewOf(rt);
  assert.deepEqual([v.scene, v.item.id], ['sc-bench', 'i-clean']);
  assert.equal(v.background, null, 'the second scene has no images');
  rt.dispatch(R('b')); // no feedback: moves at once, to a scene
  assert.deepEqual([viewOf(rt).scene, viewOf(rt).item.id], ['sc-door', 'i-hello']);
  rt.dispatch(R('c'));
  assert.equal(viewOf(rt).item.id, 'i-clean');
  assert.equal(viewOf(rt).done, false);
  rt.dispatch({ type: 'continue', block: 'g-1' });
  assert.ok(rt.trace.includes('gate g-1 blocked b-sc'), 'the gate waits for the scenario');
  rt.dispatch(R('a'));
  v = viewOf(rt);
  assert.deepEqual([v.ended, v.done, v.ending], [true, true, 'You handled the spill.']);
  assert.deepEqual(rt.trace.filter((t) => t.includes('b-sc') && !t.startsWith('warn') && !t.startsWith('gate')), [
    'respond b-sc b', 'scenario b-sc i-hello', 'respond b-sc a', 'scenario b-sc i-kit', 'scenario b-sc i-clean',
    'respond b-sc b', 'scenario b-sc i-hello', 'respond b-sc c', 'scenario b-sc i-clean', 'respond b-sc a', 'scenario b-sc end', 'complete b-sc',
  ]);
  rt.dispatch({ type: 'continue', block: 'g-1' });
  assert.ok(rt.trace.includes('gate g-1 passed'));
  rt.dispatch(C);
  assert.equal(rt.trace.at(-1), 'warn b-sc is at its end');
  rt.dispatch({ type: 'retry', block: 'b-sc' }); // Start over
  v = viewOf(rt);
  assert.deepEqual([v.item.id, v.ended, v.done], ['i-hello', false, true], 'starting over keeps the block complete');
  rt.dispatch({ type: 'retry', block: 'b-sc' });
  assert.equal(rt.trace.at(-1), 'warn b-sc cannot be retried', 'start over only at the end');
  rt.dispatch({ type: 'respond', block: 'b-h', response: 'a' });
  assert.equal(rt.trace.at(-1), 'warn b-h is not a scenario');
  rt.dispatch(R('z'));
  assert.equal(rt.trace.at(-1), 'warn b-sc has no response z');
});

test('scenario view shows the current step only: images with alt, no goTo graph, no scene titles; last steps say so', () => {
  const rt = run([]);
  const v = viewOf(rt);
  const text = JSON.stringify(v);
  assert.equal(v.scenes, undefined);
  assert.ok(!text.includes('goTo') && !text.includes('authors only') && !text.includes('i-kit'), text);
  assert.deepEqual(v.character, { src: 'assets/sam.svg', alt: 'Sam, the lab manager' });
  assert.deepEqual(v.background, { src: 'assets/bench.svg', alt: '' }, 'a background without alt is decorative');
  rt.dispatch(R('c')); rt.dispatch(R('a'));
  assert.equal(viewOf(rt).ended, true);
  const fb = run([R('c')]);
  assert.equal(viewOf(fb).feedback, null);
  const textEnd = course({ id: 'b-sc', type: 'scenario', scenes: [{ id: 's', items: [{ id: 't', kind: 'text', text: 'Bye', goTo: 'end' }] }] });
  const rt2 = run([], textEnd);
  assert.equal(viewOf(rt2).item.last, true, 'the player labels this step Finish');
});

test('scenario snapshot/restore: mid-way state resumes; tampered data is dropped or repaired', () => {
  const rt = run([R('a'), C, C, R('b')]); // at i-hello again, then...
  rt.dispatch(R('b')); // feedback showing
  const snap = rt.snapshot();
  assert.ok(JSON.stringify(snap).length < 600);
  const back = createRuntime(course(), { rng: seededRng(5) }).restore(JSON.parse(JSON.stringify(snap)));
  assert.deepEqual(viewOf(back), viewOf(rt));
  const bad = structuredClone(snap);
  Object.assign(bad.blocks['b-sc'], { item: 'i-kit', fb: 'a', ended: 'yes', done: 1 });
  const r2 = createRuntime(course()).restore(bad);
  const s = r2.state.blocks['b-sc'];
  assert.deepEqual([s.item, s.fb, s.ended, s.done], ['i-kit', null, false, false], 'feedback must belong to the current item');
  const r3 = createRuntime(course()).restore({ ...snap, blocks: { 'b-sc': { item: { toString: 1 }, fb: 'a', ended: true } } });
  const s3 = r3.state.blocks['b-sc'];
  assert.deepEqual([s3.item, s3.fb, s3.ended, s3.done], ['i-hello', null, true, true], 'an ended scenario is complete');
  const long = run(Array.from({ length: 30 }, () => [R('b'), C]).flat());
  assert.ok(JSON.stringify(long.snapshot()).length < 600, 'a long scenario run keeps the resume snapshot small');
});

test('scenario replay is deterministic, and the published bundle replays it exactly', () => {
  const ev = [{ type: 'start' }, { type: 'next' }, R('b'), C, R('a'), C, C, R('b'), R('c'), R('a'), { type: 'continue', block: 'g-1' }, { type: 'retry', block: 'b-sc' }, { type: 'end' }];
  const doc = normalize(course());
  const a = play(doc, ev, { rng: seededRng(9) });
  const b = play(doc, ev, { rng: seededRng(9) });
  assert.deepEqual(a.trace, b.trace);
  const win = {};
  vm.runInNewContext(runtimeBundle(), { window: win, structuredClone });
  const bundled = win.CFRuntime.play(doc, ev, { rng: win.CFRuntime.seededRng(9) });
  assert.deepEqual(JSON.parse(JSON.stringify(bundled.trace)), a.trace);
  assert.ok(a.trace.includes('complete b-sc') && a.trace.includes('gate g-1 passed') && a.trace.includes('lesson l-a complete'));
});
