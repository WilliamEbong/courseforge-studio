// Heuristics are ours; fixtures are original, based on sections 3.11/3.13/5.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStory } from '../../packages/import-story/index.js';
import { validate } from '../../packages/schema/index.js';
import { G, ID, esc, obj, state, slide, srgb, pkg } from '../fixtures/synthetic/story-builder.js';

const gradient = (first = '<srgbClr val="ABCDEF"/>') => `<gradFill><stops><stop pos="0"><clr>${first}</clr></stop><stop pos="100000"><clr><srgbClr val="123456"/></clr></stop></stops></gradFill>`;
const rich = (style, tail = '') => `<text>${esc(`<Document><Content><Block><Span Text="First"><Style ${style}/></Span>${tail}</Block></Content></Document>`)}</text>`;
function packageOf(shapes, bg = '') {
  const story = `<story id="${G(1)}"><mediaLst><mediaLst><media g="${G(20)}" type="Png"/></mediaLst></mediaLst><sceneLst><scene g="${G(30)}"><sldIdLst><sldId>R1</sldId></sldIdLst></scene></sceneLst></story>`;
  return pkg({ story, parts: [slide(101, { shapes, bg })] });
}
const heuristic = (report, name) => report.items.filter(i => i.kind === `heuristic.${name}`);

test('heuristic gradientFill: first stop becomes solid on slide, object and state; each approximation is reported', () => {
  const { doc, report } = importStory(packageOf(obj('rect', 201, { fill: `<bG>${gradient()}</bG>`,
    states: state('Hover', 220, 'rect', { fill: `<bG>${gradient('<srgbClr val="FEDCBA"/>')}</bG>` }) }), gradient()));
  assert.deepEqual(validate(doc), []);
  assert.equal(doc.slides[0].background, '#abcdef');
  const o = doc.slides[0].objects[0];
  assert.equal(o.style.fill, '#abcdef');
  assert.equal(o.states.hover.style.fill, '#fedcba');
  assert.equal(heuristic(report, 'gradientFill').length, 3);
  for (const i of heuristic(report, 'gradientFill')) { assert.match(i.path, /^story\//); assert.match(i.reason, /first.*stop.*solid/); }
});

test('heuristic gradientFill: exact solid wins; unresolved first stops never borrow a later stop', () => {
  for (const first of ['<schemeClr val="accent1"/>', '<srgbClr val="ABCDEF"><alpha val="50000"/></srgbClr>', '<srgbClr val="bogus"/>']) {
    const { doc, report } = importStory(packageOf(obj('rect', 201, { fill: `<bG>${gradient(first)}</bG>` })));
    assert.equal(doc.slides[0].objects[0].style, undefined);
    assert.equal(heuristic(report, 'gradientFill').length, 0);
    assert.ok(report.items.some(i => i.kind === 'style.fill'));
  }
  const { doc, report } = importStory(packageOf(obj('rect', 201, { fill: srgb('112233').replace('</bG>', gradient() + '</bG>') })));
  assert.equal(doc.slides[0].objects[0].style.fill, '#112233');
  assert.equal(heuristic(report, 'gradientFill').length, 0);
});

test('rich text supersedes firstRunStyle: mixed styles stay on their own runs and exact fill survives', () => {
  const text = rich('FontSize="24" FontIsBold="True" FontIsItalic="False" ForegroundColor="#ABCDEF"', '<Span Text=" Second"><Style FontSize="48" FontIsItalic="True"/></Span>');
  const { doc, report } = importStory(packageOf(obj('textBox', 201, { fill: srgb('112233'), extra: text })));
  assert.deepEqual(validate(doc), []);
  assert.equal(doc.slides[0].objects[0].text, 'First Second');
  assert.deepEqual(doc.slides[0].objects[0].style, { fill: '#112233', fontSize: 16, bold: false, italic: false });
  assert.deepEqual(doc.slides[0].objects[0].rich, [{ runs: [
    { text: 'First', size: 32, b: true, i: false, color: '#abcdef' },
    { text: ' Second', size: 64, i: true },
  ] }]);
  assert.equal(heuristic(report, 'firstRunStyle').length, 0);
});

test('rich text normal-state button fallback works; unsupported style and malformed/deep XML are not guessed', () => {
  const normal = `<state name="Normal"><shapeLst><btn>${rich('FontIsItalic="True"')}</btn></shapeLst></state>`;
  const { doc, report } = importStory(packageOf(obj('btn', 201, { states: normal })));
  assert.equal(doc.slides[0].objects[0].rich[0].runs[0].i, true);
  assert.equal(heuristic(report, 'firstRunStyle').length, 0);
  for (const extra of [rich('FontSize="NaN" FontIsBold="maybe" ForegroundColor="accent1,00"'), '<text>&lt;Document&gt;</text>', `<text>${esc('<x>'.repeat(300) + '</x>'.repeat(300))}</text>`]) {
    const r = importStory(packageOf(obj('textBox', 201, { plain: 'Safe plain text', extra })));
    assert.deepEqual(validate(r.doc), []);
    assert.deepEqual(r.doc.slides[0].objects[0].style, { fontSize: 16, bold: false, italic: false });
    assert.ok(r.report.items.some(i => ['text.style', 'text.formatting'].includes(i.kind)));
    assert.equal(heuristic(r.report, 'firstRunStyle').length, 0);
  }
});

test('heuristic imageAltFromName: only accessible pictures with empty alt get names; explicit alt and decorative pictures stay unchanged', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-heuristics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pic = (n, attrs, extra = '') => obj('pic', n, { attrs: `assetG="${G(20)}" ${attrs}`, extra });
  const { doc, report } = importStory(packageOf(pic(201, 'acc="true"', '<alt> </alt>')
    + pic(202, 'acc="true"', '<alt>Explicit description</alt>') + pic(203, 'acc="false"') + pic(204, '')),
  { courseDir: dir, assetsDir: path.join(dir, 'assets') });
  assert.deepEqual(validate(doc), []);
  assert.deepEqual(doc.slides[0].objects.map(o => o.alt), ['pic-201', 'Explicit description', undefined, undefined]);
  assert.equal(doc.slides[0].objects[0].image, ID('a', 20));
  assert.equal(heuristic(report, 'imageAltFromName').length, 1);
  assert.match(heuristic(report, 'imageAltFromName')[0].reason, /name.*review/);
});
