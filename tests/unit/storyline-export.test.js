import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyCourse, normalize } from '../../packages/schema/index.js';
import * as publisher from '../../packages/publisher/index.js';
import { readZip } from '../../packages/import-story/zip-read.js';
import { parseXml } from '../../packages/import-story/index.js';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer as httpServer } from '../../packages/server/server.js';
import { createServer as mcpServer } from '../../packages/mcp/server.js';
import * as core from '../../packages/core/index.js';
import * as io from '../../packages/cli/io.js';

function fixture() {
  const d = emptyCourse({ id: 'export-test', title: 'Export <test>' });
  d.size = { w: 960, h: 540 };
  d.slides = [{ id: 'intro', title: 'First & <title>', notes: 'Speaker notes & details', objects: [
    { id: 'txt', type: 'text', text: 'Editable & text', x: 10, y: 20, w: 300, h: 50 },
    { id: 'shape', type: 'shape', shape: 'ellipse', text: 'Ellipse', x: 20, y: 90 },
    { id: 'line', type: 'shape', shape: 'line', x: 5, y: 200, w: 400, h: 0 },
    { id: 'button', type: 'button', text: 'Continue', alt: 'Continue course', x: 600, y: 400 },
    { id: 'hidden', type: 'text', text: 'SECRET HIDDEN', hidden: true },
  ], layers: [{ id: 'layer', objects: [{ id: 'layer-text', type: 'text', text: 'Layer content' }] }], triggers: [] },
  { id: 'second', title: 'Second', objects: [] }];
  d.scenes = [{ id: 'scene', slides: ['intro', 'second'] }];
  return normalize(d);
}
const temp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-export-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const text = (z, name) => z.read(name).toString('utf8');
function checkPackage(z) {
  const types = parseXml(text(z, '[Content_Types].xml'));
  const defaults = new Set(types.kids.filter(n => n.tag === 'Default').map(n => n.attrs.Extension));
  const overrides = new Set(types.kids.filter(n => n.tag === 'Override').map(n => n.attrs.PartName.slice(1)));
  for (const name of z.names) {
    if (name !== '[Content_Types].xml') assert.ok(overrides.has(name) || defaults.has(name.split('.').pop()), `content type: ${name}`);
    if (/\.(xml|rels)$/.test(name)) parseXml(text(z, name), name);
    if (!name.endsWith('.rels')) continue;
    const base = name === '_rels/.rels' ? '' : path.posix.dirname(path.posix.dirname(name));
    for (const rel of parseXml(text(z, name)).kids) if (rel.attrs.TargetMode !== 'External') {
      assert.ok(z.has(path.posix.normalize(path.posix.join(base, rel.attrs.Target))), `${name} -> ${rel.attrs.Target}`);
    }
  }
}

test('PPTX: package, relationships, XML, EMU geometry, slide order, shapes, notes and omissions', t => {
  const dir = temp(t), out = path.join(dir, 'deck.pptx'), d = fixture(), before = structuredClone(d);
  const result = publisher.publishPptx(d, out);
  assert.deepEqual(d, before);
  const z = readZip(fs.readFileSync(out)); checkPackage(z);
  assert.equal(z.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 2);
  assert.match(text(z, 'ppt/presentation.xml'), /cx="9144000" cy="5143500"/);
  const s = text(z, 'ppt/slides/slide1.xml');
  assert.match(s, /<p:ph type="title"/); assert.match(s, /First &amp; &lt;title&gt;/);
  assert.match(s, /x="95250" y="190500"/); assert.match(s, /cx="2857500" cy="476250"/);
  assert.match(s, /prst="ellipse"/); assert.match(s, /prst="line"/); assert.match(s, /prst="roundRect"/);
  assert.match(s, /descr="Continue course"/); assert.doesNotMatch(s, /SECRET HIDDEN|Layer content/);
  assert.match(text(z, 'ppt/notesSlides/notesSlide1.xml'), /Speaker notes &amp; details/);
  assert.match(text(z, 'ppt/slides/slide2.xml'), /Second/);
  const report = JSON.parse(fs.readFileSync(result.report, 'utf8'));
  assert.ok(report.some(e => e.path === '/slides/0/objects/4' && e.kind === 'hidden'));
  assert.ok(report.some(e => e.path === '/slides/0/layers'));
  assert.ok(report.every(e => typeof e.path === 'string' && e.kind && e.reason));
  assert.throws(() => publisher.publishPptx(d, out), /exists/);
});

test('PPTX: embedded image and rich paragraphs/runs; an unsafe link is refused before output', t => {
  const dir = temp(t), d = fixture(), out = path.join(dir, 'rich.pptx');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8i8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(dir, 'dot.png'), png);
  d.assets = [{ id: 'dot', path: 'dot.png', alt: 'A dot' }];
  d.slides[0].objects.push({ id: 'pic', type: 'image', image: 'dot', x: 50, y: 50, w: 20, h: 20 });
  d.slides[0].objects[0].rich = [{ list: 'bullet', level: 2, align: 'center', runs: [{ text: 'Rich', b: true, i: true, u: true, s: true, color: '#123456', size: 24, font: 'Arial', link: 'https://example.org/' }] },
    { list: 'number', runs: [{ text: 'Number' }] }];
  const bad = structuredClone(d); bad.slides[0].objects[0].rich[1].runs[0].link = 'javascript:alert(1)';
  assert.throws(() => publisher.publishPptx(bad, out, { courseDir: dir }), /link must match/);
  assert.ok(!fs.existsSync(out));
  const r = publisher.publishPptx(d, out, { courseDir: dir });
  const z = readZip(fs.readFileSync(out)); checkPackage(z);
  assert.deepEqual(z.read('ppt/media/image1.png'), png);
  const s = text(z, 'ppt/slides/slide1.xml');
  for (const pattern of [/a:blip r:embed=/, /descr="A dot"/, /b="1"/, /i="1"/, /u="sng"/, /strike="sngStrike"/, /val="123456"/, /sz="1800"/, /typeface="Arial"/, /a:buChar/, /a:buAutoNum/, /lvl="1"/, /lvl="0"/, /algn="ctr"/]) assert.match(s, pattern); // course level 2 -> lvl 1, default 1 -> lvl 0
  assert.match(text(z, 'ppt/slides/_rels/slide1.xml.rels'), /https:\/\/example.org\//);
  assert.ok(r.report);
});

test('PPTX: unsafe/missing image paths and invalid rich input fail before output', t => {
  const dir = temp(t), d = fixture(), out = path.join(dir, 'bad.pptx');
  d.assets = [{ id: 'dot', path: '../escape.png' }];
  d.slides[0].objects.push({ id: 'pic', type: 'image', image: 'dot' });
  assert.throws(() => publisher.publishPptx(d, out, { courseDir: dir }), /inside the course folder/);
  assert.ok(!fs.existsSync(out));
  d.assets[0].path = 'missing.png';
  assert.throws(() => publisher.publishPptx(d, out, { courseDir: dir }), /missing asset/);
  d.assets = []; d.slides[0].objects.pop(); d.slides[0].objects[0].rich = 'wrong';
  assert.throws(() => publisher.publishPptx(d, out), /rich/);
});

function quizDoc() {
  const d = fixture();
  const choices = [{ id: 'yes', label: 'True', correct: true }, { id: 'no', label: 'False', correct: false }];
  const qs = [
    { type: 'tf', prompt: 'True?', choices }, { type: 'mc', prompt: 'Choose', choices },
    { type: 'mr', prompt: 'Choose all', choices }, { type: 'fill', prompt: 'Fill', answers: ['one', 'two'] },
    { type: 'matching', prompt: 'Match', choices, rows: [{ id: 'left', label: 'Left', choice: 'yes' }, { id: 'right', label: 'Right', choice: 'no' }] },
    { type: 'sequence', prompt: 'Order', choices },
    { type: 'hotspot', prompt: 'Point', areas: [{ id: 'area', x: 0, y: 0, w: 50, h: 50, correct: true }] },
  ];
  d.slides = qs.map((q, i) => ({ id: `q-${i}`, title: `Question ${i}`, question: { ...structuredClone(q), points: 5, feedback: { correct: 'Yes', incorrect: 'No' } } }));
  d.scenes[0].slides = d.slides.map(s => s.id);
  return d;
}

test('questions: all schema mappings, answer order, points, feedback and unsupported report', t => {
  const dir = temp(t), d = quizDoc();
  const r = publisher.publishQuestions(d, path.join(dir, 'questions.txt'));
  const blocks = fs.readFileSync(r.output, 'utf8').trim().split(/\r?\n\r?\n/).map(b => b.split(/\r?\n/));
  assert.deepEqual(blocks.map(b => b[0]), ['TF', 'MC', 'MR', 'FIB', 'MDN', 'SD']);
  assert.ok(blocks.every(b => b[1] === '5'));
  assert.equal(blocks[0][3], '*True|Yes'); assert.equal(blocks[0][4], 'False|No');
  assert.deepEqual(blocks[3].slice(3), ['one', 'two']);
  assert.deepEqual(blocks[4].slice(3), ['Left|True', 'Right|False']);
  assert.deepEqual(blocks[5].slice(3), ['True', 'False']);
  assert.ok(JSON.parse(fs.readFileSync(r.report)).some(e => e.kind === 'question' && e.reason.includes('hotspot')));
});

test('questions: XLSX first sheet, inline strings (no formulas), delimiter substitutions and report', t => {
  const dir = temp(t), d = quizDoc();
  d.slides[1].question.prompt = '=literal | * //\nNext';
  d.slides[1].question.choices[0].label = '*A|B//C';
  const r = publisher.publishQuestions(d, path.join(dir, 'questions.xlsx'));
  const z = readZip(fs.readFileSync(r.output)); checkPackage(z);
  const s = text(z, 'xl/worksheets/sheet1.xml');
  assert.match(s, /t="inlineStr"/); assert.doesNotMatch(s, /<f[ >]/);
  assert.match(s, /=literal ｜ ＊ ／／ Next/); assert.match(s, /\*＊A｜B／／C\|Yes/);
  assert.match(s, /<c r="B2"[^>]*><v>5<\/v>/);
  assert.ok(JSON.parse(fs.readFileSync(r.report)).some(e => e.kind === 'text'));
});

test('questions: skip over-ten and out-of-range whole questions; ten choices allowed', t => {
  const dir = temp(t), d = quizDoc();
  d.slides[3].question.answers = Array.from({ length: 11 }, (_, i) => `answer ${i}`);
  d.slides[2].question.points = 1001;
  d.slides[5].question.choices = Array.from({ length: 10 }, (_, i) => ({ id: `a-${i}`, label: `Choice ${i}` }));
  const r = publisher.publishQuestions(d, path.join(dir, 'limit.txt'));
  const s = fs.readFileSync(r.output, 'utf8');
  assert.doesNotMatch(s, /FIB|MR/); assert.match(s, /Choice 9/);
  const report = JSON.parse(fs.readFileSync(r.report));
  assert.ok(report.some(e => e.reason.includes('10'))); assert.ok(report.some(e => e.reason.includes('1000')));
});

test('CLI: both export flags write real files, reports and leave source unchanged', t => {
  const dir = temp(t), input = path.join(dir, 'source.course.json');
  io.saveCourse(input, quizDoc()); const before = fs.readFileSync(input);
  for (const [target, ext] of [['pptx', 'pptx'], ['questions', 'xlsx'], ['questions', 'txt']]) {
    const output = path.join(dir, `cli.${ext}`);
    const r = spawnSync(process.execPath, ['packages/cli/cf.js', 'publish', input, '--' + target, output], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).output, output);
    assert.ok(fs.existsSync(output + '.export-report.json'));
  }
  assert.deepEqual(fs.readFileSync(input), before);
});

test('HTTP: shared targets, question format, repeat-file protection and invalid target', async t => {
  const dir = temp(t); io.saveCourse(path.join(dir, 'demo.course.json'), quizDoc());
  const server = httpServer({ root: dir, port: 0, token: 'export-test-token' }); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const call = async body => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/courses/demo/publish`, { method: 'POST', headers: { 'x-cf-token': 'export-test-token', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  for (const [target, format, ext] of [['pptx', undefined, 'pptx'], ['questions', undefined, 'xlsx'], ['questions', 'txt', 'txt']]) {
    const r = await call({ target, format }); assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.out.endsWith('.' + ext)); assert.ok(r.body.result.report.endsWith('.export-report.json'));
  }
  assert.equal((await call({ target: 'constructor' })).status, 400);
  assert.equal((await call({ target: 'questions', format: '../bad' })).status, 400);
  assert.equal((await call({ target: 'pptx' })).body.ok, false);
});

test('MCP: enum and real publisher parity for PPTX, XLSX and TXT', async t => {
  const dir = temp(t), stdin = new PassThrough(), stdout = new PassThrough();
  io.saveCourse(path.join(dir, 'demo.course.json'), quizDoc());
  mcpServer({ core, io, runtime: {}, publisher, root: dir, stdin, stdout });
  let id = 0;
  const rpc = async (method, params) => { const response = once(stdout, 'data'); stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n'); return JSON.parse((await response)[0]); };
  const list = await rpc('tools/list');
  assert.deepEqual(list.result.tools.find(t => t.name === 'publish').inputSchema.properties.target.enum, ['web', 'scorm12', 'pptx', 'questions']);
  for (const [target, ext] of [['pptx', 'pptx'], ['questions', 'xlsx'], ['questions', 'txt']]) {
    const r = await rpc('tools/call', { name: 'publish', arguments: { file: 'demo.course.json', target, out: 'mcp.' + ext } });
    assert.ok(!r.result.isError, JSON.stringify(r)); assert.ok(fs.existsSync(path.join(dir, 'mcp.' + ext)));
  }
  stdin.end(); stdout.end();
});

test('question TXT: learner delimiters cannot create answers, comments or question blocks', t => {
  const dir = temp(t), d = quizDoc();
  d.slides[1].question.prompt = 'A|B//C*\n\nMC';
  d.slides[1].question.choices[1].label = '*bad|feedback//comment';
  const r = publisher.publishQuestions(d, path.join(dir, 'escape.txt'));
  const s = fs.readFileSync(r.output, 'utf8');
  assert.match(s, /A｜B／／C＊ MC/); assert.match(s, /\r\n＊bad｜feedback／／comment\|No/);
  assert.equal(s.trim().split('\r\n\r\n').length, 6);
});

test('PPTX: an unknown shape is refused; arrows get a head; hidden state and unsupported objects are reported', t => {
  const dir = temp(t), d = fixture();
  const odd = structuredClone(d); odd.slides[0].objects[1].shape = 'triangle';
  assert.throws(() => publisher.publishPptx(odd, path.join(dir, 'odd.pptx')), /shape must be one of/);
  d.slides[0].objects[1].shape = 'arrow';
  d.slides[0].objects[0].initialState = 'hidden';
  d.slides[0].objects.push({ id: 'hot', type: 'hotspot' });
  const r = publisher.publishPptx(d, path.join(dir, 'fallback.pptx'));
  const s = text(readZip(fs.readFileSync(r.output)), 'ppt/slides/slide1.xml');
  assert.doesNotMatch(s, /Editable &amp; text/); assert.match(s, /prst="line"/); assert.match(s, /<a:tailEnd type="triangle"\/>/);
  const report = JSON.parse(fs.readFileSync(r.report));
  assert.ok(report.some(e => e.kind === 'object' && e.reason.includes('hotspot')));
});

test('PPTX: prototype-like shape names are refused; text opacity and line centre geometry survive', t => {
  const dir = temp(t), d = fixture();
  const odd = structuredClone(d); odd.slides[0].objects[1].shape = 'constructor';
  assert.throws(() => publisher.publishPptx(odd, path.join(dir, 'odd.pptx')), /shape must be one of/);
  d.slides[0].objects[0].style = { opacity: 0.5 };
  d.slides[0].objects[2].h = 40;
  const r = publisher.publishPptx(d, path.join(dir, 'edge.pptx'));
  const s = text(readZip(fs.readFileSync(r.output)), 'ppt/slides/slide1.xml');
  assert.doesNotMatch(s, /prst="function/);
  assert.match(s, /<a:alpha val="50000"/);
  assert.match(s, /y="2095500"/);
});

test('questions: blank choice labels are skipped; lesson per-choice feedback is preserved', t => {
  const dir = temp(t), d = quizDoc();
  d.slides[1].question.choices[0].label = '  ';
  const r = publisher.publishQuestions(d, path.join(dir, 'empty.txt'));
  assert.doesNotMatch(fs.readFileSync(r.output, 'utf8'), /\r\nChoose\r\n/);
  assert.ok(JSON.parse(fs.readFileSync(r.report)).some(e => e.reason.includes('empty')));
  const lesson = emptyCourse({ id: 'lesson', mode: 'lessons' });
  lesson.sections = [{ id: 'section', lessons: [{ id: 'lesson-one', blocks: [{ id: 'check', type: 'question', kind: 'mc', prompt: 'Pick one', choices: [
    { id: 'one', label: 'One', correct: true, feedback: 'Specific feedback' }, { id: 'two', label: 'Two', feedback: 'Other feedback' },
  ] }] }] }];
  const r2 = publisher.publishQuestions(lesson, path.join(dir, 'lesson.txt'));
  assert.match(fs.readFileSync(r2.output, 'utf8'), /\*One\|Specific feedback\r\nTwo\|Other feedback/);
});

test('PPTX: slides follow the authored scene order, not file order; bank slides are reported (Codex review 007 #8)', t => {
  const dir = temp(t), d = fixture();
  d.slides.push({ id: 's-later', title: 'Authored first', objects: [] });
  d.scenes[0].slides = ['s-later', ...d.scenes[0].slides.filter((x) => x !== 's-later')];
  const r = publisher.publishPptx(d, path.join(dir, 'order.pptx'));
  const z = readZip(fs.readFileSync(r.output));
  assert.match(text(z, 'ppt/slides/slide1.xml'), /name="Authored first"/);
});
