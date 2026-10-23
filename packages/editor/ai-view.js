// CourseForge Studio editor, AI surfaces: Claude's status on the start screen, the AI settings dialog, and the
// assistant panel. Claude only ever proposes a change card; Apply sends it to the server as one undo step.
export function aiView({ S, $, h, call, show, toast, adopt, render, announce, courseUrl, token, openCourse, loadCourses }) {
  let status = null; // GET /api/ai: {enabled, model, dailyRequests, today, cli:{available, version, loggedIn, detail}}
  let turns = []; // assistant panel history for the open course: {prompt, lines:[], card, error, applied, busy}
  let open = false, busy = false;
  const ready = () => status?.enabled && status.cli?.available && status.cli.loggedIn !== false;
  const icon = (name) => h('span', { class: 'ico', style: `--ico: url(/editor/icons/${name}.svg)`, 'aria-hidden': 'true' });

  async function refresh() {
    const r = await call('GET', '/api/ai');
    if (r.ok) status = r;
    return status;
  }

  /** One line under the start strip: is Claude ready, and what to do if not. */
  function statusLine() {
    const s = status;
    const [kind, text] = !s ? ['wait', 'Checking for Claude…']
      : !s.cli.available ? ['off', 'Claude Code is not installed, so AI features are unavailable. Everything else works offline.']
      : s.cli.loggedIn === false ? ['off', 'Claude Code is installed but not signed in.']
      : !s.enabled ? ['off', `Claude Code ${s.cli.version ?? ''} found. AI is switched off until you turn it on.`]
      : ['on', `Claude is ready · ${s.today.requests} of ${s.dailyRequests} requests used today`];
    return h('p', { class: `ai-line ${kind}`, id: 'ai-line' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, text),
      s && h('button', { type: 'button', class: 'linkish', 'data-ui': 'ai.settings', onclick: () => settings() }, kind === 'on' ? 'AI settings' : 'Set up Claude'));
  }

  /** AI settings: the three checks (installed, signed in, switched on), model and daily limit, and what is sent. */
  async function settings() {
    await refresh();
    const s = status;
    if (!s) return toast('Could not read the AI settings.', 'error');
    const step = (ok, title, body) => h('li', { class: `ai-step ${ok ? 'done' : 'todo'}` },
      icon(ok ? 'checkmark-circle' : 'dismiss-circle'), h('div', {}, h('strong', {}, title), body));
    const save = async (patch) => { const r = await call('POST', '/api/ai', patch); if (!r.ok) return toast(r.errors?.[0]?.message ?? 'Not saved', 'error'); status = { ...status, ...r }; renderAll(); announce('AI settings saved'); };
    const model = (v, label, note) => h('label', { class: 'ai-model' }, h('input', { type: 'radio', name: 'ai-model', value: v, checked: s.model === v, onchange: () => save({ model: v }) }), h('span', {}, h('strong', {}, label), h('small', {}, note)));
    show('Claude in CourseForge Studio', 'ai-settings',
      h('p', { class: 'hint' }, 'Claude drafts and edits courses through Claude Code on this computer, using your own Claude sign-in. No key is stored in this app.'),
      h('ol', { class: 'ai-steps' },
        step(s.cli.available, s.cli.available ? `Claude Code ${s.cli.version ?? ''} is installed` : 'Install Claude Code',
          s.cli.available ? null : h('p', {}, 'Download it from ', h('a', { href: 'https://claude.com/claude-code', target: '_blank', rel: 'noreferrer' }, 'claude.com/claude-code'), ', then come back and choose Check again.')),
        step(s.cli.available && s.cli.loggedIn !== false, s.cli.loggedIn === false ? 'Sign in to Claude Code' : 'Signed in',
          s.cli.loggedIn === false ? h('p', {}, 'Open Windows Terminal, type ', h('code', {}, 'claude'), ', press Enter, then type ', h('code', {}, '/login'), ' and follow the steps in your browser.') : null),
        step(s.enabled, 'Turn on AI', h('label', { class: 'ai-toggle' }, h('input', { type: 'checkbox', id: 'ai-enabled', checked: s.enabled, 'data-ui': 'ai.enable', onchange: (e) => save({ enabled: e.target.checked }) }), h('span', {}, 'Let Claude read and propose changes to the course you are working on')))),
      h('button', { type: 'button', 'data-ui': 'ai.recheck', onclick: () => settings() }, 'Check again'),
      h('fieldset', { class: 'ai-models' }, h('legend', {}, 'Model'),
        model('fast', 'Fast', 'Quick checks and small edits'), model('default', 'Balanced', 'Recommended for most work'), model('best', 'Best', 'Large rewrites; slower and uses more of your plan')),
      h('div', { class: 'field ai-limit' }, h('label', { for: 'ai-daily' }, 'Daily request limit'),
        h('input', { id: 'ai-daily', type: 'number', min: '1', max: '1000', value: String(s.dailyRequests), onchange: (e) => save({ dailyRequests: Number(e.target.value) }) }),
        h('p', { class: 'hint' }, `Today: ${s.today.requests} requests, ${s.today.failures} failed, about $${s.today.costUsd.toFixed(2)} at API prices (covered by your Claude plan).`)),
      h('details', { class: 'ai-privacy' }, h('summary', {}, 'What Claude sees'),
        h('p', {}, 'For each request: your words, the outline and content of the open course, and any document you attach. Claude works on a copy; nothing changes until you choose Apply, and Undo reverses it. Nothing is sent while AI is off.')));
  }

  // ----- assistant panel -----
  const SUGGEST = ['Add alt text to every image that lacks it', 'Rewrite this slide in plainer language', 'Add a knowledge check question after this slide', 'Check the course for accessibility issues and fix what you can'];

  function toggle(force) {
    open = force ?? !open;
    $('#ai-panel').hidden = !open;
    $('#btn-ai')?.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('ai-open', open);
    if (open) { refresh().then(renderPanel); renderPanel(); setTimeout(() => $('#ai-prompt')?.focus(), 0); }
  }
  /** A new course: forget the old conversation. */
  function reset() { turns = []; review = null; if (open) renderPanel(); }

  const diffView = (diff) => h('pre', { class: 'ai-diff', tabindex: '0', 'aria-label': 'Changes to the course outline' },
    diff.map((d) => h('span', { class: `d d-${d.op === '+' ? 'add' : d.op === '-' ? 'del' : d.op === '…' ? 'gap' : 'ctx'}` },
      h('span', { class: 'sr-only' }, d.op === '+' ? 'Added: ' : d.op === '-' ? 'Removed: ' : ''), d.op === '…' ? '⋯' : d.line, '\n')));

  function card(t) {
    const c = t.card;
    if (!c.changed) return h('div', { class: 'ai-card quiet' }, h('p', {}, c.summary), h('p', { class: 'hint' }, 'No changes to apply.'));
    const n = c.commands.length;
    return h('div', { class: 'ai-card' },
      h('p', { class: 'ai-summary' }, c.summary),
      diffView(c.diff),
      n ? h('details', { class: 'ai-cmds' }, h('summary', {}, `${n} command${n === 1 ? '' : 's'}`), h('ol', {}, c.commands.map((x) => h('li', {}, h('code', {}, x.cmd))))) : null,
      t.applied ? h('p', { class: 'ai-applied', role: 'status' }, icon('checkmark-circle'), 'Applied. Undo reverses it.')
        : t.discarded ? h('p', { class: 'hint' }, 'Discarded.')
        : h('div', { class: 'ai-actions' },
          h('button', { type: 'button', class: 'primary', 'data-ui': 'ai.apply', onclick: () => apply(t) }, 'Apply'),
          h('button', { type: 'button', 'data-ui': 'ai.discard', onclick: () => discard(t) }, 'Discard'),
          h('span', { class: 'hint' }, `${c.turns} step${c.turns === 1 ? '' : 's'} · ≈ $${(c.costUsd ?? 0).toFixed(2)}`)));
  }

  function errorBox(e) {
    const setup = ['ai-off', 'not-installed', 'not-signed-in'].includes(e.code);
    return h('div', { class: 'ai-error', role: 'alert' }, icon('warning'), h('div', {}, h('p', {}, e.message), e.hint ? h('p', { class: 'hint' }, e.hint) : null,
      setup ? h('button', { type: 'button', 'data-ui': 'ai.settings', onclick: () => settings() }, 'Open AI settings') : null));
  }

  function renderPanel() {
    const panel = $('#ai-panel');
    if (!panel || !open) return;
    const slide = S.doc?.slides?.find((s) => s.id === S.slide);
    const log = h('ol', { class: 'ai-log', 'aria-live': 'polite' }, turns.map((t) => h('li', { class: 'ai-turn' },
      h('p', { class: 'ai-prompt-echo' }, t.prompt),
      t.lines.length ? h('ul', { class: 'ai-progress' }, t.lines.map((l) => h('li', {}, l))) : null,
      t.busy ? h('p', { class: 'ai-working', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Claude is working on a copy of your course…') : null,
      t.error ? errorBox(t.error) : t.card ? card(t) : null)));
    const empty = !turns.length && h('div', { class: 'ai-empty' },
      h('p', {}, ready() ? 'Ask for a change in your own words. Claude edits a copy, then shows you exactly what changed before anything is applied.' : 'Connect Claude to draft, rewrite and fix courses from here.'),
      ready() ? h('ul', { class: 'ai-suggest' }, SUGGEST.map((s) => h('li', {}, h('button', { type: 'button', class: 'ghost', 'data-ui': 'ai.suggest', onclick: () => { $('#ai-prompt').value = s; $('#ai-prompt').focus(); } }, s))))
        : h('button', { type: 'button', class: 'primary', 'data-ui': 'ai.settings', onclick: () => settings() }, 'Set up Claude'));
    const form = h('form', { class: 'ai-compose', onsubmit: (e) => { e.preventDefault(); ask(); } },
      h('label', { for: 'ai-prompt', class: 'sr-only' }, 'Ask Claude to change this course'),
      h('textarea', { id: 'ai-prompt', rows: '3', placeholder: 'Ask Claude to change this course…', disabled: busy, onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask(); } } }),
      h('div', { class: 'ai-compose-row' },
        slide ? h('label', { class: 'ai-focus' }, h('input', { type: 'checkbox', id: 'ai-focus', checked: true }), h('span', {}, 'About slide ', h('strong', {}, slide.title))) : h('span', {}),
        h('button', { type: 'submit', class: 'primary', 'data-ui': 'ai.ask', disabled: busy, 'aria-keyshortcuts': 'Control+Enter' }, icon('send'), 'Send')));
    const keep = $('#ai-prompt')?.value ?? '', typing = document.activeElement?.id === 'ai-prompt';
    panel.replaceChildren(
      h('div', { class: 'ai-head' }, h('h2', { id: 'ai-title' }, icon('sparkle'), 'Claude'),
        h('button', { type: 'button', class: 'small', 'data-ui': 'ai.review', disabled: !ready() || review?.busy, onclick: () => runReview() }, 'Review course'),
        h('button', { type: 'button', class: 'ghost icon', 'aria-label': 'AI settings', title: 'AI settings', 'data-ui': 'ai.settings', onclick: () => settings() }, icon('settings')),
        h('button', { type: 'button', class: 'ghost', 'data-ui': 'ai.close', onclick: () => toggle(false) }, 'Close')),
      h('div', { class: 'ai-body' }, reviewView(), empty || log), form);
    $('#ai-prompt').value = keep;
    if (typing) $('#ai-prompt').focus();
    const body = panel.querySelector('.ai-body'); body.scrollTop = body.scrollHeight;
  }

  /** POST a JSON body and feed each NDJSON line of the reply to onEvent. */
  async function streamJson(url, body, onEvent) {
    const res = await fetch(url, { method: 'POST', headers: { 'x-cf-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw j.errors?.[0] ?? { message: `HTTP ${res.status}` }; }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onEvent(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    }
  }

  async function ask() {
    const prompt = $('#ai-prompt').value.trim();
    if (!prompt || busy || !S.name) return;
    const slide = $('#ai-focus')?.checked ? S.doc.slides.find((s) => s.id === S.slide) : null;
    const t = { prompt, lines: [], busy: true };
    turns.push(t); busy = true; $('#ai-prompt').value = ''; renderPanel();
    try {
      await streamJson(courseUrl('/ai/ask'), { prompt, ...(slide ? { focus: `slide ${slide.id} "${slide.title}"` } : {}) }, (ev) => {
        if (ev.type === 'status') t.lines.push(ev.text);
        else if (ev.type === 'tool') t.lines.push(ev.name === 'run_commands' ? `Edited the copy (${ev.input?.commands?.length ?? 0} commands)` : `Read the course (${ev.name.replace(/_/g, ' ')})`);
        else if (ev.type === 'done') t.card = ev.card;
        else if (ev.type === 'error') t.error = ev.errors[0];
        renderPanel();
      });
    } catch (e) { t.error = { code: e.code ?? 'network', message: e.message ?? 'The request failed.', hint: e.hint }; }
    t.busy = false; busy = false;
    if (t.card?.changed) announce('Claude proposed a change. Review it, then Apply or Discard.');
    else if (t.error) announce(`Claude could not finish: ${t.error.message}`);
    renderPanel(); refresh();
  }

  async function apply(t) {
    const r = await call('POST', courseUrl('/ai/apply'), { draftId: t.card.draftId });
    if (!r.ok) { t.error = r.errors?.[0]; renderPanel(); return; }
    t.applied = true; adopt(r); render(); renderPanel(); announce('Applied Claude\'s change');
  }
  async function discard(t) {
    await call('POST', courseUrl('/ai/discard'), { draftId: t.card.draftId });
    t.discarded = true; renderPanel();
  }

  function renderAll() { if (!S.doc) render(); renderPanel(); }

  // ----- review: Claude reads the whole course and lists what to fix; each Fix goes to the assistant -----
  let review = null; // {busy, findings, error}
  async function runReview() {
    if (!S.name || review?.busy) return;
    review = { busy: true, findings: [] }; renderPanel();
    try {
      await streamJson(courseUrl('/ai/review'), {}, (ev) => { if (ev.type === 'done') review.findings = ev.findings; else if (ev.type === 'error') review.error = ev.errors[0]; });
    } catch (e) { review.error = { message: e.message ?? 'The review failed.', hint: e.hint }; }
    review.busy = false; renderPanel(); refresh();
    announce(review.error ? `Review failed: ${review.error.message}` : `${review.findings.length} findings`);
  }
  const reviewView = () => review && h('section', { class: 'ai-review', 'aria-labelledby': 'ai-review-h' },
    h('h3', { id: 'ai-review-h' }, 'Course review'),
    review.busy ? h('p', { class: 'ai-working', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), 'Claude is reading the whole course…')
      : review.error ? errorBox(review.error)
      : !review.findings.length ? h('p', { class: 'hint' }, 'No findings. The course reads well.')
      : h('ol', { class: 'ai-findings' }, review.findings.map((f) => h('li', { class: `sev-${f.severity}` },
        h('p', {}, h('span', { class: 'sev' }, f.severity), h('strong', {}, f.title)), h('p', { class: 'hint' }, f.detail),
        h('button', { type: 'button', class: 'small', 'data-ui': 'ai.fix', onclick: () => { $('#ai-prompt').value = f.fix; ask(); } }, 'Fix with Claude')))));

  // ----- create a course with AI: brief → outline (editable) → build → open -----
  const slug = (t) => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'new-course';
  const uniqueName = (base) => { const taken = new Set((S.courses ?? []).map((c) => c.name)); let n = base; for (let i = 2; taken.has(n); i++) n = `${base}-${i}`; return n; };

  /** Create with AI (start screen): set up Claude first when it is not ready. */
  function create() { return ready() ? createCourse() : settings(); }
  function createCourse() {
    const box = h('div', { class: 'cr-body' });
    const st = { brief: { topic: '', audience: '', minutes: 15, mode: 'slides' }, files: [], outline: null, building: null };
    show('Create a course with AI', 'ai-create', box);
    const steps = (n) => h('ol', { class: 'cr-steps', 'aria-label': 'Steps' }, ['Brief', 'Outline', 'Build'].map((s, i) => h('li', { 'aria-current': i === n ? 'step' : null, class: i < n ? 'done' : null }, s)));
    const working = (text) => h('p', { class: 'ai-working', role: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), text);

    function briefStep(error) {
      const b = st.brief;
      box.replaceChildren(steps(0), h('form', { class: 'cr-form', onsubmit: (e) => { e.preventDefault(); draftOutline(); } },
        h('div', { class: 'field' }, h('label', { for: 'cr-topic' }, 'What should the course teach?'),
          h('textarea', { id: 'cr-topic', rows: '4', required: true, value: b.topic, placeholder: 'For example: how new lab staff choose and use protective equipment, and what to do after a chemical spill', oninput: (e) => { b.topic = e.target.value; } })),
        h('div', { class: 'cr-row' },
          h('div', { class: 'field' }, h('label', { for: 'cr-audience' }, 'Who is it for?'), h('input', { id: 'cr-audience', value: b.audience, placeholder: 'New lab technicians', oninput: (e) => { b.audience = e.target.value; } })),
          h('div', { class: 'field' }, h('label', { for: 'cr-minutes' }, 'Length'), h('select', { id: 'cr-minutes', onchange: (e) => { b.minutes = Number(e.target.value); } },
            [5, 10, 15, 20, 30, 45, 60].map((m) => h('option', { value: String(m), selected: m === b.minutes }, `${m} minutes`))))),
        h('fieldset', { class: 'course-mode' }, h('legend', {}, 'Course type'),
          ['slides', 'lessons'].map((m) => h('label', { class: 'cr-radio' }, h('input', { type: 'radio', name: 'cr-mode', value: m, checked: b.mode === m, onchange: () => { b.mode = m; } }), m === 'slides' ? 'Slides' : 'Lessons'))),
        h('div', { class: 'field' }, h('label', { for: 'cr-files' }, 'Source documents (optional)'),
          h('input', { id: 'cr-files', type: 'file', multiple: true, accept: '.md,.txt,.docx,.pdf', onchange: (e) => { st.files = [...e.target.files]; } }),
          h('p', { class: 'hint' }, 'Word, PDF, Markdown or text. Claude builds the course from them. They are copied into your courses folder.')),
        error ? errorBox(error) : null,
        h('div', { class: 'dlg-actions' }, h('button', { type: 'submit', class: 'primary', 'data-ui': 'ai.outline' }, 'Draft the outline'))));
      $('#cr-topic').focus();
    }

    async function draftOutline() {
      box.replaceChildren(steps(0), working('Uploading documents…'));
      const attachments = [];
      for (const f of st.files) {
        const name = f.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100) || 'document';
        const res = await fetch(`/api/files?dir=imports&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'x-cf-token': token }, body: f }).then((r) => r.json()).catch(() => null);
        if (!res?.ok) return briefStep({ message: `Could not copy ${f.name} into the courses folder.`, hint: res?.errors?.[0]?.message });
        attachments.push(res.path);
      }
      box.replaceChildren(steps(0), working('Claude is drafting the outline. This usually takes under a minute…'));
      let out = null, error = null;
      try { await streamJson('/api/ai/outline', { brief: st.brief, attachments }, (ev) => { if (ev.type === 'done') out = ev; else if (ev.type === 'error') error = ev.errors[0]; }); } catch (e) { error = e; }
      refresh();
      if (error || !out) return briefStep(error ?? { message: 'No outline came back.' });
      st.outline = { title: out.title, text: out.outline, name: uniqueName(slug(out.title)), limit: out.limit };
      outlineStep();
    }

    function outlineStep(error) {
      const o = st.outline;
      const count = () => o.text.split('\n').filter((l) => /^##\s/.test(l.trim())).length;
      const counter = h('p', { class: 'hint', id: 'cr-count', 'aria-live': 'polite' });
      const update = () => { counter.textContent = `${count()} ${st.brief.mode === 'lessons' ? 'lessons' : 'slides'}; up to ${o.limit} suit ${st.brief.minutes} minutes. Lines: "# " section, "## " item, "- " bullet, "? " question with "[x]" / "[ ]" choices.`; };
      box.replaceChildren(steps(1), h('form', { class: 'cr-form', onsubmit: (e) => { e.preventDefault(); buildStep(); } },
        h('div', { class: 'cr-row' },
          h('div', { class: 'field' }, h('label', { for: 'cr-title' }, 'Course title'), h('input', { id: 'cr-title', required: true, value: o.title, oninput: (e) => { o.title = e.target.value; } })),
          h('div', { class: 'field' }, h('label', { for: 'cr-name' }, 'File name'), h('input', { id: 'cr-name', required: true, pattern: '[a-z0-9][a-z0-9\\-]{0,60}', value: o.name, spellcheck: 'false', oninput: (e) => { o.name = e.target.value; } }))),
        h('div', { class: 'field' }, h('label', { for: 'cr-outline' }, 'Outline: edit anything before Claude builds it'),
          h('textarea', { id: 'cr-outline', class: 'cr-outline', rows: '16', spellcheck: 'true', value: o.text, 'aria-describedby': 'cr-count', oninput: (e) => { o.text = e.target.value; update(); } })),
        counter, error ? errorBox(error) : null,
        h('div', { class: 'dlg-actions' },
          h('button', { type: 'button', 'data-ui': 'ai.back', onclick: () => briefStep() }, 'Back to the brief'),
          h('button', { type: 'button', 'data-ui': 'ai.redraft', onclick: () => draftOutline() }, 'Draft again'),
          h('button', { type: 'submit', class: 'primary', 'data-ui': 'ai.build' }, 'Build the course'))));
      update();
    }

    async function buildStep() {
      const o = st.outline, parts = [];
      let result = null, error = null;
      const draw = () => box.replaceChildren(steps(2),
        h('ul', { class: 'cr-parts' }, parts.map((p, i) => { const done = i < parts.length - 1 || !!result; return h('li', { class: done ? 'done' : 'now' }, done ? icon('checkmark-circle') : h('span', { class: 'spin', 'aria-hidden': 'true' }), p); })),
        result ? h('div', { class: 'cr-done', role: 'status' }, h('p', {}, h('strong', {}, `${o.title} is ready.`), ` ${result.parts} parts built${result.issues ? `; Check lists ${result.issues} things to look at` : ''}.`),
          h('div', { class: 'dlg-actions' }, h('button', { type: 'button', class: 'primary', 'data-ui': 'ai.open', onclick: async () => { $('#dlg').close(); await loadCourses(); await openCourse(result.name); toggle(true); runReview(); } }, 'Open and review it')))
          : error ? h('div', {}, errorBox(error), h('p', { class: 'hint' }, 'Finished parts are kept. Continue picks up where it stopped.'),
            h('div', { class: 'dlg-actions' }, h('button', { type: 'button', 'data-ui': 'ai.back', onclick: () => outlineStep() }, 'Back to the outline'), h('button', { type: 'button', class: 'primary', 'data-ui': 'ai.continue', onclick: () => buildStep() }, 'Continue building')))
          : working(parts.length ? `Claude is building part ${parts.length}… You can keep this window open; each part takes a minute or two.` : 'Setting up the course…'));
      draw();
      try {
        await streamJson('/api/ai/build', { name: o.name, title: o.title, mode: st.brief.mode, outline: o.text, brief: st.brief }, (ev) => {
          if (ev.type === 'part') { parts.push(`Part ${ev.index + 1} of ${ev.total}: ${ev.title}`); draw(); }
          else if (ev.type === 'done') result = ev; else if (ev.type === 'error') error = ev.errors[0];
        });
      } catch (e) { error = e; }
      refresh();
      if (error?.code === 'outline' || error?.code === 'pattern' || error?.code === 'dupe') return outlineStep(error);
      draw();
      announce(result ? `${o.title} is ready` : `Building stopped: ${error?.message}`);
    }

    briefStep();
  }

  return { refresh, statusLine, settings, toggle, reset, renderPanel, create, review: runReview, isOpen: () => open, status: () => status };
}
