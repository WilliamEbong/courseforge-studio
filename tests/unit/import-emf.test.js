import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importStory, storyId } from '../../packages/import-story/index.js';
import { emfToPng } from '../../packages/import-story/emf.js';
import { readZip } from '../../packages/import-story/zip-read.js';
import { rezip } from '../../packages/publisher/zip.js';
import { publishWeb, validatePackage } from '../../packages/publisher/index.js';
import { openStory, saveStory } from '../../packages/export-story/save.js';
import { G, ID, obj, slide, pkg } from '../fixtures/synthetic/story-builder.js';

test('EMF conversion refuses unsupported hosts, malformed data and oversized input', () => {
  if (process.platform !== 'win32') assert.throws(() => emfToPng(Buffer.alloc(88)), /requires Windows/);
  else {
    assert.throws(() => emfToPng(Buffer.from('emf')), /invalid or oversized/);
    assert.throws(() => emfToPng(Buffer.alloc(16 * 1024 * 1024 + 1)), /invalid or oversized/);
    assert.throws(() => emfToPng(Buffer.alloc(88)), /conversion failed/);
  }
});

test('Windows EMF extraction produces a publishable PNG while native saves preserve original media', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-emf-'));
  try {
    const emf = fs.readFileSync(new URL('../fixtures/synthetic/synthetic-120x80.emf', import.meta.url));
    const name = `story/media/R${storyId(G(21))}.emf`;
    const source = pkg({ parts: [slide(101, { shapes: obj('pic', 201, { attrs: `assetG="${G(21)}"`, at: [20, 30, 260, 190] }) })] });
    const bytes = rezip(source, readZip(source), { put: new Map([[name, emf]]) });
    const file = path.join(dir, 'source.story'); fs.writeFileSync(file, bytes);
    const imported = importStory(file, { courseDir: dir, assetsDir: path.join(dir, 'assets') });
    const pic = imported.doc.slides[0].objects.find(o => o.id === ID('o', 201));
    assert.ok(pic, 'EMF picture remains present');
    const asset = imported.doc.assets.find(a => a.id === pic.image);
    assert.equal(asset.mime, 'image/png');
    const png = fs.readFileSync(path.join(dir, asset.path));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [120, 80]);
    assert.ok(imported.report.items.some(i => i.kind === 'media.rasterized'));
    const web = path.join(dir, 'web'); publishWeb(imported.doc, web, { courseDir: dir });
    assert.deepEqual(validatePackage(web), []);
    const prev = openStory(bytes, { courseDir: dir, assetsDir: path.join(dir, 'assets') });
    assert.equal(saveStory(prev, prev.doc).buf.equals(bytes), true);
    const changed = structuredClone(prev.doc); changed.title = 'Edited title';
    const saved = saveStory(prev, changed);
    assert.equal(readZip(saved.buf).read(name).equals(emf), true);
    assert.equal(fs.readFileSync(file).equals(bytes), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
