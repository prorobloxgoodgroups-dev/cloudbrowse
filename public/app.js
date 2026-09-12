/* CloudBrowse client: draws JPEG frames from the server and relays input back. */
(() => {
  const $ = (id) => document.getElementById(id);
  const screenEl = $('screen'), ctx = screenEl.getContext('2d', { alpha: false });
  const stage = $('stage'), omni = $('omni'), ime = $('ime');
  const overlay = $('overlay'), ovTitle = $('ov-title'), ovMsg = $('ov-msg'),
        ovBtn = $('ov-btn'), spinner = document.querySelector('.spinner');

  const TOUCH = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
  const MOBILE = TOUCH && Math.min(innerWidth, innerHeight) < 560;

  let ws = null, view = { width: 1280, height: 720 }, pending = null, drawing = false;
  let tabs = [], omniFocused = false, connected = false;

  /* ---------- connection ---------- */
  function wsUrl() {
    const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${p}//${location.host}/ws`;
  }

  function connect() {
    showOverlay('Starting a browser for you…',
      'A real Chromium is booting on the server. It is streamed here as images; nothing runs on your device.', false);
    ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      connected = true;
      send({ t: 'init', view: viewport() });
      setStatus('connected');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return onFrame(ev.data);
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      connected = false;
      setStatus('disconnected');
      if (overlay.hidden) showOverlay('Session ended', 'The virtual browser was closed. Start a new one whenever you like.', true);
    };
    ws.onerror = () => setStatus('connection error');
  }

  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  function handle(m) {
    switch (m.t) {
      case 'ready':
        $('sessioninfo').textContent = `${m.active}/${m.max} sessions · idle ${m.idleTimeoutSec}s`;
        setStatus('ready');
        break;
      case 'busy':
        showOverlay('All browsers are busy',
          `${m.active} of ${m.max} sessions are in use. Sessions are released automatically when they go idle — try again in a moment.`, true);
        break;
      case 'fatal':
        showOverlay('Could not start a browser', m.msg, true);
        break;
      case 'booted':          // first tab exists and is streaming
        hideOverlay();
        setStatus('ready');
        break;
      case 'view':
        view = { width: m.width, height: m.height };
        screenEl.width = m.width; screenEl.height = m.height;
        break;
      case 'tabs':
        tabs = m.tabs; renderTabs();
        break;
      case 'loading':
        setStatus(m.loading ? 'loading…' : 'ready');
        break;
      case 'clip':
        if (m.text) navigator.clipboard?.writeText(m.text)
          .then(() => toast('Copied selection to your clipboard'))
          .catch(() => toast('Clipboard blocked by your browser'));
        else toast('Nothing selected in the virtual browser');
        break;
      case 'toast': toast(m.msg); break;
      case 'closed':
        showOverlay('Session ended', `Reason: ${m.reason}.`, true);
        break;
    }
  }

  /* ---------- frames ---------- */
  function onFrame(buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] !== 0x01) return;
    pending = new Blob([u8.subarray(1)], { type: 'image/jpeg' });
    if (!drawing) { drawing = true; requestAnimationFrame(paint); }
  }

  async function paint() {
    const blob = pending; pending = null;
    if (!blob) { drawing = false; return; }
    try {
      const bmp = await createImageBitmap(blob);
      if (screenEl.width !== bmp.width || screenEl.height !== bmp.height) {
        screenEl.width = bmp.width; screenEl.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close?.();
    } catch {}
    if (pending) requestAnimationFrame(paint); else drawing = false;
  }

  /* ---------- geometry ---------- */
  function viewport() {
    const r = stage.getBoundingClientRect();
    return {
      width: Math.round(r.width), height: Math.round(r.height),
      dpr: Math.min(2, devicePixelRatio || 1), mobile: MOBILE, touch: TOUCH,
    };
  }
  function toPage(clientX, clientY) {
    const r = screenEl.getBoundingClientRect();
    return {
      x: Math.round((clientX - r.left) * (view.width / r.width)),
      y: Math.round((clientY - r.top) * (view.height / r.height)),
    };
  }
  let rzTimer;
  new ResizeObserver(() => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => connected && send({ t: 'resize', view: viewport() }), 250);
  }).observe(stage);

  /* ---------- mouse / wheel ---------- */
  const MOD = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const BTN = ['left', 'middle', 'right', 'back', 'forward'];
  let buttons = 0;

  if (!TOUCH) {
    screenEl.addEventListener('mousedown', (e) => {
      e.preventDefault(); focusKeys();
      buttons |= 1 << e.button;
      const p = toPage(e.clientX, e.clientY);
      send({ t: 'mouse', type: 'mousePressed', ...p, button: BTN[e.button] || 'left',
             buttons, clickCount: e.detail || 1, modifiers: MOD(e) });
    });
    addEventListener('mouseup', (e) => {
      if (!connected) return;
      buttons &= ~(1 << e.button);
      const p = toPage(e.clientX, e.clientY);
      send({ t: 'mouse', type: 'mouseReleased', ...p, button: BTN[e.button] || 'left',
             buttons, clickCount: e.detail || 1, modifiers: MOD(e) });
    });
    let moveAt = 0;
    screenEl.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - moveAt < 16) return;            // ~60 moves/s is plenty
      moveAt = now;
      const p = toPage(e.clientX, e.clientY);
      send({ t: 'mouse', type: 'mouseMoved', ...p, button: buttons ? 'left' : 'none',
             buttons, modifiers: MOD(e) });
    });
    screenEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = toPage(e.clientX, e.clientY);
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.height : 1;   // lines/pages -> px
      send({ t: 'mouse', type: 'mouseWheel', ...p, button: 'none', buttons,
             deltaX: e.deltaX * k, deltaY: e.deltaY * k, modifiers: MOD(e) });
    }, { passive: false });
  }
  screenEl.addEventListener('contextmenu', (e) => e.preventDefault());
  screenEl.addEventListener('dblclick', (e) => e.preventDefault());

  /* ---------- touch ---------- */
  if (TOUCH) {
    const points = (tl) => [...tl].map((t) => {
      const p = toPage(t.clientX, t.clientY);
      return { x: p.x, y: p.y, id: t.identifier, radiusX: 12, radiusY: 12, force: 1 };
    });
    const relay = (type) => (e) => {
      e.preventDefault();
      if (type === 'touchStart') focusKeys();
      const list = type === 'touchEnd' || type === 'touchCancel' ? e.changedTouches : e.touches;
      send({ t: 'touch', type, points: points(list), modifiers: 0 });
    };
    screenEl.addEventListener('touchstart', relay('touchStart'), { passive: false });
    screenEl.addEventListener('touchmove', relay('touchMove'), { passive: false });
    screenEl.addEventListener('touchend', relay('touchEnd'), { passive: false });
    screenEl.addEventListener('touchcancel', relay('touchCancel'), { passive: false });
  }

  /* ---------- keyboard, IME, clipboard ---------- */
  function focusKeys() { if (document.activeElement !== omni) ime.focus({ preventScroll: true }); }
  $('kbd').addEventListener('click', () => { ime.focus({ preventScroll: true }); });

  const NON_PRINTING = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp',
    'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert']);

  ime.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;         // let IME finish
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    if (printable || NON_PRINTING.has(e.key)) e.preventDefault();
    if (e.key === 'Tab') e.preventDefault();
    send({ t: 'key', type: printable ? 'keyDown' : 'rawKeyDown', key: e.key, code: e.code,
           keyCode: e.keyCode, text: printable ? e.key : (e.key === 'Enter' ? '\r' : ''),
           modifiers: MOD(e), repeat: e.repeat });
  });
  ime.addEventListener('keyup', (e) => {
    if (e.isComposing) return;
    send({ t: 'key', type: 'keyUp', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: MOD(e) });
  });
  // IME / soft-keyboard path: composed text (Thai, CJK, autocorrect, swipe typing)
  // arrives as whole strings rather than key events, so it goes in via insertText.
  let composing = false, skipInput = false;
  ime.addEventListener('compositionstart', () => { composing = true; });
  ime.addEventListener('compositionend', (e) => {
    composing = false; skipInput = true;
    if (e.data) send({ t: 'text', text: e.data });
    ime.value = '';
  });
  ime.addEventListener('input', (e) => {
    if (e.isComposing || composing) return;
    if (skipInput) { skipInput = false; ime.value = ''; return; }   // already sent by compositionend
    if (ime.value) { send({ t: 'text', text: ime.value }); ime.value = ''; }
  });
  ime.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text');
    if (text) send({ t: 'text', text });
  });
  $('copybtn').addEventListener('click', () => send({ t: 'copy' }));

  /* ---------- chrome UI ---------- */
  $('omniform').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = omni.value.trim();
    if (v) { send({ t: 'nav', url: v }); omni.blur(); focusKeys(); }
  });
  omni.addEventListener('focus', () => { omniFocused = true; omni.select(); });
  omni.addEventListener('blur', () => { omniFocused = false; syncOmni(); });

  $('back').onclick = () => send({ t: 'back' });
  $('fwd').onclick = () => send({ t: 'fwd' });
  $('reload').onclick = () => send({ t: 'reload' });
  $('newtab').onclick = () => send({ t: 'newtab' });
  $('full').onclick = () => {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else (el.requestFullscreen?.() || el.webkitRequestFullscreen?.())?.catch?.(() => {});
  };

  function renderTabs() {
    const host = $('tabs');
    host.innerHTML = '';
    for (const t of tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t.active ? ' active' : '');
      el.title = t.url || t.title;
      const label = document.createElement('span');
      label.className = 't';
      label.textContent = t.title || hostOf(t.url) || 'New tab';
      el.appendChild(label);
      if (tabs.length > 1) {
        const x = document.createElement('button');
        x.className = 'x'; x.textContent = '×';
        x.onclick = (ev) => { ev.stopPropagation(); send({ t: 'closetab', id: t.id }); };
        el.appendChild(x);
      }
      el.onclick = () => { if (!t.active) send({ t: 'tab', id: t.id }); };
      host.appendChild(el);
    }
    syncOmni();
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
  function syncOmni() {
    if (omniFocused) return;
    const a = tabs.find((t) => t.active);
    if (!a) return;
    const u = a.url || '';
    // chrome-error:// is Chromium's internal error page; keep what the user typed.
    if (u.startsWith('chrome-error')) return;
    omni.value = u && u !== 'about:blank' ? u : '';
    $('lock').textContent = u.startsWith('https') ? '\u{1F512}' : '\u2609';
  }

  /* ---------- overlays / status ---------- */
  function showOverlay(title, msg, retry) {
    ovTitle.textContent = title; ovMsg.textContent = msg;
    ovBtn.hidden = !retry; spinner.hidden = !!retry;
    overlay.hidden = false;
  }
  function hideOverlay() { overlay.hidden = true; }
  ovBtn.onclick = () => { try { ws?.close(); } catch {} connect(); };
  function setStatus(s) { $('status').textContent = s; }
  let toastTimer;
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  setInterval(() => connected && send({ t: 'ping' }), 30000);   // keeps the session non-idle only while the tab is open
  connect();
})();
