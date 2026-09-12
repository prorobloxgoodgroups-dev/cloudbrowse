import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { config } from './config.js';
import { Session } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });

const sessions = new Map();
let sharedBrowser = null;
let launching = null;
let seq = 0;

const CHROME_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox',       // required inside containers
  '--disable-dev-shm-usage',                        // /dev/shm is tiny on free tiers
  '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-sync', '--disable-translate',
  '--metrics-recording-only', '--mute-audio',
  '--hide-scrollbars=false',
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame',
  '--window-size=1440,900',
];

async function getBrowser() {
  if (sharedBrowser?.connected) return sharedBrowser;
  if (launching) return launching;
  launching = puppeteer.launch({
    executablePath: config.chromiumPath,
    headless: true,
    args: CHROME_ARGS,
    protocolTimeout: 120000,
  }).then((b) => {
    sharedBrowser = b;
    launching = null;
    b.on('disconnected', () => { sharedBrowser = null; });
    return b;
  }).catch((e) => { launching = null; throw e; });
  return launching;
}

app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, sessions: sessions.size, max: config.maxSessions }));
app.get('/api/status', (_req, res) =>
  res.json({ active: sessions.size, max: config.maxSessions, idleTimeoutSec: config.idleTimeoutSec }));

wss.on('connection', async (ws) => {
  ws.on('error', () => {});

  if (sessions.size >= config.maxSessions) {
    ws.send(JSON.stringify({ t: 'busy', active: sessions.size, max: config.maxSessions }));
    return ws.close();
  }

  // The client starts talking the instant the socket opens, but we still have a
  // browser to boot. Buffer whatever arrives in the meantime — an unlistened
  // 'message' event is simply lost, which used to swallow the 'init' frame.
  const queue = [];
  let onMsg = (raw) => queue.push(raw);
  ws.on('message', (raw, isBinary) => { if (!isBinary) onMsg(raw); });

  const id = String(++seq);
  let session = null, gone = false;
  ws.on('close', () => { gone = true; session?.close('disconnected'); });

  try {
    let context, ownBrowser = null;
    if (config.processPerSession) {
      ownBrowser = await puppeteer.launch({
        executablePath: config.chromiumPath, headless: true, args: CHROME_ARGS, protocolTimeout: 120000,
      });
      context = ownBrowser.defaultBrowserContext();
    } else {
      const browser = await getBrowser();
      context = await browser.createBrowserContext();   // isolated cookies/storage/cache
    }
    if (gone) {                                         // visitor left during boot
      await context.close?.().catch(() => {});
      await ownBrowser?.close().catch(() => {});
      return;
    }
    session = new Session({
      id, ws, context, browser: ownBrowser,
      onClose: (s) => sessions.delete(s.id),
    });
    sessions.set(id, session);
    session.send({
      t: 'ready', sid: id, active: sessions.size, max: config.maxSessions,
      idleTimeoutSec: config.idleTimeoutSec, homepage: config.homepage,
    });
  } catch (e) {
    console.error('[session] launch failed:', e.message);
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'fatal', msg: 'Could not start a browser: ' + e.message }));
    return ws.close();
  }

  // Control messages are serialised (init must finish before a nav runs);
  // input events bypass the chain so typing never queues behind a page load.
  let chain = Promise.resolve();
  const CONTROL = new Set(['init', 'resize', 'nav', 'back', 'fwd', 'reload', 'newtab', 'tab', 'closetab', 'copy']);

  async function apply(m) {
    switch (m.t) {
      case 'init':   return void await session.init(m.view);
      case 'resize': return void await session.resize(m.view);
      case 'nav':    return void await session.navigate(m.url);
      case 'back':   return void await session.history('back');
      case 'fwd':    return void await session.history('fwd');
      case 'reload': return void await session.reload();
      case 'newtab': return void await session.newTab(m.url || config.homepage);
      case 'tab':    return void await session.activate(String(m.id));
      case 'closetab': return void await session.closeTab(String(m.id));
      case 'copy':   return void await session.copySelection();
      case 'mouse':
        return void await session.cdpSend('Input.dispatchMouseEvent', {
          type: m.type, x: m.x, y: m.y, button: m.button || 'none',
          buttons: m.buttons || 0, clickCount: m.clickCount || 0,
          modifiers: m.modifiers || 0, deltaX: m.deltaX || 0, deltaY: m.deltaY || 0,
        });
      case 'key':
        return void await session.cdpSend('Input.dispatchKeyEvent', {
          type: m.type, key: m.key, code: m.code,
          windowsVirtualKeyCode: m.keyCode || 0, nativeVirtualKeyCode: m.keyCode || 0,
          text: m.text || undefined, unmodifiedText: m.text || undefined,
          modifiers: m.modifiers || 0, autoRepeat: !!m.repeat, isKeypad: false,
        });
      case 'text':
        if (typeof m.text === 'string' && m.text.length)
          return void await session.cdpSend('Input.insertText', { text: m.text.slice(0, 20000) });
        return;
      case 'touch':
        return void await session.cdpSend('Input.dispatchTouchEvent', {
          type: m.type, touchPoints: m.points || [], modifiers: m.modifiers || 0,
        });
      case 'ping':   return void session.send({ t: 'pong' });
    }
  }

  function dispatch(raw) {
    if (session.closed) return;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t !== 'ping') session.touch();   // heartbeats must not defeat the idle sweeper
    if (CONTROL.has(m.t)) chain = chain.then(() => apply(m)).catch(() => {});
    else apply(m).catch(() => {});
  }

  onMsg = dispatch;
  for (const raw of queue) dispatch(raw);
  queue.length = 0;
});

// Idle sweeper: no input for idleTimeoutSec -> tear the session down.
setInterval(() => {
  const cutoff = Date.now() - config.idleTimeoutSec * 1000;
  for (const s of sessions.values()) {
    if (s.lastActivity < cutoff) s.close('idle timeout').catch(() => {});
  }
}, 15000).unref?.();

server.listen(config.port, '0.0.0.0', () => {
  console.log(`CloudBrowse on http://0.0.0.0:${config.port}`);
  console.log(`  max sessions ${config.maxSessions} | idle kill ${config.idleTimeoutSec}s | chromium ${config.chromiumPath}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const s of [...sessions.values()]) await s.close('server shutdown');
    await sharedBrowser?.close().catch(() => {});
    process.exit(0);
  });
}
