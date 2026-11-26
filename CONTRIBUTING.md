# Contributing to AnySSO

Thanks for helping. AnySSO logs a user in to any web system once and reuses the session — for
scripts, tests and AI agents. Looking for something to pick up? See the
[Help wanted list](README.md#help-wanted).

## Ground rule: nothing internal

AnySSO is brand-neutral. Never put any company's, employer's or client's real data in the repo or in
an issue: no internal hostnames, login routes, user ids, product names or credentials. Use neutral
examples (`example.com`, `acme.com`, `localhost`). Anything system-specific belongs in your own
`sites.json`, passed with `--config`, outside this repo.

A config file holds test-user ids, never passwords or tokens; see "Site config" in
[SKILL.md](skills/login/SKILL.md) (enforced in code and by `anysso config check`).

## Running the tests

Requires Node.js >= 22.13; install steps are in the [README](README.md).

```bash
npm test                        # unit + headless end-to-end (needs Playwright for the e2e part)
ANYSSO_E2E_WINDOW=1 npm test    # also opens a real login window for a few seconds
```

- `test/pure.test.js` and `test/config.test.js` are pure (no browser, no network).
- `test/cookies.test.js` builds fake browser profiles and reads them back.
- `test/e2e.test.js` runs the CLI against a local fake app; the window case is opt-in.

Tests that need Playwright skip themselves when it is absent, so `npm test` passes without it.
Tests use temporary directories and never touch your real home.

## Layout

```
skills/login/scripts/anysso.js   CLI (login, export, status, logout, consent, doctor, config)
skills/login/scripts/lib/
  pure.js      decisions with no I/O — add new logic here and unit-test it
  config.js    site-config discovery, validation, route-login security
  cookies.js   reading browser cookie databases (Firefox family, Chromium family)
  browser.js   headless login probe and the login window
  store.js     state on disk under ~/.anysso
```

Keep branching and parsing logic in `pure.js` with a test; keep I/O thin.

## Testing a platform

Tested on Windows and on Linux under WSL2. Linux and macOS are expected to work for the saved-session
and login-window paths; reports and PRs welcome.

The full list of contributions we are looking for lives in one place: the
[Help wanted section of the README](README.md#help-wanted).

1. Open a `Support for <platform>` issue (there is a template) so work is not duplicated.
2. The login window must honor `--window-size` and open in normal state, also on a reused profile;
   see `forcePopup` in `browser.js`.
3. On an unsupported path, fail with a clear message, never a traceback.
4. Add or extend a test. CI runs on `ubuntu-latest` and `windows-latest`.

## Pull requests

Small, focused, with a test for new logic. By contributing you agree to license your work under the
MIT License.
