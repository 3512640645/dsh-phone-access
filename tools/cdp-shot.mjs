#!/usr/bin/env node
/**
 * 用 CDP 驱动本机 Edge，给指定 URL 截图 / 抓 DOM / 取网络与控制台信息。
 * 用途：验证手机端 UI 适配效果，以及在不动 DSH 文件的前提下摸清 DOM 结构。
 *
 * 用法：
 *   node cdp-shot.mjs <url> <out.png> [--w 390] [--h 844] [--wait 8000] [--mobile]
 *                      [--dom dom.html] [--eval "表达式"] [--eval-file 文件]
 *                      [--netlog] [--cookies] [--errors]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const positionals = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const url = positionals[0];
const outPng = positionals[1];
const width = Number(flag('w', 390));
const height = Number(flag('h', 844));
const waitMs = Number(flag('wait', 6000));
const domPath = flag('dom', null);
const evalFile = flag('eval-file', null);
const evalExpr = evalFile ? fs.readFileSync(evalFile, 'utf8') : flag('eval', null);
const useMobile = argv.includes('--mobile');
const netLog = argv.includes('--netlog');
const cookieLog = argv.includes('--cookies');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-dsh-'));
  spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not ready yet */ }
    await sleep(250);
  }
  throw new Error('Edge CDP port not ready');
}

const browserWs = await launch();
if (!url) {
  console.log(`Edge started, CDP: ${browserWs}`);
  process.exit(0);
}

const ws = new WebSocket(browserWs);
let nextId = 0;
const pending = new Map();
const events = [];
const consoleErrors = [];
let sessionId = null;

const raw = (method, params = {}, useSession = true) => {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(useSession ? { id, method, params, sessionId } : { id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timeout`));
    }, 90000);
  });
};

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (!msg.method || msg.sessionId !== sessionId) return;
  if (msg.method === 'Network.requestWillBeSent') {
    const h = msg.params.request.headers ?? {};
    const cookie = Object.entries(h).find(([k]) => k.toLowerCase() === 'cookie');
    events.push({ id: msg.params.requestId, url: msg.params.request.url, cookie: cookie ? cookie[1] : '(none)', status: null });
  }
  if (msg.method === 'Network.responseReceived') {
    const hit = events.find((e) => e.id === msg.params.requestId);
    if (hit) hit.status = msg.params.response.status;
  }
  if (msg.method === 'Network.loadingFailed') {
    const hit = events.find((e) => e.id === msg.params.requestId);
    if (hit) hit.failed = msg.params.errorText;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(`EXCEPTION ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    consoleErrors.push(`${msg.params.type.toUpperCase()} ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
});

const created = await raw('Target.createTarget', { url: 'about:blank' }, false);
sessionId = (await raw('Target.attachToTarget', { targetId: created.targetId, flatten: true }, false)).sessionId;

await raw('Page.enable');
if (netLog) await raw('Network.enable');
if (argv.includes('--errors')) await raw('Runtime.enable');
await raw('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 2, mobile: useMobile, screenWidth: width, screenHeight: height,
});
if (useMobile) await raw('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA });
await raw('Page.navigate', { url });
await sleep(waitMs);

if (evalExpr) {
  const out = await raw('Runtime.evaluate', { expression: evalExpr, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(out.result?.value ?? out.result, null, 2));
}
if (cookieLog) {
  const cookies = await raw('Network.getCookies', { urls: [url] });
  console.log('== cookies ==');
  for (const c of cookies.cookies ?? []) {
    console.log(`  ${c.name} domain=${c.domain} path=${c.path} sameSite=${c.sameSite ?? '-'} httpOnly=${c.httpOnly} secure=${c.secure} expires=${c.expires}`);
  }
}
if (netLog) {
  console.log('== requests ==');
  for (const e of events) {
    const short = e.url.replace(/^https?:\/\/[^/]+/u, '').slice(0, 100);
    console.log(`  ${String(e.status ?? (e.failed ? `FAIL:${e.failed}` : 'pending')).padEnd(18)} ${short}`);
  }
}
if (consoleErrors.length) {
  console.log('== console errors ==');
  for (const line of consoleErrors.slice(0, 20)) console.log(`  ${line.slice(0, 200)}`);
}
if (domPath) {
  const dom = await raw('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
  fs.writeFileSync(domPath, String(dom.result?.value ?? ''), 'utf8');
  console.log(`DOM written: ${domPath}`);
}
if (outPng) {
  const shot = await raw('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log(`screenshot written: ${outPng}`);
}
process.exit(0);
