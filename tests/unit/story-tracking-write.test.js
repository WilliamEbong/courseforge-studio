import test from 'node:test';
import assert from 'node:assert/strict';
import { writeStory } from '../../packages/export-story/index.js';
import { openStory, saveStory, canon } from '../../packages/export-story/save.js';
import { applyAll } from '../../packages/core/index.js';
import { parseXml } from '../../packages/import-story/index.js';
import { rezip } from '../../packages/publisher/zip.js';
import { xml } from '../../packages/publisher/ooxml.js';

const child = (n, tag) => n.kids.find(k => k.tag === tag);
function change(state, commands) {
  const result = applyAll(state.doc, commands);
  assert.ok(result.ok, JSON.stringify(result.errors));
  const next = saveStory(state, result.doc);
  assert.deepEqual(canon(next.doc), canon(result.doc));
  return next;
}
function quizCourse() {
  const state = openStory(writeStory({ title: 'Tracking test' }));
  const slide = state.doc.slides[0].id;
  return change(state, [
    { cmd: 'question.set', args: { slide, type: 'mc', prompt: 'Ready?', choices: [{ id: 'yes', label: 'Yes', correct: true }, { id: 'no', label: 'No', correct: false }] } },
    { cmd: 'quiz.add', args: { id: 'q-test', title: 'Check', questions: [slide] } },
    { cmd: 'quiz.addResults', args: { quiz: 'q-test', id: 's-result', track: true } },
  ]);
}
const tree = state => parseXml(state.zip.read('story/story.xml').toString());
const property = (root, id) => child(root, 'propLst').kids.find(p => p.attrs.id === String(id));

test('native reporting is written in direct LMS state and preserves unrelated publish data', () => {
  let state = quizCourse();
  const original = tree(state), prop = property(original, 3);
  assert.ok(prop, 'native publisher settings must exist, not only CF metadata');
  assert.equal(child(parseXml(prop.text), 'lms').attrs.reporting, 'PassedFailed');
  const raw = state.zip.read('story/story.xml').toString();
  const nested = '<state custom="keep"><reach360><lms reporting="PassedIncomplete"/></reach360><lms type="Scorm1_2" edition="Edition2" reporting="PassedFailed" custom="keep"><course/><lesson/><extra value="keep"/></lms><opaque/></state>';
  const edited = raw.slice(0, prop.oe) + xml(nested) + raw.slice(prop.ce);
  state = openStory(rezip(state.buf, state.zip, { put: new Map([['story/story.xml', Buffer.from(edited)]]) }));
  state = change(state, [{ cmd: 'tracking.set', args: { status: 'completed-incomplete' } }]);
  assert.equal(property(tree(state), 3).text, nested.replace('reporting="PassedFailed"', 'reporting="CompletedIncomplete"'));
});

test('native count and quiz alternatives survive save, and slide-only tracking creates its manager', () => {
  let state = quizCourse();
  state = change(state, [{ cmd: 'tracking.set', args: { complete: [{ slidesViewedCount: 1 }, { quiz: 'q-test' }] } }]);
  const manager = child(tree(state), 'quizMgr').attrs;
  assert.equal(manager.trackMode, 'Slides, Results');
  assert.equal(manager.slidesViewedNumber, '1');
  assert.equal(manager.slidesViewedUnit, 'Count');
  assert.equal(manager.numView, '1');
  state = openStory(writeStory({ title: 'No quiz' }));
  state = change(state, [{ cmd: 'slide.add', args: { id: 's-two', title: 'Second' } }, { cmd: 'tracking.set', args: { complete: [{ slidesViewedCount: 1 }] } }]);
  assert.equal(child(tree(state), 'quizMgr').attrs.slidesViewedNumber, '1');
});

test('native tracking refuses to omit an enabled submitted quiz instead of disguising the difference', () => {
  const state = quizCourse(), before = Buffer.from(state.buf);
  const result = applyAll(state.doc, [{ cmd: 'tracking.set', args: { complete: [{ slidesViewed: 100 }] } }]);
  assert.ok(result.ok);
  assert.throws(() => saveStory(state, result.doc), e => e.errors?.some(x => x.code === 'story-unsupported'));
  assert.ok(state.buf.equals(before));
});

test('native tracking retains two submitted quizzes and a fixed-flow percentage', () => {
  let state = quizCourse();
  state = change(state, [
    { cmd: 'slide.add', args: { id: 's-question-two', title: 'Another question' } },
    { cmd: 'question.set', args: { slide: 's-question-two', type: 'mc', prompt: 'Again?', choices: [{ id: 'two-yes', label: 'Yes', correct: true }, { id: 'two-no', label: 'No', correct: false }] } },
    { cmd: 'quiz.add', args: { id: 'q-two', title: 'Second check', questions: ['s-question-two'] } },
    { cmd: 'quiz.addResults', args: { quiz: 'q-two', id: 's-result-two' } },
    { cmd: 'tracking.set', args: { complete: [{ slidesViewed: 50 }, { quiz: 'q-test' }, { quiz: 'q-two' }] } },
  ]);
  assert.equal(child(tree(state), 'quizMgr').attrs.slidesViewedUnit, 'Percentage');
  assert.deepEqual(state.doc.tracking.complete, [{ slidesViewed: 50 }, { quiz: 'q-test' }, { quiz: 'q-two' }]);
});
