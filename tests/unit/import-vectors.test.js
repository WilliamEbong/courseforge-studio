import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStory } from '../../packages/import-story/index.js';
import { openStory, saveStory } from '../../packages/export-story/save.js';
import { readZip } from '../../packages/import-story/zip-read.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { obj, slide, pkg, state, srgb } from '../fixtures/synthetic/story-builder.js';
import { applyAll } from '../../packages/core/index.js';

import { tableShape, validGeometry, vectorShapes as shapes } from '../fixtures/synthetic/vector-shapes.js';
const geometry = validGeometry.replace('AAMDgw==', 'AAMDCw==');

test('native vectors and symbols become bounded SVG assets with exact cubic bounds and transparent holes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vector-'));
  try {
    const source = pkg({ parts: [slide(101, { shapes: shapes() })] });
    const options = { courseDir: dir, assetsDir: path.join(dir, 'assets'), reuseAssets: true };
    const r = importStory(source, options);
    assert.equal(r.doc.slides[0].objects.length, 3);
    const svg = r.doc.slides[0].objects.map(o => {
      assert.equal(o.type, 'image'); assert.equal(o.locked, true); assert.equal(r.nodes.get(o.id).derived, true);
      const a = r.doc.assets.find(a => a.id === o.image); assert.equal(r.nodes.get(a.id).derived, true);
      return fs.readFileSync(path.join(dir, a.path), 'utf8');
    });
    assert.match(svg[0], /viewBox="10 20 100 75"/);
    assert.match(svg[0], /C10 120 110 120 110 20Z/);
    assert.match(svg[0], /fill-rule="nonzero"/);
    assert.match(svg[1], /fill="#0000ff"/);
    assert.match(svg[2], /fill-rule="evenodd"/);
    assert.equal((svg[2].match(/M/g) ?? []).length, 3, 'outer ellipse and two transparent holes');
    const output = path.join(dir, 'web'); publishWeb(r.doc, output, { courseDir: dir });
    assert.deepEqual(validatePackage(output), []);
    const prev = openStory(source, options);
    assert.equal(saveStory(prev, prev.doc).buf.equals(source), true);
    const edit = structuredClone(prev.doc); edit.title = 'Vector title edit';
    const saved = saveStory(prev, edit);
    const part = readZip(source).names.find(n => /^story\/slides\/[^/]+\.xml$/.test(n));
    assert.equal(readZip(saved.buf).read(part).equals(readZip(source).read(part)), true);
    assert.deepEqual(openStory(saved.buf, options).doc.slides[0].objects, prev.doc.slides[0].objects);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('derived vector edits and media removal refuse without rewriting native shapes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vector-save-'));
  try {
    const prev = openStory(pkg({ parts: [slide(101, { shapes: shapes() })] }), { courseDir: dir, assetsDir: path.join(dir, 'assets'), reuseAssets: true });
    assert.equal(prev.doc.slides[0].objects.length, 3);
    for (const edit of [d => { d.slides[0].objects[0].x++; }, d => { d.assets.splice(d.assets.findIndex(a => a.id === d.slides[0].objects[0].image), 1); }]) {
      const next = structuredClone(prev.doc); edit(next);
      assert.throws(() => saveStory(prev, next), e => e.errors?.some(x => x.code === 'story-unsupported'));
    }
    const duplicate = applyAll(prev.doc, [{ cmd: 'slide.duplicate', args: { id: prev.doc.slides[0].id, newId: 's-copy' } }]);
    assert.throws(() => saveStory(prev, duplicate.doc), e => e.errors?.some(x => x.code === 'story-unsupported'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unmerged tables preserve rich cells, padding, clipping and one outline without altering native bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-table-'));
  try {
    const bytes = pkg({ parts: [slide(101, { shapes: tableShape() })] });
    const opts = { courseDir: dir, assetsDir: path.join(dir, 'assets'), reuseAssets: true };
    const r = importStory(bytes, opts), objects = r.doc.slides[0].objects;
    assert.equal(objects.length, 5);
    assert.deepEqual(objects.slice(1).map(o => [o.x, o.y, o.w, o.h]), [[20,200,200,50],[220,200,200,50],[20,250,200,50],[220,250,200,50]]);
    for (const cell of objects.slice(1)) {
      assert.equal(cell.style.padding, 10); assert.equal(cell.style.clip, true);
      assert.ok(cell.rich[0].runs[0].text.startsWith('Cell')); assert.equal(cell.locked, true);
      assert.equal(r.nodes.get(cell.id).derived, true);
    }
    const a = r.doc.assets.find(a => a.id === objects[0].image), svg = fs.readFileSync(path.join(dir, a.path), 'utf8');
    assert.equal((svg.match(/stroke=/g) ?? []).length, 1);
    assert.match(svg, /x="0.5" y="0.5" width="399" height="99"/);
    const prev = openStory(bytes, opts), title = structuredClone(prev.doc); title.title = 'Changed';
    assert.equal(saveStory(prev, prev.doc).buf.equals(bytes), true);
    const saved = saveStory(prev, title), part = readZip(bytes).names.find(n => /^story\/slides\/[^/]+\.xml$/.test(n));
    assert.equal(readZip(saved.buf).read(part).equals(readZip(bytes).read(part)), true);
    const next = structuredClone(prev.doc); next.slides[0].objects[1].rich[0].runs[0].text = 'Unsupported cell edit';
    assert.throws(() => saveStory(prev, next), e => e.errors?.some(x => x.code === 'story-unsupported'));
    const merged = importStory(pkg({ parts: [slide(101, { shapes: tableShape().replace('rowSpan="1"', 'rowSpan="2"') })] }), opts);
    assert.equal(merged.doc.slides[0].objects.length, 0);
    assert.ok(merged.report.items.some(i => i.kind === 'object.table'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('malformed or unbounded vector paths are reported without emitting broken assets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vector-bad-'));
  try {
    for (const extra of [geometry, validGeometry.replace('x="10"', 'x="NaN"'), validGeometry.replace('AAMDgw==', 'AA==')]) {
      const r = importStory(pkg({ parts: [slide(101, { shapes: obj('importedVector', 201, { extra }) })] }), { courseDir: dir, assetsDir: path.join(dir, 'assets'), reuseAssets: true });
      assert.equal(r.doc.slides[0].objects.length, 0);
      assert.ok(r.report.items.some(i => i.kind === 'object.importedVector'));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vector state artwork preserves separate fills and malformed state paths leave no generated assets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-vector-state-'));
  try {
    const options = { courseDir: dir, assetsDir: path.join(dir, 'assets'), reuseAssets: true };
    const hover = state('Hover', 301, 'importedVector', { fill: srgb('0000ff') });
    const shape = obj('importedVector', 201, { fill: srgb('ff0000'), extra: validGeometry, states: hover });
    const r = importStory(pkg({ parts: [slide(101, { shapes: shape })] }), options), o = r.doc.slides[0].objects[0];
    assert.ok(o.states.hover.image !== o.image);
    const asset = r.doc.assets.find(a => a.id === o.states.hover.image);
    assert.match(fs.readFileSync(path.join(dir, asset.path), 'utf8'), /fill="#0000ff"/);
    const bad = shape.replace(hover, hover.replace('</importedVector>', geometry + '</importedVector>'));
    const rejected = importStory(pkg({ parts: [slide(101, { shapes: bad })] }), options);
    assert.equal(rejected.doc.slides[0].objects.length, 0);
    assert.equal(rejected.doc.assets.filter(a => a.mime === 'image/svg+xml').length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
