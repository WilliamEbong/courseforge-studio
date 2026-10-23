import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { resolve, join } from 'node:path';
import { createServer, MAX_MESSAGE } from '../../packages/mcp/server.js';

const ROOT = resolve('mcp-test-root'); // never touched on disk: io is in-memory

// In-memory fakes pinning the contracts server.js relies on (core, runtime, cli/io).
function fakes() {
  const files = new Map();
  const records = [];
  const core = {
    commands: { 'course.set': { name: 'course.set', summary: 'Set course fields', args: { type: 'object', properties: { title: { type: 'string' } } }, examples: [{ args: { title: 'Demo' } }] } },
    emptyCourse: ({ title = 'Untitled course', mode } = {}) => ({ schema: 'cf.course/1', id: 'course', title, ...(mode ? { mode } : {}) }),
    applyAll(doc, cmds) {
      let d = doc;
      for (const [i, c] of cmds.entries()) {
        if (c.cmd !== 'course.set') return { ok: false, errors: [{ path: `/${i}/cmd`, code: 'enum', message: `unknown command "${c.cmd}"`, hint: 'existing: course.set' }] };
        d = { ...d, ...c.args };
      }
      return { ok: true, doc: d, results: cmds.map(() => ({})), inverse: [{ cmd: 'course.set', args: { title: doc.title } }] };
    },
    query(doc, name) {
      if (name === 'course.describe') return `course ${doc.id}: ${doc.title}`;
      if (name === 'validate') return doc.title ? [] : [{ path: '/title', code: 'required', message: 'title is required' }];
      return { ok: false, errors: [{ path: '/name', code: 'ref', message: `unknown query "${name}"` }] };
    },
  };
  const io = {
    files,
    records,
    loadCourse(p) { if (!files.has(p)) throw Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' }); return structuredClone(files.get(p)); },
    saveCourse(p, doc) { files.set(p, structuredClone(doc)); },
    history: {
      record: (p, before, after) => records.push({ p, before, after }),
      undo: (p) => { if (!records.some((r) => r.p === p)) return null; const d = { ...files.get(p), title: 'undone' }; files.set(p, d); return d; }, // like io: saves
      redo: () => null,
    },
    // Same contract as cli/io.js: load (or create), apply atomically, save, record.
    runCommands(p, cmds, { create, emptyCourse } = {}) {
      let doc;
      try { doc = io.loadCourse(p); } catch (e) { if (e.code === 'ENOENT' && create) doc = emptyCourse(); else throw e; }
      const r = core.applyAll(doc, cmds);
      if (!r.ok) return r;
      io.saveCourse(p, r.doc);
      io.history.record(p, doc, r.doc);
      return r;
    },
  };
  const runtime = {
    createRuntime(doc) {
      const trace = [];
      return { trace, state: { course: doc.id }, start: () => trace.push('enter s-1'), tick: (ms) => trace.push(`tick ${ms}`), dispatch: (e) => trace.push(`${e.type} ${e.target ?? ''}`.trim()) };
    },
  };
  return { core, io, runtime };
}

function start(extra = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const deps = fakes();
  createServer({ ...deps, ...extra, root: ROOT, stdin, stdout });
  const inbox = [];
  const waiting = [];
  let buf = '';
  stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (waiting.length) waiting.shift()(m); else inbox.push(m);
    }
  });
  const next = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiting.push(r)));
  let id = 0;
  const send = (m) => stdin.write(JSON.stringify(m) + '\n');
  const rpc = (method, params) => { send({ jsonrpc: '2.0', id: ++id, method, params }); return next(); };
  const call = async (name, args) => {
    const { result } = await rpc('tools/call', { name, arguments: args });
    const t = result.content[0].text;
    return { isError: result.isError, body: t.startsWith('{') ? JSON.parse(t) : t };
  };
  return { ...deps, stdin, send, next, rpc, call };
}

const course = (s, file = 'demo.course.json', doc = { schema: 'cf.course/1', id: 'course', title: 'Demo' }) => s.io.files.set(join(ROOT, file), doc);

test('initialize handshake negotiates the version; notifications get no reply', async () => {
  const s = start();
  const r = await s.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2025-11-25');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.equal(r.result.serverInfo.name, 'courseforge-studio');
  assert.equal((await s.rpc('initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion, '2024-11-05');
  assert.equal((await s.rpc('initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion, '2025-11-25');
  s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const p = await s.rpc('ping');
  assert.deepEqual(p, { jsonrpc: '2.0', id: 4, result: {} }); // the notification produced nothing before this
});

test('ping, unknown method, parse error, invalid request', async () => {
  const s = start();
  assert.deepEqual((await s.rpc('ping')).result, {});
  assert.equal((await s.rpc('server/discover')).error.code, -32601);
  s.stdin.write('{not json\n');
  assert.deepEqual((await s.next()).error.code, -32700);
  s.send([{ jsonrpc: '2.0', id: 9, method: 'ping' }]);
  assert.equal((await s.next()).error.code, -32600);
});

test('tools/list returns every tool with a JSON Schema inputSchema', async () => {
  const { result } = await start().rpc('tools/list');
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['describe_course', 'get_course', 'import_story', 'list_commands', 'new_course', 'play', 'publish', 'query', 'redo', 'run_commands', 'undo', 'validate']);
  for (const t of result.tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 10, t.name);
    for (const r of t.inputSchema.required) assert.ok(r in t.inputSchema.properties, `${t.name}.${r}`);
  }
});

test('run_commands applies, saves and records history', async () => {
  const s = start();
  course(s);
  const r = await s.call('run_commands', { file: 'demo.course.json', commands: [{ cmd: 'course.set', args: { title: 'New' } }] });
  assert.equal(r.isError, false);
  assert.deepEqual(r.body, { ok: true, results: [{}] });
  assert.equal(s.io.files.get(join(ROOT, 'demo.course.json')).title, 'New');
  assert.equal(s.io.records.length, 1);
  assert.equal(s.io.records[0].before.title, 'Demo');
  assert.equal(s.io.records[0].after.title, 'New');
});

test('run_commands error is isError with machine-actionable errors; file unchanged', async () => {
  const s = start();
  course(s);
  const r = await s.call('run_commands', { file: 'demo.course.json', commands: [{ cmd: 'course.set', args: { title: 'X' } }, { cmd: 'slide.zap', args: {} }] });
  assert.equal(r.isError, true);
  assert.deepEqual(r.body.errors, [{ path: '/1/cmd', code: 'enum', message: 'unknown command "slide.zap"', hint: 'existing: course.set' }]);
  assert.equal(s.io.files.get(join(ROOT, 'demo.course.json')).title, 'Demo');
  assert.equal(s.io.records.length, 0);
  const missing = await s.call('run_commands', { file: 'nope.course.json', commands: [] });
  assert.equal(missing.body.errors[0].code, 'ref');
  const created = await s.call('run_commands', { file: 'nope.course.json', commands: [{ cmd: 'course.set', args: { title: 'C' } }], create: true });
  assert.equal(created.isError, false);
  assert.equal(s.io.files.get(join(ROOT, 'nope.course.json')).title, 'C');
});

test('tool arguments are schema-checked', async () => {
  const s = start();
  const r = await s.call('run_commands', { commands: 'x', extra: 1 });
  assert.equal(r.isError, true);
  assert.deepEqual(r.body.errors.map((e) => `${e.path} ${e.code}`).sort(), ['/commands type', '/extra unknown', '/file required']);
  assert.equal((await s.call('publish', { file: 'a', target: 'pdf', out: 'o' })).body.errors[0].code, 'enum');
});

test('paths outside the root are rejected', async () => {
  const s = start();
  course(s);
  for (const file of ['../escape.course.json', '..', '', 'a/../../x.json', resolve(ROOT, '..', 'evil.json'), resolve('/elsewhere/x.json')]) {
    const r = await s.call('get_course', { file });
    assert.equal(r.isError, true, file);
    assert.equal(r.body.errors[0].code, 'path', file);
  }
  assert.equal((await s.call('get_course', { file: join(ROOT, 'demo.course.json') })).isError, false); // absolute inside root is fine
  const pub = await s.call('publish', { file: 'demo.course.json', target: 'web', out: '../dist' });
  assert.deepEqual([pub.body.errors[0].path, pub.body.errors[0].code], ['/out', 'path']);
  assert.equal([...s.io.files.keys()].every((k) => k.startsWith(ROOT)), true);
});

test('oversized messages are rejected and the stream recovers', async () => {
  const s = start();
  s.stdin.write('x'.repeat(MAX_MESSAGE + 10) + '\n');
  const a = await s.next();
  assert.deepEqual([a.id, a.error.code], [null, -32600]);
  s.stdin.write('{"jsonrpc":"2.0","id":"big","method":"ping","pad":"' + 'y'.repeat(MAX_MESSAGE)); // unterminated, over the cap
  const b = await s.next();
  assert.deepEqual([b.id, b.error.code], [null, -32600]);
  s.stdin.write('"}\n'); // tail of the oversized line: discarded, no reply
  assert.deepEqual(await s.rpc('ping'), { jsonrpc: '2.0', id: 1, result: {} });
});

test('unknown tool is a protocol error (-32602)', async () => {
  const r = await start().rpc('tools/call', { name: 'rm_rf', arguments: {} });
  assert.equal(r.error.code, -32602);
  assert.equal(r.error.message, 'Unknown tool: rm_rf');
  assert.ok(r.error.data.tools.includes('run_commands'));
  assert.equal((await start().rpc('tools/call', { name: 'constructor' })).error.code, -32602);
});

test('remaining tools wire through to core, runtime, io and publisher', async () => {
  const published = [];
  const s = start({ publisher: { publishWeb: (doc, out) => { published.push([doc.id, out]); return { files: 3 }; } } });
  const lc = await s.call('list_commands', {});
  assert.deepEqual(lc.body.commands, [{ name: 'course.set', summary: 'Set course fields', args: { type: 'object', properties: { title: { type: 'string' } } }, examples: [{ args: { title: 'Demo' } }] }]);
  assert.equal((await s.call('list_commands', { name: 'nope' })).body.errors[0].hint, 'existing: course.set');

  assert.deepEqual((await s.call('new_course', { file: 'sub/a.course.json', title: 'A' })).body, { ok: true, file: 'sub/a.course.json' });
  assert.equal((await s.call('new_course', { file: 'sub/a.course.json' })).body.errors[0].code, 'dupe');
  assert.equal(s.io.files.get(join(ROOT, 'sub/a.course.json')).mode, undefined);
  assert.deepEqual((await s.call('new_course', { file: 'les.course.json', title: 'L', mode: 'lessons' })).body, { ok: true, file: 'les.course.json' });
  assert.equal(s.io.files.get(join(ROOT, 'les.course.json')).mode, 'lessons');
  const badMode = await s.call('new_course', { file: 'bad.course.json', mode: 'story' });
  assert.deepEqual([badMode.isError, badMode.body.errors[0].code, s.io.files.has(join(ROOT, 'bad.course.json'))], [true, 'enum', false]);
  assert.equal((await s.call('describe_course', { file: 'sub/a.course.json' })).body, 'course course: A');
  assert.equal((await s.call('get_course', { file: 'sub/a.course.json' })).body.doc.title, 'A');
  assert.deepEqual((await s.call('validate', { file: 'sub/a.course.json' })).body, { ok: true, errors: [] });
  assert.equal((await s.call('query', { file: 'sub/a.course.json', name: 'course.describe' })).body.data, 'course course: A');
  assert.equal((await s.call('query', { file: 'sub/a.course.json', name: 'bogus' })).isError, true);

  assert.equal((await s.call('undo', { file: 'sub/a.course.json' })).body.errors[0].code, 'history');
  await s.call('run_commands', { file: 'sub/a.course.json', commands: [{ cmd: 'course.set', args: { title: 'B' } }] });
  assert.deepEqual((await s.call('undo', { file: 'sub/a.course.json' })).body, { ok: true });
  assert.equal(s.io.files.get(join(ROOT, 'sub/a.course.json')).title, 'undone');
  assert.equal((await s.call('redo', { file: 'sub/a.course.json' })).isError, true);

  const play = await s.call('play', { file: 'sub/a.course.json', events: [{ type: 'start' }, { type: 'click', target: 'o-next' }, { type: 'tick', ms: 500 }] });
  assert.deepEqual(play.body, { ok: true, trace: ['enter s-1', 'click o-next', 'tick 500'], state: { course: 'course' } });

  assert.deepEqual((await s.call('publish', { file: 'sub/a.course.json', target: 'web', out: 'dist/a' })).body, { ok: true, out: 'dist/a', result: { files: 3 } });
  assert.deepEqual(published, [['course', join(ROOT, 'dist/a')]]);
  const scorm = await s.call('publish', { file: 'sub/a.course.json', target: 'scorm12', out: 'dist/a' });
  assert.deepEqual([scorm.isError, scorm.body.errors[0].code], [true, 'unavailable']);
});

test('MCP SCORM publish forwards the optional ZIP flag and rejects invalid values', async () => {
  const calls = [];
  const s = start({ publisher: { publishScorm12: (doc, out, options) => { calls.push(options); return { files: ['index.html', 'imsmanifest.xml'], ...(options.zip ? { zip: out + '.zip' } : {}) }; } } });
  await s.call('new_course', { file: 'course.course.json' });
  const args = { file: 'course.course.json', target: 'scorm12', out: 'dist/upload' };
  const zipped = await s.call('publish', { ...args, zip: true });
  assert.equal(zipped.body.result?.zip, join(ROOT, 'dist/upload.zip'));
  assert.equal(calls[0].zip, true);
  assert.equal(calls[0].courseDir, ROOT);
  const folder = await s.call('publish', args);
  assert.equal(folder.body.result.zip, undefined);
  assert.ok(!calls[1].zip);
  const bad = await s.call('publish', { ...args, zip: 'true' });
  assert.equal(bad.isError, true);
  assert.equal(bad.body.errors[0].path, '/zip');
  assert.equal((await s.call('publish', { ...args, target: 'web', zip: true })).body.errors[0].path, '/zip');
  assert.equal(calls.length, 2);
});
