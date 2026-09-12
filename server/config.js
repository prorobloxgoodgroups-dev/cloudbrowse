// All tunables in one place. Every value can be overridden with an env var,
// which on Hugging Face Spaces you set under Settings -> Variables and secrets.
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 7860),               // HF Spaces expects 7860
  maxSessions: num(process.env.MAX_SESSIONS, 10),  // concurrent visitors
  maxTabs: num(process.env.MAX_TABS, 8),           // tabs per visitor
  idleTimeoutSec: num(process.env.IDLE_TIMEOUT_SEC, 120), // kill after no input
  jpegQuality: num(process.env.JPEG_QUALITY, 55),  // 30 = cheap, 80 = pretty
  maxWidth: num(process.env.MAX_WIDTH, 1440),
  maxHeight: num(process.env.MAX_HEIGHT, 900),
  homepage: process.env.HOMEPAGE || 'https://duckduckgo.com',
  searchUrl: process.env.SEARCH_URL || 'https://duckduckgo.com/?q=',
  chromiumPath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  // One Chromium process per visitor is heavier but fully isolated.
  // Default: one process, one incognito context per visitor (isolated
  // cookies/storage/cache, ~5x cheaper on RAM).
  processPerSession: process.env.PROCESS_PER_SESSION === '1',
  // Basic SSRF hygiene: stop the address bar reaching the host's own network.
  allowPrivateNet: process.env.ALLOW_PRIVATE_NET === '1',
};
