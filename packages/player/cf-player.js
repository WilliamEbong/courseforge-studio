// CourseForge Studio learner player: renders runtime.view as accessible HTML and feeds DOM events
// keys and a real-time clock back to the runtime. Classic script, ES2017 (no ?. ?? or object spread), works
// from file://. Usage: CFPlayer.mount(container, { runtime, assetsBase, resumePrompt, onTrace }).
(function (root) {
  'use strict';

  var MAX_DT = 250; // ms per frame; a stalled tab must not fast-forward the timeline
  var FEEDBACK = { correct: ['Correct', '\u2713'], incorrect: ['Incorrect', '\u2715'], tryAgain: ['Try again', '\u21bb'] };
  var FLEX = { left: 'flex-start', center: 'center', right: 'flex-end', top: 'flex-start', middle: 'center', bottom: 'flex-end' };
  var uid = 0;

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function attr(el, name, v) {
    if (v === null || v === undefined || v === false) { if (el.hasAttribute(name)) el.removeAttribute(name); }
    else if (el.getAttribute(name) !== String(v)) el.setAttribute(name, v);
  }
  function setText(el, t) { if (el.textContent !== t) el.textContent = t; }
  // Make parent's element children exactly `list`, moving nodes only where the order differs (moves drop focus).
  function syncChildren(parent, list) {
    list.forEach(function (el, i) { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
    while (parent.children.length > list.length) parent.removeChild(parent.lastElementChild);
  }
  // Inline style per property: setProperty drops invalid values, so a style string cannot smuggle other declarations.
  function applyStyle(el, props) {
    var key = JSON.stringify(props);
    if (el._cfStyle === key) return;
    el._cfStyle = key;
    el.style.cssText = '';
    Object.keys(props).forEach(function (k) { el.style.setProperty(k, String(props[k])); });
  }
  function focusable(el) { return el && el.isConnected && !el.disabled && !el.hidden && !el.closest('[hidden],[inert]'); }
  // Dial value under the pointer: angle from the centre (0 = 12 o'clock, clockwise) mapped onto startAngle..endAngle;
  // outside the arc the nearer end wins. The runtime snaps and clamps.
  function dialValue(o, el, e) {
    var r = el.getBoundingClientRect();
    var a = Math.atan2(e.clientX - (r.left + r.width / 2), (r.top + r.height / 2) - e.clientY) * 180 / Math.PI;
    var span = o.endAngle - o.startAngle, s = Math.abs(span), dir = span < 0 ? -1 : 1;
    var rel = ((((a - o.startAngle) * dir) % 360) + 360) % 360;
    if (rel > s) rel = rel - s < 360 - rel ? s : 0;
    return o.min + (rel / s) * (o.max - o.min);
  }
  function dialAngle(o, v) { return o.startAngle + ((v - o.min) / (o.max - o.min)) * (o.endAngle - o.startAngle); }

  function isLine(o) { return o.type === 'shape' && (o.shape === 'line' || o.shape === 'arrow'); } // SVG, no text

  function objStyle(o, hover) {
    var s = Object.assign({}, o.style, hover ? o.hoverStyle : null);
    var p = { left: o.x + 'px', top: o.y + 'px', width: o.w + 'px', height: o.h + 'px' };
    if (o.rotation) p.transform = 'rotate(' + o.rotation + 'deg)';
    if (s.fill !== undefined) p['background-color'] = s.fill;
    if (s.color !== undefined) p.color = s.color;
    if (s.border !== undefined || s.borderWidth !== undefined) {
      p['border-style'] = 'solid';
      p['border-width'] = (s.borderWidth !== undefined ? s.borderWidth : 1) + 'px';
      if (s.border !== undefined) p['border-color'] = s.border;
    }
    if (s.radius !== undefined) p['border-radius'] = s.radius + 'px';
    else if (o.shape === 'rounded') p['border-radius'] = '16px';
    if (o.shape === 'ellipse') p['border-radius'] = '50%';
    if (s.fontSize !== undefined) p['font-size'] = s.fontSize + 'px';
    if (s.fontFamily !== undefined) p['font-family'] = s.fontFamily;
    if (s.bold !== undefined) p['font-weight'] = s.bold ? '700' : '400';
    if (s.italic !== undefined) p['font-style'] = s.italic ? 'italic' : 'normal';
    if (s.underline !== undefined) p['text-decoration'] = s.underline ? 'underline' : 'none';
    if (s.align) { p['text-align'] = s.align; p['justify-content'] = FLEX[s.align]; }
    if (s.valign) p['align-items'] = FLEX[s.valign];
    if (s.opacity !== undefined) p.opacity = s.opacity;
    if (s.textFit) p.padding = '0';
    else if (s.padding !== undefined) p.padding = s.padding + 'px';
    if (s.clip) p.overflow = 'hidden';
    if (s.shadow) p['box-shadow'] = '0 4px 14px rgba(0, 0, 0, 0.25)';
    if (isLine(o)) ['background-color', 'border-style', 'border-width', 'border-color', 'border-radius'].forEach(function (k) { delete p[k]; }); // drawLine paints it
    return p;
  }

  function mount(container, opts) {
    opts = opts || {};
    var rt = opts.runtime;
    if (!rt || typeof rt.dispatch !== 'function') throw new TypeError('CFPlayer.mount: opts.runtime is required');
    if (rt.mode === 'lessons') { // lessons courses scroll; their player lives in cf-lessons.js
      if (!root.CFLessons) throw new Error('CFPlayer.mount: lessons courses need cf-lessons.js');
      return root.CFLessons.mount(container, opts);
    }
    var assetsBase = opts.assetsBase || '';
    var doc = rt.doc;
    var id = 'cf' + (++uid);
    // Lookups keyed by course ids use null-prototype maps: "constructor" is a valid id.
    var dict = function () { return Object.create(null); };
    var els = dict(), boxes = dict();
    var hovered = null, lastKey = null, lastSlide = null, lastModal = null, modalReturn = null, pendingFocus = null;
    var seen = rt.trace.length, started = false, raf = 0, lastT = 0, qKey = null, menuKey = null;
    var menuOpen = !!(doc.player && doc.player.menu) && (container.clientWidth || 1024) >= 900;
    var clickCache = dict();
    // Media: captions text embedded by the publisher (file:// cannot load <track src>), CC state, and
    // media commands from the trace, run after the render that creates their elements.
    var captionsData = opts.captions || {}, ccOn = false, mediaQueue = [];
    var openMarker = null; // the one open marker label (learner UI state, like CC)
    function setMarker(mid) { if (openMarker !== mid) { openMarker = mid; render(true); } }
    var assetUrl = function (p) { return assetsBase + p.split('/').map(encodeURIComponent).join('/'); }; // a # or ? in a file name

    // ---------- skeleton ----------
    var menuBtn = h('button', { type: 'button', class: 'cf-icon-btn', 'aria-controls': id + '-menu', onclick: function () { menuOpen = !menuOpen; render(); } },
      [h('span', { 'aria-hidden': 'true', text: '\u2630' }), h('span', { text: 'Menu' })]);
    var titleEl = h('h1', { class: 'cf-title' });
    var slideTitleEl = h('span', { class: 'cf-slide-title' });
    var progressEl = h('span', { class: 'cf-progress' });
    var menu = h('nav', { class: 'cf-menu', id: id + '-menu', 'aria-label': 'Course menu' });
    var stage = h('section', { class: 'cf-stage', tabindex: '-1' });
    var frame = h('div', { class: 'cf-frame' }, [stage]);
    var viewport = h('div', { class: 'cf-viewport' }, [frame]);
    var qBox = h('div', { class: 'cf-qbox' });
    boxes.base = h('div', { class: 'cf-layer', 'data-layer': 'base' });
    var prevBtn = h('button', { type: 'button', class: 'cf-btn', onclick: function () { send({ type: 'prev' }); } }, [h('span', { 'aria-hidden': 'true', text: '\u2190 ' }), document.createTextNode('Prev')]);
    var nextBtn = h('button', { type: 'button', class: 'cf-btn cf-primary', onclick: function () { send({ type: 'next' }); } }, [document.createTextNode('Next'), h('span', { 'aria-hidden': 'true', text: ' \u2192' })]);
    var submitBtn = h('button', { type: 'button', class: 'cf-btn cf-primary', text: 'Submit', onclick: function () { send({ type: 'submit' }); } });
    // Captions are off by default; the vendor labels its button "Show captions (Ctrl+Alt+C)".
    var ccBtn = h('button', { type: 'button', class: 'cf-btn cf-cc', 'aria-pressed': 'false', 'aria-keyshortcuts': 'Control+Alt+C', title: 'Captions (Ctrl+Alt+C)', hidden: true, onclick: function () { toggleCaptions(); } },
      [h('span', { class: 'cf-cc-mark', 'aria-hidden': 'true', text: 'CC' }), document.createTextNode(' Captions')]);
    var live = h('div', { class: 'cf-sr', 'aria-live': 'polite' });

    var fbTitle = h('h2', { id: id + '-fb-title' });
    var fbIcon = h('span', { class: 'cf-fb-icon', 'aria-hidden': 'true' });
    var fbText = h('p', { id: id + '-fb-text' });
    var fbBtn = h('button', { type: 'button', class: 'cf-btn cf-primary', text: 'Continue', onclick: function () { send({ type: 'continue' }); } });
    var fbDlg = h('dialog', { class: 'cf-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id + '-fb-title', 'aria-describedby': id + '-fb-text' },
      [h('div', { class: 'cf-dialog-head' }, [fbIcon, fbTitle]), fbText, h('div', { class: 'cf-dialog-actions' }, [fbBtn])]);
    // Escape closes a modal <dialog> natively (without a cancelable 'cancel' when the page has no user activation),
    // so 'close' is the one reliable signal: closed while feedback is still pending = Continue.
    fbDlg.addEventListener('close', function () { if (rt.view().feedback) send({ type: 'continue' }); });

    // Quiz review: result in words and colour, the learner's answer, the correct one, and a way out.
    var rvStatus = h('p', { class: 'cf-review-status' }, [h('span', { 'aria-hidden': 'true' }), h('span')]);
    var rvWhere = h('p', { class: 'cf-review-where' });
    var rvYours = h('p', { class: 'cf-review-line' }, [h('strong', { text: 'Your answer: ' }), document.createTextNode('')]);
    var rvAnswer = h('p', { class: 'cf-review-line' }, [h('strong', { text: 'Correct answer: ' }), document.createTextNode('')]);
    var reviewBar = h('section', { class: 'cf-review', 'aria-label': 'Quiz review', hidden: true }, [
      h('div', { class: 'cf-review-text' }, [h('div', { class: 'cf-review-head' }, [rvStatus, rvWhere]), rvYours, rvAnswer]),
      h('button', { type: 'button', class: 'cf-btn', text: 'Exit review', onclick: function () { send({ type: 'exitReview' }); } }),
    ]);
    var reviewing = false, reviewKey = null;
    // Review is read-only, yet the answer controls stay focusable for reading (aria-disabled, not disabled): clicks,
    // including the simulated click of arrow keys in a radio group, are cancelled, and a select ignores its keys.
    function readOnly(e) {
      if (!reviewing || !e.target.closest('.cf-question')) return;
      var sel = e.target.tagName === 'SELECT';
      if (e.type === 'keydown') { if (sel && e.key !== 'Tab') e.preventDefault(); return; }
      if (e.type === 'mousedown' && !sel) return;
      e.preventDefault();
      e.stopPropagation();
    }
    ['click', 'keydown', 'mousedown', 'pointerdown'].forEach(function (k) { qBox.addEventListener(k, readOnly, true); });

    var shell = h('div', { class: 'cf-shell' }, [
      h('header', { class: 'cf-bar' }, [menuBtn, titleEl, h('div', { class: 'cf-where' }, [slideTitleEl, progressEl])]),
      reviewBar,
      h('div', { class: 'cf-body' }, [menu, h('main', { class: 'cf-main' }, [viewport])]),
      h('footer', { class: 'cf-nav' }, [ccBtn, prevBtn, nextBtn, submitBtn]),
    ]);
    var rootEl = h('div', { class: 'cf-player' }, [shell, live, fbDlg]);
    var theme = (doc.player && doc.player.theme) || {};
    Object.keys(theme).forEach(function (k) { if (/^[a-z][a-z0-9-]*$/.test(k)) rootEl.style.setProperty('--cf-' + k, theme[k]); });
    container.appendChild(rootEl);

    // ---------- scaling ----------
    function fit() {
      var w = doc.size.w, hh = doc.size.h;
      var cs = getComputedStyle(viewport);
      var aw = viewport.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      var ah = viewport.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      var s = Math.max(0.05, Math.min(aw / w, ah / hh)) || 1;
      frame.style.width = Math.floor(w * s) + 'px';
      frame.style.height = Math.floor(hh * s) + 'px';
      stage.style.width = w + 'px';
      stage.style.height = hh + 'px';
      stage.style.transform = 'scale(' + s + ')';
      // T5 design audit: below about half size a question form drawn in the stage gets ~8 px text and ~20 px targets
      // on a phone, so form questions move under the stage at full size (hotspot and drag questions stay on it).
      var question = rt.view().question;
      var small = s < 0.55 && (!(question && question.layout) || aw < 600);
      if (small !== smallStage) { smallStage = small; if (started) render(true); }
    }
    var smallStage = false;
    var captionUrls = Object.create(null); // caption asset id -> blob URL, shared across revisits, revoked on destroy
    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(viewport); else window.addEventListener('resize', fit);

    // ---------- runtime plumbing ----------
    function send(ev) {
      try { rt.dispatch(ev); } catch (e) { if (root.console) root.console.error('CFPlayer: dispatch failed', ev, e); }
      afterChange();
    }
    function afterChange() {
      var t = rt.trace;
      if (t.length > seen) {
        var fresh = t.slice(seen);
        seen = t.length;
        fresh.forEach(function (line) {
          if (line.indexOf('open ') === 0) {
            var url = line.slice(5);
            if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener');
          } else if (line.indexOf('focus ') === 0) pendingFocus = line.slice(6);
          else if (/^media (play|pause|stop|toggle) /.test(line)) mediaQueue.push(line.split(' '));
        });
        if (opts.onTrace) { try { opts.onTrace(fresh, rt); } catch (e) { if (root.console) root.console.error(e); } }
      }
      render();
      runMedia();
    }
    // play() rejects when the browser blocks playback (autoplay policy): warn, never an unhandled rejection.
    function playEl(el) {
      var p = el.play();
      if (p && p.catch) p.catch(function (e) { if (root.console) root.console.warn('CFPlayer: playback blocked', e && e.name); });
    }
    function runMedia() {
      var list = mediaQueue;
      mediaQueue = [];
      list.forEach(function (c) {
        var el = els[c[2]];
        if (!el || typeof el.play !== 'function') return;
        if (c[1] === 'play' || (c[1] === 'toggle' && el.paused)) playEl(el);
        else el.pause();
        if (c[1] === 'stop') el.currentTime = 0;
      });
    }
    function toggleCaptions() {
      ccOn = !ccOn;
      Object.keys(els).forEach(function (k) { var t = els[k].querySelector && els[k].querySelector('track'); if (t) t.track.mode = ccOn ? 'showing' : 'hidden'; });
      live.textContent = ccOn ? 'Captions on' : 'Captions off';
      render(true);
    }
    function start(fn) { started = true; fn(); afterChange(); }

    // ---------- objects ----------
    function clickTargets(slideId) {
      if (!clickCache[slideId]) {
        var set = dict();
        var s = doc.slides.filter(function (x) { return x.id === slideId; })[0];
        if (s) [s].concat(s.layers).forEach(function (c) { c.triggers.forEach(function (t) { if (t.on.event === 'click') set[t.on.target] = true; }); });
        clickCache[slideId] = set;
      }
      return clickCache[slideId];
    }
    function create(o) {
      var el;
      if (o.type === 'button' || o.type === 'hotspot') el = h('button', { type: 'button' });
      else if (o.type === 'image') el = h('img', { draggable: 'false' });
      else if (o.type === 'input') {
        // The character count sits right after the input (shown while it has focus) and is its description.
        el = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': id + '-count-' + o.id });
        el._cfCount = h('span', { class: 'cf-count', id: id + '-count-' + o.id });
      } else if (o.type === 'marker') {
        el = h('div', {}, [
          h('button', { type: 'button', class: 'cf-marker-btn', 'aria-expanded': 'false', 'aria-controls': id + '-mk-' + o.id }, [h('span', { 'aria-hidden': 'true', text: '+' })]),
          h('div', { class: 'cf-marker-label', id: id + '-mk-' + o.id, hidden: true }, [h('p', { class: 'cf-marker-title' }), h('p', { class: 'cf-marker-text' })]),
        ]);
      } else if (o.type === 'video') el = h('video', { playsinline: true, preload: 'metadata' });
      else if (o.type === 'audio') el = h('audio', { preload: 'metadata' });
      else if (o.type === 'slider') el = h('input', { type: 'range' });
      else if (o.type === 'dial') el = h('div', {}, [h('span', { class: 'cf-dial-pointer', 'aria-hidden': 'true' }), h('span', { class: 'cf-dial-hub', 'aria-hidden': 'true' }), h('input', { type: 'range', class: 'cf-dial-input' })]);
      else el = h('div');
      el.className = 'cf-obj cf-' + o.type + (o.shape && o.type === 'shape' ? ' cf-shape-' + o.shape : '');
      el.setAttribute('data-id', o.id);
      el.addEventListener('click', function (e) {
        if (e.target.closest('a')) return;
        if (o.type === 'marker' && !e.target.closest('.cf-marker-btn')) return; // a click in an open label is not a marker click
        if (!el.disabled && el.getAttribute('aria-disabled') !== 'true') send({ type: 'click', target: o.id });
      });
      el.addEventListener('mouseenter', function () { hovered = o.id; send({ type: 'hoverEnter', target: o.id }); });
      el.addEventListener('mouseleave', function () { if (hovered === o.id) hovered = null; send({ type: 'hoverLeave', target: o.id }); });
      if (o.type === 'input') {
        var onInput = function () { send({ type: 'input', target: o.id, text: el.value }); };
        el.addEventListener('input', onInput);
        el.addEventListener('change', onInput);
      } else if (o.type === 'marker') {
        // Markers: a click toggles; keyboard focus opens and blur closes (so another marker or a click
        // elsewhere closes it); Escape closes and keeps focus; Enter/Space toggle. One label is open at a time.
        var mb = el.firstChild;
        mb.addEventListener('pointerdown', function () { mb._cfPtr = true; });
        mb.addEventListener('focus', function () { if (!mb._cfPtr) setMarker(o.id); });
        mb.addEventListener('click', function () { mb._cfPtr = false; setMarker(openMarker === o.id ? null : o.id); });
        mb.addEventListener('blur', function () { mb._cfPtr = false; if (openMarker === o.id) setMarker(null); });
        mb.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openMarker === o.id) { e.preventDefault(); e.stopPropagation(); setMarker(null); } });
      } else if (o.type === 'video' || o.type === 'audio') {
        if (o.media) el.src = assetUrl(o.media);
        if (o.poster) el.poster = assetUrl(o.poster);
        if (o.captions) { // off by default; a blob when the publisher embedded the text, else the asset URL
          var text = Object.prototype.hasOwnProperty.call(captionsData, o.captions.id) ? captionsData[o.captions.id] : null;
          var tr = h('track', { kind: 'captions', srclang: doc.language || 'en', label: 'Captions' });
          if (typeof text === 'string' && !captionUrls[o.captions.id]) captionUrls[o.captions.id] = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
          tr.src = typeof text === 'string' ? captionUrls[o.captions.id] : o.captions.path ? assetUrl(o.captions.path) : ''; // one blob per caption asset
          el.appendChild(tr);
          tr.track.mode = ccOn ? 'showing' : 'hidden';
        }
        el.addEventListener('ended', function () { send({ type: 'mediaEnd', target: o.id }); });
        el.addEventListener('keydown', function (e) { // a video without controls is a play/pause button
          if (el.controls || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          el.click();
        });
      } else if (o.type === 'slider' || o.type === 'dial') {
        // A native range input is the control for keys and assistive tech (arrows, Home/End, PageUp/Down).
        var range = o.type === 'dial' ? el.querySelector('input') : el;
        var slide = function (v) { send({ type: 'slide', target: o.id, value: v }); };
        if (o.live) range.addEventListener('input', function () { slide(Number(range.value)); });
        range.addEventListener('change', function () { slide(Number(range.value)); });
        var stop = function () {
          if (!el._cfDrag) return;
          el._cfDrag = false;
          if (el._cfPending !== undefined) { var p = el._cfPending; el._cfPending = undefined; slide(p); } // a slider's native 'change' follows
        };
        if (o.type === 'slider') el.addEventListener('pointerdown', function () { el._cfDrag = true; }); // native thumb drag
        else {
          var turn = function (e) {
            var v = dialValue(el._cfObj, el, e);
            if (el._cfObj.live) slide(v);
            else { el._cfPending = v; el.firstChild.style.transform = 'rotate(' + dialAngle(el._cfObj, v) + 'deg)'; }
          };
          el.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 || range.disabled) return;
            e.preventDefault();
            range.focus();
            el.setPointerCapture(e.pointerId);
            el._cfDrag = true;
            turn(e);
          });
          el.addEventListener('pointermove', function (e) { if (el._cfDrag) turn(e); });
        }
        el.addEventListener('pointerup', stop);
        el.addEventListener('pointercancel', stop);
      } else if (el.tagName === 'DIV' || el.tagName === 'IMG') {
        el.addEventListener('keydown', function (e) {
          if (e.target.closest('a') || el.getAttribute('role') !== 'button' || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          el.click();
        });
      }
      return el;
    }
    function updateObj(el, o, clickable) {
      // an entrance/exit effect is a CSS animation started from the runtime's elapsed time (seek/resume safe).
      var a = o.anim, key = a ? a.name + '-' + a.effect : '';
      if (el._cfAnim !== key) { el._cfAnim = key; el._cfAnimFrom = a ? -a.elapsed : 0; }
      var props = objStyle(o, hovered === o.id && o.enabled && o.hoverStyle);
      if (a) {
        props['--cf-anim-dur'] = a.duration + 'ms'; props['--cf-anim-delay'] = el._cfAnimFrom + 'ms';
        if (a.dx !== undefined) { props['--cf-fly-x'] = a.dx + 'px'; props['--cf-fly-y'] = a.dy + 'px'; }
        if (a.paused) props['animation-play-state'] = 'paused';
      }
      attr(el, 'data-anim', key || null);
      applyStyle(el, props);
      el.hidden = !o.visible;
      attr(el, 'data-state', o.state);
      var focusEl = o.type === 'marker' ? el.firstChild : o.type === 'dial' ? el.querySelector('input') : el;
      if (focusEl !== el) {
        el.removeAttribute('tabindex');
        attr(focusEl, 'tabindex', o.tabIndex === undefined ? null : o.tabIndex);
      } else if (o.tabIndex !== undefined) el.tabIndex = o.tabIndex;
      if (o.type === 'image') {
        attr(el, 'src', o.image ? assetsBase + o.image.split('/').map(encodeURIComponent).join('/') : null); // a # or ? in a file name
        attr(el, 'alt', o.alt || '');
      } else if (o.type === 'input') {
        if (o.value !== undefined && el.value !== o.value) el.value = o.value;
        attr(el, 'maxlength', o.maxLength);
        setText(el._cfCount, el.value.length + '/' + o.maxLength + ' characters');
        applyStyle(el._cfCount, { left: o.x + 'px', top: (o.y + o.h + 4) + 'px', width: o.w + 'px' });
        el._cfCount.hidden = !o.visible;
        attr(el, 'placeholder', o.placeholder);
        attr(el, 'aria-label', o.alt || o.placeholder || o.text || 'Text entry');
        el.disabled = !o.enabled;
      } else if (o.type === 'hotspot') {
        attr(el, 'aria-label', o.alt || o.text || 'Hotspot');
        el.disabled = !o.enabled;
      } else if (o.type === 'marker') {
        var mbtn = el.firstChild, lbl = el.lastChild, open = openMarker === o.id && o.visible && o.enabled;
        attr(mbtn, 'aria-label', o.text || o.alt || 'Marker');
        mbtn.disabled = !o.enabled;
        mbtn.setAttribute('aria-expanded', String(open));
        lbl.hidden = !open;
        setText(lbl.firstChild, o.text || '');
        setText(lbl.lastChild, o.detail || '');
        el.classList.toggle('cf-open', open);
        el.classList.toggle('cf-label-left', o.x + o.w + 380 > doc.size.w); // no room on the right
      } else if (o.type === 'video' || o.type === 'audio') {
        el.controls = o.controls;
        el.loop = o.loop;
        var button = o.type === 'video' && !o.controls;
        attr(el, 'role', button ? 'button' : null);
        attr(el, 'aria-label', button ? (o.alt || 'Video') + ', play or pause' : o.alt || null);
        if (o.tabIndex === undefined) { if (button) el.tabIndex = o.enabled ? 0 : -1; else el.removeAttribute('tabindex'); }
        // Autoplay media play when they appear; any medium pauses when it disappears (layer hidden, end time).
        if (el._cfVis !== o.visible) { el._cfVis = o.visible; if (!o.visible) el.pause(); else if (o.autoplay) playEl(el); }
        // A paused timeline (Pause timeline of base layer) holds its playing media; they resume where they stopped (doc-findings).
        if (o.timelinePaused && !el.paused) { el._cfHeld = true; el.pause(); }
        else if (!o.timelinePaused && el._cfHeld) { el._cfHeld = false; if (o.visible) playEl(el); }
      } else if (o.type === 'slider' || o.type === 'dial') {
        el._cfObj = o;
        var range = o.type === 'dial' ? el.querySelector('input') : el;
        attr(range, 'min', o.min); attr(range, 'max', o.max); attr(range, 'step', o.step);
        if (!el._cfDrag && range.value !== String(o.value)) range.value = String(o.value);
        attr(range, 'aria-label', (o.alt || o.name || (o.type === 'dial' ? 'Dial' : 'Slider')) + ' range from ' + o.min + ' to ' + o.max);
        range.disabled = !o.enabled;
        if (o.type === 'dial' && !(el._cfDrag && !o.live)) el.firstChild.style.transform = 'rotate(' + dialAngle(o, o.value) + 'deg)';
      } else if (isLine(o)) {
        var lineKey = JSON.stringify([o.shape, o.w, o.h, o.style]);
        if (el._cfLine !== lineKey) { el._cfLine = lineKey; el.replaceChildren(drawLine(document, o, o.style)); }
      } else {
        var textFrame = o.style && o.style.textFit;
        var richKey = o.rich || textFrame ? JSON.stringify([!!textFrame, o.rich || o.text || '']) : null;
        if (richKey !== el._cfRich) {
          el._cfRich = richKey;
          el.replaceChildren();
          if (o.rich || textFrame) {
            var content = h('div');
            content.style.width = '100%';
            if (o.rich) renderRich(content, o.rich); else content.textContent = o.text || '';
            el.appendChild(content);
          }
        }
        if (!o.rich && !textFrame) setText(el, o.text || '');
        if (o.type === 'button') { attr(el, 'aria-label', !o.text && o.alt ? o.alt : null); el.disabled = !o.enabled; }
      }
      if ((el.tagName === 'DIV' && o.type !== 'dial' && o.type !== 'marker') || el.tagName === 'IMG') { // keyboard access for click-trigger sources
        attr(el, 'role', clickable ? 'button' : null);
        attr(el, 'aria-disabled', clickable && !o.enabled ? 'true' : null);
        if (o.tabIndex === undefined) { if (clickable) el.tabIndex = o.enabled ? 0 : -1; else el.removeAttribute('tabindex'); }
        if (clickable && el.tagName === 'DIV' && !o.text) attr(el, 'aria-label', o.alt || null);
      }
    }

    // ---------- question ----------
    // Review tags: words next to a choice, row or item, so a result never rests on colour alone.
    // list: [[text, 'ok'|'bad'], ...]; an empty list removes them.
    function setTags(host, list) {
      var box = null;
      for (var i = 0; i < host.children.length; i++) if (host.children[i].className === 'cf-tags') box = host.children[i];
      if (!list.length) { if (box) host.removeChild(box); return; }
      var key = JSON.stringify(list);
      if (!box) box = host.appendChild(h('span', { class: 'cf-tags' }));
      if (box._cfKey === key) return;
      box._cfKey = key;
      box.textContent = '';
      list.forEach(function (t) { box.appendChild(h('span', { class: 'cf-tag cf-tag-' + t[1], text: t[0] })); });
    }
    // Slide coordinates of a pointer event (the stage is scaled with a transform).
    function stagePoint(e) {
      var r = stage.getBoundingClientRect(), s = r.width / doc.size.w;
      return { x: Math.round((e.clientX - r.left) / s), y: Math.round((e.clientY - r.top) / s) };
    }
    // Hotspot question: a prompt banner over a pointer surface. Keyboard: arrows move a marker
    // (Shift = 5x), Enter/Space places it. The marker shows the recorded point.
    var hs = null;
    function renderHotspot(v) {
      var q = v.question;
      var key = v.slide.id + '|hotspot';
      if (key !== qKey) {
        qKey = key;
        var banner = h('p', { class: 'cf-qbanner', id: id + '-qp' });
        var surface = h('div', { class: 'cf-hs-surface', tabindex: '0', role: 'application', 'aria-roledescription': 'hotspot question', 'aria-describedby': id + '-qp',
          'aria-label': 'Answer area. Click to mark your answer. Keyboard: arrow keys move the marker, Shift with an arrow moves it faster, Enter or Space marks the answer.' },
        [h('span', { class: 'cf-hs-marker', 'aria-hidden': 'true' }), h('span', { class: 'cf-hs-cursor', 'aria-hidden': 'true' })]);
        hs = { x: Math.round(doc.size.w / 2), y: Math.round(doc.size.h / 2), surface: surface, banner: banner };
        var mark = function (x, y) { hs.x = x; hs.y = y; send({ type: 'point', x: x, y: y }); live.textContent = 'Answer marked.'; };
        surface.addEventListener('click', function (e) { var p = stagePoint(e); mark(p.x, p.y); });
        surface.addEventListener('keydown', function (e) {
          var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
          if (d) {
            e.preventDefault();
            var n = e.shiftKey ? 50 : 10;
            hs.x = Math.min(doc.size.w, Math.max(0, hs.x + d[0] * n)); hs.y = Math.min(doc.size.h, Math.max(0, hs.y + d[1] * n));
            render(true);
          } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mark(hs.x, hs.y); }
        });
        qBox.textContent = '';
        qBox.appendChild(banner);
        qBox.appendChild(surface);
      }
      setText(hs.banner, q.prompt);
      var locked = !!q.result || !!v.feedback || reviewing;
      attr(hs.surface, 'aria-disabled', locked ? 'true' : null);
      hs.surface.tabIndex = locked ? -1 : 0;
      var areaKey = JSON.stringify(q.areas || null); // review: outline the correct areas, labelled in words
      if (hs.areaKey !== areaKey) {
        hs.areaKey = areaKey;
        [].slice.call(hs.surface.querySelectorAll('.cf-hs-area')).forEach(function (el) { hs.surface.removeChild(el); });
        (q.areas || []).forEach(function (a) {
          var el = h('span', { class: 'cf-hs-area' + (a.shape === 'ellipse' ? ' cf-hs-ellipse' : '') }, [h('span', { text: 'Correct area' })]);
          el.style.left = a.x + 'px'; el.style.top = a.y + 'px'; el.style.width = a.w + 'px'; el.style.height = a.h + 'px';
          hs.surface.appendChild(el);
        });
      }
      var marker = hs.surface.querySelector('.cf-hs-marker'), cursor = hs.surface.querySelector('.cf-hs-cursor');
      marker.hidden = !q.point;
      if (q.point) { marker.style.left = q.point.x + 'px'; marker.style.top = q.point.y + 'px'; }
      cursor.style.left = hs.x + 'px'; cursor.style.top = hs.y + 'px';
    }

    // ---------- drag and drop: items and targets are slide objects ----------
    // Pointer: drag an item and release it over a target. Keyboard and click: pick an item up (Enter/Space or a
    // click), then activate a target; the picked item again puts it back; Escape cancels. The vendor has no
    // keyboard path; ours is required.
    var grabbed = null;
    function ddRoles(v) {
      var r = dict(), q = v.question;
      if (q && q.type === 'dragdrop') {
        q.items.forEach(function (i) { r[i.object] = 'item'; });
        q.targets.forEach(function (t) { r[t.object] = 'target'; });
      }
      return r;
    }
    function labelOf(oid) {
      var o = rt.view().objects.filter(function (x) { return x.id === oid; })[0];
      return (o && (o.text || o.alt)) || oid;
    }
    function dropTo(item, target) {
      grabbed = null;
      send({ type: 'drop', item: item, target: target });
      var it = (rt.view().question.items || []).filter(function (i) { return i.object === item; })[0];
      live.textContent = it && it.placed ? labelOf(item) + ' placed on ' + labelOf(it.placed) + '.' : labelOf(item) + ' returned to its start.';
    }
    function setupDrag(el, oid) {
      el._cfDD = true;
      el.addEventListener('pointerdown', function (e) {
        if (el._cfRole !== 'item' || el._cfLocked || e.button !== 0 || el.getAttribute('aria-disabled') === 'true' || el.disabled) return;
        var x0 = e.clientX, y0 = e.clientY, moved = false, base = el.style.transform;
        var carried = (el._cfMembers || []).map(function (id) { return els[id]; }).filter(Boolean).map(function (node) { return { node: node, transform: node.style.transform }; });
        var scale = stage.getBoundingClientRect().width / doc.size.w;
        el.setPointerCapture(e.pointerId);
        var move = function (ev) {
          var dx = ev.clientX - x0, dy = ev.clientY - y0;
          if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
          moved = true;
          el.classList.add('cf-dragging');
          el.style.transform = (base ? base + ' ' : '') + 'translate(' + dx / scale + 'px, ' + dy / scale + 'px)';
          carried.forEach(function (member) { member.node.style.transform = (member.transform ? member.transform + ' ' : '') + 'translate(' + dx / scale + 'px, ' + dy / scale + 'px)'; });
        };
        var up = function (ev) {
          el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
          el.classList.remove('cf-dragging');
          el.style.transform = base;
          carried.forEach(function (member) { member.node.style.transform = member.transform; });
          if (!moved || ev.type === 'pointercancel') return;
          el._cfDragged = true; // the click that follows the release is not a pick-up
          var p = stagePoint(ev), v = rt.view(), hit = null;
          v.question.targets.forEach(function (t) {
            var b = v.objects.filter(function (x) { return x.id === t.object; })[0];
            if (b && b.visible && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) hit = t.object;
          });
          dropTo(oid, hit);
        };
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      });
      el.addEventListener('click', function () {
        if (el._cfDragged) { el._cfDragged = false; return; }
        if (el._cfLocked || el.getAttribute('aria-disabled') === 'true') return;
        if (el._cfRole === 'item') {
          if (grabbed === oid) return dropTo(oid, null);
          grabbed = oid;
          live.textContent = 'Picked up ' + labelOf(oid) + '. Choose a drop target, or press Escape to cancel.';
          render(true);
        } else if (grabbed) dropTo(grabbed, oid);
      });
    }
    function updateDrag(el, o, role, v) {
      var q = v.question, locked = !!q.result || !!v.feedback || reviewing;
      if (!el._cfDD) setupDrag(el, o.id);
      el._cfRole = role;
      el._cfMembers = o.members;
      el._cfLocked = locked;
      var name = o.text || o.alt || o.id;
      el.classList.remove('cf-rv-ok', 'cf-rv-bad');
      if (role === 'item') {
        var it = q.items.filter(function (i) { return i.object === o.id; })[0];
        var rv = reviewing && it.target !== undefined ? (it.placed === it.target ? ', correct' : ', correct place: ' + (it.target ? labelOf(it.target) : 'not placed')) : '';
        if (rv) el.classList.add(it.placed === it.target ? 'cf-rv-ok' : 'cf-rv-bad');
        attr(el, 'aria-label', name + (it.placed ? ', on ' + labelOf(it.placed) : '') + rv + (grabbed === o.id ? ', picked up' : ''));
        attr(el, 'aria-pressed', locked ? null : String(grabbed === o.id));
        el.classList.toggle('cf-draggable', !locked && o.enabled);
      } else attr(el, 'aria-label', 'Drop target: ' + name);
      attr(el, 'aria-disabled', locked || !o.enabled ? 'true' : null);
      attr(el, 'aria-describedby', id + '-dd-help');
      el.classList.toggle('cf-grabbed', grabbed === o.id);
      el.classList.toggle('cf-droppable', role === 'target' && !!grabbed);
    }
    function renderDragBanner(v) {
      var key = v.slide.id + '|dragdrop';
      if (key !== qKey) {
        qKey = key;
        qBox.textContent = '';
        qBox.appendChild(h('p', { class: 'cf-qbanner' }));
        qBox.appendChild(h('p', { class: 'cf-sr', id: id + '-dd-help', text: 'Drag items onto drop targets. Keyboard: press Enter or Space on an item to pick it up, then on a drop target to place it. Press it again to put it back, or Escape to cancel.' }));
      }
      setText(qBox.firstChild, v.question.prompt);
    }

    // Matching: one native <select> per row with every choice (duplicates allowed).
    // Sequence (FR-7): a list reordered by insertion; Move up/down buttons are the keyboard path (the vendor has none).
    function renderListQuestion(v) {
      var q = v.question;
      var sorted = q.choices.map(function (c) { return c.id + ':' + c.label; }).sort(); // the order itself changes while answering
      var key = v.slide.id + '|' + q.type + '|' + sorted.join('|') + '|' + (q.rows || []).map(function (r) { return r.id + ':' + r.label; }).join('|');
      if (key !== qKey) {
        qKey = key;
        var body;
        if (q.type === 'matching') {
          body = q.rows.map(function (r) {
            var sid = id + '-m-' + r.id;
            return h('div', { class: 'cf-match' }, [
              h('label', { for: sid, text: r.label }),
              h('select', { id: sid, 'data-row': r.id, onchange: function (e) { send({ type: 'match', row: r.id, choice: e.target.value || null }); } },
                [h('option', { value: '', text: 'Choose…' })].concat(q.choices.map(function (c) { return h('option', { value: c.id, text: c.label }); }))),
            ]);
          });
        } else {
          body = [h('ol', { class: 'cf-seq' }, q.choices.map(function (c) {
            var li = h('li', { class: 'cf-seq-item', 'data-choice': c.id }, [
              h('span', { class: 'cf-seq-label', text: c.label }),
              h('button', { type: 'button', class: 'cf-seq-btn', 'data-dir': '-1', 'aria-label': 'Move ' + c.label + ' up', text: '↑' }),
              h('button', { type: 'button', class: 'cf-seq-btn', 'data-dir': '1', 'aria-label': 'Move ' + c.label + ' down', text: '↓' }),
            ]);
            li.addEventListener('click', function (e) {
              var b = e.target.closest('button');
              if (!b) return;
              var at = rt.view().question.choices.map(function (x) { return x.id; }).indexOf(c.id) + Number(b.getAttribute('data-dir'));
              send({ type: 'order', choice: c.id, index: at });
              live.textContent = c.label + ', position ' + (rt.view().question.choices.map(function (x) { return x.id; }).indexOf(c.id) + 1);
            });
            li.addEventListener('pointerdown', function (e) {
              if (e.button !== 0 || e.target.closest('button') || li.closest('fieldset').disabled) return;
              e.preventDefault();
              li.setPointerCapture(e.pointerId);
              var y0 = e.clientY, moved = false, scale = stage.getBoundingClientRect().width / doc.size.w;
              var mv = function (ev) { if (!moved && Math.abs(ev.clientY - y0) < 5) return; moved = true; li.classList.add('cf-dragging'); li.style.transform = 'translateY(' + (ev.clientY - y0) / scale + 'px)'; };
              var up = function (ev) {
                li.removeEventListener('pointermove', mv); li.removeEventListener('pointerup', up); li.removeEventListener('pointercancel', up);
                li.classList.remove('cf-dragging'); li.style.transform = '';
                if (!moved || ev.type === 'pointercancel') return;
                // Insertion by the midpoint rule (Q3): before the first other row whose middle is below the pointer.
                var others = [].slice.call(li.parentNode.children).filter(function (x) { return x !== li; });
                var at = others.length;
                for (var i = 0; i < others.length; i++) { var r = others[i].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { at = i; break; } }
                send({ type: 'order', choice: c.id, index: at });
              };
              li.addEventListener('pointermove', mv); li.addEventListener('pointerup', up); li.addEventListener('pointercancel', up);
            });
            return li;
          }))];
        }
        var form = h('form', { class: 'cf-question', novalidate: true, onsubmit: function (e) { e.preventDefault(); send({ type: 'submit' }); } },
          [h('fieldset', {}, [h('legend', {})].concat(body))]);
        qBox.textContent = '';
        qBox.appendChild(form);
      }
      var fs = qBox.querySelector('fieldset');
      setText(fs.querySelector('legend'), q.prompt);
      fs.disabled = !reviewing && (!!q.result || !!v.feedback);
      [].slice.call(fs.querySelectorAll('select,button')).forEach(function (c) { attr(c, 'aria-disabled', reviewing ? 'true' : null); });
      var label = function (cid) { var c = q.choices.filter(function (x) { return x.id === cid; })[0]; return c ? c.label : cid; };
      if (q.type === 'matching') q.rows.forEach(function (r) {
        var s = fs.querySelector('[data-row="' + r.id + '"]');
        if (s && s.value !== (r.selected || '')) s.value = r.selected || '';
        if (s) setTags(s.parentNode, !reviewing ? [] : r.selected === r.answer ? [['✓ Correct', 'ok']] : [['✕ Correct answer: ' + label(r.answer), 'bad']]);
      });
      else {
        var ol = fs.querySelector('.cf-seq'), had = document.activeElement;
        var lis = q.choices.map(function (c) { return ol.querySelector('[data-choice="' + c.id + '"]'); });
        syncChildren(ol, lis);
        if (had && had !== document.activeElement && ol.contains(had)) had.focus(); // a moved row keeps keyboard focus
        lis.forEach(function (li, i) { li.querySelector('[data-dir="-1"]').disabled = i === 0; li.querySelector('[data-dir="1"]').disabled = i === lis.length - 1; });
        // ponytail: the correct position comes from the review's answer labels; two items with one label share it.
        if (q.review) q.choices.forEach(function (c, i) { var at = q.review.answer.indexOf(c.label); setTags(lis[i], at === i ? [['✓ Correct position', 'ok']] : [['✕ Belongs at ' + (at + 1), 'bad']]); });
        else lis.forEach(function (li) { setTags(li, []); });
        if (had && had.disabled && ol.contains(had)) { var other = had.parentNode.querySelector('button:not([disabled])'); if (other) other.focus(); } // reached an end
      }
    }

    function renderQuestion(v) {
      var q = v.question;
      if (!q) { if (qKey !== null) { qBox.textContent = ''; qKey = null; } qBox.hidden = true; return; }
      qBox.hidden = false;
      if (q.type === 'hotspot') return renderHotspot(v);
      if (q.type === 'dragdrop') return renderDragBanner(v);
      if (q.type === 'matching' || q.type === 'sequence') return renderListQuestion(v);
      var key = v.slide.id + '|' + q.type + '|' + q.choices.map(function (c) { return c.id + ':' + c.label; }).join('|');
      if (key !== qKey) {
        qKey = key;
        var name = id + '-q-' + v.slide.id;
        var body;
        if (q.type === 'fill') {
          body = [h('input', { type: 'text', class: 'cf-answer', 'aria-label': 'Answer', autocomplete: 'off', spellcheck: 'false',
            oninput: function (e) { send({ type: 'input', answer: true, text: e.target.value }); } })];
        } else {
          body = q.choices.map(function (c) {
            return h('label', { class: 'cf-choice' }, [
              h('input', { type: q.type === 'mr' ? 'checkbox' : 'radio', name: name, value: c.id, 'data-choice': c.id,
                onchange: function () { send({ type: 'choose', choice: c.id }); } }),
              h('span', { text: c.label }),
            ]);
          });
        }
        var form = h('form', { class: 'cf-question', novalidate: true, onsubmit: function (e) { e.preventDefault(); send({ type: 'submit' }); } },
          [h('fieldset', {}, [h('legend', {})].concat(body))]);
        qBox.textContent = '';
        qBox.appendChild(form);
      }
      var fs = qBox.querySelector('fieldset');
      setText(fs.querySelector('legend'), q.prompt);
      fs.disabled = !reviewing && (!!q.result || !!v.feedback);
      if (q.type === 'fill') { var a = fs.querySelector('.cf-answer'); if (a.value !== q.text) a.value = q.text; a.readOnly = reviewing; }
      var authored = !!q.layout && !smallStage;
      fs.parentNode.classList.toggle('cf-authored', authored);
      function place(el, box) { applyStyle(el, authored ? objStyle(box) : {}); }
      place(fs.querySelector('legend'), q.layout && q.layout.prompt);
      if (q.type !== 'fill') q.choices.forEach(function (c, i) {
        var inp = fs.querySelector('[data-choice="' + c.id + '"]');
        if (!inp) return;
        if (inp.checked !== c.selected) inp.checked = c.selected;
        attr(inp, 'aria-disabled', reviewing ? 'true' : null);
        var row = inp.parentNode;
        place(row, q.layout && q.layout.choices[i]);
        row.classList.toggle('cf-rv-ok', reviewing && !!c.correct);
        row.classList.toggle('cf-rv-bad', reviewing && c.selected && !c.correct);
        setTags(row, !reviewing ? [] : [c.selected && ['Your answer', c.correct ? 'ok' : 'bad'], c.correct && ['✓ Correct answer', 'ok']].filter(Boolean));
      });
    }

    // ---------- menu ----------
    function renderMenu(v) {
      var m = v.menu;
      menuBtn.hidden = !m;
      menuBtn.setAttribute('aria-expanded', String(!!m && menuOpen));
      menu.hidden = !m || !menuOpen;
      if (!m) return;
      // A drawn question draw is a group: the draw's title over its drawn slides.
      var flat = function (list) { return [].concat.apply([], list.map(function (s) { return s.slides || [s]; })); };
      var key = JSON.stringify(m.map(function (sc) { return [sc.id, sc.title, sc.slides.map(function (s) { return [s.id, s.title, s.slides ? flat([s]).map(function (x) { return [x.id, x.title]; }) : 0]; })]; }));
      if (key !== menuKey) {
        menuKey = key;
        menu.textContent = '';
        var item = function (s) {
          return h('li', {}, [h('button', { type: 'button', class: 'cf-menu-item', 'data-slide': s.id, onclick: function () {
            if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) menuOpen = false; // overlay menu: get out of the way
            send({ type: 'menu', slide: s.id });
          } }, [
            h('span', { class: 'cf-menu-label', text: s.title }),
            h('span', { class: 'cf-check', hidden: true }, [h('span', { 'aria-hidden': 'true', text: '\u2713' }), h('span', { class: 'cf-sr', text: '(viewed)' })]),
          ])]);
        };
        m.forEach(function (sc) {
          menu.appendChild(h('h2', { text: sc.title }));
          menu.appendChild(h('ul', {}, sc.slides.map(function (s) {
            if (!s.slides) return item(s);
            var gid = id + '-draw-' + s.id;
            return h('li', { class: 'cf-menu-group' }, [h('span', { class: 'cf-menu-group-title', id: gid, text: s.title }), h('ul', { 'aria-labelledby': gid }, s.slides.map(item))]);
          })));
        });
      }
      m.forEach(function (sc) {
        flat(sc.slides).forEach(function (s) {
          var b = menu.querySelector('[data-slide="' + s.id + '"]');
          attr(b, 'aria-current', s.current ? 'page' : null);
          b.querySelector('.cf-check').hidden = !s.viewed;
        });
      });
    }

    // ---------- quiz review bar ----------
    function renderReview(v) {
      var r = v.review, rv = r && v.question && v.question.review;
      reviewBar.hidden = !rv;
      if (!rv) { reviewKey = null; return; }
      var word = rv.correct ? 'Correct' : 'Incorrect';
      var yours = rv.answered ? rv.yours.join(', ') || 'no answer' : 'not answered';
      rvStatus.setAttribute('data-result', rv.correct ? 'correct' : 'incorrect');
      setText(rvStatus.firstChild, rv.correct ? '✓' : '✕');
      setText(rvStatus.lastChild, word);
      setText(rvWhere, 'Question ' + (r.index + 1) + ' of ' + r.count);
      setText(rvYours.lastChild, yours);
      setText(rvAnswer.lastChild, rv.answer.join(', '));
      rvAnswer.hidden = rv.correct;
      var key = v.slide.id + '|' + r.index + '|' + r.count;
      if (key !== reviewKey) {
        reviewKey = key;
        live.textContent = 'Quiz review. Question ' + (r.index + 1) + ' of ' + r.count + ': ' + word + '. Your answer: ' + yours + '.' + (rv.correct ? '' : ' Correct answer: ' + rv.answer.join(', ') + '.');
      }
    }

    // ---------- render ----------
    function render(force) {
      var v = rt.view();
      var key = JSON.stringify(v) + '\u0000' + hovered + '\u0000' + menuOpen;
      if (!force && key === lastKey) return v;
      lastKey = key;
      var prevFocus = document.activeElement;
      var hadFocus = rootEl.contains(prevFocus);

      setText(titleEl, doc.title);
      renderMenu(v);
      reviewing = !!v.review;
      renderReview(v);
      var showNav = !!(doc.player && doc.player.prevNext) || reviewing; // review needs Prev/Next even when the course hides them
      prevBtn.hidden = nextBtn.hidden = !showNav;
      progressEl.hidden = !v.slide;
      if (!v.slide) {
        prevBtn.disabled = nextBtn.disabled = true; submitBtn.hidden = true;
        syncChildren(stage, []);
        fit();
        return v;
      }
      setText(slideTitleEl, v.slide.title);
      setText(progressEl, (v.slide.index + 1) + ' / ' + v.slide.count);
      attr(progressEl, 'aria-label', 'Slide ' + (v.slide.index + 1) + ' of ' + v.slide.count);
      attr(stage, 'aria-label', v.slide.title);
      stage.style.backgroundColor = v.slide.background || '';
      if (v.slide.id !== lastSlide) {
        grabbed = null;
        openMarker = null;
        if (!reviewing && (lastSlide !== null || v.slide.index > 0)) live.textContent = 'Slide ' + (v.slide.index + 1) + ' of ' + v.slide.count + ': ' + v.slide.title;
        lastSlide = v.slide.id;
      }

      // objects, grouped into one container per layer (DOM order = z-order = tab order)
      var clicks = clickTargets(v.slide.id);
      var roles = ddRoles(v);
      var wanted = dict(), present = dict();
      wanted.base = [];
      v.objects.forEach(function (o) {
        var el = els[o.id] || (els[o.id] = create(o));
        present[o.id] = true;
        updateObj(el, o, (!!clicks[o.id] || !!roles[o.id]) && o.type !== 'input');
        if (roles[o.id]) updateDrag(el, o, roles[o.id], v);
        else if (el._cfRole) { el._cfRole = null; el.classList.remove('cf-draggable', 'cf-grabbed', 'cf-droppable'); }
        var lid = o.layer || 'base';
        (wanted[lid] = wanted[lid] || []).push(el);
        if (el._cfCount) wanted[lid].push(el._cfCount);
      });
      Object.keys(els).forEach(function (oid) {
        if (present[oid]) return;
        var e = els[oid];
        if (typeof e.pause === 'function') e.pause(); // a detached video keeps playing otherwise
        if (e.parentNode) e.parentNode.removeChild(e);
        if (e._cfCount && e._cfCount.parentNode) e._cfCount.parentNode.removeChild(e._cfCount);
        delete els[oid];
      });
      var cc = v.objects.some(function (o) { return o.captions && o.visible; });
      ccBtn.hidden = !cc;
      ccBtn.setAttribute('aria-pressed', String(ccOn));
      var visibleLayers = v.layers.map(function (l) { return l.id; });
      var modal = null;
      v.layers.forEach(function (l) { if (l.modal) modal = l.id; });
      Object.keys(wanted).forEach(function (lid) {
        if (!boxes[lid]) boxes[lid] = h('div', { class: 'cf-layer', 'data-layer': lid });
        syncChildren(boxes[lid], wanted[lid]);
      });
      var hiddenLayers = Object.keys(wanted).filter(function (lid) { return lid !== 'base' && visibleLayers.indexOf(lid) < 0; });
      var docked = smallStage && !!v.question && v.question.type !== 'hotspot' && v.question.type !== 'dragdrop';
      viewport.classList.toggle('cf-docked', docked);
      frame.hidden = docked && !v.objects.some(function (o) { return o.visible; }); // an empty question slide adds nothing above the form
      if (docked && qBox.parentNode !== viewport) viewport.appendChild(qBox);
      var order = [boxes.base].concat(docked ? [] : [qBox], visibleLayers.concat(hiddenLayers).map(function (lid) {
        return boxes[lid] || (boxes[lid] = h('div', { class: 'cf-layer', 'data-layer': lid }));
      }));
      Object.keys(boxes).forEach(function (lid) { if (lid !== 'base' && order.indexOf(boxes[lid]) < 0) delete boxes[lid]; });
      order.forEach(function (box) {
        var lid = box.getAttribute('data-layer');
        if (lid) box.hidden = lid !== 'base' && visibleLayers.indexOf(lid) < 0;
        box.classList.toggle('cf-modal', !!lid && lid === modal);
        box.inert = !!modal && lid !== modal;
        // A modal layer is a dialog for assistive tech. Player controls stay usable: the runtime blocks only stage
        // clicks outside the layer (evidence; keyboard blocking is open question).
        var isModal = !!lid && lid === modal;
        attr(box, 'role', isModal ? 'dialog' : null);
        attr(box, 'aria-label', isModal ? (v.layers.filter(function (l) { return l.id === lid; })[0].title || 'Layer') : null);
      });
      syncChildren(stage, order);
      v.objects.forEach(function (o) { if (o.style && o.style.textFit && els[o.id]) fitText(els[o.id], o.style.textFit, o.style.valign); });
      renderQuestion(v);

      prevBtn.disabled = !v.nav.prev;
      nextBtn.disabled = !v.nav.next;
      submitBtn.hidden = !v.question || reviewing;
      // Our choice: no Submit until there is an answer (the runtime would only log "nothing to submit").
      submitBtn.disabled = !v.nav.submit || !v.question.answered;

      // feedback dialog
      if (v.feedback) {
        var f = FEEDBACK[v.feedback.kind] || [v.feedback.kind, ''];
        fbDlg.setAttribute('data-kind', v.feedback.kind);
        setText(fbTitle, f[0]);
        setText(fbIcon, f[1]);
        setText(fbText, v.feedback.text || '');
        fbText.hidden = !v.feedback.text;
        if (!fbDlg.open) { fbDlg.showModal(); fbBtn.focus(); }
      } else if (fbDlg.open) fbDlg.close();

      // focus: setFocus action, modal layer entry/exit, otherwise keep keyboard users inside the player.
      // A focused element that just became hidden/disabled/inert is still activeElement until Chrome's fixup.
      var lost = function () { var a = document.activeElement; return !a || a === document.body || !focusable(a); };
      if (pendingFocus && els[pendingFocus]) {
        var target = els[pendingFocus];
        pendingFocus = null;
        if (!target.matches('button,input,[tabindex]')) target.tabIndex = -1;
        if (focusable(target)) target.focus();
      } else if (modal && modal !== lastModal) {
        modalReturn = prevFocus;
        var first = boxes[modal].querySelector('button:not([disabled]),input:not([disabled]),[tabindex="0"]');
        if (first) first.focus();
      } else if (!modal && lastModal && lost() && focusable(modalReturn)) {
        modalReturn.focus();
      }
      if (hadFocus && !fbDlg.open && lost()) stage.focus();
      lastModal = modal;
      fit();
      return v;
    }

    // ---------- keyboard, clock ----------
    function onKey(e) {
      if (e.ctrlKey && e.altKey && !e.metaKey && e.code === 'KeyC' && !ccBtn.hidden && !e.defaultPrevented) { e.preventDefault(); toggleCaptions(); return; } // Ctrl+Alt+C (vendor shortcut)
      if (e.key === 'Escape' && grabbed && !e.defaultPrevented) { e.preventDefault(); grabbed = null; live.textContent = 'Cancelled.'; render(true); return; }
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !started || rootEl.querySelector('dialog[open]')) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      send({ type: 'key', key: e.key });
    }
    document.addEventListener('keydown', onKey);

    function tickFrame(t) {
      raf = requestAnimationFrame(tickFrame);
      if (!started || document.hidden || rt.state.finished || !rt.state.slide) { lastT = 0; return; }
      if (lastT) {
        var dt = Math.min(t - lastT, MAX_DT);
        // A tick changes state only by moving a running clock or logging (an end, a cue, a jump): when neither moved,
        // nothing can render differently, so a finished or paused timeline costs no view() per frame.
        var sig = rt.trace.length + JSON.stringify(rt.state.clock);
        if (dt > 0) { try { rt.tick(dt); } catch (e) { if (root.console) root.console.error(e); } if (sig !== rt.trace.length + JSON.stringify(rt.state.clock)) afterChange(); }
      }
      lastT = t;
    }
    raf = requestAnimationFrame(tickFrame);

    // ---------- resume prompt / start ----------
    function askResume(snap) {
      var dlgTitle = id + '-resume-title';
      var dlg, chosen = false;
      function choose(resume) {
        if (chosen) return;
        chosen = true;
        if (dlg.open) dlg.close();
        dlg.parentNode.removeChild(dlg);
        start(function () { if (resume) rt.restore(snap); else rt.start({ resume: 'never' }); });
      }
      var yes = h('button', { type: 'button', class: 'cf-btn cf-primary', text: 'Resume', onclick: function () { choose(true); } });
      dlg = h('dialog', { class: 'cf-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': dlgTitle }, [
        h('h2', { id: dlgTitle, text: 'Resume where you left off?' }),
        h('p', { text: 'Continue from the last slide you viewed, or start the course again.' }),
        h('div', { class: 'cf-dialog-actions' }, [h('button', { type: 'button', class: 'cf-btn', text: 'Restart', onclick: function () { choose(false); } }), yes]),
      ]);
      dlg.addEventListener('close', function () { choose(true); }); // Escape (native close) keeps progress
      rootEl.appendChild(dlg);
      render(true);
      dlg.showModal();
      yes.focus();
    }

    // when the first slide autoplays media, a click-to-start overlay comes first (browser autoplay policy)
    // the timeline waits for it. The resume prompt's button is such a click already.
    function autoplaysFirst() {
      var first = null;
      doc.scenes.some(function (sc) { first = sc.slides[0] || null; return !!first; });
      var byId = function (id) { return doc.slides.filter(function (x) { return x.id === id; })[0]; };
      var s = byId(first);
      // A first draw slide has no objects: any slide of its bank may come first.
      var bank = s && s.draw && (doc.banks || []).filter(function (b) { return b.id === s.draw.bank; })[0];
      return (bank ? bank.slides.map(byId) : [s]).some(function (x) {
        return !!x && x.objects.some(function (o) { return (o.type === 'video' || o.type === 'audio') && o.autoplay; });
      });
    }
    function askStart() {
      var go = h('button', { type: 'button', class: 'cf-btn cf-primary cf-start-btn', text: 'Start course' });
      var cover = h('div', { class: 'cf-start' }, [go]);
      go.addEventListener('click', function () { cover.parentNode.removeChild(cover); start(function () { rt.start(); }); stage.focus(); });
      viewport.appendChild(cover);
      render(true);
      go.focus();
    }

    if (opts.resumePrompt && typeof opts.resumePrompt === 'object') askResume(opts.resumePrompt);
    else if (rt.state.slide || rt.trace.length) { started = true; render(true); }
    else if (autoplaysFirst()) askStart();
    else start(function () { rt.start(); });

    return {
      rt: rt,
      render: function () { return render(true); },
      destroy: function () {
        Object.keys(captionUrls).forEach(function (k) { URL.revokeObjectURL(captionUrls[k]); });
        cancelAnimationFrame(raf);
        document.removeEventListener('keydown', onKey);
        if (ro) ro.disconnect(); else window.removeEventListener('resize', fit);
        if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
      },
    };
  }

  root.CFPlayer = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
