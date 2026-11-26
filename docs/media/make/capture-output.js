'use strict';
// Runs the real CLI against the fake Acme app and writes the transcript to stdout as JSON:
// [{cmd, out}]. The terminal GIF renders exactly this text.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { createApp } = require('./acme-app');

const PORT = 4173;
const CLI = path.join(__dirname, '../../../skills/login/scripts/anysso.js');
const work = path.join(os.tmpdir(), 'acme-demo');
fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
const bin = path.join(work, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'anysso'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
const home = path.join(work, '.anysso');
fs.writeFileSync(path.join(work, 'sites.json'), JSON.stringify({ sites: [
  { match: `127.0.0.1:${PORT}`, login: { route: '/devlogin?user={user}' }, users: { alice: '1001' }, loggedIn: '#me' } ] }));
const U = `http://127.0.0.1:${PORT}`;
const cmds = [
  `anysso login ${U}/app --config sites.json --user alice`,
  `anysso login ${U}/app --config sites.json --user alice`,
  `curl -s -H "Cookie: $(anysso export ${U}/app)" ${U}/api/me`,
  `anysso status`,
];
const server = createApp().listen(PORT, '127.0.0.1', () => {
  // Async spawn: the fake app lives in this process and must keep serving while the CLI runs.
  const { spawn } = require('child_process');
  const out = [];
  const next = (i) => {
    if (i === cmds.length) { server.close(); fs.writeFileSync(process.argv[2], JSON.stringify({ home, out }, null, 1)); return; }
    const p = spawn('sh', ['-c', cmds[i] + ' 2>&1'], { cwd: work, env: { ...process.env, ANYSSO_HOME: home, PATH: bin + path.delimiter + process.env.PATH } });
    let s = ''; p.stdout.on('data', (d) => { s += d; });
    p.on('exit', () => { out.push({ cmd: cmds[i], out: s.replace(/\n$/, '') }); next(i + 1); });
  };
  next(0);
});
process.on('exit', () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {} });
