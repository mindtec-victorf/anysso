'use strict';
// Fictional "Acme" app used only for the demo media: Acme SSO sign-in, Acme CRM dashboard, JSON API.
// All values are fake.
const http = require('http');

const SIGNIN = `<!doctype html><title>Acme SSO</title><style>
*{box-sizing:border-box}body{margin:0;font:15px system-ui,sans-serif;background:#0f172a;display:grid;place-items:center;height:100vh}
.card{background:#fff;width:400px;padding:36px 32px;border-radius:14px;box-shadow:0 20px 50px #0008}
.logo{font-size:28px;font-weight:800;color:#4f46e5;letter-spacing:-.5px}.logo b{color:#0f172a}
p{color:#64748b;margin:6px 0 24px}label{display:block;font-size:12px;font-weight:600;color:#334155;margin:14px 0 6px}
input{width:100%;padding:11px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px}
button{width:100%;margin-top:26px;padding:12px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-size:15px;font-weight:600}
small{display:block;text-align:center;color:#94a3b8;margin-top:18px}</style>
<div class="card"><div class="logo">Acme <b>SSO</b></div><p>Sign in to continue to Acme CRM</p>
<form onsubmit="return false"><label>Username</label><input id="u" autocomplete="off">
<label>Password</label><input id="p" type="password"><button id="go">Sign in with SSO</button></form>
<small>Protected by Acme Identity</small></div>
<script>document.getElementById('go').onclick = () => { location.href = '/signin-done'; };</script>`;

const DASH = (toast) => `<!doctype html><title>Acme CRM</title><style>
*{box-sizing:border-box}body{margin:0;font:15px system-ui,sans-serif;background:#f1f5f9;color:#0f172a}
nav{background:#4f46e5;color:#fff;padding:16px 22px;font-weight:700;display:flex;justify-content:space-between}
main{padding:22px}h1{font-size:22px;margin:0 0 16px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.k{background:#fff;border-radius:10px;padding:16px}.k span{color:#64748b;font-size:12px}.k b{display:block;font-size:26px;margin-top:4px}
ul{background:#fff;border-radius:10px;margin:12px 0;padding:6px 16px;list-style:none}li{padding:10px 0;border-bottom:1px solid #e2e8f0}
#toast{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);background:#052e16;color:#bbf7d0;padding:14px 20px;border-radius:12px;
font-weight:600;box-shadow:0 10px 30px #0006;display:${toast ? 'block' : 'none'};white-space:nowrap}</style>
<nav><span>Acme CRM</span><span id="me">alice</span></nav>
<main><h1>Dashboard</h1><div class="row"><div class="k"><span>Open deals</span><b>42</b></div><div class="k"><span>Won this month</span><b>$18.4k</b></div></div>
<ul><li>Globex renewal</li><li>Initech onboarding</li><li>Umbrella upsell</li></ul></main>
<div id="toast">&#10003; Session saved by AnySSO</div>`;

function createApp() {
  return http.createServer((req, res) => {
    const logged = /(^|;\s*)acme_sid=/.test(req.headers.cookie || '');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/devlogin') { // test-login route: sets a fake session cookie
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `acme_sid=demo-${url.searchParams.get('user')}-3f9a1c; path=/` });
      return res.end('<p>ok</p>');
    }
    if (url.pathname === '/signin-done') { // staged sign-in: sets the cookie, lands on the dashboard
      res.writeHead(302, { location: '/app?saved', 'set-cookie': 'acme_sid=demo-alice-3f9a1c; path=/' });
      return res.end();
    }
    if (url.pathname === '/api/me') {
      if (!logged) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ user: 'alice', org: 'Acme Inc.', role: 'sales' }));
    }
    if (url.pathname.startsWith('/app')) {
      if (!logged) { res.writeHead(302, { location: '/signin' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(DASH(url.searchParams.has('saved')));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(SIGNIN);
  });
}
module.exports = { createApp };
