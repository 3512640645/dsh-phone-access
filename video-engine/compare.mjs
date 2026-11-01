#!/usr/bin/env node
/**
 * 对比样片：把两个版本并排放在一个画面里，便于一眼看清差别。
 *
 *   node engine/compare.mjs --a out/old.mp4 --b out/new.mp4 \
 *        --label-a "手写版（v2 配乐）" --label-b "引擎版（v3 配乐）" --out out/compare.mp4
 *
 * 用途有两类：
 *   1. 版本对比：改版前后摆在一起（本片用于"手写动画 → 声明式引擎"的对比）
 *   2. 画幅对比：16:9 与 9:16 并排，检查竖屏适配有没有裁切
 *
 * 声音取 --audio 指定的一侧（默认 b），另一侧静音 —— 不能把两轨混在一起听。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const FFMPEG = flag('ffmpeg', 'D:\\dsh-video\\tools\\ffmpeg\\ffmpeg.exe');
const A = flag('a', '');
const B = flag('b', '');
const LA = flag('label-a', 'A');
const LB = flag('label-b', 'B');
// 滤镜图里 `:` 是选项分隔符、`,` 是链条分隔符、`'` 是引号 —— 标签里出现这些字符
// （例如"16:9 横屏"）会让整条 filterchain 解析失败，必须先转义。
const escLabel = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/,/g, '\\,');
const LA_ESC = escLabel(LA);
const LB_ESC = escLabel(LB);
const OUT = flag('out', 'D:\\dsh-video\\out\\compare.mp4');
const AUDIO = flag('audio', 'b');          // 'a' | 'b' | 'none'
const W = Number(flag('width', 960));

for (const [name, p] of [['--a', A], ['--b', B]]) {
  if (!p || !fs.existsSync(p)) { console.error(`缺少 ${name}（文件不存在）: ${p}`); process.exit(2); }
}

// 每侧缩放到 W 宽、保持 16:9 画布（竖屏素材留黑边，避免被拉伸变形）
const h = Math.round(W * 9 / 16);
const filter = [
  `[0:v]scale=${W}:${h}:force_original_aspect_ratio=decrease,pad=${W}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0a0a0c,` +
  `drawtext=text='${LA_ESC}':x=18:y=14:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:box=1:boxborderw=8:fontfile='C\\:/Windows/Fonts/msyh.ttc'[a]`,
  `[1:v]scale=${W}:${h}:force_original_aspect_ratio=decrease,pad=${W}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0a0a0c,` +
  `drawtext=text='${LB_ESC}':x=18:y=14:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.65:box=1:boxborderw=8:fontfile='C\\:/Windows/Fonts/msyh.ttc'[b]`,
  `[a][b]hstack=inputs=2[v]`,
].join(';');
const audioMap = AUDIO === 'a' ? ['-map', '0:a?'] : AUDIO === 'b' ? ['-map', '1:a?'] : ['-an'];

const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', A, '-i', B,
  '-filter_complex', filter, '-map', '[v]', ...audioMap,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', OUT];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const r = spawnSync(FFMPEG, args, { encoding: 'utf8', windowsHide: true });
if ((r.status ?? 1) !== 0) { console.error((r.stderr || '').slice(-1200)); process.exit(1); }

const size = (fs.statSync(OUT).size / 1048576).toFixed(2);
console.log(`对比样片: ${OUT}  (${W * 2}x${h}, ${size} MB, 声音取 ${AUDIO} 侧)`);
console.log(`  左: ${LA}  ←  ${path.basename(A)}`);
console.log(`  右: ${LB}  ←  ${path.basename(B)}`);
