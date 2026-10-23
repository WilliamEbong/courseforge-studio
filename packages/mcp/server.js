#!/usr/bin/env node
// CourseForge Studio MCP server: newline-delimited JSON-RPC 2.0 on stdio (logs on stderr only).
// A thin front-end over core/runtime/io; see specs/004-mcp (protocol facts verified in plan.md).
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PUBLISH_TARGETS } from '../core/publish-targets.js';
import { check, toJsonSchema } from '../schema/check.js';

// ponytail: legacy (initialize) era only; add server/discover + per-request _meta when a modern-only client matters.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MAX_MESSAGE = 5 * 1024 * 1024;

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const FILE = { type: 'string', description: 'Course file path relative to the courses root, e.g. "demo.story" or "demo.course.json" (lessons use JSON)' };
const FILE_ONLY = obj({ file: FILE }, ['file']);

const err = (path, code, message, hint) => Object.assign(new Error(message), { errors: [{ path, code, message, ...(hint && { hint }) }] });
const rpcErr = (code, message, data) => Object.assign(new Error(message), { rpc: { code, message, ...(data && { data }) } });

export function createServer({ core, runtime, io, publisher = null, importer = null, root, only = null, stdin, stdout }) {
  root = resolve(root);
  const onlyFile = only && resolve(root, only); // an AI draft session may touch this one file and nothing else

  const at = (p, key) => {
    const abs = resolve(root, p);
    const rel = relative(root, abs);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      throw err(`/${key}`, 'path', `${key} must be inside the courses root`, 'use a relative path such as "demo.course.json", without ".."');
    }
    if (onlyFile && abs !== onlyFile) throw err(`/${key}`, 'path', `this session may only use ${only}`, `pass file "${only}"`);
    return abs; // ponytail: no realpath, so a symlink planted inside root could escape; agents cannot create symlinks.
  };

  const open = async (file, create = false) => {
    const p = at(file, 'file');
    try {
      return [p, await io.loadCourse(p)];
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (create) return [p, null];
      throw err('/file', 'ref', `course file not found: ${file}`, 'create it with new_course, or pass create:true to run_commands');
    }
  };

  const step = (dir) => async ({ file }) => {
    const p = at(file, 'file');
    const doc = await io.history[dir](p);
    if (!doc) throw err('/file', 'history', `nothing to ${dir}`);
    return { ok: true };
  };

  const rel = (p) => relative(root, p).split(sep).join('/');

  const tools = {
    list_commands: {
      description: 'List registry commands (name, summary, args JSON Schema, examples). Pass name for one command.',
      inputSchema: obj({ name: { type: 'string', description: 'Command name, e.g. "slide.add"' } }),
      run: ({ name }) => {
        const all = Object.values(core.commands).map((c) => ({ name: c.name, summary: c.summary, args: toJsonSchema(c.args), examples: c.examples }));
        if (name === undefined) return { ok: true, commands: all };
        const one = all.filter((c) => c.name === name);
        if (!one.length) throw err('/name', 'ref', `unknown command "${name}"`, `existing: ${all.map((c) => c.name).join(', ')}`);
        return { ok: true, commands: one };
      },
    },
    describe_course: {
      description: 'Compact text outline of a course (scenes, slides, objects, layers, triggers). Read it before editing.',
      inputSchema: FILE_ONLY,
      run: async ({ file }) => core.query((await open(file))[1], 'course.describe', {}),
    },
    get_course: {
      description: 'The full course document as JSON.',
      inputSchema: FILE_ONLY,
      run: async ({ file }) => {
        const [p, doc] = await open(file), importSummary = io.storySummary?.(p);
        return { ok: true, doc, ...(importSummary ? { importSummary } : {}) };
      },
    },
    query: {
      description: 'Run a read-only registry query: course.describe, course.get, slide.get {id}, find {text|type|id}, validate, schema, commands.list, commands.help {name}, theme.list, library.list {tag?, q?}.',
      inputSchema: obj({ file: FILE, name: { type: 'string', description: 'Query name' }, args: { type: 'object', description: 'Query arguments' } }, ['file', 'name']),
      run: async ({ file, name, args = {} }) => {
        const data = await core.query((await open(file))[1], name, args);
        return data?.ok === false ? data : { ok: true, data };
      },
    },
    run_commands: {
      description: 'Apply registry commands atomically (all or nothing, one undo step) and save. Errors carry {path, code, message, hint}; nothing is saved on error.',
      inputSchema: obj({
        file: FILE,
        commands: { type: 'array', description: 'Commands in order; see list_commands', items: obj({ cmd: { type: 'string' }, args: { type: 'object' } }, ['cmd']) },
        create: { type: 'boolean', description: 'Start from an empty course when the file does not exist' },
      }, ['file', 'commands']),
      run: async ({ file, commands, create }) => {
        const [p] = await open(file, create);
        const r = io.runCommands(p, commands, { create, emptyCourse: () => core.emptyCourse() });
        return r.ok ? { ok: true, results: r.results } : { ok: false, errors: r.errors };
      },
    },
    validate: {
      description: 'Validate a course. Returns {ok, errors:[{path, code, message, hint}]}.',
      inputSchema: FILE_ONLY,
      run: async ({ file }) => {
        const errors = await core.query((await open(file))[1], 'validate', {});
        return { ok: errors.length === 0, errors };
      },
    },
    new_course: {
      description: 'Create a new, minimal course file (mode slides by default, or lessons for a Rise-style course). Refuses to overwrite an existing file.',
      inputSchema: obj({ file: FILE, title: { type: 'string' }, mode: { type: 'string', enum: ['slides', 'lessons'], description: 'slides (default): scenes/slides/triggers; lessons: sections/lessons/blocks' } }, ['file']),
      run: async ({ file, title, mode }) => {
        const [p, existing] = await open(file, true);
        if (existing) throw err('/file', 'dupe', `file already exists: ${file}`, 'choose another name, or edit it with run_commands');
        await io.saveCourse(p, core.emptyCourse({ title, mode }));
        return { ok: true, file };
      },
    },
    undo: { description: 'Undo the last command batch on a course (shared with cf undo).', inputSchema: FILE_ONLY, run: step('undo') },
    redo: { description: 'Redo the last undone command batch on a course.', inputSchema: FILE_ONLY, run: step('redo') },
    play: {
      description: 'Run the learner runtime headless over events and return the trace and final state. Events: start, click/hoverEnter/hoverLeave {target}, key {key}, next, prev, menu {slide}, tick {ms}, choose {choice}, input {target|answer, text}, submit, continue.',
      inputSchema: obj({
        file: FILE,
        events: { type: 'array', items: { type: 'object', required: ['type'], properties: { type: { type: 'string' } } } },
      }, ['file', 'events']),
      run: async ({ file, events }) => {
        const rt = runtime.createRuntime((await open(file))[1]);
        for (const e of events) {
          if (e.type === 'start') rt.start();
          else if (e.type === 'tick') rt.tick(e.ms);
          else rt.dispatch(e);
        }
        return { ok: true, trace: rt.trace, state: rt.state };
      },
    },
    publish: {
      description: 'Publish web/SCORM folders, an optional SCORM upload ZIP, a PowerPoint deck, or Storyline questions (.xlsx or .txt) inside the courses root. File exports also write an export-report.json sidecar; use a new output filename.',
      inputSchema: obj({
        file: FILE,
        target: { type: 'string', enum: Object.keys(PUBLISH_TARGETS) },
        out: { type: 'string', description: 'Output path relative to the courses root: dist/demo, dist/deck.pptx, or dist/questions.xlsx|.txt' },
        zip: { type: 'boolean', description: 'SCORM 1.2 only: also write <out>.zip for LMS upload. Default false.' },
      }, ['file', 'target', 'out']),
      run: async ({ file, target, out, zip = false }) => {
        if (zip && target !== 'scorm12') throw err('/zip', 'semantic', 'ZIP output requires target scorm12', 'use target:"scorm12" or omit zip');
        const outDir = at(out, 'out');
        const fn = publisher?.[PUBLISH_TARGETS[target].method];
        if (typeof fn !== 'function') throw err('/target', 'unavailable', `publish ${target} is not available yet`, 'packages/publisher does not export ' + PUBLISH_TARGETS[target].method);
        const [p, doc] = await open(file);
        return { ok: true, out, result: await fn(doc, outDir, { courseDir: dirname(p), ...(zip ? { zip: true } : {}) }) };
      },
    },
    import_story: {
      description: 'Open a native copy of a Storyline 360 file with a .story destination, or convert to .course.json. The source stays unchanged; unmapped features are reported in the summary and <name>.import-report.json.',
      inputSchema: obj({
        story: { type: 'string', description: '.story file relative to the courses root, e.g. "imports/module1.story"' },
        file: FILE,
        assets: { type: 'string', description: 'Image folder relative to the courses root (default assets/<name>), inside the course folder' },
      }, ['story', 'file']),
      run: async ({ story, file, assets }) => {
        const importFile = io.importCourse ?? importer?.importStoryFile;
        if (typeof importFile !== 'function') throw err('/', 'unavailable', 'import is not available', 'packages/import-story/index.js did not load');
        const r = await importFile(at(story, 'story'), at(file, 'file'), { assetsDir: assets === undefined ? undefined : at(assets, 'assets') });
        return { ok: true, file, assets: rel(r.assets), reportFile: rel(r.reportFile), summary: r.summary };
      },
    },
  };

  const text = (out) => ({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }], isError: out?.ok === false });

  async function callTool(params) {
    const name = params?.name;
    if (typeof name !== 'string' || !Object.hasOwn(tools, name)) throw rpcErr(-32602, `Unknown tool: ${name}`, { tools: Object.keys(tools) });
    const tool = tools[name];
    const args = params.arguments ?? {};
    const bad = check(tool.inputSchema, args);
    if (bad.length) return text({ ok: false, errors: bad });
    try {
      return text(await tool.run(args));
    } catch (e) {
      return text({ ok: false, errors: e.errors ?? [{ path: '/', code: e.code ?? 'internal', message: e.message }] });
    }
  }

  async function handle({ method, params }) {
    switch (method) {
      case 'initialize': {
        const v = params?.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(v) ? v : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'courseforge-studio', version: '0.1.0' },
          instructions: 'CourseForge Studio course editing. Paths are relative to the courses root. Discover commands with list_commands, read with describe_course, edit with run_commands, check with validate and play. Open .story files directly; import_story copies to .story or converts to .course.json.',
        };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
      case 'tools/call': return callTool(params);
      default: throw rpcErr(-32601, `Method not found: ${method}`);
    }
  }

  const send = (m) => stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  let queue = Promise.resolve();

  function onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
    const isObj = msg !== null && typeof msg === 'object' && !Array.isArray(msg);
    if (!isObj || msg.jsonrpc !== '2.0' || (typeof msg.method !== 'string' && !('result' in msg || 'error' in msg))) {
      return send({ id: isObj && msg.id !== undefined ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } });
    }
    if (typeof msg.method !== 'string' || msg.id === undefined) return; // a response to us, or a notification: no reply
    const run = () => handle(msg).then(
      (result) => send({ id: msg.id, result }),
      (e) => send({ id: msg.id, error: e.rpc ?? { code: -32603, message: e.message } }),
    );
    if (msg.method === 'tools/call') queue = queue.then(run); // serial: no interleaved load/save on one file
    else run();
  }

  const tooLarge = () => send({ id: null, error: { code: -32600, message: `Request too large (max ${MAX_MESSAGE} bytes)` } });
  let buf = Buffer.alloc(0);
  let skipping = false; // discarding the rest of an oversized line
  stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      const line = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      if (skipping) skipping = false;
      else if (line.length > MAX_MESSAGE) tooLarge();
      else onLine(line.toString('utf8'));
    }
    if (buf.length > MAX_MESSAGE) {
      if (!skipping) tooLarge();
      skipping = true;
      buf = Buffer.alloc(0);
    }
  });
}

if (import.meta.main) { // Node >= 24.2 (verified on 24.14)
  const i = process.argv.indexOf('--root');
  const root = resolve(i > 0 ? process.argv[i + 1] : 'courses');
  mkdirSync(root, { recursive: true });
  const o = process.argv.indexOf('--only');
  const [core, schema, runtime, io, publisher, importer] = await Promise.all([
    import('../core/index.js'),
    import('../schema/index.js'),
    import('../runtime/index.js'),
    import('../cli/io.js'),
    import('../publisher/index.js').catch((e) => { process.stderr.write(`courseforge-studio mcp: publisher unavailable (${e.message})\n`); return null; }),
    import('../import-story/index.js').catch((e) => { process.stderr.write(`courseforge-studio mcp: importer unavailable (${e.message})\n`); return null; }),
  ]);
  // core.query returns {ok, data}; the server expects data (or {ok:false, errors} to pass through).
  const query = (doc, name, args) => { const r = core.query(doc, name, args); return r.ok ? r.data : r; };
  createServer({ core: { ...core, query, emptyCourse: schema.emptyCourse }, runtime, io, publisher, importer, root, only: o > 0 ? process.argv[o + 1] : null, stdin: process.stdin, stdout: process.stdout });
  process.stderr.write(`courseforge-studio mcp: stdio server ready, root ${root}\n`);
}
