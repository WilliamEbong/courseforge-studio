import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import * as io from '../../packages/cli/io.js';
import * as core from '../../packages/core/index.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { writeStory } from '../../packages/export-story/index.js';
import { readZip } from '../../packages/import-story/zip-read.js';
import { rezip } from '../../packages/publisher/zip.js';
import { createServer } from '../../packages/server/server.js';
import { createServer as createMcp } from '../../packages/mcp/server.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-story-io-'));
const seed = (root) => { const file = path.join(root, 'demo.story'); fs.writeFileSync(file, writeStory({ title: 'Demo', text: 'Hello' })); return file; };
const title = (value) => [{ cmd: 'course.set', args: { title: value } }];
const code = (value) => (e) => e.errors?.[0]?.code === value;

for (const action of ['object.remove', 'slide.remove', 'object.duplicate', 'slide.duplicate']) test(`native ${action} undo/redo restores exact archives with opaque XML`, () => {
  const file = seed(temp()), zip = readZip(fs.readFileSync(file)), part = zip.names.find(n => /^story\/slides\/[^/]+\.xml$/.test(n));
  const xml = zip.read(part).toString().replace('</textBox>', '<opaquePayload value="keep"/></textBox>');
  fs.writeFileSync(file, rezip(fs.readFileSync(file), zip, { put: new Map([[part, Buffer.from(xml)]]) }));
  const doc = io.loadCourse(file), s = doc.slides[0], o = s.objects[0], before = fs.readFileSync(file);
  const args = action === 'object.duplicate' ? { ids: [o.id], newIds: ['o-copy'] } : { id: action.startsWith('slide.') ? s.id : o.id };
  assert.ok(io.runCommands(file, [{ cmd: action, args }]).ok);
  const after = fs.readFileSync(file);
  io.history.undo(file);
  assert.ok(fs.readFileSync(file).equals(before), 'undo must restore the exact source archive');
  io.history.redo(file);
  assert.ok(fs.readFileSync(file).equals(after), 'redo must restore the exact saved archive');
  if (action.endsWith('duplicate')) assert.equal((readZip(after).names.filter(n => /^story\/slides\/[^/]+\.xml$/.test(n)).map(n => readZip(after).read(n).toString()).join('').match(/opaquePayload/g) || []).length, 2);
});

test('native I/O saves, reloads, undoes/redoes and refuses unsupported edits without touching bytes/history', () => {
  const file = seed(temp()), before = io.loadCourse(file);
  const r = io.runCommands(file, title('Changed'));
  assert.equal(r.doc.title, 'Changed');
  assert.equal(io.loadCourse(file).title, 'Changed');
  assert.equal(io.history.undo(file).title, before.title);
  assert.equal(io.history.redo(file).title, 'Changed');
  const bytes = fs.readFileSync(file), hist = fs.readFileSync(file + '.history.json');
  assert.throws(() => io.runCommands(file, [{ cmd: 'course.set', args: { description: 'Not stored yet' } }]), code('story-unsupported'));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readFileSync(file + '.history.json'), hist);
  fs.appendFileSync(file, Buffer.from([0xff]));
  assert.throws(() => io.history.undo(file), code('history'));
});

test('native creation starts from writer document, preserves returned IDs and refuses lessons/populated conversion', () => {
  const root = temp(), file = path.join(root, 'created.story');
  io.saveCourse(file, emptyCourse({ title: 'Created' }));
  assert.equal(io.loadCourse(file).title, 'Created');
  assert.equal(io.loadCourse(file).slides.length, 1);
  const next = path.join(root, 'batch.story');
  assert.equal(io.runCommands(next, title('Batch'), { create: true, emptyCourse }).doc.title, 'Batch');
  const bad = path.join(root, 'bad.story');
  assert.throws(() => io.saveCourse(bad, emptyCourse({ mode: 'lessons' })), code('story-unsupported'));
  assert.equal(fs.existsSync(bad), false);
});

test('native multiple undo/redo tolerates rewritten ZIP metadata while detecting external writes', () => {
  const root = temp(), file = seed(root), bytes = fs.readFileSync(file);
  const zip = readZip(bytes), part = zip.names.find((n) => /^story\/slides\/[^/]+\.xml$/.test(n));
  zip.raw(part).seg.writeUInt16LE(1234, 10); // source timestamp need not equal the writer's deterministic timestamp
  fs.writeFileSync(file, bytes);
  const object = io.loadCourse(file).slides[0].objects[0];
  io.runCommands(file, title('First'));
  io.runCommands(file, [{ cmd: 'object.set', args: { id: object.id, x: object.x + 10 } }]);
  io.history.undo(file);
  assert.equal(io.history.undo(file).title, 'Demo');
  io.history.redo(file);
  assert.equal(io.history.redo(file).slides[0].objects[0].x, object.x + 10);
});

test('locked .story atomic rename produces actionable error and keeps source and history untouched', (t) => {
  const file = seed(temp()), bytes = fs.readFileSync(file);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => { if (target === file) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return rename(source, target); });
  assert.throws(() => io.runCommands(file, title('Changed')), (e) => code('story-locked')(e) && /Storyline/.test(e.errors[0].hint));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(file + '.history.json'), false);
  assert.equal(fs.existsSync(file + '.' + process.pid + '.tmp'), false);
});

test('native snapshot write failure happens before the course changes', (t) => {
  const file = seed(temp()), before = fs.readFileSync(file), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (String(target).startsWith(file + '.history' + path.sep)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return write(target, ...args);
  });
  assert.throws(() => io.runCommands(file, title('Change')), { code: 'ENOSPC' });
  assert.ok(fs.readFileSync(file).equals(before));
  assert.equal(fs.existsSync(file + '.history.json'), false);
});

test('native corrupt snapshots refuse without writing; redo branches prune only unused snapshots', () => {
  const file = seed(temp());
  io.runCommands(file, title('One'));
  io.runCommands(file, title('Two'));
  const folder = file + '.history', ignored = path.join(folder, 'user-note.txt');
  fs.writeFileSync(ignored, 'keep');
  assert.equal(fs.readdirSync(folder).filter(n => n.endsWith('.story')).length, 3);
  io.history.undo(file);
  io.runCommands(file, title('Branch'));
  assert.equal(io.history.depth(file).redo, 0);
  assert.equal(fs.readdirSync(folder).filter(n => n.endsWith('.story')).length, 3);
  assert.equal(fs.readFileSync(ignored, 'utf8'), 'keep');
  const hist = fs.readFileSync(file + '.history.json'), current = fs.readFileSync(file);
  const entry = JSON.parse(hist).undo.at(-1);
  fs.appendFileSync(path.join(folder, entry.native.before + '.story'), 'changed');
  assert.throws(() => io.history.undo(file), code('history'));
  assert.ok(fs.readFileSync(file).equals(current));
  assert.ok(fs.readFileSync(file + '.history.json').equals(hist));
});

test('native history never crosses an external edit boundary or uses legacy model patches', () => {
  const file = seed(temp());
  io.runCommands(file, title('One'));
  const doc = io.loadCourse(file); doc.title = 'Outside history'; io.saveCourse(file, doc);
  const outside = fs.readFileSync(file);
  io.runCommands(file, title('Two'));
  io.history.undo(file);
  assert.ok(fs.readFileSync(file).equals(outside));
  assert.throws(() => io.history.undo(file), code('history'));
  fs.writeFileSync(file + '.history.json', JSON.stringify({ undo: [{ u: [], r: [] }], redo: [] }));
  assert.equal(io.history.undo(file), null);
});

test('CLI native create, validate, edit, undo, redo and import copy preserve .story bytes', () => {
  const root = temp(), file = path.join(root, 'new.story');
  const cf = (...args) => { const r = spawnSync(process.execPath, ['packages/cli/cf.js', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  cf('new', file, '--title', 'CLI');
  cf('validate', file);
  cf('cmd', file, JSON.stringify(title('Edited')));
  cf('undo', file); assert.equal(io.loadCourse(file).title, 'CLI');
  cf('redo', file); assert.equal(io.loadCourse(file).title, 'Edited');
  const copied = path.join(root, 'copy.story');
  cf('import', file, copied);
  assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(file));
  const published = path.join(root, 'published');
  cf('publish', file, '--scorm12', published);
  assert.ok(fs.existsSync(path.join(published, 'imsmanifest.xml')));
});

test('HTTP lists both formats, edits native story with history and rejects ambiguous stems', async (t) => {
  const root = temp(), file = seed(root);
  io.saveCourse(path.join(root, 'json.course.json'), emptyCourse());
  const server = createServer({ root, port: 0, token: 'test' });
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = async (url, body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { headers: { 'x-cf-token': 'test' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }); return { status: r.status, ...await r.json() }; };
  assert.deepEqual((await api('/courses')).courses.map((c) => c.file).sort(), ['demo.story', 'json.course.json']);
  assert.equal((await api('/courses/demo/commands', { commands: title('HTTP') })).doc.title, 'HTTP');
  assert.equal((await api('/courses/demo/undo', {})).doc.title, 'Demo');
  assert.equal((await api('/courses/demo/redo', {})).doc.title, 'HTTP');
  assert.equal((await api('/courses', { name: 'native', format: 'story' })).status, 201);
  assert.ok(fs.existsSync(path.join(root, 'native.story')));
  const imported = await api('/import', { name: 'copy', format: 'story', path: 'demo.story' });
  assert.equal(imported.status, 201);
  assert.deepEqual(fs.readFileSync(path.join(root, 'copy.story')), fs.readFileSync(file));
  assert.ok(imported.reportFile && imported.summary);
  io.saveCourse(path.join(root, 'demo.course.json'), emptyCourse());
  assert.equal((await api('/courses/demo')).status, 409);
  assert.equal(io.loadCourse(file).title, 'HTTP');
});

test('MCP real I/O opens, edits, undoes, redoes and creates native story files', async () => {
  const root = temp(), file = seed(root), stdin = new PassThrough(), stdout = new PassThrough();
  createMcp({ root, stdin, stdout, io, core: { ...core, emptyCourse, query: (d, n, a) => core.query(d, n, a).data }, runtime: {} });
  let id = 0;
  const call = async (name, args) => {
    const data = once(stdout, 'data');
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const message = JSON.parse((await data)[0].toString());
    const r = JSON.parse(message.result.content[0].text); assert.equal(r.ok, true, JSON.stringify(r)); return r;
  };
  assert.equal((await call('get_course', { file: 'demo.story' })).doc.title, 'Demo');
  await call('run_commands', { file: 'demo.story', commands: title('MCP') });
  await call('undo', { file: 'demo.story' }); assert.equal(io.loadCourse(file).title, 'Demo');
  await call('redo', { file: 'demo.story' }); assert.equal(io.loadCourse(file).title, 'MCP');
  await call('new_course', { file: 'new.story', title: 'New' });
  assert.equal(io.loadCourse(path.join(root, 'new.story')).title, 'New');
  await call('import_story', { story: 'demo.story', file: 'copy.story' });
  assert.deepEqual(fs.readFileSync(path.join(root, 'copy.story')), fs.readFileSync(file));
});
