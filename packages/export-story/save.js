// A slide course stored in a Storyline 360 .story file. A save splices the original part text (only the
// attributes and elements that changed), copies every other ZIP entry as is (publisher/zip.js rezip) and proves itself
// by re-reading the new bytes: verify-after-write is the only refusal path for edits that have no writer yet, so nothing
// is dropped silently. Format facts: and.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readZip } from '../import-story/zip-read.js';
import { importStory, parseXml, textOf, storyId } from '../import-story/index.js';
import { elements, el, DECL, color } from './elements.js';
import { playerProperties, PLAYER_PART } from './player.js';
import { questionElements, questionNavigation } from './questions.js';
import { reconcileQuestion, reconcileQuestionMembership } from './question-save.js';
import { rezip } from '../publisher/zip.js';
import { xml } from '../publisher/ooxml.js';
import { normalize, serialize } from '../schema/index.js';
import { copyOrigins } from '../core/index.js';
import { diff } from '../cli/io.js';

const kid = (n, tag) => n?.kids.find((k) => k.tag === tag);
const kids = (n, tag) => (n ? n.kids.filter((k) => !tag || k.tag === tag) : []);
const ZERO = '00000000-0000-0000-0000-000000000000';
const CORE = /^package\/services\/metadata\/core-properties\/[^/]+\.psmdcp$/;
const LINES = new Set(['line', 'arrow', 'dblArrow', 'rightArrow', 'downArrow']);
const FILLS = ['solidFill', 'gradFill', 'blipFill', 'pattFill', 'picFill'];
const RUN = [['b', 'FontIsBold'], ['i', 'FontIsItalic'], ['u', 'FontIsUnderline'], ['s', 'FontIsStrikeout'], ['size', 'FontSize'], ['font', 'FontFamily'], ['color', 'ForegroundColor']];
const HEX = /^#[0-9a-f]{6}$/i;
const refuse = (p, code, message, hint) => Object.assign(new Error(message), { errors: [{ path: p, code, message, hint }] });
// Attribute values: raw line breaks and tabs would be normalised to spaces by an XML reader.
const attrText = (v) => xml(v).replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;').replace(/\t/g, '&#x9;');
const numText = (v) => String(v + 0);
const partOf = (t) => path.posix.normalize(t.startsWith('/') ? t.slice(1) : 'story/' + t); // story.xml.rels targets (as the importer)
const snapshot = (state) => kid(state, 'shapeLst')?.kids[0]; // a state is a full object copy

/** v4-shaped GUID whose first 12 hex digits are the id's, so the importer derives the same id again (FR-8). */
export function guidFor(id) {
  const h = /-([0-9a-f]{12})$/.exec(id)?.[1], r = crypto.randomUUID();
  return h ? `${h.slice(0, 8)}-${h.slice(8)}${r.slice(13)}` : r;
}

/** Read a .story: {buf, doc (normalized), nodes, zip, opts}. opts: importStory's assetsDir, courseDir, title. */
export function openStory(buf, opts = {}) {
  const r = importStory(buf, { ...opts, reuseAssets: true });
  return { buf, doc: normalize(r.doc), nodes: r.nodes, report: r.report, textScale: r.textScale, zip: readZip(buf), opts };
}

/** Compare key of two documents: the importer's normalisations only, one line each. */
export function canon(doc) {
  const d = JSON.parse(serialize(normalize(doc)));
  for (const a of d.assets ?? []) {
    a.mime ??= { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' }[path.extname(a.path).toLowerCase()];
    delete a.path; // media are extracted next to the file; their path is not stored in it
  }
  d.assets?.sort((a, b) => a.id.localeCompare(b.id)); // asset references are by id, independent of extraction order
  d.slides?.sort((a, b) => (a.id < b.id ? -1 : 1)); // the importer lists slides in scene order; scenes and banks hold the order
  for (const s of d.slides ?? []) for (const host of [s, ...(s.layers ?? [])]) {
    // Storyline stores each source's triggers on its own owner. Different event sources cannot fire in the same dispatch;
    // order within a source remains significant and is kept by the stable sort.
    host.triggers?.sort((a, b) => JSON.stringify(a.on).localeCompare(JSON.stringify(b.on)));
  }
  const BOOL = new Set(['b', 'i', 'u', 's']);
  const plain = (rich) => rich.every((p) => Object.keys(p).every((k) => k === 'runs') && p.runs.every((r) => Object.entries(r).every(([k, v]) => k === 'text' || (BOOL.has(k) && v === false))));
  return JSON.parse(JSON.stringify(d, (k, v) => {
    if (typeof v === 'number') return Math.round(v * 1000) / 1000 + 0; // floats are stored as text
    if (typeof v === 'string') {
      if (['fill', 'border', 'color', 'background'].includes(k) && HEX.test(v)) return v.toLowerCase(); // hexadecimal colours are case insensitive
      return v.replace(/^([a-z]+-[0-9a-f]{12})-\d+$/, '$1'); // suffixes of shared GUIDs follow document order
    }
    if (BOOL.has(k) && v === false) return undefined; // spans store "False"; unset reads the same
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v.locked) return { locked: true }; // master/layout copies are regenerated per slide and never written (FR-7)
      if (k === 'style' && v.border && v.borderWidth === 1) { const { borderWidth, ...rest } = v; return rest; } // player/editor default stroke is 1 px
      if (Array.isArray(v.rich) && plain(v.rich)) { const { rich, ...rest } = v; return rest; } // unformatted rich = text
      if (k === 'states') return Object.fromEntries(Object.entries(v).filter(([, o]) => Object.keys(o).length)); // a state without overrides
    }
    return v;
  }));
}

function firstDiff(a, b, p = '') {
  if (isDeepStrictEqual(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${p}/${k}`); if (d) return d; }
  }
  return { path: p || '/', got: a, want: b };
}

// ---------- splicer: edits {s, e, t, slot?} on a part's text (offsets from parseXml) ----------
function apply(text, list) {
  // At one offset: inserts first, then slot (whole-element) edits, then the outer edit; anything inside an applied edit is dropped.
  list = [...list].sort((a, b) => a.s - b.s || (a.e > a.s) - (b.e > b.s) || !!b.slot - !!a.slot || b.e - a.e);
  let out = '', pos = 0;
  for (const x of list) {
    if (x.s < pos) continue;
    out += text.slice(pos, x.s) + x.t;
    pos = x.e;
  }
  return out + text.slice(pos);
}
const mod = (p, n) => { let m = p.mod.get(n.s); if (!m) p.mod.set(n.s, m = { n }); return m; }; // keyed by offset: two parses of a part agree
function setAttrIn(tag, name, value) {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`), v = `"${attrText(value)}"`;
  return re.test(tag) ? tag.replace(re, (_, a) => a + v) : tag.replace(/\s*\/?>$/, (end) => ` ${name}=${v}${end}`);
}
const setAttr = (p, n, name, value) => { const m = mod(p, n); m.tag = setAttrIn(m.tag ?? p.text.slice(n.s, n.oe), name, value); };
const setInner = (p, n, inner) => { mod(p, n).inner = inner; };
const append = (p, n, x) => { const m = mod(p, n); m.add = (m.add ?? '') + x; };
const replace = (p, n, t) => p.edits.push({ s: n.s, e: n.e, t });
const cut = (p, n) => p.edits.push({ s: n.s, e: n.e, t: '', slot: true });
const setChild = (p, n, tag, inner) => { const c = kid(n, tag); if (c) setInner(p, c, inner); else append(p, n, `<${tag}>${inner}</${tag}>`); };
// Overlay fields represented by the writer while leaving unknown attributes and children in place.
function overlay(p, n, fresh, source) {
  for (const [key, value] of Object.entries(fresh.attrs)) if (key !== 'verG' && n.attrs[key] !== value) setAttr(p, n, key, value);
  for (const child of fresh.kids) {
    const old = kid(n, child.tag);
    if (!old) append(p, n, source.slice(child.s, child.e));
    else if (child.tag === 'condLst' || child.tag === 'elseTrigger') replace(p, old, source.slice(child.s, child.e));
    else overlay(p, old, child, source);
  }
}
function edits(p) {
  const out = [...p.edits];
  for (const { n, tag, inner, add } of p.mod.values()) {
    const open = tag ?? p.text.slice(n.s, n.oe);
    if (n.oe === n.e && (inner !== undefined || add)) out.push({ s: n.s, e: n.e, t: open.replace(/\s*\/>$/, '>') + (inner ?? '') + (add ?? '') + `</${n.tag}>` });
    else {
      if (tag !== undefined) out.push({ s: n.s, e: n.oe, t: tag });
      if (inner !== undefined) out.push({ s: n.oe, e: n.ce, t: inner });
      if (add) out.push({ s: n.ce, e: n.ce, t: add });
    }
  }
  return out;
}
/** An element's text with every edit inside it (not the edit that gives its slot to another element). */
function render(p, x) {
  if (typeof x === 'string') return x;
  const inside = edits(p).filter((d) => (d.e > d.s ? d.s >= x.s && d.e <= x.e && !(d.slot && d.s === x.s && d.e === x.e) : d.s > x.s && d.s < x.e));
  return apply(p.text.slice(x.s, x.e), inside.map((d) => ({ ...d, s: d.s - x.s, e: d.e - x.s })));
}
/**
 * Slot-preserving order of a parent's modelled children: `before` = their nodes now (document order), `after` = the
 * nodes (or new XML strings) wanted, in order. Nodes not wanted are cut; unmodelled siblings stay put; extra elements go
 * after the last slot. With `z`, an element landing in another slot takes that slot's zOrder: ascending in document order).
 */
function order(p, parent, before, after, z = false) {
  const keep = new Set(after);
  for (const n of before) if (!keep.has(n)) cut(p, n);
  const slots = before.filter((n) => keep.has(n));
  if (slots.length === after.length && slots.every((n, i) => n === after[i])) return;
  const zs = slots.map((n) => Number(n.attrs.zOrder));
  const top = Math.max(-1, ...kids(parent).map((k) => Number(k.attrs.zOrder)).filter(Number.isFinite));
  let extra = '';
  after.forEach((x, i) => {
    if (slots[i] === x) return;
    const zo = i < zs.length ? zs[i] : top + 1 + i - zs.length;
    if (z && typeof x !== 'string' && Number.isFinite(zo) && Number(x.attrs.zOrder) !== zo) setAttr(p, x, 'zOrder', zo);
    const t = render(p, x);
    if (i < slots.length) p.edits.push({ s: slots[i].s, e: slots[i].e, t, slot: true });
    else extra += t;
  });
  if (!extra) return;
  if (slots.length) p.edits.push({ s: slots.at(-1).e, e: slots.at(-1).e, t: extra });
  else append(p, parent, extra);
}

/* * The escaped-Document string for `paras`, carrying the original Block/Span <Style>s by position (the last one
 *  for extra paragraphs and runs) and setting the modelled attributes that changed against `old`. */
function richDoc(src, paras, old = [], textScale = 1) {
  let root = null;
  try { root = src?.startsWith('<') ? parseXml(src) : null; } catch { /* unreadable: written unformatted */ }
  const content = root?.tag === 'Document' ? kid(root, 'Content') : null, t = root ? src.replace(/^﻿/, '') : '';
  const blocks = kids(content, 'Block');
  const style = (n) => { const s = kid(n, 'Style'); return s ? t.slice(s.s, s.e) : ''; };
  const set = (st, attr, v) => { if (!st) return `<Style ${attr}="${attrText(v)}" />`; const end = st.indexOf('>') + 1; return setAttrIn(st.slice(0, end), attr, v) + st.slice(end); };
  const unset = (st, attr) => st.replace(new RegExp(`\\s${attr}=(?:"[^"]*"|'[^']*')`, 'g'), '');
  const body = paras.map((q, i) => {
    const b = blocks[Math.min(i, blocks.length - 1)], spans = kids(b, 'Span'), oq = old[i];
    let bs = style(b);
    if (q.align && q.align !== oq?.align) bs = set(bs, 'Justification', q.align[0].toUpperCase() + q.align.slice(1));
    else if (!q.align && oq?.align) bs = unset(bs, 'Justification');
    for (const [k, attr] of RUN) if (oq?.runs.some(r => r[k] !== undefined) && q.runs.every(r => r[k] === undefined)) bs = unset(bs, attr);
    return `<Block>${bs}${q.runs.map((r, j) => {
      let ss = style(spans[Math.min(j, spans.length - 1)]);
      const or = oq?.runs[Math.min(j, oq.runs.length - 1)] ?? {};
      for (const [k, attr] of RUN) {
        const v = r[k] ?? (k.length === 1 && or[k] ? false : undefined); // emphasis switched off is written as False
        if (v !== undefined && v !== or[k]) ss = set(ss, attr, typeof v === 'boolean' ? (v ? 'True' : 'False') : k === 'size' ? v / textScale : v);
        else if (v === undefined && or[k] !== undefined) ss = unset(ss, attr);
      }
      return `<Span Text="${attrText(r.text)}">${ss}</Span>`;
    }).join('')}</Block>`;
  }).join('');
  if (!content) return `<Document xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><Content>${body}</Content></Document>`;
  return content.oe === content.e ? t.slice(0, content.s) + `<Content>${body}</Content>` + t.slice(content.e) : t.slice(0, content.oe) + body + t.slice(content.ce);
}
const linesOf = (s) => (s ? s.split('\n').map((text) => ({ runs: [{ text }] })) : []);

/**
 * Save `doc1` (prev.doc after commands) into prev's package. Returns the re-read state of the new bytes. Throws
 * {errors:[{path, code, message, hint}]}: story-unsupported (the bytes would not read back as doc1), story-referenced,
 * story-inherited. Nothing is written here; the caller writes `buf`.
 */
export function saveStory(prev, doc1) {
  const d1 = normalize(doc1);
  for (const asset of prev.doc.assets) if (prev.nodes.get(asset.id)?.derived && !isDeepStrictEqual(asset, d1.assets.find(a => a.id === asset.id))) {
    throw refuse('/assets', 'story-unsupported', 'Generated previews of native shapes cannot be changed or removed from the media catalogue', 'Keep the preview asset unchanged, or convert a copy of the course to JSON');
  }
  // Extraction paths are omitted by canon; an explicit replacement must not be silently accepted.
  for (const [i, asset] of d1.assets.entries()) {
    const old = prev.doc.assets.find(a => a.id === asset.id);
    if (old && old.path !== asset.path) throw refuse(`/assets/${i}/path`, 'story-unsupported', 'Replacing an existing native asset path is not supported; nothing was saved', 'Add the replacement as a new asset, then update the object image reference');
  }
  const copies = copyOrigins.get(doc1);
  if (copies && [...copies.values()].some(c => prev.nodes.get(c.source)?.derived)) throw refuse('/slides', 'story-unsupported', 'Copying converted native shapes is not supported yet', 'Keep the original shape, or convert a copy of the course to JSON');
  if (copies?.size) for (let i = 0; i < copies.size; i++) {
    const next = seedCopies(prev, d1, copies);
    if (next === prev) break;
    prev = next;
  }
  const parts = new Map(), drop = new Set(), gone = [], put = new Map();
  const P = (name) => {
    let p = parts.get(name);
    if (!p) {
      const raw = (put.get(name) ?? prev.zip.read(name)).toString('utf8'), bom = raw.charCodeAt(0) === 0xfeff;
      parts.set(name, p = { name, bom, text: bom ? raw.slice(1) : raw, edits: [], mod: new Map(), tree: null });
    }
    return p;
  };
  const tree = (p) => (p.tree ??= parseXml(p.text, p.name));
  reconcile(prev, d1, { P, tree, drop, gone, put });
  if (gone.length) refScan(prev, { P, tree, parts, drop, gone });

  for (const p of parts.values()) {
    const text = apply(p.text, edits(p));
    if (text !== p.text) put.set(p.name, Buffer.from((p.bom ? '﻿' : '') + text, 'utf8'));
  }
  const buf = put.size || drop.size ? rezip(prev.buf, prev.zip, { put, drop }) : prev.buf;
  const next = buf === prev.buf ? prev : openStory(buf, prev.opts);
  const bad = firstDiff(canon(next.doc), canon(d1));
  if (bad) {
    const show = (v) => (v === undefined ? 'nothing' : JSON.stringify(v).slice(0, 80));
    throw refuse(bad.path, 'story-unsupported', `this change cannot be saved in a .story file yet: ${bad.path} would read back as ${show(bad.got)} instead of ${show(bad.want)}; nothing was saved`,
      'undo the change, or import the .story into a .course.json course (cf import) to use every feature');
  }
  return next;
}

// Clone native XML first, then use the ordinary reconciler for offsets, titles and other changes in the same batch.
// Unknown fields travel with the copy; GUIDs defined inside it are fresh, while external references stay external.
function seedCopies(prev, doc, copies) {
  const put = new Map(), parts = new Map(), seeded = new Set();
  const P = name => {
    if (!parts.has(name)) {
      const text = (put.get(name) ?? prev.zip.read(name)).toString('utf8').replace(/^\uFEFF/, '');
      parts.set(name, { name, text, edits: [], mod: new Map(), tree: parseXml(text, name) });
    }
    return parts.get(name);
  };
  const clone = (id, source, mapping) => {
    const entry = prev.nodes.get(source), p = P(entry.part), n = entry.node;
    const guids = new Map(), ids = new Map();
    for (const [old, fresh] of mapping) {
      const g = prev.nodes.get(old)?.node.attrs.g;
      if (g) { guids.set(g.toLowerCase(), guidFor(fresh)); ids.set(g.toLowerCase(), fresh); }
    }
    const walk = x => {
      for (const key of ['g', 'verG']) if (x.attrs[key] && !guids.has(x.attrs[key].toLowerCase())) guids.set(x.attrs[key].toLowerCase(), crypto.randomUUID());
      x.kids.forEach(walk);
    };
    walk(n);
    let text = p.text.slice(n.s, n.e).replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, g => guids.get(g.toLowerCase()) ?? g);
    const root = parseXml(text), cp = { text, edits: [], mod: new Map() };
    const nativeIds = new Map([...ids].map(([g, cfId]) => [guids.get(g), cfId]));
    const identify = x => {
      if (x.attrs.g && !x.attrs.verG) setAttr(cp, x, 'verG', crypto.randomUUID());
      if (nativeIds.has(x.attrs.g)) { setAttr(cp, x, 'cfId', nativeIds.get(x.attrs.g)); seeded.add(nativeIds.get(x.attrs.g)); }
      x.kids.forEach(identify);
    };
    identify(root);
    return apply(text, edits(cp));
  };
  const sr = P('story/_rels/story.xml.rels'), story = P('story/story.xml');
  for (const s of doc.slides) {
    const copy = copies.get(s.id);
    if (!copy || prev.nodes.has(s.id) || !prev.doc.slides.some(old => old.id === copy.source)) continue;
    const group = [...doc.scenes, ...doc.banks].find(g => g.slides.includes(s.id)), parent = prev.nodes.get(group?.id)?.node;
    if (!parent) throw refuse('/slides', 'story-unsupported', 'Create the destination scene before duplicating a native slide', 'Save the scene, then duplicate the slide');
    let i = 2, part;
    do { part = `story/slides/slide${(i++).toString(16)}.xml`; } while (prev.zip.has(part) || put.has(part));
    put.set(part, Buffer.from(DECL + clone(s.id, copy.source, copy.map)));
    const relId = 'R' + storyId(guidFor(s.id));
    append(story, kid(parent, 'sldIdLst'), el('sldId', {}, relId));
    append(sr, sr.tree, el('Relationship', { Type: 'slide', Id: relId, Target: '/' + part }));
    const cp = P('[Content_Types].xml'); append(cp, cp.tree, el('Override', { PartName: '/' + part, ContentType: 'application/slide+xml' }));
    const oldPart = prev.nodes.get(copy.source).part;
    const relPath = p => path.posix.join(path.posix.dirname(p), '_rels', path.posix.basename(p) + '.rels');
    if (prev.zip.has(relPath(oldPart))) put.set(relPath(part), prev.zip.read(relPath(oldPart)));
  }
  for (const s of doc.slides) for (const host of [s, ...s.layers]) for (const o of host.objects) {
    const copy = copies.get(o.id);
    if (!copy || seeded.has(o.id) || prev.nodes.has(o.id) || !prev.nodes.has(copy.source)) continue;
    const destination = prev.nodes.get(host.id);
    if (!destination) throw refuse('/slides', 'story-unsupported', 'Create the destination slide or layer before copying native objects', 'Save the destination, then copy the objects');
    const p = P(destination.part);
    const text = clone(o.id, copy.source, copy.map);
    append(p, kid(destination.node, 'shapeLst'), text);
    const relPath = part => path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels');
    const src = prev.nodes.get(copy.source).part, sourceRels = relPath(src), targetRels = relPath(destination.part);
    if (src !== destination.part && prev.zip.has(sourceRels)) {
      const media = new Set([...text.matchAll(/assetG="([0-9a-f-]+)"/gi)].map(m => storyId(m[1])));
      const links = kids(P(sourceRels).tree, 'Relationship').filter(n => n.attrs.Type === 'media' && [...media].some(id => n.attrs.Target.includes('R' + id + '.')));
      if (links.length) {
        if (!prev.zip.has(targetRels) && !put.has(targetRels)) put.set(targetRels, Buffer.from(DECL + el('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' })));
        const rp = P(targetRels), existing = new Set(kids(rp.tree).map(n => n.attrs.Target));
        for (const link of links) if (!existing.has(link.attrs.Target)) { append(rp, rp.tree, el('Relationship', { ...link.attrs, Id: 'R' + crypto.randomBytes(8).toString('hex') })); existing.add(link.attrs.Target); }
      }
    }
  }
  if (!seeded.size) return prev;
  for (const [name, p] of parts) { const text = apply(p.text, edits(p)); if (text !== p.text) put.set(name, Buffer.from(text)); }
  return openStory(rezip(prev.buf, prev.zip, { put }), prev.opts);
}

/** Walk scenes, slides, layers, objects and triggers by id and record the edits (tier 1, spec FR-5). */
function reconcile(prev, d1, w) {
  const d0 = prev.doc, nodes = prev.nodes, gone = w.gone, sr = 'story/_rels/story.xml.rels';
  if (d0.player.style !== d1.player.style) {
    const rp = w.P(sr), rel = kids(w.tree(rp), 'Relationship').find(r => r.attrs.Id === 'rId5');
    const name = rel?.attrs.Target ? partOf(rel.attrs.Target) : PLAYER_PART;
    if (prev.zip.has(name)) {
      const pp = w.P(name), root = w.tree(pp);
      if (root.tag !== 'player') throw refuse('/player/style', 'story-unsupported', 'Native player settings could not be read', 'Repair the player in Storyline first');
      setChild(pp, root, 'playerType', d1.player.style === 'modern' ? 'unified' : 'classic');
    } else {
      w.put.set(name, Buffer.from(playerProperties(d1.player.style, d1.title, d1.player.menu)));
    }
    if (!rel) append(rp, w.tree(rp), el('Relationship', { Type: 'playerProps', Target: '/' + name, Id: 'rId5' }));
    const ct = w.P('[Content_Types].xml');
    if (!kids(w.tree(ct), 'Override').some(n => n.attrs.PartName === '/' + name)) append(ct, w.tree(ct), el('Override', { PartName: '/' + name, ContentType: 'application/playerProps+xml' }));
  }

  // CF reset navigates; native reset needs a separate jump. Preserve untouched source behavior.
  const oldHosts = new Map(d0.slides.flatMap(s => [s, ...s.layers]).map(h => [h.id, h]));
  for (const host of d1.slides.flatMap(s => [s, ...s.layers])) for (const [i, t] of host.triggers.entries()) {
    const resets = [...t.do, ...(t.else ?? [])].filter(a => a.action === 'resetQuiz');
    for (const a of resets) {
      const first = d1.quizzes.find(q => q.id === a.quiz)?.questions[0];
      const oldFirst = d0.quizzes.find(q => q.id === a.quiz)?.questions[0];
      if (!first || first === oldFirst && isDeepStrictEqual(oldHosts.get(host.id)?.triggers, host.triggers)) continue;
      const next = host.triggers[i + 1];
      if (t.if || t.else?.length || t.do.length !== 1 || next?.if || next?.else?.length || next?.enabled === false || !isDeepStrictEqual(next?.on, t.on)
        || !isDeepStrictEqual(next?.do, [{ action: 'jump', to: first }])) {
        throw refuse('/triggers/' + t.id, 'story-unsupported', 'Native quiz reset requires an explicit following jump; nothing was saved', 'Add an unconditional jump trigger immediately after reset, with the same event and target, to the quiz first question');
      }
    }
  }
  const at = (id) => nodes.get(id);
  const renamed = new Map(); // variables have name identity in CF; a rename keeps its slot and native GUID
  if (d0.variables.length === d1.variables.length) d1.variables.forEach((v, i) => {
    const old = d0.variables[i];
    if (v.name !== old.name && v.type === old.type && !d0.variables.some(x => x.name === v.name) && !d1.variables.some(x => x.name === old.name)) renamed.set(v.name, old.name);
  });
  const unvar = (t) => t.replace(/%([^%\s]+)%/g, (m, n) => { const v = at('var:' + n); return !renamed.has(n) && v ? `%${v.node.attrs.name}%` : m; }); // CF names back to Storyline's
  const sp = () => w.P('story/story.xml');
  const gone_ = (n, id, what) => { if (n?.attrs.g) gone.push({ g: n.attrs.g, id, what }); };
  const ids = new Map();
  for (const [name, old] of renamed) ids.set('var:' + name, at('var:' + old).node.attrs.g);
  for (const q of d1.quizzes) if (q.results) ids.set('quiz-result:' + q.id, at(q.results)?.node.attrs.g ?? guidFor(q.results));
  const G = (id) => { if (!ids.has(id)) ids.set(id, at(id)?.node.attrs.g ?? guidFor(id)); return ids.get(id); };
  for (const q of d1.quizzes) if (q.results) ids.set(q.results, G('quiz-result:' + q.id));
  const T = elements(d1.size, G, crypto.randomUUID, prev.textScale);
  const Q = questionElements({ size: d1.size, resolve: G, T, doc: d1 });
  const membershipChanged = !isDeepStrictEqual(d0.quizzes.map(q => [q.id, q.questions]), d1.quizzes.map(q => [q.id, q.questions])) || !isDeepStrictEqual(d0.banks.map(b => [b.id, b.slides]), d1.banks.map(b => [b.id, b.slides]))
    || !isDeepStrictEqual(d0.slides.map(s => [s.id, s.draw]), d1.slides.map(s => [s.id, s.draw]));
  const addedSlides = new Map();
  const slideParts = new Map(d0.slides.map(s => [s.id, at(s.id).part]));
  const layoutG = d0.slides.length ? at(d0.slides[0].id)?.node.attrs.layoutG ?? ZERO : ZERO;
  for (const s of d1.slides.filter(s => !at(s.id))) {
    let i = 1, part;
    do { part = `story/slides/slide${(i++).toString(16)}.xml`; } while (prev.zip.has(part) || w.put.has(part));
    const relId = 'R' + storyId(G(s.id));
    addedSlides.set(s.id, el('sldId', {}, relId));
    slideParts.set(s.id, part);
    w.put.set(part, Buffer.from(DECL + T.slide(s, layoutG, Q.slideContents(s), s.draw ? Q.draw(s) : null)));
    const rp = w.P(sr);
    append(rp, w.tree(rp), el('Relationship', { Type: 'slide', Target: '/' + part, Id: relId }));
    const cp = w.P('[Content_Types].xml');
    append(cp, w.tree(cp), el('Override', { PartName: '/' + part, ContentType: 'application/slide+xml' }));
  }
  // / g9: image bytes, both catalogues, and relationships of their owning slides.
  const newMedia = new Map();
  const mediaExtensions = new Set(kids(w.tree(w.P('[Content_Types].xml')), 'Default').map(n => n.attrs.Extension));
  for (const asset of d1.assets.filter(a => !d0.assets.some(old => old.id === a.id))) {
    const root = prev.opts.courseDir;
    if (!root) throw refuse('/assets', 'story-assets', 'A course folder is required to add media', 'Open the native course through the shared file API');
    const file = path.resolve(root, asset.path), relative = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw refuse('/assets', 'path', 'The media file is outside the course folder', 'Copy it inside the course folder');
    const type = { '.png': ['Png', 'image/png'], '.jpg': ['Jpeg', 'image/jpeg'], '.jpeg': ['Jpeg', 'image/jpeg'], '.gif': ['Gif', 'image/gif'] }[path.extname(file).toLowerCase()];
    if (!type) throw refuse('/assets', 'story-unsupported', 'This media type cannot be written to .story yet', 'Use PNG, JPEG or GIF');
    const ext = type[0] === 'Jpeg' ? 'jpg' : type[0].toLowerCase(), data = fs.readFileSync(file), g = G(asset.id);
    const part = `story/media/R${storyId(g)}.${ext}`, stamp = new Date().toISOString();
    const checksum = crypto.createHash('md5').update(data).digest('hex');
    const media = el('media', { ...T.item(asset.id), cfAlt: asset.alt, type: type[0], displayName: path.basename(file), origFile: path.basename(file), source: '', useCnt: 1, bytes: data.length, modDT: stamp, addDT: stamp }, el('md5Checksum', {}, el('stream', {}, checksum), el('source', {}, checksum)));
    w.put.set(part, data); newMedia.set(asset.id, part);
    const sp1 = sp(), rootNode = w.tree(sp1), outer = kid(rootNode, 'mediaLst'), list = kid(outer, 'mediaLst') ?? outer;
    if (list) append(sp1, list, media); else append(sp1, rootNode, el('mediaLst', {}, el('mediaLst', {}, media)));
    const themeRel = kids(w.tree(w.P(sr)), 'Relationship').find(r => r.attrs.Id === 'rId6');
    if (themeRel) {
      const tp = w.P(partOf(themeRel.attrs.Target)), theme = w.tree(tp), assets = kid(theme, 'assetLst'), ml = kid(assets, 'mediaLst');
      if (ml) append(tp, ml, media); else if (assets) append(tp, assets, el('mediaLst', {}, media)); else append(tp, theme, el('assetLst', {}, el('mediaLst', {}, media)));
    }
    const cp = w.P('[Content_Types].xml');
    if (!mediaExtensions.has(ext)) { append(cp, w.tree(cp), el('Default', { Extension: ext, ContentType: type[1] })); mediaExtensions.add(ext); }
  }
  for (const a of d0.assets) {
    if (at(a.id)?.derived) continue; // Generated previews are not native media catalogue entries.
    const g = at(a.id)?.node.attrs.g;
    if (g) { const part = prev.zip.names.find(n => n.startsWith(`story/media/R${storyId(g)}.`)); if (part) newMedia.set(a.id, part); }
  }
  for (const a of d0.assets.filter(a => !d1.assets.some(next => next.id === a.id))) {
    const node = at(a.id)?.node, part = newMedia.get(a.id);
    if (!node || !part) continue;
    gone_(node, a.id, 'asset'); w.drop.add(part);
    for (const name of prev.zip.names.filter(n => /\.(xml|rels)$/.test(n))) {
      if (name === 'docProps/summary.xml') continue;
      const p = w.P(name);
      const walk = n => {
        for (const c of n.kids) {
          if ((c.tag === 'media' || c.tag === 'video') && c.attrs.g === node.attrs.g) cut(p, c);
          else if (c.tag === 'Relationship' && c.attrs.Type === 'media') {
            const sourceDir = path.posix.dirname(path.posix.dirname(name));
            const target = path.posix.normalize(c.attrs.Target.startsWith('/') ? c.attrs.Target.slice(1) : path.posix.join(sourceDir, c.attrs.Target));
            if (target === part) cut(p, c);
          } else walk(c);
        }
      };
      walk(w.tree(p));
    }
  }
  for (const s of d1.slides) {
    const assets = new Set([...s.objects, ...s.layers.flatMap(l => l.objects)].flatMap(o => [o.image, ...Object.values(o.states ?? {}).map(st => st.image)]).filter(id => newMedia.has(id)));
    const old = d0.slides.find(old => old.id === s.id);
    const previousAssets = new Set(old ? [...old.objects, ...old.layers.flatMap(l => l.objects)].flatMap(o => [o.image, ...Object.values(o.states ?? {}).map(st => st.image)]) : []);
    for (const id of previousAssets) assets.delete(id); // missing old relationships are preserved, not silently repaired
    if (!assets.size) continue;
    const part = slideParts.get(s.id), rp = path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels');
    const existing = prev.zip.has(rp) ? new Set(kids(w.tree(w.P(rp)), 'Relationship').map(r => path.posix.normalize(r.attrs.Target.startsWith('/') ? r.attrs.Target.slice(1) : path.posix.join(path.posix.dirname(part), r.attrs.Target)))) : new Set();
    for (const id of assets) if (existing.has(newMedia.get(id))) assets.delete(id);
    if (!assets.size) continue;
    if (!prev.zip.has(rp) && !w.put.has(rp)) w.put.set(rp, Buffer.from(DECL + el('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' })));
    const p = w.P(rp);
    for (const id of assets) append(p, w.tree(p), el('Relationship', { Id: 'R' + crypto.randomBytes(8).toString('hex'), Type: 'media', Target: '/' + newMedia.get(id) }));
  }
  const varPart = sp(), varList = kid(w.tree(varPart), 'varLst');
  for (const v of d1.variables) {
    const oldName = renamed.get(v.name) ?? v.name;
    const old = d0.variables.find(x => x.name === oldName), node = at('var:' + oldName)?.node;
    if (!old) append(varPart, varList, T.variable(v));
    else {
      if (old.initial !== v.initial) setAttr(varPart, node, 'val', v.initial);
      if (old.type !== v.type) setAttr(varPart, node, 'dataType', { number: 'num', boolean: 'bool', text: 'text' }[v.type]);
      if (old.name !== v.name) setAttr(varPart, node, 'name', v.name);
    }
  }
  for (const v of d0.variables) if (!d1.variables.some(x => x.name === v.name || renamed.get(x.name) === v.name)) {
    const node = at('var:' + v.name).node; cut(varPart, node); gone_(node, v.name, 'variable');
  }

  if (d1.title !== d0.title) { // course title: propLst prop 5 and core dc:title
    const p = sp(), story = w.tree(p), propLst = kid(story, 'propLst'), p5 = kids(propLst, 'prop').find((x) => x.attrs.id === '5');
    if (p5) setInner(p, p5, xml(d1.title));
    else if (propLst) append(p, propLst, `<prop id="5">${xml(d1.title)}</prop>`);
    else append(p, story, `<propLst><prop id="5">${xml(d1.title)}</prop></propLst>`);
    const core = prev.zip.names.find((n) => CORE.test(n)), cp = core && w.P(core);
    const title = cp && (function find(n) { return n.tag === 'dc:title' ? n : n.kids.map(find).find(Boolean); })(w.tree(cp));
    if (title) setInner(cp, title, xml(d1.title));
  }

  const slides1 = new Map(d1.slides.map((s) => [s.id, s]));
  for (const s0 of d0.slides) {
    const s1 = slides1.get(s0.id), { part, node: root } = at(s0.id);
    if (!s1) { removeSlide(s0, part, root); continue; }
    const p = w.P(part);
    if (s1.title !== s0.title) setAttr(p, root, 'name', s1.title);
    if (s1.duration !== s0.duration) setAttr(p, kid(root, 'tmProps'), 'min', s1.duration);
    if (s1.advance !== s0.advance) setAttr(p, root, 'advMode', s1.advance);
    if (s1.revisit !== s0.revisit) setAttr(p, root, 'resetMode', { auto: 'auto', reset: 'y', resume: 'n' }[s1.revisit]);
    if (s1.background !== s0.background) setChild(p, root, 'bg', color(s1.background) || '<noFill />');
    if (s1.draw && (membershipChanged || !isDeepStrictEqual(s0.draw, s1.draw))) {
      const fresh = Q.draw(s1);
      for (const [key, value] of Object.entries(fresh.attrs)) if (key !== 'sync' || !s0.draw) setAttr(p, root, key, value);
      if (root.tag !== 'bankSld') {
        const m = mod(p, root); m.tag = (m.tag ?? p.text.slice(root.s, root.oe)).replace(/^<sld\b/, '<bankSld');
        p.edits.push({ s: root.ce, e: root.e, t: '</bankSld>' });
      }
      const source = '<draw>' + fresh.tail + '</draw>', tree = parseXml(source), list = kid(root, 'questionLst');
      const wanted = kid(tree, 'questionLst').kids;
      if (!list) append(p, root, el('questionLst', {}, wanted.map(n => source.slice(n.s, n.e))));
      else {
        const old = kids(list, 'bankSld');
        const after = wanted.map(n => {
          const have = old.find(x => x.attrs.sldG === n.attrs.sldG);
          if (!have) return source.slice(n.s, n.e);
          for (const k of ['inc', 'exc']) if (have.attrs[k] !== n.attrs[k]) setAttr(p, have, k, n.attrs[k]);
          return have;
        });
        order(p, list, old, after);
      }
      setChild(p, root, 'excLst', kid(tree, 'excLst').kids.map(n => source.slice(n.s, n.e)).join(''));
    }
    if ((s1.notes ?? '') !== (s0.notes ?? '')) {
      const src = kid(root, 'note')?.text.trim();
      setChild(p, root, 'note', s1.notes ? xml(richDoc(src, linesOf(s1.notes), linesOf(s0.notes))) : '');
    }
    const extra = (!s0.question && s1.question || !d0.quizzes.some(q => q.results === s0.id) && d1.quizzes.some(q => q.results === s1.id)) ? Q.slideContents(s1) : {};
    if (!!s0.question !== !!s1.question) {
      const nav = kid(root, 'navData'), attrs = questionNavigation(!!s1.question);
      if (nav) for (const key of ['prev', 'prevGesture', 'next', 'nextGesture', 'submit']) setAttr(p, nav, key, attrs[key]);
      else append(p, root, el('navData', attrs));
    }
    slideContent(p, root, s0, s1, extra);
    reconcileQuestion(p, root, s0, s1, { kid, kids, setAttr, setInner, setChild, append, replace, cut, render, overlay, objectEdits, at, G, T, Q, gone: gone_ });
    if (membershipChanged && s0.question && s1.question && s0.question.type === s1.question.type) reconcileQuestionMembership(p, root, s1, Q, { kid, kids, setChild });
    if (extra.objects) {
      append(p, kid(root, 'shapeLst'), extra.objects);
      append(p, kid(root, 'trigLst'), extra.triggers);
    }
  }

  // Scenes (and the slide lists of banks): titles, sldIdLst membership and order, scene order, new and removed scenes.
  const p = sp();
  const rels =prev.zip.has(sr) ? new Map(kids(w.tree(w.P(sr)), 'Relationship').map((r) => [r.attrs.Id, partOf(r.attrs.Target ?? '')])) : new Map();
  const slideOfPart = new Map(d0.slides.map((s) => [at(s.id).part, s.id]));
  const sldId = new Map(addedSlides), groups0 = [...d0.scenes, ...d0.banks];
  for (const g of groups0) for (const n of kids(kid(at(g.id).node, 'sldIdLst'), 'sldId')) { const id = slideOfPart.get(rels.get(n.text.trim())); if (id) sldId.set(id, n); }
  const g0 = new Map(groups0.map((g) => [g.id, g]));
  const fresh = new Map();
  for (const g of [...d1.scenes, ...d1.banks]) {
    const want = g.slides.map((id) => sldId.get(id)).filter(Boolean);
    const old = g0.get(g.id);
    if (!old) { fresh.set(g.id, want); continue; }
    const node = at(g.id).node;
    if (g.title !== old.title) setAttr(p, node, 'name', g.title);
    const list = kid(node, 'sldIdLst');
    if (list) order(p, list, old.slides.map((id) => sldId.get(id)).filter(Boolean), want);
  }
  const keep = new Set(d1.scenes.map((s) => s.id));
  for (const s of d0.scenes) if (!keep.has(s.id)) gone.push({ g: at(s.id).node.attrs.g, id: s.id, what: 'scene' });
  const sceneLst = kid(w.tree(p), 'sceneLst');
  if (sceneLst) {
    // W scene: g verG primaryId sceneType collapse required; sldIdLst required.
    const make = (s) => el('scene', { ...T.item(s.id), name: s.title, desc: '', primaryId: ZERO, sceneType: 'scene', collapse: false }, el('sldIdLst', {}, fresh.get(s.id).map(n => render(p, n))));
    order(p, sceneLst, d0.scenes.map((s) => at(s.id).node), d1.scenes.map((s) => (g0.has(s.id) ? at(s.id).node : make(s))));
  }
  const qm = kid(w.tree(p), 'quizMgr');
  const trackingChanged = !isDeepStrictEqual(d0.tracking, d1.tracking);
  const newManager = !qm && (d1.quizzes.length || d1.banks.length || trackingChanged);
  if (trackingChanged || newManager) {
    // native Results includes every quiz with an enabled SubmitQuizSL, regardless of the legacy selected link.
    const submitted = new Set(d1.slides.flatMap(s => [s, ...s.layers]).flatMap(host => host.triggers)
      .filter(t => t.enabled !== false).flatMap(t => [...t.do, ...(t.else ?? [])]).filter(a => a.action === 'submitQuiz').map(a => a.quiz));
    const tracked = new Set(d1.tracking.complete.filter(c => c.quiz).map(c => c.quiz));
    if (submitted.size !== tracked.size || [...submitted].some(id => !tracked.has(id))) throw refuse('/tracking/complete', 'story-unsupported', 'Native tracking must include every quiz with an enabled submit trigger; nothing was saved', 'Include all submitted quizzes, or disable the corresponding submit trigger');
    // Update only direct state/lms reporting; Reach and other publish settings are unrelated and must survive.
    const status = { 'passed-incomplete': 'PassedIncomplete', 'passed-failed': 'PassedFailed', 'completed-incomplete': 'CompletedIncomplete', 'completed-failed': 'CompletedFailed' }[d1.tracking.status];
    const props = kid(w.tree(p), 'propLst'), prop = kids(props, 'prop').find(n => n.attrs.id === '3');
    const source = prop?.text?.trim() || '<state/>', nested = { text: source, mod: new Map(), edits: [] };
    let state;
    try { state = parseXml(source); } catch { /* refuse below instead of replacing unreadable settings */ }
    if (state?.tag !== 'state') throw refuse('/tracking/status', 'story-unsupported', 'Native publish settings could not be read; nothing was saved', 'Repair the publish settings in Storyline first');
    const lms = kid(state, 'lms');
    if (lms) setAttr(nested, lms, 'reporting', status);
    else append(nested, state, el('lms', { type: 'Scorm1_2', edition: 'Edition2', reporting: status }, el('course'), el('lesson'), el('ReportToLms', {}, 'true')));
    const value = xml(render(nested, state));
    if (prop) setInner(p, prop, value);
    else if (props) append(p, props, el('prop', { id: 3 }, value));
    else append(p, w.tree(p), el('propLst', {}, el('prop', { id: 3 }, value)));
  }
  if (newManager) {
    append(p, w.tree(p), Q.quizManager());
    append(p, kid(w.tree(p), 'varLst'), Q.variables());
  } else if (qm) {
    if (trackingChanged || !isDeepStrictEqual(d0.quizzes.map(q => [q.id, q.results]), d1.quizzes.map(q => [q.id, q.results])) && d1.tracking.complete.some(c => c.quiz)) {
      for (const [key, value] of Object.entries(Q.tracking())) if (qm.attrs[key] !== String(value)) setAttr(p, qm, key, value);
    }
    const banks = kid(qm, 'bankLst');
    if (banks) order(p, banks, d0.banks.map(b => at(b.id).node), d1.banks.map(b => at(b.id)?.node ?? Q.bank(b)));
    else if (d1.banks.length) append(p, qm, el('bankLst', {}, d1.banks.map(Q.bank)));
    if (!isDeepStrictEqual(d0.slides.map(s => [s.id, s.draw?.bank]), d1.slides.map(s => [s.id, s.draw?.bank]))) for (const b of d1.banks.filter(b => at(b.id))) {
      const draw = d1.slides.find(s => s.draw?.bank === b.id), node = at(b.id).node;
      if (node.attrs.drawG !== (draw ? G(draw.id) : ZERO)) setAttr(p, node, 'drawG', draw ? G(draw.id) : ZERO);
    }
    const freshQuizzes = d1.quizzes.filter(q => !d0.quizzes.some(old => old.id === q.id));
    const list = kid(qm, 'quizLst');
    if (list) for (const q of freshQuizzes) append(p, list, Q.quiz(q));
    else if (freshQuizzes.length) append(p, qm, el('quizLst', {}, freshQuizzes.map(Q.quiz)));
    if (freshQuizzes.length) append(p, kid(w.tree(p), 'varLst'), Q.variables(freshQuizzes.map(q => q.id)));
    for (const q of d1.quizzes) {
      const old = d0.quizzes.find(old => old.id === q.id), node = at(q.id)?.node;
      if (old && node && !isDeepStrictEqual(old, q)) { const fresh = Q.quiz(q); overlay(p, node, parseXml(fresh), fresh); setChild(p, node, 'questionIdLst', q.questions.map(id => el('id', {}, G(id))).join('')); }
    }
    for (const q of d0.quizzes.filter(old => !d1.quizzes.some(q => q.id === old.id))) { const node = at(q.id).node; cut(p, node); gone_(node, q.id, 'quiz'); }
    for (const b of d0.banks.filter(old => !d1.banks.some(b => b.id === old.id))) gone_(at(b.id).node, b.id, 'bank');
  }
  if (gone.length) tocCut();

  function removeSlide(s0, part, root) {
    w.drop.add(part);
    const relsPart = path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels');
    if (prev.zip.has(relsPart)) w.drop.add(relsPart);
    if (prev.zip.has(sr)) { const rp = w.P(sr); for (const r of kids(w.tree(rp), 'Relationship')) if (partOf(r.attrs.Target ?? '') === part) cut(rp, r); }
    if (prev.zip.has('[Content_Types].xml')) { const ct = w.P('[Content_Types].xml'); for (const o of kids(w.tree(ct), 'Override')) if (o.attrs.PartName === '/' + part) cut(ct, o); }
    gone_(root, s0.id, 'slide');
  }

  /* * Menu entries (story.xml toc, of removed slides and scenes, when everything nested in them is removed too. */
  function tocCut() {
    const toc = kid(w.tree(p), 'toc'), g = new Set(gone.map((x) => x.g.toLowerCase()));
    const refs = (n) => [n.attrs.refG, ...n.kids.flatMap(refs)].filter(Boolean).map((x) => x.toLowerCase());
    (function walk(n) { for (const k of kids(n)) if (k.attrs.refG && refs(k).every((x) => g.has(x))) cut(p, k); else walk(k); })(toc);
  }

  /** Objects (properties, order, removal), triggers (order, removal) and layers (order, removal) of one slide. */
  function slideContent(p, root, s0, s1, extra = {}) {
    const objs0 = [...s0.objects, ...s0.layers.flatMap((l) => l.objects)];
    const objs1 = new Map([...s1.objects, ...s1.layers.flatMap((l) => l.objects)].map((o) => [o.id, o]));
    const path1 = (id) => `/slides/${d1.slides.indexOf(s1)}/${s1.objects.some((o) => o.id === id) ? 'objects' : 'layers'}`;
    for (const o0 of objs0) {
      const o1 = objs1.get(o0.id);
      if (at(o0.id)?.derived) {
        if (!o1 || diff(o0, o1).length) throw refuse(path1(o0.id), 'story-unsupported', 'Converted native shapes are display-only; nothing was saved', 'Keep the object unchanged, or convert a copy of the course to JSON');
        continue;
      }
      if (o0.locked) {
        if (!o1 || diff(o0, o1).length) throw refuse(path1(o0.id), 'story-inherited', `object "${o0.id}" belongs to the slide master or layout, which is not edited here`, 'change it on the master or layout in Storyline, or leave it as it is');
        continue;
      }
      if (o1) objectEdits(p, at(o0.id).node, o0, o1, path1(o0.id)); else gone_(at(o0.id).node, o0.id, 'object');
    }
    // Triggers: per XML trigger list (slide, layer or object), in the new relative order; removed ones are cut.
    const trig1 = [...s1.triggers, ...s1.layers.flatMap((l) => l.triggers)].map((t) => t.id);
    const beforeTriggers = [...s0.triggers, ...s0.layers.flatMap(l => l.triggers)];
    for (const t of [...s1.triggers, ...s1.layers.flatMap(l => l.triggers)]) {
      const old = beforeTriggers.find(x => x.id === t.id), node = at(t.id)?.node;
      if (old && node && !isDeepStrictEqual(old, t)) {
        const fresh = T.trigger(t); overlay(p, node, parseXml(fresh), fresh);
        if (!t.else?.length) { const alt = kid(kid(node, 'data'), 'elseTrigger'); if (alt) cut(p, alt); }
      }
    }
    const lists = new Map(), desired = new Map();
    for (const t of [...s0.triggers, ...s0.layers.flatMap((l) => l.triggers)]) {
      const n = at(t.id).node;
      if (!lists.has(n.parent)) lists.set(n.parent, []);
      lists.get(n.parent).push(t.id);
    }
    for (const [host, ts] of [[root, s1.triggers], ...s1.layers.filter(l => at(l.id)).map(l => [at(l.id).node, l.triggers])]) {
      for (const t of ts) {
        const owner = t.on.target ? at(t.on.target)?.node : host;
        if (owner) {
          const list = kid(owner, 'trigLst');
          if (list) { if (!desired.has(list)) desired.set(list, []); desired.get(list).push(at(t.id)?.node ?? T.trigger(t)); }
          else append(p, owner, el('trigLst', {}, T.trigger(t)));
        }
      }
    }
    for (const list of new Set([...lists.keys(), ...desired.keys()])) {
      const ids = lists.get(list) ?? [];
      for (const id of ids) if (!trig1.includes(id)) gone_(at(id).node, id, 'trigger');
      const wanted = desired.get(list) ?? [];
      // Import normalizes quiz dispatch order; an unchanged author order must retain the source byte order.
      if (ids.length === wanted.length && ids.every((id, i) => at(id).node === wanted[i])) wanted.sort((a, b) => a.s - b.s);
      order(p, list, ids.map(id => at(id).node).sort((a, b) => a.s - b.s), wanted);
    }
    // Objects: base list and each layer's list (an object may move between them, object.move).
    const mine = (o) => !o.locked && objs0.some((x) => x.id === o.id);
    const lists0 = [[root, s0.objects], ...s0.layers.map((l) => [at(l.id).node, l.objects])];
    const lists1 = new Map([[root, s1.objects], ...s1.layers.filter((l) => at(l.id)).map((l) => [at(l.id).node, l.objects])]);
    for (const [host, objs] of lists0) {
      const want = lists1.get(host);
      if (!want) continue; // a removed layer goes with its objects
      const lst = kid(host, 'shapeLst');
      const all = host === root ? s1.triggers : s1.layers.find(l => at(l.id)?.node === host)?.triggers ?? [];
      if (lst) order(p, lst, objs.filter(mine).map((o) => at(o.id).node), want.filter(o => !o.locked).map((o, i) => at(o.id)?.node ?? T.object(o, i, all)), true);
    }
    // Layers.
    const l1 = new Set(s1.layers.map((l) => l.id));
    for (const l of s0.layers) if (!l1.has(l.id)) { gone_(at(l.id).node, l.id, 'layer'); for (const o of l.objects) if (!objs1.has(o.id)) gone_(at(o.id).node, o.id, 'object'); }
    const ll = kid(root, 'sldLayerLst');
    const layerXml = [...s1.layers.map(l => at(l.id)?.node ?? T.layer(l)), ...(extra.layers ? [extra.layers] : [])];
    if (ll) order(p, ll, s0.layers.map((l) => at(l.id).node), layerXml);
    else if (layerXml.length) append(p, root, el('sldLayerLst', { nextIdx: s1.layers.length + (extra.layers ? 4 : 1) }, layerXml));
    if (ll && (s1.layers.length !== s0.layers.length || extra.layers)) setAttr(p, ll, 'nextIdx', Math.max(Number(ll.attrs.nextIdx) || 1, s1.layers.length + (extra.layers ? 4 : 1)));
    for (const l of s1.layers.filter(l => at(l.id))) {
      const n = at(l.id).node, old = s0.layers.find(x => x.id === l.id);
      for (const [key, name] of [['title', 'name'], ['modal', 'modal'], ['pauseBase', 'pause'], ['hideOthers', 'stop'], ['hideOnEnd', 'hideEnd']]) if (l[key] !== old[key]) setAttr(p, n, name, l[key]);
      if (l.duration !== old.duration) setAttr(p, kid(n, 'tmProps'), 'min', l.duration);
      if (l.revisit !== old.revisit) {
        const mode = { auto: 'auto', reset: 'y', resume: 'n' }[l.revisit];
        setAttr(p, n, 'resetMode', mode);
        if (n.attrs.resetModeInheritable !== undefined) setAttr(p, n, 'resetModeInheritable', mode);
      }
    }
  }

  /* * Tier-1 object properties; state snapshots that do not override a property follow it. */
  function objectEdits(p, n, o0, o1, objectPath) {
    const ch = new Set(diff(o0, o1).map(([k]) => k[0]));
    if (!ch.size) return;
    if (o0.style?.textFit && (o0.w !== o1.w || o0.h !== o1.h)) throw refuse(objectPath, 'story-unsupported', 'Resizing native fitted text is not supported yet; nothing was saved', 'Keep its size, edit the text, or convert a copy to JSON');
    const sc = new Set(diff(o0.style ?? {}, o1.style ?? {}).map(([k]) => k[0]));
    const states = kids(kid(n, 'stateLst')).filter(s => s.attrs.name), snaps = states.map(snapshot).filter(Boolean);
    const normal = snapshot(states.find((s) => s.attrs.name === 'Normal'));
    if (sc.has('radius')) {
      const r = o1.style?.radius, node = kid(n, 'rndC');
      if (r === undefined) { if (node) cut(p, node); }
      else {
        const attrs = { rTL: r, rTR: r, rBL: r, rBR: r, DefAll: r, usePc: false };
        if (node) for (const [key, value] of Object.entries(attrs)) setAttr(p, node, key, value);
        else append(p, n, el('rndC', attrs));
      }
    }
    if (['fontSize', 'fontFamily', 'color', 'bold', 'italic'].some(k => sc.has(k)) || !o0.text && o1.text) {
      const baseline = { fontSize: 24, fontFamily: 'Segoe UI', color: o1.type === 'button' ? '#ffffff' : '#1c1f24', bold: false, italic: false };
      const value = key => o1.style?.[key] ?? baseline[key];
      const fontAttrs = { sz: value('fontSize') / prev.textScale, name: value('fontFamily'), style: [value('bold') && 'Bold', value('italic') && 'Italic'].filter(Boolean).join(', ') || 'Regular' };
      const bg = kid(n, 'bG'), font = kid(bg, 'defaultFont');
      const clr = el('srgbClr', { val: value('color').slice(1) });
      if (font) { for (const [key, val] of Object.entries(fontAttrs)) setAttr(p, font, key, val); setChild(p, font, 'clr', clr); }
      else if (bg) append(p, bg, el('defaultFont', fontAttrs, el('clr', {}, clr)));
      else append(p, n, el('bG', {}, el('defaultFont', fontAttrs, el('clr', {}, clr))));
      setAttr(p, n, 'cfTextDefaults', Object.keys(baseline).filter(k => o1.style?.[k] === undefined).join(','));
      const baseFont = font ?? kid(kid(normal, 'bG'), 'defaultFont');
      const hasFlag = (f, flag) => (f?.attrs.style ?? '').split(/,\s*/).includes(flag);
      const rawColor = f => { const c = kid(f, 'clr'); return c && p.text.slice(c.s, c.e); };
      for (const sn of snaps) {
        const sf = kid(kid(sn, 'bG'), 'defaultFont');
        if (!sf || !baseFont) continue;
        const inherited = Object.keys(baseline).filter(k => sc.has(k) && (k === 'color' ? rawColor(sf) === rawColor(baseFont)
          : k === 'fontSize' ? Number(sf.attrs.sz) === Number(baseFont.attrs.sz)
            : k === 'fontFamily' ? sf.attrs.name === baseFont.attrs.name
              : hasFlag(sf, k === 'bold' ? 'Bold' : 'Italic') === hasFlag(baseFont, k === 'bold' ? 'Bold' : 'Italic')));
        if (inherited.includes('fontSize')) setAttr(p, sf, 'sz', fontAttrs.sz);
        if (inherited.includes('fontFamily')) setAttr(p, sf, 'name', fontAttrs.name);
        if (inherited.includes('color')) setChild(p, sf, 'clr', clr);
        if (inherited.some(k => k === 'bold' || k === 'italic')) {
          const flags = new Set((sf.attrs.style ?? '').split(/,\s*/).filter(s => s && s !== 'Regular'));
          for (const [key, flag] of [['bold', 'Bold'], ['italic', 'Italic']]) if (inherited.includes(key)) { if (value(key)) flags.add(flag); else flags.delete(flag); }
          setAttr(p, sf, 'style', [...flags].join(', ') || 'Regular');
        }
        if (inherited.length) {
          const defaults = new Set((sn.attrs.cfTextDefaults ?? '').split(',').filter(Boolean));
          for (const key of inherited) { if (o1.style?.[key] === undefined) defaults.add(key); else defaults.delete(key); }
          setAttr(p, sn, 'cfTextDefaults', [...defaults].join(','));
        }
      }
    }
    const box = (x) => ['l', 't', 'r', 'b'].map((k) => Number(kid(x, 'loc')?.attrs[k]) || 0);
    const setLoc = (loc, v) => { for (const k of Object.keys(v)) if (Number(loc.attrs[k]) !== v[k]) setAttr(p, loc, k, numText(v[k])); };

    if (['line', 'arrow'].includes(n.tag) && ['x', 'y', 'w', 'h', 'rotation'].some(k => ch.has(k))) {
      setLoc(kid(n, 'loc'), { l: o1.x, t: o1.y + o1.h / 2, r: o1.x + o1.w, b: o1.y + o1.h / 2 });
      setAttr(p, n, 'rot', o1.rotation || -1);
    }

    if (['x', 'y', 'w', 'h'].some((k) => ch.has(k)) && !LINES.has(n.tag) && kid(n, 'loc')) { // loc l t r b
      const [l, t, r, b] = box(n), fx = r < l, fy = b < t;
      const L = { l: fx ? o1.x + o1.w : o1.x, t: fy ? o1.y + o1.h : o1.y, r: fx ? o1.x : o1.x + o1.w, b: fy ? o1.y : o1.y + o1.h };
      setLoc(kid(n, 'loc'), L);
      for (const sn of snaps) { // snapshots use 0-based local coordinates; an absolute copy follows the box
        const v = box(sn);
        if (isDeepStrictEqual(v, [0, 0, o0.w, o0.h])) setLoc(kid(sn, 'loc'), { r: o1.w, b: o1.h });
        else if (isDeepStrictEqual(v, [l, t, r, b])) setLoc(kid(sn, 'loc'), L);
      }
    }
    if (ch.has('rotation') && !LINES.has(n.tag)) { // rot -1 = no rotation
      const v = o1.rotation ? numText(o1.rotation) : '-1', old = n.attrs.rot;
      for (const x of [n, ...snaps.filter((s) => s.attrs.rot === old)]) setAttr(p, x, 'rot', v);
    }
    if (ch.has('name')) setAttr(p, n, 'name', o1.name ?? '');
    if (ch.has('image')) setAttr(p, n, 'assetG', G(o1.image));
    if (ch.has('states')) {
      const list = kid(n, 'stateLst');
      const merged = (o, overrides) => ({ ...o, ...overrides, style: { ...o.style, ...overrides?.style }, states: {}, ...(overrides?.text !== undefined ? { rich: undefined } : {}) });
      for (const [name, value] of Object.entries(o1.states)) {
        const old = states.find(st => st.attrs.name.toLowerCase() === name), sn = snapshot(old);
        if (!old) { if (list) append(p, list, T.state(o1, name, value)); else append(p, n, el('stateLst', {}, T.state(o1, name, value))); }
        else if (sn && !isDeepStrictEqual(value, o0.states[name])) objectEdits(p, sn, merged(o0, o0.states[name]), merged(o1, value), objectPath);
      }
      for (const name of Object.keys(o0.states)) if (!Object.hasOwn(o1.states, name)) { const old = states.find(st => st.attrs.name.toLowerCase() === name); if (old) cut(p, old); }
    }
    if (ch.has('start') || ch.has('end')) {
      const tc = kid(n, 'tmCtxLst')?.kids[0];
      if (tc) {
        setAttr(p, tc, 'start', o1.start);
        setAttr(p, tc, 'untilEnd', o1.end === null);
        if (o1.end !== null) setAttr(p, tc, 'dur', o1.end - o1.start);
      }
    }
    if (ch.has('enter') || ch.has('exit')) setChild(p, n, 'animEffect', T.animation(o1));
    if ((ch.has('alt') || ch.has('name')) && (o1.alt ?? '') !== (kid(n, 'alt')?.text.trim() ?? '')) setChild(p, n, 'alt', xml(o1.alt ?? ''));
    if ((ch.has('text') || ch.has('rich')) && ['text', 'shape', 'button'].includes(o1.type)) {
      const has = (x) => !!(kid(x, 'plain')?.text.trim() || kid(x, 'text')?.text.trim());
      const src = has(n) ? n : normal && has(normal) ? normal : n, was = textOf(src);
      // Without rich the edit replaced the formatting (object.set text): written unformatted.
      const paras = (o1.rich ?? linesOf(o1.text ?? '')).map((q) => ({ ...q, runs: q.runs.map((r) => ({ ...r, text: unvar(r.text) })) }));
      const plain = paras.map((q) => q.runs.map((r) => r.text).join('')).join('\n');
      for (const x of [src, ...snaps.filter((s) => s !== src && has(s) && textOf(s) === was)]) {
        const t = kid(x, 'text')?.text.trim() ?? '';
        setChild(p, x, 'text', xml(t && !t.startsWith('<') ? plain : richDoc(o1.rich ? t : '', paras, o1.rich ? o0.rich : [], prev.textScale)));
        setChild(p, x, 'plain', xml(plain));
      }
    }
    if (sc.has('fill') && (!o1.style?.fill || HEX.test(o1.style.fill))) {
      const fill = (x) => kid(x, 'bG')?.kids.find((k) => FILLS.includes(k.tag));
      const src = fill(n) ? n : normal && fill(normal) ? normal : n, f0 = fill(src), was = f0 && p.text.slice(f0.s, f0.e);
      const c = o1.style?.fill ?? (o1.type === 'button' ? '#34449c' : null);
      const v = c ? `<solidFill><clr><srgbClr val="${c.slice(1).toUpperCase()}" /></clr></solidFill>` : '<noFill />';
      if (o1.type === 'button') setAttr(p, n, 'cfDefaultButtonFill', !o1.style?.fill);
      for (const x of [src, ...snaps.filter((s) => s !== src && was && fill(s) && p.text.slice(fill(s).s, fill(s).e) === was)]) {
        if (o1.type === 'button' && x !== n) setAttr(p, x, 'cfDefaultButtonFill', !o1.style?.fill);
        const bG = kid(x, 'bG'), f = bG?.kids.find((k) => k.tag === 'noFill' || FILLS.includes(k.tag));
        if (f) replace(p, f, v); else if (bG) append(p, bG, v); else append(p, x, `<bG>${v}</bG>`);
      }
    }
    if (sc.has('border')) { // bG/solidLine/clr (state snapshots keep theirs: the importer reads them as overrides)
      const bG = kid(n, 'bG'), line = kid(bG, 'solidLine'), c = o1.style?.border;
      const clr = HEX.test(c ?? '') && `<clr><srgbClr val="${c.slice(1).toUpperCase()}" /></clr>`;
      if (!c) { if (line) replace(p, line, ''); }
      else if (clr && line) { const k = kid(line, 'clr'); if (k) replace(p, k, clr); else append(p, line, clr); }
      else if (clr && bG) append(p, bG, `<solidLine>${clr}</solidLine>`);
    }
    const ls = kid(kid(n, 'bG'), 'lineStyle');
    if (sc.has('border') || sc.has('borderWidth')) {
      const bg = kid(n, 'bG'), width = o1.style?.borderWidth;
      if (ls) {
        // Removing an override must not revive the previous width when a new border is set.
        if (width !== undefined) setAttr(p, ls, 'w', numText(width));
        else if (o1.style?.border) setAttr(p, ls, 'w', 1);
      } else if (width !== undefined && bg) append(p, bg, el('lineStyle', { w: width, cap: 'flat', join: 'mtr', dash: 'sld', cmpnd: 'sng', scale: 1 }, el('arrow', { scale: 1 }, el('begin', { type: 'none', sz: 'size5' }), el('end', { type: 'none', sz: 'size5' }))));
    }
  }
}

/** FR-6: a removed element's GUID still used elsewhere (outside its own copies and copiedG stamps) refuses the save. */
function refScan(prev, w) {
  const g = w.gone.map((x) => ({ ...x, g: x.g.toLowerCase() }));
  for (const name of prev.zip.names) {
    if (w.drop.has(name) || name === 'docProps/summary.xml' || !/\.(xml|rels)$/i.test(name)) continue; // summary: a save-time cache
    const p = w.parts.get(name);
    const t = (p ? apply(p.text, edits(p)) : prev.zip.read(name).toString('utf8')).toLowerCase();
    for (const x of g) {
      for (let i = t.indexOf(x.g); i >= 0; i = t.indexOf(x.g, i + 1)) {
        const before = t.slice(Math.max(0, i - 9), i);
        if (before.endsWith(' g="') || before === 'copiedg="') continue; // another element with the same GUID, or a copy stamp
        throw refuse(`/${x.what}s/${x.id}`, 'story-referenced', `${x.what} "${x.id}" is still referenced in ${name}, so it cannot be removed from the .story file`, 'remove what points to it first (a trigger, a quiz, a group or the player menu), then retry');
      }
    }
  }
}
