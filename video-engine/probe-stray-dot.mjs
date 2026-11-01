/** 找出"左上角游离小圆点"到底是什么元素。 */
const CDP_PORT = 9566;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

const PAGE = process.argv[2];
const profile = path.join(os.tmpdir(), 'cdp-probe-profile');
fs.mkdirSync(profile, { recursive: true });
spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) { ws = (await r.json()).webSocketDebuggerUrl; break; } } catch {}
  await sleep(250);
}
const sock = new WebSocket(ws);
let id = 0; const pending = new Map();
sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => sock.addEventListener('open', r, { once: true }));
const raw = (method, params = {}, sid) => new Promise((res) => { const i = ++id; pending.set(i, res); sock.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) })); });
const t = await raw('Target.createTarget', { url: 'about:blank' }, null);
const sid = (await raw('Target.attachToTarget', { targetId: t.result.targetId, flatten: true }, null)).result.sessionId;
await raw('Page.enable', {}, sid);
await raw('Page.navigate', { url: PAGE }, sid);
await sleep(2500);
const evalJs = async (expression) => (await raw('Runtime.evaluate', { expression, returnByValue: true }, sid)).result?.result?.value;

await evalJs('window.seek(9)');
await sleep(300);
const report = await evalJs(`JSON.stringify([...document.querySelectorAll('div')].map(el=>{
  const r=el.getBoundingClientRect(); const cs=getComputedStyle(el);
  return {cls:el.className, track:el.dataset.track??'', w:Math.round(r.width), h:Math.round(r.height),
          x:Math.round(r.x), y:Math.round(r.y), op:+(+cs.opacity).toFixed(2), vis:cs.visibility,
          sec:el.closest('[data-section]')?.dataset.section ?? '(none)'};
}).filter(o=>o.w>0&&o.h>0&&o.op>0.05&&o.x<40&&o.y<40))`);
console.log('左上角 (x<40,y<40) 且可见的元素:');
for (const o of JSON.parse(report ?? '[]')) console.log(' ', JSON.stringify(o));
process.exit(0);
