---
title: CloudBrowse
emoji: 🌐
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# CloudBrowse — a virtual browser inside your browser

A real Chromium runs on a server. You never receive its HTML — you receive **JPEG
frames of it**, and your clicks and keystrokes travel back the other way. This is
the same method commercial services such as Browserling use ("remote browser
isolation"), rebuilt from scratch on free infrastructure.

The page you visit is rendered on the server, so nothing about it touches the
visitor's device: no cookies, no JavaScript execution, no downloads, and no
`X-Frame-Options` or `Content-Security-Policy` to fight — those only apply to
`<iframe>` embedding, which this project deliberately does not use.

## How it works

```
   VISITOR'S BROWSER                          SERVER (one container)
 ┌────────────────────────┐               ┌──────────────────────────────┐
 │  tab strip / URL bar   │               │  Node.js  ── WebSocket ─┐    │
 │  ┌──────────────────┐  │   JPEG frames │                        │    │
 │  │   <canvas>       │◄─┼───────────────┤  Chrome DevTools Protocol   │
 │  │  (just pixels)   │  │               │   • Page.startScreencast    │
 │  └──────────────────┘  │               │   • Input.dispatch*Event    │
 │   mouse / keys / touch ├───────────────►                        │    │
 └────────────────────────┘  input events │  Chromium (headless)   ◄────┘│
                                          │   └ one incognito context    │
                                          │     per visitor: isolated    │
                                          │     cookies, storage, cache  │
                                          └──────────────────────────────┘
```

1. The visitor opens the page and a WebSocket connects to `/ws`.
2. The server gives that visitor an isolated browser context and opens a tab.
3. `Page.startScreencast` makes Chromium emit a JPEG **only when pixels change**.
   Each frame is sent as raw binary (1 header byte + JPEG — no base64 tax) and
   acknowledged, and the client paints it to a `<canvas>` inside `requestAnimationFrame`.
4. Pointer, wheel, key, IME and touch events are mapped from canvas coordinates
   into page coordinates and replayed with `Input.dispatchMouseEvent`,
   `Input.dispatchKeyEvent`, `Input.insertText` and `Input.dispatchTouchEvent`.
5. When the socket closes — or after `IDLE_TIMEOUT_SEC` with no input — the whole
   context is destroyed. Nothing survives the visit.

**Why not an iframe + a proxy that strips CSP?** Because it breaks: every major
site blocks framing, self-refreshing and redirecting pages escape the frame,
relative URLs need rewriting, logins break, and a page that goes fullscreen takes
over the *real* browser. Streaming pixels has none of those problems — a page
going fullscreen inside the virtual browser only fills the virtual window, exactly
like a remote-desktop session.

## Deploy free on Hugging Face Spaces

Free tier: 2 vCPU / 16 GB RAM, no credit card, public HTTPS URL, WebSockets work.

1. Create an account at <https://huggingface.co/join> (use a shared project
   account if this is for a group).
2. **New → Space**. Give it a name, choose **Docker → Blank**, hardware **CPU basic (free)**,
   visibility **Public**.
3. Upload every file in this repo (`Files → Add file → Upload files`, keep the
   `server/` and `public/` folder structure), or push with git:

   ```bash
   git init && git add . && git commit -m "CloudBrowse"
   git remote add origin https://huggingface.co/spaces/<account>/<space-name>
   git push -u origin main
   ```

4. Wait for the build (3–6 min the first time — it installs Chromium).
5. Open the Space URL. Use **⛶** for fullscreen; it works on phones and iPads.

The YAML block at the top of this README is what tells the Space to build the
Dockerfile and serve port 7860 — keep it.

> Free Spaces sleep after ~48 h with no visitors and wake on the next request.
> For a live demo, open it once a few minutes beforehand so the first browser
> launch is already warm.

## Run it locally instead

```bash
docker build -t cloudbrowse .
docker run --rm -p 7860:7860 cloudbrowse        # then open http://localhost:7860
```

Or without Docker (needs Node 20+ and a local Chromium/Chrome):

```bash
npm install
CHROMIUM_PATH=/usr/bin/chromium PORT=7860 npm start
```

## Configuration

All of these are environment variables (on a Space: *Settings → Variables and secrets*).

| Variable | Default | What it does |
|---|---|---|
| `MAX_SESSIONS` | `10` | Concurrent visitors. Beyond this, new arrivals get a "busy" screen. |
| `MAX_TABS` | `8` | Tabs per visitor. |
| `IDLE_TIMEOUT_SEC` | `120` | No input for this long → the session is destroyed. This is what keeps 10 sessions affordable. |
| `JPEG_QUALITY` | `55` | 30 = cheap and blocky, 80 = sharp and heavy. |
| `MAX_WIDTH` / `MAX_HEIGHT` | `1440` / `900` | Cap on the streamed viewport. |
| `HOMEPAGE` | `https://duckduckgo.com` | Page each new tab opens. |
| `SEARCH_URL` | `https://duckduckgo.com/?q=` | Used when the address bar gets words instead of a URL. |
| `PROCESS_PER_SESSION` | `0` | `1` = a separate Chromium process per visitor (stronger isolation, ~5× the RAM). |
| `ALLOW_PRIVATE_NET` | `0` | `1` removes the block on `localhost`/private-IP addresses. |
| `CHROMIUM_PATH` | `/usr/bin/chromium` | Browser binary. |
| `PORT` | `7860` | HTTP + WebSocket port. |

`GET /api/status` returns `{active, max, idleTimeoutSec}`, and `GET /healthz` is a health check.

## What works

- Multiple tabs, including pop-ups a page opens itself (`target="_blank"`)
- Back / forward / reload, address bar with search-or-URL detection
- Mouse, drag, right-click, scroll wheel; touch, tap and pinch on phones/iPads
- Full keyboard relay, plus IME and soft-keyboard input (Thai, CJK, swipe typing)
  via `Input.insertText`
- Paste into the virtual browser, and a **⎘** button to copy the remote selection
  back to your real clipboard
- Fullscreen, responsive layout, idle cleanup, busy screen when full

## Known limits

- **No downloads or file uploads.** Files would have to be relayed back over the
  socket; not implemented.
- **No audio.** Screencast carries pixels only. Video plays but is silent, and
  frame rate on 2 free vCPUs is modest.
- **Not a security product.** Sessions are isolated from each other and destroyed
  after use, but this is a public, unauthenticated browser: anyone with the URL
  can browse through your server's IP address. Don't sign into real accounts in it.
- Only the active tab is streamed (background tabs keep running but cost no encoding).
- `ALLOW_PRIVATE_NET=0` blocks the address bar from reaching the host's own
  network; it does not filter every sub-resource a page requests.

## Layout

```
Dockerfile          Chromium + Node image, runs as uid 1000 for Spaces
server/config.js    every tunable, all env-overridable
server/urls.js      address-bar parsing + private-network guard
server/session.js   one visitor: tabs, screencast, input, teardown
server/index.js     HTTP + WebSocket, session pool, idle sweeper
public/             the client: canvas renderer, tab strip, input capture
```
