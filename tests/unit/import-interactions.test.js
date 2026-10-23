// original synthetic packages based on /
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStory, storyId } from '../../packages/import-story/index.js';
import { validate } from '../../packages/schema/index.js';
import { play } from '../../packages/runtime/index.js';
import { G, ID, ZERO, obj, intr, slide, layer, fbLayer, trig, pkg } from '../fixtures/synthetic/story-builder.js';

const fixture = (name) => fs.readFileSync(new URL(`../fixtures/synthetic/${name}`, import.meta.url));
const MP4 = fixture('clip-2s.mp4'), VTT = fixture('captions-2s.vtt');
const entry = (n, ext) => `story/media/R${storyId(G(n))}.${ext}`;
const slider = (attrs = '', extra = '<track start="0" end="10"/><ticks step="0.5"/>') => obj('slider', 201, {
  attrs: attrs || `varG="${G(3)}" action="drag"`, extra,
});
const dial = (attrs = '', tag = 'dial') => obj(tag, 202, { extra:
  `<dialData dialType="BuiltInDial" varG="${G(4)}" updateAction="drag" increment="2" rotation="180" ${attrs}><values start="0" end="12"/><rotationPoint xOffset="0" yOffset="0"/></dialData>`,
});
const video = (attrs = '', extra = '<embed/><url/>') => obj('video', 203, {
  attrs: `assetG="${G(22)}" thumbG="${G(20)}" ccG="${G(23)}" ${attrs || 'vidSrcType="local" play="auto" showCtrls="false" loop="false" vol="50" mute="false"'}`,
  at: [100, 200, 420, 380], tm: 'start="500" dur="2000" untilEnd="false"', extra,
}).replaceAll('txtTmCtx', 'vidTmCtx');
const area = (tag = 'clkAreaRect', n = 402, correct = true) => obj(tag, n, {
  at: [100, 150, 300, 250], extra: `<scoreData correct="${correct}"/>`,
});
const hotspot = (areas = area(), attempts = 'one') => slide(102, {
  shapes: intr('hotSpotIntr', 400, { attempts, cor: G(410), inc: G(420) })
    + obj('textBox', 401, { plain: 'Click the rectangle' }).replace('name="textBox-401"', 'name="&amp;Title"') + areas,
  trigs: trig(405, 'OnClick', 'submitInteraction', { name: 'SubmitInteraction', blocks: `<interaction submitG="${G(400)}"/>` }),
  layers: fbLayer(410, 'Correct', 'Hit!') + fbLayer(420, 'Incorrect', 'Miss.'),
});
function packageOf({ shapes = slider() + dial() + video(), question = hotspot(), media = '', extra, layers = '' } = {}) {
  const story = `<story id="${G(1)}"><varLst>`
    + `<var g="${G(3)}" type="user" dataType="num" name="level" val="2.5"/>`
    + `<var g="${G(4)}" type="user" dataType="num" name="turn" val="6"/>`
    + `<var g="${G(5)}" type="user" dataType="text" name="text" val="x"/></varLst>`
    + `<mediaLst><mediaLst><media g="${G(20)}" type="Png"/>`
    + (media || `<video g="${G(22)}" type="Mp4" hasClosedCaptions="false"/><media g="${G(23)}" type="Vtt"/>`)
    + `</mediaLst></mediaLst><sceneLst><scene g="${G(30)}" name="Synthetic"><sldIdLst><sldId>R1</sldId><sldId>R2</sldId></sldIdLst></scene></sceneLst></story>`;
  return pkg({ story, parts: [slide(101, { shapes, layers }), question], extra: extra ?? [[entry(22, 'mpeg'), MP4], [entry(23, 'vtt'), VTT]] });
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-x6-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function imported(t, options = {}) {
  const dir = temp(t);
  return { dir, ...importStory(packageOf(options), { courseDir: dir, assetsDir: path.join(dir, 'assets') }) };
}
const kinds = (report) => report.items.map((i) => i.kind);

test('slider, dial, hotspot and video import to valid fields with extracted MP4, poster and ccG captions', (t) => {
  const { doc, report, dir } = imported(t);
  assert.deepEqual(validate(doc), []);
  const [s, d, v] = doc.slides[0].objects;
  assert.deepEqual([s.type, s.var, s.min, s.max, s.step, s.live], ['slider', 'level', 0, 10, 0.5, true]);
  assert.deepEqual([d.type, d.var, d.min, d.max, d.step, d.live, d.startAngle, d.endAngle], ['dial', 'turn', 0, 12, 2, true, -90, 90]);
  assert.deepEqual([v.type, v.media, v.poster, v.captions, v.autoplay, v.controls, v.loop, v.start, v.end],
    ['video', ID('a', 22), ID('a', 20), ID('a', 23), true, false, false, 500, 2500]);
  assert.deepEqual([v.x, v.y, v.w, v.h], [100, 200, 320, 180]);
  for (const [id, ext, mime, bytes] of [[22, 'mp4', 'video/mp4', MP4], [23, 'vtt', 'text/vtt', VTT], [20, 'png', 'image/png', fixture('synthetic-200x120.png')]]) {
    const a = doc.assets.find((a) => a.id === ID('a', id));
    assert.equal(a.path, `assets/${ID('a', id)}.${ext}`);
    assert.equal(a.mime, mime);
    assert.deepEqual(fs.readFileSync(path.join(dir, a.path)), bytes);
  }
  const q = doc.slides[1].question;
  assert.deepEqual(q.areas, [{ id: ID('c', 402), shape: 'rect', x: 100, y: 150, w: 200, h: 100, correct: true }]);
  assert.deepEqual([q.type, q.prompt, q.points, q.attempts, q.feedback.correct, q.feedback.incorrect], ['hotspot', 'Click the rectangle', 10, 1, 'Hit!', 'Miss.']);
  assert.equal(doc.slides[1].objects.length, 0);
  assert.equal(doc.slides[1].layers.length, 0);
  assert.equal(doc.slides[1].triggers.length, 0);
  assert.ok(report.items.some((i) => i.kind === 'dial.angles' && /inferred/.test(i.reason)));
  assert.ok(kinds(report).includes('question.hotspotGrouping'));
  assert.ok(kinds(report).includes('video.vol'));
  assert.ok(!kinds(report).includes('invalid'));
  for (const item of report.items) assert.deepEqual(Object.keys(item).sort(), ['kind', 'path', 'reason']);
});

test('imported controls play with initial values, snapping, and correct/incorrect hotspot hits', (t) => {
  const { doc } = imported(t);
  assert.deepEqual(play(doc, []).vars, { level: 2.5, turn: 6, text: 'x' });
  const events = [{ type: 'slide', target: ID('o', 201), value: 7.6 }, { type: 'slide', target: ID('o', 202), value: 9 }, { type: 'next' }];
  const r = play(doc, [...events, { type: 'point', x: 200, y: 200 }, { type: 'submit' }]);
  assert.deepEqual(r.vars, { level: 7.5, turn: 10, text: 'x' });
  assert.equal(r.view.question.result, 'correct');
  assert.deepEqual(r.view.feedback, { kind: 'correct', text: 'Hit!' });
  assert.deepEqual(play(doc, [...events, { type: 'point', x: 10, y: 10 }, { type: 'submit' }]).view.feedback, { kind: 'incorrect', text: 'Miss.' });
});

test('dialData on a shape and controls on layers use the same mapping; unlimited hotspot attempts survive', (t) => {
  const { doc } = imported(t, { shapes: dial('', 'rect'), layers: layer(300, { shapes: slider() }), question: hotspot(area(), 'unlimited') });
  assert.deepEqual(validate(doc), []);
  assert.equal(doc.slides[0].objects[0].type, 'dial');
  assert.equal(doc.slides[0].layers[0].objects[0].type, 'slider');
  assert.equal(doc.slides[1].question.attempts, 0);
});

test('unobserved modes, bad variables/ranges and unsupported dial variants are reported, not guessed', (t) => {
  const cases = [
    [slider(`varG="${G(3)}" action="release"`), 'slider.action'],
    [slider(`varG="${G(5)}" action="drag"`), 'slider.variable'],
    [slider(`varG="${ZERO}" action="drag"`), 'slider.variable'],
    [slider('', '<track start="NaN" end="10"/><ticks step="1"/>'), 'slider.range'],
    [slider('', '<track start="10" end="0"/><ticks step="1"/>'), 'slider.range'],
    [slider('', '<track start="0" end="10"/><ticks step="0"/>'), 'slider.range'],
    [dial().replace('updateAction="drag"', 'updateAction="release"'), 'dial.action'],
    [dial().replace('rotation="180"', 'rotation="0"'), 'dial.variant'],
    [dial('rotationIndicatorOffsetDegrees="20"'), 'dial.variant'],
    [dial().replace('BuiltInDial', 'Custom'), 'dial.variant'],
    [obj('audio', 500) + obj('sound', 501), 'object.audio'],
  ];
  for (const [shapes, kind] of cases) {
    const { doc, report } = imported(t, { shapes });
    assert.deepEqual(validate(doc), []);
    assert.equal(doc.slides[0].objects.length, 0, kind);
    assert.ok(kinds(report).includes(kind), kind);
  }
});

test('unknown or invalid hotspot areas cannot silently change the answer key', (t) => {
  for (const areas of [area() + area('clkAreaUnknown', 403), area('clkAreaFreeform'), area('clkAreaRect', 402, false), area().replace('r="300"', 'r="oops"'), '']) {
    const { doc, report } = imported(t, { shapes: '', question: hotspot(areas) });
    assert.deepEqual(validate(doc), []);
    assert.equal(doc.slides[1].question, undefined);
    assert.ok(kinds(report).some((k) => k === 'question.hotspot' || k === 'invalid'));
  }
});

test('oval hotspot mapping is explicitly inferred; ellipse center hits and bounding-box corner misses', (t) => {
  const { doc, report } = imported(t, { question: hotspot(area('clkAreaOval')) });
  assert.deepEqual(validate(doc), []);
  assert.equal(doc.slides[1].question.areas[0].shape, 'ellipse');
  assert.ok(report.items.some((i) => i.kind === 'question.hotspotShape' && /inferred/.test(i.reason)));
  const hit = (x, y) => play(doc, [{ type: 'next' }, { type: 'point', x, y }, { type: 'submit' }]).view.question.result;
  assert.equal(hit(200, 200), 'correct');
  assert.equal(hit(101, 151), 'incorrect');
});

test('missing/corrupt video, wrong media types, external sources and absent extraction are reported', (t) => {
  for (const options of [
    { extra: [] },
    { extra: [[entry(22, 'mpeg'), MP4, { crc: 123 }]] },
    { media: `<video g="${G(22)}" type="Webm"/>` },
    { shapes: video('vidSrcType="url"', '<url>https://example.invalid/video.mp4</url>') },
    { shapes: video().replace(`assetG="${G(22)}"`, 'assetG="../../escape"') },
  ]) {
    const { doc, report } = imported(t, { shapes: video(), ...options });
    assert.deepEqual(validate(doc), []);
    assert.equal(doc.slides[0].objects.length, 0);
    assert.ok(kinds(report).some((k) => k.startsWith('media.') || k === 'video.source'));
  }
  const { doc, report } = importStory(packageOf());
  assert.deepEqual(validate(doc), []);
  assert.ok(kinds(report).includes('media.notExtracted'));
});

test('caption/poster references are checked by type even when an asset is already cached', (t) => {
  const { doc, report } = imported(t, { shapes: obj('pic', 204, { attrs: `assetG="${G(20)}"` })
    + video().replace(`ccG="${G(23)}"`, `ccG="${G(20)}"`).replace(`thumbG="${G(20)}"`, `thumbG="${G(22)}"`) });
  assert.deepEqual(validate(doc), []);
  const v = doc.slides[0].objects[1];
  assert.equal(v.type, 'video');
  assert.equal(v.captions, undefined);
  assert.equal(v.poster, undefined);
  assert.equal(kinds(report).filter((k) => k === 'media.type').length, 2);
});

test('hostile media archive paths and output folder escapes are refused', (t) => {
  const dir = temp(t), outside = temp(t);
  for (const name of ['../escape.mp4', 'story/media/../../escape.vtt', 'C:/escape.mp4', 'story\\media\\escape.mp4']) {
    assert.throws(() => importStory(packageOf({ extra: [[name, MP4]] }), { courseDir: dir, assetsDir: path.join(dir, 'assets') }), /unsafe entry name/);
  }
  assert.throws(() => importStory(packageOf(), { courseDir: dir, assetsDir: outside }), /outside the course folder/);
  fs.symlinkSync(outside, path.join(dir, 'linked'), 'junction');
  assert.throws(() => importStory(packageOf(), { courseDir: dir, assetsDir: path.join(dir, 'linked', 'assets') }), /outside the course folder/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('video and caption writes never overwrite existing files', (t) => {
  for (const [n, ext] of [[22, 'mp4'], [23, 'vtt']]) {
    const dir = temp(t), assetsDir = path.join(dir, 'assets');
    fs.mkdirSync(assetsDir);
    const file = path.join(assetsDir, `${ID('a', n)}.${ext}`);
    fs.writeFileSync(file, 'keep me');
    assert.throws(() => importStory(packageOf(), { courseDir: dir, assetsDir }), /EEXIST/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');
  }
});
