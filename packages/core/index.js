export { PUBLISH_TARGETS } from './publish-targets.js';
// Command/query registry: the single entry point every front-end (GUI, CLI, HTTP, MCP) uses to edit and inspect courses.
import { check, toJsonSchema, normalize, fillDefaults, validate, jsonSchema, serialize, rangeOf } from '../schema/index.js';
import { commands as list, locate } from './commands.js';
import { a11yIssues } from './a11y.js';
import { PRESETS, FONTS, themeOf } from '../schema/themes.js';
import LIBRARY from '../library/index.json' with { type: 'json' };

export const commands = Object.freeze(Object.fromEntries(list.map((c) => [c.name, c])));
// Transient provenance lets native file adapters retain opaque data when a command copies an element.
export const copyOrigins = new WeakMap();
const fail = (errors) => ({ ok: false, errors });

/**
 * Apply one command `{cmd, args}` to `doc`. Pure: `doc` is never mutated.
 * Returns {ok:true, doc, result, inverse} or {ok:false, errors:[{path, code, message, hint?}]}.
 */
/** Run one command on a private working copy (mutated in place, defaults refilled). No document validation. */
function runOne(work, command, ctx) {
  if (!command || typeof command !== 'object') return fail([{ path: '/', code: 'type', message: 'command must be an object {cmd, args}' }]);
  const def = commands[command.cmd];
  if (!def) return fail([{ path: '/cmd', code: 'enum', message: `unknown command "${command.cmd}"`, hint: `commands: ${Object.keys(commands).join(', ')}` }]);
  const args = command.args ?? {};
  const argErrs = check(def.args, args, '/args');
  if (argErrs.length) return fail(argErrs.map((e) => ({ ...e, hint: e.hint ?? `see: cf commands ${def.name}` })));
  let result;
  try {
    result = def.run(work, structuredClone(args), { rng: ctx.rng ?? Math.random, copied(map) {
      if (!copyOrigins.has(work)) copyOrigins.set(work, new Map());
      for (const [source, target] of map) copyOrigins.get(work).set(target, { source, map });
    } });
  } catch (e) {
    if (e.cmdErrors) return fail(e.cmdErrors);
    throw e;
  }
  fillDefaults(work);
  return { ok: true, result, def };
}

export function apply(doc, command, ctx = {}) {
  const before = normalize(doc);
  const work = structuredClone(before);
  if (copyOrigins.has(doc)) copyOrigins.set(work, new Map(copyOrigins.get(doc)));
  const r = runOne(work, command, ctx);
  if (!r.ok) return r;
  const { result, def } = r;
  const after = work;
  const errors = validate(after);
  if (errors.length) return fail(errors.map((e) => ({ ...e, message: `${def.name} would make the course invalid: ${e.message}` })));
  // ponytail: whole-document inverse; switch to patches if history size ever matters.
  return { ok: true, doc: after, result, inverse: { cmd: 'course.replace', args: { doc: before } } };
}

/** Apply a batch atomically: all succeed or nothing changes. Errors carry the failing index. */
// Batches run on one working copy and validate once at the end (linear, not quadratic, in batch size). If the
// final document is invalid, the batch is replayed command by command to report the exact failing index.
export function applyAll(doc, cmds, ctx = {}) {
  if (!Array.isArray(cmds)) return apply(doc, cmds, ctx);
  const before = normalize(doc);
  const work = structuredClone(before);
  if (copyOrigins.has(doc)) copyOrigins.set(work, new Map(copyOrigins.get(doc)));
  const results = [];
  // The replay must generate the same ids as the fast pass, so record every random draw (review 003 #6).
  const source = ctx.rng ?? Math.random;
  const drawn = [];
  const rng = () => { const x = source(); drawn.push(x); return x; };
  let broken = false;
  for (let i = 0; i < cmds.length; i++) {
    let r;
    try { r = runOne(work, cmds[i], { rng }); } catch { broken = true; break; } // an invalid intermediate doc (review 003 #7): let the replay report it
    if (!r.ok) return fail(r.errors.map((e) => ({ ...e, index: i, cmd: cmds[i]?.cmd })));
    results.push(r.result);
  }
  if (broken || validate(work).length) { // slow path: find the first command that makes the course invalid
    let cur = before;
    const replay = (() => { let k = 0; return () => (k < drawn.length ? drawn[k++] : source()); })();
    for (let i = 0; i < cmds.length; i++) {
      const r = apply(cur, cmds[i], { rng: replay });
      if (!r.ok) return fail(r.errors.map((e) => ({ ...e, index: i, cmd: cmds[i]?.cmd })));
      cur = r.doc;
    }
    const errors = validate(work); // every step valid on its own but the batch result is not: report, never save it
    return fail(errors.map((e) => ({ ...e, index: cmds.length - 1, cmd: cmds.at(-1)?.cmd })));
  }
  return { ok: true, doc: work, results, inverse: { cmd: 'course.replace', args: { doc: before } } };
}

// ---------- describe: compact, token-efficient outline for humans and LLMs ----------
const fmtVal = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));
export function fmtCond(c) {
  if (!c) return '';
  const parts = (c.all || c.any || []).map((x) => x.target ? `${x.target} ${x.is === false ? 'is not' : 'is'} ${x.state}` : `${x.var} ${x.op} ${x.otherVar ?? fmtVal(x.value)}`);
  return parts.join(c.any ? ' or ' : ' and ');
}
export function fmtAction(a) {
  switch (a.action) {
    case 'setVar': return a.op === 'toggle' ? `toggle ${a.var}` : `${a.var} ${{ set: '=', add: '+=', sub: '-=', mul: '*=', div: '/=' }[a.op]} ${a.fromVar ?? fmtVal(a.value)}`;
    case 'setState': return `${a.target}→${a.state}`;
    case 'showLayer': return `show ${a.layer}`;
    case 'hideLayer': return `hide ${a.layer ?? 'this layer'}`;
    case 'jump': return `jump ${a.to}`;
    case 'jumpScene': return `jumpScene ${a.to}`;
    case 'submitQuiz': case 'resetQuiz': case 'reviewQuiz': return `${a.action} ${a.quiz}`;
    case 'openUrl': return `open ${a.url}`;
    case 'setFocus': return `focus ${a.target}`;
    case 'playMedia': case 'pauseMedia': case 'stopMedia': return `${a.action.slice(0, -5)} ${a.target}`;
    default: return a.action;
  }
}
export function fmtEvent(on) {
  return on.target ? `${on.event} ${on.target}${on.state ? ' ' + on.state : ''}` : on.var ? `${on.event} ${on.var}` : on.ms !== undefined ? `${on.event} ${on.ms}ms` : on.key ? `key ${on.key}` : on.event;
}
export const fmtTrigger = (t) => `${t.id}: ${fmtEvent(t.on)}${t.if ? ` if ${fmtCond(t.if)}` : ''} → ${t.do.map(fmtAction).join('; ')}${t.else ? ` | else ${t.else.map(fmtAction).join('; ')}` : ''}${t.enabled === false ? ' (disabled)' : ''}`;

// Type-specific tail of an object line.
function extra(o) {
  if (o.type === 'slider' || o.type === 'dial') {
    const r = rangeOf(o);
    return ` var=${o.var} ${r.min}..${r.max} step ${r.step}${o.live === false ? ' on-release' : ''}${o.type === 'dial' ? ` ${o.startAngle ?? -90}°..${o.endAngle ?? 90}°` : ''}`;
  }
  if (o.type === 'marker') return o.detail ? ` detail "${clipText(o.detail)}"` : '';
  if (o.type === 'video' || o.type === 'audio') return ` media=${o.media}${o.captions ? ' captions=' + o.captions : ''}${o.poster ? ' poster=' + o.poster : ''}${o.autoplay ? ' autoplay' : ''}${o.loop ? ' loop' : ''}${o.controls === false ? ' no-controls' : ''}`;
  return '';
}
function answerKey(q) {
  if (q.type === 'fill') return 'answers=' + q.answers.join('|');
  if (q.type === 'hotspot') return 'areas=' + (q.areas || []).map((a) => `${a.correct ? '*' : ''}${a.id}:${a.shape ?? 'rect'}@${a.x},${a.y} ${a.w}x${a.h}`).join(' ');
  if (q.type === 'matching') return `rows=${(q.rows || []).map((r) => `${r.id}>${r.choice}`).join(' ')} choices=${q.choices.map((c) => `${c.id}:${c.label}`).join(' ')}`;
  if (q.type === 'sequence') return `order=${q.choices.map((c) => `${c.id}:${c.label}`).join(' > ')}`;
  if (q.type === 'dragdrop') return `items=${(q.items || []).map((it) => `${it.object}>${it.target ?? '-'}`).join(' ')} targets=${(q.targets || []).map((t) => `${t.object}:${t.capacity ?? 'one'}`).join(' ')}`;
  return q.choices.map((c) => (c.correct ? '*' : '') + c.id + ':' + c.label).join(' ');
}
const clipText = (s, n = 40) => (s.length > n ? s.slice(0, n - 3) + '...' : s);
/** One line per block: id, type and the facts an agent needs (items, gate rule, question key). */
export function fmtBlock(b, full = false) {
  const clip = full ? (t) => t : clipText;
  const first = b.label ?? b.text ?? b.prompt ?? '';
  const facts = [
    first && `"${clip(first)}"`,
    b.kind && b.type !== 'question' && b.kind !== 'bullet' ? b.kind : '',
    b.items ? `${b.items.length} items` : '',
    b.type === 'continue' ? `require=${b.require}` : '',
    b.type === 'button' ? `→ ${b.toLesson ?? b.url}` : '',
    b.type === 'question' ? b.kind + ' ' + (b.kind === 'fill' ? 'answers=' + (b.answers || []).join('|') : b.kind === 'matching' ? (b.pairs || []).map((p) => `${p.left}=${p.right}`).join(' ') : (b.choices || []).map((c) => (c.correct ? '*' : '') + c.id + ':' + c.label).join(' ')) : '',
    b.type === 'sorting' ? `categories=${b.categories.join('|')}` : '',
    b.type === 'scenario' ? `${b.scenes.length} scenes ${b.scenes.reduce((n, s) => n + s.items.length, 0)} items` : '',
    b.image || b.media ? `asset=${b.image ?? b.media}` : '',
    full && b.type === 'question' ? fmtFeedback(b.feedback, b.choices) : '',
  ].filter(Boolean);
  return `${b.id} ${b.type}${facts.length ? ' ' + facts.join(' ') : ''}`;
}
/** Question feedback, for the full outline only (the AI change card and course review read it). */
function fmtFeedback(fb = {}, choices = []) {
  const parts = [['correct', fb.correct], ['incorrect', fb.incorrect], ['any', fb.any], ...choices.filter((c) => c.feedback).map((c) => [`choice ${c.id}`, c.feedback])].filter(([, t]) => t);
  return parts.length ? `feedback ${parts.map(([k, t]) => `${k}: "${t}"`).join(' ')}` : 'feedback: none';
}

/** Text outline of a course; `full` keeps every text whole (the AI change card diffs it). */
export function describe(doc, { full = false } = {}) {
  const d = normalize(doc);
  const nav = d.player.navigation === 'restricted' ? ' (restricted)' : '';
  const out = [d.mode === 'lessons' ? `course ${d.id} "${d.title}" lessons${nav}` : `course ${d.id} "${d.title}" ${d.size.w}x${d.size.h}`];
  for (const s of d.sections) {
    out.push(`section ${s.id} "${s.title}"`);
    for (const l of s.lessons) {
      const quiz = l.kind === 'quiz' ? ` quiz pass=${l.passPercent ?? 80}% attempts=${l.attempts || 'unlimited'} reveal=${l.reveal ?? 'all'}${l.randomize ? ' randomize' : ''}${l.shuffle ? ' shuffle' : ''}${l.requirePass ? ' requirePass' : ''}` : '';
      out.push(`  lesson ${l.id} "${l.title}"${quiz}`);
      for (const b of l.blocks) out.push('    ' + fmtBlock(b, full));
    }
  }
  if (d.variables.length) out.push('vars: ' + d.variables.map((v) => `${v.name}:${v.type}=${fmtVal(v.initial)}`).join(', '));
  const bySlide = new Map(d.slides.map((s) => [s.id, s]));
  const objLine = (o) => `${o.id} ${o.type}${o.text ? ` "${full ? o.text : clipText(o.text)}"` : ''} @${o.x},${o.y} ${o.w}x${o.h}${o.hidden ? ' hidden' : ''}${o.initialState !== 'normal' ? ' [' + o.initialState + ']' : ''}${Object.keys(o.states || {}).length ? ' states:' + Object.keys(o.states).join('/') : ''}${extra(o)}`;
  // scenes, then question banks; a draw slide is one line (bank, count, order, always/never)
  for (const [kind, sc] of [...d.scenes.map((x) => ['scene', x]), ...d.banks.map((x) => ['bank', x])]) {
    out.push(`${kind} ${sc.id} "${sc.title}"`);
    for (const sid of sc.slides) {
      const s = bySlide.get(sid);
      if (!s) continue;
      const w = s.draw;
      if (w) { out.push(`  draw ${s.id} "${s.title}" bank=${w.bank} count=${w.count || 'all'} ${w.shuffle ? 'shuffled' : 'bank order'}${w.always.length ? ' always=' + w.always.join(',') : ''}${w.never.length ? ' never=' + w.never.join(',') : ''}`); continue; }
      const flags = [s.advance === 'auto' ? 'auto-advance' : '', s.revisit !== 'auto' ? 'revisit:' + s.revisit : '', s.duration !== 5000 ? `${s.duration}ms` : ''].filter(Boolean).join(' ');
      out.push(`  slide ${s.id} "${s.title}"${flags ? ' (' + flags + ')' : ''}`);
      if (s.question) out.push(`    question ${s.question.type} "${s.question.prompt}" ${answerKey(s.question)} pts=${s.question.points} attempts=${s.question.attempts}`);
      if (s.question && full) out.push(`    ${fmtFeedback(s.question.feedback, s.question.choices)}`);
      for (const o of s.objects) out.push('    ' + objLine(o));
      for (const t of s.triggers) out.push('    ' + fmtTrigger(t));
      for (const l of s.layers) {
        const lf = [l.modal ? 'modal' : '', l.pauseBase ? 'pauseBase' : '', !l.hideOthers ? 'keepOthers' : '', l.hideOnEnd ? 'hideOnEnd' : ''].filter(Boolean).join(' ');
        out.push(`    layer ${l.id} "${l.title}"${lf ? ' (' + lf + ')' : ''}`);
        for (const o of l.objects) out.push('      ' + objLine(o));
        for (const t of l.triggers) out.push('      ' + fmtTrigger(t));
      }
    }
  }
  for (const q of d.quizzes) out.push(`quiz ${q.id} "${q.title}" pass=${q.passPercent}% questions=${q.questions.join(',')}${q.results ? ' results=' + q.results : ''}`);
  out.push(`tracking: ${d.tracking.complete.map((c) => c.quiz ? 'quiz ' + c.quiz : `viewed ${c.slidesViewed ?? c.lessonsViewed}%`).join(' or ')} → ${d.tracking.status}`);
  return out.join('\n');
}

// ---------- queries (read-only) ----------
const argsOf = (def) => toJsonSchema(def.args);
export const queries = {
  'commands.list': { summary: 'List all commands with summaries.', run: () => Object.values(commands).filter((c) => c.name !== 'course.replace').map((c) => ({ name: c.name, summary: c.summary })) },
  'commands.help': { summary: 'Full definition of one command: args JSON Schema and examples.', run: (_d, a) => { const c = commands[a?.name]; if (!c) throw new Error(`unknown command "${a?.name}"`); return { name: c.name, summary: c.summary, args: argsOf(c), examples: c.examples.map((x) => ({ cmd: c.name, args: x })) }; } },
  'course.describe': { summary: 'Compact text outline of the whole course.', run: (d) => describe(d) },
  'course.get': { summary: 'The full course document (canonical JSON).', run: (d) => JSON.parse(serialize(d)) },
  'slide.get': { summary: 'One slide by id.', run: (d, a) => { const s = normalize(d).slides.find((x) => x.id === a?.id); if (!s) throw new Error(`slide "${a?.id}" not found`); return s; } },
  'find': { summary: 'Find objects/slides/triggers by id, type or text substring.', run: (d, a = {}) => {
    const n = normalize(d); const hits = [];
    for (const s of n.slides) {
      if (a.id === s.id || (a.text && s.title.toLowerCase().includes(a.text.toLowerCase()))) hits.push({ kind: 'slide', id: s.id, title: s.title });
      for (const [o, layer] of [...s.objects.map((o) => [o, null]), ...s.layers.flatMap((l) => l.objects.map((o) => [o, l.id]))]) {
        if ((a.id && o.id === a.id) || (a.type && o.type === a.type) || (a.text && (o.text || '').toLowerCase().includes(a.text.toLowerCase()))) hits.push({ kind: 'object', id: o.id, type: o.type, slide: s.id, layer, text: o.text });
      }
    }
    if (a.id) { const hit = locate(n, a.id); if (hit && hit.kind !== 'object') hits.push({ kind: hit.kind, id: a.id, slide: hit.slide.id }); }
    const has = (s) => !!a.text && typeof s === 'string' && s.toLowerCase().includes(a.text.toLowerCase());
    const strings = (x) => (typeof x === 'string' ? [x] : x && typeof x === 'object' ? Object.values(x).flatMap(strings) : []);
    for (const s of n.sections) for (const l of s.lessons) {
      if (a.id === l.id || has(l.title)) hits.push({ kind: 'lesson', id: l.id, title: l.title, section: s.id });
      for (const b of l.blocks) if (a.id === b.id || a.type === b.type || strings(b).some(has)) hits.push({ kind: 'block', id: b.id, type: b.type, lesson: l.id, text: b.text ?? b.prompt ?? b.label });
    }
    return hits;
  } },
  'lesson.get': { summary: 'One lesson (with its blocks) by id.', run: (d, a) => { const l = normalize(d).sections.flatMap((s) => s.lessons).find((x) => x.id === a?.id); if (!l) throw new Error(`lesson "${a?.id}" not found`); return l; } },
  'slide.export': { summary: 'A reusable slide package {kind:"cf.slide/1", slide, variables, assets} for slide.import (into this or another course).', run: (d, a) => exportSlide(normalize(d), a?.id) },
  'lesson.export': { summary: 'Lessons mode: a reusable lesson package {kind:"cf.lesson/1", lesson, assets} for lesson.import.', run: (d, a) => {
    const n = normalize(d); const lesson = n.sections.flatMap((x) => x.lessons).find((l) => l.id === a?.id);
    if (!lesson) throw new Error(`lesson "${a?.id}" not found`);
    const text = JSON.stringify(lesson);
    return { kind: 'cf.lesson/1', lesson: structuredClone(lesson), assets: n.assets.filter((x) => text.includes(`"${x.id}"`)) };
  } },
  'validate': { summary: 'Validation errors ([] = valid).', run: (d) => validate(d) },
  'a11y': { summary: 'Accessibility issues (alt text, names, labels, contrast, tab order, timing, titles) with the command that fixes each.', run: (d) => a11yIssues(normalize(d)) },
  'schema': { summary: 'JSON Schema of the course document.', run: () => jsonSchema() },
  'theme.list': { summary: 'Theme presets {name, label, scheme, tokens}, fonts {name, label, stack} and the current {preset, font} (theme.apply applies them).', run: (d) => ({
    presets: Object.entries(PRESETS).map(([name, p]) => ({ name, ...p })),
    fonts: Object.entries(FONTS).map(([name, f]) => ({ name, ...f })),
    current: themeOf(d ? normalize(d).player.theme : undefined),
  }) },
  'library.list': { summary: 'Original images in the CourseForge Studio library [{id, file, title, tags, alt}]; {tag} keeps entries with that tag, {q} matches id, title, tags or alt (case-insensitive). Add one with asset.add {library: id}.', run: (_d, a = {}) => {
    const q = String(a.q ?? '').trim().toLowerCase();
    return LIBRARY.filter((x) => (!a.tag || x.tags.includes(a.tag)) && (!q || [x.id, x.title, x.alt, ...x.tags].some((s) => s.toLowerCase().includes(q))));
  } },
};

// Reusable interactions: the slide plus the variables and assets it uses.
function exportSlide(d, id) {
  const slide = d.slides.find((x) => x.id === id);
  if (!slide) throw new Error(`slide "${id}" not found`);
  const text = JSON.stringify(slide);
  const used = (name) => [`"var":"${name}"`, `"fromVar":"${name}"`, `"otherVar":"${name}"`, `%${name}%`].some((k) => text.includes(k));
  const imgs = new Set([...slide.objects, ...slide.layers.flatMap((l) => l.objects)].flatMap((o) => [o.image, o.media, o.captions, o.poster, ...Object.values(o.states || {}).map((st) => st.image)]).filter(Boolean));
  return { kind: 'cf.slide/1', slide: structuredClone(slide), variables: d.variables.filter((v) => used(v.name)), assets: d.assets.filter((x) => imgs.has(x.id)) };
}

/** Run a read-only query by name. Returns {ok, data} or {ok:false, errors}. */
export function query(doc, name, args) {
  const q = queries[name];
  if (!q) return fail([{ path: '/name', code: 'enum', message: `unknown query "${name}"`, hint: `queries: ${Object.keys(queries).join(', ')}` }]);
  try { return { ok: true, data: q.run(doc, args) }; } catch (e) { return fail([{ path: '/args', code: 'ref', message: e.message }]); }
}

