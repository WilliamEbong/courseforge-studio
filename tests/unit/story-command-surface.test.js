import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commands, applyAll, query } from '../../packages/core/index.js';
import { seededRng } from '../../packages/runtime/index.js';
import { writeStory } from '../../packages/export-story/index.js';
import { canon } from '../../packages/export-story/save.js';
import * as io from '../../packages/cli/io.js';

// Exercise every slide-mode registry command at the shared native file boundary.
// Lessons commands require JSON storage and have their own mode/parity tests.
test('native command surface either roundtrips or refuses without changing the file or history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-native-surface-'));
  try {
    const seed = path.join(root, 'seed.story');
    fs.writeFileSync(seed, writeStory({ title: 'Command surface' }));
    fs.writeFileSync(path.join(root, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1xkAAAAASUVORK5CYII=', 'base64'));
    const setup = [
      ['scene.add', { id: 'sc-2', title: 'Second' }],
      ...['started', 'score', 'tmp'].map(name => ['var.add', { name, type: name === 'started' ? 'boolean' : 'number' }]),
      ['bank.add', { id: 'bk-safety' }], ['bank.add', { id: 'bk-old' }],
      ...['s-intro', 's-q1', 's-q2', 's-old'].map(id => ['slide.add', { id, title: id }]),
      ['slide.add', { id: 's-bank', bank: 'bk-safety' }],
      ['draw.add', { id: 's-draw', bank: 'bk-safety', count: 1 }],
      ...['o-start', 'o-old', 'o-a', 'o-b', 'o-c', 'o-card'].map((id, i) => ['object.add', { slide: 's-intro', id, type: 'button', text: id, x: i * 70 }]),
      ['state.set', { target: 'o-card', state: 'flipped', text: 'Back' }],
      ['layer.add', { slide: 's-intro', id: 'l-help' }],
      ...['t-start', 't-2'].map(id => ['trigger.add', { slide: 's-intro', id, on: { event: 'click', target: 'o-start' }, do: [{ action: 'jump', to: 'next' }] }]),
      ...['s-q1', 's-q2', 's-bank'].map(slide => ['question.set', { slide, type: 'mc', prompt: 'Choose', choices: [{ id: slide + '-a', label: 'A', correct: true }, { id: slide + '-b', label: 'B' }] }]),
      ['quiz.add', { id: 'qz-final', questions: ['s-q1', 's-q2'] }],
      ['asset.add', { id: 'a-logo', path: 'dot.png' }],
    ].map(([cmd, args]) => ({ cmd, args }));
    assert.equal(io.runCommands(seed, setup).ok, true);
    const bytes = fs.readFileSync(seed);
    let saved = 0, refused = 0;
    for (const c of Object.values(commands).filter(c => !/^(section|lesson|block)\./.test(c.name))) {
      const file = path.join(root, c.name + '.story');
      fs.writeFileSync(file, bytes);
      const before = io.loadCourse(file);
      const overrides = {
        'course.replace': { doc: { ...before, title: 'Replacement' } },
        'scene.set': { id: before.scenes[0].id, title: 'Renamed' },
        'scene.remove': { id: 'sc-2', force: true },
        'bank.add': { id: 'bk-new' },
        'slide.import': { data: query(before, 'slide.export', { id: 's-intro' }).data },
        'object.add': { slide: 's-intro', id: 'o-new', type: 'button', text: 'New' },
        'layer.add': { slide: 's-intro', id: 'l-new' },
        'var.add': { name: 'extra', type: 'number' },
        'quiz.add': { id: 'qz-new', questions: ['s-q1'] },
        'quiz.remove': { id: 'qz-final', force: true },
        'asset.add': { id: 'a-new', path: 'dot.png' },
        'draw.add': { id: 's-new-draw', bank: 'bk-safety', count: 1 },
      };
      const command = { cmd: c.name, args: overrides[c.name] ?? c.examples[0] };
      const expected = applyAll(before, [command], { rng: seededRng(42) });
      assert.equal(expected.ok, true, `${c.name}: invalid test case ${JSON.stringify(expected.errors)}`);
      const history = io.history.depth(file);
      try {
        const result = io.runCommands(file, [command], { rng: seededRng(42) });
        assert.equal(result.ok, true, c.name);
        assert.deepEqual(canon(io.loadCourse(file)), canon(expected.doc), c.name);
        saved++;
      } catch (e) {
        assert.ok(e.errors?.some(x => ['story-unsupported', 'story-referenced', 'story-inherited'].includes(x.code)), `${c.name}: ${e.stack}`);
        assert.ok(fs.readFileSync(file).equals(bytes), c.name);
        assert.deepEqual(io.history.depth(file), history, c.name);
        refused++;
      }
    }
    assert.ok(saved > 30 && refused > 0, `saved=${saved}, refused=${refused}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
