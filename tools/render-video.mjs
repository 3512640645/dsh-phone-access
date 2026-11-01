#!/usr/bin/env node
/**
 * 把 D:\dsh-video\animation.html 逐帧渲染成视频（不依赖 CSS 动画，每帧由 seek(t) 精确计算）。
 * 输出到 D 盘，编码用便携版 ffmpeg，不写 C 盘临时目录。
 *
 * 用法：node render-video.mjs [--fps 30] [--scale 1] [--out D:\dsh-video\out\demo.mp4]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const FPS = Number(flag('fps', 30));
const W = Number(flag('w', 1920));
const H = Number(flag('h', 1080));
const FRAMES = flag('frames', 'D:\\dsh-video\\frames');
const OUT = flag('out', 'D:\\dsh-video\\out\\dsh-phone-access.mp4');
const PAGE = flag('page', 'file:///D:/dsh-video/animation.html');
const FFMPEG = flag('ffmpeg', 'D:\\dsh-video\\tools\\ffmpeg\\ffmpeg.exe');
const ONLY = flag('only', '');   // 「--only 2,9,15」只出这几秒的帧，用于预览，不编码
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CDP_PORT ?? 9555);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(FRAMES, { recursive: true });
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// ── 启动 Edge（无头，配置放 D 盘） ──────────────────────────────────────────
const profile = 'D:\\dsh-video\\.edge-profile';
fs.mkdirSync(profile, { recursive: true });
spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1', '--font-render-hinting=none',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { detached: true, stdio: 'ignore' }).unref();

let browserWs = null;
for (let i = 0; i < 80; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (res.ok) { browserWs = (await res.json()).webSocketDebuggerUrl; break; }
  } catch { /* 还没起来 */ }
  await sleep(250);
}
if (!browserWs) throw new Error('Edge CDP 未就绪');

const ws = new WebSocket(browserWs);
let nextId = 0;
const pending = new Map();
let sessionId = null;
const raw = (method, params = {}, useSession = true) => {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(useSession ? { id, method, params, sessionId } : { id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timeout`)); }, 60000);
  });
};
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('CDP ws 失败')), { once: true });
});

const created = await raw('Target.createTarget', { url: 'about:blank' }, false);
sessionId = (await raw('Target.attachToTarget', { targetId: created.targetId, flatten: true }, false)).sessionId;
await raw('Page.enable');
await raw('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await raw('Page.navigate', { url: PAGE });
await sleep(2500);

const evaluate = async (expression) => {
  const out = await raw('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? 'eval 失败');
  return out.result?.value;
};

const dur = await evaluate('window.DUR');

// 预览模式：只出指定秒数的帧，不编码
if (ONLY) {
  const times = ONLY.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  fs.mkdirSync(FRAMES, { recursive: true });
  for (const t of times) {
    await evaluate(`window.seek(${t})`);
    const shot = await raw('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
    const file = path.join(FRAMES, `preview-${String(t).replace('.', '_')}s.jpg`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`预览 ${t}s -> ${file}`);
  }
  process.exit(0);
}

const total = Math.round(dur * FPS);
console.log(`总时长 ${dur}s · ${FPS}fps · 共 ${total} 帧 · 分辨率 ${W}x${H}`);
console.log(`帧目录 ${FRAMES}`);

const started = Date.now();
for (let i = 0; i < total; i++) {
  const t = i / FPS;
  await evaluate(`window.seek(${t.toFixed(4)})`);
  const shot = await raw('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
  fs.writeFileSync(path.join(FRAMES, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(shot.data, 'base64'));
  if (i % 60 === 0 || i === total - 1) {
    const pct = ((i + 1) / total * 100).toFixed(1);
    const eta = ((Date.now() - started) / (i + 1)) * (total - i - 1) / 1000;
    process.stdout.write(`\r  渲染 ${pct}%  (${i + 1}/${total})  剩余约 ${eta.toFixed(0)}s   `);
  }
}
console.log('\n帧渲染完成，开始编码 …');

await new Promise((resolve, reject) => {
  const ff = spawn(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-vf', 'scale=in_range=full:out_range=tv',
    OUT,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });
  ff.on('error', reject);
  ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
});
const size = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`\n完成：${OUT}  (${size} MB)`);
process.exit(0);
