import test from 'node:test';
import assert from 'node:assert/strict';
import { questionElements } from '../../packages/export-story/questions.js';
import { elements, el, ZERO } from '../../packages/export-story/elements.js';
import { importStory, parseXml, storyId } from '../../packages/import-story/index.js';
import { normalize } from '../../packages/schema/index.js';
import { guidFor, openStory, saveStory, canon } from '../../packages/export-story/save.js';
import { applyAll } from '../../packages/core/index.js';
import { rezip } from '../../packages/publisher/zip.js';
import { writeStory } from '../../packages/export-story/index.js';
import { zip } from '../fixtures/synthetic/story-builder.js';

const id = (prefix, n) => `${prefix}-${String(n).padStart(12, '0')}`;
const S = id('s', 1), RESULT = id('s', 2), QUIZ = id('q', 3), BANK = id('b', 4), DRAW = id('s', 5);
const question = (type = 'mc') => ({ type, prompt: 'Which <answer> & why?', choices: [
  { id: id('c', 10), label: 'A & one', correct: true }, { id: id('c', 11), label: 'B <two>', correct: type === 'mr' },
], feedback: { correct: 'Yes & correct.', incorrect: 'No <answer>.', tryAgain: 'Try again.' }, points: 7, attempts: 2, shuffle: false });
function course(type = 'mc') {
  return normalize({ schema: 'cf.course/1', id: 'course', title: 'Questions', scenes: [{ id: id('sc', 6), title: 'One', slides: [S, RESULT] }],
    slides: [{ id: S, title: 'Question', question: question(type) }, { id: RESULT, title: 'Results' }], quizzes: [{ id: QUIZ, title: 'Quiz', questions: [S], results: RESULT, passPercent: 70 }] });
}
function build(doc) {
  const guids = new Map(), resolve = key => { if (!guids.has(key)) guids.set(key, guidFor(key)); return guids.get(key); };
  const T = elements(doc.size, resolve), Q = questionElements({ size: doc.size, resolve, T, doc });
  const parts = [], rels = [];
  for (const [i, s] of doc.slides.entries()) {
    const body = Q.slideContents(s), draw = s.draw ? Q.draw(s) : null;
    const sheet = T.sheet(draw ? 'bankSld' : 'sld', { ...T.item(s.id), name: s.title, layoutG: ZERO, ...(draw?.attrs ?? {}) }, {
      objects: body.objects, triggers: body.triggers,
      tail: el('sldLayerLst', { nextIdx: 4 }, body.layers) + (draw?.tail ?? ''),
    });
    parts.push([`story/slides/slide${i}.xml`, sheet]);
    rels.push(el('Relationship', { Id: 'R' + storyId(resolve(s.id)), Type: 'slide', Target: `/story/slides/slide${i}.xml` }));
  }
  const scenes = doc.scenes.map(s => el('scene', { ...T.item(s.id), name: s.title }, el('sldIdLst', {}, s.slides.map(sid => el('sldId', {}, 'R' + storyId(resolve(sid)))))));
  const story = el('story', { id: resolve('project'), UseNewFontScaling: true }, el('varLst', {}, Q.variables()), el('mediaLst', {}, el('mediaLst')), el('sceneLst', {}, scenes), Q.quizManager(), el('propLst', {}, el('prop', { id: 15 }, el('sz', doc.size))));
  const buf = zip([['[Content_Types].xml', '<Types/>'], ['story/story.xml', story], ['story/_rels/story.xml.rels', el('Relationships', {}, rels)], ...parts]);
  return { ...importStory(buf), buf, Q, T, resolve, story };
}
for (const type of ['mc', 'mr', 'tf']) test(`native ${type} factory round-trips prompt, choices, key, attempts and feedback`, () => {
  const doc = course(type), built = build(doc);
  assert.deepEqual(normalize(built.doc).slides.find(s => s.id === S).question, doc.slides[0].question);
  assert.deepEqual(normalize(built.doc).quizzes, doc.quizzes);
  assert.deepEqual(built.doc.variables, []);
});

test('native feedback buttons include the required string-table label flag', () => {
  const doc = course(), { Q } = build(doc);
  const layers = parseXml('<layers>' + Q.slideContents(doc.slides[0]).layers + '</layers>').kids;
  assert.equal(layers.length, 3);
  for (const layer of layers) {
    const button = layer.kids.find(n => n.tag === 'shapeLst').kids.find(n => n.tag === 'feedBackBtn');
    // StringTableButtonShape requires this Boolean before reading type.
    assert.equal(button.attrs.txtSet, 'false');
    assert.equal(button.attrs.type, 'con');
  }
});

test('choice font edits preserve state overrides while updating inherited font properties', () => {
  const doc = course(), choice = doc.slides[0].question.choices[0];
  doc.slides[0].question.layout = { prompt: { x: 10, y: 10, w: 600, h: 90 },
    choices: doc.slides[0].question.choices.map((c, i) => ({ id: c.id, x: 20, y: 150 + i * 90, w: 600, h: 70, style: { fontSize: 20, italic: true } })) };
  let state = openStory(build(doc).buf);
  const { part, node } = state.nodes.get(choice.id), raw = state.zip.read(part).toString();
  const hover = node.kids.find(n => n.tag === 'stateLst').kids.find(n => n.attrs.name === 'Hover');
  const font = hover.kids.find(n => n.tag === 'shapeLst').kids[0].kids.find(n => n.tag === 'bG').kids.find(n => n.tag === 'defaultFont');
  const custom = raw.slice(font.s, font.e).replace(/name="[^"]*"/, 'name="Courier New"').replace(/sz="[^"]*"/, `sz="${Number(font.attrs.sz) * 2}"`)
    .replace('style="Italic"', 'style="Bold, Italic"').replace(/val="[^"]*"/, 'val="123456"');
  state = openStory(rezip(state.buf, state.zip, { put: new Map([[part, Buffer.from(raw.slice(0, font.s) + custom + raw.slice(font.e))]]), drop: new Set() }));
  const layout = structuredClone(doc.slides[0].question.layout);
  layout.choices[0].style = { fontSize: 22, fontFamily: 'Arial', color: '#aabbcc', italic: false };
  state = updateQuestion(state, { layout });
  for (const s of state.nodes.get(choice.id).node.kids.find(n => n.tag === 'stateLst').kids) {
    const sf = s.kids.find(n => n.tag === 'shapeLst').kids[0].kids.find(n => n.tag === 'bG').kids.find(n => n.tag === 'defaultFont');
    const overridden = s.attrs.name === 'Hover';
    assert.equal(sf.attrs.style, overridden ? 'Bold' : 'Regular');
    assert.equal(sf.attrs.name, overridden ? 'Courier New' : 'Arial');
    assert.equal(Number(sf.attrs.sz), overridden ? Number(font.attrs.sz) * 2 : 22 / state.textScale);
    assert.equal(sf.kids.find(n => n.tag === 'clr').kids[0].attrs.val.toLowerCase(), overridden ? '123456' : 'aabbcc');
  }
});

test('native questions select Submit navigation and restore navigation when removed', () => {
  let state = openStory(writeStory());
  const slide = state.doc.slides[0].id;
  const change = commands => {
    const r = applyAll(state.doc, commands);
    assert.ok(r.ok, JSON.stringify(r.errors));
    state = saveStory(state, r.doc);
    assert.deepEqual(canon(state.doc), canon(r.doc));
  };
  change([{ cmd: 'question.set', args: { slide, ...question() } }]);
  const nav = () => state.nodes.get(slide).node.kids.find(n => n.tag === 'navData')?.attrs;
  assert.equal(nav()?.submit, 'true');
  for (const field of ['prev', 'prevGesture', 'next', 'nextGesture']) assert.equal(nav()[field], 'false');
  change([{ cmd: 'question.remove', args: { slide } }]);
  assert.equal(nav().submit, 'false');
  assert.equal(nav().next, 'true');
});

test('standard results provide native retry navigation after reset', () => {
  const state = openStory(writeStory());
  const slide = state.doc.slides[0].id;
  const r = applyAll(state.doc, [
    { cmd: 'question.set', args: { slide, ...question() } },
    { cmd: 'quiz.add', args: { id: 'q-native', questions: [slide] } },
    { cmd: 'quiz.addResults', args: { quiz: 'q-native', id: 's-native-results', track: true } },
  ]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const failed = r.doc.slides.find(s => s.id === 's-native-results').layers.find(l => l.title === 'Failed');
  assert.deepEqual(failed.triggers.map(t => t.do[0]), [{ action: 'resetQuiz', quiz: 'q-native' }, { action: 'jump', to: slide }]);
  const next = saveStory(state, r.doc);
  assert.deepEqual(canon(next.doc), canon(r.doc));
});

test('native reset authoring refuses missing navigation without changing the archive', () => {
  let state = openStory(writeStory());
  const slide = state.doc.slides[0].id;
  const r = applyAll(state.doc, [
    { cmd: 'question.set', args: { slide, ...question() } },
    { cmd: 'quiz.add', args: { id: 'q-reset', questions: [slide] } },
    { cmd: 'quiz.addResults', args: { quiz: 'q-reset', id: 's-reset', track: true } },
  ]);
  assert.ok(r.ok);
  state = saveStory(state, r.doc);
  const changed = structuredClone(state.doc);
  const layer = changed.slides.find(s => s.id === 's-reset').layers.find(l => l.title === 'Failed');
  layer.triggers.pop();
  const before = Buffer.from(state.buf);
  assert.throws(() => saveStory(state, changed), e => e.errors?.some(x => x.code === 'story-unsupported' && /reset/i.test(x.message)));
  assert.deepEqual(state.buf, before);
});

test('native results include the inherited freeform fields and an empty choice collection', () => {
  const doc = course(), { Q } = build(doc);
  const panel = parseXml('<shapes>' + Q.slideContents(doc.slides.find(s => s.id === RESULT)).objects + '</shapes>').kids.find(n => n.tag === 'rsltsIntr');
  assert.equal(panel.attrs.new, 'true');
  assert.equal(panel.attrs.glowType, 'accent5_15');
  const choices = panel.kids.filter(n => n.tag === 'choices');
  assert.equal(choices.length, 1);
  assert.equal(choices[0].kids.length, 0);
});

test('native choices declare the interaction type required for published scoring', () => {
  for (const [type, label] of [['mc', 'Multiple Choice'], ['tf', 'True/False'], ['mr', 'Multiple Response']]) {
    const doc = course(type), { Q } = build(doc);
    const shapes = parseXml('<shapes>' + Q.slideContents(doc.slides[0]).objects + '</shapes>').kids;
    for (const choice of shapes.filter(n => ['radio', 'checkBox'].includes(n.tag))) {
      const property = choice.kids.find(n => n.tag === 'propBag')?.kids.find(n => n.kids.some(k => k.tag === 'key' && k.text === 'ParentInteractionType'));
      assert.equal(property?.kids.find(n => n.tag === 'val')?.kids[0]?.text, label);
    }
  }
});

test('native choice controls include the standard selectable states', () => {
  for (const type of ['mc', 'tf', 'mr']) {
    const doc = course(type), { Q } = build(doc);
    const shapes = parseXml('<shapes>' + Q.slideContents(doc.slides[0]).objects + '</shapes>').kids;
    const groups = [];
    for (const choice of shapes.filter(n => ['radio', 'checkBox'].includes(n.tag))) {
      if (type === 'mr') assert.equal(choice.attrs.grpId, undefined);
      else { assert.ok(choice.attrs.grpId); groups.push(choice.attrs.grpId); }
      const states = choice.kids.find(n => n.tag === 'stateLst')?.kids ?? [];
      assert.deepEqual(states.map(s => s.attrs.name).sort(), ['Disabled', 'Down', 'Hover', 'Normal', 'Selected']);
      assert.ok(states.every(s => s.tag === (type === 'mr' ? 'checkShapeState' : 'radioShapeState')));
      for (const state of states) {
        const snapshot = state.kids.find(n => n.tag === 'shapeLst')?.kids[0];
        assert.equal(snapshot?.tag, choice.tag);
        assert.equal(state.attrs.defG, snapshot.attrs.g);
        assert.equal(snapshot.attrs.initState, '');
        assert.equal(snapshot.attrs.parentG, undefined);
        assert.equal(snapshot.attrs.grpId, undefined);
        if (state.attrs.name === 'Normal') assert.equal(snapshot.kids.find(n => n.tag === 'btnBg')?.kids.find(n => n.tag === 'foreClr')?.kids[0]?.attrs.val, '34449C');
      }
    }
    if (groups.length) assert.equal(new Set(groups).size, 1);
  }
});

test('editing a native answer key updates selected roots and new choices join the original radio group', () => {
  let state = openStory(build(course()).buf);
  const raw = state.zip.read('story/slides/slide0.xml').toString().replace(/grpId="[^"]*"/g, 'grpId="Original &amp; group"');
  state = openStory(rezip(state.buf, state.zip, { put: new Map([['story/slides/slide0.xml', Buffer.from(raw)]]), drop: new Set() }));
  const choices = state.doc.slides[0].question.choices.map((c, i) => ({ ...c, correct: i === 1 }));
  choices.push({ id: 'added-choice', label: 'Another answer', correct: false });
  state = updateQuestion(state, { choices });
  const roots = parseXml(state.zip.read('story/slides/slide0.xml').toString()).kids.find(n => n.tag === 'shapeLst').kids.filter(n => n.tag === 'radio');
  assert.equal(roots.length, 3);
  for (const root of roots) {
    assert.equal(root.attrs.grpId, 'Original & group');
    const expected = choices.find(c => c.id === root.attrs.cfId).correct;
    assert.equal(root.attrs.initState, expected ? 'Selected' : 'Normal');
    assert.equal(root.kids.find(n => n.tag === 'scoreData').attrs.correct, String(expected));
  }
});

test('native authored question layout survives; panel identity, child links and required properties are generated', () => {
  const doc = course();
  doc.slides[0].question.layout = { prompt: { x: 14, y: 18, w: 600, h: 80 }, choices: doc.slides[0].question.choices.map((c, i) => ({ id: c.id, x: 20, y: 150 + i * 70, w: 500, h: 55 })) };
  const { Q, resolve, doc: actual } = build(doc), body = Q.slideContents(doc.slides[0]);
  assert.deepEqual(actual.slides.find(s => s.id === S).question.layout, doc.slides[0].question.layout);
  const shapes = parseXml('<shapeLst>' + body.objects + '</shapeLst>').kids;
  const panel = shapes.find(n => n.tag === 'multiChoiceIntr'), props = panel.kids.find(n => n.tag === 'intrProps');
  assert.notEqual(panel.attrs.ansG, panel.attrs.g);
  assert.notEqual(props.attrs.intrG, panel.attrs.g);
  assert.deepEqual({ ...panel.kids.find(n => n.tag === 'autoScrollMrgn').attrs }, { w: '0', h: '0' });
  assert.deepEqual({ ...panel.kids.find(n => n.tag === 'autoScrollPos').attrs }, { x: '0', y: '0' });
  for (const key of ['showCorFb', 'showIncFb', 'showTryFb']) assert.equal(props.attrs[key], 'true');
  assert.deepEqual(panel.kids.find(n => n.tag === 'childLst').kids.map(n => n.text), doc.slides[0].question.choices.map(c => resolve(c.id)));
  for (const [i, n] of shapes.filter(n => n.tag === 'radio').entries()) assert.equal(n.attrs.initState, doc.slides[0].question.choices[i].correct ? 'Selected' : 'Normal');
});

test('native banks/draws and per-quiz exclusions round-trip membership', () => {
  const doc = course();
  doc.banks = [{ id: BANK, title: 'Bank', slides: [S] }];
  doc.scenes[0].slides = [DRAW, RESULT];
  doc.slides.push(normalize({ ...doc, slides: [{ id: DRAW, title: 'Draw', draw: { bank: BANK, count: 1, shuffle: true, always: [S] } }] }).slides[0]);
  doc.quizzes[0].questions = [DRAW];
  doc.quizzes.push({ id: id('q', 7), title: 'Excluded', questions: [], passPercent: 80, round: false });
  const actual = normalize(build(doc).doc);
  assert.deepEqual(actual.banks, doc.banks);
  assert.deepEqual(actual.slides.find(s => s.id === DRAW).draw, doc.slides.find(s => s.id === DRAW).draw);
  assert.deepEqual(actual.quizzes, doc.quizzes);
});

function updateQuestion(state, args) {
  const r = applyAll(state.doc, [{ cmd: 'question.set', args: { slide: S, ...args } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const next = saveStory(state, r.doc);
  assert.deepEqual(canon(next.doc), canon(r.doc));
  return openStory(next.buf);
}
test('native existing question edits preserve unknown panel fields and feedback buttons', () => {
  const doc = course(), made = build(doc);
  let state = openStory(made.buf);
  const raw = state.zip.read('story/slides/slide0.xml').toString().replace('<multiChoiceIntr ', '<multiChoiceIntr futureFlag="retain" ').replace('</multiChoiceIntr>', '<opaquePayload value="unchanged"/></multiChoiceIntr>');
  state = openStory(rezip(state.buf, state.zip, { put: new Map([['story/slides/slide0.xml', Buffer.from(raw)]]), drop: new Set() }));
  const before = state.zip.read('story/slides/slide0.xml').toString();
  state = updateQuestion(state, { prompt: 'Revised question', points: 9, attempts: 3, shuffle: true,
    choices: [{ ...doc.slides[0].question.choices[0], label: 'Changed', correct: false }, { ...doc.slides[0].question.choices[1], correct: true }],
    feedback: { correct: 'Revised correct', incorrect: 'Revised incorrect', tryAgain: 'Revised retry' } });
  const after = state.zip.read('story/slides/slide0.xml').toString();
  const buttons = text => [...text.matchAll(/<feedBackBtn\b[\s\S]*?<\/feedBackBtn>/g)].map(m => m[0]);
  assert.deepEqual(buttons(after), buttons(before));
  assert.ok(after.includes('futureFlag="retain"'));
  assert.ok(after.includes('<opaquePayload value="unchanged"/>'));
});
test('native existing question accepts a new choice, removal, explicit layout and type conversion', () => {
  let state = openStory(build(course()).buf);
  const choices = [...state.doc.slides[0].question.choices, { id: 'custom-choice', label: 'Third', correct: false }];
  state = updateQuestion(state, { choices });
  const kept = choices.slice(1).map((c, i) => ({ ...c, correct: i === 0 }));
  state = updateQuestion(state, { choices: kept, layout: { prompt: { x: 10, y: 10, w: 500, h: 90 }, choices: kept.map((c, i) => ({ id: c.id, x: 20, y: 160 + i * 90, w: 500, h: 60 })) } });
  state = updateQuestion(state, { type: 'mr' });
  assert.equal(state.doc.slides[0].question.type, 'mr');
});
test('native question removal removes only the question and quiz membership', () => {
  const state = openStory(build(course()).buf);
  const r = applyAll(state.doc, [{ cmd: 'question.remove', args: { slide: S } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const next = saveStory(state, r.doc);
  assert.deepEqual(canon(next.doc), canon(r.doc));
  assert.equal(next.doc.slides[0].question, undefined);
});
test('native attempts outside the declared enum refuse before producing bytes', () => {
  const doc = course();
  doc.slides[0].question.attempts = 11;
  assert.throws(() => build(doc), /1–10 attempts/);
});
test('legacy question controls without cfId keep their native identity on edits', () => {
  let state = openStory(build(course()).buf);
  const raw = state.zip.read('story/slides/slide0.xml').toString().replace(/ cfId="[^"]*"/g, '').replace('name="Question"', 'name=""').replace('</textBox>', '<ph type="title"/></textBox>');
  state = openStory(rezip(state.buf, state.zip, { put: new Map([['story/slides/slide0.xml', Buffer.from(raw)]]), drop: new Set() }));
  const choices = state.doc.slides.find(s => s.id === S).question.choices;
  const next = updateQuestion(state, { prompt: 'New prompt preserving slide title', choices: choices.map((c, i) => ({ ...c, label: 'Legacy revised ' + i })) });
  assert.deepEqual(next.doc.slides.find(s => s.id === S).question.choices.map(c => c.id), choices.map(c => c.id));
  assert.equal(next.doc.slides.find(s => s.id === S).title, state.doc.slides.find(s => s.id === S).title);
});
test('unknown native reference blocks choice deletion without changing original bytes', () => {
  let state = openStory(build(course()).buf);
  const raw = state.zip.read('story/slides/slide0.xml').toString();
  const first = parseXml(raw).kids.find(n => n.tag === 'shapeLst').kids.find(n => n.tag === 'radio');
  const injected = raw.replace('</sld>', `<unknownBinding targetG="${first.attrs.g}"/></sld>`);
  state = openStory(rezip(state.buf, state.zip, { put: new Map([['story/slides/slide0.xml', Buffer.from(injected)]]), drop: new Set() }));
  const before = Buffer.from(state.buf), choices = state.doc.slides[0].question.choices;
  assert.throws(() => updateQuestion(state, { choices: [{ ...choices[1], correct: true }, { id: 'replacement', label: 'Replacement', correct: false }] }), e => e.errors?.some(x => x.code === 'story-referenced'));
  assert.deepEqual(state.buf, before);
});
test('native blank project creates a question, quiz and standard results then edits them again', () => {
  let state = openStory(writeStory({ title: 'Original native quiz' }));
  const slide = state.doc.slides[0].id;
  const change = cmds => {
    const r = applyAll(state.doc, cmds);
    assert.ok(r.ok, JSON.stringify(r.errors));
    state = saveStory(state, r.doc);
    assert.deepEqual(canon(openStory(state.buf).doc), canon(r.doc));
  };
  change([{ cmd: 'question.set', args: { slide, ...question() } },
    { cmd: 'quiz.add', args: { id: 'quiz-custom', title: 'Knowledge check', questions: [slide], passPercent: 70 } },
    { cmd: 'quiz.addResults', args: { quiz: 'quiz-custom', id: 'results-custom', track: true } }]);
  change([{ cmd: 'question.set', args: { slide, prompt: 'Updated after native reopen', attempts: 10 } },
    { cmd: 'quiz.set', args: { id: 'quiz-custom', title: 'Revised check', passPercent: 90, round: true } }]);
  assert.equal(state.doc.slides.find(s => s.id === slide).question.attempts, 10);
  change([{ cmd: 'tracking.set', args: { status: 'passed-incomplete' } }]);
  assert.equal(state.doc.tracking.status, 'passed-incomplete');
  // Native Results includes every enabled quiz submission; omitting one is unsafe.
  const multi = applyAll(state.doc, [{ cmd: 'tracking.set', args: { complete: [{ slidesViewed: 100 }], status: 'completed-incomplete' } }]);
  assert.ok(multi.ok, JSON.stringify(multi.errors));
  const before = Buffer.from(state.buf);
  assert.throws(() => saveStory(state, multi.doc), e => e.errors?.some(v => v.code === 'story-unsupported'));
  assert.ok(state.buf.equals(before));
});
test('existing native questions update per-quiz exclusions when membership changes', () => {
  const doc = course();
  doc.quizzes.push({ id: 'quiz-other', title: 'Other quiz', questions: [], passPercent: 80, round: false });
  const state = openStory(build(doc).buf);
  const r = applyAll(state.doc, [{ cmd: 'quiz.set', args: { id: QUIZ, questions: [] } }, { cmd: 'quiz.set', args: { id: 'quiz-other', questions: [S] } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  const next = saveStory(state, r.doc);
  assert.deepEqual(canon(next.doc), canon(r.doc));
  assert.equal(next.doc.quizzes.find(q => q.id === QUIZ).questions.length, 0);
  assert.deepEqual(next.doc.quizzes.find(q => q.id === 'quiz-other').questions, [S]);
});
test('no-edit native quiz archives preserve bytes with optional native settings omitted', () => {
  let state = openStory(build(course()).buf);
  const raw = state.zip.read('story/story.xml').toString().replace(' showcorrectincorrectinreview="true"', '');
  state = openStory(rezip(state.buf, state.zip, { put: new Map([['story/story.xml', Buffer.from(raw)]]), drop: new Set() }));
  assert.ok(saveStory(state, state.doc).buf.equals(state.buf), 'no-edit archive bytes changed');
});
test('existing native question can add missing feedback while preserving existing layers', () => {
  let state = openStory(build(course()).buf);
  const raw = state.zip.read('story/slides/slide0.xml').toString(), root = parseXml(raw);
  const layer = root.kids.find(n => n.tag === 'sldLayerLst').kids.find(n => n.attrs.name === 'tryAgain');
  const modified = raw.slice(0, layer.s) + raw.slice(layer.e);
  state = openStory(rezip(state.buf, state.zip, { put: new Map([['story/slides/slide0.xml', Buffer.from(modified)]]), drop: new Set() }));
  state = updateQuestion(state, { feedback: { correct: 'Changed correct', incorrect: 'Changed incorrect', tryAgain: 'New retry feedback' } });
  assert.equal(state.doc.slides[0].question.feedback.tryAgain, 'New retry feedback');
});
test('authored question text styling survives generation and subsequent layout edits', () => {
  const doc = course();
  doc.slides[0].question.layout = { prompt: { x: 10, y: 10, w: 600, h: 90, style: { fontSize: 28, bold: true } },
    choices: doc.slides[0].question.choices.map((c, i) => ({ id: c.id, x: 20, y: 150 + i * 90, w: 600, h: 70, style: { fontSize: 20, italic: true } })) };
  let state = openStory(build(doc).buf);
  assert.deepEqual(state.doc.slides[0].question.layout, doc.slides[0].question.layout);
  const layout = structuredClone(doc.slides[0].question.layout);
  layout.prompt.x += 5;
  layout.prompt.style.fontSize = 32;
  layout.choices[0].style.italic = false;
  state = updateQuestion(state, { layout });
  assert.equal(state.doc.slides[0].question.layout.prompt.style.fontSize, 32);
  const choice = state.nodes.get(layout.choices[0].id).node;
  for (const state of choice.kids.find(n => n.tag === 'stateLst').kids) {
    const copy = state.kids.find(n => n.tag === 'shapeLst').kids[0];
    assert.equal(copy.kids.find(n => n.tag === 'bG').kids.find(n => n.tag === 'defaultFont').attrs.style, 'Regular');
  }
});
