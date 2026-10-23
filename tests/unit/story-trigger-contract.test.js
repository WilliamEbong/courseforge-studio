import test from 'node:test';
import assert from 'node:assert/strict';
import { elements } from '../../packages/export-story/elements.js';
import { guidFor } from '../../packages/export-story/save.js';
import { parseXml } from '../../packages/import-story/index.js';

// native TriggerData rejects "none"; use "next" for non-navigation actions.
test('native trigger target selectors obey the reader contract, including else actions', () => {
  const T = elements({ w: 720, h: 540 }, guidFor);
  const cases = [
    [{ action: 'showLayer', layer: 'details' }, 'next'],
    [{ action: 'hideLayer' }, 'me'],
    [{ action: 'hideLayer', layer: 'details' }, 'next'],
    [{ action: 'setVar', var: 'visits', op: 'add', value: 1 }, 'next'],
    [{ action: 'setState', target: 'card', state: 'hidden' }, 'next'],
    [{ action: 'submit' }, 'next'],
    [{ action: 'submitQuiz', quiz: 'check' }, 'next'],
    [{ action: 'resetQuiz', quiz: 'check' }, 'next'],
    [{ action: 'reviewQuiz', quiz: 'check' }, 'next'],
    [{ action: 'openUrl', url: 'https://example.com' }, 'next'],
    [{ action: 'jump', to: 'next' }, 'next'],
    [{ action: 'jump', to: 'prev' }, 'prev'],
    [{ action: 'jump', to: 'slide-two' }, 'spec'],
    [{ action: 'jumpScene', to: 'scene-two' }, 'spec'],
  ];
  for (const [action, expected] of cases) {
    const node = parseXml(T.trigger({ on: { event: 'click' }, do: [action], else: [action] }));
    const data = node.kids.find(k => k.tag === 'data');
    assert.equal(data.attrs.actSubType, expected, JSON.stringify(action));
    assert.equal(data.attrs.NavigationIntent, 'Unspecified');
    const alternate = data.kids.find(k => k.tag === 'elseTrigger').kids.find(k => k.tag === 'data');
    assert.equal(alternate.attrs.actSubType, expected, 'else: ' + JSON.stringify(action));
  }
  for (const [event, expected] of [['playerNext', 'Next'], ['playerPrev', 'Previous']]) {
    const node = parseXml(T.trigger({ on: { event }, do: [{ action: 'jump', to: 'next' }] }));
    assert.equal(node.kids.find(k => k.tag === 'data').attrs.NavigationIntent, expected);
  }
});

test('numeric native conditions include the required unused object-state branch', () => {
  const T = elements({ w: 720, h: 540 }, guidFor);
  for (const comparison of [{ value: 3 }, { otherVar: 'limit' }]) {
    const trigger = parseXml(T.trigger({ on: { event: 'click' }, do: [{ action: 'jump', to: 'next' }],
      if: { all: [{ var: 'visits', op: '>=', ...comparison }] } }));
    const condition = trigger.kids.find(k => k.tag === 'condLst').kids[0];
    const shape = condition.kids.find(k => k.tag === 'shapeState');
    // the native reader parses this union branch even for numeric comparisons.
    assert.equal(shape.attrs.op, 'eq');
    assert.equal(shape.attrs.name, 'Normal');
    assert.equal(shape.attrs.shapeG, '00000000-0000-0000-0000-000000000000');
    assert.equal(condition.attrs.op, 'gte');
    assert.equal(condition.attrs.dataType, comparison.otherVar ? 'var' : 'value');
  }
});

test('native arithmetic triggers use the installed operator vocabulary', () => {
  const T = elements({ w: 720, h: 540 }, guidFor);
  for (const [op, native] of [['sub', 'minus'], ['mul', 'mult'], ['add', 'add'], ['div', 'div'], ['set', 'ass'], ['toggle', 'not']]) {
    const trigger = parseXml(T.trigger({ on: { event: 'click' }, do: [{ action: 'setVar', var: 'count', op, value: 2 }] }));
    const data = trigger.kids.find(k => k.tag === 'data');
    assert.equal(data.kids.find(k => k.tag === 'other').attrs.op, native, op);
  }
});
