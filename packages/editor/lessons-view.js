// CourseForge Studio editor, lessons mode. Shown instead of the slide canvas when doc.mode === 'lessons': an outline of
// sections and lessons, a lesson page of block cards drawn with the learner player's styles (packages/player/cf-lessons.css)
// and an inspector (Block, Lesson, Course). Same parity rule as editor.js: no editing logic here. Every change is one
// registry command batch sent through ctx.dispatch; the server's document comes back and everything re-renders from it.
import { BLOCK_TYPES, QUIZ_FIELDS, allIds, newId } from '/packages/schema/index.js';

const TYPES = {
  heading: ['Heading', 'A section title, level 2 or 3'], text: ['Paragraph', 'Plain text; a blank line starts a new paragraph'],
  list: ['List', 'Bullets, numbers or a checklist'], quote: ['Quote', 'A quotation and its source'], divider: ['Divider', 'A thin rule between parts'],
  image: ['Image', 'A picture with alt text and caption'], imageText: ['Image and text', 'A picture beside a paragraph'], gallery: ['Gallery', 'Pictures in 2 to 4 columns'],
  video: ['Video', 'A local video file with captions'], audio: ['Audio', 'A local audio file with captions'],
  accordion: ['Accordion', 'Items the learner opens one by one'], tabs: ['Tabs', 'Items shown one tab at a time'], flashcards: ['Flashcards', 'Cards that flip to their back'],
  labeledGraphic: ['Labeled graphic', 'Numbered markers on an image'], process: ['Process', 'Steps the learner walks through'], timeline: ['Timeline', 'Dated events in order'],
  question: ['Knowledge check', 'A question with feedback; graded in a quiz lesson'], sorting: ['Sorting', 'Cards the learner sorts into categories'],
  button: ['Button', 'A link to a web page or another lesson'], continue: ['Continue', 'A gate: blocks below stay hidden until passed'],
  scenario: ['Scenario', 'A branching conversation with responses and feedback'],
};
const GROUPS = [['Text', ['heading', 'text', 'list', 'quote', 'divider']], ['Media', ['image', 'imageText', 'gallery', 'video', 'audio']],
  ['Interactive', ['accordion', 'tabs', 'flashcards', 'labeledGraphic', 'process', 'timeline']], ['Checks', ['question', 'sorting', 'scenario']], ['Navigation', ['button', 'continue']]];
const label = (t) => TYPES[t]?.[0] ?? t;
const KIND = { image: /\.(png|jpe?g|gif|webp|svg|avif)$/i, video: /\.(mp4|webm|ogv|mov|m4v)$/i, audio: /\.(mp3|wav|ogg|oga|m4a|aac|flac)$/i, captions: /\.vtt$/i };
const NEEDS = { image: 'image', imageText: 'image', gallery: 'image', labeledGraphic: 'image', video: 'video', audio: 'audio' };
const DEFAULTS = {
  heading: () => ({ text: 'Heading' }), text: () => ({ text: 'Write your paragraph here.' }), list: () => ({ items: ['First point', 'Second point'] }),
  quote: () => ({ text: 'Quotation' }), image: (l, a) => ({ image: a }), imageText: (l, a) => ({ image: a, text: 'Text beside the image.' }),
  gallery: (l, a) => ({ items: [{ image: a }, { image: a }] }), video: (l, a) => ({ media: a }), audio: (l, a) => ({ media: a }),
  accordion: () => ({ items: [{ title: 'Item 1', text: '' }] }), tabs: () => ({ items: [{ title: 'Tab 1', text: '' }] }), flashcards: () => ({ items: [{ front: 'Front', back: 'Back' }] }),
  labeledGraphic: (l, a) => ({ image: a, items: [{ x: 50, y: 50, title: 'Marker 1', text: '' }] }), process: () => ({ items: [{ title: 'Step 1', text: '' }] }),
  timeline: () => ({ items: [{ title: 'Event', text: '' }] }), sorting: () => ({ categories: ['Category A', 'Category B'], items: [{ text: 'Card 1', category: 0 }] }),
  question: () => ({ kind: 'mc', prompt: 'Question', choices: [{ id: 'a', label: 'Choice A', correct: true }, { id: 'b', label: 'Choice B' }] }),
};
const REQUIRE = [['none', 'None: learners continue when ready'], ['above', 'The block directly above'], ['allAbove', 'All activities above (since the last gate)']];
const THEME = [['accent', 'Accent'], ['accent-ink', 'Text on accent'], ['bg', 'Page background'], ['surface', 'Panels and cards'], ['ink', 'Text']];
const ICON = { check: 'M5 12.5l4.2 4.2L19 7', chevron: 'M6 9.5l6 6 6-6', right: 'M9.5 6l6 6-6 6', flip: 'M4 9a8 8 0 0 1 14-3.5M20 4v4.5h-4.5M20 15a8 8 0 0 1-14 3.5M4 20v-4.5h4.5' };
const DT = { block: 'text/x-cf-block', lesson: 'text/x-cf-lesson', section: 'text/x-cf-section' };
const LTABS = [['block', 'Block'], ['lesson', 'Lesson'], ['course', 'Course']];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const swap = (a, i, j) => { if (j >= 0 && j < a.length) [a[i], a[j]] = [a[j], a[i]]; return a; };

export function lessonsView(x) {
  const { exportPkg, readJsonFile, tabKey, S, $, h, ctl, colorCtl, themeGroup, group, hint, btn, cap, dispatch, ask, removeWithForce, announce, render, toast, token } = x;
  const V = { name: null, lesson: null, block: null, tab: 'block', pointer: false };
  const onTabKey = tabKey(LTABS, () => V.tab, (k) => { V.tab = k; render(); $(`#lv-tab-${k}`).focus(); }); // before the skeleton below uses it

  // ---------- skeleton (built once; the toolbar keeps the Next id the author typed across renders) ----------
  const menu = h('div', { id: 'lv-menu', class: 'lv-menu', popover: 'auto', 'aria-label': 'Insert block' });
  const insertBtn = h('button', { type: 'button', id: 'lv-insert', class: 'primary', popovertarget: 'lv-menu', 'aria-haspopup': 'true', 'data-ui': 'block.insert.menu' }, 'Insert block');
  const where = h('span', { class: 'lv-where' });
  const el = h('main', { id: 'lapp', class: 'app lapp' },
    h('nav', { id: 'lv-outline', class: 'outline', 'aria-label': 'Sections and lessons' }),
    h('section', { class: 'center lv-center', 'aria-label': 'Lesson editor' },
      h('div', { id: 'lv-toolbar', class: 'toolbar', role: 'group', 'aria-label': 'Lesson tools' },
        h('span', { class: 'tb-group' }, insertBtn),
        h('span', { class: 'tb-group' }, h('label', { for: 'lv-next-id' }, 'Next id'),
          h('input', { id: 'lv-next-id', class: 'lv-next', 'data-ui': 'next-id', placeholder: 'auto', autocomplete: 'off', spellcheck: 'false', title: 'Optional id for the next section, lesson or block you add, or for a copy (lowercase, e.g. b-intro)' })),
        where),
      h('div', { id: 'lv-viewport', class: 'lv-viewport' })),
    h('aside', { class: 'inspector', 'aria-label': 'Inspector' },
      h('div', { id: 'lv-tabs', class: 'tabs lv-tabs', role: 'tablist', 'aria-label': 'Inspector sections', onkeydown: onTabKey }),
      h('div', { id: 'lv-tabpanel', class: 'tabpanel', role: 'tabpanel' })));
  /** Attach the view only while a lessons course is open, so the slides view never has hidden twins of its controls. */
  function show(on) {
    if (on && !el.isConnected) { document.getElementById('app').after(el); document.body.append(menu); }
    if (!on && el.isConnected) { el.remove(); menu.remove(); }
  }
  menu.addEventListener('toggle', (e) => {
    insertBtn.setAttribute('aria-expanded', String(e.newState === 'open'));
    if (e.newState !== 'open') return;
    const r = (V.menuFrom ?? insertBtn).getBoundingClientRect();
    V.menuFrom = null;
    Object.assign(menu.style, { left: `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`, top: `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px` });
    menu.querySelector('button:not(:disabled)')?.focus();
  });
  window.addEventListener('pointerup', () => { V.pointer = false; });

  // ---------- lookups (read-only views of the server's document) ----------
  const lessons = () => S.doc.sections.flatMap((s) => s.lessons);
  const lessonOf = (id) => lessons().find((l) => l.id === id) ?? null;
  const sectionOf = (id) => S.doc.sections.find((s) => s.lessons.some((l) => l.id === id)) ?? null;
  const curLesson = () => lessonOf(V.lesson);
  const blockById = (id) => { for (const l of lessons()) { const b = l.blocks.find((y) => y.id === id); if (b) return b; } return null; };
  const assetsOf = (kind) => S.doc.assets.filter((a) => KIND[kind].test(a.path));
  const assetUrl = (id) => { const a = S.doc.assets.find((y) => y.id === id); return a ? `/assets/${encodeURIComponent(token)}/${encodeURIComponent(S.name)}/${a.path.split('/').map(encodeURIComponent).join('/')}` : ''; };
  const nextIdArg = (key = 'id') => { const v = $('#lv-next-id').value.trim(); return v ? { [key]: v } : {}; };
  const consumeNextId = () => { $('#lv-next-id').value = ''; };
  function sync() {
    if (V.name !== S.name) Object.assign(V, { name: S.name, lesson: null, block: null, section: null, tab: 'block' });
    if (!lessonOf(V.lesson)) { V.lesson = lessons()[0]?.id ?? null; V.block = null; }
    if (V.block && !curLesson()?.blocks.some((b) => b.id === V.block)) V.block = null;
  }

  function renderAll() {
    sync();
    renderOutline();
    renderToolbar();
    renderPage();
    renderInspector();
  }

  // ---------- selection ----------
  function selectLesson(id) { Object.assign(V, { lesson: id, block: null, tab: 'lesson', section: sectionOf(id)?.id }); render(); $('#lv-viewport').scrollTop = 0; }
  function selectBlock(id) { if (V.block === id && V.tab === 'block') return; Object.assign(V, { block: id, tab: 'block' }); render(); }
  const focusCard = (id) => document.getElementById(`lv-b-${id}`)?.focus();

  // ---------- drag and drop: dropping on an item takes its index, on a list's empty area appends ----------
  const dragStart = (kind, id) => (e) => { V.pointer = false; /* a drag ends without pointerup */ e.stopPropagation(); e.dataTransfer.setData(DT[kind], id); e.dataTransfer.effectAllowed = 'move'; };
  const dropZone = (kinds, onDrop) => ({
    ondragover: (e) => { if (kinds.some((k) => e.dataTransfer.types.includes(DT[k]))) { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add('drop'); } },
    ondragleave: (e) => e.currentTarget.classList.remove('drop'),
    ondrop: (e) => {
      if (!kinds.some((k) => e.dataTransfer.types.includes(DT[k]))) return;
      e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.remove('drop');
      for (const k of kinds) { const id = e.dataTransfer.getData(DT[k]); if (id) return onDrop(k, id); }
    },
  });

  // ---------- outline ----------
  function status(l) {
    const tracked = S.doc.tracking.complete.some((c) => c.quiz === l.id) ? ' · tracked' : '';
    if (l.kind === 'quiz') return `${plural(l.blocks.length, 'question')} · pass ${l.passPercent ?? 80}%${tracked}`;
    const gates = l.blocks.filter((b) => b.type === 'continue').length;
    return `${plural(l.blocks.length, 'block')}${gates ? ` · ${plural(gates, 'gate')}` : ''}`;
  }
  function renderOutline() {
    const box = $('#lv-outline');
    const top = box.querySelector('.outline-body')?.scrollTop ?? 0;
    const l = curLesson();
    const sec = l && sectionOf(l.id);
    const j = sec ? sec.lessons.indexOf(l) : -1;
    const secs = S.doc.sections;
    let n = 0;
    const body = h('div', { class: 'outline-body' }, secs.length ? secs.map((s, si) => {
      const name = s.title || s.id;
      return h('section', { class: 'scene lv-sec', 'aria-label': `Section ${name}`, ...dropZone(['section'], (k, id) => id !== s.id && dispatch([{ cmd: 'section.move', args: { id, index: si } }])) },
        h('div', { class: 'scene-head' },
          h('span', { class: 'lv-grip', draggable: 'true', 'aria-hidden': 'true', title: 'Drag to reorder the section', ondragstart: (e) => { dragStart('section', s.id)(e); e.dataTransfer.setDragImage(e.target.closest('section'), 12, 12); } }),
          h('input', { id: `lv-sec-${s.id}`, class: 'scene-title', value: s.title, placeholder: '(no header)', 'aria-label': `Section title (${s.id})`, 'data-cmd': 'section.set', onfocus: () => { V.section = s.id; }, onchange: (e) => dispatch([{ cmd: 'section.set', args: { id: s.id, title: e.target.value } }], e.target.id) }),
          btn('↑', 'section.move', () => dispatch([{ cmd: 'section.move', args: { id: s.id, index: si - 1 } }]), { id: `lv-sec-${s.id}-up`, class: 'ghost icon', disabled: si === 0, 'aria-label': `Move section ${name} up` }),
          btn('↓', 'section.move', () => dispatch([{ cmd: 'section.move', args: { id: s.id, index: si + 1 } }]), { id: `lv-sec-${s.id}-down`, class: 'ghost icon', disabled: si === secs.length - 1, 'aria-label': `Move section ${name} down` }),
          btn('×', 'section.remove', () => removeWithForce('section.remove', { id: s.id }, `section "${name}"`), { class: 'ghost icon', 'aria-label': `Delete section ${name}` })),
        h('ol', { class: 'slides', 'data-cmd': 'lesson.move', ...dropZone(['lesson'], (k, id) => dispatch([{ cmd: 'lesson.move', args: { id, section: s.id, index: s.lessons.length } }])) },
          s.lessons.length ? s.lessons.map((ls, li) => {
            n++;
            return h('li', { class: 'slide-li', draggable: 'true', 'data-cmd': 'lesson.move', ondragstart: dragStart('lesson', ls.id),
              ...dropZone(['lesson', 'block'], (k, id) => (k === 'lesson'
                ? id !== ls.id && dispatch([{ cmd: 'lesson.move', args: { id, section: s.id, index: li } }])
                : ls.id !== V.lesson && dispatch([{ cmd: 'block.move', args: { id, lesson: ls.id } }]).then((r) => r?.ok && announce(`Block ${id} moved to ${ls.title}`)))) },
            h('button', { type: 'button', id: `lv-l-${ls.id}`, class: 'slide-btn lv-lesson-btn', 'aria-current': ls.id === V.lesson ? 'true' : null, 'data-ui': 'lesson.select', onclick: () => selectLesson(ls.id) },
              h('span', { class: 'num' }, n), h('span', { class: 'title' }, ls.title), ls.kind === 'quiz' ? h('span', { class: 'badge' }, 'Quiz') : null,
              h('span', { class: 'lv-status' }, status(ls))));
          }) : h('li', { class: 'lv-sec-empty' }, btn('+ Add a lesson here', 'lesson.add', () => { V.section = s.id; addLesson(); }, { class: 'small', id: `lv-sec-${s.id}-add`, 'aria-label': `Add a lesson to section ${name}` }))));
    }) : hint('Start with a section: it groups lessons in the learner\'s outline.'));
    box.replaceChildren(
      h('div', { class: 'pane-head' }, h('h2', {}, 'Lessons'),
        btn('+ Lesson', 'lesson.add', addLesson, { class: 'primary small', disabled: !secs.length, 'aria-label': 'Add lesson' }),
        btn('+ Section', 'section.add', addSection, { class: 'small', 'aria-label': 'Add section' })),
      body,
      h('div', { class: 'outline-actions', role: 'group', 'aria-label': 'Selected lesson' },
        btn('Duplicate', 'lesson.duplicate', () => duplicateLesson(l), { disabled: !l, 'aria-label': 'Duplicate lesson' }),
        btn('↑', 'lesson.move', () => dispatch([{ cmd: 'lesson.move', args: { id: l.id, index: j - 1 } }]), { id: 'lv-lesson-up', disabled: !l || j <= 0, 'aria-label': 'Move lesson up' }),
        btn('↓', 'lesson.move', () => dispatch([{ cmd: 'lesson.move', args: { id: l.id, index: j + 1 } }]), { id: 'lv-lesson-down', disabled: !l || j < 0 || j >= sec.lessons.length - 1, 'aria-label': 'Move lesson down' }),
        btn('Delete', 'lesson.remove', () => removeWithForce('lesson.remove', { id: l.id }, `lesson "${l.title}"`), { disabled: !l, class: 'danger', 'aria-label': 'Delete lesson' })),
      h('div', { class: 'outline-actions', role: 'group', 'aria-label': 'Reusable lessons' },
        btn('Export', 'query', () => exportPkg('lesson', l.id), { disabled: !l, 'data-query': 'lesson.export', 'aria-label': 'Export lesson as a reusable file' }),
        btn('Insert from file', 'lesson.import', () => $('#import-lesson-file').click(), { disabled: !secs.length, title: 'Insert a reusable lesson from a file' }),
        h('input', { type: 'file', id: 'import-lesson-file', accept: '.json,application/json', hidden: true, 'data-cmd': 'lesson.import', 'aria-label': 'Reusable lesson file', onchange: importLessonFile })));
    body.scrollTop = top;
  }
  async function addSection() {
    const r = await dispatch([{ cmd: 'section.add', args: { ...nextIdArg(), title: `Section ${S.doc.sections.length + 1}` } }], 'lv-next-id');
    if (r?.ok) { consumeNextId(); V.section = r.results[0].id; announce(`Section ${r.results[0].id} added; + Lesson adds to it`); }
  }
  /** + Lesson goes to the section the author last worked in (added, renamed, or the current lesson's), after the current lesson. */
  async function addLesson() {
    const l = curLesson();
    const sec = S.doc.sections.find((s) => s.id === V.section) ?? (l && sectionOf(l.id)) ?? S.doc.sections.at(-1);
    const at = l && sec.lessons.includes(l) ? { index: sec.lessons.indexOf(l) + 1 } : {};
    const r = await dispatch([{ cmd: 'lesson.add', args: { ...nextIdArg(), section: sec.id, ...at } }], 'lv-next-id');
    if (r?.ok) { consumeNextId(); selectLesson(r.results[0].id); $('#lf-title')?.focus(); announce(`Lesson ${r.results[0].id} added`); }
  }
  async function duplicateLesson(l) {
    const r = await dispatch([{ cmd: 'lesson.duplicate', args: { id: l.id, ...nextIdArg('newId'), title: `${l.title} (copy)` } }], 'lv-next-id');
    if (r?.ok) { consumeNextId(); selectLesson(r.results[0].id); }
  }
  // ----- reusable lessons (P1.4): lesson.export query -> file; file -> lesson.import command (as reusable slides) -----
  async function importLessonFile(e) {
    const data = await readJsonFile(e, 'lesson');
    if (!data) return;
    const l = curLesson();
    const sec = (l && sectionOf(l.id)) ?? S.doc.sections.at(-1);
    const r = await dispatch([{ cmd: 'lesson.import', args: { data, section: sec.id, ...nextIdArg('newId'), ...(l && sec.lessons.includes(l) ? { index: sec.lessons.indexOf(l) + 1 } : {}) } }], 'lv-next-id');
    if (r?.ok) {
      consumeNextId();
      const res = r.results[0];
      selectLesson(res.id);
      toast(res.unlinked.length ? `Inserted; ${plural(res.unlinked.length, 'button')} pointing at lessons this course lacks were dropped (${res.unlinked.join(', ')}).` : 'Inserted the reusable lesson.');
    }
  }

  // ---------- toolbar + insert menu ----------
  function renderToolbar() {
    const l = curLesson();
    const all = lessons();
    insertBtn.disabled = !l;
    where.textContent = l ? `Lesson ${all.indexOf(l) + 1} of ${all.length}${l.kind === 'quiz' ? ' · quiz lessons hold only questions' : ''}` : '';
    const quiz = l?.kind === 'quiz';
    menu.replaceChildren(
      h('p', { class: 'lv-menu-note' }, !l ? '' : V.block ? `Inserts after the selected block (${V.block}).` : 'Inserts at the end of the lesson.'),
      ...GROUPS.map(([title, types]) => h('section', { class: 'lv-menu-group' }, h('h3', {}, title),
        h('div', { class: 'lv-menu-grid' }, types.map((t) => h('button', {
          type: 'button', class: 'lv-mi', id: `lv-mi-${t}`, disabled: quiz && t !== 'question', 'data-cmd': 'block.add', 'aria-label': `Insert ${label(t)}`,
          onclick: () => { menu.hidePopover(); insertBlock(t); },
        }, h('span', { class: 'lv-mi-name' }, label(t)), h('span', { class: 'lv-mi-desc' }, TYPES[t]?.[1] ?? '')))))));
  }
  async function insertBlock(type) {
    const l = curLesson();
    if (!l) return;
    const i = l.blocks.findIndex((b) => b.id === V.block);
    let pre = [];
    let asset;
    if (NEEDS[type]) {
      asset = assetsOf(NEEDS[type])[0]?.id;
      if (!asset) { const reg = await registerAsset(NEEDS[type]); if (!reg) return; pre = [reg.cmd]; asset = reg.id; }
    }
    const fields = type === 'button' ? buttonDefault(l) : (DEFAULTS[type] ?? (() => ({})))(l, asset);
    const r = await dispatch([...pre, { cmd: 'block.add', args: { lesson: l.id, ...nextIdArg(), type, ...(i >= 0 ? { index: i + 1 } : {}), ...fields } }], 'lv-next-id');
    if (r?.ok) { consumeNextId(); const id = r.results.at(-1).id; Object.assign(V, { block: id, tab: 'block' }); render(); focusCard(id); announce(`${label(type)} block ${id} inserted`); }
  }
  const buttonDefault = (l) => { const to = lessons().find((y) => y.id !== l.id); return to ? { label: 'Go to the next lesson', toLesson: to.id } : { label: 'Open the link', url: 'https://' }; };
  /* * Ask for a file inside the courses folder (images: or a library image); returns {id, alt, cmd: asset.add} for the caller's batch, or null. */
  async function registerAsset(kind) {
    const what = { image: 'an image', video: 'a video', audio: 'an audio file', captions: 'a WebVTT captions file' }[kind];
    const v = await ask({
      title: `Register ${what}`, cmd: 'asset.add', ok: 'Register file', library: kind === 'image',
      message: 'The file must be inside the courses folder; the path is relative to the course file.',
      fields: [{ name: 'path', label: 'File path', placeholder: { image: 'assets/photo.png', video: 'assets/clip.mp4', audio: 'assets/sound.mp3', captions: 'assets/clip.vtt' }[kind], required: true, file: { image: 'image/*', video: 'video/*', audio: 'audio/*', captions: '.vtt,text/vtt' }[kind] },
        ...(kind === 'image' ? [{ name: 'alt', label: 'Alt text (describe the image; leave empty only if it is decorative)' }] : []),
        { name: 'id', label: 'Asset id (optional)', placeholder: 'auto' }],
    });
    if (!v) return null;
    const id = v.id || newId('a', allIds(S.doc));
    return { id, alt: v.alt, cmd: { cmd: 'asset.add', args: { id, ...(v.library ? { library: v.library } : { path: v.path, ...(v.alt ? { alt: v.alt } : {}) }) } } };
  }

  // ---------- lesson page: block cards with player-styled previews ----------
  function renderPage() {
    const vp = $('#lv-viewport');
    const top = vp.scrollTop;
    const l = curLesson();
    if (!l) {
      vp.replaceChildren(h('div', { class: 'lv-blank' }, h('h2', {}, S.doc.sections.length ? 'No lessons yet' : 'An empty lessons course'),
        h('p', {}, S.doc.sections.length ? 'Add a lesson with "+ Lesson" in the outline.' : 'Add a section with "+ Section", then a lesson with "+ Lesson". Lessons hold the blocks learners scroll through.')));
      return;
    }
    const all = lessons();
    const sec = sectionOf(l.id);
    const quiz = l.kind === 'quiz';
    const facts = quiz ? ` · Quiz · ${plural(l.blocks.length, 'question')} · pass mark ${l.passPercent ?? 80}% · ${l.attempts ? plural(l.attempts, 'attempt') : 'unlimited attempts'}` : '';
    const page = h('div', { class: 'cfl lv-page', id: 'lv-page', tabindex: '-1', role: 'region', 'aria-label': `Lesson page: ${l.title}` },
      h('header', { class: 'cfl-lesson-head lv-head' },
        h('label', { class: 'cfl-sr', for: 'lv-title' }, 'Lesson title'),
        h('input', { id: 'lv-title', class: 'cfl-lesson-title lv-title', value: l.title, 'data-cmd': 'lesson.set', autocomplete: 'off', onchange: (e) => dispatch([{ cmd: 'lesson.set', args: { id: l.id, title: e.target.value } }], 'lv-title') }),
        h('p', { class: 'cfl-meta' }, `${sec.title ? `${sec.title} · ` : ''}Lesson ${all.indexOf(l) + 1} of ${all.length}${facts}`)),
      l.blocks.length
        ? h('ol', { class: 'lv-blocks', 'aria-label': `Blocks in ${l.title}`, ...dropZone(['block'], (k, id) => dispatch([{ cmd: 'block.move', args: { id, lesson: l.id, index: l.blocks.length } }])) }, l.blocks.map((b, i) => card(b, i, l)))
        : h('div', { class: 'lv-empty' }, h('p', {}, quiz ? 'This quiz has no questions yet.' : 'This lesson has no blocks yet.'),
          btn(quiz ? 'Insert the first question' : 'Insert the first block', null, (e) => { V.menuFrom = e.currentTarget; menu.showPopover(); }, { class: 'primary', 'data-ui': 'block.insert.menu' })));
    for (const [k, v] of Object.entries(S.doc.player.theme || {})) if (/^[a-z][a-z0-9-]*$/.test(k)) page.style.setProperty(`--cf-${k}`, v);
    vp.replaceChildren(page);
    vp.scrollTop = top;
  }
  function card(b, i, l) {
    const sel = b.id === V.block;
    const st = b.style || {};
    const w = st.width || (b.type === 'gallery' || b.type === 'labeledGraphic' || b.type === 'scenario' ? 'wide' : 'normal');
    const sum = summary(b);
    const pv = h('div', { class: 'lv-preview', inert: true }, preview(b, l, i));
    const about = `Block ${i + 1} of ${l.blocks.length}: ${label(b.type)} ${b.id}.${sum ? ` ${sum}.` : ''}`;
    return h('li', { class: `lv-card${sel ? ' sel' : ''}`, id: `lv-card-${b.id}`, draggable: 'true', 'data-cmd': 'block.move', ondragstart: dragStart('block', b.id),
      ...dropZone(['block'], (k, id) => id !== b.id && dispatch([{ cmd: 'block.move', args: { id, lesson: l.id, index: i } }])) },
    h('div', { class: `lv-frame w-${w}` },
      h('div', { class: 'lv-tag', 'aria-hidden': 'true' }, h('span', {}, label(b.type)), h('code', {}, b.id)),
      h('span', { id: `lv-b-${b.id}-lbl`, hidden: true }, about),
      h('div', {
        role: 'button', tabindex: '0', id: `lv-b-${b.id}`, class: 'lv-select', 'aria-pressed': String(sel), 'data-cmd': 'block.set',
        // WCAG 2.5.3: the name is the visible block content; position and type are the description (the name only when a block shows no text)
        'aria-label': pv.textContent.trim() ? null : about, 'aria-describedby': `lv-b-${b.id}-lbl`, 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown Delete',
        onpointerdown: () => { V.pointer = true; }, onfocus: () => { if (!V.pointer) selectBlock(b.id); }, onclick: () => selectBlock(b.id), onkeydown: (e) => cardKey(e, b, i, l),
      }, pv),
      sel ? h('div', { class: 'lv-tools', role: 'group', 'aria-label': `Block ${b.id}` },
        btn('↑', 'block.move', () => moveBlock(b, i - 1), { id: `lv-b-${b.id}-up`, class: 'small', disabled: i === 0, 'aria-label': 'Move block up' }),
        btn('↓', 'block.move', () => moveBlock(b, i + 1), { id: `lv-b-${b.id}-down`, class: 'small', disabled: i === l.blocks.length - 1, 'aria-label': 'Move block down' }),
        btn('Duplicate', 'block.duplicate', () => duplicateBlock(b), { id: `lv-b-${b.id}-dup`, class: 'small', 'aria-label': 'Duplicate block' }),
        btn('Delete', 'block.remove', () => deleteBlock(b, i), { id: `lv-b-${b.id}-del`, class: 'small danger', 'aria-label': 'Delete block' })) : null));
  }
  function cardKey(e, b, i, l) {
    if (e.target !== e.currentTarget) return;
    if ((e.key === 'Enter' || e.key === ' ') && !e.altKey) { e.preventDefault(); selectBlock(b.id); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); const to = i + (e.key === 'ArrowUp' ? -1 : 1); if (to >= 0 && to < l.blocks.length) moveBlock(b, to); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteBlock(b, i); }
  }
  async function moveBlock(b, index) {
    const r = await dispatch([{ cmd: 'block.move', args: { id: b.id, index } }]);
    if (r?.ok) announce(`Block ${b.id} moved to position ${index + 1}`);
  }
  async function duplicateBlock(b) {
    const r = await dispatch([{ cmd: 'block.duplicate', args: { id: b.id, ...nextIdArg('newId') } }], 'lv-next-id');
    if (r?.ok) { consumeNextId(); const id = r.results[0].id; V.block = id; render(); focusCard(id); announce(`Block ${id} added below ${b.id}`); }
  }
  async function deleteBlock(b, i) {
    const r = await removeWithForce('block.remove', { id: b.id }, `block "${b.id}"`);
    if (!r?.ok) return;
    const rest = curLesson()?.blocks ?? [];
    const next = rest[Math.min(i, rest.length - 1)];
    V.block = next?.id ?? null;
    render();
    if (next) focusCard(next.id); else $('#lv-insert').focus();
    announce(`Block ${b.id} deleted`);
  }

  // A short text summary of a block: the card's accessible name (its preview is inert).
  function summary(b) {
    const t = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    const cut = (s) => (s.length > 90 ? `${s.slice(0, 88)}…` : s);
    switch (b.type) {
      case 'heading': case 'text': case 'quote': return cut(t(b.text));
      case 'list': case 'gallery': case 'accordion': case 'tabs': case 'flashcards': case 'labeledGraphic': case 'process': case 'timeline':
        return cut(`${plural(b.items.length, 'item')}: ${b.items.map((y) => (typeof y === 'string' ? y : y.title ?? y.front ?? y.caption ?? y.alt ?? '')).filter(Boolean).join(', ')}`);
      case 'image': case 'imageText': return cut(t(b.alt || b.caption || b.text || 'no alt text'));
      case 'video': case 'audio': return cut(t(b.title || S.doc.assets.find((a) => a.id === b.media)?.path || ''));
      case 'question': return cut(`${{ mc: 'multiple choice', mr: 'multiple response', fill: 'fill in', matching: 'matching' }[b.kind]}: ${t(b.prompt)}`);
      case 'sorting': return cut(`${plural(b.items.length, 'card')} into ${b.categories.join(', ')}`);
      case 'button': return cut(`${t(b.label)} → ${b.url ?? lessonOf(b.toLesson)?.title ?? b.toLesson}`);
      case 'continue': return `${t(b.label) || 'Continue'}; requires ${REQUIRE.find(([k]) => k === (b.require || 'none'))[1].toLowerCase()}`;
      case 'scenario': return cut(`${plural(b.scenes.length, 'scene')}, ${plural(b.scenes.reduce((n, s) => n + s.items.length, 0), 'item')}: ${t(b.scenes[0].items[0].text)}`);
      default: return '';
    }
  }

  // ---------- previews: static markup with the player's classes (no form controls, so nothing inside is focusable) ----------
  const NS = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', `cfl-icon cfl-icon-${name}`);
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', ICON[name]); s.append(p);
    return s;
  }
  const P = (text, empty = '') => (String(text ?? '').trim() ? String(text).split(/\n\s*\n/).map((p) => h('p', {}, p)) : empty ? [h('p', { class: 'lv-ph' }, empty)] : []);
  const img = (id, alt) => (assetUrl(id) ? h('img', { src: assetUrl(id), alt: alt ?? '', loading: 'lazy' }) : h('div', { class: 'lv-noimg' }, `missing asset ${id}`));
  function wrap(b, kids, extra = '') {
    const st = b.style || {};
    const el = h('div', { class: `cfl-block cfl-b-${b.type}${st.padding ? ` cfl-p-${st.padding}` : ''}${st.align ? ` cfl-a-${st.align}` : ''}${st.background ? ' cfl-has-bg' : ''}${extra ? ` ${extra}` : ''}` }, kids);
    if (st.background) el.style.backgroundColor = st.background;
    if (st.color) el.style.color = st.color;
    return el;
  }
  function preview(b, l, i) {
    const quizNo = l.kind === 'quiz' ? l.blocks.slice(0, i + 1).filter((y) => y.type === 'question').length : 0;
    switch (b.type) {
      case 'heading': return wrap(b, [h(`h${b.level === 3 ? 3 : 2}`, { class: 'cfl-h' }, b.text || 'Heading')]);
      case 'text': return wrap(b, P(b.text, 'Empty paragraph'));
      case 'list': return wrap(b, b.kind === 'checkbox'
        ? [h('ul', { class: 'cfl-checklist' }, b.items.map((y) => h('li', {}, h('label', {}, h('span', { class: 'lv-box' }), h('span', {}, y)))))]
        : [h(b.kind === 'numbered' ? 'ol' : 'ul', { class: 'cfl-list' }, b.items.map((y) => h('li', {}, y)))]);
      case 'quote': return wrap(b, [h('figure', { class: 'cfl-quote' }, h('blockquote', {}, P(b.text, 'Empty quote')), b.cite ? h('figcaption', {}, b.cite) : null)]);
      case 'divider': return wrap(b, [h('hr')]);
      case 'image': return wrap(b, [h('figure', { class: 'cfl-figure' }, img(b.image, b.alt), b.caption ? h('figcaption', {}, b.caption) : null)]);
      case 'imageText': return wrap(b, [h('div', { class: `cfl-it cfl-it-${b.side || 'left'}` }, img(b.image, b.alt), h('div', { class: 'cfl-it-text' }, P(b.text)))]);
      case 'gallery': return wrap(b, [h('ul', { class: `cfl-gallery cfl-cols-${b.columns || 3}` }, b.items.map((y) => h('li', {}, h('figure', { class: 'cfl-figure' }, img(y.image, y.alt), y.caption ? h('figcaption', {}, y.caption) : null))))]);
      case 'video': case 'audio': {
        const path = S.doc.assets.find((a) => a.id === b.media)?.path ?? b.media;
        const cap = b.captions ? S.doc.assets.find((a) => a.id === b.captions)?.path ?? b.captions : null;
        return wrap(b, [b.title ? h('p', { class: 'cfl-media-title' }, b.title) : null,
          b.type === 'video' ? h('video', { src: assetUrl(b.media), preload: 'metadata', muted: true }) : h('audio', { src: assetUrl(b.media), controls: true, preload: 'none' }),
          h('p', { class: 'lv-note' }, `${path}${cap ? ` · captions ${cap}` : ' · no captions'}`)]);
      }
      case 'accordion': return wrap(b, [h('div', { class: 'cfl-acc' }, b.items.map((y, k) => h('div', { class: `cfl-acc-item${k === 0 ? ' is-open' : ''}` },
        h('div', { class: 'cfl-acc-head' }, h('span', { class: 'cfl-acc-title' }, y.title), icon('chevron')),
        k === 0 ? h('div', { class: 'cfl-acc-panel' }, P(y.text, 'No text yet')) : null)))]);
      case 'tabs': return wrap(b, [h('div', { class: 'cfl-tabs' },
        h('div', { class: 'cfl-tablist' }, b.items.map((y, k) => h('span', { class: `cfl-tab${k === 0 ? ' is-on' : ''}` }, y.title))),
        h('div', { class: 'cfl-tabpanel' }, P(b.items[0]?.text, 'No text yet')))]);
      case 'flashcards': return wrap(b, [h('ul', { class: 'cfl-cards' }, b.items.map((y) => h('li', {}, h('div', { class: 'cfl-card' }, h('span', { class: 'cfl-card-inner' },
        h('span', { class: 'cfl-card-face cfl-card-front' }, h('span', { class: 'cfl-card-text' }, y.front), h('span', { class: 'cfl-card-hint' }, icon('flip'), `Back: ${y.back}`)))))))]);
      case 'labeledGraphic': return wrap(b, [h('div', { class: 'cfl-lg' }, h('div', { class: 'cfl-lg-stage' }, img(b.image, b.alt),
        b.items.map((y, k) => { const m = h('span', { class: 'cfl-marker lv-marker' }, String(k + 1)); m.style.left = `${y.x}%`; m.style.top = `${y.y}%`; return m; })))]);
      case 'process': {
        const first = b.items[0];
        return wrap(b, [h('div', { class: 'cfl-proc' },
          h('div', { class: 'cfl-proc-body' }, b.intro ? P(b.intro) : [h('p', { class: 'cfl-meta' }, `Step 1 of ${b.items.length}`), h('p', { class: 'cfl-proc-title' }, first?.title ?? ''), ...P(first?.text)]),
          h('div', { class: 'cfl-proc-nav' }, h('span', { class: 'cfl-dots' }, b.items.map((_, k) => h('span', { class: `cfl-dot${k === 0 && !b.intro ? ' is-on' : ''}` }))),
            h('span', { class: 'cfl-btn cfl-primary' }, b.intro ? 'Start' : 'Next', icon('right'))))]);
      }
      case 'timeline': return wrap(b, [h('ol', { class: 'cfl-tl' }, b.items.map((y) => h('li', {}, y.date ? h('p', { class: 'cfl-tl-date' }, y.date) : null, h('p', { class: 'cfl-tl-title' }, y.title), h('div', {}, P(y.text)))))]);
      case 'button': return wrap(b, [h('div', { class: 'cfl-cta' }, b.text ? h('div', { class: 'cfl-cta-text' }, P(b.text)) : null,
        h('span', { class: 'cfl-btn cfl-primary' }, b.label || 'Button', icon('right')),
        h('p', { class: 'lv-note' }, b.url !== undefined ? `Opens ${b.url} in a new tab` : `Goes to lesson: ${lessonOf(b.toLesson)?.title ?? b.toLesson}`))]);
      case 'continue': return wrap(b, [h('div', { class: 'cfl-gate' }, h('span', { class: 'cfl-btn cfl-primary' }, b.label || 'Continue', icon('chevron')),
        h('p', { class: 'cfl-gate-hint' }, { none: 'Blocks below stay hidden until the learner continues.', above: 'Learners finish the block above, then continue.', allAbove: 'Learners finish every activity above (since the last gate), then continue.' }[b.require || 'none']))]);
      case 'question': return wrap(b, [questionPreview(b, quizNo ? `Question ${quizNo} of ${l.blocks.length}` : 'Knowledge check')]);
      case 'sorting': return wrap(b, [h('div', { class: 'cfl-panel cfl-sort' },
        h('p', { class: 'cfl-meta' }, `Sorting · ${plural(b.items.length, 'card')}`), h('p', { class: 'cfl-sort-card' }, b.items[0]?.text ?? ''),
        h('div', { class: 'cfl-sort-cats' }, b.categories.map((c) => h('span', { class: 'cfl-btn cfl-sort-cat' }, c))))]);
      case 'scenario': { // the first step as learners meet it
        const s = b.scenes[0];
        const it = s.items[0];
        const pic = (id, cls) => (assetUrl(id) ? h('img', { class: cls, src: assetUrl(id), alt: '' }) : h('div', { class: `lv-noimg ${cls}` }, `missing asset ${id}`));
        return wrap(b, [h('div', { class: `cfl-scn${s.character ? ' has-char' : ''}` }, s.background ? pic(s.background, 'cfl-scn-bg') : null, s.character ? pic(s.character, 'cfl-scn-char') : null,
          h('div', { class: `cfl-scn-panel${it.kind === 'dialogue' ? ' is-speech' : ''}` },
            h('p', { class: 'cfl-meta' }, `Scenario · ${plural(b.scenes.length, 'scene')} · ${plural(b.scenes.reduce((n, x) => n + x.items.length, 0), 'item')}`),
            h('div', { class: `cfl-scn-say ${it.kind === 'dialogue' ? 'is-line' : 'is-narration'}` }, P(it.text, 'No text yet')),
            it.kind === 'dialogue' ? h('div', { class: 'cfl-scn-resps' }, it.responses.map((r) => h('span', { class: 'cfl-btn cfl-scn-resp' }, r.text)))
              : h('div', { class: 'cfl-q-actions' }, h('span', { class: 'cfl-btn cfl-primary' }, 'Continue', icon('right')))))]);
      }
      default: return wrap(b, [h('p', { class: 'lv-ph' }, `${b.type} block`)]);
    }
  }
  function questionPreview(b, meta) {
    const body = b.kind === 'fill' ? [h('div', { class: 'cfl-answer lv-answer' }, `Accepted: ${(b.answers || []).join(' or ')}${b.caseSensitive ? ' (case sensitive)' : ''}`)]
      : b.kind === 'matching' ? [h('ul', { class: 'cfl-match' }, (b.pairs || []).map((p) => h('li', {}, h('span', { class: 'lv-left' }, p.left), h('span', { class: 'lv-right' }, p.right))))]
        : (b.choices || []).map((c) => h('div', { class: `cfl-choice${c.correct ? ' is-ok' : ''}` }, h('span', { class: `lv-box${b.kind === 'mc' ? ' round' : ''}` }),
          h('span', { class: 'cfl-choice-label' }, c.label), c.correct ? h('span', { class: 'cfl-choice-mark' }, icon('check')) : null));
    return h('div', { class: 'cfl-panel cfl-q' }, h('p', { class: 'cfl-meta' }, meta), h('p', { class: 'cfl-q-prompt' }, b.prompt || 'Question'), ...body);
  }

  // ---------- inspector ----------
  function renderInspector() {
    $('#lv-tabs').replaceChildren(...LTABS.map(([k, t]) => h('button', {
      type: 'button', role: 'tab', id: `lv-tab-${k}`, 'aria-selected': String(V.tab === k), 'aria-controls': 'lv-tabpanel', tabindex: V.tab === k ? '0' : '-1', 'data-ui': 'tab',
      onclick: () => { V.tab = k; render(); },
    }, t)));
    const panel = $('#lv-tabpanel');
    panel.setAttribute('aria-labelledby', `lv-tab-${V.tab}`);
    const top = V.shownTab === V.tab ? panel.scrollTop : 0;
    V.shownTab = V.tab;
    const l = curLesson();
    const b = l?.blocks.find((y) => y.id === V.block);
    const content = V.tab === 'course' ? courseForm()
      : V.tab === 'lesson' ? (l ? lessonForm(l) : hint('Add a lesson first.'))
        : b ? blockForm(b, l) : hint(l ? 'Select a block on the page (click it or Tab to it), or add one with Insert block.' : 'Add a lesson first.');
    panel.replaceChildren(...[content].flat(Infinity).filter(Boolean));
    panel.scrollTop = top;
  }

  // ----- field helpers: bound controls; each change sends one block.set -----
  const C = 'block.set';
  const setB = (b, args) => [{ cmd: C, args: { id: b.id, ...args } }];
  /** Read-modify-write commands are built when their turn in the request queue comes, from the latest document. */
  const fresh = (b, fn) => () => { const cur = blockById(b.id); return cur ? [{ cmd: C, args: { id: b.id, ...fn(structuredClone(cur)) } }] : null; };
  const opt = (v) => (v === '' ? null : v);
  const txt = (b, k, lab, o = {}) => ctl(o.area ? 'area' : 'text', `bf-${k}`, lab, b[k], { cmd: C, rows: o.rows, commit: (v) => setB(b, { [k]: o.optional ? opt(v) : v }), attrs: o.attrs });
  const sel = (b, k, lab, options, o = {}) => ctl('select', `bf-${k}`, lab, b[k] ?? '', { cmd: C, options, commit: (v) => setB(b, { [k]: o.num ? Number(v) : opt(v) }) });
  function assetCtl(b, k, kind, lab, { optional = false, setAlt = false } = {}) {
    const list = assetsOf(kind);
    const cur = b[k];
    const options = [...(optional ? [['', '(none)']] : []), ...(cur && !list.some((a) => a.id === cur) ? [[cur, cur]] : []), ...list.map((a) => [a.id, `${a.path} (${a.id})`])];
    return h('div', { class: 'lv-asset' },
      ctl('select', `bf-${k}`, lab, cur ?? '', { cmd: C, options, commit: (v) => setB(b, { [k]: opt(v) }) }),
      btn(kind === 'image' ? 'File or library…' : 'Register a file…', 'asset.add', async () => {
        const reg = await registerAsset(kind);
        if (reg) dispatch([reg.cmd, { cmd: C, args: { id: b.id, [k]: reg.id, ...(setAlt && reg.alt ? { alt: reg.alt } : {}) } }], `bf-${k}`);
      }, { class: 'small', id: `bf-${k}-reg`, 'aria-label': `${kind === 'image' ? 'Add a new file or a library image' : 'Register a new file'} for ${lab.toLowerCase()}` }));
  }
  const altWarn = (b) => (!b.alt && !S.doc.assets.find((a) => a.id === b.image)?.alt ? h('p', { class: 'warn' }, 'This image has no alt text. Describe it, unless it is purely decorative.') : null);

  /**
   * An editable list of a block's array (items, choices, pairs, answers, categories): fields per entry, reorder, remove, add.
   * fields: [{k, label, kind: text|area|num|select|check|radio, optional, options, num, write(a, i, v)}]; scalar lists use one field with no k.
   */
  function listEditor(b, { key = 'items', title, noun, fields, make, min = 1, max = Infinity, scalar = false }) {
    const list = b[key] || [];
    const N = cap(noun);
    const write = (fn) => fresh(b, (cur) => ({ [key]: fn(cur[key] || []) }));
    const fieldFor = (f, it, i) => {
      const id = `bf-${key}-${i}${f.k ? `-${f.k}` : ''}`;
      const lab = `${N} ${i + 1}${f.label ? ` ${f.label}` : ''}`;
      const value = scalar ? it : it[f.k];
      const commit = (v) => write((a) => {
        if (f.write) return f.write(a, i, v);
        if (scalar) a[i] = v;
        else if (f.optional && (v === '' || v === null)) delete a[i][f.k];
        else a[i][f.k] = f.num ? Number(v ?? 0) : f.kind === 'num' ? (v ?? 0) : v;
        return a;
      });
      if (f.kind === 'select') return ctl('select', id, lab, value ?? '', { cmd: C, options: f.options, commit });
      if (f.kind === 'check' || f.kind === 'radio') return ctl(f.kind, id, lab, value, { cmd: C, commit, attrs: f.kind === 'radio' ? { name: `bf-${key}-radio` } : {} });
      return ctl(f.kind === 'area' ? 'area' : f.kind === 'num' ? 'num' : 'text', id, lab, value, { cmd: C, commit, rows: 3, attrs: f.attrs });
    };
    return group(title,
      list.length ? h('ol', { class: 'sub-list' }, list.map((it, i) => h('li', { class: 'sub-item' },
        h('div', { class: fields.length > 1 && fields.every((f) => f.kind !== 'area') ? 'grid2' : '' }, fields.map((f) => fieldFor(f, it, i))),
        h('div', { class: 'row-actions' },
          btn('↑', C, () => dispatch(write((a) => swap(a, i, i - 1))), { id: `bf-${key}-${i}-up`, disabled: i === 0, 'aria-label': `Move ${noun} ${i + 1} up` }),
          btn('↓', C, () => dispatch(write((a) => swap(a, i, i + 1))), { id: `bf-${key}-${i}-down`, disabled: i === list.length - 1, 'aria-label': `Move ${noun} ${i + 1} down` }),
          btn('Remove', C, () => dispatch(write((a) => { a.splice(i, 1); return a; })), { id: `bf-${key}-${i}-remove`, disabled: list.length <= min, 'aria-label': `Remove ${noun} ${i + 1}` }))))) : null,
      btn(`+ ${N}`, C, () => dispatch(write((a) => [...a, make(a.length, a)]), `bf-${key}-add`), { id: `bf-${key}-add`, disabled: list.length >= max, 'aria-label': `Add ${noun}` }));
  }
  const titled = (noun, area = 'text') => [{ k: 'title', label: 'title' }, { k: 'text', label: area, kind: 'area' }];

  const FORMS = {
    heading: (b) => [group('Content', txt(b, 'text', 'Heading text'), sel(b, 'level', 'Level', [[2, 'Heading 2 (section)'], [3, 'Heading 3 (subsection)']], { num: true }))],
    text: (b) => [group('Content', txt(b, 'text', 'Text (a blank line starts a new paragraph)', { area: true, rows: 8 }))],
    list: (b) => [group('List', sel(b, 'kind', 'List style', [['bullet', 'Bullets'], ['numbered', 'Numbers'], ['checkbox', 'Checklist (learners tick every item)']])),
      listEditor(b, { title: 'Points', noun: 'point', scalar: true, fields: [{}], make: (n) => `Point ${n + 1}` })],
    quote: (b) => [group('Content', txt(b, 'text', 'Quotation', { area: true, rows: 4 }), txt(b, 'cite', 'Source (optional)', { optional: true }))],
    divider: () => [hint('A divider has no content. Use Style for its width and spacing.')],
    image: (b) => [group('Image', assetCtl(b, 'image', 'image', 'Image file', { setAlt: true }), txt(b, 'alt', 'Alt text (describe the image; empty only if decorative)', { optional: true }), altWarn(b), txt(b, 'caption', 'Caption (optional)', { optional: true }))],
    imageText: (b) => [group('Image and text', assetCtl(b, 'image', 'image', 'Image file', { setAlt: true }), txt(b, 'alt', 'Alt text (describe the image; empty only if decorative)', { optional: true }), altWarn(b),
      txt(b, 'text', 'Text', { area: true, rows: 6 }), sel(b, 'side', 'Image side', [['left', 'Image on the left'], ['right', 'Image on the right']]))],
    gallery: (b) => [group('Gallery', sel(b, 'columns', 'Columns', [[2, '2 columns'], [3, '3 columns'], [4, '4 columns']], { num: true }),
      btn('Add an image…', 'asset.add', async () => { // a new file or a library image becomes the gallery's next item
        const reg = await registerAsset('image');
        if (reg) dispatch([reg.cmd, ...fresh(b, (cur) => ({ items: [...cur.items, { image: reg.id, ...(reg.alt ? { alt: reg.alt } : {}) }] }))()], 'bf-gallery-reg');
      }, { class: 'small', id: 'bf-gallery-reg', 'aria-label': 'Add an image to the gallery from a file or the library' })),
      listEditor(b, { title: 'Images', noun: 'image', fields: [{ k: 'image', label: 'file', kind: 'select', options: assetsOf('image').map((a) => [a.id, `${a.path} (${a.id})`]) }, { k: 'alt', label: 'alt text', optional: true }, { k: 'caption', label: 'caption', optional: true }],
        make: (n, a) => ({ image: a[n - 1]?.image ?? assetsOf('image')[0]?.id }) })],
    video: (b) => mediaForm(b, 'video'), audio: (b) => mediaForm(b, 'audio'),
    accordion: (b) => itemsForm(b), tabs: (b) => itemsForm(b),
    flashcards: (b) => [listEditor(b, { title: 'Cards', noun: 'card', fields: [{ k: 'front', label: 'front', kind: 'area' }, { k: 'back', label: 'back', kind: 'area' }], make: (n) => ({ front: `Card ${n + 1}`, back: '' }) })],
    labeledGraphic: (b) => [group('Image', assetCtl(b, 'image', 'image', 'Image file', { setAlt: true }), txt(b, 'alt', 'Alt text (describe the image; empty only if decorative)', { optional: true }), altWarn(b)),
      listEditor(b, { title: 'Markers (position in % of the image)', noun: 'marker', make: (n) => ({ x: 50, y: 50, title: `Marker ${n + 1}`, text: '' }),
        fields: [{ k: 'x', label: 'left %', kind: 'num', attrs: { min: 0, max: 100 } }, { k: 'y', label: 'top %', kind: 'num', attrs: { min: 0, max: 100 } }, { k: 'title', label: 'title' }, { k: 'text', label: 'text', kind: 'area' }] })],
    process: (b) => [group('Introduction and summary', txt(b, 'intro', 'Introduction (optional; shown before step 1)', { area: true, optional: true }), txt(b, 'summary', 'Summary (optional; shown after the last step)', { area: true, optional: true })),
      listEditor(b, { title: 'Steps', noun: 'step', fields: titled('step'), make: (n) => ({ title: `Step ${n + 1}`, text: '' }) })],
    timeline: (b) => [listEditor(b, { title: 'Events', noun: 'event', fields: [{ k: 'date', label: 'date (optional)', optional: true }, { k: 'title', label: 'title' }, { k: 'text', label: 'text', kind: 'area' }], make: () => ({ title: 'Event', text: '' }) })],
    question: (b, l) => questionForm(b, l),
    sorting: (b) => [listEditor(b, { key: 'categories', title: 'Categories (1 to 4)', noun: 'category', scalar: true, fields: [{}], max: 4, make: (n) => `Category ${n + 1}` }),
      listEditor(b, { title: 'Cards', noun: 'card', make: () => ({ text: 'Card', category: 0 }),
        fields: [{ k: 'text', label: 'text', attrs: { maxlength: 80 } }, { k: 'category', label: 'category', kind: 'select', num: true, options: b.categories.map((c, i) => [i, c]) }] })],
    button: (b) => {
      const others = lessons().filter((y) => y.id !== V.lesson);
      const toUrl = b.url !== undefined;
      return [group('Button', txt(b, 'label', 'Button label'), txt(b, 'text', 'Text above the button (optional)', { area: true, optional: true }),
        ctl('select', 'bf-target', 'Goes to', toUrl ? 'url' : 'lesson', { cmd: C, options: [['url', 'A web address (opens a new tab)'], ['lesson', 'A lesson in this course']],
          commit: (v) => (v === 'url' ? setB(b, { url: 'https://', toLesson: null }) : setB(b, { toLesson: others[0]?.id ?? V.lesson, url: null })) }),
        toUrl ? txt(b, 'url', 'Web address (https:// or mailto:)', { attrs: { spellcheck: 'false' } })
          : ctl('select', 'bf-toLesson', 'Lesson', b.toLesson, { cmd: C, options: lessons().map((y) => [y.id, `${y.title} (${y.id})`]), commit: (v) => setB(b, { toLesson: v }) }))];
    },
    scenario: (b) => scenarioForm(b),
    continue: (b) => [group('Gate', txt(b, 'label', 'Button label (optional; default Continue)', { optional: true, attrs: { placeholder: 'Continue' } }),
      sel(b, 'require', 'Learners must complete', REQUIRE),
      hint('Blocks below a gate stay hidden until the learner passes it. Completable blocks: accordion, tabs, flashcards, labeled graphic, process, video, audio, checklist, knowledge check, sorting, scenario.'))],
  };
  function itemsForm(b) {
    return [group('Show as', ctl('select', 'bf-type', 'Block type', b.type, { cmd: C, options: [['accordion', 'Accordion'], ['tabs', 'Tabs']], commit: (v) => setB(b, { type: v }) })),
      listEditor(b, { title: b.type === 'tabs' ? 'Tabs' : 'Items', noun: 'item', fields: titled('item'), make: (n) => ({ title: `${b.type === 'tabs' ? 'Tab' : 'Item'} ${n + 1}`, text: '' }) })];
  }
  function mediaForm(b, kind) {
    return [group(kind === 'video' ? 'Video' : 'Audio', assetCtl(b, 'media', kind, kind === 'video' ? 'Video file' : 'Audio file'),
      assetCtl(b, 'captions', 'captions', 'Captions (WebVTT .vtt)', { optional: true }),
      !b.captions ? h('p', { class: 'warn' }, 'No captions. Learners who cannot hear the audio need a .vtt captions file.') : null,
      txt(b, 'title', 'Title (optional; also its accessible name)', { optional: true }))];
  }
  const firstFree = (a) => [...'abcdefghijklmnopqrstuvwxyz'].find((c) => !a.some((y) => y.id === c)) ?? `c${a.length}`;
  function questionForm(b, l) {
    const inQuiz = l.kind === 'quiz';
    const choiceLike = b.kind === 'mc' || b.kind === 'mr';
    const switchKind = (v) => fresh(b, (cur) => {
      const two = [{ id: 'a', label: 'Choice A', correct: true }, { id: 'b', label: 'Choice B' }];
      const choices = (cur.choices?.length >= 2 ? cur.choices : two).map(({ correct, feedback, ...c }) => ({ ...c, ...(correct ? { correct } : {}), ...(feedback && v === 'mc' ? { feedback } : {}) }));
      if (v === 'mc' || v === 'mr') {
        const firstOk = choices.findIndex((c) => c.correct);
        choices.forEach((c, i) => { if (v === 'mc' && c.correct && i !== firstOk) delete c.correct; });
        if (firstOk < 0) choices[0].correct = true;
        return { kind: v, choices, answers: null, caseSensitive: null, pairs: null };
      }
      if (v === 'fill') return { kind: v, answers: cur.answers?.length ? cur.answers : ['Answer'], choices: null, pairs: null };
      return { kind: v, pairs: cur.pairs?.length >= 2 ? cur.pairs : [{ left: 'Term 1', right: 'Match 1' }, { left: 'Term 2', right: 'Match 2' }], choices: null, answers: null, caseSensitive: null };
    });
    const fb = b.feedback || {};
    const setFb = (k) => (v) => fresh(b, (cur) => { const f = { ...(cur.feedback || {}), [k]: v }; for (const x of Object.keys(f)) if (!f[x]) delete f[x]; return { feedback: Object.keys(f).length ? f : null }; });
    const correctField = b.kind === 'mc'
      ? { k: 'correct', label: 'is the answer', kind: 'radio', write: (a, i) => a.map((c, j) => { const { correct, ...rest } = c; return j === i ? { ...rest, correct: true } : rest; }) }
      : { k: 'correct', label: 'is correct', kind: 'check', write: (a, i, v) => { if (v) a[i].correct = true; else delete a[i].correct; return a; } };
    return [
      group(inQuiz ? 'Quiz question' : 'Knowledge check',
        ctl('select', 'bf-kind', 'Question type', b.kind, { cmd: C, options: [['mc', 'Multiple choice (one answer)'], ['mr', 'Multiple response'], ['fill', 'Fill in the blank'], ['matching', 'Matching']], commit: switchKind }),
        txt(b, 'prompt', 'Prompt', { area: true, rows: 3 })),
      choiceLike && listEditor(b, { key: 'choices', title: 'Choices', noun: 'choice', min: 2, make: (n, a) => ({ id: firstFree(a), label: `Choice ${String.fromCharCode(65 + n)}` }),
        fields: [{ k: 'id', label: 'id', attrs: { spellcheck: 'false' } }, { k: 'label', label: 'label' }, correctField, ...(b.kind === 'mc' ? [{ k: 'feedback', label: 'feedback (optional)', optional: true }] : [])] }),
      b.kind === 'fill' && listEditor(b, { key: 'answers', title: 'Accepted answers', noun: 'answer', scalar: true, fields: [{}], make: () => 'Answer' }),
      b.kind === 'fill' && group('Matching rule', ctl('check', 'bf-caseSensitive', 'Case sensitive', b.caseSensitive, { cmd: C, commit: (v) => setB(b, { caseSensitive: v || null }) })),
      b.kind === 'matching' && listEditor(b, { key: 'pairs', title: 'Pairs (2 to 10; learners match each left item)', noun: 'pair', min: 2, max: 10, make: (n) => ({ left: `Term ${n + 1}`, right: `Match ${n + 1}` }),
        fields: [{ k: 'left', label: 'left' }, { k: 'right', label: 'right' }] }),
      group('Feedback', b.kind === 'mc' ? hint('Per-choice feedback (above) is shown for the chosen answer; these cover the rest.') : null,
        ctl('text', 'bf-fb-correct', 'When correct', fb.correct, { cmd: C, commit: setFb('correct') }),
        ctl('text', 'bf-fb-incorrect', 'When incorrect', fb.incorrect, { cmd: C, commit: setFb('incorrect') }),
        ctl('text', 'bf-fb-any', 'After any answer', fb.any, { cmd: C, commit: setFb('any') })),
      inQuiz ? hint('Attempts, reveal and shuffling for a quiz are lesson settings (Lesson tab).') : group('Options',
        ctl('num', 'bf-attempts', 'Attempts (empty or 0 = unlimited)', b.attempts, { cmd: C, attrs: { min: 0, step: 1 }, commit: (v) => setB(b, { attempts: v }) }),
        h('div', { class: 'checks' },
          ctl('check', 'bf-hideCorrect', 'Hide the correct answer', b.hideCorrect, { cmd: C, commit: (v) => setB(b, { hideCorrect: v || null }) }),
          ctl('check', 'bf-shuffle', 'Shuffle choices', b.shuffle, { cmd: C, commit: (v) => setB(b, { shuffle: v || null }) }))),
    ];
  }
  // scenes > items > responses. Every edit is one block.set {scenes} built from the latest document; new ids are
  // the first free s<n> / i<n> (scene and item ids share the block's namespace) and a/b/c for responses.
  function scenarioForm(b) {
    const edit = (fn) => fresh(b, (cur) => { fn(cur.scenes); return { scenes: cur.scenes }; });
    const free = (prefix, sc) => { const used = new Set(sc.flatMap((s) => [s.id, ...s.items.map((it) => it.id)])); let n = 1; while (used.has(`${prefix}${n}`)) n++; return `${prefix}${n}`; };
    const response = (id) => ({ id, text: 'Response', goTo: 'next' });
    const item = (sc) => ({ id: free('i', sc), kind: 'dialogue', text: 'What the character says.', responses: [response('a')] });
    const short = (s) => { const x = String(s ?? '').replace(/\s+/g, ' ').trim(); return x.length > 40 ? `${x.slice(0, 38)}…` : x; };
    const targets = [['next', 'Next (next item, then next scene, then the end)'], ['retry', 'Retry this scene'], ['end', 'End the scenario'],
      ...b.scenes.map((s, i) => [s.id, `Scene ${i + 1}: ${s.title || s.id}`]),
      ...b.scenes.flatMap((s, i) => s.items.map((it, j) => [it.id, `Scene ${i + 1}, item ${j + 1}: ${short(it.text)}`]))];
    const goSel = (id, lab, value, write) => ctl('select', id, lab, value ?? 'next', { cmd: C, options: targets, commit: (v) => edit((sc) => write(sc, v)) });
    const field = (id, lab, value, write, o = {}) => ctl(o.area ? 'area' : 'text', id, lab, value, { cmd: C, rows: 3, commit: (v) => edit((sc) => write(sc, v)) });
    const opt = (o, k, v) => { if (v) o[k] = v; else delete o[k]; };
    const arrows = (idp, noun, word, list, i, at, ...lead) => h('div', { class: 'row-actions' }, ...lead,
      btn('↑', C, () => dispatch(edit((sc) => swap(at(sc), i, i - 1))), { id: `${idp}-up`, disabled: i === 0, 'aria-label': `Move ${noun} up` }),
      btn('↓', C, () => dispatch(edit((sc) => swap(at(sc), i, i + 1))), { id: `${idp}-down`, disabled: i === list.length - 1, 'aria-label': `Move ${noun} down` }),
      btn(`Remove ${word}`, C, () => dispatch(edit((sc) => at(sc).splice(i, 1))), { id: `${idp}-remove`, disabled: list.length <= 1, 'aria-label': `Remove ${noun}` }));
    const imgs = assetsOf('image');
    function picture(s, i, key, lab) {
      const id = `bf-sc${i}-${key}`;
      const options = [['', '(none)'], ...(s[key] && !imgs.some((a) => a.id === s[key]) ? [[s[key], s[key]]] : []), ...imgs.map((a) => [a.id, `${a.path} (${a.id})`])];
      return h('div', { class: 'lv-asset' },
        ctl('select', id, lab, s[key] ?? '', { cmd: C, options, commit: (v) => edit((sc) => { opt(sc[i], key, v); if (!v) delete sc[i][`${key}Alt`]; }) }),
        btn('Register a file…', 'asset.add', async () => {
          const reg = await registerAsset('image');
          if (reg) dispatch(() => { const cur = blockById(b.id); if (!cur) return null; const scenes = structuredClone(cur.scenes); scenes[i][key] = reg.id; return [reg.cmd, { cmd: C, args: { id: b.id, scenes } }]; }, id);
        }, { class: 'small', id: `${id}-reg`, 'aria-label': `Register a new file for ${lab.toLowerCase()}` }));
    }
    const itemEl = (s, i, it, j) => {
      const p = `bf-sc${i}-${j}`;
      const name = `Scene ${i + 1} item ${j + 1}`;
      const at = (sc) => sc[i].items[j];
      const kind = (sc, v) => { const x = at(sc); if (x.kind === v) return; x.kind = v; if (v === 'text') delete x.responses; else { delete x.goTo; x.responses = [response('a')]; } };
      const rs = it.responses || [];
      return h('li', { class: 'sub-item lv-scn-item' },
        h('div', { class: 'grid2' },
          ctl('select', `${p}-kind`, `${name} kind`, it.kind, { cmd: C, options: [['dialogue', 'Dialogue'], ['text', 'Text (narration)']], commit: (v) => edit((sc) => kind(sc, v)) }),
          it.kind === 'text' ? goSel(`${p}-go`, `${name} goes to`, it.goTo, (sc, v) => { at(sc).goTo = v; }) : null),
        field(`${p}-text`, `${name} ${it.kind === 'dialogue' ? 'line (what the character says)' : 'text'}`, it.text, (sc, v) => { at(sc).text = v; }, { area: true }),
        it.kind === 'dialogue' ? h('ol', { class: 'sub-list' }, rs.map((r, k) => {
          const rp = `${p}-r${k}`;
          const rn = `${name} response ${k + 1}`;
          const rat = (sc) => at(sc).responses[k];
          return h('li', { class: 'sub-item' },
            field(`${rp}-text`, `${rn} text`, r.text, (sc, v) => { rat(sc).text = v; }),
            field(`${rp}-fb`, `${rn} feedback (optional)`, r.feedback, (sc, v) => opt(rat(sc), 'feedback', v)),
            goSel(`${rp}-go`, `${rn} goes to`, r.goTo, (sc, v) => { rat(sc).goTo = v; }),
            arrows(rp, `response ${k + 1} of ${name.toLowerCase()}`, 'response', rs, k, (sc) => at(sc).responses));
        })) : null,
        arrows(p, name.toLowerCase(), 'item', s.items, j, (sc) => sc[i].items,
          it.kind === 'dialogue' ? btn('+ Response', C, () => dispatch(edit((sc) => at(sc).responses.push(response(firstFree(at(sc).responses))))), { id: `${p}-add`, disabled: rs.length >= 3, 'aria-label': `Add a response to ${name.toLowerCase()} (up to 3)` }) : null));
    };
    return [
      ...b.scenes.map((s, i) => group(`Scene ${i + 1}`,
        field(`bf-sc${i}-title`, `Scene ${i + 1} title (authors only)`, s.title, (sc, v) => opt(sc[i], 'title', v)),
        picture(s, i, 'background', `Scene ${i + 1} background (optional)`),
        s.background ? field(`bf-sc${i}-backgroundAlt`, `Scene ${i + 1} background alt text (empty = decorative)`, s.backgroundAlt, (sc, v) => opt(sc[i], 'backgroundAlt', v)) : null,
        picture(s, i, 'character', `Scene ${i + 1} character (optional)`),
        s.character ? field(`bf-sc${i}-characterAlt`, `Scene ${i + 1} character alt text (who is speaking)`, s.characterAlt, (sc, v) => opt(sc[i], 'characterAlt', v)) : null,
        s.character && !s.characterAlt && !S.doc.assets.find((a) => a.id === s.character)?.alt ? h('p', { class: 'warn' }, 'This character image has no alt text.') : null,
        h('ol', { class: 'sub-list' }, s.items.map((it, j) => itemEl(s, i, it, j))),
        arrows(`bf-sc${i}`, `scene ${i + 1}`, 'scene', b.scenes, i, (sc) => sc,
          btn('+ Item', C, () => dispatch(edit((sc) => sc[i].items.push(item(sc)))), { id: `bf-sc${i}-add`, 'aria-label': `Add an item to scene ${i + 1}` })))),
      group('Scenes and ending',
        btn('+ Scene', C, () => dispatch(edit((sc) => { const id = free('s', sc); sc.push({ id, title: `Scene ${sc.length + 1}`, items: [] }); sc.at(-1).items.push(item(sc)); })), { id: 'bf-sc-add', 'aria-label': 'Add a scene' }),
        ctl('area', 'bf-ending', 'Ending text (optional; shown above Start over)', b.ending, { cmd: C, rows: 3, commit: (v) => setB(b, { ending: v || null }) }),
        hint('Learners never see scene titles. "Next" goes to the next item, then the next scene, then the end. Reaching an end completes the block.')),
    ];
  }
  function styleGroup(b) {
    const st = b.style || {};
    const sty = (k) => (v) => setB(b, { style: { [k]: v === '' ? null : v } });
    const s = (k, lab, options) => ctl('select', `bs-${k}`, lab, st[k] ?? '', { cmd: C, options: [['', 'Default'], ...options], commit: sty(k) });
    return group('Style',
      h('div', { class: 'grid2' },
        s('width', 'Width', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide'], ['full', 'Full width']]),
        s('padding', 'Padding', [['none', 'None'], ['small', 'Small'], ['normal', 'Normal'], ['large', 'Large']]),
        s('align', 'Alignment', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])),
      h('div', { class: 'grid2' },
        colorCtl('bs-background', 'Background', st.background, C, (v) => setB(b, { style: { background: v } })),
        colorCtl('bs-color', 'Text colour', st.color, C, (v) => setB(b, { style: { color: v } }))));
  }
  function blockForm(b, l) {
    return [
      h('div', { class: 'obj-head' }, h('span', { class: 'badge' }, label(b.type)), h('code', {}, b.id), h('span', { class: 'muted' }, `in ${l.title}`)),
      ...(FORMS[b.type]?.(b, l) ?? [hint('This block type has no form yet; edit it with block.set.')]),
      styleGroup(b),
      group('Arrange', ctl('select', 'bf-move-lesson', 'Move to lesson', l.id, { cmd: 'block.move', options: lessons().map((y) => [y.id, `${y.title} (${y.id})`]), commit: (v) => (v === l.id ? null : [{ cmd: 'block.move', args: { id: b.id, lesson: v } }]) }),
        hint('Reorder on the page: the arrows on the selected block, Alt+Up or Alt+Down, or drag it. Drop it on a lesson in the outline to move it there.')),
    ];
  }

  function lessonForm(l) {
    const set = (args) => [{ cmd: 'lesson.set', args: { id: l.id, ...args } }];
    const L = 'lesson.set';
    const sec = sectionOf(l.id);
    const quiz = l.kind === 'quiz';
    const tracked = S.doc.tracking.complete.some((c) => c.quiz === l.id);
    return [
      h('div', { class: 'obj-head' }, h('span', { class: 'badge' }, quiz ? 'quiz lesson' : 'lesson'), h('code', {}, l.id), h('span', { class: 'muted' }, status(l))),
      group('Lesson',
        ctl('text', 'lf-title', 'Lesson title', l.title, { cmd: L, commit: (v) => set({ title: v }) }),
        ctl('select', 'lf-kind', 'Kind', l.kind, { cmd: L, options: [['content', 'Content: stacked blocks'], ['quiz', 'Quiz: graded questions, one at a time']],
          commit: (v) => (v === 'quiz' ? set({ kind: 'quiz' }) : set({ kind: 'content', ...Object.fromEntries(QUIZ_FIELDS.map((k) => [k, null])) })) }),
        ctl('select', 'lf-section', 'Section', sec.id, { cmd: 'lesson.move', options: S.doc.sections.map((s) => [s.id, s.title || s.id]), commit: (v) => (v === sec.id ? null : [{ cmd: 'lesson.move', args: { id: l.id, section: v } }]) })),
      quiz && group('Quiz settings',
        h('div', { class: 'grid2' },
          ctl('num', 'lf-passPercent', 'Pass mark (%)', l.passPercent, { cmd: L, attrs: { min: 0, max: 100, placeholder: '80' }, commit: (v) => set({ passPercent: v }) }),
          ctl('num', 'lf-attempts', 'Attempts (0 = unlimited)', l.attempts, { cmd: L, attrs: { min: 0, step: 1, placeholder: '0' }, commit: (v) => set({ attempts: v }) })),
        ctl('select', 'lf-reveal', 'After each answer, show', l.reveal ?? '', { cmd: L, options: [['', 'Result, feedback and correct answer (default)'], ['all', 'Result, feedback and correct answer'], ['incorrect', 'Result and feedback only'], ['none', 'Nothing until the score']], commit: (v) => set({ reveal: opt(v) }) }),
        h('div', { class: 'checks' },
          ctl('check', 'lf-randomize', 'Random question order', l.randomize, { cmd: L, commit: (v) => set({ randomize: v || null }) }),
          ctl('check', 'lf-shuffle', 'Shuffle answer choices', l.shuffle, { cmd: L, commit: (v) => set({ shuffle: v || null }) }),
          ctl('check', 'lf-requirePass', 'Lesson completes only when passed', l.requirePass, { cmd: L, commit: (v) => set({ requirePass: v || null }) })),
        hint(tracked ? 'This quiz completes the course in the LMS (Course tab, Tracking).' : 'To report this quiz to the LMS, choose it under Tracking in the Course tab.')),
    ];
  }

  function courseForm() {
    const d = S.doc;
    const theme = d.player.theme || {};
    const cover = d.cover || {};
    const viewed = d.tracking.complete.find((c) => c.lessonsViewed !== undefined);
    const quizC = d.tracking.complete.find((c) => c.quiz);
    const quizzes = lessons().filter((l) => l.kind === 'quiz');
    const tracking = () => [{ cmd: 'tracking.set', args: { complete: [
      ...($('#cf-viewed').checked ? [{ lessonsViewed: Number($('#cf-viewed-pct').value) || 100 }] : []),
      ...($('#cf-quiz').checked && $('#cf-quiz-id').value ? [{ quiz: $('#cf-quiz-id').value }] : []),
    ] } }];
    const setCover = (patch) => { const c = { ...cover, ...patch }; for (const k of Object.keys(c)) if (!c[k]) delete c[k]; return [{ cmd: 'course.set', args: { cover: c.image ? c : null } }]; };
    const setTheme = (k) => (v) => { const t = { ...theme, [k]: v }; if (!v) delete t[k]; return [{ cmd: 'player.set', args: { theme: t } }]; };
    const imgs = assetsOf('image');
    return [
      group('Course',
        ctl('text', 'cf-title', 'Course title', d.title, { cmd: 'course.set', commit: (v) => [{ cmd: 'course.set', args: { title: v } }] }),
        ctl('area', 'cf-description', 'Description (shown on the cover)', d.description, { cmd: 'course.set', rows: 3, commit: (v) => [{ cmd: 'course.set', args: { description: v } }] }),
        ctl('text', 'cf-language', 'Language', d.language, { cmd: 'course.set', commit: (v) => [{ cmd: 'course.set', args: { language: v } }] })),
      group('Cover',
        h('div', { class: 'lv-asset' },
          ctl('select', 'cf-cover', 'Cover image', cover.image ?? '', { cmd: 'course.set', options: [['', '(none)'], ...imgs.map((a) => [a.id, `${a.path} (${a.id})`])], commit: (v) => setCover({ image: v }) }),
          btn('File or library…', 'asset.add', async () => { const reg = await registerAsset('image'); if (reg) dispatch([reg.cmd, ...setCover({ image: reg.id, ...(reg.alt ? { alt: reg.alt } : {}) })], 'cf-cover'); }, { class: 'small', id: 'cf-cover-reg', 'aria-label': 'Add a new file or a library image for the cover' })),
        cover.image && ctl('text', 'cf-cover-alt', 'Cover alt text', cover.alt, { cmd: 'course.set', commit: (v) => setCover({ alt: v }) })),
      group('Navigation',
        ctl('select', 'cf-navigation', 'Learners move through lessons', d.player.navigation ?? 'free', { cmd: 'player.set', options: [['free', 'Freely, in any order (search available)'], ['restricted', 'In sequence: a lesson unlocks when the earlier ones are complete']], commit: (v) => [{ cmd: 'player.set', args: { navigation: v } }] })),
      themeGroup('cf-th'),
      group('Theme colours', h('div', { class: 'grid2' }, THEME.map(([k, lab]) => colorCtl(`ct-${k}`, lab, theme[k], 'player.set', setTheme(k)))),
        hint('A preset fills these; changing one makes the theme custom. Empty uses the player default (light or dark from the learner\'s system). Check contrast with Check in the top bar.')),
      group('Tracking (first criterion met completes the course)',
        h('div', { class: 'grid2' },
          ctl('check', 'cf-viewed', 'Lessons completed', !!viewed, { cmd: 'tracking.set', commit: tracking }),
          ctl('num', 'cf-viewed-pct', 'Percent of lessons', viewed?.lessonsViewed ?? 100, { cmd: 'tracking.set', commit: tracking, attrs: { min: 1, max: 100 } }),
          ctl('check', 'cf-quiz', 'Quiz result', !!quizC, { cmd: 'tracking.set', commit: tracking }),
          ctl('select', 'cf-quiz-id', 'Quiz lesson', quizC?.quiz ?? quizzes[0]?.id ?? '', { cmd: 'tracking.set', commit: tracking, options: quizzes.map((l) => [l.id, l.title]) })),
        ctl('select', 'cf-status', 'Report status as', d.tracking.status, { cmd: 'tracking.set', commit: (v) => [{ cmd: 'tracking.set', args: { status: v } }], options: ['passed-incomplete', 'passed-failed', 'completed-incomplete', 'completed-failed'] })),
    ];
  }

  /** Check dialog "Go to": select the lesson and block a /sections/i/lessons/j[/blocks/k] path points at. */
  function goto(path) {
    if (path === '/cover' || path?.startsWith('/cover/')) { V.tab = 'course'; render(); return true; }
    const m = /^\/sections\/(\d+)\/lessons\/(\d+)(?:\/blocks\/(\d+))?/.exec(path || '');
    const l = m && S.doc.sections[+m[1]]?.lessons[+m[2]];
    if (!l) return false;
    const b = m[3] !== undefined ? l.blocks[+m[3]] : null;
    Object.assign(V, { lesson: l.id, block: b?.id ?? null, tab: b ? 'block' : 'lesson' });
    render();
    if (b) focusCard(b.id);
    return true;
  }

  return { show, render: renderAll, goto, active: () => S.doc?.mode === 'lessons' };
}
