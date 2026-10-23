// CourseForge Studio lessons player: renders a lessons runtime's view as a scrolling, accessible page and feeds
// learner actions back as runtime events. Classic script, ES2017 (no ?. ?? or object spread), works from file://.
// CFPlayer.mount hands lessons runtimes to CFLessons.mount(container, { runtime, assetsBase, resumePrompt, onTrace }).
// The runtime keeps learning state; this file keeps presentation state only (open panels, active tab, flipped cards).
(function (root) {
  'use strict';

  var uid = 0;
  // Authored 24px stroke icons (one weight, round caps).
  var ICONS = {
    check: 'M5 12.5l4.2 4.2L19 7', cross: 'M6.5 6.5l11 11M17.5 6.5l-11 11', lock: 'M7.5 11V8.2a4.5 4.5 0 0 1 9 0V11M5.5 11h13v9.5h-13z',
    chevron: 'M6 9.5l6 6 6-6', left: 'M14.5 6l-6 6 6 6', right: 'M9.5 6l6 6-6 6', menu: 'M4 7h16M4 12h16M4 17h16',
    search: 'M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM15.5 15.5L20 20', retry: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5V9H9',
    flip: 'M4 9a8 8 0 0 1 14-3.5M20 4v4.5h-4.5M20 15a8 8 0 0 1-14 3.5M4 20v-4.5h4.5', home: 'M4 11l8-6.5 8 6.5M6.5 9.5V19h11V9.5',
  };

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  // Parsed as HTML so the SVG namespace comes from the parser (validatePackage refuses absolute URLs in our files).
  var iconBox = document.createElement('div');
  function icon(name) {
    iconBox.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="cfl-icon cfl-icon-' + name + '"><path d="' + ICONS[name] + '"></path></svg>';
    return iconBox.removeChild(iconBox.firstChild);
  }
  function sr(text) { return h('span', { class: 'cfl-sr', text: text }); }
  // Plain text: a blank line starts a paragraph, single newlines are kept (white-space: pre-line).
  function paras(text, cls) { return String(text || '').split(/\n\s*\n/).map(function (p) { return h('p', { class: cls || null, text: p }); }); }
  function setText(el, t) { if (el.textContent !== t) el.textContent = t; }
  function syncChildren(parent, list) {
    list.forEach(function (el, i) { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
    while (parent.children.length > list.length) parent.removeChild(parent.lastElementChild);
  }
  var reduced = function () { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); };
  var narrow = function () { return !!(root.matchMedia && root.matchMedia('(max-width: 767.98px)').matches); };

  function mount(container, opts) {
    opts = opts || {};
    var rt = opts.runtime;
    var doc = rt.doc;
    var assetsBase = opts.assetsBase || '';
    var captionUrls = Object.create(null); // one blob per caption asset for this mount, shared across revisits
    var id = 'cfl' + (++uid);
    var dict = function () { return Object.create(null); };
    var ui = dict();         // block id -> presentation state
    var built = dict();      // block id -> {key, el}
    var reached = dict();    // block ids already reported with `reach`
    var shownLesson;         // lesson id (or null for the cover) currently built into <main>
    var sideKey = null, searchKey = null, quizKey = null, pendingFocus = null, drawer = false, seen = rt.trace.length, started = false;
    var collapsed = dict();  // section id -> collapsed by the learner
    var url = function (p) { return p ? assetsBase + String(p).split('/').map(encodeURIComponent).join('/') : ''; };
    var k = function (blockId, part) { return blockId + ':' + part; }; // data-k focus keys survive rebuilds

    // ---------- skeleton ----------
    var live = h('div', { class: 'cfl-sr', 'aria-live': 'polite' });
    var menuBtn = h('button', { type: 'button', class: 'cfl-iconbtn cfl-menu-btn', 'aria-controls': id + '-side', 'aria-expanded': 'false', onclick: function () { setDrawer(!drawer); } }, [icon('menu'), h('span', { text: 'Menu' })]);
    var topTitle = h('span', { class: 'cfl-top-title' });
    var topProgress = h('span', { class: 'cfl-top-progress' });
    var topbar = h('header', { class: 'cfl-topbar' }, [menuBtn, topTitle, topProgress]);
    var homeLink = h('a', { class: 'cfl-home', href: '#/', 'data-k': 'side:home' });
    var progressBar = h('progress', { class: 'cfl-progress', max: '100', value: '0', 'aria-label': 'Course progress' });
    var progressText = h('p', { class: 'cfl-progress-text' });
    var closeBtn = h('button', { type: 'button', class: 'cfl-iconbtn cfl-close', onclick: function () { setDrawer(false); menuBtn.focus(); } }, [icon('cross'), sr('Close menu')]);
    var searchInput = h('input', { type: 'search', id: id + '-q', class: 'cfl-search-input', autocomplete: 'off', spellcheck: 'false', placeholder: 'Search lessons',
      oninput: function () { send({ type: 'search', q: searchInput.value }); } });
    var searchStatus = h('p', { class: 'cfl-search-status', 'aria-live': 'polite' });
    var searchResults = h('ul', { class: 'cfl-results' });
    var searchBox = h('form', { role: 'search', class: 'cfl-search', onsubmit: function (e) { e.preventDefault(); } }, [
      h('label', { class: 'cfl-sr', for: id + '-q', text: 'Search lessons' }), icon('search'), searchInput, searchStatus, searchResults]);
    var outline = h('div', { class: 'cfl-outline' });
    var side = h('nav', { class: 'cfl-side', id: id + '-side', 'aria-label': 'Course outline' }, [
      h('div', { class: 'cfl-side-head' }, [homeLink, closeBtn]), h('div', { class: 'cfl-side-progress' }, [progressBar, progressText]), searchBox, outline]);
    var mainEl = h('main', { class: 'cfl-main', id: id + '-main', tabindex: '-1' });
    var skip = h('a', { class: 'cfl-skip', href: '#' + id + '-main', onclick: function (e) { e.preventDefault(); var t = mainEl.querySelector('h1') || mainEl; t.focus(); } }, ['Skip to lesson content']);
    var scrim = h('div', { class: 'cfl-scrim', onclick: function () { setDrawer(false); } });
    var rootEl = h('div', { class: 'cfl' }, [skip, topbar, h('div', { class: 'cfl-layout' }, [side, mainEl]), scrim, live]);
    var theme = (doc.player && doc.player.theme) || {};
    Object.keys(theme).forEach(function (n) { if (/^[a-z][a-z0-9-]*$/.test(n)) rootEl.style.setProperty('--cf-' + n, theme[n]); });
    if (doc.player && doc.player.navigation === 'restricted') searchBox.hidden = true; // D [NAV]: no search under restricted navigation
    container.appendChild(rootEl);

    function setDrawer(open) {
      drawer = open && narrow();
      rootEl.classList.toggle('is-open', drawer);
      menuBtn.setAttribute('aria-expanded', String(drawer));
      mainEl.inert = drawer; topbar.inert = drawer;
      if (drawer) { var first = side.querySelector('a[href], button, input'); if (first) first.focus(); }
    }
    side.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawer) { setDrawer(false); menuBtn.focus(); } });
    var mq = root.matchMedia ? root.matchMedia('(max-width: 767.98px)') : null;
    var onMq = function () { if (mq && !mq.matches && drawer) setDrawer(false); };
    if (mq && mq.addEventListener) mq.addEventListener('change', onMq);

    // ---------- runtime plumbing ----------
    function send(ev) {
      try { rt.dispatch(ev); } catch (e) { if (root.console) root.console.error('CFLessons: dispatch failed', ev, e); }
      var t = rt.trace;
      if (t.length > seen) { var fresh = t.slice(seen); seen = t.length; if (opts.onTrace) { try { opts.onTrace(fresh, rt); } catch (e) { if (root.console) root.console.error(e); } } }
      render();
    }
    function announce(text) { live.textContent = ''; setTimeout(function () { live.textContent = text; }, 30); }
    function focusKey(key) { var t = key && rootEl.querySelector('[data-k="' + key + '"]'); if (t && !t.disabled) { t.focus(); return true; } return false; }

    // ---------- observers: reach + end ----------
    var io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var b = en.target.getAttribute('data-block');
        io.unobserve(en.target);
        if (b) { if (!reached[b]) { reached[b] = true; send({ type: 'reach', block: b }); } } else send({ type: 'end' });
      });
    }, { rootMargin: '0px 0px -8% 0px' }) : null;
    var endMark = h('div', { class: 'cfl-end', 'aria-hidden': 'true' });

    // ---------- hash routing (L24): #/<lesson id>, #/ = cover ----------
    function hashLesson() { var m = /^#\/([a-z][a-z0-9-]*)?$/.exec(root.location.hash); return m ? (m[1] || null) : undefined; }
    function syncHash(push) {
      var want = '#/' + (rt.state.lesson || '');
      if (root.location.hash === want) return;
      try { if (push) root.history.pushState(null, '', want); else root.history.replaceState(null, '', want); } catch (e) { /* sandboxed frames */ }
    }
    function onHash() {
      var l = hashLesson();
      if (l === undefined || l === rt.state.lesson) return;
      if (l === null) send({ type: 'open' }); else send({ type: 'open', lesson: l });
      syncHash(false); // a locked or unknown lesson snaps the address back
    }
    root.addEventListener('hashchange', onHash);
    root.addEventListener('popstate', onHash);

    // ---------- sidebar ----------
    function renderSide(v) {
      setText(homeLink, doc.title);
      setText(topTitle, doc.title);
      progressBar.value = v.progress;
      setText(progressText, v.progress + '% complete');
      setText(topProgress, v.progress + '%');
      var key = JSON.stringify(v.outline);
      if (key !== sideKey) {
        var had = rootEl.contains(document.activeElement) && outline.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null;
        sideKey = key;
        outline.textContent = '';
        var n = 0;
        v.outline.forEach(function (s) {
          var items = s.lessons.map(function (l) {
            n++;
            var label = [h('span', { class: 'cfl-ol-num', 'aria-hidden': 'true', text: String(n) }), h('span', { class: 'cfl-ol-title', text: l.title })];
            var mark = l.complete ? [icon('check'), sr('(complete)')] : l.locked ? [icon('lock'), sr('(locked)')] : l.progress ? [h('span', { class: 'cfl-ol-pct', text: l.progress + '%' })] : [];
            var attrs = { class: 'cfl-ol-link' + (l.complete ? ' is-done' : ''), 'data-k': 'side:' + l.id, 'aria-current': l.current ? 'page' : null };
            if (l.locked && !l.current) { attrs['aria-disabled'] = 'true'; attrs.class += ' is-locked'; }
            else { attrs.href = '#/' + l.id; attrs.onclick = function () { if (drawer) setDrawer(false); }; }
            return h('li', {}, [h('a', attrs, label.concat([h('span', { class: 'cfl-ol-mark' }, mark)]))]);
          });
          var list = h('ul', { class: 'cfl-ol-list' }, items);
          // Sections are labels (D [OUT]); learners can collapse them (D [NAV]). An empty title shows no header.
          if (!s.title) { outline.appendChild(list); return; }
          var det = h('details', { class: 'cfl-ol-section', open: !collapsed[s.id] }, [h('summary', { 'data-k': 'side:sec-' + s.id }, [h('span', { text: s.title }), icon('chevron')]), list]);
          det.addEventListener('toggle', function () { collapsed[s.id] = !det.open; });
          outline.appendChild(det);
        });
        if (had) focusKey(had);
      }
      if (v.search) {
        var skey = JSON.stringify(v.search);
        if (skey !== searchKey) {
          searchKey = skey;
          searchResults.textContent = '';
          v.search.results.forEach(function (r) {
            searchResults.appendChild(h('li', {}, [h('a', { href: '#/' + r.lesson, class: 'cfl-result', onclick: function () { if (drawer) setDrawer(false); } }, [h('span', { class: 'cfl-result-title', text: r.title }), h('span', { class: 'cfl-result-snip', text: r.snippet })])]));
          });
          setText(searchStatus, v.search.q ? (v.search.results.length ? v.search.results.length + (v.search.results.length === 1 ? ' lesson matches' : ' lessons match') : 'No lessons match “' + v.search.q + '”') : '');
        }
      }
    }

    // ---------- cover ----------
    function buildCover(v) {
      var c = v.course;
      var lessons = v.outline.reduce(function (n, s) { return n + s.lessons.length; }, 0);
      var start = h('button', { type: 'button', class: 'cfl-btn cfl-primary cfl-start', 'data-k': 'cover:start', onclick: function () { send({ type: 'next' }); } }, [v.started ? 'Resume' : 'Start course', icon('right')]);
      return h('div', { class: 'cfl-cover' }, [
        c.cover ? h('img', { class: 'cfl-cover-img', src: url(c.cover.src), alt: c.cover.alt || '' }) : null,
        h('div', { class: 'cfl-cover-body' }, [
          h('h1', { tabindex: '-1', class: 'cfl-cover-title', text: c.title }),
          c.description ? h('div', { class: 'cfl-cover-desc' }, paras(c.description)) : null,
          h('p', { class: 'cfl-meta', text: lessons + (lessons === 1 ? ' lesson' : ' lessons') + (v.progress ? ' · ' + v.progress + '% complete' : '') }),
          h('div', { class: 'cfl-cover-actions' }, [start, v.started ? h('button', { type: 'button', class: 'cfl-btn cfl-quiet', onclick: function () { send({ type: 'restart' }); announce('Progress cleared.'); } }, ['Start over']) : null]),
        ]),
      ]);
    }

    // ---------- lesson frame ----------
    var blocksEl, footerEl, quizEl;
    function buildLesson(L, v) {
      blocksEl = h('div', { class: 'cfl-blocks' });
      quizEl = h('div', { class: 'cfl-quiz' });
      footerEl = h('nav', { class: 'cfl-lesson-nav', 'aria-label': 'Lesson navigation' });
      return h('article', { class: 'cfl-lesson' }, [
        h('header', { class: 'cfl-lesson-head' }, [
          h('h1', { tabindex: '-1', class: 'cfl-lesson-title', text: L.title }),
          h('p', { class: 'cfl-meta' }, [L.section ? L.section + ' · ' : '', 'Lesson ' + (L.index + 1) + ' of ' + L.count]),
        ]),
        L.kind === 'quiz' ? quizEl : blocksEl,
        endMark,
        footerEl,
      ]);
    }
    function renderFooter(v) {
      var key = JSON.stringify(v.nav) + v.lesson.complete;
      if (footerEl._k === key) return;
      footerEl._k = key;
      footerEl.textContent = '';
      [['prev', 'Previous lesson', 'left'], ['next', 'Next lesson', 'right']].forEach(function (d) {
        var t = v.nav[d[0]];
        if (!t) { footerEl.appendChild(h('span', { class: 'cfl-nav-gap' })); return; }
        var kids = [h('span', { class: 'cfl-nav-dir' }, d[0] === 'prev' ? [icon('left'), d[1]] : [d[1], icon(t.locked ? 'lock' : 'right')]), h('span', { class: 'cfl-nav-title', text: t.title })];
        footerEl.appendChild(h('button', { type: 'button', class: 'cfl-nav cfl-nav-' + d[0], 'data-k': 'nav:' + d[0], 'aria-disabled': t.locked ? 'true' : null, 'aria-describedby': t.locked ? id + '-lockhint' : null,
          onclick: function () { if (!t.locked) send({ type: d[0] }); } }, kids));
      });
      if (v.nav.next && v.nav.next.locked) footerEl.appendChild(h('p', { class: 'cfl-lock-hint', id: id + '-lockhint', text: 'Complete this lesson to unlock the next one.' }));
    }

    // ---------- blocks ----------
    function wrap(b, kids, extra) {
      var st = b.style || {};
      var cls = 'cfl-block cfl-b-' + b.type + ' cfl-w-' + (st.width || (b.type === 'gallery' || b.type === 'labeledGraphic' || b.type === 'scenario' ? 'wide' : 'normal')) + (st.padding ? ' cfl-p-' + st.padding : '') + (st.align ? ' cfl-a-' + st.align : '') + (st.background ? ' cfl-has-bg' : '') + (extra ? ' ' + extra : '');
      var el = h('div', { class: cls, 'data-block': b.id }, kids);
      if (st.background) el.style.setProperty('background-color', st.background);
      if (st.color) el.style.setProperty('color', st.color);
      return el;
    }
    function itemSeen(b, i) { return b.seen && b.seen.indexOf(i) >= 0; }
    function seenMark(b, i) { return itemSeen(b, i) ? h('span', { class: 'cfl-seen' }, [icon('check'), sr('(viewed)')]) : null; }
    function U(b, init) { return ui[b.id] || (ui[b.id] = init); }
    function local(fn) { return function (e) { fn(e); render(); }; }

    var RENDER = {
      heading: function (b) { return wrap(b, [h('h' + b.level, { class: 'cfl-h', text: b.text })]); },
      text: function (b) { return wrap(b, paras(b.text)); },
      list: function (b) {
        if (b.kind === 'checkbox') {
          return wrap(b, [h('ul', { class: 'cfl-checklist' }, b.items.map(function (t, i) {
            return h('li', {}, [h('label', {}, [h('input', { type: 'checkbox', 'data-k': k(b.id, i), checked: itemSeen(b, i), onchange: function () { send({ type: 'item', block: b.id, index: i }); } }), h('span', { text: t })])]);
          }))]);
        }
        return wrap(b, [h(b.kind === 'numbered' ? 'ol' : 'ul', { class: 'cfl-list' }, b.items.map(function (t) { return h('li', { text: t }); }))]);
      },
      quote: function (b) { return wrap(b, [h('figure', { class: 'cfl-quote' }, [h('blockquote', {}, paras(b.text)), b.cite ? h('figcaption', { text: b.cite }) : null])]); },
      divider: function (b) { return wrap(b, [h('hr', {})]); },
      image: function (b) { return wrap(b, [h('figure', { class: 'cfl-figure' }, [h('img', { src: url(b.src), alt: b.alt, loading: 'lazy' }), b.caption ? h('figcaption', { text: b.caption }) : null])]); },
      imageText: function (b) { return wrap(b, [h('div', { class: 'cfl-it cfl-it-' + b.side }, [h('img', { src: url(b.src), alt: b.alt, loading: 'lazy' }), h('div', { class: 'cfl-it-text' }, paras(b.text))])]); },
      gallery: function (b) {
        return wrap(b, [h('ul', { class: 'cfl-gallery cfl-cols-' + b.columns }, b.items.map(function (x) {
          return h('li', {}, [h('figure', { class: 'cfl-figure' }, [h('img', { src: url(x.src), alt: x.alt, loading: 'lazy' }), x.caption ? h('figcaption', { text: x.caption }) : null])]);
        }))]);
      },
      video: function (b) { return media(b, 'video'); },
      audio: function (b) { return media(b, 'audio'); },
      accordion: function (b) {
        var u = U(b, { open: {} });
        return wrap(b, [h('div', { class: 'cfl-acc' }, b.items.map(function (x, i) {
          var open = !!u.open[i], hid = id + '-' + b.id + '-h' + i, pid = id + '-' + b.id + '-p' + i;
          return h('div', { class: 'cfl-acc-item' + (open ? ' is-open' : '') }, [
            h('button', { type: 'button', class: 'cfl-acc-head', id: hid, 'aria-expanded': String(open), 'aria-controls': pid, 'data-k': k(b.id, i), onclick: function () {
              u.open[i] = !open;
              if (!open) send({ type: 'item', block: b.id, index: i }); else render();
            } }, [h('span', { class: 'cfl-acc-title', text: x.title }), seenMark(b, i), icon('chevron')]),
            h('div', { class: 'cfl-acc-panel', id: pid, role: 'region', 'aria-labelledby': hid, hidden: !open }, paras(x.text)),
          ]);
        }))]);
      },
      tabs: function (b) {
        var u = U(b, { tab: 0 });
        var select = function (i, focus) { u.tab = i; if (focus) pendingFocus = k(b.id, 'tab' + i); send({ type: 'item', block: b.id, index: i }); };
        var tabs = b.items.map(function (x, i) {
          var on = u.tab === i;
          return h('button', { type: 'button', role: 'tab', id: id + '-' + b.id + '-t' + i, 'aria-selected': String(on), 'aria-controls': id + '-' + b.id + '-tp', tabindex: on ? '0' : '-1', 'data-k': k(b.id, 'tab' + i), class: 'cfl-tab',
            onclick: function () { select(i, true); },
            onkeydown: function (e) { // D [KB]: Left/Right with wrap; Home/End
              var n = b.items.length, to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
              if (to === undefined) return; e.preventDefault(); select(to, true);
            } }, [h('span', { text: x.title }), seenMark(b, i)]);
        });
        var cur = b.items[u.tab] || b.items[0];
        return wrap(b, [h('div', { class: 'cfl-tabs' }, [
          h('div', { role: 'tablist', class: 'cfl-tablist', 'aria-label': 'Tabs' }, tabs),
          h('div', { role: 'tabpanel', class: 'cfl-tabpanel', id: id + '-' + b.id + '-tp', 'aria-labelledby': id + '-' + b.id + '-t' + u.tab, tabindex: '0' }, paras(cur.text)),
        ])]);
      },
      flashcards: function (b) {
        var u = U(b, { flipped: {} });
        return wrap(b, [h('ul', { class: 'cfl-cards' }, b.items.map(function (x, i) {
          var on = !!u.flipped[i];
          return h('li', {}, [h('button', { type: 'button', class: 'cfl-card' + (on ? ' is-flipped' : ''), 'aria-pressed': String(on), 'data-k': k(b.id, i), onclick: function () {
            u.flipped[i] = !on;
            if (!on) send({ type: 'item', block: b.id, index: i }); else render();
          } }, [h('span', { class: 'cfl-card-inner' }, [
            h('span', { class: 'cfl-card-face cfl-card-front', 'aria-hidden': on ? 'true' : null }, [h('span', { class: 'cfl-card-text', text: x.front }), h('span', { class: 'cfl-card-hint' }, [icon('flip'), 'Flip'])]),
            h('span', { class: 'cfl-card-face cfl-card-back', 'aria-hidden': on ? null : 'true' }, [h('span', { class: 'cfl-card-text', text: x.back }), h('span', { class: 'cfl-card-hint' }, [icon('flip'), 'Flip back'])]),
          ]), sr(' (card ' + (i + 1) + ' of ' + b.items.length + ')')])]);
        }))]);
      },
      labeledGraphic: function (b) {
        var u = U(b, { open: -1 });
        var pid = id + '-' + b.id + '-panel';
        var close = function () { var was = u.open; u.open = -1; pendingFocus = k(b.id, was); render(); };
        var markers = b.items.map(function (x, i) {
          var on = u.open === i;
          var m = h('button', { type: 'button', class: 'cfl-marker' + (on ? ' is-open' : '') + (itemSeen(b, i) ? ' is-seen' : ''), 'aria-expanded': String(on), 'aria-controls': pid, 'data-k': k(b.id, i),
            onclick: function () { if (on) { close(); return; } u.open = i; send({ type: 'item', block: b.id, index: i }); },
            onkeydown: function (e) { if (e.key === 'Escape' && on) { e.preventDefault(); close(); } } }, [h('span', { 'aria-hidden': 'true', text: String(i + 1) }), sr('Marker ' + (i + 1) + ': ' + x.title + (itemSeen(b, i) ? ' (viewed)' : ''))]);
          m.style.setProperty('left', x.x + '%'); m.style.setProperty('top', x.y + '%');
          return m;
        });
        var openItem = b.items[u.open];
        return wrap(b, [h('div', { class: 'cfl-lg' }, [
          h('div', { class: 'cfl-lg-stage' }, [h('img', { src: url(b.src), alt: b.alt })].concat(markers)),
          h('div', { class: 'cfl-lg-panel', id: pid, role: 'region', 'aria-label': 'Marker details', 'aria-live': 'polite', hidden: !openItem, onkeydown: function (e) { if (e.key === 'Escape') { e.preventDefault(); close(); } } }, openItem ? [
            h('p', { class: 'cfl-lg-title', text: (u.open + 1) + '. ' + openItem.title }), h('div', {}, paras(openItem.text)),
            h('button', { type: 'button', class: 'cfl-btn cfl-quiet', 'data-k': k(b.id, 'close'), onclick: close }, ['Close']),
          ] : []),
        ])]);
      },
      process: function (b) {
        var n = b.items.length;
        var u = U(b, { step: b.intro ? -1 : 0 });
        var go = function (s) { u.step = s; pendingFocus = k(b.id, 'body'); if (s >= 0 && s < n) send({ type: 'item', block: b.id, index: s }); else render(); };
        var body, nav = [];
        if (u.step < 0) {
          body = [h('div', { class: 'cfl-proc-text' }, paras(b.intro))];
          nav = [h('button', { type: 'button', class: 'cfl-btn cfl-primary', 'data-k': k(b.id, 'start'), onclick: function () { go(0); } }, ['Start', icon('right')])];
        } else if (u.step >= n) {
          body = [h('div', { class: 'cfl-proc-text' }, paras(b.summary))];
          nav = [h('button', { type: 'button', class: 'cfl-btn', 'data-k': k(b.id, 'again'), onclick: function () { go(b.intro ? -1 : 0); } }, [icon('retry'), 'Start again'])];
        } else {
          var x = b.items[u.step];
          body = [h('p', { class: 'cfl-meta', text: 'Step ' + (u.step + 1) + ' of ' + n }), h('p', { class: 'cfl-proc-title', text: x.title }), h('div', { class: 'cfl-proc-text' }, paras(x.text))];
          var canPrev = u.step > 0 || !!b.intro, canNext = u.step < n - 1 || !!b.summary;
          nav = [
            h('button', { type: 'button', class: 'cfl-btn', 'data-k': k(b.id, 'prev'), disabled: !canPrev, onclick: function () { go(u.step - 1); } }, [icon('left'), 'Previous']),
            h('span', { class: 'cfl-dots', 'aria-hidden': 'true' }, b.items.map(function (_, i) { return h('span', { class: 'cfl-dot' + (i === u.step ? ' is-on' : itemSeen(b, i) ? ' is-seen' : '') }); })),
            h('button', { type: 'button', class: 'cfl-btn cfl-primary', 'data-k': k(b.id, 'next'), disabled: !canNext, onclick: function () { go(u.step + 1); } }, ['Next', icon('right')]),
          ];
        }
        // D [PROC][KB]: Left/Right change steps
        return wrap(b, [h('div', { class: 'cfl-proc', onkeydown: function (e) {
          if (e.target.tagName === 'INPUT') return;
          if (e.key === 'ArrowRight' && u.step < (b.summary ? n : n - 1)) { e.preventDefault(); go(u.step + 1); }
          if (e.key === 'ArrowLeft' && u.step > (b.intro ? -1 : 0)) { e.preventDefault(); go(u.step - 1); }
        } }, [h('div', { class: 'cfl-proc-body', tabindex: '-1', 'data-k': k(b.id, 'body'), 'aria-live': 'polite' }, body), h('div', { class: 'cfl-proc-nav' }, nav)])]);
      },
      timeline: function (b) {
        return wrap(b, [h('ol', { class: 'cfl-tl' }, b.items.map(function (x) {
          return h('li', {}, [x.date ? h('p', { class: 'cfl-tl-date', text: x.date }) : null, h('p', { class: 'cfl-tl-title', text: x.title }), h('div', {}, paras(x.text))]);
        }))]);
      },
      button: function (b) {
        var cta;
        if (b.url) cta = h('a', { class: 'cfl-btn cfl-primary', href: b.url, target: '_blank', rel: 'noopener noreferrer', 'data-k': k(b.id, 'go') }, [b.label, icon('right'), sr(' (opens in a new tab)')]);
        else cta = h('button', { type: 'button', class: 'cfl-btn cfl-primary', 'data-k': k(b.id, 'go'), 'aria-disabled': b.target.locked ? 'true' : null,
          onclick: function () { if (!b.target.locked) send({ type: 'open', lesson: b.toLesson }); } }, [b.label, icon(b.target.locked ? 'lock' : 'right')]);
        return wrap(b, [h('div', { class: 'cfl-cta' }, [b.text ? h('div', { class: 'cfl-cta-text' }, paras(b.text)) : null, cta, b.target && b.target.locked ? h('p', { class: 'cfl-lock-hint', text: 'Locked until the earlier lessons are complete.' }) : null])]);
      },
      continue: function (b) {
        if (b.passed) return wrap(b, [], 'is-passed'); // C [CONT]: the button disappears once used
        var hint = b.missing.length ? (b.missing.length > 1 ? 'Complete the activities above to continue.' : 'Complete the activity above to continue.') : '';
        return wrap(b, [h('div', { class: 'cfl-gate' }, [
          h('button', { type: 'button', class: 'cfl-btn cfl-primary', 'data-k': k(b.id, 'go'), 'aria-describedby': hint ? id + '-' + b.id + '-hint' : null, onclick: function () {
            if (b.missing.length) { announce(hint); return; }
            pendingFocus = 'after:' + b.id; // the first block the gate reveals
            send({ type: 'continue', block: b.id });
          } }, [b.label || 'Continue', icon('chevron')]),
          hint ? h('p', { class: 'cfl-gate-hint', id: id + '-' + b.id + '-hint', text: hint }) : null,
        ])]);
      },
      question: function (b) {
        return wrap(b, [questionForm(b, {
          prefix: b.id, title: 'Knowledge check',
          after: b.result ? [b.canRetry ? h('button', { type: 'button', class: 'cfl-btn', 'data-k': k(b.id, 'retry'), onclick: function () { pendingFocus = k(b.id, 'first'); send({ type: 'retry', block: b.id }); } }, [icon('retry'), 'Take again']) : null] : [],
          send: function (ev) { ev.block = b.id; send(ev); },
        })]);
      },
      sorting: function (b) {
        var cats = b.categories;
        if (b.done && b.current === null) {
          return wrap(b, [h('div', { class: 'cfl-panel cfl-sort' }, [
            h('p', { class: 'cfl-panel-title', text: 'Sorting complete' }),
            h('p', { role: 'status', text: b.firstTry + ' of ' + b.items.length + ' correct on the first try.' }),
            sortedLists(b),
            h('button', { type: 'button', class: 'cfl-btn', 'data-k': k(b.id, 'retry'), onclick: function () { pendingFocus = k(b.id, 'c0'); send({ type: 'retry', block: b.id }); } }, [icon('retry'), 'Retry']),
          ])]);
        }
        var card = b.items[b.current];
        var wrong = b.last && !b.last.ok && b.last.item === b.current;
        var status = !b.last ? '' : b.last.ok ? 'Correct: placed in ' + cats[b.items[b.last.item].category] + '.' : 'Not that one. Try another category.';
        return wrap(b, [h('div', { class: 'cfl-panel cfl-sort' }, [
          h('p', { class: 'cfl-meta', text: 'Card ' + (b.placed.length + 1) + ' of ' + b.items.length + ' · choose its category' }),
          h('p', { class: 'cfl-sort-card' + (wrong ? ' is-wrong' : ''), text: card.text }),
          h('div', { class: 'cfl-sort-cats', role: 'group', 'aria-label': 'Categories' }, cats.map(function (c, ci) {
            return h('button', { type: 'button', class: 'cfl-btn cfl-sort-cat', 'data-k': k(b.id, 'c' + ci), onclick: function () { pendingFocus = k(b.id, 'c' + ci); send({ type: 'sort', block: b.id, item: b.current, category: ci }); } }, [c]);
          })),
          h('p', { class: 'cfl-sort-status' + (b.last && b.last.ok ? ' is-ok' : wrong ? ' is-bad' : ''), role: 'status', text: status }),
          b.placed.length ? sortedLists(b) : null,
        ])]);
      },
      // one step at a time; every step moves focus to its text (the step element is rebuilt, so focus is the announcement).
      scenario: function (b) {
        var go = function (ev) { return function () { pendingFocus = k(b.id, 'say'); ev.block = b.id; send(ev); }; };
        var say = function (kids, cls) { return h('div', { class: 'cfl-scn-say' + (cls ? ' ' + cls : ''), tabindex: '-1', 'data-k': k(b.id, 'say') }, kids); };
        var onward = function (last) { return h('div', { class: 'cfl-q-actions' }, [h('button', { type: 'button', class: 'cfl-btn cfl-primary', 'data-k': k(b.id, 'next'), onclick: go({ type: 'continue' }) }, [last ? 'Finish' : 'Continue', icon('right')])]); };
        var body;
        if (b.ended) {
          body = [say([h('p', { class: 'cfl-panel-title', text: 'End of the scenario' })].concat(b.ending ? paras(b.ending) : [])),
            h('div', { class: 'cfl-q-actions' }, [h('button', { type: 'button', class: 'cfl-btn', 'data-k': k(b.id, 'again'), onclick: go({ type: 'retry' }) }, [icon('retry'), 'Start over'])])];
        } else if (b.feedback) {
          body = [say([h('p', { class: 'cfl-scn-you' }, [h('span', { class: 'cfl-scn-you-label', text: 'Your response' }), b.feedback.text]), h('div', { class: 'cfl-scn-fb' }, paras(b.feedback.feedback))]), onward(b.feedback.last)];
        } else if (b.item.kind === 'dialogue') {
          body = [say(paras(b.item.text), 'is-line'), h('div', { class: 'cfl-scn-resps', role: 'group', 'aria-label': 'Your response' }, b.item.responses.map(function (r) {
            return h('button', { type: 'button', class: 'cfl-btn cfl-scn-resp', 'data-k': k(b.id, 'r-' + r.id), onclick: go({ type: 'respond', response: r.id }) }, [r.text]);
          }))];
        } else body = [say(paras(b.item.text), 'is-narration'), onward(b.item.last)];
        return wrap(b, [h('div', { class: 'cfl-scn' + (b.character ? ' has-char' : '') + (b.background ? ' has-bg' : '') }, [
          b.background ? h('img', { class: 'cfl-scn-bg', src: url(b.background.src), alt: b.background.alt }) : null,
          b.character ? h('img', { class: 'cfl-scn-char', src: url(b.character.src), alt: b.character.alt }) : null,
          h('div', { class: 'cfl-scn-panel' + (b.item.kind === 'dialogue' && !b.feedback && !b.ended ? ' is-speech' : '') }, body),
        ])]);
      },
    };
    function sortedLists(b) {
      return h('div', { class: 'cfl-sort-done' }, b.categories.map(function (c, ci) {
        var got = b.placed.filter(function (i) { return b.items[i].category === ci; });
        return h('div', {}, [h('p', { class: 'cfl-sort-head', text: c }), h('ul', {}, got.map(function (i) { return h('li', { text: b.items[i].text }); }))]);
      }));
    }
    function media(b, tag) {
      var kids = [h('source', { src: url(b.src) })];
      if (b.captionsSrc) {
        var text = (opts.captions || {})[b.captions];
        var src = url(b.captionsSrc);
        if (typeof text === 'string') {
          if (!captionUrls[b.captions]) captionUrls[b.captions] = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
          src = captionUrls[b.captions];
        }
        kids.push(h('track', { kind: 'captions', src: src, srclang: doc.language || 'en', label: 'Captions', default: true }));
      }
      var el = h(tag, { controls: true, preload: 'metadata', playsinline: tag === 'video' ? true : null, 'data-k': k(b.id, 'media'), 'aria-label': b.title || (tag === 'video' ? 'Video' : 'Audio'),
        onended: function () { send({ type: 'item', block: b.id, index: 0 }); } }, kids);
      return wrap(b, [b.title ? h('p', { class: 'cfl-media-title', text: b.title }) : null, el, b.done ? h('p', { class: 'cfl-meta' }, [icon('check'), ' Played to the end']) : null]);
    }

    // Shared by knowledge checks and quiz questions. q = questionView from the runtime.
    function questionForm(q, o) {
      var name = id + '-' + o.prefix;
      var done = !!q.result;
      var first = true;
      var fk = function (part) { var key = k(o.prefix, first ? 'first' : part); first = false; return key; };
      var body;
      if (q.kind === 'fill') {
        body = [h('input', { type: 'text', class: 'cfl-answer', 'aria-label': 'Your answer', autocomplete: 'off', spellcheck: 'false', 'data-k': fk('text'), value: q.text || '', disabled: done,
          oninput: function (e) { // the input is not rebuilt while typing, so Submit is enabled here
            var btn = e.target.form && e.target.form.querySelector('button[type=submit]');
            if (btn) btn.disabled = !e.target.value.trim();
            o.send({ type: 'input', text: e.target.value });
          } })];
        if (done && q.answers) body.push(h('p', { class: 'cfl-reveal', text: 'Accepted answer: ' + q.answers.join(' or ') }));
      } else if (q.kind === 'matching') {
        var rightText = function (ix) { var r = q.right.filter(function (x) { return x.index === ix; })[0]; return r ? r.text : null; };
        body = [h('ul', { class: 'cfl-match' }, q.left.map(function (l) {
          var sid = name + '-m' + l.index;
          var state = done && l.correct !== undefined ? (rightText(l.match) === rightText(l.correct) ? 'ok' : 'bad') : '';
          return h('li', { class: state ? 'is-' + state : null }, [
            h('label', { for: sid, text: l.text }),
            h('select', { id: sid, 'data-k': fk('m' + l.index), disabled: done, onchange: function (e) { o.send({ type: 'match', left: l.index, right: e.target.value === '' ? null : Number(e.target.value) }); } },
              [h('option', { value: '', text: 'Choose a match' })].concat(q.right.map(function (r) { return h('option', { value: String(r.index), selected: l.match === r.index, text: r.text }); }))),
            state === 'bad' ? h('p', { class: 'cfl-reveal', text: 'Correct match: ' + rightText(l.correct) }) : null,
          ]);
        }))];
      } else {
        body = q.choices.map(function (c) {
          var state = done && c.correct !== undefined ? (c.correct ? 'ok' : c.selected ? 'bad' : '') : done && c.selected ? 'picked' : '';
          return h('label', { class: 'cfl-choice' + (c.selected ? ' is-selected' : '') + (state ? ' is-' + state : '') }, [
            h('input', { type: q.kind === 'mr' ? 'checkbox' : 'radio', name: name, value: c.id, checked: c.selected, disabled: done, 'data-k': fk(c.id), onchange: function () { o.send({ type: 'choose', choice: c.id }); } }),
            h('span', { class: 'cfl-choice-label', text: c.label }),
            state === 'ok' ? h('span', { class: 'cfl-choice-mark' }, [icon('check'), sr(c.selected ? '(your answer, correct)' : '(correct answer)')]) : state === 'bad' ? h('span', { class: 'cfl-choice-mark' }, [icon('cross'), sr('(your answer, incorrect)')]) : null,
          ]);
        });
      }
      var answered = q.kind === 'fill' ? !!(q.text || '').trim() : q.kind === 'matching' ? q.left.every(function (l) { return l.match !== null && l.match !== undefined; }) : q.choices.some(function (c) { return c.selected; });
      var fb = done && o.feedback !== false ? h('div', { class: 'cfl-fb is-' + q.result, role: 'status', tabindex: '-1', 'data-k': k(o.prefix, 'fb') }, [
        h('p', { class: 'cfl-fb-head' }, [icon(q.result === 'correct' ? 'check' : 'cross'), q.result === 'correct' ? 'Correct' : 'Incorrect']),
        q.feedback ? h('div', { class: 'cfl-fb-text' }, paras(q.feedback)) : null,
      ]) : null;
      var submit = done ? null : h('button', { type: 'submit', class: 'cfl-btn cfl-primary', 'data-k': k(o.prefix, 'submit'), disabled: !answered }, ['Submit']);
      return h('form', { class: 'cfl-panel cfl-q', novalidate: true, onsubmit: function (e) {
        e.preventDefault();
        var typed = e.target.querySelector('.cfl-answer');
        if (!done && (answered || (typed && typed.value.trim()))) { pendingFocus = o.focusAfter || k(o.prefix, 'fb') + '|' + k(o.prefix, 'after'); o.send({ type: 'submit' }); }
      } }, [
        h('fieldset', {}, [h('legend', { class: 'cfl-q-prompt', text: q.prompt }), q.kind === 'mr' && !done ? h('p', { class: 'cfl-meta', text: 'Select all that apply.' }) : null].concat(body)),
        fb,
        h('div', { class: 'cfl-q-actions', tabindex: '-1', 'data-k': k(o.prefix, 'after') }, [submit].concat(o.after || [])),
      ]);
    }

    // ---------- quiz lessons ----------
    function renderQuiz(L) {
      var Q = L.quiz;
      // Typed text lives in the input itself; leaving it out of the key keeps the caret where the learner is typing.
      var key = JSON.stringify(Q, function (kk, v) { return kk === 'text' && typeof v === 'string' && Q.phase === 'question' ? undefined : v; });
      if (key === quizKey) return;
      var had = rootEl.contains(document.activeElement) && quizEl.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null;
      quizKey = key;
      quizEl.textContent = '';
      var attemptsLeft = Q.attempts ? Q.attempts - Q.attempt : null;
      var facts = Q.count + (Q.count === 1 ? ' question' : ' questions') + ' · pass mark ' + Q.passPercent + '%' + (Q.attempts ? ' · ' + attemptsLeft + ' of ' + Q.attempts + ' attempts left' : '');
      var cont = function () { pendingFocus = 'quiz:head'; send({ type: 'continue' }); };
      if (Q.phase === 'intro') {
        quizEl.appendChild(h('div', { class: 'cfl-panel cfl-quiz-intro' }, [
          h('p', { class: 'cfl-quiz-facts', text: facts }),
          h('p', { text: 'Answer each question and submit it to move on. Your score appears at the end.' }),
          h('button', { type: 'button', class: 'cfl-btn cfl-primary', 'data-k': 'quiz:start', onclick: cont }, ['Start quiz', icon('right')]),
        ]));
      } else if (Q.phase === 'results') {
        var R = Q.results;
        quizEl.appendChild(h('div', { class: 'cfl-panel cfl-results is-' + (R.passed ? 'pass' : 'fail') }, [
          h('h2', { tabindex: '-1', 'data-k': 'quiz:head', class: 'cfl-results-head', text: R.passed ? 'You passed' : 'Not passed yet' }),
          h('p', { class: 'cfl-score' }, [h('span', { class: 'cfl-score-num', text: R.score + '%' }), h('span', { text: ' your score · pass mark ' + Q.passPercent + '%' })]),
          R.review.length ? h('ol', { class: 'cfl-review' }, R.review.map(function (r) {
            return h('li', { class: 'is-' + r.result }, [h('p', { class: 'cfl-review-q' }, [icon(r.result === 'correct' ? 'check' : 'cross'), sr(r.result === 'correct' ? 'Correct: ' : 'Incorrect: '), r.prompt]),
              r.answer ? h('p', { class: 'cfl-meta', text: 'Answer: ' + r.answer }) : null, r.feedback ? h('p', { class: 'cfl-meta', text: r.feedback }) : null]);
          })) : null,
          h('div', { class: 'cfl-q-actions' }, [
            Q.canRetake ? h('button', { type: 'button', class: R.passed ? 'cfl-btn' : 'cfl-btn cfl-primary', 'data-k': 'quiz:retake', onclick: function () { pendingFocus = 'quiz:head'; send({ type: 'retake' }); } }, [icon('retry'), 'Take again']) : null,
            Q.attempts ? h('p', { class: 'cfl-meta', text: attemptsLeft ? attemptsLeft + (attemptsLeft === 1 ? ' attempt left' : ' attempts left') : 'No attempts left' }) : null,
          ]),
        ]));
      } else {
        var q = Q.question;
        quizEl.appendChild(h('div', { class: 'cfl-quiz-progress' }, [
          h('p', { class: 'cfl-meta', tabindex: '-1', 'data-k': 'quiz:head', text: 'Question ' + (q.index + 1) + ' of ' + Q.count }),
          h('progress', { max: String(Q.count), value: String(q.index + (Q.phase === 'feedback' ? 1 : 0)), 'aria-hidden': 'true' }),
        ]));
        var last = q.index === Q.count - 1;
        if (Q.phase === 'feedback') announce((q.result === 'correct' ? 'Correct. ' : 'Incorrect. ') + (q.feedback || ''));
        quizEl.appendChild(questionForm(q, {
          prefix: 'quiz-' + q.id, title: 'Quiz', send: send, feedback: Q.reveal !== 'none', focusAfter: 'quiz:next|quiz:head',
          after: Q.phase === 'feedback' ? [h('button', { type: 'button', class: 'cfl-btn cfl-primary', 'data-k': 'quiz:next', onclick: cont }, [last ? 'See results' : 'Next question', icon('right')])] : [],
        }));
      }
      if (pendingFocus === null && had) focusKey(had);
    }

    // ---------- render ----------
    function syncBlocks(L) {
      var had = rootEl.contains(document.activeElement) && blocksEl.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null;
      var wanted = L.blocks.map(function (b) {
        var key = JSON.stringify(b, function (kk, v) { return kk === 'text' && b.type === 'question' && typeof v === 'string' && !b.result ? undefined : v; }) + '|' + JSON.stringify(ui[b.id] || null);
        var rec = built[b.id];
        if (!rec || rec.key !== key) {
          var el = RENDER[b.type](b);
          if (rec && rec.el.parentNode) rec.el.parentNode.replaceChild(el, rec.el);
          built[b.id] = rec = { key: key, el: el };
          if (io && !reached[b.id]) io.observe(el);
        }
        return rec.el;
      });
      syncChildren(blocksEl, wanted);
      if (had && pendingFocus === null) focusKey(had);
      endMark.hidden = L.gated;
      if (io && !L.gated && !L.complete) { io.unobserve(endMark); io.observe(endMark); }
    }

    function render() {
      var v = rt.view();
      renderSide(v);
      var lessonId = v.lesson ? v.lesson.id : null;
      var changed = lessonId !== shownLesson;
      if (changed) {
        var first = shownLesson === undefined;
        shownLesson = lessonId;
        built = dict(); ui = dict(); reached = dict(); quizKey = null;
        if (io) io.disconnect();
        mainEl.textContent = '';
        mainEl.appendChild(v.lesson ? buildLesson(v.lesson, v) : buildCover(v));
        if (!first) {
          try { root.scrollTo(0, 0); } catch (e) { /* jsdom */ }
          var h1 = mainEl.querySelector('h1');
          if (h1) h1.focus({ preventScroll: true });
          announce(v.lesson ? 'Lesson ' + (v.lesson.index + 1) + ' of ' + v.lesson.count + ': ' + v.lesson.title : doc.title);
        }
        syncHash(!first && started);
      } else if (!v.lesson) {
        var fresh = buildCover(v); // the cover is tiny: rebuild for Start/Resume and progress
        var keep = rootEl.contains(document.activeElement) && mainEl.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null;
        mainEl.textContent = ''; mainEl.appendChild(fresh);
        if (keep) focusKey(keep);
      }
      if (v.lesson) {
        if (v.lesson.kind === 'quiz') renderQuiz(v.lesson); else syncBlocks(v.lesson);
        renderFooter(v);
      }
      if (pendingFocus !== null) {
        var pf = pendingFocus; pendingFocus = null;
        if (pf.indexOf('after:') === 0) {
          var gate = built[pf.slice(6)], next = gate && gate.el.nextElementSibling;
          if (next && next !== endMark) { next.setAttribute('tabindex', '-1'); next.focus({ preventScroll: true }); next.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' }); }
        } else pf.split('|').some(focusKey); // alternatives, first match wins
      }
      return v;
    }

    // ---------- start / resume ----------
    function boot() {
      started = true;
      // D/C: resuming is automatic, with no prompt; the learner returns to the saved lesson.
      if (opts.resumePrompt && typeof opts.resumePrompt === 'object') rt.restore(opts.resumePrompt);
      if (rt.trace.indexOf('resume') < 0 && rt.trace.indexOf('start') < 0) rt.start({ resume: opts.resumePrompt ? 'never' : undefined });
      var want = hashLesson();
      if (want) rt.dispatch({ type: 'open', lesson: want });
      seen = 0;
      send({ type: 'tick', ms: 0 }); // flush onTrace and render
      syncHash(false);
    }
    boot();

    return {
      rt: rt,
      render: render,
      destroy: function () {
        Object.keys(captionUrls).forEach(function (id) { URL.revokeObjectURL(captionUrls[id]); });
        if (io) io.disconnect();
        if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
        root.removeEventListener('hashchange', onHash);
        root.removeEventListener('popstate', onHash);
        if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
      },
    };
  }

  root.CFLessons = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
