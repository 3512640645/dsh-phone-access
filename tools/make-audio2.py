#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""dsh-phone-access 介绍片配乐 v2（对齐 animation.html 时间轴）。

相比 v1 的改进（去"生硬"）：
  * 有混响：合成长尾脉冲响应做卷积混响，所有点状音都有尾巴
  * 分轨编排：pad / sub bass / 琶音 / 噪声织体 / FX / 铃声，互相让位
  * 音乐连续：统一 A 小调，按段落换和弦，段落间有 riser + 低频下坠做衔接
  * 柔和瞬态：长起音、软包络、低通整形，取消硬click
  * 立体声与总线处理：宽带声场 + 轻微总线压缩 + 软限幅

输出: D:\\dsh-video\\out\\audio2.wav  (48kHz 立体声, 45.0s)
"""
import math
import os
import wave

import numpy as np

SR = 48000
DUR = 45.0
OUT = r"D:\dsh-video\out\audio2.wav"
N = int(SR * DUR) + SR

rng = np.random.default_rng(20261101)


# ───────────────────────── 基础工具 ─────────────────────────
def t_of(n):
    return np.arange(n) / SR


def adsr(n, a=0.01, d=0.1, s=0.8, r=0.3, curve=2.0):
    """经典 ADSR；用于让每个音都有"呼吸"，而不是啪一下开始/结束。"""
    e = np.zeros(n)
    ai, di, ri = int(a * SR), int(d * SR), int(r * SR)
    si = max(0, n - ai - di - ri)
    idx = 0
    if ai > 0:
        e[idx:idx + ai] = np.linspace(0, 1, ai) ** 0.7
        idx += ai
    if di > 0:
        e[idx:idx + di] = np.linspace(1, s, di) ** (1 / curve)
        idx += di
    if si > 0:
        e[idx:idx + si] = s
        idx += si
    if ri > 0 and idx < n:
        e[idx:] = np.linspace(s, 0, n - idx) ** curve
    return e


def lowpass(x, cutoff):
    """一阶低通（够用，用来削掉刺耳高频）。"""
    if cutoff >= SR / 2:
        return x
    a = math.exp(-2 * math.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def saw(freq, n, harmonics=9):
    t = t_of(n)
    out = np.zeros(n)
    for h in range(1, harmonics + 1):
        out += np.sin(2 * np.pi * freq * h * t) / h
    return out * 0.6


def triangle(freq, n, harmonics=7):
    t = t_of(n)
    out = np.zeros(n)
    for h in range(1, harmonics + 1, 2):
        out += ((-1) ** ((h - 1) // 2)) * np.sin(2 * np.pi * freq * h * t) / (h * h)
    return out * 1.2


def sine(freq, n):
    return np.sin(2 * np.pi * freq * t_of(n))


# ───────────────────────── 混响 ─────────────────────────
def make_ir(seconds=2.4, decay=3.2, damp=3800):
    """合成脉冲响应：指数衰减噪声 + 低通，得到柔和偏暗的空间尾巴。"""
    n = int(SR * seconds)
    noise = rng.normal(0, 1, n)
    env = np.exp(-np.arange(n) / SR * decay)
    ir = noise * env
    ir = lowpass(ir, damp)
    ir[: int(0.004 * SR)] *= np.linspace(0, 1, int(0.004 * SR))  # 去掉最前面的硬沿
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    return ir


IR = make_ir()
FFT_N = 1 << int(math.ceil(math.log2(N + len(IR))))


def reverb(x, wet=0.35, pre=0.012):
    """卷积混响（FFT），pre 为预延迟，让直达声先出来、尾巴再跟上。"""
    pad = np.zeros(len(x) + int(pre * SR))
    pad[int(pre * SR):] = x
    X = np.fft.rfft(pad, FFT_N)
    H = np.fft.rfft(IR, FFT_N)
    y = np.fft.irfft(X * H, FFT_N)[:len(x)]
    y /= np.max(np.abs(y)) + 1e-9
    return x * (1 - wet) + y * wet * np.max(np.abs(x) + 1e-9)


# ───────────────────────── 总线 ─────────────────────────
bus = {k: np.zeros(N) for k in ("pad", "bass", "arp", "fx", "ui", "bell", "texture")}
SEND = {"pad": 0.30, "bass": 0.05, "arp": 0.34, "fx": 0.42, "ui": 0.30, "bell": 0.48, "texture": 0.22}


def put(track, sig, at, gain=1.0, pan=0.0):
    s = int(at * SR)
    if s < 0:
        sig = sig[-s:]
        s = 0
    e = min(N, s + len(sig))
    if e <= s:
        return
    seg = sig[: e - s]
    l = math.sqrt((1 - pan) / 2)
    r = math.sqrt((1 + pan) / 2)
    bus[track][s:e] += seg * gain


# ───────────────────────── 乐器 ─────────────────────────
def pad_note(freq, dur, amp=0.12, detune=0.004, cutoff=2600):
    n = int(SR * dur)
    out = np.zeros(n)
    for d in (-detune, 0.0, detune):
        out += saw(freq * (1 + d), n, 7)
    out = lowpass(out / 3, cutoff) * adsr(n, a=dur * 0.30, d=dur * 0.18, s=0.72, r=dur * 0.34, curve=1.6)
    return amp * out


def sub_note(freq, dur, amp=0.16):
    n = int(SR * dur)
    body = sine(freq, n) * 0.8 + sine(freq * 2, n) * 0.2
    return amp * body * adsr(n, a=dur * 0.12, d=dur * 0.2, s=0.8, r=dur * 0.5, curve=1.4)


def pluck(freq, dur=0.9, amp=0.085):
    n = int(SR * dur)
    body = triangle(freq, n, 9) * 0.75 + sine(freq * 2.01, n) * 0.25
    body = lowpass(body, 5200)
    return amp * body * adsr(n, a=0.006, d=dur * 0.35, s=0.15, r=dur * 0.6, curve=2.2)


def bell(freq, dur=2.2, amp=0.11):
    n = int(SR * dur)
    out = np.zeros(n)
    for mult, g, dec in ((1.0, 1.0, 1.0), (2.0, 0.42, 0.7), (3.01, 0.17, 0.5), (4.98, 0.08, 0.35)):
        out += g * sine(freq * mult, n) * np.exp(-t_of(n) / (dur * 0.36 * dec))
    out *= adsr(n, a=0.004, d=dur * 0.05, s=0.95, r=dur * 0.2, curve=1.4)
    return amp * out


def soft_click(amp=0.06, tone=1500):
    """柔和界面音：不用硬噪声，改成短促带音高的软点。"""
    n = int(SR * 0.075)
    body = sine(tone, n) * 0.7 + triangle(tone * 1.5, n, 5) * 0.3
    body = lowpass(body, 4200)
    return amp * body * adsr(n, a=0.004, d=0.05, s=0.1, r=0.02, curve=2.6)


def whoosh(dur=0.75, amp=0.10, f0=420, f1=2100, up=True, pan_from=-0.5, pan_to=0.5, seed=0):
    """气流过场：噪声带通扫频，立体声从一侧扫到另一侧（比 v1 更顺滑）。"""
    r = np.random.default_rng(seed)
    n = int(SR * dur)
    noise = r.normal(0, 1, n)
    t = t_of(n)
    prog = t / dur
    # 时变一阶带通：用扫频正弦调制噪声包络的感觉
    centre = f0 + (f1 - f0) * (prog ** 0.75 if up else 1 - prog ** 0.75)
    mod = np.sin(2 * np.pi * centre * t) * 0.35 + 1.0
    body = noise * mod
    body = lowpass(body, 6500)
    body = highpass(body, 180)
    env = np.sin(np.pi * prog) ** 1.4
    sig = body * env
    sig /= np.max(np.abs(sig)) + 1e-9
    # 每次调用返回一个"扫过声场"的立体声
    p = pan_from + (pan_to - pan_from) * prog
    l = sig * np.sqrt((1 - p) / 2)
    rr = sig * np.sqrt((1 + p) / 2)
    return amp, l, rr


def riser(dur=2.2, amp=0.075, f0=180, f1=900, seed=1):
    """段落衔接的上行张力层。"""
    r = np.random.default_rng(seed)
    n = int(SR * dur)
    t = t_of(n)
    prog = t / dur
    tone = np.sin(2 * np.pi * (f0 + (f1 - f0) * prog ** 1.6) * t)
    noise = lowpass(r.normal(0, 1, n), 3800)
    sig = (tone * 0.55 + noise * 0.45) * (prog ** 1.8)
    return amp * sig


def impact(amp=0.22):
    """柔和低频下坠，代替 v1 的硬"啪"。"""
    n = int(SR * 1.1)
    t = t_of(n)
    f = 110 * np.exp(-t * 2.2) + 38
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR)
    noise = lowpass(rng.normal(0, 1, n), 900)
    sig = tone * 0.8 + noise * 0.25
    return amp * sig * adsr(n, a=0.008, d=0.35, s=0.25, r=0.55, curve=1.8)


def texture(dur, amp=0.010, seed=2):
    """持续噪声织体，让空隙不"空"；压得很低、偏暗，只当空气感。"""
    r = np.random.default_rng(seed)
    n = int(SR * dur)
    x = lowpass(r.normal(0, 1, n), 900)
    x = highpass(x, 140)
    env = np.sin(np.pi * np.clip(t_of(n) / dur, 0, 1)) ** 0.7
    x /= np.max(np.abs(x)) + 1e-9
    return amp * x * env


# ───────────────────────── 音高 ─────────────────────────
A2, C3, D3, E3, F3, G3 = 110.00, 130.81, 146.83, 164.81, 174.61, 196.00
A3, C4, D4, E4, F4, G4 = 220.00, 261.63, 293.66, 329.63, 349.23, 392.00
A4, C5, D5, E5, F5, G5 = 440.00, 523.25, 587.33, 659.26, 698.46, 783.99

# ───────────────────────── 段落编排 ─────────────────────────
# 和弦：(起始, 时长, pad 音高组, sub 根音, 琶音音阶)
SECTIONS = [
    (0.0, 4.4, [A3, C4, E4], A2, [A4, C5, E5, A4]),
    (4.2, 7.4, [F3, A3, C4], F3, [F4, A4, C5, A4]),
    (11.4, 7.2, [C4, E4, G4], C3, [C5, E5, G5, E5]),
    (18.4, 7.2, [F3, A3, C4], F3, [F4, C5, A4, C5]),
    (25.4, 7.2, [D4, F4, A4], D3, [D5, F5, A4, D5]),
    (32.4, 6.6, [C4, E4, G4], C3, [E5, G5, C5, G5]),
    (38.6, 6.4, [F3, A3, C4, G3], F3, [F4, A4, C5, F5]),
]

for start, dur, chord, root, arp in SECTIONS:
    # 持续垫音（宽声场）
    for i, f in enumerate(chord):
        put("pad", pad_note(f, dur + 1.2, amp=0.10 / len(chord) * 2.2, cutoff=2400 + i * 260), start, 1.0,
            pan=-0.45 + i * 0.45)
    # 低频根音
    put("bass", sub_note(root, dur + 0.6, amp=0.15), start + 0.05, 1.0)
    # 噪声织体
    put("texture", texture(dur + 0.8, seed=int(start * 10) + 1), start + 0.2, 1.0, pan=0.0)

# 琶音：贯穿全片，音高交错，音量很轻（铺"活"感）
arp_times = np.arange(1.0, 44.0, 0.62)
for i, at in enumerate(arp_times):
    seq = SECTIONS
    cur = seq[0]
    for s in seq:
        if at >= s[0]:
            cur = s
    notes = cur[4]
    f = notes[i % len(notes)]
    dur = 1.5 if i % 4 == 0 else 0.85
    amp = 0.070 if i % 4 == 0 else 0.048
    put("arp", pluck(f, dur, amp), at, 1.0, pan=(-0.55 if i % 2 == 0 else 0.55) * 0.8)


# ── 分镜音效（与画面同步，全部软化处理） ───────────────────────────────
def fx_whoosh(at, **kw):
    amp, l, r = whoosh(**kw)
    put("fx", l, at, 1.0, pan=-1.0)
    put("fx", r, at, 1.0, pan=1.0)


# S1 标题
fx_whoosh(0.10, dur=1.15, amp=0.085, f0=300, f1=1700, seed=11, pan_from=-0.6, pan_to=0.6)
put("bell", bell(A4, 2.6, 0.105), 0.95); put("bell", bell(E5, 2.4, 0.075), 1.05)
fx_whoosh(2.30, dur=0.5, amp=0.045, f0=1400, f1=2400, seed=31, pan_from=0.3, pan_to=-0.3)
put("ui", soft_click(0.05, 1750), 2.35)

# S2 问题
fx_whoosh(4.26, dur=0.75, amp=0.075, f0=420, f1=1900, seed=12, pan_from=-0.5, pan_to=0.4)
put("ui", soft_click(0.055, 1250), 5.15)
for i, k in enumerate(np.linspace(0, 1, 10)):            # 数据包上行
    put("ui", soft_click(0.030 + 0.020 * k, 900 + 1200 * k), 5.55 + 2.65 * k, pan=-0.4 + 0.8 * k)
fx_whoosh(8.05, dur=0.45, amp=0.07, f0=1800, f1=520, up=False, seed=14, pan_from=0.4, pan_to=-0.4)
put("fx", impact(0.20), 8.20)                             # 403：低频下坠（不是硬砸）
put("bell", bell(146.83, 2.2, 0.075), 8.22)               # 不谐和的低铃，暗示出错
put("bell", bell(155.56, 1.9, 0.055), 8.26)
put("ui", soft_click(0.045, 820), 8.85)

# S3 方案
fx_whoosh(11.55, dur=0.8, amp=0.08, f0=380, f1=2000, seed=15, pan_from=-0.5, pan_to=0.5)
put("ui", soft_click(0.055, 1350), 12.22)
fx_whoosh(12.28, dur=0.5, amp=0.055, f0=1300, f1=2600, seed=16, pan_from=0.4, pan_to=-0.3)
for i in range(4):
    put("ui", soft_click(0.032, 1450 + i * 110), 12.90 + i * 0.35, pan=-0.3 + i * 0.2)
for i, k in enumerate(np.linspace(0, 1, 9)):              # 成功飞行
    put("ui", soft_click(0.028 + 0.022 * k, 1000 + 1300 * k), 13.40 + 2.15 * k, pan=-0.5 + k)
put("bell", bell(C5, 2.6, 0.105), 15.45); put("bell", bell(E5, 2.4, 0.085), 15.52)
put("bell", bell(G5, 2.2, 0.060), 15.60)                  # C 大三和弦：解决感
put("ui", soft_click(0.045, 1600), 16.20)

# S4 三种入口
for i, at in enumerate([18.60, 19.10, 19.60]):
    put("ui", soft_click(0.052 - i * 0.004, 1200 + i * 220), at, pan=-0.35 + i * 0.35)
    fx_whoosh(at + 0.03, dur=0.45, amp=0.05, f0=700 + i * 260, f1=1700 + i * 320, seed=50 + i,
              pan_from=-0.35 + i * 0.35, pan_to=0.35 - i * 0.35)
for i in range(7):
    put("ui", soft_click(0.026, 1500 + i * 70), 20.45 + i * 0.45, pan=-0.4 + (i % 3) * 0.4)
put("bell", bell(G5, 2.0, 0.075), 23.35)

# S5 手机端 UI
fx_whoosh(25.55, dur=0.85, amp=0.075, f0=340, f1=1600, seed=17, pan_from=-0.55, pan_to=0.45)
put("ui", soft_click(0.05, 1100), 26.30)
fx_whoosh(26.90, dur=0.5, amp=0.065, f0=900, f1=2500, seed=18, pan_from=-0.7, pan_to=0.1)
for i in range(6):
    put("ui", soft_click(0.030, 1600 + i * 80), 26.32 + i * 0.42, pan=-0.3 + 0.12 * i)
put("ui", soft_click(0.05, 1900), 28.12)
fx_whoosh(29.20, dur=0.5, amp=0.055, f0=2300, f1=800, up=False, seed=19, pan_from=0.2, pan_to=-0.5)
put("bell", bell(D5, 2.0, 0.075), 29.90)

# S6 修过的坑
for i, at in enumerate([32.60, 33.15, 33.70]):
    fx_whoosh(at, dur=0.45, amp=0.055, f0=1100 + i * 320, f1=560, up=False, seed=80 + i,
              pan_from=0.45 - i * 0.3, pan_to=-0.45 + i * 0.3)
    put("ui", soft_click(0.04, 1300 + i * 140), at + 0.07)

# S7 收尾
put("fx", riser(2.0, 0.065, 200, 820, seed=21), 38.70)
put("bell", bell(F4, 2.8, 0.095), 40.55); put("bell", bell(A4, 2.7, 0.080), 40.62)
put("bell", bell(C5, 2.6, 0.065), 40.70)
put("bell", bell(C5, 3.4, 0.10), 41.80); put("bell", bell(E5, 3.2, 0.075), 41.88)
put("bell", bell(G5, 3.0, 0.060), 41.96); put("bell", bell(C5 * 2, 2.6, 0.040), 42.06)


# ───────────────────────── 汇总到立体声 ─────────────────────────
L = np.zeros(N)
R = np.zeros(N)
for track, sig in bus.items():
    w = reverb(sig, wet=SEND[track])          # 每轨不同混响量，点状音尾巴更长
    mono = w
    L += mono
    R += mono

# 织体做轻微去相关，声场更宽
tex = bus["texture"]
L += np.roll(tex, 90) * 0.25
R += np.roll(tex, -90) * 0.25

stereo = np.stack([L, R], axis=1)
stereo = stereo[: int(SR * DUR)]

# ── 总线：去直流 → 暗一点的高频 → 轻压缩 → 软限幅 → 归一化 ─────────────
stereo -= stereo.mean(axis=0, keepdims=True)

# 先把 15kHz 以上压掉，去掉"嘶嘶"的洗白感（听感更暖，也不刺耳）
for ch in range(2):
    stereo[:, ch] = lowpass(highpass(stereo[:, ch], 28), 15000)

# 简易总线压缩：滑动 RMS 控制增益，抓掉过冲，留出通透感
win = int(0.08 * SR)
env = np.sqrt(np.convolve((stereo ** 2).mean(axis=1), np.ones(win) / win, mode="same"))
gain = np.ones_like(env)
thresh = np.percentile(env, 88) + 1e-9
mask = env > thresh
gain[mask] = (thresh / env[mask]) ** 0.55
stereo *= gain[:, None]

# 目标响度约 -14 LUFS：峰值 0.86 再整体微降一点
peak = np.max(np.abs(stereo)) + 1e-9
stereo *= 0.82 / peak
stereo = np.tanh(stereo * 1.45) / np.tanh(1.45) * 0.95

pcm = (np.clip(stereo, -1, 1) * 32767).astype("<i2")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with wave.open(OUT, "wb") as f:
    f.setnchannels(2)
    f.setsampwidth(2)
    f.setframerate(SR)
    f.writeframes(pcm.tobytes())

rms = float(np.sqrt(np.mean(stereo ** 2)))
print(f"已生成 {OUT}")
print(f"时长 {len(pcm)/SR:.2f}s  峰值 {np.max(np.abs(stereo)):.3f}  RMS {rms:.4f} ({20*math.log10(rms+1e-9):.1f} dBFS)")
print("分段能量（每 3 秒）:")
for i in range(0, int(DUR), 3):
    seg = stereo[int(i * SR): int(min(i + 3, DUR) * SR)]
    r = float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0
    print(f"  {i:2d}-{i+3:2d}s  {r:.4f}  {'#' * int(r / max(rms, 1e-9) * 14)}")
