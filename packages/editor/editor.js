// CourseForge Studio editor: renders the course and sends registry commands to the local server.
// Parity rule: no editing logic here. The document is never mutated locally; every change is a {cmd, args}
// batch POSTed to /api/courses/:name/commands, and the server's document replaces ours (render(state) + dispatch(cmds)).
import { fmtTrigger } from '/packages/core/index.js';
import { renderRich, fitText } from '/packages/player/rich.js';
import { drawLine } from '/packages/player/line.js';
import { richField } from '/packages/editor/rich-field.js';
import { BUILTIN_STATES, objectSchema, eventSchema, actionSchema, condSchema, questionSchema, slideSchema, layerSchema, courseSchema, allIds, newId, rangeOf } from '/packages/schema/index.js';
import { aiView } from './ai-view.js'; // Claude: start-screen status, AI settings, assistant panel
import { lessonsView } from './lessons-view.js'; // the lessons-mode view (outline, lesson page, inspector)
import { PRESETS, FONTS, themeOf } from '/packages/schema/themes.js'; // preset names, swatches, current choice

// ---------- schema-derived vocabularies (display only) ----------
const EVENTS = Object.keys(eventSchema.union.map);
const ACTIONS = Object.keys(actionSchema.union.map);
const SET_OPS = actionSchema.union.map.setVar.properties.op.enum;
const CMP_OPS = condSchema.properties.all.items.properties.op.enum;
const QTYPES = questionSchema.properties.type.enum;
const ADVANCE = slideSchema.properties.advance.enum;
const REVISIT = slideSchema.properties.revisit.enum;
const RESUME = courseSchema.properties.player.properties.resume.enum;
const STATUS = courseSchema.properties.tracking.properties.status.enum;
const VAR_TYPES = courseSchema.properties.variables.items.properties.type.enum;
const SHAPES = objectSchema.properties.shape.enum;
const STYLE = objectSchema.properties.style.properties;
const LAYER_FLAGS = { hideOthers: 'Hide other layers when shown', hideBaseObjects: 'Hide base layer objects', hideOnEnd: 'Hide when its timeline ends', modal: 'Modal (blocks the base layer)', pauseBase: 'Pause the base timeline' };
const QLABEL = { mc: 'Multiple choice (one answer)', mr: 'Multiple response', tf: 'True / false', fill: 'Fill in the blank', hotspot: 'Hotspot (click an area of the slide)', dragdrop: 'Drag and drop (freeform)', matching: 'Matching (drop-down per row)', sequence: 'Sequence (put in order)' };
const PART = { var: 'variable', op: 'operator', value: 'value', fromVar: 'or copy from variable', otherVar: 'or compare with variable', target: 'object', state: 'state', is: 'test', layer: 'layer', to: 'destination', quiz: 'quiz', url: 'URL', ms: 'time (ms)', key: 'key' };
const INSERT = {
  text: { w: 320, h: 60, text: 'Text' }, shape: { w: 200, h: 120 }, button: { w: 200, h: 56, text: 'Button' },
  hotspot: { w: 160, h: 120 }, input: { w: 320, h: 48, placeholder: 'Type here' }, image: { w: 320, h: 200 },
  slider: { w: 480, h: 48 }, dial: { w: 180, h: 180 }, video: { w: 640, h: 360 }, audio: { w: 320, h: 54 }, marker: { w: 48, h: 48, text: 'Marker', detail: 'More about this spot' },
};
const TABS = [['props', 'Properties'], ['states', 'States'], ['triggers', 'Triggers'], ['layers', 'Layers'], ['vars', 'Variables'], ['slide', 'Slide'], ['question', 'Question'], ['course', 'Course']];

const $ = (sel) => document.querySelector(sel);
const token = new URLSearchParams(location.search).get('token') || '';
const S = {
  courses: null, name: null, doc: null, rev: 0, history: { undo: 0, redo: 0 }, file: '',
  slide: null, layer: null, sel: [], tab: 'props', shownTab: null,
  draft: {}, // form drafts {trigger, question}: form state only, never the document
  log: [], last: null, fieldErr: null, summaries: {},
  clip: null, // {ids, slide, layer, n}: what Ctrl+C copied (ids; Ctrl+V sends object.duplicate)
  timeline: true,
};

// ---------- tiny DOM helper (text is always set as text, so course content cannot inject markup) ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (['checked', 'disabled', 'hidden', 'required', 'selected'].includes(k)) el[k] = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false && kid !== '') el.append(kid instanceof Node ? kid : String(kid));
  if (value !== undefined) el.value = value;
  return el;
}
const opts = (list, cur) => list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(cur ?? '') }, l); });
const field = (id, label, control, cls = '') => h('div', { class: `field ${cls}` }, h('label', { for: id }, label), control);
const group = (title, ...kids) => h('section', { class: 'group' }, h('h3', {}, title), ...kids);
const hint = (text) => h('p', { class: 'hint' }, text);
const btn = (label, cmd, onclick, extra = {}) => h('button', { type: 'button', 'data-cmd': cmd || null, onclick, ...extra }, label);
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * One labelled control. Bound mode: `commit(value)` returns a command batch sent on change.
 * Draft mode: `set(value)` updates form state on input; `structural` re-renders on change.
 */
function ctl(kind, id, label, value, o = {}) {
  const read = (el) => (kind === 'check' ? el.checked : kind === 'num' ? (el.value === '' ? null : Number(el.value)) : el.value);
  const on = {
    'data-cmd': o.cmd || null, 'data-ui': o.cmd ? null : o.ui || null,
    onchange: (e) => { if (o.commit) dispatch(o.commit(read(e.target)), id); else if (o.set) { o.set(read(e.target)); if (o.structural) render(); } },
    oninput: o.set && !o.commit ? (e) => o.set(read(e.target)) : null,
  };
  if (kind === 'check') return h('div', { class: 'field check' }, h('input', { id, type: 'checkbox', checked: !!value, ...on, ...(o.attrs || {}) }), h('label', { for: id }, label));
  if (kind === 'radio') return h('div', { class: 'field check' }, h('input', { id, type: 'radio', checked: !!value, ...on, ...(o.attrs || {}) }), h('label', { for: id }, label));
  const el = kind === 'select' ? h('select', { id, ...on, value: value ?? '' }, opts(o.options, value))
    : kind === 'area' ? h('textarea', { id, rows: o.rows || 3, ...on, value: value ?? '' })
      : h('input', { id, type: kind === 'num' ? 'number' : 'text', ...on, ...(o.attrs || {}), value: value ?? '' });
  return field(id, label, el, o.cls);
}
function colorCtl(id, label, value, cmd, commit) {
  return field(id, label, h('div', { class: 'color' },
    h('input', { type: 'color', id: `${id}-pick`, class: value ? null : 'unset', 'aria-label': `${label} picker`, 'data-cmd': cmd, value: /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000', onchange: (e) => dispatch(commit(e.target.value), `${id}-pick`) }),
    h('input', { id, placeholder: 'none', 'data-cmd': cmd, value: value ?? '', spellcheck: 'false', onchange: (e) => dispatch(commit(e.target.value.trim() || null), id) })));
}
/* * Theme control, shared by both editors: presets with swatches, a font list and a live preview drawn with the
 *  lessons player's own styles. Each change is one theme.apply; the editor's chrome never changes. */
function themeGroup(p) {
  const theme = S.doc.player.theme || {};
  const cur = themeOf(theme);
  const C = 'theme.apply';
  const chips = (name) => (name === 'auto' ? [PRESETS.light.tokens, PRESETS.charcoal.tokens].flatMap((t) => [t.bg, t.accent]) : ['bg', 'surface', 'accent', 'ink'].map((k) => PRESETS[name].tokens[k]));
  const preview = h('div', { class: 'cfl th-preview', 'aria-hidden': 'true' },
    h('div', { class: 'th-card' }, h('p', { class: 'th-title' }, 'Lesson title'), h('p', { class: 'cfl-meta' }, 'Muted text · 2 of 5'), h('span', { class: 'cfl-btn cfl-primary' }, 'Continue')),
    h('div', { class: 'th-stage' }, h('span', {}, 'Slide'), h('span', { class: 'th-stage-btn' }, 'Button')));
  const previewTheme = S.doc.mode !== 'lessons' && S.doc.player.style === 'modern' ? { ...PRESETS.charcoal.tokens, ...theme } : theme;
  for (const [k, v] of Object.entries(previewTheme)) if (/^[a-z][a-z0-9-]*$/.test(k)) preview.style.setProperty(`--cf-${k}`, v);
  return group('Theme',
    h('fieldset', { class: 'plain th-presets' }, h('legend', {}, 'Colour preset (applies to the learner player)'),
      Object.entries(PRESETS).map(([name, x]) => h('div', { class: 'field check' },
        h('input', { type: 'radio', id: `${p}-preset-${name}`, name: `${p}-preset`, checked: cur.preset === name, 'data-cmd': C, onchange: () => dispatch([{ cmd: C, args: { preset: name } }], `${p}-preset-${name}`) }),
        h('label', { for: `${p}-preset-${name}` }, h('span', { class: 'th-swatch', 'aria-hidden': 'true' }, chips(name).map((c) => h('span', { style: { backgroundColor: c } }))), x.label)))),
    cur.preset === 'custom' && hint('Custom colours: choosing a preset replaces them.'),
    ctl('select', `${p}-font`, 'Font', cur.font === 'custom' ? '' : cur.font, { cmd: C, options: [...(cur.font === 'custom' ? [['', 'Custom']] : []), ...Object.entries(FONTS).map(([n, f]) => [n, f.label])], commit: (v) => (v ? [{ cmd: C, args: { font: v } }] : null) }),
    preview);
}

// ---------- lookups (read-only views of the server's document) ----------
const order = () => S.doc.scenes.flatMap((sc) => sc.slides);
const slideById = (id) => S.doc.slides.find((s) => s.id === id);
const containerOf = (id) => [...S.doc.scenes, ...S.doc.banks].find((x) => x.slides.includes(id)); // scene or bank
const curSlide = () => (S.doc && slideById(S.slide)) || null;
const curLayer = () => curSlide()?.layers.find((l) => l.id === S.layer) ?? null;
const contextObjects = () => (S.layer ? curLayer()?.objects : curSlide()?.objects) ?? [];
const selObj = () => (S.sel.length === 1 ? contextObjects().find((o) => o.id === S.sel[0]) ?? null : null);
const selObjs = () => contextObjects().filter((o) => S.sel.includes(o.id));
/** Plain click/Tab selects one object; Shift/Ctrl adds or removes it. */
function selectObj(id, add) {
  S.sel = !add ? [id] : S.sel.includes(id) ? S.sel.filter((x) => x !== id) : [...S.sel, id];
  render();
  if (add) announce(`${S.sel.length} object${S.sel.length === 1 ? '' : 's'} selected`);
}
const slideObjects = (s = curSlide()) => (s ? [...s.objects, ...s.layers.flatMap((l) => l.objects)] : []);
const contextTriggers = () => (S.layer ? curLayer()?.triggers : curSlide()?.triggers) ?? [];
const quizVars = () => S.doc.quizzes.flatMap((q) => ['scorePercent', 'scorePoints', 'passPercent', 'passPoints', 'passed'].map((k) => `${q.id}.${k}`));
const varType = (name) => S.doc.variables.find((v) => v.name === name)?.type ?? (/\.passed$/.test(name || '') ? 'boolean' : /\./.test(name || '') ? 'number' : 'text');
const valueDefault = (name) => ({ boolean: 'true', number: '0', text: '' })[varType(name)];
function typed(name, raw) {
  const t = varType(name);
  if (t === 'boolean') return raw === true || raw === 'true';
  if (t === 'number') return raw === '' || Number.isNaN(Number(raw)) ? String(raw) : Number(raw); // a bad number reaches the server and gets its error
  return String(raw ?? '');
}
const objLabel = (o) => `${o.name || (o.text ? o.text.slice(0, 24) : o.type)} (${o.id})`; // people-facing first, the id second

// ---------- server I/O ----------
async function call(method, url, body) {
  try {
    const res = await fetch(url, { method, headers: { 'x-cf-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({ ok: false, errors: [{ path: '/', code: 'http', message: `HTTP ${res.status}` }] }));
    return { ...data, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, errors: [{ path: '/', code: 'network', message: `server unreachable (${e.message})`, hint: 'is node packages/server/server.js still running?' }] };
  }
}
const courseUrl = (suffix = '') => `/api/courses/${encodeURIComponent(S.name)}${suffix}`;

// ----- file pickers (FR-B1): copy a picked file into the courses folder, then use its path as before -----
/** A picked file's name as the server accepts it: lowercase letters, digits, dots and dashes. */
const safeName = (n) => {
  const ext = (/\.[a-z0-9]{1,8}$/i.exec(n)?.[0] ?? '').toLowerCase();
  return `${n.slice(0, n.length - ext.length).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'file'}${ext}`;
};
/** Add a file picker under a path field built with ctl(); `picked(path, file)` runs after the copy. */
const withPick = (fieldEl, dir, accept, label, picked) => { fieldEl.append(filePick(fieldEl.querySelector('input'), dir, accept, label, picked)); return fieldEl; };
/** A "Choose file…" button: copies the picked file into `dir` (imports or assets) and puts its path in `input`. */
function filePick(input, dir, accept, label, picked) {
  const status = h('span', { class: 'pick-status', role: 'status' });
  const pick = h('input', { type: 'file', accept, hidden: true, 'data-ui': 'file.pick', 'aria-label': `${label}: choose a file`,
    onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      status.textContent = `Copying ${f.name}…`;
      let r;
      try { r = await (await fetch(`/api/files?dir=${dir}&name=${encodeURIComponent(safeName(f.name))}`, { method: 'POST', headers: { 'x-cf-token': token }, body: f })).json(); } catch (err) { r = { ok: false, errors: [{ path: '/', code: 'network', message: `the file could not be copied (${err.message})` }] }; }
      status.textContent = r.ok ? `Copied to ${r.path}` : 'Not copied';
      if (!r.ok) return showErrors(r.errors);
      input.value = r.path;
      picked?.(r.path, f);
    } });
  return h('div', { class: 'file-pick' }, h('button', { type: 'button', 'data-ui': 'file.pick', 'aria-label': `Choose file… for ${label}`, onclick: () => pick.click() }, 'Choose file…'), pick, status);
}

let queue = Promise.resolve();
let busy = 0;
const setBusy = (d) => { busy += d; document.body.dataset.busy = String(busy); };
/** Run server work one request at a time, so every write carries the latest rev. */
function enqueue(fn) {
  setBusy(1);
  const run = queue.then(fn);
  queue = run.catch((e) => toast(e.message, 'error')).finally(() => { setBusy(-1); maybeSync(); });
  return run;
}

// Save status in the header: Saving… while an edit is on its way, then All changes saved or Not saved.
let saving = 0;
function saveStatus(r) {
  if (r) S.saveErr = r.ok ? null : 'Not saved';
  const el = $('#save-status');
  el.textContent = saving ? 'Saving…' : S.saveErr ?? (S.saved ? 'All changes saved' : '');
  el.classList.toggle('err', !saving && !!S.saveErr);
}
/** Wait until every queued edit has reached the server (before switching or closing a course). */
async function drain() { while (busy) await queue; }

/** Send a command batch (or a function returning one, evaluated when its turn comes). */
function dispatch(cmds, origin, { quiet = false } = {}) {
  const name = S.name;
  const el = typeof origin === 'string' ? document.getElementById(origin) : null;
  const typed = el?.matches('input:not([type=checkbox]):not([type=radio]):not([type=color]), textarea') ? el.value : undefined; // kept if the server refuses it
  return enqueue(async () => {
    if (S.name !== name) return null; // its course was closed before its turn
    const list = typeof cmds === 'function' ? cmds() : cmds;
    if (!list?.length) return null;
    saving++; saveStatus();
    const r = await call('POST', courseUrl('/commands'), { commands: list, rev: S.rev });
    saving--; S.saved = true; saveStatus(r);
    if (S.name !== name) return r; // a late answer must never reopen or change another course
    record({ kind: 'commands', cmds: list }, r);
    if (r.ok) { S.fieldErr = null; S.textRetry = null; adopt(r); render(); }
    else if (r.status === 409) { await reload(); toast('This course was changed by another client, so your last edit was not applied. The editor now shows the latest version.', 'error'); }
    else if (!quiet) showErrors(r.errors, typeof origin === 'function' ? origin(r.errors) : origin, typed);
    return r;
  });
}

function adopt(r) {
  Object.assign(S, { doc: r.doc, rev: r.rev, history: r.history ?? S.history, file: r.file ?? S.file, importSummary: r.importSummary ?? null });
  if (!slideById(S.slide)) { S.slide = order()[0] ?? null; S.layer = null; S.sel = []; }
  const s = curSlide();
  if (!s?.layers.some((l) => l.id === S.layer)) S.layer = null;
  const here = (id) => contextObjects().some((o) => o.id === id);
  if (S.sel.length === 1 && !here(S.sel[0])) { // keep a single selection that moved between base and layers
    const l = s?.layers.find((x) => x.objects.some((o) => o.id === S.sel[0]));
    if (l) S.layer = l.id; else if (s?.objects.some((o) => o.id === S.sel[0])) S.layer = null;
  }
  S.sel = S.sel.filter(here);
}

async function reload() {
  const r = await call('GET', courseUrl());
  if (!r.ok) { showErrors(r.errors); return false; }
  adopt(r); S.fieldErr = null; render(); // open question and trigger drafts stay: they are the author's unsaved work
  return true;
}

function record(entry, r) {
  S.log.push({ ...entry, ok: !!r.ok, errors: r.errors, at: new Date().toLocaleTimeString(), file: r.file ?? S.file, name: entry.name ?? S.name });
  S.last = S.log.at(-1);
  renderLog();
}

// ---------- live sync (SSE): agents edit the same file through cf / MCP ----------
let events = null, sseRev = 0, syncing = false;
function subscribe() {
  events?.close(); sseRev = 0; document.body.dataset.live = '0';
  if (!S.name) return;
  events = new EventSource(courseUrl(`/events?token=${encodeURIComponent(token)}`));
  events.onopen = () => { document.body.dataset.live = '1'; };
  events.onmessage = (e) => { try { sseRev = JSON.parse(e.data).rev; } catch { return; } maybeSync(); };
}
// ponytail: revs are file mtimes, so "newer" is ">"; a clock set backwards needs a manual reload.
async function maybeSync() {
  if (busy || syncing || !S.name || !(sseRev > S.rev)) return;
  syncing = true;
  try { if (await reload()) toast('Updated by another client.'); } finally { syncing = false; }
}

// ---------- feedback: toasts, inline errors, dialogs ----------
const fmtErr = (e) => `${e.message}${e.hint ? `. Hint: ${e.hint}` : ''}${e.path && e.path !== '/' ? ` [${e.index !== undefined ? `command ${e.index + 1} ` : ''}${e.path}]` : ''}`;
function toast(text, kind = 'info') {
  const box = $('#toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('p', {}, text), h('button', { type: 'button', class: 'ghost', 'aria-label': 'Dismiss message', 'data-ui': 'toast.dismiss', onclick: () => t.remove() }, '×'));
  box.append(t);
  while (box.children.length > 4) box.firstElementChild.remove();
  if (kind !== 'error') setTimeout(() => t.remove(), 5000); // errors stay until dismissed
}
const announce = (text) => { $('#sr-status').textContent = text; };
/** Show errors in a toast and next to the field they came from; that field keeps what the author typed (not saved). */
function showErrors(errors = [], originId, typed) {
  const text = errors.map(fmtErr).join('\n') || 'The request failed.';
  S.fieldErr = originId ? { id: originId, text, typed } : null;
  render();
  toast(text, 'error');
}
function markFieldError() {
  for (const el of document.querySelectorAll('.field-err')) el.remove();
  for (const el of document.querySelectorAll('[aria-invalid]')) { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
  const el = S.fieldErr && document.getElementById(S.fieldErr.id);
  if (!el) return;
  if (S.fieldErr.typed !== undefined) el.value = S.fieldErr.typed; // the refused value stays, marked invalid, to correct and retry
  const msg = h('p', { class: 'field-err', id: `${el.id}-err` }, S.fieldErr.text);
  el.setAttribute('aria-invalid', 'true');
  el.setAttribute('aria-describedby', msg.id);
  (el.closest('.field, .toolbar') ?? el.parentElement).append(msg);
}

/**
 * Modal dialog built on <dialog>. Resolves with field values on OK, null on cancel/Escape.
 * `library: true` puts the fields on a File tab beside a Library tab of original images (the library.list
 * query); choosing one resolves {library: id, alt}, and the caller sends asset.add {library} with its insert command.
 */
function ask({ title, message, fields = [], ok = 'OK', danger = false, cmd = null, library = false }) {
  const dlg = $('#dlg');
  dlg.className = library ? 'lib' : '';
  return new Promise((resolve) => {
    let picked = null;
    const head = h('h2', { id: 'dlg-title' }, title);
    const form = h('form', { method: 'dialog' },
      !library && head, message && h('p', { class: 'msg' }, message),
      fields.map((f) => { // f.file = accepted types: the field also gets a Choose file… picker that copies into assets/
        const el = field(`ask-${f.name}`, f.label, h('input', { id: `ask-${f.name}`, 'data-cmd': cmd, 'data-ui': cmd ? null : 'dialog.field', name: f.name, value: f.value ?? '', required: f.required, placeholder: f.placeholder, spellcheck: 'false' }));
        return f.file ? withPick(el, 'assets', f.file, f.label) : el;
      }),
      h('div', { class: 'dlg-actions' },
        h('button', { type: 'button', 'data-ui': 'dialog.cancel', onclick: () => dlg.close('cancel') }, 'Cancel'), // not a submit button: Enter in a field means OK
        h('button', { value: 'ok', class: danger ? 'danger' : 'primary', 'data-cmd': cmd, 'data-ui': cmd ? null : 'dialog.ok' }, ok)));
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    dlg.replaceChildren(library ? h('div', { class: 'dlg-body' }, head, ...sourceTabs(form, (x) => { picked = { library: x.id, alt: x.alt }; dlg.close(); })) : form);
    dlg.returnValue = '';
    dlg.onclose = () => resolve(picked ?? (dlg.returnValue === 'ok' ? Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value.trim()])) : null));
    dlg.showModal();
  });
}
/** File | Library tabs for an image dialog: the Library tab searches the library.list query and calls pick(entry). */
function sourceTabs(form, pick) {
  const tabs = [['file', 'File'], ['lib', 'Library']];
  const q = h('input', { type: 'search', id: 'lib-q', 'data-ui': 'library.search', autocomplete: 'off', spellcheck: 'false', placeholder: 'goggles, safety, people…', oninput: () => load() });
  const tag = h('select', { id: 'lib-tag', 'data-ui': 'library.tag', onchange: () => load() }, h('option', { value: '' }, 'All tags'));
  const status = h('p', { class: 'hint', role: 'status' });
  const list = h('ul', { class: 'lib-grid', 'aria-label': 'Library images' });
  const panels = {
    file: h('div', { role: 'tabpanel', id: 'dlg-panel-file', 'aria-labelledby': 'dlg-tab-file' }, form),
    lib: h('div', { role: 'tabpanel', id: 'dlg-panel-lib', 'aria-labelledby': 'dlg-tab-lib', hidden: true },
      h('div', { class: 'grid2' }, field('lib-q', 'Search the library', q), field('lib-tag', 'Tag', tag)), status, list,
      hint('Original images drawn for CourseForge Studio. They are copied into the published course; no download, no attribution needed.'),
      h('div', { class: 'dlg-actions' }, h('button', { type: 'button', 'data-ui': 'dialog.cancel', onclick: () => $('#dlg').close() }, 'Cancel'))),
  };
  let seq = 0, tagged = false;
  async function load() { // ponytail: one query per keystroke; the local server answers in milliseconds
    const n = ++seq;
    const args = { ...(q.value.trim() ? { q: q.value.trim() } : {}), ...(tag.value ? { tag: tag.value } : {}) };
    const r = await call('GET', courseUrl(`/query/library.list?args=${encodeURIComponent(JSON.stringify(args))}`));
    if (n !== seq) return;
    if (!r.ok) { status.textContent = r.errors?.[0]?.message ?? 'The library is unavailable.'; return; }
    if (!tagged) { tagged = true; tag.append(...opts([...new Set(r.data.flatMap((x) => x.tags))].sort(), '')); }
    status.textContent = `${r.data.length} image${r.data.length === 1 ? '' : 's'}`;
    list.replaceChildren(...r.data.map((x) => h('li', {}, h('button', { type: 'button', class: 'lib-item', id: `lib-${x.id}`, 'data-cmd': 'asset.add', title: x.alt, onclick: () => pick(x) },
      h('img', { src: `/assets/${encodeURIComponent(token)}/${encodeURIComponent(S.name)}/library/${encodeURIComponent(x.file)}`, alt: '' }), h('span', {}, x.title)))));
  }
  const select = (k) => {
    for (const [t] of tabs) { const b = document.getElementById(`dlg-tab-${t}`); b.setAttribute('aria-selected', String(t === k)); b.tabIndex = t === k ? 0 : -1; panels[t].hidden = t !== k; }
    document.getElementById(`dlg-tab-${k}`).focus();
    if (k === 'lib' && !tagged) load();
  };
  const tablist = h('div', { class: 'tabs dlg-tabs', role: 'tablist', 'aria-label': 'Image source', onkeydown: (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); select(e.target.id === 'dlg-tab-file' ? 'lib' : 'file'); } } },
    tabs.map(([k, label], i) => h('button', { type: 'button', role: 'tab', id: `dlg-tab-${k}`, 'aria-selected': String(!i), 'aria-controls': `dlg-panel-${k}`, tabindex: i ? '-1' : '0', 'data-ui': 'tab', onclick: () => select(k) }, label)));
  return [tablist, panels.file, panels.lib];
}
function show(title, cls, ...content) {
  const dlg = $('#dlg');
  dlg.className = cls;
  dlg.setAttribute('aria-labelledby', 'dlg-title');
  dlg.onclose = null;
  dlg.replaceChildren(h('div', { class: 'dlg-body' }, h('div', { class: 'dlg-head' }, h('h2', { id: 'dlg-title' }, title), h('button', { type: 'button', 'data-ui': 'dialog.close', onclick: () => dlg.close() }, 'Close')), ...content));
  dlg.showModal();
}

/** Delete with confirmation (args may list several items: one atomic batch); when the server says an item is still referenced, show where and offer force. */
async function removeWithForce(cmd, args, label) {
  const list = [].concat(args);
  if (!(await ask({ title: `Delete ${label}?`, ok: 'Delete', danger: true, cmd }))) return null;
  const r = await dispatch(list.map((a) => ({ cmd, args: a })), null, { quiet: true });
  if (r && !r.ok && r.status === 400 && /referenced|is used|still has/.test(r.errors?.[0]?.message || '')) {
    const e = r.errors[0];
    if (await ask({ title: `${cap(label)} ${list.length > 1 ? 'are' : 'is'} still in use`, message: `${e.message}. ${e.hint || ''}`, ok: 'Delete and remove the references', danger: true, cmd })) return dispatch(list.map((a) => ({ cmd, args: { ...a, force: true } })));
    return null;
  }
  if (r && !r.ok && r.status !== 409) showErrors(r.errors);
  return r;
}

// ---------- render ----------
let quietFocus = false; // focus moved by the editor itself (restore, pointer gesture): never changes the selection
function render() {
  const a = document.activeElement;
  if (a?.matches?.('#app input:not([type=checkbox]):not([type=radio]):not([type=color]), #app textarea, #app [contenteditable=true], #app [role=toolbar] button')) a.blur(); // commit a pending edit before its field is replaced
  const focusId = document.activeElement?.id || a?.id;
  document.body.classList.toggle('has-course', !!S.doc);
  const lessons = LV.active(); // a lessons course shows the lessons view instead of the slide canvas
  $('#picker').hidden = !!S.doc;
  $('#app').hidden = !S.doc || lessons;
  LV.show(lessons);
  $('.skip').setAttribute('href', lessons ? '#lv-page' : '#stage');
  $('.skip').textContent = lessons ? 'Skip to lesson' : 'Skip to canvas';
  renderTop();
  if (S.doc) { if (lessons) LV.render(); else { renderOutline(); renderStage(); renderTimeline(); renderInspector(); } } else renderPicker();
  renderLog();
  if (AI.isOpen() && !$('#ai-panel').contains(document.activeElement)) AI.renderPanel(); // keep the slide chip current, never under the author's typing
  markFieldError();
  for (const el of document.querySelectorAll('[data-cmd]')) if (!el.title && S.summaries[el.dataset.cmd]) el.title = `${el.dataset.cmd}: ${S.summaries[el.dataset.cmd]}`;
  if (focusId && document.activeElement?.id !== focusId) focusQuiet(document.getElementById(focusId));
}
function focusQuiet(el) { const q = quietFocus; quietFocus = true; el?.focus({ preventScroll: true }); quietFocus = q; }

function renderTop() {
  $('#course-title').textContent = S.doc?.title ?? '';
  $('#course-file').textContent = S.doc ? S.file.split(/[\\/]/).at(-1) : '';
  $('#course-file').title = S.doc ? S.file : '';
  $('#btn-undo').disabled = !S.history.undo;
  $('#btn-redo').disabled = !S.history.redo;
  $('#btn-undo .lbl').textContent = S.history.undo ? `Undo (${S.history.undo})` : 'Undo';
  $('#btn-redo .lbl').textContent = S.history.redo ? `Redo (${S.history.redo})` : 'Redo';
  $('#btn-undo').title = S.history.undoLabel ? `Undo: ${S.history.undoLabel}` : 'Nothing to undo';
  $('#btn-redo').title = S.history.redoLabel ? `Redo: ${S.history.redoLabel}` : 'Nothing to redo';
  $('#btn-agent').disabled = !S.last;
}

function renderPicker() {
  const list = S.courses;
  const importFormat = $('#imp-format')?.value ?? 'story', fileFormat = $('#new-format')?.value ?? 'json';
  const lessons = $('#new-mode-lessons')?.checked ?? false;
  const formats = [['json', 'CourseForge Studio (.course.json)'], ['story', 'Storyline (.story)']];
  const newMode = (mode) => { if (mode === 'lessons') $('#new-format').value = 'json'; $('#new-format').disabled = mode === 'lessons'; };
  const icon = (name) => h('span', { class: 'ico', style: `--ico: url(/editor/icons/${name}.svg)`, 'aria-hidden': 'true' });
  const tile = (id, ico, title, text, onclick, primary) => h('button', { type: 'button', id, class: `start-tile${primary ? ' primary' : ''}`, 'data-ui': id, onclick },
    icon(ico), h('span', { class: 'tile-t' }, title), h('span', { class: 'tile-d' }, text));
  const ago = (rev) => { const m = Math.round((Date.now() - rev) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(rev).toLocaleDateString(); };
  const meta = (c) => [c.cover?.mode === 'lessons' ? 'Lessons' : 'Slides', c.cover?.mode === 'lessons' ? `${c.cover.lessons} lessons` : c.cover ? `${c.cover.slides} slides` : null, `edited ${ago(c.rev)}`].filter(Boolean).join(' · ');
  const reveal = (id) => { $(id).focus(); $(id).scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  $('#picker').replaceChildren(h('div', { class: 'home' },
    h('section', { class: 'start', 'aria-labelledby': 'start-h' },
      h('h1', { id: 'start-h' }, 'Start a course'),
      h('div', { class: 'start-strip' },
        tile('start-ai', 'sparkle', 'Create with AI', 'Describe the course or attach a document. Claude drafts it for you to review.', () => AI.create(), true),
        tile('start-outline', 'outline', 'From an outline', 'Paste headings and points. Each heading becomes a scene with slides.', () => startFromOutline()),
        tile('start-blank', 'document-add', 'Blank course', 'An empty slides or lessons course, ready to build.', () => reveal('#new-name')),
        tile('start-import', 'import', 'Open a .story file', 'Work on a copy of a Storyline project, or convert it.', () => reveal('#imp-path'))),
      AI.statusLine()),
    h('section', { class: 'shelf', 'aria-labelledby': 'shelf-h' },
      h('div', { class: 'shelf-head' }, h('h2', { id: 'shelf-h' }, 'Your courses'), list?.length ? h('span', { class: 'muted' }, `${list.length} course${list.length === 1 ? '' : 's'}`) : null),
      !token ? h('p', { class: 'field-err', role: 'alert' }, 'This page was opened without its access token. Close it and open CourseForge Studio again from its shortcut.') : null,
      list === null ? h('ul', { class: 'course-list loading', 'aria-busy': 'true', 'aria-label': 'Loading courses' }, [1, 2, 3].map(() => h('li', {}, h('div', { class: 'course-card skel' }))))
        : list.length ? h('ul', { class: 'course-list' }, list.map((c) => h('li', {}, h('button', { type: 'button', class: 'course-card', 'data-ui': 'course.open', onclick: () => openCourse(c.name), 'aria-describedby': `cm-${c.name}` },
          coverView(c), h('span', { class: 'cc-text' }, h('span', { class: 'ct' }, c.title ?? 'Unreadable file'), h('span', { class: 'cm', id: `cm-${c.name}`, 'aria-hidden': 'true' }, c.invalid ? 'Open it to see what is wrong' : meta(c)), h('code', {}, c.file))))))
        : h('div', { class: 'shelf-empty' }, h('p', {}, h('strong', {}, 'No courses yet.')), hint('Start one above. Courses are saved as files in this folder, so you can back them up or share them like any document.'))),
    h('div', { class: 'new-panels' },
      h('section', { class: 'new-panel', 'aria-labelledby': 'new-h' }, h('h2', { id: 'new-h' }, 'New course'),
        h('form', { class: 'new-course', onsubmit: createCourse },
          h('fieldset', { class: 'course-mode' }, h('legend', {}, 'Course type'),
            ctl('radio', 'new-mode-slides', 'Slides', !lessons, { cmd: 'new_course', set: newMode, attrs: { name: 'new-mode', value: 'slides' } }),
            ctl('radio', 'new-mode-lessons', 'Lessons', lessons, { cmd: 'new_course', set: newMode, attrs: { name: 'new-mode', value: 'lessons' } }),
            h('p', { class: 'hint' }, 'Slides: a fixed-size canvas with layers and triggers. Lessons: scrolling pages of blocks that read well on any screen.')),
          ctl('text', 'new-name', 'File name', '', { cmd: 'new_course', attrs: { required: true, pattern: '[a-z0-9][a-z0-9\\-]{0,60}', placeholder: 'safety-101', spellcheck: 'false', autocomplete: 'off' } }),
          ctl('text', 'new-title', 'Course title', '', { cmd: 'new_course', attrs: { placeholder: 'Lab Safety 101' } }),
          ctl('select', 'new-format', 'File format', fileFormat, { cmd: 'new_course', options: formats }),
          h('button', { type: 'submit', class: 'primary', 'data-cmd': 'new_course' }, 'Create course'))),
      h('section', { class: 'new-panel', 'aria-labelledby': 'imp-h' }, h('h2', { id: 'imp-h' }, 'Import a .story file'),
        hint('Open an editable .story copy, or convert it to a CourseForge Studio course. The source file is never changed; anything the editor cannot show is listed in a report beside the course.'),
        h('form', { class: 'new-course', onsubmit: importCourse },
          withPick(ctl('text', 'imp-path', 'Path of the .story file in the courses folder', '', { cmd: 'import_story', attrs: { required: true, placeholder: 'imports/module-1.story', spellcheck: 'false', autocomplete: 'off' } }), 'imports', '.story', 'Storyline file',
            (p, file) => { if (!$('#imp-name').value) $('#imp-name').value = safeName(file.name).replace(/\.story$/, '').replace(/[^a-z0-9-]+/g, '-').slice(0, 60); }),
          ctl('text', 'imp-name', 'Name of the imported course', '', { cmd: 'import_story', attrs: { required: true, pattern: '[a-z0-9][a-z0-9\\-]{0,60}', placeholder: 'module-1', spellcheck: 'false', autocomplete: 'off' } }),
          ctl('select', 'imp-format', 'Import format', importFormat, { cmd: 'import_story', options: formats }),
          h('button', { type: 'submit', class: 'primary', 'data-cmd': 'import_story' }, 'Import'))))));
  $('#new-format').disabled = lessons;
}

/** A course cover: the first slide drawn from its own objects (slides), or the cover image and sections (lessons). */
function coverView(c) {
  const v = c.cover;
  if (!v) return h('span', { class: 'cover broken', 'aria-hidden': 'true' });
  const asset = (p) => `/assets/${token}/${encodeURIComponent(c.name)}/${p}`;
  if (v.mode === 'lessons') return h('span', { class: 'cover lessons', 'aria-hidden': 'true' },
    v.image ? h('img', { src: asset(v.image), alt: '', loading: 'lazy' }) : null,
    h('span', { class: 'cl-text' }, h('span', { class: 'cl-title' }, c.title ?? ''), h('span', { class: 'cl-sections' }, v.sections.map((t) => h('span', {}, t)))));
  const pct = (n, d) => `${(n / d) * 100}%`;
  return h('span', { class: 'cover', 'aria-hidden': 'true', style: { aspectRatio: `${v.w} / ${v.h}`, background: v.bg ?? '#ffffff' } },
    v.objects.map((o) => h('span', {
      class: `co co-${o.type}`,
      style: {
        left: pct(o.x, v.w), top: pct(o.y, v.h), width: pct(o.w, v.w), height: pct(o.h, v.h),
        background: o.image ? null : o.fill ?? (o.type === 'button' ? 'var(--accent)' : o.type === 'input' ? '#ffffff' : null),
        color: o.color ?? (o.type === 'button' ? '#ffffff' : '#1b2129'), fontSize: o.fs ? `calc(${o.fs / v.w} * var(--cw))` : null, fontWeight: o.bold ? '700' : null,
        borderRadius: o.shape === 'ellipse' ? '50%' : o.r ? `calc(${o.r / v.w} * var(--cw))` : null,
      },
    }, o.image ? h('img', { src: asset(o.image), alt: '', loading: 'lazy' }) : o.text && o.type !== 'input' ? o.text : null)));
}

/** "From an outline" on the start screen: a new slides course, opened straight into the outline dialog. */
async function startFromOutline() {
  const taken = new Set((S.courses ?? []).map((c) => c.name));
  let name = 'new-course';
  for (let n = 2; taken.has(name); n++) name = `new-course-${n}`;
  const r = await call('POST', '/api/courses', { name, format: 'json', title: 'New course' });
  record({ kind: 'new_course', name, format: 'json' }, r);
  if (!r.ok) return showErrors(r.errors);
  await openCourse(name, r);
  showOutline();
}

// ----- outline -----
function renderOutline() {
  const el = $('#outline');
  const top = el.querySelector('.outline-body')?.scrollTop ?? 0;
  const s = curSlide();
  const sc = s && containerOf(s.id); // a scene, or a question bank
  const i = sc ? sc.slides.indexOf(s.id) : -1;
  let n = 0;
  const item = (sid, j, where, num) => {
    const sl = slideById(sid);
    return h('li', { class: 'slide-li', draggable: 'true', 'data-cmd': 'slide.move', ondragstart: (e) => { e.dataTransfer.setData('text/x-cf-slide', sid); e.dataTransfer.effectAllowed = 'move'; }, ondragover: dragOver, ondragleave: dragLeave, ondrop: (e) => drop(e, where, j) },
      h('button', { type: 'button', id: `slide-${sid}`, class: 'slide-btn', 'aria-current': sid === S.slide ? 'true' : null, 'data-ui': 'slide.select', onclick: guarded(() => selectSlide(sid)) },
        h('span', { class: 'num' }, num), h('span', { class: 'title' }, sl?.title ?? sid), sl?.draw ? h('span', { class: 'badge draw' }, 'Draw') : sl?.question ? h('span', { class: 'badge' }, 'Q') : null, h('code', {}, sid)));
  };
  const body = h('div', { class: 'outline-body' }, S.doc.scenes.map((scene, i) => h('section', { class: 'scene', 'aria-label': `Scene ${scene.title}` },
    h('div', { class: 'scene-head' },
      h('input', { id: `scene-${scene.id}`, class: 'scene-title', value: scene.title, 'aria-label': `Scene title (${scene.id})`, 'data-cmd': 'scene.set', onchange: (e) => dispatch([{ cmd: 'scene.set', args: { id: scene.id, title: e.target.value } }], e.target.id) }),
      S.doc.scenes.length > 1 && btn('↑', 'scene.move', () => dispatch([{ cmd: 'scene.move', args: { id: scene.id, index: i - 1 } }]), { class: 'ghost icon', 'aria-label': `Move scene ${scene.title} up`, disabled: i === 0 }),
      S.doc.scenes.length > 1 && btn('↓', 'scene.move', () => dispatch([{ cmd: 'scene.move', args: { id: scene.id, index: i + 1 } }]), { class: 'ghost icon', 'aria-label': `Move scene ${scene.title} down`, disabled: i === S.doc.scenes.length - 1 }),
      S.doc.scenes.length > 1 && btn('×', 'scene.remove', () => removeWithForce('scene.remove', { id: scene.id }, `scene "${scene.title}"`), { class: 'ghost icon', 'aria-label': `Delete scene ${scene.title}` })),
    h('ol', { class: 'slides', 'data-cmd': 'slide.move', ondragover: dragOver, ondragleave: dragLeave, ondrop: (e) => drop(e, { scene: scene.id }, scene.slides.length) },
      scene.slides.map((sid, j) => item(sid, j, { scene: scene.id }, ++n))))),
  // ----- question banks: slides outside the flow; draw slides pick from them -----
  h('section', { class: 'banks', 'aria-label': 'Question banks' },
    h('div', { class: 'scene-head' }, h('h2', {}, 'Question banks'), btn('+ Bank', 'bank.add', addBank, { class: 'small', 'aria-label': 'Add question bank' })),
    S.doc.banks.length ? S.doc.banks.map((b) => h('section', { class: 'scene bank', 'aria-label': `Bank ${b.title}` },
      h('div', { class: 'scene-head' },
        h('input', { id: `bank-${b.id}`, class: 'scene-title', value: b.title, 'aria-label': `Bank title (${b.id})`, 'data-cmd': 'bank.set', onchange: (e) => dispatch([{ cmd: 'bank.set', args: { id: b.id, title: e.target.value } }], e.target.id) }),
        btn('+ Q', 'slide.add', () => addBankSlide(b), { class: 'ghost icon', 'aria-label': `Add a question slide to bank ${b.title}` }),
        btn('×', 'bank.remove', () => removeWithForce('bank.remove', { id: b.id }, `bank "${b.title}"`), { class: 'ghost icon', 'aria-label': `Delete bank ${b.title}` })),
      h('ol', { class: 'slides', 'data-cmd': 'slide.move', ondragover: dragOver, ondragleave: dragLeave, ondrop: (e) => drop(e, { bank: b.id }, b.slides.length) },
        b.slides.map((sid, j) => item(sid, j, { bank: b.id }, j + 1))),
      !b.slides.length && hint('Empty. Add a question slide with + Q, or move a slide here.')))
      : hint('A bank holds slides that a draw slide picks from (Insert draw).')));
  el.replaceChildren(
    h('div', { class: 'pane-head' }, h('h2', {}, 'Slides'),
      btn('+ Slide', 'slide.add', guarded(addSlide), { class: 'primary small', 'aria-label': 'Add slide' }),
      btn('+ Draw', 'draw.add', guarded(addDraw), { class: 'small', 'aria-label': 'Insert draw from bank' }),
      btn('+ Scene', 'scene.add', addScene, { class: 'small', 'aria-label': 'Add scene' })),
    body,
    h('div', { class: 'outline-actions', role: 'group', 'aria-label': 'Selected slide' },
      btn('Duplicate', 'slide.duplicate', guarded(() => duplicateSlide(s)), { disabled: !s, 'aria-label': 'Duplicate slide' }),
      btn('↑', 'slide.move', () => dispatch([{ cmd: 'slide.move', args: { id: s.id, index: i - 1 } }]), { disabled: !s || i <= 0, 'aria-label': 'Move slide up' }),
      btn('↓', 'slide.move', () => dispatch([{ cmd: 'slide.move', args: { id: s.id, index: i + 1 } }]), { disabled: !s || i < 0 || i >= sc.slides.length - 1, 'aria-label': 'Move slide down' }),
      btn('Delete', 'slide.remove', () => removeWithForce('slide.remove', { id: s.id }, `slide "${s.title}"`), { disabled: !s, class: 'danger', 'aria-label': 'Delete slide' }),
      s && (S.doc.banks.length > 0 || S.doc.scenes.length > 1) && ctl('select', 'slide-where', 'Move slide to', `${S.doc.banks.includes(sc) ? 'bank' : 'scene'}:${sc?.id}`, {
        cmd: 'slide.move', cls: 'where', commit: (v) => { const [k, id] = v.split(':'); return [{ cmd: 'slide.move', args: { id: s.id, [k]: id } }]; },
        options: [...S.doc.scenes.map((x) => [`scene:${x.id}`, `Scene: ${x.title}`]), ...(s.draw ? [] : S.doc.banks.map((x) => [`bank:${x.id}`, `Bank: ${x.title}`]))],
      })),
    h('div', { class: 'outline-actions', role: 'group', 'aria-label': 'Reusable slides' },
      btn('Export', 'query', () => exportPkg('slide', s.id), { disabled: !s, 'data-query': 'slide.export', 'aria-label': 'Export slide as a reusable file' }),
      btn('Insert from file', 'slide.import', () => $('#import-slide-file').click(), { title: 'Insert a reusable slide from a file' }),
      h('input', { type: 'file', id: 'import-slide-file', accept: '.json,application/json', hidden: true, 'data-cmd': 'slide.import', 'aria-label': 'Reusable slide file', onchange: importSlideFile })));
  body.scrollTop = top;
}
// ----- reusable slides and lessons (P1.4): <kind>.export query -> file; file -> <kind>.import command -----
async function exportPkg(kind, id) {
  const query = `${kind}.export`;
  const r = await call('GET', courseUrl(`/query/${query}?args=${encodeURIComponent(JSON.stringify({ id }))}`));
  record({ kind: 'query', name: S.name, query, args: { id } }, r);
  if (!r.ok) return showErrors(r.errors);
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' })), download: `${id}.${kind}.json` });
  document.body.append(a); a.click(); a.remove();
  toast(`Exported ${id}.${kind}.json; insert it into any ${kind === 'lesson' ? 'lessons ' : ''}course with "Insert from file" (or ${kind}.import).`);
}
/** The file picked in a file input, parsed as JSON (the input is reset so the same file can be picked again); null if none or invalid. */
async function readJsonFile(e, kind) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return null;
  try { return JSON.parse(await file.text()); } catch { toast(`${file.name} is not a JSON ${kind} package`, 'error'); return null; }
}
async function importSlideFile(e) {
  const data = await readJsonFile(e, 'slide');
  if (!data) return;
  const sc = S.doc.scenes.find((x) => x.slides.includes(S.slide)) ?? S.doc.scenes.at(-1);
  const r = await dispatch([{ cmd: 'slide.import', args: { data, scene: sc.id, ...(S.slide ? { index: sc.slides.indexOf(S.slide) + 1 } : {}) } }]);
  if (r?.ok) {
    const res = r.results[0];
    selectSlide(res.id);
    toast(res.skipped.length ? `Inserted; ${res.skipped.length} trigger(s) pointing at slides or quizzes this course lacks were skipped.` : 'Inserted the reusable slide.');
  }
}
// ----- course check (P1.7): the same validate + a11y queries agents use; each issue links to its object -----
async function showCheck() {
  const [v, a, r] = await Promise.all([call('GET', courseUrl('/query/validate')), call('GET', courseUrl('/query/a11y')), call('GET', courseUrl('/query/resume'))]);
  if (!v.ok || !a.ok) return showErrors([...(v.errors || []), ...(a.errors || [])]);
  const issues = [...v.data.map((e) => ({ severity: 'error', code: e.code, path: e.path, message: e.message, fix: e.hint })), ...a.data, ...(r.ok ? r.data : [])];
  const go = async (p) => {
    if (!(await leaveDrafts())) return;
    if (LV.active()) { $('#dlg').close(); LV.goto(p); return; } // lessons paths (sections/.., /cover)
    const m = /^\/slides\/(\d+)(?:\/layers\/(\d+))?(?:\/objects\/(\d+))?/.exec(p);
    const sl = m && S.doc.slides[+m[1]];
    if (!sl) return;
    const layer = m[2] !== undefined ? sl.layers[+m[2]] : null;
    const obj = m[3] !== undefined ? (layer ?? sl).objects[+m[3]] : null;
    $('#dlg').close();
    Object.assign(S, { slide: sl.id, layer: layer?.id ?? null, sel: obj ? [obj.id] : [], draft: {}, fieldErr: null, tab: 'props' });
    render();
  };
  show(`Check course: ${issues.length ? `${issues.length} issue(s)` : 'no issues'}`, 'wide',
    S.importSummary?.reported ? group('Native .story display report',
      hint(`${S.importSummary.reported} source items have display or behavior limitations in this editor. They are retained in the .story file when saving.`),
      h('ul', {}, Object.entries(S.importSummary.byKind).map(([kind, count]) => h('li', {}, `${kind}: ${count}`)))) : null,
    hint('Validation errors and accessibility warnings, from the same validate and a11y queries an agent uses (cf query <file> a11y). Each fix names the command that resolves it.'),
    issues.length ? h('ul', { class: 'check-list' }, issues.map((x) => h('li', { class: `check ${x.severity}` },
      h('span', { class: 'sev' }, x.severity), ' ', h('span', {}, x.message),
      x.fix ? h('code', { class: 'fix' }, x.fix) : null,
      /^\/(slides|sections|cover)(\/|$)/.test(x.path || '') ? btn('Go to', null, () => go(x.path), { class: 'small', 'data-ui': 'check.goto', 'aria-label': `Go to ${x.path}` }) : null)))
      : h('p', {}, 'No validation or accessibility issues found.'));
}

function dragOver(e) { if (e.dataTransfer.types.includes('text/x-cf-slide')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } }
function dragLeave(e) { e.currentTarget.classList.remove('drop'); }
function drop(e, where, index) { // where: {scene} or {bank}
  e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('drop');
  const id = e.dataTransfer.getData('text/x-cf-slide');
  if (id) dispatch([{ cmd: 'slide.move', args: { id, ...where, index } }]);
}
const nextId = (key = 'id') => { const v = $('#next-id').value.trim(); return v ? { [key]: v } : {}; };
const consumeNextId = () => { $('#next-id').value = ''; };
function selectSlide(id) { Object.assign(S, { slide: id, layer: null, sel: [], draft: {}, fieldErr: null }); render(); }
/** What the author changed in a form but has not saved: the question editor, an open trigger form. */
function dirtyDrafts() {
  const q = S.draft.question, s = q && slideById(q.slide);
  return [
    s && JSON.stringify(q.q ?? null) !== JSON.stringify(s.question ?? null) && 'question',
    S.draft.trigger && JSON.stringify(S.draft.trigger) !== S.draft.triggerAtOpen && 'trigger',
  ].filter(Boolean);
}
/** Before navigation that would drop drafts: ask; true = go ahead. */
async function leaveDrafts() {
  const d = dirtyDrafts();
  return !d.length || !!(await ask({ title: `Discard the unsaved ${d.join(' and ')}?`, message: `You changed the ${d.join(' and the ')} on this slide but did not save. Stay to save it, or discard the changes.`, ok: 'Discard changes', danger: true }));
}
/** Wrap a navigation handler so unsaved drafts are confirmed first. */
const guarded = (fn) => async (...a) => { if (await leaveDrafts()) return fn(...a); render(); }; // render: a cancelled select shows its old value again
async function addSlide() {
  const sc = S.doc.scenes.find((x) => x.slides.includes(S.slide)) ?? S.doc.scenes.at(-1);
  const i = sc.slides.indexOf(S.slide);
  const r = await dispatch([{ cmd: 'slide.add', args: { ...nextId(), scene: sc.id, ...(i >= 0 ? { index: i + 1 } : {}) } }], 'next-id');
  if (r?.ok) { consumeNextId(); selectSlide(r.results[0].id); announce(`Slide ${r.results[0].id} added`); }
}
async function addScene() {
  const r = await dispatch([{ cmd: 'scene.add', args: { ...nextId(), title: `Scene ${S.doc.scenes.length + 1}` } }], 'next-id');
  if (r?.ok) consumeNextId();
}
// ----- question banks and draws -----
async function addBank() {
  const r = await dispatch([{ cmd: 'bank.add', args: { ...nextId(), title: `Question bank ${S.doc.banks.length + 1}` } }], 'next-id');
  if (r?.ok) { consumeNextId(); announce(`Bank ${r.results[0].id} added`); }
}
async function addBankSlide(b) {
  const question = { type: 'mc', prompt: 'New question', choices: [{ id: 'a', label: 'Answer A', correct: true }, { id: 'b', label: 'Answer B' }] };
  const r = await dispatch([{ cmd: 'slide.add', args: { ...nextId(), bank: b.id, title: `Question ${b.slides.length + 1}`, question } }], 'next-id');
  if (r?.ok) { consumeNextId(); selectSlide(r.results[0].id); S.tab = 'question'; render(); announce(`Question slide ${r.results[0].id} added to ${b.title}`); }
}
/** Insert > Draw from bank: after the selected flow slide, from the selected slide's bank (else the first bank). */
async function addDraw() {
  const bank = S.doc.banks.find((b) => b.slides.includes(S.slide)) ?? S.doc.banks[0];
  if (!bank) { toast('Add a question bank first ("+ Bank" under Question banks), then insert the draw.'); return; }
  const sc = S.doc.scenes.find((x) => x.slides.includes(S.slide)) ?? S.doc.scenes.at(-1);
  const i = sc.slides.indexOf(S.slide);
  const r = await dispatch([{ cmd: 'draw.add', args: { ...nextId(), bank: bank.id, scene: sc.id, ...(i >= 0 ? { index: i + 1 } : {}) } }], 'next-id');
  if (r?.ok) { consumeNextId(); selectSlide(r.results[0].id); S.tab = 'slide'; render(); announce(`Draw ${r.results[0].id} inserted`); }
}
async function duplicateSlide(s) {
  const r = await dispatch([{ cmd: 'slide.duplicate', args: { id: s.id, ...nextId('newId'), title: `${s.title} (copy)` } }], 'next-id');
  if (r?.ok) { consumeNextId(); selectSlide(r.results[0].id); }
}

// ----- canvas -----
let zoom = 1;
function renderStage() {
  const s = curSlide();
  const L = curLayer();
  const layerSel = $('#edit-layer');
  layerSel.replaceChildren(...opts([['', 'Base layer'], ...(s?.layers ?? []).map((l) => [l.id, `Layer: ${l.title}`])], S.layer ?? ''));
  layerSel.value = S.layer ?? '';
  layerSel.disabled = !s;
  for (const b of document.querySelectorAll('#insertbar [data-type]')) b.disabled = !s || !!s.draw; // a draw slide has no objects
  $('#btn-copy').disabled = $('#btn-dup').disabled = !S.sel.length;
  $('#btn-paste').disabled = !s || !S.clip;
  const stage = $('#stage');
  const { w, h: hh } = S.doc.size;
  Object.assign(stage.style, { width: `${w}px`, height: `${hh}px`, background: s?.background || '' });
  stage.setAttribute('aria-label', s ? `Slide canvas: ${s.title}${L ? `, editing layer ${L.title}` : ''}. Tab to an object; Shift or Ctrl+click adds to the selection; arrows move it, Shift for 10 pixels, Delete removes it. Press ? for all shortcuts.` : 'Slide canvas');
  if (!s) stage.replaceChildren(h('p', { class: 'stage-empty' }, 'No slides yet. Add one with "+ Slide".'));
  else if (s.draw) stage.replaceChildren(drawCard(s)); // a summary card, not objects
  else {
    const q = s.question;
    const onSlide = q && ['hotspot', 'dragdrop'].includes(q.type); // these questions use the slide itself under a prompt banner
    const qPreview = q && (onSlide
      ? h('div', { class: `q-banner${L ? ' dim' : ''}`, 'aria-hidden': 'true' }, q.prompt || '(no prompt yet)')
      : h('div', { class: `q-preview${L ? ' dim' : ''}`, 'aria-hidden': 'true' },
        h('p', { class: 'q-prompt' }, q.prompt || '(no prompt yet)'),
        q.type === 'fill' ? h('div', { class: 'q-fill' }, 'The learner types an answer here')
          : q.type === 'matching' ? h('ul', {}, (q.rows || []).map((r) => h('li', {}, `${r.label || r.id}   [choose ▾]`)))
            : h('ul', {}, q.choices.map((c, i) => h('li', {}, `${q.type === 'sequence' ? `${i + 1}. ` : ''}${c.label || c.id}`))),
        h('p', { class: 'q-note' }, 'Question area drawn by the player. Edit it in the Question tab.')));
    stage.replaceChildren(...(qPreview && !onSlide ? [qPreview] : []), ...(L?.hideBaseObjects ? [] : s.objects.map((o) => objEl(o, !!L))), ...(L ? L.objects.map((o) => objEl(o, false)) : []),
      ...areaEls(s, !!L), ...(qPreview && onSlide ? [qPreview] : []));
  }
  fit();
  for (const el of stage.querySelectorAll('[data-text-fit]')) fitText(el, JSON.parse(el.dataset.textFit), el.dataset.textValign || undefined);
}
function drawCard(s) {
  const w = s.draw;
  const bank = S.doc.banks.find((b) => b.id === w.bank);
  const n = bank ? bank.slides.filter((x) => !w.never.includes(x)).length : 0;
  const title = (id) => slideById(id)?.title ?? id;
  return h('div', { class: 'draw-card' },
    h('p', { class: 'draw-kicker' }, 'Question draw'),
    h('h2', {}, `${w.count && w.count < n ? w.count : 'All'} of ${n} slide${n === 1 ? '' : 's'} from "${bank?.title ?? w.bank}"`),
    h('p', {}, w.shuffle ? 'Drawn when the learner arrives, in random order.' : 'Drawn when the learner arrives, in bank order.'),
    w.always.length ? h('p', {}, `Always included: ${w.always.map(title).join(', ')}`) : null,
    w.never.length ? h('p', {}, `Never included: ${w.never.map(title).join(', ')}`) : null,
    h('p', { class: 'q-note' }, 'The learner sees the drawn slides here. Change the draw on the Slide tab; edit the questions in the bank.'));
}
function objEl(o, dim) {
  const over = o.states?.[o.initialState] || {};
  const st = { ...(o.style || {}), ...(over.style || {}) };
  const sel = !dim && S.sel.includes(o.id);
  const text = over.text ?? o.text ?? (o.type === 'input' ? o.placeholder : '') ?? '';
  const content = h('span', {}, text);
  if (o.rich && over.text === undefined) renderRich(content, o.rich);
  const asset = o.type === 'image' && S.doc.assets.find((a) => a.id === (over.image ?? o.image));
  const dq = (S.draft.question?.slide === S.slide && S.draft.question.q) || curSlide()?.question; // drag-and-drop roles as badges
  const dd = dq?.type === 'dragdrop' ? (dq.items?.some((i) => i.object === o.id) ? ' dd-item' : dq.targets?.some((t) => t.object === o.id) ? ' dd-target' : '') : '';
  const line = o.type === 'shape' && (o.shape === 'line' || o.shape === 'arrow'); // the shared SVG renderer
  return h('div', {
    id: `obj-${o.id}`, 'data-id': o.id,
    'data-text-fit': st.textFit ? JSON.stringify(st.textFit) : null, 'data-text-valign': st.valign || null,
    class: `obj t-${o.type} shape-${o.shape}${dim ? ' dim' : ''}${sel ? ' sel' : ''}${o.locked ? ' locked' : ''}${dd}`,
    role: dim ? null : 'button', tabindex: dim ? null : '0', 'aria-pressed': dim ? null : String(sel),
    'aria-label': dim ? null : `${o.name ? `${o.name}, ` : ''}${o.type} ${o.id}${text ? `: ${text}` : ''}${o.hidden ? ' (hidden at start)' : ''}${o.locked ? ' (locked)' : ''}`,
    'data-cmd': dim ? null : 'object.set',
    onclick: (e) => { if (e.target.closest('a')) e.preventDefault(); },
    onfocus: dim ? null : () => { if (!quietFocus && !S.sel.includes(o.id)) selectObj(o.id, false); }, // Tab selects; tabbing within a group keeps it
    style: {
      left: `${o.x + (nudge?.ids.includes(o.id) ? nudge.dx : 0)}px`, top: `${o.y + (nudge?.ids.includes(o.id) ? nudge.dy : 0)}px`, width: `${o.w}px`, height: `${o.h}px`, transform: o.rotation ? `rotate(${o.rotation}deg)` : '',
      background: line ? '' : st.fill || '', color: st.color || '', border: st.border && !line ? `${st.borderWidth ?? 1}px solid ${st.border}` : '',
      borderRadius: st.radius !== undefined ? `${st.radius}px` : '', fontSize: st.fontSize ? `${st.fontSize}px` : '', fontFamily: st.fontFamily || '',
      fontWeight: st.bold ? '700' : '', fontStyle: st.italic ? 'italic' : '', textDecoration: st.underline ? 'underline' : '',
      textAlign: st.align || '', justifyContent: { left: 'flex-start', center: 'center', right: 'flex-end' }[st.align] || '',
      alignItems: { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[st.valign] || '',
      padding: st.padding !== undefined ? `${st.padding}px` : '', boxShadow: st.shadow ? '0 4px 14px rgb(0 0 0 / .28)' : '',
      overflow: st.clip ? 'hidden' : '',
      opacity: String((st.opacity ?? 1) * (o.hidden || over.hidden ? 0.4 : 1)),
    },
  },
  asset ? h('img', { src: `/assets/${encodeURIComponent(token)}/${encodeURIComponent(S.name)}/${asset.path.split('/').map(encodeURIComponent).join('/')}`, alt: '' }) : line ? drawLine(document, o, st) : typePreview(o) ?? content,
  sel && S.sel.length === 1 && !o.locked ? HANDLES.map((d) => h('span', { class: `handle h-${d}`, 'data-h': d, 'aria-hidden': 'true', 'data-cmd': 'object.set' })) : null);
}
/** Canvas look of media (placeholder), a slider (track + thumb) or a dial (face + pointer) at its variable's initial value. */
function typePreview(o) {
  if (o.type === 'video' || o.type === 'audio') { // a labelled placeholder: the editor never plays media
    const a = S.doc.assets.find((x) => x.id === o.media);
    return h('span', { class: 'media-ph' }, h('span', { class: 'media-icon', 'aria-hidden': 'true' }, o.type === 'video' ? '▶' : '♪'), ` ${a ? a.path.split('/').at(-1) : '(no file)'}${o.captions ? ' · CC' : ''}${o.autoplay ? ' · autoplay' : ''}`);
  }
  if (o.type === 'marker') return h('span', { class: 'marker-dot', title: o.detail || '' }, '+');
  if (o.type !== 'slider' && o.type !== 'dial') return null;
  const r = rangeOf(o);
  const v = Math.min(r.max, Math.max(r.min, Number(S.doc.variables.find((x) => x.name === o.var)?.initial ?? r.min)));
  const t = (v - r.min) / (r.max - r.min) || 0;
  if (o.type === 'slider') return h('span', { class: 'slider-track' }, h('span', { class: 'slider-thumb', style: { left: `${t * 100}%` } }));
  const a = (o.startAngle ?? -90) + t * ((o.endAngle ?? 90) - (o.startAngle ?? -90));
  return h('span', { class: 'dial-face' }, h('span', { class: 'dial-pointer', style: { transform: `rotate(${a}deg)` } }));
}
function fit() {
  if (!S.doc) return;
  const vp = $('#viewport');
  const { w, h: hh } = S.doc.size;
  zoom = S.zoom ?? Math.max(0.1, Math.min((vp.clientWidth - 48) / w, (vp.clientHeight - 48) / hh, 2)); // S.zoom: a zoom the author chose; null = fit
  $('#stage').style.transform = `scale(${zoom})`;
  $('#stage').style.setProperty('--zoom', zoom);
  Object.assign($('#stagewrap').style, { width: `${w * zoom}px`, height: `${hh * zoom}px` });
  $('#zoom').textContent = `${Math.round(zoom * 100)}%`;
}

// Pointer gestures (canvas and timeline): tracked on window and resolved by id, so a re-render on pointerdown
// never breaks the drag. `drag` = {move(e), end()}; each gesture sends one command batch on pointerup.
let drag = null;
const CSSK = { x: 'left', y: 'top', w: 'width', h: 'height' };
function onPointerDown(e) {
  if (e.button !== 0) return;
  const add = e.shiftKey || e.ctrlKey || e.metaKey;
  const area = e.target.closest('.q-area:not(.dim)');
  if (area) return areaDown(e, area);
  const el = e.target.closest('.obj');
  if (!el || el.classList.contains('dim')) return marqueeDown(e, add);
  const id = el.dataset.id;
  if (!contextObjects().some((x) => x.id === id)) return;
  e.preventDefault();
  quietFocus = true; // until pointerup: the focus that follows this click must not reselect
  if (add || !S.sel.includes(id)) selectObj(id, add);
  if (!S.sel.includes(id)) return; // Shift/Ctrl+click removed it: nothing to drag
  if (selObjs().some((o) => o.locked)) return; // locked objects stay where they are
  const handle = e.target.dataset?.h ?? null; // nw n ne e se s sw w
  const resize = !!handle;
  const orig = selObjs().map((o) => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h }));
  const snap = snapper(orig);
  const x0 = e.clientX, y0 = e.clientY;
  let n = null;
  drag = {
    move(ev) {
      let dx = (ev.clientX - x0) / zoom, dy = (ev.clientY - y0) / zoom;
      if (!n && Math.abs(dx) + Math.abs(dy) < 2) return;
      if (!resize) [dx, dy] = snap(dx, dy, ev.altKey);
      n = orig.map((o) => [o, resize ? resized(o, handle, dx, dy, ev.shiftKey) : { x: Math.round(o.x + dx), y: Math.round(o.y + dy) }]);
      for (const [o, v] of n) { const oe = document.getElementById(`obj-${o.id}`); if (oe) for (const [k, x] of Object.entries(v)) oe.style[CSSK[k]] = `${x}px`; }
    },
    end() {
      if (!n && !add && S.sel.length > 1) return selectObj(id, false); // a plain click (no drag) inside a group selects just that object
      guides();
      const cmds = (n || []).map(([o, v]) => [o, Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== o[k]))]).filter(([, v]) => Object.keys(v).length)
        .map(([o, v]) => ({ cmd: 'object.set', args: { id: o.id, ...v } }));
      if (cmds.length) dispatch(cmds); // one atomic batch per gesture, however many objects
    },
  };
  focusQuiet(document.getElementById(`obj-${id}`));
}
function onPointerMove(e) { drag?.move(e); }
function onPointerUp() { const d = drag; drag = null; quietFocus = false; d?.end(); }
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/* * Edge and corner resize (FR-C3); Shift on a corner keeps the aspect ratio. ponytail: ignores rotation, as object.align does. */
function resized(o, d, dx, dy, keep) {
  let w = o.w + (d.includes('e') ? dx : d.includes('w') ? -dx : 0);
  let hh = o.h + (d.includes('s') ? dy : d.includes('n') ? -dy : 0);
  if (keep && d.length === 2 && o.w && o.h) { const k = Math.max(w / o.w, hh / o.h); w = o.w * k; hh = o.h * k; }
  w = Math.max(1, Math.round(w)); hh = Math.max(1, Math.round(hh));
  return { x: d.includes('w') ? o.x + o.w - w : o.x, y: d.includes('n') ? o.y + o.h - hh : o.y, w, h: hh };
}
/* * Snapping while dragging (FR-C6): the selection's edges and centre snap to the slide's and to other objects'
 *  within 6 screen pixels, and a guide line shows where. Alt turns it off. Returns (dx, dy, off) => [dx, dy]. */
function snapper(orig) {
  const { w: W, h: H } = S.doc.size;
  const others = contextObjects().filter((o) => !S.sel.includes(o.id));
  const xs = [0, W / 2, W, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
  const ys = [0, H / 2, H, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];
  const x0 = Math.min(...orig.map((o) => o.x)), x1 = Math.max(...orig.map((o) => o.x + o.w));
  const y0 = Math.min(...orig.map((o) => o.y)), y1 = Math.max(...orig.map((o) => o.y + o.h));
  const near = (vals, cands) => {
    let best = null;
    for (const v of vals) for (const c of cands) if (Math.abs(c - v) <= 6 / zoom && (!best || Math.abs(c - v) < Math.abs(best.d))) best = { d: c - v, at: c };
    return best;
  };
  return (dx, dy, off) => {
    const sx = off ? null : near([x0 + dx, (x0 + x1) / 2 + dx, x1 + dx], xs), sy = off ? null : near([y0 + dy, (y0 + y1) / 2 + dy, y1 + dy], ys);
    guides(sx?.at, sy?.at);
    return [dx + (sx?.d ?? 0), dy + (sy?.d ?? 0)];
  };
}
function guides(x, y) {
  const stage = $('#stage');
  for (const g of stage.querySelectorAll('.guide')) g.remove();
  if (x !== undefined) stage.append(h('div', { class: 'guide gv', 'aria-hidden': 'true', style: { left: `${x}px` } }));
  if (y !== undefined) stage.append(h('div', { class: 'guide gh', 'aria-hidden': 'true', style: { top: `${y}px` } }));
}
/* * Marquee selection on the empty canvas (FR-C5): objects fully inside the box are selected; Shift adds. A plain click clears. */
function marqueeDown(e, add) {
  const stage = $('#stage');
  if (!e.target.closest('#stage') || !curSlide() || curSlide().draw) { if (S.sel.length && !add) { S.sel = []; render(); } return; }
  const r0 = stage.getBoundingClientRect();
  const at = (ev) => ({ x: (ev.clientX - r0.left) / zoom, y: (ev.clientY - r0.top) / zoom });
  const a = at(e), base = add ? [...S.sel] : [];
  let box = null;
  drag = {
    move(ev) {
      const b = at(ev);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
      if (!box && w + hh < 4) return;
      box = { x, y, w, h: hh };
      let m = stage.querySelector('.marquee');
      if (!m) stage.append(m = h('div', { class: 'marquee', 'aria-hidden': 'true' }));
      Object.assign(m.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
    },
    end() {
      stage.querySelector('.marquee')?.remove();
      if (!box) { if (S.sel.length && !add) { S.sel = []; render(); } return; }
      const inside = contextObjects().filter((o) => o.x >= box.x && o.y >= box.y && o.x + o.w <= box.x + box.w && o.y + o.h <= box.y + box.h).map((o) => o.id);
      S.sel = [...new Set([...base, ...inside])];
      render();
      announce(`${S.sel.length} object${S.sel.length === 1 ? '' : 's'} selected`);
    },
  };
}
/* * Context menu for canvas objects (FR-C7): right-click, Shift+F10 or the Menu key. Arrow keys move, Escape closes. */
function objectMenu(x, y) {
  $('#ctx-menu')?.remove();
  const ids = [...S.sel];
  if (!ids.length) return;
  const back = document.activeElement;
  const one = ids.length === 1 ? contextObjects().find((o) => o.id === ids[0]) : null;
  const list = contextObjects();
  const at = one ? list.indexOf(one) : -1;
  const order = (index) => dispatch([{ cmd: 'object.move', args: { id: one.id, index } }]);
  const item = (label, fn, cmd, off = false) => h('button', { type: 'button', role: 'menuitem', 'data-cmd': cmd || null, 'data-ui': cmd ? null : 'menu.item', disabled: off, onclick: () => { menu.hidePopover(); fn(); } }, label);
  const sep = () => h('div', { role: 'separator' });
  const align = (edge) => item(`Align ${edge}`, () => dispatch([{ cmd: 'object.align', args: { ids, edge } }]), 'object.align');
  const menu = h('div', { id: 'ctx-menu', class: 'ctx-menu', role: 'menu', popover: 'auto', 'aria-label': one ? `Actions for ${objLabel(one)}` : `Actions for ${ids.length} objects`,
    ontoggle: (e) => { if (e.newState === 'closed') { menu.remove(); focusQuiet(back); } },
    onkeydown: (e) => {
      const items = [...menu.querySelectorAll('[role=menuitem]:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
      if (to !== undefined) { e.preventDefault(); items[(to + items.length) % items.length]?.focus(); }
    } },
    item('Copy', copySel, 'object.duplicate'), item('Paste', paste, 'object.duplicate', !S.clip), item('Duplicate', duplicateSel, 'object.duplicate'), item('Delete', () => deleteObjects(ids), 'object.remove'), sep(),
    item('Bring to front', () => order(list.length - 1), 'object.move', !one || at === list.length - 1), item('Bring forward', () => order(at + 1), 'object.move', !one || at === list.length - 1),
    item('Send backward', () => order(at - 1), 'object.move', !one || at <= 0), item('Send to back', () => order(0), 'object.move', !one || at <= 0), sep(),
    ['left', 'center', 'right', 'top', 'middle', 'bottom'].map(align));
  document.body.append(menu);
  Object.assign(menu.style, { left: `${Math.min(x, innerWidth - 220)}px`, top: `${Math.min(y, innerHeight - 380)}px` });
  menu.showPopover();
  menu.querySelector('[role=menuitem]:not(:disabled)')?.focus();
}
/* * Zoom (FR-C4): a factor relative to the current zoom, 'fit' or a fixed zoom. */
function zoomTo(z) {
  S.zoom = z === 'fit' ? null : Math.max(0.1, Math.min(4, typeof z === 'number' ? z : zoom * z.by));
  fit();
}
let nudge = null; // the latest arrow-key edit: {ids, key (ids joined), dx, dy, waiting}; the canvas already shows it
function onStageKey(e) {
  const id = e.target.closest?.('.obj')?.dataset.id;
  if (!id) return;
  const ids = S.sel.length ? [...S.sel] : [id];
  const step = e.shiftKey ? 10 : 1;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') { e.preventDefault(); if (!S.sel.includes(id)) selectObj(id, false); const r = document.getElementById(`obj-${id}`)?.getBoundingClientRect(); return objectMenu(r ? r.left + 8 : 100, r ? r.bottom : 100); }
  if (d) {
    e.preventDefault();
    if (contextObjects().some((o) => o.locked && ids.includes(o.id))) return; // locked objects stay put
    for (const o of contextObjects()) if (ids.includes(o.id)) { const el = $(`#stage .obj[data-id="${CSS.escape(o.id)}"]`); if (el) Object.assign(el.style, { left: `${parseFloat(el.style.left) + d[0]}px`, top: `${parseFloat(el.style.top) + d[1]}px` }); }
    const key = ids.join('\n');
    if (nudge?.key === key && nudge.waiting) { nudge.dx += d[0]; nudge.dy += d[1]; return; } // a held arrow key: one edit per server round trip, never a backlog
    const n = nudge = { key, ids, dx: d[0], dy: d[1], waiting: true }; // this edit's own presses (Codex review 007 #5)
    dispatch(() => { n.waiting = false; if (nudge === n) nudge = null; return contextObjects().filter((o) => n.ids.includes(o.id)).map((o) => ({ cmd: 'object.set', args: { id: o.id, x: o.x + n.dx, y: o.y + n.dy } })); });
  } else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteObjects(ids); }
  else if (e.key === 'Escape') { S.sel = []; render(); $('#stage').focus(); }
}
const deleteObjects = (ids) => removeWithForce('object.remove', ids.map((id) => ({ id })), ids.length > 1 ? `${ids.length} objects` : `object "${ids[0]}"`);

// ----- clipboard: Ctrl+C remembers ids; paste and duplicate are object.duplicate -----
function copySel() {
  if (!S.sel.length) return;
  S.clip = { ids: [...S.sel], slide: S.slide, layer: S.layer, n: 0, objects: structuredClone(selObjs()) }; // objects: a snapshot for when the originals are gone
  render();
  toast(`Copied ${S.sel.length === 1 ? S.sel[0] : `${S.sel.length} objects`}. Paste with Ctrl+V on any slide or layer.`);
}
async function paste() {
  const c = S.clip;
  if (!c || !curSlide()) return;
  const same = c.slide === S.slide && c.layer === S.layer;
  const off = same ? 20 * (c.n + 1) : 0;
  const src = slideById(c.slide);
  if (src && c.ids.every((id) => slideObjects(src).some((o) => o.id === id))) { // the originals still exist: duplicate them, their triggers follow
    const r = await dispatch([{ cmd: 'object.duplicate', args: { ids: c.ids, slide: S.slide, layer: S.layer, ...(off ? { dx: off, dy: off } : {}) } }]);
    if (r?.ok) { if (same) c.n++; pasted(r.results[0]); }
    return;
  }
  // The originals were deleted since Copy: paste the copies as they were, with new ids (their triggers went with the originals).
  const r = await dispatch(c.objects.map(({ id, ...o }) => ({ cmd: 'object.add', args: { ...o, slide: S.slide, ...(S.layer ? { layer: S.layer } : {}), x: o.x + off, y: o.y + off } })));
  if (r?.ok) { if (same) c.n++; pasted({ ids: r.results.map((x) => x.id), skipped: [] }); }
}
async function duplicateSel() {
  if (!S.sel.length) return;
  const r = await dispatch([{ cmd: 'object.duplicate', args: { ids: [...S.sel], dx: 20, dy: 20 } }]);
  if (r?.ok) pasted(r.results[0]);
}
function pasted(res) {
  S.sel = res.ids;
  render();
  focusQuiet(document.getElementById(`obj-${res.ids.at(-1)}`));
  const what = res.ids.length === 1 ? res.ids[0] : `${res.ids.length} objects`;
  if (res.skipped.length) toast(`Pasted ${what}. ${res.skipped.length} trigger(s) were not copied because they use objects or layers that are not on this slide: ${res.skipped.join(', ')}.`);
  else announce(`Pasted ${what}`);
}

async function insert(type) {
  const s = curSlide();
  if (!s) return;
  const d = INSERT[type];
  const { w: W, h: H } = S.doc.size;
  const obj = { slide: s.id, ...(S.layer ? { layer: S.layer } : {}), ...nextId(), type, x: Math.round((W - d.w) / 2), y: Math.round((H - d.h) / 2), ...d };
  let cmds = [{ cmd: 'object.add', args: obj }];
  if (type === 'image') {
    const v = await ask({
      title: 'Insert image', cmd: 'asset.add', ok: 'Insert image', library: true,
      message: 'Choose a file (it is copied into the courses folder), or type the path of one already there.',
      fields: [{ name: 'path', label: 'Image path', placeholder: 'assets/photo.png', required: true, file: 'image/*' }, { name: 'alt', label: 'Alt text (describe the image; leave empty only if it is decorative)' }],
    });
    if (!v) return;
    const aid = newId('a', allIds(S.doc));
    const src = v.library ? { library: v.library } : { path: v.path, ...(v.alt ? { alt: v.alt } : {}) }; // a library image brings its own alt text
    cmds = [{ cmd: 'asset.add', args: { id: aid, ...src } }, { cmd: 'object.add', args: { ...obj, image: aid, ...(v.alt ? { alt: v.alt } : {}) } }];
  }
  if (type === 'video' || type === 'audio') { // no cloud captioning or alt-text generation (the vendor pre-checks both)
    const v = await ask({
      title: `Insert ${type}`, cmd: 'asset.add', ok: `Insert ${type}`,
      message: 'Choose files (they are copied into the courses folder), or type paths of files already there. Files are published as they are.',
      fields: [{ name: 'path', label: `${cap(type)} file path`, placeholder: type === 'video' ? 'assets/clip.mp4' : 'assets/narration.mp3', required: true, file: `${type}/*` },
        { name: 'alt', label: 'Description (accessible name)' }, { name: 'captions', label: 'Captions file (.vtt, optional)', placeholder: 'assets/clip.vtt', file: '.vtt,text/vtt' }],
    });
    if (!v) return;
    const taken = allIds(S.doc);
    const mid = newId('a', taken);
    taken.add(mid);
    const cid = v.captions ? newId('a', taken) : null;
    cmds = [{ cmd: 'asset.add', args: { id: mid, path: v.path, ...(v.alt ? { alt: v.alt } : {}) } },
      ...(cid ? [{ cmd: 'asset.add', args: { id: cid, path: v.captions } }] : []),
      { cmd: 'object.add', args: { ...obj, media: mid, ...(cid ? { captions: cid } : {}), ...(v.alt ? { alt: v.alt } : {}) } }];
  }
  if (type === 'slider' || type === 'dial') { // like Storyline: each new slider or dial gets its own number variable (Slider1, Dial1 = 6)
    const base = type === 'dial' ? 'Dial' : 'Slider';
    let n = 1;
    while (S.doc.variables.some((v) => v.name === `${base}${n}`)) n++;
    cmds = [{ cmd: 'var.add', args: { name: `${base}${n}`, type: 'number', initial: type === 'dial' ? 6 : 0 } }, { cmd: 'object.add', args: { ...obj, var: `${base}${n}` } }];
  }
  const r = await dispatch(cmds, 'next-id');
  if (r?.ok) { consumeNextId(); const id = r.results.at(-1).id; S.sel = [id]; S.tab = 'props'; render(); focusQuiet(document.getElementById(`obj-${id}`)); announce(`${type} ${id} inserted`); }
}

// ----- timeline of the slide or layer being edited: bars over the duration; numbers and drags send object.set -----
function renderTimeline() {
  const el = $('#timeline');
  el.hidden = !S.timeline;
  $('#btn-timeline').setAttribute('aria-expanded', String(S.timeline));
  if (!S.timeline) return;
  const s = curSlide();
  const L = curLayer();
  if (!s || s.draw) { el.replaceChildren(h('h2', { id: 'tl-title', class: 'sr-only' }, 'Timeline'), hint(s ? 'A draw slide has no timeline of its own.' : 'Add a slide to see its timeline.')); return; }
  const host = L ?? s;
  const dcmd = L ? 'layer.set' : 'slide.set';
  const list = [...contextObjects()].reverse(); // front object first
  const total = Math.max(host.duration, 100, ...list.map((o) => Math.max(o.end ?? 0, o.start)));
  const pct = (ms) => `${(ms / total) * 100}%`;
  const step = [500, 1000, 2000, 5000, 10000, 30000, 60000].find((x) => total / x <= 6) ?? 120000;
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  const row = (o) => {
    const sel = S.sel.includes(o.id);
    const end = o.end ?? host.duration;
    return h('li', { class: `tl-row${sel ? ' sel' : ''}` },
      h('input', { type: 'checkbox', id: `tl-${o.id}-sel`, checked: sel, 'aria-label': `Select ${o.id}`, 'data-ui': 'object.select', onchange: () => selectObj(o.id, true) }),
      h('button', { type: 'button', id: `tl-${o.id}-name`, class: 'tl-name', 'aria-pressed': String(sel), 'data-ui': 'object.select', onclick: (e) => selectObj(o.id, e.shiftKey || e.ctrlKey || e.metaKey) }, objLabel(o)),
      h('div', { class: 'tl-track', 'aria-hidden': 'true' },
        h('div', { id: `tl-${o.id}-bar`, class: `tl-bar${o.end === null ? ' open' : ''}`, 'data-cmd': 'object.set', title: `${o.start} ms to ${o.end === null ? 'the end' : `${o.end} ms`}`, style: { left: pct(o.start), width: pct(Math.max(0, end - o.start)) }, onpointerdown: (e) => tlDown(e, o, host.duration, total) },
          h('span', { class: 'tl-edge e-start' }), h('span', { class: 'tl-edge e-end' }))),
      ctl('num', `tl-${o.id}-start`, `${o.id} appears at (ms)`, o.start, { cmd: 'object.set', cls: 'bare', commit: (v) => [{ cmd: 'object.set', args: { id: o.id, start: v ?? 0 } }], attrs: { min: 0, step: 100 } }),
      ctl('num', `tl-${o.id}-end`, `${o.id} disappears at (ms, empty = at the end)`, o.end, { cmd: 'object.set', cls: 'bare', commit: (v) => [{ cmd: 'object.set', args: { id: o.id, end: v } }], attrs: { min: 0, step: 100, placeholder: 'end' } }));
  };
  el.replaceChildren(
    h('div', { class: 'tl-head' },
      h('h2', { id: 'tl-title' }, L ? `Timeline: layer ${L.title}` : 'Timeline'),
      ctl('num', 'tl-duration', `${L ? 'Layer' : 'Slide'} duration (ms)`, host.duration, { cmd: dcmd, cls: 'inline', commit: (v) => [{ cmd: dcmd, args: { id: host.id, duration: v ?? slideSchema.properties.duration.default } }], attrs: { min: 0, step: 100 } }),
      h('p', { class: 'hint' }, 'Drag a bar or its edges (100 ms steps). An end dragged to the far right means until the end.')),
    list.length ? h('div', { class: 'tl-body' },
      h('div', { class: 'tl-row tl-ruler-row', 'aria-hidden': 'true' }, h('span'), h('span'),
        h('div', { class: 'tl-ruler' }, ticks.map((t) => h('span', { class: 'tick', style: { left: pct(t) } }, `${t / 1000}s`)), total > host.duration && h('span', { class: 'tl-endmark', style: { left: pct(host.duration) } })),
        h('span', { class: 'tl-col' }, 'Start'), h('span', { class: 'tl-col' }, 'End')),
      h('ol', { class: 'tl-list', 'aria-label': `Objects on ${L ? `layer ${L.title}` : 'this slide'}, front first` }, list.map(row)))
      : hint(L ? 'No objects on this layer yet.' : 'No objects on this slide yet.'));
}
function tlDown(e, o, dur, total) {
  if (e.button !== 0) return;
  e.preventDefault();
  const mode = e.target.classList.contains('e-start') ? 'start' : e.target.classList.contains('e-end') ? 'end' : 'move';
  const msPerPx = total / e.currentTarget.parentElement.getBoundingClientRect().width;
  const x0 = e.clientX, s0 = o.start, e0 = o.end ?? dur, open = o.end === null;
  const snap = (v) => Math.round(v / 100) * 100;
  let n = null;
  quietFocus = true;
  if (!S.sel.includes(o.id)) selectObj(o.id, false);
  drag = {
    move(ev) {
      const d = snap((ev.clientX - x0) * msPerPx);
      if (!n && !d) return;
      let start = s0, end = e0;
      if (mode === 'start') start = Math.min(Math.max(0, s0 + d), e0);
      else if (mode === 'end') end = Math.max(s0, e0 + d);
      else if (open) start = Math.min(Math.max(0, s0 + d), dur); // an open bar keeps "until the end"
      else { start = Math.max(0, s0 + d); end = e0 + (start - s0); }
      n = { start, end: open && mode !== 'end' ? null : mode === 'end' && end >= dur ? null : end };
      const bar = document.getElementById(`tl-${o.id}-bar`);
      if (bar) Object.assign(bar.style, { left: `${(start / total) * 100}%`, width: `${(((n.end ?? dur) - start) / total) * 100}%` });
    },
    end() {
      if (!n) return;
      const args = { id: o.id, ...(n.start !== o.start ? { start: n.start } : {}), ...(n.end !== o.end ? { end: n.end } : {}) };
      if (Object.keys(args).length > 1) dispatch([{ cmd: 'object.set', args }]);
    },
  };
}

// ----- inspector -----
function renderInspector() {
  $('#tabs').replaceChildren(...TABS.map(([k, label]) => h('button', {
    type: 'button', role: 'tab', id: `tab-${k}`, 'aria-selected': String(S.tab === k), 'aria-controls': 'tabpanel', tabindex: S.tab === k ? '0' : '-1', 'data-ui': 'tab',
    onclick: () => { S.tab = k; render(); },
  }, label)));
  const panel = $('#tabpanel');
  panel.setAttribute('aria-labelledby', `tab-${S.tab}`);
  const top = S.shownTab === S.tab ? panel.scrollTop : 0;
  S.shownTab = S.tab;
  const needsSlide = !['vars', 'course'].includes(S.tab);
  const drawOnly = curSlide()?.draw && !['slide', 'vars', 'course'].includes(S.tab);
  panel.replaceChildren(...[needsSlide && !curSlide() ? hint('Add a slide first.')
    : drawOnly ? hint('A draw slide has no objects, states, triggers, layers or question of its own: the learner sees the slides drawn from its bank. Change the draw on the Slide tab; edit the questions in the bank.')
      : RENDER_TAB[S.tab]()].flat(Infinity).filter(Boolean));
  panel.scrollTop = top;
}
/** Arrow/Home/End keys move between tabs (ARIA tabs pattern); shared by both editor views. */
const tabKey = (tabs, cur, go) => (e) => {
  const i = tabs.findIndex(([k]) => k === cur());
  const d = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[e.key];
  if (d === undefined) return;
  e.preventDefault();
  go(tabs[(i + d + tabs.length) % tabs.length][0]);
};
const onTabKey = tabKey(TABS, () => S.tab, (k) => { S.tab = k; render(); $(`#tab-${k}`).focus(); });

const EFFECTS = [['', 'None'], ['fade', 'Fade'], ['fly', 'Fly'], ['grow', 'Grow'], ['zoom', 'Zoom']];
const FLY_DIRS = [['b', 'Bottom'], ['bl', 'Bottom left'], ['l', 'Left'], ['tl', 'Top left'], ['t', 'Top'], ['tr', 'Top right'], ['r', 'Right'], ['br', 'Bottom right']];
const RENDER_TAB = {
  props() {
    const many = selObjs();
    if (many.length > 1) return selectionPanel(many.map((x) => x.id));
    const o = selObj();
    if (!o) return hint(S.layer ? 'Select an object on this layer, or insert one from the toolbar.' : 'Select an object on the canvas (click it or Tab to it), or insert one from the toolbar. Shift or Ctrl+click selects several.');
    const C = 'object.set';
    const set = (k, f = (v) => v) => (v) => [{ cmd: C, args: { id: o.id, [k]: f(v) } }];
    const optStr = (v) => (v === '' ? null : v);
    const st = o.style || {};
    const sty = (k) => (v) => styleCmds(o, k, v);
    const list = contextObjects();
    const idx = list.indexOf(o);
    const move = (index) => () => dispatch([{ cmd: 'object.move', args: { id: o.id, index } }]);
    const layers = curSlide().layers;
    return [
      h('div', { class: 'obj-head' }, h('span', { class: 'badge' }, o.type), h('code', {}, o.id), h('span', { class: 'muted' }, S.layer ? `on layer ${curLayer().title}` : 'on the base layer')),
      group('Content',
        ['text', 'shape', 'button'].includes(o.type) && richField({ id: 'p-text', label: 'Text (%name% shows a variable)', ...(S.textRetry?.id === o.id ? { rich: S.textRetry.rich, text: S.textRetry.text } : { rich: o.rich, text: o.text }),
          commit: async (content) => { const r = await dispatch([{ cmd: C, args: { id: o.id, ...content } }], 'p-text'); if (r && !r.ok) { S.textRetry = { id: o.id, ...content }; render(); } } }), // 007 #6: a refused save keeps the text
        ['hotspot', 'marker'].includes(o.type) && ctl('area', 'p-text', o.type === 'marker' ? 'Title (the button name; %name% shows a variable)' : 'Text (%name% shows a variable)', o.text, { cmd: C, commit: set('text', optStr) }),
        o.type === 'marker' && ctl('area', 'p-detail', 'Label text (shown while the marker is open)', o.detail, { cmd: C, commit: set('detail', optStr), rows: 4 }),
        o.type === 'input' && [
          ctl('text', 'p-placeholder', 'Placeholder', o.placeholder, { cmd: C, commit: set('placeholder', optStr) }),
          ctl('select', 'p-var', 'Store the answer in text variable', o.var ?? '', { cmd: C, commit: set('var', optStr), options: [['', '(none)'], ...S.doc.variables.filter((v) => v.type === 'text').map((v) => v.name)] }),
          ctl('num', 'p-maxlength', 'Most characters (default 400)', o.maxLength, { cmd: C, commit: set('maxLength'), attrs: { min: 1, max: 1000, step: 1 } }),
          h('div', { class: 'checks' }, ctl('check', 'p-report', 'Report the answer to the LMS (ungraded)', !!o.report, { cmd: C, commit: (v) => [{ cmd: C, args: { id: o.id, report: v || null } }] }))],
        o.type === 'image' && ctl('select', 'p-image', 'Image asset', o.image, { cmd: C, commit: set('image'), options: S.doc.assets.map((a) => [a.id, `${a.id} (${a.path})`]) }),
        (o.type === 'video' || o.type === 'audio') && [
          ctl('select', 'p-media', `${cap(o.type)} file`, o.media, { cmd: C, commit: set('media'), options: S.doc.assets.map((a) => [a.id, `${a.id} (${a.path})`]) }),
          ctl('select', 'p-captions', 'Captions (WebVTT)', o.captions ?? '', { cmd: C, commit: set('captions', optStr), options: [['', '(none)'], ...S.doc.assets.filter((a) => /\.vtt$/i.test(a.path)).map((a) => [a.id, `${a.id} (${a.path})`])] }),
          o.type === 'video' && ctl('select', 'p-poster', 'Poster image', o.poster ?? '', { cmd: C, commit: set('poster', optStr), options: [['', '(none)'], ...S.doc.assets.filter((a) => /\.(png|jpe?g|gif|webp|svg)$/i.test(a.path)).map((a) => [a.id, `${a.id} (${a.path})`])] }),
          h('div', { class: 'checks' },
            ctl('check', 'p-autoplay', 'Play automatically', !!o.autoplay, { cmd: C, commit: (v) => [{ cmd: C, args: { id: o.id, autoplay: v || null } }] }),
            ctl('check', 'p-controls', 'Show player controls', o.controls !== false, { cmd: C, commit: (v) => [{ cmd: C, args: { id: o.id, controls: v ? null : false } }] }),
            ctl('check', 'p-loop', 'Loop', !!o.loop, { cmd: C, commit: (v) => [{ cmd: C, args: { id: o.id, loop: v || null } }] })),
          hint('Without controls, a click on the video plays or pauses it. Captions start hidden; learners turn them on with the CC button or Ctrl+Alt+C.')],
        (o.type === 'slider' || o.type === 'dial') && [
          ctl('select', 'p-var', 'Store the value in number variable', o.var ?? '', { cmd: C, commit: set('var', optStr), options: [['', '(choose)'], ...S.doc.variables.filter((v) => v.type === 'number').map((v) => v.name)] }),
          h('div', { class: 'grid2' },
            ['min', 'max', 'step'].map((k) => ctl('num', `p-${k}`, { min: 'Start value', max: 'End value', step: 'Step' }[k], rangeOf(o)[k], { cmd: C, commit: set(k), attrs: { step: 'any' } })),
            o.type === 'dial' && ['startAngle', 'endAngle'].map((k) => ctl('num', `p-${k}`, k === 'startAngle' ? 'Angle at start (degrees)' : 'Angle at end (degrees)', o[k] ?? (k === 'startAngle' ? -90 : 90), { cmd: C, commit: set(k) }))),
          ctl('check', 'p-live', 'Update the variable while dragging', o.live !== false, { cmd: C, commit: (v) => [{ cmd: C, args: { id: o.id, live: v ? null : false } }] })],
        ctl('text', 'p-alt', o.type === 'image' ? 'Alt text (required unless decorative)' : 'Accessible name / alt text', o.alt, { cmd: C, commit: set('alt', optStr) }),
        o.type === 'image' && !o.alt && h('p', { class: 'warn' }, 'This image has no alt text. Add a description unless it is purely decorative.'),
        o.type === 'shape' && ctl('select', 'p-shape', 'Shape', o.shape, { cmd: C, commit: set('shape'), options: SHAPES }),
        ctl('text', 'p-name', 'Name (for authors)', o.name, { cmd: C, commit: set('name', optStr) })),
      group('Position and size',
        h('div', { class: 'grid4' }, Object.entries({ x: 'X', y: 'Y', w: 'Width', h: 'Height' }).map(([k, label]) => ctl('num', `p-${k}`, label, typeof o[k] === 'number' ? Math.round(o[k] * 10) / 10 : o[k], { cmd: C, commit: set(k), attrs: { step: 1, ...(k === 'w' || k === 'h' ? { min: 0 } : {}) } }))),
        ctl('num', 'p-rotation', 'Rotation (degrees)', o.rotation, { cmd: C, commit: set('rotation') }),
        ctl('check', 'p-locked', 'Locked on the canvas (no drag, resize or arrow keys)', !!o.locked, { cmd: C, commit: (v) => [{ cmd: C, args: { id: o.id, locked: v || null } }] })),
      group('Style',
        h('div', { class: 'grid2' },
          colorCtl('p-fill', 'Fill', st.fill, C, sty('fill')), colorCtl('p-color', 'Text color', st.color, C, sty('color')),
          ctl('num', 'p-fontSize', 'Font size', st.fontSize, { cmd: C, commit: sty('fontSize'), attrs: { min: 1 } }),
          ctl('text', 'p-fontFamily', 'Font family', st.fontFamily, { cmd: C, commit: sty('fontFamily') }),
          ctl('select', 'p-align', 'Horizontal align', st.align ?? '', { cmd: C, commit: sty('align'), options: [['', 'default'], ...STYLE.align.enum] }),
          ctl('select', 'p-valign', 'Vertical align', st.valign ?? '', { cmd: C, commit: sty('valign'), options: [['', 'default'], ...STYLE.valign.enum] }),
          colorCtl('p-border', ['line', 'arrow'].includes(o.shape) ? 'Line color' : 'Border color', st.border, C, sty('border')),
          ctl('num', 'p-borderWidth', ['line', 'arrow'].includes(o.shape) ? 'Line width' : 'Border width', st.borderWidth, { cmd: C, commit: sty('borderWidth'), attrs: { min: 0 } }),
          ctl('num', 'p-radius', 'Corner radius', st.radius, { cmd: C, commit: sty('radius'), attrs: { min: 0 } }),
          ctl('num', 'p-opacity', 'Opacity (0 to 1)', st.opacity, { cmd: C, commit: sty('opacity'), attrs: { min: 0, max: 1, step: 0.05 } }),
          ctl('num', 'p-padding', 'Padding', st.padding, { cmd: C, commit: sty('padding'), attrs: { min: 0 } })),
        h('div', { class: 'checks' }, ['bold', 'italic', 'underline', 'shadow'].map((k) => ctl('check', `p-${k}`, cap(k), st[k], { cmd: C, commit: sty(k) })))),
      group('Timing and visibility',
        ctl('check', 'p-hidden', 'Hidden at start', o.hidden, { cmd: C, commit: set('hidden') }),
        h('div', { class: 'grid2' },
          ctl('num', 'p-start', 'Appears at (ms)', o.start, { cmd: C, commit: set('start'), attrs: { min: 0, step: 100 } }),
          ctl('num', 'p-end', 'Disappears at (ms, empty = never)', o.end, { cmd: C, commit: set('end'), attrs: { min: 0, step: 100 } })),
        ctl('select', 'p-initialState', 'Initial state', o.initialState, { cmd: C, commit: set('initialState'), options: [...new Set([...BUILTIN_STATES, ...Object.keys(o.states || {})])] })),
      group('Animation', // entrance plays from the start; exit ends at the end
        ['enter', 'exit'].map((k) => {
          const e = o[k], label = k === 'enter' ? 'Entrance' : 'Exit';
          const put = (patch) => [{ cmd: C, args: { id: o.id, [k]: patch && { ...(e || {}), ...patch } } }];
          return h('div', { class: 'grid2' },
            ctl('select', `p-${k}-effect`, `${label} effect`, e?.effect ?? '', { cmd: C, commit: (v) => put(v ? { effect: v, direction: v === 'fly' ? e?.direction : undefined } : null), options: EFFECTS }),
            e && ctl('num', `p-${k}-duration`, `${label} duration (s)`, e.duration ?? 0.75, { cmd: C, commit: (v) => put({ duration: v ?? 0.75 }), attrs: { min: 0.1, max: 5, step: 0.25 } }),
            e?.effect === 'fly' && ctl('select', `p-${k}-direction`, k === 'enter' ? 'Fly in from' : 'Fly out to', e.direction ?? 'b', { cmd: C, commit: (v) => put({ direction: v }), options: FLY_DIRS }));
        }),
        o.exit && o.end == null && hint('The exit effect plays only when the object has an end time (Disappears at).')),
      group('Arrange',
        h('div', { class: 'btn-row', role: 'group', 'aria-label': 'Stacking order' },
          btn('To back', 'object.move', move(0), { disabled: idx === 0, 'aria-label': 'Send to back' }),
          btn('Backward', 'object.move', move(idx - 1), { disabled: idx === 0, 'aria-label': 'Send backward' }),
          btn('Forward', 'object.move', move(idx + 1), { disabled: idx === list.length - 1, 'aria-label': 'Bring forward' }),
          btn('To front', 'object.move', move(list.length - 1), { disabled: idx === list.length - 1, 'aria-label': 'Bring to front' })),
        layers.length > 0 && ctl('select', 'p-layer', 'Move to layer', S.layer ?? '', { cmd: 'object.move', commit: (v) => [{ cmd: 'object.move', args: { id: o.id, layer: v || null } }], options: [['', 'Base layer'], ...layers.map((l) => [l.id, l.title])] }),
        h('div', { class: 'btn-row' },
          btn('Duplicate', 'object.duplicate', duplicateSel, { 'aria-label': 'Duplicate object', 'aria-keyshortcuts': 'Control+D' }),
          btn('Delete object', 'object.remove', () => deleteObjects([o.id]), { class: 'danger' }))),
      alignGroup([o.id]),
    ];
  },

  states() {
    const o = selObj();
    if (!o) return hint('Select an object to edit its states.');
    const names = Object.keys(o.states || {});
    const card = (n) => {
      const st = o.states[n];
      const set = (args) => [{ cmd: 'state.set', args: { target: o.id, state: n, ...args } }];
      return h('fieldset', { class: 'card' }, h('legend', {}, n),
        h('div', { class: 'grid2' },
          colorCtl(`st-${n}-fill`, 'Fill', st.style?.fill, 'state.set', (v) => set({ style: { fill: v } })),
          colorCtl(`st-${n}-color`, 'Text color', st.style?.color, 'state.set', (v) => set({ style: { color: v } }))),
        ctl('text', `st-${n}-text`, 'Text in this state (empty = unchanged)', st.text, { cmd: 'state.set', commit: (v) => set({ text: v === '' ? null : v }) }),
        ctl('check', `st-${n}-hidden`, 'Hidden in this state', st.hidden, { cmd: 'state.set', commit: (v) => set({ hidden: v }) }),
        btn(`Remove state ${n}`, 'state.remove', () => dispatch([{ cmd: 'state.remove', args: { target: o.id, state: n } }]), { class: 'danger small' }));
    };
    return [
      hint(`States change how ${o.id} looks. Triggers switch them with the setState action.`),
      ctl('select', 'st-initial', 'Initial state', o.initialState, { cmd: 'object.set', commit: (v) => [{ cmd: 'object.set', args: { id: o.id, initialState: v } }], options: [...new Set([...BUILTIN_STATES, ...names])] }),
      names.length ? names.map(card) : hint('No states defined yet.'),
      h('form', { class: 'inline-form', onsubmit: (e) => { e.preventDefault(); const v = $('#st-new').value.trim(); if (v) dispatch([{ cmd: 'state.set', args: { target: o.id, state: v } }], 'st-new'); } },
        ctl('text', 'st-new', 'New state name', '', { cmd: 'state.set', attrs: { list: 'state-names', placeholder: 'hover, selected, or a custom name', spellcheck: 'false' } }),
        h('button', { type: 'submit', 'data-cmd': 'state.set' }, 'Add state')),
    ];
  },

  triggers() {
    const list = contextTriggers();
    const where = S.layer ? `layer "${curLayer().title}"` : 'this slide';
    const d = S.draft.trigger;
    return [
      hint(`Triggers on ${where}, in execution order. Switch layers with "Editing" above the canvas.`),
      list.length ? h('ol', { class: 'trig-list' }, list.map((t, i) => h('li', { class: `trig${t.enabled === false ? ' off' : ''}` },
        h('p', { class: 'sentence' }, fmtTrigger(t)),
        h('div', { class: 'row-actions' },
          btn('Edit', 'trigger.set', () => openTrigger(t), { 'aria-label': `Edit trigger ${t.id}` }),
          btn('↑', 'trigger.move', () => dispatch([{ cmd: 'trigger.move', args: { id: t.id, index: i - 1 } }]), { disabled: i === 0, 'aria-label': `Move trigger ${t.id} up` }),
          btn('↓', 'trigger.move', () => dispatch([{ cmd: 'trigger.move', args: { id: t.id, index: i + 1 } }]), { disabled: i === list.length - 1, 'aria-label': `Move trigger ${t.id} down` }),
          ctl('check', `tr-en-${t.id}`, 'Enabled', t.enabled !== false, { cmd: 'trigger.set', commit: (v) => [{ cmd: 'trigger.set', args: { id: t.id, enabled: v } }] }),
          btn('Delete', 'trigger.remove', async () => { if (await ask({ title: `Delete trigger ${t.id}?`, ok: 'Delete', danger: true, cmd: 'trigger.remove' })) dispatch([{ cmd: 'trigger.remove', args: { id: t.id } }]); }, { class: 'danger', 'aria-label': `Delete trigger ${t.id}` }))))) : hint('No triggers yet.'),
      d ? triggerForm(d) : btn('+ Add trigger', 'trigger.add', () => openTrigger(null), { class: 'primary' }),
    ];
  },

  layers() {
    const s = curSlide();
    const L = curLayer();
    const set = (args) => [{ cmd: 'layer.set', args: { id: L.id, ...args } }];
    return [
      hint('Layers stay hidden until a showLayer action. Choose a layer to edit its objects and triggers.'),
      h('ul', { class: 'layer-list' },
        h('li', {}, btn('Base layer', null, guarded(() => editLayer(null)), { 'data-ui': 'layer.edit', 'aria-pressed': String(!S.layer), class: 'layer-btn', id: 'layer-base' })),
        s.layers.map((l, i) => h('li', { class: 'layer-row' },
          btn(h('span', {}, l.title, ' ', h('code', {}, l.id)), null, guarded(() => editLayer(l.id)), { 'data-ui': 'layer.edit', 'aria-pressed': String(S.layer === l.id), class: 'layer-btn', id: `layer-${l.id}`, 'aria-label': `Edit layer ${l.title}` }),
          btn('↑', 'layer.move', () => dispatch([{ cmd: 'layer.move', args: { id: l.id, index: i - 1 } }]), { disabled: i === 0, class: 'small', id: `layer-${l.id}-up`, 'aria-label': `Move layer ${l.title} up` }),
          btn('↓', 'layer.move', () => dispatch([{ cmd: 'layer.move', args: { id: l.id, index: i + 1 } }]), { disabled: i === s.layers.length - 1, class: 'small', id: `layer-${l.id}-down`, 'aria-label': `Move layer ${l.title} down` })))),
      L && group(`Layer "${L.title}"`,
        ctl('text', 'ly-title', 'Layer title', L.title, { cmd: 'layer.set', commit: (v) => set({ title: v }) }),
        ctl('num', 'ly-duration', 'Duration (ms)', L.duration, { cmd: 'layer.set', commit: (v) => set({ duration: v ?? layerSchema.properties.duration.default }), attrs: { min: 0, step: 100 } }),
        Object.entries(LAYER_FLAGS).map(([k, label]) => ctl('check', `ly-${k}`, label, L[k], { cmd: 'layer.set', commit: (v) => set({ [k]: v }) })),
        ctl('select', 'ly-revisit', 'When revisited', L.revisit, { cmd: 'layer.set', commit: (v) => set({ revisit: v }), options: REVISIT }),
        btn('Delete layer', 'layer.remove', () => removeWithForce('layer.remove', { id: L.id }, `layer "${L.title}"`), { class: 'danger' })),
      group('Add layer', h('form', { class: 'inline-form', onsubmit: addLayer },
        ctl('text', 'ly-new-id', 'Layer ID (optional)', '', { cmd: 'layer.add', attrs: { placeholder: 'auto', spellcheck: 'false' } }),
        ctl('text', 'ly-new-title', 'Layer title', '', { cmd: 'layer.add', attrs: { placeholder: 'Feedback' } }),
        h('button', { type: 'submit', 'data-cmd': 'layer.add' }, 'Add layer'))),
    ];
  },

  vars() {
    const initCtl = (id, v, label, commit) => (v.type === 'boolean'
      ? ctl('select', id, label, String(v.initial), { cmd: 'var.set', commit: (x) => commit(x === 'true'), options: ['false', 'true'] })
      : ctl('text', id, label, String(v.initial ?? ''), { cmd: 'var.set', commit: (x) => commit(v.type === 'number' ? typed(v.name, x) : x) }));
    return [
      hint('Variables are global to the course. Show one in text with %name%.'),
      S.doc.variables.length ? h('div', { class: 'var-table' }, S.doc.variables.map((v, i) => h('div', { class: 'var-row' },
        ctl('text', `var-name-${i}`, `Name of variable ${i + 1}`, v.name, { cmd: 'var.set', commit: (x) => [{ cmd: 'var.set', args: { name: v.name, newName: x.trim() } }], attrs: { spellcheck: 'false' } }),
        h('span', { class: 'badge' }, v.type),
        initCtl(`var-init-${i}`, v, `Initial value of ${v.name}`, (x) => [{ cmd: 'var.set', args: { name: v.name, initial: x } }]),
        btn('Delete', 'var.remove', () => removeWithForce('var.remove', { name: v.name }, `variable "${v.name}"`), { class: 'danger small', 'aria-label': `Delete variable ${v.name}` })))) : hint('No variables yet.'),
      group('Add variable', h('form', { class: 'inline-form', onsubmit: addVar },
        ctl('text', 'var-new-name', 'New variable name', '', { cmd: 'var.add', attrs: { required: true, spellcheck: 'false', placeholder: 'score' } }),
        ctl('select', 'var-new-type', 'New variable type', 'number', { cmd: 'var.add', options: VAR_TYPES }),
        ctl('text', 'var-new-initial', 'New variable initial value', '', { cmd: 'var.add', attrs: { placeholder: 'default: 0, false or empty' } }),
        h('button', { type: 'submit', 'data-cmd': 'var.add' }, 'Add variable'))),
    ];
  },

  slide() {
    const s = curSlide();
    const set = (args) => [{ cmd: 'slide.set', args: { id: s.id, ...args } }];
    if (s.draw) return [ // draw properties
      h('div', { class: 'obj-head' }, h('span', { class: 'badge draw' }, 'draw'), h('code', {}, s.id)),
      ctl('text', 'sl-title', 'Slide title', s.title, { cmd: 'slide.set', commit: (v) => set({ title: v }) }),
      drawGroup(s),
    ];
    return [
      h('div', { class: 'obj-head' }, h('span', { class: 'badge' }, 'slide'), h('code', {}, s.id)),
      ctl('text', 'sl-title', 'Slide title', s.title, { cmd: 'slide.set', commit: (v) => set({ title: v }) }),
      h('div', { class: 'grid2' },
        ctl('num', 'sl-duration', 'Duration (ms)', s.duration, { cmd: 'slide.set', commit: (v) => set({ duration: v ?? slideSchema.properties.duration.default }), attrs: { min: 0, step: 100 } }),
        ctl('select', 'sl-advance', 'Advance', s.advance, { cmd: 'slide.set', commit: (v) => set({ advance: v }), options: ADVANCE.map((x) => [x, x === 'user' ? 'by the learner' : 'automatically']) }),
        ctl('select', 'sl-revisit', 'When revisited', s.revisit, { cmd: 'slide.set', commit: (v) => set({ revisit: v }), options: REVISIT })),
      colorCtl('sl-background', 'Background', s.background, 'slide.set', (v) => set({ background: v })),
      ctl('area', 'sl-notes', 'Notes', s.notes, { cmd: 'slide.set', commit: (v) => set({ notes: v }), rows: 4 }),
    ];
  },

  question() {
    const s = curSlide();
    let d = S.draft.question;
    if (!d || d.slide !== s.id) d = S.draft.question = { slide: s.id, q: s.question ? structuredClone(s.question) : null };
    if (!d.q) return [hint('This is a normal slide. Make it a question slide to add a prompt, choices and scoring.'), btn('Make this a question slide', null, () => { d.q = newQuestion(); render(); }, { class: 'primary', 'data-ui': 'question.new' })];
    const q = d.q;
    const C = 'question.set';
    const choiceRow = (c, i) => h('li', { class: 'sub-item choice' },
      h('div', { class: 'choice-grid' },
        ctl('text', `q-choice-${i}-id`, `Choice ${i + 1} id`, c.id, { cmd: C, set: (v) => { c.id = v; }, attrs: { spellcheck: 'false' } }),
        ctl('text', `q-choice-${i}-label`, `Choice ${i + 1} label`, c.label, { cmd: C, set: (v) => { c.label = v; } }),
        ['mc', 'mr', 'tf'].includes(q.type) && ctl(q.type === 'mr' ? 'check' : 'radio', `q-choice-${i}-correct`, 'Correct', c.correct, { cmd: C, attrs: { name: 'q-correct' }, set: (v) => { if (q.type !== 'mr') q.choices.forEach((x) => { x.correct = false; }); c.correct = v; } })),
      h('div', { class: 'row-actions' },
        q.type === 'sequence' && [ // the list order is the correct order
          btn('↑', null, () => { [q.choices[i - 1], q.choices[i]] = [q.choices[i], q.choices[i - 1]]; render(); }, { disabled: i === 0, class: 'small', 'data-ui': 'question.choice.move', 'aria-label': `Move choice ${i + 1} up` }),
          btn('↓', null, () => { [q.choices[i + 1], q.choices[i]] = [q.choices[i], q.choices[i + 1]]; render(); }, { disabled: i === q.choices.length - 1, class: 'small', 'data-ui': 'question.choice.move', 'aria-label': `Move choice ${i + 1} down` })],
        btn('Remove', null, () => { q.choices.splice(i, 1); render(); }, { class: 'small', 'data-ui': 'question.choice.remove', 'aria-label': `Remove choice ${i + 1}` })));
    return h('form', { class: 'qform', onsubmit: (e) => { e.preventDefault(); saveQuestion(s, q); } },
      ctl('select', 'q-type', 'Question type', q.type, { cmd: C, structural: true, options: QTYPES.map((t) => [t, QLABEL[t] ?? t]), set: (v) => {
        q.type = v;
        if (v === 'tf' && !q.choices.length) q.choices = [{ id: 't', label: 'True', correct: true }, { id: 'f', label: 'False', correct: false }];
        if (v === 'fill' && !q.answers.length) q.answers = [''];
        if (v === 'hotspot' && !q.areas?.length) q.areas = [newArea([], true)];
        if (v === 'dragdrop') { q.items ??= []; q.targets ??= []; }
        if (v === 'matching') q.rows ??= [];
      } }),
      ctl('area', 'q-prompt', 'Prompt', q.prompt, { cmd: C, set: (v) => { q.prompt = v; } }),
      q.type === 'hotspot' ? areasGroup(q, C)
      : q.type === 'dragdrop' ? dragGroups(q, C)
      : q.type === 'fill'
        ? group('Accepted answers', h('ul', { class: 'sub-list' }, q.answers.map((a, i) => h('li', { class: 'sub-item row' },
          ctl('text', `q-answer-${i}`, `Answer ${i + 1}`, a, { cmd: C, set: (v) => { q.answers[i] = v; } }),
          btn('Remove', null, () => { q.answers.splice(i, 1); render(); }, { class: 'small', 'data-ui': 'question.answer.remove', 'aria-label': `Remove answer ${i + 1}` })))),
          btn('+ Answer', null, () => { q.answers.push(''); render(); }, { 'data-ui': 'question.answer.add' }),
          ctl('check', 'q-case', 'Case sensitive', q.caseSensitive, { cmd: C, set: (v) => { q.caseSensitive = v; } }))
        : [q.type === 'matching' && rowsGroup(q, C),
          group(q.type === 'sequence' ? 'Items in their correct order' : 'Choices', h('ul', { class: 'sub-list' }, q.choices.map(choiceRow)),
            btn('+ Choice', null, () => { const used = new Set(q.choices.map((c) => c.id)); q.choices.push({ id: [...'abcdefghijklmnopqrstuvwxyz'].find((x) => !used.has(x)) ?? `c${q.choices.length}`, label: '', correct: false }); render(); }, { 'data-ui': 'question.choice.add' }),
            ctl('check', 'q-shuffle', q.type === 'sequence' ? 'Shuffle the items for the learner' : 'Shuffle choices', q.shuffle, { cmd: C, set: (v) => { q.shuffle = v; } }))],
      group('Scoring', h('div', { class: 'grid2' },
        ctl('num', 'q-points', 'Points', q.points, { cmd: C, set: (v) => { q.points = v; }, attrs: { min: 0 } }),
        ctl('num', 'q-attempts', 'Attempts', q.attempts, { cmd: C, set: (v) => { q.attempts = v; }, attrs: { min: 1, step: 1 } }))),
      group('Feedback', ['correct', 'incorrect', 'tryAgain'].map((k) => ctl('text', `q-fb-${k}`, { correct: 'When correct', incorrect: 'When incorrect', tryAgain: 'Try again' }[k], q.feedback?.[k], { cmd: C, set: (v) => { q.feedback = { ...q.feedback, [k]: v }; } }))),
      h('div', { class: 'btn-row sticky' },
        h('button', { type: 'submit', id: 'q-save', class: 'primary', 'data-cmd': 'question.set' }, 'Save question'),
        btn('Revert', null, () => { S.draft.question = null; render(); }, { 'data-ui': 'question.revert' }),
        s.question && btn('Remove question', 'question.remove', async () => { if (await ask({ title: 'Turn this back into a normal slide?', ok: 'Remove question', danger: true, cmd: 'question.remove' })) { await dispatch([{ cmd: 'question.remove', args: { slide: s.id } }]); S.draft.question = null; render(); } }, { class: 'danger' })));
  },

  course() {
    const d = S.doc;
    const viewed = d.tracking.complete.find((c) => c.slidesViewed !== undefined);
    const counted = d.tracking.complete.find((c) => c.slidesViewedCount !== undefined);
    const questionSlides = order().map(slideById).filter((s) => s.question || s.draw); // flow slides; a draw stands for its drawn questions
    const tracking = () => [{ cmd: 'tracking.set', args: { complete: [
      ...($('#tk-viewed').checked ? [{ slidesViewed: Number($('#tk-viewed-pct').value) || 100 }] : []),
      ...($('#tk-counted').checked ? [{ slidesViewedCount: Number($('#tk-viewed-count').value) || 1 }] : []),
      ...d.quizzes.filter((q) => $(`#tk-quiz-${q.id}`).checked).map((q) => ({ quiz: q.id })),
    ] } }];
    const quizCard = (qz) => {
      const set = (args) => [{ cmd: 'quiz.set', args: { id: qz.id, ...args } }];
      return h('fieldset', { class: 'card' }, h('legend', {}, qz.title, ' ', h('code', {}, qz.id)),
        h('div', { class: 'grid2' },
          ctl('text', `qz-${qz.id}-title`, 'Quiz title', qz.title, { cmd: 'quiz.set', commit: (v) => set({ title: v }) }),
          ctl('num', `qz-${qz.id}-pass`, 'Pass mark (%)', qz.passPercent, { cmd: 'quiz.set', commit: (v) => set({ passPercent: v ?? 80 }), attrs: { min: 0, max: 100 } })),
        ctl('select', `qz-${qz.id}-results`, 'Results slide', qz.results ?? '', { cmd: 'quiz.set', commit: (v) => set({ results: v || null }), options: [['', '(none)'], ...order().map((id) => [id, `${slideById(id).title} (${id})`])] }),
        qz.results && slideById(qz.results) && ctl('check', `qz-${qz.id}-review`, 'Review quiz button on the results slide', [slideById(qz.results), ...slideById(qz.results).layers].some((c) => c.triggers.some((t) => t.do.some((a) => a.action === 'reviewQuiz' && a.quiz === qz.id))), { cmd: 'quiz.set', commit: (v) => set({ review: v }) }),
        h('fieldset', { class: 'plain' }, h('legend', {}, 'Questions in this quiz'),
          questionSlides.length ? questionSlides.map((s) => ctl('check', `qz-${qz.id}-q-${s.id}`, `${s.title} (${s.id}${s.draw ? ', draw' : ''})`, qz.questions.includes(s.id), {
            cmd: 'quiz.set', commit: (on) => set({ questions: order().filter((id) => (id === s.id ? on : qz.questions.includes(id))) }),
          })) : hint('No question slides yet.')),
        h('div', { class: 'btn-row' },
          btn('Add results slide', 'quiz.addResults', async () => {
            const commands = [{ cmd: 'quiz.addResults', args: { quiz: qz.id, ...nextId() } }];
            if (/\.story$/i.test(S.file) && !d.tracking.complete.some(c => c.quiz === qz.id)) commands.push({ cmd: 'tracking.set', args: { complete: [...d.tracking.complete, { quiz: qz.id }] } });
            const r = await dispatch(commands, 'next-id');
            if (r?.ok) { consumeNextId(); selectSlide(r.results[0].id); }
          }, { 'aria-label': `Add a results slide for ${qz.title} (score, pass and fail layers, retry)` }),
          btn('Delete quiz', 'quiz.remove', () => removeWithForce('quiz.remove', { id: qz.id }, `quiz "${qz.title}"`), { class: 'danger small' })));
    };
    return [
      group('Course',
        ctl('text', 'c-title', 'Course title', d.title, { cmd: 'course.set', commit: (v) => [{ cmd: 'course.set', args: { title: v } }] }),
        h('div', { class: 'grid2' },
          ctl('num', 'c-w', 'Slide width', d.size.w, { cmd: 'course.set', commit: (v) => [{ cmd: 'course.set', args: { size: { ...d.size, w: v } } }], attrs: { min: 100 } }),
          ctl('num', 'c-h', 'Slide height', d.size.h, { cmd: 'course.set', commit: (v) => [{ cmd: 'course.set', args: { size: { ...d.size, h: v } } }], attrs: { min: 100 } })),
        ctl('text', 'c-language', 'Language', d.language, { cmd: 'course.set', commit: (v) => [{ cmd: 'course.set', args: { language: v } }] })),
      group('Player',
        ctl('select', 'pl-style', 'Player style', d.player.style ?? '', { cmd: 'player.set', commit: (v) => v ? [{ cmd: 'player.set', args: { style: v } }] : [], options: [...(!d.player.style ? [['', 'Original / automatic']] : []), ['modern', 'Modern'], ['classic', 'Classic']] }),
        ctl('check', 'pl-menu', 'Show the menu', d.player.menu, { cmd: 'player.set', commit: (v) => [{ cmd: 'player.set', args: { menu: v } }] }),
        ctl('check', 'pl-prevNext', 'Show Prev / Next buttons', d.player.prevNext, { cmd: 'player.set', commit: (v) => [{ cmd: 'player.set', args: { prevNext: v } }] }),
        ctl('select', 'pl-resume', 'Resume a returning learner', d.player.resume, { cmd: 'player.set', commit: (v) => [{ cmd: 'player.set', args: { resume: v } }], options: RESUME })),
      themeGroup('th'),
      group('Tracking (first criterion met completes the course)',
        h('div', { class: 'grid2' },
          ctl('check', 'tk-viewed', 'Slides viewed', !!viewed, { cmd: 'tracking.set', commit: tracking }),
          ctl('num', 'tk-viewed-pct', 'Percent viewed', viewed?.slidesViewed ?? 100, { cmd: 'tracking.set', commit: tracking, attrs: { min: 1, max: 100 } }),
          ctl('check', 'tk-counted', 'Use an exact slide count', !!counted, { cmd: 'tracking.set', commit: tracking }),
          ctl('num', 'tk-viewed-count', 'Number of slides viewed', counted?.slidesViewedCount ?? 1, { cmd: 'tracking.set', commit: tracking, attrs: { min: 1, step: 1 } })),
        d.quizzes.map((q) => ctl('check', `tk-quiz-${q.id}`, `Use result: ${q.title}`, d.tracking.complete.some((c) => c.quiz === q.id), { cmd: 'tracking.set', commit: tracking })),
        ctl('select', 'tk-status', 'Report status as', d.tracking.status, { cmd: 'tracking.set', commit: (v) => [{ cmd: 'tracking.set', args: { status: v } }], options: STATUS })),
      group('Quizzes',
        d.quizzes.length ? d.quizzes.map(quizCard) : hint('No quizzes yet. A quiz scores its question slides.'),
        h('form', { class: 'inline-form', onsubmit: addQuiz },
          ctl('text', 'qz-new-id', 'Quiz ID (optional)', '', { cmd: 'quiz.add', attrs: { placeholder: 'auto', spellcheck: 'false' } }),
          ctl('text', 'qz-new-title', 'Quiz title', '', { cmd: 'quiz.add', attrs: { placeholder: 'Final quiz' } }),
          h('button', { type: 'submit', 'data-cmd': 'quiz.add' }, 'Add quiz'))),
    ];
  },
};

/* * Draw properties: bank, count, shuffle, and always/never per bank slide; every change is one draw.set. */
function drawGroup(s) {
  const w = s.draw;
  const bank = S.doc.banks.find((b) => b.id === w.bank);
  const set = (args) => [{ cmd: 'draw.set', args: { id: s.id, ...args } }];
  const mode = (sid) => (w.always.includes(sid) ? 'always' : w.never.includes(sid) ? 'never' : 'random');
  const setMode = (sid, m) => set({ always: [...w.always.filter((x) => x !== sid), ...(m === 'always' ? [sid] : [])], never: [...w.never.filter((x) => x !== sid), ...(m === 'never' ? [sid] : [])] });
  return group('Draw from a question bank',
    ctl('select', 'dr-bank', 'Bank', w.bank, { cmd: 'draw.set', commit: (v) => set({ bank: v }), options: S.doc.banks.map((b) => [b.id, `${b.title} (${b.slides.length} slides)`]) }),
    h('div', { class: 'grid2' },
      ctl('num', 'dr-count', 'Slides to draw (0 = all)', w.count, { cmd: 'draw.set', commit: (v) => set({ count: v ?? 0 }), attrs: { min: 0, step: 1 } }),
      ctl('check', 'dr-shuffle', 'Random order', w.shuffle, { cmd: 'draw.set', commit: (v) => set({ shuffle: v }) })),
    hint('Each learner gets a new draw on arrival and after a quiz retry. A quiz that lists this slide scores only the drawn questions.'),
    bank?.slides.length ? h('fieldset', { class: 'plain' }, h('legend', {}, 'Bank slides'),
      bank.slides.map((sid) => ctl('select', `dr-mode-${sid}`, `${slideById(sid)?.title ?? sid} (${sid})`, mode(sid), { cmd: 'draw.set', commit: (v) => setMode(sid, v), options: [['random', 'May be drawn'], ['always', 'Always included'], ['never', 'Never included']] })))
      : hint('This bank has no slides yet.'));
}
/** One style key: merged in; an emptied field (or an unchecked box) sends null, which removes the key. */
const styleCmds = (o, k, v) => [{ cmd: 'object.set', args: { id: o.id, style: { [k]: v === '' || v === false ? null : v } } }];
/** Align (to the selection, or to the slide for one object) and distribute (3+ objects). */
function alignGroup(ids) {
  const many = ids.length > 1;
  const to = many ? 'to the selection' : 'to the slide';
  const al = (edge) => btn(cap(edge), 'object.align', () => dispatch([{ cmd: 'object.align', args: { ids, edge } }]), { class: 'small', 'aria-label': `Align ${edge} ${to}` });
  const dist = (axis) => btn(cap(axis), 'object.distribute', () => dispatch([{ cmd: 'object.distribute', args: { ids, axis } }]), { class: 'small', disabled: ids.length < 3, 'aria-label': `Distribute ${axis}ly` });
  return group(`Align ${to}`,
    h('div', { class: 'btn-row', role: 'group', 'aria-label': 'Align horizontally' }, ['left', 'center', 'right'].map(al)),
    h('div', { class: 'btn-row', role: 'group', 'aria-label': 'Align vertically' }, ['top', 'middle', 'bottom'].map(al)),
    many && h('div', { class: 'btn-row', role: 'group', 'aria-label': 'Distribute (3 or more objects)' }, h('span', { class: 'row-label' }, 'Distribute'), ['horizontal', 'vertical'].map(dist)));
}
function selectionPanel(ids) {
  return [
    h('div', { class: 'obj-head' }, h('span', { class: 'badge' }, `${ids.length} objects`), h('span', { class: 'muted' }, S.layer ? `on layer ${curLayer().title}` : 'on the base layer')),
    h('p', { class: 'sel-ids' }, ids.map((id) => h('code', {}, id))),
    hint('Drag, nudge with the arrow keys or delete them together; each gesture is one undo step. Shift or Ctrl+click adds or removes an object.'),
    alignGroup(ids),
    group('Edit', h('div', { class: 'btn-row' },
      btn('Duplicate', 'object.duplicate', duplicateSel, { 'aria-label': 'Duplicate objects', 'aria-keyshortcuts': 'Control+D' }),
      btn('Copy', null, copySel, { 'data-ui': 'clipboard.copy', 'aria-label': 'Copy objects', 'aria-keyshortcuts': 'Control+C' }),
      btn('Delete objects', 'object.remove', () => deleteObjects(ids), { class: 'danger' }))),
  ];
}
function editLayer(id) { Object.assign(S, { layer: id, sel: [], fieldErr: null }); S.draft.trigger = null; render(); }
async function addLayer(e) {
  e.preventDefault();
  const id = $('#ly-new-id').value.trim(), title = $('#ly-new-title').value.trim();
  const r = await dispatch([{ cmd: 'layer.add', args: { slide: S.slide, ...(id ? { id } : {}), ...(title ? { title } : {}) } }], 'ly-new-id');
  if (r?.ok) editLayer(r.results[0].id);
}
async function addVar(e) {
  e.preventDefault();
  const name = $('#var-new-name').value.trim(), type = $('#var-new-type').value, raw = $('#var-new-initial').value.trim();
  const initial = raw === '' ? undefined : type === 'boolean' ? raw === 'true' : type === 'number' ? (Number.isNaN(Number(raw)) ? raw : Number(raw)) : raw;
  await dispatch([{ cmd: 'var.add', args: { name, type, ...(initial !== undefined ? { initial } : {}) } }], 'var-new-name');
}
async function addQuiz(e) {
  e.preventDefault();
  const id = $('#qz-new-id').value.trim(), title = $('#qz-new-title').value.trim();
  await dispatch([{ cmd: 'quiz.add', args: { ...(id ? { id } : {}), ...(title ? { title } : {}), questions: order().filter((sid) => slideById(sid).question || slideById(sid).draw) } }], 'qz-new-id');
}
function newQuestion() {
  const P = questionSchema.properties;
  return { type: 'mc', prompt: '', choices: [{ id: 'a', label: '', correct: true }, { id: 'b', label: '', correct: false }], answers: [], caseSensitive: false, points: P.points.default, attempts: P.attempts.default, shuffle: P.shuffle.default, feedback: structuredClone(P.feedback.default) };
}
// ----- hotspot areas: form rows here, drag/resize on the canvas (areaDown) -----
function newArea(areas, correct = false) {
  const used = new Set(areas.map((a) => a.id));
  let n = areas.length + 1;
  while (used.has(`area-${n}`)) n++;
  const { w, h: hh } = S.doc.size;
  return { id: `area-${n}`, shape: 'rect', x: Math.round(w / 2 - 100 + areas.length * 30), y: Math.round(hh / 2 - 75 + areas.length * 30), w: 200, h: 150, correct };
}
function areasGroup(q, C) {
  const row = (a, i) => h('li', { class: 'sub-item' },
    h('div', { class: 'grid2' },
      ctl('text', `q-area-${i}-id`, `Area ${i + 1} id`, a.id, { cmd: C, set: (v) => { a.id = v.trim(); }, attrs: { spellcheck: 'false' } }),
      ctl('select', `q-area-${i}-shape`, `Area ${i + 1} shape`, a.shape ?? 'rect', { cmd: C, structural: true, options: [['rect', 'rectangle'], ['ellipse', 'ellipse']], set: (v) => { a.shape = v; } })),
    h('div', { class: 'grid4' }, ['x', 'y', 'w', 'h'].map((k) => ctl('num', `q-area-${i}-${k}`, `Area ${i + 1} ${{ x: 'X', y: 'Y', w: 'width', h: 'height' }[k]}`, a[k], { cmd: C, structural: true, set: (v) => { a[k] = v ?? 0; }, attrs: { step: 1 } }))),
    h('div', { class: 'row-actions' },
      ctl('check', `q-area-${i}-correct`, 'Correct area', !!a.correct, { cmd: C, structural: true, set: (v) => { a.correct = v; } }),
      btn('Remove', null, () => { q.areas.splice(i, 1); render(); }, { class: 'small', 'data-ui': 'question.area.remove', 'aria-label': `Remove area ${i + 1}` })));
  return group('Areas (drag or resize them on the canvas)',
    hint('The first area that contains the learner\'s click decides. Put a picture on the slide as an image object.'),
    h('ul', { class: 'sub-list' }, (q.areas || []).map(row)),
    btn('+ Area', null, () => { q.areas = [...(q.areas || []), newArea(q.areas || [])]; render(); }, { 'data-ui': 'question.area.add' }));
}
/** Areas shown on the canvas: the open draft when there is one, else the saved question. */
const canvasAreas = (s) => (S.draft.question?.slide === s.id && S.draft.question.q ? S.draft.question.q : s.question)?.areas ?? [];
function areaEls(s, dim) {
  if (s.question?.type !== 'hotspot' && S.draft.question?.q?.type !== 'hotspot') return [];
  return canvasAreas(s).map((a, i) => h('div', {
    class: `q-area${a.correct ? ' correct' : ''}${a.shape === 'ellipse' ? ' ellipse' : ''}${dim ? ' dim' : ''}`, 'data-area': String(i), 'data-cmd': 'question.set', 'aria-hidden': 'true',
    style: { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` },
  }, h('span', { class: 'q-area-label' }, `${a.id}${a.correct ? ' (correct)' : ''}`), h('span', { class: 'handle' })));
}
/** Drag (or resize from the corner handle) one area; the gesture ends with one question.set {areas}. */
function areaDown(e, el) {
  e.preventDefault();
  const s = curSlide();
  const d = S.draft.question?.slide === s.id && S.draft.question.q ? S.draft.question : null;
  const areas = structuredClone(canvasAreas(s));
  const a = areas[Number(el.dataset.area)];
  const o = { ...a };
  const resize = e.target.classList.contains('handle');
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  drag = {
    move(ev) {
      const dx = (ev.clientX - x0) / zoom, dy = (ev.clientY - y0) / zoom;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      moved = true;
      if (resize) { a.w = Math.max(1, Math.round(o.w + dx)); a.h = Math.max(1, Math.round(o.h + dy)); } else { a.x = Math.round(o.x + dx); a.y = Math.round(o.y + dy); }
      Object.assign(el.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` });
    },
    end() {
      if (!moved) return;
      if (d) d.q.areas = structuredClone(areas);
      dispatch([{ cmd: 'question.set', args: { slide: s.id, areas } }]);
    },
  };
}
// ----- drag-and-drop items and targets: base-layer objects of the slide -----
function dragGroups(q, C) {
  const objs = curSlide().objects.map((o) => [o.id, objLabel(o)]);
  const used = () => new Set([...q.items.map((x) => x.object), ...q.targets.map((x) => x.object)]);
  const free = () => curSlide().objects.find((o) => !used().has(o.id))?.id;
  const remove = (list, i, what) => btn('Remove', null, () => { const [gone] = list.splice(i, 1); if (what === 'target') for (const it of q.items) if (it.target === gone.object) delete it.target; render(); }, { class: 'small', 'data-ui': `question.${what}.remove`, 'aria-label': `Remove ${what} ${i + 1}` });
  const targetRow = (t, i) => h('li', { class: 'sub-item' }, h('div', { class: 'grid2' },
    ctl('select', `q-target-${i}-object`, `Target ${i + 1} object`, t.object, { cmd: C, structural: true, options: objs, set: (v) => { for (const it of q.items) if (it.target === t.object) it.target = v; t.object = v; } }),
    ctl('select', `q-target-${i}-capacity`, `Target ${i + 1} holds`, t.capacity ?? 'one', { cmd: C, structural: true, options: [['one', 'one item (centred; a new drop replaces it)'], ['many', 'several items (stacked)']], set: (v) => { t.capacity = v; } })),
  remove(q.targets, i, 'target'));
  const itemRow = (it, i) => h('li', { class: 'sub-item' }, h('div', { class: 'grid2' },
    ctl('select', `q-item-${i}-object`, `Item ${i + 1} object`, it.object, { cmd: C, structural: true, options: objs, set: (v) => { it.object = v; } }),
    ctl('select', `q-item-${i}-target`, `Item ${i + 1} correct target`, it.target ?? '', { cmd: C, structural: true, options: [['', '(none: a distractor)'], ...q.targets.map((t) => [t.object, t.object])], set: (v) => { if (v) it.target = v; else delete it.target; } })),
  remove(q.items, i, 'item'));
  const add = (list, what) => btn(`+ ${cap(what)}`, null, () => { const o = free(); if (!o) { toast('Every base-layer object is already an item or a target. Add an object first.'); return; } list.push({ object: o }); render(); }, { 'data-ui': `question.${what}.add` });
  return [
    hint('Items and targets are objects on the base layer of this slide. Learners drag items, or press Enter on an item and then on a target. Correct only when every item is on its target and distractors are on none.'),
    group('Drop targets', h('ul', { class: 'sub-list' }, q.targets.map(targetRow)), add(q.targets, 'target')),
    group('Drag items', h('ul', { class: 'sub-list' }, q.items.map(itemRow)), add(q.items, 'item')),
  ];
}
// ----- matching rows: each row is answered with one of the choices; rows may share a choice -----
function rowsGroup(q, C) {
  const row = (r, i) => h('li', { class: 'sub-item' }, h('div', { class: 'grid2' },
    ctl('text', `q-row-${i}-label`, `Row ${i + 1} statement`, r.label, { cmd: C, set: (v) => { r.label = v; } }),
    ctl('select', `q-row-${i}-choice`, `Row ${i + 1} correct choice`, r.choice, { cmd: C, structural: true, options: q.choices.map((c) => [c.id, c.label || c.id]), set: (v) => { r.choice = v; } })),
  btn('Remove', null, () => { q.rows.splice(i, 1); render(); }, { class: 'small', 'data-ui': 'question.row.remove', 'aria-label': `Remove row ${i + 1}` }));
  const add = () => { const used = new Set(q.rows.map((r) => r.id)); let n = q.rows.length + 1; while (used.has(`row-${n}`)) n++; q.rows.push({ id: `row-${n}`, label: '', choice: q.choices[0]?.id ?? '' }); render(); };
  return group('Rows (each learner row is a drop-down of all choices)', h('ul', { class: 'sub-list' }, q.rows.map(row)), btn('+ Row', null, add, { 'data-ui': 'question.row.add' }));
}
const cleanArea = (a) => ({ id: a.id, ...(a.shape === 'ellipse' ? { shape: 'ellipse' } : {}), x: a.x, y: a.y, w: a.w, h: a.h, ...(a.correct ? { correct: true } : {}) });
async function saveQuestion(s, q) {
  const fill = q.type === 'fill';
  const choiceType = ['mc', 'mr', 'tf', 'matching', 'sequence'].includes(q.type);
  const args = {
    slide: s.id, type: q.type, prompt: q.prompt,
    choices: choiceType ? q.choices.map((c) => ({ id: c.id, label: c.label, ...(c.correct ? { correct: true } : {}) })) : [],
    answers: fill ? q.answers.filter((a) => a !== '') : [], caseSensitive: !!q.caseSensitive,
    points: q.points ?? 0, attempts: q.attempts ?? 1, shuffle: !!q.shuffle, feedback: { ...q.feedback },
    ...(q.type === 'hotspot' ? { areas: (q.areas || []).map(cleanArea) } : q.areas ? { areas: null } : {}),
    ...(q.type === 'dragdrop'
      ? { items: q.items.map((it) => ({ object: it.object, ...(it.target ? { target: it.target } : {}) })), targets: q.targets.map((t) => ({ object: t.object, ...(t.capacity === 'many' ? { capacity: 'many' } : {}) })) }
      : q.items || q.targets ? { items: null, targets: null } : {}),
    ...(q.type === 'matching' ? { rows: q.rows.map((r) => ({ id: r.id, label: r.label, choice: r.choice })) } : q.rows ? { rows: null } : {}),
  };
  const FIELD = { choices: 'choice', areas: 'area', items: 'item', targets: 'target', rows: 'row' };
  const r = await dispatch([{ cmd: 'question.set', args }], (errs) => { const m = /(choices|areas|items|targets|rows)\/(\d+)\/(\w+)/.exec(errs[0]?.path || ''); return m ? `q-${FIELD[m[1]]}-${m[2]}-${m[3]}` : 'q-save'; });
  if (r?.ok) { S.draft.question = null; render(); }
}

// ----- trigger form (a draft; one trigger.add / trigger.set on Save) -----
const firstMedia = () => slideObjects().find((o) => o.type === 'video' || o.type === 'audio')?.id ?? '';
function eventDefaults(ev) {
  const first = slideObjects()[0]?.id ?? '';
  return { click: { target: first }, hoverEnter: { target: first }, hoverLeave: { target: first }, timeAt: { ms: 1000 }, varChange: { var: S.doc.variables[0]?.name ?? '' }, stateChange: { target: first, state: 'selected' }, key: { key: 'Enter' }, mediaEnd: { target: firstMedia() } }[ev] ?? {};
}
function actionDefaults(type) {
  const s = curSlide();
  const first = slideObjects()[0]?.id ?? '';
  const v = S.doc.variables[0]?.name ?? '';
  return {
    setVar: { var: v, op: 'set', value: valueDefault(v) }, setState: { target: first, state: 'selected' }, setFocus: { target: first },
    showLayer: { layer: s.layers[0]?.id ?? '' }, hideLayer: S.layer ? {} : { layer: s.layers[0]?.id ?? '' }, jump: { to: 'next' },
    jumpScene: { to: S.doc.scenes[0]?.id ?? '' }, submitQuiz: { quiz: S.doc.quizzes[0]?.id ?? '' }, resetQuiz: { quiz: S.doc.quizzes[0]?.id ?? '' }, reviewQuiz: { quiz: S.doc.quizzes[0]?.id ?? '' }, openUrl: { url: 'https://' },
    playMedia: { target: firstMedia() }, pauseMedia: { target: firstMedia() }, stopMedia: { target: firstMedia() },
  }[type] ?? {};
}
function openTrigger(t) {
  S.draft.trigger = t
    ? { isNew: false, id: t.id, name: t.name ?? '', enabled: t.enabled !== false, on: { ...t.on }, cond: t.if ? { mode: t.if.any ? 'any' : 'all', clauses: (t.if.all || t.if.any).map((c) => ({ kind: c.target !== undefined ? 'state' : 'var', ...c })) } : null, do: structuredClone(t.do), else: structuredClone(t.else || []) }
    : { isNew: true, id: '', name: '', enabled: true, on: slideObjects().length ? { event: 'click', ...eventDefaults('click') } : { event: 'timelineStart' }, cond: null, do: [{ action: 'jump', to: 'next' }], else: [] };
  S.draft.triggerAtOpen = JSON.stringify(S.draft.trigger);
  S.tab = 'triggers';
  render();
  $('#tr-on-event')?.focus();
}
/** A control for one part (var, op, value, target, layer, to...) of an event, condition or action draft. */
function partCtl(idp, lp, obj, key, ctx) {
  const id = `${idp}-${key}`, label = `${lp} ${PART[key] ?? key}`;
  const sel = (options, set = (v) => { obj[key] = v; }) => ctl('select', id, label, obj[key] ?? '', { cmd: ctx.cmd, set, structural: true, options });
  const vars = (withQuiz) => [...S.doc.variables.map((v) => [v.name, `${v.name} (${v.type})`]), ...(withQuiz ? quizVars() : [])];
  switch (key) {
    case 'var': return sel(vars(ctx.quizVars), (v) => { obj.var = v; obj.value = valueDefault(v); });
    case 'otherVar': case 'fromVar': return sel([['', '(use the value)'], ...vars(ctx.quizVars)]);
    case 'op': return sel(ctx.ops);
    case 'value':
      if (obj.op === 'toggle' || obj.fromVar || obj.otherVar) return null;
      return varType(obj.var) === 'boolean' ? sel(['true', 'false']) : ctl('text', id, label, obj.value ?? '', { cmd: ctx.cmd, set: (v) => { obj.value = v; } });
    case 'target': return sel(slideObjects().map((o) => [o.id, objLabel(o)]));
    case 'is': return sel([['true', 'is'], ['false', 'is not']], (v) => { obj.is = v === 'true'; });
    case 'state': return ctl('text', id, label, obj.state ?? '', { cmd: ctx.cmd, set: (v) => { obj.state = v; }, attrs: { list: 'state-names', spellcheck: 'false' } });
    case 'layer': return sel([...(obj.action === 'hideLayer' && S.layer ? [['', '(this layer)']] : []), ...curSlide().layers.map((l) => [l.id, `${l.title} (${l.id})`])]);
    case 'to': return sel(obj.action === 'jumpScene' ? S.doc.scenes.map((sc) => [sc.id, sc.title]) : [['next', 'next slide'], ['prev', 'previous slide'], ...order().map((sid) => [sid, `${slideById(sid).title} (${sid})`])]);
    case 'quiz': return sel(S.doc.quizzes.map((q) => [q.id, q.title]));
    case 'ms': return ctl('num', id, label, obj.ms, { cmd: ctx.cmd, set: (v) => { obj.ms = v; }, attrs: { min: 0, step: 100 } });
    default: return ctl('text', id, label, obj[key] ?? '', { cmd: ctx.cmd, set: (v) => { obj[key] = v; } });
  }
}
function triggerForm(d) {
  const cmd = d.isNew ? 'trigger.add' : 'trigger.set';
  const evProps = Object.keys(eventSchema.union.map[d.on.event]?.properties || {});
  const rowTools = (list, i, what, label) => h('div', { class: 'row-actions' },
    btn('↑', null, () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; render(); }, { disabled: i === 0, 'data-ui': `trigger.${what}.move`, 'aria-label': `Move ${label} up` }),
    btn('↓', null, () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; render(); }, { disabled: i === list.length - 1, 'data-ui': `trigger.${what}.move`, 'aria-label': `Move ${label} down` }),
    btn('Remove', null, () => { list.splice(i, 1); render(); }, { 'data-ui': `trigger.${what}.remove`, 'aria-label': `Remove ${label}` }));
  const actions = (key, title) => {
    const list = d[key];
    const lp = (i) => `${key === 'do' ? 'Action' : 'Else action'} ${i + 1}`;
    return group(title,
      h('ol', { class: 'sub-list' }, list.map((a, i) => h('li', { class: 'sub-item' },
        ctl('select', `tr-${key}-${i}-action`, `${lp(i)} type`, a.action, { cmd, structural: true, options: ACTIONS, set: (v) => { list[i] = { action: v, ...actionDefaults(v) }; } }),
        h('div', { class: 'grid2' }, Object.keys(actionSchema.union.map[a.action]?.properties || {}).map((k) => partCtl(`tr-${key}-${i}`, lp(i), a, k, { cmd, ops: SET_OPS }))),
        rowTools(list, i, 'action', lp(i).toLowerCase())))),
      btn(key === 'do' ? '+ Action' : '+ Else action', null, () => { list.push({ action: 'jump', to: 'next' }); render(); }, { 'data-ui': 'trigger.action.add', id: `tr-${key}-add` }));
  };
  const clauses = d.cond?.clauses ?? [];
  return h('form', { class: 'card trig-form', 'aria-label': d.isNew ? 'New trigger' : `Edit trigger ${d.id}`, onsubmit: (e) => { e.preventDefault(); saveTrigger(d); } },
    h('h3', {}, d.isNew ? 'New trigger' : `Edit trigger ${d.id}`),
    h('div', { class: 'grid2' },
      d.isNew && ctl('text', 'tr-id', 'Trigger ID (optional)', d.id, { cmd, set: (v) => { d.id = v.trim(); }, attrs: { placeholder: 'auto', spellcheck: 'false' } }),
      ctl('text', 'tr-name', 'Name (optional)', d.name, { cmd, set: (v) => { d.name = v; } })),
    group('When',
      ctl('select', 'tr-on-event', 'Event', d.on.event, { cmd, structural: true, options: EVENTS, set: (v) => { d.on = { event: v, ...eventDefaults(v) }; } }),
      h('div', { class: 'grid2' }, evProps.map((k) => partCtl('tr-on', 'Event', d.on, k, { cmd, quizVars: true })))),
    group('If',
      ctl('select', 'tr-cond', 'Conditions', d.cond?.mode ?? '', { cmd, structural: true, options: [['', 'Always (no conditions)'], ['all', 'All of these are true'], ['any', 'Any of these is true']], set: (v) => { d.cond = v ? { mode: v, clauses: d.cond?.clauses?.length ? d.cond.clauses : [newClause()] } : null; } }),
      d.cond && h('ol', { class: 'sub-list' }, clauses.map((c, i) => h('li', { class: 'sub-item' },
        ctl('select', `tr-if-${i}-kind`, `Condition ${i + 1} kind`, c.kind, { cmd, structural: true, options: [['var', 'Variable'], ['state', 'Object state']], set: (v) => { clauses[i] = newClause(v); } }),
        h('div', { class: 'grid2' }, (c.kind === 'state' ? ['target', 'is', 'state'] : ['var', 'op', 'value', 'otherVar']).map((k) => partCtl(`tr-if-${i}`, `Condition ${i + 1}`, c, k, { cmd, ops: CMP_OPS, quizVars: true }))),
        rowTools(clauses, i, 'condition', `condition ${i + 1}`)))),
      d.cond && btn('+ Condition', null, () => { clauses.push(newClause()); render(); }, { 'data-ui': 'trigger.condition.add', id: 'tr-if-add' })),
    actions('do', 'Do (in order; a jump ends the rest)'),
    d.cond && actions('else', 'Else (when the conditions are false)'),
    ctl('check', 'tr-enabled', 'Enabled', d.enabled, { cmd, set: (v) => { d.enabled = v; } }),
    h('div', { class: 'btn-row' },
      h('button', { type: 'submit', id: 'tr-save', class: 'primary', 'data-cmd': cmd }, d.isNew ? 'Add trigger' : 'Save trigger'),
      btn('Cancel', null, () => { S.draft.trigger = null; render(); }, { 'data-ui': 'trigger.cancel' })));
}
function newClause(kind = 'var') {
  if (kind === 'state') return { kind, target: slideObjects()[0]?.id ?? '', is: true, state: 'selected' };
  const v = S.doc.variables[0]?.name ?? '';
  return { kind, var: v, op: '==', value: valueDefault(v) };
}
const cleanAction = (a) => {
  const out = { action: a.action };
  for (const k of Object.keys(actionSchema.union.map[a.action]?.properties || {})) {
    const v = a[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'value' && (a.op === 'toggle' || a.fromVar)) continue;
    out[k] = k === 'value' ? typed(a.var, v) : v;
  }
  return out;
};
const cleanClause = (c) => (c.kind === 'state'
  ? { target: c.target, state: c.state, ...(c.is === false ? { is: false } : {}) }
  : { var: c.var, op: c.op, ...(c.otherVar ? { otherVar: c.otherVar } : { value: typed(c.var, c.value) }) });
async function saveTrigger(d) {
  const on = { event: d.on.event };
  for (const k of Object.keys(eventSchema.union.map[d.on.event]?.properties || {})) if (d.on[k] !== undefined && d.on[k] !== null && d.on[k] !== '') on[k] = k === 'ms' ? Number(d.on[k]) : d.on[k];
  const cond = d.cond?.clauses.length ? { [d.cond.mode]: d.cond.clauses.map(cleanClause) } : null;
  const elseActs = cond && d.else.length ? d.else.map(cleanAction) : null;
  const body = { ...(d.name ? { name: d.name } : {}), on, ...(cond ? { if: cond } : {}), do: d.do.map(cleanAction), ...(elseActs ? { else: elseActs } : {}) };
  const cmds = d.isNew
    ? [{ cmd: 'trigger.add', args: { slide: S.slide, ...(S.layer ? { layer: S.layer } : {}), ...(d.id ? { id: d.id } : {}), ...body, ...(d.enabled ? {} : { enabled: false }) } }]
    : [{ cmd: 'trigger.set', args: { id: d.id, ...body, name: d.name || null, if: cond, else: elseActs, enabled: d.enabled } }];
  const r = await dispatch(cmds, (errs) => {
    const p = errs[0]?.path || '';
    let m;
    if ((m = /\/(do|else)\/(\d+)\/(\w+)/.exec(p))) return `tr-${m[1]}-${m[2]}-${m[3] === 'action' ? 'action' : m[3]}`;
    if ((m = /\/if\/(?:all|any)\/(\d+)\/(\w+)/.exec(p))) return `tr-if-${m[1]}-${m[2]}`;
    if ((m = /\/on\/(\w+)/.exec(p))) return `tr-on-${m[1]}`;
    return /\/args\/id$/.test(p) ? 'tr-id' : 'tr-save';
  });
  if (r?.ok) { S.draft.trigger = null; render(); announce('Trigger saved'); }
}

// ----- command log, agent parity dialog -----
const batchJson = (cmds) => `[\n${cmds.map((c) => `  ${JSON.stringify(c)}`).join(',\n')}\n]`;
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
function equivalents(e) {
  const mcpFile = e.file.split(/[\\/]/).at(-1);
  switch (e.kind) {
    case 'commands': return { cli: `cf cmd ${e.file} ${shq(JSON.stringify(e.cmds))}`, mcp: `run_commands ${JSON.stringify({ file: mcpFile, commands: e.cmds }, null, 2)}`, http: `POST /api/courses/${e.name}/commands\n${JSON.stringify({ commands: e.cmds })}` };
    case 'undo': case 'redo': return { cli: `cf ${e.kind} ${e.file}`, mcp: `${e.kind} ${JSON.stringify({ file: mcpFile })}`, http: `POST /api/courses/${e.name}/${e.kind}` };
    case 'import_story': return { cli: `cf import ${e.path} ${e.file}`, mcp: `import_story ${JSON.stringify({ story: e.path, file: mcpFile })}`, http: `POST /api/import
${JSON.stringify({ path: e.path, name: e.name, format: e.format })}` };
    case 'new_course': return { cli: `cf new ${e.file} --title ${shq(e.title || '')}${e.mode ? ` --mode ${e.mode}` : ''}`, mcp: `new_course ${JSON.stringify({ file: mcpFile, ...(e.title ? { title: e.title } : {}), ...(e.mode ? { mode: e.mode } : {}) })}`, http: `POST /api/courses\n${JSON.stringify({ name: e.name, title: e.title, mode: e.mode, format: e.format })}` };
    case 'publish': return { cli: `cf publish ${e.file} --${e.target} dist/${e.name}-${e.target}${e.target === 'scorm12' ? ' --zip' : ''}`, mcp: `publish ${JSON.stringify({ file: mcpFile, target: e.target, out: `dist/${e.name}-${e.target}`, ...(e.target === 'scorm12' ? { zip:true } : {}) })}`, http: `POST /api/courses/${e.name}/publish\n${JSON.stringify({ target: e.target, ...(e.target === 'scorm12' ? { zip:true } : {}) })}` };
    default: return { cli: '', mcp: '', http: '' };
  }
}
const entryText = (e) => (e.kind === 'commands' ? batchJson(e.cmds) : equivalents(e).mcp);
async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); announce(what); toast(`${what} to the clipboard.`); } catch { toast('The browser blocked clipboard access; select the text and copy it instead.', 'error'); }
}
function renderLog() {
  $('#log-count').textContent = S.log.length ? String(S.log.length) : '';
  $('#btn-agent').disabled = !S.last;
  if ($('#drawer').hidden) return;
  const skip = Math.max(0, S.log.length - 200); // the drawer shows the latest 200; every entry stays in S.log
  $('#log-list').replaceChildren(...S.log.slice(skip).map((e, j) => [e, j + skip]).map(([e, i]) => h('li', { class: e.ok ? 'ok' : 'err' },
    h('div', { class: 'log-head' },
      h('span', { class: `badge ${e.ok ? 'ok' : 'err'}` }, e.ok ? 'applied' : 'rejected'), h('time', {}, e.at),
      h('span', { class: 'log-what' }, e.kind === 'commands' ? e.cmds.map((c) => c.cmd).join(', ') : e.kind),
      btn('Copy', null, () => copy(entryText(e), 'Command JSON copied'), { class: 'small', 'data-ui': 'log.copy', 'aria-label': `Copy entry ${i + 1} as JSON` })),
    h('pre', {}, entryText(e)),
    !e.ok && e.errors && h('p', { class: 'field-err' }, e.errors.map(fmtErr).join(' ')))).reverse());
}
function toggleLog(open = $('#drawer').hidden) {
  $('#drawer').hidden = !open;
  $('#btn-log').setAttribute('aria-expanded', String(open));
  renderLog();
  if (open) $('#log-close').focus(); else $('#btn-log').focus();
}
function showAgent() {
  const e = S.last;
  if (!e) return;
  const eq = equivalents(e);
  const block = (title, text, note) => h('section', { class: 'agent-block' },
    h('div', { class: 'agent-head' }, h('h3', {}, title), btn('Copy', null, () => copy(text, `${title} copied`), { class: 'small', 'data-ui': 'agent.copy', 'aria-label': `Copy ${title}` })),
    note && hint(note), h('pre', {}, text));
  show('Do the same as an agent', 'agent wide',
    hint(`Your last action${e.ok ? '' : ' (rejected by the server)'} expressed for the other front-ends. They share the registry, validation and undo history with this editor.`),
    block('CLI', eq.cli, 'Run from the folder the server was started in.'),
    block('MCP tool', eq.mcp, 'Paths are relative to the courses root.'),
    block('HTTP', eq.http, 'Send header x-cf-token with the token from the launch URL.'));
}
/** P2.10: paste or type an outline; one outline.add {text} adds scenes/slides (slides mode) or sections/lessons. */
function showOutline() {
  const area = h('textarea', { id: 'outline-text', rows: 14, spellcheck: 'true', 'data-cmd': 'outline.add', placeholder: OUTLINE_EXAMPLE });
  const add = async () => {
    const r = await dispatch([{ cmd: 'outline.add', args: { text: area.value } }], 'outline-text');
    if (r?.ok) { $('#dlg').close(); toast(`Added ${LV.active() ? 'lessons' : 'slides'} from the outline`); }
  };
  show('Create from an outline', 'wide',
    hint(`Each "# " line starts a ${LV.active() ? 'section' : 'scene'} and each "## " line a ${LV.active() ? 'lesson' : 'slide'}. Plain lines become text, "- " lines bullets. A "? " line adds a question: "[x] " marks a correct choice and "[ ] " a wrong one, or "= " lines list accepted fill-in answers. Agents send the same text with outline.add.`),
    field('outline-text', 'Outline', area),
    h('div', { class: 'btn-row' }, btn('Add to course', 'outline.add', add, { class: 'primary' })));
}
const OUTLINE_EXAMPLE = '# Getting started\n## Why it matters\nMost incidents start small.\n- Wear goggles\n- Label everything\n## Check\n? What do you put on first?\n[x] Goggles\n[ ] Coffee';
function showPreview() {
  const here = !LV.active() && S.slide && order().includes(S.slide) ? `&slide=${encodeURIComponent(S.slide)}` : ''; // FR-C8
  const src = `/preview/${encodeURIComponent(S.name)}?token=${encodeURIComponent(token)}${here}`;
  const { w, h: hh } = S.doc.size;
  show(`Preview: ${S.doc.title}`, 'wide preview',
    h('iframe', { src, title: `Preview of ${S.doc.title}`, class: 'preview-frame', style: LV.active() ? { height: '74vh' } : { aspectRatio: `${w} / ${hh}` } }), // lessons scroll: a tall frame
    h('p', {}, h('a', { href: src, target: '_blank', rel: 'noopener', 'data-ui': 'preview.tab' }, 'Open the preview in a new tab')));
}
function showStorylineExport() {
  const status = h('p', { role: 'status' });
  const exportFile = (target, format) => enqueue(async () => {
    const r = await call('POST', courseUrl('/publish'), { target, ...(format ? { format } : {}) });
    if (r.ok) status.textContent = 'Saved ' + r.out + (r.result ? '. Report: ' + r.result.report + ' (' + r.result.issues + ' entries).' : '');
    else status.textContent = (r.errors || []).map(e => e.message).join(' ');
  });
  show('Export for Storyline', '',
    hint('The PowerPoint deck carries your slides as editable text, shapes and pictures; Storyline imports it as new slides. Questions travel in a separate question file. Layers, triggers and anything else a deck cannot hold are listed in a report next to each file. An export never replaces an earlier one: move or rename the old files first.'),
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', 'data-cmd': 'publish', onclick: () => exportFile('pptx') }, 'Export PowerPoint'),
      h('button', { type: 'button', 'data-cmd': 'publish', onclick: () => exportFile('questions', 'xlsx') }, 'Export questions (Excel)'),
      h('button', { type: 'button', 'data-cmd': 'publish', onclick: () => exportFile('questions', 'txt') }, 'Export questions (text)')),
    hint('Excel is the safer choice. Storyline reserves | * and // in question files, so those characters are swapped for look-alikes and listed in the report.'),
    h('h3', {}, 'Web Object'),
    hint('Publish Web, then in Storyline choose Insert > Web Object and select the published folder containing index.html. Display it in the slide at the course stage size. Keep every file and subfolder together. This preserves interactions inside the embedded player.'),
    h('button', { type: 'button', 'data-cmd': 'publish', onclick: () => exportFile('web') }, 'Publish Web folder'), status);
}
function publish(target) {
  return enqueue(async () => {
    const r = await call('POST', courseUrl('/publish'), { target, ...(target === 'scorm12' ? { zip:true } : {}) });
    record({ kind: 'publish', target }, r);
    if (r.ok) toast(`Published ${target === 'web' ? 'the web package' : 'the SCORM 1.2 package'} to ${r.zip || r.out}`); else showErrors(r.errors);
  });
}
function historyOp(op) {
  if (!S.name || !S.history[op]) return null;
  return enqueue(async () => {
    const r = await call('POST', courseUrl(`/${op}`));
    record({ kind: op }, r);
    S.saved = true; saveStatus(r);
    if (r.ok) { S.fieldErr = null; S.draft = {}; adopt(r); render(); announce(op === 'undo' ? 'Undone' : 'Redone'); } else showErrors(r.errors);
  });
}

// ----- courses -----
async function loadCourses() {
  const r = await call('GET', '/api/courses');
  S.courses = r.ok ? r.courses : [];
  if (!r.ok) showErrors(r.errors);
}
async function createCourse(e) {
  e.preventDefault();
  const name = $('#new-name').value.trim(), title = $('#new-title').value.trim();
  const mode = $('#new-mode-lessons').checked ? 'lessons' : undefined;
  const format = mode === 'lessons' ? 'json' : $('#new-format').value;
  const r = await call('POST', '/api/courses', { name, format, ...(title ? { title } : {}), ...(mode ? { mode } : {}) });
  record({ kind: 'new_course', name, title, mode, format }, r);
  if (!r.ok) return showErrors(r.errors, 'new-name');
  return openCourse(name, r);
}
async function importCourse(e) {
  e.preventDefault();
  const path = $('#imp-path').value.trim(), name = $('#imp-name').value.trim(), format = $('#imp-format').value;
  const r = await call('POST', '/api/import', { path, name, format });
  record({ kind: 'import_story', name, path, format }, r);
  if (!r.ok) return showErrors(r.errors, 'imp-path');
  toast(`Imported ${r.summary?.mapped?.slides ?? '?'} slides; ${r.summary?.reported ?? 0} items not mapped are listed in ${r.reportFile}`);
  return openCourse(name, r);
}
async function openCourse(name, loaded) {
  await drain(); // edits still on their way belong to the course that is open now
  const r = loaded ?? await call('GET', `/api/courses/${encodeURIComponent(name)}`);
  if (!r.ok) return showErrors(r.errors);
  if (S.name !== name) AI.reset(); // a conversation belongs to one course
  Object.assign(S, { name, slide: null, layer: null, sel: [], draft: {}, tab: 'props', fieldErr: null, history: { undo: 0, redo: 0 }, saved: false, saveErr: null });
  saveStatus();
  adopt(r);
  history.replaceState(null, '', `${location.pathname}${location.search}#${encodeURIComponent(name)}`);
  subscribe();
  render();
  if (r.importSummary?.reported) toast(`${r.importSummary.reported} source items have display or behavior limitations. Open Check for the .story display report; source content is retained when saving.`);
  return r;
}
async function closeCourse() {
  await drain();
  events?.close();
  AI.toggle(false);
  Object.assign(S, { name: null, doc: null, slide: null, layer: null, sel: [], draft: {}, courses: null, saved: false, saveErr: null });
  saveStatus();
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  render();
  await loadCourses();
  render();
}

// ---------- wiring ----------
const SHORTCUTS = [
  ['Editing', [['Ctrl+Z', 'Undo'], ['Ctrl+Y', 'Ctrl+Shift+Z', 'Redo'], ['Ctrl+C', 'Copy the selected objects'], ['Ctrl+V', 'Paste them onto the slide or layer being edited'], ['Ctrl+D', 'Duplicate the selected objects'], ['Ctrl+I', 'Ask Claude: open or close the assistant']]],
  ['Canvas', [['Tab', 'Select the next object'], ['Shift+Click', 'Ctrl+Click', 'Add or remove an object from the selection'], ['Ctrl+A', 'Select every object on the slide or layer being edited'],
    ['Arrows', 'Move the selection 1 pixel'], ['Shift+Arrows', 'Move the selection 10 pixels'], ['Delete', 'Backspace', 'Delete the selection'], ['Escape', 'Clear the selection'],
    ['Drag on empty canvas', 'Select the objects inside the box (Shift adds)'], ['Shift+Drag a corner', 'Resize and keep the proportions'], ['Alt+Drag', 'Move without snapping'],
    ['Shift+F10', 'Menu', 'Open the object menu (also right-click)'], ['Ctrl+=', 'Ctrl+-', 'Zoom in or out'], ['Ctrl+0', 'Fit the slide in the window']]],
  ['Lessons', [['Tab', 'Select the next block on the lesson page'], ['Alt+Up', 'Alt+Down', 'Move the selected block'], ['Delete', 'Backspace', 'Delete the selected block']]],
  ['Panels', [['Left', 'Right', 'Switch inspector tabs (Home and End jump to the first and last)'], ['Space', 'Tick a timeline checkbox to add that object to the selection'], ['?', 'Show this list']]],
];
function showShortcuts() {
  const keys = (combo) => combo.split('+').flatMap((k, i) => [i ? '+' : null, h('kbd', {}, k)]);
  show('Keyboard shortcuts', 'keys-dlg',
    hint('On a Mac, use Cmd instead of Ctrl. Shortcuts do nothing while you type in a field, so text fields keep their own undo, copy and paste.'),
    SHORTCUTS.map(([title, rows]) => h('section', { class: 'keys' }, h('h3', {}, title),
      h('dl', {}, rows.flatMap((r) => [h('dt', {}, r.slice(0, -1).flatMap((c, i) => [i ? ' or ' : null, keys(c)])), h('dd', {}, r.at(-1))])))));
}
function onKey(e) {
  if (!S.doc || $('#dlg').open) return;
  const typing = e.target.closest?.('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]');
  if (typing) return; // text fields keep their native undo, copy and paste
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === '?' && !mod) { e.preventDefault(); showShortcuts(); return; }
  if (mod && !e.altKey && e.key.toLowerCase() === 'i' && S.doc) { e.preventDefault(); AI.toggle(); return; }
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); guarded(historyOp)('undo'); } else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); guarded(historyOp)('redo'); }
  else if (k === 'c' && S.sel.length && window.getSelection().isCollapsed) { e.preventDefault(); copySel(); } // selected page text copies natively
  else if (k === 'v' && S.clip) { e.preventDefault(); paste(); }
  else if (k === 'd' && S.sel.length) { e.preventDefault(); duplicateSel(); }
  else if (k === '0' && curSlide()) { e.preventDefault(); zoomTo('fit'); }
  else if ((k === '=' || k === '+') && curSlide()) { e.preventDefault(); zoomTo({ by: 1.25 }); }
  else if (k === '-' && curSlide()) { e.preventDefault(); zoomTo({ by: 0.8 }); }
  else if (k === 'a' && curSlide() && (e.target === document.body || e.target.closest?.('#stage, #timeline'))) {
    e.preventDefault();
    S.sel = contextObjects().map((o) => o.id);
    render();
    announce(`${S.sel.length} objects selected`);
  }
}
async function init() {
  $('#state-names').replaceChildren(...BUILTIN_STATES.map((n) => h('option', { value: n })));
  $('#btn-courses').onclick = guarded(closeCourse);
  $('#btn-undo').onclick = guarded(() => historyOp('undo'));
  $('#btn-redo').onclick = guarded(() => historyOp('redo'));
  $('#btn-preview').onclick = showPreview;
  $('#btn-check').onclick = showCheck;
  $('#btn-storyline-export').onclick = showStorylineExport;
  $('#btn-pub-web').onclick = () => publish('web');
  $('#btn-pub-scorm').onclick = () => publish('scorm12');
  $('#btn-log').onclick = () => toggleLog();
  $('#log-close').onclick = () => toggleLog(false);
  $('#btn-agent').onclick = showAgent;
  $('#btn-ai').onclick = () => AI.toggle();
  $('#btn-outline').onclick = showOutline;
  $('#btn-keys').onclick = showShortcuts;
  $('#btn-copy').onclick = copySel;
  $('#btn-paste').onclick = paste;
  $('#btn-dup').onclick = duplicateSel;
  $('#btn-timeline').onclick = () => { S.timeline = !S.timeline; render(); };
  for (const b of document.querySelectorAll('#insertbar [data-type]')) b.onclick = () => insert(b.dataset.type);
  $('#edit-layer').onchange = guarded((e) => editLayer(e.target.value || null));
  $('#tabs').addEventListener('keydown', onTabKey);
  const stage = $('#stage');
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('keydown', onStageKey);
  stage.addEventListener('contextmenu', (e) => { const el = e.target.closest('.obj:not(.dim)'); if (!el) return; e.preventDefault(); if (!S.sel.includes(el.dataset.id)) selectObj(el.dataset.id, false); objectMenu(e.clientX, e.clientY); });
  $('#btn-zoom-in').onclick = () => zoomTo({ by: 1.25 });
  $('#btn-zoom-out').onclick = () => zoomTo({ by: 0.8 });
  $('#btn-zoom-fit').onclick = () => zoomTo('fit');
  $('#btn-zoom-100').onclick = () => zoomTo(1);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', () => { drag = null; quietFocus = false; render(); });
  document.addEventListener('keydown', onKey);
  new ResizeObserver(() => fit()).observe($('#viewport'));
  render();
  if (!token) return;
  const [, cmds] = await Promise.all([loadCourses(), call('GET', '/api/commands'), AI.refresh()]);
  if (cmds.ok) S.summaries = Object.fromEntries(cmds.commands.map((c) => [c.name, c.summary]));
  const fromHash = () => { const wanted = decodeURIComponent(location.hash.slice(1)); return wanted && wanted !== S.name ? openCourse(wanted) : render(); };
  window.addEventListener('hashchange', fromHash);
  await fromHash();
}
// ---------- lessons mode: packages/editor/lessons-view.js owns its outline, lesson page and inspector ----------
const AI = aiView({ S, $, h, call, show, toast, adopt, render, announce, courseUrl, token, openCourse, loadCourses, record, showErrors });
const LV = lessonsView({ exportPkg, readJsonFile, tabKey, S, $, h, ctl, colorCtl, themeGroup, group, hint, btn, cap, dispatch, ask, removeWithForce, announce, render, toast, call, record, courseUrl, showErrors, token });
init();
