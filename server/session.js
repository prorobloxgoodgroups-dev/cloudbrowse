import { config } from './config.js';
import { normalize, isPrivate } from './urls.js';

let tabSeq = 0;
const FRAME_HEADER = 0x01;

/**
 * One Session == one visitor == one isolated browser context holding N tabs.
 * Only the ACTIVE tab is screencast; background tabs keep running but cost no
 * encode time. Frames go out as raw binary (1 header byte + JPEG) so we pay no
 * base64 tax.
 */
export class Session {
  constructor({ id, ws, context, browser, onClose }) {
    this.id = id;
    this.ws = ws;
    this.context = context;
    this.browser = browser;       // set only when processPerSession
    this.onClose = onClose;
    this.tabs = new Map();        // tabId -> { page, cdp, casting, title, url }
    this.activeId = null;
    this.view = { width: 1280, height: 720, dpr: 1, mobile: false, touch: false };
    this.lastActivity = Date.now();
    this.closed = false;
    this.pendingOwn = 0;   // tabs we are opening ourselves right now
    this.booted = false;
    this.queuedNav = null;
  }

  touch() { this.lastActivity = Date.now(); }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendFrame(b64) {
    if (this.ws.readyState !== 1) return;
    // Drop frames rather than queue them when the client can't keep up.
    if (this.ws.bufferedAmount > 2_000_000) return;
    const jpeg = Buffer.from(b64, 'base64');
    const out = Buffer.allocUnsafe(jpeg.length + 1);
    out[0] = FRAME_HEADER;
    jpeg.copy(out, 1);
    this.ws.send(out);
  }

  get active() { return this.tabs.get(this.activeId); }

  async init(view) {
    Object.assign(this.view, view || {});
    this.context.on('targetcreated', async (target) => {
      if (target.type() !== 'page') return;
      if (this.pendingOwn > 0) return;            // our own newTab() is mid-flight
      try {
        const page = await target.page();
        if (!page) return;
        for (const t of this.tabs.values()) if (t.page === page) return; // ours already
        if (this.tabs.size >= config.maxTabs) { await page.close().catch(() => {}); return; }
        await this.adopt(page, { activate: true });
      } catch {}
    });
    await this.newTab(config.homepage);
    this.booted = true;
    this.send({ t: 'booted' });
    if (this.queuedNav) { const u = this.queuedNav; this.queuedNav = null; await this.navigate(u); }
  }

  async newTab(url) {
    if (this.tabs.size >= config.maxTabs) {
      this.send({ t: 'toast', msg: `Tab limit reached (${config.maxTabs}).` });
      return;
    }
    this.pendingOwn++;
    let tab;
    try {
      const page = await this.context.newPage();
      tab = await this.adopt(page, { activate: true });
    } finally {
      this.pendingOwn--;
    }
    if (url && url !== 'about:blank') await this.navigate(url, tab.id);
    return tab;
  }

  async adopt(page, { activate } = {}) {
    const id = String(++tabSeq);
    const tab = { id, page, cdp: null, casting: false, title: 'New tab', url: page.url() || '' };
    this.tabs.set(id, tab);

    await this.applyViewport(page);
    page.setDefaultNavigationTimeout(45000);

    const sync = () => {
      tab.url = page.url();
      this.pushState();
    };
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) sync(); });
    page.on('load', async () => {
      try { tab.title = (await page.title()) || tab.url; } catch {}
      this.pushState();
      if (tab.id === this.activeId) await this.kick(tab);
    });
    page.on('domcontentloaded', () => this.pushState());
    page.on('dialog', async (d) => {
      this.send({ t: 'toast', msg: `Page dialog (${d.type()}): ${d.message()}`.slice(0, 300) });
      await d.dismiss().catch(() => {});
    });
    page.on('close', () => {
      this.tabs.delete(id);
      if (this.activeId === id) {
        const next = [...this.tabs.keys()].pop() || null;
        this.activeId = null;
        if (next) this.activate(next).catch(() => {});
        else this.close('last tab closed');
      }
      this.pushState();
    });

    if (activate) await this.activate(id);
    else this.pushState();
    return tab;
  }

  async applyViewport(page) {
    const { width, height, dpr, mobile, touch } = this.view;
    if (process.env.DEBUG_VIEW) console.log('[applyViewport]', JSON.stringify(this.view));
    await page.setViewport({
      width: Math.max(320, Math.min(config.maxWidth, Math.round(width))),
      height: Math.max(320, Math.min(config.maxHeight, Math.round(height))),
      deviceScaleFactor: Math.min(2, Math.max(1, dpr || 1)),
      isMobile: !!mobile,
      hasTouch: !!touch,
    }).catch(() => {});
    // Tell the client the exact frame geometry so it can map input coordinates.
    const vp = page.viewport();
    if (vp) this.send({ t: 'view', width: vp.width, height: vp.height });
  }

  async resize(view) {
    Object.assign(this.view, view || {});
    const tab = this.active;
    if (!tab) return;
    await this.applyViewport(tab.page);
    if (tab.casting) { await this.stopCast(tab); await this.startCast(tab); }
  }

  async activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const prev = this.active;
    if (prev && prev !== tab) await this.stopCast(prev);
    this.activeId = id;
    await this.applyViewport(tab.page);
    await tab.page.bringToFront().catch(() => {});
    await this.startCast(tab);
    this.pushState();
    await this.kick(tab);
  }

  async startCast(tab) {
    if (tab.casting) return;
    try {
      tab.cdp = tab.cdp || await tab.page.createCDPSession();
      tab.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
        if (tab.id === this.activeId) this.sendFrame(data);
        // Always ack, or Chromium stops producing frames.
        try { await tab.cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
      });
      await tab.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: config.jpegQuality,
        maxWidth: config.maxWidth,
        maxHeight: config.maxHeight,
        everyNthFrame: 1,
      });
      tab.casting = true;
    } catch (e) {
      this.send({ t: 'toast', msg: 'Stream failed to start: ' + e.message });
    }
  }

  async stopCast(tab) {
    if (!tab?.casting) return;
    tab.casting = false;
    try { await tab.cdp.send('Page.stopScreencast'); } catch {}
  }

  /** Screencast only emits on visual change, so nudge a frame out after loads. */
  async kick(tab) {
    try {
      await tab.cdp?.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, button: 'none' });
    } catch {}
  }

  pushState() {
    const tabs = [...this.tabs.values()].map((t) => ({
      id: t.id, title: t.title || t.url || 'New tab', url: t.url, active: t.id === this.activeId,
    }));
    this.send({ t: 'tabs', tabs, max: config.maxTabs });
  }

  async navigate(input, tabId) {
    const tab = tabId ? this.tabs.get(tabId) : this.active;
    if (!tab) { if (!this.booted) this.queuedNav = input; return; }
    const href = normalize(input, config);
    if (!href) { this.send({ t: 'toast', msg: 'That address scheme is not supported.' }); return; }
    if (!config.allowPrivateNet && isPrivate(href)) {
      this.send({ t: 'toast', msg: 'Blocked: private/local network addresses are not reachable.' });
      return;
    }
    this.send({ t: 'loading', loading: true });
    try {
      await tab.page.goto(href, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      this.send({ t: 'toast', msg: 'Navigation error: ' + e.message.split('\n')[0] });
    } finally {
      this.send({ t: 'loading', loading: false });
      await this.kick(tab);
    }
  }

  async history(dir) {
    const tab = this.active; if (!tab) return;
    try { dir === 'back' ? await tab.page.goBack() : await tab.page.goForward(); } catch {}
    await this.kick(tab);
  }

  async reload() {
    const tab = this.active; if (!tab) return;
    try { await tab.page.reload({ waitUntil: 'domcontentloaded' }); } catch {}
    await this.kick(tab);
  }

  async closeTab(id) {
    const tab = this.tabs.get(id); if (!tab) return;
    await tab.page.close().catch(() => {});
  }

  async cdpSend(method, params) {
    const tab = this.active;
    if (!tab?.cdp) return;
    try { await tab.cdp.send(method, params); } catch {}
  }

  async copySelection() {
    const tab = this.active; if (!tab) return;
    try {
      const text = await tab.page.evaluate(() => {
        const s = window.getSelection?.().toString();
        if (s) return s;
        const el = document.activeElement;
        if (el && 'value' in el && el.selectionStart !== el.selectionEnd) {
          return String(el.value).slice(el.selectionStart, el.selectionEnd);
        }
        return '';
      });
      this.send({ t: 'clip', text: text || '' });
    } catch { this.send({ t: 'clip', text: '' }); }
  }

  async close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    for (const tab of this.tabs.values()) {
      await this.stopCast(tab);
      await tab.page.close().catch(() => {});
    }
    this.tabs.clear();
    // Destroy the context (or the whole browser) so nothing survives the visit.
    await this.context?.close?.().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.send({ t: 'closed', reason });
    try { this.ws.close(); } catch {}
    this.onClose?.(this);
  }
}
