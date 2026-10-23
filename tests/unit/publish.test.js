// Publisher: runtime bundle parity, web/SCORM packages, assets, package validation, preview, LMS mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse, normalize } from '../../packages/schema/index.js';
import { play, seededRng } from '../../packages/runtime/index.js';
import { runtimeBundle } from '../../packages/publisher/bundle.js';
import { publishWeb, publishScorm12, previewHtml, validatePackage, toScormInteraction } from '../../packages/publisher/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `cf-pub-${name}-`));

function course({ withAsset = false, assetPath = 'assets/pic.png' } = {}) {
  const r = applyAll(emptyCourse({ id: 'pubtest', title: 'Publish <Test> & Co' }), [
    { cmd: 'var.add', args: { name: 'clicks', type: 'number', initial: 0 } },
    ...(withAsset ? [{ cmd: 'asset.add', args: { id: 'a-pic', path: assetPath, alt: 'Test pattern' } }] : []),
    { cmd: 'slide.add', args: { id: 's-1', title: 'One', objects: [
      { id: 'o-btn', type: 'button', text: 'Go %clicks%' },
      ...(withAsset ? [{ id: 'o-pic', type: 'image', image: 'a-pic' }] : []),
    ] } },
    { cmd: 'layer.add', args: { slide: 's-1', id: 'l-1', title: 'Info', modal: true } },
    { cmd: 'trigger.add', args: { slide: 's-1', on: { event: 'click', target: 'o-btn' }, do: [{ action: 'setVar', var: 'clicks', op: 'add', value: 1 }, { action: 'showLayer', layer: 'l-1' }] } },
    { cmd: 'slide.add', args: { id: 's-q1', title: 'Q1', question: { type: 'mc', prompt: 'Pick B', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', correct: true }] } } },
    { cmd: 'slide.add', args: { id: 's-q2', title: 'Q2', question: { type: 'fill', prompt: 'Type teal', answers: ['teal'] } } },
    { cmd: 'slide.add', args: { id: 's-res', title: 'Results', objects: [{ id: 'o-score', type: 'text', text: '%qz.scorePercent%' }] } },
    { cmd: 'quiz.add', args: { id: 'qz', questions: ['s-q1', 's-q2'], passPercent: 75, results: 's-res' } },
    { cmd: 'trigger.add', args: { slide: 's-res', on: { event: 'timelineStart' }, do: [{ action: 'submitQuiz', quiz: 'qz' }] } },
    { cmd: 'tracking.set', args: { complete: [{ slidesViewed: 100 }, { quiz: 'qz' }], status: 'passed-failed' } },
  ], { rng: seededRng(5) });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.doc;
}
const EVENTS = [
  { type: 'click', target: 'o-btn' }, { type: 'tick', ms: 1200 }, { type: 'next' },
  { type: 'choose', choice: 'a' }, { type: 'submit' }, { type: 'continue' },
  { type: 'input', answer: true, text: 'Teal' }, { type: 'submit' }, { type: 'continue' },
];

test('runtimeBundle evaluates as a classic script and replays the ESM runtime trace exactly', () => {
  const src = runtimeBundle();
  assert.doesNotMatch(src, /^\s*(import|export)\b/m);
  const win = {};
  vm.runInNewContext(src, { window: win, structuredClone });
  assert.deepEqual(Object.keys(win.CFRuntime).sort(), ['createRuntime', 'play', 'seededRng']);
  const doc = normalize(course());
  const esm = play(doc, EVENTS, { rng: seededRng(9) });
  const bundled = win.CFRuntime.play(doc, EVENTS, { rng: win.CFRuntime.seededRng(9) });
  const pick = (r) => JSON.parse(JSON.stringify({ trace: r.trace, lms: r.lms, slide: r.slide, vars: r.vars, status: r.status }));
  assert.deepEqual(pick(bundled), pick(esm));
  assert.ok(esm.trace.includes('quiz qz submit 50 failed'), esm.trace.join('\n'));
});

test('publishWeb writes a self-contained package that validates clean', () => {
  const out = path.join(tmp('web'), 'web');
  const r = publishWeb(course(), out);
  assert.equal(r.launch, 'index.html');
  assert.deepEqual(r.files, ['cf-player.css', 'cf-player.js', 'cf-runtime.js', 'course.js', 'index.html']);
  for (const f of r.files) assert.ok(fs.existsSync(path.join(out, f)), f);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'">/);
  assert.match(html, /<title>Publish &lt;Test&gt; &amp; Co<\/title>/);
  assert.doesNotMatch(html, /cf-scorm\.js/);
  const order = ['course.js', 'cf-runtime.js', 'cf-player.js'].map((s) => html.indexOf(`<script src="${s}">`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'scripts load data, runtime, player in order');
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(out, 'course.js'), 'utf8'), { window: win });
  assert.equal(win.CF_COURSE.id, 'pubtest');
  assert.equal(win.CF_COURSE.player.resume, 'prompt', 'course.js holds the normalized document');
  assert.deepEqual(validatePackage(out), []);
});

test('published web and SCORM boot offer resume for both slide snapshot versions', () => {
  for (const publish of [publishWeb, publishScorm12]) {
    const out = path.join(tmp('resume'), 'pkg'), doc = course();
    publish(doc, out);
    const boot = fs.readFileSync(path.join(out, 'index.html'), 'utf8').split('<script>\n')[1].split('</script>')[0];
    for (const v of [1, 2, 99]) {
      const snap = { v, slide: 's-q1' };
      let mounted, reads = 0;
      const init = () => { reads++; return snap; };
      const win = { CF_COURSE: doc, addEventListener() {},
        localStorage: { getItem: () => JSON.stringify(init()) },
        CFScorm: { createScormAdapter: () => ({ init }) },
        CFRuntime: { createRuntime: () => ({}) },
        CFPlayer: { mount: (_el, opts) => { mounted = opts; } },
      };
      vm.runInNewContext(boot, { window: win, document: { getElementById: () => ({}) } });
      assert.equal(reads, 1);
      assert.equal(mounted.resumePrompt?.v ?? false, v === 99 ? false : v, `${publish.name} v${v}`);
    }
  }
});

test('publishWeb refuses an invalid course before writing anything', () => {
  const out = path.join(tmp('bad'), 'web');
  const doc = course();
  doc.slides[0].triggers[0].do[1].layer = 'l-nope';
  assert.throws(() => publishWeb(doc, out), (e) => e.errors?.some((x) => x.code === 'ref'));
  assert.equal(fs.existsSync(out), false);
});

test('assets: copied from courseDir; traversal, reserved names and missing files are refused', () => {
  const courseDir = tmp('course');
  fs.mkdirSync(path.join(courseDir, 'assets'));
  fs.copyFileSync(path.join(ROOT, 'tests/fixtures/synthetic/synthetic-200x120.png'), path.join(courseDir, 'assets/pic.png'));
  const out = path.join(tmp('assets'), 'web');
  const r = publishWeb(course({ withAsset: true }), out, { courseDir });
  assert.ok(r.files.includes('assets/pic.png'));
  assert.deepEqual(fs.readFileSync(path.join(out, 'assets/pic.png')), fs.readFileSync(path.join(courseDir, 'assets/pic.png')));
  assert.deepEqual(validatePackage(out), []);

  assert.throws(() => publishWeb(course({ withAsset: true }), path.join(tmp('x'), 'o')), /courseDir is required/);
  // asset.add already rejects these paths; the publisher must also hold for hand-edited documents.
  for (const p of ['../outside.png', 'assets/../../outside.png', path.resolve(os.tmpdir(), 'abs.png'), 'cf-player.js', 'CF-PLAYER.JS', '.cf-publish.json']) {
    const o = path.join(tmp('trav'), 'web');
    const doc = course({ withAsset: true });
    doc.assets[0].path = p;
    assert.throws(() => publishWeb(doc, o, { courseDir }), /must stay inside the course folder/, p);
    assert.equal(fs.existsSync(o), false, 'nothing written for ' + p);
  }
  assert.throws(() => publishWeb(course({ withAsset: true, assetPath: 'assets/missing.png' }), path.join(tmp('miss'), 'web'), { courseDir }), /missing asset file\(s\).*assets\/missing\.png/);
});

test('publishScorm12 adds the adapter and a manifest with masteryscore, and zips', () => {
  const base = tmp('scorm');
  const out = path.join(base, 'pkg');
  const r = publishScorm12(course(), out, { zip: true });
  assert.equal(r.launch, 'index.html');
  assert.ok(r.files.includes('cf-scorm.js') && r.files.includes('imsmanifest.xml'));
  assert.equal(r.zip, path.resolve(out) + '.zip');
  assert.ok(fs.statSync(r.zip).size > 1000);
  const xml = fs.readFileSync(path.join(out, 'imsmanifest.xml'), 'utf8');
  assert.match(xml, /<adlcp:masteryscore>75<\/adlcp:masteryscore>/, 'passPercent of the first quiz in tracking.complete');
  assert.match(xml, /<resource identifier="pubtest-sco" type="webcontent" adlcp:scormtype="sco" href="index.html">/);
  for (const f of r.files.filter((f) => f !== 'imsmanifest.xml')) assert.match(xml, new RegExp(`<file href="${f.replace('.', '\\.')}"/>`));
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="cf-scorm.js">') > html.indexOf('<script src="cf-runtime.js">'));
  assert.match(html, /function toScormInteraction\(r\)/);
  assert.deepEqual(validatePackage(out), []);

  const plain = applyAll(emptyCourse({ id: 'plain', title: 'Plain' }), [{ cmd: 'slide.add', args: { id: 's-1' } }]).doc;
  publishScorm12(plain, path.join(base, 'plain'));
  assert.doesNotMatch(fs.readFileSync(path.join(base, 'plain/imsmanifest.xml'), 'utf8'), /masteryscore/);
});

test('validatePackage reports missing launch/manifest files, external URLs and malformed XML; openUrl targets are allowed', () => {
  const doc = course();
  doc.slides[0].triggers.push({ id: 't-open', on: { event: 'click', target: 'o-btn' }, do: [{ action: 'openUrl', url: 'https://example.org/docs?a=1&b=2' }] });
  const out = path.join(tmp('val'), 'pkg');
  publishScorm12(doc, out);
  assert.deepEqual(validatePackage(out), [], 'openUrl target inside course.js is fine');

  fs.appendFileSync(path.join(out, 'cf-player.css'), '\n.x { background-image: url(https://cdn.example.com/a.png); }\n');
  fs.rmSync(path.join(out, 'cf-runtime.js'));
  const xmlFile = path.join(out, 'imsmanifest.xml');
  fs.writeFileSync(xmlFile, fs.readFileSync(xmlFile, 'utf8').replace('</organizations>', ''));
  const codes = validatePackage(out).map((p) => `${p.code} ${p.path}`);
  assert.ok(codes.includes('external-url cf-player.css'), codes.join('\n'));
  assert.ok(codes.includes('missing cf-runtime.js'), codes.join('\n'));
  assert.ok(codes.includes('xml imsmanifest.xml'), codes.join('\n'));

  fs.rmSync(path.join(out, 'index.html'));
  assert.ok(validatePackage(out).some((p) => p.code === 'missing' && p.path === 'index.html'));
  const empty = tmp('empty');
  assert.deepEqual(validatePackage(empty).map((p) => p.code), ['missing']);
});

test('published course URL text and rich links remain data; remote executable and CSS resources still fail validation', () => {
  const doc = course(), object = doc.slides[0].objects[0];
  object.text = 'Reference: https://example.org/reading';
  object.alt = 'https://example.org/alternative';
  object.rich = [{ runs: [{ text: object.text, link: 'https://example.org/reading' }] }];
  const out = path.join(tmp('url-data'), 'pkg');
  publishScorm12(doc, out);
  assert.deepEqual(validatePackage(out), []);
  const saved = JSON.parse(fs.readFileSync(path.join(out, 'course.js'), 'utf8').replace(/^window\.CF_COURSE = /, '').replace(/;\s*$/, ''));
  assert.deepEqual(saved.slides[0].objects.find(o => o.id === object.id).rich, object.rich);
  fs.appendFileSync(path.join(out, 'course.js'), '\nfetch("https://telemetry.example.org/events");');
  fs.appendFileSync(path.join(out, 'cf-player.css'), '\n.x { background-image: url(https://cdn.example.org/image.png); }');
  const errors = validatePackage(out);
  assert.ok(errors.some(e => e.path === 'course.js' && e.code === 'external-url'));
  assert.ok(errors.some(e => e.path === 'cf-player.css' && e.code === 'external-url'));
});

test('previewHtml inlines everything, escapes script breakouts, and ships a hidden debug panel', () => {
  const doc = course();
  doc.slides[0].objects[0].text = 'evil </script><script>alert(1)</script>';
  const html = previewHtml(doc, { assetsBase: '/files/' });
  assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"/);
  assert.equal(html.match(/<\/script>/g).length, html.match(/<script>/g).length, 'no early </script> from course text');
  assert.match(html, /<aside id="cf-debug" aria-label="Debug" hidden>/);
  assert.match(html, /aria-controls="cf-debug">Debug<\/button>/);
  assert.match(html, /\("\/files\/"\);/);
  assert.match(html, /window\.CFRuntime = \{ createRuntime, play, seededRng \}/);
  assert.match(html, /window\.CF_COURSE = /);
});

test('cf-player.js and the inlined boot code stay ES2017 classic scripts', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'packages/player/cf-player.js'), 'utf8');
  const out = path.join(tmp('es'), 'pkg');
  publishScorm12(course(), out);
  const boot = fs.readFileSync(path.join(out, 'index.html'), 'utf8').split('<script>\n')[1].split('</script>')[0];
  for (const code of [raw, boot].map((s) => s.replace(/\/\/.*$/gm, ''))) {
    assert.doesNotMatch(code, /\?\.[^\d]|\?\?|catch\s*\{|\{\s*\.\.\.|\(\?<|^\s*(import|export)\s/m);
  }
  const ctx = { window: {} };
  vm.runInNewContext(raw, ctx);
  assert.equal(typeof ctx.window.CFPlayer.mount, 'function');
  new vm.Script(boot); // parses
});

test('toScormInteraction maps runtime records to spec-valid CFScorm records', () => {
  const base = { quiz: 'qz', question: 's-q', prompt: 'p', weighting: 10 };
  assert.deepEqual(toScormInteraction({ ...base, id: 'qz_s-q1_0', type: 'mc', response: [2], responseLabels: ['C'], correct: [0], result: 'incorrect' }),
    { id: 'qz_s-q1_0', type: 'choice', result: 'wrong', weighting: 10, response: [2], correct: [0] });
  assert.deepEqual(toScormInteraction({ ...base, id: 'qz s/q#2', type: 'mr', response: [0, 2], responseLabels: ['A', 'C'], correct: [0, 2], result: 'correct' }),
    { id: 'qz_s_q_2', type: 'choice', result: 'correct', weighting: 10, response: [0, 2], correct: [0, 2] });
  assert.deepEqual(toScormInteraction({ ...base, id: 'f', type: 'fill', response: 'teal', responseLabels: ['teal'], correct: ['teal', 'blue'], result: 'correct' }),
    { id: 'f', type: 'fill-in', result: 'correct', weighting: 10, response: 'teal', correct: ['teal', 'blue'] });
  const tf = (label, ix, result) => { const r = toScormInteraction({ ...base, id: 't', type: 'tf', response: [ix], responseLabels: [label], correct: [0], result }); return [r.type, r.response, r.correct]; };
  assert.deepEqual(tf('True', 0, 'correct'), ['true-false', true, true]);
  assert.deepEqual(tf('False', 1, 'incorrect'), ['true-false', false, true]);
  assert.deepEqual(tf(' yes ', 1, 'incorrect'), ['true-false', true, false]);
  assert.deepEqual(tf('Agree', 0, 'correct'), ['true-false', true, true], 'unknown label: first choice is true');
  assert.deepEqual(tf('Disagree', 1, 'correct'), ['true-false', false, false]);
  assert.equal(toScormInteraction({ ...base, id: '', type: 'mc', response: [0], correct: [0], result: 'correct' }).id, 'interaction');
});

test('republish removes only files from the previous publish; foreign non-empty folders are refused', async () => {
  const { publishWeb: pw } = await import('../../packages/publisher/index.js');
  const { emptyCourse: ec } = await import('../../packages/schema/index.js');
  const { applyAll: aa } = await import('../../packages/core/index.js');
  const fsm = await import('node:fs'); const osm = await import('node:os'); const pm = await import('node:path');
  const dir = fsm.mkdtempSync(pm.join(osm.tmpdir(), 'cf-repub-'));
  const out = pm.join(dir, 'out');
  const doc = aa(ec(), [{ cmd: 'slide.add', args: { id: 's-1' } }]).doc;
  pw(doc, out);
  fsm.writeFileSync(pm.join(out, 'stale-from-old.txt'), 'x'); // not ours: must survive
  pw(doc, out);
  assert.ok(fsm.existsSync(pm.join(out, 'stale-from-old.txt')));
  const foreign = pm.join(dir, 'foreign'); fsm.mkdirSync(foreign); fsm.writeFileSync(pm.join(foreign, 'keep.txt'), 'x');
  assert.throws(() => pw(doc, foreign), /not empty/);
});

test('SCORM zip holds only published files; # in asset names is URL-encoded (review 002 #4, #11)', () => {
  const courseDir = tmp('hash');
  fs.mkdirSync(path.join(courseDir, 'assets'));
  fs.copyFileSync(path.join(ROOT, 'tests/fixtures/synthetic/synthetic-200x120.png'), path.join(courseDir, 'assets/a#b.png'));
  const out = path.join(tmp('zip'), 'pkg');
  publishScorm12(course({ withAsset: true, assetPath: 'assets/a#b.png' }), out, { courseDir, zip: true });
  assert.match(fs.readFileSync(path.join(out, 'imsmanifest.xml'), 'utf8'), /<file href="assets\/a%23b\.png"\/>/);
  assert.deepEqual(validatePackage(out), []);
  fs.writeFileSync(path.join(out, 'private-notes.txt'), 'not for the LMS');
  const r = publishScorm12(course({ withAsset: true, assetPath: 'assets/a#b.png' }), out, { courseDir, zip: true });
  const zip = fs.readFileSync(r.zip);
  assert.ok(fs.existsSync(path.join(out, 'private-notes.txt')), 'stray file is kept on disk');
  assert.equal(zip.includes(Buffer.from('private-notes.txt')), false, 'but never packaged');
  for (const f of r.files) assert.ok(zip.includes(Buffer.from(f)), f);
});
