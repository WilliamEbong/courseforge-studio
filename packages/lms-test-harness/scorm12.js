// Mock SCORM 1.2 runtime API ("API" object) with call logging and spec-level validation.
// Used two ways: to trace vendor reference packages during the trial, and to validate our own published packages.
// Ref: SCORM 1.2 Run-Time Environment (ADL, 2001), section 3.3 data model and section 3.4 error codes.

export const ERR = {
  0: 'No error', 101: 'General exception', 201: 'Invalid argument error', 202: 'Element cannot have children',
  203: 'Element not an array - cannot have count', 301: 'Not initialized', 401: 'Not implemented error',
  402: 'Invalid set value, element is a keyword', 403: 'Element is read only', 404: 'Element is write only',
  405: 'Incorrect data type',
};

const STATUS = ['passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted'];
const EXIT = ['time-out', 'suspend', 'logout', ''];
const TIMESPAN = /^\d{2,4}:\d{2}:\d{2}(\.\d{1,2})?$/;
const decimalOrBlank = (v) => v === '' || (/^-?\d+(\.\d+)?$/.test(v));
const score = (v) => v === '' || (decimalOrBlank(v) && +v >= 0 && +v <= 100);

// element -> { r: readable, w: writable, check?: (value) => bool, max?: length }
const MODEL = {
  'cmi.core._children': { r: 1, keyword: 1 },
  'cmi.core.student_id': { r: 1 }, 'cmi.core.student_name': { r: 1 },
  'cmi.core.lesson_location': { r: 1, w: 1, max: 255 },
  'cmi.core.credit': { r: 1 }, 'cmi.core.entry': { r: 1 }, 'cmi.core.lesson_mode': { r: 1 },
  'cmi.core.lesson_status': { r: 1, w: 1, check: (v) => STATUS.includes(v) && v !== 'not attempted' },
  'cmi.core.score._children': { r: 1, keyword: 1 },
  'cmi.core.score.raw': { r: 1, w: 1, check: score }, 'cmi.core.score.min': { r: 1, w: 1, check: score },
  'cmi.core.score.max': { r: 1, w: 1, check: score },
  'cmi.core.total_time': { r: 1 },
  'cmi.core.exit': { w: 1, check: (v) => EXIT.includes(v) },
  'cmi.core.session_time': { w: 1, check: (v) => TIMESPAN.test(v) },
  'cmi.suspend_data': { r: 1, w: 1, max: 4096 },
  'cmi.launch_data': { r: 1 }, 'cmi.comments': { r: 1, w: 1, max: 4096 }, 'cmi.comments_from_lms': { r: 1 },
  'cmi.student_data._children': { r: 1, keyword: 1 }, 'cmi.student_data.mastery_score': { r: 1 },
  'cmi.student_data.max_time_allowed': { r: 1 }, 'cmi.student_data.time_limit_action': { r: 1 },
  'cmi.student_preference._children': { r: 1, keyword: 1 },
  'cmi.objectives._children': { r: 1, keyword: 1 }, 'cmi.objectives._count': { r: 1 },
  'cmi.interactions._children': { r: 1, keyword: 1 }, 'cmi.interactions._count': { r: 1 },
};
// Array members (n = index). Interactions are write-only in SCORM 1.2 except _count members.
const ARRAY_MEMBER = /^cmi\.(objectives|interactions)\.(\d+)\.(.+)$/;
const INTERACTION_FIELDS = new Set(['id', 'time', 'type', 'weighting', 'student_response', 'result', 'latency',
  'objectives._count', 'correct_responses._count']);
const INTERACTION_SUB = /^(objectives|correct_responses)\.(\d+)\.(id|pattern)$/;
const OBJECTIVE_FIELDS = new Set(['id', 'score.raw', 'score.min', 'score.max', 'status', 'score._children']);

function addTimespans(a, b) {
  const sec = (t) => { const [h, m, s] = t.split(':'); return +h * 3600 + +m * 60 + +s; };
  const total = sec(a) + sec(b);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total - h * 3600 - m * 60;
  return `${String(h).padStart(4, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * @param {{ load(): object|null, save(state: object): void }} store  persistent learner record (one SCO)
 * @param {(entry: object) => void} log
 */
export function createScorm12Api(store, log = () => {}, learner = { id: 'learner-1', name: 'Learner, Test' }) {
  let rec = store.load() || { status: 'not attempted', location: '', suspend: '', raw: '', min: '', max: '',
    total: '0000:00:00.00', lastExit: '', comments: '', objectives: [], interactions: [], sessions: 0 };
  let state = 'not-initialized'; // -> running -> finished
  let lastError = 0;
  let pending = {}; // values set this session, applied on commit/finish
  let entry = '';

  const fail = (code, ret) => { lastError = code; return ret; };
  const ok = (ret) => { lastError = 0; return ret; };

  function snapshot() {
    return { ...rec, ...pending.rec, objectives: rec.objectives, interactions: rec.interactions };
  }

  function getValue(el) {
    if (state !== 'running') return fail(301, '');
    if (el === 'cmi.core.entry') return ok(entry);
    if (el === 'cmi.core.student_id') return ok(learner.id);
    if (el === 'cmi.core.student_name') return ok(learner.name);
    if (el === 'cmi.core.credit') return ok('credit');
    if (el === 'cmi.core.lesson_mode') return ok('normal');
    const cur = snapshot();
    const map = {
      'cmi.core.lesson_location': cur.location, 'cmi.core.lesson_status': cur.status,
      'cmi.core.score.raw': cur.raw, 'cmi.core.score.min': cur.min, 'cmi.core.score.max': cur.max,
      'cmi.core.total_time': rec.total, 'cmi.suspend_data': cur.suspend, 'cmi.launch_data': '',
      'cmi.comments': cur.comments, 'cmi.comments_from_lms': '',
      'cmi.student_data.mastery_score': '', 'cmi.student_data.max_time_allowed': '', 'cmi.student_data.time_limit_action': '',
      'cmi.objectives._count': String(rec.objectives.length), 'cmi.interactions._count': String(rec.interactions.length),
      'cmi.core._children': 'student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time',
      'cmi.core.score._children': 'raw,min,max', 'cmi.student_data._children': 'mastery_score,max_time_allowed,time_limit_action',
      'cmi.objectives._children': 'id,score,status', 'cmi.interactions._children': 'id,objectives,time,type,correct_responses,weighting,student_response,result,latency',
      'cmi.student_preference._children': '',
    };
    if (el in map) return ok(map[el]);
    const m = ARRAY_MEMBER.exec(el);
    if (m && m[1] === 'objectives' && OBJECTIVE_FIELDS.has(m[3])) return ok(String(rec.objectives[+m[2]]?.[m[3]] ?? ''));
    if (m && m[1] === 'interactions') return fail(404, '');
    const def = MODEL[el];
    if (def && !def.r) return fail(404, '');
    if (el.startsWith('cmi.student_preference.')) return fail(401, '');
    return fail(201, '');
  }

  function setValue(el, value) {
    if (state !== 'running') return fail(301, 'false');
    value = String(value);
    const m = ARRAY_MEMBER.exec(el);
    if (m) {
      const list = m[1] === 'objectives' ? rec.objectives : rec.interactions;
      const n = +m[2];
      if (n > list.length) return fail(201, 'false'); // arrays must be filled in order
      const field = m[3];
      const legal = m[1] === 'objectives' ? OBJECTIVE_FIELDS.has(field) : (INTERACTION_FIELDS.has(field) || INTERACTION_SUB.test(field));
      if (!legal || field.endsWith('_count') || field.endsWith('_children')) return fail(field.endsWith('_count') || field.endsWith('_children') ? 402 : 201, 'false');
      list[n] = { ...(list[n] || {}), [field]: value };
      return ok('true');
    }
    const def = MODEL[el];
    if (!def) return fail(el.startsWith('cmi.student_preference.') ? 401 : 201, 'false');
    if (def.keyword) return fail(402, 'false');
    if (!def.w) return fail(403, 'false');
    if (def.check && !def.check(value)) return fail(405, 'false');
    if (def.max && value.length > def.max) return fail(405, 'false');
    const key = { 'cmi.core.lesson_location': 'location', 'cmi.core.lesson_status': 'status', 'cmi.core.score.raw': 'raw',
      'cmi.core.score.min': 'min', 'cmi.core.score.max': 'max', 'cmi.suspend_data': 'suspend', 'cmi.comments': 'comments',
      'cmi.core.exit': 'exit', 'cmi.core.session_time': 'session' }[el];
    pending.rec = { ...pending.rec, [key]: value };
    return ok('true');
  }

  function persist(final) {
    const p = pending.rec || {};
    const next = { ...rec };
    for (const k of ['location', 'status', 'raw', 'min', 'max', 'suspend', 'comments']) if (k in p) next[k] = p[k];
    if (final) {
      if (p.session) next.total = addTimespans(rec.total, p.session);
      next.lastExit = p.exit ?? '';
      // SCORM 1.2: an LMS may set "completed" if the SCO never set a status; we record what the SCO sent and leave it.
      next.sessions = rec.sessions + 1;
    }
    rec = next;
    store.save(rec);
  }

  const wrap = (name, fn) => (...args) => {
    const ret = fn(...args);
    log({ t: Date.now(), fn: name, args, ret, err: lastError });
    return ret;
  };

  return {
    LMSInitialize: wrap('LMSInitialize', (arg = '') => {
      if (arg !== '') return fail(201, 'false');
      if (state === 'running') return fail(101, 'false');
      if (state === 'finished') return fail(101, 'false');
      state = 'running';
      entry = rec.sessions === 0 ? 'ab-initio' : rec.lastExit === 'suspend' ? 'resume' : '';
      if (rec.status === 'not attempted') { /* status stays until the SCO sets one */ }
      return ok('true');
    }),
    LMSFinish: wrap('LMSFinish', (arg = '') => {
      if (arg !== '') return fail(201, 'false');
      if (state !== 'running') return fail(301, 'false');
      persist(true); pending = {}; state = 'finished';
      return ok('true');
    }),
    LMSGetValue: wrap('LMSGetValue', getValue),
    LMSSetValue: wrap('LMSSetValue', setValue),
    LMSCommit: wrap('LMSCommit', (arg = '') => {
      if (arg !== '') return fail(201, 'false');
      if (state !== 'running') return fail(301, 'false');
      persist(false);
      return ok('true');
    }),
    LMSGetLastError: wrap('LMSGetLastError', () => String(lastError)),
    LMSGetErrorString: wrap('LMSGetErrorString', (code) => ERR[+code] ?? ''),
    LMSGetDiagnostic: wrap('LMSGetDiagnostic', (code) => ERR[code === '' || code == null ? lastError : +code] ?? ''),
    _record: () => structuredClone(rec),
  };
}
