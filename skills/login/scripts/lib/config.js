'use strict';
/**
 * The AnySSO site-config file: parameterizable hosts and login routes for local / private test
 * networks. AnySSO itself knows no specific system — a consumer (or the user) supplies this file.
 *
 * Precedence (first that exists wins, no merge):
 *   --config <file> > ./.anysso.json > $ANYSSO_HOME/sites.json  (default ~/.anysso/sites.json)
 *
 * Shape:
 *   {
 *     "denylist": ["*.prod.example.com"],
 *     "sites": [
 *       { "match": "localhost:8080" | ["*.test.example.com", ...],
 *         "login": { "route": "/auth/dev-login?user={user}", "mode": "route" | "window" },
 *         "users": { "alice": "1001", "bob": "1002" },
 *         "loggedIn": "#user-menu", "cookieSites": ["example.com"],
 *         "afterLogin": "/dashboard", "timeout": 300, "insecure": false, "testOnly": false }
 *     ]
 *   }
 *
 * A config file holds TEST USER IDS, never passwords or tokens — secret-bearing keys are rejected.
 */
const fs = require('fs');
const path = require('path');
const P = require('./pure');

function homeFile() {
  const home = process.env.ANYSSO_HOME || path.join(require('os').homedir(), '.anysso');
  return path.join(home, 'sites.json');
}

/** The config file to use (by precedence) and where it came from, or null when there is none. */
function resolvePath(configFlag, cwd = process.cwd()) {
  // An explicit --config must exist — never silently fall back to another file.
  if (configFlag) {
    if (fs.existsSync(configFlag)) return { file: configFlag, origin: 'flag' };
    const e = new Error('config file not found: ' + configFlag); e.exitCode = 2; throw e;
  }
  for (const [file, origin] of [[path.join(cwd, '.anysso.json'), 'project'], [homeFile(), 'ANYSSO_HOME']]) {
    if (fs.existsSync(file)) return { file, origin };
  }
  return null;
}

/** Parse and validate a config file. Returns { config, problems }: problems is [] when valid. */
function load(file) {
  const problems = [];
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { config: null, problems: ['cannot parse JSON: ' + e.message] }; }
  if (!config || typeof config !== 'object') return { config: null, problems: ['top level must be a JSON object'] };

  const secrets = P.forbiddenKeys(config);
  if (secrets.length) problems.push('secret-bearing keys are not allowed in a config file (use a test user id, never a password): ' + secrets.join(', '));

  if (config.denylist && !Array.isArray(config.denylist)) problems.push('"denylist" must be an array of host patterns');
  const sites = config.sites;
  if (sites !== undefined && !Array.isArray(sites)) problems.push('"sites" must be an array');
  for (const [i, s] of (Array.isArray(sites) ? sites : []).entries()) {
    const at = `sites[${i}]`;
    if (!s || typeof s !== 'object') { problems.push(`${at} must be an object`); continue; }
    if (!s.match || (Array.isArray(s.match) ? s.match.some((m) => typeof m !== 'string') : typeof s.match !== 'string')) problems.push(`${at}.match must be a host pattern (string) or an array of them`);
    if (s.login !== undefined) {
      if (typeof s.login !== 'object') problems.push(`${at}.login must be an object`);
      else {
        if (s.login.route !== undefined && typeof s.login.route !== 'string') problems.push(`${at}.login.route must be a string`);
        if (s.login.mode !== undefined && !['route', 'window'].includes(s.login.mode)) problems.push(`${at}.login.mode must be "route" or "window"`);
        if (typeof s.login.route === 'string' && s.login.route.includes('{user}') && (!s.users || !Object.keys(s.users).length)) problems.push(`${at}.login.route uses {user} but ${at}.users is empty`);
      }
    }
    if (s.users !== undefined && (typeof s.users !== 'object' || Array.isArray(s.users))) problems.push(`${at}.users must be an object of alias -> test-user-id`);
    for (const [a, id] of Object.entries(s.users || {})) if (typeof id !== 'string' && typeof id !== 'number') problems.push(`${at}.users.${a} must be a string or number id`);
    if (s.cookieSites !== undefined && !Array.isArray(s.cookieSites)) problems.push(`${at}.cookieSites must be an array`);
    const site = JSON.stringify(s.match);
    if (s.afterLogin !== undefined && (typeof s.afterLogin !== 'string' || !s.afterLogin)) problems.push(`${at}.afterLogin must be a non-empty string (a path or an absolute URL) — site ${site}`);
    if (s.timeout !== undefined && !(typeof s.timeout === 'number' && Number.isFinite(s.timeout) && s.timeout > 0)) problems.push(`${at}.timeout must be a positive number of seconds — site ${site}`);
    if (s.insecure !== undefined && typeof s.insecure !== 'boolean') problems.push(`${at}.insecure must be true or false — site ${site}`);
  }
  return { config: problems.length ? null : config, problems };
}

/**
 * Resolve the login route for a matched site: returns { url, mode, blocked }.
 * A parameterized/dev route is powerful (auto-login as a test user), so by default it is allowed
 * only against a local/private host OR an entry explicitly marked `testOnly: true`, and NEVER
 * against a denylisted host. When blocked, the caller falls back to the login window.
 */
function resolveLogin(config, site, user, targetUrl, host, hostname) {
  if (!site || !site.login || !site.login.route || site.login.mode === 'window') return { mode: 'window' };
  if (P.isDenylisted(config, host, hostname)) return { mode: 'window', blocked: 'host is on the config denylist' };
  if (!P.isPrivateHost(hostname) && !site.testOnly) return { mode: 'window', blocked: 'route login is limited to local/private hosts (mark the site "testOnly": true to allow it elsewhere)' };
  const route = P.userRoute(site.login.route, site.users, user);
  const u = new URL(route, targetUrl);
  // The route runs with the session being built: it may only point at the target's own origin.
  if (u.origin !== new URL(targetUrl).origin) return { mode: 'window', blocked: 'login route must stay on the target origin (' + new URL(targetUrl).origin + ')' };
  return { url: u.href, mode: 'route' };
}

/**
 * A project file (./.anysso.json) may come with a cloned repository, so it cannot weaken security:
 * `insecure` and `testOnly` from it are ignored unless the user passed it with --config or set
 * ANYSSO_TRUST_PROJECT_CONFIG=1. Returns the site to use and the keys that were dropped.
 */
function trustedSite(site, origin, env = process.env) {
  if (origin !== 'project' || env.ANYSSO_TRUST_PROJECT_CONFIG === '1') return { site, dropped: [] };
  const dropped = ['insecure', 'testOnly'].filter((k) => site[k]);
  if (!dropped.length) return { site, dropped };
  const copy = { ...site };
  for (const k of dropped) delete copy[k];
  return { site: copy, dropped };
}

module.exports = { homeFile, resolvePath, load, resolveLogin, trustedSite };
