
// a 100-slide course with many triggers, built only from commands, then validated, played to the end, published
// and read back from the package.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse, validate, serialize, parse, normalize } from '../../packages/schema/index.js';
import { createRuntime, seededRng } from '../../packages/runtime/index.js';
import { publishWeb, publishScorm12, validatePackage } from '../../packages/publisher/index.js';

const N = 100;
function bigCourse() {
  const cmds = [{ cmd: 'var.add', args: { name: 'visits', type: 'number' } }, { cmd: 'var.add', args: { name: 'flag', type: 'boolean' } }];
  for (let i = 0; i < N; i++) {
    const s = `s-${i}`;
    cmds.push({ cmd: 'slide.add', args: { id: s, title: `Slide ${i}`, objects: [
      { id: `o-${i}-t`, type: 'text', text: `Slide ${i} of ${N}: %visits% visits`, x: 40, y: 40, w: 800, h: 60 },
      { id: `o-${i}-b`, type: 'button', text: 'Toggle', x: 40, y: 140, w: 200, h: 60 },
      { id: `o-${i}-s`, type: 'shape', x: 300, y: 140, w: 100, h: 100, states: { selected: { style: { fill: '#0b6e6e' } } } },
    ], layers: [{ id: `l-${i}`, title: 'Info', objects: [{ id: `o-${i}-c`, type: 'button', text: 'Close', x: 40, y: 300, w: 200, h: 60 }] }] } });
    cmds.push({ cmd: 'trigger.add', args: { slide: s, on: { event: 'timelineStart' }, do: [{ action: 'setVar', var: 'visits', op: 'add', value: 1 }] } });
    cmds.push({ cmd: 'trigger.add', args: { slide: s, on: { event: 'click', target: `o-${i}-b` }, do: [{ action: 'setVar', var: 'flag', op: 'toggle' }, { action: 'showLayer', layer: `l-${i}` }] } });
    cmds.push({ cmd: 'trigger.add', args: { slide: s, on: { event: 'varChange', var: 'flag' }, if: { all: [{ var: 'flag', op: '==', value: true }] }, do: [{ action: 'setState', target: `o-${i}-s`, state: 'selected' }], else: [{ action: 'setState', target: `o-${i}-s`, state: 'normal' }] } });
    cmds.push({ cmd: 'trigger.add', args: { slide: s, layer: `l-${i}`, on: { event: 'click', target: `o-${i}-c` }, do: [{ action: 'hideLayer' }] } });
  }
  const t0 = performance.now();
  const r = applyAll(emptyCourse({ id: 'stress', title: 'Stress course' }), cmds, { rng: seededRng(3) });
  return { r, ms: performance.now() - t0, count: cmds.length };
}

test(`a ${N}-slide course with ${N * 4} triggers builds, validates, serializes and round-trips quickly`, () => {
  const { r, ms, count } = bigCourse();
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(count, 2 + N * 5);
  assert.ok(ms < 5000, `${count} commands took ${ms.toFixed(0)} ms`);
  let t = performance.now();
  assert.deepEqual(validate(r.doc), []);
  const text = serialize(r.doc);
  assert.equal(serialize(parse(text)), text);
  assert.ok(performance.now() - t < 1000, 'validate + serialize + parse under 1 s (editor load budget)');
});

test('a learner can play all 100 slides with clicks on each; state and variables stay consistent', () => {
  const { r } = bigCourse();
  const rt = createRuntime(r.doc, { rng: seededRng(4) });
  const t0 = performance.now();
  rt.start();
  for (let i = 0; i < N; i++) {
    rt.dispatch({ type: 'click', target: `o-${i}-b` }).tick(500).dispatch({ type: 'click', target: `o-${i}-c` }).tick(500);
    if (i < N - 1) rt.dispatch({ type: 'next' });
  }
  const ms = performance.now() - t0;
  assert.equal(rt.state.slide, `s-${N - 1}`);
  assert.equal(rt.state.vars.visits, N);
  assert.equal(rt.state.vars.flag, false, 'toggled an even number of times');
  assert.equal(rt.state.viewed.length, N);
  assert.ok(ms < 3000, `play took ${ms.toFixed(0)} ms`);
  const snap = rt.snapshot();
  const rt2 = createRuntime(r.doc); rt2.restore(snap);
  assert.equal(rt2.state.slide, `s-${N - 1}`);
  assert.equal(rt2.state.vars.visits, N + 1, "resume re-enters the slide, so its start trigger fires again");
  // the snapshot must fit SCORM 1.2 cmi.suspend_data (4096 characters) after 100 slides.
  const json = JSON.stringify(snap);
  assert.ok(json.length < 4096, `suspend data ${json.length} characters`);
  const rt3 = createRuntime(r.doc); rt3.restore(JSON.parse(json));
  rt3.dispatch({ type: 'menu', slide: 's-1' });
  assert.equal(rt3.state.obj['o-1-s'].state, rt.state.saved['s-1'].obj['o-1-s'].state, 'a changed object state survives the compact snapshot');
  assert.equal(rt3.state.obj['o-1-b'].state, 'normal', 'unchanged objects come back from the slide defaults');
});

test('publish web + SCORM under 3 s; the package embeds exactly the normalized source document (round trip)', () => {
  const { r } = bigCourse();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-scale-'));
  const t0 = performance.now();
  publishWeb(r.doc, path.join(dir, 'web'));
  publishScorm12(r.doc, path.join(dir, 'scorm'), { zip: true });
  assert.ok(performance.now() - t0 < 3000, 'publish budget');
  for (const out of ['web', 'scorm']) {
    assert.deepEqual(validatePackage(path.join(dir, out)), []);
    const ctx = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(dir, out, 'course.js'), 'utf8'), ctx);
    assert.equal(serialize(ctx.window.CF_COURSE), serialize(normalize(r.doc)), `${out}: published document equals the source`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
