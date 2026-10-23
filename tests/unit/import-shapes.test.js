// lines, arrows, nearest shapes, inherited backgrounds and master/layout objects. Fixtures are original and
// follow and (SHAPES-LAYOUT-CORPUS-20261017); no vendor file is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStory } from '../../packages/import-story/index.js';
import { validate, emptyCourse } from '../../packages/schema/index.js';
import { applyAll } from '../../packages/core/index.js';
import { playerBundle } from '../../packages/publisher/bundle.js';
import { G, obj, slide, pkg } from '../fixtures/synthetic/story-builder.js';

const ends = (begin, end) => `<arrow><begin type="${begin}"/><end type="${end}"/></arrow>`;
const stroke = (hex, w, begin = 'none', end = 'none', fill = '') => `<bG>${fill}<solidLine><clr><srgbClr val="${hex}"/></clr></solidLine><lineStyle w="${w}" cap="flat">${ends(begin, end)}</lineStyle></bG>`;
const solid = (hex) => `<solidFill><clr><srgbClr val="${hex}"/></clr></solidFill>`;
const prst = (tag, attrs = '') => `<prstGeom><${tag} ${attrs}/></prstGeom>`;

/** One scene; each slide uses layout G(90) of master G(92) unless `layoutG` says otherwise. */
function packageOf({ slides = [{}], layoutBg = '', masterBg = '', layoutShapes = '', masterShapes = '', clr = '' } = {}) {
  const story = `<story id="${G(1)}"><mediaLst><mediaLst /></mediaLst><sceneLst><scene g="${G(30)}"><sldIdLst>${slides.map((_, i) => `<sldId>R${i + 1}</sldId>`).join('')}</sldIdLst></scene></sceneLst></story>`;
  const parts = slides.map((s, i) => slide(101 + i, { shapes: s.shapes ?? '', bg: s.bg ?? '', attrs: `resetMode="auto" advMode="user" layoutG="${s.layoutG ?? G(90)}"` }));
  return pkg({ story, parts, extra: [
    ['story/slideLayouts/slideLayout2.xml', `<layout g="${G(90)}" internalG="${G(91)}" showMasterSp="false"><bg>${layoutBg}</bg><shapeLst>${layoutShapes}</shapeLst></layout>`],
    ['story/slideMasters/slideMaster.xml', `<master g="${G(92)}"><bg>${masterBg}</bg><shapeLst>${masterShapes}</shapeLst><clrLst>${clr}</clrLst><layoutIdLst><sldId>RL</sldId></layoutIdLst></master>`],
    ['story/slideMasters/_rels/slideMaster.xml.rels', '<Relationships><Relationship Type="slideLayout" Id="RL" Target="/story/slideLayouts/slideLayout2.xml"/></Relationships>'],
  ] });
}
const run = (opts) => { const r = importStory(packageOf(opts)); assert.deepEqual(validate(r.doc), []); return r; };
const kinds = (report, kind) => report.items.filter((i) => i.kind === kind);
const only = (opts) => { const r = run(opts); return { ...r, o: r.doc.slides[0].objects[0] }; };

test('schema: arrow is a shape value and locked is a validated boolean', () => {
  const ok = applyAll(emptyCourse({ title: 'Shapes' }), [
    { cmd: 'slide.add', args: { id: 's-one' } },
    { cmd: 'object.add', args: { slide: 's-one', id: 'o-arrow', type: 'shape', shape: 'arrow', locked: true, style: { border: '#123456', borderWidth: 4 } } },
    { cmd: 'object.set', args: { id: 'o-arrow', locked: null } },
  ]);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.doc.slides[0].objects[0].locked, undefined);
  const bad = (o) => validate({ ...ok.doc, slides: [{ ...ok.doc.slides[0], objects: [{ ...ok.doc.slides[0].objects[0], ...o }] }] });
  assert.deepEqual(bad({ locked: true }), []);
  assert.ok(bad({ locked: 'yes' }).some((e) => e.path.endsWith('/locked')));
  assert.ok(bad({ shape: 'zigzag' }).some((e) => e.path.endsWith('/shape')));
});

test('connector line: endpoints become a centred, rotated box; stroke from solidLine and lineStyle@w', () => {
  const { o, report } = only({ slides: [{ shapes: obj('line', 201, { at: [100, 200, 300, 200], fill: stroke('FF0000', 3, 'def', 'def') }) }] });
  assert.equal(o.type, 'shape');
  assert.equal(o.shape, 'line');
  assert.deepEqual([o.x, o.y, o.w, o.h, o.rotation], [100, 198.5, 200, 3, undefined]);
  assert.deepEqual(o.style, { border: '#ff0000', borderWidth: 3 });
  assert.equal(kinds(report, 'object.line').length, 0);
  const d = only({ slides: [{ shapes: obj('line', 201, { at: [300, 100, 100, 300], fill: stroke('00FF00', 2) }) }] }).o; // r < l: drawn from (300,100) to (100,300)
  assert.deepEqual([d.x, d.y, d.w, d.h, d.rotation], [58.58, 199, 282.84, 2, 135]);
});

test('arrow heads: end head -> arrow, begin-only head turns it round, both and open heads are labelled heuristics', () => {
  const down = only({ slides: [{ shapes: obj('arrow', 201, { at: [50, 10, 50, 110], fill: stroke('0000FF', 2, 'none', 'triangle') }) }] });
  assert.equal(down.o.shape, 'arrow');
  assert.deepEqual([down.o.x, down.o.y, down.o.w, down.o.h, down.o.rotation], [0, 57, 100, 6, 90]);
  assert.equal(kinds(down.report, 'object.arrow').length + kinds(down.report, 'heuristic.arrowHead').length, 0);
  const back = only({ slides: [{ shapes: obj('arrow', 201, { at: [0, 0, 100, 0], fill: stroke('0000FF', 2, 'triangle', 'none') }) }] }).o;
  assert.equal(back.rotation, 180);
  const dbl = only({ slides: [{ shapes: obj('dblArrow', 201, { at: [0, 0, 100, 0], fill: stroke('0000FF', 4, 'triangle', 'triangle') }) }] });
  assert.equal(dbl.o.shape, 'arrow');
  assert.equal(kinds(dbl.report, 'heuristic.doubleArrow').length, 1);
  assert.equal(kinds(dbl.report, 'object.dblArrow').length, 0);
  const open = only({ slides: [{ shapes: obj('arrow', 201, { at: [0, 0, 100, 0], fill: stroke('0000FF', 2, 'none', 'open') }) }] });
  assert.equal(open.o.shape, 'arrow');
  assert.equal(kinds(open.report, 'heuristic.arrowHead').length, 1);
});

test('block arrows: rightArrow/downArrow become arrows stroked with their fill colour', () => {
  const fill = stroke('333333', 1, 'none', 'none', solid('00AA00'));
  const right = only({ slides: [{ shapes: obj('rightArrow', 201, { at: [100, 100, 300, 160], fill, extra: prst('rightArrow', 'cx="0.42" cy="0.5"') }) }] });
  assert.equal(right.o.shape, 'arrow');
  assert.deepEqual([right.o.x, right.o.y, right.o.w, right.o.h, right.o.rotation], [100, 100, 200, 60, undefined]);
  assert.deepEqual(right.o.style, { border: '#00aa00', borderWidth: 20 });
  assert.equal(kinds(right.report, 'heuristic.blockArrow').length, 1);
  assert.equal(kinds(right.report, 'object.rightArrow').length, 0);
  const down = only({ slides: [{ shapes: obj('downArrow', 201, { at: [100, 100, 160, 300], fill, extra: prst('downArrow') }) }] }).o;
  assert.deepEqual([down.x, down.y, down.w, down.h, down.rotation], [30, 170, 200, 60, 90]);
});

test('nearest shapes: foldedCorner -> rect, roundSameSideCorner -> rounded, polygon (5+ sides) -> ellipse; others stay reported', () => {
  const fill = `<bG>${solid('FFEEDD')}</bG>`;
  const { doc, report } = run({ slides: [{ shapes: obj('foldedCorner', 201, { fill, plain: 'Note', extra: prst('foldedCorner', 'corner="0.17"') })
    + obj('roundSameSideCorner', 202, { fill, extra: prst('roundSameSideCorner', 'l="0" r="0.17"') })
    + obj('polygon', 203, { fill, extra: prst('polygon', 'sides="8" offset="0.29"') })
    + obj('polygon', 204, { fill, extra: prst('polygon', 'sides="3"') })
    + obj('noSymbol', 205, { fill, extra: prst('noSymbol', 'radius="0.03"') })
    + obj('multiply', 206, { fill, extra: prst('multiply', 'cy="0.3"') }) }] });
  assert.deepEqual(doc.slides[0].objects.map((o) => [o.name, o.shape]), [['foldedCorner-201', 'rect'], ['roundSameSideCorner-202', 'rounded'], ['polygon-203', 'ellipse']]);
  assert.equal(doc.slides[0].objects[0].text, 'Note');
  assert.equal(doc.slides[0].objects[0].style.fill, '#ffeedd');
  for (const k of ['foldedCorner', 'roundSameSideCorner', 'polygon']) assert.equal(kinds(report, `heuristic.${k}`).length, 1, k);
  for (const k of ['polygon', 'noSymbol', 'multiply']) assert.equal(kinds(report, `object.${k}`).length, 1, k);
  assert.equal(kinds(report, 'object.foldedCorner').length + kinds(report, 'object.roundSameSideCorner').length, 0);
});

test('backgrounds: no own fill inherits the layout, else the master; own fills, noFill and pictures are not overridden', () => {
  const master = run({ masterBg: solid('336699'), slides: [{}] });
  assert.equal(master.doc.slides[0].background, '#336699');
  assert.equal(kinds(master.report, 'heuristic.inheritedBackground').length, 1);
  const layout = run({ layoutBg: solid('112233'), masterBg: solid('336699'), slides: [{}] });
  assert.equal(layout.doc.slides[0].background, '#112233');
  const scheme = run({ masterBg: '<solidFill><clr><schemeClr val="lt2"/></clr></solidFill>', clr: '<lt2><srgbClr val="ABCDEF"/></lt2>', slides: [{}] });
  assert.equal(scheme.doc.slides[0].background, '#abcdef');
  const own = run({ masterBg: solid('336699'), slides: [{ bg: solid('445566') }, { bg: '<noFill/>' }] });
  assert.deepEqual(own.doc.slides.map((s) => s.background), ['#445566', undefined]);
  assert.equal(kinds(own.report, 'heuristic.inheritedBackground').length, 0);
  const pic = run({ layoutBg: '<picFill tile="false" assetG="00000000-0000-0000-0000-000000000000"><pic/></picFill>', masterBg: solid('336699'), slides: [{}] });
  assert.equal(pic.doc.slides[0].background, undefined);
  assert.equal(kinds(pic.report, 'slide.background').length, 1);
  const unresolved = run({ masterBg: solid('336699'), slides: [{ layoutG: G(99) }] }); // no master lists this layout: nothing is guessed
  assert.equal(unresolved.doc.slides[0].background, undefined);
});

test('master and layout objects: copied onto each slide behind its own objects, locked, mapped and reported once', () => {
  const { doc, report } = run({
    masterShapes: obj('rect', 501, { at: [0, 500, 720, 540], fill: `<bG>${solid('101010')}</bG>` }) + obj('ph', 502),
    layoutShapes: obj('foldedCorner', 601, { at: [10, 10, 110, 60], extra: prst('foldedCorner') }) + obj('btnPh', 602),
    slides: [{ shapes: obj('textBox', 201, { plain: 'Own' }) }, { shapes: obj('textBox', 211, { plain: 'Two' }) }],
  });
  const [one, two] = doc.slides;
  assert.deepEqual(one.objects.map((o) => [o.name, o.locked]), [['rect-501', true], ['foldedCorner-601', true], ['textBox-201', undefined]]);
  assert.deepEqual(two.objects.map((o) => o.name), ['rect-501', 'foldedCorner-601', 'textBox-211']);
  assert.deepEqual([one.objects[0].x, one.objects[0].y, one.objects[0].w, one.objects[0].h], [0, 500, 720, 40]);
  assert.equal(one.objects[0].style.fill, '#101010');
  const ids = doc.slides.flatMap((s) => s.objects.map((o) => o.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(kinds(report, 'heuristic.foldedCorner').length, 1); // once for the layout object, not once per slide
  assert.match(kinds(report, 'heuristic.foldedCorner')[0].path, /^story\/slideLayouts\//);
  assert.equal(kinds(report, 'object.ph').length + kinds(report, 'object.btnPh').length, 0);
  assert.equal(kinds(report, 'layout').length, 1);
  assert.match(kinds(report, 'layout')[0].reason, /placeholder/);
});

test('published player bundle carries the shared SVG line renderer', () => {
  const js = playerBundle();
  assert.ok(js.includes('function drawLine('), 'drawLine is inlined');
  assert.ok(!/^export /m.test(js), 'no module keywords left');
});
