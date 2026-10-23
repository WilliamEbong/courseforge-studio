// (editor responsiveness): undo history holds patches, not whole documents, so an edit costs the same
// on the 100th change as on the first, and a large course does not turn every keystroke into megabytes of I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveCourse, history, runCommands, loadCourse, diff, patch } from '../../packages/cli/io.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { applyAll } from '../../packages/core/index.js';
import { seededRng } from '../../packages/runtime/index.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cf-017-')), 'c.course.json');
function bigFile(slides = 60) {
  const cmds = [];
  for (let i = 0; i < slides; i++) cmds.push({ cmd: 'slide.add', args: { id: `s-${i}`, title: `Slide ${i}`, objects: Array.from({ length: 8 }, (_, k) => ({ id: `o-${i}-${k}`, type: 'text', text: `Slide ${i} text ${k} `.repeat(6), x: 10 * k, y: 20 * k, w: 300, h: 40 })) } });
  const r = applyAll(emptyCourse({ id: 'big', title: 'Big' }), cmds, { rng: seededRng(1) });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const f = tmp();
  saveCourse(f, r.doc);
  return f;
}

test('100 nudges on a large course keep the history file small and every step undoable', () => {
  const f = bigFile();
  const docBytes = fs.statSync(f).size;
  const original = loadCourse(f);
  for (let i = 1; i <= 100; i++) assert.ok(runCommands(f, [{ cmd: 'object.set', args: { id: 'o-3-2', x: 20 + i } }]).ok);
  const histBytes = fs.statSync(`${f}.history.json`).size;
  assert.ok(histBytes < docBytes / 2, `history ${histBytes} bytes for a ${docBytes}-byte course`);
  const final = loadCourse(f);
  assert.equal(history.depth(f).undo, 100);
  for (let i = 0; i < 100; i++) assert.ok(history.undo(f));
  assert.deepEqual(loadCourse(f), original, 'undo all returns the original document');
  for (let i = 0; i < 100; i++) assert.ok(history.redo(f));
  assert.deepEqual(loadCourse(f), final, 'redo all returns the final document');
});

test('adding and removing slides undoes exactly (arrays that change length)', () => {
  const f = bigFile(3);
  const before = loadCourse(f);
  const r = runCommands(f, [{ cmd: 'slide.add', args: { title: 'New' } }]);
  runCommands(f, [{ cmd: 'slide.remove', args: { id: 's-0' } }]);
  const after = loadCourse(f);
  history.undo(f); history.undo(f);
  assert.deepEqual(loadCourse(f), before);
  history.redo(f); history.redo(f);
  assert.deepEqual(loadCourse(f), after);
  assert.ok(r.ok);
});

test('a history file in the old whole-document format is ignored, not fatal', () => {
  const f = bigFile(1);
  fs.writeFileSync(`${f}.history.json`, JSON.stringify({ undo: [{ forward: { cmd: 'x' }, inverse: { cmd: 'course.replace', args: { doc: {} } } }], redo: [] }));
  assert.ok(runCommands(f, [{ cmd: 'slide.set', args: { id: 's-0', title: 'Renamed' } }]).ok);
  assert.equal(history.depth(f).undo, 1);
  assert.ok(history.undo(f));
  assert.equal(loadCourse(f).slides[0].title, 'Slide 0');
});

test('an external write (another process) is seen by the next load', () => {
  const f = bigFile(1);
  loadCourse(f);
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  doc.title = 'Changed outside';
  fs.writeFileSync(f, JSON.stringify(doc));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.equal(loadCourse(f).title, 'Changed outside');
});

test('patches are plain data: prototype-named keys stay own properties, a missing path refuses', () => {
  const a = JSON.parse('{"s":{"constructor":{"text":"a"},"__proto__":{"x":1}}}');
  const b = JSON.parse('{"s":{"constructor":{"text":"b"},"__proto__":{"x":2}}}');
  const out = patch(a, diff(a, b));
  assert.deepEqual(out, b);
  assert.equal(Object.getPrototypeOf(out.s), Object.prototype);
  assert.equal(Object.prototype.x, undefined);
  assert.throws(() => patch({ s: {} }, [[['s', 'constructor', 'text'], 'injected']]), /changed/);
  assert.equal(Object.text, undefined);
});

test('undo and redo say what they will undo or redo (FR-C10)', () => {
  const f = bigFile(1);
  runCommands(f, [{ cmd: 'object.set', args: { id: 'o-0-1', x: 5, y: 6 } }]);
  assert.equal(history.depth(f).undoLabel, 'Move object');
  runCommands(f, [{ cmd: 'slide.add', args: { title: 'New' } }]);
  assert.equal(history.depth(f).undoLabel, 'Add slide');
  runCommands(f, [{ cmd: 'object.set', args: { id: 'o-0-1', text: 'Hi' } }, { cmd: 'slide.set', args: { id: 's-0', title: 'T' } }]);
  assert.equal(history.depth(f).undoLabel, '2 changes');
  history.undo(f);
  assert.deepEqual([history.depth(f).undoLabel, history.depth(f).redoLabel], ['Add slide', '2 changes']);
});

// ---------------- Codex review 007 ----------------
test('a save racing with another writer never caches the wrong document (007 #1)', () => {
  const f = bigFile(1);
  const rename = fs.renameSync;
  let raced = false;
  fs.renameSync = (a, b) => { // writer B saves right after our rename, before we look at the file again
    rename(a, b);
    if (!raced && path.resolve(b) === path.resolve(f)) { raced = true; const d = JSON.parse(fs.readFileSync(f, 'utf8')); d.title = 'Other writer'; fs.writeFileSync(f, JSON.stringify(d, null, 1)); }
  };
  try { assert.ok(runCommands(f, [{ cmd: 'course.set', args: { title: 'My edit' } }]).ok); } finally { fs.renameSync = rename; }
  assert.equal(loadCourse(f).title, 'Other writer', 'the next load sees what is on disk, not what we wrote');
});

test('undo and redo refuse when the course changed outside the shared history (007 #2)', () => {
  const f = bigFile(1);
  runCommands(f, [{ cmd: 'object.set', args: { id: 'o-0-0', x: 999 } }]);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.slides[0].objects.reverse(); // another program reorders the objects without recording history
  fs.writeFileSync(f, JSON.stringify(d, null, 2));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  const disk = fs.readFileSync(f, 'utf8');
  assert.throws(() => history.undo(f), /changed outside/);
  assert.equal(fs.readFileSync(f, 'utf8'), disk, 'nothing was applied');
  assert.equal(history.depth(f).undo, 1, 'the step stays for later');
});
