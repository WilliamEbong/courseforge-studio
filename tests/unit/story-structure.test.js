import test from 'node:test';
import assert from 'node:assert/strict';
import { writeStory } from '../../packages/export-story/index.js';
import { openStory, saveStory, canon } from '../../packages/export-story/save.js';
import { applyAll } from '../../packages/core/index.js';
import { parseXml } from '../../packages/import-story/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function edit(state, cmds) {
  const result = applyAll(state.doc, cmds);
  assert.ok(result.ok, JSON.stringify(result.errors));
  const next = saveStory(state, result.doc);
  assert.deepEqual(canon(next.doc), canon(result.doc));
  return { state: next, results: result.results };
}

test('authored user variables retain an empty property path for native re-save', () => {
  let state = openStory(writeStory());
  state = edit(state, [
    { cmd: 'var.add', args: { name: 'visits', type: 'number', initial: 0 } },
    { cmd: 'var.add', args: { name: 'ready', type: 'boolean', initial: false } },
    { cmd: 'var.add', args: { name: 'label', type: 'text', initial: '' } },
  ]).state;
  const vars = parseXml(state.zip.read('story/story.xml').toString()).kids.find(n => n.tag === 'varLst').kids;
  assert.equal(vars.length, 3);
  for (const v of vars) assert.equal(v.attrs.propPath, '');
});

test('native border added to an existing object uses the native line reader contract', () => {
  let state = openStory(writeStory({ text: 'Border' }));
  const id = state.doc.slides[0].objects[0].id;
  state = edit(state, [{ cmd: 'object.set', args: { id, style: { border: '#123456', borderWidth: 3 } } }]).state;
  const { part } = state.nodes.get(id);
  const root = parseXml(state.zip.read(part).toString('utf8'));
  const shape = root.kids.find(k => k.tag === 'shapeLst').kids.find(k => k.tag === 'textBox');
  const line = shape.kids.find(k => k.tag === 'bG').kids.find(k => k.tag === 'lineStyle');
  const arrow = line.kids.find(k => k.tag === 'arrow');
  assert.equal(line.attrs.join, 'mtr');
  assert.equal(line.attrs.dash, 'sld');
  assert.equal(Number(line.attrs.scale), 1);
  assert.equal(Number(arrow.attrs.scale), 1);
  for (const end of arrow.kids) assert.equal(end.attrs.sz, 'size5');
});

test('native authored and question feedback layers use valid native seeking defaults', () => {
  let state = openStory(writeStory());
  const slide = state.doc.slides[0].id;
  state = edit(state, [
    { cmd: 'layer.add', args: { slide, title: 'Details' } },
    { cmd: 'question.set', args: { slide, type: 'mc', prompt: 'Choose one', choices: [
      { id: 'c-yes', label: 'Yes', correct: true }, { id: 'c-no', label: 'No', correct: false },
    ] } },
  ]).state;
  const layers = state.zip.names.filter(n => /^story\/slides\/[^/]+\.xml$/.test(n)).flatMap(name =>
    parseXml(state.zip.read(name).toString('utf8')).kids.find(k => k.tag === 'sldLayerLst')?.kids ?? []);
  assert.equal(layers.filter(l => l.tag === 'sldLayer').length, 1);
  assert.equal(layers.filter(l => l.tag === 'feedBackLayer').length, 3);
  // authored layers inherit automatically; native feedback layers suppress seeking.
  for (const layer of layers) {
    assert.equal(layer.attrs.seek, layer.tag === 'sldLayer' ? 'auto' : 'n', layer.tag);
    if (layer.tag === 'feedBackLayer') assert.equal(layer.attrs.seekInheritable, 'n');
  }
});

test('default native buttons keep a visible fill through creation and style reset', () => {
  let state = openStory(writeStory());
  const slide = state.doc.slides[0].id;
  state = edit(state, [{ cmd: 'object.add', args: { id: 'o-button', slide, type: 'button', text: 'Continue', x: 10, y: 10, w: 200, h: 50 } }]).state;
  const fill = () => {
    const { node } = state.nodes.get('o-button');
    return node.kids.find(k => k.tag === 'bG')?.kids.find(k => k.tag === 'solidFill')?.kids[0]?.kids[0]?.attrs.val;
  };
  assert.equal(fill(), '34449C');
  assert.equal(state.doc.slides[0].objects[0].style?.fill, undefined);
  state = edit(state, [{ cmd: 'object.set', args: { id: 'o-button', style: { fill: '#123456' } } }]).state;
  assert.equal(fill(), '123456');
  state = edit(state, [{ cmd: 'state.set', args: { target: 'o-button', state: 'hover', text: 'Ready' } }]).state;
  state = edit(state, [{ cmd: 'object.set', args: { id: 'o-button', style: { fill: null } } }]).state;
  assert.equal(fill(), '34449C');
  assert.equal(state.doc.slides[0].objects[0].style?.fill, undefined);
});

test('native structure: add slides and objects, layers, variables and click triggers, then reopen', () => {
  let state = openStory(writeStory({ title: 'Original course' }));
  const scene = state.doc.scenes[0].id;
  let r = edit(state, [{ cmd: 'slide.add', args: { scene, title: 'Process', duration: 7000 } }]);
  state = r.state;
  const slide = r.results[0].id;
  r = edit(state, [
    { cmd: 'object.add', args: { slide, type: 'text', text: 'Follow these steps', x: 50, y: 60, w: 420, h: 80 } },
    { cmd: 'object.add', args: { slide, type: 'shape', shape: 'rect', x: 40, y: 180, w: 150, h: 100, style: { fill: '#2563EB' } } },
    { cmd: 'object.add', args: { slide, type: 'button', text: 'Show details', x: 220, y: 180, w: 180, h: 50 } },
    { cmd: 'layer.add', args: { slide, title: 'Details', modal: true, pauseBase: true } },
    { cmd: 'var.add', args: { name: 'visits', type: 'number', initial: 0 } },
  ]);
  state = r.state;
  const button = r.results[2].id, layer = r.results[3].id;
  r = edit(state, [
    { cmd: 'object.add', args: { slide, layer, type: 'text', text: 'Detailed instructions', x: 80, y: 80 } },
    { cmd: 'trigger.add', args: { slide, on: { event: 'click', target: button }, do: [{ action: 'showLayer', layer }] } },
  ]);
  state = r.state;
  const reopened = openStory(state.buf);
  assert.equal(reopened.doc.slides.find(s => s.id === slide).layers[0].objects[0].text, 'Detailed instructions');
  assert.equal(reopened.doc.variables[0].name, 'visits');
  assert.equal(saveStory(reopened, reopened.doc).buf, reopened.buf);
});

test('native structure: media is embedded before use, linked from its slide and readable after the source is gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-story-media-'));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8i8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(dir, 'dot.png'), bytes);
  let state = openStory(writeStory(), { courseDir: dir, assetsDir: path.join(dir, 'assets') });
  let r = edit(state, [{ cmd: 'asset.add', args: { path: 'dot.png', mime: 'image/png' } }]);
  const asset = r.results[0].id;
  r = edit(r.state, [{ cmd: 'object.add', args: { slide: r.state.doc.slides[0].id, type: 'image', image: asset, x: 20, y: 30, w: 100, h: 80, alt: 'A dot' } }]);
  fs.unlinkSync(path.join(dir, 'dot.png'));
  state = openStory(r.state.buf, { courseDir: dir, assetsDir: path.join(dir, 'assets') });
  assert.deepEqual(fs.readFileSync(path.join(dir, state.doc.assets[0].path)), bytes);
  assert.equal(state.doc.slides[0].objects[0].image, asset);
  assert.ok(state.zip.names.some(n => n.endsWith('slide.xml.rels')));
  assert.equal(saveStory(state, state.doc).buf, state.buf);
  const replacement = structuredClone(state.doc);
  replacement.assets[0].path = 'replacement.png';
  assert.throws(() => saveStory(state, replacement), e => e.errors?.some(x => x.code === 'story-unsupported' && x.path === '/assets/0/path'));
  state = edit(state, [{ cmd: 'object.remove', args: { id: state.doc.slides[0].objects[0].id } }, { cmd: 'asset.remove', args: { id: asset } }]).state;
  assert.equal(state.doc.assets.length, 0);
});

test('native structure: custom ids, states, duplicate objects and slides preserve editable content', () => {
  let state = openStory(writeStory());
  const slide = state.doc.slides[0].id;
  state = edit(state, [{ cmd: 'object.add', args: { id: 'o-card', slide, type: 'button', text: 'Front', x: 20, y: 30, w: 200, h: 70 } }]).state;
  state = edit(state, [{ cmd: 'state.set', args: { target: 'o-card', state: 'hover', text: 'Back', style: { fill: '#abcdef' } } }]).state;
  state = edit(state, [{ cmd: 'state.set', args: { target: 'o-card', state: 'hover', text: 'Details', style: { fill: '#fedcba' } } }]).state;
  let r = edit(state, [{ cmd: 'object.duplicate', args: { ids: ['o-card'], dx: 100, newIds: ['o-copy'] } }]);
  assert.equal(r.state.doc.slides[0].objects.find(o => o.id === 'o-copy').states.hover.text, 'Details');
  state = edit(r.state, [{ cmd: 'slide.duplicate', args: { id: slide, newId: 's-copy', title: 'Copied' } }]).state;
  assert.equal(state.doc.slides.find(s => s.id === 's-copy').objects.length, 2);
  state = edit(state, [{ cmd: 'state.remove', args: { target: 'o-card', state: 'hover' } }]).state;
  assert.deepEqual(state.doc.slides.find(s => s.id === slide).objects[0].states, {});
});

test('native structure: object timing and animations, borders, slide properties survive repeated edits', () => {
  let state = openStory(writeStory({ text: 'Timeline' }));
  const slide = state.doc.slides[0].id, id = state.doc.slides[0].objects[0].id;
  state = edit(state, [
    { cmd: 'object.set', args: { id, start: 800, end: 4000, enter: { effect: 'fade', duration: 0.5 }, style: { border: '#AABBCC', borderWidth: 3 } } },
    { cmd: 'slide.set', args: { id: slide, duration: 6000, background: '#ABCDEF', advance: 'auto', revisit: 'reset' } },
  ]).state;
  state = edit(state, [{ cmd: 'object.set', args: { id, start: 100, end: null, style: { border: '#112233' } } }]).state;
  assert.equal(state.doc.slides[0].objects[0].end, null);
  assert.equal(state.doc.slides[0].objects[0].enter.effect, 'fade');
});

test('native structure: trigger conditions/else, changing owners and variable rename keep native references', () => {
  let state = openStory(writeStory({ text: 'Visits: %visits%' }));
  const slide = state.doc.slides[0].id, object = state.doc.slides[0].objects[0].id;
  let r = edit(state, [
    { cmd: 'var.add', args: { name: 'visits', type: 'number', initial: 0 } },
    { cmd: 'object.add', args: { slide, type: 'button', text: 'Count', x: 50, y: 300, w: 100, h: 40 } },
  ]);
  const button = r.results[1].id;
  r = edit(r.state, [{ cmd: 'trigger.add', args: { slide, on: { event: 'click', target: button }, if: { all: [{ var: 'visits', op: '<', value: 5 }] }, do: [{ action: 'setVar', var: 'visits', op: 'add', value: 1 }], else: [{ action: 'setVar', var: 'visits', op: 'set', value: 0 }] } }]);
  const trigger = r.results[0].id;
  state = edit(r.state, [
    { cmd: 'var.set', args: { name: 'visits', newName: 'count', initial: 2 } },
    { cmd: 'trigger.set', args: { id: trigger, on: { event: 'click', target: object }, else: null, name: 'Count visits' } },
  ]).state;
  assert.equal(state.doc.variables[0].name, 'count');
  assert.equal(state.doc.slides[0].triggers[0].on.target, object);
  assert.equal(state.doc.slides[0].objects[0].text, 'Visits: %count%');
  const condition = state.nodes.get(trigger).node.kids.find(n => n.tag === 'condLst').kids[0];
  for (const key of ['strVal1', 'strVal2', 'boolVal']) assert.equal(condition.attrs[key], '');
});

test('native geometry: lines, arrows, rounded buttons, hotspots and layer revisit', () => {
  let state = openStory(writeStory());
  const slide = state.doc.slides[0].id;
  state = edit(state, [
    { cmd: 'object.add', args: { id: 'o-line', slide, type: 'shape', shape: 'line', x: 40, y: 50, w: 180, h: 3, rotation: 45, style: { border: '#123456', borderWidth: 3 } } },
    { cmd: 'object.add', args: { id: 'o-arrow', slide, type: 'shape', shape: 'arrow', x: 80, y: 100, w: 120, h: 9, rotation: -90, style: { border: '#123456', borderWidth: 3 } } },
    { cmd: 'object.add', args: { id: 'o-hot', slide, type: 'hotspot', x: 10, y: 10, w: 200, h: 50 } },
    { cmd: 'object.add', args: { id: 'o-rounded', slide, type: 'button', text: 'Continue', style: { radius: 8, fontSize: 22, italic: true } } },
    { cmd: 'layer.add', args: { id: 'l-resume', slide, title: 'Details', revisit: 'resume' } },
  ]).state;
  state = edit(state, [
    { cmd: 'object.set', args: { id: 'o-line', x: 90, y: 80, w: 240, rotation: -30 } },
    { cmd: 'object.set', args: { id: 'o-rounded', style: { radius: 12, bold: true } } },
    { cmd: 'layer.set', args: { id: 'l-resume', revisit: 'reset' } },
  ]).state;
  assert.equal(state.doc.slides[0].layers[0].revisit, 'reset');
});

test('native bank draw settings and membership remain editable after reopen', () => {
  let state = openStory(writeStory());
  const scene = state.doc.scenes[0].id;
  state = edit(state, [
    { cmd: 'bank.add', args: { id: 'bk-core', title: 'Core questions' } },
    { cmd: 'slide.add', args: { id: 's-bank-one', bank: 'bk-core', title: 'One' } },
    { cmd: 'slide.add', args: { id: 's-bank-two', bank: 'bk-core', title: 'Two' } },
    { cmd: 'draw.add', args: { id: 's-draw', scene, bank: 'bk-core', count: 1, shuffle: true } },
  ]).state;
  state = edit(state, [
    { cmd: 'bank.set', args: { id: 'bk-core', title: 'Updated bank' } },
    { cmd: 'draw.set', args: { id: 's-draw', count: 0, shuffle: false, always: ['s-bank-one'] } },
    { cmd: 'slide.move', args: { id: 's-bank-two', index: 0 } },
  ]).state;
  assert.deepEqual(state.doc.banks[0].slides, ['s-bank-two', 's-bank-one']);
});
