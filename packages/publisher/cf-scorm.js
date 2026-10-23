// CourseForge Studio runtime LMS adapter for SCORM 1.2 (interface from item 14).
// Classic browser script in ES2017 syntax (no ?. ?? object spread or optional catch binding). It assigns
// CFScorm to window (browser) or globalThis (Node); Node tests import this file for that side effect.
(function (root) {
  'use strict';

  const MODES = ['passed-incomplete', 'passed-failed', 'completed-incomplete', 'completed-failed'];
  const TERMINAL = ['passed', 'completed', 'failed'];
  const SUSPEND_MAX = 4096; // SCORM 1.2 CMIString4096
  const MAX_DEPTH = 7;
  const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,255}$/.test(v);
  const pad = (n, w) => String(n).padStart(w, '0');
  const pct = (n) => typeof n === 'number' && n >= 0 && n <= 100; // false for NaN
  // At most 2 decimals, truncated like the vendor; toFixed(6) first avoids float noise.
  const dec2 = (n) => String(Number(n.toFixed(6).replace(/(\.\d\d)\d*$/, '$1')));
  const str255 = (s) => Array.from(String(s)).slice(0, 255).join(''); // by code point, never splits a surrogate pair
  const isIxList = (v) => Array.isArray(v) && v.every((i) => Number.isInteger(i) && i >= 0 && i < 26);
  const letters = (ixs) => Array.from(new Set(ixs)).sort((a, b) => a - b).map((i) => String.fromCharCode(97 + i)).join(',');
  const isPairs = (v) => Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && p[0] >= 0 && p[0] < 10 && Number.isInteger(p[1]) && p[1] >= 0 && p[1] < 26);
  const pairs = (v) => v.map((p) => p[0] + '.' + String.fromCharCode(97 + p[1])).join(',');

  // CMITimespan HHHH:MM:SS.SS. ponytail: clamps at 9999:59:59.99, the format's ceiling.
  function timespan(ms) {
    const cs = Math.min(Math.max(Math.round(ms / 10), 0), 3599999999);
    return pad(Math.floor(cs / 360000), 4) + ':' + pad(Math.floor(cs / 6000) % 60, 2) + ':' + ((cs % 6000) / 100).toFixed(2).padStart(5, '0');
  }
  // CMITime HH:MM:SS, local time of day.
  function clock(ms) {
    const d = new Date(ms);
    return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
  }

  // Runtime interaction record -> ordered [field, value] pairs in SCORM 1.2 vocabulary, or null when invalid.
  function interactionFields(rec, time) {
    if (!rec || !isId(rec.id)) return null;
    let resp, pats;
    if (rec.type === 'choice') {
      if (!isIxList(rec.response) || !isIxList(rec.correct) || !rec.correct.length) return null;
      // SCORM 1.2: a comma list in {} means every listed choice must be selected (multiple response).
      // anyOf (hotspot): each correct choice alone is a correct response, so one pattern per choice.
      const c = letters(rec.correct);
      resp = letters(rec.response); pats = rec.anyOf ? c.split(',') : [c.indexOf(',') >= 0 ? '{' + c + '}' : c];
    } else if (rec.type === 'sequencing') {
      // SCORM 1.2 sequencing: an ordered comma list of single characters (a,c,b); order matters, so no sorting.
      if (!isIxList(rec.response) || !rec.response.length || !isIxList(rec.correct) || !rec.correct.length) return null;
      const seq = (v) => v.map((i) => String.fromCharCode(97 + i)).join(',');
      resp = seq(rec.response); pats = [seq(rec.correct)];
    } else if (rec.type === 'true-false') {
      if (typeof rec.response !== 'boolean' || typeof rec.correct !== 'boolean') return null;
      resp = rec.response ? 't' : 'f'; pats = [rec.correct ? 't' : 'f'];
    } else if (rec.type === 'fill-in') {
      if (typeof rec.response !== 'string' || !Array.isArray(rec.correct) || !rec.correct.every((s) => typeof s === 'string')) return null;
      resp = str255(rec.response); pats = rec.correct.map(str255);
    } else if (rec.type === 'matching') {
      // SCORM 1.2 matching: comma list of source.target pairs; single-character ids, sources 0-9 and targets a-z.
      if (!isPairs(rec.response) || !isPairs(rec.correct) || !rec.correct.length) return null;
      resp = pairs(rec.response); pats = [pairs(rec.correct)];
    } else return null;
    if (rec.result !== 'correct' && rec.result !== 'wrong') return null;
    if (rec.weighting !== undefined && !(typeof rec.weighting === 'number' && isFinite(rec.weighting))) return null;
    if (rec.latencyMs !== undefined && !(typeof rec.latencyMs === 'number' && rec.latencyMs >= 0)) return null;
    if (rec.objective !== undefined && !isId(rec.objective)) return null;
    const out = [['id', rec.id]];
    if (rec.objective !== undefined) out.push(['objectives.0.id', rec.objective]);
    out.push(['time', clock(time)], ['type', rec.type]);
    pats.forEach((p, k) => out.push(['correct_responses.' + k + '.pattern', p]));
    if (rec.weighting !== undefined) out.push(['weighting', String(rec.weighting)]);
    out.push(['student_response', resp], ['result', rec.result]);
    if (rec.latencyMs !== undefined) out.push(['latency', timespan(rec.latencyMs)]);
    return out;
  }

  // SCORM 1.2 discovery: win and up to 7 parents, then the opener and its parents.
  function findApi(win) {
    function climb(w) {
      for (let i = 0; w && i <= MAX_DEPTH; i++) {
        try { if (w.API) return w.API; } catch (e) { /* cross-origin frame: keep climbing */ }
        if (w.parent === w) break;
        w = w.parent;
      }
      return null;
    }
    let api = climb(win);
    if (!api) { try { api = win.opener ? climb(win.opener) : null; } catch (e) { api = null; } }
    return api;
  }

  function createScormAdapter(opts) {
    const o = opts || {};
    const win = o.win || root;
    const mode = (o.tracking && o.tracking.status) || 'passed-incomplete';
    if (MODES.indexOf(mode) < 0) throw new TypeError('CFScorm: tracking.status must be one of ' + MODES.join(', ') + '; got ' + mode);
    if (typeof o.courseId !== 'string' || !o.courseId) throw new TypeError('CFScorm: courseId is required');
    const now = o.now || Date.now;
    const key = 'cf:' + o.courseId;
    const words = mode.split('-');
    const MAP = { passed: words[0], completed: words[0], failed: words[1], incomplete: 'incomplete' };

    let api = findApi(win);
    let started = false, done = false, initAt = 0, lmsStatus = '', nextIx = 0;
    // Saves commit every time: LMSs persist on Commit, so resume data must not wait (the vendor commits about twice per
    // session and can lose progress on a crash). session_time is written once, at exit; score rides on the next commit.
    const a = { found: !!api, warnings: [] };
    const warn = (w) => { a.warnings.push(w); };
    const live = () => !!api && started && !done;

    // Single choke point for LMS calls: a refused call or an LMS exception becomes a warning, never a throw.
    function lms(fn, el, v) {
      try {
        const r = fn === 'LMSGetValue' ? api.LMSGetValue(el) : fn === 'LMSSetValue' ? api.LMSSetValue(el, String(v)) : api[fn]('');
        if (fn === 'LMSGetValue' || String(r) === 'true') return r;
        warn({ call: fn, element: el, code: String(api.LMSGetLastError()) });
      } catch (e) {
        warn({ call: fn, element: el, code: 'exception', message: String((e && e.message) || e) });
      }
      return null;
    }
    // localStorage get (v undefined) or set; storage can be missing or blocked.
    function store(v) {
      try {
        if (v === undefined) return win.localStorage.getItem(key);
        win.localStorage.setItem(key, v);
        return true;
      } catch (e) {
        warn({ call: 'localStorage', code: 'exception', message: String((e && e.message) || e) });
        return null;
      }
    }
    function parse(s, from) {
      if (!s) return null;
      try { return JSON.parse(s); } catch (e) { warn({ call: from, code: 'bad-json' }); return null; }
    }
    const sessionTime = () => lms('LMSSetValue', 'cmi.core.session_time', timespan(now() - initAt));

    a.init = function () {
      if (started) return null;
      started = true;
      initAt = now();
      if (api && lms('LMSInitialize') === null) { api = null; a.found = false; }
      if (!api) return parse(store(), 'localStorage');
      // pagehide only: beforeunload can be canceled, and finishing then would end reporting for a course still running.
      // ponytail: a page restored from the back/forward cache stays finished; re-initialize on pageshow if an LMS needs it.
      if (typeof win.addEventListener === 'function') win.addEventListener('pagehide', function () { a.exit(); });
      nextIx = parseInt(lms('LMSGetValue', 'cmi.interactions._count'), 10) || 0;
      lmsStatus = String(lms('LMSGetValue', 'cmi.core.lesson_status') || '');
      const fresh = lmsStatus === '' || lmsStatus === 'not attempted';
      if (fresh) { lmsStatus = 'incomplete'; lms('LMSSetValue', 'cmi.core.lesson_status', lmsStatus); }
      if (TERMINAL.indexOf(lmsStatus) < 0) lms('LMSSetValue', 'cmi.core.exit', 'suspend');
      const snap = parse(lms('LMSGetValue', 'cmi.suspend_data'), 'cmi.suspend_data');
      if (fresh) lms('LMSCommit');
      return snap;
    };

    a.status = function (s) {
      if (typeof s !== 'string' || !Object.prototype.hasOwnProperty.call(MAP, s)) { warn({ call: 'status', code: 'bad-status', value: s }); return; }
      if (!live()) return;
      lmsStatus = MAP[s];
      lms('LMSSetValue', 'cmi.core.lesson_status', lmsStatus);
      lms('LMSCommit');
    };

    a.score = function (sc) {
      const raw = sc && sc.raw;
      const min = sc && sc.min !== undefined ? sc.min : 0;
      const max = sc && sc.max !== undefined ? sc.max : 100;
      if (!pct(raw) || !pct(min) || !pct(max) || min > max) { warn({ call: 'score', code: 'bad-score', value: sc }); return; }
      if (!live()) return;
      lms('LMSSetValue', 'cmi.core.score.raw', dec2(raw));
      lms('LMSSetValue', 'cmi.core.score.min', dec2(min));
      lms('LMSSetValue', 'cmi.core.score.max', dec2(max)); // committed with the next status change, save or exit
    };

    a.interaction = function (rec) {
      const fields = interactionFields(rec, now());
      if (!fields) { warn({ call: 'interaction', code: 'bad-interaction', id: rec && rec.id }); return; }
      if (!live()) return;
      const prefix = 'cmi.interactions.' + nextIx++ + '.';
      fields.forEach((f) => lms('LMSSetValue', prefix + f[0], f[1]));
    };

    a.save = function (snapshot) {
      let json;
      try { json = JSON.stringify(snapshot); } catch (e) { json = undefined; }
      if (typeof json !== 'string') { warn({ call: 'save', code: 'bad-snapshot' }); return false; }
      if (!api) return store(json) === true;
      // Never truncate: the LMS keeps the last good value and the runtime gets false.
      if (json.length > SUSPEND_MAX) { warn({ call: 'save', code: 'suspend-too-long', length: json.length }); return false; }
      if (!live()) return false;
      const ok = lms('LMSSetValue', 'cmi.suspend_data', json) !== null;
      return lms('LMSCommit') !== null && ok;
    };

    a.exit = function () {
      if (!live()) return;
      if (typeof o.snapshot === 'function') { try { a.save(o.snapshot()); } catch (e) { warn({ call: 'exit', code: 'snapshot', message: String((e && e.message) || e) }); } }
      done = true;
      sessionTime();
      lms('LMSSetValue', 'cmi.core.exit', TERMINAL.indexOf(lmsStatus) >= 0 ? '' : 'suspend');
      lms('LMSCommit');
      lms('LMSFinish');
    };

    return a;
  }

  root.CFScorm = { createScormAdapter: createScormAdapter };
})(typeof window !== 'undefined' ? window : globalThis);
