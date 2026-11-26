'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../skills/login/scripts/lib/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anysso-cfg-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name, obj) => { const f = path.join(tmp, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };

test('load accepts a valid config', () => {
  const f = write('ok.json', { denylist: ['*.prod.acme.com'], sites: [
    { match: 'localhost:8080', login: { route: '/dev/login?u={user}' }, users: { alice: '1001' }, loggedIn: '#m', afterLogin: '/home', timeout: 120, insecure: true },
  ] });
  const { config: cfg, problems } = config.load(f);
  assert.deepEqual(problems, []);
  assert.equal(cfg.sites.length, 1);
});

test('load rejects secret-bearing keys, bad shapes and {user} without users', () => {
  const sec = config.load(write('sec.json', { sites: [{ match: 'x', password: 'nope' }] }));
  assert.match(sec.problems.join(' '), /secret-bearing keys/);
  assert.equal(sec.config, null);

  const bad = config.load(write('bad.json', { sites: [{ login: { route: '/x?u={user}', mode: 'teleport' } }] }));
  const j = bad.problems.join(' ');
  assert.match(j, /match must be/);
  assert.match(j, /mode must be/);
  assert.match(j, /\{user\} but/);

  assert.match(config.load(write('nojson.json', 'not json')).problems.join(' '), /parse JSON/);
});

test('load validates afterLogin, timeout and insecure, naming key and site', () => {
  const bad = config.load(write('keys.json', { sites: [
    { match: 'a.acme.com', afterLogin: 5, timeout: -1, insecure: 'yes' },
    { match: 'b.acme.com', timeout: '30' },
  ] }));
  const j = bad.problems.join('\n');
  assert.match(j, /sites\[0\]\.afterLogin must be a non-empty string.*a\.acme\.com/);
  assert.match(j, /sites\[0\]\.timeout must be a positive number.*a\.acme\.com/);
  assert.match(j, /sites\[0\]\.insecure must be true or false.*a\.acme\.com/);
  assert.match(j, /sites\[1\]\.timeout.*b\.acme\.com/);
  assert.equal(bad.config, null);
  assert.match(config.load(write('t0.json', { sites: [{ match: 'x', timeout: 0 }] })).problems.join(' '), /timeout must be a positive/);
  assert.match(config.load(write('al.json', { sites: [{ match: 'x', afterLogin: '' }] })).problems.join(' '), /afterLogin/);
  assert.match(config.load(write('after-login.json', { sites: [{ match: 'x', afterLogin: ['/a'] }] })).problems.join(' '), /afterLogin/);
});

test('resolvePath honors precedence flag > project > ANYSSO_HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anysso-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'anysso-proj-'));
  const prevHome = process.env.ANYSSO_HOME;
  try {
    process.env.ANYSSO_HOME = home;
    fs.mkdirSync(path.join(home), { recursive: true });
    const homeCfg = write('sites.json', { sites: [] });
    fs.copyFileSync(homeCfg, path.join(home, 'sites.json'));
    assert.equal(config.resolvePath(undefined, proj).origin, 'ANYSSO_HOME');
    fs.writeFileSync(path.join(proj, '.anysso.json'), '{"sites":[]}');
    assert.equal(config.resolvePath(undefined, proj).origin, 'project');
    const flag = write('flag.json', { sites: [] });
    assert.equal(config.resolvePath(flag, proj).origin, 'flag');
    assert.throws(() => config.resolvePath(path.join(tmp, 'missing.json'), proj), /not found/);
  } finally {
    if (prevHome === undefined) delete process.env.ANYSSO_HOME; else process.env.ANYSSO_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('resolveLogin: private host allowed, public blocked unless testOnly, denylist always blocks', () => {
  const cfg = { denylist: ['*.prod.acme.com'] };
  const site = { login: { route: '/dev/login?u={user}' }, users: { alice: '1001' } };
  const local = config.resolveLogin(cfg, site, 'alice', 'http://localhost:8080/app', 'localhost:8080', 'localhost');
  assert.equal(local.mode, 'route');
  assert.match(local.url, /\/dev\/login\?u=1001$/);

  const pub = config.resolveLogin(cfg, site, 'alice', 'https://app.acme.com/x', 'app.acme.com', 'app.acme.com');
  assert.equal(pub.mode, 'window');
  assert.match(pub.blocked, /local\/private/);

  const pubOk = config.resolveLogin(cfg, { ...site, testOnly: true }, 'alice', 'https://staging.acme.com/x', 'staging.acme.com', 'staging.acme.com');
  assert.equal(pubOk.mode, 'route');

  const denied = config.resolveLogin(cfg, { ...site, testOnly: true }, 'alice', 'https://x.prod.acme.com/x', 'x.prod.acme.com', 'x.prod.acme.com');
  assert.equal(denied.mode, 'window');
  assert.match(denied.blocked, /denylist/);

  const win = config.resolveLogin(cfg, { login: { route: '/x', mode: 'window' } }, undefined, 'http://localhost/x', 'localhost', 'localhost');
  assert.equal(win.mode, 'window');
});

test('the route stays on the target origin', () => {
  const site = { login: { route: 'https://elsewhere.example/dev-login?user={user}' }, users: { alice: '1001' } };
  const r = config.resolveLogin({}, site, 'alice', 'http://localhost:3000/app', 'localhost:3000', 'localhost');
  assert.equal(r.mode, 'window');
  assert.match(r.blocked, /target origin/);
  const ok = config.resolveLogin({}, { ...site, login: { route: '/dev-login?user={user}' } }, 'alice', 'http://localhost:3000/app', 'localhost:3000', 'localhost');
  assert.equal(ok.url, 'http://localhost:3000/dev-login?user=1001');
});

test('a project file cannot weaken security unless trusted', () => {
  const site = { match: 'x', insecure: true, testOnly: true, loggedIn: '#me' };
  const t = config.trustedSite(site, 'project', {});
  assert.deepEqual(t.dropped, ['insecure', 'testOnly']);
  assert.equal(t.site.insecure, undefined);
  assert.equal(t.site.loggedIn, '#me');
  assert.deepEqual(config.trustedSite(site, 'project', { ANYSSO_TRUST_PROJECT_CONFIG: '1' }).dropped, []);
  assert.deepEqual(config.trustedSite(site, 'flag', {}).dropped, []);
  assert.deepEqual(config.trustedSite(site, 'ANYSSO_HOME', {}).dropped, []);
});

test('login.start must be a non-empty string', () => {
  assert.match(config.load(write('start.json', { sites: [{ match: 'x', login: { start: 5 } }] })).problems.join(' '), /login\.start/);
  assert.deepEqual(config.load(write('start-ok.json', { sites: [{ match: 'x', login: { mode: 'window', start: '/portal' } }] })).problems, []);
});

test('verify must be a string and stay on the matched host', () => {
  assert.deepEqual(config.load(write('v-ok.json', { sites: [{ match: 'a.acme.com', verify: '/me' }, { match: '*.acme.com', verify: 'https://b.acme.com/me' }] })).problems, []);
  assert.match(config.load(write('v-bad.json', { sites: [{ match: 'a.acme.com', verify: 'https://evil.example/me' }] })).problems.join(' '), /verify must resolve to the target origin/);
  assert.match(config.load(write('v-num.json', { sites: [{ match: 'a.acme.com', verify: 5 }] })).problems.join(' '), /verify must be a non-empty string/);
});

test('config add: dry run writes nothing; --yes writes atomically, replaces an identical match and rejects secrets', () => {
  const { spawnSync } = require('child_process');
  const cli = path.join(__dirname, '../skills/login/scripts/anysso.js');
  const h = path.join(tmp, 'home-add');
  const env = { ...process.env, ANYSSO_HOME: h };
  const run = (...a) => spawnSync(process.execPath, [cli, 'config', 'add', ...a], { env, encoding: 'utf8', cwd: tmp });
  const file = path.join(h, 'sites.json');
  const one = JSON.stringify({ match: '*.acme.com', login: { start: 'https://portal.acme.com/' } });

  const dry = run('--site', one);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: pass --yes to write/);
  assert.equal(fs.existsSync(file), false);

  assert.equal(run('--site', one, '--yes').status, 0);
  if (process.platform !== 'win32') { // Windows has no POSIX modes
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(h).mode & 0o777, 0o700);
  }
  assert.equal(run('--site', JSON.stringify({ match: 'localhost:1' }), '--yes').status, 0);
  assert.equal(run('--site', JSON.stringify({ match: '*.acme.com', verify: '/me' }), '--yes').status, 0);
  const sites = JSON.parse(fs.readFileSync(file, 'utf8')).sites;
  assert.equal(sites.length, 2);
  assert.equal(sites[0].verify, '/me');
  assert.equal(sites[0].login, undefined); // replaced, not merged

  const bad = run('--site', JSON.stringify({ match: 'x', token: 'nope' }), '--yes');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /secret-bearing keys/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sites.length, 2);

  const other = path.join(tmp, 'other.json');
  assert.equal(run('--site', one, '--file', other, '--yes').status, 0);
  assert.equal(fs.existsSync(other), true);
});
