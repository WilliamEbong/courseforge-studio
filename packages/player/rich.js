// Shared by the editor canvas and published player. Course strings are always text nodes.
export function renderRich(container, rich) {
  const doc = container.ownerDocument;
  const lists = [];
  container.replaceChildren();
  for (const paragraph of rich) {
    let parent = container;
    if (paragraph.list) {
      const level = paragraph.level || 1;
      lists.length = Math.min(lists.length, level);
      if (!lists[level - 1] || lists[level - 1].type !== paragraph.list) lists.length = Math.min(lists.length, level - 1);
      while (lists.length < level) {
        const list = doc.createElement(paragraph.list === 'number' ? 'ol' : 'ul');
        Object.assign(list.style, { margin: '0', paddingLeft: '1.5em' });
        const previous = lists.length ? lists[lists.length - 1].el : null;
        if (previous && !previous.lastElementChild) {
          const holder = doc.createElement('li');
          holder.style.listStyleType = 'none';
          holder.dataset.richPlaceholder = 'true';
          previous.append(holder);
        }
        (previous ? previous.lastElementChild : container).append(list);
        lists.push({ el: list, type: paragraph.list });
      }
      parent = lists[lists.length - 1].el;
    } else lists.length = 0;
    const block = doc.createElement(paragraph.list ? 'li' : 'p');
    block.style.margin = '0';
    if (paragraph.align) block.style.textAlign = paragraph.align;
    for (const run of paragraph.runs) {
      let node = doc.createTextNode(run.text);
      for (const [key, tag] of [['b', 'strong'], ['i', 'em'], ['u', 'u'], ['s', 's']]) {
        if (run[key]) {
          const wrap = doc.createElement(tag);
          wrap.append(node);
          node = wrap;
        }
      }
      const span = doc.createElement('span');
      if (run.color) span.style.color = run.color;
      if (run.size) span.style.fontSize = `${run.size}px`;
      if (run.font) span.style.fontFamily = run.font;
      if (run.b === false) span.style.fontWeight = 'normal';
      if (run.i === false) span.style.fontStyle = 'normal';
      if (run.u === false || run.s === false) span.style.textDecoration = 'none';
      if (span.style.length) { span.append(node); node = span; }
      if (run.link && /^(https?:|mailto:)/i.test(run.link)) {
        const link = doc.createElement('a');
        link.href = run.link;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.append(node);
        node = link;
      }
      block.append(node);
    }
    if (!block.textContent) block.append(doc.createElement('br'));
    parent.append(block);
  }
}

// Browser-measured shrink only. Authored font sizes remain in the course model.
export function fitText(container, frame, valign = 'middle') {
  const content = container.firstElementChild, doc = container.ownerDocument;
  if (!frame || !content || !container.isConnected || !container.getClientRects().length) return;
  const css = doc.defaultView.getComputedStyle(container);
  const key = JSON.stringify([frame, valign, css.fontSize, css.fontFamily, css.fontWeight, css.fontStyle, css.lineHeight, content.textContent]);
  if (content._cfFitKey === key) return;
  container.style.padding = '0';
  Object.assign(content.style, { position:'absolute', display:'block', left:frame.x+'px', top:frame.y+'px', width:frame.w+'px', height:'auto', margin:'0', padding:'0', whiteSpace:frame.wrap ? 'pre-wrap' : 'pre', overflowWrap:'normal', wordBreak:'normal' });
  const runs = [...content.querySelectorAll('[style]')].filter(n => n.style.fontSize);
  for (const run of runs) if (run._cfNominalSize === undefined) run._cfNominalSize = parseFloat(run.style.fontSize);
  const base = parseFloat(css.fontSize), line = parseFloat(css.lineHeight) / base;
  content.style.lineHeight = Number.isFinite(line) ? String(line) : 'normal';
  const scale = value => {
    content.style.fontSize = base * value + 'px';
    for (const run of runs) run.style.fontSize = run._cfNominalSize * value + 'px';
  };
  const fits = () => content.scrollHeight <= Math.floor(frame.h) && content.scrollWidth <= Math.floor(frame.w);
  scale(1);
  let ratio = 1;
  if (!fits()) {
    let lo = 0, hi = 1;
    for (let i=0; i<12; i++) { const mid=(lo+hi)/2; scale(mid); if (fits()) lo=mid; else hi=mid; }
    ratio=lo; scale(ratio);
  }
  const spare = Math.max(0, frame.h-content.scrollHeight);
  content.style.top = frame.y + (valign === 'top' ? 0 : valign === 'bottom' ? spare : spare/2) + 'px';
  content.dataset.textFitScale = String(ratio);
  content._cfFitKey = key;
  if (doc.fonts && doc.fonts.status === 'loading' && !content._cfFitFonts) {
    content._cfFitFonts = true;
    doc.fonts.ready.then(() => { delete content._cfFitKey; fitText(container, frame, valign); });
  }
}
