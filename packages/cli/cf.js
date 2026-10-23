#!/usr/bin/env node
// `cf`: command-line front-end over the shared registry. Every editor action has a `cf cmd` equivalent.
// Output: JSON on stdout (results), JSON on stderr (errors). Exit codes: 0 ok, 1 command/validation error, 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emptyCourse, validate, jsonSchema } from '../schema/index.js';
import { PUBLISH_TARGETS, commands, query, describe } from '../core/index.js';
import { play, seededRng } from '../runtime/index.js';
import { loadCourse, saveCourse, history, runCommands, importCourse, storySummary } from './io.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `cf - CourseForge Studio command line (same commands as the editor, HTTP API and MCP server)

  cf new <file> [--title T] [--id ID] [--mode slides|lessons]  create a course (*.story or *.course.json)
  cf describe <file>                         compact outline (best first read for agents)
  cf validate <file>                         [] when valid; errors carry {path, code, message, hint}
  cf cmd <file> '<json>' | -                 apply one command {cmd,args} or an array atomically (- = stdin)
  cf batch <file> <cmds.jsonl|->             apply a JSONL file of commands atomically
  cf query <file> <name> ['<json args>']     read-only queries (cf query <file> commands.list)
  cf commands [name] [--markdown]            command reference (args schema + examples)
  cf schema                                  JSON Schema of the course document
  cf undo <file> | cf redo <file>            history shared with the editor and MCP
  cf play <file> [events.jsonl|-] [--seed N] headless learner run; prints trace, vars, LMS calls
  cf test <file> <scenario.json>             play + assertions {events, expect:{trace,traceOrder,vars,slide,lesson,status,lms}}
  cf publish <file> --web|--scorm12 <outDir> [--zip]
  cf publish <file> --pptx <out.pptx> | --questions <out.xlsx|out.txt>
  cf import <file.story> <out.story|out.course.json> [--assets DIR]
                                             native copy or JSON conversion; source unchanged; writes an import report
  cf app [--root DIR] [--port N] [--no-open]  start CourseForge Studio like a desktop program: the editor in its own window;
                                             projects in Documents/CourseForge Studio (samples copied on first run)
  cf serve [--root DIR] [--port N] [--new-token]  local editor (127.0.0.1); the token persists in DIR/.cf-token
  cf mcp [--root DIR]                        MCP stdio server for AI agents

Options: --create (cmd/batch: start a new file if missing), --text (human output where supported)`;

const out = (x) => process.stdout.write((typeof x === 'string' ? x : JSON.stringify(x, null, 2)) + '\n');
const fail = (errors, code = 1) => { process.stderr.write(JSON.stringify({ ok: false, errors: [].concat(errors) }, null, 2) + '\n'); process.exit(code); };
const usage = (msg) => { process.stderr.write((msg ? msg + '\n\n' : '') + USAGE + '\n'); process.exit(2); };

function parseArgs(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const nxt = argv[i + 1]; if (nxt !== undefined && !nxt.startsWith('--') && ['title', 'id', 'seed', 'root', 'port', 'assets', 'mode'].includes(k)) { opt[k] = nxt; i++; } else opt[k] = true; }
    else pos.push(a);
  }
  return { pos, opt };
}
const readInput = (src) => (src === '-' ? fs.readFileSync(0, 'utf8') : fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : src);
const parseJson = (text, what) => { try { return JSON.parse(text); } catch (e) { return fail({ path: '/', code: 'json', message: `${what} is not valid JSON: ${e.message}` }); } };
const parseJsonl = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).map((l, i) => { try { return JSON.parse(l); } catch (e) { return fail({ path: `/${i}`, code: 'json', message: `line ${i + 1}: ${e.message}` }); } });
function load(file) {
  try { return loadCourse(file); } catch (e) {
    if (e.code === 'ENOENT') fail({ path: '/file', code: 'ref', message: `file not found: ${file}`, hint: 'create it with cf new, or pass --create' });
    if (e.errors) fail(e.errors);
    throw e;
  }
}

function commandsMarkdown() {
  const lines = ['# CourseForge Studio command reference', '', 'Generated from the registry (`cf commands --markdown`). Every command works identically from the editor, `cf cmd`, the HTTP API and the MCP tool `run_commands`.', ''];
  for (const c of Object.values(commands)) {
    if (c.name === 'course.replace') continue;
    const help = query(null, 'commands.help', { name: c.name }).data;
    lines.push(`## ${c.name}`, '', c.summary, '', '| arg | type | notes |', '|---|---|---|');
    for (const [k, v] of Object.entries(help.args.properties || {})) {
      const type = v.type ? [].concat(v.type).join('\\|') : v.oneOf ? 'one of ' + v.oneOf.length : 'object';
      const notes = [help.args.required?.includes(k) ? '**required**' : '', v.enum ? 'one of: ' + v.enum.join(', ') : '', v.pattern ? '`' + v.pattern + '`' : '', v.description || ''].filter(Boolean).join('; ');
      lines.push(`| ${k} | ${type} | ${notes} |`);
    }
    for (const v of help.args.oneOf || []) lines.push(`| type=${v.properties.type.const} | variant | ${Object.entries(v.properties).filter(([k]) => k !== 'type').map(([k, p]) => (v.required.includes(k) ? `**${k}**` : k) + (p.items?.properties ? `[{${Object.keys(p.items.properties).join(', ')}}]` : '')).join(', ') || '(no fields)'}${v.description ? '; ' + v.description : ''} |`);
    if (help.examples.length) lines.push('', 'Examples:', '', ...help.examples.map((e) => '```json\n' + JSON.stringify(e) + '\n```'));
    lines.push('');
  }
  lines.push('## Publish targets', '', 'The shared I/O registry is packages/core/publish-targets.js. Use cf publish, MCP publish or POST /api/courses/:name/publish (not cf cmd).', '', '| target | CLI output | publisher |', '|---|---|---|');
  for (const [target, entry] of Object.entries(PUBLISH_TARGETS)) lines.push('| ' + target + ' | --' + target + ' ' + (entry.extension ? 'out' + entry.extension : 'outDir') + ' | ' + entry.method + ' |');
  lines.push('', 'Questions also accept .txt. MCP: {file,target,out,zip?}. HTTP: {target,format?,zip?}, with format xlsx (default) or txt for questions. For scorm12, zip:true also creates an adjacent LMS upload ZIP. File exports return output, report, files, slides/questions and issues; reports are arrays of {path,kind,reason} in <output>.export-report.json. Existing output/report files are refused.', '', 'PowerPoint preserves editable base-slide visuals; unsupported interactions and approximations are reported. Question delimiters |, *, // use reported fullwidth substitutions; inspect accepted answers after import. TXT layout is assumed, so prefer XLSX. To retain interactions, publish web and insert the folder containing index.html as a Storyline Web Object.', '');
  return lines.join('\n');
}

function check(result, expect = {}) {
  const problems = [];
  const tr = result.trace;
  const known = ['trace', 'traceIncludes', 'traceOrder', 'notTrace', 'vars', 'slide', 'lesson', 'status', 'layers', 'lms'];
  for (const k of Object.keys(expect)) if (!known.includes(k)) problems.push(`unknown expectation "${k}" (allowed: ${known.join(', ')})`);
  for (const want of [...(expect.trace || []), ...(expect.traceIncludes || [])]) if (!tr.includes(want)) problems.push(`trace lacks "${want}"`);
  let idx = -1;
  for (const want of expect.traceOrder || []) { const j = tr.indexOf(want, idx + 1); if (j < 0) { problems.push(`traceOrder: "${want}" not found after position ${idx}`); break; } idx = j; }
  for (const no of expect.notTrace || []) if (tr.includes(no)) problems.push(`trace unexpectedly has "${no}"`);
  for (const [k, v] of Object.entries(expect.vars || {})) if (result.vars[k] !== v) problems.push(`var ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(result.vars[k])}`);
  if (expect.slide && result.slide !== expect.slide) problems.push(`slide: expected ${expect.slide}, got ${result.slide}`);
  if (expect.lesson !== undefined && result.lesson !== expect.lesson) problems.push(`lesson: expected ${expect.lesson}, got ${result.lesson}`);
  if (expect.status && result.status !== expect.status) problems.push(`status: expected ${expect.status}, got ${result.status}`);
  if (expect.layers && JSON.stringify(result.layers) !== JSON.stringify(expect.layers)) problems.push(`layers: expected ${JSON.stringify(expect.layers)}, got ${JSON.stringify(result.layers)}`);
  for (const want of expect.lms || []) if (!result.lms.includes(want)) problems.push(`lms lacks "${want}"`);
  return problems;
}

async function main(argv) {
  const [sub, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  const file = pos[0];
  const needFile = () => { if (!file) usage(`cf ${sub}: missing <file>`); return file; };
  switch (sub) {
    case undefined: case 'help': case '--help': case '-h': return out(USAGE);
    case 'new': {
      needFile();
      if (fs.existsSync(file)) fail({ path: '/file', code: 'dupe', message: `already exists: ${file}`, hint: 'edit it with cf cmd' });
      const id = opt.id ?? (path.basename(file).replace(/\.story$|\.course\.json$|\.json$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^[^a-z]+/, '') || 'course');
      if (opt.mode !== undefined && !['slides', 'lessons'].includes(opt.mode)) usage('cf new: --mode must be slides or lessons');
      const doc = emptyCourse({ id: id.slice(0, 40), title: opt.title ?? 'Untitled course', mode: opt.mode });
      const errs = validate(doc);
      if (errs.length) fail(errs);
      const saved = saveCourse(file, doc);
      return out({ ok: true, file, id: saved.id });
    }
    case 'describe': {
      const outline = describe(load(needFile())), summary = storySummary(file);
      return out(outline + (summary?.reported ? `\nNative .story rendering report: ${JSON.stringify(summary)}\nUnsupported source content is retained when saving.` : ''));
    }
    case 'validate': { const errs = validate(load(needFile())); if (errs.length) fail(errs); return out({ ok: true, errors: [] }); }
    case 'cmd': case 'batch': {
      needFile();
      if (pos[1] === undefined) usage(`cf ${sub}: missing commands`);
      const text = readInput(pos[1]);
      const cmds = sub === 'batch' ? parseJsonl(text) : [].concat(parseJson(text, 'command'));
      let r;
      try { r = runCommands(file, cmds, { create: !!opt.create, emptyCourse, rng: opt.seed !== undefined ? seededRng(Number(opt.seed)) : undefined }); } catch (e) {
        if (e.code === 'ENOENT') fail({ path: '/file', code: 'ref', message: `file not found: ${file}`, hint: 'create it with cf new, or pass --create' });
        if (e.errors) fail(e.errors);
        throw e;
      }
      if (!r.ok) fail(r.errors);
      return out({ ok: true, results: r.results });
    }
    case 'query': {
      needFile();
      if (!pos[1]) usage('cf query: missing <name>');
      const r = query(load(file), pos[1], pos[2] ? parseJson(readInput(pos[2]), 'args') : undefined);
      if (!r.ok) fail(r.errors);
      return out(typeof r.data === 'string' && opt.text ? r.data : r.data);
    }
    case 'commands': {
      if (opt.markdown) return out(commandsMarkdown());
      const r = pos[0] ? query(null, 'commands.help', { name: pos[0] }) : query(null, 'commands.list');
      if (!r.ok) fail(r.errors);
      return out(r.data);
    }
    case 'schema': return out(jsonSchema());
    case 'undo': case 'redo': {
      needFile();
      const doc = history[sub](file);
      if (!doc) fail({ path: '/file', code: 'history', message: `nothing to ${sub}` });
      return out({ ok: true, depth: history.depth(file) });
    }
    case 'play': case 'test': {
      const doc = load(needFile());
      let events = [];
      let expect = {};
      if (sub === 'play' && pos[1]) events = parseJsonl(readInput(pos[1]));
      if (sub === 'test') {
        if (!pos[1]) usage('cf test: missing <scenario.json>');
        const sc = parseJson(readInput(pos[1]), 'scenario');
        events = sc.events || []; expect = sc.expect || {};
      }
      const r = play(doc, events, { rng: seededRng(Number(opt.seed ?? 1)) });
      if (sub === 'play') return out({ slide: r.slide, lesson: r.lesson, layers: r.layers, status: r.status, vars: r.vars, lms: r.lms, trace: r.trace });
      const problems = check(r, expect);
      if (problems.length) fail(problems.map((p) => ({ path: '/expect', code: 'assert', message: p })), 1);
      return out({ ok: true, checks: Object.values(expect).flat().length, slide: r.slide, lesson: r.lesson });
    }
    case 'publish': {
      needFile();
      const targets = Object.keys(PUBLISH_TARGETS).filter(t => opt[t]);
      const target = targets.length === 1 ? targets[0] : null;
      const outDir = pos[1];
      if (!target || !outDir) usage('cf publish: choose one of --web, --scorm12, --pptx, --questions and an output path');
      const pub = await import(pathToFileURL(path.join(HERE, '../publisher/index.js')).href).catch(() => null);
      const fn = pub?.[PUBLISH_TARGETS[target].method];
      if (!fn) fail({ path: '/target', code: 'unavailable', message: `publish ${target} is not available` });
      const doc = load(file);
      const errs = validate(doc);
      if (errs.length) fail(errs);
      const r = await fn(doc, path.resolve(outDir), { courseDir: path.dirname(path.resolve(file)), zip: !!opt.zip });
      return out({ ok: true, out: outDir, ...r });
    }
    case 'import': {
      needFile();
      if (!pos[1]) usage('cf import: missing <out.story|out.course.json>');
      let r;
      try { r = importCourse(file, pos[1], { assetsDir: typeof opt.assets === 'string' ? opt.assets : undefined }); } catch (e) { if (e.errors) fail(e.errors); throw e; }
      return out(r);
    }
    case 'serve': {
      const args = [path.join(HERE, '../server/server.js'), '--root', opt.root ?? 'courses', '--port', String(opt.port ?? 8420), ...(opt['new-token'] ? ['--new-token'] : [])];
      const { spawn } = await import('node:child_process');
      spawn(process.execPath, args, { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0));
      return;
    }
    case 'app': {
      // The desktop program: the editor in its own app window (the Edge/Chrome engine in app mode: no tabs or address bar),
      // with the local server behind it; closing that window quits. Projects live in Documents/CourseForge Studio.
      // A second launch while it runs just opens another window.
      const os = await import('node:os');
      const { spawn } = await import('node:child_process');
      const { documentsDir, ensureProjects } = await import('../server/projects.js');
      const root = path.resolve(opt.root ?? path.join(documentsDir(), 'CourseForge Studio'));
      // Startup failures also go to a file the launcher shows in a message box (the program has no console).
      const errLog = path.join(process.env.LOCALAPPDATA || os.homedir(), 'CourseForge Studio', 'last-error.txt');
      const quit = (e) => {
        try { fs.mkdirSync(path.dirname(errLog), { recursive: true }); fs.writeFileSync(errLog, `${e.message}\n${e.hint ?? ''}\n`); } catch { /* stderr still has it */ }
        fail(e);
      };
      const port = Number(opt.port ?? 8470);
      try { ensureProjects(root); } // first run: start with the two original samples
      catch (e) { return quit({ path: '/root', code: 'start', message: `could not set up the projects folder ${root}: ${e.message}`, hint: 'check that the folder can be written, or start with --root <another folder>' }); }
      const open = (url, owner) => {
        out({ ok: true, url, root });
        if (opt['no-open']) return;
        const win = process.platform === 'win32';
        const browsers = win
          ? ['ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'].flatMap((v) => (process.env[v] ? [
            path.join(process.env[v], 'Microsoft/Edge/Application/msedge.exe'), path.join(process.env[v], 'Google/Chrome/Application/chrome.exe')] : []))
          : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
        const exe = browsers.find((b) => fs.existsSync(b));
        // A profile of its own makes the window its own process, so the program ends when the window closes.
        const profile = path.join(process.env.LOCALAPPDATA || os.homedir(), 'CourseForge Studio', 'window');
        const [cmd, args] = exe ? [exe, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1440,900', '--no-first-run', '--no-default-browser-check']]
          : win ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
        const w = spawn(cmd, args, { detached: !owner, stdio: 'ignore' });
        w.on('error', (e) => quit({ path: '/window', code: 'start', message: `could not open the CourseForge Studio window: ${e.message}`, hint: `open ${url} in a browser` }));
        if (owner && exe) w.on('exit', () => { server.kill(); process.exit(0); });
        else w.unref();
      };
      const server = spawn(process.execPath, [path.join(HERE, '../server/server.js'), '--root', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
      server.on('error', (e) => quit({ path: '/server', code: 'start', message: `could not start the editor server: ${e.message}` }));
      server.stdout.on('data', (d) => { const m = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(String(d)); if (m) open(m[0], true); });
      let errText = '';
      server.stderr.on('data', (d) => { errText += d; });
      server.on('exit', async (code) => {
        if (/EADDRINUSE/.test(errText)) { // already running? open a window on it when it is ours (same courses folder token)
          let token = '';
          try { token = fs.readFileSync(path.join(root, '.cf-token'), 'utf8').trim(); } catch { /* no editor has used this folder */ }
          const url = `http://127.0.0.1:${port}/?token=${token}`;
          const ours = token && await fetch(`http://127.0.0.1:${port}/api/courses`, { headers: { 'x-cf-token': token }, signal: AbortSignal.timeout(3000) })
            .then((r) => (r.ok ? r.json() : null)).then((j) => j?.ok === true && Array.isArray(j.courses), () => false);
          if (ours) return open(url);
          return quit({ path: '/port', code: 'busy', message: `port ${port} is used by another program`, hint: 'close that program, or start CourseForge Studio with --port <another port>' });
        }
        if (code) return quit({ path: '/', code: 'start', message: errText.trim() || `the editor server stopped (exit code ${code})` });
        process.exit(0);
      });
      return;
    }
    case 'mcp': {
      const { spawn } = await import('node:child_process');
      spawn(process.execPath, [path.join(HERE, '../mcp/server.js'), '--root', opt.root ?? 'courses'], { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0));
      return;
    }
    default: return usage(`unknown subcommand "${sub}"`);
  }
}

main(process.argv.slice(2)).catch((e) => fail({ path: '/', code: 'internal', message: e.stack || e.message }));
