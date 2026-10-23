// Regression tests for Codex review 005: question banks and draws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse } from '../../packages/schema/index.js';
import { applyAll } from '../../packages/core/index.js';
import { createRuntime, seededRng } from '../../packages/runtime/index.js';

const mc = (k) => ({ type: 'mc', prompt: `Question ${k}`, points: 10, shuffle: false, choices: [{ id: 'a', label: 'No' }, { id: 'b', label: 'Yes', correct: true }] });
const build = (cmds) => { const r = applyAll(emptyCourse({ id: 'r5', title: 'Review 005' }), cmds, { rng: seededRng(5) }); assert.ok(r.ok, JSON.stringify(r.errors)); return r.doc; };
const course = (draw = {}) => build([
  { cmd: 'slide.add', args: { id: 's-intro', title: 'Intro' } },
  { cmd: 'bank.add', args: { id: 'bk-1', title: 'Bank' } },
  ...[1, 2, 3, 4, 5].map((k) => ({ cmd: 'slide.add', args: { id: `s-b${k}`, bank: 'bk-1', question: mc(k) } })),
  { cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-1', count: 2, ...draw } },
  { cmd: 'slide.add', args: { id: 's-q', question: mc('direct') } },
  { cmd: 'slide.add', args: { id: 's-end', title: 'Results', objects: [{ id: 'o-retry', type: 'button', text: 'Retry' }] } },
  { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-draw', 's-q'], results: 's-end', passPercent: 80 } },
  { cmd: 'trigger.add', args: { slide: 's-end', on: { event: 'timelineStart' }, do: [{ action: 'submitQuiz', quiz: 'qz' }] } },
  { cmd: 'trigger.add', args: { slide: 's-end', on: { event: 'click', target: 'o-retry' }, do: [{ action: 'resetQuiz', quiz: 'qz' }] } },
]);
const answer = (rt) => rt.dispatch({ type: 'choose', choice: 'b' }).dispatch({ type: 'submit' }).dispatch({ type: 'continue' });

test('#1 skipping a draw through the menu does not pass the quiz: its questions count, unanswered', () => {
  const rt = createRuntime(course(), { rng: seededRng(2) }); rt.start();
  rt.dispatch({ type: 'menu', slide: 's-q' });
  answer(rt);
  assert.equal(rt.state.slide, 's-end');
  assert.equal(rt.state.vars['qz.scorePercent'], 33.33); // 10 of 30 points: the 2 drawn questions count, unanswered
  assert.equal(rt.state.vars['qz.passed'], false);
  assert.equal(rt.state.draws['s-draw'].length, 2, 'the skipped draw was drawn at submit');
});

test('#2 after a retry re-draws, Prev never reaches a question of the discarded draw', () => {
  const rt = createRuntime(course(), { rng: seededRng(3) }); rt.start();
  rt.dispatch({ type: 'next' }); answer(rt); answer(rt); answer(rt); // two drawn questions, then the direct one
  assert.equal(rt.state.slide, 's-end');
  const first = [...rt.state.draws['s-draw']];
  rt.dispatch({ type: 'click', target: 'o-retry' });
  const now = new Set(rt.state.draws['s-draw'] ?? []);
  for (const id of rt.state.history) if (/^s-b/.test(id)) assert.ok(now.has(id), `history keeps ${id} from the old draw ${first}`);
  for (let i = 0; i < 10; i++) rt.dispatch({ type: 'prev' });
  assert.ok(!/^s-b/.test(rt.state.slide) || now.has(rt.state.slide));
});

test('#4 resume refuses drawn sets the draw could not have produced (count, always, never)', () => {
  const doc = course({ count: 1, always: ['s-b1'], never: ['s-b2'] });
  const resume = (dr) => { const rt = createRuntime(doc, { rng: seededRng(1), lms: { init: () => ({ v: 1, slide: 's-intro', dr }) } }); rt.start({ resume: true }); return rt.state.draws; };
  assert.deepEqual(resume({ 's-draw': [1] }), {}, 'never-included slide');
  assert.deepEqual(resume({ 's-draw': [] }), {}, 'too few');
  assert.deepEqual(resume({ 's-draw': [0, 2] }), {}, 'too many');
  assert.deepEqual(resume({ 's-draw': [2] }), {}, 'misses the always slide');
  assert.deepEqual(resume({ 's-draw': [0] }), { 's-draw': ['s-b1'] }, 'a possible set is kept');
});

test('#5 a trailing empty draw does not leave the course incomplete', () => {
  const doc = build([
    { cmd: 'slide.add', args: { id: 's-intro', title: 'Intro' } },
    { cmd: 'bank.add', args: { id: 'bk-empty', title: 'Empty' } },
    { cmd: 'draw.add', args: { id: 's-draw', bank: 'bk-empty' } },
    { cmd: 'tracking.set', args: { complete: [{ slidesViewed: 100 }] } },
  ]);
  const saves = [];
  const rt = createRuntime(doc, { lms: { init: () => null, status: () => {}, save: (s) => saves.push(s) } }); rt.start();
  assert.equal(rt.state.status, 'incomplete');
  rt.dispatch({ type: 'next' });
  assert.equal(rt.state.status, 'completed');
  assert.deepEqual(saves.at(-1).dr, { 's-draw': [] }, 'the empty draw is saved');
});

test('#3 a bank whose questions differ in quiz membership is reported (CF scores every drawn question)', async () => {
  const { importStory } = await import('../../packages/import-story/index.js');
  const { pkg, storyXml, slides, slide, intr, obj, choice, G } = await import('../fixtures/synthetic/story-builder.js');
  const bankLst = `<bankLst><scene g="${G(33)}" name="Bank A" drawG="${G(34)}"><sldIdLst><sldId>R10</sldId><sldId>R11</sldId></sldIdLst><bankProps rand="false" include="-1" /></scene></bankLst>`;
  const story = storyXml().replace(/<bankLst>.*<\/bankLst>/, bankLst)
    .replace('<sldId>R8</sldId><sldId>R9</sldId>', '<sldId>R9</sldId><sldId>R8</sldId>');
  const q = (n, excluded) => slide(n, { shapes: intr('multiChoiceIntr', n * 10, { title: G(n * 10 + 1) }).replace('<exclQuizLst />', excluded ? `<exclQuizLst><quiz g="${G(40)}" /></exclQuizLst>` : '<exclQuizLst />')
    + obj('textBox', n * 10 + 1, { plain: `Bank ${n}` }) + choice('radio', n * 10 + 2, n * 10, 'Yes', 100, { selected: true }) + choice('radio', n * 10 + 3, n * 10, 'No', 200) });
  const draw = slide(109, { root: 'bankSld', attrs: `resetMode="auto" advMode="user" bankG="${G(33)}" incCnt="2" sync="false" rnd="false"` })
    .replace('</bankSld>', `<questionLst /><excLst /></bankSld>`);
  const parts = slides();
  parts[8] = draw;
  const { report, doc } = importStory(pkg({ story, parts: [...parts, q(110, false), q(111, true)] }));
  assert.ok(doc.quizzes[0].questions.some(id => doc.slides.find(s => s.id === id)?.draw), 'draw precedes the result and is selected by the native default rule');
  assert.equal(report.items.filter((x) => x.kind === 'draw.quizMembership').length, 1, JSON.stringify(report.items.map((x) => x.kind)));
  const afterResult = story.replace('<sldId>R9</sldId><sldId>R8</sldId>', '<sldId>R8</sldId><sldId>R9</sldId>');
  const ungraded = importStory(pkg({ story: afterResult, parts: [...parts, q(110, false), q(111, true)] }));
  assert.equal(ungraded.report.items.filter(x => x.kind === 'draw.quizMembership').length, 0, 'an ungraded draw cannot introduce this quiz scoring gap');
});
