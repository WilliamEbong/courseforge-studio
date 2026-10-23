// Original element builders from.
import crypto from 'node:crypto';
import { xml } from '../publisher/ooxml.js';
import { textPointScale } from '../import-story/index.js';

export const ZERO = '00000000-0000-0000-0000-000000000000';
export const DECL = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>';
export const PLAYER_BUTTON = { next: '0ec0db78-2e1d-4919-bde6-6824587f77c4', prev: 'ae475cc5-601c-414e-82c1-df8dc7d39471', submit: 'ded656e9-96d2-4bb0-825c-2290fa8c4a2b' };
export const attr = (v) => xml(v).replace(/[\t\n\r]/g, c => `&#x${c.charCodeAt(0).toString(16).toUpperCase()};`);
export function el(tag, attrs = {}, ...children) {
  const a = Object.entries(attrs).filter(([, v]) => v !== undefined).map(([k, v]) => ` ${k}="${attr(v)}"`).join('');
  const body = children.flat().join('');
  return body ? `<${tag}${a}>${body}</${tag}>` : `<${tag}${a} />`;
}
export const color = (fill) => /^#[0-9a-f]{6}$/i.test(fill ?? '') ? el('solidFill', {}, el('clr', {}, el('srgbClr', { val: fill.slice(1).toUpperCase() }))) : '';

export function elements(size, resolve, guid = crypto.randomUUID, textScale = textPointScale(size, true)) {
  const item = (id) => ({ g: id ? resolve(id) : guid(), verG: guid(), ...(/^[a-z][a-z0-9-]{0,40}$/.test(id ?? '') ? { cfId: id } : {}) });
  const tmProps = min => el('tmProps', { ...item(), cur: 0, min, visible: true, hideAll: false }, el('markers', { nextId: 0 }));
  const timing = (o, text = false) => el('tmCtxLst', { version: text ? 2 : 1 }, el(text ? 'txtTmCtx' : 'tmCtx', {
    ...item(), start: o.start ?? 0, dur: o.end == null ? 5000 : o.end - (o.start ?? 0), min: 250, max: 0,
    hasMax: false, alwysShw: false, untilEnd: o.end == null, assetStart: 0, name: '',
  }));
  const sheet = (tag, a, body = {}, duration = 5000) => el(tag, {
    ...item(), timeManagerVisibilityLocked: true, typeName: '', id: 0, state: 0, showMasterSp: false,
    name: '', role: '', resetMode: 'auto', layoutG: ZERO, stateG: ZERO, showPlay: false, clrScheme: 'def',
    isDrawingThemeUpgraded: true, assetG: ZERO, backVis: 'trans', layoutType: 'Content', hideToc: false, ...a,
  }, tmProps(duration), timing({}), el('sz', { w: size.w, h: size.h }), el('bg', {}, color(body.background) || el('noFill')),
  el('shapeLst', {}, body.objects ?? ''), el('trigLst', {}, body.triggers ?? ''), el('trans'), el('note', {}, body.notes ? xml(richText([{ runs: [{ text: body.notes }] }])) : ''), body.tail ?? '');

  function richText(paras) {
    const props = { b: 'FontIsBold', i: 'FontIsItalic', u: 'FontIsUnderline', s: 'FontIsStrikeout', size: 'FontSize', font: 'FontFamily', color: 'ForegroundColor' };
    const blocks = paras.map(p => el('Block', {},
      p.align ? el('Style', { Justification: p.align[0].toUpperCase() + p.align.slice(1) }) : '',
      p.runs.map(r => {
        const attrs = Object.fromEntries(Object.entries(props).filter(([k]) => r[k] !== undefined)
          .map(([k, name]) => [name, typeof r[k] === 'boolean' ? (r[k] ? 'True' : 'False') : k === 'size' ? r[k] / textScale : r[k]]));
        return el('Span', { Text: r.text }, el('Style', attrs));
      })));
    return el('Document', { 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', 'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema' }, el('Content', {}, blocks));
  }
  const triggers = (all, target) => all.filter(t => (t.on.target ?? null) === target).map(trigger).join('');
  const style = s => color(s?.fill) + (s?.border ? el('solidLine', {}, el('clr', {}, el('srgbClr', { val: s.border.slice(1) }))) : '')
    + (s?.borderWidth !== undefined ? el('lineStyle', { w: s.borderWidth, cap: 'flat', join: 'mtr', dash: 'sld', cmpnd: 'sng', scale: 1 }, el('arrow', { scale: 1 }, el('begin', { type: 'none', sz: 'size5' }), el('end', { type: 'none', sz: 'size5' }))) : '');
  const animation = o => ['enter', 'exit'].filter(k => o[k]).map(k => el(k === 'enter' ? 'entr' : 'exit', {}, el(o[k].effect, { dur: `PT${o[k].duration}S`, dir: o[k].direction ?? 'b', lvl: 'none' }))).join('');
  function object(o, z = 0, all = [], isSnapshot = false, native = {}) {
    const tag = native.tag ?? { text: 'textBox', shape: { rect: 'rect', rounded: 'roundRect', ellipse: 'oval', line: 'line', arrow: 'arrow' }[o.shape], button: 'btn', hotspot: 'clkAreaRect', image: 'pic' }[o.type];
    if (!tag) return ''; // verify-after-write refuses the unrepresented object.
    const text = o.text ?? '', paras = o.rich ?? (text ? text.split('\n').map(text => ({ runs: [{ text }] })) : []);
    const textAttrs = { autoFit: 'none', shdw: 'none', wrap: true, scrollOverflow: 'none', rtl: false, defHorzAlign: 'l', horzAlign: 'not', vertAlign: 'not', textDir: 'not' };
    const hasText = ['text', 'shape', 'button'].includes(o.type), st = o.style ?? {};
    const defaultButtonFill = o.type === 'button' && st.fill === undefined;
    const isLine = o.type === 'shape' && ['line', 'arrow'].includes(o.shape);
    const loc = isLine ? { l: o.x, t: o.y + o.h / 2, r: o.x + o.w, b: o.y + o.h / 2 } : { l: o.x, t: o.y, r: o.x + o.w, b: o.y + o.h };
    const appearance = isLine ? color(st.fill) + (st.border ? el('solidLine', {}, el('clr', {}, el('srgbClr', { val: st.border.slice(1) }))) : '')
      + el('lineStyle', { w: st.borderWidth ?? 2, cap: 'flat', join: 'mtr', dash: 'sld', cmpnd: 'sng', scale: 1 }, el('arrow', { scale: 1 }, el('begin', { type: 'none', sz: 'size5' }), el('end', { type: o.shape === 'arrow' ? 'triangle' : 'none', sz: 'size5' }))) : style(defaultButtonFill ? { ...st, fill: '#34449c' } : st);
    const textDefaults = hasText ? ['fontSize', 'fontFamily', 'color', 'bold', 'italic'].filter(k => st[k] === undefined).join(',') : undefined;
    const font = hasText ? el('defaultFont', { name: st.fontFamily ?? 'Segoe UI', sz: (st.fontSize ?? 24) / textScale, style: [st.bold && 'Bold', st.italic && 'Italic'].filter(Boolean).join(', ') || 'Regular' },
      el('clr', {}, el('srgbClr', { val: (st.color ?? (o.type === 'button' ? '#ffffff' : '#1c1f24')).slice(1) }))) : '';
    const states = !isSnapshot ? Object.entries(o.states ?? {}).filter(([k]) => k !== 'normal').map(([name, overrides]) => state(o, name, overrides)).join('') : '';
    return el(tag, { ...item(o.id), timeManagerVisibilityLocked: false, typeName: '', id: z + 1, name: o.name ?? '',
      state: 106759, zOrder: z, editCtx: 'Normal', initState: '', handCur: true, rot: o.rotation || -1, acc: true,
      ...textAttrs, ...(o.type === 'image' ? { assetG: resolve(o.image), imgSet: true, blend: 'srcCpy', useFileName: false, freeForm: false } : {}),
      cfTextDefaults: textDefaults,
      cfDefaultButtonFill: defaultButtonFill ? true : undefined,
      ...(o.type === 'button' ? { style: 'rectFlat', defTxtShdw: false } : {}), ...native.attrs,
    }, tmProps(5000), timing(o, o.type === 'text'), el('childLst', {}, native.childIds ?? ''), el('trigLst', {}, triggers(all, o.id)), el('stateLst', {}, native.states ?? states),
    el('bG', {}, appearance, font), st.radius !== undefined ? el('rndC', { rTL: st.radius, rTR: st.radius, rBL: st.radius, rBR: st.radius, DefAll: st.radius, usePc: false }) : '',
    el('sldSz', size), el('loc', loc), el('animEffect', {}, animation(o)),
    el('alt', {}, xml(o.alt ?? '')), el('text', {}, xml(richText(paras))), el('plain', {}, xml(text)),
    el('textMargin', { l: -1, t: -1, r: -1, b: -1 }), el('bounds', { l: 0, t: 0, r: o.w, b: o.h }),
    el('resize', { fontNm: '+minor', fontSz: 12 }), el('margins', { l: 0, t: 0, r: 0, b: 0 }), el('parLst'), el('hLinkLst'),
    o.type === 'button' ? el('pict', { val: 'Default', align: 'def' }, el('clr', {}, el('srgbClr', { val: '000000' }))) : '', native.children ?? '');
  }
  function state(o, name, overrides, native = {}) {
    const snapshotId = 'state-copy:' + o.id + ':' + name;
    const snap = { ...o, ...overrides, style: { ...o.style, ...overrides.style }, id: snapshotId, x: 0, y: 0, states: {} };
    if (overrides.text !== undefined) delete snap.rich;
    return sheet(native.stateTag ?? 'state', { name: name[0].toUpperCase() + name.slice(1), defG: resolve(snapshotId), ...(native.stateTag ? { state: 2 } : {}) }, {
      objects: object(snap, 0, [], true, native), tail: el('shapeSz', { w: o.w, h: o.h }) + el('text'),
    });
  }
  function trigger(t) {
    const a = t.do?.[0] ?? {}, on = t.on ?? {};
    const event = { click: 'OnClick', hoverEnter: 'OnMouseHover', playerNext: 'OnNextButtonClick', playerPrev: 'OnClick', timelineStart: 'OnStart', timelineEnd: 'OnEnd', varChange: 'OnVariableValueChange' }[on.event];
    const action = { jump: 'jumpToSlide', jumpScene: 'jumpToScene', showLayer: 'showSubSlide', hideLayer: 'hideSubSlide', setState: 'changeShapeState', setVar: 'adjustVar', submit: 'submitInteraction', openUrl: 'jumpToFileUrl', submitQuiz: 'SubmitQuizSL', resetQuiz: 'ResetQuizSL', reviewQuiz: 'ReviewQuizSL' }[a.action];
    const sub = a.action === 'jump' ? (['next', 'prev'].includes(a.to) ? a.to : 'spec') : a.action === 'jumpScene' ? 'spec' : a.action === 'hideLayer' && !a.layer ? 'me' : 'next';
    const intent = on.event === 'playerPrev' ? 'Previous' : on.event === 'playerNext' ? 'Next' : 'Unspecified';
    const other = { open: a.url ?? '', email: '', js: '', op: { set: 'ass', toggle: 'not', add: 'add', sub: 'minus', mul: 'mult', div: 'div' }[a.op] ?? 'ass', varVal1: typeof a.value === 'string' ? a.value : '', useVar: false, dblVal: typeof a.value === 'number' ? a.value : 0, boolVal: a.value === false ? 'False' : 'True', ...(a.var ? { varG: resolve('var:' + a.var) } : {}), ...(on.var ? { varChangeG: resolve('var:' + on.var) } : {}) };
    const conditions = (t.if?.all ?? []).map(c => el('trigCond', { ...item(), lightBox: false, op: { '==': 'eq', '>=': 'gte', '<': 'lt' }[c.op], floatVal1: c.value ?? 0, floatVal2: 0, strVal1: '', strVal2: '', boolVal: '', varG: resolve('var:' + c.var), varG2: c.otherVar ? resolve('var:' + c.otherVar) : ZERO, dataType: c.otherVar ? 'var' : 'value', andOr: 'and' }, el('shapeState', { shapeG: ZERO, op: 'eq', name: 'Normal' })));
    let result = el('trig', { ...item(t.id), name: t.name ?? '', type: 'user', edit: 'variablename, subslides, keypresskeys, actions, operators, variablevalue, variableoperators', group: t.group ?? 'none' },
      el('data', { enabled: t.enabled !== false, event, action, actSubType: sub, NavigationIntent: intent, NavigationState: 'Button, Gesture' },
        el('keyPress', { keys: 'None', case: false }), el('slide', { showNav: false, ...(a.action === 'jump' && sub === 'spec' ? { jumpG: resolve(a.to) } : {}) }),
        el('scene', a.action === 'jumpScene' ? { jumpG: resolve(a.to) } : {}),
        el('shape', { setStateName: a.state ? a.state[0].toUpperCase() + a.state.slice(1) : '', setstateop: 'ass', stateInclude: 'all', statesNot: 'are', stateName: '', ...(a.target ? { setStateG: resolve(a.target) } : {}) }, el('stateLst'), el('dropLst'), el('intersectLst'), el('stopIntersectLst'), el('hoverLst')),
        el('clickLst'), el('sldLayer', a.layer ? { [a.action === 'showLayer' ? 'showG' : 'hideG']: resolve(a.layer) } : {}), el('video'), el('audio'), el('other', other), el('interaction'),
        el('frame', { actionG: PLAYER_BUTTON[on.event === 'playerNext' ? 'next' : on.event === 'playerPrev' ? 'prev' : ''] ?? ZERO, restore: true }),
        a.quiz ? el('customData', { enumName: action, data: '', g: resolve('quiz-result:' + a.quiz), bool: false }) : ''), el('condLst', {}, conditions));
    if (t.else?.length) {
      const alt = trigger({ on, do: t.else }).replace(/^<trig\b/, '<elseTrigger').replace(/<\/trig>$/, '</elseTrigger>');
      result = result.replace('</data>', () => alt + '</data>'); // a function: "$&" in user text is not a pattern
    }
    return result;
  }
  const nav = () => ['next', 'prev'].map(to => trigger({ on: { event: to === 'next' ? 'playerNext' : 'playerPrev' }, do: [{ action: 'jump', to }] })).join('');
  function layer(l) {
    return sheet('sldLayer', { ...item(l.id), name: l.title, modal: l.modal, pause: l.pauseBase, stop: l.hideOthers, hideEnd: l.hideOnEnd, top: false, seek: 'auto', presentAs: 'Layer', resetMode: { auto: 'auto', reset: 'y', resume: 'n' }[l.revisit] }, {
      objects: l.objects.map((o, i) => object(o, i, l.triggers)).join(''), triggers: triggers(l.triggers, null),
    }, l.duration);
  }
  function slide(s, layoutG, extra = {}, draw = null) {
    return sheet(draw ? 'bankSld' : 'sld', { ...item(s.id), name: s.title, layoutG, advMode: s.advance, resetMode: { auto: 'auto', reset: 'y', resume: 'n' }[s.revisit], linkType: 'none', showInReview: true, includeInSlideCounts: true, zoomTransDur: 1000, useNextTrans: true, ...draw?.attrs }, {
      objects: s.objects.filter(o => !o.locked).map((o, i) => object(o, i, s.triggers)).join('') + (extra.objects ?? ''),
      triggers: nav() + triggers(s.triggers, null) + (extra.triggers ?? ''), background: s.background, notes: s.notes,
      tail: el('sldLayerLst', { nextIdx: s.layers.length + (s.question ? 4 : 1) }, s.layers.map(layer), extra.layers ?? '') + (extra.navigation ?? '') + (draw?.tail ?? ''),
    }, s.duration);
  }
  const variable = v => el('var', { ...item('var:' + v.name), name: v.name, type: 'user', dataType: { number: 'num', boolean: 'bool', text: 'text' }[v.type], val: v.initial, isRandom: false, propPath: '' });
  return { item, tmProps, timing, sheet, richText, object, layer, slide, trigger, variable, animation, state, style };
}
