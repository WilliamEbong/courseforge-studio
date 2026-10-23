// Publisher: web and SCORM 1.2 folders, the editor preview page, and a package checker.
import fs from 'node:fs';
import path from 'node:path';
import { validate, normalize } from '../schema/index.js';
import { PRESETS } from '../schema/themes.js';
import { runtimeBundle, playerBundle } from './bundle.js';
import { manifest } from './scorm12-manifest.js';
import { writeZip } from './zip.js';
import { publishPptx as writePptx } from './pptx.js';
export { publishQuestions } from './questions.js';
export const publishPptx = (doc, out, options = {}) => writePptx(doc, out, { ...options, planAssets });

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const PLAYER_CSS = '../player/cf-player.css', SCORM_JS = './cf-scorm.js';
const LESSONS_JS = '../player/cf-lessons.js', LESSONS_CSS = '../player/cf-lessons.css';
// Compared lowercased: on case-insensitive file systems CF-PLAYER.JS would replace cf-player.js.
const RESERVED = new Set(['index.html', 'course.js', 'cf-captions.js', 'cf-runtime.js', 'cf-player.js', 'cf-player.css', 'cf-lessons.js', 'cf-lessons.css', 'cf-scorm.js', 'imsmanifest.xml', '.cf-publish.json']);
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'";
// Packages with captions add media-src blob: their tracks are built from blobs, because Chrome refuses
// <track src> from file:// pages.
const CSP_CAPTIONS = CSP.replace("img-src 'self' data:;", "img-src 'self' data:; media-src 'self' blob:;");
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Inline <script> content must not close the element early; `<` in JSON is escaped the same way JS reads it.
// Course text and learner-click links are data, just like captions; escape slashes so URL text is not mistaken for a remote load.
const courseJs = (d) => `window.CF_COURSE = ${JSON.stringify(d).replace(/</g, '\\u003c').replace(/\//g, '\\/')};\n`;
const inlineJs = (s) => s.replace(/<\/script/gi, '<\\/script');

// ---------- browser boot code: plain ES2017 functions, inlined with toString() ----------

/* * Runtime interaction record -> CFScorm record (item 5). */
export function toScormInteraction(r) {
  var type = r.type === 'tf' ? 'true-false' : r.type === 'fill' ? 'fill-in' : r.type === 'matching' || r.type === 'dragdrop' ? 'matching' : r.type === 'sequence' ? 'sequencing' : 'choice';
  var out = { id: String(r.id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 255) || 'interaction', type: type, result: r.result === 'correct' ? 'correct' : 'wrong', weighting: r.weighting };
  if (typeof r.latencyMs === 'number' && r.latencyMs >= 0) out.latencyMs = r.latencyMs; // vendor reports latency
  if (typeof r.objective === 'string' && /^[A-Za-z0-9_.-]{1,255}$/.test(r.objective)) out.objective = r.objective;
  if (type === 'choice' || type === 'matching' || type === 'sequencing') { // matching: [[source, target], ...]; sequencing: ordered indices
    out.response = r.response; out.correct = r.correct;
    if (r.type === 'hotspot') out.anyOf = true; // any correct area counts
  }
  else if (type === 'fill-in') { out.response = String(r.response); out.correct = r.correct; }
  else {
    // true/false comes from the chosen label (first choice = true when the label says neither); tf has exactly
    // one correct choice of two, so the correct value follows from the result.
    var label = String((r.responseLabels || [])[0] || '').trim();
    out.response = /^(true|yes|t|y)$/i.test(label) ? true : /^(false|no|f|n)$/i.test(label) ? false : r.response[0] === 0;
    out.correct = out.result === 'correct' ? out.response : !out.response;
  }
  return out;
}

function boot(scorm) {
  'use strict';
  var doc = window.CF_COURSE;
  var lms;
  if (scorm) {
    // snapshot: the adapter saves the live state one last time before LMSFinish (closing mid-slide keeps typed input).
    var ad = window.CFScorm.createScormAdapter({ win: window, courseId: doc.id, tracking: doc.tracking, snapshot: function () { return rt && rt.snapshot(); } });
    lms = { init: ad.init, status: ad.status, score: ad.score, save: ad.save, exit: ad.exit, interaction: function (r) { ad.interaction(toScormInteraction(r)); } };
  } else {
    var key = 'cf:' + doc.id;
    lms = {
      init: function () { try { return JSON.parse(window.localStorage.getItem(key)); } catch (e) { return null; } },
      save: function (s) { try { window.localStorage.setItem(key, JSON.stringify(s)); return true; } catch (e) { return false; } },
    };
    window.addEventListener('pagehide', function () { if (rt) lms.save(rt.snapshot()); });
  }
  var snap = lms.init();
  lms.init = function () { return snap; }; // runtime.start() asks again; the LMS can only be initialized once
  var rt = window.CFRuntime.createRuntime(doc, { lms: lms });
  var ask = snap && (snap.v === 1 || snap.v === 2 && doc.mode !== 'lessons') && doc.player.resume === 'prompt' ? snap : false;
  window.CFPlayer.mount(document.getElementById('cf-root'), { runtime: rt, resumePrompt: ask, captions: window.CF_CAPTIONS });
}

function bootPreview(assetsBase) {
  'use strict';
  // FR-C8: the editor opens the preview where the author is working (?slide=<id> or ?lesson=<id>)
  var at = /[?&](slide|lesson)=([^&]+)/.exec(window.location.search);
  var rt = window.CFRuntime.createRuntime(window.CF_COURSE, at && at[1] === 'slide' ? { startAt: decodeURIComponent(at[2]) } : {}); // not the learner menu, which may be off (007 #10)
  var panel = document.getElementById('cf-debug');
  var btn = document.getElementById('cf-debug-toggle');
  var stateEl = document.getElementById('cf-debug-state');
  var traceEl = document.getElementById('cf-debug-trace');
  function update() {
    if (panel.hidden) return;
    var s = rt.state;
    stateEl.textContent = rt.mode === 'lessons'
      ? 'lesson: ' + s.lesson + '\ncomplete: ' + (s.done.join(', ') || '(none)') + '\nstatus: ' + s.status
      : 'slide: ' + s.slide + '\nlayers: ' + (s.layers.join(', ') || '(none)') + '\nvars:\n'
      + Object.keys(s.vars).map(function (k) { return '  ' + k + ' = ' + JSON.stringify(s.vars[k]); }).join('\n');
    traceEl.textContent = rt.trace.slice(-30).join('\n');
  }
  function show(on) { panel.hidden = !on; btn.setAttribute('aria-expanded', String(on)); update(); }
  btn.addEventListener('click', function () { show(panel.hidden); });
  window.CFPlayer.mount(document.getElementById('cf-root'), { runtime: rt, assetsBase: assetsBase, onTrace: update });
  if (at && at[1] === 'lesson' && rt.mode === 'lessons') rt.dispatch({ type: 'open', lesson: decodeURIComponent(at[2]) });
  show(/[?&]debug(=|&|$)/.test(window.location.search));
}

// ---------- packages ----------

function page({ title, lang, head, body }) {
  return `<!doctype html>
<html lang="${escHtml(lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
<title>${escHtml(title)}</title>
<link rel="icon" href="data:,">
<style>html, body, #cf-root { height: 100%; margin: 0; }</style>
</head>
<body>
<div id="cf-root"></div>
${body}
</body>
</html>
`;
}

const LIBRARY = new URL('../library/', import.meta.url);
export const LIBRARY_PATH = /^library\/[\w-][\w.-]*$/; // asset.add {library} writes library/<file>; no subfolders, no leading dot

/** Check and resolve every asset before anything is written. Returns [{rel, src}]. */
function planAssets(d, courseDir) {
  if (!d.assets.length) return [];
  if (!courseDir) throw new Error(`publish: courseDir is required to copy ${d.assets.length} asset(s)`);
  const base = path.resolve(courseDir);
  const realBase = fs.existsSync(base) ? fs.realpathSync(base) : base;
  const inside = (root, p) => { const r = path.relative(root, p); return !!r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
  const bad = [], missing = [];
  const plan = d.assets.map((a) => {
    let src = path.resolve(base, a.path), root = base, realRoot = realBase;
    const rel = path.relative(base, src).split(path.sep).join('/');
    // library/<name> the course folder lacks comes from packages/library (flat names only, same containment).
    if (LIBRARY_PATH.test(a.path) && !fs.existsSync(src)) { root = realRoot = fs.realpathSync(LIBRARY); src = path.join(root, a.path.slice(8)); }
    if (!inside(root, src) || RESERVED.has(rel.toLowerCase())) bad.push(a.path);
    else if (!fs.existsSync(src) || !fs.statSync(src).isFile()) missing.push(a.path);
    else if (!inside(realRoot, fs.realpathSync(src))) bad.push(a.path); // symlink pointing outside
    return { asset: a, rel, src };
  });
  if (bad.length) throw new Error(`publish: asset paths must stay inside the course folder (and not replace player files): ${bad.join(', ')}`);
  if (missing.length) throw new Error(`publish: missing asset file(s) in ${base}: ${missing.join(', ')}`);
  for (const p of plan) p.asset.path = p.rel; // published course refers to the normalized relative path
  return plan;
}

function writePackage(doc, outDir, { courseDir, scorm = false } = {}) {
  const errors = validate(doc);
  if (errors.length) throw Object.assign(new Error(`publish: invalid course (${errors.length} error(s)): ${errors[0].path} ${errors[0].message}`), { errors });
  const d = normalize(doc);
  // Explicit tokens win; the default palette follows the selected player style.
  if (d.mode !== 'lessons' && d.player.style === 'modern') d.player.theme = { ...PRESETS.charcoal.tokens, ...d.player.theme };
  const assets = planAssets(d, courseDir);
  const capIds = new Set(d.slides.flatMap((s) => [...s.objects, ...s.layers.flatMap((l) => l.objects)]).map((o) => o.captions).filter(Boolean));
  for (const section of d.sections || []) for (const lesson of section.lessons) for (const block of lesson.blocks) if (block.captions) capIds.add(block.captions);
  const captions = Object.fromEntries(assets.filter((a) => capIds.has(a.asset.id)).map((a) => [a.asset.id, fs.readFileSync(a.src, 'utf8')]));
  const out = path.resolve(outDir);
  const lessons = d.mode === 'lessons'; // the lessons player renders, cf-player.js hands over to it
  const capJs = Object.keys(captions).length ? ['cf-captions.js'] : [];
  const scripts = ['course.js', ...capJs, 'cf-runtime.js', ...(scorm ? ['cf-scorm.js'] : []), 'cf-player.js', ...(lessons ? ['cf-lessons.js'] : [])];
  const css = lessons ? 'cf-lessons.css' : 'cf-player.css';
  const bootJs = `${scorm ? toScormInteraction + '\n' : ''}(${boot})(${scorm});`;
  const files = {
    'index.html': page({
      title: d.title, lang: d.language,
      head: `<meta http-equiv="Content-Security-Policy" content="${capJs.length ? CSP_CAPTIONS : CSP}">\n<link rel="stylesheet" href="${css}">`,
      body: `${scripts.map((s) => `<script src="${s}"></script>`).join('\n')}\n<script>\n${inlineJs(bootJs)}\n</script>`,
    }),
    'course.js': courseJs(d),
    // Escaped slashes keep cue text such as "see https://..." from looking like a remote load to validatePackage.
    ...(capJs.length ? { 'cf-captions.js': `window.CF_CAPTIONS = ${JSON.stringify(captions).replace(/</g, '\\u003c').replace(/\//g, '\\/')};\n` } : {}),
    'cf-runtime.js': runtimeBundle(),
    'cf-player.js': playerBundle(),
    [css]: read(lessons ? LESSONS_CSS : PLAYER_CSS),
    ...(lessons ? { 'cf-lessons.js': read(LESSONS_JS) } : {}),
    ...(scorm ? { 'cf-scorm.js': read(SCORM_JS) } : {}),
  };
  prepareOut(out);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text);
  for (const a of assets) {
    fs.mkdirSync(path.dirname(path.join(out, a.rel)), { recursive: true });
    fs.copyFileSync(a.src, path.join(out, a.rel));
  }
  const written = [...Object.keys(files), ...assets.map((a) => a.rel)].sort();
  fs.writeFileSync(path.join(out, MARKER), JSON.stringify({ files: [...written, ...(scorm ? ['imsmanifest.xml'] : [])] }));
  return { d, out, files: written };
}

// Republishing: only files our previous publish recorded are removed; any other non-empty folder is refused
// (never delete what we did not create).
const MARKER = '.cf-publish.json';
function prepareOut(out) {
  if (!fs.existsSync(out)) { fs.mkdirSync(out, { recursive: true }); return; }
  const entries = fs.readdirSync(out);
  if (!entries.length) return;
  let prev;
  try { prev = JSON.parse(fs.readFileSync(path.join(out, MARKER), 'utf8')).files; } catch { prev = null; }
  if (!Array.isArray(prev)) throw Object.assign(new Error(`publish: ${out} is not empty and was not created by a previous publish; choose an empty folder`), { errors: [{ path: '/out', code: 'semantic', message: 'output folder not empty', hint: 'use a new or empty folder' }] });
  for (const rel of prev) {
    const f = path.resolve(out, rel);
    if (f.startsWith(out + path.sep) && fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
}

export function publishWeb(doc, outDir, { courseDir } = {}) {
  const { files } = writePackage(doc, outDir, { courseDir });
  return { files, launch: 'index.html' };
}

export function publishScorm12(doc, outDir, { courseDir, zip = false } = {}) {
  const { d, out, files } = writePackage(doc, outDir, { courseDir, scorm: true });
  const qc = d.tracking.complete.find((c) => c.quiz);
  const quizLesson = qc && d.mode === 'lessons' && d.sections.flatMap((s) => s.lessons).find((l) => l.id === qc.quiz);
  const masteryScore = !qc ? undefined : quizLesson ? (quizLesson.passPercent ?? 80) : d.quizzes.find((q) => q.id === qc.quiz)?.passPercent;
  fs.writeFileSync(path.join(out, 'imsmanifest.xml'), manifest({ id: d.id, title: d.title, version: '1.0', masteryScore, files, launch: 'index.html' }));
  const result = { files: [...files, 'imsmanifest.xml'].sort(), launch: 'index.html' };
  if (zip) { result.zip = out + '.zip'; writeZip(out, result.zip, result.files); } // only our files, never strays in the folder
  return result;
}

/** Single self-contained HTML page for the editor's preview iframe (no CSP: assets come from the editor origin). */
export function previewHtml(doc, { assetsBase = '' } = {}) {
  const d = normalize(doc);
  // Explicit tokens win; the default palette follows the selected player style.
  if (d.mode !== 'lessons' && d.player.style === 'modern') d.player.theme = { ...PRESETS.charcoal.tokens, ...d.player.theme };
  const lessons = d.mode === 'lessons';
  const css = `${read(lessons ? LESSONS_CSS : PLAYER_CSS)}
#cf-debug-toggle { position: fixed; right: 12px; bottom: 76px; z-index: 20; font: 600 13px/1 system-ui, sans-serif; padding: 8px 12px; border-radius: 8px; border: 1px solid #8a8f98; background: #1c1f24; color: #fff; cursor: pointer; }
#cf-debug-toggle:focus-visible { outline: 3px solid #c2410c; outline-offset: 2px; }
#cf-debug { position: fixed; right: 12px; top: 64px; bottom: 120px; width: min(360px, calc(100vw - 24px)); z-index: 20; overflow: auto; padding: 12px; border-radius: 10px; background: #1c1f24; color: #e9e7e2; font: 12px/1.45 ui-monospace, Consolas, monospace; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
#cf-debug h2 { font: 600 12px/1 system-ui, sans-serif; text-transform: uppercase; letter-spacing: .06em; color: #a9adb5; margin: 4px 0 8px; }
#cf-debug pre { margin: 0 0 12px; white-space: pre-wrap; word-break: break-word; }`;
  return page({
    title: `Preview: ${d.title}`, lang: d.language,
    head: `<style>\n${css}\n</style>`,
    body: `<button id="cf-debug-toggle" type="button" aria-expanded="false" aria-controls="cf-debug">Debug</button>
<aside id="cf-debug" aria-label="Debug" hidden><h2>State</h2><pre id="cf-debug-state"></pre><h2>Trace (last 30)</h2><pre id="cf-debug-trace"></pre></aside>
<script>\n${inlineJs(courseJs(d))}</script>
<script>\n${inlineJs(runtimeBundle())}</script>
<script>\n${inlineJs(playerBundle())}</script>
${lessons ? `<script>\n${inlineJs(read(LESSONS_JS))}</script>\n` : ''}<script>\n${inlineJs(`(${bootPreview})(${JSON.stringify(String(assetsBase))});`)}\n</script>`,
  });
}

// ---------- package check ----------

// ponytail: tag-balance scan, not a full XML parser (no DTD, namespace or encoding checks).
function xmlProblem(xml) {
  const body = xml.replace(/^\uFEFF?\s*<\?xml[^?]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
  const stack = [];
  let m, roots = 0;
  while ((m = re.exec(body))) {
    if (!m[2]) return `stray "${m[0]}" at offset ${m.index}`;
    if (m[1]) { if (m[3] || m[4]) return `malformed </${m[2]}>`; const open = stack.pop(); if (open !== m[2]) return `</${m[2]}> closes <${open ?? 'nothing'}>`; }
    else { if (!stack.length) roots++; if (!m[4]) stack.push(m[2]); }
  }
  if (stack.length) return `<${stack.pop()}> is never closed`;
  if (roots !== 1) return `expected one root element, found ${roots}`;
  if (!/^\s*<manifest[\s>/]/.test(body)) return 'root element must be <manifest>';
  return null;
}

const unXml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]);

function openUrls(dir) {
  const urls = new Set();
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, 'course.js'), 'utf8').replace(/^window\.CF_COURSE = /, '').replace(/;\s*$/, '')); } catch { return urls; }
  const walk = (x) => { if (x && typeof x === 'object') { if ((x.action === 'openUrl' || x.type === 'button') && typeof x.url === 'string') urls.add(x.url); Object.values(x).forEach(walk); } };
  walk(doc);
  return urls;
}

/** [] when the package looks sound, else [{path, code, message}]. */
export function validatePackage(dir) {
  const root = path.resolve(dir);
  const problems = [];
  const add = (p, code, message) => problems.push({ path: p, code, message });
  const isFile = (rel) => { const f = path.resolve(root, rel); return f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile(); };
  let launch = 'index.html';
  if (isFile('imsmanifest.xml')) {
    const xml = fs.readFileSync(path.join(root, 'imsmanifest.xml'), 'utf8');
    const bad = xmlProblem(xml);
    if (bad) add('imsmanifest.xml', 'xml', `imsmanifest.xml is not well-formed: ${bad}`);
    const href = /<resource\b[^>]*?\shref="([^"]*)"/.exec(xml);
    const dec = (h) => { try { return decodeURIComponent(h); } catch { add(h, 'xml', 'imsmanifest.xml href has a malformed %-escape'); return h; } };
    if (href) launch = dec(unXml(href[1])); else add('imsmanifest.xml', 'launch', 'no <resource href> launch entry');
    for (const m of xml.matchAll(/<file\s+href="([^"]*)"/g)) {
      const f = dec(unXml(m[1]));
      if (!isFile(f)) add(f, 'missing', 'listed in imsmanifest.xml but not in the package');
    }
  }
  if (!isFile(launch)) add(launch, 'missing', 'launch file not found');
  const allowed = [...openUrls(root)];
  for (const rel of fs.readdirSync(root, { recursive: true }).map((r) => r.split(path.sep).join('/')).sort()) {
    if (!/\.(html?|js|css)$/i.test(rel) || !isFile(rel)) continue;
    for (const m of fs.readFileSync(path.join(root, rel), 'utf8').matchAll(/https?:\/\/[^\s"'<>()\\]+/gi)) {
      if (!allowed.some((u) => u.startsWith(m[0]))) add(rel, 'external-url', `absolute URL ${m[0]}: published courses must not load remote resources`);
    }
  }
  return problems;
}
