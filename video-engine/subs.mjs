#!/usr/bin/env node
/**
 * 字幕轨道导出：从同一份场景 JSON 里抽出文字类元素的时间点，生成 SRT / VTT。
 *
 * 为什么从 spec 抽而不是另外维护一份字幕文件：
 *   字幕和画面本来就该是同一份数据。手写 SRT 的结果一定是"画面改了字幕没跟上"。
 *
 * 抽取规则（只取"人对人说的话"，不取图示里的技术标签）：
 *   caption 的每条 → 一条字幕
 *   bullets 的每条 → 一条字幕
 *   title 的副标题 → 一条字幕
 *   cards 的标题+正文 → 合并成一条（去掉内联标签）
 *   outro 的说明行 → 每条一条
 *
 * 用法: node engine/subs.mjs --spec scenes/x.json [--out out/x] [--lang zh]
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const SPEC = flag('spec', 'D:\\dsh-video\\engine\\scenes\\dsh-phone-access.json');
const OUT = flag('out', 'D:\\dsh-video\\out\\dsh-phone-access');
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

const stripTags = (s) => String(s ?? '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();

const cues = [];
for (const section of spec.sections) {
  const secEnd = section.end;
  for (const layer of section.layers) {
    const p = layer.props ?? {};
    const push = (text, inT, outT) => {
      const clean = stripTags(text);
      if (clean) cues.push({ start: inT, end: outT ?? secEnd, text: clean, section: section.id });
    };

    if (layer.type === 'caption') {
      const items = p.items ?? [];
      items.forEach((it, i) => push(it.text, it.in, it.out ?? items[i + 1]?.in ?? secEnd));
    } else if (layer.type === 'bullets') {
      const items = p.items ?? [];
      items.forEach((it, i) => push(it.text, it.in, it.out ?? items[i + 1]?.in ?? secEnd));
    } else if (layer.type === 'title') {
      push(`${p.title ?? ''} ${p.accent ?? ''}`, 1.0, secEnd);
      push(p.subtitle, 1.4, secEnd);
    } else if (layer.type === 'cards') {
      for (const it of p.items ?? []) push(`${it.label ?? ''} ${it.title ?? ''}：${it.body ?? ''}`, it.in, it.out ?? secEnd);
    } else if (layer.type === 'outro') {
      for (const l of p.lines ?? []) push(l.text, l.in, l.out ?? secEnd);
      if (p.repo?.foot) push(p.repo.foot, p.repo.footIn ?? p.repo.in, secEnd);
    }
  }
}

cues.sort((a, b) => a.start - b.start);
// 去重相邻重复文本，并把重叠截断（字幕不该互相盖）
const cleaned = [];
for (const c of cues) {
  if (c.end - c.start < 0.35) continue;
  const prev = cleaned[cleaned.length - 1];
  if (prev && prev.text === c.text) { prev.end = Math.max(prev.end, c.end); continue; }
  if (prev && prev.end > c.start) prev.end = Math.max(prev.start + 0.3, c.start - 0.05);
  cleaned.push({ ...c });
}

const fmt = (t, sep) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const f = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s}${sep}${f}`;
};

const srt = cleaned.map((c, i) => `${i + 1}\n${fmt(c.start, ',')} --> ${fmt(c.end, ',')}\n${c.text}\n`).join('\n');
const vtt = `WEBVTT\n\n` + cleaned.map((c, i) =>
  `cue-${i + 1}\n${fmt(c.start, '.')} --> ${fmt(c.end, '.')}\n${c.text}\n`).join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(`${OUT}.srt`, srt, 'utf8');
fs.writeFileSync(`${OUT}.vtt`, vtt, 'utf8');

console.log(`字幕轨: ${cleaned.length} 条 → ${OUT}.srt / .vtt`);
const total = cleaned.reduce((s, c) => s + (c.end - c.start), 0);
const longest = cleaned.reduce((a, c) => Math.max(a, c.text.length), 0);
console.log(`  覆盖时长 ${total.toFixed(1)}s / ${spec.duration}s（${(total / spec.duration * 100).toFixed(0)}%）  最长一条 ${longest} 字`);
for (const c of cleaned.slice(0, 6)) console.log(`  ${fmt(c.start, ',')}  ${c.text.slice(0, 42)}`);
if (cleaned.length > 6) console.log(`  … 其余 ${cleaned.length - 6} 条见文件`);
