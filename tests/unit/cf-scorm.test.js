import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createScorm12Api } from '../../packages/lms-test-harness/scorm12.js';
import '../../packages/publisher/cf-scorm.js';

const { createScormAdapter } = globalThis.CFScorm;
const SRC = new URL('../../packages/publisher/cf-scorm.js', import.meta.url);
const T0 = new Date(2026, 9, 16, 23, 10, 37).getTime(); // local time, so CMITime is 23:10:37 in any zone

const memStore = () => { let r = null; return { load: () => r && structuredClone(r), save: (x) => { r = structuredClone(x); } }; };

// A content window whose parent frame holds the real mock LMS API.
function launch(store = memStore(), opts = {}) {
  const calls = [];
  const api = createScorm12Api(store, (e) => { if (e.fn !== 'LMSGetLastError') calls.push(`${e.fn}(${e.args.map((x) => JSON.stringify(x)).join(', ')})`); });
  const listeners = {};
  const clock = { t: T0 };
  const win = { parent: { API: api }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const ad = createScormAdapter({ win, courseId: 'demo', now: () => clock.t, ...opts });
  return { ad, api, calls, listeners, clock, store };
}

test('first launch: SCORM call sequence, data model values, finish', () => {
  const { ad, api, calls, clock } = launch();
  assert.equal(ad.found, true);
  assert.equal(ad.init(), null);
  assert.deepEqual(calls, [
    'LMSInitialize("")',
    'LMSGetValue("cmi.interactions._count")',
    'LMSGetValue("cmi.core.lesson_status")',
    'LMSSetValue("cmi.core.lesson_status", "incomplete")',
    'LMSSetValue("cmi.core.exit", "suspend")',
    'LMSGetValue("cmi.suspend_data")',
    'LMSCommit("")',
  ]);
  assert.equal(api._record().status, 'incomplete');
  calls.length = 0;
  clock.t += 10890;
  assert.equal(ad.save({ slide: 's-2' }), true);
  ad.status('passed');
  ad.exit();
  assert.deepEqual(calls, [
    'LMSSetValue("cmi.suspend_data", "{\\"slide\\":\\"s-2\\"}")',
    'LMSCommit("")',
    'LMSSetValue("cmi.core.lesson_status", "passed")',
    'LMSCommit("")',
    'LMSSetValue("cmi.core.session_time", "0000:00:10.89")',
    'LMSSetValue("cmi.core.exit", "")',
    'LMSCommit("")',
    'LMSFinish("")',
  ]);
  const rec = api._record();
  assert.equal(rec.status, 'passed');
  assert.equal(rec.suspend, '{"slide":"s-2"}');
  assert.equal(rec.lastExit, '');
  assert.equal(rec.total, '0000:00:10.89');
  assert.deepEqual(ad.warnings, []);
});

test('status mapping per tracking.status, and exit=suspend only until terminal', () => {
  const table = {
    'passed-incomplete': { passed: 'passed', completed: 'passed', failed: 'incomplete', incomplete: 'incomplete' },
    'passed-failed': { passed: 'passed', completed: 'passed', failed: 'failed', incomplete: 'incomplete' },
    'completed-incomplete': { passed: 'completed', completed: 'completed', failed: 'incomplete', incomplete: 'incomplete' },
    'completed-failed': { passed: 'completed', completed: 'completed', failed: 'failed', incomplete: 'incomplete' },
  };
  for (const [mode, row] of Object.entries(table)) {
    for (const [runtime, expected] of Object.entries(row)) {
      const { ad, api } = launch(memStore(), { tracking: { status: mode } });
      ad.init();
      ad.status(runtime);
      assert.equal(api._record().status, expected, `${mode}: ${runtime}`);
      ad.exit();
      assert.equal(api._record().lastExit, expected === 'incomplete' ? 'suspend' : '', `${mode}: ${runtime} exit`);
      assert.deepEqual(ad.warnings, []);
    }
  }
  // Default is the vendor default, Passed/Incomplete.
  const { ad, api } = launch(memStore(), { tracking: {} });
  ad.init(); ad.status('completed');
  assert.equal(api._record().status, 'passed');
  ad.status('done');
  assert.equal(ad.warnings[0].code, 'bad-status');
  assert.throws(() => launch(memStore(), { tracking: { status: 'passed' } }), TypeError);
  assert.throws(() => createScormAdapter({ win: {} }), /courseId/);
});

test('score: at most 2 decimals, truncated; invalid values are refused', () => {
  const { ad, api } = launch();
  ad.init();
  for (const [raw, want] of [[66.666666, '66.66'], [33.33, '33.33'], [100, '100'], [0.1 + 0.2, '0.3'], [0, '0']]) {
    ad.score({ raw, min: 0, max: 100 });
    ad.save({}); // score is committed with the next save/status/exit (fewer commits)
    assert.equal(api._record().raw, want);
  }
  assert.equal(api._record().min, '0');
  assert.equal(api._record().max, '100');
  ad.score({ raw: 101 }); ad.score({ raw: NaN }); ad.score({ raw: '50' }); ad.score(null); ad.save({});
  assert.equal(api._record().raw, '0');
  assert.deepEqual(ad.warnings.map((w) => w.code), ['bad-score', 'bad-score', 'bad-score', 'bad-score']);
});

test('interactions use spec-valid SCORM 1.2 formats', () => {
  const { ad, api } = launch();
  ad.init();
  ad.interaction({ id: 'qz-1_s-q2_0', type: 'choice', response: [2, 0], correct: [0, 2], result: 'correct', weighting: 10, latencyMs: 11240, objective: 'qz-1' });
  ad.interaction({ id: 'qz-1_s-q1_0', type: 'choice', response: [0], correct: [1], result: 'wrong' });
  ad.interaction({ id: 'qz-1_s-tf_0', type: 'true-false', response: false, correct: true, result: 'wrong' });
  ad.interaction({ id: 'qz-1_s-q3_0', type: 'fill-in', response: 'x'.repeat(300), correct: ['teal', 'teal blue'], result: 'wrong' });
  // Rejected: matching without pairs, index past z, whitespace id, missing id, bad result.
  ad.interaction({ id: 'q-m', type: 'matching', response: [], correct: [], result: 'correct' });
  ad.interaction({ id: 'q-z', type: 'choice', response: [26], correct: [0], result: 'wrong' });
  ad.interaction({ id: 'q 1', type: 'true-false', response: true, correct: true, result: 'correct' });
  ad.interaction({ type: 'true-false', response: true, correct: true, result: 'correct' });
  ad.interaction({ id: 'q-r', type: 'true-false', response: true, correct: true, result: true });
  const [mr, mc, tf, fill, ...rest] = api._record().interactions;
  assert.equal(rest.length, 0);
  assert.deepEqual(Object.keys(mr), ['id', 'objectives.0.id', 'time', 'type', 'correct_responses.0.pattern', 'weighting', 'student_response', 'result', 'latency']);
  assert.deepEqual(mr, {
    id: 'qz-1_s-q2_0', 'objectives.0.id': 'qz-1', time: '23:10:37', type: 'choice', 'correct_responses.0.pattern': '{a,c}', // all listed choices required (review 002 #10)
    weighting: '10', student_response: 'a,c', result: 'correct', latency: '0000:00:11.24',
  });
  assert.deepEqual(mc, { id: 'qz-1_s-q1_0', time: '23:10:37', type: 'choice', 'correct_responses.0.pattern': 'b', student_response: 'a', result: 'wrong' });
  assert.equal(tf.student_response, 'f');
  assert.equal(tf['correct_responses.0.pattern'], 't');
  assert.equal(tf.type, 'true-false');
  assert.equal(fill.student_response, 'x'.repeat(255));
  assert.equal(fill['correct_responses.0.pattern'], 'teal');
  assert.equal(fill['correct_responses.1.pattern'], 'teal blue');
  assert.equal(ad.warnings.length, 5);
  assert.ok(ad.warnings.every((w) => w.code === 'bad-interaction'));
});

test('suspend_data round trip resumes; 4096 guard keeps last good value; interactions append', () => {
  const store = memStore();
  const s1 = launch(store);
  s1.ad.init();
  s1.ad.interaction({ id: 'q1_0', type: 'true-false', response: true, correct: true, result: 'correct' });
  const snap = { slide: 's-3', vars: { n: 2, name: 'Ann "A" <b>' }, visited: ['s-1', 's-2'] };
  assert.equal(s1.ad.save(snap), true);
  const exact = { s: 'x'.repeat(4096 - 8) }; // JSON is exactly 4096 chars
  assert.equal(JSON.stringify(exact).length, 4096);
  assert.equal(s1.ad.save(exact), true);
  assert.equal(s1.ad.save(snap), true);
  assert.equal(s1.ad.save({ s: 'x'.repeat(4096 - 7) }), false);
  assert.equal(s1.api._record().suspend, JSON.stringify(snap), 'last good value kept, not truncated');
  assert.deepEqual(s1.ad.warnings, [{ call: 'save', code: 'suspend-too-long', length: 4097 }]);
  s1.clock.t += 5000;
  s1.ad.exit();
  assert.equal(s1.api._record().lastExit, 'suspend');

  const s2 = launch(store);
  assert.deepEqual(s2.ad.init(), snap);
  assert.equal(s2.api.LMSGetValue('cmi.core.entry'), 'resume');
  assert.ok(!s2.calls.some((c) => c.startsWith('LMSSetValue("cmi.core.lesson_status"')), 'existing incomplete status is not rewritten');
  s2.ad.interaction({ id: 'q1_1', type: 'true-false', response: false, correct: true, result: 'wrong' });
  assert.deepEqual(s2.api._record().interactions.map((i) => i.id), ['q1_0', 'q1_1']);
  s2.clock.t += 2500;
  s2.ad.exit();
  assert.equal(s2.api._record().total, '0000:00:07.50');
  assert.deepEqual(s2.ad.warnings, []);
});

test('relaunch after a terminal status keeps it and does not set exit=suspend', () => {
  const store = memStore();
  const s1 = launch(store);
  s1.ad.init(); s1.ad.status('passed'); s1.ad.exit();
  const s2 = launch(store);
  s2.ad.init();
  assert.ok(!s2.calls.some((c) => c.startsWith('LMSSetValue')), s2.calls.join('\n'));
  assert.equal(s2.api._record().status, 'passed');
});

test('pagehide saves a final snapshot and finishes once; cancelable beforeunload is not hooked (review 002 #6, #7)', () => {
  const live = { v: 1, slide: 's-1', vars: { learner: 'Alice' } };
  const { ad, api, calls, listeners } = launch(undefined, { snapshot: () => live });
  ad.init();
  assert.equal(typeof listeners.pagehide, 'function');
  assert.equal(listeners.beforeunload, undefined);
  listeners.pagehide({});
  ad.exit();
  assert.equal(api._record().suspend, JSON.stringify(live), 'state typed on the current slide survives closing');
  assert.equal(calls.filter((c) => c.startsWith('LMSFinish')).length, 1);
  ad.status('passed'); // after finish: no-op, no LMS error
  assert.equal(calls.filter((c) => c.includes('lesson_status", "passed')).length, 0);
});

test('API discovery: parent chain up to 7, opener chain, cross-origin frames', () => {
  const API = createScorm12Api(memStore());
  const chain = (depth, top) => { let w = top; for (let i = 0; i < depth; i++) w = { parent: w }; return w; };
  assert.equal(createScormAdapter({ win: chain(7, { API }), courseId: 'c' }).found, true);
  assert.equal(createScormAdapter({ win: chain(8, { API }), courseId: 'c' }).found, false);
  assert.equal(createScormAdapter({ win: { parent: {}, opener: chain(2, { API }) }, courseId: 'c' }).found, true);
  const crossOrigin = { get API() { throw new Error('SecurityError'); }, parent: { API } };
  assert.equal(createScormAdapter({ win: { parent: crossOrigin }, courseId: 'c' }).found, true);
  const top = {}; top.parent = top; // real top window: parent === self
  assert.equal(createScormAdapter({ win: top, courseId: 'c' }).found, false);
});

test('no API: methods are no-ops and resume uses localStorage cf:<courseId>', () => {
  const data = new Map();
  const localStorage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  const ad = createScormAdapter({ win: { localStorage }, courseId: 'demo' });
  assert.equal(ad.found, false);
  assert.equal(ad.init(), null);
  const big = { s: 'x'.repeat(5000) }; // no 4096 cap outside an LMS
  assert.equal(ad.save(big), true);
  assert.equal(data.get('cf:demo'), JSON.stringify(big));
  ad.status('passed'); ad.score({ raw: 50 }); ad.interaction({ id: 'q', type: 'true-false', response: true, correct: true, result: 'correct' }); ad.exit();
  assert.deepEqual(ad.warnings, []);
  assert.deepEqual(createScormAdapter({ win: { localStorage }, courseId: 'demo' }).init(), big);

  // Blocked storage: no throw, warnings instead.
  const blocked = createScormAdapter({ win: { get localStorage() { throw new Error('SecurityError'); } }, courseId: 'demo' });
  assert.equal(blocked.init(), null);
  assert.equal(blocked.save({ a: 1 }), false);
  assert.deepEqual(blocked.warnings.map((w) => w.code), ['exception', 'exception']);
  data.set('cf:bad', '{not json');
  const bad = createScormAdapter({ win: { localStorage }, courseId: 'bad' });
  assert.equal(bad.init(), null);
  assert.equal(bad.warnings[0].code, 'bad-json');
});

test('failed Initialize falls back to localStorage', () => {
  const API = createScorm12Api(memStore());
  API.LMSInitialize(''); // a second Initialize now fails with 101
  const data = new Map([['cf:demo', '{"slide":"s-9"}']]);
  const ad = createScormAdapter({ win: { parent: { API }, localStorage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) } }, courseId: 'demo' });
  assert.equal(ad.found, true);
  assert.deepEqual(ad.init(), { slide: 's-9' });
  assert.equal(ad.found, false);
  assert.deepEqual(ad.warnings[0], { call: 'LMSInitialize', element: undefined, code: '101' });
});

test('refused or throwing LMS calls become warnings, never exceptions', () => {
  const store = memStore();
  const real = createScorm12Api(store);
  const API = { ...real, LMSCommit: () => 'false', LMSGetLastError: () => '101', LMSSetValue: (el, v) => { if (el === 'cmi.core.score.raw') throw new Error('boom'); return real.LMSSetValue(el, v); } };
  const ad = createScormAdapter({ win: { parent: { API } }, courseId: 'demo' });
  ad.init();
  ad.score({ raw: 50 });
  assert.equal(ad.save({ a: 1 }), false);
  const codes = ad.warnings.map((w) => `${w.call}:${w.element ?? ''}:${w.code}`);
  assert.deepEqual(codes, ['LMSCommit::101', 'LMSSetValue:cmi.core.score.raw:exception', 'LMSCommit::101']);
});

test('cf-scorm.js stays ES2017 syntax and loads as a classic script onto window', () => {
  const raw = fs.readFileSync(SRC, 'utf8');
  const code = raw.replace(/\/\/.*$/gm, ''); // drop line comments (they name the banned syntax)
  assert.doesNotMatch(code, /\?\.[^\d]|\?\?|catch\s*\{|\{\s*\.\.\.|\(\?<|^\s*(import|export)\s/m);
  const ctx = { window: {} };
  vm.runInNewContext(raw, ctx); // sloppy-mode script, like a <script> tag
  assert.equal(typeof ctx.window.CFScorm.createScormAdapter, 'function');
});
