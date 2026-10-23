// entrance and exit effects. Differential against: the entrance
// starts at the object's start; the exit is scheduled at end - duration so it ends at the object's end; visibility
// and triggers do not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse, validate } from '../../packages/schema/index.js';
import { createRuntime } from '../../packages/runtime/index.js';

// The a 3 s slide (1920x1080); text visible 1.0-2.0 s with Fade in 0.5 s and Fade out 0.25 s
// a button at y=519 visible all along with Fly In 0.75 s from the bottom.
function s035() {
  const r = applyAll(emptyCourse({ id: 's035' }), [
    { cmd: 'course.set', args: { size: { w: 1920, h: 1080 } } },
    { cmd: 'slide.add', args: { id: 's-1', duration: 3000, objects: [
      { id: 'o-text', type: 'text', text: 'Patched text', x: 327, y: 189, w: 916, h: 147, start: 1000, end: 2000, enter: { effect: 'fade', duration: 0.5 }, exit: { effect: 'fade', duration: 0.25 } },
      { id: 'o-btn', type: 'button', text: 'Probe', x: 341, y: 519, w: 484, h: 55, enter: { effect: 'fly', duration: 0.75 } },
    ] } },
  ]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.doc;
}
const at = (doc, ms) => { const rt = createRuntime(doc); rt.start(); if (ms) rt.tick(ms); return Object.fromEntries(rt.view().objects.map((o) => [o.id, o])); };

test('entrance from the start, exit ends at the end (scheduled at end - duration)', () => {
  const doc = s035();
  assert.deepEqual(validate(doc), []);
  assert.equal(at(doc, 999)['o-text'].visible, false);
  let v = at(doc, 1000)['o-text'];
  assert.equal(v.visible, true);
  assert.deepEqual(v.anim, { name: 'enter', effect: 'fade', duration: 500, elapsed: 0, paused: false });
  assert.equal(at(doc, 1250)['o-text'].anim.elapsed, 250);
  assert.equal(at(doc, 1500)['o-text'].anim, null, 'entrance over after 0.5 s');
  assert.equal(at(doc, 1749)['o-text'].anim, null);
  v = at(doc, 1750)['o-text'];
  assert.deepEqual([v.anim.name, v.anim.elapsed, v.anim.duration, v.visible], ['exit', 0, 250, true], ' hide/Exit scheduled at 1750');
  assert.equal(at(doc, 2000)['o-text'].visible, false, 'hidden at the end, as without an effect');
});

test('fly from the bottom starts just below the stage edge; the other directions use the matching edge', () => {
  const doc = s035();
  const a = at(doc, 0)['o-btn'].anim;
  assert.deepEqual([a.name, a.effect, a.duration, a.dx, a.dy], ['enter', 'fly', 750, 0, 1080 - 519]); // vendor: dy 566 (I: slightly more margin)
  const r = applyAll(doc, [{ cmd: 'object.set', args: { id: 'o-btn', enter: { effect: 'fly', duration: 0.5, direction: 'tl' } } }]);
  const b = at(r.doc, 0)['o-btn'].anim;
  assert.deepEqual([b.dx, b.dy], [-(341 + 484), -(519 + 55)]);
});

test('effects are visual only: no effect on visibility, triggers or the trace; null clears; validation is actionable', () => {
  const doc = s035();
  const plain = applyAll(doc, [{ cmd: 'object.set', args: { id: 'o-text', enter: null, exit: null } }, { cmd: 'object.set', args: { id: 'o-btn', enter: null } }]).doc;
  for (const ms of [0, 999, 1000, 1600, 1800, 2000, 2500]) {
    const [x, y] = [at(doc, ms), at(plain, ms)];
    for (const id of ['o-text', 'o-btn']) assert.equal(x[id].visible, y[id].visible, `${id} at ${ms} ms`);
  }
  assert.equal(at(plain, 1000)['o-text'].anim, undefined, 'no anim field without effects');
  const bad = applyAll(doc, [{ cmd: 'object.set', args: { id: 'o-text', enter: { effect: 'spin' } } }]);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].path, /enter\/effect/);
  assert.match(JSON.stringify(bad.errors[0]), /fade/);
});

test('a layer that pauses the base timeline pauses running base effects; an exit without an end is ignored', () => {
  const r = applyAll(emptyCourse(), [
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-a', type: 'shape', enter: { effect: 'grow', duration: 1 }, exit: { effect: 'zoom', duration: 0.5 } }, { id: 'o-b', type: 'button', text: 'Open' }], layers: [{ id: 'l-1', pauseBase: true }] } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'showLayer', layer: 'l-1' }] } },
  ]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const rt = createRuntime(r.doc); rt.start(); rt.tick(300);
  const view = () => rt.view().objects.find((o) => o.id === 'o-a').anim;
  assert.deepEqual([view().name, view().elapsed, view().paused], ['enter', 300, false]);
  rt.dispatch({ type: 'click', target: 'o-b' }).tick(400);
  assert.deepEqual([view().elapsed, view().paused], [300, true], 'the base clock and its effect stop together');
  rt.tick(5000);
  assert.equal(view().name, 'enter', 'no exit without an end: the object never leaves');
});

test('import: animEffect encodings map to enter/exit; unmapped effects and sequencing are reported', async () => {
  const { pkg, storyXml, slides, slide, obj, ID } = await import('../fixtures/synthetic/story-builder.js');
  const { importStory } = await import('../../packages/import-story/index.js');
  const fx = (inner) => `<animEffect>${inner}</animEffect>`;
  const s = slide(160, { shapes:
    obj('textBox', 161, { text: 'Faded', tm: 'start="1000" dur="1000" untilEnd="false"', extra: fx('<entr><fade dur="PT0.5S" lvl="none" easingDir="none" easingType="lin" dir="none" /></entr><exit><fade dur="PT0.25S" lvl="none" easingDir="none" easingType="lin" dir="none" /></exit>') })
    + obj('rect', 162, { extra: fx('<entr><fly dur="PT0.75S" lvl="none" easingDir="out" easingType="cubic" dir="b" /></entr>') })
    + obj('rect', 163, { extra: fx('<entr><wheel dur="PT1S" lvl="para" /></entr>') }) });
  const story = storyXml().replace('<sldId>R1</sldId>', '<sldId>R10</sldId><sldId>R1</sldId>');
  const { doc, report } = importStory(pkg({ story, parts: [...slides(), s] }));
  assert.deepEqual(validate(doc), []);
  const o = (n) => doc.slides.find((x) => x.id === ID('s', 160)).objects.find((x) => x.id === ID('o', n));
  assert.deepEqual([o(161).enter, o(161).exit], [{ effect: 'fade', duration: 0.5 }, { effect: 'fade', duration: 0.25 }]);
  assert.deepEqual(o(162).enter, { effect: 'fly', duration: 0.75, direction: 'b' });
  assert.equal(o(163).enter, undefined);
  assert.ok(report.items.some((x) => x.kind === 'object.animation' && /wheel/.test(x.reason)));
});
