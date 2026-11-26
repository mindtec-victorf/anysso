---
name: login
description: >
  Use when a task needs to act as a logged-in user on a web system — any site, any environment
  (localhost, staging, behind a VPN, production), with SSO (SAML, OIDC, Azure AD/Entra,
  Okta, Keycloak, Google, CAS, ADFS) or a plain login form. Gives you a reusable session: first the
  one saved before, then a test-login route from the config (when set), then the session already in
  the user's own browser, and only then a small login window the user signs in to once. Outputs a Playwright storageState, a Cookie header, a Netscape
  cookie jar for curl, or a bearer token. Triggers: "log in to", "use my session", "I'm already
  logged in", "screenshot the logged page", "call this API as me", "authenticated request", "SSO".
---

# AnySSO — log in once, reuse the session

`scripts/anysso.js` (relative to this skill's directory) ensures a logged-in session for a URL and
hands it to whatever needs it. stdout holds only the machine-readable result; progress goes to
stderr.

## Ensure a session

```bash
node scripts/anysso.js login https://app.example.com/dashboard --json
# {"file": ".../sessions/app.example.com/default.json", "source": "Firefox session", ...}
```

It tries these in order and stops at the first that lands logged in:

1. **Saved session**, validated headless (sessions expire; the file is never trusted blindly).
2. **Config login route**, when the site config defines one for the host (see "Site config").
3. **Your browser's session**: cookies of that site (and its identity provider) from the user's
   browsers. Needs consent (see "Rules"). Which browsers are readable on which OS: see the README.
4. **Login window**: a small browser window (`--window-size WxH`, default 520x720). The user signs in;
   AnySSO detects it and closes the window. Its profile remembers the identity provider, so the next
   login is usually one click.

Pass the URL of a page that **requires** login (a dashboard, a settings page), not a public home. If
the logged-in check misfires on a site, pass `--logged-in '<css of an element only shown when logged
in>'`.

The window step waits for a human (default 300 s, `--timeout`). Tell the user a window is opening and
what to do; in CI or unattended runs use `--no-window` (exit 1 when there is no session).

## Use the session

| Consumer | Command |
|----------|---------|
| Playwright | `browser.newContext({ storageState: '<file from login>' })` |
| curl header | `curl -H "Cookie: $(node scripts/anysso.js export <url>)" <url>` |
| curl jar | `node scripts/anysso.js export <url> --format netscape > jar.txt && curl -b jar.txt <url>` |
| API bearer | `curl -H "Authorization: Bearer $(node scripts/anysso.js export <url> --format token)" <api>` |

`export --format` accepts:

| Format | Output |
|--------|--------|
| `header` (default) | `Cookie:` header value |
| `netscape` | Netscape cookie jar |
| `json` | the cookies that apply to the URL, as JSON |
| `state` | path of the saved Playwright `storageState` file |
| `token` | bearer token; exits 1 when none was captured |

`--format token` returns the bearer the app actually uses: AnySSO watches the `Authorization` headers
across the SSO redirect chain during login and keeps the freshest, falling back to a JWT stored in
`localStorage` or cookies. A cookie-only site has no bearer; use `--format header` there.

Several identities on one host: `--account alice`, `--account bob` (on both `login` and `export`).

## Site config

AnySSO has no built-in knowledge of any system. A JSON config holds hosts, login routes and
per-site options; a consumer (another plugin, or the user) supplies it.

Precedence (first that exists wins, no merge): `--config <file>` > `./.anysso.json` >
`$ANYSSO_HOME/sites.json` (default `~/.anysso/sites.json`).

```json
{
  "denylist": ["*.prod.acme.com"],
  "sites": [
    {
      "match": ["localhost:8080", "*.test.acme.com"],
      "login": { "route": "/auth/dev-login?user={user}", "mode": "route" },
      "users": { "alice": "1001", "bob": "1002" },
      "loggedIn": "#user-menu",
      "cookieSites": ["acme.com", "okta.com"],
      "afterLogin": "/dashboard",
      "timeout": 300,
      "insecure": false,
      "testOnly": false
    }
  ]
}
```

| Key | Effect |
|-----|--------|
| `match` | host (with port), hostname, or glob (`*`); string or array. Matched against both host and hostname |
| `login.route` | route that authenticates on visit; `{user}` is replaced by the chosen id. Relative to the target URL |
| `login.mode` | `route` (default) or `window` (always use the login window) |
| `users` | alias to **test-user id** map; pick with `--user <alias>` |
| `loggedIn` | CSS selector that exists only when logged in |
| `cookieSites` | extra sites to import cookies from, e.g. the identity provider |
| `afterLogin` | path or absolute URL on the same registrable site as the target. When the login window is signed in but rests on another host of that site, AnySSO opens it (default: the original URL), at most 2 times |
| `timeout` | login-window timeout, a positive number of seconds |
| `insecure` | `true` or `false`: accept invalid TLS certificates |
| `testOnly` | allow the route login against a non-private host |

**Flags and config.** `--site` adds to `cookieSites`. `--insecure` and `"insecure": true` combine with
OR (loopback hosts always accept invalid certificates). `--logged-in`, `--timeout` and `--user`
override or select the matching config value. `--account` and `--window-size` are flags only.
Validate a file with `anysso config check`.

**Security of the route login (enforced in code):**

- A parameterized route can authenticate as a test user, so it runs only against a **private host**:
  `localhost`, `*.localhost`, `*.local`, `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `*.test` and single-label names (such as `intranet`). For any other host the route
  is refused and AnySSO moves on, unless that site sets `"testOnly": true`.
- A host matching `denylist` is **always** refused for the route, even with `testOnly`.
- The route must resolve to the target's own origin; a route pointing anywhere else is refused.
- `./.anysso.json` can arrive with a cloned repository, so its `insecure` and `testOnly` are ignored
  (with a notice) unless the file is passed with `--config` or `ANYSSO_TRUST_PROJECT_CONFIG=1` is set.
- The config holds test-user **ids, never passwords or tokens**; a secret-bearing key is rejected.

## Environment variables

| Variable | Effect |
|----------|--------|
| `ANYSSO_HOME` | state directory (default `~/.anysso`): sessions, consent, login-window profile, `sites.json` |
| `ANYSSO_CHANNEL` | browser channel to try first for the login window (e.g. `chrome`, `msedge`) |
| `ANYSSO_OZONE_PLATFORM` | Chromium `--ozone-platform` for the login window on Linux (`wayland` or `x11`); default is detected |
| `ANYSSO_NO_NATIVE` | set to any value to skip the Windows host's Edge on WSL and use a local browser |
| `ANYSSO_PLAYWRIGHT_DIR` | extra directory to load Playwright from |
| `ANYSSO_TRUST_PROJECT_CONFIG` | `1` honors `insecure` and `testOnly` from `./.anysso.json` |
| `ANYSSO_DEBUG` | set to any value to print the full stack of unexpected errors |
| `ANYSSO_E2E_WINDOW` | tests only: `1` also runs the real login-window test |

## Rules (non-negotiable)

- **Consent is the user's decision.** Reading browser cookies needs `anysso consent`, once. Never run
  it on your own: ask the user, explain that only cookies of the target site and its identity provider
  are read, then run it if they agree. Without consent, AnySSO skips to the login window.
- **A session is the user's real identity.** On production, only read (navigate, screenshot, GET);
  write only when the user explicitly asks for that change.
- **Never show secrets.** Do not print cookie values, headers or tokens in the chat or in files that
  get committed. Pipe `export` output straight into the command that uses it.
- **Sign out** when the user asks or the task is over on a shared machine: `anysso logout <url>`
  (`--all` for every host, `--forget-window` to also clear the login window's profile).

## Other commands

```bash
node scripts/anysso.js status            # saved sessions: host, account, cookie count, expiry (no values)
node scripts/anysso.js doctor            # Node (>= 22.13), Playwright, readable browsers, consent, display
node scripts/anysso.js consent --revoke  # stop reading browser cookies
```

Exit codes: `0` ok, `1` not logged in or login failed, `2` usage, `3` missing dependency
(`npm i -g playwright && npx playwright install chromium`).

## Known limits

- Browser import copies **cookies only**. Sites that keep the login only in `localStorage` (some
  SPAs) need the login window once; the saved session then carries `localStorage` too.
- Linux Chromium: GNOME keyring via `secret-tool`; KWallet-stored keys are not read.
