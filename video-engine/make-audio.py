#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""规格驱动的配乐生成器（v4）。

与 v3 的唯一结构性差别：**时间轴不再写在代码里**。
和弦进行、音效事件全部读自场景 JSON 的 `audio` 块 —— 与画面同一份数据。

  node engine/render.mjs --spec scenes/x.json ...     # 画面
  python tools/make-audio.py --spec scenes/x.json      # 声音
                                                      ↑ 同一份 spec

事件类型（写进 spec 的 audio.events）：
  whoosh  {t,dur,amp,f0,f1,up,seed}       过场气流
  bell    {t,freq,amp,pan}                铃音
  click   {t,tone,amp,pan}                界面点按
  impact  {t,amp}                         低频下坠
  riser   {t,dur,amp,f0,f1,seed}          上行张力
  series  {t,count,gap,tone,step,amp,panFrom,panTo}   等间隔一串短音
  ramp    {t,count,span,tone0,tone1,amp0,amp1,panFrom,panTo}  音高上行的一串
"""
import argparse
import json
import math
import os
import subprocess
import wave

import numpy as np

SR = 48000
OUT_DIR = r"D:\dsh-video\out"
FFMPEG = r"D:\dsh-video\tools\ffmpeg\ffmpeg.exe"

ap = argparse.ArgumentParser()
ap.add_argument('--spec', default=r'D:\dsh-video\engine\scenes\dsh-phone-access.json')
ap.add_argument('--out', default=os.path.join(OUT_DIR, 'audio-spec.wav'))
args = ap.parse_args()

SPEC = json.load(open(args.spec, encoding='utf-8'))
DUR = float(SPEC.get('duration', 45.0))
AUDIO = SPEC.get('audio', {})
TARGET_LUFS = float(AUDIO.get('target_lufs', -15))
TARGET_PEAK = 0.79
N = int(SR * DUR) + SR
rng = np.random.default_rng(20261101)

print(f"场景: {SPEC.get('title')}  {DUR}s  调性 {AUDIO.get('key','-')}")
print(f"和弦段 {len(AUDIO.get('sections', []))} · 音效事件 {len(AUDIO.get('events', []))}")


# ═══════════════════════ DSP（与 v3 相同，已验证） ═══════════════════════
def t_of(n): return np.arange(n) / SR


def adsr(n, a=0.01, d=0.1, s=0.8, r=0.3, curve=2.0):
    e = np.zeros(n)
    ai, di, ri = int(a * SR), int(d * SR), int(r * SR)
    si = max(0, n - ai - di - ri)
    idx = 0
    if ai: e[idx:idx + ai] = np.linspace(0, 1, ai) ** 0.7; idx += ai
    if di: e[idx:idx + di] = np.linspace(1, s, di) ** (1 / curve); idx += di
    if si: e[idx:idx + si] = s; idx += si
    if ri and idx < n: e[idx:] = np.linspace(s, 0, n - idx) ** curve
    return e


def lowpass(x, cutoff, order=1):
    if cutoff >= SR / 2: return x
    y = x
    for _ in range(order):
        a = math.exp(-2 * math.pi * cutoff / SR); acc = 0.0
        out = np.empty_like(y)
        for i in range(len(y)):
            acc = (1 - a) * y[i] + a * acc; out[i] = acc
        y = out
    return y


def highpass(x, cutoff, order=1): return x - lowpass(x, cutoff, order)


def saw(freq, n, harmonics=9):
    t = t_of(n); out = np.zeros(n)
    for h in range(1, harmonics + 1): out += np.sin(2 * np.pi * freq * h * t) / h
    return out * 0.6


def triangle(freq, n, harmonics=7):
    t = t_of(n); out = np.zeros(n)
    for h in range(1, harmonics + 1, 2):
        out += ((-1) ** ((h - 1) // 2)) * np.sin(2 * np.pi * freq * h * t) / (h * h)
    return out * 1.2


def sine(freq, n): return np.sin(2 * np.pi * freq * t_of(n))


def make_ir(seconds=2.4, decay=3.2, damp=3800):
    n = int(SR * seconds)
    ir = rng.normal(0, 1, n) * np.exp(-np.arange(n) / SR * decay)
    ir = lowpass(ir, damp)
    ir[: int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))
    return ir / (np.sqrt(np.sum(ir ** 2)) + 1e-9)


IR = make_ir()
FFT_N = 1 << int(math.ceil(math.log2(N + len(IR))))


def reverb(x, wet=0.35, pre=0.012):
    pad = np.zeros(len(x) + int(pre * SR)); pad[int(pre * SR):] = x
    y = np.fft.irfft(np.fft.rfft(pad, FFT_N) * np.fft.rfft(IR, FFT_N), FFT_N)[:len(x)]
    y /= np.max(np.abs(y)) + 1e-9
    return x * (1 - wet) + y * wet * (np.max(np.abs(x)) + 1e-9)


def pad_note(freq, dur, amp=0.12, detune=0.004, cutoff=2600):
    n = int(SR * dur); out = np.zeros(n)
    for d in (-detune, 0.0, detune): out += saw(freq * (1 + d), n, 7)
    out += saw(freq * 2, n, 5) * 0.38
    return amp * lowpass(out / 3.4, cutoff) * adsr(n, dur * 0.30, dur * 0.18, 0.72, dur * 0.34, 1.6)


def sub_note(freq, dur, amp=0.16):
    n = int(SR * dur)
    return amp * (sine(freq, n) * 0.8 + sine(freq * 2, n) * 0.2) * adsr(n, dur * 0.12, dur * 0.2, 0.8, dur * 0.5, 1.4)


def pluck(freq, dur=0.9, amp=0.085):
    n = int(SR * dur)
    body = triangle(freq, n, 9) * 0.6 + sine(freq * 2.01, n) * 0.22 + sine(freq * 3.02, n) * 0.18
    return amp * highpass(lowpass(body, 9000), 300) * adsr(n, 0.006, dur * 0.35, 0.15, dur * 0.6, 2.2)


def bell(freq, dur=2.2, amp=0.11):
    n = int(SR * dur); out = np.zeros(n)
    for mult, g, dec in ((1.0, 1.0, 1.0), (2.0, 0.42, 0.7), (3.01, 0.17, 0.5), (4.98, 0.08, 0.35)):
        out += g * sine(freq * mult, n) * np.exp(-t_of(n) / (dur * 0.36 * dec))
    return amp * out * adsr(n, 0.004, dur * 0.05, 0.95, dur * 0.2, 1.4)


def soft_click(amp=0.06, tone=1500):
    n = int(SR * 0.075)
    return amp * lowpass(sine(tone, n) * 0.7 + triangle(tone * 1.5, n, 5) * 0.3, 4200) * adsr(n, 0.004, 0.05, 0.1, 0.02, 2.6)


def whoosh(dur=0.75, amp=0.10, f0=420, f1=2100, up=True, seed=0):
    r = np.random.default_rng(seed); n = int(SR * dur)
    noise = r.normal(0, 1, n); t = t_of(n); prog = t / dur
    centre = f0 + (f1 - f0) * (prog ** 0.75 if up else 1 - prog ** 0.75)
    body = highpass(lowpass(noise * (np.sin(2 * np.pi * centre * t) * 0.35 + 1.0), 6500), 180)
    sig = body * np.sin(np.pi * prog) ** 1.4
    return amp * sig / (np.max(np.abs(sig)) + 1e-9)


def riser(dur=2.2, amp=0.075, f0=180, f1=900, seed=1):
    r = np.random.default_rng(seed); n = int(SR * dur); prog = t_of(n) / dur
    tone = np.sin(2 * np.pi * (f0 + (f1 - f0) * prog ** 1.6) * t_of(n))
    return amp * (tone * 0.55 + lowpass(r.normal(0, 1, n), 3800) * 0.45) * (prog ** 1.8)


def impact(amp=0.22):
    n = int(SR * 1.1); t = t_of(n)
    f = 110 * np.exp(-t * 2.2) + 38
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR)
    return amp * (tone * 0.8 + lowpass(rng.normal(0, 1, n), 900) * 0.25) * adsr(n, 0.008, 0.35, 0.25, 0.55, 1.8)


def texture(dur, amp=0.010, seed=2):
    r = np.random.default_rng(seed); n = int(SR * dur)
    x = highpass(lowpass(r.normal(0, 1, n), 900), 140)
    x /= np.max(np.abs(x)) + 1e-9
    return amp * x * np.sin(np.pi * np.clip(t_of(n) / dur, 0, 1)) ** 0.7


# ═══════════════════════ 总线 ═══════════════════════
TRACKS = ("pad", "bass", "arp", "texture", "fx", "ui", "bell")
bus = {k: np.zeros(N) for k in TRACKS}
busL = {k: np.zeros(N) for k in TRACKS}
busR = {k: np.zeros(N) for k in TRACKS}
MUSIC = ("pad", "bass", "arp", "texture")
TRIGGER = ("fx", "bell", "ui")
SEND = {"pad": 0.30, "bass": 0.05, "arp": 0.34, "fx": 0.42, "ui": 0.30, "bell": 0.48, "texture": 0.22}
BUS_GAIN = {'pad': 1.0, 'bass': 1.0, 'arp': 1.0, 'texture': 1.0, 'fx': 1.30, 'ui': 2.40, 'bell': 1.15}


def put_st(track, sig, at, gain=1.0, pan=0.0):
    s = int(at * SR)
    if s < 0: sig = sig[-s:]; s = 0
    e = min(N, s + len(sig))
    if e <= s: return
    seg = sig[: e - s]
    l = math.sqrt((1 - pan) / 2); r = math.sqrt((1 + pan) / 2)
    busL[track][s:e] += seg * gain * l
    busR[track][s:e] += seg * gain * r
    bus[track][s:e] += seg * gain * 0.5


# ═══════════════════════ 铺底（读自 spec.audio.sections） ═══════════════════════
SECTIONS = AUDIO.get('sections', [])
for sec in SECTIONS:
    start, dur = float(sec['start']), float(sec['dur'])
    chord = sec['chord']
    for i, f in enumerate(chord):
        put_st("pad", pad_note(f, dur + 1.2, amp=0.11 / len(chord) * 2.2, cutoff=3200 + i * 300),
               start, 1.0, pan=-0.45 + i * 0.45)
    put_st("bass", sub_note(sec['root'], dur + 0.6, amp=0.085), start + 0.05, 1.0, 0.0)
    put_st("texture", texture(dur + 0.8, seed=int(start * 10) + 1), start + 0.2, 1.0, 0.0)

# 琶音：0.62s 网格，按当前段落取音（与 v3 相同节奏，音高来自 spec）
if SECTIONS:
    for i, at in enumerate(np.arange(1.0, DUR - 1.0, 0.62)):
        cur = SECTIONS[0]
        for s in SECTIONS:
            if at >= float(s['start']): cur = s
        notes = cur['arp']; f = notes[i % len(notes)]
        dur = 1.5 if i % 4 == 0 else 0.85
        amp = 0.078 if i % 4 == 0 else 0.058
        put_st("arp", pluck(f, dur, amp), at, 1.0, pan=(-0.55 if i % 2 == 0 else 0.55) * 0.8)


# ═══════════════════════ 音效事件（读自 spec.audio.events） ═══════════════════════
counts = {}
for ev in AUDIO.get('events', []):
    kind = ev['type']; t = float(ev['t'])
    counts[kind] = counts.get(kind, 0) + 1
    if kind == 'whoosh':
        put_st("fx", whoosh(dur=float(ev.get('dur', 0.75)), amp=float(ev.get('amp', 0.09)),
                            f0=float(ev.get('f0', 420)), f1=float(ev.get('f1', 2100)),
                            up=bool(ev.get('up', True)), seed=int(ev.get('seed', 0))), t, 1.0, 0.0)
    elif kind == 'bell':
        put_st("bell", bell(float(ev['freq']), float(ev.get('dur', 2.2)), float(ev.get('amp', 0.1))),
               t, 1.0, float(ev.get('pan', 0.0)))
    elif kind == 'click':
        put_st("ui", soft_click(float(ev.get('amp', 0.05)), float(ev.get('tone', 1500))), t, 1.0, float(ev.get('pan', 0.0)))
    elif kind == 'impact':
        put_st("fx", impact(float(ev.get('amp', 0.2))), t)
    elif kind == 'riser':
        put_st("fx", riser(float(ev.get('dur', 2.0)), float(ev.get('amp', 0.065)),
                           float(ev.get('f0', 200)), float(ev.get('f1', 820)), int(ev.get('seed', 1))), t)
    elif kind == 'series':
        for i in range(int(ev['count'])):
            pan = float(ev.get('panFrom', 0)) + (float(ev.get('panTo', 0)) - float(ev.get('panFrom', 0))) * i / max(1, int(ev['count']) - 1)
            put_st("ui", soft_click(float(ev.get('amp', 0.03)), float(ev.get('tone', 1500)) + i * float(ev.get('step', 0))),
                   t + i * float(ev.get('gap', 0.4)), 1.0, pan)
    elif kind == 'ramp':
        for i, k in enumerate(np.linspace(0, 1, int(ev['count']))):
            tone = float(ev['tone0']) + (float(ev['tone1']) - float(ev['tone0'])) * k
            amp = float(ev['amp0']) + (float(ev['amp1']) - float(ev['amp0'])) * k
            pan = float(ev.get('panFrom', 0)) + (float(ev.get('panTo', 0)) - float(ev.get('panFrom', 0))) * k
            put_st("ui", soft_click(amp, tone), t + float(ev['span']) * k, 1.0, pan)
    else:
        raise SystemExit(f"未知事件类型: {kind}")

print("事件统计:", ", ".join(f"{k}×{v}" for k, v in sorted(counts.items())))


# ═══════════════════════ 侧链避让 ═══════════════════════
def envelope(x, attack_ms=8.0, release_ms=260.0):
    a_a = math.exp(-1.0 / (SR * attack_ms / 1000.0))
    a_r = math.exp(-1.0 / (SR * release_ms / 1000.0))
    env = np.zeros_like(x); prev = 0.0; ax = np.abs(x)
    for i in range(len(ax)):
        coef = a_a if ax[i] > prev else a_r
        prev = coef * prev + (1 - coef) * ax[i]; env[i] = prev
    return env


trig = np.zeros(N)
for k in TRIGGER: trig += np.abs(bus[k])
trig_env = envelope(trig, 6.0, 300.0); trig_env /= (np.max(trig_env) + 1e-9)
duck_db = -5.5 * np.clip((trig_env - 0.05) / (0.30 + 1e-9), 0, 1)
duck = 10 ** (duck_db / 20.0)
duck = np.convolve(duck, np.ones(int(0.02 * SR)) / int(0.02 * SR), mode='same')

L = np.zeros(N); R = np.zeros(N)
for k in TRACKS:
    wet = reverb(bus[k], wet=SEND[k]) if k in ("fx", "bell", "ui", "arp") else bus[k]
    g = (duck if k in MUSIC else 1.0) * BUS_GAIN[k]
    if k in MUSIC:
        L += busL[k] * g; R += busR[k] * g
    else:
        L += (wet * 0.5 + busL[k] * 0.5) * g
        R += (wet * 0.5 + busR[k] * 0.5) * g

stereo = np.stack([L, R], axis=1)[: int(SR * DUR)]


# ═══════════════════════ 母带链 ═══════════════════════
def master_chain(st, rep):
    st = st - st.mean(axis=0, keepdims=True)
    mid = st.mean(axis=1); low = lowpass(mid, 120)
    st = st - np.stack([lowpass(st[:, 0], 120), lowpass(st[:, 1], 120)], axis=1) + np.stack([low, low], axis=1)
    rep['mono_below_120hz'] = True

    for ch in range(2):
        st[:, ch] = st[:, ch] + 1.0 * highpass(st[:, ch], 4000)

    prog = np.abs(st).mean(axis=1)
    kk = int(0.18 * SR)
    prog = np.convolve(prog, np.ones(kk) / kk, mode='same')
    prog = np.clip(prog / (np.percentile(prog, 95) + 1e-9), 0, 1.4) ** 0.85
    air = highpass(rng.normal(0, 1, len(st)), 7500) * 0.030 * prog
    shimmer = highpass(lowpass(rng.normal(0, 1, len(st)), 11000), 4000) * 0.020 * prog
    midlayer = highpass(lowpass(rng.normal(0, 1, len(st)), 4200), 1000) * 0.028 * prog
    st[:, 0] += air + shimmer + midlayer
    st[:, 1] += air + np.roll(shimmer, 120) + np.roll(midlayer, 90)

    m = st.mean(axis=1); s = (st[:, 0] - st[:, 1]) / 2 * 1.18
    st = np.stack([m + s, m - s], axis=1)
    rep['mid_side_width'] = 1.18

    win = int(0.09 * SR)
    env = np.sqrt(np.convolve((st ** 2).mean(axis=1), np.ones(win) / win, mode='same'))
    thr = np.percentile(env, 85) + 1e-9
    over = np.clip(env / thr - 1.0, 0, None)
    gain = 1.0 / (1.0 + 0.28 * over)
    gain = np.convolve(gain, np.ones(int(0.03 * SR)) / int(0.03 * SR), mode='same')
    st = st * gain[:, None]
    rep['glue_reduction_db'] = round(float(20 * np.log10(np.min(gain) + 1e-9)), 2)

    peak = np.max(np.abs(st), axis=1)
    need = np.clip(peak / 0.94, 1.0, None)
    look = int(0.002 * SR)
    lim = np.maximum.accumulate(np.concatenate([need, np.ones(look)]))[:len(need)]
    lim = np.convolve(lim, np.ones(look * 2) / (look * 2), mode='same')
    st = st / np.maximum(lim, 1.0)[:, None]
    rep['limiter_action_db'] = round(float(20 * np.log10(1.0 / max(np.max(lim), 1e-9))), 2)

    return st * (TARGET_PEAK / (np.max(np.abs(st)) + 1e-9))


qa = {'duck_max_db': round(float(np.min(duck_db)), 2),
      'duck_active_ratio': round(float(np.mean(duck < 0.99)), 3),
      'duration_s': DUR}
stereo = master_chain(stereo, qa)

pcm = (np.clip(stereo, -1, 1) * 32767).astype('<i2')
os.makedirs(OUT_DIR, exist_ok=True)
with wave.open(args.out, 'wb') as f:
    f.setnchannels(2); f.setsampwidth(2); f.setframerate(SR); f.writeframes(pcm.tobytes())

rms = float(np.sqrt(np.mean(stereo ** 2)))
qa['peak'] = round(float(np.max(np.abs(stereo))), 4)
qa['rms_dbfs'] = round(20 * math.log10(rms + 1e-9), 2)

win_len = int(0.05 * SR)
frames = np.array([np.sqrt(np.mean(stereo[i:i + win_len] ** 2)) for i in range(0, len(stereo) - win_len, win_len)])
quiet = frames < 10 ** (-60 / 20)
gap = 0; max_gap = 0
for q in quiet:
    gap = gap + 1 if q else 0
    max_gap = max(max_gap, gap)
qa['max_silence_ms'] = int(max_gap * 50)

print("── 母带链 ──")
for k, v in qa.items(): print(f"  {k}: {v}")


# ═══════════════════════ 质检 ═══════════════════════
def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')


print("\n── 质检 ──")
r = run([FFMPEG, '-hide_banner', '-nostats', '-i', args.out, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'])
txt = (r.stderr or '') + (r.stdout or '')
lufs = lra = tp = None
for line in txt.splitlines():
    l = line.strip()
    if l.startswith('I:') and lufs is None:
        try: lufs = float(l.split()[1])
        except Exception: pass
    if l.startswith('LRA:') and lra is None:
        try: lra = float(l.split()[1])
        except Exception: pass
    if l.startswith('Peak:') and tp is None:
        try: tp = float(l.split()[1])
        except Exception: pass
qa['lufs_integrated'] = lufs; qa['lra_lu'] = lra; qa['true_peak_dbtp'] = tp

mono = stereo.mean(axis=1)
X = np.fft.rfft(mono); fr = np.fft.rfftfreq(len(mono), 1 / SR); P = np.abs(X) ** 2
bands = {'sub_20_80': (20, 80), 'bass_80_250': (80, 250), 'lowmid_250_1k': (250, 1000),
         'mid_1k_4k': (1000, 4000), 'high_4k_10k': (4000, 10000), 'air_10k_24k': (10000, 24000)}
tot = P.sum()
qa['bands_pct'] = {k: round(float(100 * P[(fr >= a) & (fr < b)].sum() / tot), 2) for k, (a, b) in bands.items()}

spec_png = os.path.join(OUT_DIR, 'qa-spec-spectrogram.png')
run([FFMPEG, '-y', '-hide_banner', '-loglevel', 'error', '-i', args.out,
     '-lavfi', 'showspectrumpic=s=1200x460:legend=1:scale=log', spec_png])

checks = []
def check(name, ok, detail): checks.append({'check': name, 'ok': bool(ok), 'detail': detail})

lo, hi = TARGET_LUFS - 1.5, TARGET_LUFS + 1.5
check(f'响度在 {lo:.1f}~{hi:.1f} LUFS（spec 目标 {TARGET_LUFS}）', lufs is not None and lo <= lufs <= hi, f'I={lufs} LUFS')
check('真峰 ≤ -1 dBTP', tp is not None and tp <= -1.0, f'{tp} dBTP')
check('低频 20~50%', 20 <= qa['bands_pct']['bass_80_250'] <= 50, f"{qa['bands_pct']['bass_80_250']}%")
check('中频 1k-4k 10~30%', 10 <= qa['bands_pct']['mid_1k_4k'] <= 30, f"{qa['bands_pct']['mid_1k_4k']}%")
check('空气感 10k+ ≥1.5%', qa['bands_pct']['air_10k_24k'] >= 1.5, f"{qa['bands_pct']['air_10k_24k']}%")
check('无空洞（<400ms）', qa['max_silence_ms'] < 400, f"{qa['max_silence_ms']}ms")
check('侧链避让 ≥3dB', qa['duck_max_db'] <= -3.0, f"最深 {qa['duck_max_db']}dB / 覆盖 {qa['duck_active_ratio']}")

qa['checks'] = checks
passed = sum(1 for c in checks if c['ok'])
print(f"  通过 {passed}/{len(checks)} 项:")
for c in checks: print(f"    [{'PASS' if c['ok'] else 'FAIL'}] {c['check']}  ({c['detail']})")

report = os.path.join(OUT_DIR, 'qa-audio-spec.json')
json.dump({**qa, 'spec': args.spec, 'wav': args.out}, open(report, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print(f"\n音频: {args.out}\n报告: {report}")
print(f"频谱图: {spec_png}")
