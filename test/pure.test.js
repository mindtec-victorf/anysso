'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const P = require('../skills/login/scripts/lib/pure');

test('siteOf picks the registrable site', () => {
  assert.equal(P.siteOf('app.login.example.com'), 'example.com');
  assert.equal(P.siteOf('example.com'), 'example.com');
  assert.equal(P.siteOf('a.b.example.org'), 'example.org');
  assert.equal(P.siteOf('staging-app.acme.co.uk'), 'acme.co.uk');
  assert.equal(P.siteOf('.sso.acme.com.au'), 'acme.com.au');
  assert.equal(P.siteOf('service.gov.uk'), 'service.gov.uk');
  assert.equal(P.siteOf('app.acme.coop.py'), 'acme.coop.py');
  assert.equal(P.siteOf('hr.acme.ltd.uk'), 'acme.ltd.uk');
  assert.equal(P.siteOf('a.b.co.uk'), 'b.co.uk');
  assert.equal(P.siteOf('login.shop.example.io'), 'example.io'); // 2-letter TLD, no second-level label
  assert.equal(P.siteOf('localhost:8080'), 'localhost');
  assert.equal(P.siteOf('10.0.0.5'), '10.0.0.5');
  assert.equal(P.siteOf('intranet'), 'intranet');
});

test('matchSite matches host (with port) or hostname, first entry wins', () => {
  const config = { sites: [
    { match: 'localhost:8080', loggedIn: '#local' },
    { match: ['*.test.acme.com', 'app-*.acme.com'], loggedIn: '#wild' },
    { match: 'app.acme.com', loggedIn: '#exact' },
  ] };
  assert.equal(P.matchSite(config, 'localhost:8080', 'localhost').loggedIn, '#local');
  assert.equal(P.matchSite(config, 'x.test.acme.com', 'x.test.acme.com').loggedIn, '#wild');
  assert.equal(P.matchSite(config, 'app.acme.com', 'app.acme.com').loggedIn, '#exact');
  assert.equal(P.matchSite(config, 'other.com', 'other.com'), null);
  assert.equal(P.matchSite({}, 'x', 'x'), null);
});

test('isPrivateHost covers loopback and private ranges only', () => {
  ['localhost', 'app.localhost', 'printer.local', '127.0.0.1', '127.9.9.9', '::1', '[::1]', '10.1.2.3', '172.16.0.1', '172.31.9.9',
    '192.168.0.5', 'intranet', 'app.test'].forEach(
    (h) => assert.equal(P.isPrivateHost(h), true, h));
  ['app.acme.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '193.168.0.1', '2001:db8::1'].forEach(
    (h) => assert.equal(P.isPrivateHost(h), false, h));
});

test('isDenylisted matches globs over host and hostname', () => {
  const c = { denylist: ['*.prod.acme.com', 'app.acme.com'] };
  assert.equal(P.isDenylisted(c, 'app.acme.com', 'app.acme.com'), true);
  assert.equal(P.isDenylisted(c, 'x.prod.acme.com', 'x.prod.acme.com'), true);
  assert.equal(P.isDenylisted(c, 'staging.acme.com', 'staging.acme.com'), false);
  assert.equal(P.isDenylisted({}, 'x', 'x'), false);
});

test('userRoute substitutes {user} and validates the alias', () => {
  const users = { alice: '1001', bob: '1002' };
  assert.equal(P.userRoute('/dev/login?u={user}', users, 'alice'), '/dev/login?u=1001');
  assert.equal(P.userRoute('/dev/login', users, undefined), '/dev/login'); // no placeholder: user optional
  assert.throws(() => P.userRoute('/x?u={user}', users, undefined), /needs a user/);
  assert.throws(() => P.userRoute('/x?u={user}', users, 'ghost'), /unknown user/);
});

test('resolveAfterLogin accepts paths and URLs on the same site only', () => {
  const t = 'https://app.acme.co.uk/deep/page';
  assert.equal(P.resolveAfterLogin('/home', t), 'https://app.acme.co.uk/home');
  assert.equal(P.resolveAfterLogin('https://portal.acme.co.uk/x', t), 'https://portal.acme.co.uk/x');
  assert.equal(P.resolveAfterLogin('https://evil.co.uk/x', t), null);
  assert.equal(P.resolveAfterLogin('https://acme.com/x', t), null);
  assert.equal(P.resolveAfterLogin('javascript:alert(1)', t), null);
});

test('parseWindowSize accepts WxH and rejects the rest', () => {
  assert.deepEqual(P.parseWindowSize('520x720'), { width: 520, height: 720 });
  assert.deepEqual(P.parseWindowSize(' 800X600 '), { width: 800, height: 600 });
  ['520', '520x', 'x720', '520,720', '0x0', '100x100', '-5x700', 'axb', ''].forEach((v) => assert.equal(P.parseWindowSize(v), null, v));
});

test('nodeAtLeast compares major then minor', () => {
  assert.equal(P.nodeAtLeast('22.13.0', [22, 13]), true);
  assert.equal(P.nodeAtLeast('22.12.9', [22, 13]), false);
  assert.equal(P.nodeAtLeast('23.0.0', [22, 13]), true);
  assert.equal(P.nodeAtLeast('20.19.0', [22, 13]), false);
  assert.equal(P.nodeAtLeast('22.13', [22, 13]), true);
});

test('forbiddenKeys finds secret-bearing keys at any depth', () => {
  assert.deepEqual(P.forbiddenKeys({ sites: [{ users: { a: '1' }, password: 'x' }] }), ['sites.0.password']);
  assert.deepEqual(P.forbiddenKeys({ a: { b: { token: 't' } } }), ['a.b.token']);
  assert.deepEqual(P.forbiddenKeys({ users: { alice: '1001' }, loggedIn: '#x' }), []);
});

test('centerBox centers and clamps to the work area', () => {
  assert.deepEqual(P.centerBox({ x: 0, y: 0, width: 1920, height: 1040 }, 520, 720), { width: 520, height: 720, left: 700, top: 160 });
  assert.deepEqual(P.centerBox({ x: 0, y: 0, width: 400, height: 600 }, 520, 720), { width: 400, height: 600, left: 0, top: 0 });
});

test('classify: target host, login screens, identity provider', () => {
  const t = 'app.example.com';
  assert.equal(P.classify({ url: 'https://app.example.com/dashboard', targetHost: t }), 'logged');
  assert.equal(P.classify({ url: 'https://app.example.com/login?next=/', targetHost: t }), 'login');
  assert.equal(P.classify({ url: 'https://app.example.com/home', targetHost: t, hasPassword: true }), 'login');
  assert.equal(P.classify({ url: 'https://login.microsoftonline.com/common/oauth2/authorize', targetHost: t }), 'elsewhere');
  assert.equal(P.classify({ url: 'about:blank', targetHost: t }), 'elsewhere');
  assert.equal(P.classify({ url: 'https://app.example.com/login', targetHost: t, selectorFound: true }), 'logged');
  assert.equal(P.classify({ url: 'https://app.example.com/home', targetHost: t, selectorFound: false }), 'login');
  assert.equal(P.isLoginUrl('https://kc.example.com/realms/x/protocol/openid-connect/auth'), true);
  assert.equal(P.isLoginUrl('https://app.example.com/authors'), false);
});

const ck = (o) => ({ name: 'n', value: 'v', domain: 'app.example.com', path: '/', expires: -1, secure: false, httpOnly: false, sameSite: 'Lax', ...o });

test('cookieMatchesUrl follows domain, path, secure and expiry rules', () => {
  const url = 'https://app.example.com/api/v1';
  assert.ok(P.cookieMatchesUrl(ck(), url));
  assert.ok(P.cookieMatchesUrl(ck({ domain: '.example.com' }), url));
  assert.ok(!P.cookieMatchesUrl(ck({ domain: 'other.example.com' }), url));
  assert.ok(P.cookieMatchesUrl(ck({ path: '/api' }), url));
  assert.ok(!P.cookieMatchesUrl(ck({ path: '/ap' }), url));
  assert.ok(!P.cookieMatchesUrl(ck({ secure: true }), 'http://app.example.com/'));
  assert.ok(P.cookieMatchesUrl(ck({ secure: true, domain: 'localhost' }), 'http://localhost:8080/'));
  assert.ok(!P.cookieMatchesUrl(ck({ expires: 1000 }), url));
});

test('cookieHeader and netscapeJar', () => {
  const cs = [ck({ name: 'a', value: '1' }), ck({ name: 'b', value: '2', domain: '.example.com', httpOnly: true, expires: 2e9 }), ck({ name: 'c', domain: 'x.org' })];
  assert.equal(P.cookieHeader(cs, 'https://app.example.com/'), 'a=1; b=2');
  const jar = P.netscapeJar(cs).split('\n');
  assert.ok(jar.includes('app.example.com\tFALSE\t/\tFALSE\t0\ta\t1'));
  assert.ok(jar.includes('#HttpOnly_.example.com\tTRUE\t/\tFALSE\t2000000000\tb\t2'));
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (p) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(p) + '.' + 'c2lnbmF0dXJlLXNpZw';

test('bearerOf reads a JWT out of an Authorization header', () => {
  const t = jwt({ sub: 'x' });
  assert.equal(P.bearerOf('Bearer ' + t), t);
  assert.equal(P.bearerOf('bearer ' + t), t);
  assert.equal(P.bearerOf('Bearer not-a-jwt'), null);
  assert.equal(P.bearerOf('Basic abc'), null);
  assert.equal(P.bearerOf(undefined), null);
});

test('findToken: a live-captured bearer beats storage, freshest wins', () => {
  const older = jwt({ sub: 'old' });
  const newer = jwt({ sub: 'new' });
  const state = { tokens: [older, newer], cookies: [],
    origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'k', value: JSON.stringify({ access_token: jwt({ sub: 'ls' }) }) }] }] };
  assert.equal(P.findToken(state, 'https://app.example.com/x'), newer);
  assert.equal(P.findToken({ tokens: ['garbage'], cookies: [], origins: state.origins }, 'https://app.example.com/x'),
    P.findToken({ cookies: [], origins: state.origins }, 'https://app.example.com/x'));
});

test('findToken prefers access_token in JSON, then raw JWTs, scoped to the origin', () => {
  const access = jwt({ sub: 'a' });
  const id = jwt({ sub: 'i' });
  const state = {
    cookies: [ck({ name: 't', value: jwt({ sub: 'cookie' }) })],
    origins: [
      { origin: 'https://other.com', localStorage: [{ name: 'x', value: jwt({ sub: 'other' }) }] },
      { origin: 'https://app.example.com', localStorage: [
        { name: 'raw', value: id },
        { name: 'oidc.user:https://idp:client', value: JSON.stringify({ id_token: id, access_token: access }) },
      ] },
    ],
  };
  assert.equal(P.findToken(state, 'https://app.example.com/x'), access);
  assert.equal(P.findToken({ cookies: state.cookies, origins: [] }, 'https://app.example.com/'), state.cookies[0].value);
  assert.equal(P.findToken({ cookies: [], origins: [] }, 'https://app.example.com/'), null);
  assert.equal(P.isJwt('not.a.jwt'), false);
});

test('filterState keeps only related sites', () => {
  const st = { cookies: [ck(), ck({ domain: '.idp.net' }), ck({ domain: 'ads.com' })],
    origins: [{ origin: 'https://app.example.com', localStorage: [] }, { origin: 'https://ads.com', localStorage: [] }] };
  const f = P.filterState(st, ['example.com', 'idp.net']);
  assert.deepEqual(f.cookies.map((c) => c.domain), ['app.example.com', '.idp.net']);
  assert.deepEqual(f.origins.map((o) => o.origin), ['https://app.example.com']);
});

test('chromiumDecrypt round-trips v10/v11 and strips the host hash (DB v24+)', () => {
  const key = P.chromiumKey('peanuts', 1);
  const enc = (plain, prefix = 'v10') => {
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from(prefix), c.update(plain), c.final()]);
  };
  assert.equal(P.chromiumDecrypt(enc(Buffer.from('secret')), key, '.example.com'), 'secret');
  const hashed = Buffer.concat([crypto.createHash('sha256').update('.example.com').digest(), Buffer.from('secret2')]);
  assert.equal(P.chromiumDecrypt(enc(hashed, 'v11'), key, '.example.com'), 'secret2');
  assert.equal(P.chromiumDecrypt(Buffer.from('v20xxxxxxxxxxxxxxxxxxx'), key, 'h'), null);
  assert.equal(P.chromiumDecrypt(enc(Buffer.from('x')), P.chromiumKey('wrong', 1), 'h'), null);
});

test('expiry conversions', () => {
  assert.equal(P.chromiumExpiry(0), -1);
  assert.equal(Math.round(P.chromiumExpiry(13_000_000_000_000_000)), 13_000_000_000 - 11644473600);
  assert.equal(P.firefoxExpiry(1_900_000_000), 1_900_000_000);
  assert.equal(P.firefoxExpiry(1_900_000_000_000), 1_900_000_000);
  assert.equal(P.firefoxExpiry(0), -1);
});

test('afterLogin {origin} is the target origin, still same-site only', () => {
  assert.equal(P.resolveAfterLogin('https://portal.acme.co.uk/open?app={origin}/auth', 'https://crm.acme.co.uk/home'),
    'https://portal.acme.co.uk/open?app=https://crm.acme.co.uk/auth');
  assert.equal(P.resolveAfterLogin('https://evil.example/x?{origin}', 'https://crm.acme.co.uk/home'), null);
});

test('trail keeps host+pathname only, collapses consecutive duplicates and caps at 30', () => {
  const t = [];
  for (const u of ['https://a.test/x?token=SECRET#frag', 'https://a.test/x?other=1', 'https://b.test:8443/y', 'about:blank', 'https://a.test/x']) P.addTrail(t, u);
  assert.deepEqual(t, ['a.test/x', 'b.test:8443/y', 'a.test/x']);
  assert.equal(P.pagePath('https://a.test/p?q=1#h'), 'a.test/p');
  assert.equal(P.pagePath('not a url'), null);
  const big = [];
  for (let i = 0; i < 40; i++) P.addTrail(big, 'https://a.test/p' + i);
  assert.equal(big.length, 30);
  assert.equal(big[29], 'a.test/p39');
  assert.equal(big[0], 'a.test/p10');
});

test('resolveVerify stays on the target origin', () => {
  assert.equal(P.resolveVerify('/me', 'https://app.test/x?y=1'), 'https://app.test/me');
  assert.equal(P.resolveVerify('https://app.test/me', 'https://app.test/'), 'https://app.test/me');
  assert.equal(P.resolveVerify('https://other.test/me', 'https://app.test/'), null);
  assert.equal(P.resolveVerify('//other.test/me', 'https://app.test/'), null);
});

test('hint decisions: own login form needs no login.start; handshake needs a target-host handshake path', () => {
  assert.match(P.hintOwnLoginForm({ state: 'login', host: 'app.test', hasStart: false }), /^app\.test shows its own login form; .*login\.start.*Adapting to a new system/);
  assert.equal(P.hintOwnLoginForm({ state: 'login', host: 'app.test', hasStart: true }), null);
  assert.equal(P.hintOwnLoginForm({ state: 'elsewhere', host: 'app.test', hasStart: false }), null);
  assert.match(P.hintHandshake({ trail: ['idp.test/login', 'app.test/auth'], host: 'app.test' }), /did not authorize/);
  assert.match(P.hintHandshake({ trail: ['app.test/gate/callback', 'idp.test/x'], host: 'app.test' }), /did not authorize/);
  assert.equal(P.hintHandshake({ trail: ['app.test/auth', 'app.test/err'], host: 'app.test' }), null); // last target page is not a handshake
  assert.equal(P.hintHandshake({ trail: ['app.test/author'], host: 'app.test' }), null);
});
