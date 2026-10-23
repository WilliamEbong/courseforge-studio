// P0 command set. Each command: { name, summary, args (schema-lite), examples, run(d, a, ctx) -> result }.
// `d` is a private working copy of the normalized document; run mutates it in place. apply() handles cloning,
// validation and undo. Errors thrown with cmdError() become machine-actionable {path, code, message, hint}.
import {
  objectSchema, layerSchema, triggerSchema, questionSchema, slideSchema, courseSchema, eventSchema, actionSchema, condSchema, drawSchema,
  newId, allIds, ID, VAR_NAME, BUILTIN_STATES, normalize, validate, blockSchema, BLOCK_TYPES, lessonSchema, QUIZ_FIELDS,
} from '../schema/index.js';
import { replaceRichVariables } from '../schema/rich.js';
import { PRESETS, PRESET_TOKENS, FONTS } from '../schema/themes.js';
import LIBRARY from '../library/index.json' with { type: 'json' }; // original images shipped in packages/library

export const cmdError = (path, code, message, hint) => Object.assign(new Error(message), { cmdErrors: [{ path, code, message, ...(hint ? { hint } : {}) }] });

// ---------- lookups ----------
const ids = (list) => list.map((x) => x.id).join(', ') || '(none)';
export function slideOf(d, id) {
  const s = d.slides.find((x) => x.id === id);
  if (!s) throw cmdError('/args/slide', 'ref', `slide "${id}" not found`, `existing slides: ${ids(d.slides)}`);
  return s;
}
function bankOf(d, id, argPath = '/args/id') {
  const b = d.banks.find((x) => x.id === id);
  if (!b) throw cmdError(argPath, 'ref', `bank "${id}" not found`, `banks: ${ids(d.banks)}; add one with bank.add`);
  return b;
}
export function locate(d, id) {
  for (const slide of d.slides) {
    let i = slide.objects.findIndex((o) => o.id === id);
    if (i >= 0) return { kind: 'object', slide, list: slide.objects, index: i, item: slide.objects[i], layer: null };
    i = slide.triggers.findIndex((t) => t.id === id);
    if (i >= 0) return { kind: 'trigger', slide, list: slide.triggers, index: i, item: slide.triggers[i], layer: null };
    for (const layer of slide.layers) {
      if (layer.id === id) return { kind: 'layer', slide, list: slide.layers, index: slide.layers.indexOf(layer), item: layer, layer: null };
      i = layer.objects.findIndex((o) => o.id === id);
      if (i >= 0) return { kind: 'object', slide, list: layer.objects, index: i, item: layer.objects[i], layer };
      i = layer.triggers.findIndex((t) => t.id === id);
      if (i >= 0) return { kind: 'trigger', slide, list: layer.triggers, index: i, item: layer.triggers[i], layer };
    }
  }
  return null;
}
const need = (d, id, kind, argPath = '/args/id') => {
  const hit = locate(d, id);
  if (!hit || hit.kind !== kind) {
    const all = d.slides.flatMap((s) => kind === 'layer' ? s.layers : kind === 'object' ? [...s.objects, ...s.layers.flatMap((l) => l.objects)] : [...s.triggers, ...s.layers.flatMap((l) => l.triggers)]);
    throw cmdError(argPath, 'ref', `${kind} "${id}" not found`, `existing ${kind}s: ${ids(all.slice(0, 20))}`);
  }
  return hit;
};
const lessonsOf = (d) => d.sections.flatMap((s) => s.lessons);
const blocksOf = (d) => lessonsOf(d).flatMap((l) => l.blocks);
function sectionOf(d, id, argPath = '/args/id') {
  const s = d.sections.find((x) => x.id === id);
  if (!s) throw cmdError(argPath, 'ref', `section "${id}" not found`, `sections: ${ids(d.sections)}`);
  return s;
}
function findLesson(d, id, argPath = '/args/id') {
  for (const section of d.sections) { const index = section.lessons.findIndex((l) => l.id === id); if (index >= 0) return { section, list: section.lessons, index, item: section.lessons[index] }; }
  throw cmdError(argPath, 'ref', `lesson "${id}" not found`, `lessons: ${ids(lessonsOf(d).slice(0, 20))}`);
}
function findBlock(d, id, argPath = '/args/id') {
  for (const lesson of lessonsOf(d)) { const index = lesson.blocks.findIndex((b) => b.id === id); if (index >= 0) return { lesson, list: lesson.blocks, index, item: lesson.blocks[index] }; }
  throw cmdError(argPath, 'ref', `block "${id}" not found`, `blocks: ${ids(blocksOf(d).slice(0, 20))}`);
}
// Give blocks without an id a fresh one (agents may omit block ids in lesson.add).
/** outline.add {text}: the plain outline the editor dialog sends (and agents may), parsed into outline.add sections. */
function parseOutline(text) {
  const sections = [];
  let sec = null, it = null, m;
  const fail = (n, msg) => { throw cmdError('/args/text', 'outline', `line ${n}: ${msg}`, 'sections start with "# ", items with "## ", bullets with "- ", a question with "? ", its choices with "[x] " (correct) or "[ ] ", fill-in answers with "= "'); };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim(), n = i + 1;
    if (!line) return;
    if ((m = /^##\s+(.+)$/.exec(line))) {
      if (!sec) sections.push((sec = { title: 'Section 1', items: [] }));
      sec.items.push((it = { title: m[1] }));
    } else if ((m = /^#\s+(.+)$/.exec(line))) { sections.push((sec = { title: m[1], items: [] })); it = null; }
    else if (!it) fail(n, 'text before the first "## " item');
    else if ((m = /^\?\s+(.+)$/.exec(line))) { if (it.question) fail(n, 'one question per item'); it.question = { type: 'fill', prompt: m[1] }; }
    else if ((m = /^\[( |x|X)\]\s+(.+)$/.exec(line))) {
      const q = it.question;
      if (!q || q.answers) fail(n, 'a choice needs a "? " question above it');
      (q.choices ??= []).push({ label: m[2], correct: m[1] !== ' ' });
      q.type = q.choices.filter((c) => c.correct).length > 1 ? 'mr' : 'mc';
    } else if ((m = /^=\s+(.+)$/.exec(line))) { const q = it.question; if (!q || q.choices) fail(n, 'an answer needs a fill-in "? " question above it'); (q.answers ??= []).push(m[1]); }
    else if ((m = /^[-*•]\s+(.+)$/.exec(line))) (it.bullets ??= []).push(m[1]);
    else it.text = it.text ? `${it.text}\n${line}` : line;
  });
  if (!sections.some((x) => x.items.length)) fail(1, 'no "## " item found');
  return sections.filter((x) => x.items.length);
}

function idBlocks(d, blocks, ctx, extra = []) {
  const taken = allIds(d);
  for (const x of [...extra, ...blocks.map((b) => b.id)]) if (x !== undefined) taken.add(x);
  for (const b of blocks) if (b.id === undefined) { b.id = newId('b', taken, ctx.rng); taken.add(b.id); }
  return blocks;
}
const insertAt = (list, item, index) => { const i = index === undefined ? list.length : Math.max(0, Math.min(index, list.length)); list.splice(i, 0, item); return i; };
const takeId = (d, wanted, prefix, ctx, argPath = '/args/id') => {
  const taken = allIds(d);
  if (wanted !== undefined) { if (taken.has(wanted)) throw cmdError(argPath, 'dupe', `id "${wanted}" already used`, 'omit id to generate one'); return wanted; }
  return newId(prefix, taken, ctx.rng);
};
const pick = (a, keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const assignFields = (target, a, keys) => { for (const k of keys) if (a[k] !== undefined) { if (a[k] === null) delete target[k]; else target[k] = structuredClone(a[k]); } };

// References to an id from anywhere in the doc (for safe removal).
export function refsTo(d, id) {
  const out = [];
  d.scenes.forEach((sc, i) => sc.slides.forEach((s, j) => { if (s === id) out.push(`/scenes/${i}/slides/${j}`); }));
  d.banks.forEach((b, i) => b.slides.forEach((s, j) => { if (s === id) out.push(`/banks/${i}/slides/${j}`); }));
  d.slides.forEach((s, i) => { if (!s.draw) return; if (s.draw.bank === id) out.push(`/slides/${i}/draw/bank`); for (const k of ['always', 'never']) s.draw[k].forEach((x, j) => { if (x === id) out.push(`/slides/${i}/draw/${k}/${j}`); }); });
  d.quizzes.forEach((q, i) => { q.questions.forEach((s, j) => { if (s === id) out.push(`/quizzes/${i}/questions/${j}`); }); if (q.results === id) out.push(`/quizzes/${i}/results`); });
  d.tracking.complete.forEach((c, i) => { if (c.quiz === id) out.push(`/tracking/complete/${i}`); });
  d.slides.forEach((s, i) => {
    const scanObjs = (objs, base) => objs.forEach((o, j) => {
      for (const k of ['image', 'media', 'captions', 'poster']) if (o[k] === id) out.push(`${base}/${j}/${k}`);
      for (const [k, st] of Object.entries(o.states || {})) if (st.image === id) out.push(`${base}/${j}/states/${k}/image`);
    });
    scanObjs(s.objects, `/slides/${i}/objects`);
    const scanTrig = (trs, base) => trs.forEach((t, j) => {
      const tp = `${base}/${j}`;
      if (t.on.target === id) out.push(`${tp}/on/target`);
      [...(t.if?.all || []), ...(t.if?.any || [])].forEach((c) => { if (c.target === id) out.push(`${tp}/if`); });
      [...t.do, ...(t.else || [])].forEach((a) => { if ([a.target, a.layer, a.to, a.quiz].includes(id)) out.push(`${tp}/do`); });
      const qv = (n) => typeof n === 'string' && n.startsWith(id + '.');
      if (qv(t.on.var) || [...(t.if?.all || []), ...(t.if?.any || [])].some((c) => qv(c.var) || qv(c.otherVar)) || [...t.do, ...(t.else || [])].some((a) => qv(a.var) || qv(a.fromVar))) out.push(`${tp}/vars`);
    });
    scanTrig(s.triggers, `/slides/${i}/triggers`);
    s.layers.forEach((l, j) => { scanObjs(l.objects, `/slides/${i}/layers/${j}/objects`); scanTrig(l.triggers, `/slides/${i}/layers/${j}/triggers`); });
  });
  // lessons mode: the cover and blocks refer to assets; button blocks refer to lessons
  if (d.cover?.image === id) out.push('/cover/image');
  d.sections.forEach((s, i) => s.lessons.forEach((l, j) => l.blocks.forEach((b, k) => {
    const bp = `/sections/${i}/lessons/${j}/blocks/${k}`;
    for (const key of ['toLesson', 'image', 'media', 'captions']) if (b[key] === id) out.push(`${bp}/${key}`);
    if (b.type === 'gallery') b.items.forEach((x, n) => { if (x.image === id) out.push(`${bp}/items/${n}/image`); });
    if (b.type === 'scenario') b.scenes.forEach((x, n) => { for (const key of ['background', 'character']) if (x[key] === id) out.push(`${bp}/scenes/${n}/${key}`); });
  })));
  return [...new Set(out)];
}
// Remove triggers/list entries that reference id (used by force removals).
function purgeRefs(d, id) {
  for (const sc of [...d.scenes, ...d.banks]) sc.slides = sc.slides.filter((s) => s !== id);
  for (const s of d.slides) if (s.draw) for (const k of ['always', 'never']) s.draw[k] = s.draw[k].filter((x) => x !== id);
  for (const q of d.quizzes) { q.questions = q.questions.filter((s) => s !== id); if (q.results === id) delete q.results; }
  d.tracking.complete = d.tracking.complete.filter((c) => c.quiz !== id);
  const qv = (n) => typeof n === 'string' && n.startsWith(id + '.');
  const hits = (t) => t.on.target === id || qv(t.on.var) || [...(t.if?.all || []), ...(t.if?.any || [])].some((c) => c.target === id || qv(c.var) || qv(c.otherVar)) || [...t.do, ...(t.else || [])].some((a) => [a.target, a.layer, a.to, a.quiz].includes(id) || qv(a.var) || qv(a.fromVar));
  for (const s of d.slides) {
    s.triggers = s.triggers.filter((t) => !hits(t));
    for (const l of s.layers) l.triggers = l.triggers.filter((t) => !hits(t));
    for (const o of [...s.objects, ...s.layers.flatMap((l) => l.objects)]) { for (const k of ['image', 'media', 'captions', 'poster']) if (o[k] === id) delete o[k]; for (const st of Object.values(o.states || {})) if (st.image === id) delete st.image; }
  }
  if (d.cover?.image === id) delete d.cover.image;
  for (const l of d.sections.flatMap((s) => s.lessons)) {
    l.blocks = l.blocks.filter((b) => ![b.toLesson, b.image, b.media].includes(id)); // blocks that cannot exist without the target
    for (const b of l.blocks) { if (b.captions === id) delete b.captions; if (b.type === 'gallery') b.items = b.items.filter((x) => x.image !== id); }
    for (const s of l.blocks.flatMap((b) => (b.type === 'scenario' ? b.scenes : []))) for (const key of ['background', 'character']) if (s[key] === id) { delete s[key]; delete s[`${key}Alt`]; }
  }
}
function guardRemove(d, id, force, label) {
  const refs = refsTo(d, id);
  if (refs.length && !force) throw cmdError('/args/id', 'ref', `${label} "${id}" is still referenced (${refs.length})`, `referenced at ${refs.slice(0, 6).join(', ')}; pass force:true to also remove those triggers/entries`);
  if (refs.length) purgeRefs(d, id);
}
// ----- Review quiz button: an ordinary button plus a click trigger, like the generated Retry -----
const reviewParts = (sid, quizId, h) => ({
  object: { id: `${sid}-review`, type: 'button', x: 80, y: h - 220, w: 240, h: 60, text: 'Review quiz', style: { fontSize: 22, radius: 8 } },
  trigger: { id: `${sid}-review-t`, on: { event: 'click', target: `${sid}-review` }, do: [{ action: 'reviewQuiz', quiz: quizId }] },
});
function setReview(d, q, on) {
  const s = q.results && d.slides.find((x) => x.id === q.results);
  if (!s) throw cmdError('/args/review', 'semantic', `quiz "${q.id}" has no results slide`, 'set results first, or add one with quiz.addResults');
  const reviews = (t) => t.on.event === 'click' && [...t.do, ...(t.else || [])].some((x) => x.action === 'reviewQuiz' && x.quiz === q.id);
  const buttons = [s, ...s.layers].flatMap((c) => c.triggers.filter(reviews).map((t) => t.on.target));
  if (on && !buttons.length) {
    const rv = reviewParts(s.id, q.id, d.size.h);
    for (const x of [rv.object.id, rv.trigger.id]) if (allIds(d).has(x)) throw cmdError('/args/review', 'dupe', `generated id "${x}" already exists`, 'rename or remove that object or trigger first');
    s.objects.push(rv.object); s.triggers.push(rv.trigger);
  }
  if (!on) for (const oid of buttons) { purgeRefs(d, oid); for (const c of [s, ...s.layers]) c.objects = c.objects.filter((o) => o.id !== oid); } // the button and every trigger about it
}
function varRefs(d, name) {
  const out = [];
  d.slides.forEach((s, i) => {
    const trs = [...s.triggers.map((t, j) => [t, `/slides/${i}/triggers/${j}`]), ...s.layers.flatMap((l, j) => l.triggers.map((t, k) => [t, `/slides/${i}/layers/${j}/triggers/${k}`]))];
    for (const [t, p] of trs) {
      if (t.on.var === name) out.push(p + '/on');
      if ([...(t.if?.all || []), ...(t.if?.any || [])].some((c) => c.var === name || c.otherVar === name)) out.push(p + '/if');
      if ([...t.do, ...(t.else || [])].some((a) => a.var === name || a.fromVar === name)) out.push(p + '/do');
    }
    for (const o of [...s.objects, ...s.layers.flatMap((l) => l.objects)]) if (o.var === name) out.push(`/slides/${i} object ${o.id}`);
  });
  return out;
}

// Re-id every object/layer/trigger inside a cloned slide; remap internal references.
function reid(d, slide, ctx, srcId) {
  const taken = allIds(d);
  const map = new Map([[srcId, slide.id]]);
  const fresh = (old, prefix) => { const n = newId(prefix, taken, ctx.rng); taken.add(n); map.set(old, n); return n; };
  for (const o of slide.objects) o.id = fresh(o.id, 'o');
  for (const l of slide.layers) { l.id = fresh(l.id, 'l'); for (const o of l.objects) o.id = fresh(o.id, 'o'); }
  const fixTrig = (t) => {
    t.id = fresh(t.id, 't');
    if (map.has(t.on.target)) t.on.target = map.get(t.on.target);
    for (const c of [...(t.if?.all || []), ...(t.if?.any || [])]) if (map.has(c.target)) c.target = map.get(c.target);
    for (const a of [...t.do, ...(t.else || [])]) { if (map.has(a.target)) a.target = map.get(a.target); if (map.has(a.layer)) a.layer = map.get(a.layer); if (a.action === 'jump' && map.has(a.to)) a.to = map.get(a.to); }
  };
  slide.triggers.forEach(fixTrig);
  slide.layers.forEach((l) => l.triggers.forEach(fixTrig));
  const q = slide.question; // drag-and-drop items and targets name objects of this slide
  for (const x of [...(q?.items || []), ...(q?.targets || [])]) { if (map.has(x.object)) x.object = map.get(x.object); if (map.has(x.target)) x.target = map.get(x.target); }
  return map;
}

// ---------- arg schema helpers ----------
const S = (props, required = []) => ({ type: 'object', additionalProperties: false, required, properties: props });
const idArg = { type: 'string', pattern: ID };
const objFields = Object.fromEntries(Object.entries(objectSchema.properties).filter(([k]) => k !== 'id'));
const slideFields = ['title', 'duration', 'advance', 'revisit', 'background', 'notes'];
const layerFields = ['title', 'duration', 'hideOthers', 'hideBaseObjects', 'hideOnEnd', 'modal', 'pauseBase', 'revisit'];
const nullable = (s) => ({ ...s, type: [].concat(s.type || 'any').concat('null'), ...(s.enum ? { enum: [...s.enum, null] } : {}) });
// block.set takes the fields of every block type; a field whose shape differs by type is checked by document validation.
const blockFields = {};
for (const t of Object.values(BLOCK_TYPES)) for (const [k, v] of Object.entries(t.properties)) {
  blockFields[k] = blockFields[k] && JSON.stringify(blockFields[k]) !== JSON.stringify(v) ? { type: [...new Set([].concat(blockFields[k].type, v.type))], description: 'shape depends on the block type' } : v;
}
const newBlock = { ...blockSchema, required: [] }; // id optional: generated
const lessonFields = ['title', 'kind', ...QUIZ_FIELDS];
// Style args: every key nullable; null deletes that key. One merge rule for object.set and state.set.
const styleArg = nullable({ ...objectSchema.properties.style, properties: Object.fromEntries(Object.entries(objectSchema.properties.style.properties).map(([k, v]) => [k, nullable(v)])) });
const blockStyleArg = nullable({ ...blockSchema.properties.style, properties: Object.fromEntries(Object.entries(blockSchema.properties.style.properties).map(([k, v]) => [k, nullable(v)])) });
function mergeStyle(target, style) {
  if (style === undefined) return;
  const s = style === null ? {} : { ...(target.style || {}), ...structuredClone(style) };
  for (const k of Object.keys(s)) if (s[k] === null) delete s[k];
  if (Object.keys(s).length) target.style = s; else delete target.style;
}
// Objects named by ids, all on one slide (multi-object commands).
function objsOn(d, list) {
  if (!list.length) throw cmdError('/args/ids', 'required', 'pass at least one object id');
  if (new Set(list).size !== list.length) throw cmdError('/args/ids', 'dupe', 'ids repeats an object id');
  const hits = list.map((id) => need(d, id, 'object', '/args/ids'));
  if (hits.some((x) => x.slide !== hits[0].slide)) throw cmdError('/args/ids', 'semantic', 'objects must be on the same slide', `slides: ${[...new Set(hits.map((x) => x.slide.id))].join(', ')}`);
  return hits;
}
const idsArg = { type: 'array', items: idArg };

export const commands = [
  // ----- course -----
  {
    name: 'course.set', summary: 'Set course title, description, language, slide size, mode (slides|lessons; switching swaps slidesViewed/lessonsViewed tracking) or lessons cover {image, alt} (null removes).',
    args: S({ title: { type: 'string' }, description: { type: 'string' }, language: { type: 'string' }, size: courseSchema.properties.size, mode: { type: 'string', enum: ['slides', 'lessons'] }, cover: nullable(courseSchema.properties.cover) }),
    examples: [{ title: 'Lab Safety 101', size: { w: 1280, h: 720 } }, { mode: 'lessons', title: 'Lab Basics', description: 'Three short lessons and a quiz.' }],
    run(d, a) {
      if (a.mode && a.mode !== d.mode) {
        const [from, to] = a.mode === 'lessons' ? ['slidesViewed', 'lessonsViewed'] : ['lessonsViewed', 'slidesViewed'];
        for (const c of d.tracking.complete) if (c[from] !== undefined) { c[to] = c[from]; delete c[from]; }
      }
      assignFields(d, a, ['title', 'description', 'language', 'size', 'mode', 'cover']);
      return {};
    },
  },
  {
    name: 'player.set', summary: 'Player options: style (modern|classic), menu, prev/next buttons, resume behavior (prompt|always|never), theme tokens.',
    args: courseSchema.properties.player, examples: [{ menu: true, prevNext: true, resume: 'prompt' }],
    run(d, a) { Object.assign(d.player, structuredClone(a)); return {}; },
  },
  {
    name: 'theme.apply', summary: `Apply a theme preset and/or font to both players. preset: ${Object.keys(PRESETS).join('|')} (writes the full preset token set into player.theme, replacing the previous preset; auto removes it so the player uses its selected style or device setting; presets are explicit schemes). font: ${Object.keys(FONTS).join('|')} (system font stacks; system removes the font tokens). Other custom theme tokens stay; the theme.list query shows every preset's tokens.`,
    args: S({ preset: { type: 'string', enum: Object.keys(PRESETS) }, font: { type: 'string', enum: Object.keys(FONTS) } }),
    examples: [{ preset: 'charcoal' }, { preset: 'ocean', font: 'serif' }, { preset: 'auto' }],
    run(d, a) {
      if (a.preset === undefined && a.font === undefined) throw cmdError('/args', 'required', 'pass preset, font or both', `presets: ${Object.keys(PRESETS).join(', ')}; fonts: ${Object.keys(FONTS).join(', ')}`);
      const t = { ...(d.player.theme || {}) };
      if (a.preset !== undefined) { for (const k of PRESET_TOKENS) delete t[k]; Object.assign(t, PRESETS[a.preset].tokens); }
      if (a.font !== undefined) { delete t.font; delete t.serif; const stack = FONTS[a.font].stack; if (stack) t.font = t.serif = stack; } // serif: the lessons heading face
      if (Object.keys(t).length) d.player.theme = t; else delete d.player.theme;
      return pick(a, ['preset', 'font']);
    },
  },
  {
    name: 'tracking.set', summary: 'LMS completion criteria (first met wins) and status reporting mode.',
    args: courseSchema.properties.tracking, examples: [{ complete: [{ quiz: 'qz-final' }], status: 'passed-failed' }, { complete: [{ slidesViewed: 100 }] }],
    run(d, a) { assignFields(d.tracking, a, ['complete', 'status']); return {}; },
  },
  {
    name: 'outline.add',
    summary: 'Scaffold content from a structured outline (AI generation hook): each section becomes a scene (slides mode) or a section (lessons mode); each item becomes a slide or a lesson with its title, text and bullets; an item question becomes a question slide or a knowledge-check block. Deterministic for a given rng; returns the new ids.',
    args: S({
      sections: { type: 'array', items: S({ title: { type: 'string' }, items: { type: 'array', items: S({ title: { type: 'string' }, text: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } },
        question: S({ type: { type: 'string', enum: ['mc', 'mr', 'tf', 'fill'] }, prompt: { type: 'string' }, choices: { type: 'array', items: S({ label: { type: 'string' }, correct: { type: 'boolean' } }, ['label']) }, answers: { type: 'array', items: { type: 'string' } } }, ['type', 'prompt']) }, ['title']) } }, ['title', 'items']) },
      text: { type: 'string', description: 'the same outline as plain text instead of sections: "# Section", "## Item", text lines, "- bullet", "? question" then "[x] correct" / "[ ] wrong" choices (two or more [x] = multiple response) or "= accepted answer" lines (fill-in)' },
    }),
    examples: [{ sections: [{ title: 'Basics', items: [{ title: 'Why it matters', text: 'Most incidents start small.', bullets: ['Wear goggles', 'Label everything'], question: { type: 'mc', prompt: 'What first?', choices: [{ label: 'Goggles', correct: true }, { label: 'Coffee' }] } }] }] },
      { text: '# Basics\n## Why it matters\nMost incidents start small.\n- Wear goggles\n? What first?\n[x] Goggles\n[ ] Coffee' }],
    run(d, a, ctx) {
      if (!a.sections === !a.text) throw cmdError('/args', 'required', 'give either sections or text', 'text is the plain outline that the editor From outline dialog sends');
      if (a.text) a = { sections: parseOutline(a.text) };
      const taken = allIds(d);
      const fresh = (prefix) => { const n = newId(prefix, taken, ctx.rng); taken.add(n); return n; };
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      const choicesOf = (q) => (q.type === 'tf' && !q.choices?.length ? [{ label: 'True', correct: true }, { label: 'False' }] : q.choices || []).map((c, i) => ({ id: letters[i], label: c.label, correct: !!c.correct }));
      const out = { scenes: [], sections: [], slides: [], lessons: [] };
      if (d.mode === 'lessons') {
        for (const sec of a.sections) {
          const section = { id: fresh('sec'), title: sec.title, lessons: [] };
          for (const it of sec.items) {
            const blocks = [{ type: 'heading', text: it.title }];
            if (it.text) blocks.push({ type: 'text', text: it.text });
            if (it.bullets?.length) blocks.push({ type: 'list', items: it.bullets });
            if (it.question) {
              const q = it.question;
              if (q.type === 'tf') throw cmdError('/args/sections', 'semantic', 'knowledge checks in lessons mode take mc, mr or fill (tf is a slides-mode question)', 'use mc with True/False choices');
              blocks.push({ type: 'question', kind: q.type, prompt: q.prompt, ...(q.type === 'fill' ? { answers: q.answers || [] } : { choices: choicesOf(q) }) });
            }
            const lesson = { id: fresh('l'), title: it.title, blocks: idBlocks(d, blocks, ctx, [...taken]) };
            for (const b of lesson.blocks) taken.add(b.id);
            section.lessons.push(lesson); out.lessons.push(lesson.id);
          }
          d.sections.push(section); out.sections.push(section.id);
        }
        return out;
      }
      for (const sec of a.sections) {
        const scene = { id: fresh('sc'), title: sec.title, slides: [] };
        for (const it of sec.items) {
          const body = [it.text, ...(it.bullets || []).map((x) => `• ${x}`)].filter(Boolean).join('\n');
          const slide = { id: fresh('s'), title: it.title, objects: [
            { id: fresh('o'), type: 'text', text: it.title, x: 80, y: 60, w: 1120, h: 90, style: { fontSize: 44, bold: true } },
            ...(body ? [{ id: fresh('o'), type: 'text', text: body, x: 80, y: 180, w: 1120, h: 420, style: { fontSize: 26 } }] : []),
          ], layers: [], triggers: [] };
          d.slides.push(slide); scene.slides.push(slide.id); out.slides.push(slide.id);
          if (it.question) {
            const q = it.question;
            const qs = { id: fresh('s'), title: `${it.title}: check`, objects: [], layers: [], triggers: [], question: { type: q.type, prompt: q.prompt, ...(q.type === 'fill' ? { answers: q.answers || [] } : { choices: choicesOf(q) }) } };
            d.slides.push(qs); scene.slides.push(qs.id); out.slides.push(qs.id);
          }
        }
        d.scenes.push(scene); out.scenes.push(scene.id);
      }
      return out;
    },
  },
  {
    name: 'course.replace', summary: 'Replace the whole document (used by undo; prefer specific commands).',
    args: S({ doc: { type: 'object' } }, ['doc']), examples: [],
    run(d, a) {
      const errs = validate(a.doc); // later commands in a batch must never see an invalid document (review 003 #7)
      if (errs.length) throw cmdError(`/args/doc${errs[0].path === '/' ? '' : errs[0].path}`, errs[0].code, `replacement document is invalid: ${errs[0].message}`, errs[0].hint);
      const n = normalize(a.doc); for (const k of Object.keys(d)) delete d[k]; Object.assign(d, n); return {};
    },
  },
  // ----- scenes -----
  {
    name: 'scene.add', summary: 'Add a scene (a group of slides).', args: S({ id: idArg, title: { type: 'string' }, index: { type: 'integer', minimum: 0 } }),
    examples: [{ title: 'Module 1' }],
    run(d, a, ctx) { const id = takeId(d, a.id, 'sc', ctx); insertAt(d.scenes, { id, title: a.title ?? 'Scene', slides: [] }, a.index); return { id }; },
  },
  {
    name: 'scene.set', summary: 'Rename a scene.', args: S({ id: idArg, title: { type: 'string' } }, ['id']), examples: [{ id: 'sc-1', title: 'Intro' }],
    run(d, a) { const sc = d.scenes.find((s) => s.id === a.id); if (!sc) throw cmdError('/args/id', 'ref', `scene "${a.id}" not found`, `scenes: ${ids(d.scenes)}`); assignFields(sc, a, ['title']); return {}; },
  },
  {
    name: 'scene.move', summary: 'Reorder a scene.', args: S({ id: idArg, index: { type: 'integer', minimum: 0 } }, ['id', 'index']), examples: [{ id: 'sc-2', index: 0 }],
    run(d, a) { const i = d.scenes.findIndex((s) => s.id === a.id); if (i < 0) throw cmdError('/args/id', 'ref', `scene "${a.id}" not found`, `scenes: ${ids(d.scenes)}`); const [sc] = d.scenes.splice(i, 1); insertAt(d.scenes, sc, a.index); return {}; },
  },
  {
    name: 'scene.remove', summary: 'Remove a scene; its slides must be moved first unless force:true (then they are deleted too).',
    args: S({ id: idArg, force: { type: 'boolean' } }, ['id']), examples: [{ id: 'sc-2' }],
    run(d, a) {
      const i = d.scenes.findIndex((s) => s.id === a.id);
      if (i < 0) throw cmdError('/args/id', 'ref', `scene "${a.id}" not found`, `scenes: ${ids(d.scenes)}`);
      const sc = d.scenes[i];
      if (sc.slides.length && !a.force) throw cmdError('/args/id', 'semantic', `scene "${a.id}" still has ${sc.slides.length} slide(s)`, 'move them with slide.move or pass force:true');
      if (d.scenes.length === 1) throw cmdError('/args/id', 'semantic', 'a course needs at least one scene');
      guardRemove(d, a.id, a.force, 'scene');
      for (const sid of [...sc.slides]) { d.slides = d.slides.filter((s) => s.id !== sid); purgeRefs(d, sid); }
      d.scenes.splice(d.scenes.findIndex((s) => s.id === a.id), 1);
      return {};
    },
  },
  // ----- question banks -----
  {
    name: 'bank.add', summary: 'Add a question bank: slides kept outside the flow that draw slides pick from (add slides with slide.add {bank}).',
    args: S({ id: idArg, title: { type: 'string' }, index: { type: 'integer', minimum: 0 } }), examples: [{ id: 'bk-safety', title: 'Safety questions' }],
    run(d, a, ctx) { const id = takeId(d, a.id, 'bk', ctx); insertAt(d.banks, { id, title: a.title ?? 'Question bank', slides: [] }, a.index); return { id }; },
  },
  {
    name: 'bank.set', summary: 'Rename a question bank.', args: S({ id: idArg, title: { type: 'string' } }, ['id']), examples: [{ id: 'bk-safety', title: 'Lab safety' }],
    run(d, a) { assignFields(bankOf(d, a.id), a, ['title']); return {}; },
  },
  {
    name: 'bank.remove', summary: 'Delete a question bank. Refused while a draw slide uses it; its slides must be moved first unless force:true (then they are deleted too).',
    args: S({ id: idArg, force: { type: 'boolean' } }, ['id']), examples: [{ id: 'bk-old' }],
    run(d, a) {
      const b = bankOf(d, a.id);
      const draws = d.slides.filter((s) => s.draw?.bank === a.id).map((s) => s.id);
      if (draws.length) throw cmdError('/args/id', 'ref', `draw slide(s) ${draws.join(', ')} draw from bank "${a.id}"`, 'point them at another bank with draw.set {id, bank} or delete them with slide.remove');
      if (b.slides.length && !a.force) throw cmdError('/args/id', 'semantic', `bank "${a.id}" still has ${b.slides.length} slide(s)`, 'move them with slide.move {id, scene} or pass force:true');
      for (const sid of [...b.slides]) { d.slides = d.slides.filter((s) => s.id !== sid); purgeRefs(d, sid); }
      d.banks.splice(d.banks.indexOf(b), 1);
      return {};
    },
  },
  // ----- slides -----
  {
    name: 'slide.add', summary: 'Add a slide (optionally with objects, layers, triggers and a question in one go) to a scene, or with bank to a question bank (outside the flow; reached through draw slides).',
    args: S({ id: idArg, scene: idArg, bank: idArg, index: { type: 'integer', minimum: 0 }, ...pick(slideSchema.properties, [...slideFields, 'objects', 'layers', 'triggers', 'question']) }),
    examples: [{ title: 'Welcome', objects: [{ id: 'o-title', type: 'text', x: 80, y: 60, w: 800, h: 80, text: 'Welcome!' }] }, { id: 's-q1', title: 'Check', question: { type: 'mc', prompt: 'Pick B', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', correct: true }] } },
      { id: 's-b1', bank: 'bk-safety', title: 'Bank question 1', question: { type: 'tf', prompt: 'Goggles protect your eyes', choices: [{ id: 't', label: 'True', correct: true }, { id: 'f', label: 'False' }] } }],
    run(d, a, ctx) {
      if (a.scene && a.bank) throw cmdError('/args/bank', 'semantic', 'pass scene or bank, not both');
      const sc = a.bank ? bankOf(d, a.bank, '/args/bank') : a.scene ? d.scenes.find((s) => s.id === a.scene) : d.scenes[d.scenes.length - 1];
      if (!sc) throw cmdError('/args/scene', 'ref', `scene "${a.scene}" not found`, `scenes: ${ids(d.scenes)}`);
      const id = takeId(d, a.id, 's', ctx);
      const slide = { id, ...pick(a, slideFields), objects: structuredClone(a.objects || []), layers: structuredClone(a.layers || []), triggers: structuredClone(a.triggers || []) };
      if (a.question) slide.question = structuredClone(a.question);
      d.slides.push(slide);
      insertAt(sc.slides, id, a.index);
      return { id, [a.bank ? 'bank' : 'scene']: sc.id };
    },
  },
  {
    name: 'slide.set', summary: 'Change slide properties (title, duration ms, advance user|auto, revisit auto|reset|resume, background, notes). background/notes: null removes.',
    args: S({ id: idArg, ...pick(slideSchema.properties, slideFields), background: nullable(slideSchema.properties.background), notes: nullable(slideSchema.properties.notes) }, ['id']),
    examples: [{ id: 's-intro', revisit: 'reset', advance: 'auto' }, { id: 's-intro', background: null }],
    run(d, a) { assignFields(slideOf(d, a.id), a, slideFields); return {}; },
  },
  {
    name: 'slide.move', summary: 'Move a slide within its scene or bank (index), to another scene (scene), into a question bank (bank) or from a bank back into the flow (scene).',
    args: S({ id: idArg, scene: idArg, bank: idArg, index: { type: 'integer', minimum: 0 } }, ['id']),
    examples: [{ id: 's-q1', index: 0 }, { id: 's-q1', scene: 'sc-2' }, { id: 's-q1', bank: 'bk-safety' }],
    run(d, a) {
      const s = slideOf(d, a.id);
      if (a.scene && a.bank) throw cmdError('/args/bank', 'semantic', 'pass scene or bank, not both');
      const from = [...d.scenes, ...d.banks].find((x) => x.slides.includes(a.id));
      const fromBank = d.banks.includes(from);
      const to = a.bank ? bankOf(d, a.bank, '/args/bank') : a.scene ? d.scenes.find((x) => x.id === a.scene) : from;
      if (!to) throw cmdError('/args/scene', 'ref', `scene "${a.scene}" not found`, `scenes: ${ids(d.scenes)}`);
      const toBank = d.banks.includes(to);
      if (toBank && !fromBank) { // a quiz entry would break
        if (s.draw) throw cmdError('/args/bank', 'semantic', `"${a.id}" is a draw slide`, 'draw slides stay in the flow');
        const quizzes = d.quizzes.filter((q) => q.questions.includes(a.id)).map((q) => q.id);
        if (quizzes.length) throw cmdError('/args/id', 'ref', `slide "${a.id}" is a question of quiz ${quizzes.join(', ')}`, `remove it from the quiz first (quiz.set {id, questions}); the quiz then lists a draw slide`);
      }
      if (fromBank && from !== to) {
        const draws = d.slides.filter((x) => x.draw && (x.draw.always.includes(a.id) || x.draw.never.includes(a.id))).map((x) => x.id);
        if (draws.length) throw cmdError('/args/id', 'ref', `slide "${a.id}" is listed in always/never of draw ${draws.join(', ')}`, 'remove it there first with draw.set {id, always, never}');
      }
      if (from) from.slides.splice(from.slides.indexOf(a.id), 1);
      insertAt(to.slides, a.id, a.index);
      return {};
    },
  },
  {
    name: 'slide.import',
    summary: 'Insert a reusable slide package (from the slide.export query, possibly from another course) with fresh ids. Missing variables and assets are added; triggers that point at slides, scenes or quizzes this course lacks are skipped (result.skipped).',
    args: S({ data: { type: 'object' }, scene: idArg, index: { type: 'integer', minimum: 0 }, newId: idArg }, ['data']),
    examples: [],
    run(d, a, ctx) {
      const pkg = a.data;
      if (pkg?.kind !== 'cf.slide/1' || !pkg.slide || typeof pkg.slide !== 'object') throw cmdError('/args/data', 'type', 'data must be a slide package {kind:"cf.slide/1", slide, variables, assets}', 'create one with the slide.export query');
      const sc = a.scene ? d.scenes.find((s) => s.id === a.scene) : d.scenes[d.scenes.length - 1];
      if (!sc) throw cmdError('/args/scene', 'ref', `scene "${a.scene}" not found`, `scenes: ${ids(d.scenes)}`);
      for (const v of pkg.variables || []) {
        const have = d.variables.find((x) => x.name === v.name);
        if (have && have.type !== v.type) throw cmdError('/args/data/variables', 'semantic', `variable "${v.name}" is ${have.type} here but ${v.type} in the package`, 'rename one of them first (var.set newName)');
        if (!have) d.variables.push(structuredClone(v));
      }
      const slide = structuredClone(pkg.slide);
      const srcId = slide.id;
      slide.id = takeId(d, a.newId, 's', ctx, '/args/newId');
      const assetMap = new Map();
      for (const as of pkg.assets || []) {
        const same = d.assets.find((x) => x.path === as.path);
        if (same) { assetMap.set(as.id, same.id); continue; }
        const id = allIds(d).has(as.id) ? newId('a', allIds(d), ctx.rng) : as.id;
        d.assets.push({ ...structuredClone(as), id });
        assetMap.set(as.id, id);
      }
      const objs = [...(slide.objects || []), ...(slide.layers || []).flatMap((l) => l.objects || [])];
      for (const o of objs) {
        for (const k of ['image', 'media', 'captions', 'poster']) if (assetMap.has(o[k])) o[k] = assetMap.get(o[k]); // media fields:
        for (const st of Object.values(o.states || {})) if (assetMap.has(st.image)) st.image = assetMap.get(st.image);
      }
      slide.objects ??= []; slide.layers ??= []; slide.triggers ??= [];
      for (const l of slide.layers) { l.objects ??= []; l.triggers ??= []; }
      const known = new Set([...d.slides.map((x) => x.id), srcId, 'next', 'prev']); // srcId: self-jumps are remapped by reid
      const out = { id: slide.id, scene: sc.id, skipped: [] }; // skipped lists the package's trigger ids
      const keep = (t) => {
        const acts = [...t.do, ...(t.else || [])];
        const bad = acts.some((x) => (x.action === 'jump' && !known.has(x.to)) || (x.action === 'jumpScene' && !d.scenes.some((y) => y.id === x.to)) || (['submitQuiz', 'resetQuiz', 'reviewQuiz'].includes(x.action) && !d.quizzes.some((y) => y.id === x.quiz)));
        if (bad) out.skipped.push(t.id);
        return !bad;
      };
      slide.triggers = slide.triggers.filter(keep);
      for (const l of slide.layers) l.triggers = l.triggers.filter(keep);
      reid(d, slide, ctx, srcId);
      d.slides.push(slide);
      insertAt(sc.slides, slide.id, a.index);
      return out;
    },
  },
  {
    name: 'slide.duplicate', summary: 'Duplicate a slide (new ids for everything inside) right after the original.',
    args: S({ id: idArg, newId: idArg, title: { type: 'string' } }, ['id']), examples: [{ id: 's-intro', title: 'Intro (copy)' }],
    run(d, a, ctx) {
      const src = slideOf(d, a.id);
      const copy = structuredClone(src);
      copy.id = takeId(d, a.newId, 's', ctx, '/args/newId');
      if (a.title) copy.title = a.title;
      ctx.copied?.(reid(d, copy, ctx, a.id));
      d.slides.push(copy);
      const sc = [...d.scenes, ...d.banks].find((s) => s.slides.includes(a.id)); // a bank slide's copy stays in the bank
      sc.slides.splice(sc.slides.indexOf(a.id) + 1, 0, copy.id);
      return { id: copy.id };
    },
  },
  {
    name: 'slide.remove', summary: 'Delete a slide. Fails if jumps/quizzes reference it unless force:true (removes those triggers/entries).',
    args: S({ id: idArg, force: { type: 'boolean' } }, ['id']), examples: [{ id: 's-old' }],
    run(d, a) {
      slideOf(d, a.id);
      const refs = refsTo(d, a.id).filter((p) => !/^\/(scenes|banks)\//.test(p));
      if (refs.length && !a.force) throw cmdError('/args/id', 'ref', `slide "${a.id}" is still referenced (${refs.length})`, `referenced at ${refs.slice(0, 6).join(', ')}; pass force:true`);
      d.slides = d.slides.filter((s) => s.id !== a.id);
      purgeRefs(d, a.id);
      return {};
    },
  },
  // ----- question draws -----
  {
    name: 'draw.add', summary: 'Add a draw slide to a scene: when the learner reaches it, count slides are picked from the bank (count 0 = all; shuffle: random order, else bank order; always/never: bank slides always or never included). Quizzes may list the draw slide; they then score the drawn questions only.',
    args: S({ id: idArg, title: { type: 'string' }, scene: idArg, index: { type: 'integer', minimum: 0 }, ...drawSchema.properties }, ['bank']),
    examples: [{ id: 's-draw', bank: 'bk-safety', count: 5 }, { bank: 'bk-safety', count: 3, shuffle: false, always: ['s-b1'], never: ['s-b4'], title: 'Safety check' }],
    run(d, a, ctx) {
      const bank = bankOf(d, a.bank, '/args/bank');
      const sc = a.scene ? d.scenes.find((s) => s.id === a.scene) : d.scenes[d.scenes.length - 1];
      if (!sc) throw cmdError('/args/scene', 'ref', `scene "${a.scene}" not found`, `scenes: ${ids(d.scenes)}`);
      const id = takeId(d, a.id, 's', ctx);
      d.slides.push({ id, title: a.title ?? `Draw from ${bank.title}`, objects: [], layers: [], triggers: [], draw: structuredClone(pick(a, Object.keys(drawSchema.properties))) });
      insertAt(sc.slides, id, a.index);
      return { id, scene: sc.id };
    },
  },
  {
    name: 'draw.set', summary: 'Change a draw slide: bank (always/never are cleared unless given), count, shuffle, always, never, title.',
    args: S({ id: idArg, title: { type: 'string' }, ...drawSchema.properties }, ['id']),
    examples: [{ id: 's-draw', count: 10 }, { id: 's-draw', always: ['s-b2'], never: [] }],
    run(d, a) {
      const s = slideOf(d, a.id);
      if (!s.draw) throw cmdError('/args/id', 'semantic', `slide "${a.id}" is not a draw slide`, `draw slides: ${ids(d.slides.filter((x) => x.draw))}`);
      if (a.bank !== undefined && a.bank !== s.draw.bank) { bankOf(d, a.bank, '/args/bank'); s.draw.always = []; s.draw.never = []; }
      assignFields(s.draw, a, Object.keys(drawSchema.properties));
      assignFields(s, a, ['title']);
      return {};
    },
  },
  // ----- objects -----
  {
    name: 'object.add', summary: `Add an object to a slide (or one of its layers). Types: ${objectSchema.properties.type.enum.join(', ')}. Later objects draw on top.`,
    args: S({ slide: idArg, layer: idArg, index: { type: 'integer', minimum: 0 }, id: idArg, ...objFields }, ['slide', 'type']),
    examples: [{ slide: 's-intro', type: 'button', id: 'o-start', text: 'Start', x: 540, y: 600, w: 200, h: 56 }, { slide: 's-intro', layer: 'l-help', type: 'text', text: 'Hint: %score% points so far' }],
    run(d, a, ctx) {
      const slide = slideOf(d, a.slide);
      let list = slide.objects;
      if (a.layer) { const l = slide.layers.find((x) => x.id === a.layer); if (!l) throw cmdError('/args/layer', 'ref', `layer "${a.layer}" not on slide "${a.slide}"`, `layers: ${ids(slide.layers)}`); list = l.objects; }
      const id = takeId(d, a.id, 'o', ctx);
      const obj = { id, ...structuredClone(pick(a, Object.keys(objFields))) };
      insertAt(list, obj, a.index);
      return { id };
    },
  },
  {
    name: 'object.set', summary: 'Change object properties (geometry, text, style (merged; a key set to null is removed), image, alt, hidden, timing start/end ms, initialState...). null deletes an optional field. rich derives text; setting text without rich replaces formatting with plain text.',
    args: S({ id: idArg, ...Object.fromEntries(Object.entries(objFields).filter(([k]) => k !== 'type').map(([k, v]) => [k, nullable(v)])), style: styleArg }, ['id']),
    examples: [{ id: 'o-start', x: 560, text: 'Begin', style: { fill: '#0b6e6e', color: '#ffffff' } }, { id: 'o-start', style: { fill: null } }],
    run(d, a) {
      const o = need(d, a.id, 'object').item;
      const keys = Object.keys(objFields).filter((k) => k !== 'type' && k !== 'style');
      assignFields(o, a, keys);
      if (a.text !== undefined && a.rich === undefined) delete o.rich;
      mergeStyle(o, a.style);
      return {};
    },
  },
  {
    name: 'object.move', summary: 'Change z-order (index; 0 = back) and/or move to a layer of the same slide (layer: null = base).',
    args: S({ id: idArg, index: { type: 'integer', minimum: 0 }, layer: { type: ['string', 'null'] } }, ['id']),
    examples: [{ id: 'o-start', index: 0 }, { id: 'o-hint', layer: 'l-help' }],
    run(d, a) {
      const hit = need(d, a.id, 'object');
      let target = hit.list;
      if (a.layer !== undefined) {
        if (a.layer === null) target = hit.slide.objects;
        else { const l = hit.slide.layers.find((x) => x.id === a.layer); if (!l) throw cmdError('/args/layer', 'ref', `layer "${a.layer}" not on this slide`, `layers: ${ids(hit.slide.layers)}`); target = l.objects; }
      }
      hit.list.splice(hit.index, 1);
      insertAt(target, hit.item, a.index);
      return {};
    },
  },
  {
    name: 'object.remove', summary: 'Delete an object. Fails if triggers reference it unless force:true (removes those triggers).',
    args: S({ id: idArg, force: { type: 'boolean' } }, ['id']), examples: [{ id: 'o-old' }],
    run(d, a) { const hit = need(d, a.id, 'object'); guardRemove(d, a.id, a.force, 'object'); const again = locate(d, a.id); again.list.splice(again.index, 1); return {}; },
  },
  {
    name: 'object.duplicate',
    summary: 'Copy objects (same slide and layer) with fresh ids, plus the triggers they fire, remapping references to the copies. Omit slide and layer to copy in place; else paste onto slide (default: source slide) and layer (default/null: base). dx/dy offset the copies. Copied triggers that would reference missing objects/layers at the destination are skipped (result.skipped).',
    args: S({ ids: idsArg, slide: idArg, layer: { type: ['string', 'null'], pattern: ID }, dx: { type: 'number' }, dy: { type: 'number' }, newIds: idsArg }, ['ids']),
    examples: [{ ids: ['o-start'], dx: 20, dy: 20 }, { ids: ['o-card', 'o-flip'], slide: 's-two', layer: 'l-info', newIds: ['o-card2', 'o-flip2'] }],
    run(d, a, ctx) {
      const hits = objsOn(d, a.ids);
      const src = hits[0];
      if (hits.some((x) => x.list !== src.list)) throw cmdError('/args/ids', 'semantic', 'objects must be on the same slide and layer', 'copy base-layer and layer objects in separate commands');
      if (a.newIds && a.newIds.length !== hits.length) throw cmdError('/args/newIds', 'semantic', `newIds needs ${hits.length} id(s), one per entry of ids`);
      const inPlace = a.slide === undefined && a.layer === undefined;
      const slide = a.slide === undefined ? src.slide : slideOf(d, a.slide);
      let dest = inPlace ? src.layer : null;
      if (!inPlace && a.layer) { dest = slide.layers.find((l) => l.id === a.layer); if (!dest) throw cmdError('/args/layer', 'ref', `layer "${a.layer}" not on slide "${slide.id}"`, `layers: ${ids(slide.layers)}`); }
      const taken = allIds(d);
      const map = new Map();
      const fresh = (prefix, wanted) => {
        if (wanted !== undefined && taken.has(wanted)) throw cmdError('/args/newIds', 'dupe', `id "${wanted}" already used`, 'omit newIds to generate ids');
        const n = wanted ?? newId(prefix, taken, ctx.rng);
        taken.add(n);
        return n;
      };
      for (const [h, wanted] of hits.map((x, i) => [x, a.newIds?.[i]]).sort((p, q) => p[0].index - q[0].index)) {
        const o = structuredClone(h.item);
        o.id = fresh('o', wanted);
        map.set(h.item.id, o.id);
        o.x += a.dx ?? 0;
        o.y += a.dy ?? 0;
        (dest ?? slide).objects.push(o);
      }
      const local = new Set([...slide.layers, ...slide.objects, ...slide.layers.flatMap((l) => l.objects)].map((x) => x.id));
      const out = { ids: hits.map((x) => map.get(x.item.id)), triggers: [], skipped: [] };
      for (const t of [...(src.layer ?? src.slide).triggers].filter((x) => map.has(x.on.target))) {
        const c = structuredClone(t);
        const clauses = [...(c.if?.all || []), ...(c.if?.any || [])];
        const acts = [...c.do, ...(c.else || [])];
        for (const x of [c.on, ...clauses, ...acts]) if (map.has(x.target)) x.target = map.get(x.target);
        const refs = [c.on.target, ...clauses.map((x) => x.target), ...acts.flatMap((x) => [x.target, x.layer])].filter(Boolean);
        const badHere = (x) => (x.action === 'hideLayer' && !x.layer && !dest) || (x.action === 'submit' && !slide.question); // review 003 #8
        if (refs.some((r) => !local.has(r)) || acts.some(badHere)) { out.skipped.push(t.id); continue; }
        c.id = fresh('t');
        map.set(t.id, c.id);
        (dest ?? slide).triggers.push(c);
        out.triggers.push(c.id);
      }
      ctx.copied?.(map);
      return out;
    },
  },
  {
    name: 'object.align', summary: 'Align objects by edge or center: left|center|right (x), top|middle|bottom (y), to the selection bounds (default for 2+ objects) or the slide (default for one). Rotation is ignored.',
    args: S({ ids: idsArg, edge: { type: 'string', enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] }, to: { type: 'string', enum: ['selection', 'slide'] } }, ['ids', 'edge']),
    examples: [{ ids: ['o-a', 'o-b', 'o-c'], edge: 'left' }, { ids: ['o-title'], edge: 'center', to: 'slide' }],
    run(d, a) {
      const os = objsOn(d, a.ids).map((x) => x.item);
      const [k, w] = ['left', 'center', 'right'].includes(a.edge) ? ['x', 'w'] : ['y', 'h'];
      const toSlide = (a.to ?? (os.length > 1 ? 'selection' : 'slide')) === 'slide';
      const lo = toSlide ? 0 : Math.min(...os.map((o) => o[k]));
      const hi = toSlide ? d.size[w] : Math.max(...os.map((o) => o[k] + o[w]));
      const f = { left: 0, top: 0, center: 0.5, middle: 0.5, right: 1, bottom: 1 }[a.edge];
      for (const o of os) o[k] = lo + (hi - lo - o[w]) * f;
      return {};
    },
  },
  {
    name: 'object.distribute', summary: 'Space 3+ objects evenly (equal gaps) horizontally or vertically; the outermost objects stay put.',
    args: S({ ids: idsArg, axis: { type: 'string', enum: ['horizontal', 'vertical'] } }, ['ids', 'axis']),
    examples: [{ ids: ['o-a', 'o-b', 'o-c'], axis: 'horizontal' }],
    run(d, a) {
      const os = objsOn(d, a.ids).map((x) => x.item);
      if (os.length < 3) throw cmdError('/args/ids', 'semantic', `distribute needs at least 3 objects (got ${os.length})`, 'use object.align for two objects');
      const [k, w] = a.axis === 'horizontal' ? ['x', 'w'] : ['y', 'h'];
      os.sort((p, q) => p[k] - q[k]);
      // First and last BY POSITION stay put, even when sizes overlap (review 003 #9).
      const first = os[0], last = os[os.length - 1];
      const gap = (last[k] + last[w] - first[k] - os.reduce((n, o) => n + o[w], 0)) / (os.length - 1);
      let at = first[k] + first[w] + gap;
      for (const o of os.slice(1, -1)) { o[k] = at; at += o[w] + gap; }
      return {};
    },
  },
  {
    name: 'state.set', summary: `Define or update an object state (overrides of style/text/image/hidden; style is merged, a key set to null is removed; null removes an override). Built-ins: ${BUILTIN_STATES.join(', ')}; custom names allowed.`,
    args: S({ target: idArg, state: { type: 'string', pattern: '^[a-z][a-z0-9_-]*$' }, style: styleArg, text: nullable({ type: 'string' }), image: nullable(idArg), hidden: nullable({ type: 'boolean' }) }, ['target', 'state']),
    examples: [{ target: 'o-start', state: 'hover', style: { fill: '#095c5c' } }, { target: 'o-card', state: 'flipped', text: 'Answer: 42' }, { target: 'o-start', state: 'hover', style: { fill: null } }],
    run(d, a) {
      const o = need(d, a.target, 'object', '/args/target').item;
      o.states = o.states || {};
      const st = Object.hasOwn(o.states, a.state) ? o.states[a.state] : {};
      mergeStyle(st, a.style);
      assignFields(st, a, ['text', 'image', 'hidden']);
      o.states[a.state] = st;
      return {};
    },
  },
  {
    name: 'state.remove', summary: 'Remove a state definition from an object.', args: S({ target: idArg, state: { type: 'string' } }, ['target', 'state']), examples: [{ target: 'o-card', state: 'flipped' }],
    run(d, a) { const o = need(d, a.target, 'object', '/args/target').item; if (!o.states || !Object.hasOwn(o.states, a.state)) throw cmdError('/args/state', 'ref', `state "${a.state}" not defined on "${a.target}"`, `defined: ${Object.keys(o.states || {}).join(', ') || '(none)'}`); delete o.states[a.state]; return {}; },
  },
  // ----- layers -----
  {
    name: 'layer.add', summary: 'Add a layer to a slide (hidden until a showLayer action). Props: hideOthers, hideBaseObjects, hideOnEnd, modal, pauseBase, revisit.',
    args: S({ slide: idArg, id: idArg, index: { type: 'integer', minimum: 0 }, ...pick(layerSchema.properties, [...layerFields, 'objects', 'triggers']) }, ['slide']),
    examples: [{ slide: 's-intro', id: 'l-help', title: 'Help', modal: true }],
    run(d, a, ctx) { const slide = slideOf(d, a.slide); const id = takeId(d, a.id, 'l', ctx); insertAt(slide.layers, { id, ...structuredClone(pick(a, [...layerFields, 'objects', 'triggers'])) }, a.index); return { id }; },
  },
  {
    name: 'layer.set', summary: 'Change layer properties.', args: S({ id: idArg, ...pick(layerSchema.properties, layerFields) }, ['id']), examples: [{ id: 'l-help', pauseBase: true }],
    run(d, a) { assignFields(need(d, a.id, 'layer').item, a, layerFields); return {}; },
  },
  {
    name: 'layer.move', summary: 'Reorder a layer within its slide (index 0 = first in the list).', args: S({ id: idArg, index: { type: 'integer', minimum: 0 } }, ['id', 'index']), examples: [{ id: 'l-help', index: 0 }],
    run(d, a) { const hit = need(d, a.id, 'layer'); hit.list.splice(hit.index, 1); insertAt(hit.list, hit.item, a.index); return {}; },
  },
  {
    name: 'layer.remove', summary: 'Delete a layer and its objects. Fails if referenced unless force:true.', args: S({ id: idArg, force: { type: 'boolean' } }, ['id']), examples: [{ id: 'l-help' }],
    run(d, a) {
      const hit = need(d, a.id, 'layer');
      for (const o of hit.item.objects) guardRemove(d, o.id, a.force, 'object');
      guardRemove(d, a.id, a.force, 'layer');
      const again = locate(d, a.id); again.list.splice(again.index, 1); return {};
    },
  },
  // ----- triggers -----
  {
    name: 'trigger.add', summary: 'Add a trigger to a slide (or layer): on <event> [if <conditions>] do <actions> [else <actions>]. Actions run in order; a jump ends the rest.',
    args: S({ slide: idArg, layer: idArg, id: idArg, index: { type: 'integer', minimum: 0 }, name: { type: 'string' }, on: eventSchema, if: condSchema, do: triggerSchema.properties.do, else: triggerSchema.properties.else, enabled: { type: 'boolean' } }, ['slide', 'on', 'do']),
    examples: [
      { slide: 's-intro', on: { event: 'click', target: 'o-start' }, do: [{ action: 'setVar', var: 'started', op: 'set', value: true }, { action: 'jump', to: 'next' }] },
      { slide: 's-q1', on: { event: 'click', target: 'o-hint' }, if: { all: [{ var: 'score', op: '<', value: 50 }] }, do: [{ action: 'showLayer', layer: 'l-help' }], else: [{ action: 'setState', target: 'o-hint', state: 'disabled' }] },
    ],
    run(d, a, ctx) {
      const slide = slideOf(d, a.slide);
      let list = slide.triggers;
      if (a.layer) { const l = slide.layers.find((x) => x.id === a.layer); if (!l) throw cmdError('/args/layer', 'ref', `layer "${a.layer}" not on slide "${a.slide}"`, `layers: ${ids(slide.layers)}`); list = l.triggers; }
      const id = takeId(d, a.id, 't', ctx);
      insertAt(list, { id, ...structuredClone(pick(a, ['name', 'on', 'if', 'do', 'else', 'enabled'])) }, a.index);
      return { id };
    },
  },
  {
    name: 'trigger.set', summary: 'Replace parts of a trigger (on, if, do, else, name, enabled). if/else/name: null removes.',
    args: S({ id: idArg, name: nullable({ type: 'string' }), on: eventSchema, if: nullable(condSchema), do: triggerSchema.properties.do, else: nullable(triggerSchema.properties.else), enabled: { type: 'boolean' } }, ['id']),
    examples: [{ id: 't-start', do: [{ action: 'jump', to: 's-q1' }] }, { id: 't-start', if: null }],
    run(d, a) { assignFields(need(d, a.id, 'trigger').item, a, ['name', 'on', 'if', 'do', 'else', 'enabled']); return {}; },
  },
  {
    name: 'trigger.move', summary: 'Reorder a trigger within its list (execution order).', args: S({ id: idArg, index: { type: 'integer', minimum: 0 } }, ['id', 'index']), examples: [{ id: 't-2', index: 0 }],
    run(d, a) { const hit = need(d, a.id, 'trigger'); hit.list.splice(hit.index, 1); insertAt(hit.list, hit.item, a.index); return {}; },
  },
  {
    name: 'trigger.remove', summary: 'Delete a trigger.', args: S({ id: idArg }, ['id']), examples: [{ id: 't-2' }],
    run(d, a) { const hit = need(d, a.id, 'trigger'); hit.list.splice(hit.index, 1); return {}; },
  },
  // ----- variables -----
  {
    name: 'var.add', summary: 'Declare a course variable (number|boolean|text). Use %name% in text to display it.',
    args: S({ name: { type: 'string', pattern: VAR_NAME }, type: { type: 'string', enum: ['number', 'boolean', 'text'] }, initial: { type: ['number', 'string', 'boolean'] } }, ['name', 'type']),
    examples: [{ name: 'score', type: 'number', initial: 0 }, { name: 'visitedLab', type: 'boolean', initial: false }],
    run(d, a) {
      if (d.variables.some((v) => v.name === a.name)) throw cmdError('/args/name', 'dupe', `variable "${a.name}" already exists`, 'use var.set to change it');
      const initial = a.initial ?? { number: 0, boolean: false, text: '' }[a.type];
      d.variables.push({ name: a.name, type: a.type, initial });
      return { name: a.name };
    },
  },
  {
    name: 'var.set', summary: 'Change a variable initial value or rename it (references and %name% text are updated).',
    args: S({ name: { type: 'string' }, newName: { type: 'string', pattern: VAR_NAME }, initial: { type: ['number', 'string', 'boolean'] } }, ['name']),
    examples: [{ name: 'score', initial: 10 }, { name: 'score', newName: 'points' }],
    run(d, a) {
      const v = d.variables.find((x) => x.name === a.name);
      if (!v) throw cmdError('/args/name', 'ref', `variable "${a.name}" not found`, `variables: ${d.variables.map((x) => x.name).join(', ') || '(none)'}`);
      if (a.initial !== undefined) v.initial = a.initial;
      if (a.newName && a.newName !== a.name) {
        if (d.variables.some((x) => x.name === a.newName)) throw cmdError('/args/newName', 'dupe', `variable "${a.newName}" already exists`);
        const ren = (x) => (x === a.name ? a.newName : x);
        for (const s of d.slides) {
          for (const t of [...s.triggers, ...s.layers.flatMap((l) => l.triggers)]) {
            if (t.on.var) t.on.var = ren(t.on.var);
            for (const c of [...(t.if?.all || []), ...(t.if?.any || [])]) { if (c.var) c.var = ren(c.var); if (c.otherVar) c.otherVar = ren(c.otherVar); }
            for (const x of [...t.do, ...(t.else || [])]) { if (x.var) x.var = ren(x.var); if (x.fromVar) x.fromVar = ren(x.fromVar); }
          }
          for (const o of [...s.objects, ...s.layers.flatMap((l) => l.objects)]) {
            if (o.var) o.var = ren(o.var);
            if (o.text) o.text = o.text.split(`%${a.name}%`).join(`%${a.newName}%`);
            if (o.rich) o.rich = replaceRichVariables(o.rich, (token, name) => name === a.name ? `%${a.newName}%` : token);
            if (o.detail) o.detail = o.detail.split(`%${a.name}%`).join(`%${a.newName}%`);
            for (const st of Object.values(o.states || {})) if (st.text) st.text = st.text.split(`%${a.name}%`).join(`%${a.newName}%`);
          }
          if (s.question) {
            const r = (x) => (typeof x === 'string' ? x.split(`%${a.name}%`).join(`%${a.newName}%`) : x);
            s.question.prompt = r(s.question.prompt);
            for (const c of [...(s.question.choices || []), ...(s.question.rows || [])]) c.label = r(c.label);
            for (const k of Object.keys(s.question.feedback || {})) s.question.feedback[k] = r(s.question.feedback[k]);
          }
        }
        v.name = a.newName;
      }
      return { name: v.name };
    },
  },
  {
    name: 'var.remove', summary: 'Delete a variable. Fails if used unless force:true (removes those triggers).', args: S({ name: { type: 'string' }, force: { type: 'boolean' } }, ['name']), examples: [{ name: 'tmp' }],
    run(d, a) {
      if (!d.variables.some((x) => x.name === a.name)) throw cmdError('/args/name', 'ref', `variable "${a.name}" not found`);
      const refs = varRefs(d, a.name);
      if (refs.length && !a.force) throw cmdError('/args/name', 'ref', `variable "${a.name}" is used (${refs.length})`, `used at ${refs.slice(0, 6).join(', ')}; pass force:true`);
      const uses = (t) => t.on.var === a.name || [...(t.if?.all || []), ...(t.if?.any || [])].some((c) => c.var === a.name || c.otherVar === a.name) || [...t.do, ...(t.else || [])].some((x) => x.var === a.name || x.fromVar === a.name);
      for (const s of d.slides) { s.triggers = s.triggers.filter((t) => !uses(t)); for (const l of s.layers) l.triggers = l.triggers.filter((t) => !uses(t)); for (const o of [...s.objects, ...s.layers.flatMap((l) => l.objects)]) if (o.var === a.name) delete o.var; }
      d.variables = d.variables.filter((x) => x.name !== a.name);
      return {};
    },
  },
  // ----- questions & quizzes -----
  {
    name: 'question.set', summary: `Make a slide a question slide or update its question (${questionSchema.properties.type.enum.join('|')}). Fields are merged; choices/answers/areas/items/targets/rows are replaced (null removes areas, items, targets or rows).`,
    args: S({ slide: idArg, ...Object.fromEntries(Object.entries(questionSchema.properties)), ...Object.fromEntries(['areas', 'items', 'targets', 'rows'].map((k) => [k, nullable(questionSchema.properties[k])])) }, ['slide']),
    examples: [
      { slide: 's-q1', type: 'mc', prompt: 'Which gas do plants absorb?', choices: [{ id: 'a', label: 'Oxygen' }, { id: 'b', label: 'Carbon dioxide', correct: true }], points: 10, attempts: 2 },
      { slide: 's-q2', type: 'fill', prompt: 'Type the color', answers: ['teal', 'teal blue'] },
      { slide: 's-q3', type: 'hotspot', prompt: 'Click the fire extinguisher', areas: [{ id: 'ext', x: 820, y: 260, w: 140, h: 260, correct: true }, { id: 'door', shape: 'ellipse', x: 200, y: 200, w: 180, h: 300 }] },
      { slide: 's-q4', type: 'dragdrop', prompt: 'Sort the waste', items: [{ object: 'o-glass', target: 'o-bin-sharps' }, { object: 'o-gloves', target: 'o-bin-bio' }, { object: 'o-paper' }], targets: [{ object: 'o-bin-sharps' }, { object: 'o-bin-bio', capacity: 'many' }] },
      { slide: 's-q5', type: 'matching', prompt: 'Match each hazard to its sign', choices: [{ id: 'bio', label: 'Biohazard' }, { id: 'rad', label: 'Radiation' }], rows: [{ id: 'blood', label: 'Blood sample', choice: 'bio' }, { id: 'isotope', label: 'Isotope', choice: 'rad' }] },
      { slide: 's-q6', type: 'sequence', prompt: 'Put the steps in order', choices: [{ id: 'wash', label: 'Wash hands' }, { id: 'gloves', label: 'Put on gloves' }, { id: 'work', label: 'Start work' }] },
    ],
    run(d, a) {
      const s = slideOf(d, a.slide);
      const keys = Object.keys(questionSchema.properties).filter((k) => k !== 'feedback');
      if (!s.question) { if (!a.type || a.prompt === undefined) throw cmdError('/args', 'required', 'new questions need type and prompt'); s.question = {}; }
      assignFields(s.question, a, keys);
      if (a.feedback) s.question.feedback = { ...(s.question.feedback || {}), ...a.feedback };
      return {};
    },
  },
  {
    name: 'question.remove', summary: 'Turn a question slide back into a normal slide.', args: S({ slide: idArg }, ['slide']), examples: [{ slide: 's-q1' }],
    run(d, a) { const s = slideOf(d, a.slide); if (!s.question) throw cmdError('/args/slide', 'semantic', `slide "${a.slide}" has no question`); delete s.question; for (const q of d.quizzes) q.questions = q.questions.filter((x) => x !== a.slide); return {}; },
  },
  {
    name: 'quiz.add', summary: 'Create a quiz from question slides with a pass mark (%) and optional results slide.',
    args: S({ id: idArg, title: { type: 'string' }, questions: { type: 'array', items: idArg }, passPercent: { type: 'number', minimum: 0, maximum: 100 }, results: idArg, round: { type: 'boolean' } }),
    examples: [{ id: 'qz-final', questions: ['s-q1', 's-q2'], passPercent: 80, results: 's-results' }],
    run(d, a, ctx) { const id = takeId(d, a.id, 'qz', ctx); d.quizzes.push({ id, ...structuredClone(pick(a, ['title', 'questions', 'passPercent', 'results', 'round'])) }); return { id }; },
  },
  {
    name: 'quiz.set', summary: 'Change a quiz. review true|false adds or removes the Review quiz button on its results slide.',
    args: S({ id: idArg, title: { type: 'string' }, questions: { type: 'array', items: idArg }, passPercent: { type: 'number', minimum: 0, maximum: 100 }, results: nullable(idArg), round: { type: 'boolean' }, review: { type: 'boolean' } }, ['id']),
    examples: [{ id: 'qz-final', passPercent: 70 }, { id: 'qz-final', review: false }],
    run(d, a) {
      const q = d.quizzes.find((x) => x.id === a.id); if (!q) throw cmdError('/args/id', 'ref', `quiz "${a.id}" not found`, `quizzes: ${ids(d.quizzes)}`);
      assignFields(q, a, ['title', 'questions', 'passPercent', 'results', 'round']);
      if (a.review !== undefined) setReview(d, q, a.review);
      return {};
    },
  },
  {
    name: 'quiz.addResults', summary: 'Add a standard results slide for a quiz: score text, pass/fail layers, submit on start, Retry button (after a fail), Review quiz button (review: false leaves it out); optionally make the quiz the LMS completion criterion.',
    args: S({ quiz: idArg, id: idArg, title: { type: 'string' }, scene: idArg, passText: { type: 'string' }, failText: { type: 'string' }, retry: { type: 'boolean' }, review: { type: 'boolean' }, track: { type: 'boolean' } }, ['quiz']),
    examples: [{ quiz: 'qz-final', id: 's-results', track: true }],
    run(d, a, ctx) {
      const q = d.quizzes.find((x) => x.id === a.quiz);
      if (!q) throw cmdError('/args/quiz', 'ref', `quiz "${a.quiz}" not found`, `quizzes: ${ids(d.quizzes)}`);
      const sid = takeId(d, a.id, 's', ctx);
      const fresh = (p) => { const taken = allIds(d); taken.add(sid); const n = newId(p, taken, ctx.rng); return n; };
      const lp = `${sid}-pass`, lf = `${sid}-fail`, ob = `${sid}-retry`;
      const sc = a.scene ? d.scenes.find((s) => s.id === a.scene) : d.scenes.find((s) => s.slides.includes(q.questions[q.questions.length - 1])) || d.scenes[d.scenes.length - 1];
      if (!sc) throw cmdError('/args/scene', 'ref', `scene "${a.scene}" not found`, `scenes: ${ids(d.scenes)}`);
      const { w, h } = d.size;
      const slide = {
        id: sid, title: a.title ?? 'Results',
        objects: [
          { id: `${sid}-score`, type: 'text', x: 80, y: 60, w: w - 160, h: 70, text: `Your score: %${q.id}.scorePercent%% (pass mark ${q.passPercent}%)`, style: { fontSize: 34, bold: true } },
        ],
        layers: [
          { id: lp, title: 'Passed', objects: [{ id: `${lp}-text`, type: 'text', x: 80, y: 170, w: w - 160, h: 200, text: a.passText ?? 'Congratulations, you passed.', style: { fontSize: 28 } }] },
          // Retry lives on the Failed layer: after a pass only the result shows (vendor results slide)
          { id: lf, title: 'Failed', objects: [{ id: `${lf}-text`, type: 'text', x: 80, y: 170, w: w - 160, h: 200, text: a.failText ?? 'You did not pass this time. Review and try again.', style: { fontSize: 28 } },
            ...(a.retry === false ? [] : [{ id: ob, type: 'button', x: 80, y: h - 140, w: 240, h: 60, text: 'Retry quiz', style: { fontSize: 22, radius: 8 } }])],
          triggers: a.retry === false ? [] : [{ id: `${sid}-retry-t`, on: { event: 'click', target: ob }, do: [{ action: 'resetQuiz', quiz: q.id }] },
            ...(q.questions[0] ? [{ id: `${sid}-retry-jump`, on: { event: 'click', target: ob }, do: [{ action: 'jump', to: q.questions[0] }] }] : [])] },
        ],
        triggers: [
          { id: fresh('t'), on: { event: 'timelineStart' }, do: [{ action: 'submitQuiz', quiz: q.id }] },
          { id: `${sid}-branch`, on: { event: 'timelineStart' }, if: { all: [{ var: `${q.id}.scorePercent`, op: '>=', otherVar: `${q.id}.passPercent` }] }, do: [{ action: 'showLayer', layer: lp }], else: [{ action: 'showLayer', layer: lf }] },
        ],
      };
      // Review shows after a pass and after a fail, so it sits on the base layer, above Retry.
      if (a.review !== false) { const rv = reviewParts(sid, q.id, h); slide.objects.push(rv.object); slide.triggers.push(rv.trigger); }
      for (const x of [`${sid}-score`, lp, lf, ob, `${lp}-text`, `${lf}-text`, `${sid}-branch`, `${sid}-retry-t`, `${sid}-retry-jump`, ...slide.objects.map((o) => o.id), ...slide.triggers.map((t) => t.id)]) if (allIds(d).has(x)) throw cmdError('/args/id', 'dupe', `generated id "${x}" already exists`, 'pass a different id');
      d.slides.push(slide);
      sc.slides.push(sid);
      q.results = sid;
      if (a.track) d.tracking = { complete: [{ quiz: q.id }], status: 'passed-failed' };
      return { id: sid, layers: [lp, lf] };
    },
  },
  {
    name: 'quiz.remove', summary: 'Delete a quiz (question slides stay). Fails if referenced unless force:true.', args: S({ id: idArg, force: { type: 'boolean' } }, ['id']), examples: [{ id: 'qz-final' }],
    run(d, a) { if (!d.quizzes.some((x) => x.id === a.id)) throw cmdError('/args/id', 'ref', `quiz "${a.id}" not found`); guardRemove(d, a.id, a.force, 'quiz'); d.quizzes = d.quizzes.filter((x) => x.id !== a.id); return {}; },
  },
  // ----- lessons mode: sections -----
  {
    name: 'section.add', summary: 'Lessons mode: add a section (a labelled group of lessons in the outline; an empty title shows no header).',
    args: S({ id: idArg, title: { type: 'string' }, index: { type: 'integer', minimum: 0 } }), examples: [{ id: 'sec-basics', title: 'Basics' }],
    run(d, a, ctx) { const id = takeId(d, a.id, 'sec', ctx); insertAt(d.sections, { id, title: a.title ?? 'Section', lessons: [] }, a.index); return { id }; },
  },
  {
    name: 'section.set', summary: 'Rename a section.', args: S({ id: idArg, title: { type: 'string' } }, ['id']), examples: [{ id: 'sec-basics', title: 'Getting started' }],
    run(d, a) { assignFields(sectionOf(d, a.id), a, ['title']); return {}; },
  },
  {
    name: 'section.move', summary: 'Reorder a section.', args: S({ id: idArg, index: { type: 'integer', minimum: 0 } }, ['id', 'index']), examples: [{ id: 'sec-quiz', index: 0 }],
    run(d, a) { const s = sectionOf(d, a.id); d.sections.splice(d.sections.indexOf(s), 1); insertAt(d.sections, s, a.index); return {}; },
  },
  {
    name: 'section.remove', summary: 'Remove a section; its lessons must be moved first unless force:true (then they are deleted with the buttons/tracking entries that point to them).',
    args: S({ id: idArg, force: { type: 'boolean' } }, ['id']), examples: [{ id: 'sec-old' }],
    run(d, a) {
      const s = sectionOf(d, a.id);
      if (s.lessons.length && !a.force) throw cmdError('/args/id', 'semantic', `section "${a.id}" still has ${s.lessons.length} lesson(s)`, 'move them with lesson.move {id, section} or pass force:true');
      d.sections.splice(d.sections.indexOf(s), 1);
      for (const l of s.lessons) purgeRefs(d, l.id);
      return {};
    },
  },
  // ----- lessons mode: lessons -----
  {
    name: 'lesson.add', summary: 'Lessons mode: add a lesson to a section (default: the last one). kind content = stacked blocks; kind quiz = question blocks graded one at a time (passPercent 80, attempts 0 = unlimited, reveal all|incorrect|none, randomize, shuffle, requirePass). blocks may be given inline; missing block ids are generated.',
    args: S({ id: idArg, section: idArg, index: { type: 'integer', minimum: 0 }, ...pick(lessonSchema.properties, lessonFields), blocks: { type: 'array', items: newBlock } }),
    examples: [
      { id: 'l-intro', section: 'sec-basics', title: 'Welcome', blocks: [{ type: 'heading', text: 'Welcome' }, { type: 'text', text: 'Two short paragraphs.\n\nA blank line starts the second one.' }] },
      { id: 'l-quiz', title: 'Final quiz', kind: 'quiz', passPercent: 80, attempts: 2, reveal: 'incorrect' },
    ],
    run(d, a, ctx) {
      const sec = a.section ? sectionOf(d, a.section, '/args/section') : d.sections[d.sections.length - 1];
      if (!sec) throw cmdError('/args/section', 'ref', 'the course has no section yet', 'add one first: section.add {"title":"..."}');
      const id = takeId(d, a.id, 'l', ctx);
      const lesson = { id, ...structuredClone(pick(a, lessonFields)), blocks: idBlocks(d, structuredClone(a.blocks || []), ctx, [id]) };
      insertAt(sec.lessons, lesson, a.index);
      return { id, section: sec.id, blocks: lesson.blocks.map((b) => b.id) };
    },
  },
  {
    name: 'lesson.set', summary: 'Change a lesson: title, kind, quiz settings (passPercent, attempts, reveal, randomize, shuffle, requirePass; null removes).',
    args: S({ id: idArg, title: { type: 'string' }, kind: lessonSchema.properties.kind, ...Object.fromEntries(QUIZ_FIELDS.map((k) => [k, nullable(lessonSchema.properties[k])])) }, ['id']),
    examples: [{ id: 'l-quiz', passPercent: 70, attempts: 3 }, { id: 'l-intro', title: 'Start here' }],
    run(d, a) { assignFields(findLesson(d, a.id).item, a, lessonFields); return {}; },
  },
  {
    name: 'lesson.move', summary: 'Move a lesson within its section or to another section.', args: S({ id: idArg, section: idArg, index: { type: 'integer', minimum: 0 } }, ['id']),
    examples: [{ id: 'l-quiz', index: 0 }, { id: 'l-quiz', section: 'sec-check' }],
    run(d, a) {
      const hit = findLesson(d, a.id);
      const to = a.section ? sectionOf(d, a.section, '/args/section').lessons : hit.list;
      hit.list.splice(hit.index, 1);
      insertAt(to, hit.item, a.index);
      return {};
    },
  },
  {
    name: 'lesson.duplicate', summary: 'Duplicate a lesson (new ids for its blocks) right below the original.',
    args: S({ id: idArg, newId: idArg, title: { type: 'string' } }, ['id']), examples: [{ id: 'l-intro', title: 'Welcome (copy)' }],
    run(d, a, ctx) {
      const hit = findLesson(d, a.id);
      const copy = structuredClone(hit.item);
      copy.id = takeId(d, a.newId, 'l', ctx, '/args/newId');
      if (a.title) copy.title = a.title;
      for (const b of copy.blocks) delete b.id;
      idBlocks(d, copy.blocks, ctx, [copy.id]);
      hit.list.splice(hit.index + 1, 0, copy);
      return { id: copy.id, blocks: copy.blocks.map((b) => b.id) };
    },
  },
  {
    name: 'lesson.import', summary: 'Lessons mode: insert a reusable lesson package (from the lesson.export query, possibly from another course) with fresh ids into a section. Missing assets are added; buttons that point at lessons this course lacks are dropped (result.unlinked).',
    args: S({ data: { type: 'object' }, section: idArg, index: { type: 'integer', minimum: 0 }, newId: idArg }, ['data', 'section']),
    examples: [],
    run(d, a, ctx) {
      const pkg = a.data;
      if (pkg?.kind !== 'cf.lesson/1' || !pkg.lesson || !Array.isArray(pkg.lesson.blocks)) throw cmdError('/args/data', 'type', 'data must be a lesson package {kind:"cf.lesson/1", lesson, assets}', 'create one with the lesson.export query');
      const sec = d.sections.find((x) => x.id === a.section);
      if (!sec) throw cmdError('/args/section', 'ref', `section "${a.section}" not found`, `sections: ${ids(d.sections)}`);
      const lesson = structuredClone(pkg.lesson);
      lesson.id = takeId(d, a.newId, 'l', ctx, '/args/newId');
      const assetMap = new Map();
      for (const as of pkg.assets || []) {
        const same = d.assets.find((x) => x.path === as.path);
        if (same) { assetMap.set(as.id, same.id); continue; }
        const id = allIds(d).has(as.id) ? newId('a', allIds(d), ctx.rng) : as.id;
        d.assets.push({ ...structuredClone(as), id });
        assetMap.set(as.id, id);
      }
      const known = new Set(d.sections.flatMap((x) => x.lessons.map((l) => l.id)));
      const out = { id: lesson.id, unlinked: [] };
      lesson.blocks = lesson.blocks.filter((b) => { // a button to a lesson this course lacks cannot stay valid: drop it, report it
        if (b.type === 'button' && b.toLesson && b.toLesson !== pkg.lesson.id && !known.has(b.toLesson)) { out.unlinked.push(b.id); return false; }
        return true;
      });
      for (const b of lesson.blocks) {
        for (const k of Object.keys(b)) if (typeof b[k] === 'string' && assetMap.has(b[k])) b[k] = assetMap.get(b[k]);
        for (const it of b.items || []) for (const k of Object.keys(it)) if (typeof it[k] === 'string' && assetMap.has(it[k])) it[k] = assetMap.get(it[k]);
        for (const s of b.scenes || []) for (const k of ['background', 'character']) if (assetMap.has(s[k])) s[k] = assetMap.get(s[k]); // not ids: scene ids are block-local
        if (b.type === 'button' && b.toLesson === pkg.lesson.id) b.toLesson = lesson.id;
        delete b.id;
      }
      idBlocks(d, lesson.blocks, ctx, [lesson.id]);
      insertAt(sec.lessons, lesson, a.index);
      return { ...out, blocks: lesson.blocks.map((b) => b.id) };
    },
  },
  {
    name: 'lesson.remove', summary: 'Delete a lesson. Fails if buttons or tracking point to it unless force:true (removes those).',
    args: S({ id: idArg, force: { type: 'boolean' } }, ['id']), examples: [{ id: 'l-old' }],
    run(d, a) { findLesson(d, a.id); guardRemove(d, a.id, a.force, 'lesson'); const hit = findLesson(d, a.id); hit.list.splice(hit.index, 1); return {}; },
  },
  // ----- lessons mode: blocks -----
  {
    name: 'block.add', summary: `Lessons mode: add a block to a lesson (default: at the end). Types: ${Object.keys(BLOCK_TYPES).join(', ')}. Collections are always "items". style: {width, padding, align, background, color}.`,
    args: { type: 'object', additionalProperties: false, required: ['lesson', 'type'], properties: { lesson: idArg, index: { type: 'integer', minimum: 0 }, ...blockSchema.properties, id: idArg }, union: blockSchema.union },
    examples: [
      { lesson: 'l-intro', id: 'b-acc', type: 'accordion', items: [{ title: 'Goggles', text: 'Protect your eyes.' }, { title: 'Gloves', text: 'Protect your hands.' }] },
      { lesson: 'l-intro', type: 'continue', require: 'above', label: 'Continue' },
      { lesson: 'l-intro', type: 'question', kind: 'mc', prompt: 'Which protects your eyes?', choices: [{ id: 'a', label: 'Goggles', correct: true }, { id: 'b', label: 'Gloves' }], feedback: { correct: 'Yes.', incorrect: 'Look again.' } },
      { lesson: 'l-intro', type: 'button', label: 'Take the quiz', toLesson: 'l-quiz' },
    ],
    run(d, a, ctx) {
      const { item: lesson } = findLesson(d, a.lesson, '/args/lesson');
      const block = structuredClone(a);
      delete block.lesson; delete block.index;
      block.id = takeId(d, a.id, 'b', ctx);
      insertAt(lesson.blocks, block, a.index);
      return { id: block.id };
    },
  },
  {
    name: 'block.set', summary: 'Change block fields (any field of its type; type may switch, e.g. accordion <-> tabs; style is merged, a style key set to null is removed; null removes an optional field). Arrays such as items/choices are replaced.',
    args: S({ id: idArg, type: { type: 'string', enum: Object.keys(BLOCK_TYPES) }, style: blockStyleArg, ...Object.fromEntries(Object.entries(blockFields).map(([k, v]) => [k, nullable(v)])) }, ['id']),
    examples: [{ id: 'b-acc', type: 'tabs' }, { id: 'b-intro', text: 'New text', style: { width: 'wide', background: '#f4f1ea' } }, { id: 'b-intro', style: { background: null } }],
    run(d, a) {
      const b = findBlock(d, a.id).item;
      assignFields(b, a, ['type', ...Object.keys(blockFields)]);
      mergeStyle(b, a.style); // one command clears one style key
      return {};
    },
  },
  {
    name: 'block.move', summary: 'Reorder a block (index) and/or move it to another lesson.', args: S({ id: idArg, lesson: idArg, index: { type: 'integer', minimum: 0 } }, ['id']),
    examples: [{ id: 'b-acc', index: 0 }, { id: 'b-acc', lesson: 'l-two', index: 2 }],
    run(d, a) {
      const hit = findBlock(d, a.id);
      const to = a.lesson ? findLesson(d, a.lesson, '/args/lesson').item.blocks : hit.list;
      hit.list.splice(hit.index, 1);
      insertAt(to, hit.item, a.index);
      return {};
    },
  },
  {
    name: 'block.duplicate', summary: 'Duplicate a block right below the original.', args: S({ id: idArg, newId: idArg }, ['id']), examples: [{ id: 'b-acc' }],
    run(d, a, ctx) {
      const hit = findBlock(d, a.id);
      const copy = { ...structuredClone(hit.item), id: takeId(d, a.newId, 'b', ctx, '/args/newId') };
      hit.list.splice(hit.index + 1, 0, copy);
      return { id: copy.id };
    },
  },
  {
    name: 'block.remove', summary: 'Delete a block.', args: S({ id: idArg }, ['id']), examples: [{ id: 'b-old' }],
    run(d, a) { const hit = findBlock(d, a.id); hit.list.splice(hit.index, 1); return {}; },
  },
  // ----- assets -----
  {
    name: 'asset.add', summary: 'Register an asset: a file (path relative to the course file, e.g. assets/photo.png) or an original image from the CourseForge Studio library (library: an id from the library.list query; the path becomes library/<file> and alt comes from the library unless given). Pass path or library.',
    args: S({ id: idArg, path: { type: 'string', pattern: '^(?![a-zA-Z]:|/|\\\\)(?!.*\\.\\.)[^<>:"|?*]+$' }, library: { type: 'string', enum: LIBRARY.map((x) => x.id) }, mime: { type: 'string' }, alt: { type: 'string' } }),
    examples: [{ id: 'a-logo', path: 'assets/logo.png', alt: 'Company logo' }, { id: 'a-goggles', library: 'goggles' }],
    run(d, a, ctx) {
      if ((a.path === undefined) === (a.library === undefined)) throw cmdError('/args', 'required', 'pass either path (a file in the course folder) or library (an original image from the CourseForge Studio library)', 'the library.list query lists library ids');
      const lib = LIBRARY.find((x) => x.id === a.library);
      const id = takeId(d, a.id, 'a', ctx);
      d.assets.push({ id, ...(lib ? { path: `library/${lib.file}`, alt: lib.alt } : {}), ...pick(a, ['path', 'mime', 'alt']) });
      return { id };
    },
  },
  {
    name: 'asset.remove', summary: 'Delete an asset entry. Fails if objects use it unless force:true.', args: S({ id: idArg, force: { type: 'boolean' } }, ['id']), examples: [{ id: 'a-logo' }],
    run(d, a) { if (!d.assets.some((x) => x.id === a.id)) throw cmdError('/args/id', 'ref', `asset "${a.id}" not found`); guardRemove(d, a.id, a.force, 'asset'); d.assets = d.assets.filter((x) => x.id !== a.id); return {}; },
  },
];

