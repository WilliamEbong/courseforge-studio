import { renderRich } from '../player/rich.js';

const safeLink = (value) => /^(https?:|mailto:)/i.test(value || '');
const linkValue = (value) => value.replace(/^[^:]+:/, (scheme) => scheme.toLowerCase());

// Only explicitly supported tags/styles become data; attributes and arbitrary HTML never survive.
export function serializeRich(root) {
  const paragraphs = [];
  let current;
  const start = (props = {}) => { current = { ...props, runs: [] }; paragraphs.push(current); };
  const color = (value) => {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    const match = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(value);
    return match ? `#${match.slice(1).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}` : undefined;
  };
  function visit(node, inherited = {}, list, level = 0) {
    if (node.nodeType === 3) {
      if (!node.textContent) return;
      if (!current) start();
      const run = { text: node.textContent, ...inherited };
      const previous = current.runs.at(-1);
      if (previous && JSON.stringify({ ...previous, text: '' }) === JSON.stringify({ ...run, text: '' })) previous.text += run.text;
      else current.runs.push(run);
      return;
    }
    if (node.nodeType !== 1 || ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'IMG'].includes(node.tagName)) return;
    if (['UL', 'OL'].includes(node.tagName)) {
      current = null;
      for (const child of node.childNodes) visit(child, inherited, node.tagName === 'UL' ? 'bullet' : 'number', Math.min(5, level + 1));
      current = null;
      return;
    }
    const style = { ...inherited };
    for (const [tags, key] of [[['B', 'STRONG'], 'b'], [['I', 'EM'], 'i'], [['U'], 'u'], [['S', 'STRIKE'], 's']]) if (tags.includes(node.tagName)) style[key] = true;
    if (node.style.fontWeight) style.b = node.style.fontWeight === 'bold' || Number(node.style.fontWeight) >= 600;
    if (node.style.fontStyle) style.i = node.style.fontStyle === 'italic';
    const decoration = node.style.textDecorationLine || node.style.textDecoration;
    if (decoration) { style.u = decoration.includes('underline'); style.s = decoration.includes('line-through'); }
    const foreground = color(node.style.color || node.getAttribute('color') || '');
    if (foreground) style.color = foreground;
    if (/^\d+(\.\d+)?px$/.test(node.style.fontSize) && Number.parseFloat(node.style.fontSize) >= 1) style.size = Number.parseFloat(node.style.fontSize);
    const font = node.style.fontFamily || node.getAttribute('face');
    if (font) style.font = /^(['"])([^,'"]+)\1$/.test(font) ? font.slice(1, -1) : font;
    if (node.tagName === 'A' && safeLink(node.getAttribute('href'))) style.link = linkValue(node.getAttribute('href'));
    const block = ['P', 'DIV', 'LI'].includes(node.tagName);
    const hasInline = Array.from(node.childNodes).some((child) => child.nodeType === 3 || (child.nodeType === 1 && !['P', 'DIV', 'UL', 'OL', 'LI'].includes(child.tagName)));
    if (block && !node.dataset.richPlaceholder && (hasInline || !node.childNodes.length)) {
      const props = node.tagName === 'LI' && list ? { list, level } : {};
      if (['left', 'center', 'right', 'justify'].includes(node.style.textAlign)) props.align = node.style.textAlign;
      start(props);
    }
    if (node.tagName === 'BR') {
      // A sole BR is the browser's caret placeholder in an empty paragraph.
      if (node.parentNode.childNodes.length > 1 && node.nextSibling) start(current ? Object.fromEntries(Object.entries(current).filter(([k]) => k !== 'runs')) : {});
      return;
    }
    for (const child of node.childNodes) visit(child, style, list, level);
    if (block) current = null;
  }
  for (const node of root.childNodes) visit(node);
  if (!paragraphs.length) start();
  for (const p of paragraphs) if (!p.runs.length) p.runs.push({ text: '' });
  return paragraphs;
}

export function richField({ id, label, rich, text, commit }) {
  const group = document.createElement('div');
  group.className = 'field';
  const caption = document.createElement('label');
  caption.id = `${id}-label`;
  caption.htmlFor = id;
  caption.textContent = label;
  const toolbar = document.createElement('div');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Text formatting');
  Object.assign(toolbar.style, { display: 'flex', flexWrap: 'wrap', gap: '4px' });
  const editor = document.createElement('div');
  editor.id = id;
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-labelledby', caption.id);
  editor.dataset.cmd = 'object.set';
  Object.assign(editor.style, { minHeight: '72px', padding: '8px', border: '1px solid var(--line, #94a3b8)', borderRadius: '4px', background: 'var(--surface, white)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
  renderRich(editor, rich || (text || '').split('\n').map((line) => ({ runs: [{ text: line }] })));
  let previous = JSON.stringify(serializeRich(editor));
  let saved;
  function remember() {
    const selection = window.getSelection();
    if (selection.rangeCount && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)) saved = selection.getRangeAt(0).cloneRange();
  }
  function restore() {
    editor.focus();
    if (saved) { const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(saved); }
  }
  // window.prompt() throws in Electron, so the link URL is asked for in a <dialog>. It lives inside the group so
  // focusing it does not count as leaving the field (no early commit). Resolves with the URL, or null on cancel.
  function askLink() {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      const form = document.createElement('form');
      form.method = 'dialog';
      const title = Object.assign(document.createElement('h2'), { id: `${id}-link-title`, textContent: 'Add a link' });
      dlg.setAttribute('aria-labelledby', title.id);
      const label = document.createElement('label');
      label.textContent = 'Link URL (https:, http: or mailto:)';
      const input = document.createElement('input');
      input.id = `${id}-link`;
      input.spellcheck = false;
      label.htmlFor = input.id;
      const error = Object.assign(document.createElement('p'), { id: `${id}-link-error` });
      error.setAttribute('role', 'alert');
      const actions = document.createElement('div');
      actions.className = 'dlg-actions';
      const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel', onclick: () => dlg.close('cancel') });
      const ok = Object.assign(document.createElement('button'), { textContent: 'Add link', value: 'ok', className: 'primary' }); // the only submit button, so Enter adds the link
      actions.append(cancel, ok);
      form.addEventListener('submit', (event) => {
        if (event.submitter?.value !== 'ok' || safeLink(linkValue(input.value.trim()))) return;
        event.preventDefault();
        error.textContent = 'Use an https:, http: or mailto: link.';
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', error.id);
        input.focus();
      });
      form.append(title, label, input, error, actions);
      dlg.append(form);
      dlg.addEventListener('close', () => { dlg.remove(); resolve(dlg.returnValue === 'ok' ? linkValue(input.value.trim()) : null); });
      group.append(dlg);
      dlg.showModal();
    });
  }
  async function format(command) {
    let value;
    if (command === 'createLink') {
      value = await askLink();
      if (value === null) { restore(); return; }
    }
    restore();
    // Native editing keeps caret/selection and the browser's text undo history together.
    document.execCommand(command, false, value);
    if (command === 'removeFormat') {
      document.execCommand('unlink');
      for (let level = 0; level < 5; level++) {
        const list = document.queryCommandState('insertUnorderedList') ? 'insertUnorderedList' : document.queryCommandState('insertOrderedList') ? 'insertOrderedList' : null;
        if (!list) break;
        document.execCommand(list);
      }
      document.execCommand('justifyLeft');
    }
    remember();
  }
  for (const [name, command] of [['Bold', 'bold'], ['Italic', 'italic'], ['Underline', 'underline'], ['Bullets', 'insertUnorderedList'], ['Numbering', 'insertOrderedList'], ['Link', 'createLink'], ['Clear formatting', 'removeFormat']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.dataset.cmd = 'object.set';
    button.addEventListener('mousedown', (event) => { remember(); event.preventDefault(); });
    button.addEventListener('click', () => format(command));
    toolbar.append(button);
  }
  editor.addEventListener('keyup', remember);
  editor.addEventListener('mouseup', remember);
  editor.addEventListener('input', remember);
  editor.addEventListener('keydown', (event) => {
    remember();
    const command = { b: 'bold', i: 'italic', u: 'underline' }[event.key.toLowerCase()];
    if ((event.ctrlKey || event.metaKey) && command) { event.preventDefault(); format(command); }
    event.stopPropagation();
  });
  editor.addEventListener('paste', (event) => {
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    remember();
  });
  editor.addEventListener('drop', (event) => { event.preventDefault(); });
  editor.addEventListener('click', (event) => { if (event.target.closest('a')) event.preventDefault(); });
  group.addEventListener('focusout', (event) => {
    remember();
    if (group.contains(event.relatedTarget)) return;
    const next = serializeRich(editor);
    const serialized = JSON.stringify(next);
    if (serialized !== previous) {
      previous = serialized;
      const plain = !rich && next.every((p) => Object.keys(p).length === 1 && p.runs.every((r) => Object.keys(r).length === 1));
      commit(plain ? { text: next.map((p) => p.runs.map((r) => r.text).join('')).join('\n') } : { rich: next });
    }
  });
  group.append(caption, toolbar, editor);
  return group;
}
