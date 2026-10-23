#!/usr/bin/env node
// CourseForge Studio local server: serves the editor and a thin HTTP front-end over the command registry.
// No course logic here: edits go through packages/cli/io.js (same core, validation and history as `cf` and MCP).
// Bound to 127.0.0.1, per-launch token, file access confined (after resolving links) to the courses root and packages/.
// No cookies: browsers send cookies to every port of a host, so the token travels only in headers, queries and asset paths.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { query } from '../core/index.js';
import { emptyCourse } from '../schema/index.js';
import * as io from '../cli/io.js';
import { createAssistant, fakeProvider } from '../ai/assistant.js';

const PACKAGES = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const EDITOR = path.join(PACKAGES, 'editor');
export const MAX_BODY = 5 * 1024 * 1024;
export const MAX_UPLOAD = 1024 * 1024 * 1024; // one chosen file (a .story or a video); larger ones go in by hand
const UPLOAD_NAME = /^[a-z0-9][a-z0-9._-]{0,119}$/i; // the editor normalizes a picked file's name to this
const NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const EXT = '.course.json';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.vtt': 'text/vtt', '.woff2': 'font/woff2',
  '.webm': 'video/webm', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
};
import { PUBLISH_TARGETS } from '../core/publish-targets.js';

const fail = (status, p, code, message, hint) => Object.assign(new Error(message), { status, errors: [{ path: p, code, message, ...(hint ? { hint } : {}) }] });
const notFound = () => fail(404, '/url', 'not-found', 'not found');

const within = (base, abs) => { const r = path.relative(base, abs); return !!r && r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
/** Resolve `rel` inside `base`; null when missing or when it would escape (traversal, other drive, UNC, symlink, junction). */
export function inside(base, rel) {
  const abs = path.resolve(base, rel);
  if (!within(base, abs)) return null;
  try { return within(fs.realpathSync(base), fs.realpathSync(abs)) ? abs : null; } catch { return null; }
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

function sendFile(res, file, headers = {}) {
  let st = null;
  try { st = file && fs.statSync(file); } catch { /* missing or invalid name */ }
  if (!st || !st.isFile()) throw notFound(); // no directory listing
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store', ...headers });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res); // a read failure ends this response, not the server
}

// ponytail: oversized bodies are drained (memory stays bounded) and then refused; destroy the socket if bandwidth ever matters.
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(fail(413, '/', 'range', `request body is over ${MAX_BODY} bytes`, 'split the batch into smaller requests'));
      try { resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(fail(400, '/', 'json', `invalid JSON body: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

const shown = (f) => { const r = path.relative(process.cwd(), f); return (r.startsWith('..') || path.isAbsolute(r) ? f : r).split(path.sep).join('/'); };

export function createServer({ root = 'courses', token = crypto.randomBytes(24).toString('base64url'), port = 8420, dataDir, aiProvider } = {}) {
  root = path.resolve(root);
  fs.mkdirSync(root, { recursive: true });
  // AI settings and usage live with the app's data (the desktop passes its userData); CF_AI_FAKE replays a test script.
  const fake = process.env.CF_AI_FAKE ? fakeProvider(JSON.parse(fs.readFileSync(process.env.CF_AI_FAKE, 'utf8'))) : undefined;
  const assistant = createAssistant({ root, dataDir: dataDir ?? path.join(root, '.courseforge'), provider: aiProvider ?? fake });
  const tokenBuf = Buffer.from(token);
  const okToken = (t) => { if (typeof t !== 'string') return false; const b = Buffer.from(t); return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf); };
  const watchers = new Map(); // course file -> { clients:Set<res>, listener }

  const server = http.createServer((req, res) => handle(req, res).catch((e) => {
    if (res.headersSent) { res.destroy(); return; }
    json(res, e.status ?? (e.errors ? 400 : 500), { ok: false, errors: e.errors ?? [{ path: '/', code: 'internal', message: e.message }] });
  }));
  server.token = token;
  server.listen(port, '127.0.0.1');

  function auth(req, url) {
    if (![req.headers['x-cf-token'], url.searchParams.get('token')].some(okToken)) {
      throw fail(401, '/token', 'auth', 'missing or wrong token', 'open the URL the server printed (it carries ?token=...), or send header x-cf-token');
    }
  }
  const only = (req, method) => { if (req.method !== method) throw fail(405, '/method', 'method', `use ${method} here`); };
  const courseFile = (name, format) => {
    if (!NAME.test(name)) throw fail(400, '/name', 'pattern', `course name must match ${NAME.source}`, 'lowercase letters, digits and dashes, e.g. "safety-101"');
    if (format !== undefined && !['story', 'json'].includes(format)) throw fail(400, '/format', 'enum', 'format must be story or json');
    const files = fs.readdirSync(root).filter((f) => /\.story$|\.course\.json$/i.test(f) && f.replace(/\.story$|\.course\.json$/i, '') === name);
    if (files.length > 1) throw fail(409, '/name', 'ambiguous', `multiple course files use the name ${name}`, 'Rename one file to give each course a unique name');
    return path.join(root, files[0] ?? name + (format === 'story' ? '.story' : EXT));
  };
  const load = (file) => {
    try { return io.loadCourse(file); } catch (e) {
      if (e.code === 'ENOENT') throw fail(404, '/name', 'ref', 'course not found', 'GET /api/courses lists the courses');
      throw Object.assign(e, { status: 400 });
    }
  };
  const state = (file, doc) => ({ doc, rev: io.revision(file), history: io.history.depth(file), file: shown(file), ...(io.isStory(file) ? { importSummary: io.storySummary(file) } : {}) });
  const publisher = () => import('../publisher/index.js').catch((e) => ({ loadError: e.message }));

  async function handle(req, res) {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer'); // page and asset URLs carry the token
    const port = server.address().port;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) throw fail(403, '/headers/host', 'host', `use http://127.0.0.1:${port}/`);
    if (req.method !== 'GET' && req.method !== 'POST') throw fail(405, '/method', 'method', `method ${req.method} not allowed`, 'use GET or POST');
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { throw fail(400, '/url', 'url', 'malformed URL encoding'); }
    let m;
    if (p === '/') {
      only(req, 'GET');
      return sendFile(res, path.join(EDITOR, 'index.html'));
    }
    if ((m = /^\/editor\/(.+)$/.exec(p))) { only(req, 'GET'); return sendFile(res, inside(EDITOR, m[1])); }
    if ((m = /^\/packages\/(.+)$/.exec(p))) { only(req, 'GET'); return sendFile(res, inside(PACKAGES, m[1])); }
    if ((m = /^\/assets\/([^/]+)\/([^/]+)\/(.+)$/.exec(p))) { // /assets/<token>/<course>/<file>: <img> tags cannot send headers
      only(req, 'GET');
      if (!okToken(m[1])) throw fail(401, '/token', 'auth', 'missing or wrong token');
      courseFile(m[2]);
      // library/<name> the courses folder lacks comes from packages/library (same rule as the publisher).
      const own = inside(root, m[3]);
      return sendFile(res, own ?? ((await publisher()).LIBRARY_PATH?.test(m[3]) ? inside(path.join(PACKAGES, 'library'), m[3].slice(8)) : null));
    }
    if ((m = /^\/preview\/([^/]+)$/.exec(p))) {
      only(req, 'GET'); auth(req, url);
      const doc = load(courseFile(m[1]));
      const pub = await publisher();
      const html = typeof pub.previewHtml === 'function'
        ? await pub.previewHtml(doc, { assetsBase: `/assets/${token}/${m[1]}/` })
        : '<!doctype html><meta charset="utf-8"><title>Preview unavailable</title><body style="font:15px system-ui;padding:2rem"><h1>Preview unavailable</h1><p>The publisher (packages/publisher/index.js previewHtml) is not built yet.</p>';
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }
    if (p.startsWith('/api/')) { auth(req, url); return api(req, res, p.slice(4), url); }
    throw notFound();
  }

  async function api(req, res, p, url) {
    if (p === '/commands') {
      only(req, 'GET');
      const names = query(null, 'commands.list').data.map((c) => c.name);
      return json(res, 200, { ok: true, commands: names.map((name) => query(null, 'commands.help', { name }).data) });
    }
    if (p === '/ai') { // AI status (Claude CLI found and signed in, settings, today's usage) and settings changes
      if (req.method === 'GET') return json(res, 200, { ok: true, ...assistant.status() });
      const body = await readJson(req);
      return json(res, 200, { ok: true, ...assistant.settings.set(body ?? {}) });
    }
    if (p === '/courses') {
      if (req.method === 'GET') {
        const courses = fs.readdirSync(root).filter((f) => /\.story$|\.course\.json$/i.test(f) && NAME.test(f.replace(/\.story$|\.course\.json$/i, ''))).map((f) => {
          const file = path.join(root, f);
          let title = null;
          try { title = io.loadCourse(file).title; } catch { /* listed as unreadable */ }
          return { name: f.replace(/\.story$|\.course\.json$/i, ''), file: f, format: io.isStory(f) ? 'story' : 'json', title, rev: io.revision(file), ...(title === null ? { invalid: true } : {}) };
        });
        return json(res, 200, { ok: true, courses });
      }
      const body = await readJson(req);
      const file = courseFile(typeof body?.name === 'string' ? body.name : '', body.format);
      if (body.title !== undefined && typeof body.title !== 'string') throw fail(400, '/title', 'type', 'title must be a string');
      if (body.mode !== undefined && !['slides', 'lessons'].includes(body.mode)) throw fail(400, '/mode', 'enum', 'mode must be one of: slides, lessons', 'omit it for a slides course');
      if (body.mode === 'lessons' && body.format === 'story') throw fail(400, '/format', 'story-unsupported', 'Lessons courses use JSON storage', 'Choose format json');
      if (fs.existsSync(file)) throw fail(409, '/name', 'dupe', `course "${body.name}" already exists`, 'open it, or choose another name');
      fs.rmSync(file + '.history.json', { force: true }); // a leftover history would undo into another course
      const doc = emptyCourse({ title: body.title || undefined, mode: body.mode });
      const saved = io.saveCourse(file, doc);
      return json(res, 201, { ok: true, name: body.name, ...state(file, saved) });
    }
    if (p === '/files') { // the editor's file pickers copy a chosen file into the courses folder; agents use paths directly
      only(req, 'POST');
      const dir = url.searchParams.get('dir'), name = url.searchParams.get('name') ?? '';
      if (!['imports', 'assets'].includes(dir)) throw fail(400, '/dir', 'enum', 'dir must be imports or assets');
      if (!UPLOAD_NAME.test(name) || name.includes('..')) throw fail(400, '/name', 'pattern', 'file name must be letters, digits, dots, dashes or underscores', 'e.g. module-1.story');
      if (Number(req.headers['content-length']) > MAX_UPLOAD) throw fail(413, '/', 'range', `the file is over ${MAX_UPLOAD / 1024 ** 3} GB`, 'copy it into the courses folder by hand');
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      if (!inside(root, dir)) throw fail(400, '/dir', 'path', 'folder escapes the courses root');
      const { name: stem, ext } = path.parse(name);
      // Reserve a free name atomically ('wx' fails if it exists), so two uploads never pick the same file (007 #3).
      let rel = null;
      for (let n = 0; !rel; n++) {
        const r = `${dir}/${n ? `${stem}-${n}${ext}` : name}`;
        try { fs.closeSync(fs.openSync(path.join(root, r), 'wx')); rel = r; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      const dest = path.join(root, rel), part = `${dest}.${crypto.randomUUID()}.part`;
      let size = 0;
      try {
        await pipeline(req, async function* (chunks) {
          for await (const c of chunks) { if ((size += c.length) > MAX_UPLOAD) throw fail(413, '/', 'range', 'the file is too large'); yield c; }
        }, fs.createWriteStream(part, { flags: 'wx' }));
        fs.renameSync(part, dest); // replaces our own empty reservation
      } catch (e) { fs.rmSync(part, { force: true }); fs.rmSync(dest, { force: true }); throw e; }
      return json(res, 201, { ok: true, path: rel, size });
    }
    if (p === '/import') { // read-only Storyline import, same function as `cf import` and MCP import_story
      only(req, 'POST');
      const body = await readJson(req);
      const file = courseFile(typeof body?.name === 'string' ? body.name : '', body.format);
      if (typeof body?.path !== 'string' || !body.path) throw fail(400, '/path', 'type', 'path must name a .story file inside the courses root', 'e.g. {"path":"imports/module1.story","name":"module-1"}');
      const src = inside(root, body.path);
      if (!src) throw fail(400, '/path', 'path', 'path must name an existing file inside the courses root');
      if (fs.existsSync(file)) throw fail(409, '/name', 'dupe', `course "${body.name}" already exists`, 'choose another name');
      let r;
      try { r = io.importCourse(src, file); } catch (e) { throw Object.assign(e, { status: 400 }); }
      return json(res, 201, { ok: true, name: body.name, reportFile: shown(r.reportFile), summary: r.summary, ...state(file, load(file)) });
    }
    const m = /^\/courses\/([^/]+)(?:\/(commands|undo|redo|publish|events|query|ai)(?:\/([^/]+))?)?$/.exec(p);
    if (!m || ['query', 'ai'].includes(m[2]) !== (m[3] !== undefined)) throw notFound();
    const [, name, op, q] = m;
    const file = courseFile(name);
    if (!fs.existsSync(file)) throw fail(404, '/name', 'ref', `course "${name}" not found`, 'GET /api/courses lists the courses');

    if (!op) { only(req, 'GET'); return json(res, 200, { ok: true, ...state(file, load(file)) }); }
    if (op === 'commands') {
      only(req, 'POST');
      const body = await readJson(req);
      if (!Array.isArray(body?.commands) || !body.commands.length) throw fail(400, '/commands', 'type', 'commands must be a non-empty array of {cmd, args}', 'POST {"commands":[{"cmd":"slide.add","args":{"title":"Intro"}}]}');
      if (body.rev !== undefined && body.rev !== io.revision(file)) throw fail(409, '/rev', 'stale', 'the course changed since you loaded it; nothing was applied', 'reload');
      const r = io.runCommands(file, body.commands);
      if (!r.ok) return json(res, 400, { ok: false, errors: r.errors });
      return json(res, 200, { ok: true, results: r.results, ...state(file, r.doc) });
    }
    if (op === 'undo' || op === 'redo') {
      only(req, 'POST');
      const doc = io.history[op](file);
      if (!doc) throw fail(400, '/', 'history', `nothing to ${op}`);
      return json(res, 200, { ok: true, ...state(file, doc) });
    }
    if (op === 'ai') { // ask: NDJSON progress lines, then {type:'done', card} or {type:'error', errors}; apply/discard a draft
      only(req, 'POST');
      const body = await readJson(req);
      if (q === 'apply') return json(res, 200, { ...assistant.apply(String(body?.draftId ?? '')), ...state(file, load(file)) });
      if (q === 'discard') return json(res, 200, assistant.discard(String(body?.draftId ?? '')));
      if (q !== 'ask') throw notFound();
      if (body?.focus !== undefined && typeof body.focus !== 'string') throw fail(400, '/focus', 'type', 'focus must be a string');
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      const send = (o) => res.write(JSON.stringify(o) + '\n');
      try { send({ type: 'done', card: await assistant.ask({ file, prompt: body?.prompt, focus: body?.focus, onEvent: send }) }); }
      catch (e) { send({ type: 'error', errors: e.errors ?? [{ path: '/', code: 'internal', message: e.message }] }); }
      return res.end();
    }
    if (op === 'query') {
      only(req, 'GET');
      let args;
      try { args = url.searchParams.has('args') ? JSON.parse(url.searchParams.get('args')) : undefined; } catch { throw fail(400, '/args', 'json', 'args must be URL-encoded JSON'); }
      const r = query(load(file), q, args);
      return json(res, r.ok ? 200 : 400, r);
    }
    if (op === 'publish') {
      only(req, 'POST');
      const body = await readJson(req);
      const target = Object.hasOwn(PUBLISH_TARGETS, body?.target) ? PUBLISH_TARGETS[body.target] : null;
      const fn = target?.method;
      if (!fn) throw fail(400, '/target', 'enum', 'target must be one of: ' + Object.keys(PUBLISH_TARGETS).join(', '));
      const pub = await publisher();
      if (typeof pub[fn] !== 'function') throw fail(501, '/target', 'unavailable', `publish ${body.target} is not available yet`, pub.loadError ?? `packages/publisher/index.js does not export ${fn}`);
      if (body.format !== undefined && (body.target !== 'questions' || !['xlsx', 'txt'].includes(body.format))) throw fail(400, '/format', 'enum', 'format is xlsx or txt for questions only');
      if (body.zip !== undefined && typeof body.zip !== 'boolean') throw fail(400, '/zip', 'type', 'zip must be a boolean');
      if (body.zip && body.target !== 'scorm12') throw fail(400, '/zip', 'semantic', 'ZIP output requires target scorm12');
      const ext = body.target === 'questions' ? '.' + (body.format ?? 'xlsx') : target.extension;
      const outDir = path.join(root, 'dist', `${name}-${body.target}${ext}`);
      const result = await pub[fn](load(file), outDir, { courseDir: root, zip: body.zip === true });
      return json(res, 200, { ok: true, out: shown(outDir), ...(result.zip ? { zip: shown(result.zip) } : {}), ...(target.extension ? { result: { ...result, output: shown(result.output), report: shown(result.report) } } : {}) });
    }
    // op === 'events': Server-Sent Events, {rev} on connect and on every change of the file (CLI, MCP or this server).
    only(req, 'GET');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`retry: 1000\ndata: ${JSON.stringify({ rev: io.revision(file) })}\n\n`);
    let w = watchers.get(file);
    if (!w) {
      const clients = new Set();
      const listener = (cur) => { for (const c of clients) c.write(`data: ${JSON.stringify({ rev: Math.floor(cur.mtimeMs) })}\n\n`); };
      fs.watchFile(file, { interval: 500, persistent: false }, listener);
      watchers.set(file, w = { clients, listener });
    }
    w.clients.add(res);
    req.on('close', () => {
      w.clients.delete(res);
      if (!w.clients.size && watchers.get(file) === w) { fs.unwatchFile(file, w.listener); watchers.delete(file); }
    });
  }

  return server;
}

if (import.meta.main) { // Node >= 24.2, as packages/mcp/server.js
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const root = path.resolve(arg('--root', 'courses'));
  fs.mkdirSync(root, { recursive: true });
  // The token survives restarts, so an open editor (and its live sync) keeps working after the server comes back;
  // --new-token rotates it. ponytail: plain file in the courses folder, the same local trust boundary as the courses.
  const tokenFile = path.join(root, '.cf-token');
  let token = !process.argv.includes('--new-token') && fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  if (!/^[A-Za-z0-9_-]{24,}$/.test(token)) { token = crypto.randomBytes(24).toString('base64url'); fs.writeFileSync(tokenFile, token, { mode: 0o600 }); }
  const server = createServer({ root, token, port: Number(arg('--port', 8420)) });
  server.on('listening', () => console.log(`CourseForge Studio editor: http://127.0.0.1:${server.address().port}/?token=${server.token}`));
  server.on('error', (e) => { console.error(`courseforge-studio server: ${e.message}`); process.exit(1); });
}
