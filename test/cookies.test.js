'use strict';
// Builds fake Firefox and Chromium profiles under a temp HOME and reads them back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.emitWarning = () => {};
const { DatabaseSync } = require('node:sqlite');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anysso-test-'));
process.env.HOME = home;
// os.homedir() reads USERPROFILE on Windows; Firefox profiles live under APPDATA there.
process.env.USERPROFILE = home;
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
const cookies = require('../skills/login/scripts/lib/cookies');
const P = require('../skills/login/scripts/lib/pure');

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function firefoxProfile() {
  const dir = process.platform === 'win32'
    ? path.join(process.env.APPDATA, 'Mozilla/Firefox/Profiles/abc.default')
    : path.join(home, '.mozilla/firefox/abc.default');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'cookies.sqlite'));
  db.exec('CREATE TABLE moz_cookies (host TEXT, path TEXT, name TEXT, value TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)');
  const ins = db.prepare('INSERT INTO moz_cookies VALUES (?,?,?,?,?,?,?,?)');
  ins.run('.example.com', '/', 'sid', 'ff-secret', 1_900_000_000_000, 1, 1, 1);
  ins.run('ads.other.com', '/', 'track', 'x', 0, 0, 0, 0);
  db.close();
}

function chromiumProfile() {
  if (process.platform !== 'linux') return;
  const dir = path.join(home, '.config/chromium/Default/Network');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'Cookies'));
  db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)');
  const c = crypto.createCipheriv('aes-128-cbc', P.chromiumKey('peanuts', 1), Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([crypto.createHash('sha256').update('app.example.com').digest(), Buffer.from('cr-secret')]);
  const enc = Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()]);
  db.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?)').run('app.example.com', 'session', '', enc, '/', 0, 1, 1, 2);
  db.close();
}

test('reads Firefox and Chromium (Linux v10) sessions for the requested sites only', () => {
  firefoxProfile();
  chromiumProfile();
  const mine = cookies.readSessions(['example.com']).filter((s) => s.profile.startsWith(home));
  const ff = mine.find((s) => s.browser === 'Firefox');
  assert.ok(ff, 'firefox profile found');
  assert.deepEqual(ff.cookies.map((c) => [c.name, c.value, c.expires, c.sameSite]), [['sid', 'ff-secret', 1_900_000_000, 'Lax']]);
  if (process.platform === 'linux') {
    const cr = mine.find((s) => s.browser === 'Chromium');
    assert.ok(cr, 'chromium profile found');
    assert.deepEqual(cr.cookies.map((c) => [c.name, c.value, c.expires, c.sameSite]), [['session', 'cr-secret', -1, 'Strict']]);
  }
  assert.equal(cookies.readSessions(['nothing.test']).filter((s) => s.profile.startsWith(home)).length, 0);
});
