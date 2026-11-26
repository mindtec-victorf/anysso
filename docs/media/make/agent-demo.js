'use strict';
// Regenerates docs/media/agent.gif: an AI agent signs in with AnySSO and screenshots the demo app.
//   NODE_PATH=$(npm root -g) PATH=$(dirname $(which playwright)):$PATH node docs/media/make/agent-demo.js
// Needs Playwright + Chromium and ffmpeg (FFMPEG=/path/to/ffmpeg to override).
// Everything shown is real: the CLI and Playwright run headless (--no-window) against the fake Acme app.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { createApp } = require('./acme-app');

const OUT = path.join(__dirname, '..', 'agent.gif');
const CLI = path.join(__dirname, '../../../skills/login/scripts/anysso.js');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const PORT = 4175, U = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anysso-agent-'));
const home = path.join(tmp, '.anysso');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The CLI must run in a child process: the fake app lives in this one.
const run = (cmd, args) => new Promise((resolve) => {
  const p = require('child_process').spawn(cmd, args, { cwd: tmp, env: { ...process.env, ANYSSO_HOME: home, ANYSSO_NO_NATIVE: '1' } });
  let o = '', e = ''; p.stdout.on('data', (d) => { o += d; }); p.stderr.on('data', (d) => { e += d; });
  p.on('exit', (code) => resolve({ code, out: o.trim(), err: e.trim() }));
});

function page(d) {
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#c9d1d9;font:14px/21px "DejaVu Sans Mono",Menlo,Consolas,monospace;height:100vh;overflow:hidden}
.bar{height:36px;background:#161b22;border-bottom:1px solid #21262d;display:flex;align-items:center;padding:0 14px;gap:8px;color:#8b949e;font:13px system-ui,sans-serif}
.d{width:11px;height:11px;border-radius:50%}#log{padding:14px 22px;height:calc(100vh - 36px);overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end}
.m{margin:6px 0}.u{color:#fff}.u i{color:#58a6ff;font-style:normal}.a{color:#e6edf3}.a i{color:#7ee787;font-style:normal}
.t{background:#161b22;border:1px solid #30363d;border-left:3px solid #d29922;border-radius:6px;padding:7px 11px;margin:6px 0;color:#e6edf3;word-break:break-all;font-size:13px}
.t b{color:#d29922;font-weight:600}.o{background:#010409;border:1px solid #21262d;border-radius:6px;padding:7px 11px;margin:6px 0;color:#8b949e;white-space:pre;font-size:13px;line-height:19px}
.h{color:#7ee787;background:#12261a;font-weight:700}.o img{display:block;width:300px;border-radius:6px;border:1px solid #30363d;margin-top:4px}
.cur{display:inline-block;width:8px;height:15px;background:#c9d1d9;vertical-align:-2px}</style>
<div class="bar"><span class="d" style="background:#ff5f56"></span><span class="d" style="background:#ffbd2e"></span><span class="d" style="background:#27c93f"></span>&nbsp;AI agent &middot; AnySSO skill</div>
<div id="log"></div><script>
const D=${JSON.stringify(d)};const L=document.getElementById('log');
const w=(ms)=>new Promise(r=>setTimeout(r,ms));
const add=(c,h)=>{const e=document.createElement('div');e.className=c;e.innerHTML=h;L.appendChild(e);return e;};
async function type(e,pre,txt,ms){let s='';for(const ch of txt){s+=ch;e.innerHTML=pre+s+'<span class="cur"></span>';await w(ms);}e.innerHTML=pre+s;}
(async()=>{await w(500);
 await type(add('m u'),'<i>you &gt;</i> ',D.user,35);await w(700);
 await type(add('m a'),'<i>agent &gt;</i> ',D.say1,22);await w(500);
 const t1=add('t','');await type(t1,'<b>Bash</b> ',D.login,9);await w(600);
 const o1=add('o','');for(const l of D.json){o1.innerHTML+=l+'\\n';await w(110);}await w(900);
 await type(add('m a'),'<i>agent &gt;</i> ',D.say2,22);await w(400);
 const t2=add('t','');await type(t2,'<b>Bash</b> ',D.shot,12);await w(600);
 const o2=add('o','');await w(300);o2.innerHTML='<img src="'+D.img+'">';await w(1200);
 await type(add('m a'),'<i>agent &gt;</i> ',D.done,22);
})();</script>`;
}

(async () => {
  fs.writeFileSync(path.join(tmp, 'sites.json'), JSON.stringify({ sites: [
    { match: `127.0.0.1:${PORT}`, login: { route: '/devlogin?user={user}' }, users: { alice: '1001' } } ] }));
  const server = createApp();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  try {
    // 1. Real login, never opens a window.
    const loginArgs = ['login', `${U}/app`, '--config', 'sites.json', '--user', 'alice', '--title', 'Screenshot the Acme CRM dashboard', '--verify', '/app', '--no-window', '--json'];
    const login = await run(process.execPath, [CLI, ...loginArgs]);
    if (login.code !== 0) throw new Error('login failed: ' + login.out + login.err);
    let res; try { res = JSON.parse(login.out); } catch (_) { throw new Error(login.out + login.err); }
    // 2. Real headless screenshot using the saved storageState.
    const shotArgs = [`--load-storage=${res.file}`, '--viewport-size=760,440', `${U}/app`, path.join(tmp, 'dashboard.png')];
    const shot = await run('playwright', ['screenshot', ...shotArgs]);
    if (shot.code !== 0) throw new Error('screenshot failed: ' + shot.out);
    const img = 'data:image/png;base64,' + fs.readFileSync(path.join(tmp, 'dashboard.png')).toString('base64');

    const hide = (s) => s.split(home).join('~/.anysso');
    const shown = JSON.stringify(res, null, 2).split('\n').map(hide).map(esc).map((l) =>
      /^\s*"(ok|strategy|trail|landed)"/.test(l) ? l.replace(/^(\s*)(.*)$/, '$1<span class="h">$2</span>') : l);
    const html = path.join(tmp, 'agent.html');
    fs.writeFileSync(html, page({
      user: 'Take a screenshot of my Acme CRM dashboard.',
      say1: 'Signing in with AnySSO first.',
      login: esc(`ANYSSO_NO_NATIVE=1 anysso login ${U}/app --config sites.json --user alice --title "Screenshot the Acme CRM dashboard" --verify /app --no-window --json`.replace('ANYSSO_NO_NATIVE=1 ', '')),
      json: shown,
      say2: 'Session ready. Taking the screenshot.',
      shot: esc(`playwright screenshot --load-storage=<file from login> --viewport-size=760,440 ${U}/app dashboard.png`),
      img,
      done: 'Done: dashboard.png (logged in as alice).',
    }));

    const W = 900, H = 600;
    const browser = await chromium.launch(); // headless by default
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: tmp, size: { width: W, height: H } } });
    const p = await ctx.newPage();
    await p.goto('file://' + html);
    await p.waitForTimeout(Number(process.env.DEMO_MS) || 18000);
    const video = p.video(); await ctx.close(); await browser.close();
    const webm = path.join(tmp, 'agent.webm'); fs.renameSync(await video.path(), webm);
    const pal = path.join(tmp, 'pal.png'), vf = `fps=10,scale=${W}:-1:flags=lanczos`;
    execFileSync(FFMPEG, ['-y', '-i', webm, '-vf', `${vf},palettegen=max_colors=64`, pal], { stdio: 'ignore' });
    execFileSync(FFMPEG, ['-y', '-i', webm, '-i', pal, '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`, '-loop', '0', OUT], { stdio: 'ignore' });
    console.log(OUT, (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
  } finally {
    server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
