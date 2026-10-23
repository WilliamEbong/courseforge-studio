// Original SVG geometry from the contract,.
const f = n => String(Math.round(n * 1e6) / 1e6 + 0);
const pair = p => p.map(f).join(' ');
const fail = () => { throw new Error('unsupported or malformed vector geometry'); };

export function importedPath(points, bytes, mode = 'Alternate') {
  if (!points.length || points.length > 10000 || bytes.length !== points.length || !['Alternate', 'Winding'].includes(mode)
    || points.some(p => p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 1e7))) fail();
  let d = '', last, start;
  const bounds = [];
  for (let i = 0; i < points.length; i++) {
    const b = bytes[i], kind = b & 7, p = points[i];
    if (![0, 1, 3, 129, 131].includes(b)) fail();
    if (kind === 0) { d += 'M' + pair(p); start = p; bounds.push(p); }
    else if (!last) fail();
    else if (kind === 1) { d += 'L' + pair(p); bounds.push(p); }
    else {
      if (b !== 3 || bytes[i + 1] !== 3 || ![3, 131].includes(bytes[i + 2])) fail();
      const a = last, b1 = p, c = points[i + 1], end = points[i + 2];
      d += 'C' + [b1, c, end].map(pair).join(' '); bounds.push(end);
      for (let axis = 0; axis < 2; axis++) {
        const A = -a[axis] + 3 * b1[axis] - 3 * c[axis] + end[axis];
        const B = 2 * (a[axis] - 2 * b1[axis] + c[axis]), C = b1[axis] - a[axis];
        const discriminant = B * B - 4 * A * C;
        const roots = Math.abs(A) < 1e-12 ? (Math.abs(B) < 1e-12 ? [] : [-C / B])
          : discriminant < 0 ? [] : [(-B + Math.sqrt(discriminant)) / (2 * A), (-B - Math.sqrt(discriminant)) / (2 * A)];
        for (const t of roots.filter(t => t > 0 && t < 1)) bounds.push([0, 1].map(k => (1 - t) ** 3 * a[k] + 3 * (1 - t) ** 2 * t * b1[k] + 3 * (1 - t) * t * t * c[k] + t ** 3 * end[k]));
      }
      i += 2;
    }
    last = points[i];
    if (bytes[i] & 128) { d += 'Z'; last = start; }
  }
  const xs = bounds.map(p => p[0]), ys = bounds.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
  if (!(w > 0 && h > 0)) fail(); // shortcut: degenerate native paths stay reported until a line use case needs them.
  return { d, box: [x, y, w, h], rule: mode === 'Alternate' ? 'evenodd' : 'nonzero' };
}

export function symbolPath(kind, w, h, value) {
  if (![w, h, value].every(Number.isFinite) || !(w > 0 && h > 0 && value >= 0) || w > 1e7 || h > 1e7) fail();
  const cx = w / 2, cy = h / 2;
  if (kind === 'multiply') {
    const s = Math.min(w, h) / 2, t = s * Math.min(value, .75);
    const points = [[-t,-s],[t,-s],[t,-t],[s,-t],[s,t],[t,t],[t,s],[-t,s],[-t,t],[-s,t],[-s,-t],[-t,-t]];
    return { d: points.map(([x,y], i) => (i ? 'L' : 'M') + pair([cx + (x-y) * .7 / Math.SQRT2, cy + (x+y) * .7 / Math.SQRT2])).join('') + 'Z', box: [0,0,w,h], rule: 'nonzero' };
  }
  if (kind !== 'noSymbol') fail();
  const thickness = Math.min(value, .5) * Math.min(w, h), rx = cx - thickness, ry = cy - thickness;
  let d = `M0 ${f(cy)}A${f(cx)} ${f(cy)} 0 1 0 ${f(w)} ${f(cy)}A${f(cx)} ${f(cy)} 0 1 0 0 ${f(cy)}Z`;
  if (rx > 0 && ry > 0) {
    const amplitude = Math.SQRT2 * rx * ry / Math.hypot(rx, ry);
    if (thickness / 2 < amplitude) {
      const half = Math.acos(thickness / 2 / amplitude);
      for (const center of [3 * Math.PI / 4, 7 * Math.PI / 4]) {
        const point = angle => [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
        d += 'M' + pair(point(center - half)) + `A${f(rx)} ${f(ry)} 0 0 1 ` + pair(point(center + half)) + 'Z';
      }
    }
  }
  return { d, box: [0,0,w,h], rule: 'evenodd' };
}

export function pathSvg(geometry, style = {}) {
  const color = c => /^#[0-9a-f]{6}$/i.test(c ?? '') ? c : 'none';
  const width = Number.isFinite(style.borderWidth) && style.borderWidth >= 0 ? style.borderWidth : 1;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${geometry.box.map(f).join(' ')}" preserveAspectRatio="none"><path d="${geometry.d}" fill="${color(style.fill)}" fill-rule="${geometry.rule}" stroke="${color(style.border)}" stroke-width="${f(width)}" vector-effect="non-scaling-stroke"/></svg>`;
}
