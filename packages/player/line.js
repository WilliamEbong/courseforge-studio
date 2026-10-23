// Shared by the editor canvas and published player; inlined into the classic player script, so ES2017 only.
// A line or arrow is a stroke along the box's horizontal centre line from its left edge (start) to its right edge
// (end); the object's rotation turns the box. An arrow ends in a filled head 3 x the stroke width long and wide, never
// longer than the box. Course values are set as attributes only; the markup below is static.
export function drawLine(doc, o, style) {
  const s = style || {};
  const t = s.borderWidth !== undefined ? s.borderWidth : 2;
  const c = s.border || s.fill || s.color || 'currentColor';
  const y = o.h / 2, head = o.shape === 'arrow' ? Math.min(3 * t, o.w) : 0;
  // The HTML parser puts <svg> in the SVG namespace, so no namespace URL has to appear in the published package.
  const tpl = doc.createElement('template');
  tpl.innerHTML = '<svg aria-hidden="true" focusable="false" class="cf-line-svg"><line></line><polygon></polygon></svg>';
  const svg = tpl.content.firstChild, line = svg.firstChild, tip = svg.lastChild;
  const set = (n, attrs) => { for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k])); };
  set(svg, { width: o.w, height: o.h });
  svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none';
  set(line, { x1: 0, y1: y, x2: o.w - head, y2: y, stroke: c, 'stroke-width': t });
  if (head) set(tip, { points: `${o.w - head},${y - head / 2} ${o.w},${y} ${o.w - head},${y + head / 2}`, fill: c });
  else tip.remove();
  return svg;
}
