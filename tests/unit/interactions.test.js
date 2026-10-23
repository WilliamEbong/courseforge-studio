// slider, dial, hotspot question, video/audio, freeform drag-and-drop (schema, commands, runtime, LMS).
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse, validate } from '../../packages/schema/index.js';
import { applyAll, describe, query } from '../../packages/core/index.js';
import { createRuntime, seededRng } from '../../packages/runtime/index.js';
import { toScormInteraction, publishWeb, publishScorm12, validatePackage } from '../../packages/publisher/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScorm12Api } from '../../packages/lms-test-harness/scorm12.js';
import '../../packages/publisher/cf-scorm.js';
import { importStory } from '../../packages/import-story/index.js';
import { G, ID, docXml, obj, trig, slide, intr, slides, pkg } from '../fixtures/synthetic/story-builder.js';

// Runtime LMS records -> publisher mapping -> CFScorm adapter -> mock SCORM 1.2 API: the cmi.interactions fields.
function scormLms() {
  const sets = [];
  const api = createScorm12Api({ load: () => null, save: () => {} }, (e) => { if (e.fn === 'LMSSetValue' && e.args[0].startsWith('cmi.interactions.')) sets.push(`${e.args[0].replace(/^cmi\.interactions\./, '')}=${e.args[1]}`); });
  const ad = globalThis.CFScorm.createScormAdapter({ win: { parent: { API: api }, addEventListener() {} }, courseId: 'ix', now: () => new Date(2026, 9, 16, 0, 0, 0).getTime() }); // local midnight: CMITime 00:00:00
  const records = [];
  return { sets, records, lms: { init: ad.init, status() {}, score() {}, save() {}, interaction: (r) => { records.push(r); ad.interaction(toScormInteraction(r)); } }, warnings: ad.warnings };
}
const fields = (sets, n) => Object.fromEntries(sets.filter((s) => s.startsWith(`${n}.`)).map((s) => { const [k, v] = s.slice(String(n).length + 1).split('='); return [k, v]; }));

const build = (cmds) => {
  const r = applyAll(emptyCourse({ id: 'ix', title: 'Interactions' }), cmds, { rng: seededRng(9) });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.doc;
};
const fails = (doc, cmds) => {
  const r = applyAll(doc, cmds);
  assert.equal(r.ok, false, 'expected the batch to fail');
  return r.errors;
};
const run = (doc, events = [], lms = null) => {
  const rt = createRuntime(doc, { lms, rng: seededRng(3) });
  rt.start();
  for (const e of events) rt.dispatch(e);
  return rt;
};

// ---------------- slider and dial (FR-1) ----------------
const rangeDoc = () => build([
  { cmd: 'var.add', args: { name: 'level', type: 'number', initial: 0 } },
  { cmd: 'var.add', args: { name: 'turn', type: 'number', initial: 6 } },
  { cmd: 'var.add', args: { name: 'changes', type: 'number', initial: 0 } },
  { cmd: 'slide.add', args: { id: 's-1', title: 'Range', objects: [
    { id: 'o-sl', type: 'slider', var: 'level', name: 'Level', x: 80, y: 100, w: 600, h: 48 },
    { id: 'o-dl', type: 'dial', var: 'turn', x: 80, y: 200, w: 180, h: 180, step: 2 },
    { id: 'o-txt', type: 'text', text: 'L=%level% T=%turn%' },
  ] } },
  { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'varChange', var: 'level' }, do: [{ action: 'setVar', var: 'changes', op: 'add', value: 1 }] } },
]);

test('slider/dial validation: number variable required, min < max, step > 0, distinct angles', () => {
  const d = rangeDoc();
  assert.deepEqual(validate(d), []);
  const code = (patch) => fails(d, [{ cmd: 'object.set', args: { id: 'o-sl', ...patch } }]).map((e) => `${e.code}:${e.path}`);
  assert.deepEqual(code({ var: null }), ['required:/slides/0/objects/0/var']);
  assert.match(fails(d, [{ cmd: 'var.add', args: { name: 'label', type: 'text' } }, { cmd: 'object.set', args: { id: 'o-sl', var: 'label' } }])[0].message, /number variable; "label" is text/);
  assert.deepEqual(code({ var: 'nope' }), ['ref:/slides/0/objects/0/var']);
  assert.deepEqual(code({ min: 10 }), ['range:/slides/0/objects/0/max']);
  assert.deepEqual(code({ step: 0 }), ['range:/slides/0/objects/0/step']);
  assert.deepEqual(fails(d, [{ cmd: 'object.set', args: { id: 'o-dl', startAngle: 90 } }]).map((e) => e.code), ['range']);
  assert.match(fails(d, [{ cmd: 'object.add', args: { slide: 's-1', type: 'slider' } }])[0].hint, /number variables: level, turn, changes/);
});

test('slide event snaps to the step, clamps, sets the variable and fires varChange once per change', () => {
  const rt = run(rangeDoc());
  const v = () => rt.state.vars;
  rt.dispatch({ type: 'slide', target: 'o-sl', value: 2.6 });
  assert.equal(v().level, 3);
  rt.dispatch({ type: 'slide', target: 'o-sl', value: 3.2 }); // same snapped value: no varChange
  rt.dispatch({ type: 'slide', target: 'o-sl', value: 99 });
  assert.equal(v().level, 10);
  rt.dispatch({ type: 'slide', target: 'o-sl', value: -5 });
  assert.equal(v().level, 0);
  assert.equal(v().changes, 3);
  rt.dispatch({ type: 'slide', target: 'o-dl', value: 6.9 }); // dial step 2 from 0: 6.9 -> 6
  assert.equal(v().turn, 6);
  rt.dispatch({ type: 'slide', target: 'o-dl', value: 7.1 });
  assert.equal(v().turn, 8);
  rt.dispatch({ type: 'slide', target: 'o-dl', value: 13 }); // dial default max 12
  assert.equal(v().turn, 12);
  assert.equal(rt.view().objects.find((o) => o.id === 'o-txt').text, 'L=0 T=12');
  rt.dispatch({ type: 'slide', target: 'o-txt', value: 1 });
  rt.dispatch({ type: 'slide', target: 'o-sl', value: 'x' });
  assert.ok(rt.trace.includes('warn o-txt is not a slider or dial'));
  assert.ok(rt.trace.includes('warn bad value x'));
});

test('fractional steps stay exact; disabled, hidden and modal-blocked sliders ignore input', () => {
  const d = build([
    { cmd: 'var.add', args: { name: 'x', type: 'number', initial: 0 } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-sl', type: 'slider', var: 'x', min: 0, max: 1, step: 0.1 }, { id: 'o-off', type: 'slider', var: 'x', initialState: 'disabled' }] } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-m', modal: true } },
  ]);
  const rt = run(d, [{ type: 'slide', target: 'o-sl', value: 0.30000000000000004 }]);
  assert.equal(rt.state.vars.x, 0.3);
  rt.dispatch({ type: 'slide', target: 'o-sl', value: 0.71 });
  assert.equal(rt.state.vars.x, 0.7);
  rt.dispatch({ type: 'slide', target: 'o-off', value: 5 });
  assert.equal(rt.state.vars.x, 0.7);
  assert.ok(rt.trace.includes('ignored slide o-off'));
  createRuntime(d); // no throw for a fresh runtime
  const rt2 = run(build([
    { cmd: 'var.add', args: { name: 'x', type: 'number', initial: 0 } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-sl', type: 'slider', var: 'x' }, { id: 'o-b', type: 'button', text: 'b' }] } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-m', modal: true } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-b' }, do: [{ action: 'showLayer', layer: 'l-m' }] } },
  ]), [{ type: 'click', target: 'o-b' }, { type: 'slide', target: 'o-sl', value: 4 }]);
  assert.equal(rt2.state.vars.x, 0, 'a modal layer blocks the base slider');
});

test('view and describe expose range, live flag, dial angles and the label parts', () => {
  const d = rangeDoc();
  const v = run(d).view();
  const sl = v.objects.find((o) => o.id === 'o-sl');
  assert.deepEqual([sl.min, sl.max, sl.step, sl.value, sl.live, sl.name, sl.interactive], [0, 10, 1, 0, true, 'Level', true]);
  const dl = v.objects.find((o) => o.id === 'o-dl');
  assert.deepEqual([dl.min, dl.max, dl.step, dl.value, dl.startAngle, dl.endAngle], [0, 12, 2, 6, -90, 90]);
  const text = describe(d);
  assert.match(text, /o-sl slider @80,100 600x48 var=level 0\.\.10 step 1/);
  assert.match(text, /o-dl dial .* var=turn 0\.\.12 step 2 -90°\.\.90°/);
});

// ---------------- hotspot question (FR-2) ----------------
const hotspotDoc = (attempts = 1) => build([
  { cmd: 'slide.add', args: { id: 's-hs', title: 'Hotspot', question: { type: 'hotspot', prompt: 'Click the valve', attempts, areas: [
    { id: 'valve', x: 100, y: 100, w: 200, h: 100, correct: true },
    { id: 'pipe', shape: 'ellipse', x: 400, y: 100, w: 200, h: 100 },
  ] } } },
  { cmd: 'slide.add', args: { id: 's-end', title: 'End' } },
  { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-hs'] } },
]);

test('hotspot validation: 1-25 areas, one correct, unique ids; no choices needed', () => {
  const d = hotspotDoc();
  assert.deepEqual(validate(d), []);
  const msg = (areas) => fails(d, [{ cmd: 'question.set', args: { slide: 's-hs', areas } }])[0].message;
  assert.match(msg([]), /1 to 25 areas \(found 0\)/);
  assert.match(msg([{ id: 'a', x: 0, y: 0, w: 5, h: 5 }]), /at least one correct area/);
  assert.match(msg([{ id: 'a', x: 0, y: 0, w: 5, h: 5, correct: true }, { id: 'a', x: 9, y: 9, w: 5, h: 5 }]), /area id "a" repeated/);
  assert.match(msg(Array.from({ length: 26 }, (_, i) => ({ id: `a${i}`, x: i, y: 0, w: 5, h: 5, correct: true }))), /found 26/);
  assert.equal(fails(d, [{ cmd: 'question.set', args: { slide: 's-hs', areas: [{ id: 'a', x: 0, y: 0, w: 0, h: 5, correct: true }] } }])[0].code, 'range');
  const r = applyAll(d, [{ cmd: 'question.set', args: { slide: 's-hs', type: 'mc', choices: [{ id: 'a', label: 'A', correct: true }, { id: 'b', label: 'B' }], areas: null } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.equal(r.doc.slides[0].question.areas, undefined, 'areas: null removes them');
  assert.match(describe(d), /question hotspot "Click the valve" areas=\*valve:rect@100,100 200x100 pipe:ellipse@400,100 200x100/);
});

test('hotspot runtime: no point = nothing to submit; last point wins; hit test decides', () => {
  const run1 = (pts) => {
    const rt = run(hotspotDoc(), pts.map(([x, y]) => ({ type: 'point', x, y })));
    rt.dispatch({ type: 'submit' });
    return rt;
  };
  const none = run1([]);
  assert.ok(none.trace.includes('warn nothing to submit'));
  assert.equal(none.view().question.answered, false);
  assert.equal(run1([[150, 150]]).state.feedback, 'correct');
  assert.equal(run1([[10, 10], [150, 150]]).state.feedback, 'correct', 'the last click counts');
  assert.equal(run1([[150, 150], [10, 10]]).state.feedback, 'incorrect');
  assert.equal(run1([[500, 150]]).state.feedback, 'incorrect', 'inside an incorrect area');
  assert.equal(run1([[405, 105]]).state.feedback, 'incorrect', 'corner of the ellipse box is outside the ellipse');
  assert.deepEqual(run1([[-50, 99999]]).state.q['s-hs'].point, { x: 0, y: 720 }, 'clamped to the slide');
  const locked = run1([[150, 150]]);
  locked.dispatch({ type: 'point', x: 1, y: 1 }); // feedback open: ignored
  assert.deepEqual(locked.state.q['s-hs'].point, { x: 150, y: 150 });
  locked.dispatch({ type: 'continue' });
  assert.equal(locked.state.slide, 's-end');
  assert.ok(run(hotspotDoc(), [{ type: 'point', x: 'a', y: 2 }]).trace.includes('warn bad point'));
  assert.ok(run(rangeDoc(), [{ type: 'point', x: 1, y: 2 }]).trace.includes('warn not a hotspot question'));
});

test('hotspot try again keeps the point; the final result locks it; resume restores it', () => {
  const rt = run(hotspotDoc(2), [{ type: 'point', x: 10, y: 10 }, { type: 'submit' }]);
  assert.equal(rt.state.feedback, 'tryAgain');
  rt.dispatch({ type: 'continue' });
  assert.deepEqual(rt.view().question.point, { x: 10, y: 10 });
  rt.dispatch({ type: 'point', x: 120, y: 120 });
  rt.dispatch({ type: 'submit' });
  assert.equal(rt.state.feedback, 'correct');
  const snap = rt.snapshot();
  const back = createRuntime(hotspotDoc(2), { lms: { init: () => snap } });
  back.start({ resume: 'always' });
  assert.deepEqual(back.state.q['s-hs'].point, { x: 120, y: 120 });
  assert.equal(back.state.q['s-hs'].result, 'correct');
  back.dispatch({ type: 'continue' });
  back.dispatch({ type: 'menu', slide: 's-hs' });
  back.dispatch({ type: 'point', x: 1, y: 1 });
  assert.deepEqual(back.state.q['s-hs'].point, { x: 120, y: 120 }, 'locked after the final result');
  const evil = structuredClone(snap);
  evil.q['s-hs'].point = { x: 'x', y: 1 };
  const r2 = createRuntime(hotspotDoc(2), { lms: { init: () => evil } });
  r2.start({ resume: 'always' });
  assert.equal(r2.state.q['s-hs'].point, null, 'an invalid point from the store is dropped');
});

test('hotspot LMS: SCORM 1.2 choice, one letter per area, outside = next letter, one pattern per correct area', () => {
  const d = build([
    { cmd: 'slide.add', args: { id: 's-hs', question: { type: 'hotspot', prompt: 'p', attempts: 0, areas: [
      { id: 'a1', x: 0, y: 100, w: 100, h: 100, correct: true }, { id: 'a2', x: 200, y: 100, w: 100, h: 100 }, { id: 'a3', x: 400, y: 100, w: 100, h: 100, correct: true },
    ] } } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-hs'] } },
  ]);
  const L = scormLms();
  const rt = createRuntime(d, { lms: L.lms });
  rt.start();
  for (const [x, y] of [[250, 150], [999, 600], [450, 150]]) { rt.dispatch({ type: 'point', x, y }); rt.dispatch({ type: 'submit' }); rt.dispatch({ type: 'continue' }); }
  assert.deepEqual(L.records.map((r) => [r.type, r.response, r.responseLabels, r.correct, r.result]), [
    ['hotspot', [1], ['a2'], [0, 2], 'incorrect'], ['hotspot', [3], ['outside'], [0, 2], 'incorrect'], ['hotspot', [2], ['a3'], [0, 2], 'correct'],
  ]);
  assert.deepEqual(fields(L.sets, 0), { id: 'qz_s-hs_0_0', 'objectives.0.id': 'qz', time: '00:00:00', type: 'choice', 'correct_responses.0.pattern': 'a', 'correct_responses.1.pattern': 'c', weighting: '10', student_response: 'b', result: 'wrong', latency: '0000:00:00.00' });
  assert.equal(fields(L.sets, 1).student_response, 'd');
  assert.deepEqual([fields(L.sets, 2).student_response, fields(L.sets, 2).result], ['c', 'correct']);
  assert.deepEqual(L.warnings, []);
});

// ---------------- video and audio (FR-3) ----------------
const mediaDoc = () => build([
  { cmd: 'var.add', args: { name: 'ends', type: 'number', initial: 0 } },
  { cmd: 'asset.add', args: { id: 'a-clip', path: 'assets/clip.mp4', alt: 'Test pattern' } },
  { cmd: 'asset.add', args: { id: 'a-cc', path: 'assets/clip.vtt' } },
  { cmd: 'asset.add', args: { id: 'a-tone', path: 'assets/tone.wav' } },
  { cmd: 'slide.add', args: { id: 's-1', title: 'Media', objects: [
    { id: 'o-vid', type: 'video', media: 'a-clip', captions: 'a-cc', controls: false, x: 100, y: 100, w: 320, h: 180 },
    { id: 'o-aud', type: 'audio', media: 'a-tone', autoplay: true },
    { id: 'o-play', type: 'button', text: 'Play' },
  ] } },
  { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-play' }, do: [{ action: 'stopMedia', target: 'o-aud' }, { action: 'playMedia', target: 'o-vid' }, { action: 'pauseMedia', target: 'o-vid' }] } },
  { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'mediaEnd', target: 'o-vid' }, do: [{ action: 'setVar', var: 'ends', op: 'add', value: 1 }] } },
]);

test('media validation: media asset required, captions must be .vtt, media events/actions need media objects', () => {
  const d = mediaDoc();
  assert.deepEqual(validate(d), []);
  assert.equal(fails(d, [{ cmd: 'object.add', args: { slide: 's-1', type: 'video' } }])[0].code, 'required');
  assert.match(fails(d, [{ cmd: 'object.set', args: { id: 'o-vid', captions: 'a-clip' } }])[0].message, /WebVTT/);
  assert.equal(fails(d, [{ cmd: 'object.set', args: { id: 'o-vid', poster: 'a-nope' } }])[0].code, 'ref');
  assert.match(fails(d, [{ cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'mediaEnd', target: 'o-play' }, do: [] } }])[0].hint, /media objects: o-vid, o-aud/);
  assert.match(fails(d, [{ cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-play' }, do: [{ action: 'playMedia', target: 'o-play' }] } }])[0].message, /playMedia needs a video or audio object/);
  assert.match(fails(d, [{ cmd: 'asset.remove', args: { id: 'a-cc' } }])[0].message, /still referenced/);
  const r = applyAll(d, [{ cmd: 'asset.remove', args: { id: 'a-cc', force: true } }]);
  assert.ok(r.ok && r.doc.slides[0].objects[0].captions === undefined, 'force removes the captions reference');
  assert.match(describe(d), /o-vid video @100,100 320x180 media=a-clip captions=a-cc no-controls/);
  assert.match(describe(d), /→ stop o-aud; play o-vid; pause o-vid/);
});

test('media runtime: actions and a click on a control-less video become trace commands; mediaEnd fires triggers', () => {
  const rt = run(mediaDoc(), [{ type: 'click', target: 'o-play' }, { type: 'click', target: 'o-vid' }, { type: 'mediaEnd', target: 'o-vid' }, { type: 'mediaEnd', target: 'o-play' }]);
  const media = rt.trace.filter((l) => l.startsWith('media '));
  assert.deepEqual(media, ['media stop o-aud', 'media play o-vid', 'media pause o-vid', 'media toggle o-vid', 'media ended o-vid']);
  assert.equal(rt.state.vars.ends, 1);
  assert.ok(rt.trace.includes('warn o-play is not a video or audio object'));
  const v = rt.view().objects;
  assert.deepEqual(v.find((o) => o.id === 'o-vid'), { ...v.find((o) => o.id === 'o-vid'), media: 'assets/clip.mp4', captions: { id: 'a-cc', path: 'assets/clip.vtt' }, poster: null, autoplay: false, controls: false, loop: false, alt: 'Test pattern', interactive: false });
  assert.equal(v.find((o) => o.id === 'o-aud').autoplay, true);
  const withControls = run(build([{ cmd: 'asset.add', args: { id: 'a-v', path: 'v.mp4' } }, { cmd: 'slide.add', args: { objects: [{ id: 'o-v', type: 'video', media: 'a-v' }] } }]), [{ type: 'click', target: 'o-v' }]);
  assert.ok(!withControls.trace.some((l) => l.startsWith('media ')), 'native controls handle clicks themselves');
});

test('publish: media and .vtt copied as is; captions embedded in cf-captions.js; CSP adds media-src blob: only then', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ix-pub-'));
  const course = path.join(base, 'course');
  fs.mkdirSync(path.join(course, 'assets'), { recursive: true });
  const FIX = new URL('../fixtures/synthetic/', import.meta.url);
  fs.copyFileSync(new URL('clip-2s.mp4', FIX), path.join(course, 'assets/clip.mp4'));
  fs.writeFileSync(path.join(course, 'assets/clip.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nSee https://example.org/a </b>\n');
  fs.copyFileSync(new URL('tone-440hz-2s.wav', FIX), path.join(course, 'assets/tone.wav'));
  const out = path.join(base, 'scorm');
  const r = publishScorm12(mediaDoc(), out, { courseDir: course });
  assert.ok(r.files.includes('cf-captions.js') && r.files.includes('assets/clip.mp4') && r.files.includes('assets/clip.vtt'));
  assert.deepEqual(fs.readFileSync(path.join(out, 'assets/clip.mp4')), fs.readFileSync(new URL('clip-2s.mp4', FIX)), 'no transcoding');
  const cap = fs.readFileSync(path.join(out, 'cf-captions.js'), 'utf8');
  const CF = {};
  new Function('window', cap)(CF);
  assert.equal(CF.CF_CAPTIONS['a-cc'], fs.readFileSync(path.join(course, 'assets/clip.vtt'), 'utf8'));
  assert.ok(!cap.includes('</') && !cap.includes('https://'));
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /media-src 'self' blob:/);
  assert.match(html, /<script src="course.js"><\/script>\n<script src="cf-captions.js"><\/script>/);
  assert.deepEqual(validatePackage(out), []);
  const plain = path.join(base, 'web');
  publishWeb(rangeDoc(), plain, { courseDir: course });
  assert.doesNotMatch(fs.readFileSync(path.join(plain, 'index.html'), 'utf8'), /media-src|cf-captions/);
});

// ---------------- freeform drag-and-drop (FR-4) ----------------
const ddDoc = (attempts = 0) => build([
  { cmd: 'slide.add', args: { id: 's-dd', title: 'Sort', objects: [
    { id: 'o-bin-a', type: 'shape', x: 100, y: 400, w: 300, h: 200, text: 'A' },
    { id: 'o-bin-b', type: 'shape', x: 600, y: 400, w: 300, h: 200, text: 'B' },
    { id: 'o-x', type: 'button', text: 'x', x: 100, y: 100, w: 100, h: 40 },
    { id: 'o-y', type: 'button', text: 'y', x: 250, y: 100, w: 100, h: 40 },
    { id: 'o-z', type: 'button', text: 'z', x: 400, y: 100, w: 100, h: 60 },
    { id: 'o-noise', type: 'button', text: 'noise', x: 550, y: 100, w: 100, h: 40 },
  ] } },
  { cmd: 'layer.add', args: { slide: 's-dd', id: 'l-help', modal: true } },
  { cmd: 'question.set', args: { slide: 's-dd', type: 'dragdrop', prompt: 'Sort them', attempts, items: [
    { object: 'o-x', target: 'o-bin-a' }, { object: 'o-y', target: 'o-bin-b' }, { object: 'o-z', target: 'o-bin-b' }, { object: 'o-noise' },
  ], targets: [{ object: 'o-bin-a' }, { object: 'o-bin-b', capacity: 'many' }] } },
  { cmd: 'slide.add', args: { id: 's-end', title: 'End' } },
  { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-dd'] } },
]);
const at = (rt, id) => { const o = rt.view().objects.find((x) => x.id === id); return [o.x, o.y]; };

test('drag-and-drop validation: base-layer objects, one role each, keys among the targets, SCORM limits', () => {
  const d = ddDoc();
  assert.deepEqual(validate(d), []);
  const err = (patch) => fails(d, [{ cmd: 'question.set', args: { slide: 's-dd', ...patch } }])[0];
  assert.match(err({ items: [{ object: 'o-x', target: 'o-nope' }] }).message, /not one of this question's targets/);
  assert.match(err({ items: [{ object: 'o-q', target: 'o-bin-a' }] }).hint, /base-layer objects: o-bin-a, o-bin-b/);
  assert.match(err({ items: [{ object: 'o-bin-a', target: 'o-bin-a' }] }).message, /already used/);
  assert.match(err({ items: [{ object: 'o-x' }] }).message, /at least one item needs a correct target/);
  assert.match(err({ targets: [] }).message, /1 to 26 targets \(found 0\)/);
  assert.match(err({ items: Array.from({ length: 11 }, () => ({ object: 'o-x' })) }).message, /1 to 10 items \(found 11\)/);
  assert.match(fails(d, [{ cmd: 'object.move', args: { id: 'o-x', layer: 'l-help' } }])[0].message, /"o-x" is not on this slide's base layer/);
  const dup = applyAll(d, [{ cmd: 'slide.duplicate', args: { id: 's-dd', newId: 's-dd2' } }], { rng: seededRng(4) });
  assert.ok(dup.ok, JSON.stringify(dup.errors));
  const copy = dup.doc.slides.find((s) => s.id === 's-dd2');
  assert.ok(copy.question.items.every((it) => copy.objects.some((o) => o.id === it.object) && (!it.target || copy.objects.some((o) => o.id === it.target))), 'slide.duplicate remaps items and targets');
  assert.match(describe(d), /question dragdrop "Sort them" items=o-x>o-bin-a o-y>o-bin-b o-z>o-bin-b o-noise>- targets=o-bin-a:one o-bin-b:many/);
});

test('drop rules: outside returns home, one-item targets centre and replace, many-item targets stack and compact', () => {
  const rt = run(ddDoc());
  assert.equal(rt.view().question.answered, false);
  rt.dispatch({ type: 'drop', item: 'o-x', target: 'o-bin-a' });
  assert.deepEqual(at(rt, 'o-x'), [200, 480], 'centred: 100 + (300-100)/2, 400 + (200-40)/2');
  rt.dispatch({ type: 'drop', item: 'o-y', target: 'o-bin-a' }); // replaces x, which returns to its start
  assert.deepEqual([at(rt, 'o-x'), at(rt, 'o-y')], [[100, 100], [200, 480]]);
  rt.dispatch({ type: 'drop', item: 'o-y', target: 'o-bin-b' });
  rt.dispatch({ type: 'drop', item: 'o-z', target: 'o-bin-b' });
  assert.deepEqual([at(rt, 'o-y'), at(rt, 'o-z')], [[604, 404], [604, 448]], 'stacked top-down from the top-left');
  rt.dispatch({ type: 'drop', item: 'o-y', target: 'o-bin-b' }); // re-dropped: goes to the bottom
  assert.deepEqual([at(rt, 'o-z'), at(rt, 'o-y')], [[604, 404], [604, 468]]);
  rt.dispatch({ type: 'drop', item: 'o-z', target: null }); // dragged off: home, the column compacts
  assert.deepEqual([at(rt, 'o-z'), at(rt, 'o-y')], [[400, 100], [604, 404]]);
  rt.dispatch({ type: 'drop', item: 'o-y', target: 'o-somewhere' });
  assert.deepEqual(at(rt, 'o-y'), [250, 100], 'an unknown target is outside');
  rt.dispatch({ type: 'drop', item: 'o-bin-a', target: 'o-bin-b' });
  assert.ok(rt.trace.includes('warn o-bin-a is not a drag item'));
  assert.ok(run(hotspotDoc(), [{ type: 'drop', item: 'o-x', target: null }]).trace.includes('warn not a drag-and-drop question'));
});

test('drag-and-drop grading: partial is wrong, distractors must stay out; try again keeps placements; final locks; resume restores', () => {
  const rt = run(ddDoc(2), [{ type: 'drop', item: 'o-x', target: 'o-bin-a' }, { type: 'drop', item: 'o-y', target: 'o-bin-b' }, { type: 'submit' }]);
  assert.equal(rt.state.feedback, 'tryAgain', 'z is missing: partial answers are wrong');
  rt.dispatch({ type: 'drop', item: 'o-z', target: 'o-bin-b' }); // feedback open: ignored
  rt.dispatch({ type: 'continue' });
  assert.deepEqual(rt.view().question.items.map((i) => i.placed), ['o-bin-a', 'o-bin-b', null, null], 'Try Again keeps the placements');
  rt.dispatch({ type: 'drop', item: 'o-z', target: 'o-bin-b' });
  rt.dispatch({ type: 'drop', item: 'o-noise', target: 'o-bin-b' });
  rt.dispatch({ type: 'submit' });
  assert.equal(rt.state.feedback, 'incorrect', 'a placed distractor is wrong; attempts used up');
  const snap = rt.snapshot();
  rt.dispatch({ type: 'continue' });
  rt.dispatch({ type: 'menu', slide: 's-dd' });
  rt.dispatch({ type: 'drop', item: 'o-noise', target: null });
  assert.equal(rt.view().question.items[3].placed, 'o-bin-b', 'locked after the final result, still placed on revisit');
  const back = createRuntime(ddDoc(2), { lms: { init: () => snap } });
  back.start({ resume: 'always' });
  assert.deepEqual(back.view().question.items.map((i) => i.placed), ['o-bin-a', 'o-bin-b', 'o-bin-b', 'o-bin-b']);
  const evil = structuredClone(snap);
  evil.q['s-dd'].placed = { 'o-x': 'o-bin-a', 'o-y': 'o-bin-a', 'o-bin-a': 'o-bin-b', 'o-z': 'o-nowhere', constructor: 'o-bin-b' };
  const r2 = createRuntime(ddDoc(2), { lms: { init: () => evil } });
  r2.start({ resume: 'always' });
  assert.deepEqual(r2.state.q['s-dd'].placed, { 'o-y': 'o-bin-a' }, 'only valid entries; a one-item target keeps one');
  const ok = run(ddDoc(), [['o-x', 'o-bin-a'], ['o-y', 'o-bin-b'], ['o-z', 'o-bin-b']].map(([item, target]) => ({ type: 'drop', item, target })).concat([{ type: 'submit' }]));
  assert.equal(ok.state.feedback, 'correct');
});

test('drag-and-drop behind a modal layer is ignored; LMS: SCORM 1.2 matching 0.a pairs in item order, placed items only', () => {
  const d = ddDoc();
  const blocked = createRuntime(applyAll(d, [{ cmd: 'trigger.add', args: { slide: 's-dd', on: { event: 'timelineStart' }, do: [{ action: 'showLayer', layer: 'l-help' }] } }]).doc);
  blocked.start();
  blocked.dispatch({ type: 'drop', item: 'o-x', target: 'o-bin-a' });
  assert.ok(blocked.trace.includes('ignored drop o-x'));
  const L = scormLms();
  const rt = createRuntime(d, { lms: L.lms });
  rt.start();
  for (const [item, target] of [['o-z', 'o-bin-b'], ['o-x', 'o-bin-a']]) rt.dispatch({ type: 'drop', item, target });
  rt.dispatch({ type: 'submit' });
  rt.dispatch({ type: 'continue' });
  rt.dispatch({ type: 'drop', item: 'o-y', target: 'o-bin-b' });
  rt.dispatch({ type: 'submit' });
  assert.deepEqual(L.records.map((r) => [r.type, r.response, r.responseLabels, r.correct, r.result]), [
    ['dragdrop', [[0, 0], [2, 1]], ['o-x.o-bin-a', 'o-z.o-bin-b'], [[0, 0], [1, 1], [2, 1]], 'incorrect'],
    ['dragdrop', [[0, 0], [1, 1], [2, 1]], ['o-x.o-bin-a', 'o-y.o-bin-b', 'o-z.o-bin-b'], [[0, 0], [1, 1], [2, 1]], 'correct'],
  ]);
  assert.deepEqual(fields(L.sets, 0), { id: 'qz_s-dd_0_0', 'objectives.0.id': 'qz', time: '00:00:00', type: 'matching', 'correct_responses.0.pattern': '0.a,1.b,2.b', weighting: '10', student_response: '0.a,2.b', result: 'wrong', latency: '0000:00:00.00' });
  assert.deepEqual([fields(L.sets, 1).student_response, fields(L.sets, 1).result, fields(L.sets, 1).id], ['0.a,1.b,2.b', 'correct', 'qz_s-dd_0_1']);
  assert.deepEqual(L.warnings, []);
});

// ---------------- matching drop-down and sequence (FR-6, FR-7) ----------------
const listDoc = () => build([
  { cmd: 'slide.add', args: { id: 's-m', title: 'Match', question: { type: 'matching', prompt: 'Match the signs', attempts: 2, choices: [{ id: 'bio', label: 'Biohazard' }, { id: 'rad', label: 'Radiation' }, { id: 'fire', label: 'Flammable' }],
    rows: [{ id: 'blood', label: 'Blood', choice: 'bio' }, { id: 'urine', label: 'Urine', choice: 'bio' }, { id: 'iso', label: 'Isotope', choice: 'rad' }] } } },
  { cmd: 'slide.add', args: { id: 's-s', title: 'Order', question: { type: 'sequence', prompt: 'Order the steps', attempts: 2, choices: [{ id: 'wash', label: 'Wash' }, { id: 'gown', label: 'Gown' }, { id: 'gloves', label: 'Gloves' }, { id: 'work', label: 'Work' }] } } },
  { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-m', 's-s'] } },
]);

test('matching and sequence validation and describe', () => {
  const d = listDoc();
  assert.deepEqual(validate(d), []);
  assert.match(fails(d, [{ cmd: 'question.set', args: { slide: 's-m', rows: [{ id: 'r', label: 'R', choice: 'nope' }] } }])[0].hint, /choices: bio, rad, fire/);
  assert.match(fails(d, [{ cmd: 'question.set', args: { slide: 's-m', rows: [] } }])[0].message, /1 to 10 rows/);
  assert.match(fails(d, [{ cmd: 'question.set', args: { slide: 's-m', choices: Array.from({ length: 27 }, (_, i) => ({ id: `c${i}`, label: 'x' })), rows: [{ id: 'r', label: 'R', choice: 'c0' }] } }])[0].message, /1 to 26 choices/);
  assert.match(fails(d, [{ cmd: 'question.set', args: { slide: 's-s', choices: [{ id: 'a', label: 'A' }] } }])[0].message, /2 to 26 items/);
  const text = describe(d);
  assert.match(text, /question matching "Match the signs" rows=blood>bio urine>bio iso>rad choices=bio:Biohazard rad:Radiation fire:Flammable/);
  assert.match(text, /question sequence "Order the steps" order=wash:Wash > gown:Gown > gloves:Gloves > work:Work/);
});

test('matching: duplicates allowed, every row needed, all-or-nothing, try again keeps rows; SCORM matching 0.a in row order', () => {
  const L = scormLms();
  const rt = createRuntime(listDoc(), { lms: L.lms, rng: seededRng(5) });
  rt.start();
  for (const [row, choice] of [['blood', 'bio'], ['urine', 'bio']]) rt.dispatch({ type: 'match', row, choice });
  assert.equal(rt.view().question.answered, false, 'a row is still empty');
  rt.dispatch({ type: 'submit' });
  assert.ok(rt.trace.includes('warn nothing to submit'));
  rt.dispatch({ type: 'match', row: 'iso', choice: 'fire' });
  rt.dispatch({ type: 'submit' });
  assert.equal(rt.state.feedback, 'tryAgain');
  rt.dispatch({ type: 'continue' });
  assert.deepEqual(rt.view().question.rows.map((r) => r.selected), ['bio', 'bio', 'fire']);
  rt.dispatch({ type: 'match', row: 'iso', choice: 'rad' });
  rt.dispatch({ type: 'match', row: 'nope', choice: 'rad' });
  rt.dispatch({ type: 'match', row: 'iso', choice: 'nope' });
  rt.dispatch({ type: 'submit' });
  assert.equal(rt.state.feedback, 'correct');
  assert.deepEqual([fields(L.sets, 0).type, fields(L.sets, 0).student_response, fields(L.sets, 0)['correct_responses.0.pattern'], fields(L.sets, 0).result], ['matching', '0.a,1.a,2.c', '0.a,1.a,2.b', 'wrong']);
  assert.deepEqual([fields(L.sets, 1).student_response, fields(L.sets, 1).result], ['0.a,1.a,2.b', 'correct']);
  assert.ok(rt.trace.includes('warn no row nope') && rt.trace.includes('warn no choice nope'));
  const snap = rt.snapshot();
  snap.q['s-m'].matched.evil = 'bio';
  const back = createRuntime(listDoc(), { lms: { init: () => snap } });
  back.start({ resume: 'always' });
  assert.deepEqual(back.state.q['s-m'].matched, { blood: 'bio', urine: 'bio', iso: 'rad' });
  assert.deepEqual(L.warnings, []);
});

test('sequence: insertion moves, no guard, correct order grades correct; SCORM sequencing a,b,c', () => {
  const L = scormLms();
  const rt = createRuntime(listDoc(), { lms: L.lms, rng: seededRng(5) });
  rt.start();
  rt.dispatch({ type: 'menu', slide: 's-s' }); // Next is held on an unanswered question slide
  const order = () => rt.view().question.choices.map((c) => c.id);
  const start = order();
  assert.equal(rt.view().question.answered, true, 'Submit always evaluates (Q3)');
  rt.dispatch({ type: 'order', choice: 'work', index: 0 }); // insertion, not swap: the others keep their order
  assert.deepEqual(order(), ['work', ...start.filter((x) => x !== 'work')]);
  rt.dispatch({ type: 'order', choice: 'nope', index: 0 });
  assert.ok(rt.trace.includes('warn bad order nope 0'));
  const first = order();
  rt.dispatch({ type: 'submit' });
  assert.equal(rt.state.feedback, 'tryAgain', '"work" first is wrong');
  rt.dispatch({ type: 'continue' });
  for (const [i, id] of ['wash', 'gown', 'gloves', 'work'].entries()) rt.dispatch({ type: 'order', choice: id, index: i });
  rt.dispatch({ type: 'submit' });
  assert.equal(rt.state.feedback, 'correct');
  const ix = (ids) => ids.map((id) => 'abcd'[['wash', 'gown', 'gloves', 'work'].indexOf(id)]).join(',');
  assert.deepEqual([fields(L.sets, 0).type, fields(L.sets, 0).student_response, fields(L.sets, 0)['correct_responses.0.pattern'], fields(L.sets, 0).result], ['sequencing', ix(first), 'a,b,c,d', 'wrong']);
  assert.deepEqual([fields(L.sets, 1).student_response, fields(L.sets, 1).result], ['a,b,c,d', 'correct']);
  assert.deepEqual(L.warnings, []);
  rt.dispatch({ type: 'continue' });
  rt.dispatch({ type: 'menu', slide: 's-s' });
  rt.dispatch({ type: 'order', choice: 'wash', index: 3 });
  assert.deepEqual(order(), ['wash', 'gown', 'gloves', 'work'], 'locked after the final result');
});

// ---------------- markers (FR-8) ----------------
test('marker objects: title + detail in the view and describe; unnamed markers flagged; var rename reaches the detail', () => {
  const d = build([
    { cmd: 'var.add', args: { name: 'n', type: 'number', initial: 3 } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-mk', type: 'marker', text: 'Fume hood', detail: 'Keep the sash low (%n% cm)', x: 600, y: 300, w: 48, h: 48 }, { id: 'o-mk2', type: 'marker' }] } },
  ]);
  const v = run(d).view().objects.find((o) => o.id === 'o-mk');
  assert.deepEqual([v.text, v.detail, v.interactive], ['Fume hood', 'Keep the sash low (3 cm)', true]);
  assert.match(describe(d), /o-mk marker "Fume hood" @600,300 48x48 detail "Keep the sash low \(%n% cm\)"/);
  assert.ok(query(d, 'a11y').data.some((x) => x.code === 'name-missing' && x.message.includes('marker o-mk2')));
  const r = applyAll(d, [{ cmd: 'var.set', args: { name: 'n', newName: 'height' } }]);
  assert.equal(r.doc.slides[0].objects[0].detail, 'Keep the sash low (%height% cm)');
});

test('import marker: markerProps title/desc become the marker title and label; the empty media block is not reported', () => {
  const parts = slides();
  const mp = (media) => `<markerProps pos="tr"><title>${docXml('Eyewash')}</title><desc>${docXml('Flush for 15 minutes')}</desc>${media}</markerProps>`; // escaped <Document>s like <text>
  parts[1] = slide(102, { name: 'Second', shapes: obj('marker', 260, { at: [300, 200, 340, 240], extra: mp(`<media pos="bc" assetG="${'0'.repeat(8)}-0000-0000-0000-000000000000" url=""><video><embed></embed></video></media>`) })
    + obj('marker', 261, { at: [400, 200, 440, 240], extra: mp(`<media pos="bc" assetG="${G(20)}" url="" />`) }) });
  const { doc, report } = importStory(pkg({ parts }));
  assert.deepEqual(validate(doc), []);
  const [a, b] = doc.slides[1].objects;
  assert.deepEqual([a.type, a.text, a.detail, a.x, a.y, a.w, a.h], ['marker', 'Eyewash', 'Flush for 15 minutes', 300, 200, 40, 40]);
  assert.equal(b.type, 'marker');
  assert.deepEqual(report.items.filter((x) => x.kind === 'object.markerMedia').map((x) => x.path), ['story/slides/slide2.xml#/sld/shapeLst/marker[2]/markerProps/media']);
  assert.ok(!report.items.some((x) => x.kind === 'object.marker'));
});

test('reusable slides: slide.export/slide.import carry media assets, slider variables and drag-and-drop keys', () => {
  const src = build([
    { cmd: 'var.add', args: { name: 'level', type: 'number', initial: 2 } },
    { cmd: 'asset.add', args: { id: 'a-clip', path: 'assets/clip.mp4' } },
    { cmd: 'asset.add', args: { id: 'a-cc', path: 'assets/clip.vtt' } },
    { cmd: 'slide.add', args: { id: 's-x', title: 'X', objects: [
      { id: 'o-v', type: 'video', media: 'a-clip', captions: 'a-cc' }, { id: 'o-sl', type: 'slider', var: 'level' },
      { id: 'o-i', type: 'shape' }, { id: 'o-t', type: 'shape' },
    ], question: { type: 'dragdrop', prompt: 'p', items: [{ object: 'o-i', target: 'o-t' }], targets: [{ object: 'o-t' }] } } },
  ]);
  const pkgData = query(src, 'slide.export', { id: 's-x' }).data;
  assert.deepEqual(pkgData.assets.map((x) => x.id).sort(), ['a-cc', 'a-clip']);
  assert.deepEqual(pkgData.variables.map((x) => x.name), ['level']);
  const r = applyAll(build([{ cmd: 'asset.add', args: { id: 'a-clip', path: 'assets/other.mp4' } }]), [{ cmd: 'slide.import', args: { data: pkgData } }], { rng: seededRng(8) });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const s = r.doc.slides.at(-1);
  const v = s.objects.find((o) => o.type === 'video');
  assert.deepEqual([r.doc.assets.find((x) => x.id === v.media).path, r.doc.assets.find((x) => x.id === v.captions).path], ['assets/clip.mp4', 'assets/clip.vtt']);
  assert.ok(s.objects.some((o) => o.id === s.question.items[0].object) && s.question.items[0].target === s.question.targets[0].object);
});

test('a11y query: unnamed sliders/dials and uncaptioned media are flagged with the fixing command', () => {
  const issues = (d) => query(d, 'a11y').data.map((x) => `${x.code}:${x.path}`);
  const d = rangeDoc();
  assert.ok(issues(d).includes('name-missing:/slides/0/objects/1'), 'the dial has neither alt nor name');
  assert.ok(!issues(d).includes('name-missing:/slides/0/objects/0'), 'the slider has a name');
  const m = mediaDoc();
  assert.deepEqual(issues(m).filter((x) => x.startsWith('captions-missing')), ['captions-missing:/slides/0/objects/1']);
  assert.match(query(m, 'a11y').data.find((x) => x.code === 'captions-missing').fix, /object\.set \{"id":"o-aud","captions"/);
});

// ---------------- importer (FR-5): dragDropIntr from a SYNTHETIC .story built from ----------------
function ddStory({ onlyOne = 'false', snapLoc = 'tile', returnMode = 'correct', itemTag = 'rect' } = {}) {
  const parts = slides();
  const choices = [[810, 820], [811, 821], [812, 821]].map(([s, m], i) => `<intrFreeChoice g="${G(830 + i)}" shpG="${G(s)}" matchShpG="${G(m)}" compType="none"><scoringData correct="false" /></intrFreeChoice>`).join('');
  const dd = `<dragDrop snapTarget="true" returnStart="true" revealDrag="false" snapLoc="${snapLoc}" onlyOne="${onlyOne}" delay="true" returnMode="${returnMode}"><order>${[810, 811, 812, 813].map((n) => `<g>${G(n)}</g>`).join('')}</order></dragDrop>`;
  parts[6] = slide(107, {
    shapes: intr('dragDropIntr', 800, { title: G(801), attempts: 'unlimited', body: `<choices>${choices}</choices>${dd}` })
      + obj('textBox', 801, { plain: 'Sort these' })
      + obj(itemTag, 810, { plain: 'A', at: [10, 10, 110, 50] }) + obj('rect', 811, { plain: 'B', at: [120, 10, 220, 50] }) + obj('roundRect', 812, { plain: 'C', at: [230, 10, 330, 50] })
      + obj('rect', 813, { plain: 'D', at: [340, 10, 440, 50] })
      + obj('rect', 820, { plain: 'Left', at: [10, 300, 300, 500] }) + obj('rect', 821, { plain: 'Right', at: [400, 300, 700, 500] }),
    trigs: trig(1070, 'OnClick', 'submitInteraction', { blocks: `<interaction submitG="${G(800)}" />` }),
  });
  return importStory(pkg({ parts }));
}
const kinds = (report) => report.items.map((x) => x.kind);

test('import dragDropIntr: items/keys from intrFreeChoice, targets from matchShpG, onlyOne -> capacity, unmapped options reported', () => {
  const { doc, report } = ddStory();
  assert.deepEqual(validate(doc), []);
  const s7 = doc.slides.find((s) => s.id === ID('s', 107));
  assert.deepEqual(s7.question, {
    type: 'dragdrop', prompt: 'Sort these', attempts: 0, points: 10, shuffle: true,
    items: [{ object: ID('o', 810), target: ID('o', 820) }, { object: ID('o', 811), target: ID('o', 821) }, { object: ID('o', 812), target: ID('o', 821) }],
    targets: [{ object: ID('o', 820), capacity: 'many' }, { object: ID('o', 821), capacity: 'many' }],
  });
  assert.deepEqual(s7.objects.map((o) => o.id), [810, 811, 812, 813, 820, 821].map((n) => ID('o', n)), 'drag items and targets stay ordinary slide objects; the title box is consumed');
  assert.deepEqual(s7.triggers, [], 'the SubmitInteraction trigger is consumed (CF draws Submit)');
  for (const k of ['question.dragDropReturnMode', 'question.dragDropOrder']) assert.ok(kinds(report).includes(k), k);
  assert.ok(!kinds(report).includes('question.dragDropLayout'), 'tile + onlyOne=false is the stacked layout');
  assert.ok(doc.quizzes[0].questions.includes(ID('s', 107)));
  // The imported question plays: correct when every keyed item is on its target.
  const rt = createRuntime(doc);
  rt.start();
  rt.dispatch({ type: 'menu', slide: ID('s', 107) });
  for (const [i, t] of [[810, 820], [811, 821], [812, 821]]) rt.dispatch({ type: 'drop', item: ID('o', i), target: ID('o', t) });
  rt.dispatch({ type: 'submit' });
  assert.equal(rt.state.feedback, 'correct');
});

test('import dragDropIntr: onlyOne=true -> one-item targets; layout mismatch reported; unimported item drops the question', () => {
  const one = ddStory({ onlyOne: 'true', snapLoc: 'tile', returnMode: 'any' });
  const q = one.doc.slides.find((s) => s.id === ID('s', 107)).question;
  assert.deepEqual(q.targets, [{ object: ID('o', 820) }, { object: ID('o', 821) }]);
  assert.ok(kinds(one.report).includes('question.dragDropLayout'));
  assert.ok(!kinds(one.report).includes('question.dragDropReturnMode'));
  const bad = ddStory({ itemTag: 'group' });
  const s7 = bad.doc.slides.find((s) => s.id === ID('s', 107));
  assert.equal(s7.question, undefined);
  assert.ok(kinds(bad.report).includes('question.dragDropObjects'));
  assert.ok(bad.report.items.some((x) => x.kind === 'trigger.source' && x.path.startsWith('story/slides/slide7.xml')), 'its submit trigger is reported, not silently dropped');
  assert.ok(!bad.doc.quizzes[0].questions.includes(ID('s', 107)));
  assert.deepEqual(validate(bad.doc), []);
});
