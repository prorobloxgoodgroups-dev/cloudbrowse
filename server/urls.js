// Turn whatever the user typed into a URL, and keep the address bar from
// pointing at the host's own private network.
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|\[?::1\]?|.*\.local|.*\.internal)$/i;
const PRIVATE_IP = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function normalize(input, { searchUrl }) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^(about|chrome|file|view-source|devtools):/i.test(raw)) return null;
  let url = raw;
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    || (/^[^\s]+\.[a-z]{2,}([/:?#].*)?$/i.test(raw) && !raw.includes(' '));
  if (!looksLikeUrl) return searchUrl + encodeURIComponent(raw);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return searchUrl + encodeURIComponent(raw);
  }
}

export function isPrivate(href) {
  try {
    const host = new URL(href).hostname.replace(/^\[|\]$/g, '');
    if (PRIVATE_HOST.test(host)) return true;
    return PRIVATE_IP.some((re) => re.test(host));
  } catch {
    return false;
  }
}
