// Deterministic learner runtime: a pure state machine (no DOM, no wall clock) driven by events and a virtual clock.
// Semantics follow observed Storyline behavior.
import { normalize, INTERACTIVE } from '../schema/index.js';
import { createLessonRuntime } from './lessons.js';
import { replaceRichVariables } from '../schema/rich.js';

const MAX_DEPTH = 32;
const LEARNER_EVENTS = new Set(['click', 'key', 'hoverEnter', 'hoverLeave']); // during Review Quiz only these fire triggers
const MAX_TICK = 24 * 3600 * 1000;
const ANSWER_EVENTS = new Set(['choose', 'point', 'drop', 'match', 'order', 'submit']); // ignored while reviewing
const BASE = '#base';
const JUMPED = Symbol('jumped'); // exec() result of a jump action // clock key of the base timeline; '#' cannot occur in ids, so layers never collide
const own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : undefined);
/** Percent with 2 decimals, truncated like the vendor (66.666 -> 66.66) but immune to float noise (29/50 -> 58). */
export const percent = (earned, possible) => (possible ? Math.trunc((earned * 10000) / possible + 1e-7) / 100 : 0);
// Slider/dial range (same rule as schema rangeOf; the publish bundle allows only the one import line above).
const rangeOf = (o) => ({ min: o.min ?? 0, max: o.max ?? (o.type === 'dial' ? 12 : 10), step: o.step ?? 1 });
const isRange = (o) => o.type === 'slider' || o.type === 'dial';
/* * Snap to the nearest min + n*step, then clamp to [min, max] (drags snap to the nearest step). */
function snapValue(o, value) {
  const { min, max, step } = rangeOf(o);
  const v = Number(value);
  if (!Number.isFinite(v)) return min;
  return Number(Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step)).toFixed(10));
}

export function createRuntime(docIn, opts = {}) {
  if (docIn?.mode === 'lessons') return createLessonRuntime(docIn, opts);
  const { lms = null, rng = Math.random, startAt = null } = opts; // startAt: the editor's preview opens where the author works
  const doc = normalize(docIn);
  const order = doc.scenes.flatMap((sc) => sc.slides);
  const resultSlides = new Set(doc.quizzes.map((q) => q.results).filter(Boolean));
  const slideById = new Map(doc.slides.map((s) => [s.id, s]));
  const varDefs = new Map(doc.variables.map((v) => [v.name, v]));
  // A quiz lists question slides and draw slides; a draw slide stands for the slides drawn there.
  const quizOf = (slideId) => doc.quizzes.filter((q) => q.questions.some((x) => x === slideId || drawSet(x)?.includes(slideId)));
  const trace = [];
  const log = (s) => trace.push(s);

  const S = {
    slide: null, layers: [], obj: {}, clock: {}, ended: {}, paused: {}, saved: {},
    vars: Object.fromEntries(doc.variables.map((v) => [v.name, v.initial ?? { number: 0, boolean: false, text: '' }[v.type]])),
    history: [], viewed: [], q: {}, quiz: {}, feedback: null, status: 'incomplete', reported: null, focus: null, finished: false,
    draws: {}, // draw slide id -> the bank slide ids drawn there
    review: null, // {quiz, slides, results} while the learner reviews a submitted quiz
    scoreClosed: false, scoreOwner: null, manualComplete: false, // LMS reporting, separate from visible quiz grades
  };
  let navPending = null; // {target, back} entered once the current dispatch unwinds
  let depth = 0;
  let active = 0; // >0 while a dispatch is running
  let slideMs = 0; // time on the current slide; unlike the base clock it does not stop at the slide's duration (latency)

  // ---------- helpers ----------
  const slide = () => slideById.get(S.slide);
  const layerDef = (id) => slide()?.layers.find((l) => l.id === id);
  // Per-slide object list and id index, built once: a slide's objects never change during a run, and view() looks up
  // every object (a rebuilt list per lookup made it O(n²)). Reversed so a duplicate id resolves to the first, like find().
  const defsCache = new WeakMap();
  const defsOf = (s) => {
    let d = defsCache.get(s);
    if (!d) { const list = [...s.objects.map((o) => [o, null]), ...s.layers.flatMap((l) => l.objects.map((o) => [o, l.id]))]; d = { list, byId: new Map(list.map((x) => [x[0].id, x]).reverse()) }; defsCache.set(s, d); }
    return d;
  };
  const objDefs = (s = slide()) => defsOf(s).list;
  const objDef = (id) => defsOf(slide()).byId.get(id);
  const objState = (id) => own(S.obj, id)?.state;
  const initObjects = (s) => Object.fromEntries(objDefs(s).map(([o]) => [o.id, { state: o.hidden ? 'hidden' : o.initialState }]));
  const timeVisible = (o, layerId) => { const t = own(S.clock, layerId ?? BASE) ?? 0; return t >= o.start && (o.end === null || t < o.end); };
  const visible = (id) => {
    const hit = objDef(id); if (!hit) return false;
    const [o, layerId] = hit;
    if (objState(id) === 'hidden' || own(o.states || {}, objState(id))?.hidden) return false;
    if (layerId && !S.layers.includes(layerId)) return false;
    if (!layerId && S.layers.some((l) => layerDef(l)?.hideBaseObjects)) return false;
    return timeVisible(o, layerId);
  };
  const getVar = (name) => own(S.vars, name);
  const interp = (text) => (text || '').replace(/%([A-Za-z_][A-Za-z0-9_.-]*)%/g, (m, n) => (getVar(n) === undefined ? m : String(getVar(n))));
  const hasInteractive = (s) => !!s.question || objDefs(s).some(([o]) => INTERACTIVE.has(o.type));
  // A question slide offers only Submit until it is answered (vendor player;).
  const unanswered = () => { if (S.review) return false; const s = slide(); const qs = s?.question ? own(S.q, S.slide) : null; return !!(qs && !qs.result); };
  // Visible layers in document order (trigger order follows the slide's layer list, not show order).
  const visibleLayers = () => (slide()?.layers || []).filter((l) => S.layers.includes(l.id));

  // ---------- question draws ----------
  const bankById = new Map(doc.banks.map((b) => [b.id, b]));
  const inBank = new Set(doc.banks.flatMap((b) => b.slides));
  const drawSet = (id) => own(S.draws, id);
  /** The learner flow: the slide order with each drawn draw replaced by its drawn slides (an undrawn draw is one entry). */
  const flow = () => order.flatMap((id) => drawSet(id) ?? [id]);
  /* * Pick a draw's set once. Vendor rule: each slot takes item floor(rng * remaining) of the remaining
   *  eligible slides in bank order. Ours: `always` slides come first; a slide drawn by another draw is not eligible. */
  function drawFor(id) {
    if (drawSet(id)) return drawSet(id);
    const w = slideById.get(id).draw;
    const taken = new Set(Object.entries(S.draws).flatMap(([k, v]) => (k === id ? [] : v)));
    const pool = (bankById.get(w.bank)?.slides || []).filter((x) => !taken.has(x) && !w.never.includes(x));
    const rest = pool.filter((x) => !w.always.includes(x));
    let set = pool.filter((x) => w.always.includes(x));
    for (let n = (w.count || pool.length) - set.length; n > 0 && rest.length; n--) set.push(rest.splice(Math.floor(rng() * rest.length), 1)[0]);
    if (!w.shuffle) set = pool.filter((x) => set.includes(x)); // bank order (I)
    S.draws[id] = set;
    log(`draw ${id} ${set.join(',')}`);
    return set;
  }
  /** Drop history entries for bank slides that are no longer drawn (a retry re-draws; review 005 #2). */
  function pruneHistory() { const f = new Set(flow()); S.history = S.history.filter((x) => !inBank.has(x) || f.has(x)); }
  /** Where navigation to `id` lands: a draw slide stands for its first drawn slide (drawn now if needed); an empty draw
   *  for the slide after it. */
  function land(id) {
    if (!slideById.get(id)?.draw) return id;
    const set = drawFor(id);
    return set.length ? set[0] : land(order[order.indexOf(id) + 1]);
  }

  function evalClause(c) {
    if (c.target !== undefined) { const st = objState(c.target); return c.is === false ? st !== c.state : st === c.state; }
    const a = getVar(c.var);
    const b = c.otherVar !== undefined ? getVar(c.otherVar) : c.value;
    switch (c.op) {
      case '==': return a === b || (typeof a === 'number' && Number(b) === a);
      case '!=': return !(a === b || (typeof a === 'number' && Number(b) === a));
      case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
      case 'contains': return String(a).toLowerCase().includes(String(b).toLowerCase());
      case 'notContains': return !String(a).toLowerCase().includes(String(b).toLowerCase());
      default: return false;
    }
  }
  const evalCond = (cond) => !cond || (cond.all ? cond.all.every(evalClause) : (cond.any || []).some(evalClause));

  // ---------- trigger dispatch ----------
  const containers = () => [{ id: null, triggers: slide().triggers }, ...visibleLayers().map((l) => ({ id: l.id, triggers: l.triggers }))];
  // Key presses go to the topmost visible layer first, then lower layers, then the slide; nothing below a modal
  // layer hears them.
  const keyContainers = () => {
    const out = [];
    for (const l of [...visibleLayers()].reverse()) { out.push({ id: l.id, triggers: l.triggers }); if (l.modal) return out; }
    return [...out, { id: null, triggers: slide().triggers }];
  };
  const matches = (on, ev) => on.event === ev.event
    && (on.target === undefined || on.target === ev.target) && (on.var === undefined || on.var === ev.var)
    && (on.state === undefined || on.state === ev.state) && (on.key === undefined || on.key.toLowerCase() === String(ev.key).toLowerCase())
    && (on.ms === undefined || on.ms === ev.ms);

  /** Run all triggers matching `ev` in the given containers (default: slide + visible layers). Returns number fired. */
  function fire(ev, only) {
    if (S.review && !LEARNER_EVENTS.has(ev.event)) return 0; // review is read-only: only what the learner does fires (Codex review 007 #4)
    if (depth >= MAX_DEPTH) { log(`warn depth limit at ${ev.event}`); return 0; }
    depth++;
    let n = 0;
    try {
      for (const c of only || containers()) {
        if (c.id !== null && !S.layers.includes(c.id)) continue; // a handler may have hidden this layer meanwhile
        for (const t of [...c.triggers]) {
          if (navPending || S.finished) return n;
          if (t.enabled === false || !matches(t.on, ev)) continue;
          n++;
          log(`fire ${t.id}`);
          const acts = evalCond(t.if) ? t.do : (t.else || []);
          for (let i = 0; i < acts.length; i++) {
            if (navPending || S.finished) { log(`cancel ${t.id}`); return n; }
            // A jump ends the rest of the list even when it goes nowhere.
            if (exec(acts[i], c.id) === JUMPED && !navPending) { log(`cancel ${t.id}`); return n; }
          }
        }
      }
    } finally { depth--; }
    return n;
  }

  function setVar(name, value) {
    const def = varDefs.get(name);
    if (def) {
      if (def.type === 'number') value = Number(value); else if (def.type === 'boolean') value = value === true || value === 'true'; else value = String(value);
      if (def.type === 'number' && !Number.isFinite(value)) { log(`warn ${name} not finite`); return; }
    }
    if (getVar(name) === value) return; // same-value assignment does not fire
    S.vars[name] = value;
    log(`var ${name}=${value}`);
    fire({ event: 'varChange', var: name });
  }

  function setState(id, state) {
    const rec = own(S.obj, id);
    if (!rec || rec.state === state) return;
    rec.state = state;
    log(`state ${id}=${state}`);
    fire({ event: 'stateChange', target: id, state });
  }

  function showLayer(id) {
    const l = layerDef(id);
    if (!l) return;
    if (S.layers.includes(id)) { // showing a visible layer restarts its timeline (FR-6.5)
      S.clock[id] = 0; S.ended[id] = false; S.paused[id] = false;
      log(`layer~ ${id}`);
    } else {
      if (l.hideOthers) for (const other of [...S.layers]) hideLayer(other);
      S.layers.push(id);
      S.clock[id] = 0; S.ended[id] = false; S.paused[id] = false;
      log(`layer+ ${id}`);
    }
    fire({ event: 'timelineStart' }, [{ id, triggers: l.triggers }]);
  }
  function hideLayer(id) {
    if (!S.layers.includes(id)) return;
    S.layers = S.layers.filter((x) => x !== id);
    log(`layer- ${id}`);
  }

  function exec(a, containerId) {
    switch (a.action) {
      case 'setVar': {
        const cur = getVar(a.var);
        const v = a.fromVar !== undefined ? getVar(a.fromVar) : a.value;
        const next = { set: () => v, add: () => cur + Number(v), sub: () => cur - Number(v), mul: () => cur * Number(v), div: () => (Number(v) === 0 ? cur : cur / Number(v)), toggle: () => !cur }[a.op]();
        return setVar(a.var, next);
      }
      case 'setState': return setState(a.target, a.state);
      case 'showLayer': return showLayer(a.layer);
      case 'hideLayer': return hideLayer(a.layer ?? containerId);
      case 'jump': requestNav(a.to); return JUMPED;
      case 'jumpScene': { const sc = doc.scenes.find((x) => x.id === a.to); if (sc && sc.slides[0]) requestNav(sc.slides[0]); else log(`warn no ${a.to} scene`); return JUMPED; }
      case 'submit': return submitQuestion();
      case 'submitQuiz': return submitQuiz(a.quiz);
      case 'resetQuiz': return resetQuiz(a.quiz);
      case 'reviewQuiz': return reviewQuiz(a.quiz);
      case 'completeCourse': return report('completed', true);
      case 'exitCourse': S.finished = true; log('exit'); lms?.exit?.(); return;
      case 'openUrl': log(`open ${a.url}`); return;
      case 'pauseTimeline': S.paused[containerId ?? BASE] = true; log(`pause ${containerId ?? 'base'}`); return;
      case 'resumeTimeline': S.paused[containerId ?? BASE] = false; log(`resume ${containerId ?? 'base'}`); return;
      case 'setFocus': S.focus = a.target; log(`focus ${a.target}`); return;
      // Media commands are trace lines the player carries out (like open/focus): the runtime has no media clock.
      case 'playMedia': case 'pauseMedia': case 'stopMedia': log(`media ${a.action.slice(0, -5)} ${a.target}`); return;
      default: log(`warn unknown action ${a.action}`);
    }
  }

  // ---------- navigation ----------
  function resolveTarget(to) {
    if (S.review && (to === 'next' || to === 'prev')) { // review walks its own list; past the end = back
      const r = S.review, i = r.slides.indexOf(S.slide);
      return to === 'next' ? r.slides[i + 1] ?? r.results : r.slides[i - 1] ?? null;
    }
    if (to === 'next') { const f = flow(); return land(f[f.indexOf(S.slide) + 1]) ?? null; }
    if (to === 'prev') return S.history[S.history.length - 1] ?? null;
    if (inBank.has(to) && !flow().includes(to)) { log(`warn ${to} not drawn`); return false; }
    return slideById.has(to) ? land(to) ?? null : null;
  }
  function requestNav(to) {
    const target = resolveTarget(to);
    if (!target) { if (target !== false) log(`warn no ${to} slide`); checkTracking(); save(); return; } // drawing may have changed the flow (review 005 #5)
    navPending = { target, back: to === 'prev' };
    log(`jump ${target}`);
  }
  function flushNav() {
    let guard = 0;
    while (navPending && guard++ < 100) { const { target, back } = navPending; navPending = null; enterSlide(target, back); }
  }

  const liveState = () => ({ obj: structuredClone(S.obj), layers: [...S.layers], clock: { ...S.clock }, ended: { ...S.ended } });
  function leaveSlide() {
    if (!S.slide) return;
    S.saved[S.slide] = liveState();
    log(`leave ${S.slide}`);
  }

  function enterSlide(id, back = false, forceResume = false) {
    const s = slideById.get(id);
    if (!s) return;
    if (S.slide) { leaveSlide(); if (!S.review) { if (back) S.history.pop(); else S.history.push(S.slide); } } // review keeps Prev history
    if (S.review && !S.review.slides.includes(id)) { log(`review end ${S.review.quiz}`); S.review = null; }
    const revisit = S.viewed.includes(id);
    const mode = forceResume ? 'resume' : s.revisit === 'auto' ? (hasInteractive(s) ? 'resume' : 'reset') : s.revisit;
    S.slide = id; S.feedback = null; slideMs = 0;
    const saved = own(S.saved, id);
    if ((revisit || forceResume) && mode === 'resume' && saved) {
      S.obj = { ...initObjects(s), ...structuredClone(saved.obj) }; S.layers = saved.layers.filter((l) => s.layers.some((x) => x.id === l)); // snapshots keep only changed objects
      S.clock = { [BASE]: own(saved.clock, BASE) ?? 0 }; S.ended = { [BASE]: own(saved.ended, BASE) ?? false }; S.paused = {};
    } else {
      S.obj = initObjects(s); S.layers = []; S.clock = { [BASE]: 0 }; S.ended = { [BASE]: false }; S.paused = {};
    }
    if (!revisit && !S.review) S.viewed.push(id); // review marks nothing viewed and creates no answer state
    if (s.question && !own(S.q, id) && !S.review) S.q[id] = newQuestionState(s.question);
    log(`enter ${id}`);
    // Resumed layers restart first, then the base timeline starts.
    for (const l of [...S.layers]) { S.clock[l] = 0; S.ended[l] = false; fire({ event: 'timelineStart' }, [{ id: l, triggers: layerDef(l).triggers }]); }
    fire({ event: 'timelineStart' }, [{ id: null, triggers: s.triggers }]);
    if (!S.review) checkTracking();
    save();
  }

  // ---------- questions & quizzes ----------
  function newQuestionState(q) {
    const ids = q.choices.map((c) => c.id);
    if (q.shuffle) for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const extra = q.type === 'hotspot' ? { point: null } : q.type === 'dragdrop' ? { placed: {} } : q.type === 'matching' ? { matched: {} } : {};
    return { order: ids, selected: [], text: '', attempts: 0, result: null, ...extra };
  }
  // ----- question types -----
  /** Index of the first hotspot area containing point p, or -1. */
  function hitIndex(q, p) {
    if (!p) return -1;
    return (q.areas || []).findIndex((a) => (a.shape === 'ellipse'
      ? ((p.x - a.x - a.w / 2) / (a.w / 2)) ** 2 + ((p.y - a.y - a.h / 2) / (a.h / 2)) ** 2 <= 1
      : p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h));
  }
  /* * Is there something to submit? (a hotspot needs a click.) */
  function answered(q, qs) {
    if (q.type === 'fill') return !!qs.text.trim();
    if (q.type === 'hotspot') return !!qs.point;
    if (q.type === 'dragdrop') return Object.keys(qs.placed).length > 0; // Submit needs a moved item
    if (q.type === 'matching') return q.rows.every((r) => own(qs.matched, r.id) !== undefined); // Q3: every row
    if (q.type === 'sequence') return true; // Q3: the drag sequence has no guard
    return qs.selected.length > 0;
  }
  /** response / responseLabels / correct of the runtime interaction record (indices; the publisher maps them to SCORM). */
  function answerRecord(q, qs) {
    if (q.type === 'fill') return { response: qs.text, responseLabels: [qs.text], correct: q.answers };
    if (q.type === 'hotspot') { // a miss is the extra index areas.length, like the vendor's choice_incorrect
      const i = hitIndex(q, qs.point);
      return { response: [i < 0 ? q.areas.length : i], responseLabels: [i < 0 ? 'outside' : q.areas[i].id], correct: q.areas.map((a, k) => (a.correct ? k : -1)).filter((k) => k >= 0) };
    }
    if (q.type === 'dragdrop') { // [item index, target index] pairs: placed items only, in item order
      const ti = (obj) => q.targets.findIndex((t) => t.object === obj);
      const response = q.items.map((it, k) => [k, ti(qs.placed[it.object])]).filter(([, t]) => t >= 0);
      return { response, responseLabels: response.map(([k, t]) => `${q.items[k].object}.${q.targets[t].object}`), correct: q.items.map((it, k) => [k, ti(it.target)]).filter(([, t]) => t >= 0) };
    }
    const ci = (id) => q.choices.findIndex((c) => c.id === id);
    if (q.type === 'matching') { // [row index, choice index] pairs in row order
      const response = q.rows.map((r, k) => [k, ci(own(qs.matched, r.id))]).filter(([, c]) => c >= 0);
      return { response, responseLabels: response.map(([k, c]) => `${q.rows[k].id}.${q.choices[c].id}`), correct: q.rows.map((r, k) => [k, ci(r.choice)]) };
    }
    if (q.type === 'sequence') return { response: qs.order.map(ci), responseLabels: [...qs.order], correct: q.choices.map((c, k) => k) };
    const choiceLabel = (id) => q.choices.find((c) => c.id === id)?.label ?? id;
    return { response: qs.selected.map(ci), responseLabels: qs.selected.map(choiceLabel), correct: q.choices.map((c, i) => (c.correct ? i : -1)).filter((i) => i >= 0) };
  }
  function placePoint(ev) {
    const q = slide().question; const qs = own(S.q, S.slide);
    if (q?.type !== 'hotspot' || !qs) { log('warn not a hotspot question'); return; }
    if (qs.result || S.feedback) return;
    const x = Number(ev.x), y = Number(ev.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { log('warn bad point'); return; }
    qs.point = { x: Math.min(doc.size.w, Math.max(0, x)), y: Math.min(doc.size.h, Math.max(0, y)) };
    log(`point ${qs.point.x},${qs.point.y}`);
  }
  /* * Freeform drag-and-drop (rules observed in). */
  function dropItem(ev) {
    const q = slide().question; const qs = own(S.q, S.slide);
    if (q?.type !== 'dragdrop' || !qs) { log('warn not a drag-and-drop question'); return; }
    if (qs.result || S.feedback) return; // items lock after the final result; the feedback dialog is modal
    if (!q.items.some((it) => it.object === ev.item)) { log(`warn ${ev.item} is not a drag item`); return; }
    if (!clickable(ev.item)) { log(`ignored drop ${ev.item}`); return; } // e.g. behind a modal layer
    const tgt = q.targets.find((t) => t.object === ev.target);
    delete qs.placed[ev.item]; // re-dropping moves an item to the end of a stack
    if (!tgt) { log(`drop ${ev.item} start`); return; } // outside every target: back to its start
    if ((tgt.capacity ?? 'one') === 'one') {
      for (const [k, v] of Object.entries(qs.placed)) if (v === tgt.object) { delete qs.placed[k]; log(`drop ${k} start`); } // the occupant goes home
    }
    qs.placed[ev.item] = tgt.object;
    log(`drop ${ev.item} ${tgt.object}`);
  }
  /* * Matching drop-down row (any choice in any row, duplicates allowed); choice null clears the row. */
  function matchRow(ev) {
    const q = slide().question; const qs = own(S.q, S.slide);
    if (q?.type !== 'matching' || !qs) { log('warn not a matching question'); return; }
    if (qs.result || S.feedback) return;
    if (!q.rows.some((r) => r.id === ev.row)) { log(`warn no row ${ev.row}`); return; }
    if (ev.choice === null || ev.choice === undefined || ev.choice === '') { delete qs.matched[ev.row]; log(`match ${ev.row} -`); return; }
    if (!q.choices.some((c) => c.id === ev.choice)) { log(`warn no choice ${ev.choice}`); return; }
    qs.matched[ev.row] = ev.choice;
    log(`match ${ev.row} ${ev.choice}`);
  }
  /* * Sequence: move one item to a position; the others shift (insertion, not swap:). */
  function moveItem(ev) {
    const q = slide().question; const qs = own(S.q, S.slide);
    if (q?.type !== 'sequence' || !qs) { log('warn not a sequence question'); return; }
    if (qs.result || S.feedback) return;
    const from = qs.order.indexOf(ev.choice);
    const to = Number(ev.index);
    if (from < 0 || !Number.isInteger(to)) { log(`warn bad order ${ev.choice} ${ev.index}`); return; }
    qs.order.splice(from, 1);
    qs.order.splice(Math.max(0, Math.min(to, qs.order.length)), 0, ev.choice);
    log(`order ${qs.order.join(',')}`);
  }
  /** Display positions of placed items: centred on a one-item target; stacked from the top-left of a many-item target. */
  function dragLayout(s, qs) {
    const pos = new Map();
    if (s.question?.type !== 'dragdrop' || !qs?.placed) return pos;
    const byId = new Map(s.objects.map((o) => [o.id, o]));
    for (const t of s.question.targets) {
      const tb = byId.get(t.object);
      let y = tb.y + 4;
      for (const [item, at] of Object.entries(qs.placed)) {
        if (at !== t.object) continue;
        const ib = byId.get(item);
        if ((t.capacity ?? 'one') === 'one') pos.set(item, { x: tb.x + (tb.w - ib.w) / 2, y: tb.y + (tb.h - ib.h) / 2 });
        else { pos.set(item, { x: tb.x + 4, y }); y += ib.h + 4; }
        for (const id of ib.members || []) {
          const member = byId.get(id), at = pos.get(item);
          if (member) pos.set(id, { x: member.x + at.x - ib.x, y: member.y + at.y - ib.y });
        }
      }
    }
    return pos;
  }
  function choose(choiceId) {
    const s = slide(); const qs = own(S.q, S.slide);
    if (!s?.question || !qs || qs.result || S.feedback) return;
    if (!s.question.choices.some((c) => c.id === choiceId)) { log(`warn no choice ${choiceId}`); return; }
    if (s.question.type === 'mr') qs.selected = qs.selected.includes(choiceId) ? qs.selected.filter((x) => x !== choiceId) : [...qs.selected, choiceId];
    else qs.selected = [choiceId];
    log(`choose ${choiceId}`);
  }
  function isCorrect(q, qs) {
    if (q.type === 'hotspot') return q.areas[hitIndex(q, qs.point)]?.correct === true;
    if (q.type === 'dragdrop') return q.items.every((it) => (own(qs.placed, it.object) ?? null) === (it.target ?? null)); // partial = wrong
    if (q.type === 'matching') return q.rows.every((r) => own(qs.matched, r.id) === r.choice);
    if (q.type === 'sequence') return qs.order.join('\n') === q.choices.map((c) => c.id).join('\n');
    if (q.type === 'fill') {
      const norm = (x) => (q.caseSensitive ? x.trim() : x.trim().toLowerCase());
      return q.answers.some((a) => norm(a) === norm(qs.text));
    }
    const want = q.choices.filter((c) => c.correct).map((c) => c.id).sort().join(',');
    return [...qs.selected].sort().join(',') === want;
  }
  function submitQuestion() {
    const s = slide(); const q = s?.question; const qs = own(S.q, S.slide);
    if (!q || !qs || qs.result || S.feedback || S.review) return; // feedback dialog is modal; review is read-only
    if (!answered(q, qs)) { log('warn nothing to submit'); return; }
    qs.attempts++;
    const ok = isCorrect(q, qs);
    const final = ok || (q.attempts > 0 && qs.attempts >= q.attempts); // attempts 0 = unlimited
    S.feedback = ok ? 'correct' : final ? 'incorrect' : 'tryAgain';
    log(`submit ${S.slide} ${S.feedback}`);
    if (final) qs.result = ok ? 'correct' : 'incorrect';
    // Every submit is reported, a try-again included; the score only when it
    // changes. Order: score, then interaction.
    for (const quiz of quizOf(S.slide)) {
      const sc = score(quiz);
      const st = quizState(quiz.id);
      reportScore(quiz.id, sc.percent);
      lms?.interaction?.({
        id: `${quiz.id}_${S.slide}_${st.attempt}_${qs.attempts - 1}`, type: q.type, quiz: quiz.id, question: S.slide, prompt: q.prompt,
        ...answerRecord(q, qs), result: ok ? 'correct' : 'incorrect', weighting: q.points,
        latencyMs: Math.round(slideMs), objective: quiz.id, // the vendor reports both
      });
    }
    save();
  }
  function quizState(id) { if (!own(S.quiz, id)) S.quiz[id] = { attempt: 0, submitted: false, passed: false, percent: 0 }; return S.quiz[id]; }
  function score(quiz) {
    let earned = 0, possible = 0;
    for (const sid of quiz.questions.flatMap((x) => drawSet(x) ?? [x])) { // drawn questions only; an undrawn draw counts nothing
      const q = slideById.get(sid)?.question; if (!q) continue;
      possible += q.points;
      if (own(S.q, sid)?.result === 'correct') earned += q.points;
    }
    const p = percent(earned, possible);
    return { earned, possible, percent: quiz.round ? Math.round(p) : p };
  }
  function setQuizVars(quiz, sc, passed) {
    setVar(`${quiz.id}.scorePercent`, sc.percent); setVar(`${quiz.id}.scorePoints`, sc.earned);
    setVar(`${quiz.id}.passPercent`, quiz.passPercent); setVar(`${quiz.id}.passPoints`, Math.ceil((quiz.passPercent / 100) * sc.possible - 1e-9));
    setVar(`${quiz.id}.passed`, passed);
  }
  function submitQuiz(id) {
    const quiz = doc.quizzes.find((q) => q.id === id); if (!quiz) return;
    for (const x of quiz.questions) if (slideById.get(x)?.draw) drawFor(x); // skipped draws still count, unanswered (ours; review 005 #1)
    const st = quizState(id); const sc = score(quiz);
    st.submitted = true; st.percent = sc.percent; st.passed = sc.percent >= quiz.passPercent;
    setQuizVars(quiz, sc, st.passed);
    log(`quiz ${id} submit ${sc.percent} ${st.passed ? 'passed' : 'failed'}`);
    // The vendor sends only the status from the results slide (no score.raw there); the score goes out only
    // when it changed, e.g. a draw skipped through the menu now counts (review 005 #1).
    reportScore(id, sc.percent);
    checkTracking();
    save();
  }
  function resetQuiz(id) {
    const quiz = doc.quizzes.find((q) => q.id === id); if (!quiz) return;
    const st = quizState(id);
    S.review = null; // a new attempt is never a review
    for (const sid of quiz.questions.flatMap((x) => drawSet(x) ?? [x])) { delete S.q[sid]; delete S.saved[sid]; } // menu viewed marks stay
    for (const sid of quiz.questions) delete S.draws[sid]; // the next entry draws again (doc-findings: retry re-draws)
    pruneHistory();
    st.attempt++; st.submitted = false; st.passed = false; st.percent = 0;
    setQuizVars(quiz, { percent: 0, earned: 0, possible: score(quiz).possible }, false);
    log(`quiz ${id} reset attempt ${st.attempt}`);
    // Equal numeric scores from another quiz do not transfer ownership.
    const unlock = S.scoreOwner === id;
    if (unlock) S.scoreClosed = false;
    if (S.reported !== 'completed' || unlock) { S.reported = null; report('incomplete'); }
    if (quiz.questions[0]) requestNav(quiz.questions[0]);
  }

  // ----- quiz review: the submitted attempt, read-only, then back to where review started -----
  /** The quiz's question slides of this attempt in flow order (a draw stands for its drawn slides). */
  function attemptSlides(quiz) {
    const mine = new Set(quiz.questions.flatMap((x) => drawSet(x) ?? [x]));
    return flow().filter((sid) => mine.has(sid) && slideById.get(sid).question);
  }
  function reviewQuiz(id) {
    const quiz = doc.quizzes.find((q) => q.id === id);
    if (!quiz) { log(`warn no ${id} quiz`); return; }
    if (!own(S.quiz, quiz.id)?.submitted) { log(`warn quiz ${quiz.id} not submitted`); return; }
    const slides = attemptSlides(quiz);
    if (!slides.length) { log(`warn quiz ${quiz.id} has no questions to review`); return; }
    S.review = { quiz: quiz.id, slides, results: S.review?.results ?? S.slide };
    log(`review ${quiz.id} ${slides.join(',')}`);
    requestNav(slides[0]);
  }
  /** What the review shows for one question: result, the learner's answer and the correct one, as plain text. */
  function reviewOf(q, qs) {
    const label = (cid) => q.choices.find((c) => c.id === cid)?.label ?? cid;
    const name = (oid) => { const o = slide().objects.find((x) => x.id === oid); return interp(o?.text) || o?.alt || oid; };
    const pick = (ids, keep) => ids.filter(keep).map(label);
    const [yours, answer] = q.type === 'fill' ? [qs.text.trim() ? [qs.text] : [], q.answers]
      : q.type === 'hotspot' ? [qs.point ? [isCorrect(q, qs) ? 'inside the correct area' : 'outside the correct area'] : [], ['the outlined area']]
      : q.type === 'dragdrop' ? [q.items.map((it) => `${name(it.object)}: ${own(qs.placed, it.object) ? name(qs.placed[it.object]) : 'not placed'}`), q.items.map((it) => `${name(it.object)}: ${it.target ? name(it.target) : 'not placed'}`)]
      : q.type === 'matching' ? [q.rows.map((r) => `${interp(r.label)}: ${own(qs.matched, r.id) ? label(qs.matched[r.id]) : 'no answer'}`), q.rows.map((r) => `${interp(r.label)}: ${label(r.choice)}`)]
      : q.type === 'sequence' ? [qs.order.map(label), q.choices.map((c) => c.label)]
      : [pick(qs.order, (cid) => qs.selected.includes(cid)), pick(qs.order, (cid) => q.choices.find((c) => c.id === cid)?.correct)];
    const answered = qs.attempts > 0;
    return { correct: qs.result === 'correct', answered, yours: answered ? yours : [], answer };
  }

  // ---------- tracking ----------
  function reportScore(quiz, raw) {
    if (S.scoreClosed || S.sentRaw === raw) return;
    S.sentRaw = raw; S.scoreOwner = quiz;
    log(`score ${quiz} ${raw}`);
    lms?.score?.({ raw, min: 0, max: 100 });
  }
  const terminal = status => status === 'passed' || status === 'completed' || status === 'failed' && doc.tracking.status.endsWith('-failed');
  function report(status, force = false) {
    if (force) S.manualComplete = true;
    if (!force && S.reported === status) return;
    S.status = status; S.reported = status;
    if (terminal(status)) {
      if (S.scoreClosed) return;
      S.scoreClosed = true;
    }
    log(`lms status ${status}`);
    lms?.status?.(status);
  }
  function checkTracking(replayScore = false) {
    if (S.manualComplete) return report('completed');
    for (const c of doc.tracking.complete) {
      const f = flow(); // slides of the learner flow (drawn slides, not the draw), ours
      if (c.slidesViewedCount !== undefined && new Set(f.filter((id) => S.viewed.includes(id))).size >= c.slidesViewedCount) return report('completed');
      if (c.slidesViewed !== undefined && f.length && (f.filter((id) => S.viewed.includes(id)).length / f.length) * 100 >= c.slidesViewed) return report('completed');
      if (c.quiz && own(S.quiz, c.quiz)?.submitted) {
        if (replayScore) reportScore(c.quiz, score(doc.quizzes.find(q => q.id === c.quiz)).percent);
        return report(S.quiz[c.quiz].passed ? 'passed' : 'failed');
      }
    }
  }
  const save = () => lms?.save?.(snapshot());

  // ---------- timeline ----------
  function tick(ms) {
    let remaining = ms;
    while (remaining > 0 && !S.finished && S.slide) {
      // Step to the next interesting time (a cue or an end) so triggers fire in time order.
      const step = Math.min(remaining, nextBoundary());
      slideMs += step; // before advance: a jump in this step re-enters and zeroes it
      advance(step);
      remaining -= step;
      flushNav();
    }
  }
  function running() {
    const s = slide(); const out = [];
    const basePaused = own(S.paused, BASE) || S.layers.some((l) => layerDef(l)?.pauseBase);
    if (!basePaused && !own(S.ended, BASE)) out.push({ id: null, key: BASE, dur: s.duration, triggers: s.triggers });
    for (const l of visibleLayers()) if (!own(S.paused, l.id) && !own(S.ended, l.id)) out.push({ id: l.id, key: l.id, dur: l.duration, triggers: l.triggers });
    return out;
  }
  function nextBoundary() {
    let best = Infinity;
    for (const c of running()) {
      const t = own(S.clock, c.key) ?? 0;
      const marks = [c.dur, ...c.triggers.filter((x) => x.on.event === 'timeAt').map((x) => x.on.ms)];
      for (const m of marks) if (m > t && m - t < best) best = m - t;
    }
    return best === Infinity ? Number.MAX_SAFE_INTEGER : best; // exact boundaries: results do not depend on tick sizes
  }
  function advance(step) {
    for (const c of running()) {
      if (c.id !== null && !S.layers.includes(c.id)) continue; // hidden by an earlier handler in this step
      const from = own(S.clock, c.key) ?? 0; const to = Math.min(from + step, c.dur);
      S.clock[c.key] = to;
      const cues = c.triggers.filter((x) => x.on.event === 'timeAt' && x.on.ms > from && x.on.ms <= to).map((x) => x.on.ms);
      for (const ms of [...new Set(cues)].sort((a, b) => a - b)) fire({ event: 'timeAt', ms }, [{ id: c.id, triggers: c.triggers }]);
      if (navPending) return;
      if (to >= c.dur && !own(S.ended, c.key)) {
        S.ended[c.key] = true;
        log(`end ${c.id ?? S.slide}`);
        fire({ event: 'timelineEnd' }, [{ id: c.id, triggers: c.triggers }]);
        if (c.id === null && slide().advance === 'auto' && !navPending) requestNav('next');
        if (c.id !== null && layerDef(c.id)?.hideOnEnd) hideLayer(c.id);
        if (navPending) return;
      }
    }
  }

  // ---------- public dispatch ----------
  function clickable(id) {
    if (!visible(id)) return false;
    const st = objState(id);
    if (st === 'disabled' || st === 'hidden') return false;
    if (S.feedback) return false; // feedback dialog is modal
    const modal = [...visibleLayers()].reverse().find((l) => l.modal);
    if (modal && objDef(id)[1] !== modal.id) return false;
    return true;
  }

  function dispatch(ev) {
    if (!ev || typeof ev.type !== 'string') throw new TypeError('event must be {type, ...}');
    if (S.finished && ev.type !== 'start') { log('warn course exited'); return api; }
    if (!S.slide && ev.type !== 'start') { log(`warn ${ev.type} before start`); return api; } // fuzz: no slide yet
    if (S.review && (ANSWER_EVENTS.has(ev.type) || (ev.type === 'input' && (ev.answer !== undefined || !ev.target)))) { log(`ignored ${ev.type} in review`); return api; } // read-only
    active++;
    try {
      switch (ev.type) {
        case 'start': start(ev); break;
        case 'click': {
          if (!clickable(ev.target)) { log(`ignored click ${ev.target}`); break; }
          if (own(objDef(ev.target)[0].states || {}, 'visited') && objState(ev.target) === 'normal') setState(ev.target, 'visited');
          // A press on a video without native controls toggles playback (onpress -> media_toggle).
          if (objDef(ev.target)[0].type === 'video' && objDef(ev.target)[0].controls === false) log(`media toggle ${ev.target}`);
          fire({ event: 'click', target: ev.target });
          break;
        }
        case 'hoverEnter': case 'hoverLeave': if (clickable(ev.target)) fire({ event: ev.type, target: ev.target }); break;
        case 'key': if (!S.feedback) fire({ event: 'key', key: ev.key }, keyContainers()); break;
        case 'next':
          if (S.feedback) { cont(); break; }
          if (S.review) { requestNav('next'); break; } // the player owns review navigation: no playerNext triggers
          if (unanswered()) { log('warn answer the question first'); break; } // vendor: Submit only until answered
          if (!fire({ event: 'playerNext' })) requestNav('next');
          break;
        case 'prev': if (S.feedback) break; if (S.review) { requestNav('prev'); break; } if (unanswered()) { log('warn answer the question first'); break; } if (!fire({ event: 'playerPrev' })) requestNav('prev'); break;
        case 'menu': if (!doc.player.menu) { log('warn menu disabled'); break; } if (S.feedback) break; requestNav(ev.slide); break;
        case 'tick': {
          const ms = Number(ev.ms);
          if (!Number.isFinite(ms) || ms < 0) { log(`warn bad tick ${ev.ms}`); break; }
          tick(Math.min(ms, MAX_TICK));
          break;
        }
        case 'choose': choose(ev.choice); break;
        case 'input': {
          if (S.feedback) break;
          const qs = own(S.q, S.slide);
          if (ev.answer !== undefined || (!ev.target && qs)) { if (qs && !qs.result) { qs.text = String(ev.text ?? '').slice(0, 1000); log('input answer'); } break; }
          const o = objDef(ev.target)?.[0];
          if (!o || o.type !== 'input') { log(`warn ${ev.target} is not an input`); break; }
          if (o.var) setVar(o.var, String(ev.text ?? '').slice(0, 1000));
          break;
        }
        case 'slide': { // slider or dial moved: {target, value}
          const o = objDef(ev.target)?.[0];
          if (!o || !isRange(o)) { log(`warn ${ev.target} is not a slider or dial`); break; }
          if (!clickable(ev.target)) { log(`ignored slide ${ev.target}`); break; }
          if (!Number.isFinite(Number(ev.value))) { log(`warn bad value ${ev.value}`); break; }
          setVar(o.var, snapValue(o, ev.value));
          break;
        }
        case 'point': placePoint(ev); break; // hotspot question: {x, y} in slide coordinates
        case 'drop': dropItem(ev); break; // drag-and-drop question: {item, target|null}
        case 'match': matchRow(ev); break; // matching question: {row, choice|null}
        case 'order': moveItem(ev); break; // sequence question: {choice, index}
        case 'mediaEnd': { // the player reports a video/audio 'ended'
          const o = objDef(ev.target)?.[0];
          if (!o || (o.type !== 'video' && o.type !== 'audio')) { log(`warn ${ev.target} is not a video or audio object`); break; }
          log(`media ended ${ev.target}`);
          fire({ event: 'mediaEnd', target: ev.target });
          break;
        }
        case 'submit': submitQuestion(); break;
        case 'continue': cont(); break;
        case 'review': reviewQuiz(ev.quiz ?? doc.quizzes.find((q) => q.results === S.slide)?.id); break; // default: this results slide's quiz
        case 'exitReview': if (S.review) { const back = S.review.results; log(`review end ${S.review.quiz}`); S.review = null; requestNav(back); } else log('warn not reviewing'); break; // 007 #9: ends review even when back is a question
        default: log(`warn unknown event ${ev.type}`);
      }
    } finally { active--; }
    if (!active) flushNav();
    return api;
  }

  function cont() {
    const qs = own(S.q, S.slide);
    if (!S.feedback) return;
    const fb = S.feedback; S.feedback = null;
    log(`continue ${fb}`);
    if (fb === 'tryAgain') return; // Try Again only hides the feedback; the learner's answers stay
    requestNav('next');
  }

  function start({ resume } = {}) {
    const snap = lms?.init?.() ?? null;
    const policy = resume ?? doc.player.resume;
    if (snap && (policy === 'always' || policy === true) && restore(snap)) return;
    if (snap) report('incomplete'); // rejecting resume starts a new reporting attempt
    const first = land(startAt && order.includes(startAt) ? startAt : order[0]);
    if (!first) { log('warn course has no slides'); return; }
    log('start');
    enterSlide(first);
  }

  // ---------- snapshot / restore (resume) ----------
  // A snapshot keeps only what a resume needs (SCORM 1.2 caps cmi.suspend_data at 4096 characters):
  // saved states of slides that resume on revisit, and object entries that differ from the slide's initial state.
  const resumes = (s) => s.revisit === 'resume' || (s.revisit === 'auto' && hasInteractive(s));
  function compact(sid, st) {
    const init = initObjects(slideById.get(sid));
    const obj = {};
    for (const [k, v] of Object.entries(st.obj)) {
      if (JSON.stringify(v) === JSON.stringify(init[k])) continue;
      obj[k] = Object.keys(v).length === 1 && typeof v.state === 'string' ? v.state : v; // a state-only entry is just its name
    }
    const t = own(st.clock, BASE), e = own(st.ended, BASE); // short keys: o objects, l layers, t base clock, e base ended
    return { ...(Object.keys(obj).length ? { o: obj } : {}), ...(st.layers.length ? { l: [...st.layers] } : {}), ...(t ? { t } : {}), ...(e ? { e: 1 } : {}) };
  }
  const slideIx = new Map(order.map((id, i) => [id, i]));
  const allSlideIx = new Map(doc.slides.map((s, i) => [s.id, i]));
  const enc = (list) => list.map((id) => slideIx.get(id) ?? id); // slide ids as indexes into the slide order
  function snapshot() {
    const saved = Object.fromEntries(Object.entries(S.saved).filter(([sid]) => slideById.has(sid) && resumes(slideById.get(sid))).map(([sid, st]) => [sid, compact(sid, st)]));
    const bankSlides = (k) => bankById.get(slideById.get(k).draw.bank).slides;
    const dr = Object.entries(S.draws).map(([k, v]) => [k, v.map((x) => bankSlides(k).indexOf(x))]); // drawn sets as bank indexes
    const snap = {
      v: 1, slide: S.slide, current: S.slide ? compact(S.slide, liveState()) : null, feedback: S.feedback, history: enc(S.history), viewed: enc(S.viewed),
      vars: { ...S.vars }, saved, q: structuredClone(S.q), quiz: structuredClone(S.quiz), status: S.status, reported: S.reported,
      // CF resume policy: retain the reporting boundary of this attempt, including an absent score.
      rp: [S.scoreClosed, S.sentRaw ?? null, S.scoreOwner, S.manualComplete],
      ...(dr.length ? { dr: Object.fromEntries(dr) } : {}),
      ...(S.review ? { rv: { quiz: S.review.quiz, results: enc([S.review.results])[0] } } : {}), // the list is rebuilt on restore
    };
    // Large assessments use slide indexes and omit repeated question keys/selected IDs; v1 remains readable.
    if (JSON.stringify(snap).length > 4096) {
      snap.v = 2;
      snap.history = S.history.map(id => allSlideIx.get(id));
      snap.viewed = S.viewed.map(id => allSlideIx.get(id));
      snap.saved = Object.fromEntries(Object.entries(saved).map(([sid, state]) => [allSlideIx.get(sid), state]));
      if (S.review) snap.rv.results = allSlideIx.get(S.review.results);
      snap.q = Object.fromEntries(Object.entries(S.q).map(([sid, q]) => {
        const extra = { ...(q.text ? { t: q.text } : {}), ...(q.point ? { p: { ...q.point } } : {}),
          ...(Object.keys(q.placed ?? {}).length ? { d: { ...q.placed } } : {}), ...(Object.keys(q.matched ?? {}).length ? { m: { ...q.matched } } : {}) };
        // Choice order as one base-36 digit per choice ("" = authored order); id lists stay readable on restore.
        const ids = slideById.get(sid).question.choices.map((c) => c.id);
        const ord = ids.length > 36 ? [...q.order] : q.order.every((id, i) => id === ids[i]) ? '' : q.order.map((id) => ids.indexOf(id).toString(36)).join('');
        return [allSlideIx.get(sid), [ord, q.selected.map(id => q.order.indexOf(id)), q.attempts, q.result === 'correct' ? 1 : q.result === 'incorrect' ? 2 : 0,
          ...(Object.keys(extra).length ? [extra] : [])]];
      }));
    }
    return snap;
  }
  /** Drawn sets from an untrusted snapshot: draws of this course, bank slides by index, each slide in one set at most. */
  function restoreDraws(dr) {
    const out = {}, used = new Set();
    if (isObj(dr)) for (const [k, v] of Object.entries(dr)) {
      const w = order.includes(k) && slideById.get(k).draw, bank = w && bankById.get(w.bank);
      if (!bank || !Array.isArray(v)) continue;
      const set = v.map((x) => (Number.isInteger(x) ? bank.slides[x] : null)); // snapshots store bank indexes
      const pool = bank.slides.filter((x) => !w.never.includes(x) && !used.has(x));
      const always = w.always.filter((x) => pool.includes(x));
      const size = Math.min(w.count || pool.length, pool.length);
      // Only a set this draw could have drawn is kept (review 005 #4); anything else is drawn again on entry.
      if (set.length !== size || new Set(set).size !== set.length || !set.every((x) => pool.includes(x)) || !always.every((x) => set.includes(x))) continue;
      for (const x of set) used.add(x);
      out[k] = set;
    }
    return out;
  }
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  /* * answer state from an untrusted snapshot: a finite point inside the slide. */
  function restoreAnswer(def, qs) {
    if (def.type === 'hotspot') {
      const p = qs.point;
      const ok = isObj(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x <= doc.size.w && p.y <= doc.size.h;
      return { point: ok ? { x: p.x, y: p.y } : null };
    }
    if (def.type === 'dragdrop') { // keep item -> target entries that still exist; one-item targets keep their last item
      const placed = {};
      const items = new Set(def.items.map((it) => it.object));
      const cap = new Map(def.targets.map((t) => [t.object, t.capacity ?? 'one']));
      if (isObj(qs.placed)) for (const [k, v] of Object.entries(qs.placed)) {
        if (!items.has(k) || !cap.has(v)) continue;
        if (cap.get(v) === 'one') for (const [k2, v2] of Object.entries(placed)) if (v2 === v) delete placed[k2];
        placed[k] = v;
      }
      return { placed };
    }
    if (def.type === 'matching') {
      const rows = new Set(def.rows.map((r) => r.id)), choices = new Set(def.choices.map((c) => c.id));
      return { matched: Object.fromEntries(Object.entries(isObj(qs.matched) ? qs.matched : {}).filter(([r, c]) => rows.has(r) && choices.has(c))) };
    }
    return {};
  }
  const ids = (list, version) => (Array.isArray(list) ? list.map((x) => (Number.isInteger(x) ? version === 2 ? doc.slides[x]?.id : order[x] : x)).filter((x) => typeof x === 'string' && slideById.has(x)) : []);
  /** A saved slide state from an untrusted snapshot, expanded from its compact form; null if unusable. */
  const slideState = (st, sid) => {
    if (!isObj(st) || !slideById.has(sid)) return null;
    const obj = st.o ?? st.obj ?? {}, layers = st.l ?? st.layers ?? [], t = st.t ?? own(st.clock, BASE), e = st.e ?? own(st.ended, BASE);
    if (!isObj(obj) || !Array.isArray(layers)) return null;
    const clean = {};
    for (const [o] of objDefs(slideById.get(sid))) {
      const v = own(obj, o.id), state = typeof v === 'string' ? v : isObj(v) ? v.state : null;
      if (typeof state === 'string' && (['normal', 'hover', 'down', 'selected', 'visited', 'disabled', 'hidden'].includes(state) || own(o.states, state))) clean[o.id] = { state };
    }
    return {
      obj: clean,
      layers: layers.filter((l) => typeof l === 'string'), clock: { [BASE]: Number.isFinite(t) && t > 0 ? t : 0 }, ended: { [BASE]: !!e },
    };
  };
  /** Restore a snapshot from an untrusted store. Invalid parts are dropped; returns false if unusable. */
  function restore(snap) {
    if (!isObj(snap) || ![1, 2].includes(snap.v)) { log('warn resume data ignored'); return false; }
    const vars = { ...S.vars };
    if (isObj(snap.vars)) for (const [k, v] of Object.entries(snap.vars)) {
      const def = varDefs.get(k);
      const derived = /^([a-z][a-z0-9-]*)\.(scorePercent|scorePoints|passPercent|passPoints|passed)$/.exec(k);
      const type = def ? { number: 'number', boolean: 'boolean', text: 'string' }[def.type]
        : derived && doc.quizzes.some((q) => q.id === derived[1]) ? (derived[2] === 'passed' ? 'boolean' : 'number') : null;
      if (typeof v === type && (type !== 'number' || Number.isFinite(v))) vars[k] = v;
    }
    const q = {};
    if (isObj(snap.q)) for (const [key, raw] of Object.entries(snap.q)) {
      const sid = snap.v === 2 ? doc.slides[Number(key)]?.id : key;
      let qs = raw;
      if (snap.v === 2 && Array.isArray(raw)) {
        const choices = slideById.get(sid)?.question?.choices ?? [];
        const order = Array.isArray(raw[0]) ? raw[0] : raw[0] === '' ? choices.map((c) => c.id) : typeof raw[0] === 'string' ? [...raw[0]].map((d) => choices[parseInt(d, 36)]?.id) : [];
        const extra = isObj(raw[4]) ? raw[4] : {};
        qs = { order, selected: Array.isArray(raw[1]) ? raw[1].filter(i => Number.isInteger(i) && i >= 0 && i < order.length).map(i => order[i]) : [],
          attempts: raw[2], result: raw[3] === 1 ? 'correct' : raw[3] === 2 ? 'incorrect' : null, text: extra.t, point: extra.p, placed: extra.d, matched: extra.m };
      }
      const def = slideById.get(sid)?.question;
      if (!def || !isObj(qs)) continue;
      const valid = new Set(def.choices.map((c) => c.id));
      const ord = Array.isArray(qs.order) ? qs.order.filter((c) => valid.has(c)) : [];
      if (ord.length !== valid.size || new Set(ord).size !== valid.size) continue; // course changed since the snapshot: drop this answer state
      q[sid] = { order: ord, selected: Array.isArray(qs.selected) ? qs.selected.filter((c) => valid.has(c)) : [], text: typeof qs.text === 'string' ? qs.text : '', attempts: Number.isSafeInteger(qs.attempts) && qs.attempts >= 0 ? qs.attempts : 0, result: ['correct', 'incorrect'].includes(qs.result) ? qs.result : null, ...restoreAnswer(def, qs) };
    }
    const saved = {};
    if (isObj(snap.saved)) for (const [key, st] of Object.entries(snap.saved)) {
      const sid = snap.v === 2 ? doc.slides[Number(key)]?.id : key;
      const x = slideState(st, sid); if (slideById.has(sid) && x) saved[sid] = x;
    }
    Object.assign(S, {
      history: ids(snap.history, snap.v), viewed: ids(snap.viewed, snap.v), vars, saved, q, draws: restoreDraws(snap.dr),
      quiz: isObj(snap.quiz) ? Object.fromEntries(Object.entries(snap.quiz).filter(([k, v]) => doc.quizzes.some((x) => x.id === k) && isObj(v)).map(([k, v]) => [k, {
        attempt: Number.isSafeInteger(v.attempt) && v.attempt >= 0 ? v.attempt : 0, submitted: v.submitted === true,
        passed: v.passed === true, percent: Number.isFinite(v.percent) && v.percent >= 0 && v.percent <= 100 ? v.percent : 0,
      }])) : {},
      status: ['incomplete', 'completed', 'passed', 'failed'].includes(snap.status) ? snap.status : 'incomplete',
      reported: ['completed', 'passed', 'failed', 'incomplete'].includes(snap.reported) ? snap.reported : null, review: null,
    });
    const rp = snap.rp;
    const validReport = Array.isArray(rp) && typeof rp[0] === 'boolean' && typeof rp[3] === 'boolean'
      && (rp[1] === null && rp[2] === null || Number.isFinite(rp[1]) && rp[1] >= 0 && rp[1] <= 100 && doc.quizzes.some(q => q.id === rp[2]));
    S.scoreClosed = validReport ? rp[0] : false;
    S.sentRaw = validReport && rp[1] !== null ? rp[1] : undefined;
    S.scoreOwner = validReport ? rp[2] : null;
    S.manualComplete = validReport && rp[3];
    const drawn = new Set(Object.values(S.draws).flat());
    for (const sid of [...Object.keys(S.q), ...Object.keys(S.saved)]) if (inBank.has(sid) && !drawn.has(sid)) { delete S.q[sid]; delete S.saved[sid]; }
    pruneHistory();
    // Older snapshots have no reporting metadata: reconstruct from restored criteria, never LMS status alone.
    if (!validReport) { S.reported = null; checkTracking(true); }
    log('resume');
    S.slide = null;
    const target = land(typeof snap.slide === 'string' && slideById.has(snap.slide) && (!inBank.has(snap.slide) || flow().includes(snap.slide)) ? snap.slide : order[0]);
    if (!target) return false;
    // Review: resumed only for a submitted quiz whose rebuilt list holds the saved slide.
    const rq = isObj(snap.rv) && typeof snap.rv.quiz === 'string' && own(S.quiz, snap.rv.quiz)?.submitted ? doc.quizzes.find((x) => x.id === snap.rv.quiz) : null;
    const back = rq && ids([snap.rv.results], snap.v)[0];
    if (back && attemptSlides(rq).includes(target)) S.review = { quiz: rq.id, slides: attemptSlides(rq), results: back };
    const current = slideState(snap.current, target);
    if (current) S.saved[target] = current;
    const keepHistory = S.history;
    enterSlide(target, false, !!S.saved[target]);
    S.history = keepHistory;
    if (['correct', 'incorrect', 'tryAgain'].includes(snap.feedback) && slide()?.question && !S.review) S.feedback = snap.feedback;
    return true;
  }

  // ---------- render model for players ----------
  // the running entrance/exit effect of an object, from its timeline clock. The exit ends at the
  // object's end and wins over an overlapping entrance (ours). Players animate from `elapsed`, so resume and seek line up.
  const timelinePaused = (layerId) => (layerId ? !!own(S.paused, layerId) : !!(own(S.paused, BASE) || S.layers.some((l) => layerDef(l)?.pauseBase)));
  function effectOf(o, layerId) {
    const t = own(S.clock, layerId ?? BASE) ?? 0, ms = (e) => Math.round(e.duration * 1000);
    let name = null, e = null, at = 0;
    if (o.exit && o.end !== null && t >= o.end - ms(o.exit) && t < o.end) [name, e, at] = ['exit', o.exit, o.end - ms(o.exit)];
    else if (o.enter && t >= o.start && t < o.start + ms(o.enter)) [name, e, at] = ['enter', o.enter, o.start];
    if (!e) return null;
    const dir = e.effect === 'fly' ? (e.direction ?? 'b') : '';
    const dx = dir.includes('l') ? -(o.x + o.w) : dir.includes('r') ? doc.size.w - o.x : 0; // just outside the stage edge
    const dy = dir.includes('t') ? -(o.y + o.h) : dir.includes('b') ? doc.size.h - o.y : 0;
    return { name, effect: e.effect, duration: ms(e), elapsed: t - at, ...(dir ? { dx, dy } : {}), paused: timelinePaused(layerId) };
  }
  function view() {
    const s = slide();
    if (!s) return { slide: null };
    const asset = (id) => doc.assets.find((a) => a.id === id);
    const placedAt = dragLayout(s, own(S.q, s.id));
    const objs = objDefs().map(([o, layerId]) => {
      const st = objState(o.id) ?? 'normal';
      const over = own(o.states || {}, st) || {};
      const at = placedAt.get(o.id);
      return {
        id: o.id, type: o.type, layer: layerId, x: at ? at.x : o.x, y: at ? at.y : o.y, w: o.w, h: o.h, rotation: o.rotation, shape: o.shape,
        ...(o.members ? { members: [...o.members] } : {}),
        ...(o.rich && over.text === undefined ? { rich: replaceRichVariables(o.rich, interp) } : {}),
        text: interp(over.text ?? o.text), style: { ...(o.style || {}), ...(over.style || {}) },
        hoverStyle: own(o.states || {}, 'hover')?.style || null, downStyle: own(o.states || {}, 'down')?.style || null,
        image: asset(over.image ?? o.image)?.path ?? null, alt: o.alt ?? asset(o.image)?.alt ?? '',
        state: st, visible: visible(o.id), enabled: clickable(o.id), interactive: INTERACTIVE.has(o.type), tabIndex: o.tabIndex,
        value: o.type === 'input' && o.var ? String(getVar(o.var) ?? '') : undefined, placeholder: o.placeholder,
        ...(isRange(o) ? { ...rangeOf(o), value: snapValue(o, getVar(o.var)), live: o.live !== false, name: o.name, ...(o.type === 'dial' ? { startAngle: o.startAngle ?? -90, endAngle: o.endAngle ?? 90 } : {}) } : {}),
        ...(o.type === 'marker' ? { detail: interp(o.detail) } : {}),
        ...(o.enter || o.exit ? { anim: effectOf(o, layerId) } : {}),
        ...(o.type === 'video' || o.type === 'audio' ? {
          media: asset(o.media)?.path ?? null, captions: o.captions ? { id: o.captions, path: asset(o.captions)?.path ?? null } : null, poster: asset(o.poster)?.path ?? null,
          autoplay: !!o.autoplay, controls: o.controls !== false, loop: !!o.loop, alt: o.alt ?? asset(o.media)?.alt ?? '',
          timelinePaused: timelinePaused(layerId), // documented: media pause with their paused timeline and resume where they stopped
        } : {}),
      };
    });
    const q = s.question; const rv = S.review;
    const qs = own(S.q, s.id) ?? (rv && q ? newQuestionState({ ...q, shuffle: false }) : undefined); // review: a question never reached reads as unanswered
    const f = flow(); // progress n / N follows the learner flow
    const i = f.indexOf(s.id);
    const entry = (sid) => ({ id: sid, title: slideById.get(sid).title, viewed: S.viewed.includes(sid), current: sid === s.id });
    // A draw is one menu entry until drawn, then its drawn slides under the draw's title.
    const menuEntry = (sid) => { const set = drawSet(sid); return set ? { ...entry(sid), viewed: set.every((x) => S.viewed.includes(x)), current: set.includes(s.id), slides: set.map(entry) } : entry(sid); };
    return {
      course: { id: doc.id, title: doc.title, w: doc.size.w, h: doc.size.h },
      slide: { id: s.id, title: s.title, background: s.background ?? null, index: i, count: f.length },
      objects: objs,
      layers: visibleLayers().map((l) => ({ id: l.id, title: l.title, modal: l.modal })),
      question: q && qs ? {
        type: q.type, prompt: interp(q.prompt),
        ...(q.layout ? { layout: structuredClone(q.layout) } : {}),
        choices: qs.order.map((id) => { const c = q.choices.find((x) => x.id === id); return { id, label: c?.label ?? id, selected: qs.selected.includes(id), ...(rv ? { correct: !!c?.correct } : {}) }; }),
        text: qs.text, attempts: qs.attempts, maxAttempts: q.attempts, result: qs.result, answered: answered(q, qs),
        ...(q.type === 'hotspot' ? { point: qs.point, ...(rv ? { areas: q.areas.filter((a) => a.correct).map((a) => ({ id: a.id, shape: a.shape ?? 'rect', x: a.x, y: a.y, w: a.w, h: a.h })) } : {}) } : {}),
        ...(q.type === 'matching' ? { rows: q.rows.map((r) => ({ id: r.id, label: interp(r.label), selected: own(qs.matched, r.id) ?? null, ...(rv ? { answer: r.choice } : {}) })) } : {}),
        ...(q.type === 'dragdrop' ? { items: q.items.map((it) => ({ object: it.object, placed: own(qs.placed, it.object) ?? null, ...(rv ? { target: it.target ?? null } : {}) })), targets: q.targets.map((t) => ({ object: t.object, capacity: t.capacity ?? 'one' })) } : {}),
        ...(rv ? { review: reviewOf(q, qs) } : {}), // answers only while reviewing
      } : null,
      feedback: S.feedback ? { kind: S.feedback, text: q?.feedback?.[S.feedback] ?? '' } : null,
      review: rv ? { quiz: rv.quiz, title: doc.quizzes.find((x) => x.id === rv.quiz).title, index: rv.slides.indexOf(s.id), count: rv.slides.length } : null,
      nav: rv ? { prev: rv.slides.indexOf(s.id) > 0, next: true, submit: false } : { prev: doc.player.prevNext && S.history.length > 0 && !S.feedback && !unanswered(), next: doc.player.prevNext && (!!S.feedback || ((i < f.length - 1 || s.triggers.some((t) => t.on.event === 'playerNext')) && !unanswered())), submit: !!q && !!qs && !qs.result && !S.feedback },
      // Results slides are not listed (observed, the vendor menu hides "Quiz Results"); empty scenes drop out.
      menu: doc.player.menu ? doc.scenes.map((sc) => ({ id: sc.id, title: sc.title, slides: sc.slides.filter((sid) => !resultSlides.has(sid)).map(menuEntry) })).filter((sc) => sc.slides.length) : null,
      vars: { ...S.vars }, status: S.status, finished: S.finished, focus: S.focus,
    };
  }

  const api = {
    dispatch, tick: (ms) => dispatch({ type: 'tick', ms }), view, snapshot,
    restore: (s) => { active++; try { restore(s); } finally { active--; } flushNav(); return api; },
    start: (opts) => dispatch({ type: 'start', ...(opts || {}) }),
    get state() { return S; }, trace, doc,
  };
  return api;
}

/** Run a list of events headlessly; returns {trace, state, view}. Used by `cf play`, MCP and tests. */
export function play(doc, events, opts = {}) {
  const calls = [];
  const lms = opts.lms ?? {
    init: () => null, status: (s) => calls.push(`status ${s}`), score: (x) => calls.push(`score ${x.raw}`),
    interaction: (r) => calls.push(`interaction ${r.question} ${r.result}`), save: () => {}, exit: () => calls.push('exit'),
  };
  const rt = createRuntime(doc, { lms, rng: opts.rng });
  const evs = events.length && events[0].type === 'start' ? events : [{ type: 'start' }, ...events];
  for (const e of evs) rt.dispatch(e);
  const v = rt.view();
  return { trace: rt.trace, lms: calls, slide: rt.state.slide ?? null, lesson: rt.state.lesson ?? null, vars: { ...rt.state.vars }, status: rt.state.status, layers: [...(rt.state.layers || [])], view: v };
}

/** Seeded RNG (LCG) for reproducible shuffles in tests and CLI runs. */
export function seededRng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
