'use strict';
// End-to-end against a local fake app that redirects to /login until a session cookie exists.
// Needs Playwright + Chromium (skipped otherwise). The login-window case opens a real window and
// only runs with ANYSSO_E2E_WINDOW=1.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '../skills/login/scripts/anysso.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anysso-e2e-'));
const env = { ...process.env, ANYSSO_HOME: home };

let havePw = true;
try { require('../skills/login/scripts/lib/browser').playwright(); } catch (_) { havePw = false; }

const LOGIN_PAGE = `<!doctype html><title>Sign in</title><form method="post" action="/login">
<input name="u"><input type="password" name="p"><button>Sign in</button></form>
<script>if (location.search.includes('auto') && !navigator.userAgent.includes('Headless')) setTimeout(() => {
  document.cookie = 'sid=good; path=/'; location.href = '/app/home'; }, 800);</script>`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const BEARER = `${b64({ alg: 'HS256' })}.${b64({ sub: 'me' })}.c2ln`; // the token the app sends live

let auto = false; // the fake login page signs itself in (window test)
const server = http.createServer((req, res) => {
  const logged = /(^|;\s*)sid=good/.test(req.headers.cookie || '');
  if (req.url.startsWith('/devlogin')) { // a route that authenticates on visit (config login route)
    const user = new URL(req.url, 'http://x').searchParams.get('user') || 'good';
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${user}; path=/` });
    return res.end('<p>ok</p>');
  }
  if (req.url.startsWith('/app')) {
    if (!logged) { res.writeHead(302, { location: '/login' + (auto ? '?auto' : '') }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><title>Home</title><h1 id="me">Welcome</h1>
<script>localStorage.setItem("oidc.user", JSON.stringify({access_token: "tok-123"}));
fetch('/api/me', { headers: { Authorization: 'Bearer ${BEARER}' } });</script>`);
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(LOGIN_PAGE);
});

let base;
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });

// Async on purpose: spawnSync would block this process, which also serves the fake app.
function run(...args) { return runWith(env, ...args); }
function runWith(runEnv, ...args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

test('invalid --window-size and --timeout exit 2 before any browser work', async () => {
  for (const bad of [['--window-size', '520'], ['--window-size', '10x10'], ['--window-size', 'wide']]) {
    const r = await run('login', base + '/app/home', ...bad);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /invalid --window-size/);
  }
  const t = await run('login', base + '/app/home', '--timeout', '0');
  assert.equal(t.status, 2, t.stderr);
  assert.match(t.stderr, /invalid --timeout/);
});

test('doctor checks Node >= 22.13 and prints the same requirement', async () => {
  // A temp HOME keeps the browser-profile scan away from the real one.
  const r = await runWith({ ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') }, 'doctor');
  assert.equal(r.status, 0, r.stderr);
  const m = /^(ok  |MISS) Node (\S+) \(>= 22\.13 required\)$/m.exec(r.stdout);
  assert.ok(m, r.stdout);
  const [maj, min] = process.versions.node.split('.').map(Number);
  assert.equal(m[1].trim() === 'ok', maj > 22 || (maj === 22 && min >= 13));
  assert.equal(require('../package.json').engines.node, '>=22.13');
});

test('not logged in + --no-window fails with exit 1', { skip: !havePw }, async () => {
  const r = await run('login', base + '/app/home', '--no-window', '--no-browser');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not logged in/);
});

test('a saved session is validated and reused; export works', { skip: !havePw }, async () => {
  const host = new URL(base).host;
  const dir = path.join(home, 'sessions', host.replace(/[^A-Za-z0-9._-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'default.json'), JSON.stringify({
    cookies: [{ name: 'sid', value: 'good', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [],
  }));
  const r = await run('login', base + '/app/home', '--no-window', '--no-browser', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).source, 'saved session');
  assert.equal((await run('export', base + '/app/home')).stdout.trim(), 'sid=good');
  // The bearer the app sent live is captured and wins over the localStorage token.
  assert.equal((await run('export', base + '/app/home', '--format', 'token')).stdout.trim(), BEARER);
  assert.match((await run('status')).stdout, /1 cookies/);
  assert.equal((await run('logout', base)).status, 0);
  assert.equal((await run('export', base + '/app/home')).status, 1);
});

test('a config login route authenticates headless, no window', { skip: !havePw }, async () => {
  const cfgFile = path.join(home, 'cfg.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ sites: [
    { match: '127.0.0.1', login: { route: '/devlogin?user={user}' }, users: { alice: 'good' }, loggedIn: '#me' },
  ] }));
  // The dev route sets sid=<user>; our fake server accepts sid=good, so user "alice" -> "good" logs in.
  const r = await run('login', base + '/app/home', '--no-window', '--no-browser', '--fresh', '--config', cfgFile, '--user', 'alice', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).source, 'config login route');
  assert.equal((await run('export', base + '/app/home')).stdout.trim(), 'sid=good');
  await run('logout', base);
});

test('login window: detects the login and saves the session', { skip: !havePw || !process.env.ANYSSO_E2E_WINDOW }, async () => {
  // The fake login page signs itself in after 0.8s (?auto), standing in for the human.
  auto = true;
  const p = spawn(process.execPath, [CLI, 'login', base + '/app/home', '--no-browser', '--fresh', '--timeout', '60', '--json'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => p.on('exit', r));
  assert.equal(code, 0, err);
  assert.equal(JSON.parse(out).source, 'login window');
  assert.equal((await run('export', base + '/app/home')).stdout.trim(), 'sid=good');
});
