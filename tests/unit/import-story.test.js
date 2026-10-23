// read-only Storyline .story import. Every package here is SYNTHETIC: built in this file from the
// documented structure (notes). No vendor file is used or committed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readZip } from '../../packages/import-story/zip-read.js';
import { importStory, importStoryFile, parseXml, storyId, summarize } from '../../packages/import-story/index.js';
import { validate, serialize } from '../../packages/schema/index.js';
import { play } from '../../packages/runtime/index.js';
import * as importer from '../../packages/import-story/index.js';
import { createServer as createMcp } from '../../packages/mcp/server.js';
import { createServer as createHttp } from '../../packages/server/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PNG = fs.readFileSync(path.join(ROOT, 'tests/fixtures/synthetic/synthetic-200x120.png'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-import-'));

import { zip, ZERO, G, ID, esc, docXml, loc, srgb, SCHEME, obj, state, trig, cond, elseTrig, slide, layer, choice, intr, fbLayer, NAV, storyXml, slides, pkg } from '../fixtures/synthetic/story-builder.js';

const byKind = (items, kind) => items.filter((x) => x.kind === kind);
const findTrig = (list, id) => list.find((t) => t.id === ID('t', id));

// ---------- ZIP reader ----------
test('zip: stored and deflated entries read back; names listed', () => {
  const z = readZip(zip([['a.txt', 'hello', { method: 0 }], ['b/c.xml', '<x/>'.repeat(50)]]));
  assert.deepEqual(z.names, ['a.txt', 'b/c.xml']);
  assert.equal(z.read('a.txt').toString(), 'hello');
  assert.equal(z.read('b/c.xml').toString(), '<x/>'.repeat(50));
  assert.throws(() => z.read('missing'), /no entry/);
});

test('zip: malformed, truncated, encrypted, ZIP64 and unsupported archives are refused clearly', () => {
  assert.throws(() => readZip(Buffer.from('this is not a zip file at all, just text')), /not a ZIP file/);
  assert.throws(() => readZip(Buffer.alloc(0)), /not a ZIP file/);
  const good = zip([['a.txt', 'hello world hello world']]);
  assert.throws(() => readZip(good.subarray(20)), /zip: /);
  assert.throws(() => readZip(zip([['a.txt', 'x', { flags: 1 }]])), /encrypted/);
  assert.throws(() => readZip(zip([['a.txt', 'x']], { count: 0xffff })), /ZIP64/);
  assert.throws(() => readZip(zip([['a.txt', 'x', { method: 12 }]])).read('a.txt'), /unsupported compression method 12/);
  assert.throws(() => readZip('nope'), /expected a Buffer/);
});

test('zip: traversal and unsafe names are refused; duplicates too', () => {
  for (const name of ['../evil.xml', '/abs.xml', 'C:/x.xml', 'a\\b.xml', 'story/../../x.xml', 'a/\u0001.xml']) {
    assert.throws(() => readZip(zip([['ok.txt', 'x'], [name, 'y']])), /unsafe entry name/, name);
  }
  assert.throws(() => readZip(zip([['a.txt', 'x'], ['a.txt', 'y']])), /duplicate entry/);
});

test('zip: bomb guards (declared total, entry count, inflate past declared size) and CRC check', () => {
  assert.throws(() => readZip(zip([['big.bin', 'x', { size: 300 * 1024 * 1024 }]])), /exceeds the limit/);
  assert.throws(() => readZip(zip([['a', '1'], ['b', '2']]), { maxEntries: 1 }), /entries exceed/);
  assert.throws(() => readZip(zip([['a', '1'], ['b', '22']]), { maxTotal: 2 }), /exceeds the limit of 2 bytes/);
  const liar = readZip(zip([['bomb.txt', 'A'.repeat(100000), { size: 10 }]]));
  assert.throws(() => liar.read('bomb.txt'), /larger than its declared size/);
  assert.throws(() => readZip(zip([['a.txt', 'hello', { crc: 1234 }]])).read('a.txt'), /CRC/);
});

// ---------- XML and ids ----------
test('xml: entities, CDATA, BOM, self-closing; DTDs refused; malformed input fails', () => {
  const r = parseXml('\uFEFF<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y=\'&#65;&#x42;\'><b/><c>t&lt;<![CDATA[<raw>]]></c></a>', 'p.xml');
  assert.equal(r.tag, 'a');
  assert.equal(r.attrs.x, '1 & 2');
  assert.equal(r.attrs.y, 'AB');
  assert.equal(r.kids[1].text, 't<<raw>');
  assert.equal(r.part, 'p.xml');
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>'), /DTD/);
  assert.throws(() => parseXml('<a><b></a>'), /xml:/);
  assert.throws(() => parseXml('<a>'), /unclosed/);
  assert.throws(() => parseXml('<a x="1></a>'), /xml:/);
});

test('storyId matches the documented derivation', () => {
  assert.equal(storyId('1998f629-e9b6-41a8-85e0-0f0707b2e977'), '5dVLl5w3fYX');
});

// ---------- importStory ----------
function importSynthetic() {
  const dir = tmp();
  const r = importStory(pkg(), { assetsDir: path.join(dir, 'assets', 'syn'), courseDir: dir, title: 'fallback' });
  return { ...r, dir };
}

test('import: course, variables, scenes and slide properties', () => {
  const { doc, report } = importSynthetic();
  assert.deepEqual(validate(doc), []);
  assert.equal(doc.title, 'Synthetic course');
  assert.equal(doc.id, 'course-000000011111');
  assert.deepEqual(doc.size, { w: 720, h: 540 });
  assert.deepEqual(doc.variables, [
    { name: 'score', type: 'number', initial: 5 }, { name: 'flag', type: 'boolean', initial: false },
    { name: 'msg', type: 'text', initial: 'hi' }, { name: 'bad_name', type: 'text', initial: '' },
  ]);
  assert.equal(byKind(report.items, 'variable.renamed').length, 1);
  assert.deepEqual(doc.scenes.map((s) => [s.id, s.title, s.slides.length]), [[ID('sc', 30), 'Intro', 2], [ID('sc', 31), 'Quiz', 6]]);
  const s1 = doc.slides[0];
  assert.deepEqual([s1.id, s1.title, s1.duration, s1.advance, s1.revisit, s1.background, s1.notes], [ID('s', 101), 'Welcome', 4000, 'auto', 'reset', '#112233', 'Say hi']);
  assert.equal(byKind(report.items, 'draw.bank').length, 1, 'a draw slide without a bank is reported');
  assert.deepEqual(doc.banks, [{ id: ID('bk', 32), title: 'Question bank', slides: [] }], 'its one slide part is missing (slide.missing)');
  for (const k of ['layout', 'tracking']) assert.equal(byKind(report.items, k).length, 1, k);
});

test('import: text, shapes, pictures, buttons and states', () => {
  const { doc, report, dir } = importSynthetic();
  const o = (n) => doc.slides[0].objects.find((x) => x.id === ID('o', n));
  assert.equal(byKind(report.items, 'text.formatting').length, 0, 'fully mapped rich text needs no loss report');
  assert.deepEqual(o(201), { id: ID('o', 201), type: 'text', name: 'textBox-201', x: 10, y: 20, w: 200, h: 50, text: 'Hello %msg%', style: { fontSize: 16, bold: false, italic: false }, rich: [{ runs: [{ text: 'Hello %msg%' }] }], start: 1000, end: 3000 });
  assert.deepEqual([o(202).shape, o(202).style, o(202).rotation], ['rect', { fill: '#ff0000' }, 45]);
  assert.equal(o(203).shape, 'ellipse');
  assert.equal(o(203).style, undefined);
  assert.ok(byKind(report.items, 'style.fill').some((x) => x.path.includes('/oval')));
  assert.deepEqual([o(204).shape, o(204).text], ['rounded', 'Box']);
  const pic = o(205);
  assert.equal(pic.type, 'image');
  assert.equal(pic.alt, 'A tiny picture');
  const asset = doc.assets.find((a) => a.id === pic.image);
  assert.deepEqual(asset, { id: ID('a', 20), path: `assets/syn/${ID('a', 20)}.png`, mime: 'image/png' });
  assert.deepEqual(fs.readFileSync(path.join(dir, asset.path)), PNG);
  assert.equal(o(206), undefined, 'malformed synthetic EMF picture skipped');
  assert.equal(byKind(report.items, 'media.type').length, 1);
  const btn = o(207);
  assert.equal(btn.type, 'button');
  assert.equal(btn.text, 'Go', 'label from the Normal state copy');
  assert.deepEqual(btn.style, { fill: '#00ff00', fontSize: 16, bold: false, italic: false });
  assert.deepEqual(btn.states, { hover: { text: 'Go!', style: { fill: '#0000ff' } }, visited: {} });
  assert.equal(byKind(report.items, 'state.name').length, 1, 'Drag Over reported');
});

test('import: unknown elements and groups are reported with a stable path, never silently dropped', () => {
  const { doc, report } = importSynthetic();
  const ids = new Set(doc.slides.flatMap((s) => s.objects.map((x) => x.id)));
  assert.ok(!ids.has(ID('o', 208)) && !ids.has(ID('o', 209)));
  assert.deepEqual(byKind(report.items, 'object.widget'), [{ path: 'story/slides/slide.xml#/sld/shapeLst/widget', kind: 'object.widget', reason: '<widget> is not supported yet' }]);
  assert.equal(byKind(report.items, 'object.group').length, 1);
  assert.equal(byKind(report.items, 'trigger.element')[0].path, 'story/slides/slide.xml#/sld/shapeLst/textBox/trigLst/hlinkTrig');
});

test('import: triggers (events, actions, conditions, else, enabled) and layers', () => {
  const { doc, report } = importSynthetic();
  const s1 = doc.slides[0];
  const t = (n) => findTrig(s1.triggers, n);
  const B = ID('o', 207), L = ID('l', 301);
  assert.deepEqual(t(1010), { id: ID('t', 1010), on: { event: 'click', target: B }, do: [{ action: 'setVar', var: 'score', op: 'add', value: 2 }] });
  assert.deepEqual(t(1011).if, { all: [{ var: 'score', op: '==', value: 7 }] });
  assert.deepEqual(t(1011).do, [{ action: 'setState', target: B, state: 'disabled' }]);
  assert.deepEqual(t(1011).else, [{ action: 'setState', target: B, state: 'selected' }]);
  assert.deepEqual(t(1012).do, [{ action: 'setVar', var: 'flag', op: 'toggle' }]);
  assert.deepEqual(t(1013).do, [{ action: 'setVar', var: 'msg', op: 'set', value: 'bye' }]);
  assert.equal(t(1014), undefined, 'JavaScript dropped');
  assert.deepEqual(t(1015).do, [{ action: 'showLayer', layer: L }]);
  assert.deepEqual([t(1016).do, t(1016).enabled], [[{ action: 'jump', to: ID('s', 102) }], false]);
  assert.equal(t(1017), undefined, 'neq condition is not evidenced');
  assert.deepEqual(t(1002).on, { event: 'hoverEnter', target: ID('o', 202) });
  assert.equal(byKind(report.items, 'trigger.approximation').length, 1);
  assert.deepEqual(t(1020), { id: ID('t', 1020), on: { event: 'varChange', var: 'score' }, do: [{ action: 'openUrl', url: 'https://example.com/x' }] });
  assert.deepEqual(t(1021).do, [{ action: 'openUrl', url: 'mailto:a@example.com' }]);
  assert.deepEqual([t(1022).on, t(1022).do], [{ event: 'timelineEnd' }, [{ action: 'jumpScene', to: ID('sc', 31) }]]);
  assert.equal(t(1023), undefined, 'built-in variable');
  assert.equal(t(1024), undefined, 'unknown event');
  assert.equal(t(1090) ?? t(1091), undefined, 'default player navigation is CF behaviour already');
  const reasons = report.items.filter((x) => x.kind.startsWith('trigger.')).map((x) => x.reason).join('\n');
  for (const r of ['JavaScript', 'operator "neq"', 'not imported', 'event "OnKeyPress"']) assert.match(reasons, new RegExp(r));
  assert.deepEqual(findTrig(doc.slides[1].triggers, 1040), { id: ID('t', 1040), on: { event: 'playerNext' }, do: [{ action: 'jump', to: ID('s', 101) }] });
  const popup = s1.layers[0];
  assert.deepEqual([popup.id, popup.title, popup.modal, popup.hideOthers, popup.hideOnEnd, popup.duration, popup.pauseBase], [L, 'Popup', true, false, true, 1500, true]);
  assert.equal(byKind(report.items, 'layer.pauseBase').length, 0, 'sldLayer@pause maps to pauseBase');
  assert.deepEqual(findTrig(popup.triggers, 1030), { id: ID('t', 1030), on: { event: 'click', target: ID('o', 302) }, do: [{ action: 'hideLayer', layer: L }] });
  assert.deepEqual(findTrig(popup.triggers, 1031).on, { event: 'timelineStart' });
});

test('import: questions (mc, mr, tf, fill) with feedback; question parts are consumed', () => {
  const { doc, report } = importSynthetic();
  const [s3, s4, s5, s6, s7] = doc.slides.slice(2, 7);
  assert.deepEqual(s3.question, {
    type: 'mc', prompt: 'Pick B', points: 10, attempts: 1, shuffle: true,
    choices: [{ id: ID('c', 402), label: 'A', correct: false }, { id: ID('c', 403), label: 'B', correct: true }, { id: ID('c', 404), label: 'C', correct: false }],
    layout: { prompt: { x: 0, y: 0, w: 100, h: 50, style: { fontSize: 32, bold: false, italic: false } }, choices: [402, 403, 404].map((n, i) => ({ id: ID('c', n), x: 100, y: 100 + i * 100, w: 500, h: 40, style: { fontSize: 16, bold: false, italic: false } })) },
    feedback: { correct: 'Right!', incorrect: 'Wrong.', tryAgain: 'Try again.' },
  });
  assert.deepEqual([s3.objects, s3.layers, s3.triggers], [[], [], []], 'title, choices, feedback layers and submit trigger consumed');
  assert.deepEqual(s4.question.choices.map((c) => [c.label, c.correct]), [['One', true], ['Two', false], ['Three', true]]);
  assert.equal(s4.question.prompt, 'Pick 1 and 3');
  for (const k of ['question.keyConflict', 'question.promptFromTitle', 'question.trueFalse']) assert.equal(byKind(report.items, k).length, 1, k);
  assert.equal(s4.question.attempts, 0, 'attempts="unlimited" = 0');
  assert.equal(byKind(report.items, 'question.attempts').length, 0);
  assert.deepEqual([s5.question.type, s5.question.prompt, s5.question.choices.filter((c) => c.correct).map((c) => c.label)], ['tf', 'Sky is blue', ['True']]);
  assert.deepEqual([s6.question.type, s6.question.answers, s6.question.caseSensitive, s6.objects], ['fill', ['teal', 'teal blue'], undefined, []]);
  assert.equal(s7.question, undefined);
  assert.equal(byKind(report.items, 'question.dragDropIntr').length, 1);
  assert.ok(byKind(report.items, 'trigger.source').some((x) => x.path.startsWith('story/slides/slide7.xml')));
  assert.equal(report.consumed.layers, 2);
});

test('import: quiz, results slide (submit first), quiz variables in conditions and text', () => {
  const { doc, report } = importSynthetic();
  const Q = ID('q', 40);
  assert.deepEqual(doc.quizzes, [{ id: Q, title: 'Quiz1', questions: [ID('s', 103), ID('s', 104), ID('s', 105), ID('s', 106)], passPercent: 80, results: ID('s', 108) }]);
  const s8 = doc.slides.find((s) => s.id === ID('s', 108));
  assert.deepEqual(s8.triggers.map((t) => t.do[0].action), ['submitQuiz', 'showLayer', 'showLayer']);
  assert.deepEqual(s8.triggers[1].if, { all: [{ var: `${Q}.scorePoints`, op: '>=', otherVar: `${Q}.passPoints` }] });
  assert.equal(s8.objects[0].text, `Score: %${Q}.scorePercent%%`);
  assert.equal(byKind(report.items, 'trigger.reordered').length, 1);
  const retry = s8.layers[1].triggers.map((t) => t.do[0]);
  assert.deepEqual(retry, [{ action: 'resetQuiz', quiz: Q }, { action: 'jump', to: ID('s', 103) }]);
  assert.deepEqual(s8.layers[0].triggers.map((t) => t.do[0]), [{ action: 'reviewQuiz', quiz: Q }], 'ReviewQuizSL');
});

test('import: the result plays in the runtime (quiz end to end)', () => {
  const { doc } = importSynthetic();
  const ev = [{ type: 'menu', slide: ID('s', 103) }, { type: 'choose', choice: ID('c', 403) }, { type: 'submit' }, { type: 'continue' },
    { type: 'choose', choice: ID('c', 502) }, { type: 'choose', choice: ID('c', 504) }, { type: 'submit' }, { type: 'continue' },
    { type: 'choose', choice: ID('c', 602) }, { type: 'submit' }, { type: 'continue' },
    { type: 'input', answer: true, text: 'TEAL' }, { type: 'submit' }, { type: 'continue' }, { type: 'next' }];
  const r = play(doc, ev);
  for (const s of [103, 104, 105, 106]) assert.ok(r.trace.includes(`submit ${ID('s', s)} correct`), r.trace.join('\n'));
  assert.equal(r.slide, ID('s', 108));
  assert.ok(r.trace.includes(`quiz ${ID('q', 40)} submit 100 passed`), r.trace.join('\n'));
  assert.deepEqual(r.layers, [ID('l', 901)]);
});

// ---------- question banks (quizMgr/bankLst) and draw slides (bankSld) ----------
function bankStory() {
  const bankLst = `<bankLst><scene g="${G(33)}" name="Bank A" drawG="${G(34)}"><sldIdLst><sldId>R10</sldId><sldId>R11</sldId><sldId>R12</sldId></sldIdLst><bankProps rand="false" include="-1" /></scene>`
    + `<scene g="${G(35)}" name=""><sldIdLst /><bankProps rand="true" include="-1" /></scene></bankLst>`;
  const story = storyXml().replace(/<bankLst>.*<\/bankLst>/, bankLst)
    .replace('<sldId>R8</sldId><sldId>R9</sldId>', '<sldId>R9</sldId><sldId>R8</sldId>'); // native default membership precedes its results
  const q = (n, root) => slide(n, { root, shapes: intr('multiChoiceIntr', n * 10, { title: G(n * 10 + 1) }) + obj('textBox', n * 10 + 1, { plain: `Bank ${n}` })
    + choice('radio', n * 10 + 2, n * 10, 'Yes', 100, { selected: true }) + choice('radio', n * 10 + 3, n * 10, 'No', 200) });
  const item = (n, g, inc, exc, link = 'none') => `<bankSld g="${G(n)}" verG="${G(n + 50)}" link="${link}" exc="${exc}" sldG="${G(g)}" inc="${inc}" />`;
  const draw = slide(109, { root: 'bankSld', attrs: `resetMode="auto" advMode="user" bankG="${G(33)}" incCnt="2" sync="true" rnd="true"`, trigs: NAV + trig(1095, 'OnNextButtonClick', 'jumpToScene', { sub: 'spec', blocks: `<scene jumpG="${G(30)}" />` }) })
    .replace('</bankSld>', `<questionLst>${item(131, 110, true, false)}${item(132, 111, false, true, 'next')}${item(133, 112, false, false)}</questionLst><excLst /></bankSld>`);
  const parts = slides();
  parts[8] = draw; // R9: the draw slide in scene "Quiz"
  return pkg({ story, parts: [...parts, q(110, 'sld'), q(111, 'exSld'), q(112, 'sld')] }); // R10-R12: the bank
}

test('import: question banks become banks, bankSld becomes a draw slide; unmapped draw attributes are reported', () => {
  const { doc, report } = importStory(bankStory());
  assert.deepEqual(validate(doc), []);
  assert.deepEqual(doc.banks, [{ id: ID('bk', 33), title: 'Bank A', slides: [ID('s', 110), ID('s', 111), ID('s', 112)] }, { id: ID('bk', 35), title: 'Question bank', slides: [] }]);
  assert.ok(doc.slides.find((s) => s.id === ID('s', 111)).question, 'exSld bank slides are mapped like sld');
  const draw = doc.slides.find((s) => s.id === ID('s', 109));
  assert.deepEqual([draw.title, draw.draw, draw.triggers], ['Draw from Bank A', { bank: ID('bk', 33), count: 2, shuffle: true, always: [ID('s', 110)], never: [ID('s', 111)] }, []]);
  assert.deepEqual(doc.scenes[1].slides.at(-2), ID('s', 109));
  assert.deepEqual(doc.quizzes[0].questions, [103, 104, 105, 106, 109].map((n) => ID('s', n)), 'the quiz lists the draw, not the bank slides');
  for (const k of ['draw.sync', 'draw.link', 'draw.trigger', 'bank.props']) assert.equal(byKind(report.items, k).length, 1, k);
  assert.match(byKind(report.items, 'draw.link')[0].path, /#\/bankSld\/questionLst\/bankSld\[2\]$/);
  assert.deepEqual(summarize(report).mapped, { ...summarize(report).mapped, banks: 2, bankSlides: 3, draws: 1, slides: 12 });
  const r = play(doc, [{ type: 'menu', slide: ID('s', 109) }, { type: 'choose', choice: ID('c', 1102) }, { type: 'submit' }], { rng: () => 0 });
  assert.ok(r.trace.includes(`draw ${ID('s', 109)} ${ID('s', 110)},${ID('s', 112)}`), r.trace.join('\n'));
  assert.ok(r.trace.includes(`submit ${ID('s', 110)} correct`));
  assert.deepEqual(r.lms.filter((l) => l.startsWith('interaction')), [`interaction ${ID('s', 110)} correct`]);
});

test('import: deterministic ids and report across runs; summary counts add up', () => {
  const a = importStory(pkg(), { assetsDir: path.join(tmp(), 'a') });
  const b = importStory(pkg(), { assetsDir: path.join(tmp(), 'a') });
  assert.equal(serialize(a.doc), serialize(b.doc));
  assert.deepEqual(a.report.items, b.report.items);
  const s = summarize(a.report);
  assert.equal(s.reported, a.report.items.length);
  assert.equal(Object.values(s.byKind).reduce((x, y) => x + y, 0), s.reported);
  assert.equal(s.source.slides, 9);
  assert.equal(s.mapped.slides, 8);
  assert.ok(s.source.objects >= s.mapped.objects + s.consumed.objects);
});

test('import: without an assets folder pictures are reported, not guessed', () => {
  const { doc, report } = importStory(pkg());
  assert.deepEqual(validate(doc), []);
  assert.equal(doc.assets.length, 0);
  assert.equal(doc.title, 'Synthetic course');
  assert.equal(byKind(report.items, 'media.notExtracted').length, 2);
});

test('import: invalid leftovers are repaired by removal and reported as invalid', () => {
  const bad = slide(150, { shapes: intr('multiChoiceIntr', 151) + choice('radio', 152, 151, 'X', 100, { selected: true }) + choice('radio', 153, 151, 'Y', 200, { selected: true }) });
  const story = storyXml().replace('<sldId>R3</sldId>', '<sldId>R10</sldId><sldId>R3</sldId>');
  const { doc, report } = importStory(pkg({ story, parts: [...slides(), bad] }));
  assert.deepEqual(validate(doc), []);
  const s = doc.slides.find((x) => x.id === ID('s', 150));
  assert.equal(s.question, undefined, 'mc with two correct choices removed');
  const inv = byKind(report.items, 'invalid');
  assert.deepEqual(inv.map((x) => x.path), ['story/slides/slidea.xml#/sld/shapeLst/multiChoiceIntr', '/quizzes/0/questions/0']);
  assert.match(inv[0].reason, /exactly one correct choice.*removed/);
  assert.ok(!doc.quizzes[0].questions.includes(ID('s', 150)));
});

test('import: non-story archives and hostile XML are refused with clear errors', () => {
  assert.throws(() => importStory(zip([['a.txt', 'x']])), /story\/story.xml is missing/);
  assert.throws(() => importStory(zip([['story/story.xml', '<!DOCTYPE x><story/>']])), /DTD/);
  assert.throws(() => importStory(zip([['story/story.xml', '<notstory/>']])), /root is <notstory>/);
  assert.throws(() => importStory(Buffer.from('garbage')), /not a ZIP file/);
});

// ---------- importStoryFile and the three front-ends ----------
test('importStoryFile writes course, assets and report; refuses overwrite and assets outside the course folder', () => {
  const dir = tmp();
  const src = path.join(dir, 'in.story');
  fs.writeFileSync(src, pkg());
  const out = path.join(dir, 'syn.course.json');
  const r = importStoryFile(src, out);
  assert.equal(r.ok, true);
  assert.equal(r.assets, path.join(dir, 'assets', 'syn'));
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(out, 'utf8'))), []);
  const rep = JSON.parse(fs.readFileSync(r.reportFile, 'utf8'));
  assert.equal(path.basename(r.reportFile), 'syn.import-report.json');
  assert.equal(rep.items.length, r.summary.reported);
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'syn', `${ID('a', 20)}.png`)));
  assert.throws(() => importStoryFile(src, out), (e) => e.errors[0].code === 'dupe');
  assert.throws(() => importStoryFile(src, path.join(dir, 'x.course.json'), { assetsDir: path.join(dir, '..') }), (e) => e.errors[0].code === 'path');
  assert.throws(() => importStoryFile(path.join(dir, 'missing.story'), path.join(dir, 'y.course.json')), (e) => e.errors[0].code === 'ref');
  fs.writeFileSync(path.join(dir, 'bad.story'), 'not a zip');
  assert.throws(() => importStoryFile(path.join(dir, 'bad.story'), path.join(dir, 'z.course.json')), (e) => e.errors[0].code === 'import' && /not a ZIP/.test(e.errors[0].message));
});

test('CLI: cf import prints the summary; the result validates; a second run refuses to overwrite', () => {
  const dir = tmp();
  const src = path.join(dir, 'in.story');
  fs.writeFileSync(src, pkg());
  const out = path.join(dir, 'syn.course.json');
  const cf = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/cf.js'), ...args], { encoding: 'utf8' });
  const r = cf('import', src, out);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.summary.mapped.slides, 8);
  assert.equal(cf('validate', out).status, 0);
  const again = cf('import', src, out);
  assert.equal(again.status, 1);
  assert.equal(JSON.parse(again.stderr).errors[0].code, 'dupe');
  const custom = cf('import', src, path.join(dir, 'b.course.json'), '--assets', path.join(dir, 'img'));
  assert.equal(custom.status, 0, custom.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'img', `${ID('a', 20)}.png`)));
  assert.equal(cf('import', src).status, 2, 'missing output is a usage error');
});

test('MCP: import_story confines story, file and assets to the root', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'in.story'), pkg());
  const stdin = new PassThrough(), stdout = new PassThrough();
  createMcp({ core: {}, runtime: {}, io: {}, importer, root, stdin, stdout });
  let id = 0;
  const call = async (args) => {
    const n = ++id;
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'import_story', arguments: args } }) + '\n');
    for (;;) {
      const [chunk] = await once(stdout, 'data');
      const msg = JSON.parse(String(chunk).trim().split('\n').pop());
      if (msg.id === n) return JSON.parse(msg.result.content[0].text);
    }
  };
  const ok = await call({ story: 'in.story', file: 'syn.course.json' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual([ok.file, ok.assets, ok.reportFile], ['syn.course.json', 'assets/syn', 'syn.import-report.json']);
  assert.equal(ok.summary.mapped.questions, 4);
  assert.ok(fs.existsSync(path.join(root, 'syn.course.json')));
  for (const args of [{ story: '../in.story', file: 'a.course.json' }, { story: 'in.story', file: '../a.course.json' }, { story: 'in.story', file: 'a.course.json', assets: '../img' }]) {
    const bad = await call(args);
    assert.equal(bad.ok, false);
    assert.equal(bad.errors[0].code, 'path', JSON.stringify(args));
  }
  assert.equal((await call({ story: 'in.story', file: 'syn.course.json' })).errors[0].code, 'dupe');
});

test('HTTP: POST /api/import imports a .story inside the root; refuses escapes and duplicates', async () => {
  const dir = tmp();
  const root = path.join(dir, 'courses');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'in.story'), pkg());
  fs.writeFileSync(path.join(dir, 'outside.story'), pkg());
  const server = createHttp({ root, token: 'test-token-0123456789', port: 0 });
  await once(server, 'listening');
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/import`, { method: 'POST', headers: { 'x-cf-token': 'test-token-0123456789', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try {
    const r = await post({ path: 'in.story', name: 'syn' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.summary.mapped.slides, 8);
    assert.deepEqual(validate(r.data.doc), []);
    assert.ok(fs.existsSync(path.join(root, 'assets', 'syn', `${ID('a', 20)}.png`)));
    assert.equal((await post({ path: 'in.story', name: 'syn' })).status, 409);
    assert.equal((await post({ path: '../outside.story', name: 'x' })).status, 400);
    assert.equal((await post({ path: 'missing.story', name: 'x' })).status, 400);
    assert.equal((await post({ path: 'in.story', name: '../x' })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
