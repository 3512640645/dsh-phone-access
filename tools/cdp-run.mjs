#!/usr/bin/env node
/**
 * 用 CDP 跑一段「真实点击」流程：导航 -> 点击 -> 截图 -> 抓 DOM。
 * 关键点：点击用 Input.dispatchMouseEvent 发真实鼠标事件（合成 MouseEvent 打不开 React 里的会话列表）。
 *
 * 用法：node cdp-run.mjs <步骤文件.json>
 * 步骤文件是数组，每项支持：
 *   { "goto": "url" }           导航
 *   { "sleep": 2000 }           等待毫秒
 *   { "click": "css选择器" }     滚到可见处并真实点击中心点
 *   { "clickText": "文字" }      按可见文字找可点击元素再点
 *   { "eval": "表达式" }         求值并打印
 *   { "evalFile": "x.js" }       从文件读表达式
 *   { "shot": "out.png" }       截图
 *   { "dom": "out.html" }       抓 DOM
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CDP_PORT ?? 9333);
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 EdgA/131.0.0.0';

const stepsFile = process.argv[2];
if (!stepsFile) {
  console.error('usage: node cdp-run.mjs <steps.json>');
  process.exit(2);
}
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8').replace(/^\uFEFF/u, ''));
const baseDir = path.dirname(path.resolve(stepsFile));

const width = Number(process.env.PHONE_W ?? 390);
const height = Number(process.env.PHONE_H ?? 844);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  // 复用同一份浏览器配置：首次须知、Cookie 等状态能保留，跑多次更贴近真实手机
  const profile = process.env.CDP_PROFILE ?? path.join(os.tmpdir(), 'cdp-dsh-phone-profile');
  fs.mkdirSync(profile, { recursive: true });
  spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('Edge CDP 未就绪');
}

const browserWs = await launch();
const ws = new WebSocket(browserWs);
let nextId = 0;
const pending = new Map();
let sessionId = null;
const logs = [];

const raw = (method, params = {}, useSession = true) => {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(useSession ? { id, method, params, sessionId } : { id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timeout`)); }, 90000);
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
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push(`EXCEPTION ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    logs.push(`${msg.params.type.toUpperCase()} ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('CDP WebSocket 失败')), { once: true });
});

const created = await raw('Target.createTarget', { url: 'about:blank' }, false);
sessionId = (await raw('Target.attachToTarget', { targetId: created.targetId, flatten: true }, false)).sessionId;
await raw('Page.enable');
await raw('Runtime.enable');
await raw('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height });
await raw('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA });

const evaluate = async (expression) => {
  const out = await raw('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? 'eval 失败');
  return out.result?.value;
};

const centerOf = async (selector) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);

const centerOfText = async (text) => evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button,[role="button"],[tabindex],a,li,label,span,div')];
  const hits = nodes.filter((e) => (e.innerText || e.textContent || '').includes(${JSON.stringify(text)}));
  if (!hits.length) return null;
  // 取"最小面积"的那个，避免点到包住整页的容器
  const sized = hits.map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => x.r.width > 8 && x.r.height > 8);
  if (!sized.length) return null;
  sized.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
  const { e, r } = sized[0];
  e.scrollIntoView({ block: 'center' });
  const after = e.getBoundingClientRect();
  return { x: Math.round(after.left + after.width / 2), y: Math.round(after.top + after.height / 2), label: (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 30) };
})()`);

const realClick = async (point) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await raw('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    await sleep(60);
  }
};

for (const step of steps) {
  if (step.goto) {
    await raw('Page.navigate', { url: step.goto });
    await sleep(step.sleep ?? 3000);
    console.log(`-> goto ${step.goto}`);
  }
  if (step.sleep) await sleep(step.sleep);
  if (step.eval) console.log(`eval: ${JSON.stringify(await evaluate(step.eval))}`);
  if (step.evalFile) {
    const expr = fs.readFileSync(path.resolve(baseDir, step.evalFile), 'utf8');
    console.log(`evalFile ${step.evalFile}: ${JSON.stringify(await evaluate(expr))}`);
  }
  if (step.click) {
    const point = await centerOf(step.click);
    if (point) { await realClick(point); console.log(`-> click ${step.click} @${point.x},${point.y}`); }
    else console.log(`!! 找不到 ${step.click}`);
  }
  if (step.clickText) {
    const point = await centerOfText(step.clickText);
    if (point) { await realClick(point); console.log(`-> clickText ${step.clickText} @${point.x},${point.y} "${point.label}"`); }
    else console.log(`!! 找不到文字 ${step.clickText}`);
  }
  if (step.clickEval) {
    const point = await evaluate(`(() => { ${step.clickEval} })()`);
    if (point && point.x !== undefined) { await realClick(point); console.log(`-> clickEval @${point.x},${point.y} ${point.label ?? ''}`); }
    else console.log(`!! clickEval 没拿到坐标: ${JSON.stringify(point)}`);
  }
  if (step.shot) {
    const shot = await raw('Page.captureScreenshot', { format: 'png' });
    const out = path.resolve(baseDir, step.shot);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log(`shot -> ${out}`);
  }
  if (step.dom) {
    const dom = await evaluate('document.documentElement.outerHTML');
    const out = path.resolve(baseDir, step.dom);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, String(dom), 'utf8');
    console.log(`dom -> ${out}`);
  }
}

if (logs.length) {
  console.log('== 控制台错误/警告 ==');
  for (const line of logs.slice(0, 20)) console.log(`  ${line.slice(0, 180)}`);
} else {
  console.log('== 无控制台错误 ==');
}
process.exit(0);
