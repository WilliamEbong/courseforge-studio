// Audit 2026-10 (server): byte ranges for media, AI drafts that nobody applies, and the course listing's .story reloads.
import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../packages/server/server.js';
import { createAssistant, fakeProvider } from '../../packages/ai/assistant.js';
import { writeStory } from '../../packages/export-story/index.js';

const TOKEN = 'test-token-0123456789';
const SAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../samples/lab-safety.course.json');
let server, base, tmp, root;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-audit-server-'));
  root = path.join(tmp, 'courses');
  server = createServer({ root, token: TOKEN, port: 0 });
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('media answers byte ranges so the editor can seek a video', async () => {
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'clip.mp4'), Buffer.from('0123456789'));
  const get = async (range) => {
    const res = await fetch(`${base}/assets/${TOKEN}/demo/assets/clip.mp4`, { headers: range ? { range } : {} });
    return { status: res.status, body: await res.text(), len: res.headers.get('content-length'), cr: res.headers.get('content-range'), ar: res.headers.get('accept-ranges') };
  };
  assert.deepEqual(await get(), { status: 200, body: '0123456789', len: '10', cr: null, ar: 'bytes' });
  assert.deepEqual(await get('bytes=2-5'), { status: 206, body: '2345', len: '4', cr: 'bytes 2-5/10', ar: 'bytes' });
  assert.deepEqual(await get('bytes=7-'), { status: 206, body: '789', len: '3', cr: 'bytes 7-9/10', ar: 'bytes' });
  assert.deepEqual(await get('bytes=-3'), { status: 206, body: '789', len: '3', cr: 'bytes 7-9/10', ar: 'bytes' });
  assert.deepEqual(await get('bytes=8-99'), { status: 206, body: '89', len: '2', cr: 'bytes 8-9/10', ar: 'bytes' });
  const bad = await get('bytes=10-');
  assert.deepEqual([bad.status, bad.cr], [416, 'bytes */10']);
  assert.equal((await get('bytes=0-1,4-5')).status, 200, 'multi-range falls back to the whole file');
});

test('listing courses twice does not reopen unchanged .story packages', async () => {
  for (const n of ['one', 'two']) fs.writeFileSync(path.join(root, `${n}.story`), writeStory({ title: n, text: 'Hello' }));
  const list = async () => (await (await fetch(`${base}/api/courses`, { headers: { 'x-cf-token': TOKEN } })).json()).courses;
  assert.deepEqual((await list()).filter((c) => c.format === 'story').map((c) => c.title), ['one', 'two']);
  const reads = mock.method(fs, 'readFileSync');
  try {
    assert.deepEqual((await list()).filter((c) => c.format === 'story').map((c) => c.title), ['one', 'two']);
    assert.equal(reads.mock.calls.filter((c) => /\.story$/.test(String(c.arguments[0]))).length, 0);
  } finally { reads.mock.restore(); }
});

test('a course that failed to load once (file locked, offline) is retried by the next listing', async () => {
  fs.writeFileSync(path.join(root, 'flaky.story'), writeStory({ title: 'flaky', text: 'Hello' }));
  const list = async () => (await (await fetch(`${base}/api/courses`, { headers: { 'x-cf-token': TOKEN } })).json()).courses.find((c) => c.name === 'flaky');
  const real = fs.readFileSync;
  const busy = mock.method(fs, 'readFileSync', function (f, ...rest) { if (/flaky\.story$/.test(String(f))) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real.call(this, f, ...rest); });
  try { assert.equal((await list()).invalid, true); } finally { busy.mock.restore(); }
  assert.equal((await list()).title, 'flaky');
});

test('an AI draft left unapplied (course switched, page reloaded) is swept by a later request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-audit-ai-')), file = path.join(dir, 'demo.course.json');
  fs.copyFileSync(SAMPLE, file);
  const rename = { commands: [{ cmd: 'course.set', args: { title: 'Shorter' } }], summary: 'Renamed.' };
  const a = createAssistant({ root: dir, dataDir: path.join(dir, '.data'), provider: fakeProvider([rename]) });
  a.settings.set({ enabled: true });
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const old = await a.ask({ file, prompt: 'shorten the title' });
    mock.timers.tick(2 * 60 * 60 * 1000);
    const fresh = await a.ask({ file, prompt: 'shorten the title' });
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(old.draftId)), [], 'the stale draft and its history are gone');
    assert.ok(fs.existsSync(path.join(dir, `.ai-draft-${fresh.draftId}.course.json`)));
    assert.throws(() => a.apply(old.draftId), (e) => e.status === 404);
    a.apply(fresh.draftId);
  } finally { mock.timers.reset(); fs.rmSync(dir, { recursive: true, force: true }); }
});
