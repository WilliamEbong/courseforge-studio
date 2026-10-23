// reusable interactions. slide.export packages a slide with the variables and assets it uses;
// slide.import inserts it into another course with fresh ids (CLI/MCP/HTTP get both through the registry).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAll, query } from '../../packages/core/index.js';
import { emptyCourse, validate, allIds } from '../../packages/schema/index.js';
import { play } from '../../packages/runtime/index.js';

const ok = (cmds, doc = emptyCourse()) => { const r = applyAll(doc, cmds); assert.ok(r.ok, JSON.stringify(r.errors)); return r; };

test('export a slide with a layer, triggers, a variable and an image; import it twice into another course', () => {
  const src = ok([
    { cmd: 'var.add', args: { name: 'opened', type: 'boolean' } },
    { cmd: 'asset.add', args: { id: 'a-pic', path: 'assets/pic.png', alt: 'Picture' } },
    { cmd: 'slide.add', args: { id: 's-card', title: 'Flip card', objects: [{ id: 'o-card', type: 'button', text: 'Flip (%opened%)' }, { id: 'o-img', type: 'image', image: 'a-pic' }], layers: [{ id: 'l-back', title: 'Back' }] } },
    { cmd: 'slide.add', args: { id: 's-other' } },
    { cmd: 'trigger.add', args: { slide: 's-card', on: { event: 'click', target: 'o-card' }, do: [{ action: 'setVar', var: 'opened', op: 'toggle' }, { action: 'showLayer', layer: 'l-back' }] } },
    { cmd: 'trigger.add', args: { slide: 's-card', id: 't-away', on: { event: 'timelineEnd' }, do: [{ action: 'jump', to: 's-other' }] } },
  ]).doc;
  const ex = query(src, 'slide.export', { id: 's-card' });
  assert.ok(ex.ok, JSON.stringify(ex.errors));
  assert.equal(ex.data.kind, 'cf.slide/1');
  assert.deepEqual(ex.data.variables.map((v) => v.name), ['opened']);
  assert.deepEqual(ex.data.assets.map((x) => x.id), ['a-pic']);
  const target = ok([{ cmd: 'slide.add', args: { id: 's-1' } }]).doc;
  const r = ok([{ cmd: 'slide.import', args: { data: ex.data } }, { cmd: 'slide.import', args: { data: ex.data } }], target);
  assert.deepEqual(validate(r.doc), []);
  assert.equal(r.doc.slides.length, 3);
  assert.deepEqual(r.results.map((x) => x.skipped), [['t-away'], ['t-away']], 'a jump to a slide this course lacks is skipped');
  assert.equal(r.doc.variables.filter((v) => v.name === 'opened').length, 1);
  assert.equal(r.doc.assets.length, 1, 'the same asset path is shared, not duplicated');
  const before = allIds(target);
  for (const x of r.results) assert.ok(!before.has(x.id));
  const imported = r.doc.slides.find((s) => s.id === r.results[0].id);
  const btn = imported.objects.find((o) => o.type === 'button');
  const p = play(r.doc, [{ type: 'menu', slide: imported.id }, { type: 'click', target: btn.id }]);
  assert.equal(p.vars.opened, true);
  assert.equal(p.layers.length, 1);
});

test('import refuses a non-package and a variable type clash, with hints', () => {
  const doc = ok([{ cmd: 'var.add', args: { name: 'opened', type: 'number' } }]).doc;
  const bad = applyAll(doc, [{ cmd: 'slide.import', args: { data: { slide: {} } } }]);
  assert.equal(bad.ok, false); assert.match(bad.errors[0].hint, /slide.export/);
  const pkg = { kind: 'cf.slide/1', slide: { id: 's-x' }, variables: [{ name: 'opened', type: 'boolean' }], assets: [] };
  const clash = applyAll(doc, [{ cmd: 'slide.import', args: { data: pkg } }]);
  assert.equal(clash.ok, false); assert.match(clash.errors[0].message, /number here but boolean/);
});

test('lessons: export a lesson from the sample and import it into another lessons course', async () => {
  const fs = await import('node:fs');
  const sample = JSON.parse(fs.readFileSync(new URL('../../samples/lab-basics-lessons.course.json', import.meta.url), 'utf8'));
  const first = sample.sections[0].lessons[0];
  const ex = query(sample, 'lesson.export', { id: first.id });
  assert.ok(ex.ok, JSON.stringify(ex.errors));
  assert.equal(ex.data.kind, 'cf.lesson/1');
  const target = ok([{ cmd: 'course.set', args: { mode: 'lessons' } }, { cmd: 'section.add', args: { id: 'sec-a', title: 'A' } }]).doc;
  const r = ok([{ cmd: 'lesson.import', args: { data: ex.data, section: 'sec-a' } }], target);
  assert.deepEqual(validate(r.doc), []);
  const lesson = r.doc.sections[0].lessons[0];
  const dropped = r.results[0].unlinked.length;
  assert.equal(lesson.blocks.length, first.blocks.length - dropped);
  assert.ok(dropped >= 1, 'the sample lesson links to its quiz lesson, which the target lacks');
  assert.notEqual(lesson.id, undefined);
  assert.equal(r.doc.assets.length, ex.data.assets.length);
});
