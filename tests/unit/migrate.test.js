// versioned documents migrate forward; newer or unknown versions are refused with a hint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, CURRENT } from '../../packages/schema/migrate.js';
import { parse, emptyCourse, serialize } from '../../packages/schema/index.js';

test('current documents pass through unchanged; parse() still round-trips', () => {
  const d = emptyCourse({ title: 'T' });
  assert.equal(migrate(d), d);
  const text = serialize(d);
  assert.equal(serialize(parse(text)), text);
});

test('a newer version is refused with an actionable hint; an unknown one too', () => {
  assert.throws(() => parse(JSON.stringify({ ...emptyCourse(), schema: 'cf.course/2' })), (e) => e.errors[0].code === 'version' && /newer CourseForge Studio/.test(e.errors[0].message) && /update CourseForge Studio/.test(e.errors[0].hint));
  assert.throws(() => parse(JSON.stringify({ ...emptyCourse(), schema: 'something-else' })), (e) => e.errors[0].code === 'version' && e.errors[0].hint.includes(CURRENT));
});

test('steps run in order from an older version (exercised with a test-only table)', () => {
  const steps = [
    { from: 'cf.course/1', to: 'cf.course/2', run: (d) => ({ ...d, renamed: d.old, old: undefined }) },
    { from: 'cf.course/2', to: 'cf.course/3', run: (d) => ({ ...d, added: true }) },
  ];
  const out = migrate({ schema: 'cf.course/1', old: 7 }, steps, 'cf.course/3');
  assert.deepEqual({ schema: out.schema, renamed: out.renamed, added: out.added }, { schema: 'cf.course/3', renamed: 7, added: true });
  assert.throws(() => migrate({ schema: 'cf.course/1' }, [], 'cf.course/2'), (e) => /no migration from cf.course\/1/.test(e.message));
});
