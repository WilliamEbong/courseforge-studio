// Lessons-mode learner runtime: a pure state machine over sections -> lessons -> blocks with the slides
// runtime's outer API. Behavior source: (D = documented, C = community
// [ours] = our rule where the docs are silent, digest. Nothing here is observed: the Rise editor is cloud-hosted.
import { normalize, isCompletable, scenarioStep } from '../schema/index.js';
import { percent } from './index.js';

const QUIZ_DEFAULTS = { passPercent: 80, attempts: 0, reveal: 'all', randomize: false, shuffle: false, requirePass: false }; // D [QS]; reveal, requirePass [ours]
const ITEM_TYPES = new Set(['accordion', 'tabs', 'flashcards', 'labeledGraphic', 'process', 'video', 'audio', 'list']);
const TEXT_KEYS = ['title', 'text', 'label', 'cite', 'caption', 'intro', 'summary', 'front', 'back', 'date'];
const MAX_TEXT = 1000;
const STATUSES = ['incomplete', 'completed', 'passed', 'failed'];
const dict = () => Object.create(null); // keyed by course ids, and "constructor" is a valid id
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const words = (x) => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(words) : isObj(x) ? [...TEXT_KEYS.map((k) => x[k]).filter((v) => typeof v === 'string'), ...words(x.items || [])] : []);

export function createLessonRuntime(docIn, { lms = null, rng = Math.random } = {}) {
  const doc = normalize(docIn);
  const lessons = doc.sections.flatMap((s) => s.lessons);
  const order = lessons.map((l) => l.id);
  const lessonById = new Map(lessons.map((l) => [l.id, l]));
  const sectionOf = new Map(doc.sections.flatMap((s) => s.lessons.map((l) => [l.id, s])));
  const blockById = new Map(lessons.flatMap((l) => l.blocks.map((b) => [b.id, b])));
  const lessonOf = new Map(lessons.flatMap((l) => l.blocks.map((b) => [b.id, l])));
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const restricted = doc.player.navigation === 'restricted';
  const trace = [];
  const log = (s) => trace.push(s);
  const S = { lesson: null, last: null, done: [], blocks: dict(), quiz: dict(), reached: dict(), search: null, status: 'incomplete', reported: null };

  // ---------- helpers ----------
  const cfg = (l, k) => l[k] ?? QUIZ_DEFAULTS[k];
  const cur = () => lessonById.get(S.lesson) || null;
  const itemBlock = (b) => ITEM_TYPES.has(b.type) && (b.type !== 'list' || b.kind === 'checkbox');
  const count = (b) => (b.type === 'video' || b.type === 'audio' ? 1 : b.items.length);
  const shuffled = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const unlocked = (id) => !restricted || order.slice(0, order.indexOf(id)).every((x) => S.done.includes(x)); // D [NAV]: in sequence

  function freshAnswer(b, shuffle) {
    if (b.kind === 'matching') {
      // [ours] the right-hand options are always shuffled: in pair order a select list would give the answers away
      const ord = shuffled(b.pairs.map((_, i) => i));
      if (ord.every((x, i) => x === i)) ord.push(ord.shift());
      return { order: ord, sel: [], text: '', match: b.pairs.map(() => null), tries: 0, result: null };
    }
    const ord = (b.choices || []).map((c) => c.id);
    return { order: shuffle ? shuffled(ord) : ord, sel: [], text: '', match: [], tries: 0, result: null };
  }
  /** Learning state of a block, created when its lesson is entered (so rng use depends only on events). */
  function block(b) {
    if (S.blocks[b.id]) return S.blocks[b.id];
    const st = S.blocks[b.id] = { seen: [], done: false };
    if (b.type === 'tabs' || (b.type === 'process' && !b.intro)) st.seen.push(0); // on screen from the start [ours]
    if (b.type === 'continue') st.passed = false;
    if (b.type === 'question') Object.assign(st, freshAnswer(b, b.shuffle));
    if (b.type === 'sorting') Object.assign(st, { placed: [], missed: [], last: null });
    if (b.type === 'scenario') Object.assign(st, scStart(b));
    if (itemBlock(b) && b.type !== 'list' && st.seen.length >= count(b)) st.done = true;
    return st;
  }
  // Blocks on screen: everything up to and including the first continue block not yet passed (D [CONT]).
  function visible(l) {
    const out = [];
    for (const b of l.blocks) { out.push(b); if (b.type === 'continue' && !S.blocks[b.id]?.passed) break; }
    return out;
  }
  const gateOf = (l) => { const v = visible(l); const g = v[v.length - 1]; return g && g.type === 'continue' && !S.blocks[g.id]?.passed ? g : null; };
  function target(id) {
    const l = cur(); const b = blockById.get(id);
    if (!l || !b || lessonOf.get(id) !== l) { log(`warn no block ${id} in this lesson`); return null; }
    if (!visible(l).includes(b)) { log(`warn ${id} is behind a gate`); return null; }
    return b;
  }

  // ---------- navigation ----------
  function open(id) {
    if (id === undefined || id === null) { if (S.lesson !== null) { S.lesson = null; log('cover'); } return; }
    const l = lessonById.get(id);
    if (!l) { log(`warn no lesson ${id}`); return; }
    if (!unlocked(id)) { log(`locked ${id}`); return; }
    if (S.lesson === id) return;
    S.lesson = id; S.last = id;
    if (l.kind === 'quiz') quiz(l); else l.blocks.forEach(block);
    log(`enter ${id}`);
  }
  function step(d) {
    if (!order.length) { log('warn course has no lessons'); return; }
    if (S.lesson === null) { if (d > 0) open(S.last ?? order[0]); else log('warn no previous lesson'); return; } // the cover's Start/Resume
    const t = order[order.indexOf(S.lesson) + d];
    if (!t) { log(`warn no ${d > 0 ? 'next' : 'previous'} lesson`); return; }
    open(t);
  }
  function reach(id) {
    const b = target(id); if (!b) return;
    const r = S.reached[S.lesson] || (S.reached[S.lesson] = []);
    if (!r.includes(id)) r.push(id);
  }
  // C + [ours]: a content lesson is complete when its end is reached with no gate pending.
  function end() {
    const l = cur();
    if (!l || l.kind === 'quiz') return;
    if (gateOf(l)) { log(`warn end of ${l.id} is behind a gate`); return; }
    complete(l);
  }
  function complete(l) {
    if (S.done.includes(l.id)) return;
    S.done.push(l.id);
    log(`lesson ${l.id} complete`);
    checkTracking();
  }

  // ---------- interactive blocks ----------
  function item(id, i) {
    const b = target(id); if (!b) return;
    if (!itemBlock(b)) { log(`warn ${id} has no items to open`); return; }
    if (!Number.isInteger(i) || i < 0 || i >= count(b)) { log(`warn ${id} has no item ${i}`); return; }
    const st = block(b);
    if (b.type === 'list') st.seen = st.seen.includes(i) ? st.seen.filter((x) => x !== i) : [...st.seen, i]; // checkbox toggles
    else if (!st.seen.includes(i)) st.seen.push(i);
    log(`item ${id} ${i}`);
    // [ours] complete when every item has been opened/flipped/viewed (checkbox list: all checked at once)
    if (!st.done && st.seen.length >= count(b)) { st.done = true; log(`complete ${id}`); }
  }
  // D [CONT]: None | Complete Block Directly Above | Complete All Blocks Above (since the previous continue block)
  function missing(l, g) {
    if (g.require === 'none') return [];
    const above = [];
    for (let i = l.blocks.indexOf(g) - 1; i >= 0 && l.blocks[i].type !== 'continue'; i--) { above.push(l.blocks[i]); if (g.require === 'above') break; }
    return above.filter((b) => isCompletable(b) && !S.blocks[b.id]?.done).map((b) => b.id);
  }
  function pass(id) {
    const b = target(id); if (!b) return;
    if (b.type === 'scenario') { scContinue(b); return; }
    if (b.type !== 'continue') { log(`warn ${id} is not a continue block`); return; }
    const st = block(b);
    if (st.passed) return;
    const m = missing(cur(), b);
    if (m.length) { log(`gate ${id} blocked ${m.join(',')}`); return; }
    st.passed = true;
    log(`gate ${id} passed`);
  }
  function sort(id, i, c) {
    const b = target(id); if (!b) return;
    if (b.type !== 'sorting') { log(`warn ${id} is not a sorting block`); return; }
    const st = block(b);
    if (!Number.isInteger(i) || !b.items[i] || st.placed.includes(i)) { log(`warn ${id} has no open card ${i}`); return; }
    if (!Number.isInteger(c) || c < 0 || c >= b.categories.length) { log(`warn ${id} has no category ${c}`); return; }
    const ok = b.items[i].category === c; // D [SORT]: a correct card is placed, a wrong one returns
    if (ok) st.placed.push(i); else if (!st.missed.includes(i)) st.missed.push(i);
    st.last = { item: i, ok };
    log(`sort ${id} ${i} ${ok ? 'correct' : 'wrong'}`);
    if (!st.done && st.placed.length === b.items.length) { st.done = true; log(`complete ${id}`); }
  }

  // ---------- scenario: D [SCEN] scenes, dialogue/text, goTo; [ours] feedback before the move, complete at an end ----------
  const scItem = (b, id) => b.scenes.flatMap((s) => s.items).find((x) => x.id === id);
  const scStart = (b) => ({ item: b.scenes[0].items[0].id, fb: null, ended: false });
  function scMove(b, st, it, to) {
    const n = scenarioStep(b, it, to);
    st.fb = null;
    if (!n) {
      st.ended = true;
      log(`scenario ${b.id} end`);
      if (!st.done) { st.done = true; log(`complete ${b.id}`); }
      return;
    }
    st.item = n.id;
    log(`scenario ${b.id} ${n.id}`);
  }
  function respond(id, rid) {
    const b = target(id); if (!b) return;
    if (b.type !== 'scenario') { log(`warn ${id} is not a scenario`); return; }
    const st = block(b);
    const it = scItem(b, st.item);
    if (st.ended || st.fb !== null || it.kind !== 'dialogue') { log(`warn ${id} is not waiting for a response`); return; }
    const r = it.responses.find((x) => x.id === rid);
    if (!r) { log(`warn ${id} has no response ${rid}`); return; }
    log(`respond ${id} ${rid}`);
    if (r.feedback) st.fb = rid; else scMove(b, st, it, r.goTo);
  }
  function scContinue(b) { // leaves the feedback or the current text item
    const st = block(b);
    const it = scItem(b, st.item);
    if (st.fb !== null) scMove(b, st, it, it.responses.find((x) => x.id === st.fb).goTo);
    else if (!st.ended && it.kind === 'text') scMove(b, st, it, it.goTo);
    else log(`warn ${b.id} is ${st.ended ? 'at its end' : 'waiting for a response'}`);
  }

  // ---------- questions: knowledge checks (ungraded) and quiz lessons (graded) ----------
  function answerTarget(ev) { // -> [block, answer state, inQuiz] or null
    const l = cur();
    if (l && l.kind === 'quiz') {
      const q = quiz(l);
      if (q.phase !== 'question') { log(`warn quiz ${l.id} is not waiting for an answer`); return null; }
      const id = q.order[q.i];
      if (ev.block !== undefined && ev.block !== id) { log(`warn ${ev.block} is not the current question`); return null; }
      return [blockById.get(id), q.ans[id], true];
    }
    const b = target(ev.block); if (!b) return null;
    if (b.type !== 'question') { log(`warn ${b.id} is not a question`); return null; }
    return [b, block(b), false];
  }
  function answer(ev) {
    const hit = answerTarget(ev); if (!hit) return;
    const [b, a, inQuiz] = hit;
    if (a.result) { log(`warn ${b.id} already answered`); return; }
    if (ev.type === 'submit') { if (inQuiz) quizSubmit(b, a); else kcSubmit(b, a); return; }
    if (ev.type === 'choose') {
      if (!(b.kind === 'mc' || b.kind === 'mr') || !b.choices.some((c) => c.id === ev.choice)) { log(`warn ${b.id} has no choice ${ev.choice}`); return; }
      a.sel = b.kind === 'mr' ? (a.sel.includes(ev.choice) ? a.sel.filter((x) => x !== ev.choice) : [...a.sel, ev.choice]) : [ev.choice];
      log(`choose ${b.id} ${ev.choice}`);
    } else if (ev.type === 'input') {
      if (b.kind !== 'fill') { log(`warn ${b.id} takes no text`); return; }
      a.text = String(ev.text ?? '').slice(0, MAX_TEXT);
      log(`input ${b.id}`);
    } else {
      const n = b.kind === 'matching' ? b.pairs.length : 0;
      const ok = (x) => Number.isInteger(x) && x >= 0 && x < n;
      if (!ok(ev.left) || !(ok(ev.right) || ev.right === null)) { log(`warn ${b.id} has no match ${ev.left}.${ev.right}`); return; }
      a.match[ev.left] = ev.right;
      log(`match ${b.id} ${ev.left}.${ev.right}`);
    }
  }
  // D [KB][KC]: matching submits once every item is linked
  const answered = (b, a) => (b.kind === 'fill' ? !!a.text.trim() : b.kind === 'matching' ? a.match.every((x) => x !== null) : a.sel.length > 0);
  function isCorrect(b, a) {
    if (b.kind === 'fill') { const norm = (x) => (b.caseSensitive ? x.trim() : x.trim().toLowerCase()); return b.answers.some((x) => norm(x) === norm(a.text)); } // D [KC]
    if (b.kind === 'matching') return a.match.every((r, i) => b.pairs[r].right === b.pairs[i].right);
    return [...a.sel].sort().join(',') === b.choices.filter((c) => c.correct).map((c) => c.id).sort().join(',');
  }
  function grade(b, a) {
    if (!answered(b, a)) { log(`warn ${b.id} has no answer yet`); return false; }
    a.tries++;
    a.result = isCorrect(b, a) ? 'correct' : 'incorrect';
    return true;
  }
  function kcSubmit(b, a) {
    if (!grade(b, a)) return;
    log(`kc ${b.id} ${a.result}`); // ungraded: never reported to the LMS (D [KC])
    if (!a.done) { a.done = true; log(`complete ${b.id}`); } // [ours] complete once answered
  }
  const kcRetry = (b, a) => a.result === 'incorrect' && (!b.attempts || a.tries < b.attempts); // D [KC]: no Take Again after a correct answer
  function feedbackText(b, a) { // D [KC]: by choice (mc), correct/incorrect, or any response
    const f = b.feedback || {};
    const byChoice = b.kind === 'mc' ? b.choices.find((c) => c.id === a.sel[0])?.feedback : undefined;
    return byChoice ?? (a.result === 'correct' ? f.correct : f.incorrect) ?? f.any ?? '';
  }
  const answerText = (b) => (b.kind === 'fill' ? b.answers[0] : b.kind === 'matching' ? b.pairs.map((p) => `${p.left} = ${p.right}`).join('; ') : b.choices.filter((c) => c.correct).map((c) => c.label).join(', '));
  function retry(id) {
    const b = target(id); if (!b) return;
    const st = block(b);
    if (b.type === 'question' && kcRetry(b, st)) Object.assign(st, { sel: [], text: '', match: st.match.map(() => null), result: null });
    else if (b.type === 'sorting' && st.done) Object.assign(st, { placed: [], missed: [], last: null }); // D [SORT] Retry
    else if (b.type === 'scenario' && st.ended) Object.assign(st, scStart(b)); // D [SCEN] Start Over; stays complete [ours]
    else { log(`warn ${id} cannot be retried`); return; }
    log(`retry ${id}`);
  }

  // Quiz lessons: intro -> question -> feedback -> ... -> results (D [KB] flow; D [QS] settings).
  function quiz(l) { return S.quiz[l.id] || (S.quiz[l.id] = { phase: 'intro', i: 0, order: [], ans: dict(), tries: 0, score: null, passed: false }); }
  const canRetake = (l, q) => q.phase === 'results' && (!cfg(l, 'attempts') || q.tries < cfg(l, 'attempts'));
  function begin(l, q) {
    if (!l.blocks.length) { log(`warn quiz ${l.id} has no questions`); return; }
    q.order = l.blocks.map((b) => b.id);
    if (cfg(l, 'randomize')) shuffled(q.order);
    q.ans = dict();
    for (const b of l.blocks) q.ans[b.id] = freshAnswer(b, cfg(l, 'shuffle'));
    Object.assign(q, { i: 0, phase: 'question', score: null, passed: false });
    q.tries++;
    log(`quiz ${l.id} start ${q.tries}`);
  }
  function quizContinue() {
    const l = cur();
    if (!l || l.kind !== 'quiz') { log('warn nothing to continue'); return; }
    const q = quiz(l);
    if (q.phase === 'intro') begin(l, q);
    else if (q.phase === 'feedback') advance(l, q);
    else log(`warn quiz ${l.id} is ${q.phase === 'question' ? 'waiting for an answer' : 'finished'}`);
  }
  function quizSubmit(b, a) {
    const l = cur(); const q = quiz(l);
    if (!grade(b, a)) return;
    log(`submit ${b.id} ${a.result}`);
    lms?.interaction?.(record(l, q, b, a));
    if (cfg(l, 'reveal') === 'none') advance(l, q); else q.phase = 'feedback';
  }
  function advance(l, q) {
    if (q.i < q.order.length - 1) { q.i++; q.phase = 'question'; return; }
    // [ours] one point per question, all or nothing; percent() truncates like the slides runtime
    q.score = percent(q.order.filter((id) => q.ans[id].result === 'correct').length, q.order.length);
    q.passed = q.score >= cfg(l, 'passPercent');
    q.phase = 'results';
    log(`quiz ${l.id} ${q.score} ${q.passed ? 'passed' : 'failed'}`);
    // Like slides scoreClosed: once the LMS has a final status, a later quiz must not overwrite its score.
    const closed = S.reported === 'passed' || S.reported === 'completed' || (S.reported === 'failed' && doc.tracking.status?.endsWith('-failed'));
    if (!closed) lms?.score?.({ raw: q.score, min: 0, max: 100 });
    if (q.passed || !cfg(l, 'requirePass')) complete(l);
    checkTracking(l.id);
  }
  function retake() {
    const l = cur();
    if (!l || l.kind !== 'quiz') { log('warn no quiz to retake'); return; }
    const q = quiz(l);
    if (!canRetake(l, q)) { log(`warn quiz ${l.id} cannot be retaken`); return; }
    // Like slides resetQuiz: a new attempt of the tracked quiz reopens the course unless another criterion completed it.
    if (doc.tracking.complete.some((c) => c.quiz === l.id) && S.reported !== 'completed') { S.reported = null; report('incomplete'); }
    begin(l, q);
  }
  // Interaction record in the slides runtime's shape (publisher toScormInteraction maps it to SCORM 1.2).
  function record(l, q, b, a) {
    const base = { id: `${l.id}_${b.id}_${q.tries - 1}`, type: b.kind, quiz: l.id, question: b.id, prompt: b.prompt, result: a.result, weighting: 1 };
    if (b.kind === 'fill') return { ...base, response: a.text, responseLabels: [a.text], correct: [...b.answers] };
    if (b.kind === 'matching') return { ...base, response: a.match.map((r, i) => [i, r]), responseLabels: a.match.map((r, i) => `${b.pairs[i].left} = ${b.pairs[r].right}`), correct: b.pairs.map((_, i) => [i, i]) };
    return { ...base, response: a.sel.map((id) => b.choices.findIndex((c) => c.id === id)), responseLabels: a.sel.map((id) => b.choices.find((c) => c.id === id).label), correct: b.choices.map((c, i) => (c.correct ? i : -1)).filter((i) => i >= 0) };
  }

  // ---------- search (D [NAV]: free navigation only) ----------
  let texts = null; // [lesson, [text...]] built on the first search; questions and sorting never leak answers [ours]
  function search(q) {
    if (restricted) { log('warn search needs free navigation'); return; }
    const t = String(q ?? '').trim().toLowerCase().slice(0, 100);
    if (!t) { S.search = null; return; }
    texts = texts || lessons.map((l) => [l, [l.title, ...l.blocks.filter((b) => b.type !== 'question' && b.type !== 'sorting').flatMap(words)]]);
    const results = [];
    for (const [l, parts] of texts) {
      const hit = parts.find((p) => p.toLowerCase().includes(t));
      if (!hit) continue;
      const i = hit.toLowerCase().indexOf(t);
      const from = Math.max(0, i - 30), to = i + t.length + 50;
      results.push({ lesson: l.id, title: l.title, snippet: (from ? '…' : '') + hit.slice(from, to) + (to < hit.length ? '…' : '') });
    }
    S.search = { q: t, results };
    log(`search "${t}" ${results.length}`);
  }

  // ---------- tracking (same status mapping as slides) ----------
  function report(status) {
    if (S.reported === status) return;
    S.status = status; S.reported = status;
    log(`lms status ${status}`);
    lms?.status?.(status);
  }
  function checkTracking(quizId) {
    if (S.reported === 'passed' || S.reported === 'completed') return;
    for (const c of doc.tracking.complete) {
      // D [WHEN]: percentage counts per lesson and is sent as soon as the threshold lesson completes
      if (c.lessonsViewed !== undefined && order.length && (S.done.length / order.length) * 100 >= c.lessonsViewed) return report('completed');
      // D [WHEN]: a quiz result is sent when that quiz's results show
      const q = c.quiz && S.quiz[c.quiz];
      if (q && q.score !== null && (!quizId || quizId === c.quiz)) return report(q.passed ? 'passed' : 'failed');
    }
  }
  const save = () => lms?.save?.(snapshot());

  function start({ resume } = {}) {
    const snap = lms?.init?.() ?? null;
    const policy = resume ?? doc.player.resume;
    if (snap && (policy === 'always' || policy === true) && restore(snap)) return;
    if (!order.length) log('warn course has no lessons');
    log('start'); // on the cover (D [THEME])
  }
  function restart() {
    Object.assign(S, { lesson: null, last: null, done: [], blocks: dict(), quiz: dict(), reached: dict(), search: null }); // the LMS status is never taken back
    log('restart');
  }

  const QUIET = new Set(['tick', 'reach', 'search', 'input']); // input fires per keystroke; submit and navigation save it
  function dispatch(ev) {
    if (!ev || typeof ev.type !== 'string') throw new TypeError('event must be {type, ...}');
    switch (ev.type) {
      case 'start': start(ev); break;
      case 'open': open(ev.lesson); break;
      case 'next': step(1); break;
      case 'prev': step(-1); break;
      case 'reach': reach(ev.block); break;
      case 'end': end(); break;
      case 'item': item(ev.block, ev.index); break;
      case 'continue': if (ev.block !== undefined) pass(ev.block); else quizContinue(); break;
      case 'choose': case 'input': case 'match': case 'submit': answer(ev); break;
      case 'retry': retry(ev.block); break;
      case 'retake': retake(); break;
      case 'sort': sort(ev.block, ev.item, ev.category); break;
      case 'respond': respond(ev.block, ev.response); break;
      case 'search': search(ev.q); break;
      case 'restart': restart(); break;
      case 'tick': break; // lessons have no timeline
      default: log(`warn unknown event ${ev.type}`);
    }
    if (!QUIET.has(ev.type)) save();
    return api;
  }

  // ---------- snapshot / restore (resume; SCORM 1.2 suspend_data holds 4096 characters) ----------
  // ponytail: empty fields are dropped; bit-pack block state if a real course outgrows 4096 characters.
  const lean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => ![false, null, '', 0].includes(v) && !(Array.isArray(v) && v.every((x) => x === null))));
  function snapshot() {
    const blocks = {};
    for (const [id, st] of Object.entries(S.blocks)) {
      const b = blockById.get(id);
      const v = lean({ ...st, last: null, seen: st.done && b.type !== 'list' ? [] : st.seen }); // done implies every item seen
      if (Object.keys(v).length) blocks[id] = v;
    }
    const quizzes = {};
    for (const [id, q] of Object.entries(S.quiz)) quizzes[id] = lean({ ...q, ans: Object.fromEntries(Object.entries(q.ans).map(([k, a]) => [k, lean(a)])) });
    return { v: 1, mode: 'lessons', lesson: S.lesson, last: S.last, done: [...S.done], blocks, quiz: quizzes, status: S.status, reported: S.reported };
  }
  const ints = (a, n) => (Array.isArray(a) ? [...new Set(a.filter((x) => Number.isInteger(x) && x >= 0 && x < n))] : []);
  function cleanAnswer(b, x, shuffle) {
    const a = freshAnswer(b, shuffle);
    if (!isObj(x)) return a;
    if (Array.isArray(x.order) && x.order.length === a.order.length && a.order.every((v) => x.order.includes(v))) a.order = [...x.order];
    const choiceIds = new Set((b.choices || []).map((c) => c.id));
    const sel = Array.isArray(x.sel) ? [...new Set(x.sel.filter((v) => choiceIds.has(v)))] : [];
    a.sel = b.kind === 'mc' ? sel.slice(0, 1) : sel;
    a.text = typeof x.text === 'string' ? x.text.slice(0, MAX_TEXT) : '';
    if (Array.isArray(x.match)) a.match = a.match.map((_, i) => (Number.isInteger(x.match[i]) && x.match[i] >= 0 && x.match[i] < a.match.length ? x.match[i] : null));
    a.tries = Number.isInteger(x.tries) && x.tries >= 0 ? x.tries : 0;
    if (['correct', 'incorrect'].includes(x.result) && answered(b, a)) a.result = isCorrect(b, a) ? 'correct' : 'incorrect'; // recomputed, never trusted
    return a;
  }
  function cleanBlock(b, x) {
    const st = block(b);
    if (!isObj(x)) return;
    st.done = x.done === true && isCompletable(b);
    if (itemBlock(b)) st.seen = st.done && b.type !== 'list' ? [...Array(count(b)).keys()] : [...new Set([...st.seen, ...ints(x.seen, count(b))])];
    if (b.type === 'continue') st.passed = x.passed === true;
    if (b.type === 'question') Object.assign(st, cleanAnswer(b, x, b.shuffle), { done: st.done });
    if (b.type === 'sorting') { st.placed = ints(x.placed, b.items.length); st.missed = ints(x.missed, b.items.length); }
    if (b.type === 'scenario') {
      const it = scItem(b, x.item);
      if (it) st.item = it.id;
      st.ended = x.ended === true;
      st.done = st.done || st.ended;
      st.fb = !st.ended && it && it.kind === 'dialogue' && it.responses.some((r) => r.id === x.fb) ? x.fb : null;
    }
  }
  function cleanQuiz(l, x) {
    const q = quiz(l);
    if (!isObj(x)) return;
    const ids = l.blocks.map((b) => b.id);
    q.tries = Number.isInteger(x.tries) && x.tries >= 0 ? x.tries : 0;
    // A changed course or a missing attempt goes back to the intro; attempts used are kept.
    if (!['question', 'feedback', 'results'].includes(x.phase) || !(Array.isArray(x.order) && x.order.length === ids.length && ids.every((id) => x.order.includes(id)))) return;
    q.order = [...x.order]; q.phase = x.phase;
    q.i = Number.isInteger(x.i) && x.i >= 0 && x.i < ids.length ? x.i : 0;
    for (const b of l.blocks) q.ans[b.id] = cleanAnswer(b, isObj(x.ans) && Object.hasOwn(x.ans, b.id) ? x.ans[b.id] : null, cfg(l, 'shuffle'));
    if (q.phase === 'feedback' && !q.ans[q.order[q.i]].result) q.phase = 'question';
    if (q.phase === 'results') {
      q.score = percent(q.order.filter((id) => q.ans[id].result === 'correct').length, q.order.length);
      q.passed = q.score >= cfg(l, 'passPercent');
    }
  }
  /** Restore a snapshot from an untrusted store. Invalid parts are dropped; returns false if unusable. */
  function restore(snap) {
    if (!isObj(snap) || snap.v !== 1 || snap.mode !== 'lessons') { log('warn resume data ignored'); return false; }
    Object.assign(S, { lesson: null, blocks: dict(), quiz: dict(), reached: dict(), search: null });
    S.done = Array.isArray(snap.done) ? [...new Set(snap.done.filter((x) => lessonById.has(x)))] : [];
    if (isObj(snap.blocks)) for (const [id, x] of Object.entries(snap.blocks)) { const b = blockById.get(id); if (b) cleanBlock(b, x); }
    if (isObj(snap.quiz)) for (const [id, x] of Object.entries(snap.quiz)) { const l = lessonById.get(id); if (l && l.kind === 'quiz') cleanQuiz(l, x); }
    S.status = STATUSES.includes(snap.status) ? snap.status : 'incomplete';
    S.reported = STATUSES.includes(snap.reported) ? snap.reported : null;
    S.last = lessonById.has(snap.last) ? snap.last : null;
    log('resume');
    if (typeof snap.lesson === 'string') open(snap.lesson); // a missing or locked lesson leaves the learner on the cover
    return true;
  }

  // ---------- render model for players ----------
  const src = (id) => assets.get(id)?.path ?? null;
  const alt = (a, id) => a ?? assets.get(id)?.alt ?? '';
  function questionView(b, a, showCorrect) {
    const out = { kind: b.kind, prompt: b.prompt, result: a.result, tries: a.tries };
    if (b.kind === 'mc' || b.kind === 'mr') out.choices = a.order.map((id) => { const c = b.choices.find((x) => x.id === id); return { id, label: c.label, selected: a.sel.includes(id), ...(showCorrect ? { correct: !!c.correct } : {}) }; });
    if (b.kind === 'fill') { out.text = a.text; if (showCorrect) out.answers = [...b.answers]; }
    if (b.kind === 'matching') {
      out.left = b.pairs.map((p, i) => ({ index: i, text: p.left, match: a.match[i], ...(showCorrect ? { correct: i } : {}) }));
      out.right = a.order.map((i) => ({ index: i, text: b.pairs[i].right }));
    }
    if (a.result) out.feedback = feedbackText(b, a);
    return out;
  }
  function blockView(b) {
    const st = block(b);
    const v = { ...b };
    if (b.image) { v.src = src(b.image); v.alt = alt(b.alt, b.image); }
    if (b.media) { v.src = src(b.media); v.captionsSrc = b.captions ? src(b.captions) : null; }
    if (b.type === 'gallery') v.items = b.items.map((x) => ({ ...x, src: src(x.image), alt: alt(x.alt, x.image) }));
    if (b.type === 'button' && b.toLesson) v.target = { id: b.toLesson, title: lessonById.get(b.toLesson).title, locked: !unlocked(b.toLesson) };
    if (itemBlock(b)) { v.seen = [...st.seen]; v.done = st.done; }
    if (b.type === 'continue') { v.passed = st.passed; v.missing = st.passed ? [] : missing(cur(), b); }
    if (b.type === 'question') {
      for (const k of ['choices', 'answers', 'pairs', 'feedback']) delete v[k]; // the learner view replaces the answer key
      // D [KC]: the correct answer shows after submitting unless hidden after an incorrect response
      Object.assign(v, questionView(b, st, st.result === 'correct' || (st.result === 'incorrect' && !b.hideCorrect)), { canRetry: kcRetry(b, st), done: st.done });
    }
    if (b.type === 'sorting') {
      const open = b.items.map((_, i) => i).filter((i) => !st.placed.includes(i));
      Object.assign(v, { placed: [...st.placed], current: open.length ? open[0] : null, last: st.last, done: st.done, firstTry: open.length ? null : b.items.length - st.missed.length });
    }
    if (b.type === 'scenario') { // the current step only: no goTo graph, no scene titles (D [SCEN]: hidden from learners)
      const it = scItem(b, st.item);
      const s = b.scenes.find((x) => x.items.includes(it));
      const r = st.fb !== null ? it.responses.find((x) => x.id === st.fb) : null;
      const pic = (id, a) => (id ? { src: src(id), alt: alt(a, id) } : null);
      delete v.scenes;
      Object.assign(v, {
        scene: s.id, background: pic(s.background, s.backgroundAlt), character: pic(s.character, s.characterAlt),
        item: { id: it.id, kind: it.kind, text: it.text, responses: (it.responses || []).map((x) => ({ id: x.id, text: x.text })), last: it.kind === 'text' && scenarioStep(b, it, it.goTo) === null },
        feedback: r ? { response: r.id, text: r.text, feedback: r.feedback, last: scenarioStep(b, it, r.goTo) === null } : null,
        ended: st.ended, ending: b.ending ?? '', done: st.done,
      });
    }
    return v;
  }
  function quizView(l) {
    const q = quiz(l);
    const reveal = cfg(l, 'reveal');
    const out = { phase: q.phase, attempt: q.tries, attempts: cfg(l, 'attempts'), passPercent: cfg(l, 'passPercent'), reveal, count: l.blocks.length, canRetake: canRetake(l, q) };
    if (q.phase === 'question' || q.phase === 'feedback') {
      const b = blockById.get(q.order[q.i]);
      out.question = { id: b.id, index: q.i, ...questionView(b, q.ans[b.id], q.phase === 'feedback' && reveal === 'all') };
    }
    if (q.phase === 'results') {
      out.results = {
        score: q.score, passed: q.passed,
        review: reveal === 'none' ? [] : q.order.map((id) => { const b = blockById.get(id); const a = q.ans[id]; return { id, prompt: b.prompt, result: a.result, feedback: feedbackText(b, a), ...(reveal === 'all' ? { answer: answerText(b) } : {}) }; }),
      };
    }
    return out;
  }
  function view() {
    const l = cur();
    const near = (d) => {
      const id = l ? order[order.indexOf(l.id) + d] : d > 0 ? (S.last ?? order[0]) : undefined;
      return id ? { id, title: lessonById.get(id).title, locked: !unlocked(id) } : null;
    };
    return {
      mode: 'lessons',
      course: { id: doc.id, title: doc.title, description: doc.description ?? '', cover: doc.cover?.image ? { src: src(doc.cover.image), alt: alt(doc.cover.alt, doc.cover.image) } : null },
      navigation: restricted ? 'restricted' : 'free',
      lesson: l ? {
        id: l.id, title: l.title, kind: l.kind, index: order.indexOf(l.id), count: order.length, section: sectionOf.get(l.id).title, complete: S.done.includes(l.id),
        blocks: l.kind === 'quiz' ? [] : visible(l).map(blockView), gated: l.kind !== 'quiz' && !!gateOf(l), quiz: l.kind === 'quiz' ? quizView(l) : null,
      } : null,
      outline: doc.sections.map((s) => ({
        id: s.id, title: s.title,
        lessons: s.lessons.map((x) => ({ id: x.id, title: x.title, kind: x.kind, complete: S.done.includes(x.id), locked: !unlocked(x.id), current: x === l, progress: S.done.includes(x.id) ? 100 : Math.floor(percent((S.reached[x.id] || []).length, x.blocks.length + 1)) })), // + 1: the end of the lesson
      })),
      progress: Math.floor(percent(S.done.length, order.length)),
      started: S.last !== null,
      nav: { prev: near(-1), next: near(1) },
      search: restricted ? null : (S.search ?? { q: '', results: [] }),
      status: S.status,
    };
  }

  const api = {
    dispatch, tick: (ms) => dispatch({ type: 'tick', ms }), view, snapshot,
    restore: (s) => { restore(s); return api; },
    start: (opts) => dispatch({ type: 'start', ...(opts || {}) }),
    get state() { return S; }, trace, doc, mode: 'lessons',
  };
  return api;
}
