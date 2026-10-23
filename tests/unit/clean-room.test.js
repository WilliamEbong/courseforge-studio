// Public-repository hygiene: the product ships only original code and assets. Every tracked file and every commit
// message is scanned for third-party runtime markers, private paths, secrets and internal working notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = 'tests/unit/clean-room.test.js';
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const tracked = git('ls-files').split('\n').filter(Boolean);
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|emf|mp4|webm|wav|mp3|ogg|zip)$/i;
const text = tracked.filter((f) => f !== SELF && !BINARY.test(f));

const TOP = new Set(['packages', 'tests', 'samples', 'docs', 'specs', 'build', '.github', '.specify', '.claude', '.agents', '.codex',
  'README.md', 'LICENSE', 'CHANGELOG.md', 'CLAUDE.md', 'AGENTS.md', 'package.json', 'package-lock.json', 'playwright.config.js',
  'electron-builder.yml', '.gitignore', '.gitattributes', 'PRODUCT.md', 'DESIGN.md', '.impeccable']);
// Internal working notes and private material never appear in the public tree or history.
const PRIVATE = [/reverse.?engineer/i, /private-fixtures/i, /DIRECTIVE_PLAN/, /\bHANDOFF/, /\bresearch\//, /\bREA[- ]\d/, /Evidence ID/i,
  /\bev_[0-9a-f]{12}/, /[A-Z]:\\Users\\/i, /\/Users\/Owner\b/i, /sk-ant-[A-Za-z0-9]/];
// Identifiers that only appear in third-party player code or its telemetry, never in our own runtime.
const MARKERS = [/globalProvideData\s*\(/, /metrics\.articulate\.com/i, /\bGetPlayer\s*\(/, /frame\.desktop\.min\.js/, /\bDS\.(appState|pubSub|windowManager)\b/, /cdn\.articulate/i];

const scan = (patterns) => text.flatMap((f) => { const t = fs.readFileSync(path.join(ROOT, f), 'utf8'); return patterns.filter((m) => m.test(t)).map((m) => `${f}: ${m}`); });

test('only allowlisted top-level paths are tracked', () => {
  assert.deepEqual([...new Set(tracked.map((f) => f.split('/')[0]))].filter((t) => !TOP.has(t)), []);
});

test('no third-party asset files are tracked (fonts, .story, HLS media, published player folders)', () => {
  const bad = tracked.filter((f) => /\.(story|ttf|otf|woff2?|eot|m3u8)$/i.test(f) || /(^|\/)(story_content|html5\/lib|html5\/data)\//i.test(f) || /analytics-frame\.html$/i.test(f));
  assert.deepEqual(bad, []);
});

test('no tracked text file contains third-party runtime markers', () => assert.deepEqual(scan(MARKERS), []));

test('no tracked text file contains private paths, secrets or internal working notes', () => assert.deepEqual(scan(PRIVATE), []));

test('no commit message contains private paths, secrets or internal working notes', () => {
  const log = git('rev-list', '--all', '--count').trim() === '0' ? '' : git('log', '--all', '--format=%B%n%an <%ae>');
  assert.deepEqual(PRIVATE.filter((m) => m.test(log)).map(String), []);
});

test('no file in packages/ or samples/ is large enough to be a copied bundle (> 300 KB)', () => {
  const big = tracked.filter((f) => /^(packages|samples)\//.test(f) && fs.statSync(path.join(ROOT, f)).size > 300 * 1024);
  assert.deepEqual(big, []);
});
