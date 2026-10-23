// adversarial inputs. Seeded (reproducible) mutations of real documents, commands, resume data
// and archives must yield error lists or controlled exceptions, never crashes, hangs or invalid saved documents.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, parse, serialize } from '../../packages/schema/index.js';
import { apply, commands } from '../../packages/core/index.js';
import { createRuntime, seededRng } from '../../packages/runtime/index.js';
import { readZip } from '../../packages/import-story/zip-read.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'samples/lab-safety.course.json'), 'utf8'));
const rnd = seededRng(20261016);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const JUNK = [null, undefined, 0, -1, 1e308, NaN, '', 'x'.repeat(5000), '__proto__', 'constructor', true, [], {}, [null], { __proto__: { polluted: 1 } }, '../../etc', '<script>', 1.5];

/** Replace one random node of a JSON tree with junk (or delete it). */
function mutate(doc) {
  const d = structuredClone(doc);
  const paths = [];
  (function walk(x, p) { if (x && typeof x === 'object') for (const k of Object.keys(x)) { paths.push([...p, k]); walk(x[k], [...p, k]); } })(d, []);
  const p = pick(paths);
  let parent = d; for (const k of p.slice(0, -1)) parent = parent[k];
  const key = p[p.length - 1];
  if (rnd() < 0.2 && !Array.isArray(parent)) delete parent[key]; else parent[key] = structuredClone(pick(JUNK));
  return d;
}

test('validate/parse never throw on 500 mutated documents; anything that validates also round-trips', () => {
  let invalid = 0;
  for (let i = 0; i < 500; i++) {
    const d = mutate(rnd() < 0.5 ? SAMPLE : mutate(SAMPLE));
    let errs;
    assert.doesNotThrow(() => { errs = validate(d); }, `validate threw on iteration ${i}`);
    if (errs.length) { invalid++; assert.throws(() => parse(JSON.stringify(d)), (e) => Array.isArray(e.errors)); continue; }
    const text = serialize(parse(JSON.stringify(d)));
    assert.equal(serialize(parse(text)), text, 'round trip is stable');
  }
  assert.ok(invalid > 100, `mutations should mostly produce invalid documents (got ${invalid})`);
  assert.equal(({}).polluted, undefined, 'no prototype pollution');
});

test('600 random commands with junk args: apply() returns ok or errors, never throws, never yields an invalid doc', () => {
  const names = Object.keys(commands);
  let doc = parse(JSON.stringify(SAMPLE));
  let okCount = 0;
  for (let i = 0; i < 600; i++) {
    const name = pick(names);
    const spec = commands[name];
    const example = spec.examples?.length ? structuredClone(pick(spec.examples)) : {};
    const args = rnd() < 0.5 ? example : mutate({ a: example }).a ?? {};
    let r;
    assert.doesNotThrow(() => { r = apply(doc, { cmd: name, args }, { rng: rnd }); }, `${name} threw`);
    if (r.ok) { okCount++; assert.deepEqual(validate(r.doc), [], `${name} produced an invalid document`); doc = r.doc; }
    else assert.ok(Array.isArray(r.errors) && r.errors.every((e) => e.path && e.code && e.message), `${name} error shape`);
  }
  assert.ok(okCount > 10, `some commands should succeed (got ${okCount})`);
});

test('runtime restore() rejects 300 junk snapshots without throwing; play continues', () => {
  const doc = parse(JSON.stringify(SAMPLE));
  const good = (() => { const rt = createRuntime(doc, { rng: seededRng(1) }); rt.start(); rt.dispatch({ type: 'next' }); return rt.snapshot(); })();
  for (let i = 0; i < 300; i++) {
    const snap = rnd() < 0.3 ? pick(JUNK) : mutate(good);
    const rt = createRuntime(doc, { rng: seededRng(2) });
    assert.doesNotThrow(() => { rt.restore(snap); rt.dispatch({ type: 'next' }); rt.tick(1000); rt.view(); }, `restore threw on iteration ${i}`);
  }
});

test('readZip rejects 300 random or truncated byte buffers with an Error (no hang, no crash)', () => {
  const real = fs.readFileSync(path.join(ROOT, 'tests/fixtures/synthetic/synthetic-200x120.png'));
  for (let i = 0; i < 300; i++) {
    const n = Math.floor(rnd() * 4096);
    const buf = Buffer.alloc(n);
    for (let j = 0; j < n; j++) buf[j] = Math.floor(rnd() * 256);
    if (rnd() < 0.3 && n > 4) buf.writeUInt32LE(0x06054b50, n - 4 - Math.floor(rnd() * Math.min(n - 4, 22))); // fake end-of-central-directory
    const input = rnd() < 0.1 ? real : buf;
    try { readZip(input); } catch (e) { assert.ok(e instanceof Error, 'throws an Error'); }
  }
});
