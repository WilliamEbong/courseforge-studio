import { obj, srgb, docXml } from './story-builder.js';

export const tableShape = (n = 204) => obj('table', n, { at: [20, 200, 420, 300], extra: '<table><columns><tableColumn width="200"/><tableColumn width="200"/></columns><rows>'
  + [0, 1].map(r => '<tableRow height="50"><cells>' + [0, 1].map(c => `<tableCell rowSpan="1" columnSpan="1" verticalMerge="false" horizontalMerge="false" textShadow="false" text="${docXml(r === 0 && c === 0 ? 'Cell with enough original text to clip when narrow' : `Cell ${r + 1}.${c + 1}`)}"><style textDirection="Horizontal" verticalAlign="Top"><margins l="10" t="10" r="10" b="10"/><background><fillColor><srgbClr val="ffffff"/></fillColor></background>`
    + ['top', 'bottom', 'left', 'right'].map(side => `<${side}Border dashType="${({ top: r === 0, bottom: r === 1, left: c === 0, right: c === 1 })[side] ? 'Solid' : 'Custom'}" weight="1"><themeColor><srgbClr val="0000ff"/></themeColor></${side}Border>`).join('') + '</style></tableCell>').join('') + '</cells></tableRow>').join('') + '</rows></table>' });

// Original cubic arch: exact curve height is 75, not the control-point height 100.
export const validGeometry = '<points><point x="10" y="20"/><point x="10" y="120"/><point x="110" y="120"/><point x="110" y="20"/></points><types>AAMDgw==</types><fillMode>Winding</fillMode>';
export const vectorShapes = () => obj('importedVector', 201, { at: [20, 20, 220, 170], fill: srgb('ff0000'), extra: validGeometry })
  + obj('multiply', 202, { at: [250, 20, 350, 120], fill: srgb('0000ff'), extra: '<prstGeom><multiply cy="0.3" vertexSet="true"/></prstGeom>' })
  + obj('noSymbol', 203, { at: [380, 20, 480, 120], fill: srgb('008000'), extra: '<prstGeom><noSymbol radius="0.1" vertexSet="true"/></prstGeom>' });
