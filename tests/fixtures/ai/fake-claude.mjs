// Imitates `claude -p --output-format stream-json` for tests. FAKE_CLAUDE_MODE picks the script; the argv and the
// stdin prompt are written to FAKE_CLAUDE_LOG so tests can check what the app passed.
import fs from 'node:fs';

const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
const prompt = fs.readFileSync(0, 'utf8');
if (process.env.FAKE_CLAUDE_LOG) fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), prompt }));
if (process.argv.includes('--version')) { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: mode !== 'auth' })); process.exit(0); }

const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const tool = (n) => say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__cf__describe_course', input: { file: `x${n}` } }] } });
say({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] });
if (mode === 'ok') {
  tool(1);
  say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Renamed the title.' }] } });
  say({ type: 'result', subtype: 'success', is_error: false, result: 'Renamed the title.', total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 5 } });
} else if (mode === 'loop') {
  for (let i = 1; i < 50; i++) tool(i);
  say({ type: 'result', subtype: 'success', is_error: false, result: 'never reached' });
} else if (mode === 'auth') {
  say({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', total_cost_usd: 0 });
} else if (mode === 'crash') {
  process.stderr.write('something broke\n');
  process.exit(3);
}
