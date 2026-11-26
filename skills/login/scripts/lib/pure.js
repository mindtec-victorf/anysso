'use strict';
/**
 * Pure helpers (no I/O, no browser) — everything here is covered by test/pure.test.js.
 */
const crypto = require('crypto');

/** IPv4/IPv6 literal or single-label host (localhost, intranet names). */
function isBareHost(host) {
  return /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.');
}

// Second-level labels that act as part of the public suffix under a 2-letter country TLD (co.uk).
const SECOND_LEVEL_LABELS = ['ac', 'co', 'com', 'coop', 'edu', 'gob', 'gov', 'int', 'ltd', 'mil', 'net', 'nom', 'org', 'plc', 'sch'];

/**
 * Registrable site of a host ("app.login.example.com" -> "example.com"), used to pick which
 * browser cookies belong to a target.
 * shortcut: no Public Suffix List — a 2-letter TLD under one of SECOND_LEVEL_LABELS counts as the
 * public suffix; upgrade to a PSL if a real site hits a case this misses.
 */
function siteOf(host) {
  host = String(host).toLowerCase().replace(/^\./, '').replace(/:\d+$/, '');
  if (isBareHost(host)) return host;
  const labels = host.split('.');
  const [sld, tld] = labels.slice(-2);
  const keep = tld.length === 2 && SECOND_LEVEL_LABELS.includes(sld) ? 3 : 2;
  return labels.length <= keep ? host : labels.slice(-keep).join('.');
}

/**
 * Resolve a site's `afterLogin` (a path or an absolute URL) against the target URL. `{origin}` in it
 * stands for the target's origin, for portals that open a system from a URL parameter. Returns the
 * absolute URL, or null when it is not on the same registrable site as the target.
 */
function resolveAfterLogin(afterLogin, targetUrl) {
  try {
    const t = new URL(targetUrl);
    const u = new URL(String(afterLogin).split('{origin}').join(t.origin), targetUrl);
    return /^https?:$/.test(u.protocol) && siteOf(u.hostname) === siteOf(t.hostname) ? u.href : null;
  } catch (_) { return null; }
}

/** Parse "WxH" (e.g. "520x720") into { width, height }, or null when malformed or out of range. */
function parseWindowSize(s) {
  const m = /^(\d{2,5})x(\d{2,5})$/i.exec(String(s).trim());
  if (!m) return null;
  const width = +m[1], height = +m[2];
  return width >= MIN_WINDOW_SIDE && height >= MIN_WINDOW_SIDE ? { width, height } : null;
}
const MIN_WINDOW_SIDE = 200; // below this, browsers clamp the window and the page is unusable

/** True when `version` ("22.13.1") is at least `min` ([22, 13]) on major, then minor. */
function nodeAtLeast(version, min) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A host glob where `*` is any run of chars (`*.test.example.com`, `app-*.example.com:8080`). */
function hostGlob(pattern, ...candidates) {
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$', 'i');
  return candidates.some((c) => re.test(c));
}

/**
 * The first site entry in `config.sites` whose `match` (a host/port, a hostname, or a glob of
 * either — string or array) fits the target. Matches against both host (with port) and hostname,
 * so `localhost:8080` and `*.test.example.com` both work. Returns null when nothing matches.
 */
function matchSite(config, host, hostname) {
  for (const site of (config && config.sites) || []) {
    const pats = Array.isArray(site.match) ? site.match : [site.match];
    if (pats.some((p) => p && hostGlob(p, host, hostname))) return site;
  }
  return null;
}

/**
 * True for hosts a parameterized login route may target by default: localhost, *.localhost,
 * *.local, 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, *.test, and bare
 * single-label names (intranet hosts).
 */
function isPrivateHost(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopback(h) || h.endsWith('.test') || (!h.includes('.') && !h.includes(':'))) return true; // bare intranet name
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127;
}

/** host is on the config's production denylist (globs over host and hostname). */
function isDenylisted(config, host, hostname) {
  return ((config && config.denylist) || []).some((p) => hostGlob(p, host, hostname));
}

/** Substitute {user} in a login route with the id behind `alias` in `users`; validate the pairing. */
function userRoute(route, users, alias) {
  if (!route.includes('{user}')) return route;
  if (!alias) { const e = new Error('this login route needs a user: pass --user <name> (one of: ' + Object.keys(users || {}).join(', ') + ')'); e.exitCode = 2; throw e; }
  const id = (users || {})[alias];
  if (id === undefined) { const e = new Error('unknown user "' + alias + '" (known: ' + Object.keys(users || {}).join(', ') + ')'); e.exitCode = 2; throw e; }
  return route.replace(/\{user\}/g, encodeURIComponent(id));
}

const FORBIDDEN_KEY = /^(pass(word|phrase)?|secret|token|credential|pin|otp|mfa)$/i;
/** Paths of any secret-bearing keys found anywhere in the config — a config file must never hold them. */
function forbiddenKeys(obj, path = '') {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? path + '.' + k : k;
    if (FORBIDDEN_KEY.test(k)) out.push(p);
    else out.push(...forbiddenKeys(v, p));
  }
  return out;
}

/** Centered box {width,height,left,top} inside a work area {x,y,width,height}. */
function centerBox(work, w, h) {
  const width = Math.min(w, work.width), height = Math.min(h, work.height);
  return { width, height, left: work.x + Math.max(0, Math.round((work.width - width) / 2)), top: work.y + Math.max(0, Math.round((work.height - height) / 2)) };
}

/** localhost, *.localhost, *.local, 127.0.0.0/8, ::1 — hosts where TLS errors are ignored automatically. */
function isLoopback(host) {
  host = host.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host === '::1' || /^127\./.test(host);
}

const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|log-?on|auth|authorize|sso|oauth2?|saml2?|cas|openid-connect|adfs)(\/|$)/i;

/** Path looks like a login/identity-provider endpoint (generic, language-neutral route names). */
function isLoginUrl(url) {
  try { return LOGIN_PATH.test(new URL(url).pathname); } catch (_) { return false; }
}

/**
 * Classify one page snapshot during login detection:
 *   'logged'    — on the target host and off any login screen
 *   'login'     — on the target host but on a login screen
 *   'elsewhere' — on another host (identity provider, SSO portal, about:blank)
 * With `loggedInSelector` the caller's explicit signal wins over the heuristic.
 */
function classify({ url, targetHost, hasPassword = false, selectorFound = null, httpStatus = null }) {
  let u;
  try { u = new URL(url); } catch (_) { return 'elsewhere'; }
  if (!/^https?:$/.test(u.protocol) || u.host !== targetHost) return 'elsewhere';
  // 401/403 on the page itself means "sign in first", even when it shows no password field.
  if (httpStatus === 401 || httpStatus === 403) return 'login';
  if (selectorFound !== null) return selectorFound ? 'logged' : 'login';
  return hasPassword || isLoginUrl(url) ? 'login' : 'logged';
}

/** host+pathname of an http(s) URL, or null. Never the query or fragment: they can carry tokens. */
function pagePath(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.host + u.pathname : null; } catch (_) { return null; }
}

const TRAIL_MAX = 30; // enough to show a portal hand-off; the oldest entries drop first

/** Append a page path to the trail unless it repeats the last one; keeps at most TRAIL_MAX entries. */
function pushTrail(trail, entry) {
  if (entry && trail[trail.length - 1] !== entry) { trail.push(entry); if (trail.length > TRAIL_MAX) trail.shift(); }
  return trail;
}
const addTrail = (trail, url) => pushTrail(trail, pagePath(url));

/**
 * Resolve a `verify` path or URL against the target; null unless it stays on the target's own
 * origin (the same rule as the login route).
 */
function resolveVerify(verify, targetUrl) {
  try {
    const t = new URL(targetUrl), u = new URL(String(verify), t);
    return u.origin === t.origin ? u.href : null;
  } catch (_) { return null; }
}

const HANDSHAKE_PATH = /\/(auth|sso|callback|token)(\/|$)/i;

/** Hint when the login window ended on the target's own login form and no login.start is set. */
function hintOwnLoginForm({ state, host, hasStart }) {
  return state === 'login' && !hasStart
    ? `${host} shows its own login form; if this system is opened from a portal, set login.start to the portal's sign-in page (see SKILL.md "Adapting to a new system")`
    : null;
}

/** Hint when verify failed and the last target-host page of the trail looks like a portal hand-off. */
function hintHandshake({ trail, host }) {
  const last = [...trail].reverse().find((e) => e === host || e.startsWith(host + '/'));
  return last && HANDSHAKE_PATH.test(last.slice(host.length))
    ? `the portal hand-off (${last}) did not authorize this account for ${host}; ask the user to open the system from the portal once, or use another account`
    : null;
}

/** Cookie (Playwright shape) is sent to `url` at time `now`. */
function cookieMatchesUrl(c, url, now = Date.now() / 1000) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const d = c.domain.toLowerCase();
  const domainOk = d.startsWith('.') ? (host === d.slice(1) || host.endsWith(d)) : host === d;
  const p = c.path || '/';
  const pathOk = u.pathname === p || u.pathname.startsWith(p.endsWith('/') ? p : p + '/');
  const secureOk = !c.secure || u.protocol === 'https:' || isLoopback(host);
  const alive = c.expires === -1 || c.expires === undefined || c.expires > now;
  return domainOk && pathOk && secureOk && alive;
}

function cookieHeader(cookies, url) {
  return cookies.filter((c) => cookieMatchesUrl(c, url)).map((c) => c.name + '=' + c.value).join('; ');
}

/** Netscape cookie jar (curl -b / wget --load-cookies). */
function netscapeJar(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by anysso — contains live session secrets.'];
  for (const c of cookies) {
    const sub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const exp = c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push([(c.httpOnly ? '#HttpOnly_' : '') + c.domain, sub, c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      exp, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** The JWT in an `Authorization: Bearer <jwt>` header, or null. */
function bearerOf(authHeader) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(authHeader || ''));
  return m && isJwt(m[1]) ? m[1] : null;
}

const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/;
function isJwt(s) {
  if (typeof s !== 'string' || !JWT.test(s)) return false;
  try { return !!JSON.parse(Buffer.from(s.split('.')[0], 'base64url').toString()).alg; } catch (_) { return false; }
}

/**
 * First bearer token found for `url` in a storageState: a JWT stored raw in localStorage, or an
 * access_token/id_token/token field inside a JSON value (oidc-client, MSAL, Auth0 SDK shapes),
 * then raw JWT cookies. Prefers access_token over id_token.
 */
function findToken(state, url) {
  // A token captured live from the flow (Authorization header) beats anything parked in storage:
  // it is the one the real app is actually sending, and the freshest is last.
  const net = (state.tokens || []).filter(isJwt);
  if (net.length) return net[net.length - 1];
  const origin = new URL(url).origin;
  const values = [];
  for (const o of state.origins || []) if (o.origin === origin) for (const e of o.localStorage || []) values.push(e.value);
  const found = [];
  const walk = (v, depth) => {
    if (depth > 4 || v == null) return;
    if (typeof v === 'string') {
      if (isJwt(v)) found.push({ rank: 2, v });
      else if (/^[[{]/.test(v)) { try { walk(JSON.parse(v), depth + 1); } catch (_) { /* not JSON */ } }
      return;
    }
    if (typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && /^(access_?token|accesstoken)$/i.test(k)) found.push({ rank: 0, v: x });
      else if (typeof x === 'string' && /^(id_?token|token|secret)$/i.test(k) && isJwt(x)) found.push({ rank: 1, v: x });
      else walk(x, depth + 1);
    }
  };
  values.forEach((v) => walk(v, 0));
  for (const c of (state.cookies || []).filter((c) => cookieMatchesUrl(c, url))) if (isJwt(c.value)) found.push({ rank: 3, v: c.value });
  found.sort((a, b) => a.rank - b.rank);
  return found.length ? found[0].v : null;
}

/** Keep only cookies/origins whose site is in `sites` — a saved session never carries unrelated logins. */
function filterState(state, sites) {
  const set = new Set(sites);
  const hostOf = (o) => { try { return new URL(o).hostname; } catch (_) { return ''; } };
  return {
    cookies: (state.cookies || []).filter((c) => set.has(siteOf(c.domain))),
    origins: (state.origins || []).filter((o) => set.has(siteOf(hostOf(o.origin)))),
  };
}

// --- Chromium cookie decryption (Linux "v10"/"v11", macOS "v10": AES-128-CBC) ---
function chromiumKey(password, iterations) {
  return crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

/**
 * Decrypt one `encrypted_value`. Returns null for formats we cannot read (Windows DPAPI/app-bound
 * "v20", wrong key). Chromium DB version >= 24 prefixes the plaintext with SHA-256(host_key).
 */
function chromiumDecrypt(enc, key, hostKey) {
  const buf = Buffer.from(enc);
  const prefix = buf.subarray(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return null;
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    let out = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
    const h = crypto.createHash('sha256').update(hostKey).digest();
    if (out.length >= 32 && out.subarray(0, 32).equals(h)) out = out.subarray(32);
    return out.toString('utf8');
  } catch (_) { return null; }
}

/** Chromium expires_utc (µs since 1601-01-01) -> Unix seconds, -1 for session cookies. */
function chromiumExpiry(us) {
  const n = Number(us);
  return n > 0 ? n / 1e6 - 11644473600 : -1;
}

/** Firefox expiry (seconds, or ms in newer builds) -> Unix seconds, -1 for session cookies. */
function firefoxExpiry(v) {
  const n = Number(v);
  const s = n > 1e11 ? n / 1000 : n;
  return s > 0 ? s : -1;
}

const SAMESITE = { 0: 'None', 1: 'Lax', 2: 'Strict' };
const sameSite = (v) => SAMESITE[v] || 'Lax';

module.exports = {
  siteOf, resolveAfterLogin, parseWindowSize, nodeAtLeast, hostGlob, matchSite, isPrivateHost, isDenylisted, userRoute, forbiddenKeys, centerBox,
  isLoopback, isLoginUrl, classify, pagePath, pushTrail, addTrail, resolveVerify, hintOwnLoginForm, hintHandshake, cookieMatchesUrl, cookieHeader, netscapeJar,
  isJwt, bearerOf, findToken, filterState, chromiumKey, chromiumDecrypt, chromiumExpiry, firefoxExpiry, sameSite,
};
