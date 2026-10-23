// CourseForge Studio editor, AI surfaces: Claude's status on the start screen, the AI settings dialog, and the
// assistant panel. Claude only ever proposes a change card; Apply sends it to the server as one undo step.
export function aiView({ S, $, h, call, show, toast, adopt, render, announce, courseUrl, token }) {
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
  function reset() { turns = []; if (open) renderPanel(); }

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
        h('button', { type: 'button', class: 'ghost icon', 'aria-label': 'AI settings', title: 'AI settings', 'data-ui': 'ai.settings', onclick: () => settings() }, icon('settings')),
        h('button', { type: 'button', class: 'ghost', 'data-ui': 'ai.close', onclick: () => toggle(false) }, 'Close')),
      h('div', { class: 'ai-body' }, empty || log), form);
    $('#ai-prompt').value = keep;
    if (typing) $('#ai-prompt').focus();
    const body = panel.querySelector('.ai-body'); body.scrollTop = body.scrollHeight;
  }

  async function ask() {
    const prompt = $('#ai-prompt').value.trim();
    if (!prompt || busy || !S.name) return;
    const slide = $('#ai-focus')?.checked ? S.doc.slides.find((s) => s.id === S.slide) : null;
    const t = { prompt, lines: [], busy: true };
    turns.push(t); busy = true; $('#ai-prompt').value = ''; renderPanel();
    try {
      const res = await fetch(courseUrl('/ai/ask'), { method: 'POST', headers: { 'x-cf-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ prompt, ...(slide ? { focus: `slide ${slide.id} "${slide.title}"` } : {}) }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw j.errors?.[0] ?? { message: `HTTP ${res.status}` }; }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
          if (ev.type === 'status') t.lines.push(ev.text);
          else if (ev.type === 'tool') t.lines.push(ev.name === 'run_commands' ? `Edited the copy (${ev.input?.commands?.length ?? 0} commands)` : `Read the course (${ev.name.replace(/_/g, ' ')})`);
          else if (ev.type === 'done') t.card = ev.card;
          else if (ev.type === 'error') t.error = ev.errors[0];
          renderPanel();
        }
      }
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

  /** Create with AI (start screen): set up Claude first when it is not ready. */
  function create() { return ready() ? createCourse() : settings(); }
  async function createCourse() { toast('Creating a course with AI arrives in the next step of this build.'); }

  return { refresh, statusLine, settings, toggle, reset, renderPanel, create, isOpen: () => open, status: () => status };
}
