// Storyline 360 `.story` -> cf.course/1 importer (read-only, evidence-bounded)..
// Strings inside the package are data only. Anything without an evidenced encoding is reported as
// {path, kind, reason}; nothing is guessed silently.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readZip } from './zip-read.js';
import { emfToPng } from './emf.js';
import { importedPath, symbolPath, pathSvg } from './vector.js';
import { SCHEMA_VERSION, ID, VAR_NAME, questionSchema, validate } from '../schema/index.js';
import { saveCourse } from '../cli/io.js';
import { replaceRichVariables } from '../schema/rich.js';

// Native points to CSS pixels. scale only when both axes grow or shrink.
export function textPointScale({ w = 720, h = 540 } = {}, useNewFontScaling = false) {
  const x = w / 720, y = h / 540;
  return ((x > 1 && y > 1) || (x < 1 && y < 1) ? (useNewFontScaling ? y : Math.max(x, y)) : 1) * 4 / 3;
}

// ---------- XML (non-validating; no DTDs, so no entity expansion) ----------
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => (!s.includes('&') ? s : s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (m, e) => {
  if (e[0] !== '#') return ENT[e] ?? m;
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n <= 0x10ffff ? String.fromCodePoint(n) : m;
}));
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(!)|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parse XML text into {tag, attrs, kids, text, parent} nodes; returns the root element (with .part). Each element
 * records offsets in the BOM-stripped text: s start, oe end of start tag, ce start of close tag, e end
 *  (self-closing: oe = ce = e). */
const MAX_XML_DEPTH = 256; // real Storyline parts nest far less; deeper input is hostile (review 003 #3)
export function parseXml(text, part = '') {
  const doc = { tag: '#document', attrs: {}, kids: [], text: '', parent: null };
  const stack = [doc];
  const re = new RegExp(TOKEN);
  const where = (at) => `at offset ${at}${part ? ' in ' + part : ''}`;
  text = text.replace(/^\uFEFF/, '');
  while (re.lastIndex < text.length) {
    const at = re.lastIndex;
    const m = re.exec(text);
    if (!m) throw new Error(`xml: malformed markup ${where(at)}`);
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) throw new Error(`xml: DTDs and declarations are not supported ${where(at)}`);
    else if (m[3]) { if (stack.length < 2 || top.tag !== m[3]) throw new Error(`xml: unexpected </${m[3]}> ${where(at)}`); top.ce = at; top.e = re.lastIndex; stack.pop(); }
    else if (m[4]) {
      const attrs = Object.create(null);
      for (const a of m[5].matchAll(ATTR)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const node = { tag: m[4], attrs, kids: [], text: '', parent: top, s: at, oe: re.lastIndex, ce: re.lastIndex, e: re.lastIndex };
      top.kids.push(node);
      if (!m[6]) {
        if (stack.length > MAX_XML_DEPTH) throw new Error(`xml: elements nested deeper than ${MAX_XML_DEPTH} ${where(at)}`);
        stack.push(node);
      }
    } else if (m[7] !== undefined) {
      if (stack.length > 1) top.text += decode(m[7]);
      else if (m[7].trim()) throw new Error(`xml: text outside the root element ${where(at)}`);
    }
  }
  if (stack.length !== 1 || doc.kids.length !== 1) throw new Error(`xml: unclosed or missing root element${part ? ' in ' + part : ''}`);
  const root = doc.kids[0];
  root.parent = null; root.part = part;
  return root;
}

const kid = (n, tag) => n?.kids.find((k) => k.tag === tag);
const FLY_DIRS = new Set(['b', 'bl', 'l', 'tl', 't', 'tr', 'r', 'br']);
const kids = (n, tag) => (n ? (tag ? n.kids.filter((k) => k.tag === tag) : n.kids) : []);
function descendants(n, tag) {
  const out = [];
  const stack = n ? [...n.kids].reverse() : [];
  while (stack.length) { const x = stack.pop(); if (!tag || x.tag === tag) out.push(x); for (let i = x.kids.length - 1; i >= 0; i--) stack.push(x.kids[i]); }
  return out;
}
/** Stable report path: `<part>#/<tag>[n]/...` (index only where a tag repeats among siblings). */
function where(n) {
  const segs = [];
  let x = n;
  for (; x.parent; x = x.parent) {
    const sib = x.parent.kids.filter((k) => k.tag === x.tag);
    segs.unshift(sib.length > 1 ? `${x.tag}[${sib.indexOf(x) + 1}]` : x.tag);
  }
  return `${x.part}#/${[x.tag, ...segs].join('/')}`;
}

// ---------- Storyline helpers ----------
const ZERO = '00000000-0000-0000-0000-000000000000';
const isG = (g) => typeof g === 'string' && g !== ZERO && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(g);
const num = (s) => (s === undefined || String(s).trim() === '' || !Number.isFinite(Number(s)) ? undefined : Number(s));
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/* * 11-char part/media ID: base62 of the first 8 bytes of the GUID in .NET byte order, little-endian. */
export function storyId(g) {
  const h = g.toLowerCase();
  let n = BigInt('0x' + h.slice(14, 18) + h.slice(9, 13) + h.slice(0, 8));
  let s = '';
  while (n > 0n) { s = B62[Number(n % 62n)] + s; n /= 62n; }
  return s;
}

const MEDIA = { Png: ['png', 'image/png'], Jpeg: ['jpg', 'image/jpeg'], Gif: ['gif', 'image/gif'], Emf: ['png', 'image/png'], Mp4: ['mp4', 'video/mp4'], Vtt: ['vtt', 'text/vtt'] };
const IMAGE_TYPES = ['Png', 'Jpeg', 'Gif', 'Emf'];
const QTYPE = { multiChoiceIntr: 'mc', multiRespIntr: 'mr', trueFalseIntr: 'tf', textEntryIntr: 'fill', dragDropIntr: 'dragdrop', hotSpotIntr: 'hotspot', matchDropDownIntr: 'matching', matchDragDropIntr: 'matching', seqDropDownIntr: 'sequence', seqDragDropIntr: 'sequence' };
const SHAPES = { rect: 'rect', roundRect: 'rounded', oval: 'ellipse' };
// Connector lines carry their heads in bG/lineStyle/arrow/begin|end@type; block arrows
// are filled shapes drawn as stroked arrows; NEAR shapes are labelled approximations (ours).
const LINES = new Set(['line', 'arrow', 'dblArrow']);
const BLOCK_ARROWS = { rightArrow: 0, downArrow: 90 };
const NEAR = { foldedCorner: ['rect', 'the folded corner is not drawn'], roundSameSideCorner: ['rounded', 'all four corners are rounded, not one side'], polygon: ['ellipse', 'the polygon is drawn as the ellipse inside its box'] };
const NO_HEAD = new Set([undefined, 'none', 'def']);
const OWN_BG = ['solidFill', 'gradFill', 'picFill', 'blipFill', 'pattFill', 'noFill'];
const round2 = (v) => Math.round(v * 100) / 100 + 0; // + 0 turns -0 into 0
const BUTTONS = new Set(['btn', 'feedBackBtn', 'rsltBtn']);
const TEXTS = new Set(['textBox', 'feedbackTextBox']);
const STATES = { Normal: 'normal', Hover: 'hover', Down: 'down', Selected: 'selected', Visited: 'visited', Disabled: 'disabled', Hidden: 'hidden' };
const TRIGGERS = new Set(['trig', 'submitQuizTrig', 'resetQuizTrig', 'gotoFirstInQuizTrig', 'reviewQuizTrig']);
const OPS = { eq: '==', gte: '>=', lt: '<' }; // the operators observed
const FEEDBACK_DEFAULT = questionSchema.properties.feedback.default;
const CONSUMED = Symbol('consumed');
const fail = (kind, error) => ({ kind, error });
const VAR_RE = new RegExp(VAR_NAME);
const ID_RE = new RegExp(ID);

const clean = (s) => s.replace(/\r\n?/g, '\n').trim();
function docText(s) { // `<text>` holds an escaped <Document> or, on some buttons, a bare string
  const t = s.trim();
  if (!t.startsWith('<')) return t;
  let root;
  try { root = parseXml(t); } catch { return ''; }
  const lines = []; // one linear pass: each Block starts a line, Spans append to it (review 003 #3: no rescans)
  for (const x of descendants(root)) {
    if (x.tag === 'Block') lines.push('');
    else if (x.tag === 'Span' && lines.length) lines[lines.length - 1] += x.attrs.Text ?? '';
  }
  return lines.join('\n');
}
export function textOf(n) {
  const p = kid(n, 'plain')?.text;
  if (p && p.trim()) return clean(p);
  const t = kid(n, 'text')?.text;
  return t ? clean(docText(t)) : '';
}
function color(clr) { // Bare sRGB, also used for the deliberately narrow first-gradient-stop heuristic.
  const s = kid(clr, 'srgbClr');
  return clr && clr.kids.length === 1 && s && !s.kids.length && /^[0-9a-f]{6}$/i.test(s.attrs.val ?? '') ? '#' + s.attrs.val.toLowerCase() : null;
}
function fillIn(bG, resolve = color) {
  const sf = kid(bG, 'solidFill');
  if (sf) { const c = resolve(kid(sf, 'clr')); return c ? { fill: c } : { issue: 'fill color or modifier could not be resolved from the applicable master' }; }
  const gradient = kid(bG, 'gradFill');
  if (gradient && !kid(bG, 'noFill')) {
    const c = color(kid(kids(kid(gradient, 'stops'), 'stop')[0], 'clr'));
    if (c) return { fill: c, heuristic: true };
  }
  if (['gradFill', 'blipFill', 'pattFill', 'picFill'].some((t) => kid(bG, t))) return { issue: 'gradient, picture and pattern fills are not imported' };
  return {};
}
const snapshot = (state) => kid(state, 'shapeLst')?.kids[0]; // a state is a full object copy
const statesOf = n => kids(kid(n, 'stateLst')); // Specialized choice states share @name and shapeLst.
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Import a .story package. `src` is a Buffer or a file path. Media are written to `assetsDir` (if given) as
 * `<assetId>.<ext>`; `asset.path` is relative to `courseDir` (default: the parent of `assetsDir`). `reuseAssets`
 * reuses byte-identical media; changed bytes use a hash-suffixed path without overwriting existing files.
 * Returns {doc, report: {source, mapped, consumed, items:[{path, kind, reason}]}, nodes}: nodes maps the id of each
 * scene, slide, layer, object and trigger (and `var:<name>` of each user/quiz variable) to {part, node}.
 */
export function importStory(src, { assetsDir, courseDir, title, reuseAssets = false } = {}) {
  const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
  if (title === undefined && typeof src === 'string') title = path.basename(src).replace(/\.story$/i, '');
  const zip = readZip(buf);
  if (!zip.has('story/story.xml')) throw new Error('not a Storyline .story package: story/story.xml is missing');
  const customIds = new Map();
  const submittedResults = new Set();
  const xml = name => {
    const root = parseXml(zip.read(name).toString('utf8'), name);
    for (const n of [root, ...descendants(root)]) {
      if (isG(n.attrs.g) && ID_RE.test(n.attrs.cfId ?? '')) customIds.set(n.attrs.g, n.attrs.cfId);
      if (n.tag === 'data' && n.attrs.action === 'SubmitQuizSL' && n.attrs.enabled !== 'false') submittedResults.add(kid(n, 'customData')?.attrs.g);
    }
    return root;
  };
  const story = xml('story/story.xml');
  if (story.tag !== 'story') throw new Error(`not a Storyline .story package: story.xml root is <${story.tag}>`);
  const props = kids(kid(story, 'propLst'), 'prop');
  const sz = kid(props.find((p) => p.attrs.id === '15'), 'sz')?.attrs ?? {};
  const w = num(sz.w), h = num(sz.h);
  const textScale = textPointScale({ w, h }, story.attrs.UseNewFontScaling === 'true');

  const items = [];
  const note = (at, kind, reason) => items.push({ path: typeof at === 'string' ? at : where(at), kind, reason });
  const noteGradient = at => note(at, 'heuristic.gradientFill', 'heuristic (ours): first gradient stop used as a solid color; remaining stops and gradient geometry are lost');
  // Masters own palettes/fonts; their relationship lists connect layouts to the applicable master (format notes section 3.12).
  const themeByLayout = new Map(), sheetTheme = new Map(), consumedLinks = new WeakSet(); // theme: {colors, fonts, master, layout}
  const optionalXml = name => { try { return zip.has(name) ? xml(name) : null; } catch { note(name, 'theme.part', 'malformed theme/layout XML; references remain unresolved'); return null; } };
  for (const name of zip.names.filter(n => /^story\/slideMasters\/[^/]+\.xml$/.test(n))) {
    const master = optionalXml(name);
    if (!master) continue;
    const colors = new Map(kids(kid(master, 'clrLst')).map(n => [n.tag, color(n)]));
    const theme = { colors, fonts: kid(master, 'fonts')?.attrs ?? {}, master };
    sheetTheme.set(master, theme);
    const relName = path.posix.join(path.posix.dirname(name), '_rels', path.posix.basename(name) + '.rels');
    const relations = new Map(kids(optionalXml(relName), 'Relationship').filter(r => r.attrs.Type === 'slideLayout').map(r => [r.attrs.Id, r.attrs.Target]));
    for (const id of kids(kid(master, 'layoutIdLst'), 'sldId')) {
      const target = relations.get(id.text.trim());
      if (!target) continue;
      const part = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(name), target));
      const layout = optionalXml(part);
      if (!layout) continue;
      const lt = { ...theme, layout };
      sheetTheme.set(layout, lt);
      for (const g of [layout.attrs.g, layout.attrs.internalG]) if (g) themeByLayout.set(g, lt);
    }
  }
  function themeFor(n) { // a slide or layer by its layoutG; objects of a layout or master by their sheet
    for (let p = n; p; p = p.parent) { const t = sheetTheme.get(p) ?? themeByLayout.get(p.attrs.layoutG); if (t) return t; }
    return { colors: new Map(), fonts: {} };
  }
  function themeColor(clr, at) {
    if (!clr?.kids.length) return null;
    const c = clr.kids[0], base = c.tag === 'srgbClr' ? color({ kids: [{ ...c, kids: [] }] }) : c.tag === 'schemeClr' ? themeFor(at).colors.get(c.attrs.val) : null;
    if (!base) return null;
    let rgb = base.slice(1).match(/../g).map(x => parseInt(x, 16)), transformed = false;
    for (const m of [...c.kids, ...clr.kids.slice(1)]) {
      const v = num(m.attrs.val);
      if (!['tint', 'shade'].includes(m.tag) || !(v >= 0 && v <= 100000)) return null;
      // Inferred DrawingML scale (format notes section 3.13); never silently approximate an unsupported modifier.
      rgb = rgb.map(x => m.tag === 'tint' ? x + (255 - x) * v / 100000 : x * v / 100000);
      transformed = true;
    }
    if (transformed) note(at, 'heuristic.themeColor', 'approximated: tint/shade applied per channel using the 100000 scale; check the colour against the original');
    return '#' + rgb.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
  }
  const fillOf = n => fillIn(kid(n, 'bG'), c => themeColor(c, n));
  function borderOf(n) {
    const bg = kid(n, 'bG'), line = kid(bg, 'lineStyle'), solid = kid(bg, 'solidLine');
    if (!solid) return {};
    const border = themeColor(kid(solid, 'clr'), n);
    if (!border) { note(n, 'style.border', 'border color or modifier could not be resolved'); return {}; }
    const width = num(line?.attrs.w);
    return { border, ...(width >= 0 ? { borderWidth: width } : {}) };
  }
  function textStyleOf(n) {
    const bg = kid(n, 'bG'), font = kid(bg, 'defaultFont')?.attrs ?? {}, style = {};
    const size = num(font.sz);
    if (size > 0) style.fontSize = size * textScale;
    const family = font.name?.startsWith('+') ? themeFor(n).fonts[font.name.slice(1)] : font.name;
    if (family) style.fontFamily = family;
    const color = themeColor(kid(kid(bg, 'defaultFont'), 'clr'), n) ?? themeColor(kid(bg, 'foreClr'), n);
    if (color) style.color = color;
    if (font.style) {
      style.bold = /bold/i.test(font.style);
      style.italic = /italic/i.test(font.style);
    }
    return style;
  }
  function resolvedTextStyle(n, normal, type) {
    const ph = kid(n, 'ph')?.attrs.type;
    const fallback = { title: 24, subtitle: 18, body: 14 }[ph] ?? 12;
    const family = themeFor(n).fonts[ph === 'title' ? 'major' : 'minor'];
    const phAttrs = kid(n, 'ph')?.attrs, layout = themeFor(n).layout;
    const placeholders = kids(kid(layout, 'shapeLst')).filter(p => p !== n && kid(p, 'ph'));
    const inherited = phAttrs && (placeholders.find(p => p.attrs.g === phAttrs.g)
      ?? placeholders.find(p => kid(p, 'ph').attrs.type === phAttrs.type && (!phAttrs.subType || kid(p, 'ph').attrs.subType === phAttrs.subType))
      ?? (!(phAttrs.type === 'cstm' && phAttrs.subType) ? placeholders.find(p => kid(p, 'ph').attrs.type === phAttrs.type) : null));
    const style = { fontSize: fallback * textScale, bold: false, italic: false, ...(family ? { fontFamily: family } : {}), ...textStyleOf(inherited), ...textStyleOf(normal), ...textStyleOf(n) };
    // Our writer records only omitted defaults; retain anything changed in another editor.
    const baseline = { fontSize: 24, fontFamily: 'Segoe UI', color: type === 'button' ? '#ffffff' : '#1c1f24', bold: false, italic: false };
    for (const key of (n?.attrs.cfTextDefaults ?? '').split(',')) if (Object.hasOwn(baseline, key) && style[key] === baseline[key]) delete style[key];
    return style;
  }
  function textFitOf(n, o) {
    if (n.tag !== 'textBox' || ['none','resize'].includes(n.attrs.autoFit)) return;
    const ph = kid(n, 'ph')?.attrs, theme = themeFor(n);
    const inherited = ph && kids(kid(theme.layout, 'shapeLst')).find(p => p !== n && p.attrs.g === ph.g && kid(p, 'ph'));
    let mode = n.attrs.autoFit ?? 'def';
    if (mode === 'def') {
      if (!ph) return; // An ordinary legacy text box defaults to Resize, not Shrink.
      if (!inherited || kids(kid(inherited, 'stateLst')).length || isG(kid(inherited, 'ph')?.attrs.g)) {
        note(n, 'text.autofit', 'placeholder fitting defaults are unresolved'); return;
      }
      mode = inherited.attrs.autoFit ?? 'def';
      // Loaded default themes are project-bound: the project flag overrides the saved theme flag.
      if (mode === 'def') mode = story.attrs.UseNewAutofitDefaults === 'true' ? 'none' : 'shrink';
    }
    if (mode !== 'shrink') return;
    // shortcut: stateless boxes and direct placeholders only; other default contexts remain reported.
    const edges = ['l','t','r','b'], m = kid(n, 'margins')?.attrs ?? {};
    const margins = edges.map(k => num(m[k] ?? 0));
    const textMargins = edges.map((k,i) => {
      let v = num(kid(n,'textMargin')?.attrs[k] ?? -1);
      if (v === -1) v = num(kid(inherited,'textMargin')?.attrs[k] ?? -1);
      return v === -1 ? [10,5,10,5][i] : v;
    });
    if (kids(kid(n, 'stateLst')).length || (inherited && (kids(kid(inherited,'stateLst')).length || isG(kid(inherited,'ph')?.attrs.g)))
      || (ph && !inherited) || ![...margins,...textMargins].every(v => Number.isFinite(v) && v >= 0)) {
      note(n, 'text.autofit', 'shrink text has unsupported state context, margins or local bounds'); return;
    }
    const wrap = ['true','false'].includes(n.attrs.wrap) ? n.attrs.wrap : ['true','false'].includes(inherited?.attrs.wrap) ? inherited.attrs.wrap : inherited ? 'true' : ph ? null : 'false';
    if (wrap === null) { note(n, 'text.autofit', 'placeholder wrapping defaults are unresolved'); return; }
    const [l,t,r,b] = textMargins.map((v,i)=>v+margins[i]);
    const fit = { x:l, y:t, w:o.w-l-r, h:o.h-t-b, wrap:wrap === 'true' };
    if (!(fit.w > 0 && fit.h > 0)) { note(n, 'text.autofit', 'shrink text has empty local bounds'); return; }
    return fit;
  }
  function richOf(n, owner = n) {
    const text = kid(n, 'text')?.text.trim();
    if (!text?.startsWith('<')) return null;
    let root;
    try { root = parseXml(text); } catch { note(n, 'text.style', 'malformed or over-depth rich text; plain text retained'); return null; }
    if (root.tag !== 'Document' || !kid(root, 'Content')) { note(n, 'text.style', 'unsupported rich-text document structure; plain text retained'); return null; }
    const issues = new Set(), theme = themeFor(n), paragraphs = [];
    const links = kids(kid(owner, 'hLinkLst'), 'item');
    const triggers = kids(kid(owner, 'trigLst'), 'hlinkTrig');
    function runStyle(attrs, run) {
      for (const [attr, key] of [['FontIsBold', 'b'], ['FontIsItalic', 'i'], ['FontIsUnderline', 'u'], ['FontIsStrikeout', 's']]) {
        if (attrs[attr] === undefined) continue;
        if (/^(true|false)$/i.test(attrs[attr])) run[key] = attrs[attr].toLowerCase() === 'true';
        else issues.add('invalid run emphasis');
      }
      if (attrs.FontSize !== undefined) { const size = num(attrs.FontSize); if (size >= 1) run.size = size * textScale; else issues.add('invalid font size'); }
      if (attrs.FontFamily) {
        const font = attrs.FontFamily.startsWith('+') ? theme.fonts[attrs.FontFamily.slice(1)] : attrs.FontFamily;
        if (font) run.font = font; else issues.add('unresolved theme font');
      }
      if (attrs.ForegroundColor) {
        const match = /^(#[0-9a-f]{6}|[a-z][a-z0-9]*)(?:,00)?$/i.exec(attrs.ForegroundColor);
        const value = match && (match[1][0] === '#' ? match[1].toLowerCase() : theme.colors.get(match[1]));
        if (value) run.color = value; else issues.add('unresolved text color or tint/shade index');
      }
      if (attrs.LinkId !== undefined) {
        const entry = links.find(l => l.attrs.id === attrs.LinkId), link = kid(entry, 'txtHlink');
        const t = triggers.find(t => t.attrs.g === link?.attrs.trigG), d = kid(t, 'data'), other = kid(d, 'other')?.attrs;
        const url = d?.attrs.action === 'sendEmail' ? 'mailto:' + (other?.email ?? '') : d?.attrs.action === 'jumpToFileUrl' ? other?.open : '';
        if (link?.attrs.enabled === 'true' && d?.attrs.enabled !== 'false' && d?.attrs.event === 'OnClick' && !kids(kid(t, 'condLst')).length && !kid(d, 'elseTrigger') && /^(https?:|mailto:)/i.test(url ?? '') && !/[\u0000-\u0020\u007f]/.test(url)) {
          try { run.link = new URL(url).href; consumedLinks.add(t); } catch { issues.add('invalid hyperlink URL'); }
        } else issues.add('unresolved, conditional, disabled or unsafe hyperlink');
      }
      if (attrs.Elevation && attrs.Elevation !== 'Normal') issues.add('superscript/subscript');
      if (attrs.DisplayCase && attrs.DisplayCase !== 'AsIs') issues.add('display case');
    }
    for (const block of kids(kid(root, 'Content'))) {
      if (block.tag !== 'Block') { issues.add('unsupported rich-text element'); continue; }
      const paragraph = { runs: [] }, style = kid(block, 'Style'), a = style?.attrs ?? {};
      if (a.Justification) { const align = a.Justification.toLowerCase(); if (['left', 'center', 'right', 'justify'].includes(align)) paragraph.align = align; else issues.add('paragraph alignment'); }
      if (['SpacingBefore', 'SpacingAfter', 'LeadingMargin', 'FirstLineMargin'].some(k => a[k] !== undefined && num(a[k]) !== 0) || (a.LineSpacingRule && a.LineSpacingRule !== 'Single')) issues.add('paragraph spacing or margins');
      const list = kid(style, 'ListStyle')?.attrs;
      if (list && list.ListType !== 'None') {
        if (list.ListType === 'Bullet' || list.ListType === 'ListNumberedAsArabic') {
          paragraph.list = list.ListType === 'Bullet' ? 'bullet' : 'number';
          const level = num(a.ListLevel ?? '1');
          if (Number.isInteger(level) && level >= 1 && level <= 5) paragraph.level = level; else issues.add('unsupported list level');
          if (list.Start !== undefined && list.Start !== '1') issues.add('list start value');
          if (list.ListTypeFormat && !['Plain', 'Period'].includes(list.ListTypeFormat)) issues.add('list marker format');
          if (paragraph.list === 'bullet' && ((list.BulletChar && list.BulletChar !== '•') || (list.BulletFont && list.BulletFont !== 'Arial') || (list.Size && list.Size !== '100') || (list.Color && !/^#000000(?:,00)?$/i.test(list.Color)))) issues.add('custom bullet appearance');
        } else issues.add('unsupported list type');
      }
      for (const span of kids(block)) {
        if (span.tag === 'Style') continue;
        if (span.tag !== 'Span') { issues.add('unsupported paragraph element'); continue; }
        const run = { text: rewrite(span.attrs.Text ?? '', n) };
        runStyle({ ...kid(style, 'BaseSpanStyle')?.attrs, ...kid(span, 'Style')?.attrs }, run);
        paragraph.runs.push(run);
      }
      if (!paragraph.runs.length) paragraph.runs.push({ text: '' });
      paragraphs.push(paragraph);
    }
    if (issues.size) note(n, 'text.formatting', 'not imported: ' + [...issues].join('; '));
    return paragraphs.length ? replaceRichVariables(paragraphs, token => rewrite(token, n)) : null;
  }
  const origin = new WeakMap(); // CF node -> source node (its path is computed by where() when reported)
  const nodes = new Map(); // CF id -> {part, node}: where a save writes it back
  const track = (x, n) => {
    origin.set(x, n);
    let r = n;
    while (r.parent) r = r.parent;
    if (x.id) nodes.set(x.id, { part: r.part, node: n });
  };
  const taken = new Set();
  const idFor = (prefix, g) => {
    const base = customIds.get(g) ?? `${prefix}-${isG(g) ? g.replace(/-/g, '').slice(0, 12).toLowerCase() : 'x' + taken.size}`;
    let id = base;
    for (let i = 2; taken.has(id); i++) { const suffix = `-${i}`; id = base.slice(0, 41 - suffix.length) + suffix; }
    taken.add(id);
    return id;
  };
  const stats = { source: { slides: 0, layers: 0, objects: 0, triggers: 0 }, consumed: { objects: 0, layers: 0, triggers: 0 } };
  const baseCache = new Map(); // master/layout node -> [{g, o, used}]: each of their objects is mapped (and reported) once
  const tableCells = new WeakMap(); // generated text objects attached to the table background, not new native shapes

  // ----- relationships, media -----
  const rels = new Map();
  if (zip.has('story/_rels/story.xml.rels')) for (const r of kids(xml('story/_rels/story.xml.rels'), 'Relationship')) rels.set(r.attrs.Id, r.attrs.Target ?? '');
  const partOf = (t) => path.posix.normalize(t.startsWith('/') ? t.slice(1) : 'story/' + t);
  const media = new Map(descendants(kid(story, 'mediaLst')).filter((m) => m.tag === 'media' || m.tag === 'video').map((m) => [m.attrs.g, m]));
  const mediaEntry = new Map();
  for (const n of zip.names) { const m = /^story\/media\/R([0-9A-Za-z]+)\.[^/]+$/.exec(n); if (m) mediaEntry.set(m[1], n); }
  const assets = [];
  const assetByG = new Map();
  const attemptedAssets = new Set();
  const pending = []; // [file, Buffer]: written only after the document is valid
  courseDir = courseDir ?? (assetsDir ? path.dirname(path.resolve(assetsDir)) : undefined);
  function derivedAsset(n, svg) {
    if (!assetsDir) throw new Error('no assets folder was given for generated graphics');
    const id = idFor('a', n.attrs.g), file = path.join(path.resolve(assetsDir), `${id}.svg`);
    const asset = { id, path: path.relative(path.resolve(courseDir), file).split(path.sep).join('/'), mime: 'image/svg+xml' };
    assets.push(asset); pending.push([file, Buffer.from(svg)]); track(asset, n); nodes.get(id).derived = true;
    return id;
  }
  function vectorGeometry(n, w, h) {
    if (n.tag === 'importedVector') {
      const types = kid(n, 'types')?.text.trim() ?? '';
      if (types.length > 14000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(types)) throw new Error('malformed path type bytes');
      return importedPath(kids(kid(n, 'points'), 'point').map(p => [num(p.attrs.x), num(p.attrs.y)]), Buffer.from(types, 'base64'), kid(n, 'fillMode')?.text.trim() || 'Alternate');
    }
    const geometry = kid(kid(n, 'prstGeom'), n.tag);
    const raw = geometry?.attrs[n.tag === 'multiply' ? 'cy' : 'radius'], value = num(raw);
    if (raw !== undefined && value === undefined) throw new Error('invalid symbol parameter');
    if (geometry?.attrs.vertexSet === 'false' && kid(n, 'ph')) throw new Error('inherited symbol parameters are not supported');
    return symbolPath(n.tag, w, h, value ?? (n.tag === 'multiply' ? .3 : .1875));
  }
  function assetFor(g, at, allowed = IMAGE_TYPES) {
    if (!isG(g)) { note(at, 'media.missing', 'invalid or missing media reference'); return null; }
    const m = media.get(g);
    if (!m) { note(at, 'media.missing', 'media is not listed in story.xml'); return null; }
    const type = MEDIA[m.attrs.type];
    if (!type || !allowed.includes(m.attrs.type)) { note(at, 'media.type', `media type "${m.attrs.type}" is not imported here (expected ${allowed.join(', ')})`); return null; }
    if (assetByG.has(g)) return assetByG.get(g);
    attemptedAssets.add(g);
    if (!assetsDir) { note(at, 'media.notExtracted', 'no assets folder was given, so the media was skipped'); return null; }
    const entry = mediaEntry.get(storyId(g));
    if (!entry) { note(at, 'media.missing', 'media file not found in the package'); return null; }
    let data;
    try { data = zip.read(entry); } catch (e) { note(at, 'media.corrupt', e.message); return null; }
    if (m.attrs.type === 'Emf') {
      try { data = emfToPng(data); }
      catch (e) { note(at, 'media.type', e.message); return null; }
      note(m, 'media.rasterized', 'EMF rasterized to PNG by Windows for viewing and publishing; original native media retained');
    }
    const id = idFor('a', g);
    const file = path.join(path.resolve(assetsDir), `${id}.${type[0]}`);
    pending.push([file, data]);
    const asset = { id, path: path.relative(path.resolve(courseDir), file).split(path.sep).join('/'), mime: type[1] };
    if (m.attrs.cfAlt !== undefined) asset.alt = m.attrs.cfAlt; // Own-file library metadata; picture alt is separate.
    assets.push(asset);
    track(asset, m);
    assetByG.set(g, id);
    return id;
  }

  // ----- variables -----
  const vars = new Map(); // g -> {kind: user|quiz|builtIn|prop, name, type}
  const variables = [];
  const varNames = new Set();
  const typeOf = { num: 'number', bool: 'boolean', text: 'text' };
  for (const v of kids(kid(story, 'varLst'), 'var')) {
    const a = v.attrs, type = typeOf[a.dataType];
    if (a.type !== 'user') { vars.set(a.g, { kind: a.type, sname: a.name, type, node: v }); continue; }
    if (!type) { note(v, 'variable.type', `data type "${a.dataType}" has no mapping`); continue; }
    let name = a.name ?? '';
    if (!VAR_RE.test(name) || varNames.has(name)) {
      let fixed = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=[0-9]|$)|^__/, 'v_');
      for (let i = 2, b = fixed; varNames.has(fixed); i++) fixed = `${b}_${i}`;
      note(v, 'variable.renamed', `renamed to "${fixed}" (CF variable names use letters, digits and _)`);
      name = fixed;
    }
    varNames.add(name);
    const val = a.val ?? '';
    variables.push({ name, type, initial: type === 'number' ? (num(val) ?? 0) : type === 'boolean' ? /^true$/i.test(val) : val });
    vars.set(a.g, { kind: 'user', sname: a.name, name, type, node: v });
    if (a.isRandom === 'true') note(v, 'variable.random', 'random initial values are not imported');
  }

  // ----- quizzes -----
  const quizMgr = kid(story, 'quizMgr');
  const quizzes = [];
  const quizNodes = [];
  const quizByResult = new Map();
  for (const qn of kids(kid(quizMgr, 'quizLst'), 'quiz')) {
    const a = qn.attrs;
    const pass = num(a.passScore);
    const quiz = { id: idFor('q', a.g), title: a.name?.trim() || 'Quiz', questions: [], passPercent: pass >= 0 && pass <= 100 ? pass : 80 };
    if (a.roundUpScorePercent === 'true') quiz.round = true; // rounding observed in
    if (quiz.passPercent !== pass) note(qn, 'quiz.passScore', 'pass score is not a percentage; 80 used');
    for (const [attr, field] of [['scorePct', 'scorePercent'], ['scorePoints', 'scorePoints'], ['passPct', 'passPercent'], ['passPoints', 'passPoints']]) {
      const v = vars.get(a[attr]);
      if (v) Object.assign(v, { kind: 'quiz', name: `${quiz.id}.${field}`, type: 'number' });
    }
    if (a.timed === 'true') note(qn, 'quiz.timer', 'quiz timers are not imported');
    if (isG(a.resultSldG)) quizByResult.set(a.resultSldG, quiz);
    quizzes.push(quiz); quizNodes.push(qn);
    track(quiz, qn);
  }
  const varByName = new Map([...vars.values()].filter((v) => v.kind === 'user' || v.kind === 'quiz').map((v) => [v.sname, v.name]));
  for (const v of vars.values()) if (v.kind === 'user' || v.kind === 'quiz') nodes.set('var:' + v.name, { part: 'story/story.xml', node: v.node });
  const builtIn = new Set([...vars.values()].filter((v) => v.kind === 'builtIn').map((v) => v.sname));
  const importedVarNames = new Set(varByName.values());
  const rewrite = (t, at) => t.replace(/%([^%\s]+)%/g, (m, n) => {
    if (varByName.has(n)) return `%${varByName.get(n)}%`;
    if (importedVarNames.has(n)) return m;
    note(at, 'text.variable', builtIn.has(n) ? `built-in variable %${n}% is not resolved` : `variable reference %${n}% is not resolved`);
    return m;
  });

  // ----- scenes and slides, pass 1: ids for every slide and scene (jump targets may point forward) -----
  const scenes = [], slides = [], parts = [], banks = [], draws = [];
  const sceneByG = new Map(), slideByG = new Map(), bankByG = new Map();
  // Question banks: quizMgr/bankLst/scene, the same scene element outside sceneLst. Bank slides
  // (sld, or exSld in banks) are mapped like scene slides;.
  const sceneLike = (sc, list, onDraw) => {
    for (const sid of kids(kid(sc, 'sldIdLst'), 'sldId')) {
      const target = rels.get(sid.text.trim());
      const part = target && partOf(target);
      if (!part || !zip.has(part)) { note(sid, 'slide.missing', 'slide part not found in the package'); continue; }
      const root = xml(part);
      stats.source.slides++;
      if (root.tag === 'bankSld' && onDraw) { onDraw(root); continue; }
      if (root.tag !== 'sld' && root.tag !== 'exSld') { note(root, `slide.${root.tag}`, `<${root.tag}> slides are not imported here`); continue; }
      const titles = kids(kid(root, 'shapeLst')).filter(n => kid(n, 'ph')?.attrs.type === 'title');
      const slide = { id: idFor('s', root.attrs.g), title: root.attrs.name?.trim() || (titles.length === 1 && textOf(titles[0])) || 'Untitled slide', objects: [], layers: [], triggers: [] };
      list.push(slide.id); slides.push(slide); slideByG.set(root.attrs.g, slide); parts.push([root, slide]);
      track(slide, root);
    }
  };
  for (const bn of kids(kid(quizMgr, 'bankLst'), 'scene')) {
    const bank = { id: idFor('bk', bn.attrs.g), title: bn.attrs.name?.trim() || 'Question bank', slides: [] };
    banks.push(bank); bankByG.set(bn.attrs.g, bank); track(bank, bn);
    const bp = kid(bn, 'bankProps')?.attrs ?? {};
    if ((bp.rand && bp.rand !== 'false') || (bp.include && bp.include !== '-1')) note(kid(bn, 'bankProps'), 'bank.props', `bankProps rand="${bp.rand}" include="${bp.include}" has no evidenced meaning and is not imported`);
    sceneLike(bn, bank.slides, null);
  }
  for (const sc of kids(kid(story, 'sceneLst'), 'scene')) {
    const scene = { id: idFor('sc', sc.attrs.g), title: sc.attrs.name?.trim() || 'Scene', slides: [] };
    scenes.push(scene); sceneByG.set(sc.attrs.g, scene); track(scene, sc);
    sceneLike(sc, scene.slides, (root) => mapDraw(root, scene));
  }

  /* * bankSld: bankG -> bank, incCnt -> count, rnd -> shuffle, questionLst/bankSld@inc|exc -> always|never (I). */
  function mapDraw(root, scene) {
    const a = root.attrs;
    const bank = bankByG.get(a.bankG);
    if (!bank) { note(root, 'draw.bank', 'the question bank of this draw is not in quizMgr/bankLst'); return; }
    const cnt = num(a.incCnt);
    const draw = { bank: bank.id, count: Number.isInteger(cnt) && cnt >= 0 ? cnt : 0, shuffle: a.rnd === 'true', always: [], never: [] };
    if (draw.count !== cnt) note(root, 'draw.count', `incCnt "${a.incCnt}" is not a count; every eligible slide is drawn`);
    if (a.sync === 'true') note(root, 'draw.sync', 'sync="true" has no evidenced meaning and is not imported');
    const slide = { id: idFor('s', a.g), title: a.name?.trim() || `Draw from ${bank.title}`, objects: [], layers: [], triggers: [], draw };
    scene.slides.push(slide.id); slides.push(slide); slideByG.set(a.g, slide); track(slide, root);
    draws.push([root, slide]);
  }

  // ----- pass 2: slide content -----
  const questionSlides = []; // [slide, Set(excluded quiz GUIDs)]
  for (const [root, slide] of parts) mapSlide(root, slide);
  for (const [root, slide] of draws) resolveDraw(root, slide);

  function resolveDraw(root, slide) {
    const bank = banks.find((b) => b.id === slide.draw.bank);
    for (const q of kids(kid(root, 'questionLst'), 'bankSld')) {
      const s = slideByG.get(q.attrs.sldG);
      if (!s || !bank.slides.includes(s.id)) { note(q, 'draw.question', 'the listed question is not an imported slide of the bank'); continue; }
      if (q.attrs.inc === 'true') slide.draw.always.push(s.id); // inc/exc: always/never include (I: every example item has both false)
      else if (q.attrs.exc === 'true') slide.draw.never.push(s.id);
      if (q.attrs.link && q.attrs.link !== 'none') note(q, 'draw.link', `link "${q.attrs.link}" (tying a drawn question to another slide) is not imported`);
    }
    if (kids(kid(root, 'shapeLst')).length || kids(kid(root, 'sldLayerLst')).length) note(root, 'draw.content', 'objects and layers on a draw slide are not imported (CF draw slides have no content)');
    const trigs = []; // default Next/Prev triggers are consumed as usual; anything else cannot live on a CF draw slide
    mapTriggers(root, trigs, { root, slide, objByG: new Map(), layerByG: new Map(), consumed: new Set(), qG: null }, { kind: 'slide' });
    for (const t of trigs) note(origin.get(t), 'draw.trigger', 'triggers on a draw slide are not imported (CF draw slides have none)');
  }

  function mapSlide(root, slide) {
    const a = root.attrs;
    const dur = num(kid(root, 'tmProps')?.attrs.min);
    if (dur >= 0) slide.duration = dur; // tmProps@min is the timeline length
    if (a.advMode === 'auto') slide.advance = 'auto';
    else if (a.advMode && a.advMode !== 'user') note(root, 'slide.advance', `advMode "${a.advMode}" has no mapping`);
    const rv = { auto: 'auto', y: 'reset', n: 'resume' }[a.resetMode ?? 'auto'];
    if (rv) { if (rv !== 'auto') slide.revisit = rv; } else note(root, 'slide.revisit', `resetMode "${a.resetMode}" has no mapping`);
    // no fill of its own -> the layout's, else the master's (inferred: every sampled inherited colour was white).
    const bg = kid(root, 'bg'), theme = themeByLayout.get(a.layoutG);
    const from = OWN_BG.some((t) => kid(bg, t)) ? null : [theme?.layout, theme?.master].find((s) => OWN_BG.some((t) => kid(kid(s, 'bg'), t)));
    const bgSrc = from ? kid(from, 'bg') : bg;
    const bgFill = fillIn(bgSrc, c => themeColor(c, root));
    if (bgFill.fill) {
      slide.background = bgFill.fill;
      if (bgFill.heuristic) noteGradient(bgSrc);
      if (from) note(bg ?? root, 'heuristic.inheritedBackground', `inferred: the slide has no fill of its own, so its ${from === theme.layout ? 'layout' : 'master'} background is used`);
    } else if (bgFill.issue) note(bgSrc, 'slide.background', (from ? 'inherited background: ' : '') + bgFill.issue);
    const nt = kid(root, 'note')?.text;
    if (nt && nt.trim()) { const t = clean(docText(nt)); if (t) slide.notes = t; }

    const ctx = { root, slide, objByG: new Map(), layerByG: new Map(), consumed: new Set(), qG: null };
    mapQuestion(ctx);
    const nav = kid(root, 'navData');
    if (!slide.question && nav && (nav.attrs.prev === 'false' || nav.attrs.next === 'false')) note(nav, 'slide.navigation', 'per-slide player buttons are not imported');

    slide.objects.push(...baseObjects(theme)); // master, then layout objects, behind the slide's own
    const base = kids(kid(root, 'shapeLst')).map((n) => [n, mapObject(n, ctx)]);
    for (const [, o] of base) if (o) slide.objects.push(o, ...tableCells.get(o) ?? []);
    for (const [n, o] of base.filter(([n, o]) => n.tag === 'group' && o)) {
      const members = base.filter(([child]) => child.attrs.parentG === n.attrs.g).map(([, child]) => child);
      if (members.some(child => !child)) {
        note(n, 'object.group', 'a group member could not be imported; group interaction is not imported');
        slide.objects.splice(slide.objects.indexOf(o), 1); ctx.objByG.delete(n.attrs.g);
        continue;
      }
      o.members = members.map(child => child.id);
      o.alt = members.map(child => child.text || child.alt || '').filter(Boolean).join(' ') || o.name;
      slide.objects.splice(slide.objects.indexOf(o), 1); slide.objects.push(o); // transparent hit box above its visible members
    }
    if (ctx.dd) resolveDragDrop(ctx);
    const layers = [];
    for (const ln of kids(kid(root, 'sldLayerLst'))) {
      stats.source.layers++;
      const objs = kids(kid(ln, 'shapeLst'));
      if (ctx.consumed.has(ln)) { stats.consumed.layers++; stats.source.objects += objs.length; stats.consumed.objects += objs.length; layers.push([ln, null, objs.map((n) => [n, null])]); continue; }
      if (ln.tag !== 'sldLayer' && ln.tag !== 'feedBackLayer') { note(ln, `layer.${ln.tag}`, `<${ln.tag}> is not imported`); continue; }
      const layer = mapLayer(ln);
      ctx.layerByG.set(ln.attrs.g, layer); slide.layers.push(layer);
      const mapped = objs.map((n) => [n, mapObject(n, ctx)]);
      for (const [, o] of mapped) if (o) layer.objects.push(o, ...tableCells.get(o) ?? []);
      layers.push([ln, layer, mapped]);
    }
    // Triggers last: every object, layer and slide id of this slide now exists.
    mapTriggers(root, slide.triggers, ctx, { kind: 'slide' });
    for (const [n, o] of base) mapTriggers(n, slide.triggers, ctx, { kind: 'object', id: o?.id, consumed: ctx.consumed.has(n), dropped: !o });
    for (const [ln, layer, objs] of layers) {
      mapTriggers(ln, layer?.triggers, ctx, { kind: 'layer', layer, consumed: !layer });
      for (const [n, o] of objs) mapTriggers(n, layer?.triggers, ctx, { kind: 'object', id: o?.id, layer, consumed: !layer || ctx.consumed.has(n), dropped: !o });
    }
    if (quizByResult.has(a.g)) submitFirst(root, slide);
  }

  function mapLayer(ln) {
    const a = ln.attrs;
    const layer = { id: idFor('l', a.g), title: a.name?.trim() || a.defaultName?.trim() || 'Layer', objects: [], triggers: [] };
    track(layer, ln);
    const dur = num(kid(ln, 'tmProps')?.attrs.min);
    if (dur >= 0) layer.duration = dur;
    if (a.modal === 'true') layer.modal = true;
    if (a.stop === 'false') layer.hideOthers = false;
    if (a.hideEnd === 'true') layer.hideOnEnd = true;
    if (a.pause === 'true') layer.pauseBase = true; // sldLayer@pause publishes as pauseParent
    if (a.hideAllInheritable === 'true') note(ln, 'layer.hideBaseObjects', '"hide objects on the base layer" is not imported; check the layer after import');
    const reset = a.resetModeInheritable ?? a.resetMode;
    const revisit = { y: 'reset', n: 'resume' }[reset];
    if (revisit) layer.revisit = revisit;
    else if (reset && reset !== 'auto') note(ln, 'layer.revisit', `layer resetMode "${reset}" is not imported`);
    if (a.presentAs && a.presentAs !== 'Layer') note(ln, 'layer.presentAs', `layers presented as "${a.presentAs}" are imported as plain layers`);
    return layer;
  }

  /* * the master's and then the layout's non-placeholder objects, as locked base objects of one slide. Observed
   * in the vendor publish: base layer, `loc` geometry, behind the slide's objects, master first. */
  function baseObjects(theme) {
    const out = [];
    for (const sheet of [theme?.master, theme?.layout]) {
      if (!sheet) continue;
      if (!baseCache.has(sheet)) {
        const ctx = { objByG: new Map(), consumed: new Set() };
        baseCache.set(sheet, kids(kid(sheet, 'shapeLst')).filter((n) => n.tag !== 'ph' && n.tag !== 'btnPh').map((n) => {
          if (kids(kid(n, 'trigLst')).length) note(n, 'trigger.source', 'triggers on master and layout objects are not imported');
          const o = mapObject(n, ctx);
          return [o, ...tableCells.get(o) ?? []].filter(Boolean).map(o => ({ g: n.attrs.g, o }));
        }).flat());
      }
      for (const e of baseCache.get(sheet)) { // the first slide takes the mapped object, later slides a copy with its own id
        const o = e.used ? { ...structuredClone(e.o), id: idFor('o', e.g) } : e.o;
        e.used = true;
        o.locked = true;
        track(o, origin.get(e.o));
        if (nodes.get(e.o.id)?.derived) nodes.get(o.id).derived = true;
        out.push(o);
      }
    }
    return out;
  }

  /* * a line from (x1, y1) to (x2, y2) as a box of height h centred on it, turned by rotation (plus `turn`). */
  function placeLine(o, x1, y1, x2, y2, h, turn) {
    const len = Math.hypot(x2 - x1, y2 - y1);
    let deg = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI + turn;
    deg -= Math.ceil((deg - 180) / 360) * 360; // into (-180, 180]
    Object.assign(o, { x: round2((x1 + x2 - len) / 2), y: round2((y1 + y2 - h) / 2), w: round2(len), h: round2(h) });
    if (round2(deg)) o.rotation = round2(deg); else delete o.rotation;
  }

  // bounded unmerged table; preserve its native node and draw existing image/text primitives.
  function mapTable(n, ctx) {
    try {
      const fail = reason => { throw new Error(reason); };
      if (![undefined, -1, 0].includes(num(n.attrs.rot)) || statesOf(n).length || kids(kid(n, 'trigLst')).length || kid(n, 'animEffect')?.kids.length) fail('rotated, stateful or animated tables are not supported');
      const model = kid(n, 'table'), columns = kids(kid(model, 'columns'), 'tableColumn').map(c => num(c.attrs.width));
      const rows = kids(kid(model, 'rows'), 'tableRow'), heights = rows.map(r => num(r.attrs.height));
      const loc = kid(n, 'loc')?.attrs ?? {}, [x,y,right,bottom] = ['l','t','r','b'].map(k => num(loc[k]));
      const w = columns.reduce((a,b) => a+b, 0), h = heights.reduce((a,b) => a+b, 0);
      if (!columns.length || !rows.length || columns.length * rows.length > 400 || [...columns,...heights].some(v => !(v > 0 && v <= 1e5))
        || ![x,y,right,bottom].every(Number.isFinite) || Math.abs(right-x-w) > .01 || Math.abs(bottom-y-h) > .01) fail('invalid or scaled table dimensions');
      const cells = [], rectangles = [], perimeter = [];
      let top = 0;
      for (const [ri, row] of rows.entries()) {
        const entries = kids(kid(row, 'cells'), 'tableCell');
        if (entries.length !== columns.length) fail('table cell count does not match its columns');
        let left = 0;
        for (const [ci, cell] of entries.entries()) {
          const style = kid(cell, 'style'), attrs = style?.attrs ?? {}, margins = kid(style, 'margins')?.attrs ?? {};
          const padding = ['l','t','r','b'].map(k => num(margins[k]));
          if (['rowSpan','columnSpan'].some(k => num(cell.attrs[k] ?? '1') !== 1) || ['verticalMerge','horizontalMerge','textShadow'].some(k => cell.attrs[k] === 'true')
            || !['Horizontal', undefined].includes(attrs.textDirection) || !['Top', undefined].includes(attrs.verticalAlign)
            || !(padding[0] >= 0) || padding.some(v => v !== padding[0])) fail('merged cells, text effects, directions or unequal margins are not supported');
          const background = kid(style, 'background'), fill = themeColor(kid(background, 'fillColor'), n);
          if (!fill || background.kids.some(k => k.tag !== 'fillColor')) fail('unsupported table cell fill');
          rectangles.push(`<rect x="${left}" y="${top}" width="${columns[ci]}" height="${heights[ri]}" fill="${fill}"/>`);
          for (const side of ['top','bottom','left','right']) {
            const edge = kid(style, side + 'Border'), dash = edge?.attrs.dashType ?? 'Solid';
            const outer = { top: ri === 0, bottom: ri === rows.length-1, left: ci === 0, right: ci === columns.length-1 }[side];
            if (!outer) { if (dash !== 'Custom') fail('internal table borders are not supported'); continue; }
            if (dash !== 'Solid') fail('non-solid perimeter table borders are not supported');
            const color = themeColor(kid(edge, 'themeColor'), n), width = num(edge?.attrs.weight ?? '1');
            if (!color || !(width >= 0 && width < Math.min(w,h))) fail('invalid table border');
            perimeter.push({ color, width });
          }
          const textNode = { tag: 'text', attrs: {}, kids: [], text: cell.attrs.text ?? '', parent: cell };
          const proxy = { ...cell, kids: [...cell.kids, textNode] };
          const rich = richOf(proxy, n);
          if (!rich) fail('unsupported table rich-text document');
          cells.push({ id: '', type: 'text', x: x+left, y: y+top, w: columns[ci], h: heights[ri], locked: true,
            text: rich.map(p => p.runs.map(r => r.text).join('')).join('\n'), rich,
            style: { ...resolvedTextStyle(n, null, 'text'), padding: padding[0], clip: true, valign: 'top' } });
          left += columns[ci];
        }
        top += heights[ri];
      }
      const border = perimeter[0];
      if (perimeter.some(p => p.color !== border.color || p.width !== border.width)) fail('unequal perimeter table borders are not supported');
      const inset = border.width / 2;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${rectangles.join('')}<rect x="${inset}" y="${inset}" width="${w-border.width}" height="${h-border.width}" fill="none" stroke="${border.color}" stroke-width="${border.width}"/></svg>`;
      const o = { id: idFor('o', n.attrs.g), type: 'image', x,y,w,h, locked: true, image: derivedAsset(n, svg), style: { fill: 'transparent' } };
      if (n.attrs.name?.trim()) o.name = n.attrs.name.trim();
      const tc = kid(n, 'tmCtxLst')?.kids[0]?.attrs;
      for (const part of [o, ...cells]) {
        if (!part.id) part.id = idFor('o', n.attrs.g);
        if (num(tc?.start) > 0) part.start = num(tc.start);
        if (tc?.untilEnd === 'false' && num(tc.dur) >= 0) part.end = (num(tc.start) ?? 0) + num(tc.dur);
        track(part, n); nodes.get(part.id).derived = true;
      }
      tableCells.set(o, cells); ctx.objByG.set(n.attrs.g, o);
      return o;
    } catch (e) { note(n, 'object.table', e.message); return null; }
  }

  function mapObject(n, ctx) {
    stats.source.objects++;
    if (ctx.consumed.has(n)) { stats.consumed.objects++; return null; }
    const tag = n.tag;
    if (tag === 'table') return mapTable(n, ctx);
    const groupChildren = tag === 'group' ? kids(kid(ctx.root, 'shapeLst')).filter(child => child.attrs.parentG === n.attrs.g) : [];
    const simpleGroup = tag === 'group' && ctx.dd?.pairs.some(pair => pair.includes(n.attrs.g)) && groupChildren.length > 0
      && [n, ...groupChildren].every(child => [undefined, -1, 0].includes(num(child.attrs.rot)) && !statesOf(child).length && !kids(kid(child, 'trigLst')).length)
      && groupChildren.every(child => ['pic', 'textBox'].includes(child.tag));
    const dial = kid(n, 'dialData');
    const near = Object.hasOwn(NEAR, tag) && (tag !== 'polygon' || num(kid(kid(n, 'prstGeom'), 'polygon')?.attrs.sides) >= 5) ? NEAR[tag] : null;
    const lineLike = LINES.has(tag) || Object.hasOwn(BLOCK_ARROWS, tag);
    const vector = ['importedVector', 'multiply', 'noSymbol'].includes(tag);
    const type = simpleGroup || tag === 'clkAreaRect' ? 'hotspot' : tag === 'dial' || (dial?.attrs.dialType && dial.attrs.dialType !== 'None') ? 'dial' : tag === 'slider' || tag === 'video' ? tag : TEXTS.has(tag) ? 'text' : SHAPES[tag] || near || lineLike ? 'shape' : tag === 'pic' || vector ? 'image' : BUTTONS.has(tag) ? 'button' : tag === 'marker' ? 'marker' : null;
    if (!type) {
      if (/Intr$/.test(tag)) return null; // question elements: mapQuestion already reported why
      note(n, `object.${tag}`, tag === 'group' ? 'group containers are not imported; members are imported as separate objects' : `<${tag}> is not supported yet`);
      return null;
    }
    const states = statesOf(n);
    const normal = snapshot(states.find((s) => s.attrs.name === 'Normal'));
    const o = { id: '', type };
    if (type === 'slider' || type === 'dial') {
      const a = type === 'dial' ? dial?.attrs ?? {} : n.attrs;
      const v = vars.get(a.varG);
      if (v?.kind !== 'user' || v.type !== 'number') { note(n, `${type}.variable`, 'control must reference an imported user number variable'); return null; }
      const action = type === 'dial' ? a.updateAction : a.action;
      if (action !== 'drag') { note(n, `${type}.action`, `update action "${action}" has no observed mapping`); return null; }
      const range = kid(type === 'dial' ? dial : n, type === 'dial' ? 'values' : 'track')?.attrs ?? {};
      const min = num(range.start), max = num(range.end), step = num(type === 'dial' ? a.increment : kid(n, 'ticks')?.attrs.step);
      if (min === undefined || max === undefined || !(min < max) || !(step > 0)) { note(n, `${type}.range`, 'missing or invalid range/step; control skipped'); return null; }
      Object.assign(o, { var: v.name, min, max, step, live: true });
      if (type === 'dial') {
        const rotation = num(a.rotation), point = kid(dial, 'rotationPoint')?.attrs ?? {};
        if (a.dialType !== 'BuiltInDial' || !(rotation > 0) || (a.rotationIndicatorOffsetDegrees !== undefined && num(a.rotationIndicatorOffsetDegrees) !== 0)
          || ['xOffset', 'yOffset'].some((k) => point[k] !== undefined && num(point[k]) !== 0)) {
          note(n, 'dial.variant', 'only a BuiltInDial with a positive sweep and no indicator/pivot offset is supported'); return null;
        }
        Object.assign(o, { startAngle: -rotation / 2, endAngle: rotation / 2 });
        note(n, 'dial.angles', 'sweep centered on 12 o’clock (±rotation/2) is inferred from the');
      }
    }
    if (type === 'video') { // source paths are never used
      if (n.attrs.vidSrcType !== 'local' || kid(n, 'url')?.text.trim() || kid(n, 'embed')?.text.trim() || kid(n, 'embed')?.kids.length) {
        note(n, 'video.source', 'only inserted local video is evidenced; URL/embed video is not imported'); return null;
      }
      o.media = assetFor(n.attrs.assetG, n, ['Mp4']);
      if (!o.media) return null;
      o.autoplay = n.attrs.play === 'auto';
      if (n.attrs.play !== 'auto') note(n, 'video.play', `play mode "${n.attrs.play}" imported without autoplay (inferred; only auto was observed)`);
      for (const [attr, key] of [['showCtrls', 'controls'], ['loop', 'loop']]) {
        if (['true', 'false'].includes(n.attrs[attr])) o[key] = n.attrs[attr] === 'true';
        else note(n, `video.${attr}`, `missing or unsupported ${attr}; CF default is used`);
      }
      for (const [attr, key, types] of [['thumbG', 'poster', IMAGE_TYPES], ['ccG', 'captions', ['Vtt']]]) {
        if (n.attrs[attr] && n.attrs[attr] !== ZERO) { const id = assetFor(n.attrs[attr], n, types); if (id) o[key] = id; }
      }
      for (const attr of ['vol', 'mute', 'rew', 'full']) {
        if (n.attrs[attr] !== undefined && n.attrs[attr] !== (attr === 'vol' ? '100' : 'false')) note(n, `video.${attr}`, `${attr} is not imported`);
      }
    }
    if (type === 'image' && !vector) {
      o.image = assetFor(n.attrs.assetG, n); // reports a missing or invalid reference itself
      if (!o.image) return null;
    }
    o.id = idFor('o', n.attrs.g);
    track(o, n);
    ctx.objByG.set(n.attrs.g, o);
    if (n.attrs.name?.trim()) o.name = n.attrs.name.trim();
    const loc = kid(n, 'loc')?.attrs ?? {};
    const [l, t, r, b] = ['l', 't', 'r', 'b'].map((k) => num(loc[k]) ?? 0);
    Object.assign(o, { x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t) });
    if (type === 'button' && normal) {
      const nl = kid(normal, 'loc')?.attrs ?? {}, [x, y, w, h] = ['l', 't', 'r', 'b'].map(k => num(nl[k]));
      // shortcut: only zero-origin Normal artwork is evidenced; add translated artwork after a vendor comparison.
      if (x === 0 && y === 0 && w > 0 && h > 0) Object.assign(o, { w, h });
      else note(n, 'object.stateGeometry', 'nonzero or invalid Normal artwork bounds; outer button bounds retained');
    }
    if (type === 'shape') o.shape = SHAPES[tag] ?? near?.[0] ?? 'line';
    if (near) note(n, `heuristic.${tag}`, `heuristic (ours): <${tag}> imported as the nearest CF shape (${near[0]}); ${near[1]}`);
    const rot = num(n.attrs.rot);
    if (rot !== undefined && rot !== -1 && rot !== 0) o.rotation = rot; // -1 = no rotation
    if (type === 'marker') { // markerProps title/desc (runtime): the button name and its label
      const mp = kid(n, 'markerProps');
      const title = clean(docText(kid(mp, 'title')?.text ?? '')), desc = clean(docText(kid(mp, 'desc')?.text ?? ''));
      if (title) { o.text = rewrite(title, n); }
      if (desc) o.detail = rewrite(desc, n);
      const m = kid(mp, 'media');
      // Example corpus: every marker has an empty media block (assetG zero, url "", empty embed).
      if (m && (isG(m.attrs.assetG) || (m.attrs.url ?? '').trim() || descendants(m, 'pic').some((p) => isG(p.attrs.assetG)) || descendants(m, 'embed').some((x) => x.text.trim()))) note(m, 'object.markerMedia', 'pictures and video inside a marker label are not imported');
    } else if (type !== 'image') {
      const text = textOf(n) || (normal ? textOf(normal) : '');
      if (text) { o.text = rewrite(text, n); }
    }
    const alt = kid(n, 'alt')?.text.trim();
    if (alt) o.alt = alt;
    else if (type === 'image' && n.attrs.acc === 'true' && o.name) {
      o.alt = o.name;
      note(n, 'heuristic.imageAltFromName', 'heuristic (ours): picture name used for empty alt with acc=true (inferred non-decorative); review the description for accessibility');
    }
    let f = fillOf(n);
    if (!f.fill && !f.issue && normal) f = fillOf(normal);
    // Keep CF's implicit button fill implicit, but retain a native editor's changed colour.
    if (type === 'button' && n.attrs.cfDefaultButtonFill === 'true' && f.fill === '#34449c') f = {};
    if (f.fill) { o.style = { fill: f.fill }; if (f.heuristic) noteGradient(n); }
    else if (f.issue) note(n, 'style.fill', f.issue);
    const border = borderOf(n);
    if (Object.keys(border).length) o.style = { ...o.style, ...border };
    const corners = kid(n, 'rndC')?.attrs ?? kid(normal, 'rndC')?.attrs;
    if (corners) {
      const radii = ['rTL', 'rTR', 'rBL', 'rBR'].map(key => num(corners[key]));
      if (corners.usePc === 'false' && radii[0] >= 0 && radii.every(r => r === radii[0])) o.style = { ...o.style, radius: radii[0] };
      else note(n, 'style.radius', 'unequal or percentage corner radii are not imported');
    }
    if (['text', 'shape', 'button'].includes(type)) {
      const textStyle = o.text ? resolvedTextStyle(n, normal, type) : {};
      if (Object.keys(textStyle).length) o.style = { ...o.style, ...textStyle };
      const rich = richOf(textOf(n) ? n : normal, n);
      if (rich) { o.rich = rich; o.text = rich.map(p => p.runs.map(r => r.text).join('')).join('\n'); }
      const textFit = o.text && textFitOf(n, o);
      if (textFit) o.style = { ...o.style, textFit };
    }
    if (LINES.has(tag)) { // loc l,t = start and r,b = end (inferred from r < l / b < t in the sample)
      const heads = kid(kid(kid(n, 'bG'), 'lineStyle'), 'arrow');
      const [hb, he] = ['begin', 'end'].map((k) => kid(heads, k)?.attrs.type);
      const begin = !NO_HEAD.has(hb), end = !NO_HEAD.has(he), sw = o.style?.borderWidth ?? 2;
      o.shape = begin || end ? 'arrow' : 'line';
      placeLine(o, l, t, r, b, begin || end ? 3 * sw : sw, (begin && !end ? 180 : 0) + (o.rotation ?? 0));
      if (begin && end) note(n, 'heuristic.doubleArrow', 'heuristic (ours): imported as a one-headed arrow; the start arrowhead is not drawn');
      const drawn = end ? he : hb;
      if ((begin || end) && drawn !== 'triangle') note(n, 'heuristic.arrowHead', `heuristic (ours): "${drawn}" arrowhead drawn as a filled triangle`);
    } else if (lineLike) { // block arrow: a stroked arrow as thick as a third of the block
      const down = BLOCK_ARROWS[tag] === 90, cx = o.x + o.w / 2, cy = o.y + o.h / 2, across = down ? o.w : o.h, color = o.style?.fill ?? o.style?.border;
      o.shape = 'arrow';
      o.style = { ...(color ? { border: color } : {}), borderWidth: round2(across / 3) };
      placeLine(o, down ? cx : o.x, down ? o.y : cy, down ? cx : o.x + o.w, down ? o.y + o.h : cy, across, o.rotation ?? 0);
      note(n, 'heuristic.blockArrow', `heuristic (ours): <${tag}> block arrow drawn as a stroked arrow in its fill colour; its outline and head proportions are not kept${o.text ? ', and its text is not drawn' : ''}`);
    }
    const tc = kid(n, 'tmCtxLst')?.kids[0]?.attrs; // start/dur in ms, untilEnd
    if (tc) {
      const start = num(tc.start) ?? 0, dur = num(tc.dur);
      if (start > 0) o.start = start;
      if (tc.untilEnd === 'false' && dur >= 0) o.end = start + dur;
    }
    if (n.attrs.initState && n.attrs.initState !== 'Normal') note(n, 'object.initialState', `initial state "${n.attrs.initState}" is not imported (editor vs runtime meaning is open)`);
    for (const [part, key] of [['entr', 'enter'], ['exit', 'exit']]) { // animEffect/entr|exit/<effect dur dir lvl ...>
      const e = kid(kid(n, 'animEffect'), part)?.kids[0];
      if (!e) continue;
      const m = /^PT(\d+(?:\.\d+)?)S$/.exec(e.attrs.dur ?? ''), effect = { fade: 'fade', fly: 'fly' }[e.tag];
      if (!effect || !m) { note(e, 'object.animation', `${key === 'enter' ? 'entrance' : 'exit'} effect <${e.tag}> is not supported yet (Fade and Fly In are)`); continue; }
      o[key] = { effect, duration: Math.min(5, Math.max(0.1, Number(m[1]))) };
      if (effect === 'fly') { // dir "b" observed; the other codes are inferred to be the same compass letters
        if (FLY_DIRS.has(e.attrs.dir)) o[key].direction = e.attrs.dir;
        else note(e, 'object.animation.direction', `fly direction "${e.attrs.dir}" has no mapping; from the bottom is used`);
      }
      if (e.attrs.lvl && e.attrs.lvl !== 'none') note(e, 'object.animation.sequence', 'by-paragraph sequencing is not imported; the object animates as one');
    }
    if (kid(n, 'hLink')?.attrs.enabled === 'true') note(n, 'object.hyperlink', 'object hyperlinks are not imported');
    for (const s of states) {
      const name = s.attrs.name ?? '';
      if (kids(kid(s, 'trigLst')).length) note(s, 'state.triggers', 'triggers inside states are not imported');
      if (name === 'Normal') continue;
      const key = STATES[name] ?? (/^[a-z][a-z0-9_-]*$/.test(name.toLowerCase()) ? name.toLowerCase() : null);
      if (!key) { note(s, 'state.name', `state "${name}" has no mapping`); continue; }
      const sn = snapshot(s), ov = {};
      if (sn) {
        if (type !== 'image') { const st = textOf(sn); if (st && st !== textOf(normal ?? n)) ov.text = rewrite(st, sn); }
        let sf = fillOf(sn);
        if (type === 'button' && sn.attrs.cfDefaultButtonFill === 'true' && sf.fill === '#34449c') sf = {};
        if (sf.fill && sf.fill !== o.style?.fill) { ov.style = { fill: sf.fill }; if (sf.heuristic) noteGradient(sn); }
        else if (sf.issue) note(sn, 'style.fill', sf.issue);
        const border = borderOf(sn);
        if (Object.keys(border).length) ov.style = { ...ov.style, ...border };
        if (kid(sn, 'text')?.text.trim().startsWith('<')) note(sn, 'text.stateFormatting', 'state text remains plain; rich state formatting is not imported');
        if (type === 'image' && isG(sn.attrs.assetG) && sn.attrs.assetG !== n.attrs.assetG) { const img = assetFor(sn.attrs.assetG, sn); if (img) ov.image = img; }
      }
      (o.states ??= {})[key] = ov;
    }
    if (vector) {
      try {
        const geometry = vectorGeometry(n, o.w, o.h);
        const svg = pathSvg(geometry, o.style), stateSvgs = [];
        for (const [key, state] of Object.entries(o.states ?? {})) {
          const sn = snapshot(states.find(s => (STATES[s.attrs.name] ?? s.attrs.name?.toLowerCase()) === key));
          stateSvgs.push([state, pathSvg(sn && (kid(sn, 'points') || kid(sn, 'prstGeom')) ? vectorGeometry(sn, o.w, o.h) : geometry, { ...o.style, ...state.style })]);
        }
        o.image = derivedAsset(n, svg);
        for (const [state, stateSvg] of stateSvgs) {
          state.image = derivedAsset(n, stateSvg);
          delete state.style;
        }
        o.style = { fill: 'transparent' }; o.locked = true; nodes.get(o.id).derived = true;
        if (tag === 'noSymbol') note(n, 'heuristic.noSymbolBounds', 'prohibition symbol uses full destination bounds; native paint inset differs by up to one pixel');
      } catch (e) { ctx.objByG.delete(n.attrs.g); note(n, `object.${tag}`, e.message); return null; }
    }
    return o;
  }

  // List question encodings: format notes section 3.10. Resolve the whole key before consuming any objects.
  function mapQuestionList(qn, shapes, type) {
    const drag = qn.tag === 'matchDragDropIntr';
    const tag = type === 'sequence' ? (qn.tag === 'seqDropDownIntr' ? 'comboSeq' : 'seqDragDropItem') : drag ? 'matchDragDropItem' : 'intrLabelDropDown';
    const entries = shapes.filter(n => n.attrs.parentG === qn.attrs.g);
    const consumed = [...entries];
    if (!entries.length || entries.some(n => n.tag !== tag || !isG(n.attrs.g)) || new Set(entries.map(n => n.attrs.g)).size !== entries.length) {
      return fail('question.list', 'missing, duplicate or unsupported question rows; the entire question is skipped');
    }
    const label = n => textOf(n) || textOf(snapshot(statesOf(n).find(s => s.attrs.name === 'Normal')));
    if (type === 'sequence') {
      if (entries.length < 2 || entries.length > 26 || entries.some(n => !label(n))) return fail('question.list', 'sequence needs 2 to 26 labelled items; the entire question is skipped');
      const z = entries.map(n => num(n.attrs.zOrder));
      const ordered = z.every(n => Number.isInteger(n) && n >= 0) && new Set(z).size === z.length;
      if (ordered) entries.sort((a, b) => num(a.attrs.zOrder) - num(b.attrs.zOrder));
      note(qn, 'question.sequenceOrder', `correct sequence is inferred from ${ordered ? 'ascending zOrder' : 'document order (zOrder is incomplete or ambiguous)'}; verify the imported key`);
      return { fields: { choices: entries.map(n => ({ id: idFor('c', n.attrs.g), label: rewrite(label(n), n) })) }, consumed };
    }
    if (entries.length > 10) return fail('question.list', 'matching needs at most 10 rows; the entire question is skipped');
    const pairs = [];
    for (const row of entries) {
      const children = shapes.filter(n => n.attrs.parentG === row.attrs.g);
      const left = drag ? children.find(n => n.tag === 'matchDropArea') : row;
      const right = children.find(n => n.tag === (drag ? 'matchDragItem' : 'comboMatch'));
      if (children.length !== (drag ? 2 : 1) || !left || !right || !isG(right.attrs.g) || (drag && !isG(left.attrs.g))) return fail('question.list', 'missing or ambiguous matching pair; the entire question is skipped');
      const correct = drag ? '' : clean(kid(right, 'correctText')?.text ?? '');
      const answer = correct || label(right);
      if (!label(left) || !answer) return fail('question.list', 'matching row or answer text is empty; the entire question is skipped');
      pairs.push({ row, left, right, answer, inferred: !drag && !correct });
      consumed.push(...children);
    }
    if (new Set(consumed.map(n => n.attrs.g)).size !== consumed.length) return fail('question.list', 'duplicate matching object GUIDs; the entire question is skipped');
    const choices = [], rows = [], byLabel = new Map();
    for (const { row, left, right, answer, inferred } of pairs) {
      if (inferred) note(right, 'question.matchingKey', 'empty correctText; the combo object text is used as its paired answer (inferred from the corpus); verify the imported key');
      const text = rewrite(answer, right);
      if (!byLabel.has(text)) { const id = idFor('c', right.attrs.g); byLabel.set(text, id); choices.push({ id, label: text }); }
      rows.push({ id: idFor('r', row.attrs.g), label: rewrite(label(left), left), choice: byLabel.get(text) });
    }
    if (drag) note(qn, 'question.matchDragPresentation', 'parent-linked drop-area/drag-item text pairs imported as matching dropdown rows (ours); drag geometry and one-item drop presentation are not preserved');
    return { fields: { rows, choices }, consumed };
  }

  function mapQuestion(ctx) {
    const shapes = kids(kid(ctx.root, 'shapeLst'));
    const results = shapes.find((n) => n.tag === 'rsltsIntr');
    if (results) { ctx.consumed.add(results); if (!quizByResult.has(ctx.root.attrs.g)) note(results, 'quiz.results', 'results slide is not the results slide of any quiz'); }
    const qns = shapes.filter((n) => /Intr$/.test(n.tag) && n.tag !== 'rsltsIntr');
    if (!qns.length) return;
    const [qn, ...extra] = qns;
    for (const n of extra) note(n, 'question.extra', 'only one question per slide is imported');
    const type = QTYPE[qn.tag];
    if (!type) { note(qn, `question.${qn.tag}`, `<${qn.tag}> questions are not imported`); return; }
    const list = ['matching', 'sequence'].includes(type) ? mapQuestionList(qn, shapes, type) : null;
    if (list?.error) { note(qn, list.kind, list.error); return; }
    const areas = shapes.filter((n) => n.tag.startsWith('clkArea'));
    if (type === 'hotspot' && (qns.length !== 1 || areas.some((n) => !['clkAreaRect', 'clkAreaOval'].includes(n.tag)))) {
      note(qn, 'question.hotspot', 'ambiguous question grouping or unobserved area XML tag; hotspot question skipped'); return;
    }
    if (type === 'dragdrop' && !kids(kid(qn, 'choices'), 'intrFreeChoice').some((c) => isG(c.attrs.shpG))) { note(qn, 'question.dragDropIntr', '<dragDropIntr> without drag items (choices/intrFreeChoice@shpG) is not imported'); return; }
    const ip = kid(qn, 'intrProps')?.attrs ?? {};
    const byG = (g) => (isG(g) ? shapes.find((n) => n.attrs.g === g) : undefined);
    const q = { type, prompt: '' };
    ctx.consumed.add(qn);
    let titleBox = byG(ip.titleBoxG);
    if (!titleBox && !isG(ip.titleBoxG)) { // the title box is the slide's title placeholder; older files leave titleBoxG empty
      const ph = shapes.filter((n) => n.tag === 'textBox' && kid(n, 'ph')?.attrs.type === 'title');
      if (ph.length === 1) { titleBox = ph[0]; note(qn, 'question.promptFromTitle', 'titleBoxG is empty; the prompt is the slide title placeholder'); }
      if (!titleBox && type === 'hotspot') {
        const titles = shapes.filter((n) => n.tag === 'textBox' && n.attrs.name === '&Title');
        if (titles.length === 1) titleBox = titles[0];
      }
    }
    if (titleBox) { ctx.consumed.add(titleBox); q.prompt = rewrite(textOf(titleBox), titleBox); } else note(qn, 'question.prompt', 'question title box not found; prompt left empty');
    if (list) {
      Object.assign(q, list.fields);
      for (const n of list.consumed) ctx.consumed.add(n);
    } else if (type === 'fill') {
      q.answers = kids(kid(qn, 'choices'), 'intrFreeChoice').map((c) => clean(kid(c, 'text')?.text ?? '')).filter(Boolean);
      if (qn.attrs.case === 'true') q.caseSensitive = true;
      const box = byG(qn.attrs.textEntryG) ?? shapes.find((n) => n.tag === 'intrTextEntryBox');
      if (box) ctx.consumed.add(box);
    } else if (type === 'hotspot') { // rectangle observed; oval-to-ellipse mapping inferred
      q.areas = areas.map((n) => {
        ctx.consumed.add(n);
        const loc = kid(n, 'loc')?.attrs ?? {};
        const [l, t, r, b] = ['l', 't', 'r', 'b'].map((k) => num(loc[k]));
        const shape = n.tag === 'clkAreaRect' ? 'rect' : 'ellipse';
        if (shape === 'ellipse') note(n, 'question.hotspotShape', 'clkAreaOval tag and ellipse mapping are inferred; only rectangular area XML was observed');
        return { id: idFor('c', n.attrs.g), shape, x: l, y: t, w: r - l, h: b - t, correct: kid(n, 'scoreData')?.attrs.correct === 'true' };
      });
      note(qn, 'question.hotspotGrouping', 'all slide-level click areas were grouped with this question; check the hotspot areas');
    } else if (type === 'dragdrop') { // freeform drag and drop: options from the example census
      const pairs = kids(kid(qn, 'choices'), 'intrFreeChoice').map((c) => [c.attrs.shpG, isG(c.attrs.matchShpG) ? c.attrs.matchShpG : null]);
      const ddn = kid(qn, 'dragDrop');
      const dd = ddn?.attrs ?? {};
      const onlyOne = dd.onlyOne === 'true';
      ctx.dd = { qn, pairs, onlyOne };
      q.items = []; q.targets = []; // objects are mapped after the question: resolveDragDrop fills these
      if (pairs.some(([, m]) => !m)) note(qn, 'question.dragDropDistractor', 'choices without matchShpG are imported as distractors (missing-side choice contract)');
      const fits = onlyOne ? ['cntr', 'rand'] : ['tile'];
      if (dd.snapLoc && !fits.includes(dd.snapLoc)) note(ddn, 'question.dragDropLayout', `snapLoc "${dd.snapLoc}" with onlyOne="${dd.onlyOne}" is imported as ${onlyOne ? 'one centred item per target' : 'stacked items'}`);
      if (dd.returnStart === 'false') note(ddn, 'question.dragDropReturn', 'items dropped outside a target always return to their start in CF (returnStart="false" is not imported)');
      if (dd.returnMode && dd.returnMode !== 'any') note(ddn, 'question.dragDropReturnMode', `returnMode "${dd.returnMode}" has no evidenced meaning and is not imported`);
      if (dd.revealDrag === 'true') note(ddn, 'question.dragDropReveal', 'revealing drag items one at a time is not imported');
      if (dd.snapTarget === 'false') note(ddn, 'question.dragDropSnap', 'CF always snaps dropped items to the target');
      const listed = new Set(pairs.map(([s]) => s));
      if (descendants(kid(ddn, 'order'), 'g').some((g) => isG(g.text.trim()) && !listed.has(g.text.trim()))) note(ddn, 'question.dragDropOrder', 'drag objects listed only in dragDrop/order (not in choices) are not imported as items');
    } else {
      const top = (n) => [num(kid(n, 'loc')?.attrs.t) ?? 0, num(kid(n, 'loc')?.attrs.l) ?? 0];
      const choices = shapes.filter((n) => n.attrs.parentG === qn.attrs.g && (n.tag === 'radio' || n.tag === 'checkBox'))
        .sort((x, y) => top(x)[0] - top(y)[0] || top(x)[1] - top(y)[1]); // display order (childLst order differs)
      const marked = new Set(), scored = new Set();
      q.choices = choices.map((c) => {
        ctx.consumed.add(c);
        const normal = snapshot(statesOf(c).find((s) => s.attrs.name === 'Normal'));
        const id = idFor('c', c.attrs.g);
        track({ id }, c);
        if (c.attrs.initState === 'Selected') marked.add(id);
        if (kid(c, 'scoreData')?.attrs.correct === 'true') scored.add(id);
        return { id, label: rewrite(textOf(c) || (normal ? textOf(normal) : ''), c), correct: qn.attrs.cfKey === 'score' ? kid(c, 'scoreData')?.attrs.correct === 'true' : c.attrs.initState === 'Selected' };
      });
      if (titleBox && qn.attrs.cfLayout !== 'auto') {
        const box = n => {
          const loc = kid(n, 'loc')?.attrs ?? {}, [x, y, r, b] = ['l', 't', 'r', 'b'].map(k => num(loc[k]));
          const normal = snapshot(statesOf(n).find(s => s.attrs.name === 'Normal'));
          const style = resolvedTextStyle(n, normal, 'text');
          return [x, y, r, b].every(Number.isFinite) && r > x && b > y ? { x, y, w: r - x, h: b - y, ...(Object.keys(style).length ? { style } : {}) } : null;
        };
        const prompt = box(titleBox), positions = choices.map(box);
        if (prompt && positions.every(Boolean)) q.layout = { prompt, choices: positions.map((p, i) => ({ id: q.choices[i].id, ...p })) };
        else note(qn, 'question.layout', 'invalid authored question bounds; the standard question layout is used');
      }
      if (qn.attrs.cfKey !== 'score' && !sameSet(marked, scored)) note(qn, 'question.keyConflict', 'choices marked Selected differ from scoreData@correct; the Selected marking is used, as in the published course');
      if (type === 'tf') note(qn, 'question.trueFalse', 'true/false imported like multiple choice (same structure; no GUI experiment yet)');
    }
    const pts = num(ip.corPts);
    if (pts >= 0) q.points = pts;
    if (num(ip.incPts)) note(qn, 'question.incorrectPoints', 'points for incorrect answers are not imported');
    // "unlimited" (and the published sentinel 10000) = attempts 0; a plain count is kept.
    const attemptNames = ['unlimited', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const tries = attemptNames.includes(ip.attempts) ? attemptNames.indexOf(ip.attempts) : /^\d+$/.test(ip.attempts ?? '') ? Number(ip.attempts) % 10000 : undefined;
    if (tries !== undefined) q.attempts = tries; else note(qn, 'question.attempts', `attempts "${ip.attempts}" is not imported; 1 attempt`);
    q.shuffle = ip.shuffle === 'true';
    if (ip.branch && ip.branch !== 'none') note(qn, 'question.branching', 'question branching is not imported');
    if (ip.feedbk === 'none') note(qn, 'question.feedbackOff', 'questions without feedback are not supported; CF shows feedback');
    const layerNodes = kids(kid(ctx.root, 'sldLayerLst'));
    const fb = {};
    for (const [key, attr] of [['correct', 'corFbG'], ['incorrect', 'incFbG'], ['tryAgain', 'tryFbG']]) {
      const ln = isG(ip[attr]) && layerNodes.find((x) => x.attrs.g === ip[attr]);
      if (!ln) continue;
      ctx.consumed.add(ln);
      const texts = [];
      let standardTitle = false;
      for (const o of kids(kid(ln, 'shapeLst'))) {
        if (TEXTS.has(o.tag)) {
          const t = textOf(o), heading = { correct: 'correct', incorrect: 'incorrect', tryAgain: 'try again' }[key];
          if (kid(o, 'ph')?.attrs.type === 'title' && t.toLowerCase() === heading) standardTitle = true;
          else if (t) texts.push(rewrite(t, o));
        }
        else if (o.tag !== 'feedBackBtn') note(o, 'question.feedbackObject', 'feedback layers keep their text only');
        for (const t of kids(kid(o, 'trigLst'))) {
          const d = kid(t, 'data')?.attrs ?? {};
          if (!(d.action === 'hideSubSlide' || (d.action === 'jumpToSlide' && d.actSubType === 'next'))) note(t, 'question.feedbackTrigger', 'feedback layers import only the Continue behaviour (hide layer, next slide)');
        }
      }
      if (kids(kid(ln, 'trigLst')).length) note(ln, 'question.feedbackTrigger', 'feedback layer triggers are not imported');
      if (texts.length || standardTitle) fb[key] = texts.join('\n');
    }
    if (Object.keys(fb).length) q.feedback = { ...FEEDBACK_DEFAULT, ...fb };
    const ex = kid(kid(qn, 'intrProps'), 'exclQuizLst');
    const excl = new Set(descendants(ex).flatMap((k) => [k.text.trim(), ...Object.values(k.attrs)]).filter(isG));
    if (ex?.kids.length) note(ex, 'question.quizExclusion', 'exclQuizLst entries read as excluded quiz GUIDs (inferred)');
    ctx.slide.question = q; ctx.qG = qn.attrs.g;
    track(q, qn);
    questionSlides.push([ctx.slide, excl]);
  }

  /* * Drag items and targets are ordinary base-layer objects found by GUID; one-item targets
   *  when dragDrop@onlyOne is true, else stacked (example census: onlyOne true with cntr/rand, false with tile). */
  function resolveDragDrop(ctx) {
    const { qn, pairs, onlyOne } = ctx.dd;
    const base = new Set(ctx.slide.objects);
    const idOf = (g) => { const o = ctx.objByG.get(g); return o && base.has(o) ? o.id : null; };
    const sourceIds = new Set(kids(kid(ctx.root, 'shapeLst')).map(n => n.attrs.g));
    // Native freeform rows may have only one side. Existing but unsupported objects remain a loss.
    if (pairs.some(pair => pair.some(g => sourceIds.has(g) && !idOf(g)))) {
      note(qn, 'question.dragDropObjects', 'a drag item or drop target is not an imported base-layer object, so the question is not imported');
      delete ctx.slide.question;
      ctx.qG = null;
      questionSlides.splice(questionSlides.findIndex(([s]) => s === ctx.slide), 1);
      return;
    }
    const q = ctx.slide.question;
    q.items = pairs.filter(([s]) => idOf(s)).map(([s, m]) => ({ object: idOf(s), ...(idOf(m) ? { target: idOf(m) } : {}) }));
    q.targets = [...new Set(pairs.map(([, m]) => idOf(m)).filter(Boolean))].map((object) => ({ object, ...(onlyOne ? {} : { capacity: 'many' }) }));
  }

  function mapTriggers(node, out, ctx, owner) {
    for (const t of kids(kid(node, 'trigLst'))) {
      stats.source.triggers++;
      if (owner.consumed || consumedLinks.has(t)) { stats.consumed.triggers++; continue; }
      if (owner.dropped) { note(t, 'trigger.source', 'the object that fires this trigger is not imported'); continue; }
      const r = mapTrigger(t, ctx, owner);
      if (r === CONSUMED) { stats.consumed.triggers++; continue; }
      if (r.error) { note(t, r.kind, r.error); continue; }
      out.push(r.trigger); track(r.trigger, t);
      for (const x of r.approx) note(t, 'trigger.approximation', x);
    }
  }

  function mapTrigger(t, ctx, owner) {
    if (!TRIGGERS.has(t.tag)) return fail('trigger.element', `<${t.tag}> triggers are not imported`);
    const d = kid(t, 'data');
    if (!d) return fail('trigger.data', 'trigger has no data block');
    const { event, action, actSubType: sub, NavigationIntent: intent } = d.attrs;
    const conds = kids(kid(t, 'condLst'), 'trigCond');
    const els = kid(d, 'elseTrigger');
    if (owner.kind === 'slide' && !t.attrs.cfId && !conds.length && !els && d.attrs.enabled !== 'false') { // the default player buttons: CF does the same by default
      if (event === 'OnNextButtonClick' && action === 'jumpToSlide' && sub === 'next') return CONSUMED;
      if (event === 'OnClick' && intent === 'Previous' && action === 'jumpToSlide' && sub === 'prev') return CONSUMED;
    }
    if (owner.kind === 'slide' && action === 'submitInteraction' && event === 'OnClick') {
      if (!t.attrs.cfId && ctx.qG && kid(d, 'interaction')?.attrs.submitG === ctx.qG) return CONSUMED; // CF draws its own Submit button
      if (!ctx.qG) return fail('trigger.source', 'submit trigger of a question that is not imported');
    }
    const approx = [];
    const on = mapEvent(d, owner, approx);
    if (on.error) return on;
    const act = mapAction(d, ctx, owner, approx);
    if (act.error) return act;
    const cond = conds.length ? mapConds(conds) : null;
    if (cond?.error) return cond;
    let alt = null;
    if (els) {
      if (kids(kid(els, 'condLst'), 'trigCond').length) return fail('trigger.condition', 'else-if branches are not evidenced');
      alt = mapAction(kid(els, 'data') ?? { attrs: {}, kids: [] }, ctx, owner, approx);
      if (alt.error) return { ...alt, error: 'else: ' + alt.error };
    }
    const trigger = { id: idFor('t', t.attrs.g) };
    if (t.attrs.name?.trim()) trigger.name = t.attrs.name.trim();
    Object.assign(trigger, { on }, cond && { if: cond }, { do: [act] }, alt && { else: [alt] }, d.attrs.enabled === 'false' && { enabled: false });
    return { trigger, approx };
  }

  function mapEvent(d, owner, approx) {
    const { event, NavigationIntent: intent } = d.attrs;
    const obj = owner.kind === 'object';
    switch (event) {
      case 'OnClick':
        if (obj) return { event: 'click', target: owner.id };
        if (owner.kind === 'slide' && intent === 'Previous') return { event: 'playerPrev' };
        if (owner.kind === 'slide' && intent === 'Next') { approx.push('slide-level OnClick with NavigationIntent Next imported as playerNext (inferred from the Previous encoding)'); return { event: 'playerNext' }; }
        return fail('trigger.event', `OnClick on a ${owner.kind} has no evidenced source`);
      case 'OnNextButtonClick': return obj ? fail('trigger.event', 'OnNextButtonClick on an object') : { event: 'playerNext' };
      case 'OnStart': return obj ? fail('trigger.event', 'object timeline-start triggers are not imported') : { event: 'timelineStart' };
      case 'OnEnd': return obj ? fail('trigger.event', 'object timeline-end triggers are not imported') : { event: 'timelineEnd' };
      case 'OnVariableValueChange': {
        const v = vars.get(kid(d, 'other')?.attrs.varChangeG);
        return v?.kind === 'user' ? { event: 'varChange', var: v.name } : fail('trigger.variable', 'variable-change trigger on a variable that is not imported');
      }
      case 'OnMouseHover':
        if (!obj) break;
        approx.push('OnMouseHover imported as hoverEnter; restore-on-mouse-leave is not evidenced');
        return { event: 'hoverEnter', target: owner.id };
    }
    return fail('trigger.event', `event "${event}" is not supported yet`);
  }

  function mapAction(d, ctx, owner, approx) {
    const { action: a, actSubType: sub } = d.attrs;
    const other = kid(d, 'other')?.attrs ?? {};
    switch (a) {
      case 'jumpToSlide':
        if (sub === 'next' || sub === 'prev') return { action: 'jump', to: sub };
        if (sub === 'spec') { const s = slideByG.get(kid(d, 'slide')?.attrs.jumpG); return s ? { action: 'jump', to: s.id } : fail('trigger.target', 'jump target slide is not imported'); }
        break;
      case 'jumpToScene':
        if (sub === 'spec') { const sc = sceneByG.get(kid(d, 'scene')?.attrs.jumpG); return sc ? { action: 'jumpScene', to: sc.id } : fail('trigger.target', 'jump target scene is not imported'); }
        break;
      case 'showSubSlide': { const l = ctx.layerByG.get(kid(d, 'sldLayer')?.attrs.showG); return l ? { action: 'showLayer', layer: l.id } : fail('trigger.target', 'layer to show is not imported on this slide'); }
      case 'hideSubSlide': {
        const g = kid(d, 'sldLayer')?.attrs.hideG;
        const l = ctx.layerByG.get(g);
        if (l) return { action: 'hideLayer', layer: l.id };
        if (sub === 'me' && owner.layer && !isG(g)) return { action: 'hideLayer' };
        return fail('trigger.target', 'layer to hide is not imported on this slide');
      }
      case 'changeShapeState': {
        const sh = kid(d, 'shape')?.attrs ?? {};
        const o = ctx.objByG.get(sh.setStateG);
        if (!o) return fail('trigger.target', 'state target object is not imported');
        if (sh.setstateop && sh.setstateop !== 'ass') return fail('trigger.action', `state operation "${sh.setstateop}" is not evidenced`);
        const st = STATES[sh.setStateName] ?? (/^[a-z][a-z0-9_-]*$/.test((sh.setStateName ?? '').toLowerCase()) ? sh.setStateName.toLowerCase() : null);
        return st ? { action: 'setState', target: o.id, state: st } : fail('trigger.state', `state "${sh.setStateName}" has no mapping`);
      }
      case 'adjustVar': {
        const v = vars.get(other.varG);
        if (v?.kind !== 'user') return fail('trigger.variable', 'adjusted variable is not a user variable');
        if (other.useRandom === 'true') return fail('trigger.action', 'random values are not imported');
        if (other.op === 'not' && v.type === 'boolean') return { action: 'setVar', var: v.name, op: 'toggle' };
        if (other.useVar === 'true') return fail('trigger.action', 'values from another variable are not evidenced');
        if (other.op === 'ass' && v.type === 'text') return { action: 'setVar', var: v.name, op: 'set', value: other.varVal1 ?? '' };
        const n = num(other.dblVal);
        if (other.op === 'add' && v.type === 'number' && n !== undefined) return { action: 'setVar', var: v.name, op: 'add', value: n };
        if (other.op === 'ass' && v.type === 'number' && n !== undefined) { approx.push('number assignment read from dblVal (inferred from the Add encoding)'); return { action: 'setVar', var: v.name, op: 'set', value: n }; }
        return fail('trigger.action', `adjust variable "${other.op}" on a ${v.type} variable is not evidenced`);
      }
      case 'submitInteraction': return ctx.slide.question ? { action: 'submit' } : fail('trigger.action', 'submit outside an imported question slide');
      case 'jumpToFileUrl': {
        const u = (other.open ?? '').trim();
        return /^(https?:\/\/\S+|mailto:\S+)$/.test(u) ? { action: 'openUrl', url: u } : fail('trigger.action', 'only http(s) and mailto links are imported');
      }
      case 'sendEmail': {
        const e = (other.email ?? '').trim();
        return e && !/\s/.test(e) ? { action: 'openUrl', url: 'mailto:' + e } : fail('trigger.action', 'email trigger without a usable address');
      }
      case 'SubmitQuizSL': case 'ResetQuizSL': {
        const q = quizByResult.get(kid(d, 'customData')?.attrs.g);
        return q ? { action: a === 'SubmitQuizSL' ? 'submitQuiz' : 'resetQuiz', quiz: q.id } : fail('trigger.target', 'quiz of this results action is not imported');
      }
      case 'ReviewQuizSL': { // same customData encoding as Submit/Reset
        const q = quizByResult.get(kid(d, 'customData')?.attrs.g);
        if (!q) return fail('trigger.target', 'quiz of this review action is not imported');
        const qa = quizNodes[quizzes.indexOf(q)].attrs; // option meanings inferred from the attribute names
        if (qa.reviewincorrectquestionsonly === 'true') approx.push('review of incorrect questions only is not supported: every question is reviewed');
        if (qa.showcorrectincorrectinreview === 'false') approx.push('review without correct/incorrect marks is not supported: marks are shown');
        return { action: 'reviewQuiz', quiz: q.id };
      }
      case 'executeJavaScript': return fail('trigger.action', 'JavaScript triggers are not imported');
    }
    return fail('trigger.action', `action "${a}"${sub ? ` (${sub})` : ''} is not supported yet`);
  }

  function mapConds(conds) { // (value), (var vs var)
    const all = [];
    const condVar = (g) => { const v = vars.get(g); return v && (v.kind === 'user' || v.kind === 'quiz') ? v : null; };
    for (const c of conds) {
      const a = c.attrs;
      if (a.andOr !== 'and') return fail('trigger.condition', `"${a.andOr}" joins are not evidenced`);
      if (a.lightBox === 'true') return fail('trigger.condition', 'lightbox conditions are not imported');
      if (isG(kid(c, 'shapeState')?.attrs.shapeG)) return fail('trigger.condition', 'object-state conditions are not evidenced');
      const op = OPS[a.op];
      if (!op) return fail('trigger.condition', `operator "${a.op}" is not evidenced`);
      const v = condVar(a.varG);
      if (!v) return fail('trigger.condition', 'condition variable is not imported');
      if (a.dataType === 'var') { const w = condVar(a.varG2); if (!w) return fail('trigger.condition', 'compared variable is not imported'); all.push({ var: v.name, op, otherVar: w.name }); }
      else if (a.dataType === 'value' && v.type === 'number' && num(a.floatVal1) !== undefined) all.push({ var: v.name, op, value: num(a.floatVal1) });
      else return fail('trigger.condition', `${a.dataType} comparison on a ${v.type} variable is not evidenced`);
    }
    return { all };
  }

  function submitFirst(root, slide) {
    // CF sets quiz variables when the quiz is submitted; Storyline keeps them live. So the results slide's
    // "submit results" must run before the conditions that read the score (same outcome, CF order).
    const starts = slide.triggers.filter((t) => t.on.event === 'timelineStart');
    const first = starts.findIndex((t) => t.do[0].action === 'submitQuiz');
    if (first <= 0) return;
    const ordered = [...starts.filter((t) => t.do[0].action === 'submitQuiz'), ...starts.filter((t) => t.do[0].action !== 'submitQuiz')];
    let i = 0;
    slide.triggers = slide.triggers.map((t) => (t.on.event === 'timelineStart' ? ordered[i++] : t));
    note(root, 'trigger.reordered', 'quiz submit moved before the other timeline-start triggers (CF computes quiz variables on submit)');
  }

  // ----- quizzes: membership and results -----
  // explicit slide GUIDs plus defaults before this result in its own scene, bounded by other results.
  const exclOf = new Map(questionSlides.map(([s, excl]) => [s.id, excl]));
  for (const [root, s] of draws) exclOf.set(s.id, new Set(kids(kid(root, 'excLst')).map(n => n.text.trim())));
  const flowIds = scenes.flatMap((sc) => sc.slides);
  const resultIds = new Set([...quizNodes.map(q => slideByG.get(q.attrs.resultSldG)?.id), ...parts.filter(([root]) => kids(kid(root, 'shapeLst')).some(n => n.tag === 'rsltsIntr')).map(([,s]) => s.id)].filter(Boolean));
  const explicit = quizNodes.map(qn => new Set(kids(kid(qn, 'questionIdLst')).map(n => slideByG.get(n.text.trim())?.id).filter(id => exclOf.has(id) && !resultIds.has(id))));
  const allExplicit = new Set(explicit.flatMap(ids => [...ids]));
  const orderedIds = [...flowIds, ...banks.flatMap(b => b.slides)];
  quizzes.forEach((quiz, i) => {
    const qn = quizNodes[i], rs = slideByG.get(qn.attrs.resultSldG), selected = explicit[i];
    const scene = scenes.find(sc => sc.slides.includes(rs?.id));
    let collecting = false;
    for (const id of [...scene?.slides ?? []].reverse()) {
      if (resultIds.has(id)) { collecting = id === rs?.id; continue; }
      if (collecting && !allExplicit.has(id) && exclOf.has(id) && !exclOf.get(id).has(qn.attrs.g)) selected.add(id);
    }
    quiz.questions = orderedIds.filter(id => selected.has(id));
    for (const id of quiz.questions) {
      const draw = slides.find(s => s.id === id)?.draw;
      if (!draw) continue;
      const candidates = banks.find(b => b.id === draw.bank).slides.filter(id => !draw.never.includes(id));
      if (candidates.some(id => exclOf.get(id)?.has(qn.attrs.g))) note(qn, 'draw.quizMembership', 'a selected draw has bank questions with per-quiz exclusions; CF scores every drawn question and those member-specific exclusions are not represented');
    }
    if (rs) quiz.results = rs.id; else note(qn, 'quiz.results', 'results slide is not imported');
  });

  // Keep supported library media even before an object references it (native asset.add).
  if (assetsDir) for (const [g, m] of media) if (MEDIA[m.attrs.type] && !attemptedAssets.has(g)) assetFor(g, m, Object.keys(MEDIA));

  // ----- course -----
  const core = zip.names.find((n) => /^package\/services\/metadata\/core-properties\/[^/]+\.psmdcp$/.test(n));
  let coreTitle = '';
  if (core) try { coreTitle = descendants(xml(core), 'dc:title')[0]?.text.trim() ?? ''; } catch { /* optional part */ }
  const doc = {
    schema: SCHEMA_VERSION,
    id: isG(story.attrs.id) ? `course-${story.attrs.id.replace(/-/g, '').slice(0, 12).toLowerCase()}` : 'course',
    title: props.find((p) => p.attrs.id === '5')?.text.trim() || coreTitle || title || 'Imported course',
    ...(w >= 100 && h >= 100 ? { size: { w, h } } : {}),
    variables, scenes, banks, slides, quizzes, assets,
  };
  if (!(w >= 100 && h >= 100)) note('story/story.xml#/story/propLst', 'course.size', 'slide size not found; CF default size used');
  if (zip.names.some((n) => n.startsWith('story/slideLayouts/') || n.startsWith('story/slideMasters/'))) note('story/slideLayouts', 'layout', 'placeholder styles (ph), button placeholders (btnPh), objects of layer and feedback layouts and the showMasterSp flag are not imported; master/layout objects and backgrounds are imported per slide');
  // native player selection is separate from its opaque theme/control settings.
  const playerRel = zip.has('story/_rels/story.xml.rels') ? kids(xml('story/_rels/story.xml.rels'), 'Relationship').find(r => r.attrs.Id === 'rId5') : null;
  const playerPart = playerRel?.attrs.Target ? path.posix.normalize(playerRel.attrs.Target.startsWith('/') ? playerRel.attrs.Target.slice(1) : 'story/' + playerRel.attrs.Target) : null;
  if (playerPart && zip.has(playerPart)) {
    const player = xml(playerPart), type = kid(player, 'playerType')?.text.trim();
    if (player.tag === 'player' && ['unified', 'classic'].includes(type)) doc.player = { menu: true, prevNext: true, resume: 'prompt', style: type === 'unified' ? 'modern' : 'classic' };
    note(playerPart, 'player', 'player style imported; native colors, controls and other settings are preserved in the package but not rendered by CF');
  }
  const manager = kid(story, 'quizMgr')?.attrs ?? {};
  // prop 3 contains saved publish state; Reach settings are a different destination.
  let status, nativeReporting = false;
  const publishState = props.find(p => p.attrs.id === '3')?.text.trim();
  if (publishState) try {
    const state = parseXml(publishState), lms = state.tag === 'state' && kid(state, 'lms');
    nativeReporting = Boolean(lms);
    if (lms) status = { PassedIncomplete: 'passed-incomplete', PassedFailed: 'passed-failed', CompletedIncomplete: 'completed-incomplete', CompletedFailed: 'completed-failed' }[lms.attrs.reporting];
  } catch { nativeReporting = true; /* malformed native state must not be hidden by an old CF marker */ }
  const trackedQuiz = manager.trackMode === 'result' && quizByResult.get(manager.lmsResultSlideG);
  if (!nativeReporting && trackedQuiz && ['passed-incomplete', 'passed-failed', 'completed-incomplete', 'completed-failed'].includes(manager.cfTrackingStatus)) {
    doc.tracking = { complete: [{ quiz: trackedQuiz.id }], status: manager.cfTrackingStatus }; // Legacy CF metadata only when direct native reporting is absent.
  } else {
    const aliases = { none: 'None', def: 'Default', slide: 'Slides', result: 'Results', trigger: 'Trigger' };
    const flags = new Set((manager.trackMode ?? '').split(',').map(s => aliases[s.trim()] ?? s.trim()));
    const eligible = quizNodes.map(qn => submittedResults.has(qn.attrs.resultSldG) && quizByResult.get(qn.attrs.resultSldG)).filter(q => q?.results);
    const completeTrigger = [...parts, ...draws].some(([root]) => [root, themeFor(root).layout].some(r => descendants(r, 'data').some(d => d.attrs.action === 'CompleteCourse' && d.attrs.enabled !== 'false')));
    // Results is derived from enabled submissions regardless of the saved legacy selection.
    if (eligible.length) flags.add('Results'); else flags.delete('Results');
    if (completeTrigger) flags.add('Trigger'); else flags.delete('Trigger');
    if (flags.has('Default')) {
      if (eligible.length || flags.has('Trigger')) flags.delete('Slides');
      else if (!items.some(i => i.kind === 'trigger.action')) flags.add('Slides');
      else { flags.delete('Slides'); note(quizMgr, 'tracking.default', 'default tracking with unsupported trigger actions is not resolved'); }
    }
    const complete = [], number = num(manager.slidesViewedNumber);
    const fixedFlow = !banks.length && !slides.some(s => s.draw) && new Set(flowIds).size === slides.length && stats.source.slides === slides.length;
    // a regular scene counts ordinary slides plus requested draws, never the bank pool.
    // shortcut: all-question draws and wholly excluded scenes stay reported until their counting membership is represented.
    const projectTotal = scenes.reduce((total, scene) => {
      if (scene.slides.length && scene.slides.every(id => nodes.get(id)?.node.attrs.includeInSlideCounts === 'false')) return NaN;
      return total + scene.slides.reduce((n, id) => {
        const s = slides.find(s => s.id === id);
        return n + (s?.draw ? (s.draw.count > 0 ? s.draw.count : NaN) : 1);
      }, 0);
    }, 0);
    if (flags.has('Slides')) {
      if (manager.totalSlidesSource === 'project' && manager.slidesViewedUnit === 'Count' && Number.isInteger(number)
        && Number.isFinite(projectTotal) && projectTotal > 0) {
        complete.push({ slidesViewedCount: number <= 0 || number >= projectTotal ? projectTotal : number });
      } else if (manager.totalSlidesSource === 'project' && manager.slidesViewedUnit === 'Percentage' && fixedFlow && number >= 1 && number <= 100) {
        complete.push({ slidesViewed: number });
      } else note(quizMgr, 'tracking.slides', 'unsupported slide-tracking denominator or threshold; project counts below total and fixed-flow project percentages are imported');
    }
    for (const quiz of eligible) complete.push({ quiz: quiz.id });
    if ([...flags].some(f => !['None', 'Default', 'Slides', 'Results'].includes(f))) note(quizMgr ?? story, 'tracking.flags', 'unsupported tracking flags or complete-course trigger criteria are not imported');
    if (status && complete.length) doc.tracking = { complete, status };
    else note('story/story.xml#/story/quizMgr', 'tracking', 'no supported combination of LMS reporting and tracking settings was found; CF default tracking applies');
  }

  repair(doc);
  if (pending.length) {
    // Confinement on the REAL path (junctions and symlinks resolved) and never overwrite (review 003 #1/#2).
    const target = path.resolve(assetsDir);
    if (courseDir) {
      const base = fs.realpathSync(courseDir);
      const inside = (p) => { const r = path.relative(base, p); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); };
      let probe = target;
      while (!fs.existsSync(probe)) probe = path.dirname(probe);
      if (!inside(fs.realpathSync(probe))) throw new Error(`assets folder resolves outside the course folder: ${target}`);
      fs.mkdirSync(target, { recursive: true });
      if (!inside(fs.realpathSync(target))) throw new Error(`assets folder resolves outside the course folder: ${target}`);
    } else fs.mkdirSync(target, { recursive: true });
    for (let [file, data] of pending) {
      const identical = (f) => fs.lstatSync(f).isFile() && fs.readFileSync(f).equals(data);
      if (reuseAssets && fs.existsSync(file)) {
        if (identical(file)) continue;
        // Same native media id can hold different bytes after edits/undo; give each version a distinct cache URL.
        const original = file, ext = path.extname(file), hash = crypto.createHash('sha256').update(data).digest('hex');
        file = file.slice(0, -ext.length) + '-' + hash + ext;
        const asset = doc.assets.find(a => path.resolve(courseDir, a.path) === original);
        if (asset) asset.path = path.relative(courseDir, file).split(path.sep).join('/');
        if (fs.existsSync(file)) {
          if (identical(file)) continue;
          throw new Error('extracted asset cache conflict; choose another assets folder');
        }
      }
      fs.writeFileSync(file, data, { flag: 'wx' }); // never overwrite or follow an existing link
    }
  }
  const sum = (f) => doc.slides.reduce((n, s) => n + f(s), 0);
  const mapped = {
    scenes: doc.scenes.length, slides: doc.slides.length, layers: sum((s) => s.layers.length),
    objects: sum((s) => s.objects.length + s.layers.reduce((n, l) => n + l.objects.length, 0)),
    triggers: sum((s) => s.triggers.length + s.layers.reduce((n, l) => n + l.triggers.length, 0)),
    variables: doc.variables.length, questions: sum((s) => (s.question ? 1 : 0)), quizzes: doc.quizzes.length, assets: doc.assets.length,
    banks: doc.banks.length, bankSlides: doc.banks.reduce((n, b) => n + b.slides.length, 0), draws: sum((s) => (s.draw ? 1 : 0)),
  };
  return { doc, report: { ...stats, mapped, items }, nodes, textScale };

  /** Remove whatever validate() still rejects (nearest trigger, object, layer, question, ...) and report it. */
  function repair(d) {
    for (let guard = 0; guard < 100000; guard++) {
      const errs = validate(d);
      if (!errs.length) return;
      const e = errs[0];
      const seg = e.path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
      const removed = removeAt(d, seg);
      if (removed === undefined) throw new Error(`import produced an invalid course: ${e.path} ${e.message}`);
      const from = removed && typeof removed === 'object' && origin.get(removed);
      items.push({ path: from ? where(from) : e.path, kind: 'invalid', reason: `${e.message} (removed)` });
    }
    throw new Error('import: validation repair did not converge');
  }
  function removeAt(d, [k0, i0, k1, i1, k2, i2]) {
    const cut = (list, i) => (list && list[i] !== undefined ? list.splice(i, 1)[0] : undefined);
    if (k0 === 'slides' && d.slides[i0]) {
      const s = d.slides[i0];
      if (k1 === 'question') { const q = s.question; delete s.question; return q; }
      if ((k1 === 'objects' || k1 === 'triggers') && i1 !== undefined) return cut(s[k1], i1);
      if (k1 === 'layers' && i1 !== undefined) return (k2 === 'objects' || k2 === 'triggers') && i2 !== undefined ? cut(s.layers[i1]?.[k2], i2) : cut(s.layers, i1);
      return cut(d.slides, i0);
    }
    if (k0 === 'quizzes' && d.quizzes[i0]) {
      if (k1 === 'questions' && i1 !== undefined) return cut(d.quizzes[i0].questions, i1);
      if (k1 === 'results') { const q = d.quizzes[i0]; delete q.results; return q; }
      return cut(d.quizzes, i0);
    }
    if ((k0 === 'scenes' || k0 === 'banks') && k1 === 'slides' && i1 !== undefined) return cut(d[k0][i0]?.slides, i1);
    if (['scenes', 'banks', 'variables', 'assets'].includes(k0) && i0 !== undefined) return cut(d[k0], i0);
    return undefined;
  }
}

/** Compact counts for front-ends: source, mapped, consumed (absorbed into CF questions/defaults), reported by kind. */
export function summarize(report) {
  const byKind = {};
  for (const it of report.items) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
  return {
    source: report.source, mapped: report.mapped, consumed: report.consumed, reported: report.items.length,
    byKind: Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))),
  };
}

const fileError = (p, code, message, hint) => Object.assign(new Error(message), { errors: [{ path: p, code, message, ...(hint && { hint }) }] });

/**
 * Shared by `cf import`, MCP `import_story` and `POST /api/import`: import `storyPath` into a new course file.
 * Media go to `assetsDir` (default `<course dir>/assets/<name>/`, must be inside the course dir); the full report
 * goes to `<name>.import-report.json` next to the course. Throws {errors} when it cannot import.
 */
export function importStoryFile(storyPath, outFile, { assetsDir } = {}) {
  if (fs.existsSync(outFile)) throw fileError('/file', 'dupe', `already exists: ${outFile}`, 'choose another output file, or delete the existing one first');
  if (!fs.existsSync(storyPath) || !fs.statSync(storyPath).isFile()) throw fileError('/story', 'ref', `file not found: ${storyPath}`);
  const dir = path.dirname(path.resolve(outFile));
  const name = path.basename(outFile).replace(/\.course\.json$|\.json$/i, '') || 'course';
  const assets = path.resolve(assetsDir ?? path.join(dir, 'assets', name));
  const rel = path.relative(dir, assets);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw fileError('/assets', 'path', 'the assets folder must be inside the course folder', `for example ${path.join(dir, 'assets', name)}`);
  const reportFile = path.join(dir, `${name}.import-report.json`);
  if (fs.existsSync(reportFile)) throw fileError('/file', 'dupe', `already exists: ${reportFile}`, 'another import already uses this name; choose another output file');
  if (fs.existsSync(assets) && fs.readdirSync(assets).length) throw fileError('/assets', 'dupe', `assets folder is not empty: ${assets}`, 'another course uses it; choose another output file or assets folder');
  let r;
  try { r = importStory(storyPath, { assetsDir: assets, courseDir: dir }); } catch (e) { throw fileError('/story', 'import', e.message); }
  fs.rmSync(outFile + '.history.json', { force: true }); // a leftover history would undo into another course
  saveCourse(outFile, r.doc);
  const summary = summarize(r.report);
  fs.writeFileSync(reportFile, JSON.stringify({ source: path.basename(storyPath), summary, items: r.report.items }, null, 2) + '\n');
  return { ok: true, file: outFile, assets: assets, reportFile, summary };
}
