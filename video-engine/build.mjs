#!/usr/bin/env node
/**
 * 一条命令出片：场景 JSON → 配乐 → 画面 → 混流 → 字幕 → 质检。
 *
 *   node engine/build.mjs --spec engine/scenes/dsh-phone-access.json --aspect 16:9
 *   node engine/build.mjs --spec ... --aspect 9:16 --aspect 16:9    （多画幅）
 *
 * 之所以要有这个入口：之前每一步都要手动串（改完画面容易忘了重生成音频），
 * 而"画与声同源"只有在**每次都从同一份 spec 一起生成**时才成立。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const all = (n) => argv.reduce((acc, a, i) => (a === `--${n}` ? acc.concat(argv[i + 1]) : acc), []);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };

const ROOT = 'D:\\dsh-video';
const SPEC = flag('spec', path.join(ROOT, 'engine', 'scenes', 'dsh-phone-access.json'));
const ASPECTS = all('aspect').length ? all('aspect') : ['16:9'];
const FPS = flag('fps', '30');
const BURN_SUBS = argv.includes('--burn-subs');   // 额外产出烧录字幕版
const NODE = process.env.DSH_NODE ?? process.execPath;
const PY = flag('python', 'D:\\ds\\DSH Desktop\\.build\\office-runtime\\primary-runtime\\dependencies\\python\\python.exe');
const FFMPEG = flag('ffmpeg', path.join(ROOT, 'tools', 'ffmpeg', 'ffmpeg.exe'));
const FFmpegOK = fs.existsSync(FFMPEG);

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const name = path.basename(SPEC, '.json');
const outDir = path.join(ROOT, 'out');
fs.mkdirSync(outDir, { recursive: true });
const isCmd = /\.(cmd|bat)$/i.test(NODE);

function step(title, cmd, args) {
  console.log(`\n── ${title} ──`);
  const r = isCmd
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/c', cmd, ...args], { stdio: 'inherit', windowsHide: true })
    : spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true });
  return (r.status ?? 1) === 0;
}

/** 并发版：多画幅的帧渲染互不依赖（各自一个无头浏览器实例 + 独立帧目录），可以并行。 */
function stepAsync(title, cmd, args) {
  console.log(`── ${title}（并行）──`);
  return new Promise((resolve) => {
    const child = isCmd
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/c', cmd, ...args], { stdio: 'inherit', windowsHide: true })
      : spawn(cmd, args, { stdio: 'inherit', windowsHide: true });
    child.on('exit', (code) => resolve((code ?? 1) === 0));
    child.on('error', () => resolve(false));
  });
}

const t0 = Date.now();

// 1) 配乐（读 spec.audio）
const wav = path.join(outDir, `${name}-audio.wav`);
if (!step('配乐（spec.audio → WAV + 质检）', PY, [path.join(ROOT, 'tools', 'make-audio.py'), '--spec', SPEC, '--out', wav])) {
  console.error('配乐生成失败'); process.exit(1);
}

// 2) 字幕轨（读 spec 的文字元素）
step('字幕轨（spec → SRT/VTT）', NODE, [path.join(ROOT, 'engine', 'subs.mjs'), '--spec', SPEC, '--out', path.join(outDir, name)]);

// 3) 所有画幅的**帧渲染并行**（互不依赖），渲染完再逐个混流+质检
const renderJobs = ASPECTS.map((aspect) => {
  const tag = aspect.replace(':', 'x');
  const [W, H] = aspect === '9:16' ? [1080, 1920] : [1920, 1080];
  const silent = path.join(outDir, `${name}-${tag}-silent.mp4`);
  return stepAsync(`渲染 ${aspect}（${W}x${H}@${FPS}）`, NODE,
    [path.join(ROOT, 'engine', 'render.mjs'), '--spec', SPEC, '--aspect', aspect,
     '--fps', FPS, '--out', silent, '--frames', path.join(ROOT, 'frames', `${name}-${tag}`)]);
});
const renderOk = await Promise.all(renderJobs);

const finals = [];
for (const [i, aspect] of ASPECTS.entries()) {
  const tag = aspect.replace(':', 'x');
  const [W, H] = aspect === '9:16' ? [1080, 1920] : [1920, 1080];
  const silent = path.join(outDir, `${name}-${tag}-silent.mp4`);
  const final = path.join(outDir, `${name}-${tag}.mp4`);
  // 并行渲染失败是**静默**的（可能退出码正常但没产出，也可能沿用上一轮的旧文件）——
  // 所以这里既查文件存在、又查帧目录帧数、还要确认文件是本次新写的。
  const framesDir = path.join(ROOT, 'frames', `${name}-${tag}`);
  const frameCount = fs.existsSync(framesDir) ? fs.readdirSync(framesDir).filter((f) => f.endsWith('.png') || f.endsWith('.jpg')).length : 0;
  const expectFrames = Math.round(spec.duration * Number(FPS));
  const fresh = fs.existsSync(silent) && fs.statSync(silent).mtimeMs >= t0;
  if (!renderOk[i] || !fresh || frameCount < expectFrames * 0.98) {
    console.error(`  ✘ ${aspect} 校验未通过：exit=${renderOk[i]} 新文件=${fresh} 帧数=${frameCount}/${expectFrames}`);
    continue;
  }
  console.log(`  ✔ ${aspect} 渲染校验通过：${frameCount} 帧，产物 ${(fs.statSync(silent).size / 1048576).toFixed(2)} MB`);

  if (FFmpegOK) {
    step(`混流 ${aspect}`, FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', silent, '-i', wav, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '224k', '-ar', '48000',
      '-shortest', '-movflags', '+faststart', final]);

    if (BURN_SUBS) {
      // 烧录字幕：字体走系统雅黑，白字黑边，放在最底部（不与画面内 76% 处的说明文字打架）。
      // 注意 libass 的 FontSize 是按 PlayRes 比例算的，不显式给 PlayRes 会变得巨大 ——
      // 第一版就是漏了 PlayResX/Y，字幕撑到半屏高还压住了画面内的说明。
      const srt = path.join(outDir, `${name}.srt`).replace(/\\/g, '/').replace(':', '\\:');
      const vertical = aspect === '9:16';
      const style = `PlayResX=${W},PlayResY=${H},FontName=Microsoft YaHei,FontSize=${vertical ? 40 : 32},`
        + `PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,`
        + `Alignment=2,MarginV=${vertical ? 40 : 22}`;
      const subbed = path.join(outDir, `${name}-${tag}-subbed.mp4`);
      step(`烧录字幕 ${aspect}`, FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
        '-i', final, '-vf', `subtitles='${srt}':force_style='${style}'`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy', '-movflags', '+faststart', subbed]);
    }
  }

  step(`质检 ${aspect}`, NODE,
    [path.join(ROOT, 'engine', 'qa.mjs'), '--video', final,
     '--expect-duration', String(spec.duration), '--expect-size', `${W}x${H}`]);
  finals.push(final);
}

console.log(`\n═══ 全部完成，用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟 ═══`);
console.log(`场景: ${SPEC}`);
console.log(`配乐: ${wav}`);
console.log(`字幕: ${path.join(outDir, name)}.srt / .vtt`);
for (const f of finals) {
  const mb = fs.existsSync(f) ? (fs.statSync(f).size / 1048576).toFixed(2) : '?';
  console.log(`成片: ${f}  (${mb} MB)`);
}
