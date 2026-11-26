#!/usr/bin/env node
'use strict';
/**
 * anysso — log in to any web system once (SSO or not) and reuse the session from scripts, tests
 * and AI agents. The order of attempts for `anysso login` is documented in skills/login/SKILL.md.
 *
 * stdout carries only machine-readable output (a path, a header, a jar); logs go to stderr.
 * Exit codes: 0 ok · 1 not logged in / login failed · 2 usage · 3 missing dependency.
 */
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const P = require('./lib/pure');
const store = require('./lib/store');
const cookies = require('./lib/cookies');
const config = require('./lib/config');

const VERSION = require('../../../package.json').version;
const MIN_NODE = [22, 13]; // node:sqlite (browser cookie import) needs this release
const DEFAULT_WINDOW_SIZE = '520x720'; // narrow enough to read as a popup, tall enough for most SSO forms
const MAX_BROWSER_SESSIONS = 3; // browser sessions tried per login; more would slow a failing login
const DEFAULT_TIMEOUT_S = 300; // a human signs in, MFA included
const log = (m) => process.stderr.write('anysso: ' + m + '\n');

const HELP = `anysso ${VERSION} — log in once, reuse the session anywhere

Usage:
  anysso login <url> [options]     ensure a logged-in session; prints the storageState path
  anysso export <url> --format <f> print the session as: header | netscape | json | state | token
  anysso status                    list saved sessions (no secret values)
  anysso logout <url|host>         delete saved sessions for a host (--all: every host)
  anysso consent [--revoke]        allow (or revoke) reading your browsers' cookies
  anysso doctor                    check Node, Playwright, browsers and the login window
  anysso config check              validate the resolved config file (see "Site config" in SKILL.md)
  anysso config add --site '<json>' [--file <path>] [--yes]
                                   add or replace a site entry (default file: $ANYSSO_HOME/sites.json); dry run without --yes

Login options:
  --account <name>       keep several identities per host (default: "default")
  --fresh                ignore the saved session
  --no-browser           do not look at your browsers' cookies
  --no-window            never open the login window (fail instead) — for CI
  --site <domain>        extra cookie site to import, e.g. the identity provider (repeatable)
  --logged-in <css>      element that only exists when logged in (overrides the heuristic)
  --timeout <seconds>    how long the login window waits (default 300)
  --window-size <WxH>    login window size in pixels (default 520x720)
  --title <text>         what the login window is for, shown in its title and taskbar
  --insecure             accept invalid TLS certificates (automatic for loopback hosts)
  --config <file.json>   site config (hosts + login routes); default ./.anysso.json or $ANYSSO_HOME/sites.json
  --user <name>          test-user alias for a parameterized login route (from the config's "users")
  --verify <path|url>    after a login succeeds, open it in a fresh headless context and accept only if it
                         stays on the target, off a login route, without a password field (config key: verify)
  --json                 print {"file","source","strategy","host","account","trail","landed","hints"} instead of the path
`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      account: { type: 'string' }, fresh: { type: 'boolean' },
      'no-browser': { type: 'boolean' }, 'no-window': { type: 'boolean' }, site: { type: 'string', multiple: true },
      'logged-in': { type: 'string' }, timeout: { type: 'string' }, 'window-size': { type: 'string' }, title: { type: 'string' }, insecure: { type: 'boolean' },
      config: { type: 'string' }, user: { type: 'string' }, verify: { type: 'string' }, file: { type: 'string' }, yes: { type: 'boolean' },
      json: { type: 'boolean' }, format: { type: 'string' }, all: { type: 'boolean' }, revoke: { type: 'boolean' },
      'forget-window': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    },
  });
  return { cmd: positionals[0], arg: positionals[1], o: values };
}

function targetOf(raw) {
  if (!raw) throw usage('missing <url>');
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (_) { throw usage('invalid URL: ' + raw); }
  if (!/^https?:$/.test(u.protocol)) throw usage('only http(s) URLs are supported');
  return u;
}

function usage(msg) { const e = new Error(msg); e.exitCode = 2; return e; }

function windowSizeOf(raw) {
  const size = P.parseWindowSize(raw || DEFAULT_WINDOW_SIZE);
  if (!size) throw usage('invalid --window-size: ' + raw + ' (expected WxH, e.g. 520x720, each side >= 200)');
  return size;
}

function timeoutOf(raw, site) {
  if (raw === undefined) return site.timeout || DEFAULT_TIMEOUT_S;
  const n = Number(raw);
  if (!(n > 0)) throw usage('invalid --timeout: ' + raw + ' (expected a positive number of seconds)');
  return n;
}

// --- login ---
async function login(u, o) {
  const size = windowSizeOf(o['window-size']);
  const B = require('./lib/browser');
  const url = u.href;
  const host = u.host;
  const found = config.resolvePath(o.config);
  let cfg = null, site = null;
  if (found) {
    const r = config.load(found.file);
    if (r.problems.length) throw usage('invalid config ' + found.file + ':\n  - ' + r.problems.join('\n  - '));
    cfg = r.config;
    const t = config.trustedSite(P.matchSite(cfg, host, u.hostname) || {}, found.origin);
    site = t.site;
    log(`config: ${found.file} (${found.origin})` + (P.matchSite(cfg, host, u.hostname) ? '' : ' — no site matched ' + host));
    if (t.dropped.length) log(`ignoring ${t.dropped.join(', ')} from the project file ${found.file}: pass it with --config, or set ANYSSO_TRUST_PROJECT_CONFIG=1, to trust it`);
  } else { site = {}; }
  const insecure = !!o.insecure || !!site.insecure || P.isLoopback(u.hostname);
  const selector = o['logged-in'] || site.loggedIn;
  const sites = new Set([P.siteOf(u.hostname), ...(o.site || []).map(P.siteOf), ...(site.cookieSites || []).map(P.siteOf)]);
  const prevTokens = (!o.fresh && store.loadSession(host, o.account) || {}).tokens || [];
  const verifyRaw = o.verify || site.verify;
  const verifyUrl = verifyRaw ? P.resolveVerify(verifyRaw, url) : null;
  if (verifyRaw && !verifyUrl) throw usage(`verify ${verifyRaw} must resolve to the target origin (${u.origin})`);
  const trail = [], hints = [];
  const addHint = (h) => { if (h && !hints.includes(h)) { hints.push(h); log('hint: ' + h); } };
  const report = (extra) => { // the trail line and hints, on stderr
    (extra || []).forEach((e) => P.pushTrail(trail, e));
    if (trail.length) log('trail: ' + trail.join(' \u2192 '));
  };
  // With --json a failure still prints what the agent needs to adapt: the trail, the landing and hints.
  const failJson = (error, landed = null) => {
    if (o.json) process.stdout.write(JSON.stringify({ ok: false, error, host, account: o.account, trail, landed, hints }) + '\n');
  };
  // Returns 0 once saved, or null when --verify rejects the session (nothing is saved).
  const done = async (state, source, tokens, r = {}) => {
    const saved = P.filterState(state, sites);
    (r.trail || []).forEach((e) => P.pushTrail(trail, e));
    if (verifyUrl) {
      const v = await B.verify(verifyUrl, saved, { selector, insecure });
      if (!v.ok) {
        log(`verify failed: ${verifyRaw} landed on ${v.landed}`);
        addHint(P.hintHandshake({ trail: r.trail || [], host }));
        return null;
      }
    }
    // Keep tokens captured earlier; a plain revisit may send none, and an old bearer beats none.
    const all = [...prevTokens, ...(tokens || [])];
    const merged = all.filter((t, i) => all.lastIndexOf(t) === i); // dedup, keep freshest position
    if (merged.length) saved.tokens = merged;
    const file = store.saveSession(host, o.account, saved);
    log(`logged in to ${host} via ${source}` + (tokens && tokens.length ? ` (+${tokens.length} bearer token${tokens.length > 1 ? 's' : ''})` : ''));
    report();
    process.stdout.write((o.json ? JSON.stringify({ ok: true, file, source, strategy: source, host, account: o.account, trail, landed: r.landed || null, hints }) : file) + '\n');
    return 0;
  };
  const learn = (hosts) => hosts.forEach((h) => sites.add(P.siteOf(h)));

  // 1. saved session (or, without one, a cookie-less visit that reveals the identity provider)
  const saved = o.fresh ? null : store.loadSession(host, o.account);
  const first = await B.probe(url, { state: saved, selector, insecure });
  learn(first.hosts);
  if (first.status === 'logged') {
    if (!saved) log('warning: the page loaded without any session — it may not require login, or pass --logged-in <css>');
    const c = await done(first.state, saved ? 'saved session' : 'no login needed', first.tokens, first);
    if (c !== null) return c;
  } else {
    (first.trail || []).forEach((e) => P.pushTrail(trail, e));
    if (saved) log('saved session expired');
  }

  // 2. a parameterized login route from the config that authenticates on visit (dev/test routes)
  if (site.login && site.login.route) {
    const r = config.resolveLogin(cfg, site, o.user, url, host, u.hostname);
    if (r.blocked) log('config login route not used: ' + r.blocked);
    else if (r.mode === 'route') {
      const p = await B.probe(url, { visitFirst: r.url, selector, insecure });
      learn(p.hosts);
      if (p.status === 'logged') { const c = await done(p.state, 'config login route', p.tokens, p); if (c !== null) return c; }
      log('config login route did not log in (' + p.status + ')');
    }
  }

  // 3. the user's own browsers
  if (!o['no-browser']) {
    if (!store.hasConsent()) {
      log('tip: run `anysso consent` once to reuse the login you already have in your browser');
    } else {
      const sources = cookies.readSessions([...sites], { log });
      if (!sources.length) log(`no browser session found for ${[...sites].join(', ')}`);
      for (const src of sources.slice(0, MAX_BROWSER_SESSIONS)) {
        const r = await B.probe(url, { cookies: src.cookies, selector, insecure });
        if (r.status === 'logged') { const c = await done(r.state, `${src.browser} session`, r.tokens, r); if (c !== null) return c; }
        log(`${src.browser} session did not log in (${r.status})`);
      }
    }
  }

  // 4. login window
  if (o['no-window']) { log(`not logged in to ${host} and --no-window was given`); report(); failJson('not logged in and --no-window was given'); return 1; }
  const timeoutMs = timeoutOf(o.timeout, site) * 1000;
  const hasStart = !!(site.login && site.login.start);
  let w;
  try {
    w = await B.loginWindow(url, { selector, insecure, timeoutMs, log, size, afterLogin: site.afterLogin, start: site.login && site.login.start, title: o.title });
  } catch (e) {
    report(e.trail);
    if (e.last) addHint(P.hintOwnLoginForm({ state: e.last.state, host, hasStart }));
    failJson(String(e.message).split('\n')[0], e.last && e.last.url ? P.pagePath(e.last.url) : null);
    throw e;
  }
  learn(w.hosts);
  const c = await done(w.state, 'login window', w.tokens, w);
  if (c === null) { report(); failJson('verify rejected the session', w.landed || null); return 1; }
  return c;
}

// --- export / status / logout / consent / doctor ---
function exportSession(u, o) {
  const state = store.loadSession(u.host, o.account);
  if (!state) { log(`no saved session for ${u.host} — run: anysso login ${u.href}`); return 1; }
  const f = o.format || 'header';
  let out;
  if (f === 'header') out = P.cookieHeader(state.cookies, u.href);
  else if (f === 'netscape') out = P.netscapeJar(state.cookies).trimEnd();
  else if (f === 'json') out = JSON.stringify(state.cookies.filter((c) => P.cookieMatchesUrl(c, u.href)), null, 2);
  else if (f === 'state') out = store.sessionFile(u.host, o.account);
  else if (f === 'token') {
    out = P.findToken(state, u.href);
    if (!out) { log(`no bearer token found in the session for ${u.origin} (cookie-based login? use --format header)`); return 1; }
  } else throw usage('unknown --format: ' + f + ' (header | netscape | json | state | token)');
  process.stdout.write(out + '\n');
  return 0;
}

function status() {
  const now = Date.now() / 1000;
  const rows = store.listSessions();
  if (!rows.length) { log('no saved sessions'); return 0; }
  for (const s of rows) {
    const exps = s.state.cookies.map((c) => c.expires).filter((e) => e > 0);
    const soonest = exps.length ? Math.min(...exps) : null;
    const exp = soonest === null ? 'session cookies' : soonest < now ? 'EXPIRED cookies' : 'until ' + new Date(soonest * 1000).toISOString().slice(0, 16).replace('T', ' ');
    process.stdout.write(`${s.host}\t${s.account}\t${s.state.cookies.length} cookies\tsaved ${s.savedAt.toISOString().slice(0, 16).replace('T', ' ')}\t${exp}\n`);
  }
  return 0;
}

function logout(arg, o) {
  if (o['forget-window']) { fs.rmSync(path.join(store.HOME(), 'profile'), { recursive: true, force: true }); log('login window profile removed'); }
  if (o.all) { fs.rmSync(path.join(store.HOME(), 'sessions'), { recursive: true, force: true }); log('all sessions removed'); return 0; }
  if (!arg) { if (o['forget-window']) return 0; throw usage('missing <url|host> (or --all)'); }
  const host = targetOf(arg).host;
  const n = store.removeSession(host, o.account);
  log(n ? `removed ${n} session(s) for ${host}` : `no session for ${host}`);
  return 0;
}

function consent(o) {
  store.setConsent(!o.revoke);
  log(o.revoke ? 'browser cookie access revoked' : 'browser cookie access granted — only cookies of the site you log in to (and its identity provider) are read');
  return 0;
}

function doctor() {
  const ok = (b, m) => process.stdout.write((b ? 'ok   ' : 'MISS ') + m + '\n');
  const tested = process.platform === 'win32' || cookies.isWsl();
  process.stdout.write(`info platform: ${process.platform}${cookies.isWsl() ? ' (WSL)' : ''} — ${tested ? 'tested' : 'not tested yet; reports and PRs welcome'}\n`);
  ok(P.nodeAtLeast(process.versions.node, MIN_NODE), `Node ${process.versions.node} (>= ${MIN_NODE.join('.')} required)`);
  ok(cookies.sqliteAvailable(), 'node:sqlite (reads browser cookie databases)');
  let pw = null;
  try { pw = require('./lib/browser').playwright(); } catch (_) { /* reported below */ }
  ok(!!pw, 'Playwright' + (pw ? '' : ' — npm i -g playwright'));
  if (pw) {
    let exe = '';
    try { exe = pw.chromium.executablePath(); } catch (_) { /* not installed */ }
    ok(exe && fs.existsSync(exe), 'Chromium for headless checks' + (exe && fs.existsSync(exe) ? '' : ' — npx playwright install chromium'));
  }
  const srcs = cookies.listSources();
  const by = {};
  srcs.forEach((s) => { by[s.browser] = (by[s.browser] || 0) + 1; });
  ok(srcs.length > 0, 'browser profiles: ' + (Object.entries(by).map(([b, n]) => `${b} (${n})`).join(', ') || 'none readable'));
  if (process.platform === 'win32' || cookies.isWsl()) process.stdout.write('info Chromium-family cookies on Windows are not readable (see README); Firefox-family and the login window work\n');
  ok(store.hasConsent(), 'consent to read browser cookies' + (store.hasConsent() ? '' : ' — anysso consent'));
  if (process.platform === 'linux' && !cookies.isWsl()) ok(!!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY), 'display for the login window');
  process.stdout.write('info state dir: ' + store.HOME() + '\n');
  try { const f = config.resolvePath(); process.stdout.write('info config: ' + (f ? `${f.file} (${f.origin})` : 'none (optional)') + '\n'); } catch (_) { /* none */ }
  return 0;
}

function configAdd(o) {
  const raw = o.site || [];
  if (raw.length !== 1) throw usage('config add needs exactly one --site \'<json object>\'');
  let site;
  try { site = JSON.parse(raw[0]); } catch (e) { throw usage('--site is not valid JSON: ' + e.message); }
  if (!site || typeof site !== 'object' || Array.isArray(site)) throw usage('--site must be a JSON object (one site entry)');
  const file = o.file ? path.resolve(o.file) : config.homeFile();
  let existing = {};
  if (fs.existsSync(file)) {
    const r = config.load(file);
    if (r.problems.length) throw usage('existing config ' + file + ' is invalid:\n  - ' + r.problems.join('\n  - '));
    existing = r.config;
  }
  const merged = config.mergeSite(existing, site);
  const { problems } = config.validate(merged);
  if (problems.length) throw usage('invalid site entry:\n  - ' + problems.join('\n  - '));
  process.stdout.write(JSON.stringify(site, null, 2) + '\nfile: ' + file + '\n');
  if (!o.yes) { process.stdout.write('dry run: pass --yes to write\n'); return 0; }
  config.writeFile(file, merged);
  process.stdout.write('written\n');
  return 0;
}

function configCheck(arg, o) {
  if (arg === 'add') return configAdd(o);
  if (arg && arg !== 'check') throw usage('unknown config subcommand: ' + arg + ' (config check | config add)');
  const found = config.resolvePath(o.config);
  if (!found) { log(`no config file found (looked for --config, ./.anysso.json, ${config.homeFile()})`); return 0; }
  const { problems } = config.load(found.file);
  if (!problems.length) { process.stdout.write(`ok   ${found.file} (${found.origin}): valid\n`); return 0; }
  process.stdout.write(`FAIL ${found.file} (${found.origin}):\n` + problems.map((p) => '  - ' + p).join('\n') + '\n');
  return 2;
}

async function main(argv) {
  const { cmd, arg, o } = parse(argv);
  const acct = { ...o, account: o.account || 'default' };
  if (o.version) { process.stdout.write(VERSION + '\n'); return 0; }
  if (o.help || !cmd || cmd === 'help') { process.stdout.write(HELP); return cmd || o.help ? 0 : 2; }
  switch (cmd) {
    case 'login': return login(targetOf(arg), acct);
    case 'export': return exportSession(targetOf(arg), acct);
    case 'status': return status();
    case 'logout': return logout(arg, o);
    case 'consent': return consent(o);
    case 'doctor': return doctor();
    case 'config': return configCheck(arg, o);
    default: throw usage('unknown command: ' + cmd);
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  // Deliberate (exitCode-bearing) errors print in full; unexpected ones show only their first line.
  log((e.exitCode ? '' : 'error: ') + (e.exitCode ? e.message : e.message.split('\n')[0]));
  if (!e.exitCode && process.env.ANYSSO_DEBUG) console.error(e);
  process.exitCode = e.exitCode || (String(e.code).startsWith('ERR_PARSE_ARGS') ? 2 : 1);
});
