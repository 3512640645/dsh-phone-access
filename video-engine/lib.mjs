/**
 * 场景化渲染引擎 · 组件库与文档生成
 *
 * 核心思路：不再为每个元素手写 seek(t) 的数学，而是
 *   场景 JSON（声明式） → 组件库渲染成带 data-* 标记的 HTML → 通用运行时按 t 套用样式
 *
 * 运行时只认这几个 data 属性，所以新增场景/调整节奏都不用改代码：
 *   data-in / data-out    进入/退出时刻（秒）
 *   data-fade             渐变时长（秒，默认 .5 / .4）
 *   data-dy              入场位移（px，默认 18，负值向上）
 *   data-scale           入场缩放起点（默认 1）
 *   data-delay            同组元素依次延迟（由组件内部展开）
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 组件：分镜标题（左上角 HUD 的按钮式段落名 + 进度条） */
function hud({ sections }) {
  const marks = sections.map((s) => `[${s.start},"${esc(s.name)}"]`).join(',');
  return {
    html: `
  <div id="hud" style="position:absolute;left:var(--pad);top:var(--padTop);display:flex;align-items:center;gap:16px">
    <div class="bar" style="width:46px;height:3px;border-radius:2px;background:var(--accent)"></div>
    <div id="hudName" style="font-size:var(--fs-sm);letter-spacing:.22em;color:var(--dim)">开始</div>
  </div>
  <div style="position:absolute;left:var(--pad);right:var(--pad);bottom:var(--padBottom);height:2px;background:#ffffff10">
    <div id="prog" style="position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,var(--accent),#f0a385)"></div>
  </div>`,
    script: `const marks=[${marks}]; window.__hudName=document.getElementById('hudName'); window.__prog=document.getElementById('prog'); window.__marks=marks;`,
  };
}

/** 组件：标题页；竖屏时字号收小、整体上移，避免标题换行后与副标题叠在一起 */
function title({ title, accent, subtitle, tags = [] }, ctx = {}) {
  const vertical = ctx.aspect === '9:16';
  return {
    html: `
  <div style="position:absolute;inset:0">
    <div id="t-mark" class="card" data-in="0.15" data-out="99" data-scale=".86" style="left:50%;top:${vertical ? 22 : 30}%;transform-origin:center;margin-left:-84px;width:168px;height:168px;border-radius:42px;display:flex;align-items:center;justify-content:center">
      <svg width="92" height="92" viewBox="0 0 92 92" fill="none">
        <rect x="10" y="14" width="52" height="38" rx="6" stroke="var(--accent)" stroke-width="4"/>
        <rect x="44" y="36" width="34" height="46" rx="8" stroke="var(--fg)" stroke-width="4"/>
        <path d="M56 70h10" stroke="var(--ok)" stroke-width="4" stroke-linecap="round"/>
      </svg>
    </div>
    <div data-in="0.5" data-out="99" class="h1" style="position:absolute;left:0;right:0;top:${vertical ? 42 : 47}%;text-align:center">
      ${esc(title)} <span style="color:var(--accent)">${esc(accent)}</span>
    </div>
    <div data-in="0.9" data-out="99" style="position:absolute;left:${vertical ? 6 : 0}%;right:${vertical ? 6 : 0}%;top:${vertical ? 60 : 59}%;text-align:center;font-size:var(--fs-sm);color:var(--dim);line-height:1.6">${subtitle}</div>
    <div data-in="1.4" data-out="99" style="position:absolute;left:0;right:0;top:${vertical ? 68 : 66}%;text-align:center">
      ${tags.map((t) => `<span class="tag mono" style="margin:0 4px">${esc(t)}</span>`).join('')}
    </div>
  </div>`,
  };
}

/** 组件：卡片行（可带状态标签）；竖屏时自动改为纵向堆叠 */
function cards({ items, columns = 3 }, ctx = {}) {
  const vertical = ctx.aspect === '9:16';
  const gap = 40;
  // 竖屏：一行一张，整体纵向排布；横屏：按列横排
  const layout = vertical
    ? items.map((it, i) => ({ left: 8, top: 22 + i * (it.height ?? 22) * 1.12, width: 84 }))
    : (() => {
      const total = columns * 27 + (columns - 1) * 3.4;
      const left0 = (100 - total) / 2;
      return items.map((it, i) => ({ left: left0 + i * (27 + 3.4), top: it.top ?? 28, width: 27 }));
    })();
  return {
    html: items.map((it, i) => {
      const L = layout[i];
      return `
    <div class="card" data-in="${it.in}" data-out="${it.out ?? 99}" data-dy="44" data-scale=".97"
         style="left:${L.left}%;top:${L.top}%;width:${L.width}%;height:${vertical ? 20 : (it.height ?? 39)}%;padding:calc(var(--fs-md)*1.3)">
      <div class="lbl" style="color:${it.lblColor ?? 'var(--bad)'}">${esc(it.label)}</div>
      <div style="margin-top:calc(var(--fs-md)*.5);font-size:var(--fs-lg);font-weight:600">${esc(it.title)}</div>
      <div style="margin-top:calc(var(--fs-md)*.8);font-size:var(--fs-sm);color:var(--dim);line-height:1.7">${it.body}</div>
      ${it.foot ? `<div class="mono" style="margin-top:auto;font-size:var(--fs-sm);color:var(--ok)">${esc(it.foot)}</div>` : ''}
    </div>`;
    }).join(''),
  };
}

/** 组件：链路图（A → B，带流动光点与结果徽标）；竖屏时改为纵向链路 */
function pipeline({ from, to, mid = null, badges = [], packets = [], code = null }, ctx = {}) {
  const vertical = ctx.aspect === '9:16';
  const cells = mid ? [from, mid, to] : [from, to];
  // 横屏：三列横排；竖屏：三行纵排（连接线变垂直，光点改沿 Y 轴走）
  const geo = vertical
    ? cells.map((c, i) => ({ left: 8, top: 14 + i * 22, width: 84, height: 18 }))
    : (() => {
      const w = mid ? 26 : 34;
      const lefts = mid ? [8, 37, 70] : [10, 56];
      return cells.map((c, i) => ({ left: lefts[i], top: c.top ?? 34, width: w, height: c.height ?? 30 }));
    })();
  const barPos = vertical
    ? `left:50%;top:${14 + cells.length * 22}%;height:2px`
    : `left:${(geo[0].left + geo[0].width)}%;right:${100 - geo[geo.length - 1].left}%;top:50%;height:2px`;
  return {
    html: `
  ${cells.map((c, i) => {
    const g = geo[i];
    return `
    <div class="card" data-in="${c.in}" data-out="${c.out ?? 99}" data-dy="40"
         style="left:${g.left}%;top:${g.top}%;width:${g.width}%;height:${g.height}%;
                ${c.accent ? 'border-color:#d9775744;box-shadow:0 26px 70px -26px #d9775733' : ''}">
      <div class="lbl" style="padding:calc(var(--fs-md)*1.1) calc(var(--fs-md)*1.1) 0;${c.accent ? 'color:var(--accent)' : ''}">${esc(c.label)}</div>
      <div style="padding:calc(var(--fs-md)*.4) calc(var(--fs-md)*1.1) 0;font-size:var(--fs-lg);font-weight:600">${esc(c.title)}</div>
      <div class="mono" style="padding:calc(var(--fs-md)*.5) calc(var(--fs-md)*1.1) 0;font-size:var(--fs-sm);color:var(--dim);line-height:1.8">
        ${(c.lines ?? []).map((l) => `<div data-in="${l.in}" data-out="99">${esc(l.text)}</div>`).join('')}
      </div>
    </div>`;
  }).join('')}
  ${vertical
    ? `<div data-in="${packets[0]?.in ?? 99}" data-out="99" style="position:absolute;left:50%;top:${14 + 18}%;width:2px;height:${(cells.length - 1) * 22 - 18}%;background:linear-gradient(180deg,#ffffff10,#ffffff34,#ffffff10)"></div>`
    : `<div data-in="${packets[0]?.in ?? 99}" data-out="99" style="position:absolute;${barPos};background:linear-gradient(90deg,#ffffff10,#ffffff34,#ffffff10)"></div>`}
  ${packets.map((p) => `
    <div class="dot" data-track="packet" ${vertical ? 'data-axis="y"' : ''} data-from="${p.from}" data-to="${p.to}" data-in="${p.in}" data-out="${p.out}"
         style="${vertical ? `left:calc(50% - 9px);top:${14 + 18}%;` : `left:${geo[0].left + geo[0].width}%;top:calc(50% - 9px);`}width:18px;height:18px;border-radius:50%;background:${p.color ?? 'var(--info)'};box-shadow:0 0 24px ${p.color ?? 'var(--info)'}cc"></div>`).join('')}
  ${badges.map((b) => `
    <div data-in="${b.in}" data-out="${b.out ?? 99}" data-scale=".9" style="position:absolute;left:${vertical ? 20 : b.left}%;top:${vertical ? (b.vtop ?? 6) : b.top}%;text-align:center">
      <span class="tag ${b.kind ?? ''} mono" style="font-size:var(--fs-md);padding:.5em .9em">${esc(b.text)}</span>
    </div>`).join('')}
  ${code ? `
    <div class="card mono" data-in="${code.in}" data-out="${code.out ?? 99}" data-dy="14"
         style="left:${vertical ? 8 : (code.left ?? 30)}%;top:${vertical ? 78 : (code.top ?? 62)}%;width:${vertical ? 84 : (code.width ?? 40)}%;height:${code.height ?? 9}%;
                display:flex;align-items:center;justify-content:center;font-size:var(--fs-sm);color:var(--dim)">${code.text}</div>` : ''}`,
  };
}

/** 组件：条目列表（逐条出现）；竖屏时整体下移到手机下方 */
function bullets({ items, left = 62, top = 30, gap = 7.6 }, ctx = {}) {
  const vertical = ctx.aspect === '9:16';
  const L = vertical ? 8 : left;
  const T = vertical ? 66 : top;
  const G = vertical ? 4.6 : gap;
  return {
    html: items.map((b, i) => `
    <div data-in="${b.in}" data-out="${b.out ?? 99}" data-dy="0"
         style="position:absolute;left:${L}%;right:${vertical ? 8 : 0}%;top:${T + i * G}%;font-size:${vertical ? 'calc(var(--fs-sm)*1.05)' : 'var(--fs-md)'};color:var(--fg)">${b.text}</div>`).join(''),
  };
}

/** 组件：手机模型（可选抽屉展开/收起）；竖屏时居中放大、条目列表让到下方 */
function phone({ left = 10, top = 20, width = 19, height = 78, drawer = null, rows = [] }, ctx = {}) {
  const vertical = ctx.aspect === '9:16';
  const L = vertical ? 24 : left;
  const T = vertical ? 13 : top;
  const W = vertical ? 52 : width;
  const H = vertical ? 50 : height;
  return {
    html: `
  <div class="card" data-in="${drawer?.frameIn ?? 0}" data-out="99" data-dy="30" data-scale=".96"
       style="left:${L}%;top:${T}%;width:${W}%;height:${H}%;border-radius:34px;padding:14px;overflow:hidden">
    <div style="position:absolute;inset:14px;border-radius:24px;background:#0e0e11;overflow:hidden">
      <div style="position:absolute;left:0;top:0;bottom:0;width:44px;background:#141418;border-right:1px solid #ffffff10"></div>
      <div style="position:absolute;left:44px;top:0;right:0;bottom:0;padding:16px">
        <div style="width:120px;height:12px;border-radius:6px;background:#ffffff22"></div>
        <div style="margin-top:22px;width:70%;height:22px;border-radius:8px;background:#ffffff30"></div>
        <div style="margin-top:14px;width:50%;height:12px;border-radius:6px;background:#ffffff18"></div>
        <div style="margin-top:34px;height:64px;border-radius:14px;border:1px dashed #ffffff26"></div>
      </div>
      ${drawer ? `
      <div id="phone-shade" style="position:absolute;left:44px;top:0;right:0;bottom:0;background:#000000aa"></div>
      <div data-track="drawer" data-open="${drawer.open}" data-close="${drawer.close ?? 99}" data-width="268"
           style="position:absolute;left:44px;top:0;bottom:0;width:268px;background:#1b1b21;border-right:1px solid #ffffff1a;padding:18px 16px;box-shadow:34px 0 60px -20px #000d">
        <div style="font-size:15px;font-weight:700;letter-spacing:.06em;white-space:nowrap">deepseek <span style="color:var(--accent)">HARNESS</span></div>
        <div style="margin-top:16px;height:34px;border-radius:10px;background:#ffffff12;display:flex;align-items:center;justify-content:center;font-size:13px">＋ 新会话</div>
        <div style="margin-top:16px;font-size:13.5px;color:#c9c9d2;line-height:2.1">工作台　插件<br>插件市场　自动化任务<br>上下文洞察　更多</div>
        <div style="margin-top:14px;font-size:12px;color:var(--dim)">工作区</div>
        ${rows.map((r, i) => `<div data-row="${i}" style="margin-top:${i ? 6 : 8}px;height:32px;border-radius:9px;background:${i === 0 ? '#ffffff14' : 'transparent'};display:flex;align-items:center;padding:0 10px;font-size:13px;white-space:nowrap;color:${i === 0 ? 'var(--fg)' : 'var(--dim)'}">${esc(r)}</div>`).join('')}
      </div>` : ''}
    </div>
  </div>`,
  };
}

/** 组件：收尾（盾牌 + 仓库卡片）；竖屏时整体纵排 */
function outro({ lines = [], repo = {} }, ctx = {}) {
  const vertical = ctx.aspect === '9:16';
  return {
    html: `
  <div data-in="${repo.in ?? 0}" data-out="99" data-scale=".9" style="position:absolute;left:${vertical ? 38 : 14}%;top:${vertical ? 12 : 33}%;width:${vertical ? 24 : 16}%;height:${vertical ? 17 : 34}%;display:flex;align-items:center;justify-content:center">
    <svg width="100%" height="100%" viewBox="0 0 100 100" fill="none">
      <path d="M50 8l32 12v30c0 22-14 34-32 42C32 84 18 72 18 50V20L50 8z" stroke="var(--ok)" stroke-width="3.4"/>
      <path d="M36 52l10 10 20-22" stroke="var(--ok)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
  <div style="position:absolute;left:${vertical ? 0 : 33}%;right:${vertical ? 0 : 'auto'};${vertical ? 'text-align:center;' : ''}top:${vertical ? 32 : 36}%">
    ${lines.map((l, i) => `
      <div data-in="${l.in}" data-out="99" data-dy="0"
           style="margin-top:${i ? 1.6 : 0}rem;${i === 0 ? 'font-size:var(--fs-lg);font-weight:700' : 'font-size:var(--fs-sm);color:var(--dim)'}">${esc(l.text)}</div>`).join('')}
  </div>
  <div class="card" data-in="${repo.in}" data-out="99" data-dy="26"
       style="left:${vertical ? 8 : 33}%;top:${vertical ? 50 : 60}%;width:${vertical ? 84 : 50}%;height:${vertical ? 10 : 12}%;border-radius:16px;display:flex;align-items:center;padding:0 calc(var(--fs-md)*1.4);gap:calc(var(--fs-md)*1.1)">
    <svg width="54" height="54" viewBox="0 0 16 16" fill="var(--fg)"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.37-.94-.9-1.19-.9-1.19-.73-.5.06-.49.06-.49.81.06 1.24.83 1.24.83.72 1.24 1.88.88 2.34.67.07-.52.28-.88.51-1.08-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
    <div>
      <div style="font-size:var(--fs-md);font-weight:600">${esc(repo.text)}</div>
      <div class="mono" style="margin-top:8px;font-size:var(--fs-sm);color:var(--info)">${esc(repo.url)}</div>
    </div>
  </div>
  ${repo.foot ? `<div data-in="${repo.footIn ?? repo.in}" data-out="99" style="position:absolute;left:0;right:0;top:${vertical ? 64 : 78}%;text-align:center;font-size:var(--fs-sm);color:var(--dim)">${esc(repo.foot)}</div>` : ''}`,
  };
}

/** 组件：底部字幕（贯穿式说明）；竖屏时上移，避免与底部代码卡/内容碰撞 */
function caption({ items }, ctx = {}) {
  const vertical = ctx.aspect === '9:16';
  return {
    html: items.map((c, i) => `
    <div data-in="${c.in}" data-out="${c.out ?? 99}" data-dy="12"
         style="position:absolute;left:8%;right:8%;top:${c.top ?? (vertical ? 68 + i * 4.5 : 76)}%;text-align:center;font-size:var(--fs-md);color:${c.dim ? 'var(--dim)' : 'var(--fg)'}">${c.text}</div>`).join(''),
  };
}

const REGISTRY = { hud, title, cards, pipeline, bullets, phone, outro, caption };

/**
 * 由场景描述生成完整 HTML。
 * @param {object} spec   场景 JSON
 * @param {'16:9'|'9:16'} aspect 画幅
 */
export function buildHtml(spec, aspect = '16:9') {
  const vertical = aspect === '9:16';
  const [W, H] = vertical ? [1080, 1920] : [1920, 1080];
  const base = vertical ? 30 : 22;                     // 竖屏字号略大，等效视觉密度接近
  const scale = vertical ? 1.0 : 1.0;

  let body = '';
  let persistent = '';
  let scripts = '';
  for (const section of spec.sections) {
    for (const layer of section.layers) {
      const fn = REGISTRY[layer.type];
      if (!fn) throw new Error(`未知组件: ${layer.type}`);
      const out = fn(layer.props ?? {}, { section, aspect, W, H });
      if (layer.persist) {
        // persistent 层跨越所有段落（例如左上角段落名与进度条）
        persistent += `<section style="position:absolute;inset:0">${out.html ?? ''}</section>`;
      } else {
        body += `<section data-section="${section.id}" data-start="${section.start}" data-end="${section.end}"
                          style="position:absolute;inset:0">${out.html ?? ''}</section>`;
      }
      if (out.script) scripts += out.script;
    }
  }

  const cssVars = `
    --accent:#d97757; --ok:#4ade80; --bad:#f87171; --info:#60a5fa; --fg:#e8e8ea; --dim:#9a9aa6;
    --fs-sm:${base * 0.78}px; --fs-md:${base * 1.25}px; --fs-lg:${base * 1.55}px; --fs-xl:${base * 2.2}px;
    --pad:${base * 4}px; --padTop:${base * 2.7}px; --padBottom:${base * 2}px;`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(spec.title)}</title><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${W}px; height:${H}px; overflow:hidden; background:#0a0a0c; }
  body { font-family:"Microsoft YaHei UI","Microsoft YaHei","Segoe UI",system-ui,sans-serif; color:var(--fg); -webkit-font-smoothing:antialiased; ${cssVars} }
  #stage { position:absolute; inset:0; overflow:hidden; }
  #bg { position:absolute; inset:0; background:
        radial-gradient(1100px 700px at 22% 18%, #1b1b21 0%, transparent 62%),
        radial-gradient(900px 640px at 82% 84%, #17171d 0%, transparent 60%), #0a0a0c; }
  #grid { position:absolute; inset:0; opacity:.30;
    background-image:linear-gradient(to right, rgba(255,255,255,.055) 1px, transparent 1px),
                     linear-gradient(to bottom, rgba(255,255,255,.055) 1px, transparent 1px);
    background-size:${base * 3}px ${base * 3}px;
    -webkit-mask-image:radial-gradient(1100px 780px at 50% 46%, #000 38%, transparent 88%); }
  #vig { position:absolute; inset:0; box-shadow:inset 0 0 320px 90px #06060799; }
  .card { position:absolute; border-radius:18px; background:linear-gradient(180deg,#1a1a1f,#141418);
    border:1px solid rgba(255,255,255,.085); box-shadow:0 26px 60px -28px #000c; display:flex; flex-direction:column; }
  /* .dot 必须显式绝对定位：漏了这行时，光点会按静态流停在段落原点 (0,0)，
     表现为每帧左上角一个游离小圆点（排查了半天） */
  .dot { position:absolute; }
  .lbl { font-size:${base * 0.78}px; letter-spacing:.16em; text-transform:uppercase; color:var(--dim); }
  .mono { font-family:"Cascadia Mono",Consolas,monospace; }
  .tag { display:inline-block; padding:.28em .7em; border-radius:999px; font-size:${base * 0.75}px;
    border:1px solid rgba(255,255,255,.14); color:#c9c9d2; background:#ffffff08; }
  .tag.ok { color:var(--ok); border-color:#4ade8055; background:#4ade8012; }
  .tag.err { color:var(--bad); border-color:#f8717155; background:#f8717112; }
  .tag.info { color:var(--info); border-color:#60a5fa55; background:#60a5fa12; }
  .h1 { font-size:${base * (vertical ? 2.9 : 3.7)}px; font-weight:700; letter-spacing:-.01em; }
</style></head><body>
<div id="stage">
  <div id="bg"></div><div id="grid"></div>
  ${body}
  ${persistent}
  <div id="vig"></div>
</div>
<script>
const DUR = ${spec.duration};
// ── 通用运行时：所有动画都由 data-in/out/fade/dy/scale 推导，不含逐元素数学 ──
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const easeOut=(x)=>1-Math.pow(1-clamp(x,0,1),3);
const easeExpo=(x)=>(x<=0?0:x>=1?1:1-Math.pow(2,-10*x));

// 段落级门控：每个 section 只在 [start,end] 内可见，元素透明度再乘上它。
// 第一版没有这层，导致所有段落同时挂在画面上 —— 元素级进出场管不住段落。
const sections=[...document.querySelectorAll('[data-section]')].map(el=>({
  el, start:parseFloat(el.dataset.start), end:parseFloat(el.dataset.end),
  alpha:1,
}));
const nodes=[...document.querySelectorAll('[data-in]')].map(el=>({
  el, sec:el.closest('[data-section]'),
  inT:parseFloat(el.dataset.in), outT:parseFloat(el.dataset.out ?? '99'),
  fadeIn:parseFloat(el.dataset.fade ?? '0.5'), fadeOut:parseFloat(el.dataset.fadeOut ?? '0.4'),
  dy:parseFloat(el.dataset.dy ?? '18'), sc:parseFloat(el.dataset.scale ?? '1'),
}));
const packets=[...document.querySelectorAll('[data-track=packet]')].map(el=>({
  el, sec:el.closest('[data-section]'), axis:el.dataset.axis ?? 'x',
  from:parseFloat(el.dataset.from), to:parseFloat(el.dataset.to),
  inT:parseFloat(el.dataset.in), outT:parseFloat(el.dataset.out ?? '99'),
}));
const drawers=[...document.querySelectorAll('[data-track=drawer]')].map(el=>({
  el, sec:el.closest('[data-section]'),
  open:parseFloat(el.dataset.open), close:parseFloat(el.dataset.close ?? '99'),
  width:parseFloat(el.dataset.width ?? '268'),
}));
const shade=document.getElementById('phone-shade');

function seek(t){
  // 段落门控：0.45s 淡入 / 0.35s 淡出
  const secAlpha=new Map();
  for(const s of sections){
    let a=1;
    if(t<s.start-0.001) a=0;
    else if(t<s.start+0.45) a=easeOut((t-s.start)/0.45);
    if(a>0){
      if(t>s.end) a=0;
      else if(t>s.end-0.35) a=Math.min(a,1-easeOut((t-(s.end-0.35))/0.35));
    }
    secAlpha.set(s.el,a);
    s.el.style.visibility=a<=0.001?'hidden':'visible';
  }
  for(const n of nodes){
    let o=1,x=0,y=0,s=1;
    if(t<n.inT) o=0;
    else if(t<n.inT+n.fadeIn){const k=easeOut((t-n.inT)/n.fadeIn); o=k; y=n.dy*(1-k); s=1+(n.sc-1)*(1-easeExpo((t-n.inT)/n.fadeIn));}
    if(t>n.outT) o=0;
    else if(t>n.outT-n.fadeOut){const k=easeOut((t-(n.outT-n.fadeOut))/n.fadeOut); o=Math.min(o,1-k);}
    if(n.sec) o*=(secAlpha.get(n.sec) ?? 1);
    n.el.style.opacity=o;
    n.el.style.visibility=o<=0.001?'hidden':'visible';
    if(n.dy!==0||n.sc!==1) n.el.style.transform='translateY('+y+'px) scale('+s+')';
  }
  for(const p of packets){
    const k=easeOut(clamp((t-p.from)/(p.to-p.from),0,1));
    const sa=(p.sec?secAlpha.get(p.sec):1) ?? 1;   // 段落门控同样作用于光点
    // 横屏沿 X 走、竖屏沿 Y 走（纵排链路的连接线是垂直的）
    p.el.style.transform = p.axis==='y'
      ? 'translateY('+(k*100)+'%) scale('+(t<p.inT||t>p.outT?0.6:1)+')'
      : 'translateX('+(k*100)+'%) translateX('+(-k*18)+'px) scale('+(t<p.inT||t>p.outT?0.6:1)+')';
    p.el.style.opacity=(t<p.inT||t>p.outT)?0:sa;
    p.el.style.visibility=(t<p.inT||t>p.outT||sa<=0.001)?'hidden':'visible';
  }
  for(const d of drawers){
    const open=easeOut(clamp((t-d.open)/((d.close-d.open)*0.18),0,1));
    const shut=easeOut(clamp((t-(d.close-0.7))/0.6,0,1));
    const x=-d.width*(1-open)+d.width*shut;
    d.el.style.transform='translateX('+x+'px)';
    const sa=(d.sec?secAlpha.get(d.sec):1) ?? 1;
    d.el.style.opacity=sa;
    if(shade){const a=(t>d.open&&t<d.close-0.7)?0.67*open:0.67*Math.max(0,1-shut); shade.style.opacity=a*sa;}
  }
  if(window.__prog) window.__prog.style.width=(clamp(t/DUR,0,1)*100)+'%';
  if(window.__marks&&window.__hudName){
    let name=window.__marks[0][1];
    for(const [at,n] of window.__marks) if(t>=at) name=n;
    window.__hudName.textContent=name;
  }
  const g=document.getElementById('grid'); if(g) g.style.transform='translate('+(-t*6)+'px,'+(-t*3)+'px)';
}
${scripts}
window.seek=seek; window.DUR=DUR; seek(0);
</script>
</body></html>`;
}
