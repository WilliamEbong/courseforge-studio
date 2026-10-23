// Isolation check against the real Claude Code CLI (skipped when it is not installed). It reads only the init event and
// stops the CLI before any request finishes: the course MCP server must be connected, and none of the user's own
// plugins, skills or tools may load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claude from '../../packages/ai/claude.js';
import { mcpConfigFor, ALLOWED } from '../../packages/ai/assistant.js';

const SAMPLE = fileURLToPath(new URL('../../samples/lab-safety.course.json', import.meta.url));

test('real CLI: the course server is connected and the user setup stays out', { skip: !(await claude.probe()).available && 'Claude Code is not installed', timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-live-'));
  fs.copyFileSync(SAMPLE, path.join(dir, 'x.course.json'));
  fs.writeFileSync(path.join(dir, 'system.md'), 'Reply OK.');
  const [cmd, pre, env] = claude.claudeCommand();
  const args = [...pre, ...claude.buildArgs({ systemFile: path.join(dir, 'system.md'), model: claude.MODELS.fast, mcpConfig: mcpConfigFor(dir, 'x.course.json', dir), allowedTools: ALLOWED })];
  const init = await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: dir, windowsHide: true, env: { ...process.env, ...env } });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n')) { try { const ev = JSON.parse(line); if (ev.subtype === 'init') { child.kill(); resolve(ev); } } catch { /* partial line */ } }
    });
    child.on('error', reject);
    child.on('close', () => reject(new Error('no init event')));
    child.stdin.end('Reply OK.');
  });
  assert.deepEqual(init.mcp_servers.map((s) => [s.name, s.status]), [['cf', 'connected']]);
  assert.ok(init.tools.every((t) => t.startsWith('mcp__cf__')), `only course tools: ${init.tools}`);
  assert.ok((init.plugins ?? []).every((p) => p.path === 'builtin'), `no user plugins: ${JSON.stringify(init.plugins)}`);
  assert.equal((init.skills ?? []).length, 0);
});
