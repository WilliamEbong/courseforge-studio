// Human/AI parity at the process level: the same command batch applied through the real MCP stdio server
// and through the `cf` CLI must produce byte-identical course files (constitution principle I).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lines = fs.readFileSync(path.join(ROOT, 'samples/lab-safety.cmds.jsonl'), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('//'));
const commands = lines.map((l) => JSON.parse(l));

function mcpSession(root) {
  const child = spawn(process.execPath, [path.join(ROOT, 'packages/mcp/server.js'), '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => { const n = ++id; waiters.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { call, close: () => child.kill() };
}

test('MCP run_commands and cf batch produce identical files; describe matches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-parity-'));
  // CLI path
  const cliFile = path.join(root, 'cli.course.json');
  spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/cf.js'), 'new', cliFile, '--id', 'lab-safety', '--title', 'Lab'], { encoding: 'utf8' });
  const r1 = spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/cf.js'), 'batch', cliFile, path.join(ROOT, 'samples/lab-safety.cmds.jsonl')], { encoding: 'utf8' });
  assert.equal(r1.status, 0, r1.stderr);
  // MCP path (same starting doc: copy the CLI's empty course as the MCP starting point is created by new_course with a different id)
  const s = mcpSession(root);
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity-test', version: '1' } });
    assert.ok(init.result.serverInfo);
    const tools = (await s.call('tools/list', {})).result.tools.map((t) => t.name);
    assert.ok(tools.includes('run_commands'));
    fs.writeFileSync(path.join(root, 'mcp.course.json'), JSON.stringify({ schema: 'cf.course/1', id: 'lab-safety', title: 'Lab', scenes: [{ id: 'sc-1', title: 'Scene 1', slides: [] }] }));
    const res = await s.call('tools/call', { name: 'run_commands', arguments: { file: 'mcp.course.json', commands } });
    assert.notEqual(res.result.isError, true, res.result.content?.[0]?.text);
    assert.equal(fs.readFileSync(path.join(root, 'mcp.course.json'), 'utf8'), fs.readFileSync(cliFile, 'utf8'));
    const desc = await s.call('tools/call', { name: 'describe_course', arguments: { file: 'mcp.course.json' } });
    const cliDesc = spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/cf.js'), 'describe', cliFile], { encoding: 'utf8' }).stdout.trim();
    assert.ok(desc.result.content[0].text.includes(cliDesc.split('\n')[1]), 'MCP describe contains the same outline');
    // Errors are equally actionable through MCP.
    const bad = await s.call('tools/call', { name: 'run_commands', arguments: { file: 'mcp.course.json', commands: [{ cmd: 'slide.remove', args: { id: 's-q1' } }] } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /still referenced/);
    const play = await s.call('tools/call', { name: 'play', arguments: { file: 'mcp.course.json', events: [{ type: 'start' }, { type: 'input', target: 'o-w-name', text: 'Ana' }, { type: 'click', target: 'o-w-start' }] } });
    assert.match(play.result.content[0].text, /enter s-objectives/);
  } finally { s.close(); }
});
