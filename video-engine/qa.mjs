#!/usr/bin/env node
/**
 * 视频质检：把"成片到底行不行"变成可读的数字与一张接触表。
 *
 * 检查项：
 *   1. 容器/流信息（时长、分辨率、帧率、编码）是否符合声明
 *   2. 黑帧检测（黑场/空洞段落）—— 渲染引擎最典型的失败是"某段什么都没画"
 *   3. 接触表（每 5 秒抽 1 帧拼图）—— 一眼看完整体节奏与画面
 *   4. 响度（有音轨时）—— 复用 EBU R128
 *
 * 用法: node engine/qa.mjs --video out/xxx.mp4 [--expect-duration 45] [--expect-size 1920x1080]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const VIDEO = flag('video', '');
if (!VIDEO || !fs.existsSync(VIDEO)) { console.error('缺少 --video <存在的文件>'); process.exit(2); }
const EXPECT_DUR = flag('expect-duration', '');
const EXPECT_SIZE = flag('expect-size', '');
const FFMPEG = flag('ffmpeg', 'D:\\dsh-video\\tools\\ffmpeg\\ffmpeg.exe');
const FFPROBE = flag('ffprobe', 'D:\\dsh-video\\tools\\ffmpeg\\ffprobe.exe');

// 必须用 spawnSync：execFileSync 成功时不返回 stderr，而 ffmpeg 的分析结果全在 stderr，
// 会导致"响度拿到 null"、"黑帧检测在空输入上假通过"这类静默错误。
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  return { out: r.stdout ?? '', err: r.stderr ?? '', status: r.status ?? 0 };
};
const checks = [];
const add = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}  (${detail})`); };

console.log(`\n视频质检: ${path.basename(VIDEO)}`);

// ── 1. 流信息 ──
const probe = JSON.parse(run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', VIDEO]).out || '{}');
const v = (probe.streams ?? []).find((s) => s.codec_type === 'video') ?? {};
const a = (probe.streams ?? []).find((s) => s.codec_type === 'audio');
const dur = Number(probe.format?.duration ?? 0);
const fps = (() => { const [n, d] = String(v.r_frame_rate ?? '0/1').split('/').map(Number); return d ? n / d : 0; })();
console.log(`  容器: ${(Number(probe.format?.size ?? 0) / 1048576).toFixed(2)}MB  ${dur}s  ${v.width}x${v.height} @${fps.toFixed(2)}fps  ${v.codec_name}${a ? ` + ${a.codec_name} ${a.sample_rate}Hz/${a.channels}ch` : ' (无音轨)'}`);

add('分辨率符合预期', !EXPECT_SIZE || `${v.width}x${v.height}` === EXPECT_SIZE, `${v.width}x${v.height}${EXPECT_SIZE ? ` / 期望 ${EXPECT_SIZE}` : ''}`);
add('时长符合预期', !EXPECT_DUR || Math.abs(dur - Number(EXPECT_DUR)) < 0.3, `${dur}s${EXPECT_DUR ? ` / 期望 ${EXPECT_DUR}s` : ''}`);
add('帧率 ≥24fps（不要有掉帧的顿感）', fps >= 24, `${fps.toFixed(2)}fps`);

// ── 2. 黑帧检测 ──
const bd = run(FFMPEG, ['-hide_banner', '-i', VIDEO, '-vf', 'blackdetect=d=0.5:pix_th=0.06', '-an', '-f', 'null', '-']);
const blackLines = ((bd.err || '') + (bd.out || '')).split('\n').filter((l) => l.includes('black_start'));
const blackSpans = blackLines.map((l) => {
  const s = Number(/black_start:([\d.]+)/.exec(l)?.[1] ?? 0);
  const e = Number(/black_end:([\d.]+)/.exec(l)?.[1] ?? 0);
  return { start: s, end: e, len: +(e - s).toFixed(2) };
});
add('无 ≥0.5s 的纯黑段（引擎漏画会表现为黑场）', blackSpans.length === 0,
    blackSpans.length ? blackSpans.map((b) => `${b.start}~${b.end}s`).join(', ') : '未检出');

// ── 3. 接触表 ──
const cols = 4, rows = 3;
const sheet = VIDEO.replace(/\.mp4$/i, '') + '-contact.png';
const step = Math.max(1, Math.round(dur / (cols * rows)));
run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', VIDEO,
  '-vf', `fps=1/${step},scale=480:-1,tile=${cols}x${rows}`, '-frames:v', '1', sheet]);
const sheetOk = fs.existsSync(sheet) && fs.statSync(sheet).size > 10000;
add('接触表已生成（用于人眼复核节奏）', sheetOk, sheetOk ? `${path.basename(sheet)} ${(fs.statSync(sheet).size / 1024).toFixed(0)}KB` : '生成失败');

// ── 4. 响度 ──
let lufs = null, tp = null;
if (a) {
  const r = run(FFMPEG, ['-hide_banner', '-nostats', '-i', VIDEO, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-']);
  const txt = (r.err || '') + (r.out || '');
  for (const line of txt.split('\n')) {
    const l = line.trim();
    if (l.startsWith('I:') && lufs === null) { try { lufs = parseFloat(l.split(/\s+/)[1]); } catch {} }
    if (l.startsWith('Peak:') && tp === null) { try { tp = parseFloat(l.split(/\s+/)[1]); } catch {} }
  }
  add('混音响度在 -16~-12 LUFS', lufs !== null && lufs >= -16 && lufs <= -12, `I=${lufs} LUFS`);
}

// ── 落盘 ──
const report = {
  video: VIDEO, size_mb: +(Number(probe.format?.size ?? 0) / 1048576).toFixed(2),
  duration: dur, width: v.width, height: v.height, fps: +fps.toFixed(3),
  has_audio: Boolean(a), lufs, true_peak: tp,
  black_spans: blackSpans, contact_sheet: sheet, checks,
};
const jsonPath = VIDEO.replace(/\.mp4$/i, '') + '-qa.json';
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
const passed = checks.filter((c) => c.ok).length;
console.log(`\n  通过 ${passed}/${checks.length} 项 · 报告 ${path.basename(jsonPath)}`);
process.exit(passed === checks.length ? 0 : 1);
