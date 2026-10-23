// Accessibility checks over a course document (WCAG 2.2 AA basics an author can fix in the editor or via commands).
// Each issue: {severity: 'error'|'warning', code, path, message, fix} where `fix` names the command to run.

const hex = (c) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG contrast ratio of two CSS hex colors, or null when either is not a hex color. */
export function contrast(fg, bg) {
  const a = hex(fg), b = hex(bg);
  if (!a || !b) return null;
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

export function a11yIssues(doc) {
  const out = [];
  const push = (severity, code, path, message, fix) => out.push({ severity, code, path, message, fix });
  doc.slides.forEach((s, i) => {
    const objects = [...s.objects.map((o, j) => [o, `/slides/${i}/objects/${j}`]), ...s.layers.flatMap((l, j) => l.objects.map((o, k) => [o, `/slides/${i}/layers/${j}/objects/${k}`]))];
    const bg = s.background || '#ffffff';
    const under = (o) => { // topmost earlier filled object whose box contains o's centre
      const cx = o.x + o.w / 2, cy = o.y + o.h / 2; let fill = null;
      for (const [b] of objects) { if (b === o) break; if (b.style?.fill && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) fill = b.style.fill; }
      return fill;
    };
    for (const [o, p] of objects) {
      const name = (o.alt || o.text || '').trim();
      if (o.type === 'image' && !o.alt?.trim()) push('error', 'alt-missing', p, `image ${o.id} has no alt text`, `object.set {"id":"${o.id}","alt":"<describe the image>"} (use "" only for decorative images)`);
      if ((o.type === 'button' || o.type === 'hotspot' || o.type === 'marker') && !name) push('error', 'name-missing', p, `${o.type} ${o.id} has no accessible name`, `object.set {"id":"${o.id}","alt":"<what it does>"}`);
      if (o.type === 'input' && !(o.alt || o.placeholder)) push('error', 'label-missing', p, `input ${o.id} has no label`, `object.set {"id":"${o.id}","alt":"<label>"}`);
      if ((o.type === 'slider' || o.type === 'dial') && !(o.alt || o.name)) push('warning', 'name-missing', p, `${o.type} ${o.id} is announced only as "${o.type === 'dial' ? 'Dial' : 'Slider'} range from ..."`, `object.set {"id":"${o.id}","alt":"<what it sets>"}`);
      if ((o.type === 'video' || o.type === 'audio') && !o.captions) push('warning', 'captions-missing', p, `${o.type} ${o.id} has no captions (WCAG 1.2.2)`, `asset.add {"path":"assets/<file>.vtt"} then object.set {"id":"${o.id}","captions":"<asset id>"}`);
      if (o.text && o.type !== 'image') {
        const fg = o.style?.color || '#1d1d1b';
        const back = o.style?.fill || under(o) || bg;
        const ratio = contrast(fg, back);
        const large = (o.style?.fontSize ?? 24) >= 24 || ((o.style?.fontSize ?? 24) >= 18.66 && o.style?.bold);
        if (ratio !== null && ratio < (large ? 3 : 4.5)) push('warning', 'contrast', p, `text in ${o.id} has contrast ${ratio}:1 (needs ${large ? 3 : 4.5}:1)`, `object.set {"id":"${o.id}","style":{"color":"<darker or lighter color>"}}`);
        if ((o.style?.fontSize ?? 24) < 12) push('warning', 'small-text', p, `text in ${o.id} is ${o.style.fontSize}px`, `object.set {"id":"${o.id}","style":{"fontSize":16}}`);
      }
    }
    const tabbed = objects.filter(([o]) => o.tabIndex !== undefined);
    const seen = new Map();
    for (const [o, p] of tabbed) { if (seen.has(o.tabIndex)) push('warning', 'tab-order', p, `${o.id} shares tabIndex ${o.tabIndex} with ${seen.get(o.tabIndex)}`, `object.set {"id":"${o.id}","tabIndex":<unique number>}`); else seen.set(o.tabIndex, o.id); }
    if (s.advance === 'auto' && s.duration < 3000 && objects.some(([o]) => o.text && o.text.length > 80)) push('warning', 'timing', `/slides/${i}`, `slide ${s.id} auto-advances after ${s.duration}ms with long text`, `slide.set {"id":"${s.id}","advance":"user"}`);
    if (!s.title || s.title === 'Untitled slide') push('warning', 'title', `/slides/${i}/title`, `slide ${s.id} has no meaningful title (used by the menu and screen readers)`, `slide.set {"id":"${s.id}","title":"<title>"}`);
  });
  // lessons mode: alt text (asset alt counts; "" marks a decorative image), captions, heading order, block colors
  const noAlt = (alt, img) => alt === undefined && !doc.assets.find((a) => a.id === img)?.alt?.trim();
  const altFix = (id) => `block.set {"id":"${id}","alt":"<describe the image>"} (use "" only for decorative images)`;
  if (doc.cover?.image && noAlt(doc.cover.alt, doc.cover.image)) push('error', 'alt-missing', '/cover', 'the cover image has no alt text', 'course.set {"cover":{"image":"<asset id>","alt":"<describe it>"}}');
  (doc.sections || []).forEach((s, i) => s.lessons.forEach((l, j) => {
    let level = 1; // the lesson title is the h1
    l.blocks.forEach((b, k) => {
      const p = `/sections/${i}/lessons/${j}/blocks/${k}`;
      if (['image', 'imageText', 'labeledGraphic'].includes(b.type) && noAlt(b.alt, b.image)) push('error', 'alt-missing', p, `${b.type} ${b.id} has no alt text`, altFix(b.id));
      if (b.type === 'gallery' && b.items.some((x) => noAlt(x.alt, x.image))) push('error', 'alt-missing', p, `gallery ${b.id} has images without alt text`, `block.set {"id":"${b.id}","items":[{"image":"...","alt":"..."}]}`);
      if (b.type === 'scenario' && b.scenes.some((x) => x.character && noAlt(x.characterAlt, x.character))) push('error', 'alt-missing', p, `scenario ${b.id} has a character image without alt text`, `block.set {"id":"${b.id}","scenes":[{..."characterAlt":"<who the character is>"}]}`);
      if (b.type === 'video' && !b.captions) push('warning', 'captions-missing', p, `video ${b.id} has no captions`, `asset.add {"path":"assets/<name>.vtt"} then block.set {"id":"${b.id}","captions":"<asset id>"}`);
      if (b.type === 'heading') { if (b.level > level + 1) push('warning', 'heading-order', p, `heading ${b.id} skips from level ${level} to ${b.level}`, `block.set {"id":"${b.id}","level":${level + 1}}`); level = b.level; }
      const ratio = (b.style?.color || b.style?.background) && contrast(b.style.color || '#1c1f24', b.style.background || '#ffffff');
      if (ratio && ratio < 4.5) push('warning', 'contrast', p + '/style', `text in ${b.id} has contrast ${ratio}:1 (needs 4.5:1)`, `block.set {"id":"${b.id}","style":{"color":"<darker or lighter color>"}}`);
    });
  }));
  return out;
}
