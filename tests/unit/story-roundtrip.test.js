// a slide course stored in a .story file (lossless container, surgical XML edits, verify-after-write).
// Packages are SYNTHETIC (tests/fixtures/synthetic/story-builder.js) or our own writeStory output; no vendor file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZip } from '../../packages/import-story/zip-read.js';
import { rezip } from '../../packages/publisher/zip.js';
import { writeStory } from '../../packages/export-story/index.js';
import { parseXml, importStory } from '../../packages/import-story/index.js';
import { openStory, saveStory, canon, guidFor } from '../../packages/export-story/save.js';
import { applyAll } from '../../packages/core/index.js';
import { zip, pkg, ID, G, obj, slide, srgb, state, storyXml, slides as baseSlides } from '../fixtures/synthetic/story-builder.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-story-'));
const counter = () => { let n = 0; return () => `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };
const blank = (opts = {}) => writeStory({ title: 'Round trip', guid: counter(), now: new Date('2026-10-17T12:00:00Z'), ...opts });

// ---------- T1: container ----------
test('rezip with no changes is byte-identical (synthetic package, writeStory output, data descriptors, extra fields)', () => {
  for (const buf of [pkg(), blank({ text: 'Hello' }), zip([['a.txt', 'one'], ['b.txt', 'two two two', { method: 0, desc: true }], ['c.txt', 'x'.repeat(99), { extra: 'XTRA' }]])]) {
    const z = readZip(buf);
    assert.ok(Buffer.isBuffer(z.raw(z.names[0]).seg) && Buffer.isBuffer(z.raw(z.names[0]).cen));
    assert.deepEqual(rezip(buf, z), buf);
  }
});

test('rezip: a replaced entry round-trips through readZip; dropped and added entries; untouched bytes copied as is', () => {
  const buf = zip([['a.txt', 'one'], ['b.txt', 'two', { desc: true }], ['c.txt', 'three']]);
  const z = readZip(buf);
  const out = rezip(buf, z, { put: new Map([['a.txt', Buffer.from('ONE!')], ['d.txt', Buffer.from('four')]]), drop: new Set(['c.txt']) });
  const y = readZip(out);
  assert.deepEqual(y.names, ['a.txt', 'b.txt', 'd.txt']);
  assert.equal(y.read('a.txt').toString(), 'ONE!');
  assert.equal(y.read('b.txt').toString(), 'two');
  assert.equal(y.read('d.txt').toString(), 'four');
  assert.deepEqual(y.raw('b.txt').seg, z.raw('b.txt').seg, 'untouched entry (with its data descriptor) is the same bytes');
  assert.equal(y.raw('b.txt').cen.subarray(0, 42).compare(z.raw('b.txt').cen.subarray(0, 42)), 0, 'central record: only the offset changes');
});

// ---------- T2: parser offsets, importer nodes ----------
test('parseXml records offsets: s, oe (end of start tag), ce (start of close tag), e; BOM stripped first', () => {
  const src = '﻿<a x="1"><b y="2"/><c>t&lt;</c></a>', text = src.slice(1);
  const a = parseXml(src), [b, c] = a.kids;
  assert.deepEqual([a.s, a.oe, a.ce, a.e], [0, 9, text.length - 4, text.length]);
  assert.equal(text.slice(b.s, b.e), '<b y="2"/>');
  assert.equal(b.oe, b.e, 'self-closing: the start tag is the element');
  assert.equal(text.slice(c.oe, c.ce), 't&lt;');
  assert.equal(text.slice(c.s, c.e), '<c>t&lt;</c>');
});

test('importStory returns nodes for scenes, slides, layers, objects, triggers and variables; the mapping is unchanged', () => {
  const r = importStory(pkg(), { title: 'x' });
  const at = (id) => r.nodes.get(id);
  assert.equal(at(ID('sc', 30)).node.tag, 'scene');
  assert.equal(at(ID('sc', 30)).part, 'story/story.xml');
  assert.equal(at(ID('s', 101)).node.tag, 'sld');
  assert.equal(at(ID('s', 101)).part, 'story/slides/slide.xml');
  assert.equal(at(ID('o', 202)).node.tag, 'rect');
  assert.equal(at(ID('l', 301)).node.tag, 'sldLayer');
  assert.equal(at(ID('t', 1010)).node.tag, 'trig');
  assert.equal(at('var:score').node.attrs.name, 'score');
  assert.equal(at('var:bad_name').node.attrs.name, 'bad name', 'renamed variables map to their Storyline name');
  assert.ok([...r.nodes.keys()].some((k) => /^var:q-.*\.scorePercent$/.test(k)), 'quiz variables too');
  assert.deepEqual(r.doc, importStory(pkg(), { title: 'x' }).doc);
});

test('reuseAssets: a second import into the same assets folder keeps the extracted media; without it the import refuses', () => {
  const dir = tmp(), assetsDir = path.join(dir, 'assets', 'x');
  const first = importStory(pkg(), { assetsDir, courseDir: dir });
  assert.ok(first.doc.assets.length);
  assert.deepEqual(importStory(pkg(), { assetsDir, courseDir: dir, reuseAssets: true }).doc, first.doc);
  assert.throws(() => importStory(pkg(), { assetsDir, courseDir: dir }), /EEXIST/);
});

// ---------- T3-T8: saves ----------
const run = (buf, cmds) => {
  const prev = openStory(buf), r = applyAll(prev.doc, cmds);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return { prev, doc: r.doc, results: r.results, save: () => saveStory(prev, r.doc) };
};
/** Save, then re-read the new bytes with the importer itself (independent of saveStory's own check). */
const roundTrip = (buf, cmds) => {
  const x = run(buf, cmds), next = x.save();
  assert.deepEqual(canon(importStory(next.buf).doc), canon(x.doc));
  return { ...x, next };
};
const refusedWith = (code) => (e) => e.errors?.[0]?.code === code && typeof e.errors[0].path === 'string' && !!e.errors[0].hint;
const part = (buf, name) => readZip(buf).read(name).toString('utf8').replace(/^﻿/, '');
const el = (text, g) => { let hit; (function f(n) { if (n.attrs.g === g) hit ??= n; n.kids.forEach(f); })(parseXml(text)); return hit; };
const S1 = 'story/slides/slide.xml';

test('no-edit save is byte-identical (synthetic package and writeStory output)', () => {
  for (const buf of [pkg(), blank(), blank({ text: 'Hi' })]) {
    const prev = openStory(buf);
    assert.equal(saveStory(prev, structuredClone(prev.doc)).buf, buf);
  }
});

test('verify-after-write: an edit without a writer is refused with story-unsupported and a path; nothing is built', () => {
  const x = run(pkg(), [{ cmd: 'object.set', args: { id: ID('o', 202), hidden: true } }]);
  assert.throws(x.save, (e) => refusedWith('story-unsupported')(e) && e.errors[0].path.endsWith('/hidden'));
  roundTrip(pkg(), [{ cmd: 'object.add', args: { slide: ID('s', 102), type: 'text', text: 'new' } }]);
  roundTrip(pkg(), [{ cmd: 'slide.set', args: { id: ID('s', 102), duration: 1234 } }]);
});

test('a one-attribute edit changes only its part, and only inside the element (SC-3)', () => {
  const buf = pkg(), { next } = roundTrip(buf, [{ cmd: 'object.set', args: { id: ID('o', 202), x: 33 } }]);
  const a = readZip(buf), b = readZip(next.buf);
  assert.deepEqual(b.names, a.names);
  for (const n of a.names) if (n !== S1) assert.deepEqual(b.raw(n).seg, a.raw(n).seg, n);
  const t0 = part(buf, S1), t1 = part(next.buf, S1), loc = el(t0, G(202)).kids.find((k) => k.tag === 'loc');
  let i = 0; while (t0[i] === t1[i]) i++;
  let j = 0; while (t0.at(-1 - j) === t1.at(-1 - j)) j++;
  assert.ok(i >= loc.s && t0.length - j <= loc.e, 'the change lies inside <loc>');
  assert.match(t1.slice(loc.s), /^<loc l="33" t="0" r="133" b="50" \/>/);
});

const KINDS = [
  ['geometry', [{ cmd: 'object.set', args: { id: ID('o', 202), x: 50, y: 60, w: 120, h: 70 } }]],
  ['rotation off', [{ cmd: 'object.set', args: { id: ID('o', 202), rotation: 0 } }], (t) => assert.equal(el(t, G(202)).attrs.rot, '-1')],
  ['rotation', [{ cmd: 'object.set', args: { id: ID('o', 203), rotation: 30 } }]],
  ['name', [{ cmd: 'object.set', args: { id: ID('o', 203), name: 'Circle & co' } }]],
  ['alt (new element)', [{ cmd: 'object.set', args: { id: ID('o', 204), alt: 'A box' } }]],
  ['fill', [{ cmd: 'object.set', args: { id: ID('o', 202), style: { fill: '#123456' } } }], (t) => assert.match(t, /srgbClr val="123456"/)],
  ['fill removed', [{ cmd: 'object.set', args: { id: ID('o', 202), style: { fill: null } } }]],
  ['fill of a button (Normal state)', [{ cmd: 'object.set', args: { id: ID('o', 207), style: { fill: '#abcdef' } } }]],
  ['border', [{ cmd: 'object.set', args: { id: ID('o', 202), style: { border: '#00ff00' } } }]],
  ['text (plain)', [{ cmd: 'object.set', args: { id: ID('o', 201), text: 'Bye %msg% & <you>' } }]],
  ['text of a button (states follow)', [{ cmd: 'object.set', args: { id: ID('o', 207), text: 'Go now' } }]],
  ['text added to a shape', [{ cmd: 'object.set', args: { id: ID('o', 203), text: 'In the oval' } }]],
  ['rich text', [{ cmd: 'object.set', args: { id: ID('o', 201), rich: [{ runs: [{ text: 'Bold', b: true }, { text: ' and big', size: 30 }] }, { align: 'center', runs: [{ text: 'Second', color: '#ff0000' }] }] } }]],
  ['slide title', [{ cmd: 'slide.set', args: { id: ID('s', 101), title: 'Hi "there"' } }]],
  ['notes', [{ cmd: 'slide.set', args: { id: ID('s', 101), notes: 'Line 1\nLine <2>' } }]],
  ['notes added', [{ cmd: 'slide.set', args: { id: ID('s', 102), notes: 'New note' } }]],
  ['notes removed', [{ cmd: 'slide.set', args: { id: ID('s', 101), notes: null } }]],
  ['scene title', [{ cmd: 'scene.set', args: { id: ID('sc', 30), title: 'Start' } }]],
  ['course title', [{ cmd: 'course.set', args: { title: 'Renamed course' } }]],
  ['slide order', [{ cmd: 'slide.move', args: { id: ID('s', 102), index: 0 } }]],
  ['slide to another scene', [{ cmd: 'slide.move', args: { id: ID('s', 102), scene: ID('sc', 31), index: 1 } }]],
  ['scene order', [{ cmd: 'scene.move', args: { id: ID('sc', 31), index: 0 } }]],
  ['object order', [{ cmd: 'object.move', args: { id: ID('o', 203), index: 0 } }]],
  ['object to a layer', [{ cmd: 'object.move', args: { id: ID('o', 203), layer: ID('l', 301), index: 0 } }]],
  ['object to a layer, edited', [{ cmd: 'object.move', args: { id: ID('o', 204), layer: ID('l', 301) } }, { cmd: 'object.set', args: { id: ID('o', 204), x: 7, name: 'moved' } }]],
  ['layer order', [{ cmd: 'layer.move', args: { id: ID('l', 902), index: 0 } }]],
  ['trigger order (slide)', [{ cmd: 'trigger.move', args: { id: ID('t', 1022), index: 0 } }]],
  ['trigger order (object)', [{ cmd: 'trigger.move', args: { id: ID('t', 1012), index: 4 } }]],
  ['object removed', [{ cmd: 'object.remove', args: { id: ID('o', 203) } }], (t) => assert.ok(!t.includes(G(203)))],
  ['trigger removed', [{ cmd: 'trigger.remove', args: { id: ID('t', 1021) } }]],
  ['layer removed (with the triggers that showed it)', [{ cmd: 'layer.remove', args: { id: ID('l', 301), force: true } }]],
  ['several edits in one batch', [{ cmd: 'object.set', args: { id: ID('o', 201), x: 1, text: 'One' } }, { cmd: 'object.move', args: { id: ID('o', 201), index: 3 } }, { cmd: 'slide.set', args: { id: ID('s', 101), title: 'T' } }, { cmd: 'trigger.remove', args: { id: ID('t', 1010) } }]],
];
for (const [kind, cmds, check] of KINDS) {
  test(`round trip: ${kind} (SC-1)`, () => {
    const { next } = roundTrip(pkg(), cmds);
    check?.(part(next.buf, S1));
  });
}

test('round trip: a slide removed drops its part, relationship and content type (and the trigger that jumped to it)', () => {
  const { next, doc } = roundTrip(pkg(), [{ cmd: 'slide.remove', args: { id: ID('s', 102), force: true } }]);
  assert.ok(!doc.slides.some((s) => s.id === ID('s', 102)));
  assert.ok(!readZip(next.buf).has('story/slides/slide2.xml'));
  assert.ok(!part(next.buf, 'story/_rels/story.xml.rels').includes('slide2.xml'));
  assert.ok(!part(next.buf, 'story/story.xml').includes('<sldId>R2</sldId>'));
});

test('round trip: a scene with its slides removed', () => {
  roundTrip(pkg(), [{ cmd: 'scene.remove', args: { id: ID('sc', 30), force: true } }]);
});

test('native duplicates preserve opaque fields and remap internal GUIDs before later edits', () => {
  const raw = obj('textBox', 201, { plain: 'Original', extra: `<opaque localG="${G(201)}" value="keep" />` });
  const buf = pkg({ parts: [slide(101, { shapes: raw }), ...baseSlides().slice(1)] });
  const copied = roundTrip(buf, [
    { cmd: 'object.duplicate', args: { ids: [ID('o', 201)], newIds: ['o-preserved'], dx: 25 } },
    { cmd: 'object.set', args: { id: 'o-preserved', text: 'Changed copy' } },
    { cmd: 'slide.duplicate', args: { id: ID('s', 101), newId: 's-preserved', title: 'Copied slide' } },
  ]).next;
  const original = el(part(copied.buf, S1), G(201));
  const clone = copied.nodes.get('o-preserved').node;
  assert.equal(clone.kids.find(n => n.tag === 'opaque').attrs.localG, clone.attrs.g);
  assert.equal(original.kids.find(n => n.tag === 'opaque').attrs.localG, G(201));
  assert.notEqual(clone.attrs.verG, original.attrs.verG);
  const copySlide = copied.nodes.get('s-preserved');
  assert.match(part(copied.buf, copySlide.part), /value="keep"/);
});

test('removal of something still referenced in the file is refused with story-referenced (FR-6)', () => {
  // Known quiz references are reconciled; opaque native references must still protect the slide.
  roundTrip(pkg(), [{ cmd: 'slide.remove', args: { id: ID('s', 108), force: true } }]);
  const story = storyXml().replace('</story>', `<opaque targetG="${G(108)}" /></story>`);
  assert.throws(run(pkg({ story }), [{ cmd: 'slide.remove', args: { id: ID('s', 108), force: true } }]).save, refusedWith('story-referenced'));
});

test('text: style attributes the model does not hold survive a text edit; changed run attributes are written (T6)', () => {
  const styled = '<Document xmlns:xsi="x"><Content><Block><Style Justification="Center" LineSpacing="20"><ListStyle ListType="None" /></Style>'
    + '<Span Text="Old"><Style FontSize="20" LinkColor="#123456" DisplayCase="AsIs"><Shadow Offset="0x0" Color="#FFFFFF,00" /></Style></Span></Block></Content></Document>';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const buf = pkg({ parts: [slide(101, { shapes: obj('textBox', 201, { extra: `<text>${esc(styled)}</text>` }) }), ...baseSlides().slice(1)] });
  const prev = openStory(buf);
  const o = prev.doc.slides[0].objects[0];
  assert.deepEqual(o.rich, [{ align: 'center', runs: [{ text: 'Old', size: 20 * prev.textScale }] }]);
  const save = (rich) => saveStory(prev, applyAll(prev.doc, [{ cmd: 'object.set', args: { id: o.id, rich } }]).doc);
  const t = el(part(save([{ align: 'center', runs: [{ text: 'New', size: 20 }] }]).buf, S1), G(201));
  const saved = t.kids.find((k) => k.tag === 'text').text;
  for (const s of ['Text="New"', 'LinkColor="#123456"', '<Shadow Offset="0x0"', 'LineSpacing="20"', '<ListStyle ListType="None" />', 'Justification="Center"']) assert.ok(saved.includes(s), s);
  assert.equal(t.kids.find((k) => k.tag === 'plain').text, 'New');
  const bold = el(part(save([{ align: 'center', runs: [{ text: 'New', size: 20, b: true }] }]).buf, S1), G(201)).kids.find((k) => k.tag === 'text').text;
  assert.ok(bold.includes('FontIsBold="True"') && bold.includes('LinkColor="#123456"'));
});

test('state snapshots follow geometry, rotation, text and fill they do not override', () => {
  const { next } = roundTrip(pkg(), [{ cmd: 'object.set', args: { id: ID('o', 207), w: 300, h: 90, rotation: 10, text: 'Next', style: { fill: '#010203' } } }]);
  const btn = el(part(next.buf, S1), G(207));
  const kidOf = (n, tag) => n.kids.find((k) => k.tag === tag);
  const of = (name) => kidOf(kidOf(btn, 'stateLst').kids.find((s) => s.attrs.name === name), 'shapeLst').kids[0];
  assert.deepEqual(['r', 'b'].map((k) => kidOf(of('Normal'), 'loc').attrs[k]), ['300', '90'], '0-based snapshot loc takes the new size');
  assert.equal(kidOf(of('Normal'), 'plain').text, 'Next');
  assert.equal(kidOf(of('Visited'), 'plain').text, 'Next', 'Visited had the same text: it follows');
  assert.equal(kidOf(of('Hover'), 'plain').text, 'Go!', 'Hover overrides the text: kept');
  assert.match(part(next.buf, S1), /srgbClr val="010203"/);
  assert.match(part(next.buf, S1), /srgbClr val="0000FF"/, 'Hover overrides the fill: kept');
});

test('inherited master/layout objects are never written: editing or removing them is refused with story-inherited (FR-7)', () => {
  const story = `<story id="${G(1)}"><mediaLst><mediaLst /></mediaLst><sceneLst><scene g="${G(30)}"><sldIdLst><sldId>R1</sldId></sldIdLst></scene></sceneLst></story>`;
  const buf = pkg({ story, parts: [slide(101, { shapes: obj('textBox', 201, { plain: 'Own' }), attrs: `layoutG="${G(90)}"` })], extra: [
    ['story/slideLayouts/slideLayout2.xml', `<layout g="${G(90)}" internalG="${G(91)}"><bg /><shapeLst>${obj('rect', 601, { fill: srgb('101010') })}</shapeLst></layout>`],
    ['story/slideMasters/slideMaster.xml', `<master g="${G(92)}"><bg /><shapeLst /><layoutIdLst><sldId>RL</sldId></layoutIdLst></master>`],
    ['story/slideMasters/_rels/slideMaster.xml.rels', '<Relationships><Relationship Type="slideLayout" Id="RL" Target="/story/slideLayouts/slideLayout2.xml"/></Relationships>'],
  ] });
  const locked = openStory(buf).doc.slides[0].objects[0];
  assert.equal(locked.locked, true);
  assert.throws(run(buf, [{ cmd: 'object.set', args: { id: locked.id, x: 5 } }]).save, refusedWith('story-inherited'));
  assert.throws(run(buf, [{ cmd: 'object.remove', args: { id: locked.id } }]).save, refusedWith('story-inherited'));
  roundTrip(buf, [{ cmd: 'object.set', args: { id: ID('o', 201), x: 5 } }]);
});

test('ids survive a save: guidFor keeps the id hex; scene.add round-trips with generated and given ids (FR-8)', () => {
  assert.match(guidFor('sc-0123456789ab'), /^01234567-89ab-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const x = run(pkg(), [{ cmd: 'scene.add', args: { title: 'Extra' } }, { cmd: 'scene.add', args: { id: 'sc-00000000abcd', title: 'Moved in', index: 0 } }, { cmd: 'slide.move', args: { id: ID('s', 102), scene: 'sc-00000000abcd' } }]);
  assert.match(x.results[0].id, /^sc-[0-9a-f]{12}$/);
  const next = x.save();
  assert.deepEqual(next.doc.scenes.map((s) => s.id).filter((id) => [x.results[0].id, 'sc-00000000abcd'].includes(id)), ['sc-00000000abcd', x.results[0].id]);
  assert.deepEqual(next.doc.scenes[0].slides, [ID('s', 102)]);
  assert.ok(roundTrip(pkg(), [{ cmd: 'scene.add', args: { id: 'sc-intro', title: 'Named' } }]).next.doc.scenes.some(s => s.id === 'sc-intro'));
});

test('writeStory output edits round-trip (course title, text, geometry)', () => {
  const buf = blank({ text: 'Hello' }), o = openStory(buf).doc.slides[0].objects[0];
  roundTrip(buf, [{ cmd: 'course.set', args: { title: 'New' } }, { cmd: 'object.set', args: { id: o.id, text: 'Changed', x: 10, w: 400 } }]);
});
