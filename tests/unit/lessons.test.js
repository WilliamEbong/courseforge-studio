// lessons mode: schema, commands (undo), runtime rules, resume hardening, scale, publisher, CLI/MCP parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emptyCourse, validate, serialize, parse, normalize } from '../../packages/schema/index.js';
import { apply, applyAll, describe, query } from '../../packages/core/index.js';
import { createRuntime, play, seededRng } from '../../packages/runtime/index.js';
import { createLessonRuntime } from '../../packages/runtime/lessons.js';
import { runtimeBundle } from '../../packages/publisher/bundle.js';
import { publishWeb, publishScorm12, previewHtml, validatePackage, toScormInteraction } from '../../packages/publisher/index.js';
import '../../packages/publisher/cf-scorm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CF = path.join(ROOT, 'packages/cli/cf.js');
const SAMPLE = path.join(ROOT, 'samples/lab-basics-lessons.course.json');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cf-les-${name}-`));
const ok = (r) => { assert.ok(r.ok, JSON.stringify(r.errors, null, 1)); return r.doc; };
const mc = (id, prompt = 'Pick A') => ({ id, type: 'question', kind: 'mc', prompt, choices: [{ id: 'a', label: 'A', correct: true, feedback: 'Yes, A.' }, { id: 'b', label: 'B', feedback: 'Not B.' }] });

/** Two content lessons with every gate kind, one quiz lesson. */
function course(extra = []) {
  return ok(applyAll(emptyCourse({ id: 'les', title: 'Lessons', mode: 'lessons' }), [
    { cmd: 'asset.add', args: { id: 'a-img', path: 'assets/pic.png', alt: 'Test pattern' } },
    { cmd: 'section.add', args: { id: 'sec-1', title: 'One' } },
    { cmd: 'lesson.add', args: { id: 'l-a', title: 'Alpha', blocks: [
      { id: 'b-h', type: 'heading', text: 'Start' },
      { id: 'b-acc', type: 'accordion', items: [{ title: 'x', text: 'one' }, { title: 'y', text: 'two' }] },
      { id: 'g-1', type: 'continue', require: 'above' },
      { id: 'b-tabs', type: 'tabs', items: [{ title: 't0', text: 'a' }, { title: 't1', text: 'b' }] },
      { id: 'b-cards', type: 'flashcards', items: [{ front: 'f', back: 'b' }] },
      { id: 'g-2', type: 'continue', require: 'allAbove' },
      mc('b-kc'),
      { id: 'g-3', type: 'continue', require: 'above' },
      { id: 'b-end', type: 'text', text: 'Searchable needle text' },
    ] } },
    { cmd: 'lesson.add', args: { id: 'l-b', title: 'Beta', blocks: [
      { id: 'b-sort', type: 'sorting', categories: ['Yes', 'No'], items: [{ text: 'good', category: 0 }, { text: 'bad', category: 1 }] },
      { id: 'b-list', type: 'list', kind: 'checkbox', items: ['p', 'q'] },
      { id: 'b-proc', type: 'process', items: [{ title: 's1', text: 'a' }, { title: 's2', text: 'b' }] },
      { id: 'b-lg', type: 'labeledGraphic', image: 'a-img', items: [{ x: 10, y: 20, title: 'm', text: 'n' }] },
    ] } },
    { cmd: 'section.add', args: { id: 'sec-2', title: 'Check' } },
    { cmd: 'lesson.add', args: { id: 'l-q', title: 'Quiz', kind: 'quiz', passPercent: 50, attempts: 2, blocks: [
      mc('q-1'), { id: 'q-2', type: 'question', kind: 'matching', prompt: 'Match', pairs: [{ left: 'L0', right: 'R0' }, { left: 'L1', right: 'R1' }] },
    ] } },
    { cmd: 'tracking.set', args: { complete: [{ quiz: 'l-q' }], status: 'passed-failed' } },
    ...extra,
  ], { rng: seededRng(7) }));
}
const lmsLog = () => {
  const calls = []; let saved = null;
  return { calls, get saved() { return saved; }, lms: { init: () => saved, status: (s) => calls.push(`status ${s}`), score: (x) => calls.push(`score ${x.raw}`), interaction: (r) => calls.push(r), save: (s) => { saved = s; }, exit: () => {} } };
};
const run = (doc, events, opts = {}) => { const rt = createRuntime(doc, { rng: seededRng(3), ...opts }); rt.start(); for (const e of events) rt.dispatch(e); return rt; };
const passLessonA = [
  { type: 'next' }, { type: 'item', block: 'b-acc', index: 0 }, { type: 'item', block: 'b-acc', index: 1 }, { type: 'continue', block: 'g-1' },
  { type: 'item', block: 'b-tabs', index: 1 }, { type: 'item', block: 'b-cards', index: 0 }, { type: 'continue', block: 'g-2' },
  { type: 'choose', block: 'b-kc', choice: 'a' }, { type: 'submit', block: 'b-kc' }, { type: 'continue', block: 'g-3' }, { type: 'end' },
];

// ---------------- schema ----------------
test('lessons documents: empty course valid, round trip idempotent, slides files unchanged', () => {
  const e = emptyCourse({ mode: 'lessons' });
  assert.deepEqual(validate(e), []);
  assert.deepEqual(e.tracking.complete, [{ lessonsViewed: 100 }], 'lessons default tracking');
  const text = serialize(course());
  assert.equal(serialize(parse(text)), text);
  const slides = fs.readFileSync(path.join(ROOT, 'samples/lab-safety.course.json'), 'utf8');
  assert.equal(serialize(parse(slides)), slides, 'additive: the slides sample serializes byte-identically');
  assert.ok(!slides.includes('"mode"') && !slides.includes('"sections"'));
});
const blocksOf = (d, l = 0) => d.sections[0].lessons[l].blocks;
for (const [label, mutate, code] of [
  ['block id reused by a lesson', (d) => { blocksOf(d)[0].id = 'l-b'; }, 'dupe'],
  ['section id reused', (d) => { d.sections[1].id = 'sec-1'; }, 'dupe'],
  ['image asset missing', (d) => { blocksOf(d, 1)[3].image = 'a-nope'; }, 'ref'],
  ['captions not a .vtt', (d) => { blocksOf(d).push({ id: 'b-v', type: 'video', media: 'a-img', captions: 'a-img' }); }, 'semantic'],
  ['quiz lesson with a text block', (d) => { d.sections[1].lessons[0].blocks.push({ id: 'b-t', type: 'text', text: 'x' }); }, 'semantic'],
  ['quiz setting on a content lesson', (d) => { d.sections[0].lessons[0].passPercent = 50; }, 'semantic'],
  ['"above" gate under a heading', (d) => { blocksOf(d).splice(1, 0, { id: 'g-x', type: 'continue', require: 'above' }); }, 'semantic'],
  ['"allAbove" gate with nothing completable', (d) => { blocksOf(d).unshift({ id: 'g-x', type: 'continue', require: 'allAbove' }); }, 'semantic'],
  ['button with neither url nor lesson', (d) => { blocksOf(d).push({ id: 'b-btn', type: 'button', label: 'Go' }); }, 'semantic'],
  ['button with both', (d) => { blocksOf(d).push({ id: 'b-btn', type: 'button', label: 'Go', url: 'https://x.test', toLesson: 'l-b' }); }, 'semantic'],
  ['button to a missing lesson', (d) => { blocksOf(d).push({ id: 'b-btn', type: 'button', label: 'Go', toLesson: 'l-zz' }); }, 'ref'],
  ['button url javascript:', (d) => { blocksOf(d).push({ id: 'b-btn', type: 'button', label: 'Go', url: 'javascript:alert(1)' }); }, 'pattern'],
  ['mc with two correct', (d) => { blocksOf(d)[6].choices[1].correct = true; }, 'semantic'],
  ['matching with one pair', (d) => { d.sections[1].lessons[0].blocks[1].pairs.pop(); }, 'semantic'],
  ['per-choice feedback on mr', (d) => { blocksOf(d)[6].kind = 'mr'; }, 'semantic'],
  ['sorting category out of range', (d) => { blocksOf(d, 1)[0].items[0].category = 5; }, 'range'],
  ['sorting with 5 categories', (d) => { blocksOf(d, 1)[0].categories = ['a', 'b', 'c', 'd', 'e']; }, 'range'],
  ['accordion without items', (d) => { blocksOf(d)[1].items = []; }, 'range'],
  ['marker outside the image', (d) => { blocksOf(d, 1)[3].items[0].x = 120; }, 'range'],
  ['unknown block type', (d) => { blocksOf(d)[0].type = 'carousel'; }, 'enum'],
  ['slidesViewed in a lessons course', (d) => { d.tracking.complete = [{ slidesViewed: 50 }]; }, 'semantic'],
  ['tracking quiz is not a quiz lesson', (d) => { d.tracking.complete = [{ quiz: 'l-a' }]; }, 'ref'],
]) {
  test(`validate rejects (lessons): ${label}`, () => {
    const d = structuredClone(course());
    mutate(d);
    const errs = validate(d);
    assert.ok(errs.some((e) => e.code === code), `expected ${code}, got ${JSON.stringify(errs)}`);
    assert.ok(errs.every((e) => e.path.startsWith('/') && e.message), 'actionable');
  });
}
test('validate rejects lessonsViewed in a slides course', () => {
  const d = emptyCourse(); d.tracking.complete = [{ lessonsViewed: 50 }];
  assert.equal(validate(d)[0].hint, 'use slidesViewed');
});

// ---------------- commands ----------------
test('commands: add, set, move, duplicate, remove for sections, lessons and blocks; inverse restores', () => {
  const d = course();
  const before = serialize(d);
  let r = apply(d, { cmd: 'block.set', args: { id: 'b-acc', type: 'tabs', style: { width: 'wide', background: '#ffffff' } } });
  assert.equal(ok(r).sections[0].lessons[0].blocks[1].type, 'tabs');
  assert.equal(serialize(apply(r.doc, r.inverse).doc), before, 'undo restores the document');
  r = apply(ok(r), { cmd: 'block.set', args: { id: 'b-acc', style: null } });
  assert.equal(ok(r).sections[0].lessons[0].blocks[1].style, undefined, 'null removes');
  const moved = ok(apply(d, { cmd: 'lesson.move', args: { id: 'l-b', section: 'sec-2', index: 0 } }));
  assert.deepEqual(moved.sections.map((s) => s.lessons.map((l) => l.id)), [['l-a'], ['l-b', 'l-q']]);
  const dup = apply(d, { cmd: 'lesson.duplicate', args: { id: 'l-a', newId: 'l-a2' } }, { rng: seededRng(1) });
  const copy = ok(dup).sections[0].lessons[1];
  assert.equal(copy.id, 'l-a2');
  assert.equal(copy.blocks.length, 9);
  assert.ok(copy.blocks.every((b) => /^b-[0-9a-f]{12}$/.test(b.id)), 'fresh block ids');
  assert.deepEqual(dup.result.blocks, copy.blocks.map((b) => b.id));
  const bd = ok(apply(d, { cmd: 'block.duplicate', args: { id: 'b-end', newId: 'b-end2' } }));
  assert.equal(bd.sections[0].lessons[0].blocks[9].id, 'b-end2');
  const bm = ok(apply(d, { cmd: 'block.move', args: { id: 'b-end', lesson: 'l-b', index: 0 } }));
  assert.equal(bm.sections[0].lessons[1].blocks[0].id, 'b-end');
  assert.equal(ok(apply(d, { cmd: 'block.remove', args: { id: 'b-end' } })).sections[0].lessons[0].blocks.length, 8);
  assert.equal(ok(apply(d, { cmd: 'section.move', args: { id: 'sec-2', index: 0 } })).sections[0].id, 'sec-2');
  assert.equal(ok(apply(d, { cmd: 'section.set', args: { id: 'sec-2', title: 'Final' } })).sections[1].title, 'Final');
  assert.equal(ok(apply(d, { cmd: 'lesson.set', args: { id: 'l-q', attempts: null, reveal: 'none' } })).sections[1].lessons[0].attempts, undefined);
});
test('commands: guards, force purges and actionable errors', () => {
  const d = course([{ cmd: 'block.add', args: { lesson: 'l-b', id: 'b-btn', type: 'button', label: 'Quiz', toLesson: 'l-q' } }]);
  const guarded = apply(d, { cmd: 'lesson.remove', args: { id: 'l-q' } });
  assert.equal(guarded.errors[0].code, 'ref');
  assert.match(guarded.errors[0].hint, /tracking\/complete\/0.*toLesson/);
  const forced = ok(apply(d, { cmd: 'lesson.remove', args: { id: 'l-q', force: true } }));
  assert.ok(!forced.sections[0].lessons[1].blocks.some((b) => b.id === 'b-btn') && !forced.tracking.complete.length, 'buttons and tracking entry removed');
  assert.match(apply(d, { cmd: 'section.remove', args: { id: 'sec-1' } }).errors[0].hint, /lesson\.move/);
  assert.equal(ok(apply(d, { cmd: 'section.remove', args: { id: 'sec-2', force: true } })).sections.length, 1);
  const asset = ok(apply(d, { cmd: 'asset.remove', args: { id: 'a-img', force: true } }));
  assert.ok(!asset.sections[0].lessons[1].blocks.some((b) => b.type === 'labeledGraphic'), 'blocks that need the asset go with it');
  assert.match(apply(emptyCourse({ mode: 'lessons' }), { cmd: 'lesson.add', args: { title: 'x' } }).errors[0].hint, /section\.add/);
  assert.match(apply(d, { cmd: 'block.add', args: { lesson: 'l-q', type: 'text', text: 'x' } }).errors[0].message, /quiz lessons hold only question blocks/);
  assert.match(apply(d, { cmd: 'block.add', args: { lesson: 'l-a', type: 'tabs' } }).errors[0].message, /items is required for type=tabs/);
  assert.match(apply(d, { cmd: 'block.set', args: { id: 'b-nope', text: 'x' } }).errors[0].hint, /b-h, b-acc/);
});
test('block.set style merges; a key set to null is removed, an emptied style disappears', () => {
  const style = (d) => d.sections[0].lessons[0].blocks.find((b) => b.id === 'b-h').style;
  let d = ok(apply(course(), { cmd: 'block.set', args: { id: 'b-h', style: { width: 'wide', background: '#eeeeee' } } }));
  d = ok(apply(d, { cmd: 'block.set', args: { id: 'b-h', style: { align: 'center' } } }));
  assert.deepEqual(style(d), { width: 'wide', background: '#eeeeee', align: 'center' });
  d = ok(apply(d, { cmd: 'block.set', args: { id: 'b-h', style: { background: null, width: null } } }));
  assert.deepEqual(style(d), { align: 'center' });
  d = ok(apply(d, { cmd: 'block.set', args: { id: 'b-h', style: { align: null } } }));
  assert.equal(style(d), undefined);
  d = ok(apply(d, { cmd: 'block.set', args: { id: 'b-h', style: { padding: 'large' } } }));
  assert.equal(ok(apply(d, { cmd: 'block.set', args: { id: 'b-h', style: null } })).sections[0].lessons[0].blocks[0].style, undefined);
  assert.equal(apply(d, { cmd: 'block.set', args: { id: 'b-h', style: { width: 'huge' } } }).ok, false);
});
test('course.set mode swaps slidesViewed and lessonsViewed, keeping the percent', () => {
  const s = ok(apply(emptyCourse(), { cmd: 'tracking.set', args: { complete: [{ slidesViewed: 60 }] } }));
  const l = ok(apply(s, { cmd: 'course.set', args: { mode: 'lessons', cover: { image: undefined, alt: 'x' } } }));
  assert.deepEqual(l.tracking.complete, [{ lessonsViewed: 60 }]);
  assert.deepEqual(ok(apply(l, { cmd: 'course.set', args: { mode: 'slides', cover: null } })).tracking.complete, [{ slidesViewed: 60 }]);
});
test('describe, find, lesson.get and a11y cover lessons', () => {
  const d = course([
    { cmd: 'block.add', args: { lesson: 'l-b', id: 'b-img', type: 'image', image: 'a-img', alt: undefined } },
    { cmd: 'asset.add', args: { id: 'a-raw', path: 'assets/raw.png' } },
    { cmd: 'block.add', args: { lesson: 'l-b', id: 'b-img2', type: 'image', image: 'a-raw' } },
    { cmd: 'block.add', args: { lesson: 'l-b', id: 'b-h3', type: 'heading', text: 'Deep', level: 3 } },
    { cmd: 'block.add', args: { lesson: 'l-b', id: 'b-faint', type: 'text', text: 'pale', style: { color: '#cccccc' } } },
  ]);
  const text = describe(d);
  assert.match(text, /^course les "Lessons" lessons/);
  assert.match(text, /g-2 continue require=allAbove/);
  assert.match(text, /lesson l-q "Quiz" quiz pass=50% attempts=2 reveal=all/);
  assert.match(text, /q-2 question "Match" matching L0=R0 L1=R1/);
  assert.match(text, /tracking: quiz l-q → passed-failed/);
  assert.deepEqual(query(d, 'find', { text: 'needle' }).data.map((h) => h.id), ['b-end']);
  assert.equal(query(d, 'lesson.get', { id: 'l-b' }).data.blocks.length, 8);
  const issues = query(d, 'a11y').data.map((x) => `${x.code}:${x.path.split('/').pop()}`);
  assert.deepEqual(issues.sort(), ['alt-missing:5', 'contrast:style', 'heading-order:6'], 'image with asset alt is fine; raw asset is not');
});

// ---------------- runtime ----------------
test('runtime: cover, next, gates hide later blocks, completion and traces', () => {
  const rt = run(course(), [{ type: 'next' }, { type: 'continue', block: 'g-1' }, { type: 'item', block: 'b-tabs', index: 1 }, { type: 'end' }]);
  assert.equal(rt.state.lesson, 'l-a');
  assert.deepEqual(rt.view().lesson.blocks.map((b) => b.id), ['b-h', 'b-acc', 'g-1']);
  assert.deepEqual(rt.trace.slice(0, 2), ['start', 'enter l-a']);
  assert.ok(rt.trace.includes('gate g-1 blocked b-acc'));
  assert.ok(rt.trace.includes('warn b-tabs is behind a gate'));
  assert.ok(rt.trace.includes('warn end of l-a is behind a gate'));
  for (const e of passLessonA.slice(1)) rt.dispatch(e);
  assert.ok(rt.trace.includes('complete b-cards') && rt.trace.includes('gate g-2 passed') && rt.trace.includes('lesson l-a complete'));
  assert.ok(!rt.trace.includes('item b-tabs 0'), 'tab 0 counts as seen without an event');
  assert.deepEqual(rt.view().outline[0].lessons.map((l) => l.complete), [true, false]);
});
test('runtime: item blocks, checkbox toggle, process without intro, media ended, bad input', () => {
  const doc = course([{ cmd: 'block.add', args: { lesson: 'l-b', id: 'b-aud', type: 'audio', media: 'a-img' } }]);
  const rt = run(doc, [{ type: 'open', lesson: 'l-b' }, { type: 'item', block: 'b-list', index: 0 }, { type: 'item', block: 'b-list', index: 0 }, { type: 'item', block: 'b-list', index: 1 },
    { type: 'item', block: 'b-list', index: 0 }, { type: 'item', block: 'b-proc', index: 1 }, { type: 'item', block: 'b-aud', index: 0 },
    { type: 'item', block: 'b-lg', index: 9 }, { type: 'item', block: 'b-sort', index: 0 }, { type: 'item', block: 'nope', index: 0 }]);
  const v = Object.fromEntries(rt.view().lesson.blocks.map((b) => [b.id, b]));
  assert.equal(v['b-list'].done, true, 'checkbox list completes when all are checked at once');
  assert.equal(v['b-proc'].done, true, 'step 0 is on screen from the start');
  assert.equal(v['b-aud'].done, true);
  assert.ok(rt.trace.includes('warn b-lg has no item 9') && rt.trace.includes('warn b-sort has no items to open') && rt.trace.includes('warn no block nope in this lesson'));
});
test('runtime: knowledge checks are ungraded, retry rules, feedback by choice, hideCorrect', () => {
  const doc = course([{ cmd: 'block.set', args: { id: 'b-kc', attempts: 2 } }]);
  const { lms, calls } = lmsLog();
  const rt = run(doc, passLessonA.slice(0, 7), { lms });
  const kc = () => rt.view().lesson.blocks.find((b) => b.id === 'b-kc');
  rt.dispatch({ type: 'submit', block: 'b-kc' });
  assert.ok(rt.trace.includes('warn b-kc has no answer yet'));
  rt.dispatch({ type: 'choose', block: 'b-kc', choice: 'b' }).dispatch({ type: 'submit', block: 'b-kc' });
  assert.equal(kc().result, 'incorrect'); assert.equal(kc().feedback, 'Not B.'); assert.equal(kc().canRetry, true);
  assert.equal(kc().choices.find((c) => c.id === 'a').correct, true, 'correct answer revealed');
  rt.dispatch({ type: 'retry', block: 'b-kc' }).dispatch({ type: 'choose', block: 'b-kc', choice: 'b' }).dispatch({ type: 'submit', block: 'b-kc' });
  assert.equal(kc().canRetry, false, 'attempts used up');
  rt.dispatch({ type: 'retry', block: 'b-kc' });
  assert.ok(rt.trace.includes('warn b-kc cannot be retried'));
  assert.ok(!calls.some((c) => typeof c === 'object'), 'knowledge checks never reach the LMS');
  const hidden = run(course([{ cmd: 'block.set', args: { id: 'b-kc', hideCorrect: true } }]), [...passLessonA.slice(0, 7), { type: 'choose', block: 'b-kc', choice: 'b' }, { type: 'submit', block: 'b-kc' }]);
  assert.ok(hidden.view().lesson.blocks.find((b) => b.id === 'b-kc').choices.every((c) => c.correct === undefined));
  const right = run(doc, [...passLessonA.slice(0, 7), { type: 'choose', block: 'b-kc', choice: 'a' }, { type: 'submit', block: 'b-kc' }]);
  assert.equal(right.view().lesson.blocks.find((b) => b.id === 'b-kc').canRetry, false, 'no Take Again after a correct answer');
});
test('runtime: sorting places correct cards, keeps wrong ones, first-try score, retry', () => {
  const rt = run(course(), [{ type: 'open', lesson: 'l-b' }, { type: 'sort', block: 'b-sort', item: 0, category: 1 }, { type: 'sort', block: 'b-sort', item: 0, category: 0 },
    { type: 'sort', block: 'b-sort', item: 0, category: 0 }, { type: 'sort', block: 'b-sort', item: 1, category: 1 }]);
  const s = () => rt.view().lesson.blocks.find((b) => b.id === 'b-sort');
  assert.deepEqual([s().done, s().firstTry, s().current], [true, 1, null]);
  assert.ok(rt.trace.includes('sort b-sort 0 wrong') && rt.trace.includes('warn b-sort has no open card 0'));
  rt.dispatch({ type: 'retry', block: 'b-sort' });
  assert.deepEqual([s().done, s().current, s().placed], [true, 0, []]);
});
test('runtime: quiz lesson flow, LMS interactions then score then status, attempts, matching record', () => {
  const { lms, calls } = lmsLog();
  const rt = run(course(), [{ type: 'open', lesson: 'l-q' }, { type: 'choose', choice: 'a' }], { lms });
  assert.ok(rt.trace.includes('warn quiz l-q is not waiting for an answer'), 'intro first');
  const q = () => rt.view().lesson.quiz;
  assert.equal(q().phase, 'intro');
  rt.dispatch({ type: 'continue' }).dispatch({ type: 'choose', block: 'q-2', choice: 'a' });
  assert.ok(rt.trace.includes('warn q-2 is not the current question'));
  rt.dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' });
  assert.equal(q().phase, 'feedback');
  assert.equal(q().question.choices.find((c) => c.id === 'a').correct, true, 'reveal all shows the answer');
  rt.dispatch({ type: 'continue' }).dispatch({ type: 'match', left: 0, right: 0 }).dispatch({ type: 'submit' });
  assert.ok(rt.trace.includes('warn q-2 has no answer yet'), 'matching needs every item linked');
  rt.dispatch({ type: 'match', left: 1, right: 1 }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });
  assert.deepEqual([q().phase, q().results.score, q().results.passed, q().canRetake], ['results', 50, true, true]);
  assert.deepEqual(calls.map((c) => (typeof c === 'object' ? c.id : c)), ['l-q_q-1_0', 'l-q_q-2_0', 'score 50', 'status passed']);
  const match = calls[1];
  assert.deepEqual([match.type, match.response, match.correct, match.result], ['matching', [[0, 0], [1, 1]], [[0, 0], [1, 1]], 'correct']);
  assert.deepEqual(toScormInteraction(match), { id: 'l-q_q-2_0', type: 'matching', result: 'correct', weighting: 1, response: [[0, 0], [1, 1]], correct: [[0, 0], [1, 1]] });
  rt.dispatch({ type: 'retake' });
  assert.ok(rt.trace.includes('lms status incomplete') && rt.trace.includes('quiz l-q start 2'), 'a retake of the tracked quiz reopens it');
  for (const e of [{ type: 'choose', choice: 'b' }, { type: 'submit' }, { type: 'continue' }, { type: 'match', left: 0, right: 1 }, { type: 'match', left: 1, right: 0 }, { type: 'submit' }, { type: 'continue' }]) rt.dispatch(e);
  assert.deepEqual([q().results.score, q().canRetake], [0, false]);
  assert.equal(calls[calls.length - 1], 'status failed');
  rt.dispatch({ type: 'retake' });
  assert.ok(rt.trace.includes('warn quiz l-q cannot be retaken'));
});
test('runtime: reveal none skips feedback; requirePass blocks completion and restricted navigation', () => {
  const doc = course([{ cmd: 'lesson.set', args: { id: 'l-q', reveal: 'none', requirePass: true, passPercent: 100 } }, { cmd: 'player.set', args: { navigation: 'restricted' } },
    { cmd: 'section.add', args: { id: 'sec-3' } }, { cmd: 'lesson.add', args: { id: 'l-z', title: 'After' } }]);
  const rt = run(doc, [{ type: 'open', lesson: 'l-q' }]);
  assert.deepEqual(rt.trace.slice(-1), ['locked l-q'], 'restricted: earlier lessons first');
  rt.dispatch({ type: 'search', q: 'needle' });
  assert.ok(rt.trace.includes('warn search needs free navigation'));
  assert.equal(rt.view().search, null);
  for (const e of [...passLessonA, { type: 'next' }]) rt.dispatch(e);
  assert.equal(rt.state.lesson, 'l-b');
  rt.dispatch({ type: 'next' });
  assert.ok(rt.trace.includes('locked l-q'), 'l-b not complete yet');
  rt.dispatch({ type: 'end' }).dispatch({ type: 'next' }).dispatch({ type: 'continue' }).dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' });
  assert.equal(rt.view().lesson.quiz.question.id, 'q-2', 'no feedback phase with reveal none');
  rt.dispatch({ type: 'match', left: 0, right: 0 }).dispatch({ type: 'match', left: 1, right: 1 }).dispatch({ type: 'submit' });
  assert.equal(rt.view().lesson.quiz.results.review.length, 0);
  assert.ok(!rt.state.done.includes('l-q'), 'failed with requirePass: not complete');
  rt.dispatch({ type: 'next' });
  assert.ok(rt.trace.includes('locked l-z'));
});
test('runtime: lessonsViewed reports completed as soon as the threshold lesson completes (D [WHEN])', () => {
  const doc = course([{ cmd: 'tracking.set', args: { complete: [{ lessonsViewed: 50 }], status: 'completed-incomplete' } }]);
  const { lms, calls } = lmsLog();
  const rt = run(doc, [...passLessonA, { type: 'next' }], { lms });
  assert.deepEqual(calls, []);
  rt.dispatch({ type: 'end' });
  assert.deepEqual(calls, ['status completed'], '2 of 3 lessons = 66% >= 50%');
});
test('runtime: free navigation search excludes questions; randomize and shuffle are seeded', () => {
  const rt = run(course(), [{ type: 'search', q: 'NEEDLE' }, { type: 'search', q: 'Pick A' }]);
  assert.deepEqual(rt.trace.slice(-2), ['search "needle" 1', 'search "pick a" 0']);
  assert.equal(rt.view().search.results.length, 0);
  const doc = course([{ cmd: 'lesson.set', args: { id: 'l-q', randomize: true, shuffle: true } }]);
  const order = (seed) => { const r = createRuntime(doc, { rng: seededRng(seed) }); r.start(); r.dispatch({ type: 'open', lesson: 'l-q' }).dispatch({ type: 'continue' }); return JSON.stringify(r.state.quiz['l-q'].order) + JSON.stringify(r.state.quiz['l-q'].ans['q-1'].order); };
  assert.equal(order(4), order(4));
  assert.ok([1, 2, 3, 4, 5, 6].map(order).some((o) => o !== order(4)), 'different seeds give different orders');
});
test('runtime: snapshot/restore resumes lesson, gates, answers and a quiz mid-attempt', () => {
  const doc = course();
  const a = lmsLog();
  const rt = run(doc, [...passLessonA, { type: 'next' }, { type: 'item', block: 'b-list', index: 1 }, { type: 'open', lesson: 'l-q' }, { type: 'continue' }, { type: 'choose', choice: 'a' }, { type: 'submit' }], { lms: a.lms });
  const snap = a.saved;
  assert.ok(JSON.stringify(snap).length < 1500, 'compact snapshot');
  const rt2 = createRuntime(doc, { lms: { init: () => snap, save: () => {} } });
  rt2.start({ resume: 'always' });
  assert.equal(rt2.state.lesson, 'l-q');
  assert.deepEqual(rt2.state.done, ['l-a']);
  assert.equal(rt2.view().lesson.quiz.phase, 'feedback');
  rt2.dispatch({ type: 'continue' });
  assert.equal(rt2.view().lesson.quiz.question.id, 'q-2');
  rt2.dispatch({ type: 'open', lesson: 'l-a' });
  assert.equal(rt2.view().lesson.blocks.length, 9, 'gates stay passed');
  rt2.dispatch({ type: 'open', lesson: 'l-b' });
  assert.deepEqual(rt2.view().lesson.blocks.find((b) => b.id === 'b-list').seen, [1]);
});
test('runtime: restore treats data as untrusted', () => {
  const doc = course();
  const restored = (snap) => { const rt = createLessonRuntime(doc); rt.restore(snap); return rt; };
  for (const bad of [null, 42, 'x', [], { v: 2, mode: 'lessons' }, { v: 1 }, { v: 1, mode: 'slides' }]) assert.ok(restored(bad).trace.includes('warn resume data ignored'));
  const rt = restored({
    v: 1, mode: 'lessons', lesson: 'l-q', last: { toString: 1 }, done: ['l-zz', 7, 'l-b', 'l-b'], status: 'hacked', reported: 'passed',
    blocks: { 'b-acc': { seen: [0, 1, 99, -1, 'x'], done: 'yes' }, 'b-h': { done: true }, 'b-kc': { sel: ['zz', 'a'], result: 'incorrect', tries: -5, order: ['zz'] }, constructor: { seen: [1] }, 'g-1': { passed: 1 } },
    quiz: { 'l-q': { phase: 'results', order: ['q-1'], tries: 1.5 }, 'l-a': { phase: 'results' } },
  });
  assert.equal(rt.state.lesson, 'l-q', 'free navigation: the saved lesson opens');
  assert.equal(rt.state.last, 'l-q', 'a non-string "last" is dropped; entering sets it');
  const v = (id) => { rt.dispatch({ type: 'open', lesson: id }); return rt.view().lesson; };
  assert.deepEqual(rt.state.done, ['l-b']);
  assert.equal(rt.state.status, 'incomplete'); assert.equal(rt.state.reported, 'passed');
  const acc = v('l-a').blocks.find((b) => b.id === 'b-acc');
  assert.deepEqual([acc.seen, acc.done], [[0, 1], false], 'indexes filtered, "yes" is not true');
  assert.equal(v('l-a').blocks.length, 3, 'passed:1 is not true, so the gate holds');
  const kc = createLessonRuntime(doc); kc.restore({ v: 1, mode: 'lessons', blocks: { 'b-kc': { sel: ['zz', 'a'], result: 'incorrect', tries: -5, order: ['zz'] } } });
  assert.deepEqual(kc.state.blocks['b-kc'].sel, ['a']);
  assert.equal(kc.state.blocks['b-kc'].result, 'correct', 'result recomputed from the answer');
  assert.equal(kc.state.blocks['b-kc'].tries, 0);
  assert.deepEqual(kc.state.blocks['b-kc'].order, ['a', 'b']);
  assert.equal(v('l-q').quiz.phase, 'intro', 'a quiz state that does not match the course goes back to the intro');
});
test('runtime: restricted navigation keeps a resumed learner out of locked lessons', () => {
  const doc = course([{ cmd: 'player.set', args: { navigation: 'restricted' } }]);
  const rt = createLessonRuntime(doc);
  rt.restore({ v: 1, mode: 'lessons', lesson: 'l-q', done: [] });
  assert.equal(rt.state.lesson, null);
  assert.ok(rt.trace.includes('locked l-q'));
});
test('scale: a 200-block lesson plays, renders its view and snapshots quickly (L25)', () => {
  const blocks = [];
  for (let i = 0; i < 200; i++) blocks.push(i % 10 === 9 ? { id: `g-${i}`, type: 'continue', require: 'above' } : i % 10 === 8 ? { id: `b-${i}`, type: 'accordion', items: [{ title: 'a', text: 'b' }, { title: 'c', text: 'd' }] } : { id: `b-${i}`, type: 'text', text: `Paragraph ${i} `.repeat(20) });
  const doc = ok(applyAll(emptyCourse({ mode: 'lessons' }), [{ cmd: 'section.add', args: { id: 'sec' } }, { cmd: 'lesson.add', args: { id: 'l-long', title: 'Long', blocks } }]));
  const t0 = performance.now();
  const rt = createRuntime(doc); rt.start(); rt.dispatch({ type: 'next' });
  for (let i = 0; i < 200; i++) {
    const b = blocks[i];
    rt.dispatch({ type: 'reach', block: b.id });
    if (b.type === 'accordion') { rt.dispatch({ type: 'item', block: b.id, index: 0 }); rt.dispatch({ type: 'item', block: b.id, index: 1 }); }
    if (b.type === 'continue') rt.dispatch({ type: 'continue', block: b.id });
    rt.view();
  }
  rt.dispatch({ type: 'end' });
  const ms = performance.now() - t0;
  assert.ok(rt.state.done.includes('l-long'));
  assert.equal(rt.view().lesson.blocks.length, 200);
  assert.ok(ms < 2000, `took ${ms} ms`);
  assert.ok(JSON.stringify(rt.snapshot()).length < 4096, 'fits SCORM 1.2 suspend_data');
});

// ---------------- publisher, bundle, CLI, MCP ----------------
test('bundle replays the lessons runtime exactly; play() reports the lesson', () => {
  const win = {};
  vm.runInNewContext(runtimeBundle(), { window: win, structuredClone });
  const doc = normalize(course());
  const ev = [...passLessonA, { type: 'open', lesson: 'l-q' }, { type: 'continue' }, { type: 'choose', choice: 'a' }, { type: 'submit' }];
  const esm = play(doc, ev, { rng: seededRng(2) });
  const bundled = win.CFRuntime.play(doc, ev, { rng: win.CFRuntime.seededRng(2) });
  const pick = (r) => JSON.parse(JSON.stringify({ trace: r.trace, lms: r.lms, lesson: r.lesson, status: r.status }));
  assert.deepEqual(pick(bundled), pick(esm));
  assert.equal(esm.lesson, 'l-q');
  assert.deepEqual(esm.lms, ['interaction q-1 correct']);
});
test('publishWeb/Scorm12 ship the lessons player; package validates; preview inlines it', () => {
  const doc = normalize(JSON.parse(fs.readFileSync(SAMPLE, 'utf8')));
  const web = path.join(tmp('web'), 'web');
  const r = publishWeb(doc, web, { courseDir: path.join(ROOT, 'samples') });
  assert.deepEqual(r.files, ['assets/lab-bench.svg', 'cf-lessons.css', 'cf-lessons.js', 'cf-player.js', 'cf-runtime.js', 'course.js', 'index.html']);
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
  assert.ok(html.indexOf('cf-player.js') < html.indexOf('cf-lessons.js') && html.includes('href="cf-lessons.css"'));
  assert.deepEqual(validatePackage(web), []);
  const sc = path.join(tmp('scorm'), 'scorm');
  publishScorm12(doc, sc, { courseDir: path.join(ROOT, 'samples') });
  assert.match(fs.readFileSync(path.join(sc, 'imsmanifest.xml'), 'utf8'), /<adlcp:masteryscore>75<\/adlcp:masteryscore>/);
  assert.deepEqual(validatePackage(sc), []);
  const withUrl = ok(applyAll(doc, [{ cmd: 'block.add', args: { lesson: 'l-welcome', type: 'button', label: 'More', url: 'https://example.org/more' } }]));
  const web2 = path.join(tmp('web2'), 'web');
  publishWeb(withUrl, web2, { courseDir: path.join(ROOT, 'samples') });
  assert.deepEqual(validatePackage(web2), [], 'button URLs are authored links, not remote resources');
  assert.match(previewHtml(doc), /CFLessons = \{ mount: mount \}/);
});
test('cf-scorm writes SCORM 1.2 matching interactions as source.target pairs', () => {
  const sets = [];
  const api = { LMSInitialize: () => 'true', LMSGetValue: () => '', LMSSetValue: (k, v) => { sets.push([k, v]); return 'true'; }, LMSCommit: () => 'true', LMSFinish: () => 'true', LMSGetLastError: () => '0' };
  const ad = globalThis.CFScorm.createScormAdapter({ win: { API: api }, courseId: 'c', tracking: { status: 'passed-failed' }, now: () => 0 });
  ad.init();
  ad.interaction({ id: 'q_m_0', type: 'matching', response: [[0, 1], [1, 0]], correct: [[0, 0], [1, 1]], result: 'wrong', weighting: 1 });
  ad.interaction({ id: 'q_bad', type: 'matching', response: [[10, 0]], correct: [[0, 0]], result: 'wrong' });
  const ix = Object.fromEntries(sets.filter(([k]) => k.startsWith('cmi.interactions.')).map(([k, v]) => [k.replace('cmi.interactions.', ''), v]));
  assert.equal(ix['0.type'], 'matching');
  assert.equal(ix['0.student_response'], '0.b,1.a');
  assert.equal(ix['0.correct_responses.0.pattern'], '0.a,1.b');
  assert.equal(ix['1.id'], undefined, 'sources past 9 are refused');
});
test('cf new --mode lessons, cf test on the sample, and the sample is rebuilt from its commands alone', () => {
  const dir = tmp('cli');
  const file = path.join(dir, 'x.course.json');
  const n = spawnSync(process.execPath, [CF, 'new', file, '--mode', 'lessons', '--id', 'lab-basics', '--title', 'Lab Basics'], { encoding: 'utf8' });
  assert.equal(n.status, 0, n.stderr);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mode, 'lessons');
  assert.equal(spawnSync(process.execPath, [CF, 'new', path.join(dir, 'y.course.json'), '--mode', 'cards'], { encoding: 'utf8' }).status, 2);
  const b = spawnSync(process.execPath, [CF, 'batch', file, path.join(ROOT, 'samples/lab-basics-lessons.cmds.jsonl')], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(SAMPLE, 'utf8'), 'samples/lab-basics-lessons.course.json comes only from commands');
  const t = spawnSync(process.execPath, [CF, 'test', SAMPLE, path.join(ROOT, 'samples/lab-basics-lessons.scenario.json')], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  assert.equal(JSON.parse(t.stdout).lesson, 'l-quiz');
  const wrong = path.join(dir, 'wrong.json');
  fs.writeFileSync(wrong, JSON.stringify({ events: [{ type: 'next' }], expect: { lesson: 'l-quiz' } }));
  const f = spawnSync(process.execPath, [CF, 'test', SAMPLE, wrong], { encoding: 'utf8' });
  assert.equal(f.status, 1);
  assert.match(f.stderr, /lesson: expected l-quiz, got l-welcome/);
});
test('parity: MCP run_commands and cf batch build the same lessons course; MCP play runs it', async () => {
  const root = tmp('mcp');
  const start = emptyCourse({ id: 'lab-basics', title: 'Lab Basics', mode: 'lessons' });
  fs.writeFileSync(path.join(root, 'mcp.course.json'), serialize(start));
  const cmds = fs.readFileSync(path.join(ROOT, 'samples/lab-basics-lessons.cmds.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('//')).map((l) => JSON.parse(l));
  const child = spawn(process.execPath, [path.join(ROOT, 'packages/mcp/server.js'), '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiters = new Map(); let id = 0;
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(msg.id)?.(msg); } });
  const call = (method, params) => new Promise((resolve) => { const n = ++id; waiters.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lessons-parity', version: '1' } });
    const res = await call('tools/call', { name: 'run_commands', arguments: { file: 'mcp.course.json', commands: cmds } });
    assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
    assert.equal(fs.readFileSync(path.join(root, 'mcp.course.json'), 'utf8'), fs.readFileSync(SAMPLE, 'utf8'));
    const p = await call('tools/call', { name: 'play', arguments: { file: 'mcp.course.json', events: [{ type: 'start' }, { type: 'next' }, { type: 'end' }] } });
    assert.match(p.result.content[0].text, /lesson l-welcome complete/);
  } finally { child.kill(); }
});
