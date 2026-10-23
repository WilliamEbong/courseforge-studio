import test from 'node:test';
import assert from 'node:assert/strict';
import { importStory } from '../../packages/import-story/index.js';
import { validate } from '../../packages/schema/index.js';
import { G, ID, esc, obj, slide, pkg, trig } from '../fixtures/synthetic/story-builder.js';

const richText = body => `<text>${esc(`<Document><Content>${body}</Content></Document>`)}</text>`;
const span = (text, style = '') => `<Span Text="${esc(text)}"><Style ${style}/></Span>`;
function packageOf(shapes, { master = true, bg = '' } = {}) {
  const story = `<story id="${G(1)}"><sceneLst><scene g="${G(30)}"><sldIdLst><sldId>R1</sldId></sldIdLst></scene></sceneLst></story>`;
  return pkg({ story, parts: [slide(101, { shapes, bg, attrs: `layoutG="${G(90)}"` })], extra: master ? [
    ['story/slideLayouts/slideLayout2.xml', `<layout g="${G(90)}" internalG="${G(91)}"/>`],
    ['story/slideMasters/slideMaster.xml', `<master g="${G(92)}"><clrLst><dk1><srgbClr val="102030"/></dk1><accent1><srgbClr val="204060"/></accent1></clrLst><fonts major="Georgia" minor="Arial"/><layoutIdLst><sldId>RL</sldId></layoutIdLst></master>`],
    ['story/slideMasters/_rels/slideMaster.xml.rels', '<Relationships><Relationship Type="slideLayout" Id="RL" Target="/story/slideLayouts/slideLayout2.xml"/></Relationships>'],
  ] : [] });
}

test('rich import preserves mixed runs, paragraph alignment, bullets, numbering, theme fonts and a hyperlink', () => {
  const body = `<Block><Style Justification="Center"/><Span Text="Normal "><Style FontFamily="+minor" FontSize="20" ForegroundColor="dk1,00"/></Span>${span('bold', 'FontIsBold="True" FontIsItalic="True" FontIsUnderline="True" FontIsStrikeout="True" ForegroundColor="#ABCDEF"')}</Block>`
    + `<Block><Style ListLevel="2"><ListStyle ListType="Bullet"/></Style>${span('Bullet')}</Block>`
    + `<Block><Style Justification="Justify" ListLevel="1"><ListStyle ListType="ListNumberedAsArabic" Start="1"/></Style>${span('Link', 'FontFamily="+major" LinkId="L1"')}</Block>`;
  const extra = richText(body) + `<hLinkLst><item id="L1"><txtHlink enabled="true" trigG="${G(500)}"/></item></hLinkLst>`;
  const { doc, report } = importStory(packageOf(obj('textBox', 201, { extra, trigs: trig(500, 'OnClick', 'jumpToFileUrl', { tag: 'hlinkTrig', other: 'open="https://example.com/guide"' }) })));
  assert.deepEqual(validate(doc), []);
  assert.deepEqual(doc.slides[0].objects[0].rich, [
    { align: 'center', runs: [{ text: 'Normal ', font: 'Arial', size: 20 * (4 / 3), color: '#102030' }, { text: 'bold', b: true, i: true, u: true, s: true, color: '#abcdef' }] },
    { list: 'bullet', level: 2, runs: [{ text: 'Bullet' }] },
    { list: 'number', level: 1, align: 'justify', runs: [{ text: 'Link', font: 'Georgia', link: 'https://example.com/guide' }] },
  ]);
  assert.equal(doc.slides[0].objects[0].text, 'Normal bold\nBullet\nLink');
  assert.equal(report.items.filter(i => ['heuristic.firstRunStyle', 'trigger.element', 'text.formatting'].includes(i.kind)).length, 0);
});

test('theme colors resolve for fills, borders and slide backgrounds; tint/shade inference is reported', () => {
  const fill = '<solidFill><clr><schemeClr val="accent1"/></clr></solidFill>';
  const border = '<lineStyle w="2"/><solidLine><clr><schemeClr val="dk1"/></clr></solidLine>';
  const tinted = '<solidFill><clr><schemeClr val="accent1"/><tint val="50000"/></clr></solidFill>';
  const { doc, report } = importStory(packageOf(obj('rect', 201, { fill: `<bG>${fill}${border}</bG>` }) + obj('rect', 202, { fill: `<bG>${tinted}</bG>` }), { bg: fill }));
  assert.equal(doc.slides[0].background, '#204060');
  assert.deepEqual(doc.slides[0].objects[0].style, { fill: '#204060', border: '#102030', borderWidth: 2 });
  assert.equal(doc.slides[0].objects[1].style.fill, '#90a0b0');
  assert.ok(report.items.some(i => i.kind === 'heuristic.themeColor'));
  assert.deepEqual(validate(doc), []);
});

test('unsupported formatting, missing theme, unsafe links and malformed rich XML are reported without losing text', () => {
  const body = `<Block><Style ListLevel="6"><ListStyle ListType="Unknown"/></Style>${span('Safe', 'ForegroundColor="accent1,04" FontFamily="+minor" LinkId="missing" Elevation="Superscript"')}</Block>`;
  const { doc, report } = importStory(packageOf(obj('textBox', 201, { plain: 'Safe', extra: richText(body) }), { master: false }));
  assert.equal(doc.slides[0].objects[0].text, 'Safe');
  assert.deepEqual(validate(doc), []);
  assert.ok(report.items.some(i => i.kind === 'text.formatting'));
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'data:text/html,hello']) {
    const x = importStory(packageOf(obj('textBox', 201, { extra: richText(`<Block>${span('Safe', 'LinkId="bad"')}</Block>`) + `<hLinkLst><item id="bad"><txtHlink enabled="true" trigG="${G(500)}"/></item></hLinkLst>`, trigs: trig(500, 'OnClick', 'jumpToFileUrl', { tag: 'hlinkTrig', other: `open="${url}"` }) })));
    assert.equal(x.doc.slides[0].objects[0].rich[0].runs[0].link, undefined);
    assert.ok(x.report.items.some(i => i.kind === 'text.formatting'));
  }
  for (const text of ['<Document>', '<x>'.repeat(300) + '</x>'.repeat(300), '<!DOCTYPE x><Document/>']) {
    const x = importStory(packageOf(obj('textBox', 201, { plain: 'Safe', extra: `<text>${esc(text)}</text>` })));
    assert.equal(x.doc.slides[0].objects[0].text, 'Safe');
    assert.equal(x.doc.slides[0].objects[0].rich, undefined);
    assert.ok(x.report.items.some(i => i.kind === 'text.style'));
  }
});

test('base span properties are overridden per run, mail links resolve, and conditional links remain reported', () => {
  const body = `<Block><Style><BaseSpanStyle FontIsBold="True" ForegroundColor="#ABCDEF,00"/></Style>${span('Mail', 'FontIsBold="False" LinkId="L1"')}${span(' rest')}</Block>`;
  const extra = richText(body) + `<hLinkLst><item id="L1"><txtHlink enabled="true" trigG="${G(500)}"/></item></hLinkLst>`;
  const mail = trig(500, 'OnClick', 'sendEmail', { tag: 'hlinkTrig', other: 'email="author@example.com"' });
  const result = importStory(packageOf(obj('textBox', 201, { extra, trigs: mail })));
  assert.deepEqual(result.doc.slides[0].objects[0].rich[0].runs, [
    { text: 'Mail', b: false, color: '#abcdef', link: 'mailto:author@example.com' },
    { text: ' rest', b: true, color: '#abcdef' },
  ]);
  const conditional = mail.replace('<condLst>', '<condLst><trigCond/>');
  const rejected = importStory(packageOf(obj('textBox', 201, { extra, trigs: conditional })));
  assert.equal(rejected.doc.slides[0].objects[0].rich[0].runs[0].link, undefined);
  assert.ok(rejected.report.items.some(i => i.kind === 'text.formatting'));
});

test('imported quiz variable references split across runs are renamed without losing their style', () => {
  const extra = richText(`<Block>${span('Score: ')}${span('%Quiz1.', 'FontIsBold="True"')}${span('ScorePercent%')}</Block>`);
  const { doc, report } = importStory(pkg({ parts: [slide(101, { shapes: obj('textBox', 201, { extra }) })] }));
  const o = doc.slides[0].objects[0];
  assert.equal(o.text, `Score: %${ID('q', 40)}.scorePercent%`);
  assert.equal(report.items.filter(i => i.kind === 'text.variable').length, 0);
  assert.deepEqual(o.rich[0].runs, [{ text: 'Score: ' }, { text: `%${ID('q', 40)}.scorePercent%`, b: true }]);
  assert.deepEqual(validate(doc), []);
});
