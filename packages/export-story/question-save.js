// Patch only the question fields represented by the model; retain native controls and opaque siblings.
import { isDeepStrictEqual } from 'node:util';
import { parseXml, textOf } from '../import-story/index.js';
import { el, attr } from './elements.js';
import { nativeAttempts } from './questions.js';

const TAG = { mc: 'multiChoiceIntr', mr: 'multiRespIntr', tf: 'trueFalseIntr' };
const FEEDBACK = [['correct', 'corFbG'], ['incorrect', 'incFbG'], ['tryAgain', 'tryFbG']];
// Call only when quiz/bank/draw membership changes. The native importer follows this exclusion list.
export function reconcileQuestionMembership(p, root, s, Q, { kid, kids, setChild }) {
  if (!s.question) return false;
  const panels = kids(kid(root, 'shapeLst')).filter(n => n.tag.endsWith('Intr') && n.tag !== 'rsltsIntr');
  if (panels.length !== 1) return false;
  const props = kid(panels[0], 'intrProps');
  if (!props) return false;
  const desired = Q.exclusions(s.id), list = kid(props, 'exclQuizLst');
  const old = kids(list).map(n => n.text.trim()).sort(), fresh = parseXml('<exclQuizLst>' + desired + '</exclQuizLst>').kids.map(n => n.text.trim()).sort();
  if (!isDeepStrictEqual(old, fresh)) setChild(p, props, 'exclQuizLst', desired);
  return true;
}
export function reconcileQuestion(p, root, s0, s1, h) {
  const { kid, kids, setAttr, setChild, append, cut, objectEdits, Q, gone, at } = h;
  const old = s0.question, next = s1.question;
  if (isDeepStrictEqual(old, next)) return true;
  if (!old || !TAG[old.type] || next && !TAG[next.type]) return false;
  const list = kid(root, 'shapeLst'), shapes = kids(list), panels = shapes.filter(n => n.tag === TAG[old.type]);
  if (panels.length !== 1) return false;
  const panel = panels[0], props = kid(panel, 'intrProps');
  if (!props) return false;
  const title = shapes.find(n => n.attrs.g === props.attrs.titleBoxG)
    ?? shapes.find(n => n.tag === 'textBox' && kid(n, 'ph')?.attrs.type === 'title');
  const choices = shapes.filter(n => n.attrs.parentG === panel.attrs.g && ['radio', 'checkBox'].includes(n.tag));
  const choiceId = n => n.attrs.cfId || 'c-' + n.attrs.g.replaceAll('-', '').slice(0, 12);
  const byId = new Map(choices.map(n => [choiceId(n), n]));
  for (const c of old.choices) if (at?.(c.id)?.node) byId.set(c.id, at(c.id).node);
  if (!title || old.choices.some(c => !byId.has(c.id))) return false;
  const layers = kid(root, 'sldLayerLst');
  const feedback = FEEDBACK.map(([key, attr]) => {
    const layer = kids(layers).find(n => n.attrs.g === props.attrs[attr]);
    const texts = kids(kid(layer, 'shapeLst')).filter(n => ['textBox', 'feedbackTextBox'].includes(n.tag)
      && !(kid(n, 'ph')?.attrs.type === 'title' && textOf(n).toLowerCase() === { correct: 'correct', incorrect: 'incorrect', tryAgain: 'try again' }[key]));
    return { key, layer, texts };
  });
  const forget = n => { cut(p, n); gone?.(n, n.attrs.cfId || n.attrs.g, 'question element'); };
  if (!next || old.type !== next.type) {
    const fresh = next ? Q.slideContents(s1) : null;
    const retained = new Set(fresh ? [...(fresh.objects + fresh.layers + fresh.triggers).matchAll(/\sg="([^"]+)"/g)].map(m => m[1]) : []);
    // Only consumed question pieces are reconstructed. All ordinary slide objects remain in place.
    for (const n of [panel, title, ...choices, ...feedback.map(f => f.layer).filter(Boolean)]) {
      if (retained.has(n.attrs.g)) cut(p, n); else forget(n);
    }
    for (const t of kids(kid(root, 'trigLst'))) {
      const d = kid(t, 'data');
      if (!t.attrs.cfId && d?.attrs.action === 'submitInteraction' && kid(d, 'interaction')?.attrs.submitG === panel.attrs.g) forget(t);
    }
    if (next) {
      append(p, list, fresh.objects);
      if (kid(root, 'trigLst')) append(p, kid(root, 'trigLst'), fresh.triggers); else append(p, root, el('trigLst', {}, fresh.triggers));
      if (layers) append(p, layers, fresh.layers); else append(p, root, el('sldLayerLst', { nextIdx: 4 }, fresh.layers));
    }
    return true;
  }
  const fresh = Q.slideContents(s1), generated = parseXml('<shapeLst>' + fresh.objects + '</shapeLst>');
  const generatedChoice = c => generated.kids.find(n => ['radio', 'checkBox'].includes(n.tag) && choiceId(n) === c.id);
  const box = n => {
    const a = kid(n, 'loc')?.attrs ?? {}, [x, y, r, b] = ['l', 't', 'r', 'b'].map(k => Number(a[k]));
    return { x, y, w: r - x, h: b - y };
  };
  const edit = (n, beforeText, afterText, geometry, oldStyle) => {
    const before = { type: 'text', text: beforeText, ...box(n), ...(oldStyle ? { style: oldStyle } : {}) };
    objectEdits(p, n, before, { ...before, text: afterText, ...geometry, ...(geometry ? { style: geometry.style } : {}) });
  };
  for (const [field, attr, value] of [['points', 'corPts', next.points], ['attempts', 'attempts', nativeAttempts(next.attempts)], ['shuffle', 'shuffle', next.shuffle]]) {
    if (old[field] !== next[field]) setAttr(p, props, attr, value);
  }
  const layoutChanged = !isDeepStrictEqual(old.layout, next.layout);
  const reordered = old.choices.map(c => c.id).join('|') !== next.choices.map(c => c.id).join('|');
  // Unnamed native slides derive their title from the prompt placeholder. Pin its existing title before editing that text.
  if (old.prompt !== next.prompt && !root.attrs.name?.trim()) setAttr(p, root, 'name', s1.title);
  if (layoutChanged) setAttr(p, panel, 'cfLayout', next.layout ? 'authored' : 'auto');
  edit(title, old.prompt, next.prompt, layoutChanged ? next.layout?.prompt ?? box(generated.kids.find(n => n.tag === 'textBox')) : undefined, old.layout?.prompt.style);
  const desired = [];
  for (const c of next.choices) {
    const n = byId.get(c.id), previous = old.choices.find(v => v.id === c.id), gn = generatedChoice(c);
    if (!gn) return false;
    if (!n) {
      // New controls use the original interaction GUID, not a new generated panel identity.
      const source = '<shapeLst>' + fresh.objects + '</shapeLst>';
      let added = source.slice(gn.s, gn.e).replace(/parentG="[^"]*"/, `parentG="${panel.attrs.g}"`);
      const group = choices.find(n => n.attrs.grpId)?.attrs.grpId;
      if (group && next.type !== 'mr') added = added.replace(/grpId="[^"]*"/, () => `grpId="${attr(group)}"`);
      append(p, list, added);
      desired.push(gn.attrs.g);
    } else {
      desired.push(n.attrs.g);
      edit(n, previous.label, c.label, layoutChanged || reordered && !next.layout ? next.layout?.choices.find(v => v.id === c.id) ?? box(gn) : undefined, old.layout?.choices.find(v => v.id === c.id)?.style);
      const score = kid(n, 'scoreData');
      if (!!previous.correct !== !!c.correct) setAttr(p, n, 'initState', c.correct ? 'Selected' : 'Normal');
      if (score) setAttr(p, score, 'correct', c.correct ?? false);
      else append(p, n, el('scoreData', { correct: c.correct ?? false, pts: 0, showFeedBk: false, shuffle: true }));
    }
  }
  for (const c of old.choices) if (!next.choices.some(v => v.id === c.id)) forget(byId.get(c.id));
  // Native checked controls derive the answer key from their initial Selected state.
  setAttr(p, panel, 'cfKey', 'score');
  if (reordered) setChild(p, panel, 'childLst', desired.map(g => el('g', {}, g)).join(''));
  const feedbackSource = '<sldLayerLst>' + fresh.layers + '</sldLayerLst>', generatedLayers = parseXml(feedbackSource).kids, addedLayers = [];
  for (const f of feedback) if (next.feedback[f.key] !== old.feedback[f.key]) {
    if (f.texts.length) f.texts.forEach((n, i) => edit(n, textOf(n), i === 0 ? next.feedback[f.key] : ''));
    else {
      const generatedLayer = generatedLayers.find(n => n.attrs.name === f.key);
      if (!f.layer) {
        addedLayers.push(feedbackSource.slice(generatedLayer.s, generatedLayer.e));
        setAttr(p, props, FEEDBACK.find(([key]) => key === f.key)[1], generatedLayer.attrs.g);
      } else {
        const text = kids(kid(generatedLayer, 'shapeLst')).find(n => n.tag === 'textBox'), source = feedbackSource.slice(text.s, text.e), list = kid(f.layer, 'shapeLst');
        if (list) append(p, list, source); else append(p, f.layer, el('shapeLst', {}, source));
      }
    }
  }
  if (addedLayers.length) {
    if (layers) {
      append(p, layers, addedLayers.join(''));
      setAttr(p, layers, 'nextIdx', Math.max(Number(layers.attrs.nextIdx) || 1, kids(layers).length + addedLayers.length + 1));
    } else append(p, root, el('sldLayerLst', { nextIdx: addedLayers.length + 1 }, addedLayers));
  }
  return true;
}
