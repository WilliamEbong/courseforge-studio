import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pkg } from '../fixtures/synthetic/story-builder.js';
import { readZip } from '../../packages/import-story/zip-read.js';
import { rezip } from '../../packages/publisher/zip.js';
import { openStory, saveStory } from '../../packages/export-story/save.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { saveCourse, loadCourse, runCommands, history } from '../../packages/cli/io.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-media-cache-'));
const smallPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8i8AAAAASUVORK5CYII=', 'base64');
const assetBytes = (dir, doc, id = doc.assets[0].id) => fs.readFileSync(path.join(dir, doc.assets.find(a => a.id === id).path));

test('native reopens distinguish changed same-GUID media and preserve earlier extracted files', () => {
  const dir = temp(), opts = { courseDir: dir, assetsDir: path.join(dir, 'assets') }, first = pkg(), zip = readZip(first);
  const media = zip.names.find(n => /^story\/media\/.*\.png$/.test(n));
  const second = rezip(first, zip, { put: new Map([[media, smallPng]]) });
  const a = openStory(first, opts), originalPath = a.doc.assets[0].path, original = assetBytes(dir, a.doc);
  const b = openStory(second, opts);
  assert.ok(assetBytes(dir, b.doc).equals(smallPng), 'reopen must extract the current archive bytes');
  assert.notEqual(b.doc.assets[0].path, originalPath, 'different bytes need a different browser cache URL');
  assert.ok(fs.readFileSync(path.join(dir, originalPath)).equals(original), 'earlier files must not be overwritten');
  assert.ok(assetBytes(dir, openStory(first, opts).doc).equals(original));
  assert.ok(saveStory(b, b.doc).buf.equals(second), 'no-edit native bytes stay identical');
  fs.writeFileSync(path.join(dir, b.doc.assets[0].path), 'external edit');
  assert.throws(() => openStory(second, opts), /asset.*conflict/i);
  assert.equal(fs.readFileSync(path.join(dir, b.doc.assets[0].path), 'utf8'), 'external edit');
});

test('native history undo/redo selects the archive media after reusing an asset id', () => {
  const dir = temp(), file = path.join(dir, 'images.story');
  const first = readZip(pkg()).read(readZip(pkg()).names.find(n => /^story\/media\/.*\.png$/.test(n)));
  fs.writeFileSync(path.join(dir, 'first.png'), first);
  fs.writeFileSync(path.join(dir, 'second.png'), smallPng);
  saveCourse(file, emptyCourse());
  const slide = loadCourse(file).slides[0].id, id = 'a-image';
  const add = name => [{ cmd: 'asset.add', args: { id, path: name } }, { cmd: 'object.add', args: { id: 'o-image', slide, type: 'image', image: id, x: 0, y: 0, w: 100, h: 100 } }];
  assert.ok(runCommands(file, add('first.png')).ok);
  const before = fs.readFileSync(file);
  assert.ok(runCommands(file, [{ cmd: 'object.remove', args: { id: 'o-image' } }, { cmd: 'asset.remove', args: { id } }]).ok);
  assert.ok(runCommands(file, add('second.png')).ok);
  const after = fs.readFileSync(file);
  assert.ok(assetBytes(dir, loadCourse(file), id).equals(smallPng));
  history.undo(file);
  assert.ok(assetBytes(dir, history.undo(file), id).equals(first));
  assert.ok(fs.readFileSync(file).equals(before));
  history.redo(file);
  assert.ok(assetBytes(dir, history.redo(file), id).equals(smallPng));
  assert.ok(fs.readFileSync(file).equals(after));
  assert.ok(fs.readFileSync(path.join(dir, 'first.png')).equals(first));
  assert.ok(fs.readFileSync(path.join(dir, 'second.png')).equals(smallPng));
});
