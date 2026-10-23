// Course file I/O shared by the CLI, HTTP server and MCP server: atomic saves, a parsed-document cache and a persistent
// undo/redo history.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse, serialize, fillDefaults, emptyCourse, validate } from '../schema/index.js';
import { applyAll } from '../core/index.js';
import { openStory, saveStory } from '../export-story/save.js';
import { writeStory } from '../export-story/index.js';
import { importStoryFile, importStory, summarize } from '../import-story/index.js';

// Parsed documents by file, keyed on mtime + size. A long-running server or MCP process skips re-parsing and
// re-validating the course it just wrote (most of an edit's cost on a large course); any other writer changes the
// stamp, so the next load parses the file again.
const cache = new Map();
const stamp = (file) => { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; };
export const isStory = (file) => /\.story$/i.test(file);
const stem = (file) => path.basename(file).replace(/\.story$|\.course\.json$|\.json$/i, '');
const storyOptions = (file) => ({ courseDir: path.dirname(path.resolve(file)), assetsDir: path.join(path.dirname(path.resolve(file)), 'assets', stem(file)), title: stem(file) });
// ponytail: retain one open package, rather than retaining every course's ZIP and XML in a long-running server.
let storyCache;
function storyState(file) {
  const key = path.resolve(file), st = stamp(file);
  if (storyCache?.key !== key || storyCache.stamp !== st) storyCache = { key, stamp: st, state: openStory(fs.readFileSync(file), storyOptions(file)) };
  return storyCache.state;
}
const storyError = (code, message, hint) => Object.assign(new Error(message), { errors: [{ path: '/file', code, message, hint }] });
function newStory(file, doc) {
  const errors = validate(doc);
  if (errors.length) throw Object.assign(new Error('invalid course'), { errors });
  const blank = emptyCourse({ id: doc.id, title: doc.title });
  blank.size = doc.size;
  if (serialize(doc) !== serialize(blank)) throw storyError('story-unsupported', 'Only an empty slide course can be created as .story here', 'Use .course.json for lessons or populated course conversion');
  return openStory(writeStory({ title: doc.title, size: doc.size }), storyOptions(file));
}

/** Load and validate a course file. Throws {code:'ENOENT'} when missing, {errors} when invalid. */
export function loadCourse(file) {
  if (isStory(file)) return structuredClone(storyState(file).doc);
  const key = path.resolve(file), st = stamp(file);
  const hit = cache.get(key);
  if (hit?.stamp === st) return structuredClone(hit.doc);
  const doc = parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  cache.set(key, { stamp: st, doc: structuredClone(doc) });
  return doc;
}
/** Rendering coverage of a native package; the original file retains unsupported content. */
export function storySummary(file) { return isStory(file) ? summarize(storyState(file).report) : null; }

/** Atomic write: a temp file renamed over the target, so a crash never leaves half a file. */
const atomic = (file, text) => {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); return text; }
  catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* preserve the original error */ }
    if (isStory(file) && ['EBUSY', 'EPERM'].includes(e.code)) throw storyError('story-locked', 'The .story file is locked; nothing was saved', 'Close the project in Storyline, then retry');
    throw e;
  }
};
function write(file, doc) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  return atomic(file, serialize(doc));
}
/** Atomic write (temp file + rename); creates parent folders. */
export function saveCourse(file, doc) { if (isStory(file)) return saveValid(file, doc).doc; write(file, doc); return doc; }
const digest = (text) => crypto.createHash('sha256').update(text).digest('base64url');
/** Save a document the command core has validated and remember it exactly as the next load would return it.
 *  Returns {doc, hash}: hash identifies the bytes written, so history can tell when someone else changed the file. */
function saveValid(file, doc, initial, remember = false) {
  if (isStory(file)) {
    const prior = initial ?? (fs.existsSync(file) ? storyState(file) : undefined);
    const state = prior ? saveStory(prior, doc) : newStory(file, doc);
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    // Persist both archives before replacing the course; a snapshot failure cannot destroy undo data.
    let native;
    try {
      native = remember ? { before: snapshot(file, prior.buf), after: snapshot(file, state.buf) } : undefined;
      atomic(file, state.buf);
    } catch (e) {
      if (remember) try { pruneSnapshots(file, readHist(file)); } catch { /* preserve the save error */ }
      throw e;
    }
    const st = stamp(file);
    storyCache = fs.readFileSync(file).equals(state.buf) && stamp(file) === st ? { key: path.resolve(file), stamp: st, state } : undefined;
    return { doc: structuredClone(state.doc), hash: digest(state.buf), native };
  }
  const text = write(file, doc), key = path.resolve(file);
  const saved = fillDefaults(JSON.parse(text)); // exactly what parse() returns for this text, minus re-validation
  // Another process may save between our rename and this check: cache only if the file still holds our bytes (007 #1).
  const st = stamp(file);
  if (fs.readFileSync(file, 'utf8') === text && stamp(file) === st) cache.set(key, { stamp: st, doc: saved }); else cache.delete(key);
  return { doc: structuredClone(saved), hash: digest(text) };
}

/** Monotonic revision for optimistic concurrency (editor vs agents): file mtime in ms. */
export function revision(file) {
  try { return Math.floor(fs.statSync(file).mtimeMs); } catch { return 0; }
}

// ---------- patches: what an edit changed, as [path, value] ops ([path] alone deletes) ----------
const isObj = (v) => v !== null && typeof v === 'object';
/** Ops that turn `a` into `b`. ponytail: an array whose length changes is stored whole (adding a slide stores the slides array); match elements by id if that ever matters. */
export function diff(a, b, p = [], ops = []) {
  if (a === b) return ops;
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b) && (!Array.isArray(a) || a.length === b.length)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(Object.hasOwn(a, k) ? a[k] : undefined, Object.hasOwn(b, k) ? b[k] : undefined, [...p, k], ops);
  } else ops.push(b === undefined ? [p] : [p, b]);
  return ops;
}
/** Apply ops to a copy. Keys are own data properties only, so "__proto__" or "constructor" are ordinary keys. */
export function patch(doc, ops) {
  let root = structuredClone(doc);
  for (const [p, ...v] of ops) {
    if (!p.length) { root = structuredClone(v[0]); continue; }
    const parent = p.slice(0, -1).reduce((o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined), root);
    if (!isObj(parent)) throw Object.assign(new Error('the course changed since this edit; undo is not possible'), { errors: [{ path: '/', code: 'history', message: 'the course changed since this edit; undo is not possible' }] });
    const k = p.at(-1);
    if (v.length) Object.defineProperty(parent, k, { value: structuredClone(v[0]), writable: true, enumerable: true, configurable: true });
    else delete parent[k];
  }
  return root;
}

// History: <file>.history.json = { undo: [{u, r}], redo: [{u, r}] } (capped); u turns the newer document into the
// older one, r the older into the newer. Entries from the old whole-document format ({forward, inverse}) are dropped.
const HISTORY_LIMIT = 100;
const VERB = { add: 'Add', set: 'Change', remove: 'Delete', move: 'Move', duplicate: 'Duplicate', import: 'Import', replace: 'Replace', apply: 'Apply', align: 'Align', distribute: 'Distribute' };
/** What a batch did, for the Undo and Redo buttons: "Move object", "Add slide", "3 changes". */
export function label(cmds) {
  const list = [].concat(cmds);
  const names = [...new Set(list.map((c) => String(c?.cmd ?? '')))];
  if (names.length !== 1) return `${list.length} changes`;
  const [noun, verb = ''] = names[0].split('.');
  const moved = verb === 'set' && list.every((c) => Object.keys(c.args || {}).every((k) => ['id', 'x', 'y'].includes(k)));
  return `${moved ? 'Move' : VERB[verb] ?? verb} ${noun}${list.length > 1 ? ` (${list.length})` : ''}`;
}
const histFile = (file) => `${file}.history.json`;
const histDir = (file) => path.resolve(`${file}.history`);
const validHash = (hash) => typeof hash === 'string' && /^[A-Za-z0-9_-]{43}$/.test(hash);
const historyError = (message) => Object.assign(new Error(message), { status: 409, errors: [{ path: '/', code: 'history', message }] });
function snapshotPath(file, hash) {
  if (!validHash(hash)) throw historyError('invalid native history snapshot');
  const dir = histDir(file);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw historyError('native history folder must not be a link');
  return path.join(dir, `${hash}.story`);
}
function snapshot(file, bytes) {
  const hash = digest(bytes), target = snapshotPath(file, hash);
  fs.mkdirSync(histDir(file), { recursive: true });
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw historyError('native history snapshot must not be a link');
  if (!fs.existsSync(target) || digest(fs.readFileSync(target)) !== hash) atomic(target, bytes);
  return hash;
}
const readHist = (file) => {
  let h; try { h = JSON.parse(fs.readFileSync(histFile(file), 'utf8')); } catch { h = {}; }
  // Old native model patches cannot restore opaque XML; expose only archive-backed steps.
  const ok = (l) => (Array.isArray(l) ? l.filter((e) => isStory(file)
    ? validHash(e?.native?.before) && validHash(e?.native?.after) && validHash(e?.h)
    : Array.isArray(e?.u) && Array.isArray(e?.r)) : []);
  return { undo: ok(h.undo), redo: ok(h.redo) };
};
const writeHist = (file, h) => atomic(histFile(file), JSON.stringify(h));
function pruneSnapshots(file, h) {
  const keep = new Set([...h.undo, ...h.redo].flatMap(e => [e.native.before, e.native.after]));
  // Only our hash-named regular files, never recursive removal or user files.
  for (const entry of fs.readdirSync(histDir(file), { withFileTypes: true })) {
    const hash = entry.name.replace(/\.story$/, '');
    if (entry.isFile() && entry.name === `${hash}.story` && validHash(hash) && !keep.has(hash)) fs.unlinkSync(snapshotPath(file, hash));
  }
}

function step(file, from, to) {
  const h = readHist(file);
  const e = h[from].pop();
  if (!e) return null;
  // Patches address array positions: applied to a file someone else changed, they could edit the wrong object (007 #2).
  if (e.h && digest(fs.readFileSync(file)) !== e.h) {
    const message = `the course was changed outside the shared history since this step, so ${from} could change the wrong things; make the change by hand`;
    throw Object.assign(new Error(message), { status: 409, errors: [{ path: '/', code: 'history', message, hint: 'reload the course' }] });
  }
  let doc, hash;
  if (isStory(file)) {
    hash = from === 'undo' ? e.native.before : e.native.after;
    const target = snapshotPath(file, hash);
    if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) throw historyError('native history snapshot is missing or is a link');
    const bytes = fs.readFileSync(target);
    if (digest(bytes) !== hash) throw historyError('native history snapshot was changed; nothing was restored');
    const state = openStory(bytes, storyOptions(file)); // validate before replacing current archive
    atomic(file, bytes);
    storyCache = undefined;
    doc = structuredClone(state.doc);
  } else {
    const cur = loadCourse(file);
    const r = applyAll(cur, [{ cmd: 'course.replace', args: { doc: patch(cur, from === 'undo' ? e.u : e.r) } }]);
    if (!r.ok) throw Object.assign(new Error(`${from} failed`), { errors: r.errors });
    ({ doc, hash } = saveValid(file, r.doc));
  }
  h[to].push({ ...e, h: hash }); // the reverse step expects the file as it is now
  if (!isStory(file) && h[from].length) h[from].at(-1).h = hash;
  writeHist(file, h);
  return doc;
}

export const history = {
  /** Record one applied batch: `before` and `after` are the documents on either side of it. */
  record(file, before, after, what, hash, native) {
    if (isStory(file) && (!validHash(native?.before) || !validHash(native?.after))) throw historyError('native history requires archive snapshots');
    const h = readHist(file);
    h.undo.push({ ...(isStory(file) ? { native } : { u: diff(after, before), r: diff(before, after) }), ...(what ? { label: what } : {}), ...(hash ? { h: hash } : {}) });
    if (h.undo.length > HISTORY_LIMIT) h.undo.splice(0, h.undo.length - HISTORY_LIMIT);
    h.redo = [];
    writeHist(file, h);
    if (isStory(file)) pruneSnapshots(file, h);
  },
  /** Undo the last batch: returns the restored doc (and saves it) or null. */
  undo: (file) => step(file, 'undo', 'redo'),
  redo: (file) => step(file, 'redo', 'undo'),
  depth(file) { const h = readHist(file); return { undo: h.undo.length, redo: h.redo.length, undoLabel: h.undo.at(-1)?.label ?? null, redoLabel: h.redo.at(-1)?.label ?? null }; },
};

/** Load, apply commands atomically, save and record history. Returns applyAll's result (+rev). */
export function runCommands(file, cmds, { create = false, emptyCourse, rng } = {}) {
  let doc, initial;
  try { doc = loadCourse(file); } catch (e) {
    if (e.code === 'ENOENT' && create && emptyCourse) {
      doc = emptyCourse({ title: stem(file) });
      if (isStory(file)) { initial = newStory(file, doc); doc = structuredClone(initial.doc); }
    }
    else throw e;
  }
  const r = applyAll(doc, cmds, { rng });
  if (!r.ok) return r;
  const { doc: after, hash, native } = saveValid(file, r.doc, initial, isStory(file));
  history.record(file, doc, after, label(cmds), hash, native); // loadCourse and emptyCourse both return normalized documents
  return { ...r, doc: after, rev: revision(file) };
}

/** Open a native copy when the destination is .story; convert only for JSON destinations. */
export function importCourse(source, file, options = {}) {
  if (!isStory(file)) return importStoryFile(source, file, options);
  if (fs.existsSync(file)) throw storyError('dupe', `already exists: ${file}`, 'Choose another output file');
  const opts = { ...storyOptions(file), ...(options.assetsDir ? { assetsDir: path.resolve(options.assetsDir) } : {}) };
  const rel = path.relative(opts.courseDir, opts.assetsDir);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw storyError('path', 'Assets must be inside the course folder', 'Choose an assets folder next to the course');
  const reportFile = path.join(opts.courseDir, `${stem(file)}.import-report.json`);
  if (fs.existsSync(reportFile) || (fs.existsSync(opts.assetsDir) && fs.readdirSync(opts.assetsDir).length)) throw storyError('dupe', 'Import assets or report already exist', 'Choose another output name');
  const bytes = fs.readFileSync(source);
  const r = importStory(bytes, opts), summary = summarize(r.report);
  fs.mkdirSync(opts.courseDir, { recursive: true });
  atomic(file, bytes);
  fs.rmSync(histFile(file), { force: true });
  fs.writeFileSync(reportFile, JSON.stringify({ source: path.basename(source), summary, items: r.report.items }, null, 2) + '\n');
  return { ok: true, file, assets: opts.assetsDir, reportFile, summary };
}
