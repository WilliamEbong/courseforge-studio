// registry: layer.move, null clears, object.duplicate, object.align, object.distribute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse, normalize, validate } from '../../packages/schema/index.js';
import { apply, applyAll } from '../../packages/core/index.js';
import { seededRng } from '../../packages/runtime/index.js';

const ctx = () => ({ rng: seededRng(7) });
const base = () => {
  const r = applyAll(emptyCourse({ title: 'P1' }), [
    { cmd: 'var.add', args: { name: 'seen', type: 'boolean' } },
    { cmd: 'slide.add', args: { id: 's-a', title: 'A', background: '#eeeeee', objects: [
      { id: 'o-btn', type: 'button', text: 'Go', x: 100, y: 100, w: 200, h: 50, states: { hover: { style: { fill: '#111111', color: '#ffffff' }, text: 'Hover' } } },
      { id: 'o-card', type: 'shape', x: 400, y: 300, w: 100, h: 100, style: { fill: '#222222', radius: 4 } },
      { id: 'o-note', type: 'text', text: 'Note', x: 700, y: 200, w: 300, h: 60 }] } },
    { cmd: 'layer.add', args: { slide: 's-a', id: 'l-one', title: 'One', objects: [{ id: 'o-close', type: 'button', text: 'Close', x: 10, y: 10, w: 80, h: 40 }] } },
    { cmd: 'layer.add', args: { slide: 's-a', id: 'l-two', title: 'Two' } },
    { cmd: 'layer.add', args: { slide: 's-a', id: 'l-three', title: 'Three' } },
    { cmd: 'trigger.add', args: { slide: 's-a', id: 't-btn', name: 'Go', on: { event: 'click', target: 'o-btn' }, if: { all: [{ target: 'o-card', state: 'hidden', is: false }] }, do: [{ action: 'setState', target: 'o-btn', state: 'visited' }, { action: 'setState', target: 'o-card', state: 'hidden' }, { action: 'showLayer', layer: 'l-one' }] } },
    { cmd: 'trigger.add', args: { slide: 's-a', id: 't-card', on: { event: 'click', target: 'o-card' }, do: [{ action: 'setVar', var: 'seen', op: 'set', value: true }] } },
    { cmd: 'trigger.add', args: { slide: 's-a', layer: 'l-one', id: 't-close', on: { event: 'click', target: 'o-close' }, do: [{ action: 'hideLayer' }] } },
    { cmd: 'slide.add', args: { id: 's-b', title: 'B' } },
    { cmd: 'layer.add', args: { slide: 's-b', id: 'l-b', title: 'B layer' } },
  ], ctx());
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.doc;
};
const objs = (doc, slide = 's-a', layer = null) => { const s = doc.slides.find((x) => x.id === slide); return layer ? s.layers.find((l) => l.id === layer).objects : s.objects; };
const obj = (doc, id) => doc.slides.flatMap((s) => [...s.objects, ...s.layers.flatMap((l) => l.objects)]).find((o) => o.id === id);
/** Apply, assert ok, assert undo restores the input exactly; returns the result. */
function ok(doc, cmd) {
  const r = apply(doc, cmd, ctx());
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(apply(r.doc, r.inverse).doc, normalize(doc), 'undo restores deep-equal');
  return r;
}
const err = (doc, cmd) => { const r = apply(doc, cmd, ctx()); assert.equal(r.ok, false); return r.errors[0]; };

// ---------- layer.move ----------
test('layer.move reorders layers, clamps the index, undo restores', () => {
  const d = base();
  let r = ok(d, { cmd: 'layer.move', args: { id: 'l-three', index: 0 } });
  assert.deepEqual(r.doc.slides[0].layers.map((l) => l.id), ['l-three', 'l-one', 'l-two']);
  r = ok(d, { cmd: 'layer.move', args: { id: 'l-one', index: 99 } });
  assert.deepEqual(r.doc.slides[0].layers.map((l) => l.id), ['l-two', 'l-three', 'l-one']);
});
test('layer.move errors name the existing layers', () => {
  const e = err(base(), { cmd: 'layer.move', args: { id: 'l-zz', index: 0 } });
  assert.equal(e.code, 'ref');
  assert.match(e.hint, /l-one/);
  assert.equal(err(base(), { cmd: 'layer.move', args: { id: 'l-one' } }).code, 'required');
});

// ---------- null clears ----------
test('state.set style {key:null} removes one key; the last key removes style; text/hidden null remove overrides', () => {
  const d = base();
  let r = ok(d, { cmd: 'state.set', args: { target: 'o-btn', state: 'hover', style: { fill: null } } });
  assert.deepEqual(obj(r.doc, 'o-btn').states.hover, { style: { color: '#ffffff' }, text: 'Hover' });
  r = ok(r.doc, { cmd: 'state.set', args: { target: 'o-btn', state: 'hover', style: { color: null }, text: null } });
  assert.deepEqual(obj(r.doc, 'o-btn').states.hover, {});
  r = ok(d, { cmd: 'state.set', args: { target: 'o-btn', state: 'hover', style: null, hidden: true } });
  assert.deepEqual(obj(r.doc, 'o-btn').states.hover, { text: 'Hover', hidden: true });
  r = ok(r.doc, { cmd: 'state.set', args: { target: 'o-btn', state: 'hover', hidden: null } });
  assert.deepEqual(obj(r.doc, 'o-btn').states.hover, { text: 'Hover' });
});
test('state.set still rejects a wrongly typed style key', () => {
  const e = err(base(), { cmd: 'state.set', args: { target: 'o-btn', state: 'hover', style: { fill: 3 } } });
  assert.equal(e.path, '/args/style/fill');
  assert.equal(e.code, 'type');
  assert.equal(err(base(), { cmd: 'state.set', args: { target: 'o-btn', state: 'hover', style: { align: 'up' } } }).code, 'enum');
});
test('object.set style {key:null} removes one key and keeps the rest', () => {
  const d = base();
  let r = ok(d, { cmd: 'object.set', args: { id: 'o-card', style: { fill: null, bold: true } } });
  assert.deepEqual(obj(r.doc, 'o-card').style, { radius: 4, bold: true });
  r = ok(r.doc, { cmd: 'object.set', args: { id: 'o-card', style: { radius: null, bold: null } } });
  assert.equal(obj(r.doc, 'o-card').style, undefined);
  r = ok(d, { cmd: 'object.set', args: { id: 'o-card', shape: null } }); // nullable enums accept null
  assert.equal(obj(r.doc, 'o-card').shape, 'rect');
});
test('trigger.set {name:null} and slide.set {background:null} remove the field', () => {
  const d = base();
  let r = ok(d, { cmd: 'trigger.set', args: { id: 't-btn', name: null } });
  assert.equal('name' in r.doc.slides[0].triggers[0], false);
  r = ok(d, { cmd: 'slide.set', args: { id: 's-a', background: null, notes: null } });
  assert.equal('background' in r.doc.slides[0], false);
  assert.equal(err(d, { cmd: 'slide.set', args: { id: 's-a', title: null } }).code, 'type', 'required-with-default fields stay non-null');
});

// ---------- object.duplicate ----------
test('object.duplicate in place: fresh ids, offset, on top, triggers copied and remapped', () => {
  const d = base();
  const r = ok(d, { cmd: 'object.duplicate', args: { ids: ['o-card', 'o-btn'], dx: 20, dy: 10 } });
  const [card2, btn2] = r.result.ids;
  assert.ok(card2 && btn2 && card2 !== 'o-card' && btn2 !== 'o-btn');
  const list = objs(r.doc);
  assert.deepEqual(list.map((o) => o.id), ['o-btn', 'o-card', 'o-note', btn2, card2], 'copies on top, source stacking kept');
  assert.deepEqual({ ...obj(r.doc, btn2), id: 'o-btn', x: 100, y: 100 }, obj(d, 'o-btn'));
  assert.deepEqual([obj(r.doc, btn2).x, obj(r.doc, btn2).y], [120, 110]);
  assert.equal(r.result.triggers.length, 2);
  assert.deepEqual(r.result.skipped, []);
  const t = r.doc.slides[0].triggers.find((x) => x.id === r.result.triggers[0]);
  assert.equal(t.on.target, btn2);
  assert.equal(t.if.all[0].target, card2, 'reference to a copied object follows the copy');
  assert.deepEqual(t.do.map((a) => a.target ?? a.layer), [btn2, card2, 'l-one']);
  assert.equal(t.name, 'Go');
  assert.deepEqual(validate(r.doc), []);
});
test('object.duplicate keeps references to objects that were not copied when they still exist', () => {
  const r = ok(base(), { cmd: 'object.duplicate', args: { ids: ['o-btn'], newIds: ['o-btn2'] } });
  const t = r.doc.slides[0].triggers.find((x) => x.id === r.result.triggers[0]);
  assert.equal(t.on.target, 'o-btn2');
  assert.equal(t.if.all[0].target, 'o-card');
  assert.deepEqual([obj(r.doc, 'o-btn2').x, obj(r.doc, 'o-btn2').y], [100, 100], 'dx/dy default to 0');
});
test('object.duplicate across slides: base or layer; triggers with unresolvable references are skipped', () => {
  const d = base();
  let r = ok(d, { cmd: 'object.duplicate', args: { ids: ['o-btn'], slide: 's-b', newIds: ['o-b1'] } });
  assert.deepEqual(objs(r.doc, 's-b').map((o) => o.id), ['o-b1']);
  assert.deepEqual(r.result, { ids: ['o-b1'], triggers: [], skipped: ['t-btn'] }, 't-btn needs o-card and l-one, which s-b lacks');
  r = ok(d, { cmd: 'object.duplicate', args: { ids: ['o-btn', 'o-card'], slide: 's-b', layer: 'l-b', newIds: ['o-b1', 'o-b2'] } });
  assert.deepEqual(objs(r.doc, 's-b', 'l-b').map((o) => o.id), ['o-b1', 'o-b2']);
  assert.deepEqual(r.result.skipped, ['t-btn'], 'still needs l-one');
  const tc = r.doc.slides[1].layers[0].triggers.find((x) => x.id === r.result.triggers[0]);
  assert.equal(tc.on.target, 'o-b2');
  // From a layer to another slide's layer: a bare hideLayer stays valid; to a base layer it would not.
  r = ok(d, { cmd: 'object.duplicate', args: { ids: ['o-close'], slide: 's-b', layer: 'l-b' } });
  assert.equal(r.result.triggers.length, 1);
  r = ok(d, { cmd: 'object.duplicate', args: { ids: ['o-close'], slide: 's-b', layer: null } });
  assert.deepEqual(r.result.skipped, ['t-close']);
  assert.equal(objs(r.doc, 's-b').length, 1);
  r = ok(d, { cmd: 'object.duplicate', args: { ids: ['o-note'], layer: 'l-two' } }); // layer of the source slide
  assert.equal(objs(r.doc, 's-a', 'l-two').length, 1);
});
test('object.duplicate errors carry hints', () => {
  const d = base();
  let e = err(d, { cmd: 'object.duplicate', args: { ids: ['o-zz'] } });
  assert.deepEqual([e.code, e.path], ['ref', '/args/ids']);
  assert.match(e.hint, /o-btn/);
  e = err(d, { cmd: 'object.duplicate', args: { ids: ['o-btn', 'o-close'] } });
  assert.equal(e.code, 'semantic');
  assert.match(e.hint, /separate commands/);
  assert.equal(err(d, { cmd: 'object.duplicate', args: { ids: ['o-btn', 'o-btn'] } }).code, 'dupe');
  assert.equal(err(d, { cmd: 'object.duplicate', args: { ids: [] } }).code, 'required');
  e = err(d, { cmd: 'object.duplicate', args: { ids: ['o-btn'], slide: 's-b', layer: 'l-one' } });
  assert.deepEqual([e.code, e.path], ['ref', '/args/layer']);
  assert.match(e.hint, /l-b/);
  assert.match(err(d, { cmd: 'object.duplicate', args: { ids: ['o-btn'], slide: 's-zz' } }).hint, /s-a, s-b/);
  assert.equal(err(d, { cmd: 'object.duplicate', args: { ids: ['o-btn', 'o-card'], newIds: ['o-x'] } }).path, '/args/newIds');
  e = err(d, { cmd: 'object.duplicate', args: { ids: ['o-btn'], newIds: ['o-card'] } });
  assert.deepEqual([e.code, e.path], ['dupe', '/args/newIds']);
});

// ---------- align / distribute ----------
const geo = (doc, ids) => ids.map((id) => { const o = obj(doc, id); return [o.x, o.y]; });
test('object.align to the selection bounds, every edge', () => {
  const d = base(); // o-btn 100,100 200x50; o-card 400,300 100x100; o-note 700,200 300x60
  const ids = ['o-btn', 'o-card', 'o-note'];
  const cases = {
    left: [[100, 100], [100, 300], [100, 200]], right: [[800, 100], [900, 300], [700, 200]], center: [[450, 100], [500, 300], [400, 200]],
    top: [[100, 100], [400, 100], [700, 100]], bottom: [[100, 350], [400, 300], [700, 340]], middle: [[100, 225], [400, 200], [700, 220]],
  };
  for (const [edge, want] of Object.entries(cases)) assert.deepEqual(geo(ok(d, { cmd: 'object.align', args: { ids, edge } }).doc, ids), want, edge);
});
test('object.align to the slide (default for one object)', () => {
  const d = base();
  assert.deepEqual(geo(ok(d, { cmd: 'object.align', args: { ids: ['o-card'], edge: 'center' } }).doc, ['o-card']), [[590, 300]]);
  assert.deepEqual(geo(ok(d, { cmd: 'object.align', args: { ids: ['o-card', 'o-btn'], edge: 'bottom', to: 'slide' } }).doc, ['o-card', 'o-btn']), [[400, 620], [100, 670]]);
});
test('object.align errors', () => {
  const d = base();
  assert.equal(err(d, { cmd: 'object.align', args: { ids: ['o-btn'], edge: 'up' } }).code, 'enum');
  const e = err(apply(d, { cmd: 'object.add', args: { slide: 's-b', id: 'o-far', type: 'text' } }).doc, { cmd: 'object.align', args: { ids: ['o-btn', 'o-far'], edge: 'left' } });
  assert.equal(e.code, 'semantic');
  assert.match(e.hint, /s-a, s-b/);
});
test('object.distribute spaces objects evenly; outermost stay; needs 3+', () => {
  const d = base();
  // horizontal: sorted o-btn(100..300) o-card(400..500) o-note(700..1000): span 900, widths 600, gap 150
  assert.deepEqual(geo(ok(d, { cmd: 'object.distribute', args: { ids: ['o-note', 'o-btn', 'o-card'], axis: 'horizontal' } }).doc, ['o-btn', 'o-card', 'o-note']), [[100, 100], [450, 300], [700, 200]]);
  // vertical: o-btn(100..150) o-note(200..260) o-card(300..400): span 300, heights 210, gap 45
  assert.deepEqual(geo(ok(d, { cmd: 'object.distribute', args: { ids: ['o-btn', 'o-card', 'o-note'], axis: 'vertical' } }).doc, ['o-btn', 'o-note', 'o-card']), [[100, 100], [700, 195], [400, 300]]);
  const e = err(d, { cmd: 'object.distribute', args: { ids: ['o-btn', 'o-card'], axis: 'vertical' } });
  assert.equal(e.code, 'semantic');
  assert.match(e.hint, /object\.align/);
});
test('a group move is one atomic batch with one inverse', () => {
  const d = base();
  const r = applyAll(d, [{ cmd: 'object.set', args: { id: 'o-btn', x: 110 } }, { cmd: 'object.set', args: { id: 'o-card', x: 410 } }]);
  assert.ok(r.ok);
  assert.deepEqual(apply(r.doc, r.inverse).doc, normalize(d));
  const bad = applyAll(d, [{ cmd: 'object.set', args: { id: 'o-btn', x: 110 } }, { cmd: 'object.remove', args: { id: 'o-card' } }]);
  assert.equal(bad.ok, false, 'o-card is referenced: the whole batch is refused');
  assert.equal(bad.errors[0].index, 1);
});
