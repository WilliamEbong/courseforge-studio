// HTTP AI endpoints with the fake provider: status/settings, ask (NDJSON progress then a change card), apply, discard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../../packages/server/server.js';
import { fakeProvider } from '../../packages/ai/assistant.js';

test('AI endpoints: off by default, enable, ask streams progress and a card, apply changes the course, discard does not', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-sai-')), root = path.join(tmp, 'courses');
  fs.mkdirSync(root);
  fs.copyFileSync(new URL('../../samples/lab-safety.course.json', import.meta.url), path.join(root, 'lab.course.json'));
  const steps = [{ commands: [{ cmd: 'course.set', args: { title: 'Renamed' } }], summary: 'Renamed it.' }];
  const server = createServer({ root, token: 'tok-0123456789abcdefghij', port: 0, dataDir: path.join(tmp, 'data'), aiProvider: fakeProvider(steps) });
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (p, body) => fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'x-cf-token': 'tok-0123456789abcdefghij', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const ask = async (prompt) => (await (await call('/courses/lab/ai/ask', { prompt })).text()).trim().split('\n').map((l) => JSON.parse(l));

  const status = await (await call('/ai')).json();
  assert.equal(status.enabled, false);
  assert.equal(typeof status.cli.available, 'boolean');
  const off = await ask('rename');
  assert.equal(off.at(-1).errors[0].code, 'ai-off');

  assert.equal((await (await call('/ai', { enabled: true })).json()).enabled, true);
  const lines = await ask('rename');
  assert.deepEqual(lines.map((l) => l.type), ['status', 'tool', 'text', 'done']);
  const card = lines.at(-1).card;
  const applied = await (await call('/courses/lab/ai/apply', { draftId: card.draftId })).json();
  assert.equal(applied.doc.title, 'Renamed');
  assert.equal(applied.history.undoLabel, 'AI: Renamed it.');

  const second = (await ask('rename again')).at(-1).card;
  assert.deepEqual(await (await call('/courses/lab/ai/discard', { draftId: second.draftId })).json(), { ok: true });
  assert.equal((await call('/courses/lab/ai/apply', { draftId: second.draftId })).status, 404);
});
