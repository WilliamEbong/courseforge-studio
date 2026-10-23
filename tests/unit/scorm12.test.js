import test from 'node:test';
import assert from 'node:assert/strict';
import { createScorm12Api } from '../../packages/lms-test-harness/scorm12.js';

const memStore = () => { let r = null; return { load: () => r && structuredClone(r), save: (x) => { r = structuredClone(x); } }; };

test('lifecycle, entry and resume across sessions', () => {
  const store = memStore();
  let api = createScorm12Api(store);
  assert.equal(api.LMSGetValue('cmi.core.lesson_status'), '');
  assert.equal(api.LMSGetLastError(), '301');
  assert.equal(api.LMSInitialize(''), 'true');
  assert.equal(api.LMSGetValue('cmi.core.entry'), 'ab-initio');
  assert.equal(api.LMSGetValue('cmi.core.lesson_status'), 'not attempted');
  assert.equal(api.LMSSetValue('cmi.core.lesson_status', 'incomplete'), 'true');
  assert.equal(api.LMSSetValue('cmi.suspend_data', 'abc'), 'true');
  assert.equal(api.LMSSetValue('cmi.core.exit', 'suspend'), 'true');
  assert.equal(api.LMSSetValue('cmi.core.session_time', '0000:01:30.00'), 'true');
  assert.equal(api.LMSFinish(''), 'true');
  assert.equal(api.LMSGetValue('cmi.suspend_data'), '');
  assert.equal(api.LMSGetLastError(), '301');

  api = createScorm12Api(store);
  api.LMSInitialize('');
  assert.equal(api.LMSGetValue('cmi.core.entry'), 'resume');
  assert.equal(api.LMSGetValue('cmi.suspend_data'), 'abc');
  assert.equal(api.LMSGetValue('cmi.core.total_time'), '0000:01:30.00');
});

test('data model validation errors', () => {
  const api = createScorm12Api(memStore());
  api.LMSInitialize('');
  assert.equal(api.LMSSetValue('cmi.core.lesson_status', 'done'), 'false');
  assert.equal(api.LMSGetLastError(), '405');
  assert.equal(api.LMSSetValue('cmi.core.student_name', 'x'), 'false');
  assert.equal(api.LMSGetLastError(), '403');
  assert.equal(api.LMSGetValue('cmi.core.exit'), '');
  assert.equal(api.LMSGetLastError(), '404');
  assert.equal(api.LMSSetValue('cmi.core._children', 'x'), 'false');
  assert.equal(api.LMSGetLastError(), '402');
  assert.equal(api.LMSSetValue('cmi.core.score.raw', '101'), 'false');
  assert.equal(api.LMSSetValue('cmi.suspend_data', 'x'.repeat(4097)), 'false');
  assert.equal(api.LMSSetValue('cmi.interactions.1.id', 'q'), 'false'); // must fill index 0 first
  assert.equal(api.LMSSetValue('cmi.interactions.0.id', 'q1'), 'true');
  assert.equal(api.LMSGetValue('cmi.interactions._count'), '1');
  assert.equal(api.LMSGetErrorString('403'), 'Element is read only');
});
