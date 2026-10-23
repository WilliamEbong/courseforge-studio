// Synthetic Storyline .story builder for tests. Everything here is built from the documented structure
// (notes); no vendor file is used or committed.
import zlib from 'node:zlib';
import { storyId } from '../../../packages/import-story/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PNG = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'synthetic-200x120.png'));

// ---------- test-only ZIP writer (can forge hostile archives) ----------
export function zip(entries, { count } = {}) {
  const locals = [], cens = [];
  let off = 0;
  for (const [name, content, o = {}] of entries) {
    const data = Buffer.from(content);
    const method = o.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = o.crc ?? zlib.crc32(data), size = o.size ?? data.length, nb = Buffer.from(name);
    // desc: sizes and CRC in a trailing data descriptor (flag bit 3); extra: an opaque extra field in both headers.
    const flags = (o.flags ?? 0) | (o.desc ? 8 : 0), ex = Buffer.from(o.extra ? `\xfe\xca${String.fromCharCode(o.extra.length)}\0${o.extra}` : '', 'latin1');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    if (!o.desc) { lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(size, 22); }
    lh.writeUInt16LE(nb.length, 26); lh.writeUInt16LE(ex.length, 28);
    const dd = Buffer.alloc(o.desc ? 16 : 0);
    if (o.desc) { dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(body.length, 8); dd.writeUInt32LE(size, 12); }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt16LE(ex.length, 30); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, ex, body, dd); cens.push(ch, nb, ex);
    off += 30 + nb.length + ex.length + body.length + dd.length;
  }
  const cd = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count ?? entries.length, 8); end.writeUInt16LE(count ?? entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- synthetic Storyline XML (shapes follow) ----------
export const ZERO = '00000000-0000-0000-0000-000000000000';
export const G = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
export const ID = (prefix, n) => `${prefix}-${String(n).padStart(8, '0')}1111`;
export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const docXml = (t) => esc(`<Document><Content><Block><Span Text="${esc(t)}" /></Block></Content></Document>`);
export const loc = (l, t, r, b) => `<loc l="${l}" t="${t}" r="${r}" b="${b}" />`;
export const srgb = (hex) => `<bG><solidFill><clr><srgbClr val="${hex}" /></clr></solidFill></bG>`;
export const SCHEME = '<bG><solidFill><clr><schemeClr val="accent1" /></clr></solidFill></bG>';
export function obj(tag, n, { at = [0, 0, 100, 50], plain, text, fill = '', trigs = '', states = '', extra = '', attrs = '', rot = -1, tm = 'start="0" dur="5000" untilEnd="true"' } = {}) {
  return `<${tag} g="${G(n)}" name="${tag}-${n}" rot="${rot}" ${attrs}><tmProps min="5000" /><tmCtxLst version="2"><txtTmCtx ${tm} /></tmCtxLst><childLst />`
    + `<trigLst>${trigs}</trigLst><stateLst>${states}</stateLst>${fill}${loc(...at)}${text !== undefined ? `<text>${docXml(text)}</text>` : ''}${extra}`
    + `${plain !== undefined ? `<plain>${esc(plain)}</plain>` : ''}</${tag}>`;
}
export const state = (name, n, tag, { plain, fill = '' } = {}) => `<state g="${G(n)}" name="${name}"><shapeLst><${tag} g="${G(n + 1)}">${fill}${loc(0, 0, 100, 50)}${plain !== undefined ? `<plain>${esc(plain)}</plain>` : ''}</${tag}></shapeLst><trigLst /></state>`;
export function trig(n, event, action, { sub = 'next', intent = 'Unspecified', blocks = '', other = '', conds = '', els = '', enabled = 'true', tag = 'trig', name = '' } = {}) {
  return `<${tag} g="${G(n)}" name="${name}" type="user"><data enabled="${enabled}" event="${event}" action="${action}" actSubType="${sub}" NavigationIntent="${intent}">`
    + `<keyPress keys="None" />${blocks}<other ${other} />${els}</data><condLst>${conds}</condLst></${tag}>`;
}
export const cond = (op, dataType, { varG, varG2 = ZERO, floatVal1 = '0', andOr = 'and', shapeG = ZERO }) =>
  `<trigCond op="${op}" dataType="${dataType}" floatVal1="${floatVal1}" varG="${varG}" varG2="${varG2}" andOr="${andOr}" lightBox="false"><shapeState shapeG="${shapeG}" op="eq" name="Normal" /></trigCond>`;
export const elseTrig = (n, action, blocks) => `<elseTrigger g="${G(n)}"><data enabled="true" event="OnStart" action="${action}" actSubType="next">${blocks}<other /></data><condLst /></elseTrigger>`;
export function slide(n, { name = '', attrs = 'resetMode="auto" advMode="user"', min = 5000, bg = '', note = '', shapes = '', trigs = '', layers = '', root = 'sld', nav = '' } = {}) {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?><${root} g="${G(n)}" name="${esc(name)}" ${attrs}><tmProps min="${min}" /><bg>${bg}</bg>`
    + `<shapeLst>${shapes}</shapeLst><trigLst>${trigs}</trigLst>${note ? `<note>${docXml(note)}</note>` : ''}${nav}<sldLayerLst>${layers}</sldLayerLst></${root}>`;
}
export const layer = (n, { name = '', attrs = 'modal="false" pause="false" stop="true" hideEnd="false"', min = 5000, shapes = '', trigs = '', tag = 'sldLayer' } = {}) =>
  `<${tag} g="${G(n)}" name="${name}" ${attrs}><tmProps min="${min}" /><bg /><shapeLst>${shapes}</shapeLst><trigLst>${trigs}</trigLst></${tag}>`;
export const choice = (tag, n, parent, label, top, { selected = false, scored = selected } = {}) =>
  obj(tag, n, { at: [100, top, 600, top + 40], attrs: `parentG="${G(parent)}" initState="${selected ? 'Selected' : 'Normal'}"`, extra: `<scoreData correct="${scored}" pts="0" />`, states: state('Normal', n * 10, tag, { plain: label }) });
export const intr = (tag, n, { title = ZERO, attempts = 'one', cor = ZERO, inc = ZERO, extraAttrs = '', body = '' } = {}) =>
  obj(tag, n, { attrs: extraAttrs, extra: `<intrProps feedbk="intr" branch="none" corPts="10" incPts="0" corFbG="${cor}" incFbG="${inc}" tryFbG="${ZERO}" shuffle="true" attempts="${attempts}" titleBoxG="${title}"><tipText /><exclQuizLst /></intrProps>${body}` });
export const fbLayer = (n, name, text) => layer(n, { name, attrs: 'modal="true" pause="true" stop="true" hideEnd="false"', shapes:
  obj('feedbackTextBox', n + 1, { plain: text })
  + obj('feedBackBtn', n + 2, { states: state('Normal', (n + 2) * 10, 'feedBackBtn', { plain: 'Continue' }), trigs: trig(n + 3, 'OnClick', 'hideSubSlide', { sub: 'me', blocks: `<sldLayer hideG="${G(n)}" />` }) + trig(n + 4, 'OnClick', 'jumpToSlide', { name: 'Continue' }) }) });
export const NAV = trig(1090, 'OnNextButtonClick', 'jumpToSlide', { name: 'Navigation', intent: 'Next' }) + trig(1091, 'OnClick', 'jumpToSlide', { sub: 'prev', name: 'Previous', intent: 'Previous' });

export function storyXml() {
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?><story id="${G(1)}"><varLst>`
    + `<var g="${G(2)}" name="Player.Volume" dataType="num" val="0" type="builtIn" />`
    + `<var g="${G(3)}" name="score" dataType="num" val="5" type="user" />`
    + `<var g="${G(4)}" name="flag" dataType="bool" val="False" type="user" />`
    + `<var g="${G(5)}" name="msg" dataType="text" val="hi" type="user" />`
    + `<var g="${G(10)}" name="bad name" dataType="text" val="" type="user" />`
    + ['ScorePercent', 'ScorePoints', 'PassPercent', 'PassPoints'].map((k, i) => `<var g="${G(6 + i)}" name="Quiz1.${k}" dataType="num" val="0" type="prop" />`).join('')
    + `</varLst><mediaLst><mediaLst><media g="${G(20)}" type="Png" /><media g="${G(21)}" type="Emf" /></mediaLst></mediaLst>`
    + `<sceneLst><scene g="${G(30)}" name="Intro"><sldIdLst><sldId>R1</sldId><sldId>R2</sldId></sldIdLst></scene>`
    + `<scene g="${G(31)}" name="Quiz"><sldIdLst>${[3, 4, 5, 6, 7, 8, 9].map((i) => `<sldId>R${i}</sldId>`).join('')}</sldIdLst></scene></sceneLst>`
    + `<propLst><prop id="5">Synthetic course</prop><prop id="15"><sz w="720" h="540" /></prop></propLst>`
    + `<quizMgr><bankLst><scene g="${G(32)}" name=""><sldIdLst><sldId>R99</sldId></sldIdLst></scene></bankLst><quizLst>`
    + `<quiz g="${G(40)}" name="Quiz1" passScore="80" scorePct="${G(6)}" scorePoints="${G(7)}" passPct="${G(8)}" passPoints="${G(9)}" resultSldG="${G(108)}"><questionIdLst /></quiz>`
    + '</quizLst></quizMgr></story>';
}

export function slides() {
  const s1 = slide(101, {
    name: 'Welcome', attrs: 'resetMode="y" advMode="auto"', min: 4000, bg: '<solidFill><clr><srgbClr val="112233" /></clr></solidFill>', note: 'Say hi',
    shapes: obj('textBox', 201, { at: [10, 20, 210, 70], text: 'Hello %msg%', tm: 'start="1000" dur="2000" untilEnd="false"', trigs: trig(1001, 'OnClick', 'jumpToFileUrl', { tag: 'hlinkTrig' }) })
      + obj('rect', 202, { fill: srgb('FF0000'), rot: 45, trigs: trig(1002, 'OnMouseHover', 'showSubSlide', { blocks: `<sldLayer showG="${G(301)}" />` }) })
      + obj('oval', 203, { fill: SCHEME })
      + obj('roundRect', 204, { plain: 'Box' })
      + obj('pic', 205, { attrs: `assetG="${G(20)}"`, extra: '<alt>A tiny picture</alt>' })
      + obj('pic', 206, { attrs: `assetG="${G(21)}"` })
      + obj('btn', 207, {
        attrs: 'initState="Normal"',
        states: state('Normal', 2070, 'btn', { plain: 'Go', fill: srgb('00FF00') }) + state('Hover', 2072, 'btn', { plain: 'Go!', fill: srgb('0000FF') })
          + state('Visited', 2074, 'btn', { plain: 'Go' }) + state('Drag Over', 2076, 'btn', { plain: 'Go' }),
        trigs: trig(1010, 'OnClick', 'adjustVar', { other: `varG="${G(3)}" op="add" dblVal="2"` })
          + trig(1011, 'OnClick', 'changeShapeState', { blocks: `<shape setStateG="${G(207)}" setStateName="Disabled" setstateop="ass" />`, conds: cond('eq', 'value', { varG: G(3), floatVal1: '7' }), els: elseTrig(1111, 'changeShapeState', `<shape setStateG="${G(207)}" setStateName="Selected" setstateop="ass" />`) })
          + trig(1012, 'OnClick', 'adjustVar', { other: `varG="${G(4)}" var1G="${G(4)}" op="not" useVar="true"` })
          + trig(1013, 'OnClick', 'adjustVar', { other: `varG="${G(5)}" op="ass" varVal1="bye" useVar="false"` })
          + trig(1014, 'OnClick', 'executeJavaScript', { other: 'js="alert(1)"' })
          + trig(1015, 'OnClick', 'showSubSlide', { blocks: `<sldLayer showG="${G(301)}" />` })
          + trig(1016, 'OnClick', 'jumpToSlide', { sub: 'spec', enabled: 'false', blocks: `<slide jumpG="${G(102)}" />` })
          + trig(1017, 'OnClick', 'adjustVar', { conds: cond('neq', 'value', { varG: G(3), floatVal1: '1' }), other: `varG="${G(3)}" op="add" dblVal="1"` }),
      })
      + obj('widget', 208)
      + obj('group', 209),
    trigs: NAV
      + trig(1020, 'OnVariableValueChange', 'jumpToFileUrl', { other: `varChangeG="${G(3)}" open="https://example.com/x"` })
      + trig(1021, 'OnStart', 'sendEmail', { other: 'email="a@example.com"' })
      + trig(1022, 'OnEnd', 'jumpToScene', { sub: 'spec', blocks: `<scene jumpG="${G(31)}" />` })
      + trig(1023, 'OnStart', 'adjustVar', { other: `varG="${G(2)}" op="ass" dblVal="1"` })
      + trig(1024, 'OnKeyPress', 'jumpToSlide'),
    layers: layer(301, {
      name: 'Popup', attrs: 'modal="true" pause="true" stop="false" hideEnd="true"', min: 1500,
      shapes: obj('feedBackBtn', 302, { states: state('Normal', 3020, 'feedBackBtn', { plain: 'Close' }), trigs: trig(1030, 'OnClick', 'hideSubSlide', { sub: 'me', blocks: `<sldLayer hideG="${G(301)}" />` }) }),
      trigs: trig(1031, 'OnStart', 'adjustVar', { other: `varG="${G(3)}" op="add" dblVal="1"` }),
    }),
  });
  const s2 = slide(102, { name: 'Second', shapes: obj('textBox', 210, { plain: 'Two' }), trigs: trig(1040, 'OnNextButtonClick', 'jumpToSlide', { sub: 'spec', intent: 'Next', blocks: `<slide jumpG="${G(101)}" />` }) });
  const s3 = slide(103, {
    attrs: 'resetMode="auto" advMode="user" layoutType="Quiz Questions"',
    shapes: intr('multiChoiceIntr', 400, { title: G(401), cor: G(410), inc: G(420) })
      + obj('textBox', 401, { plain: 'Pick B', extra: '<ph type="title" />' })
      + choice('radio', 403, 400, 'B', 200, { selected: true }) + choice('radio', 402, 400, 'A', 100) + choice('radio', 404, 400, 'C', 300),
    trigs: trig(1050, 'OnClick', 'submitInteraction', { name: 'SubmitInteraction', blocks: `<interaction submitG="${G(400)}" />` }),
    layers: fbLayer(410, 'Correct', 'Right!') + fbLayer(420, 'Incorrect', 'Wrong.'),
  });
  const s4 = slide(104, {
    shapes: intr('multiRespIntr', 500, { attempts: 'unlimited' }) + obj('textBox', 501, { plain: 'Pick 1 and 3', extra: '<ph type="title" />' })
      + choice('checkBox', 502, 500, 'One', 100, { selected: true }) + choice('checkBox', 503, 500, 'Two', 200) + choice('checkBox', 504, 500, 'Three', 300, { selected: true, scored: false }),
  });
  const s5 = slide(105, { shapes: intr('trueFalseIntr', 600, { title: G(601) }) + obj('textBox', 601, { plain: 'Sky is blue' }) + choice('radio', 602, 600, 'True', 100, { selected: true }) + choice('radio', 603, 600, 'False', 200) });
  const s6 = slide(106, {
    shapes: intr('textEntryIntr', 700, { title: G(701), extraAttrs: `textEntryG="${G(702)}" case="false"`, body: '<choices><intrFreeChoice><text>teal</text></intrFreeChoice><intrFreeChoice><text>teal blue</text></intrFreeChoice></choices>' })
      + obj('textBox', 701, { plain: 'Type teal' })
      + obj('intrTextEntryBox', 702, { plain: 'type here', trigs: trig(1060, 'OnLostFocus', 'adjustVar', { tag: 'textEntryTrig' }) }),
  });
  const s7 = slide(107, { shapes: obj('dragDropIntr', 800) + obj('textBox', 801, { plain: 'Drag me' }), trigs: trig(1070, 'OnClick', 'submitInteraction', { blocks: `<interaction submitG="${G(800)}" />` }) });
  const custom = (e) => `<customData enumName="${e}" g="${G(108)}" />`;
  const s8 = slide(108, {
    shapes: obj('rsltsIntr', 850) + obj('textBox', 851, { plain: 'Score: %Quiz1.ScorePercent%%' }),
    trigs: trig(1080, 'OnStart', 'showSubSlide', { blocks: `<sldLayer showG="${G(901)}" />`, conds: cond('gte', 'var', { varG: G(7), varG2: G(9) }) })
      + trig(1081, 'OnStart', 'showSubSlide', { blocks: `<sldLayer showG="${G(902)}" />`, conds: cond('lt', 'var', { varG: G(7), varG2: G(9) }) })
      + trig(1082, 'OnStart', 'SubmitQuizSL', { tag: 'submitQuizTrig', blocks: custom('SubmitQuizSL') }),
    layers: layer(901, { name: 'Success', shapes: obj('rsltBtn', 910, { states: state('Normal', 9100, 'rsltBtn', { plain: 'Review' }), trigs: trig(1083, 'OnClick', 'ReviewQuizSL', { tag: 'reviewQuizTrig', blocks: custom('ReviewQuizSL') }) }) })
      + layer(902, { name: 'Failure', shapes: obj('rsltBtn', 920, { states: state('Normal', 9200, 'rsltBtn', { plain: 'Retry' }), trigs: trig(1084, 'OnClick', 'ResetQuizSL', { tag: 'resetQuizTrig', blocks: custom('ResetQuizSL') }) + trig(1085, 'OnClick', 'jumpToSlide', { tag: 'gotoFirstInQuizTrig', sub: 'spec', blocks: `<slide jumpG="${G(103)}" />` }) }) }),
  });
  const s9 = slide(109, { root: 'bankSld' });
  return [s1, s2, s3, s4, s5, s6, s7, s8, s9];
}

export function pkg({ story = storyXml(), parts = slides(), extra = [] } = {}) {
  const names = parts.map((_, i) => (i ? `slide${(i + 1).toString(16)}.xml` : 'slide.xml'));
  const rels = names.map((n, i) => `<Relationship Type="slide" Target="/story/slides/${n}" Id="R${i + 1}" />`).join('');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types />'],
    ['_rels/.rels', '<?xml version="1.0"?><Relationships />', { method: 0 }],
    ['story/story.xml', '\uFEFF' + story],
    ['story/_rels/story.xml.rels', `<?xml version="1.0"?><Relationships>${rels}</Relationships>`],
    ...parts.map((x, i) => [`story/slides/${names[i]}`, x]),
    [`story/media/R${storyId(G(20))}.png`, PNG, { method: 0 }],
    [`story/media/R${storyId(G(21))}.emf`, 'emf', { method: 0 }],
    ['story/slideLayouts/slideLayout.xml', '<layout />'],
    ...extra,
  ]);
}

