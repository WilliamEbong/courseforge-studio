// `cf` end-to-end through real processes: what an AI agent (or a human in a shell) actually runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CF = path.join(ROOT, 'packages/cli/cf.js');
const cf = (args, input) => {
  const r = spawnSync(process.execPath, [CF, ...args], { cwd: ROOT, input, encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* text output */ }
  let err = null;
  try { err = JSON.parse(r.stderr); } catch { /* none */ }
  return { code: r.status, out: r.stdout, json, err };
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cli-'));

test('cf builds the Lab Safety sample from JSONL and its scenario passes', () => {
  const f = path.join(tmp(), 'lab.course.json');
  assert.equal(cf(['new', f, '--id', 'lab-safety', '--title', 'Lab']).code, 0);
  const b = cf(['batch', f, 'samples/lab-safety.cmds.jsonl', '--seed', '1']);
  assert.equal(b.code, 0, b.err && JSON.stringify(b.err));
  assert.equal(cf(['validate', f]).code, 0);
  const t = cf(['test', f, 'samples/lab-safety.scenario.json']);
  assert.equal(t.code, 0, t.err && JSON.stringify(t.err));
  assert.equal(t.json.slide, 's-results');
  // The committed sample must equal a fresh build (keeps samples/ honest).
  assert.equal(fs.readFileSync(f, 'utf8'), fs.readFileSync(path.join(ROOT, 'samples/lab-safety.course.json'), 'utf8'));
});

test('cf cmd: atomic failure exits 1 with machine-actionable errors and leaves the file untouched', () => {
  const f = path.join(tmp(), 'a.course.json');
  cf(['new', f]);
  const before = fs.readFileSync(f, 'utf8');
  const r = cf(['cmd', f, JSON.stringify([{ cmd: 'slide.add', args: { id: 's-1' } }, { cmd: 'object.add', args: { slide: 's-nope', type: 'text' } }])]);
  assert.equal(r.code, 1);
  assert.equal(r.err.errors[0].code, 'ref');
  assert.equal(r.err.errors[0].index, 1);
  assert.match(r.err.errors[0].hint, /s-1/);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
});

test('cf cmd via stdin, describe, query, undo/redo', () => {
  const f = path.join(tmp(), 'b.course.json');
  cf(['new', f]);
  assert.equal(cf(['cmd', f, '-'], JSON.stringify({ cmd: 'slide.add', args: { id: 's-1', title: 'One' } })).code, 0);
  assert.match(cf(['describe', f]).out, /slide s-1 "One"/);
  assert.equal(cf(['query', f, 'slide.get', '{"id":"s-1"}']).json.title, 'One');
  assert.equal(cf(['undo', f]).code, 0);
  assert.doesNotMatch(cf(['describe', f]).out, /s-1/);
  assert.equal(cf(['redo', f]).code, 0);
  assert.match(cf(['describe', f]).out, /s-1/);
  assert.equal(cf(['undo', path.join(tmp(), 'missing.course.json')]).code, 1);
});

test('cf usage errors exit 2; unknown file exits 1 with a hint', () => {
  assert.equal(cf(['frobnicate']).code, 2);
  assert.equal(cf(['cmd']).code, 2);
  const r = cf(['describe', path.join(tmp(), 'nope.course.json')]);
  assert.equal(r.code, 1);
  assert.match(r.err.errors[0].hint, /cf new/);
});

test('cf commands, schema and markdown reference are self-describing', () => {
  const list = cf(['commands']).json;
  assert.ok(list.length >= 30);
  assert.ok(cf(['commands', 'trigger.add']).json.examples.length > 0);
  assert.equal(cf(['schema']).json.title, 'CourseForge Studio course document v1');
  assert.match(cf(['commands', '--markdown']).out, /## trigger\.add/);
});

test('cf play prints a deterministic trace', () => {
  const ev = '{"type":"click","target":"o-w-name"}\n{"type":"input","target":"o-w-name","text":"Kim"}\n{"type":"click","target":"o-w-start"}\n';
  const a = cf(['play', 'samples/lab-safety.course.json', '-'], ev);
  const b = cf(['play', 'samples/lab-safety.course.json', '-'], ev);
  assert.equal(a.code, 0);
  assert.deepEqual(a.json.trace, b.json.trace);
  assert.equal(a.json.vars.learner, 'Kim');
  assert.equal(a.json.slide, 's-objectives');
});

test('cf app: first run copies the samples into the projects folder and prints the URL; a second launch reuses the running editor', async () => {
  const { spawn } = await import('node:child_process');
  const root = path.join(tmp(), 'CourseForge Studio');
  const a = spawn(process.execPath, [CF, 'app', '--no-open', '--root', root, '--port', '0']);
  let first;
  try {
    let text = '';
    first = await new Promise((resolve, reject) => {
      a.stdout.on('data', (d) => { text += d; try { resolve(JSON.parse(text)); } catch { /* wait for the whole object */ } });
      a.on('exit', (c) => reject(new Error(`cf app exited ${c}`)));
      setTimeout(() => reject(new Error('no URL within 10 s')), 10000);
    });
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]{24,}$/);
    assert.equal(first.root, root);
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.endsWith('.course.json')).sort(), ['lab-basics-lessons.course.json', 'lab-safety.course.json']);
    const port = new URL(first.url).port;
    const b = spawnSync(process.execPath, [CF, 'app', '--no-open', '--root', root, '--port', port], { encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    assert.equal(JSON.parse(b.stdout).url, first.url, 'the second launch opens the running editor');
  } finally {
    try {
      if (process.platform === 'win32' && first) {
        // taskkill /T needs permissions unavailable in the sandbox; the printed port identifies our server child.
        const sockets = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
        assert.equal(sockets.status, 0, sockets.stderr);
        const address = `127.0.0.1:${new URL(first.url).port}`;
        const row = sockets.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(fields => fields[0] === 'TCP' && fields[1] === address && fields[3] === 'LISTENING');
        if (row) process.kill(Number(row[4]));
        else await assert.rejects(fetch(first.url, { signal: AbortSignal.timeout(1000) }), 'test server is still reachable but its PID was not found');
      }
    } finally { a.kill(); }
  }
});

// FR-B2: when the desktop program cannot start, the reason is written where the launcher can show it.
test('cf app: a port taken by another program exits non-zero and writes the reason to CourseForge Studio/last-error.txt', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process'); // async: the stand-in server below must keep answering
  const other = http.createServer((q, r) => r.end('not cf')).listen(0, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  const local = tmp();
  try {
    const child = spawn(process.execPath, [CF, 'app', '--no-open', '--root', path.join(local, 'Projects'), '--port', String(other.address().port)], { env: { ...process.env, LOCALAPPDATA: local } });
    const status = await new Promise((resolve) => { child.on('exit', resolve); setTimeout(() => { child.kill(); resolve('timeout'); }, 20000); });
    assert.equal(status, 1);
    const log = fs.readFileSync(path.join(local, 'CourseForge Studio', 'last-error.txt'), 'utf8');
    assert.match(log, /port \d+ is used by another program/);
  } finally { other.close(); }
});

test('cf app: a projects folder that cannot be created is reported in last-error.txt (Codex review 007 #11)', async () => {
  const { spawn } = await import('node:child_process');
  const local = tmp();
  const blocker = path.join(local, 'not-a-folder');
  fs.writeFileSync(blocker, 'a file where the projects folder should go');
  const child = spawn(process.execPath, [CF, 'app', '--no-open', '--root', path.join(blocker, 'CourseForge Studio'), '--port', '0'], { env: { ...process.env, LOCALAPPDATA: local } });
  const status = await new Promise((resolve) => { child.on('exit', resolve); setTimeout(() => { child.kill(); resolve('timeout'); }, 20000); });
  assert.equal(status, 1);
  assert.match(fs.readFileSync(path.join(local, 'CourseForge Studio', 'last-error.txt'), 'utf8'), /could not set up the projects folder/);
});
