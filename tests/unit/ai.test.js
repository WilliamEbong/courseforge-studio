// AI core: the Claude CLI provider (against a script that imitates the CLI), settings and daily limits, and the
// assistant's draft → change card → apply (one undo step) / discard / conflict flow with the fake provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claude from '../../packages/ai/claude.js';
import { createSettings } from '../../packages/ai/settings.js';
import { createAssistant, fakeProvider, lineDiff, ALLOWED } from '../../packages/ai/assistant.js';
import * as io from '../../packages/cli/io.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, '../fixtures/ai/fake-claude.mjs');
const SAMPLE = path.join(HERE, '../../samples/lab-safety.course.json');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-ai-'));

function withFake(mode, fn) {
  const log = path.join(tmp(), 'log.json');
  Object.assign(process.env, { CF_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log });
  return Promise.resolve(fn(log)).finally(() => { delete process.env.CF_CLAUDE_BIN; delete process.env.FAKE_CLAUDE_MODE; delete process.env.FAKE_CLAUDE_LOG; });
}

test('provider: passes the model, isolation flags and allow list; prompt on stdin; parses tools, text and cost', () => withFake('ok', async (log) => {
  const events = [];
  const r = await claude.run({ system: 'sys', prompt: 'make the title shorter', model: claude.MODELS.fast, mcpConfig: 'mcp.json', allowedTools: ALLOWED, cwd: tmp(), onEvent: (e) => events.push(e) });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Renamed the title.');
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.turns, 1);
  const { argv, prompt } = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.equal(prompt, 'make the title shorter');
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-5-5');
  for (const flag of ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf('--tools') + 1], '', 'no built-in tools');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], ALLOWED.join(','));
  assert.ok(!ALLOWED.some((t) => /publish|import_story|new_course|undo|redo/.test(t)), 'no file-creating or history tools');
  assert.deepEqual(events.map((e) => e.type), ['tool', 'text']);
}));

test('provider: stops a runaway agent at the turn limit', () => withFake('loop', async () => {
  const r = await claude.run({ system: 's', prompt: 'p', maxTurns: 3, cwd: tmp() });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'turn-limit');
}));

test('provider: plain-language errors for a signed-out CLI, a crash and a missing CLI', async () => {
  await withFake('auth', async () => { const r = await claude.run({ system: 's', prompt: 'p', cwd: tmp() }); assert.equal(r.error.code, 'not-signed-in'); assert.match(r.error.hint, /\/login/); });
  await withFake('crash', async () => { const r = await claude.run({ system: 's', prompt: 'p', cwd: tmp() }); assert.equal(r.ok, false); assert.match(r.error.message, /something broke/); });
  process.env.CF_CLAUDE_BIN = path.join(tmp(), 'no-such-claude.exe');
  try { const r = await claude.run({ system: 's', prompt: 'p', cwd: tmp() }); assert.equal(r.error.code, 'not-installed'); assert.equal(claude.probe().available, false); }
  finally { delete process.env.CF_CLAUDE_BIN; }
});

test('probe: version and sign-in state', () => withFake('ok', () => assert.deepEqual(claude.probe(), { available: true, version: '9.9.9', loggedIn: true, detail: null })));

test('settings: AI is off until enabled; the daily limit refuses before anything runs; failures are counted', () => {
  const s = createSettings(tmp());
  assert.throws(() => s.check(), (e) => e.errors[0].code === 'ai-off');
  s.set({ enabled: true, dailyRequests: 2 });
  s.check();
  s.record({ ok: true, costUsd: 0.5 });
  s.record({ ok: false });
  assert.throws(() => s.check(), (e) => e.errors[0].code === 'daily-limit');
  assert.deepEqual(s.get().today, { requests: 2, failures: 1, costUsd: 0.5 });
  assert.throws(() => s.set({ model: 'gpt' }));
});

test('lineDiff: changed lines with one line of context and gaps between hunks', () => {
  const d = lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nf\nG');
  assert.deepEqual(d.map((x) => x.op + x.line), [' a', '-b', '+B', ' c', '…', ' f', '-g', '+G']);
  assert.deepEqual(lineDiff('same', 'same'), []);
});

function course() {
  const root = tmp(), file = path.join(root, 'demo.course.json');
  fs.copyFileSync(SAMPLE, file);
  return { root, file };
}
const rename = { commands: [{ cmd: 'course.set', args: { title: 'Lab Safety, Shorter' } }], summary: 'Renamed the course. Nothing else changed.' };

test('assistant: the change lands on a draft; Apply is one undo step labelled for the AI; Undo restores', async () => {
  const { root, file } = course();
  const a = createAssistant({ root, dataDir: tmp(), provider: fakeProvider([rename]) });
  assert.rejects(a.ask({ file, prompt: 'x' }), (e) => e.errors[0].code === 'ai-off');
  a.settings.set({ enabled: true });
  const original = fs.readFileSync(file, 'utf8');
  const card = await a.ask({ file, prompt: 'shorten the title' });
  assert.equal(card.changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'the course is untouched until Apply');
  assert.ok(card.diff.some((l) => l.op === '+' && l.line.includes('Lab Safety, Shorter')));
  assert.deepEqual(card.commands, rename.commands);
  a.apply(card.draftId);
  assert.equal(io.loadCourse(file).title, 'Lab Safety, Shorter');
  assert.equal(io.history.depth(file).undoLabel, 'AI: Renamed the course.');
  io.history.undo(file);
  assert.equal(io.loadCourse(file).title, 'Lab Safety Essentials');
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith('.ai-draft')), [], 'drafts are cleaned up');
  assert.equal(a.settings.get().today.requests, 1);
});

test('assistant: a course edited meanwhile refuses Apply; Discard removes the draft; no-op requests leave no draft', async () => {
  const { root, file } = course();
  const a = createAssistant({ root, dataDir: tmp(), provider: fakeProvider([rename, { summary: 'Nothing needed changing.' }]) });
  a.settings.set({ enabled: true });
  const card = await a.ask({ file, prompt: 'shorten the title' });
  const t = new Date(Date.now() + 5000);
  io.runCommands(file, [{ cmd: 'course.set', args: { description: 'edited by hand' } }]);
  fs.utimesSync(file, t, t);
  assert.throws(() => a.apply(card.draftId), (e) => e.status === 409 && e.errors[0].code === 'conflict');
  assert.equal(io.loadCourse(file).title, 'Lab Safety Essentials');
  const none = await a.ask({ file, prompt: 'is it fine?' });
  assert.deepEqual([none.changed, none.draftId], [false, null]);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith('.ai-draft')), []);
  assert.throws(() => a.apply('missing'), (e) => e.status === 404);
});

test('assistant: a failed run reports a plain error, counts as used and leaves no draft', async () => {
  const { root, file } = course();
  const a = createAssistant({ root, dataDir: tmp(), provider: fakeProvider([{ error: { code: 'busy', message: 'Claude is busy.', hint: 'Wait.' } }]) });
  a.settings.set({ enabled: true });
  await assert.rejects(a.ask({ file, prompt: 'x' }), (e) => e.errors[0].code === 'busy' && e.errors[0].hint === 'Wait.');
  assert.deepEqual(a.settings.get().today, { requests: 1, failures: 1, costUsd: 0 });
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith('.ai-draft')), []);
});
