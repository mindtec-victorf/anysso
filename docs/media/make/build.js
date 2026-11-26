'use strict';
// Regenerates docs/media/terminal.gif and docs/media/login-window.gif.
//   NODE_PATH=$(npm root -g) node docs/media/make/build.js
// Needs Playwright + Chromium and ffmpeg (FFMPEG=/path/to/ffmpeg to override).
// The terminal text is the real output of the real CLI against the fake Acme app (capture-output.js).
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { createApp } = require('./acme-app');

const MEDIA = path.join(__dirname, '..');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anysso-media-'));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toGif(webm, gif, width, fps) {
  const pal = path.join(tmp, 'pal.png');
  const vf = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  execFileSync(FFMPEG, ['-y', '-i', webm, '-vf', `${vf},palettegen=max_colors=64`, pal], { stdio: 'ignore' });
  execFileSync(FFMPEG, ['-y', '-i', webm, '-i', pal, '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`, '-loop', '0', gif], { stdio: 'ignore' });
  console.log(gif, (fs.statSync(gif).size / 1024).toFixed(0) + ' KB');
}

async function record(browser, viewport, ms, setup, name) {
  const ctx = await browser.newContext({ viewport, recordVideo: { dir: tmp, size: viewport } });
  const page = await ctx.newPage();
  await setup(page);
  await page.waitForTimeout(ms);
  const video = page.video();
  await ctx.close();
  const f = path.join(tmp, name + '.webm');
  fs.renameSync(await video.path(), f);
  return f;
}

function terminalHtml(steps, home) {
  const data = JSON.stringify(steps.map((s) => ({ cmd: esc(s.cmd), out: esc(s.out.split(home).join('~/.anysso')).split('\n') })));
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0b1020;font:15px/22px "DejaVu Sans Mono",Menlo,Consolas,monospace;color:#d6deeb}
.bar{height:34px;background:#161b2e;display:flex;align-items:center;padding:0 14px;gap:8px;color:#7f8aa8;font-size:13px}
.d{width:12px;height:12px;border-radius:50%}#t{padding:16px 22px;white-space:pre-wrap;word-break:break-all}
.p{color:#7ee787}.c{color:#fff}.o{color:#9fb0d0}.ok{color:#7ee787}.cur{display:inline-block;width:9px;height:17px;background:#d6deeb;vertical-align:-3px}</style>
<div class="bar"><span class="d" style="background:#ff5f56"></span><span class="d" style="background:#ffbd2e"></span><span class="d" style="background:#27c93f"></span>&nbsp;demo app: Acme CRM on 127.0.0.1</div>
<div id="t"></div><script>
const steps=${data};const t=document.getElementById('t');
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
const color=(l)=>/logged in|^\\{/.test(l)?'<span class="ok">'+l+'</span>':l;
(async()=>{await wait(600);
for(const s of steps){
  const line=document.createElement('div');t.appendChild(line);
  let typed='';for(const ch of s.cmd){typed+=ch;line.innerHTML='<span class="p">$ </span><span class="c">'+typed+'</span><span class="cur"></span>';await wait(22);}
  line.innerHTML='<span class="p">$ </span><span class="c">'+typed+'</span>';await wait(450);
  for(const l of s.out){const d=document.createElement('div');d.className='o';d.innerHTML=color(l);t.appendChild(d);await wait(160);}
  await wait(900);t.appendChild(document.createElement('br'));
}
const e=document.createElement('div');e.innerHTML='<span class="p">$ </span><span class="cur"></span>';t.appendChild(e);
})();</script>`;
}

(async () => {
  const cap = path.join(tmp, 'cap.json');
  execFileSync(process.execPath, [path.join(__dirname, 'capture-output.js'), cap], { stdio: 'inherit' });
  const { home, out } = JSON.parse(fs.readFileSync(cap, 'utf8'));
  const server = createApp();
  await new Promise((r) => server.listen(4174, '127.0.0.1', r));
  const browser = await chromium.launch();

  const html = path.join(tmp, 'terminal.html');
  fs.writeFileSync(html, terminalHtml(out, home));
  const tv = await record(browser, { width: 900, height: 460 }, 16000, (p) => p.goto('file://' + html), 'terminal');
  toGif(tv, path.join(MEDIA, 'terminal.gif'), 900, 10);

  const wv = await record(browser, { width: 520, height: 720 }, 10500, async (p) => {
    const b = 'http://127.0.0.1:4174';
    await p.goto(b + '/app'); // redirected to the Acme SSO page
    await p.waitForTimeout(1500);
    await p.type('#u', 'alice', { delay: 120 });
    await p.type('#p', 'demo-password', { delay: 90 });
    await p.waitForTimeout(600);
    await p.click('#go');
    await p.waitForTimeout(500);
    await p.goto(b + '/signin-done'); // staged sign-in: cookie + redirect to the dashboard
    await p.waitForTimeout(500);
    await p.evaluate(() => { document.title = 'Acme CRM'; });
  }, 'window');
  toGif(wv, path.join(MEDIA, 'login-window.gif'), 520, 10);

  await browser.close(); server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})();
