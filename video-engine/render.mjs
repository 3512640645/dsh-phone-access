#!/usr/bin/env node
/**
 * 场景化渲染 CLI：场景 JSON → HTML → 逐帧渲染 → 编码 → 质检。
 *
 * 用法:
 *   node engine/render.mjs --spec engine/scenes/dsh-phone-access.json --aspect 16:9
 *   node engine/render.mjs --spec ... --aspect 9:16 --out out/vertical.mp4
 *   node engine/render.mjs --spec ... --html-only        （只出 HTML，便于调试画面）
 *
 * 设计：画与声同源。场景 JSON 是唯一时间轴来源；音频由 make-audio3.py 按同一批
 * 时间点合成，两边都改自同一份分镜，避免"画面改了音频没跟上"。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildHtml } from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const SPEC = flag('spec', 'D:\\dsh-video\\engine\\scenes\\dsh-phone-access.json');
const ASPECT = flag('aspect', '16:9');
const FPS = Number(flag('fps', 30));
const ROOT = 'D:\\dsh-video';
const BUILD = path.join(ROOT, 'engine', '.build');
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const name = path.basename(SPEC, '.json');
const tag = ASPECT.replace(':', 'x');

fs.mkdirSync(BUILD, { recursive: true });
const htmlPath = path.join(BUILD, `${name}-${tag}.html`);
fs.writeFileSync(htmlPath, buildHtml(spec, ASPECT), 'utf8');
console.log(`场景: ${spec.title}  ${spec.duration}s  ${ASPECT}  ${spec.sections.length} 段`);
console.log(`HTML: ${htmlPath}`);

if (has('html-only')) process.exit(0);

const out = flag('out', path.join(ROOT, 'out', `${name}-${tag}.mp4`));
const frames = flag('frames', path.join(ROOT, 'frames', `${name}-${tag}`));
const [W, H] = ASPECT === '9:16' ? [1080, 1920] : [1920, 1080];

const node = process.env.DSH_NODE ?? process.execPath;
const args = [
  path.join(ROOT, 'tools', 'render-video.mjs'),
  '--fps', String(FPS),
  '--w', String(W), '--h', String(H),
  '--page', `file:///${htmlPath.replace(/\\/g, '/')}`,
  '--frames', frames,
  '--out', out,
];
console.log(`渲染: ${W}x${H} @${FPS}fps → ${out}`);
// node 路径可能是 .cmd 批处理（DSH 自带的 node.cmd）：
// Node 20+ 的 spawn 不能直接执行 .cmd（EINVAL），必须用 cmd /c 包一层。
// 端口按画幅派生：多画幅并行渲染时各自一个无头实例 + 独立配置目录，互不抢占。
const PORT = Number(flag('port', 9555)) + (ASPECT === '9:16' ? 2 : ASPECT === '1:1' ? 4 : 0);
const isCmd = /\.(cmd|bat)$/i.test(node);
const child = isCmd
  ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', node, ...args], { stdio: 'inherit', windowsHide: true, env: { ...process.env, CDP_PORT: String(PORT) } })
  : spawn(node, args, { stdio: 'inherit', windowsHide: true, env: { ...process.env, CDP_PORT: String(PORT) } });
child.on('exit', (code) => {
  if (code !== 0) { console.error(`渲染失败，退出码 ${code}`); process.exit(code ?? 1); }
  console.log(`完成: ${out}  (${(fs.statSync(out).size / 1048576).toFixed(2)} MB)`);
  process.exit(0);
});
