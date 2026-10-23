// Claude Code CLI provider: `claude -p` in stream-json mode on the user's own sign-in (no API key in this app).
// Isolation from the user's own Claude setup uses flags only: --safe-mode (no CLAUDE.md, hooks, plugins, styles),
// --strict-mcp-config (only our course server), --tools "" (no built-in tools) and --permission-mode dontAsk
// (anything not on the allow list is refused, never prompted). Prompts travel on stdin, the system prompt in a file.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MODELS = { fast: 'claude-haiku-5-5', default: 'claude-sonnet-5-5', best: 'claude-opus-5-5' };

const fail = (code, message, hint) => ({ code, message, ...(hint ? { hint } : {}) });
export const INSTALL_HINT = 'Install Claude Code from https://claude.com/claude-code, run "claude" once in a terminal and sign in, then try again.';
const LOGIN_HINT = 'Open a terminal, run "claude", type /login and sign in with your Claude account, then try again.';

/** [command, leading args, extra env] for the CLI. CF_CLAUDE_BIN points tests at a script that imitates it. */
export function claudeCommand(env = process.env) {
  const nodeEnv = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  if (env.CF_CLAUDE_BIN) return /\.[cm]?js$/.test(env.CF_CLAUDE_BIN) ? [process.execPath, [env.CF_CLAUDE_BIN], nodeEnv] : [env.CF_CLAUDE_BIN, [], {}];
  if (process.platform === 'win32') { // the npm shim is a .cmd that needs a shell; run the real exe it points to
    for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
      for (const exe of [path.join(dir, 'claude.exe'), path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]) {
        if (fs.existsSync(exe)) return [exe, [], {}];
      }
    }
  }
  return ['claude', [], {}];
}

/** Is the CLI installed and signed in? Never throws. */
export function probe() {
  const [cmd, pre, env] = claudeCommand();
  const run = (args) => spawnSync(cmd, [...pre, ...args], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, ...env } });
  const v = run(['--version']);
  if (v.error || v.status !== 0) return { available: false, version: null, loggedIn: false, detail: fail('not-installed', 'Claude Code is not installed on this computer.', INSTALL_HINT) };
  const version = /\d+\.\d+\.\d+/.exec(v.stdout)?.[0] ?? null;
  let loggedIn = null;
  try { loggedIn = JSON.parse(run(['auth', 'status', '--json']).stdout).loggedIn === true; } catch { /* older CLI: unknown until the first call */ }
  return { available: true, version, loggedIn, detail: loggedIn === false ? fail('not-signed-in', 'Claude Code is installed but not signed in.', LOGIN_HINT) : null };
}

/** Classify a failed result into a plain-language error. */
function classify(text) {
  if (/login|log in|api key|authenticat|unauthori[sz]ed|oauth/i.test(text)) return fail('not-signed-in', 'Claude Code is not signed in.', LOGIN_HINT);
  if (/usage limit|rate.?limit|overloaded|429|529|limit reached/i.test(text)) return fail('busy', 'Claude is at its usage limit or busy right now.', 'Wait a few minutes and try again. Your course was not changed.');
  return fail('ai-error', `Claude stopped with an error: ${text.slice(0, 300)}`, 'Try again. If it keeps happening, check that Claude Code works in a terminal.');
}

/**
 * Run one agent task. Resolves (never rejects) with
 * {ok, text, structured, turns, costUsd, usage, tools:[{name, input}], error?}. `jsonSchema` asks for structured output;
 * `tools`/`addDirs` let a run read attached files (Read, inside those folders only).
 */
export function run({ system, prompt, model = MODELS.default, mcpConfig, allowedTools = [], tools = '', addDirs = [], jsonSchema, maxTurns = 12, cwd, timeoutMs = 300000, onEvent = () => {} }) {
  const [cmd, pre, env] = claudeCommand();
  fs.mkdirSync(cwd, { recursive: true });
  const systemFile = path.join(cwd, 'system-prompt.md');
  fs.writeFileSync(systemFile, system);
  const args = [...pre, '-p', '--safe-mode', '--strict-mcp-config', ...(mcpConfig ? ['--mcp-config', mcpConfig] : []),
    '--tools', tools, ...addDirs.flatMap((d) => ['--add-dir', d]), ...(jsonSchema ? ['--json-schema', JSON.stringify(jsonSchema)] : []), ...(allowedTools.length ? ['--allowedTools', allowedTools.join(',')] : []), '--permission-mode', 'dontAsk',
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', model, '--system-prompt-file', systemFile];
  return new Promise((resolve) => {
    const out = { ok: false, text: '', structured: null, turns: 0, costUsd: 0, usage: null, tools: [] };
    let buf = '', stderr = '', done = false, stopped = null;
    const finish = (extra) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...out, ...extra }); };
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env, ...env } }); } catch (e) { return finish({ error: fail('not-installed', `Claude Code could not be started: ${e.message}`, INSTALL_HINT) }); }
    const stop = (error) => { stopped = error; child.kill(); };
    const timer = setTimeout(() => stop(fail('timeout', `Claude did not finish within ${Math.round(timeoutMs / 1000)} seconds.`, 'Try a smaller request.')), timeoutMs);
    const onLine = (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'assistant') {
        const parts = ev.message?.content ?? [];
        for (const p of parts) {
          if (p.type === 'text' && p.text) onEvent({ type: 'text', text: p.text });
          if (p.type === 'tool_use') { out.tools.push({ name: p.name, input: p.input }); onEvent({ type: 'tool', name: p.name.replace(/^mcp__cf__/, ''), input: p.input }); }
        }
        if (parts.some((p) => p.type === 'tool_use') && ++out.turns > maxTurns) stop(fail('turn-limit', `Claude needed more than ${maxTurns} steps.`, 'Split the request into smaller ones. Nothing was applied.'));
      } else if (ev.type === 'result') {
        out.text = typeof ev.result === 'string' ? ev.result : '';
        out.structured = ev.structured_output ?? null;
        out.costUsd = Number(ev.total_cost_usd) || 0;
        out.usage = ev.usage ?? null;
        out.ok = ev.is_error !== true && (!ev.subtype || ev.subtype === 'success');
        if (!out.ok) out.error = classify(`${ev.subtype ?? ''} ${out.text} ${(ev.errors ?? []).join(' ')}`);
      }
    };
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? fail('not-installed', 'Claude Code is not installed on this computer.', INSTALL_HINT) : fail('ai-error', e.message) }));
    child.on('close', (code) => {
      if (buf) onLine(buf);
      if (stopped) return finish({ ok: false, error: stopped });
      if (out.ok || out.error) return finish({});
      finish({ ok: false, error: classify(stderr.trim() || `exit code ${code}`) });
    });
    child.stdin.on('error', () => { /* the CLI may exit before reading stdin */ });
    child.stdin.end(prompt, 'utf8');
  });
}
