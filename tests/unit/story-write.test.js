// SC-1/SC-2: the minimal .story writer emits the contract of
// The required names below are copied from that spec (what Storyline's loader reads without a presence check),
// not from the writer, so the test is an independent check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeStory } from '../../packages/export-story/index.js';
import { elements } from '../../packages/export-story/elements.js';
import { readZip } from '../../packages/import-story/zip-read.js';
import { parseXml, storyId, importStory } from '../../packages/import-story/index.js';

const counter = () => { let n = 0; return () => `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`; };
const NOW = new Date('2026-10-17T12:00:00Z');
const build = (opts = {}) => writeStory({ title: 'Probe & <title>', guid: counter(), now: NOW, ...opts });
const open = (buf) => {
  const zip = readZip(buf);
  const xml = (name) => parseXml(zip.read(name).toString('utf8'), name);
  return { zip, xml };
};
const kid = (n, tag) => n.kids.find((k) => k.tag === tag);
const all = (n, tag, out = []) => { for (const k of n.kids) { if (k.tag === tag) out.push(k); all(k, tag, out); } return out; };

test('native borders, lines and arrows emit numeric scales and native enum spellings', () => {
  const T = elements({ w: 720, h: 540 }, counter());
  for (const type of [{ type: 'text', text: 'Border' }, { type: 'shape', shape: 'line' }, { type: 'shape', shape: 'arrow' }]) {
    const shape = parseXml(T.object({ ...type, x: 10, y: 20, w: 100, h: 40, style: { border: '#123456', borderWidth: 2 } }));
    const line = kid(kid(shape, 'bG'), 'lineStyle'), arrow = kid(line, 'arrow');
    // both scales are floats, and these enums do not use DrawingML spellings.
    assert.equal(Number(line.attrs.scale), 1, type.type + '/' + type.shape);
    assert.equal(Number(arrow.attrs.scale), 1);
    assert.equal(line.attrs.join, 'mtr');
    assert.equal(line.attrs.dash, 'sld');
    assert.equal(kid(arrow, 'begin').attrs.sz, 'size5');
    assert.equal(kid(arrow, 'end').attrs.sz, 'size5');
    assert.equal(kid(arrow, 'end').attrs.type, type.shape === 'arrow' ? 'triangle' : 'none');
  }
});
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function requireNames(node, attrs, elements, where) {
  for (const a of attrs) assert.ok(a in node.attrs, `${where}: missing @${a}`);
  for (const e of elements) assert.ok(kid(node, e), `${where}: missing <${e}>`);
}
// Spec (SlideBase, Slide, TimeManagerCollectionItem, TimeCollectionItem, CollectionItem).
const SHEET_ATTRS = ['g', 'verG', 'id', 'state', 'showMasterSp', 'resetMode', 'layoutG', 'stateG', 'showPlay', 'clrScheme', 'assetG', 'backVis', 'hideToc'];
const SHEET_ELEMENTS = ['tmProps', 'tmCtxLst', 'sz', 'bg', 'shapeLst', 'trigLst', 'trans', 'note'];

const PARTS = [
  '[Content_Types].xml', '_rels/.rels', 'docProps/app.xml',
  'story/playerProps.xml', 'story/story.xml', 'story/_rels/story.xml.rels', 'story/slides/slide.xml',
  'story/theme/theme.xml', 'story/theme/_rels/theme.xml.rels',
  'story/slideMasters/slideMaster.xml', 'story/slideMasters/_rels/slideMaster.xml.rels',
  'story/slideLayouts/slideLayout.xml',
];

for (const variant of ['blank', 'text']) {
  const opts = variant === 'text' ? { text: 'Hello <world> & "friends"\nSecond line' } : {};

  test(`${variant}: package parts, content types and relationships `, () => {
    const { zip, xml } = open(build(opts));
    const core = zip.names.filter((n) => /^package\/services\/metadata\/core-properties\/[0-9a-f]{32}\.psmdcp$/.test(n));
    assert.equal(core.length, 1);
    assert.deepEqual([...zip.names].sort(), [...PARTS, ...core].sort(), 'exactly the original scaffold and player settings; no vendor template');

    const types = xml('[Content_Types].xml');
    const defaults = new Map(types.kids.filter((k) => k.tag === 'Default').map((k) => [k.attrs.Extension, k.attrs.ContentType]));
    const overrides = new Map(types.kids.filter((k) => k.tag === 'Override').map((k) => [k.attrs.PartName, k.attrs.ContentType]));
    assert.equal(defaults.get('xml'), 'application/story+xml');
    assert.equal(defaults.get('rels'), 'application/vnd.openxmlformats-package.relationships+xml');
    assert.equal(defaults.get('psmdcp'), 'application/vnd.openxmlformats-package.core-properties+xml');
    assert.equal(overrides.get('/story/slides/slide.xml'), 'application/slide+xml');
    assert.equal(overrides.get('/story/theme/theme.xml'), 'application/theme+xml');
    assert.equal(overrides.get('/story/slideMasters/slideMaster.xml'), 'application/slideMaster+xml');
    assert.equal(overrides.get('/story/slideLayouts/slideLayout.xml'), 'application/slideLayout+xml');
    assert.equal(overrides.get('/docProps/app.xml'), 'application/extended-properties+xml');
    for (const name of zip.names) {
      if (name === '[Content_Types].xml') continue;
      assert.ok(overrides.has('/' + name) || defaults.has(name.split('.').pop()), `no content type for ${name}`);
    }

    // Every relationship target exists; IDs are unique valid XML IDs.
    for (const rels of zip.names.filter((n) => n.endsWith('.rels'))) {
      const ids = new Set();
      for (const r of xml(rels).kids) {
        assert.match(r.attrs.Id, /^[A-Za-z_][\w.-]*$/);
        assert.ok(!ids.has(r.attrs.Id), `duplicate ${r.attrs.Id} in ${rels}`); ids.add(r.attrs.Id);
        assert.ok(zip.has(r.attrs.Target.replace(/^\//, '')), `${rels}: missing target ${r.attrs.Target}`);
      }
    }
    const pkg = xml('_rels/.rels').kids;
    assert.equal(pkg.find((r) => r.attrs.Type === 'main').attrs.Target, '/story/story.xml');
    assert.ok(pkg.find((r) => r.attrs.Type === 'extended-properties'));
    assert.equal(pkg.find((r) => r.attrs.Type.endsWith('/metadata/core-properties')).attrs.Target, '/' + core[0]);

    const storyRels = xml('story/_rels/story.xml.rels').kids;
    assert.equal(storyRels.find((r) => r.attrs.Type === 'theme').attrs.Id, 'rId6', 'the loader looks the theme up as rId6');
    const sld = xml('story/slides/slide.xml');
    assert.equal(storyRels.find((r) => r.attrs.Type === 'slide').attrs.Id, 'R' + storyId(sld.attrs.g));
    const master = xml('story/slideMasters/slideMaster.xml'), layout = xml('story/slideLayouts/slideLayout.xml');
    assert.equal(xml('story/theme/_rels/theme.xml.rels').kids[0].attrs.Id, 'R' + storyId(master.attrs.internalG));
    assert.equal(xml('story/slideMasters/_rels/slideMaster.xml.rels').kids[0].attrs.Id, 'R' + storyId(layout.attrs.internalG));

    const props = xml(core[0]);
    assert.equal(kid(props, 'version').text, '3.0.4.0');
    assert.equal(kid(props, 'revision').text, '3.0.4.0');
    assert.equal(kid(props, 'dc:title').text, 'Probe & <title>');
    assert.equal(kid(props, 'dcterms:created').attrs['xsi:type'], 'dcterms:W3CDTF');
  });

  test(`${variant}: story, theme, master, layout and slide carry the loader's required names ,`, () => {
    const { xml } = open(build(opts));
    const story = xml('story/story.xml');
    requireNames(story, ['id', 'pG', 'defRadStyle', 'defChkStyle'], ['mediaLst', 'varLst', 'sceneLst'], 'story');
    const scene = kid(kid(story, 'sceneLst'), 'scene');
    requireNames(scene, ['g', 'verG', 'primaryId', 'sceneType', 'collapse'], ['sldIdLst'], 'scene');
    const sz = kid(all(story, 'prop').find((p) => p.attrs.id === '15'), 'sz');
    assert.deepEqual([sz.attrs.w, sz.attrs.h], ['720', '540']);

    const storyRels = xml('story/_rels/story.xml.rels').kids;
    assert.equal(kid(kid(scene, 'sldIdLst'), 'sldId').text, storyRels.find((r) => r.attrs.Type === 'slide').attrs.Id);

    const theme = xml('story/theme/theme.xml');
    requireNames(theme, ['g', 'verG', 'displayIdx', 'type'], ['assetLst', 'mstrIdLst'], 'theme');
    assert.equal(kid(kid(theme, 'mstrIdLst'), 'sldId').text, xml('story/theme/_rels/theme.xml.rels').kids[0].attrs.Id);

    const master = xml('story/slideMasters/slideMaster.xml');
    assert.equal(master.tag, 'master');
    requireNames(master, [...SHEET_ATTRS, 'internalG', 'copyG', 'useCnt', 'preserve', 'role'], [...SHEET_ELEMENTS, 'fonts', 'layoutIdLst', 'clrLst'], 'master');
    assert.equal(master.attrs.role, 'Content');
    const colors = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink', 'control1', 'custom1', 'custom2', 'correct', 'incorrect'];
    for (const c of colors) assert.match(kid(kid(kid(master, 'clrLst'), c), 'srgbClr').attrs.val, /^[0-9A-F]{6}$/, `clrLst/${c}`);
    assert.equal(kid(kid(master, 'layoutIdLst'), 'sldId').text, xml('story/slideMasters/_rels/slideMaster.xml.rels').kids[0].attrs.Id);

    const layout = xml('story/slideLayouts/slideLayout.xml');
    assert.equal(layout.tag, 'layout');
    requireNames(layout, [...SHEET_ATTRS, 'internalG', 'copyG', 'useCnt', 'role'], SHEET_ELEMENTS, 'layout');
    assert.equal(layout.attrs.role, 'Blank');
    assert.equal(kid(layout, 'shapeLst').kids.length, 0);

    const sld = xml('story/slides/slide.xml');
    assert.equal(sld.tag, 'sld');
    requireNames(sld, [...SHEET_ATTRS, 'advMode', 'linkType', 'showInReview', 'zoomTransDur', 'useNextTrans'], SHEET_ELEMENTS, 'sld');
    assert.equal(sld.attrs.layoutG, layout.attrs.internalG, 'layoutG resolves to the layout');

    // Timeline items : tmProps and every time-layer context.
    for (const n of [sld, master, layout, ...all(sld, 'textBox')]) {
      requireNames(kid(n, 'tmProps'), ['cur', 'min', 'visible', 'hideAll'], [], `${n.tag}/tmProps`);
      const list = kid(n, 'tmCtxLst');
      assert.ok('version' in list.attrs);
      for (const c of list.kids) requireNames(c, ['g', 'verG', 'start', 'dur', 'min', 'max', 'hasMax', 'alwysShw', 'untilEnd', 'assetStart'], [], `${n.tag}/${c.tag}`);
    }

    // Navigation triggers with every required data block .
    const trigs = kid(sld, 'trigLst').kids;
    assert.deepEqual(trigs.map((t) => [kid(t, 'data').attrs.event, kid(t, 'data').attrs.actSubType]).sort(), [['OnClick', 'prev'], ['OnNextButtonClick', 'next']]);
    for (const t of trigs) {
      requireNames(t, ['g', 'verG', 'type', 'edit', 'group'], ['data', 'condLst'], 'trig');
      const d = kid(t, 'data');
      requireNames(d, ['enabled', 'actSubType'], ['keyPress', 'slide', 'scene', 'shape', 'sldLayer', 'video', 'audio', 'other', 'interaction', 'frame'], 'trig/data');
      requireNames(kid(d, 'keyPress'), ['keys', 'case'], [], 'keyPress');
      requireNames(kid(d, 'slide'), ['showNav'], [], 'slide');
      requireNames(kid(d, 'shape'), ['stateInclude', 'statesNot'], ['stateLst', 'dropLst', 'hoverLst'], 'shape');
      requireNames(kid(d, 'other'), ['op', 'useVar', 'dblVal'], [], 'other');
      requireNames(kid(d, 'frame'), ['restore'], [], 'frame');
      // the player-button binding is frame@actionG = the fixed Next/Previous button GUIDs, as in every native slide.
      assert.equal(kid(d, 'frame').attrs.actionG, { next: '0ec0db78-2e1d-4919-bde6-6824587f77c4', prev: 'ae475cc5-601c-414e-82c1-df8dc7d39471' }[d.attrs.actSubType]);
    }

    // Every collection item has a GUID g and verG ; GUIDs that are not links are unique.
    const own = [];
    for (const r of [story, theme, master, layout, sld]) {
      const stack = [r];
      while (stack.length) { const n = stack.pop(); if ('verG' in n.attrs) { assert.match(n.attrs.g, GUID, `${n.tag}@g`); assert.match(n.attrs.verG, GUID, `${n.tag}@verG`); own.push(n.attrs.g, n.attrs.verG); } stack.push(...n.kids); }
    }
    assert.equal(new Set(own).size, own.length, 'fresh GUIDs everywhere');
  });
}

test('text: the text box carries every required name and plain equals the rich span text ', () => {
  const { xml } = open(build({ text: 'Hello <world> & "friends"\nSecond line' }));
  const tb = all(xml('story/slides/slide.xml'), 'textBox');
  assert.equal(tb.length, 1);
  const b = tb[0];
  requireNames(b, ['g', 'verG', 'id', 'state', 'zOrder', 'handCur', 'rot', 'acc', 'autoFit', 'shdw', 'wrap', 'rtl', 'defHorzAlign', 'horzAlign', 'vertAlign', 'textDir'],
    ['tmProps', 'tmCtxLst', 'childLst', 'trigLst', 'bG', 'sldSz', 'loc', 'text', 'textMargin', 'bounds', 'resize', 'parLst', 'plain'], 'textBox');
  requireNames(kid(b, 'textMargin'), ['l', 't', 'r', 'b'], [], 'textMargin');
  requireNames(kid(b, 'bounds'), ['l', 't', 'r', 'b'], [], 'bounds');
  requireNames(kid(b, 'resize'), ['fontSz'], [], 'resize');
  const doc = parseXml(kid(b, 'text').text, 'rich');
  assert.equal(doc.tag, 'Document');
  const blocks = kid(doc, 'Content').kids;
  assert.deepEqual(blocks.map((bl) => all(bl, 'Span').map((s) => s.attrs.Text).join('')), ['Hello <world> & "friends"', 'Second line']);
  assert.equal(kid(b, 'plain').text, 'Hello <world> & "friends"\nSecond line');
  assert.equal(kid(b, 'sldSz').attrs.w, '720');
});

test('the importer reads both outputs (SC-2)', () => {
  const blank = importStory(build(), { title: 'blank' });
  assert.equal(blank.doc.slides.length, 1);
  const text = importStory(build({ text: 'Imported back' }), { title: 'text' });
  assert.equal(text.doc.slides.length, 1);
  assert.ok(JSON.stringify(text.doc.slides[0].objects).includes('Imported back'));
});

test('same inputs give the same bytes; random GUIDs by default are v4 and distinct per file', () => {
  assert.deepEqual(build({ text: 'x' }), build({ text: 'x' }));
  const a = open(writeStory({ title: 'a' })).xml('story/slides/slide.xml').attrs.g;
  const b = open(writeStory({ title: 'a' })).xml('story/slides/slide.xml').attrs.g;
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

test('text with invalid XML characters is refused', () => {
  assert.throws(() => build({ text: 'bad \u0001 char' }), /invalid XML characters/);
});

// Codex review 008 #1: XML readers normalize literal tab/CR/LF in attribute values (and CR in text) to spaces/LF,
// so they must be written as character references.
test('tabs and carriage returns survive a standards-compliant XML reader (review 008 #1)', () => {
  const { xml } = open(build({ title: 'a\rb', text: 'x\ty' }));
  const tb = all(xml('story/slides/slide.xml'), 'textBox')[0];
  const rich = kid(tb, 'text').text;
  assert.match(rich, /Text="x&#x9;y"/, 'the tab inside Span@Text is a character reference');
  assert.equal(parseXml(rich).kids[0].kids[0].kids[0].attrs.Text, 'x\ty');
  const { zip } = open(build({ title: 'a\rb' }));
  const core = zip.names.find((n) => n.endsWith('.psmdcp'));
  assert.match(zip.read(core).toString('utf8'), /<dc:title>a&#xD;b<\/dc:title>/);
});

// Codex review 008 #2: the size must be finite, numeric and large enough for a valid text frame.
test('invalid slide sizes are refused before any part is generated (review 008 #2)', () => {
  for (const size of [{ w: 720 }, { w: 'abc', h: 540 }, { w: 1, h: 1 }, { w: Infinity, h: 540 }, { w: -720, h: 540 }, { w: 720.5, h: 540 }]) {
    assert.throws(() => build({ text: 'x', size }), /size/, JSON.stringify(size));
  }
  assert.doesNotThrow(() => build({ text: 'x', size: { w: 1920, h: 1080 } }));
});
