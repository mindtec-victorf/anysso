'use strict';
/**
 * Reads the user's existing browser sessions (cookies only) for a set of sites.
 *
 * - Firefox family (Firefox, Zen, LibreWolf, Waterfox, Floorp): every OS, plus Windows profiles
 *   seen from WSL. Cookies are stored unencrypted in cookies.sqlite.
 * - Chromium family (Chrome, Chromium, Edge, Brave, Vivaldi): Linux (keyring or the built-in
 *   default key) and macOS (Keychain — the OS may show a permission prompt).
 * - Chromium on Windows is skipped (see README, "Browser session import").
 *
 * Databases are copied to a private temp dir first (the browser keeps them open/locked).
 * Cookie values never reach stdout/stderr here — callers get them in memory.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const P = require('./pure');

let sqlite;
/** node:sqlite (unflagged from Node 22.13) without its one-time ExperimentalWarning; null if absent. */
function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
  try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; } finally { process.emitWarning = emit; }
  return sqlite;
}

const openSqlite = (file) => new (loadSqlite().DatabaseSync)(file, { readOnly: true });
const sqliteAvailable = () => !!loadSqlite();

const isWsl = () => process.platform === 'linux' && /microsoft/i.test(os.release());

function children(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); }
  catch (_) { return []; }
}

/** Copy `file` (+ its -wal/-journal) to a private temp dir, run fn(copyPath), always clean up. */
function withCopy(file, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anysso-'));
  try {
    fs.chmodSync(tmp, 0o700);
    for (const suf of ['', '-wal', '-journal']) {
      if (fs.existsSync(file + suf)) fs.copyFileSync(file + suf, path.join(tmp, 'db' + suf));
    }
    return fn(path.join(tmp, 'db'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function lastUsed(file) {
  return Math.max(...['', '-wal'].map((s) => { try { return fs.statSync(file + s).mtimeMs; } catch (_) { return 0; } }));
}

// --- Firefox family ---
const FIREFOX_VENDORS = ['Mozilla/Firefox', 'zen', 'LibreWolf', 'Waterfox', 'Floorp', 'librewolf', 'waterfox', 'floorp'];

function firefoxProfiles() {
  const home = os.homedir();
  const roots = [];
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    FIREFOX_VENDORS.forEach((v) => roots.push(path.join(appdata, v, 'Profiles')));
  } else if (process.platform === 'darwin') {
    const sup = path.join(home, 'Library', 'Application Support');
    ['Firefox', 'zen', 'LibreWolf', 'Waterfox', 'Floorp'].forEach((v) => roots.push(path.join(sup, v, 'Profiles')));
  } else {
    roots.push(path.join(home, '.mozilla/firefox'), path.join(home, '.zen'), path.join(home, '.librewolf'),
      path.join(home, '.waterfox'), path.join(home, '.floorp'), path.join(home, 'snap/firefox/common/.mozilla/firefox'),
      path.join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox'), path.join(home, '.var/app/app.zen_browser.zen/.zen'));
    if (isWsl()) {
      for (const user of children('/mnt/c/Users')) {
        FIREFOX_VENDORS.forEach((v) => roots.push(path.join(user, 'AppData/Roaming', v, 'Profiles')));
      }
    }
  }
  return roots.flatMap(children)
    .filter((d) => fs.existsSync(path.join(d, 'cookies.sqlite')))
    .map((d) => ({ browser: browserName(d), profile: d, db: path.join(d, 'cookies.sqlite'), kind: 'firefox' }));
}

function browserName(dir) {
  const m = /(zen|librewolf|waterfox|floorp|firefox)/i.exec(dir);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : 'Firefox';
}

function readFirefox(src, sites) {
  return withCopy(src.db, (db) => {
    const con = openSqlite(db);
    try {
      return con.prepare('SELECT host, path, name, value, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies').all()
        .filter((r) => sites.has(P.siteOf(r.host)))
        .map((r) => ({
          name: r.name, value: r.value, domain: r.host, path: r.path || '/', expires: P.firefoxExpiry(r.expiry),
          httpOnly: !!r.isHttpOnly, secure: !!r.isSecure, sameSite: P.sameSite(r.sameSite),
        }));
    } finally { con.close(); }
  });
}

// --- Chromium family (Linux / macOS) ---
const CHROMIUM = [
  // [display name, Linux config dir, macOS Application Support dir, Linux keyring app, macOS Keychain service]
  ['Chrome', 'google-chrome', 'Google/Chrome', 'chrome', 'Chrome Safe Storage'],
  ['Chromium', 'chromium', 'Chromium', 'chromium', 'Chromium Safe Storage'],
  ['Edge', 'microsoft-edge', 'Microsoft Edge', 'microsoft-edge', 'Microsoft Edge Safe Storage'],
  ['Brave', 'BraveSoftware/Brave-Browser', 'BraveSoftware/Brave-Browser', 'brave', 'Brave Safe Storage'],
  ['Vivaldi', 'vivaldi', 'Vivaldi', 'vivaldi', 'Vivaldi Safe Storage'],
];

function chromiumProfiles() {
  if (process.platform === 'win32' || (process.platform !== 'darwin' && process.platform !== 'linux')) return [];
  const home = os.homedir();
  const out = [];
  for (const [name, linuxDir, macDir, keyringApp, keychain] of CHROMIUM) {
    const base = process.platform === 'darwin'
      ? path.join(home, 'Library/Application Support', macDir) : path.join(home, '.config', linuxDir);
    for (const prof of children(base)) {
      const db = [path.join(prof, 'Network/Cookies'), path.join(prof, 'Cookies')].find((f) => fs.existsSync(f));
      if (db) out.push({ browser: name, profile: prof, db, kind: 'chromium', keyringApp, keychain });
    }
  }
  return out;
}

const keyCache = new Map();
function chromiumKeys(src) {
  if (keyCache.has(src.browser)) return keyCache.get(src.browser);
  const run = (cmd, args) => {
    try {
      const r = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0 ? r.stdout.trim() : '';
    } catch (_) { return ''; }
  };
  let keys;
  if (process.platform === 'darwin') {
    const pw = run('security', ['find-generic-password', '-w', '-s', src.keychain]);
    keys = { v10: pw ? P.chromiumKey(pw, 1003) : null, v11: null };
  } else {
    // shortcut: GNOME keyring via secret-tool only (KWallet not read); without it v11 cookies are skipped.
    const pw = run('secret-tool', ['lookup', 'application', src.keyringApp]);
    keys = { v10: P.chromiumKey('peanuts', 1), v11: pw ? P.chromiumKey(pw, 1) : null };
  }
  keyCache.set(src.browser, keys);
  return keys;
}

function readChromium(src, sites) {
  return withCopy(src.db, (db) => {
    const con = openSqlite(db);
    try {
      const rows = con.prepare('SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies').all()
        .filter((r) => sites.has(P.siteOf(r.host_key)));
      if (!rows.length) return [];
      const keys = chromiumKeys(src);
      const out = [];
      for (const r of rows) {
        let value = r.value;
        if (!value && r.encrypted_value && r.encrypted_value.length) {
          const prefix = Buffer.from(r.encrypted_value.subarray(0, 3)).toString();
          const key = keys[prefix];
          value = key ? P.chromiumDecrypt(r.encrypted_value, key, r.host_key) : null;
        }
        if (value == null) continue;
        out.push({
          name: r.name, value, domain: r.host_key, path: r.path || '/', expires: P.chromiumExpiry(r.expires_utc),
          httpOnly: !!r.is_httponly, secure: !!r.is_secure, sameSite: P.sameSite(r.samesite),
        });
      }
      return out;
    } finally { con.close(); }
  });
}

/** Every readable browser profile on this machine, most recently used first. */
function listSources() {
  return [...firefoxProfiles(), ...chromiumProfiles()].sort((a, b) => lastUsed(b.db) - lastUsed(a.db));
}

/**
 * Cookies for `sites` from each browser profile that has any, most recently used first:
 * [{ browser, profile, cookies }]. Unreadable/locked profiles are skipped.
 */
function readSessions(sites, { log = () => {} } = {}) {
  if (!sqliteAvailable()) { log('browser import needs Node >= 22.13 (node:sqlite) — skipped'); return []; }
  const set = new Set(sites);
  const found = [];
  for (const src of listSources()) {
    let cookies = [];
    try { cookies = src.kind === 'firefox' ? readFirefox(src, set) : readChromium(src, set); }
    catch (e) { log(`${src.browser}: could not read ${src.profile} (${e.code || e.message})`); continue; }
    if (cookies.length) found.push({ browser: src.browser, profile: src.profile, cookies });
  }
  return found;
}

module.exports = { listSources, readSessions, sqliteAvailable, isWsl };
