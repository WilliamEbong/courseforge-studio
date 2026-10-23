// SC-1: theme presets meet WCAG AA on the pairs the players draw; theme.apply replaces preset tokens; errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, applyAll, query } from '../../packages/core/index.js';
import { contrast } from '../../packages/core/a11y.js';
import { emptyCourse } from '../../packages/schema/index.js';
import { PRESETS, PRESET_TOKENS, FONTS, themeOf } from '../../packages/schema/themes.js';

// [foreground, background]: a token name or a literal colour the player CSS hard-codes (white button text on the stage
// accent, white question panels on the stage). Text needs 4.5:1; focus rings, field borders and stage controls 3:1.
const TEXT = [['ink', 'bg'], ['ink', 'surface'], ['ink', 'side'], ['ink', 'accent-soft'], ['ink', 'ok-soft'], ['ink', 'bad-soft'],
  ['muted', 'bg'], ['muted', 'surface'], ['muted', 'side'], ['accent', 'bg'], ['accent', 'surface'], ['accent', 'side'], ['accent', 'accent-soft'],
  ['accent-ink', 'accent'], ['ok', 'surface'], ['ok', 'ok-soft'], ['bad', 'surface'], ['bad', 'bad-soft'], ['warn', 'surface'],
  ['stage-ink', 'stage-bg'], ['stage-ink', '#ffffff'], ['#ffffff', 'stage-accent'], ['stage-muted', 'stage-bg'], ['stage-muted', '#ffffff']];
const UI = [['focus', 'bg'], ['focus', 'surface'], ['focus', 'side'], ['field', 'surface'], ['stage-accent', 'stage-bg'],
  ['stage-focus', 'stage-bg'], ['stage-focus', '#ffffff']]; // stage focus rings on the white stage and question cards (review 005 #6)

test('every preset sets the full token set and meets WCAG AA on its key pairs', () => {
  const low = [];
  for (const [name, p] of Object.entries(PRESETS)) {
    if (name === 'auto') { assert.deepEqual(p.tokens, {}); continue; }
    assert.deepEqual(Object.keys(p.tokens).sort(), [...PRESET_TOKENS].sort(), name);
    const c = (x) => (x.startsWith('#') ? x : p.tokens[x]);
    for (const [pairs, min] of [[TEXT, 4.5], [UI, 3]]) {
      for (const [fg, bg] of pairs) { const r = contrast(c(fg), c(bg)); if (!(r >= min)) low.push(`${name}: ${fg} on ${bg} = ${r}:1 (needs ${min})`); }
    }
  }
  assert.deepEqual(low, []);
});

const base = () => emptyCourse({ title: 'Themed' });
test('theme.apply writes the preset, replaces the previous one and keeps custom tokens and the font', () => {
  let r = applyAll(base(), [{ cmd: 'player.set', args: { theme: { radius: '4px', accent: '#ff0000' } } }, { cmd: 'theme.apply', args: { preset: 'ocean', font: 'serif' } }]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepEqual(r.doc.player.theme, { radius: '4px', ...PRESETS.ocean.tokens, font: FONTS.serif.stack, serif: FONTS.serif.stack });
  assert.deepEqual(r.results[1], { preset: 'ocean', font: 'serif' });
  r = apply(r.doc, { cmd: 'theme.apply', args: { preset: 'charcoal' } });
  assert.deepEqual(r.doc.player.theme, { radius: '4px', ...PRESETS.charcoal.tokens, font: FONTS.serif.stack, serif: FONTS.serif.stack });
  assert.deepEqual(themeOf(r.doc.player.theme), { preset: 'charcoal', font: 'serif' });
  r = apply(r.doc, { cmd: 'theme.apply', args: { preset: 'auto', font: 'system' } });
  assert.deepEqual(r.doc.player.theme, { radius: '4px' }, 'auto and system remove every preset and font token');
  assert.deepEqual(themeOf(r.doc.player.theme), { preset: 'auto', font: 'system' });
  r = apply(base(), { cmd: 'theme.apply', args: { font: 'mono' } });
  assert.deepEqual(r.doc.player.theme, { font: FONTS.mono.stack, serif: FONTS.mono.stack });
  assert.equal(themeOf({ ...PRESETS.light.tokens, ink: '#000000' }).preset, 'custom');
});

test('theme.apply errors are actionable: unknown preset or font lists the valid names; an empty call says what to pass', () => {
  const r = apply(base(), { cmd: 'theme.apply', args: { preset: 'neon' } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].path, '/args/preset');
  assert.match(r.errors[0].message, /must be one of: auto, light, charcoal, ocean, forest, high-contrast/);
  const f = apply(base(), { cmd: 'theme.apply', args: { font: 'comic' } });
  assert.match(f.errors[0].message, /system, serif, rounded, mono/);
  const e = apply(base(), { cmd: 'theme.apply', args: {} });
  assert.equal(e.errors[0].code, 'required');
  assert.match(e.errors[0].hint, /presets: auto, light/);
});

test('theme.list returns presets with tokens, fonts and the current choice', () => {
  const r = applyAll(base(), [{ cmd: 'theme.apply', args: { preset: 'forest', font: 'rounded' } }]);
  const q = query(r.doc, 'theme.list');
  assert.ok(q.ok);
  assert.deepEqual(q.data.presets.map((p) => p.name), Object.keys(PRESETS));
  assert.deepEqual(q.data.presets.find((p) => p.name === 'forest').tokens, PRESETS.forest.tokens);
  assert.deepEqual(q.data.fonts.map((f) => f.name), ['system', 'serif', 'rounded', 'mono']);
  assert.deepEqual(q.data.current, { preset: 'forest', font: 'rounded' });
  assert.deepEqual(query(base(), 'theme.list').data.current, { preset: 'auto', font: 'system' });
});
