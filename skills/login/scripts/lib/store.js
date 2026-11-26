'use strict';
/**
 * Local state under ~/.anysso (override: ANYSSO_HOME):
 *   sessions/<host>/<account>.json  Playwright storageState, mode 0600
 *   profile/                        the AnySSO login window's own browser profile (keeps the
 *                                   identity provider session, so the next login is one click)
 *   config.json                     consent flags
 * shortcut: sessions are plain files protected by permissions (like ~/.aws or Playwright's own
 * storageState); upgrade to the OS keyring if a user needs encryption at rest.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = () => process.env.ANYSSO_HOME || path.join(os.homedir(), '.anysso');

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const sessionFile = (host, account = 'default') => path.join(HOME(), 'sessions', safe(host), safe(account) + '.json');
const profileDir = () => ensureDir(path.join(HOME(), 'profile'));

function saveSession(host, account, state) {
  const f = sessionFile(host, account);
  ensureDir(path.dirname(f));
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
  return f;
}

function loadSession(host, account) {
  try { return JSON.parse(fs.readFileSync(sessionFile(host, account), 'utf8')); } catch (_) { return null; }
}

function listSessions() {
  const root = path.join(HOME(), 'sessions');
  const out = [];
  for (const host of (fs.existsSync(root) ? fs.readdirSync(root) : [])) {
    for (const f of fs.readdirSync(path.join(root, host)).filter((n) => n.endsWith('.json'))) {
      const file = path.join(root, host, f);
      let state = { cookies: [], origins: [] };
      try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* corrupt: listed with 0 cookies */ }
      out.push({ host, account: f.replace(/\.json$/, ''), file, savedAt: fs.statSync(file).mtime, state });
    }
  }
  return out;
}

function removeSession(host, account) {
  const files = account ? [sessionFile(host, account)]
    : listSessions().filter((s) => s.host === safe(host)).map((s) => s.file);
  files.forEach((f) => fs.rmSync(f, { force: true }));
  return files.length;
}

const configFile = () => path.join(HOME(), 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (_) { return {}; }
}
function writeConfig(cfg) {
  ensureDir(HOME());
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const hasConsent = () => !!readConfig().browserCookies;
function setConsent(on) {
  const cfg = readConfig();
  if (on) cfg.browserCookies = { grantedAt: new Date().toISOString() }; else delete cfg.browserCookies;
  writeConfig(cfg);
}

module.exports = { HOME, sessionFile, profileDir, saveSession, loadSession, listSessions, removeSession, hasConsent, setConsent };
