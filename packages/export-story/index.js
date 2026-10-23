// Original Storyline 360 .story package scaffold (specs 023/025).
// Every part is generated here from: no vendor template
// master, theme, font or default part is copied. Section numbers below refer to that note.
import crypto from 'node:crypto';
import os from 'node:os';
import { packageBytes, xml } from '../publisher/ooxml.js';
import { storyId } from '../import-story/index.js';

import { elements, el, DECL, ZERO } from './elements.js';
import { playerProperties, PLAYER_PART } from './player.js';
export { PLAYER_BUTTON } from './elements.js';
const FILE_VERSION = '3.0.4.0'; // compared by major number with the app's file version
const CORE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';

// XML readers turn literal tab/CR/LF in attribute values into spaces and CR in text into LF: write them as character
// references (Codex review 008 #1).
const ref = (c) => `&#x${c.charCodeAt(0).toString(16).toUpperCase()};`;
const rels = (list) => DECL + el('Relationships', { xmlns: 'http://schemas.openxmlformats.org/package/2006/relationships' },
  list.map(([id, type, target]) => el('Relationship', { Type: type, Target: target, Id: id })));

// Our own colour scheme and fonts: every scheme colour is read).
const COLORS = { dk1: '000000', lt1: 'FFFFFF', dk2: '1F2933', lt2: 'E4E7EB', accent1: '2563EB', accent2: '059669', accent3: 'D97706',
  accent4: 'DC2626', accent5: '7C3AED', accent6: '0891B2', hlink: '2563EB', folHlink: '7C3AED', control1: '4B5563', custom1: 'FFFFFF',
  custom2: '000000', correct: '059669', incorrect: 'DC2626' };
const FONT = 'Arial';

/**
 * Build a .story package: one scene, one slide; with `text`, one text box (one paragraph per line).
 * `guid` and `now` are injectable so tests get stable bytes. Returns a Buffer.
 */
export function writeStory({ title = 'Untitled', text, size = { w: 720, h: 540 }, guid = crypto.randomUUID, now = new Date() } = {}) {
  const { w, h } = size ?? {};
  // ponytail: 100-4000 px are our bounds (they keep the text frame valid), not limits observed in Storyline (review 008 #2)
  if (![w, h].every((v) => Number.isInteger(v) && v >= 100 && v <= 4000)) throw new RangeError(`size: w and h must be whole numbers from 100 to 4000 (got ${JSON.stringify(size)})`);
  const g = () => guid();
  const T = elements(size, g, g);
  const item = () => ({ g: g(), verG: g() }); // g and verG are both required Guids
  const tmProps = (min) => el('tmProps', { ...item(), cur: 0, min, visible: 'true', hideAll: 'false' }, el('markers', { nextId: 0 }));
  const tmCtx = (tag, version, dur, min, untilEnd) => el('tmCtxLst', { version },
    el(tag, { ...item(), start: 0, dur, min, max: 0, hasMax: 'false', alwysShw: 'false', untilEnd, assetStart: 0, name: '' }));

  // the sheet attributes and children read by SlideBase and Slide (slide, master and layout alike).
  const sheet = (tag, attrs, extraKids, { bg = el('bg'), dur = 0, min = 250 } = {}) => el(tag, {
    ...item(), timeManagerVisibilityLocked: 'true', typeName: '', id: 0, state: 0, showMasterSp: 'false', name: '', role: '',
    resetMode: 'auto', layoutG: ZERO, stateG: ZERO, showPlay: 'false', clrScheme: 'def', isDrawingThemeUpgraded: 'true',
    assetG: ZERO, backVis: 'trans', layoutType: 'Content', hideToc: 'false', ...attrs,
  }, tmProps(5000), tmCtx('tmCtx', 1, dur, min, 'false'), el('sz', { w: 0, h: 0 }), bg, extraKids.shapes ?? el('shapeLst'),
  extraKids.triggers ?? el('trigLst'), el('trans'), el('note'), extraKids.tail ?? '');

  const master = { internalG: g(), copyG: g(), copyVersionG: g() };
  const layout = { internalG: g(), copyG: g(), copyVersionG: g() };
  const masterId = 'R' + storyId(master.internalG), layoutId = 'R' + storyId(layout.internalG);

  const layoutXml = DECL + sheet('layout', { state: 2, showMasterSp: 'true', name: 'Blank', role: 'Blank', ...layout, useCnt: 0 }, {}, { dur: 3000, min: 3000 });
  const masterXml = DECL + sheet('master', { state: 2, name: 'CourseForge Studio', role: 'Content', ...master, useCnt: 0, preserve: 'false' }, {
    tail: [
      el('clrLst', { name: 'CourseForge Studio' }, Object.entries(COLORS).map(([k, v]) => el(k, {}, el('srgbClr', { val: v })))),
      el('fonts', { name: 'CourseForge Studio', major: FONT, minor: FONT }),
      el('layoutIdLst', {}, el('sldId', {}, layoutId)),
    ],
  }, { bg: el('bg', {}, el('solidFill', {}, el('clr', {}, el('schemeClr', { val: 'lt1' })))), dur: 3000, min: 3000 });
  const themeXml = DECL + el('theme', { ...item(), name: 'CourseForge Studio', displayIdx: 0, appName: 'CourseForge Studio', type: 'internal', UseNewAutofitDefaults: 'true' },
    el('assetLst', {}, el('mediaLst')), el('mstrIdLst', {}, el('sldId', {}, masterId)));

  const shapes = text === undefined ? el('shapeLst') : el('shapeLst', {}, T.object({
    type: 'text', name: 'Text Box 1', text: String(text).replace(/\r\n|\r/g, '\n'),
    x: Math.round(w * .1), y: Math.round(h * .2), w: Math.round(w * .9) - Math.round(w * .1), h: Math.round(h * .4) - Math.round(h * .2),
  }));
  const slide = item();
  const slideId = 'R' + storyId(slide.g);
  const slideXml = DECL + sheet('sld', {
    ...slide, name: 'Slide 1', layoutG: layout.internalG,
    advMode: 'user', linkType: 'none', showInReview: 'true', includeInSlideCounts: 'true', zoomTransDur: 1000, useNextTrans: 'true',
  }, {
    shapes,
    triggers: el('trigLst', {}, T.trigger({ name: 'Navigation', group: 'next', on: { event: 'playerNext' }, do: [{ action: 'jump', to: 'next' }] }), T.trigger({ name: 'Previous', on: { event: 'playerPrev' }, do: [{ action: 'jump', to: 'prev' }] })),
  });

  // story root; built-in variables are rebuilt by the loader, so varLst stays empty.
  const storyXml = DECL + el('story', { id: g(), pG: g(), defRadStyle: 'style1', defChkStyle: 'style1', renderingEngineType: 'DirectWrite',
    UseNewAutofitDefaults: 'true', UseNewFontScaling: 'true', autofitUpgraded: 'true' },
  el('varLst'), el('mediaLst', {}, el('mediaLst')),
  el('sceneLst', {}, el('scene', { ...item(), name: 'Scene 1', desc: '', primaryId: ZERO, sceneType: 'scene', collapse: 'false' },
    el('sldIdLst', {}, el('sldId', {}, slideId)))),
  el('propLst', {}, el('prop', { id: 15 }, el('sz', { w, h }))));

  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const corePart = `package/services/metadata/core-properties/${g().replace(/-/g, '')}.psmdcp`;
  const coreXml = '<?xml version="1.0" encoding="utf-8"?>' + el('coreProperties', {
    'xmlns:dc': 'http://purl.org/dc/elements/1.1/', 'xmlns:dcterms': 'http://purl.org/dc/terms/',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', xmlns: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  }, el('dcterms:created', { 'xsi:type': 'dcterms:W3CDTF' }, stamp), el('dc:creator', {}, 'CourseForge Studio'),
  el('dcterms:modified', { 'xsi:type': 'dcterms:W3CDTF' }, stamp), el('revision', {}, FILE_VERSION),
  el('dc:title', {}, xml(title).replace(/\r/g, ref)), el('version', {}, FILE_VERSION));

  const types = DECL + el('Types', { xmlns: 'http://schemas.openxmlformats.org/package/2006/content-types' },
    el('Default', { Extension: 'xml', ContentType: 'application/story+xml' }),
    el('Default', { Extension: 'psmdcp', ContentType: 'application/vnd.openxmlformats-package.core-properties+xml' }),
    el('Default', { Extension: 'rels', ContentType: 'application/vnd.openxmlformats-package.relationships+xml' }),
    [['/story/slides/slide.xml', 'slide'], ['/story/theme/theme.xml', 'theme'], ['/story/slideMasters/slideMaster.xml', 'slideMaster'],
      ['/story/slideLayouts/slideLayout.xml', 'slideLayout'], ['/docProps/app.xml', 'extended-properties'], ['/' + PLAYER_PART, 'playerProps']]
      .map(([part, type]) => el('Override', { PartName: part, ContentType: `application/${type}+xml` })));

  return packageBytes({
    '[Content_Types].xml': types,
    '_rels/.rels': rels([['rId1', 'main', '/story/story.xml'], ['rId2', 'extended-properties', '/docProps/app.xml'], ['rId3', CORE_REL, '/' + corePart]]),
    'docProps/app.xml': DECL + el('Properties', {}, el('Company'), el('Application', {}, 'CourseForge Studio'), el('AppVersion', {}, '1.0.0.0')),
    [corePart]: coreXml,
    'story/story.xml': storyXml,
    [PLAYER_PART]: playerProperties('modern', title),
    'story/_rels/story.xml.rels': rels([[slideId, 'slide', '/story/slides/slide.xml'], ['rId5', 'playerProps', '/' + PLAYER_PART], ['rId6', 'theme', '/story/theme/theme.xml']]), // theme is looked up as rId6
    'story/slides/slide.xml': slideXml,
    'story/theme/theme.xml': themeXml,
    'story/theme/_rels/theme.xml.rels': rels([[masterId, 'slideMaster', '/story/slideMasters/slideMaster.xml']]),
    'story/slideMasters/slideMaster.xml': masterXml,
    'story/slideMasters/_rels/slideMaster.xml.rels': rels([[layoutId, 'slideLayout', '/story/slideLayouts/slideLayout.xml']]),
    'story/slideLayouts/slideLayout.xml': layoutXml,
  }, os.tmpdir());
}
