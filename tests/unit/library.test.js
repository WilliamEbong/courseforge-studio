// the local asset library. SC-3 originality/safety markers on every file; SC-1 library.list, asset.add {library}
// publish copies library files, and library paths cannot leave packages/library (publisher and editor server).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply, applyAll, query } from '../../packages/core/index.js';
import { emptyCourse, ID } from '../../packages/schema/index.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { createServer } from '../../packages/server/server.js';
import * as io from '../../packages/cli/io.js';

const LIB = fileURLToPath(new URL('../../packages/library/', import.meta.url));
const index = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8'));
const LICENCE = '<!-- CourseForge Studio library: original artwork drawn for CourseForge Studio. Licence: MIT (see LICENSE at the repository root and packages/library/LICENSE.md). -->';
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-library-'));

test('SC-3: every library file is ours (licence comment) and self-contained (no external references, scripts or fonts)', () => {
  const svgs = fs.readdirSync(LIB).filter((f) => f.endsWith('.svg')).sort();
  assert.ok(svgs.length >= 20 && svgs.length <= 30, `${svgs.length} images`);
  assert.deepEqual(svgs, index.map((x) => x.file).sort(), 'every SVG is listed in index.json and every entry has a file');
  assert.deepEqual(fs.readdirSync(LIB).filter((f) => !f.endsWith('.svg')).sort(), ['LICENSE.md', 'index.json']);
  const bad = [];
  for (const f of svgs) {
    const text = fs.readFileSync(path.join(LIB, f), 'utf8');
    if (!text.startsWith(LICENCE + '\n<svg ')) bad.push(`${f}: must start with the licence comment, then <svg`);
    if (text.split(SVG_NS).length !== 2) bad.push(`${f}: needs exactly one SVG namespace declaration`);
    const rest = text.replace(SVG_NS, '');
    for (const [re, what] of [[/https?:|\/\/|data:|file:/i, 'a URL'], [/href/i, 'a link'], [/@import|url\(/i, 'a CSS reference'], [/<script|\son[a-z]+\s*=/i, 'script'],
      [/foreignObject|<image|<use|<style|<font|@font-face|<text/i, 'embedded content or text'], [/<!DOCTYPE|<!ENTITY/i, 'a DTD']]) if (re.test(rest)) bad.push(`${f}: contains ${what}`);
    if (Buffer.byteLength(text) > 8 * 1024) bad.push(`${f}: larger than 8 KB`);
    if (!/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="240" height="240" viewBox="0 0 240 240">$/m.test(text) || !text.trimEnd().endsWith('</svg>')) bad.push(`${f}: unexpected root element`);
  }
  assert.deepEqual(bad, []);
  const ids = new Set();
  for (const x of index) {
    assert.deepEqual(Object.keys(x), ['id', 'file', 'title', 'tags', 'alt'], x.id);
    assert.match(x.id, new RegExp(ID));
    assert.ok(!ids.has(x.id), `duplicate id ${x.id}`); ids.add(x.id);
    assert.ok(x.title.trim() && x.alt.trim().length >= 8, `${x.id}: title and descriptive alt text`);
    assert.ok(x.tags.length && x.tags.every((t) => /^[a-z][a-z-]*$/.test(t)), `${x.id}: tags`);
  }
  assert.match(fs.readFileSync(path.join(LIB, 'LICENSE.md'), 'utf8'), /original work drawn by hand for CourseForge Studio/);
});

test('library.list filters by tag and by a case-insensitive search over id, title, tags and alt', () => {
  const ids = (args) => query(null, 'library.list', args).data.map((x) => x.id);
  assert.equal(ids().length, index.length);
  assert.deepEqual(ids({ tag: 'ppe' }), ['goggles', 'gloves', 'lab-coat', 'face-mask']);
  assert.deepEqual(ids({ q: 'FLASK' }), ['flask']);
  assert.deepEqual(ids({ q: 'red', tag: 'emergency' }), ['fire-extinguisher']);
  assert.deepEqual(ids({ tag: 'nope' }), []);
  assert.deepEqual(query(null, 'library.list', { q: 'goggles' }).data[0], index[0]);
});

test('CLI parity: cf query library.list and cf cmd asset.add {library}', () => {
  const file = path.join(tmp(), 'c.course.json');
  const cf = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('../../packages/cli/cf.js', import.meta.url)), ...args], { encoding: 'utf8' });
  assert.equal(cf('new', file).status, 0);
  assert.deepEqual(JSON.parse(cf('query', file, 'library.list', '{"q":"trophy"}').stdout).map((x) => x.id), ['trophy']);
  const r = cf('cmd', file, '[{"cmd":"asset.add","args":{"id":"a-t","library":"trophy"}}]');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).assets, [{ id: 'a-t', path: 'library/trophy.svg', alt: 'A gold trophy with a star' }]);
});

const base = () => emptyCourse({ title: 'Library' });
test('asset.add {library} registers library/<file> with the library alt text unless alt is given', () => {
  const r = applyAll(base(), [{ cmd: 'asset.add', args: { id: 'a-g', library: 'goggles' } }, { cmd: 'asset.add', args: { library: 'flask', alt: 'Our flask', mime: 'image/svg+xml' } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.doc.assets[0], { id: 'a-g', path: 'library/goggles.svg', alt: index[0].alt });
  assert.deepEqual(r.doc.assets[1], { id: r.results[1].id, path: 'library/flask.svg', alt: 'Our flask', mime: 'image/svg+xml' });
});

test('asset.add errors: unknown library id lists the ids; path and library are exclusive and one is required', () => {
  const e = apply(base(), { cmd: 'asset.add', args: { library: 'unicorn' } });
  assert.equal(e.errors[0].path, '/args/library');
  assert.match(e.errors[0].message, /must be one of: goggles, gloves/);
  for (const args of [{}, { path: 'assets/a.png', library: 'flask' }]) {
    const r = apply(base(), { cmd: 'asset.add', args });
    assert.equal(r.errors[0].code, 'required');
    assert.match(r.errors[0].hint, /library\.list/);
  }
});

function libCourse(paths) {
  const r = applyAll(base(), [{ cmd: 'slide.add', args: { id: 's-1', title: 'One' } }, ...paths.map((p, i) => ({ cmd: 'asset.add', args: { id: `a-${i}`, ...(p.startsWith('library/') && !p.includes('..') ? { library: path.basename(p, '.svg') } : { path: p }) } })),
    ...paths.map((p, i) => ({ cmd: 'object.add', args: { slide: 's-1', type: 'image', image: `a-${i}`, alt: 'x', x: 0, y: 0, w: 100, h: 100 } }))]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.doc;
}

test('publish copies library images into the package; a file in the course folder wins', () => {
  const courseDir = tmp();
  const out = path.join(tmp(), 'web');
  const doc = libCourse(['library/goggles.svg', 'library/flask.svg']);
  fs.mkdirSync(path.join(courseDir, 'library'));
  fs.writeFileSync(path.join(courseDir, 'library', 'flask.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const r = publishWeb(doc, out, { courseDir });
  assert.ok(r.files.includes('library/goggles.svg') && r.files.includes('library/flask.svg'));
  assert.deepEqual(fs.readFileSync(path.join(out, 'library/goggles.svg')), fs.readFileSync(path.join(LIB, 'goggles.svg')));
  assert.equal(fs.readFileSync(path.join(out, 'library/flask.svg'), 'utf8'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.deepEqual(validatePackage(out), []);
});

test('library path tricks are refused by the publisher: traversal, subfolders, links out of the course folder', () => {
  for (const p of ['library/../library/goggles.svg', 'library/./goggles.svg', 'library/sub/goggles.svg', 'library/.hidden']) {
    const doc = libCourse([]);
    doc.assets.push({ id: 'a-x', path: p }); // hand-edited files can hold any string; asset.add refuses ".." already
    assert.throws(() => publishWeb(doc, path.join(tmp(), 'web'), { courseDir: tmp() }), /missing asset/, p);
  }
  const courseDir = tmp(), outside = tmp();
  fs.writeFileSync(path.join(outside, 'goggles.svg'), 'outside');
  fs.symlinkSync(outside, path.join(courseDir, 'library'), 'junction');
  assert.throws(() => publishWeb(libCourse(['library/goggles.svg']), path.join(tmp(), 'web'), { courseDir }), /must stay inside the course folder/);
});

test('editor server: /assets/<token>/<course>/library/<file> serves packages/library when the courses folder lacks it, and nothing else', async () => {
  const root = tmp();
  const TOKEN = 'library-token-0123456789';
  io.saveCourse(path.join(root, 'demo.course.json'), libCourse(['library/goggles.svg']));
  const server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  const a = `http://127.0.0.1:${server.address().port}/assets/${TOKEN}/demo/`;
  try {
    const res = await fetch(a + 'library/goggles.svg');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(await res.text(), fs.readFileSync(path.join(LIB, 'goggles.svg'), 'utf8'));
    fs.mkdirSync(path.join(root, 'library'));
    fs.writeFileSync(path.join(root, 'library', 'flask.svg'), 'course copy');
    assert.equal(await (await fetch(a + 'library/flask.svg')).text(), 'course copy');
    const api = `http://127.0.0.1:${server.address().port}/api/courses/demo`;
    const listed = await (await fetch(`${api}/query/library.list?args=${encodeURIComponent('{"tag":"ppe"}')}`, { headers: { 'x-cf-token': TOKEN } })).json();
    assert.deepEqual(listed.data.map((x) => x.id), ['goggles', 'gloves', 'lab-coat', 'face-mask'], 'HTTP runs the same query');
    for (const p of ['library/nope.svg', 'library/..%2fpackage.json', 'library/..%2f..%2fserver%2fserver.js', 'library%2f..%2f..%2fpackages%2fserver%2fserver.js', 'library/sub%2fgoggles.svg', 'library/index.json%2f..%2fgoggles.svg']) {
      assert.equal((await fetch(a + p)).status, 404, p);
    }
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'private.svg'), 'outside');
    fs.rmSync(path.join(root, 'library'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'library'), 'junction');
    assert.equal((await fetch(a + 'library/private.svg')).status, 404, 'a link out of the courses folder is not followed');
    assert.equal((await fetch(a + 'library/goggles.svg')).status, 200, 'the library still serves its own files');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
