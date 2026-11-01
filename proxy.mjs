#!/usr/bin/env node
/**
 * DSH 手机访问网关 (dsh-phone-proxy)
 *
 * 背景：DSH Desktop 启动 Harness 时固定 `web --host 127.0.0.1 --port <port>`，
 * 而 `dsh-client-connection` 的 Host/Origin 栅栏只接受 loopback、监听器绑定 IP
 * 或 `--trusted-host` 声明的 authority。所以手机直连局域网 IP 或走隧道时：
 *   - 首页能拿到（200）
 *   - 所有 /api 请求和 WebSocket 会被 403 拒绝
 *
 * 做法：反向代理，对每个转发请求重写
 *   Host:   <外部 authority>  ->  127.0.0.1:<harness 端口>
 *   Origin / Referer 同理
 * 这样栅栏、authority 绑定的签名 Cookie、同源 Origin 校验三者同时满足，
 * Harness 本身仍只监听 loopback，不需要改任何 DSH 文件。
 *
 * 认证策略（002 版，专治 ERR_TOO_MANY_REDIRECTS）：
 *   - 手机侧只有一把访问密钥（?k=<key> -> HttpOnly Cookie），**不发任何重定向**，
 *     带密钥的第一次请求直接返回 200 首页。
 *   - Harness 的启动 token 换取签名 Cookie 这一步完全在网关内部完成，网关自己
 *     保存这份 Cookie 并注入每个上游请求。手机浏览器存不存 Cookie 都不影响，
 *     因此不会再出现「401 -> 换 Cookie -> 重定向 -> 401」的循环。
 *
 * 环境变量：
 *   PHONE_PORT=8080        监听端口（同时绑 loopback 和局域网地址）
 *   PHONE_HOST=<ip>        额外监听地址
 *   PHONE_KEY=<key>        访问密钥（默认读同目录 phone-key.txt；都不给则不设防）
 *   PHONE_ALLOW=ip1,ip2    仅允许这些客户端 IP
 *   DSH_LOG=<path>         Desktop 日志路径（默认 %APPDATA%\dsh-desktop\logs\harness.log）
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const ROOT = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1'));

// 日志同时写控制台和同目录 proxy.log（无窗口启动时也能事后排障，超过 2 MB 自动清空）
const LOG_FILE = path.join(ROOT, 'proxy.log');
const rawLog = console.log.bind(console);
function tee(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args.map(String).join(' ')}`;
  rawLog(line);
  try {
    if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.writeFileSync(LOG_FILE, '');
  } catch { /* 文件还不存在，忽略 */ }
  try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch { /* 忽略日志写失败 */ }
}
console.log = (...a) => tee('info', a);
console.warn = (...a) => tee('warn', a);
console.error = (...a) => tee('error', a);
const LOG_PATH = process.env.DSH_LOG
  ?? path.join(process.env.APPDATA ?? process.cwd(), 'dsh-desktop', 'logs', 'harness.log');
const LISTEN_PORT = Number(process.env.PHONE_PORT || 8080);
const ALLOW = (process.env.PHONE_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
const LOOPBACK = '127.0.0.1';
const HARNESS_LINE = /dsh web:\s*(https?:\/\/[^\s"'<>]+)/gu;
const KEY_COOKIE = 'dsh-phone-key';
const AUTH_COOKIE = /^dsh-auth-[A-Za-z0-9_-]+=[^;]+/u;

function loadKey() {
  const fromEnv = (process.env.PHONE_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(path.join(ROOT, 'phone-key.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}
const ACCESS_KEY = loadKey();
/** 访问 Cookie 不设上限：10 年，手机不用反复重开链接。 */
const KEY_COOKIE_ATTRS = `${KEY_COOKIE}=${ACCESS_KEY}; Path=/; Max-Age=315360000; Expires=Thu, 01 Jan 2037 00:00:00 GMT; HttpOnly; SameSite=Lax`;

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.byteLength === right.byteLength && crypto.timingSafeEqual(left, right);
}

function cookieValue(header, name) {
  for (const segment of String(header ?? '').split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim();
  }
}

/** 'pass' 放行 | 'grant' 本次带了正确密钥（下发 Cookie 后继续） | 'deny' 拒绝 */
function gate(providedKey, cookieHeader) {
  if (!ACCESS_KEY) return 'pass';
  const present = cookieValue(cookieHeader, KEY_COOKIE);
  if (present !== undefined && safeEqual(present, ACCESS_KEY)) return 'pass';
  if (providedKey !== null && providedKey !== '' && safeEqual(providedKey, ACCESS_KEY)) return 'grant';
  return 'deny';
}

/**
 * 免密钥路径：浏览器/系统在「不带凭据」的前提下也会取这些文件（web app manifest、
 * 图标），拦下来只会让 PWA 安装和图标失效，且它们不含任何会话或工作区信息。
 */
const KEY_EXEMPT = new Set(['/manifest.webmanifest', '/dsh-desktop-logo.png', '/favicon.svg', '/favicon-dark.svg', '/favicon.ico']);

/**
 * 注意：DSH 的客户端插件批量 URL 形如 `/plugins/??a/client.js,b/client.js`，
 * 这里必须按字符串处理，绝不能丢给 `new URL()` 再序列化 —— 那会把 `??`
 * 当成查询分隔符重写，导致上游 404、插件加载失败。
 */
function splitTarget(rawTarget) {
  const hashAt = rawTarget.indexOf('#');
  const withoutHash = hashAt === -1 ? rawTarget : rawTarget.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  const pathname = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const query = queryAt === -1 ? '' : withoutHash.slice(queryAt + 1);
  return { pathname, query };
}

/** 取 ?k=<key> 的值（不做 URL 归一化，原样解码）。 */
function keyFromQuery(query) {
  for (const segment of query.split('&')) {
    if (!segment.startsWith('k=')) continue;
    try {
      return decodeURIComponent(segment.slice(2));
    } catch {
      return segment.slice(2);
    }
  }
  return null;
}

/** 去掉 ?k=<key>，其余查询串逐字节保留。 */
function stripKey(rawTarget) {
  const { pathname, query } = splitTarget(rawTarget);
  if (query === '') return rawTarget;
  const kept = query.split('&').filter((segment) => !segment.startsWith('k='));
  return kept.length ? `${pathname}?${kept.join('&')}` : pathname;
}

function withToken(target, token) {
  const param = `token=${encodeURIComponent(token)}`;
  return target.includes('?') ? `${target}&${param}` : `${target}?${param}`;
}

function lanIPv4() {
  if (process.env.PHONE_HOST) return process.env.PHONE_HOST;
  const candidates = localIPv4s();
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0] ?? '127.0.0.1';
}

/** 本机所有非 loopback IPv4（含 Tailscale 的 100.x 网段；跳过 169.254 这类自动专用地址）。 */
function localIPv4s() {
  const found = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      if (!found.includes(a.address)) found.push(a.address);
    }
  }
  return found;
}

/** 读取日志尾部若干字节。 */
function tail(file, bytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** 从日志里按时间倒序列出所有 (port, token) 候选。 */
function candidates() {
  let text;
  try {
    text = tail(LOG_PATH, 512 * 1024);
  } catch {
    return [];
  }
  const found = [];
  for (const m of text.matchAll(HARNESS_LINE)) {
    try {
      const url = new URL(m[1]);
      const token = url.searchParams.get('token');
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      if (!token || !Number.isInteger(port) || port <= 0) continue;
      const key = `${port}:${token}`;
      if (found.some((c) => c.key === key)) continue;
      found.push({ key, port, token });
    } catch { /* 忽略无法解析的行 */ }
  }
  return found.reverse();
}

let cache = { mtimeMs: 0, list: [] };
function refreshedCandidates() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(LOG_PATH).mtimeMs; } catch { /* 日志可能还没建 */ }
  if (mtimeMs !== cache.mtimeMs) cache = { mtimeMs, list: candidates() };
  return cache.list;
}

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, LOOPBACK);
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(400);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

let active = null;
async function upstream({ force = false } = {}) {
  if (active && !force) return active;
  for (const cand of refreshedCandidates()) {
    if (await probe(cand.port)) { active = cand; return active; }
  }
  active = null;
  return null;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });

/** 网关自己持有的 Harness 签名 Cookie：进程内一份，失配时重新签发。 */
let harnessAuth = null;
let harnessAuthFor = null;

function cookieFromSetCookie(headers) {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const line of list) {
    const m = AUTH_COOKIE.exec(String(line));
    if (m) return m[0];
  }
  return null;
}

/** 用启动 token 换一份签名 Cookie（Harness 会回 303 + Set-Cookie）。 */
async function mintAuth(up) {
  const out = await send({
    port: up.port,
    path: `/?token=${encodeURIComponent(up.token)}`,
    method: 'GET',
    headers: { host: `${LOOPBACK}:${up.port}` },
  });
  const cookie = cookieFromSetCookie(out.headers);
  if (cookie) {
    harnessAuth = cookie;
    harnessAuthFor = up.key;
    console.log(`[phone-proxy] 已用启动 token 续签 Harness Cookie（上游 ${LOOPBACK}:${up.port}）`);
    return true;
  }
  console.warn(`[phone-proxy] 续签失败：上游返回 ${out.status}，可能 token 已过期`);
  harnessAuth = null;
  harnessAuthFor = null;
  return false;
}

async function ensureAuth(up) {
  if (harnessAuth && harnessAuthFor === up.key) return true;
  return mintAuth(up);
}

/** 把网关持有的 Harness Cookie 注入上游 Cookie 头；客户端自带的优先保留。 */
function upstreamCookie(clientCookie) {
  const base = clientCookie ?? '';
  if (!harnessAuth) return base;
  const name = harnessAuth.split('=')[0];
  if (base.includes(`${name}=`)) return base;
  return base ? `${base}; ${harnessAuth}` : harnessAuth;
}

function rewriteHeaders(headers, authority) {
  const out = { ...headers };
  out.host = authority;
  out['x-forwarded-host'] = headers.host ?? '';
  if (out.origin !== undefined) out.origin = `http://${authority}`;
  if (out.referer !== undefined) out.referer = String(out.referer).replace(/^https?:\/\/[^/]+/u, `http://${authority}`);
  delete out['x-forwarded-proto'];
  return out;
}

function send({ port, path: reqPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: LOOPBACK, port, path: reqPath, method, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function deny(res, code, text) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

// ───────────────────────── 手机端 UI 适配层 ─────────────────────────
const MOBILE_CSS_FILE = path.join(ROOT, 'mobile.css');
let mobileCssCache = { mtimeMs: 0, text: '' };

/** 读 mobile.css（按 mtime 热加载，改完样式不用重启网关）。 */
function mobileCss() {
  try {
    const mtimeMs = fs.statSync(MOBILE_CSS_FILE).mtimeMs;
    if (mtimeMs !== mobileCssCache.mtimeMs) {
      mobileCssCache = { mtimeMs, text: fs.readFileSync(MOBILE_CSS_FILE, 'utf8') };
    }
    return mobileCssCache.text;
  } catch {
    return mobileCssCache.text;
  }
}

/** 手机端交互脚本（抽屉遮罩/自动收起），同样热加载。 */
const MOBILE_JS_FILE = path.join(ROOT, 'mobile.js');
const MOBILE_JS_PATH = '/_dsh_phone/mobile.js';
let mobileJsCache = { mtimeMs: 0, text: '' };
function mobileJs() {
  try {
    const mtimeMs = fs.statSync(MOBILE_JS_FILE).mtimeMs;
    if (mtimeMs !== mobileJsCache.mtimeMs) {
      mobileJsCache = { mtimeMs, text: fs.readFileSync(MOBILE_JS_FILE, 'utf8') };
    }
    return mobileJsCache.text;
  } catch {
    return mobileJsCache.text;
  }
}

function isMobileClient(req) {
  const ua = String(req.headers['user-agent'] ?? '');
  if (/Android|iPhone|iPad|iPod|Windows Phone|HarmonyOS|Mobile Safari|MicroMessenger/i.test(ua)) return true;
  const hint = String(req.headers['sec-ch-ua-mobile'] ?? '');
  return hint.includes('?1');
}

/** 给手机版 index.html 注入视口/主题色/适配样式。 */
function injectMobileShell(html, req) {
  if (!isMobileClient(req)) return html;
  let out = html;
  out = out.replace(
    /<meta name="viewport"[^>]*>/i,
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">',
  );
  const head = [
    '<meta name="theme-color" content="#151517">',
    '<meta name="color-scheme" content="dark light">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<link rel="apple-touch-icon" href="/dsh-desktop-logo.png">',
    `<style id="dsh-phone-adapt">\n${mobileCss()}\n</style>`,
    `<script src=".${MOBILE_JS_PATH}" defer></script>`,
  ].join('\n');
  return out.includes('</head>') ? out.replace('</head>', `${head}\n</head>`) : `${head}\n${out}`;
}

/** PWA 用 standalone：fullscreen 在手机上会把状态栏一起吃掉。 */
function adaptManifest(body) {
  try {
    const manifest = JSON.parse(body.toString('utf8'));
    if (manifest.display === 'fullscreen') manifest.display = 'standalone';
    return Buffer.from(JSON.stringify(manifest), 'utf8');
  } catch {
    return body;
  }
}

/**
 * 解压上游响应体。
 * Harness 对 Accept-Encoding 会回 gzip/br，必须解压后再改 HTML/JSON ——
 * 直接在压缩字节上做字符串替换会把页面写成乱码。
 * @returns {{ text: string } | null} null 表示编码未知，调用方应原样透传。
 */
function decodeText(body, headers) {
  const encoding = String(headers['content-encoding'] ?? '').trim().toLowerCase();
  try {
    if (encoding === '' || encoding === 'identity') return { text: body.toString('utf8') };
    if (encoding === 'gzip' || encoding === 'x-gzip') return { text: zlib.gunzipSync(body).toString('utf8') };
    if (encoding === 'br') return { text: zlib.brotliDecompressSync(body).toString('utf8') };
    if (encoding === 'deflate') return { text: zlib.inflateSync(body).toString('utf8') };
  } catch {
    return null;
  }
  return null;
}

/** 响应里合并「密钥 Cookie」和上游 Set-Cookie。 */
function mergedCookies(headers, extra) {
  const out = { ...headers };
  const raw = out['set-cookie'];
  const list = [...(Array.isArray(raw) ? raw : raw ? [raw] : []), ...extra];
  delete out['set-cookie'];
  if (list.length) out['set-cookie'] = list;
  return out;
}

async function handleRequest(req, res) {
  const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/u, '');
  if (ALLOW.length && !ALLOW.includes(remote)) return deny(res, 403, `phone-proxy: ${remote} 不在 PHONE_ALLOW 白名单内\n`);

  const rawTarget = req.url ?? '/';
  const { pathname, query } = splitTarget(rawTarget);
  const providedKey = keyFromQuery(query);
  const exempt = KEY_EXEMPT.has(pathname);
  const decision = exempt ? 'pass' : gate(providedKey, req.headers.cookie);
  if (decision === 'deny') {
    console.log(`[phone-proxy] 401 ${req.method} ${rawTarget} <- ${remote} 缺少访问密钥`);
    return deny(res, 401, 'phone-proxy: 缺少访问密钥，请使用带 ?k=... 的完整链接访问\n');
  }
  const extraCookies = [];
  if (decision === 'grant') {
    extraCookies.push(KEY_COOKIE_ATTRS);
    console.log(`[phone-proxy] 200 ${req.method} ${rawTarget} <- ${remote} 密钥正确，已下发访问 Cookie`);
  }
  // 密钥只用于网关自身：从转发的目标里摘掉，且绝不重定向
  const forwardPath = providedKey === null ? rawTarget : stripKey(rawTarget);

  // 手机端交互脚本由网关自己提供，不转发给上游
  if (req.method === 'GET' && pathname === MOBILE_JS_PATH) {
    const body = Buffer.from(mobileJs(), 'utf8');
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(body.length),
    });
    return res.end(body);
  }

  const up = await upstream();
  if (!up) return deny(res, 503, `phone-proxy: 没有找到在跑的 Harness Web 实例（日志：${LOG_PATH}）\n`);

  const authority = `${LOOPBACK}:${up.port}`;
  const headers = rewriteHeaders(req.headers, authority);
  headers.cookie = upstreamCookie(req.headers.cookie);
  const isIndex = req.method === 'GET' && pathname === '/';

  // 首页：缓冲转发；上游 401 时先续签再重放，绝不把 401/303 链条丢给浏览器
  if (isIndex) {
    try {
      await ensureAuth(up);
      headers.cookie = upstreamCookie(req.headers.cookie);
      let out = await send({ port: up.port, path: forwardPath, method: 'GET', headers });
      if (out.status === 401 && await mintAuth(up)) {
        headers.cookie = upstreamCookie(req.headers.cookie);
        out = await send({ port: up.port, path: withToken(forwardPath, up.token), method: 'GET', headers });
      }
      const outHeaders = mergedCookies(out.headers, extraCookies);
      delete outHeaders['transfer-encoding'];
      let body = out.body;
      if (out.status === 200 && String(out.headers['content-type'] ?? '').includes('text/html')) {
        const decoded = decodeText(body, out.headers);
        if (decoded) {
          body = Buffer.from(injectMobileShell(decoded.text, req), 'utf8');
          delete outHeaders['content-encoding']; // 已解压，不能再声称是 gzip/br
        }
      }
      outHeaders['content-length'] = String(body.length);
      const hasAuth = Boolean(harnessAuth);
      console.log(`[phone-proxy] ${out.status} GET ${forwardPath} <- ${remote} index auth=${hasAuth ? 'ok' : 'no'}${isMobileClient(req) ? ' mobile' : ''}`);
      res.writeHead(out.status ?? 502, outHeaders);
      res.end(body);
    } catch (error) {
      active = null;
      deny(res, 502, `phone-proxy: 上游错误 ${error.message}\n`);
    }
    return;
  }

  // PWA manifest：手机上把 fullscreen 改成 standalone（否则状态栏也被吃掉）
  if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
    try {
      const out = await send({ port: up.port, path: forwardPath, method: 'GET', headers });
      const decoded = decodeText(out.body, out.headers);
      const body = decoded ? adaptManifest(Buffer.from(decoded.text, 'utf8')) : out.body;
      const outHeaders = mergedCookies(out.headers, extraCookies);
      delete outHeaders['transfer-encoding'];
      if (decoded) delete outHeaders['content-encoding'];
      outHeaders['content-length'] = String(body.length);
      res.writeHead(out.status ?? 502, outHeaders);
      return res.end(body);
    } catch (error) {
      active = null;
      return deny(res, 502, `phone-proxy: 上游错误 ${error.message}\n`);
    }
  }

  // 其它请求：流式转发（无 body 的请求遇到 401 会先续签再重试一次）
  // 内容是构建期 hash 命名的静态资源（/assets/x-<hash>.js、plugins/??...&rev=<hash>），
  // 给它们加 immutable 缓存：手机上第二次打开几乎不用再下载（Tailscale 慢链路尤其明显）。
  const immutable = /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(?:js|css|woff2?|ttf|png|svg|webp)$/u.test(pathname)
    || (pathname.startsWith('/plugins/') && /[?&]rev=[A-Za-z0-9]+/u.test(rawTarget));
  const bufferable = req.method === 'GET' || req.method === 'HEAD';
  const proxied = http.request({ host: LOOPBACK, port: up.port, path: forwardPath, method: req.method, headers, agent }, async (pres) => {
    if (pres.statusCode === 401 && bufferable) {
      const chunks = [];
      for await (const chunk of pres) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (body.length < 1024 * 64 && harnessAuth === null && await mintAuth(up)) {
        const retryHeaders = { ...headers, cookie: upstreamCookie(req.headers.cookie) };
        const retried = await send({ port: up.port, path: forwardPath, method: req.method, headers: retryHeaders }).catch(() => null);
        if (retried) {
          console.log(`[phone-proxy] ${retried.status} ${req.method} ${forwardPath} <- ${remote} 续签后重试`);
          const retryHeadersOut = mergedCookies(retried.headers, extraCookies);
          delete retryHeadersOut['transfer-encoding'];
          retryHeadersOut['content-length'] = String(retried.body.length);
          res.writeHead(retried.status ?? 502, retryHeadersOut);
          return res.end(retried.body);
        }
      }
      const outHeaders = mergedCookies(pres.headers, extraCookies);
      if (immutable && pres.statusCode === 200) outHeaders['cache-control'] = 'public, max-age=31536000, immutable';
      res.writeHead(pres.statusCode ?? 502, outHeaders);
      return res.end(body);
    }
    const streamHeaders = mergedCookies(pres.headers, extraCookies);
    if (immutable) {
      if (pres.statusCode === 200) {
        streamHeaders['cache-control'] = 'public, max-age=31536000, immutable';
        console.log(`[phone-proxy] ${pres.statusCode} GET ${pathname.slice(0, 40)} <- ${remote} static(cached)`);
      } else {
        console.log(`[phone-proxy] ${pres.statusCode} GET ${pathname.slice(0, 40)} <- ${remote} static`);
      }
    }
    res.writeHead(pres.statusCode ?? 502, streamHeaders);
    pres.pipe(res);
  });
  proxied.on('error', (error) => {
    active = null;
    if (!res.headersSent) deny(res, 502, `phone-proxy: 上游断开 ${error.message}\n`);
    else res.destroy();
  });
  req.pipe(proxied);
}

/** WebSocket / 其它 Upgrade 通道：改写握手头后双向透传。 */
async function handleUpgrade(req, socket, head) {
  socket.on('error', () => socket.destroy());
  const rawTarget = req.url ?? '/';
  const query = splitTarget(rawTarget).query;
  if (gate(keyFromQuery(query), req.headers.cookie) !== 'pass') {
    socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    return socket.destroy();
  }
  const target = stripKey(rawTarget);
  const up = await upstream();
  if (!up) return socket.destroy();
  await ensureAuth(up);
  const authority = `${LOOPBACK}:${up.port}`;
  const headers = rewriteHeaders(req.headers, authority);
  headers.cookie = upstreamCookie(req.headers.cookie);
  const lines = [`${req.method} ${target} HTTP/1.1`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
    else lines.push(`${key}: ${value}`);
  }
  lines.push('', '');

  const upstreamSocket = net.connect(up.port, LOOPBACK, () => {
    upstreamSocket.write(lines.join('\r\n'));
    if (head?.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });
  upstreamSocket.on('error', () => { active = null; socket.destroy(); });
  socket.on('close', () => upstreamSocket.destroy());
  upstreamSocket.on('close', () => socket.destroy());
}

// 同时监听 loopback 与所有本机 IPv4：loopback 供 cloudflared / 其它隧道工具回连，
// 局域网地址供同 Wi-Fi 的手机直连，Tailscale 的地址（100.x 网段）供手机在外面直连。
const lanHost = lanIPv4();
const listenHosts = [...new Set([LOOPBACK, ...localIPv4s(), ...(process.env.PHONE_HOST ? [process.env.PHONE_HOST] : [])])];
const servers = [];

(async () => {
  for (const bindHost of listenHosts) {
    const instance = http.createServer(handleRequest);
    instance.on('upgrade', handleUpgrade);
    await new Promise((resolve, reject) => {
      instance.once('error', reject);
      instance.listen(LISTEN_PORT, bindHost, () => {
        console.log(`[phone-proxy] 监听        http://${bindHost}:${LISTEN_PORT}`);
        resolve();
      });
    });
    servers.push(instance);
  }

  const up = await upstream();
  console.log('[phone-proxy] 日志        ', LOG_PATH);
  console.log('[phone-proxy] 上游实例    ', up ? `127.0.0.1:${up.port} (token ${up.token.slice(0, 6)}…，${refreshedCandidates().length} 个候选)` : '未发现（Harness 启动后自动接入）');
  console.log('[phone-proxy] 访问密钥    ', ACCESS_KEY ? `开启 (${ACCESS_KEY})` : '关闭（仅适合可信局域网）');
  console.log('[phone-proxy] 手机打开    ', `http://${lanHost}:${LISTEN_PORT}/`);
})().catch((error) => {
  console.error(`[phone-proxy] 启动失败：${error.message}`);
  process.exit(1);
});

process.on('SIGINT', () => { for (const instance of servers) instance.close(() => process.exit(0)); });
