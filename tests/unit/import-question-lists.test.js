// Original synthetic list questions: section 3.10; no private content.
import test from 'node:test';
import assert from 'node:assert/strict';
import { importStory } from '../../packages/import-story/index.js';
import { validate } from '../../packages/schema/index.js';
import { play } from '../../packages/runtime/index.js';
import { G, ID, esc, obj, intr, slide, fbLayer, trig, pkg } from '../fixtures/synthetic/story-builder.js';

const child = (tag, n, parent, label, z = 0, extra = '') => obj(tag, n, {
  plain: label, attrs: `parentG="${G(parent)}" zOrder="${z}"`, extra,
});
const dropdownRows = (key = 'Red') => child('intrLabelDropDown', 210, 200, 'Warm', 1)
  + child('comboMatch', 211, 210, 'Wrong cached answer', 0, `<correctText>${esc(key)}</correctText><cachedText>Wrong</cachedText>`)
  + child('intrLabelDropDown', 220, 200, 'Cool')
  + child('comboMatch', 221, 220, 'Blue', 0, '<correctText>Blue</correctText>');
const dragRows = () => child('matchDragDropItem', 210, 200, '', 1)
  + child('matchDropArea', 211, 210, 'Warm') + child('matchDragItem', 212, 210, 'Red', 1)
  + child('matchDragDropItem', 220, 200, '')
  + child('matchDropArea', 221, 220, 'Cool') + child('matchDragItem', 222, 220, 'Blue', 1);
const sequenceRows = tag => child(tag, 212, 200, 'Finish', 2) + child(tag, 210, 200, 'Start', 0) + child(tag, 211, 200, 'Work', 1);
function packageOf(tag, rows, attempts = 'one') {
  const question = intr(tag, 200, { title: G(201), attempts, cor: G(300), inc: G(310) }).replace(/tryFbG="[^"]+"/, `tryFbG="${G(320)}"`);
  const story = `<story id="${G(1)}"><sceneLst><scene g="${G(30)}"><sldIdLst><sldId>R1</sldId></sldIdLst></scene></sceneLst></story>`;
  return pkg({ story, parts: [slide(101, {
    shapes: question + obj('textBox', 201, { plain: 'Synthetic prompt' }) + rows,
    layers: fbLayer(300, 'Correct', 'Good!') + fbLayer(310, 'Incorrect', 'No.') + fbLayer(320, 'Try Again', 'Try again.'),
    trigs: trig(400, 'OnClick', 'submitInteraction', { blocks: `<interaction submitG="${G(200)}"/>` }),
  })] });
}
const reportHas = (report, kind) => report.items.some(i => i.kind === kind && i.path && i.reason);
for (const [tag, rows, type] of [
  ['matchDropDownIntr', dropdownRows(), 'matching'],
  ['matchDragDropIntr', dragRows(), 'matching'],
  ['seqDropDownIntr', sequenceRows('comboSeq'), 'sequence'],
  ['seqDragDropIntr', sequenceRows('seqDragDropItem'), 'sequence'],
]) test(` lists: ${tag} preserves keys and shared feedback, attempts, points; play grades both outcomes`, () => {
  const { doc, report } = importStory(packageOf(tag, rows));
  assert.deepEqual(validate(doc), []);
  const s = doc.slides[0], q = s.question;
  assert.equal(q?.type, type);
  assert.deepEqual([q.prompt, q.points, q.attempts, q.shuffle], ['Synthetic prompt', 10, 1, true]);
  assert.deepEqual(q.feedback, { correct: 'Good!', incorrect: 'No.', tryAgain: 'Try again.' });
  assert.deepEqual([s.objects.length, s.layers.length, s.triggers.length], [0, 0, 0]);
  let good, bad;
  if (type === 'matching') {
    assert.deepEqual(q.rows.map(r => r.label), ['Warm', 'Cool']);
    assert.deepEqual(q.choices.map(c => c.label), ['Red', 'Blue']);
    assert.deepEqual(q.rows.map(r => r.choice), q.choices.map(c => c.id));
    good = q.rows.map((r, i) => ({ type: 'match', row: r.id, choice: q.choices[i].id }));
    bad = q.rows.map((r, i) => ({ type: 'match', row: r.id, choice: q.choices[1 - i].id }));
    if (tag === 'matchDragDropIntr') assert.ok(reportHas(report, 'question.matchDragPresentation'));
  } else {
    assert.deepEqual(q.choices.map(c => c.label), ['Start', 'Work', 'Finish']);
    good = [210, 211, 212].map((n, index) => ({ type: 'order', choice: ID('c', n), index }));
    bad = [212, 211, 210].map((n, index) => ({ type: 'order', choice: ID('c', n), index }));
    assert.ok(report.items.some(i => i.kind === 'question.sequenceOrder' && /inferred.*zOrder/.test(i.reason)));
  }
  assert.equal(play(doc, [...good, { type: 'submit' }]).view.question.result, 'correct');
  assert.deepEqual(play(doc, [...bad, { type: 'submit' }]).view.feedback, { kind: 'incorrect', text: 'No.' });
  const retry = importStory(packageOf(tag, rows, 'unlimited')).doc;
  assert.equal(retry.slides[0].question.attempts, 0);
  assert.deepEqual(play(retry, [...bad, { type: 'submit' }]).view.feedback, { kind: 'tryAgain', text: 'Try again.' });
  assert.equal(play(retry, [...bad, { type: 'submit' }, { type: 'continue' }, ...good, { type: 'submit' }]).view.question.result, 'correct');
  assert.ok(!reportHas(report, 'invalid'));
});

test('lists: missing dropdown correctText falls back to object text with an inference report; repeated labels share a choice', () => {
  const rows = dropdownRows('').replace('Wrong cached answer', 'Blue');
  const { doc, report } = importStory(packageOf('matchDropDownIntr', rows));
  assert.equal(doc.slides[0].question?.choices.length, 1);
  assert.ok(reportHas(report, 'question.matchingKey'));
  assert.deepEqual(doc.slides[0].question.rows.map(r => r.choice), [ID('c', 211), ID('c', 211)]);
});

test('lists: missing or duplicate sequence zOrder uses document order and reports the inference', () => {
  for (const rows of [sequenceRows('comboSeq').replace(/zOrder="\d"/g, ''), sequenceRows('comboSeq').replace('zOrder="2"', 'zOrder="0"')]) {
    const { doc, report } = importStory(packageOf('seqDropDownIntr', rows));
    assert.deepEqual(doc.slides[0].question?.choices.map(c => c.label), ['Finish', 'Start', 'Work']);
    assert.ok(report.items.some(i => i.kind === 'question.sequenceOrder' && /document order/.test(i.reason)));
  }
});

test('lists: incomplete or ambiguous pairs and empty keys reject the whole question with a reason', () => {
  const cases = [
    ['matchDropDownIntr', dropdownRows().replace(`parentG="${G(220)}"`, `parentG="${G(999)}"`)],
    ['matchDropDownIntr', dropdownRows() + child('comboMatch', 222, 220, 'Extra')],
    ['matchDropDownIntr', dropdownRows('').replace('Wrong cached answer', '')],
    ['matchDragDropIntr', dragRows().replace('matchDragItem', 'unknownItem') .replace('</matchDragItem>', '</unknownItem>')],
    ['seqDragDropIntr', sequenceRows('seqDragDropItem').replace('Finish', '')],
  ];
  for (const [tag, rows] of cases) {
    const { doc, report } = importStory(packageOf(tag, rows));
    assert.deepEqual(validate(doc), []);
    assert.equal(doc.slides[0].question, undefined);
    assert.ok(reportHas(report, 'question.list'));
    assert.ok(doc.slides[0].objects.some(o => o.text === 'Synthetic prompt'), 'rejected question must not consume its prompt');
  }
});
