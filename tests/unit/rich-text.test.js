import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCourse, normalize, validate, serialize, parse } from '../../packages/schema/index.js';
import { apply, applyAll } from '../../packages/core/index.js';
import { createRuntime } from '../../packages/runtime/index.js';
import { replaceRichVariables } from '../../packages/schema/rich.js';
import { runtimeBundle } from '../../packages/publisher/bundle.js';
import vm from 'node:vm';

const rich = [{ runs: [{ text: 'Hello ', b: true }, { text: '%name%', i: true, u: true, s: true, color: '#123abc', size: 22, font: 'Arial', link: 'https://example.org/' }], align: 'center' }, { runs: [{ text: 'Second' }], list: 'bullet', level: 2 }];
function course() {
  const r = applyAll(emptyCourse({ id: 'rich-test' }), [
    { cmd: 'var.add', args: { name: 'name', type: 'text', initial: '<script>test</script>' } },
    { cmd: 'slide.add', args: { id: 's-1', objects: [{ id: 'o-text', type: 'text', text: 'Hello %name%\nSecond', rich }] } },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.doc;
}

test('rich schema validates supported runs, list levels and safe link protocols', () => {
  const d = course();
  assert.deepEqual(validate(d), []);
  for (const link of ['https://example.org', 'http://example.org', 'mailto:reader@example.org']) {
    const copy = structuredClone(d); copy.slides[0].objects[0].rich[0].runs[0].link = link;
    assert.deepEqual(validate(copy), []);
  }
  for (const link of ['javascript:alert(1)', 'data:text/html,x', '//example.org', 'file:///x', ' https://example.org']) {
    const copy = structuredClone(d); copy.slides[0].objects[0].rich[0].runs[0].link = link;
    assert.ok(validate(copy).some(e => e.path.endsWith('/link')), link);
  }
  for (const level of [0, 6, 1.5]) {
    const copy = structuredClone(d); copy.slides[0].objects[0].rich[1].level = level;
    assert.ok(validate(copy).some(e => e.path.endsWith('/level')));
  }
  const copy = structuredClone(d); copy.slides[0].objects[0].type = 'hotspot';
  assert.ok(validate(copy).some(e => e.path.endsWith('/rich')));
});

test('rich commands derive the plain mirror, replace text explicitly, clear rich, and undo exactly', () => {
  const d = course(), replacement = [{ runs: [{ text: 'Changed', b: true }] }, { runs: [] }];
  const r = apply(d, { cmd: 'object.set', args: { id: 'o-text', rich: replacement, text: 'ignored mirror' } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.doc.slides[0].objects[0].text, 'Changed\n');
  assert.deepEqual(apply(r.doc, r.inverse).doc, d);
  const plain = apply(r.doc, { cmd: 'object.set', args: { id: 'o-text', text: 'Plain' } });
  assert.equal(plain.ok, true);
  assert.equal(plain.doc.slides[0].objects[0].rich, undefined);
  assert.equal(plain.doc.slides[0].objects[0].text, 'Plain');
  const cleared = apply(r.doc, { cmd: 'object.set', args: { id: 'o-text', rich: null } });
  assert.equal(cleared.doc.slides[0].objects[0].text, 'Changed\n');
  assert.equal(cleared.doc.slides[0].objects[0].rich, undefined);
  assert.deepEqual(parse(serialize(d)), d);
});

test('object.add and nested slide objects normalize rich text mirrors', () => {
  const d = course();
  const added = apply(d, { cmd: 'object.add', args: { slide: 's-1', id: 'o-button', type: 'button', rich } });
  assert.equal(added.ok, true, JSON.stringify(added.errors));
  assert.equal(added.doc.slides[0].objects[1].text, 'Hello %name%\nSecond');
  const copy = structuredClone(d); delete copy.slides[0].objects[0].text;
  assert.equal(normalize(copy).slides[0].objects[0].text, 'Hello %name%\nSecond');
});

test('variable rename updates rich runs and runtime substitutes without changing the document', () => {
  const d = course();
  const renamed = apply(d, { cmd: 'var.set', args: { name: 'name', newName: 'reader' } });
  assert.equal(renamed.ok, true, JSON.stringify(renamed.errors));
  assert.equal(renamed.doc.slides[0].objects[0].rich[0].runs[1].text, '%reader%');
  const rt = createRuntime(renamed.doc); rt.start();
  const view = rt.view().objects[0];
  assert.equal(view.rich[0].runs[1].text, '<script>test</script>');
  assert.equal(view.rich[0].runs[1].i, true);
  assert.equal(view.text, 'Hello <script>test</script>\nSecond');
  assert.equal(renamed.doc.slides[0].objects[0].rich[0].runs[1].text, '%reader%');
});

test('a plain state text override replaces base rich text; style-only overrides retain it', () => {
  for (const state of [{ text: 'State plain' }, { style: { color: '#123456' } }]) {
    const r = applyAll(course(), [
      { cmd: 'state.set', args: { target: 'o-text', state: 'selected', ...state } },
      { cmd: 'object.set', args: { id: 'o-text', initialState: 'selected' } },
    ]);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const rt = createRuntime(r.doc); rt.start();
    assert.equal(!!rt.view().objects[0].rich, state.text === undefined);
  }
});


test('malformed rich input reports errors without crashing or changing the original course', () => {
  const d = course();
  for (const bad of [null, {}, [null], [{ runs: [null] }], [{ runs: [{ text: 1 }] }], [{ runs: [{ text: 'x', color: 'red' }] }], [{ runs: [{ text: 'x', size: 0 }] }], [{ runs: [{ text: 'x', onclick: 'evil' }] }]]) {
    const copy = structuredClone(d); copy.slides[0].objects[0].rich = bad;
    assert.ok(validate(copy).length, JSON.stringify(bad));
    if (bad !== null) assert.equal(apply(d, { cmd: 'object.set', args: { id: 'o-text', rich: bad } }).ok, false);
  }
  assert.deepEqual(d, course());
});


test('variables spanning styled runs substitute and rename without losing surrounding text or styles', () => {
  const d = course();
  const rich = [{ runs: [{ text: 'Before %na', b: true }, { text: 'm', i: true }, { text: 'e% after %name%.', u: true }] }];
  const set = apply(d, { cmd: 'object.set', args: { id: 'o-text', rich } });
  assert.equal(set.ok, true);
  const rt = createRuntime(set.doc); rt.start();
  const view = rt.view().objects[0];
  assert.equal(view.rich[0].runs.map(r => r.text).join(''), view.text);
  assert.deepEqual(view.rich[0].runs, [
    { text: 'Before ', b: true }, { text: '<script>test</script>', b: true },
    { text: ' after ', u: true }, { text: '<script>test</script>', u: true }, { text: '.', u: true },
  ]);
  const renamed = apply(set.doc, { cmd: 'var.set', args: { name: 'name', newName: 'reader' } });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.doc.slides[0].objects[0].text, 'Before %reader% after %reader%.');
  assert.equal(renamed.doc.slides[0].objects[0].rich[0].runs[1].b, true);
  assert.deepEqual(set.doc.slides[0].objects[0].rich, rich);
  const context = { window: {} };
  vm.runInNewContext(runtimeBundle(), context);
  const published = context.window.CFRuntime.createRuntime(set.doc); published.start();
  assert.equal(JSON.stringify(published.view().objects[0].rich), JSON.stringify(view.rich));
});


test('rich variable replacement handles empty runs and tokens at paragraph boundaries', () => {
  for (const parts of [['', '%name%', ''], ['', '%na', '', 'me%', ''], ['%name%', '%name%'], ['%other%', '', '%name%']]) {
    const rich = [{ runs: parts.map(text => ({ text, b: true })) }];
    const replaced = replaceRichVariables(rich, (token, name) => name === 'name' ? '' : token);
    assert.equal(replaced[0].runs.map(r => r.text).join(''), parts.join('').replaceAll('%name%', ''));
    assert.ok(replaced[0].runs.every(r => r.b));
  }
});
