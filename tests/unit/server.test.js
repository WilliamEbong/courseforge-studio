// HTTP server: real core/io on a temp courses root, ephemeral port.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer, MAX_BODY } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';
import { readZip } from '../../packages/import-story/zip-read.js';

const TOKEN = 'test-token-0123456789';
let server, base, tmp, root;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-server-'));
  root = path.join(tmp, 'courses');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside the root');
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const api = async (p, { method = 'GET', body, token = TOKEN, raw } = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-cf-token': token } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, type: res.headers.get('content-type') };
};
const run = (name, commands, rev) => api(`/api/courses/${name}/commands`, { method: 'POST', body: { commands, ...(rev !== undefined ? { rev } : {}) } });

test('token is required on /api/* (header or query)', async () => {
  assert.equal((await api('/api/courses', { token: null })).status, 401);
  assert.equal((await api('/api/courses', { token: 'wrong-token-0123456789' })).status, 401);
  assert.equal((await api('/api/courses')).status, 200);
  assert.equal((await api(`/api/courses?token=${TOKEN}`, { token: null })).status, 200);
  const r = await api('/api/courses', { token: null });
  assert.equal(r.data.ok, false);
  assert.equal(r.data.errors[0].code, 'auth');
});

test('foreign Host header is refused (DNS rebinding guard)', async () => {
  const req = http.request(`${base}/api/courses?token=${TOKEN}`, { headers: { host: 'evil.example:80' } });
  req.end();
  const [res] = await once(req, 'response');
  res.resume();
  assert.equal(res.statusCode, 403);
});

test('create, list and get a course', async () => {
  const c = await api('/api/courses', { method: 'POST', body: { name: 'demo', title: 'Demo' } });
  assert.equal(c.status, 201);
  assert.equal(c.data.doc.title, 'Demo');
  assert.ok(fs.existsSync(path.join(root, 'demo.course.json')));
  assert.equal((await api('/api/courses', { method: 'POST', body: { name: 'demo' } })).status, 409);
  for (const name of ['../evil', 'Bad', '-x', 'a/b', '', 'a'.repeat(62)]) {
    const r = await api('/api/courses', { method: 'POST', body: { name } });
    assert.equal(r.status, 400, name);
    assert.equal(r.data.errors[0].code, 'pattern');
  }
  const list = await api('/api/courses');
  assert.deepEqual(list.data.courses.map((x) => [x.name, x.title]), [['demo', 'Demo']]);
  const g = await api('/api/courses/demo');
  assert.equal(g.status, 200);
  assert.equal(typeof g.data.rev, 'number');
  assert.deepEqual(g.data.history, { undo: 0, redo: 0, undoLabel: null, redoLabel: null });
  assert.equal((await api('/api/courses/nope')).status, 404);
});

test('create a lessons course with mode; a bad mode is refused', async () => {
  const c = await api('/api/courses', { method: 'POST', body: { name: 'les', title: 'Les', mode: 'lessons' } });
  assert.equal(c.status, 201);
  assert.deepEqual([c.data.doc.mode, c.data.doc.tracking.complete], ['lessons', [{ lessonsViewed: 100 }]]);
  assert.equal(io.loadCourse(path.join(root, 'les.course.json')).mode, 'lessons');
  const bad = await api('/api/courses', { method: 'POST', body: { name: 'les-bad', mode: 'story' } });
  assert.deepEqual([bad.status, bad.data.errors[0].path, bad.data.errors[0].code], [400, '/mode', 'enum']);
  assert.equal(fs.existsSync(path.join(root, 'les-bad.course.json')), false);
  const plain = await api('/api/courses', { method: 'POST', body: { name: 'les-default' } });
  assert.equal(plain.data.doc.mode, 'slides');
});

test('commands: ok, error (400, nothing saved), stale rev (409)', async () => {
  const ok = await run('demo', [{ cmd: 'slide.add', args: { id: 's-one', title: 'One' } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.results, [{ id: 's-one', scene: 'sc-1' }]);
  assert.equal(ok.data.doc.slides.length, 1);
  assert.equal(ok.data.rev, io.revision(path.join(root, 'demo.course.json')));
  const onDisk = fs.readFileSync(path.join(root, 'demo.course.json'), 'utf8');

  const bad = await run('demo', [{ cmd: 'object.add', args: { slide: 's-missing', type: 'text' } }]);
  assert.equal(bad.status, 400);
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.errors[0].code, 'ref');
  assert.match(bad.data.errors[0].hint, /s-one/);
  assert.equal(fs.readFileSync(path.join(root, 'demo.course.json'), 'utf8'), onDisk);

  const stale = await run('demo', [{ cmd: 'slide.add', args: {} }], ok.data.rev - 1);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.errors[0].code, 'stale');
  assert.equal(stale.data.errors[0].hint, 'reload');
  const fresh = await run('demo', [{ cmd: 'slide.set', args: { id: 's-one', title: 'First' } }], ok.data.rev);
  assert.equal(fresh.status, 200);

  assert.equal((await run('demo', [])).status, 400);
  assert.equal((await api('/api/courses/demo/commands', { method: 'POST', raw: '{not json' })).data.errors[0].code, 'json');
});

test('undo and redo walk the shared history', async () => {
  const u = await api('/api/courses/demo/undo', { method: 'POST' });
  assert.equal(u.status, 200);
  assert.equal(u.data.doc.slides[0].title, 'One');
  const u2 = await api('/api/courses/demo/undo', { method: 'POST' });
  assert.equal(u2.data.doc.slides.length, 0);
  assert.equal((await api('/api/courses/demo/undo', { method: 'POST' })).data.errors[0].code, 'history');
  const r = await api('/api/courses/demo/redo', { method: 'POST' });
  assert.equal(r.data.doc.slides.length, 1);
  assert.deepEqual([r.data.history.undo, r.data.history.redo], [1, 1]);
  assert.ok(r.data.history.undoLabel && r.data.history.redoLabel, 'labelled for the Undo and Redo buttons');
  await api('/api/courses/demo/redo', { method: 'POST' });
});

test('registry metadata and queries', async () => {
  const c = await api('/api/commands');
  const add = c.data.commands.find((x) => x.name === 'slide.add');
  assert.ok(add.summary && add.args.properties && add.examples.length);
  const d = await api('/api/courses/demo/query/course.describe');
  assert.match(d.data.data, /slide s-one "First"/);
  const s = await api(`/api/courses/demo/query/slide.get?args=${encodeURIComponent(JSON.stringify({ id: 's-one' }))}`);
  assert.equal(s.data.data.title, 'First');
  assert.equal((await api('/api/courses/demo/query/nope')).status, 400);
  assert.equal((await api('/api/courses/demo/query/slide.get?args=%7Bbad')).status, 400);
});

test('static files, path traversal and course-name guards', async () => {
  const idx = await fetch(base + '/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-type'), /text\/html/);
  const mod = await fetch(base + '/packages/core/index.js');
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type'), /text\/javascript/);
  for (const p of ['/packages/core', '/packages/..%2fpackage.json', '/packages/..%5cpackage.json', '/packages/%2e%2e/package.json',
    '/packages/core/..%2f..%2f..%2fsecret.txt', '/editor/..%2fcore%2findex.js%2f..%2f..%2f..%2fpackage.json', '/nope']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  assert.equal((await fetch(base + '/packages/%E0%A4%A')).status, 400);
  const a = `/assets/${TOKEN}/demo/`;
  assert.equal((await fetch(`${base}${a}demo.course.json`)).status, 200);
  for (const p of ['..%2fsecret.txt', '..%5csecret.txt', encodeURIComponent(path.join(tmp, 'secret.txt'))]) {
    assert.equal((await fetch(base + a + p)).status, 404, p);
  }
  assert.equal((await fetch(`${base}/assets/wrong-token-0123456789/demo/demo.course.json`)).status, 401);
  assert.equal((await fetch(`${base}/assets/demo/demo.course.json?token=${TOKEN}`)).status, 404, 'token must be in the path');
  // review 002 #3: a link inside the root that points outside it is not followed
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside the root');
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  assert.equal((await fetch(`${base}${a}linked/private.txt`)).status, 404);
  assert.equal((await fetch(`${base}${a}linked`)).status, 404);
  assert.equal((await api('/api/courses/..%2f..%2fsecret')).status, 404); // decoded slashes never form a course name
  assert.equal((await api('/api/courses/..%5csecret')).status, 400);
  assert.equal((await api('/api/courses/Demo')).status, 400);
  assert.equal((await fetch(base + '/api/courses', { method: 'PUT', headers: { 'x-cf-token': TOKEN } })).status, 405);
});

test('request bodies over 5 MB are refused', async () => {
  const big = JSON.stringify({ commands: [{ cmd: 'course.set', args: { title: 'x'.repeat(MAX_BODY) } }] });
  const r = await api('/api/courses/demo/commands', { method: 'POST', raw: big });
  assert.equal(r.status, 413);
  assert.equal(r.data.errors[0].code, 'range');
});

test('publish and preview report the publisher state clearly', async () => {
  const p = await api('/api/courses/demo/publish', { method: 'POST', body: { target: 'web' } });
  if (p.status === 501) assert.equal(p.data.errors[0].code, 'unavailable');
  else assert.equal(p.data.ok, true, JSON.stringify(p.data));
  assert.equal((await api('/api/courses/demo/publish', { method: 'POST', body: { target: 'zip' } })).status, 400);
  const pv = await fetch(`${base}/preview/demo?token=${TOKEN}`);
  assert.equal(pv.status, 200);
  assert.match(pv.headers.get('content-type'), /text\/html/);
  assert.equal(pv.headers.get('set-cookie'), null, 'no cookie: browsers would send it to every localhost port (review 002 #1)');
  assert.equal(pv.headers.get('referrer-policy'), 'no-referrer');
  if (typeof (await import('../../packages/publisher/index.js')).previewHtml === 'function') assert.match(await pv.text(), new RegExp(`/assets/${TOKEN}/demo/`));
  assert.equal((await fetch(`${base}/preview/demo`)).status, 401);
});

test('SCORM publish can produce an LMS upload ZIP and validates the option', async () => {
  const p = await api('/api/courses/demo/publish', { method: 'POST', body: { target: 'scorm12', zip: true } });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.zip, path.join(root, 'dist/demo-scorm12.zip').replaceAll('\\', '/'));
  const zip = readZip(fs.readFileSync(p.data.zip));
  assert.ok(zip.names.includes('imsmanifest.xml'));
  assert.ok(zip.read('index.html').equals(fs.readFileSync(path.join(p.data.out, 'index.html'))));
  for (const body of [{ target:'scorm12', zip:'true' }, { target:'web', zip:true }]) {
    const r = await api('/api/courses/demo/publish', { method:'POST', body });
    assert.equal(r.status, 400);
    assert.equal(r.data.errors[0].path, '/zip');
  }
});

test('SSE emits the new rev after an external io.saveCourse', async () => {
  const file = path.join(root, 'demo.course.json');
  const ac = new AbortController();
  const res = await fetch(`${base}/api/courses/demo/events?token=${TOKEN}`, { signal: ac.signal });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const next = async () => {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const d = /^data: (.*)$/m.exec(ev); if (d) return JSON.parse(d[1]); continue; }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += dec.decode(value, { stream: true });
    }
  };
  const first = await next();
  assert.equal(first.rev, io.revision(file));
  await new Promise((r) => setTimeout(r, 20));
  const doc = io.loadCourse(file);
  io.saveCourse(file, { ...doc, title: 'Changed by an agent' });
  const ev = await Promise.race([next(), new Promise((_, rej) => setTimeout(() => rej(new Error('no SSE event within 3s')), 3000))]);
  assert.notEqual(ev.rev, first.rev);
  assert.equal(ev.rev, io.revision(file));
  ac.abort();
});

// FR-B1: the editor's file pickers copy a chosen file into the courses folder (agents use paths directly).
test('file upload: imports/ and assets/ only, safe names, never overwrites, size-capped, token required', async () => {
  const up = (q, bytes, opts = {}) => fetch(`${base}/api/files?${q}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...(opts.token === null ? {} : { 'x-cf-token': TOKEN }), ...(opts.headers || {}) }, body: bytes })
    .then(async (r) => ({ status: r.status, data: await r.json() }));
  let r = await up('dir=assets&name=photo.png', Buffer.from('png-bytes'));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.path, 'assets/photo.png');
  assert.equal(fs.readFileSync(path.join(root, 'assets/photo.png'), 'utf8'), 'png-bytes');
  r = await up('dir=assets&name=photo.png', Buffer.from('second'));
  assert.equal(r.data.path, 'assets/photo-1.png', 'an existing file is kept; the copy gets a free name');
  assert.equal(fs.readFileSync(path.join(root, 'assets/photo.png'), 'utf8'), 'png-bytes');
  r = await up('dir=imports&name=module-1.story', Buffer.from('zip'));
  assert.equal(r.data.path, 'imports/module-1.story');
  for (const q of ['dir=..&name=x.txt', 'dir=dist&name=x.txt', 'dir=assets&name=..%2Fsecret.txt', 'dir=assets&name=a%2Fb.png', 'dir=assets&name=.hidden', 'dir=assets&name=']) {
    r = await up(q, Buffer.from('x'));
    assert.equal(r.status, 400, q);
  }
  r = await up('dir=assets&name=x.png', Buffer.from('x'), { token: null });
  assert.equal(r.status, 401);
  r = await up('dir=assets&name=big.mp4', Buffer.from('x'), { headers: { 'content-length': String(2 * 1024 ** 3) } }).catch((e) => ({ status: 'refused', e }));
  assert.ok(r.status === 413 || r.status === 'refused', `oversized upload: ${r.status}`);
  assert.equal(fs.existsSync(path.join(root, 'assets/big.mp4')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'assets')).filter((f) => f.endsWith('.part')), [], 'no partial files left behind');
});

test('two uploads with the same name at the same time each keep their own bytes (Codex review 007 #3)', async () => {
  const body = (ch) => new ReadableStream({ async start(c) { for (let i = 0; i < 8; i++) { c.enqueue(new TextEncoder().encode(ch.repeat(64 * 1024))); await new Promise((r) => setTimeout(r, 15)); } c.close(); } });
  const up = (ch) => fetch(`${base}/api/files?dir=assets&name=same.bin`, { method: 'POST', headers: { 'x-cf-token': TOKEN, 'content-type': 'application/octet-stream' }, body: body(ch), duplex: 'half' }).then((r) => r.json());
  const [a, b] = await Promise.all([up('A'), up('B')]);
  assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
  assert.notEqual(a.path, b.path);
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  assert.match(read(a.path), /^A+$/);
  assert.match(read(b.path), /^B+$/);
  assert.equal(read(a.path).length, 8 * 64 * 1024);
});
