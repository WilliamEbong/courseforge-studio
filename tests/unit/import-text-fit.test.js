import test from 'node:test';
import assert from 'node:assert/strict';
import { importStory } from '../../packages/import-story/index.js';
import { openStory, saveStory } from '../../packages/export-story/save.js';
import { readZip } from '../../packages/import-story/zip-read.js';
import { validate } from '../../packages/schema/index.js';
import { obj, slide, pkg, state, G, storyXml } from '../fixtures/synthetic/story-builder.js';

const bounds = '<bounds l="10" t="5" r="210" b="35"/><textMargin l="-1" t="-1" r="-1" b="-1"/><margins l="0" t="0" r="0" b="0"/>';
const shape = (attrs = 'autoFit="shrink" wrap="true"', extra = bounds, states = '') => obj('textBox', 201, { at: [20,20,240,60], text: 'A longer synthetic title that needs fitting', attrs, extra, states });
const bytes = () => pkg({ parts: [slide(101, { shapes: shape() })] });

test('direct title-placeholder defaults use the loaded project flag and inherit wrapping', () => {
  const make = modern => pkg({ story:storyXml().replace('<story ', `<story UseNewAutofitDefaults="${modern}" `),
    parts:[slide(101,{attrs:`layoutG="${G(90)}"`,shapes:shape('autoFit="def" wrap="none"',bounds+`<ph g="${G(301)}" type="title"/>`)})],
    extra:[
      ['story/theme/theme.xml',`<theme UseNewAutofitDefaults="${!modern}"><mstrIdLst><sldId>M</sldId></mstrIdLst></theme>`],
      ['story/theme/_rels/theme.xml.rels','<Relationships><Relationship Type="slideMaster" Id="M" Target="../slideMasters/master.xml"/></Relationships>'],
      ['story/slideMasters/master.xml','<master><layoutIdLst><sldId>L</sldId></layoutIdLst></master>'],
      ['story/slideMasters/_rels/master.xml.rels','<Relationships><Relationship Type="slideLayout" Id="L" Target="../slideLayouts/layout.xml"/></Relationships>'],
      ['story/slideLayouts/layout.xml',`<layout g="${G(90)}"><shapeLst>${obj('ph',301,{attrs:'autoFit="def" wrap="none"',extra:'<ph type="title"/>'})}</shapeLst></layout>`],
    ]});
  const legacy=importStory(make(false)).doc.slides[0].objects[0];
  assert.deepEqual(legacy.style.textFit,{x:10,y:5,w:200,h:30,wrap:true});
  assert.equal(importStory(make(true)).doc.slides[0].objects[0].style.textFit,undefined);
});

test('explicit stateless native shrink preserves nominal size, wrapping and local text frame', () => {
  const { doc } = importStory(bytes());
  assert.deepEqual(doc.slides[0].objects[0].style.textFit, { x:10, y:5, w:200, h:30, wrap:true });
  assert.equal(doc.slides[0].objects[0].style.fontSize, 16);
  assert.deepEqual(validate(doc), []);
  const nowrap = importStory(pkg({ parts: [slide(101, { shapes: shape('autoFit="shrink" wrap="false"') })] }));
  assert.equal(nowrap.doc.slides[0].objects[0].style.textFit.wrap, false);
  for (const s of [shape('autoFit="none"'), shape('autoFit="resize"'), shape('autoFit="def"')]) {
    assert.equal(importStory(pkg({ parts: [slide(101, { shapes:s })] })).doc.slides[0].objects[0].style.textFit, undefined);
  }
});

test('invalid shrink margins and state inheritance remain reported instead of guessed', () => {
  for (const s of [shape(undefined, '<textMargin l="999"/>'), shape(undefined, '<margins l="NaN"/>'), shape(undefined, bounds, state('Normal', 500, 'textBox', { plain:'State' }))]) {
    const r = importStory(pkg({ parts: [slide(101, { shapes:s })] }));
    assert.equal(r.doc.slides[0].objects[0].style.textFit, undefined);
    assert.ok(r.report.items.some(i => i.kind === 'text.autofit'));
  }
  const cached=importStory(pkg({parts:[slide(101,{shapes:shape(undefined,bounds.replace('r="210"','r="999"'))})]}));
  assert.deepEqual(cached.doc.slides[0].objects[0].style.textFit,{x:10,y:5,w:200,h:30,wrap:true});
  const inset=importStory(pkg({parts:[slide(101,{shapes:shape(undefined,'<textMargin l="20" t="3" r="10" b="2"/><margins l="2" t="2" r="4" b="4"/>')})]}));
  assert.deepEqual(inset.doc.slides[0].objects[0].style.textFit,{x:22,y:5,w:184,h:29,wrap:true});
});

test('native shrink no-edit/title/text saves preserve fitting source and authored sizes', () => {
  const original = bytes(), prev = openStory(original);
  assert.ok(saveStory(prev, prev.doc).buf.equals(original));
  const title = structuredClone(prev.doc); title.title = 'New course title';
  const titled = saveStory(prev, title);
  const part = readZip(original).names.find(n => /^story\/slides\/[^/]+\.xml$/.test(n));
  assert.ok(readZip(titled.buf).read(part).equals(readZip(original).read(part)));
  const next = structuredClone(prev.doc); const o = next.slides[0].objects[0];
  o.text = 'Edited title with a different length'; delete o.rich;
  const saved = saveStory(prev, next), imported = importStory(saved.buf).doc.slides[0].objects[0];
  assert.deepEqual(imported.style.textFit, { x:10, y:5, w:200, h:30, wrap:true });
  assert.equal(imported.text, o.text); assert.equal(imported.style.fontSize, o.style.fontSize);
});

test('native shrink resizing refuses until inverse local text bounds are supported', () => {
  const prev=openStory(bytes()), next=structuredClone(prev.doc); next.slides[0].objects[0].w+=100;
  assert.throws(()=>saveStory(prev,next),e=>e.errors?.some(x=>x.code==='story-unsupported'));
});
