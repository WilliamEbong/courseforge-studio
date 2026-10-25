// Reported text inputs (ungraded SCORM 1.2 fill-in, result neutral), input maxLength and the resume-size warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse, validate } from '../../packages/schema/index.js';
import { applyAll, resumeIssues } from '../../packages/core/index.js';
import { createRuntime } from '../../packages/runtime/index.js';
import { toScormInteraction } from '../../packages/publisher/index.js';
import { createScorm12Api } from '../../packages/lms-test-harness/scorm12.js';
import '../../packages/publisher/cf-scorm.js';

function course(inputs = [{ id: 'o-plan', type: 'input', var: 'plan', report: true, alt: 'Your change' }]) {
  const vars = [...new Set(inputs.map((o) => o.var).filter(Boolean))];
  const r = applyAll(emptyCourse(), [
    ...vars.map((name) => ({ cmd: 'var.add', args: { name, type: 'text' } })),
    { cmd: 'slide.add', args: { id: 's-1', objects: inputs } },
    { cmd: 'slide.add', args: { id: 's-2' } },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.doc;
}
function run(doc) {
  const calls = [];
  const lms = { init: () => null, status: (s) => calls.push(['status', s]), score: (s) => calls.push(['score', s]), save: () => true, exit: () => calls.push(['exit']), interaction: (r) => calls.push(['interaction', r]) };
  return { rt: createRuntime(doc, { lms }).start(), calls };
}
const records = (calls) => calls.filter(([k]) => k === 'interaction').map(([, r]) => r);

test('a reported input sends one ungraded fill-in when the learner leaves the slide, and no score', () => {
  const { rt, calls } = run(course());
  rt.dispatch({ type: 'input', target: 'o-plan', text: 'Ask about smoking at every visit' });
  assert.equal(records(calls).length, 0, 'nothing is reported while typing');
  rt.dispatch({ type: 'next' });
  const [rec, ...more] = records(calls);
  assert.equal(more.length, 0);
  assert.equal(rec.id, 'o-plan');
  assert.equal(rec.type, 'fill');
  assert.equal(rec.result, 'neutral');
  assert.equal(rec.response, 'Ask about smoking at every visit');
  assert.deepEqual(rec.correct, []);
  assert.equal(calls.some(([k]) => k === 'score'), false);
  // Back and forward again without a change: not reported twice. A changed answer is reported again.
  rt.dispatch({ type: 'prev' }); rt.dispatch({ type: 'next' });
  assert.equal(records(calls).length, 1);
  rt.dispatch({ type: 'prev' }); rt.dispatch({ type: 'input', target: 'o-plan', text: 'Ask at every visit' }); rt.dispatch({ type: 'next' });
  assert.equal(records(calls).length, 2);
});

test('inputs without report send nothing; an empty reported answer sends nothing', () => {
  const quiet = run(course([{ id: 'o-a', type: 'input', var: 'a' }]));
  quiet.rt.dispatch({ type: 'input', target: 'o-a', text: 'hello' }); quiet.rt.dispatch({ type: 'next' });
  assert.equal(records(quiet.calls).length, 0);
  const empty = run(course());
  empty.rt.dispatch({ type: 'next' });
  assert.equal(records(empty.calls).length, 0);
});

test('text typed before the window closed is reported after resume; Exit course reports too', () => {
  const doc = course();
  const first = run(doc);
  first.rt.dispatch({ type: 'input', target: 'o-plan', text: 'Ask at every visit' });
  const snap = JSON.parse(JSON.stringify(first.rt.snapshot())); // the learner closes the window here
  assert.equal(records(first.calls).length, 0);
  const calls = [];
  const lms = { init: () => snap, save: () => true, status() {}, score() {}, exit: () => calls.push(['exit']), interaction: (r) => calls.push(['interaction', r]) };
  const rt = createRuntime({ ...doc, player: { ...doc.player, resume: 'always' } }, { lms }).start();
  rt.dispatch({ type: 'next' });
  assert.deepEqual(records(calls).map((r) => r.response), ['Ask at every visit']);
  const exiting = applyAll(doc, [{ cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'key', key: 'q' }, do: [{ action: 'exitCourse' }] } }]);
  assert.equal(exiting.ok, true, JSON.stringify(exiting.errors));
  const ex = run(exiting.doc);
  ex.rt.dispatch({ type: 'input', target: 'o-plan', text: 'Bye' });
  ex.rt.dispatch({ type: 'key', key: 'q' });
  assert.deepEqual(ex.calls.filter(([k]) => k === 'interaction' || k === 'exit').map(([k, r]) => (r ? r.response : k)), ['Bye', 'exit']);
});

test('report needs a variable; maxLength and report apply to inputs only', () => {
  const doc = course([{ id: 'o-a', type: 'input', alt: 'x' }, { id: 'o-b', type: 'button', text: 'Go' }]);
  doc.slides[0].objects[0].report = true;
  doc.slides[0].objects[1].maxLength = 10;
  assert.deepEqual(validate(doc).map((e) => [e.path, e.code]), [['/slides/0/objects/1/maxLength', 'semantic'], ['/slides/0/objects/0/report', 'required']].sort());
});

test('neutral fill-in reaches the LMS as SCORM 1.2 fill-in, result neutral, 255-character response, no correct_responses', () => {
  const store = { r: null, load() { return this.r; }, save(x) { this.r = structuredClone(x); } };
  const api = createScorm12Api(store);
  const ad = globalThis.CFScorm.createScormAdapter({ win: { parent: { API: api }, addEventListener() {} }, courseId: 'demo' });
  ad.init();
  const rec = toScormInteraction({ id: 'o-plan step 1', type: 'fill', response: 'x'.repeat(400), correct: [], result: 'neutral', latencyMs: 5000 });
  assert.equal(rec.result, 'neutral');
  ad.interaction(rec);
  const [i] = api._record().interactions;
  assert.equal(i.id, 'o-plan_step_1');
  assert.equal(i.type, 'fill-in');
  assert.equal(i.result, 'neutral');
  assert.equal(i.student_response.length, 255);
  assert.equal(Object.keys(i).some((k) => k.startsWith('correct_responses')), false);
  assert.deepEqual(ad.warnings, []);
  assert.equal(api._record().raw, '', 'no score');
});

test('input text is capped at maxLength (default 400) and the view carries the limit', () => {
  const { rt } = run(course([{ id: 'o-a', type: 'input', var: 'a', alt: 'a' }, { id: 'o-b', type: 'input', var: 'b', alt: 'b', maxLength: 20 }]));
  rt.dispatch({ type: 'input', target: 'o-a', text: 'x'.repeat(1000) });
  rt.dispatch({ type: 'input', target: 'o-b', text: 'y'.repeat(50) });
  const v = rt.view();
  assert.equal(v.vars.a.length, 400);
  assert.equal(v.vars.b.length, 20);
  assert.deepEqual(v.objects.map((o) => o.maxLength), [400, 20]);
});

test('resume-size warning: quiet for five inputs at the default, warns when full fields overflow 4096', () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `o-${i}`, type: 'input', var: `t${i}`, alt: 'a' }));
  assert.deepEqual(resumeIssues(course(five)), []);
  const big = course(five.map((o, i) => ({ ...o, maxLength: i === 3 ? 1000 : 900 })));
  const [w, ...rest] = resumeIssues(big);
  assert.equal(rest.length, 0);
  assert.equal(w.code, 'resume-size');
  assert.match(w.fix, /"id":"o-3"/);
});
