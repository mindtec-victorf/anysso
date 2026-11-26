'use strict';
/**
 * Browser side: resolve Playwright, probe whether a session is logged in (headless), and run the
 * small login window when no session works.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const P = require('./pure');
const { isWsl } = require('./cookies');
const store = require('./store');

let pw;
function playwright() {
  if (pw) return pw;
  const cands = ['playwright'];
  if (process.env.ANYSSO_PLAYWRIGHT_DIR) cands.push(process.env.ANYSSO_PLAYWRIGHT_DIR);
  try {
    const o = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const g = (process.platform === 'win32' ? cp.execSync('npm root -g', o) : cp.execFileSync('npm', ['root', '-g'], o)).trim();
    if (g) cands.push(path.join(g, 'playwright'));
  } catch (_) { /* no npm on PATH: try the other candidates */ }
  for (const c of cands) {
    try { pw = require(c); return pw; } catch (_) { /* next */ }
  }
  const e = new Error('Playwright not found. Install it: npm i -g playwright && npx playwright install chromium');
  e.exitCode = 3;
  throw e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POLL_MS = 1000; // one page snapshot per second: fast enough to feel instant, cheap on CPU
const PROBE_POLLS = 12; // client-side SSO redirects usually settle within ~12 s
const NAV_TIMEOUT_MS = 30000; // a slow identity provider can take this long to answer
const IDLE_TIMEOUT_MS = 5000; // best-effort wait for network idle after navigation
const POWERSHELL_TIMEOUT_MS = 5000; // the work-area query is optional; give up quickly
const CDP_POLL_MS = 300; // port file polling interval
const CDP_PORT_WAIT_MS = 15000; // Edge needs a moment to write DevToolsActivePort
const LOGGED_POLLS = 2; // consecutive polls on the same logged-in page before it counts as signed in
const STUCK_POLLS = 3; // consecutive polls on the same off-target page before AnySSO reopens
const MAX_REOPENS = 2; // reopening twice covers a redirect chain; more would fight the user

// HTTP status of each page's latest main-document response (401/403 = not signed in).
const docStatus = new WeakMap();
function trackStatus(page) {
  page.on('response', (r) => {
    try { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) docStatus.set(page, r.status()); } catch (_) { /* page closing */ }
  });
}

async function snapshot(page, targetHost, selector) {
  const url = page.url();
  let hasPassword = false;
  let selectorFound = null;
  try {
    hasPassword = await page.evaluate(() => [...document.querySelectorAll('input[type=password]')]
      .some((e) => e.getClientRects().length > 0));
    if (selector) selectorFound = (await page.$(selector)) !== null;
  } catch (_) { /* page navigating: classify by URL only */ }
  return { url, state: P.classify({ url, targetHost, hasPassword, selectorFound, httpStatus: docStatus.get(page) || null }) };
}

/** Hosts a context's pages navigate through (main frames) — reveals the identity provider. */
function trackHosts(ctx, hosts, trail) {
  const watch = (page) => page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) {
      try { const h = new URL(f.url()).hostname; if (h) hosts.add(h); } catch (_) { /* about: */ }
      if (trail) P.addTrail(trail, f.url());
    }
  });
  ctx.pages().forEach(watch);
  ctx.on('page', watch);
}

/**
 * Collect bearer tokens the app sends during the flow (the `Authorization` header on XHR/fetch to
 * the target site and its identity provider) into `tokens`, newest last, deduped. This is the token
 * an agent would put in `curl` — it is the user's own session, captured as it flows.
 */
function trackTokens(ctx, tokens) {
  ctx.on('request', (req) => {
    let t = null;
    try { t = P.bearerOf(req.headers().authorization); } catch (_) { /* header gone */ }
    if (t && tokens[tokens.length - 1] !== t) { const i = tokens.indexOf(t); if (i >= 0) tokens.splice(i, 1); tokens.push(t); }
  });
}

/**
 * Open `url` headless with the given cookies/storageState and report where it lands:
 * { status: 'logged'|'login'|'elsewhere', hosts, state }. Waits for client-side SSO redirects to
 * settle (up to PROBE_POLLS seconds) before deciding.
 */
async function probe(url, { state, cookies, selector, insecure, visitFirst }) {
  const targetHost = new URL(url).host;
  const b = await playwright().chromium.launch();
  try {
    // Playwright's storageState only knows cookies/origins; our extra keys (tokens) must not leak in.
    const ss = state ? { cookies: state.cookies || [], origins: state.origins || [] } : undefined;
    const ctx = await b.newContext({ storageState: ss, ignoreHTTPSErrors: !!insecure });
    if (cookies && cookies.length) await ctx.addCookies(cookies);
    const hosts = new Set();
    const tokens = [];
    const trail = [];
    trackHosts(ctx, hosts, trail);
    trackTokens(ctx, tokens);
    const page = await ctx.newPage();
    trackStatus(page);
    // A login route that authenticates on visit (from the site config): hit it, then the target.
    if (visitFirst) { try { await page.goto(visitFirst, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }); } catch (_) { /* judged below */ } }
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }); } catch (_) { /* judged below */ }
    await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
    let last = null;
    let status = 'elsewhere';
    for (let i = 0; i < PROBE_POLLS; i++) {
      const s = await snapshot(page, targetHost, selector);
      if (s.state === 'logged' && last && last.state === 'logged') { status = 'logged'; break; }
      if (last && s.url === last.url && s.state !== 'logged') { status = s.state; break; }
      status = s.state;
      last = s;
      await sleep(POLL_MS);
    }
    return { status, hosts, tokens, trail, landed: P.pagePath(page.url()), state: await ctx.storageState() };
  } finally {
    await b.close();
  }
}

/**
 * Open `url` (already resolved to the target origin) in a fresh headless context with `state` and
 * report { ok, landed }: ok only when it ends on the target host, off a login route, without a
 * password field (and matching `selector` when set).
 */
async function verify(url, state, { selector, insecure }) {
  const r = await probe(url, { state, selector, insecure });
  return { ok: r.status === 'logged', landed: r.landed };
}

// --- Login window ---

// WSLg headed Chromium needs the Wayland backend when a GPU render node exists, X11 otherwise.
function linuxHeadedArgs() {
  const has = (f) => { try { return fs.existsSync(f); } catch (_) { return false; } };
  const wslg = !!process.env.WAYLAND_DISPLAY || has('/mnt/wslg');
  const ozone = process.env.ANYSSO_OZONE_PLATFORM || (wslg ? (has('/dev/dri') ? 'wayland' : 'x11') : '');
  return ozone ? ['--ozone-platform=' + ozone] : [];
}

/**
 * WSL: when the Windows host's Edge is reachable, open the login there (--app popup, own profile
 * %LOCALAPPDATA%\anysso that keeps the identity provider session) driven over CDP on 127.0.0.1;
 * needs WSL networkingMode=mirrored. Any failure returns null and the caller uses a local browser.
 */
const EDGE_EXE = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
async function openNativeEdge(url, log, box) {
  if (!isWsl() || process.env.ANYSSO_NO_NATIVE || !fs.existsSync(EDGE_EXE)) return null;
  // Separate args: WSL interop quotes them itself (manual quotes break cmd.exe).
  const cmd = (...a) => cp.spawnSync('cmd.exe', ['/c', ...a], { cwd: '/mnt/c', encoding: 'utf8' });
  try {
    const dir = cmd('echo', '%LOCALAPPDATA%').stdout.trim() + '\\anysso';
    const portFile = dir + '\\DevToolsActivePort';
    cmd('del', '/q', portFile);
    cp.spawn(EDGE_EXE, ['--app=' + url, '--remote-debugging-port=0', '--user-data-dir=' + dir,
      '--no-first-run', '--no-default-browser-check', ...popupArgs(box)],
    { cwd: '/mnt/c', stdio: 'ignore', detached: true }).unref();
    // Port 0 = Edge picks one; read it via cmd.exe (drvfs misses freshly created files).
    let port = '';
    for (const t0 = Date.now(); !port && Date.now() - t0 < CDP_PORT_WAIT_MS;) {
      const r = cmd('type', portFile);
      if (r.status === 0 && /^\d+/.test(r.stdout)) port = r.stdout.split(/\r?\n/)[0].trim();
      else await sleep(CDP_POLL_MS);
    }
    if (!port) throw new Error(`debugging port did not appear in ${CDP_PORT_WAIT_MS / 1000}s`);
    const eb = await playwright().chromium.connectOverCDP('http://127.0.0.1:' + port);
    // browser.close() only disconnects a CDP session; Browser.close really closes Edge.
    const close = async () => { try { await (await eb.newBrowserCDPSession()).send('Browser.close'); } catch (_) { /* gone */ } };
    return { ctx: eb.contexts()[0], close, opened: true };
  } catch (e) {
    log(`host Edge unavailable (${e.message}) — using a local browser`);
    return null;
  }
}


// The primary screen's work area (Windows/WSL via PowerShell), or null off Windows / on failure.
function workArea() {
  if (process.platform !== 'win32' && !isWsl()) return null;
  const r = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $a=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($a.X) $($a.Y) $($a.Width) $($a.Height)"'],
  { cwd: isWsl() ? '/mnt/c' : undefined, encoding: 'utf8', timeout: POWERSHELL_TIMEOUT_MS });
  const [x, y, width, height] = String(r.stdout || '').trim().split(/\s+/).map(Number);
  return r.status === 0 && width > 0 && height > 0 ? { x, y, width, height } : null;
}

// Popup geometry, centered when the work area is known; without it the size alone applies.
function popupBox(size) {
  const wa = workArea();
  return wa ? P.centerBox(wa, size.width, size.height) : { width: size.width, height: size.height, left: null, top: null };
}

function popupArgs(box) {
  const a = ['--window-size=' + box.width + ',' + box.height];
  if (box.left !== null) a.push('--window-position=' + box.left + ',' + box.top);
  return a;
}

// Force the window to normal state at the given box via CDP: a reused browser profile can restore
// a maximized window, which --window-size alone does not undo.
async function forcePopup(ctx, page, box) {
  try {
    const cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    const bounds = { width: box.width, height: box.height };
    if (box.left !== null) { bounds.left = box.left; bounds.top = box.top; }
    await cdp.send('Browser.setWindowBounds', { windowId, bounds });
  } catch (_) { /* best-effort: some backends (WSLg X11) lack window bounds — the launch args still apply */ }
}

/**
 * Persistent-profile window, first that opens wins: the host's Edge on WSL (when reachable), then
 * installed Chrome, installed Edge, and Playwright's bundled Chromium. ANYSSO_CHANNEL goes first.
 */
async function openWindow(url, { insecure, log, size }) {
  const box = popupBox(size);
  const edge = await openNativeEdge(url, log, box);
  if (edge) return { ...edge, box };
  const args = [...popupArgs(box), ...linuxHeadedArgs()];
  let lastErr;
  for (const channel of [process.env.ANYSSO_CHANNEL, 'chrome', 'msedge', undefined].filter((c, i, a) => a.indexOf(c) === i)) {
    try {
      const ctx = await playwright().chromium.launchPersistentContext(store.profileDir(), {
        headless: false, channel, viewport: null, ignoreHTTPSErrors: !!insecure, args,
      });
      return { ctx, close: () => ctx.close().catch(() => {}), opened: false, box };
    } catch (e) { lastErr = e; }
  }
  const noDisplay = process.platform === 'linux' && !isWsl() && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  throw new Error('could not open a browser window: ' + (lastErr && lastErr.message.split('\n')[0]) +
    (noDisplay ? ' (no DISPLAY/WAYLAND_DISPLAY)' : ''));
}

function waitEnter() {
  if (!process.stdin.isTTY) return new Promise(() => {});
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin });
    rl.once('line', () => { rl.close(); resolve('enter'); });
  });
}

/**
 * Show the login window and wait until the user is logged into the target: a tab on the target
 * host, off any login screen, for LOGGED_POLLS polls in a row (or ENTER on a TTY). When the window
 * is signed in but rests on another page of the same site, AnySSO opens `afterLogin` (a path or an
 * absolute URL on that site; default: the original URL) at most MAX_REOPENS times. `start` (same
 * rules) is where the window opens instead of the target, for systems entered through a portal.
 * Resolves { state, hosts, tokens }.
 */
async function loginWindow(url, { selector, insecure, timeoutMs, log, size, afterLogin, start, title }) {
  const targetHost = new URL(url).host;
  const targetSite = P.siteOf(new URL(url).hostname);
  let reopenUrl = url;
  if (afterLogin) {
    reopenUrl = P.resolveAfterLogin(afterLogin, url);
    if (!reopenUrl) { log(`afterLogin ${afterLogin} is not on ${targetSite} — ignored`); reopenUrl = url; }
  }
  let startUrl = url;
  if (start) {
    startUrl = P.resolveAfterLogin(start, url);
    if (!startUrl) { log(`login.start ${start} is not on ${targetSite} — ignored`); startUrl = url; }
  }
  const win = await openWindow(startUrl, { insecure, log, size });
  const hosts = new Set();
  const tokens = [];
  const trail = [];
  let last = null; // latest snapshot; on failure the caller reads it to hint
  try {
    trackHosts(win.ctx, hosts, trail);
    trackTokens(win.ctx, tokens);
    win.ctx.pages().forEach((pg) => P.addTrail(trail, pg.url())); // a window opened with --app already navigated
    win.ctx.pages().forEach(trackStatus);
    win.ctx.on('page', trackStatus);
    const first = win.ctx.pages()[0] || await win.ctx.newPage();
    if (!win.opened) await first.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
    await forcePopup(win.ctx, first, win.box);
    // The taskbar shows the page title ("Sign in", "Login"...): prefix it with what the window is for.
    const tag = '\u{1F510} ' + (title || `Sign in to ${targetHost}`);
    const keepTitle = (t) => {
      const set = () => { if (!document.title.startsWith(t)) document.title = t + (document.title ? ' \u2014 ' + document.title : ''); };
      set();
      new MutationObserver(set).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    };
    await win.ctx.addInitScript(keepTitle, tag).catch(() => {});
    for (const pg of win.ctx.pages()) await pg.evaluate(keepTitle, tag).catch(() => {});
    log(`login window open — sign in to ${targetHost}` + (process.stdin.isTTY ? ' (or press ENTER when done)' : ''));
    let enter = false;
    waitEnter().then(() => { enter = true; });
    const seen = new Map(); // page -> { url, state, count }
    let reopened = 0;
    let ok = false;
    for (const t0 = Date.now(); !ok && Date.now() - t0 < timeoutMs;) {
      if (enter) { ok = true; break; }
      const pages = win.ctx.pages();
      if (!pages.length) throw new Error('login window closed before login finished');
      for (const page of pages) {
        const s = await snapshot(page, targetHost, selector);
        last = s;
        P.addTrail(trail, s.url);
        const prev = seen.get(page);
        const count = prev && prev.url === s.url && prev.state === s.state ? prev.count + 1 : 1;
        seen.set(page, { ...s, count });
        if (s.state === 'logged' && count >= LOGGED_POLLS) { ok = true; break; }
        let u = null;
        try { u = new URL(s.url); } catch (_) { /* about:blank */ }
        if (s.state === 'elsewhere' && u && /^https?:$/.test(u.protocol) && P.siteOf(u.hostname) === targetSite &&
            !P.isLoginUrl(s.url) && count >= STUCK_POLLS && reopened < MAX_REOPENS) {
          reopened++;
          log(`landed on ${u.host} — opening ${new URL(reopenUrl).host}`);
          page.goto(reopenUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
          seen.delete(page);
        }
      }
      if (!ok) await sleep(POLL_MS);
    }
    if (!ok) throw new Error(`login not detected within ${Math.round(timeoutMs / 1000)}s`);
    hosts.add(new URL(url).hostname);
    return { state: await win.ctx.storageState(), hosts, tokens, trail, landed: P.pagePath(last ? last.url : url) };
  } catch (e) {
    e.trail = trail; e.last = last;
    throw e;
  } finally {
    await win.close();
  }
}

module.exports = { playwright, probe, verify, loginWindow };
