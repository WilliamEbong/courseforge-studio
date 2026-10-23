// AI generation hook. outline.add scaffolds a slides or lessons course from a structured
// outline in one deterministic, validated, undoable command (agents call it via CLI/MCP/HTTP; the editor exposes it too).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../../packages/core/index.js';
import { emptyCourse, validate, serialize } from '../../packages/schema/index.js';
import { play, seededRng } from '../../packages/runtime/index.js';

const outline = { sections: [
  { title: 'Basics', items: [
    { title: 'Why it matters', text: 'Most incidents start small.', bullets: ['Wear goggles', 'Label everything'] },
    { title: 'First step', question: { type: 'mc', prompt: 'What first?', choices: [{ label: 'Goggles', correct: true }, { label: 'Coffee' }] } },
  ] },
  { title: 'Practice', items: [{ title: 'Spills', text: 'Stop, alert, contain.', question: { type: 'fill', prompt: 'Type stop', answers: ['stop'] } }] },
] };

test('slides mode: sections -> scenes, items -> slides, questions -> question slides; valid, playable, deterministic', () => {
  const run = () => applyAll(emptyCourse({ title: 'Gen' }), [{ cmd: 'outline.add', args: outline }], { rng: seededRng(9) });
  const r = run();
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(validate(r.doc), []);
  assert.equal(r.results[0].scenes.length, 2);
  assert.equal(r.results[0].slides.length, 5, '3 content slides + 2 question slides');
  assert.equal(serialize(run().doc), serialize(r.doc), 'same rng, same document');
  const q = r.doc.slides.find((s) => s.question?.type === 'mc');
  assert.deepEqual(q.question.choices.map((c) => [c.id, c.correct]), [['a', true], ['b', false]]);
  const p = play(r.doc, [{ type: 'next' }, { type: 'next' }]);
  assert.equal(p.slide, q.id);
});

test('lessons mode: sections -> sections, items -> lessons with heading/text/list/knowledge-check blocks', () => {
  const r = applyAll(emptyCourse({ title: 'Gen' }), [{ cmd: 'course.set', args: { mode: 'lessons' } }, { cmd: 'outline.add', args: outline }], { rng: seededRng(9) });
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(validate(r.doc), []);
  assert.equal(r.doc.sections.length, 2);
  const first = r.doc.sections[0].lessons[0];
  assert.deepEqual(first.blocks.map((b) => b.type), ['heading', 'text', 'list']);
  assert.equal(r.doc.sections[0].lessons[1].blocks.at(-1).type, 'question');
});

test('errors are actionable: tf knowledge checks in lessons mode are refused with a hint', () => {
  const r = applyAll(emptyCourse(), [{ cmd: 'course.set', args: { mode: 'lessons' } }, { cmd: 'outline.add', args: { sections: [{ title: 'S', items: [{ title: 'L', question: { type: 'tf', prompt: 'p' } }] }] } }]);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].hint, /mc with True\/False/);
});

test('outline.add {text}: the plain outline (editor dialog, agents) builds the same course as the structured form', () => {
  const text = `# Basics
## Why it matters
Most incidents start small.
- Wear goggles
- Label everything

## First step
? What first?
[x] Goggles
[ ] Coffee

# Practice
## Spills
Stop, alert, contain.
? Type stop
= stop`;
  const a = applyAll(emptyCourse({ title: 'Gen' }), [{ cmd: 'outline.add', args: outline }], { rng: seededRng(9) });
  const b = applyAll(emptyCourse({ title: 'Gen' }), [{ cmd: 'outline.add', args: { text } }], { rng: seededRng(9) });
  assert.ok(b.ok, JSON.stringify(b.errors));
  assert.equal(serialize(b.doc), serialize(a.doc));
  const mr = applyAll(emptyCourse(), [{ cmd: 'outline.add', args: { text: `## Pick two
? Which protect you?
[x] Goggles
[x] Gloves
[ ] Sandals` } }]);
  assert.ok(mr.ok, JSON.stringify(mr.errors));
  assert.equal(mr.doc.slides.find((s) => s.question).question.type, 'mr');
});

test('outline.add {text}: errors name the line and give the syntax; sections and text together are refused', () => {
  const bad = applyAll(emptyCourse(), [{ cmd: 'outline.add', args: { text: `# A
just text before any item` } }]);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /line 2: text before the first "## " item/);
  assert.match(bad.errors[0].hint, /\[x\]/);
  const orphan = applyAll(emptyCourse(), [{ cmd: 'outline.add', args: { text: `## A
[x] Yes` } }]);
  assert.match(orphan.errors[0].message, /line 2: a choice needs/);
  const both = applyAll(emptyCourse(), [{ cmd: 'outline.add', args: { text: '## A', sections: outline.sections } }]);
  assert.match(both.errors[0].message, /either sections or text/);
});
