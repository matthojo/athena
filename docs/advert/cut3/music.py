#!/usr/bin/env python3
"""Athena cut 3 music bed. 67.200 s (28 bars), 48 kHz stereo, 100 BPM, bar 1 beat 1 at t=0.

D major, warm and bouncy. Everything is synthesised with numpy.
Run: python3 music.py   ->  $FILM/audio/music.wav
"""
import json
import os
import sys
import time
from functools import lru_cache

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audiolib import (SR, audio_dir, db, to_db, mtof, rms_db, write_wav, g_lp, g_hp, fft_filter, edges,
                      pan_gains, make_ir, convolve_reverb, feedback_delay, master)

# ------------------------------------------------------------------ director-tunable constants
LIFT_MS = 23400      # Ask section: groove lifts back to full when the answer lands (snapped to a beat)
THIN_START_MS = 18000
ASK_END_MS = 28800

# ------------------------------------------------------------------ grid
BPM = 100
BEAT = 60.0 / BPM          # 0.6 s
BAR = 4 * BEAT             # 2.4 s
S16 = BEAT / 4             # 0.15 s
SWING = 0.020              # off-16ths land 20 ms late: a little bounce; beats stay dead on the grid
DUR = 67.2
N = int(round(DUR * SR))
LIFT = round(LIFT_MS / 1000.0 / BEAT) * BEAT
LIFT = min(max(LIFT, THIN_START_MS / 1000.0 + BEAT), ASK_END_MS / 1000.0)
THIN0 = THIN_START_MS / 1000.0
TILES = [3.0 + BEAT * k for k in range(8)]
TILE_NOTES = [69, 71, 74, 76, 78, 81, 83, 86]   # A4 B4 D5 E5 F#5 A5 B5 D6: D major pentatonic up to the tonic
ACCENTS = [54.0, 54.6]      # the two early swaps (pointer retypes)
BUILD0 = 55.2               # the rise starts; a pitched tick on every swap from here on
STOP = 61.2                 # cut dead
END = 62.4                  # final chord ("Great" is pressed)
TAG = 64.8                  # logo tag
SILENT = 66.9               # digital silence from here
PENT = [74, 76, 78, 81, 83, 86, 88, 90, 93, 95, 98, 100]     # D major pentatonic, D5 up to E7
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "swaps.json")) as _f:
    SWAPS = [float(q["at"]) / 1000.0 for q in json.load(_f)]
TICKS = [t for t in SWAPS if BUILD0 - 1e-6 <= t < STOP - 1e-3]


def T(sec):
    return int(round(sec * SR))


def pos(bar, i16):
    """Time of 16th i16 in a bar, with swing on the odd 16ths."""
    return bar * BAR + i16 * S16 + (SWING if i16 % 2 else 0.0)


STEMS = {}


def stem(name):
    if name not in STEMS:
        STEMS[name] = np.zeros((N, 2), dtype=np.float32)
    return STEMS[name]


def add(name, sig, t, gain=1.0, pan=0.0):
    buf = stem(name)
    i = T(t)
    if i >= N or i < 0:
        return
    n = min(len(sig), N - i)
    if sig.ndim == 1:
        l, r = pan_gains(pan)
        buf[i:i + n, 0] += (sig[:n] * (gain * l * 1.4142)).astype(np.float32)
        buf[i:i + n, 1] += (sig[:n] * (gain * r * 1.4142)).astype(np.float32)
    else:
        l, r = pan_gains(pan)
        buf[i:i + n, 0] += (sig[:n, 0] * (gain * l * 1.4142)).astype(np.float32)
        buf[i:i + n, 1] += (sig[:n, 1] * (gain * r * 1.4142)).astype(np.float32)


# ------------------------------------------------------------------ instruments (all band-limited additive)
def _partials(f, n, amps, taus, mults=None):
    t = np.arange(n) / SR
    out = np.zeros(n)
    for j, (a, tau) in enumerate(zip(amps, taus)):
        k = (j + 1) if mults is None else mults[j]
        if f * k > 16000:
            continue
        out += a * np.sin(2 * np.pi * f * k * t) * np.exp(-t / tau)
    return out


@lru_cache(maxsize=None)
def pluck(midi, dur, tau=0.16, K=10, c=0.6, p=1.0, cents=0.0):
    """Muted pluck: saw-ish partials whose highs die quickly (acts like a closing filter)."""
    f = mtof(midi) * 2 ** (cents / 1200.0)
    n = int(dur * SR)
    kmax = max(1, min(K, int(14000 / f)))
    k = np.arange(1, kmax + 1)
    sig = _partials(f, n, 1.0 / k ** p, tau / (1.0 + c * (k - 1)))
    return edges(sig, 0.003, 0.02)


@lru_cache(maxsize=None)
def mallet(midi, dur, tau=0.5, cents=0.0, bright=1.0):
    """Soft mallet / electric-piano tine: strong fundamental, a little 2nd and a quick 4th-partial 'tine'."""
    f = mtof(midi) * 2 ** (cents / 1200.0)
    n = int(dur * SR)
    sig = _partials(f, n, [1.0, 0.28 * bright, 0.10 * bright, 0.16 * bright],
                    [tau, tau * 0.6, tau * 0.35, tau * 0.18])
    return edges(sig, 0.003, 0.03)


def stereo_voice(fn, midi, dur, spread=5.0, **kw):
    a = fn(midi, dur, cents=-spread, **kw)
    b = fn(midi, dur, cents=+spread, **kw)
    c = fn(midi, dur, cents=0.0, **kw)
    return np.stack([c + 0.6 * a, c + 0.6 * b], axis=1)


@lru_cache(maxsize=None)
def hook_note(midi, dur=0.42):
    v = stereo_voice(pluck, midi, dur, spread=6.0, tau=0.17, K=14, c=0.36)
    m = mallet(midi, dur, tau=0.22)
    return v + 1.2 * m[:, None]


@lru_cache(maxsize=None)
def ep_chord(notes, dur, tau=0.45, bright=1.0):
    out = None
    for m in notes:
        v = stereo_voice(mallet, m, dur, spread=4.0, tau=tau, bright=bright)
        out = v if out is None else out + v
    return out / len(notes)


@lru_cache(maxsize=None)
def bass_note(midi, dur):
    """Round bass: sustained fundamental, a few quickly-fading harmonics for definition on small speakers."""
    f = mtof(midi)
    n = int(dur * SR)
    k = np.arange(1, 9)
    amps = 1.0 / k ** 1.5
    taus = np.where(k == 1, 0.55, 0.20 / (1.0 + 0.45 * (k - 1)))
    sig = _partials(f, n, amps, taus)
    return edges(sig, 0.006, 0.03)


@lru_cache(maxsize=None)
def pad_chord(notes, dur, fc=1200.0, seed=0):
    """Warm detuned pad, stereo (different detune per side), soft low-pass built into the partial amplitudes."""
    rng = np.random.default_rng(seed + 17)
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    for m in notes:
        for ch, dets in enumerate(((-8.0, 4.0), (8.0, -4.0))):
            for d in dets:
                f = mtof(m) * 2 ** (d / 1200.0)
                kmax = max(1, min(14, int(min(fc * 3.0, 12000.0) / f)))
                for k in range(1, kmax + 1):
                    a = (1.0 / k) / (1.0 + (k * f / fc) ** 2)
                    out[:, ch] += a * np.sin(2 * np.pi * f * k * t + rng.uniform(0, 2 * np.pi))
    return edges(out / len(notes), 0.09, 0.16)


def _noise(n, seed, ch=1):
    r = np.random.default_rng(seed).standard_normal((n, ch))
    return r[:, 0] if ch == 1 else r


@lru_cache(maxsize=None)
def kick(soft=1.0):
    n = int(0.36 * SR)
    t = np.arange(n) / SR
    f = 49.0 + 75.0 * np.exp(-t / 0.028)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.13)
    click = fft_filter(_noise(n, 3), lambda fr: g_lp(fr, 1800.0, 2)) * np.exp(-t / 0.004) * 0.10 * soft
    return edges(np.tanh(1.2 * (body + click)), 0.0012, 0.03)


@lru_cache(maxsize=None)
def snap(var=0):
    n = int(0.16 * SR)
    t = np.arange(n) / SR
    nz = fft_filter(_noise(n, 20 + var, 2), lambda fr: g_hp(fr, 1500.0, 2) * g_lp(fr, 5200.0 + 300 * var, 2))
    env = np.exp(-t / 0.011) + 0.25 * np.exp(-t / 0.045)
    tone = np.sin(2 * np.pi * (2250.0 + 60 * var) * t) * np.exp(-t / 0.008) * 0.35
    common = nz.mean(axis=1, keepdims=True)
    sig = (0.7 * common + 0.5 * nz) * env[:, None] + tone[:, None]
    return edges(sig, 0.0008, 0.02)


@lru_cache(maxsize=None)
def clap():
    n = int(0.26 * SR)
    t = np.arange(n) / SR
    nz = fft_filter(_noise(n, 31, 2), lambda fr: g_hp(fr, 800.0, 2) * g_lp(fr, 6000.0, 2))
    env = np.zeros(n)
    for d in (0.0, 0.010, 0.021):
        i = int(d * SR)
        env[i:] += np.exp(-t[: n - i] / 0.005)
    i = int(0.030 * SR)
    env[i:] += 0.8 * np.exp(-t[: n - i] / 0.055)
    common = nz.mean(axis=1, keepdims=True)
    return edges((0.6 * common + 0.6 * nz) * env[:, None], 0.001, 0.03)


@lru_cache(maxsize=None)
def rim():
    n = int(0.09 * SR)
    t = np.arange(n) / SR
    tone = (np.sin(2 * np.pi * 830.0 * t) + 0.5 * np.sin(2 * np.pi * 1730.0 * t)) * np.exp(-t / 0.011)
    nz = fft_filter(_noise(n, 41), lambda fr: g_hp(fr, 2000.0, 2) * g_lp(fr, 7000.0, 2)) * np.exp(-t / 0.004) * 0.5
    return edges(tone + nz, 0.0008, 0.02)


@lru_cache(maxsize=None)
def shaker(var=0):
    n = int(0.11 * SR)
    t = np.arange(n) / SR
    nz = fft_filter(_noise(n, 50 + var, 2), lambda fr: g_hp(fr, 5200.0, 3) * g_lp(fr, 11500.0, 2))
    env = (1 - np.exp(-t / 0.006)) * np.exp(-t / 0.022)
    return edges(nz * env[:, None], 0.002, 0.02)


@lru_cache(maxsize=None)
def hat(open_=False, var=0):
    dur, tau = (0.26, 0.085) if open_ else (0.07, 0.016)
    n = int(dur * SR)
    t = np.arange(n) / SR
    nz = fft_filter(_noise(n, 60 + var, 2), lambda fr: g_hp(fr, 7000.0, 3) * g_lp(fr, 14000.0, 2))
    return edges(nz * np.exp(-t / tau)[:, None], 0.001, 0.03)


@lru_cache(maxsize=None)
def crash(tau=0.5):
    n = int(min(2.0, tau * 4.5) * SR)
    t = np.arange(n) / SR
    nz = fft_filter(_noise(n, 70, 2), lambda fr: g_hp(fr, 3800.0, 2) * g_lp(fr, 12000.0, 2))
    return edges(nz * np.exp(-t / tau)[:, None], 0.003, 0.1)


@lru_cache(maxsize=None)
def swoosh(dur, f0=700.0, f1=5200.0, bw=900.0, seed=80):
    """Airy riser: narrow-band noise heterodyned onto a rising chirp; ends exactly at its last sample."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    nz = fft_filter(_noise(n, seed, 2), lambda fr: g_lp(fr, bw / 2.0, 3))
    fi = f0 * (f1 / f0) ** (t / dur)
    ph = 2 * np.pi * np.cumsum(fi) / SR
    sig = nz * np.stack([np.cos(ph), np.sin(ph)], axis=1)
    env = (t / dur) ** 2.2
    return edges(sig * env[:, None], 0.01, 0.03)


@lru_cache(maxsize=None)
def tick_note(midi):
    """Short, bright, pitched tick for a phrase swap."""
    n = int(0.14 * SR)
    t = np.arange(n) / SR
    sig = _partials(mtof(midi), n, [1.0, 0.5, 0.25], [0.05, 0.03, 0.02])
    click = fft_filter(_noise(n, 90), lambda fr: g_hp(fr, 3000.0, 2) * g_lp(fr, 9000.0, 2)) * np.exp(-t / 0.002) * 0.45
    return edges(sig + click, 0.0008, 0.02)


# ------------------------------------------------------------------ harmony
CH = {
    "D":    dict(bass=38, ep=(57, 61, 66), pad=(50, 57, 61, 66)),         # Dmaj7
    "Bm":   dict(bass=35, ep=(57, 62, 66), pad=(47, 57, 62, 66)),         # Bm7
    "G":    dict(bass=43, ep=(59, 62, 66), pad=(55, 59, 62, 66)),         # Gmaj7
    "A":    dict(bass=45, ep=(59, 62, 64), pad=(52, 55, 59, 64)),         # A9sus4
    "D/F#": dict(bass=42, ep=(57, 62, 66), pad=(50, 57, 62, 66)),
    "A/C#": dict(bass=37, ep=(57, 61, 64), pad=(52, 57, 61, 64)),
}
HOOK = {  # (16th index, midi): syncopated, pentatonic, same shape each bar so it sticks
    "D":    [(0, 78), (3, 81), (6, 78), (8, 76), (11, 74), (14, 76)],
    "Bm":   [(0, 78), (3, 81), (6, 83), (8, 81), (12, 78)],
    "G":    [(0, 83), (3, 81), (6, 79), (8, 81), (11, 79), (14, 76)],
    "A":    [(0, 76), (3, 74), (6, 76), (8, 81), (12, 76)],
    "D/F#": [(0, 78), (3, 81), (6, 86), (8, 81), (11, 78), (14, 76)],
    "A/C#": [(0, 76), (3, 73), (6, 76), (8, 81), (12, 76)],
}
CTR = {"D": [(0, 81), (8, 78)], "Bm": [(0, 86)], "G": [(0, 86), (8, 83)], "A": [(0, 83), (8, 85)],
       "D/F#": [(0, 81), (8, 86)], "A/C#": [(0, 85)]}

# bar -> chord(s); two entries = two beats each
BARS = {1: ["D"], 2: ["Bm"], 3: ["G"], 4: ["A"],
        5: ["D"], 6: ["Bm"], 7: ["G"], 8: ["A"], 9: ["D"], 10: ["Bm"], 11: ["G", "A"],
        12: ["D"], 13: ["Bm"], 14: ["G"], 15: ["A"], 16: ["D"], 17: ["Bm"], 18: ["G"], 19: ["A"],
        20: ["G", "A"], 21: ["Bm", "A/C#"],
        22: ["D"]}
# 1 light, 2 fill, 3 full, 4 +hats, 5 +counter line and rim ghosts, 6 +arp and hook octave,
# 7 +16th hats, brighter pad, 8 the biggest; 0 = the drop that opens the build
LEVEL = {1: 1, 2: 1, 3: 1, 4: 2, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3, 10: 3, 11: 3,
         12: 4, 13: 4, 14: 5, 15: 5, 16: 6, 17: 6, 18: 7, 19: 7, 20: 8, 21: 8, 22: 0}


def chord_at(bar, i16):
    c = BARS[bar]
    return c[0] if len(c) == 1 or i16 < 8 else c[1]


def thin(t):
    return THIN0 <= t < LIFT - 1e-6


BASS_FULL = [(0, 0, 2.0, 1.0), (3, 0, 0.9, 0.8), (6, 12, 0.9, 0.72), (8, 0, 2.0, 0.95), (11, 0, 0.9, 0.8), (14, 7, 1.0, 0.8)]
EP_COMP = [(0, 3.5, 1.0), (6, 1.4, 0.7), (10, 2.6, 0.85)]


def build():
    kicks = []

    def k(t, g=1.0):
        add("kick", kick(), t, g)
        kicks.append(t)

    # ---- bar 0: room tone, a very quiet bed, a soft pop when the orb appears
    n = T(4.2)
    room = fft_filter(_noise(n, 5, 2), lambda fr: g_lp(fr, 450.0, 1) * g_hp(fr, 70.0, 2))
    tt = np.arange(n) / SR
    room *= (np.clip(tt / 0.6, 0, 1) * np.clip((4.2 - tt) / 1.6, 0, 1))[:, None]
    add("room", room, 0.0)
    bed = pad_chord((50, 57, 62), 3.4, fc=420.0, seed=1)
    tb = np.arange(len(bed)) / SR
    add("bed", bed * (np.clip(tb / 2.2, 0, 1) ** 1.5 * np.clip((3.4 - tb) / 1.0, 0, 1))[:, None], 0.0)
    add("tile", stereo_voice(mallet, 74, 0.7, tau=0.16), 1.2, 0.14)
    add("tile", bass_note(50, 0.25)[:, None] * np.ones((1, 2)), 1.2, 0.14)

    # ---- eight tile notes climbing the pentatonic, one per beat from 3.0 s
    for j, (t, m) in enumerate(zip(TILES, TILE_NOTES)):
        add("tile", stereo_voice(mallet, m, 1.4, tau=0.42, bright=1.3), t, 0.72 + 0.04 * j, pan=-0.28 + 0.08 * j)
        add("tile", pluck(m + 12, 0.25, tau=0.07, K=4), t, 0.18)

    # ---- the groove, bar by bar
    for bar in range(1, 23):
        lvl = LEVEL[bar]
        drop = lvl == 0
        t0 = bar * BAR
        fill = bar == 4

        # kick (soft, on 1 and 3 with a bouncy push)
        if not drop:
            pat = [(0, 1.0), (8, 0.92)]
            if lvl >= 2:
                pat.append((10, 0.68))
            if lvl >= 3:
                pat.append((15, 0.42))
            for i, g in pat:
                if not thin(t0 + i * S16):
                    k(pos(bar, i), g * (0.8 if lvl == 1 else 1.0))

        # snaps on 2 and 4, later ghosts and a clap layer
        for n_, i in enumerate((4, 12)):
            add("snap", snap(n_), pos(bar, i), 1.0 if not drop else 0.9, pan=0.08)
            if lvl >= 8:
                add("clap", clap(), pos(bar, i), 1.0)
        if lvl >= 5:
            for i, g in ((7, 0.32), (13, 0.38)):
                add("rim", rim(), pos(bar, i), g, pan=-0.25)
        if fill:
            for i, g in ((12, 0.3), (13, 0.42), (14, 0.58), (15, 0.8)):
                add("rim", rim(), pos(bar, i), g, pan=-0.2)

        # shaker (swung 16ths), hats
        if lvl >= 2:
            for i in range(16):
                g = (0.50, 0.30, 0.90, 0.36)[i % 4] * (0.75 if thin(t0 + i * S16) or lvl == 2 else 1.0)
                add("shaker", shaker(i % 3), pos(bar, i), g, pan=0.32)
        if lvl >= 4:
            for i in (2, 6, 10, 14):
                if lvl >= 8:
                    add("hat", hat(True, i % 2), pos(bar, i), 0.9, pan=-0.3)
                elif not thin(t0 + i * S16):
                    add("hat", hat(False, i % 2), pos(bar, i), 0.8, pan=-0.3)

        if lvl >= 7:
            for i in range(1, 16, 2):
                add("hat", hat(False, 1), pos(bar, i), 0.38, pan=-0.3)

        # bass
        for i, off, d16, g in BASS_FULL:
            tg = t0 + i * S16
            c = CH[chord_at(bar, i)]
            g *= {0: 0.82, 1: 0.72, 8: 1.06}.get(lvl, 0.85 if thin(tg) else 1.0)
            add("bass", bass_note(c["bass"] + off, round(d16 * S16, 4)), pos(bar, i), g)

        # electric-piano comp
        if lvl >= 2:
            for i, d16, g in EP_COMP:
                c = CH[chord_at(bar, i)]
                add("ep", ep_chord(c["ep"], round(d16 * S16 + 0.25, 4), bright={7: 1.15, 8: 1.3}.get(lvl, 1.0)), pos(bar, i), g)

        # pad (soft glue; widest and brightest in the big section)
        if lvl >= 3:
            fc = {3: 1100.0, 4: 1300.0, 5: 1500.0, 6: 1800.0, 7: 2100.0, 8: 2600.0}[lvl]
            chords = BARS[bar]
            seg = BAR / len(chords)
            for s, name in enumerate(chords):
                g = {3: 0.8, 4: 0.9, 5: 1.0, 6: 1.1, 7: 1.3, 8: 1.7}[lvl]
                add("pad", pad_chord(CH[name]["pad"], round(seg + 0.14, 4), fc=fc, seed=s), t0 + s * seg, g)

        # hook
        if lvl >= 3 or drop:
            for i, m in HOOK[BARS[bar][0]]:
                if len(BARS[bar]) == 2 and i >= 8:
                    continue
                tg = t0 + i * S16
                if thin(tg) or (drop and i > 6):
                    continue
                add("hook", hook_note(m), pos(bar, i), (1.0 if i % 4 == 0 else 0.85) * (0.8 if drop else 1.0))
                if lvl >= 6:
                    add("hook", hook_note(m + 12), pos(bar, i), {6: 0.30, 7: 0.36}.get(lvl, 0.42))
            if len(BARS[bar]) == 2 and not drop:
                for i, m in ((8, 81), (12, 76)):
                    if not thin(t0 + i * S16):
                        add("hook", hook_note(m), pos(bar, i), 1.0)
                        if lvl >= 6:
                            add("hook", hook_note(m + 12), pos(bar, i), {6: 0.30, 7: 0.36}.get(lvl, 0.42))

        # counter line (long soft high notes) from the second layer on
        if lvl >= 5:
            names = BARS[bar]
            if len(names) == 1:
                notes = CTR[names[0]]
                for j, (i, m) in enumerate(notes):
                    d = (notes[j + 1][0] if j + 1 < len(notes) else 16) - i
                    add("ctr", stereo_voice(mallet, m, d * S16 + 0.2, tau=0.9, bright=0.6), pos(bar, i), 1.0, pan=0.2)
            else:
                for s, name in enumerate(names):
                    add("ctr", stereo_voice(mallet, CTR[name][0][1], 8 * S16 + 0.2, tau=0.9, bright=0.6),
                        pos(bar, 8 * s), 1.0, pan=0.2)

        # quiet 16th arp from the third layer on
        if lvl >= 6:
            seq = [0, 1, 2, 1]
            for i in range(16):
                tones = CH[chord_at(bar, i)]["ep"]
                m = tones[seq[i % 4]] + 12
                add("arp", pluck(m, 0.22, tau=0.09, K=6, c=0.7), pos(bar, i), 1.0 if i % 4 in (0, 3) else 0.65,
                    pan=0.5 if i % 2 else -0.5)

        # bar 4 fill: mallet run up into the full groove
        if fill:
            for i, m in ((8, 76), (10, 78), (12, 81), (14, 83)):
                add("tile", stereo_voice(mallet, m, 0.6, tau=0.25, bright=1.2), pos(bar, i), 0.5 + 0.03 * i)

    # ---- section markers: soft crashes and swooshes into the changes
    for t, g in ((12.0, 0.8), (LIFT, 0.7), (28.8, 0.5), (38.4, 0.4), (48.0, 1.0)):
        add("fx", crash(0.45), t, g)
    for t, d, g in ((12.0, 1.2, 0.9), (LIFT, 0.6, 0.6), (28.8, 0.6, 0.45), (48.0, 1.2, 1.0)):
        add("fx", swoosh(d), t - d, g)

    # ---- the lift (answer lands): a clear arrival wherever in the bar it falls
    lb, li = int(LIFT // BAR), int(round((LIFT % BAR) / S16)) % 16
    if lb in BARS and THIN0 < LIFT < ASK_END_MS / 1000.0:
        name = chord_at(lb, li)
        if not any(abs(tk - LIFT) < 1e-3 for tk in kicks):
            k(LIFT, 1.0)
        add("accent", ep_chord(tuple(CH[name]["ep"]) + tuple(m + 12 for m in CH[name]["ep"]), 0.9, tau=0.4, bright=1.4), LIFT, 0.8)
        if li not in [i for i, _ in HOOK[name]]:
            add("hook", hook_note(HOOK[name][0][1]), LIFT, 1.0)

    # ---- accents on the two early swaps (the pointer's retypes), inside the drop bar
    for t, bells in ((ACCENTS[0], (78, 81)), (ACCENTS[1], (81, 86))):
        k(t, 0.85)
        notes = CH["D"]["ep"]
        add("accent", ep_chord(tuple(notes) + tuple(m + 12 for m in notes), 0.9, tau=0.4, bright=1.5), t, 1.0)
        for m in bells:
            add("accent", stereo_voice(mallet, m, 1.0, tau=0.45, bright=1.4), t, 0.5)
        add("accent", rim(), t, 0.5)

    # ---- the build, 55.2 -> 61.2: everything rises, the swap ticks are the quickening percussion
    d = STOP - BUILD0
    n = int(round(d * SR))
    t = np.arange(n) / SR
    x = t / d
    air = swoosh(round(d, 4), f0=350.0, f1=7500.0, bw=1400.0, seed=81)[:n]
    add("build", air / np.max(np.abs(air)), BUILD0, 1.0)
    ph = 2 * np.pi * np.cumsum(mtof(57) * 2 ** (2.0 * x ** 1.5)) / SR                 # A3 gliding up to A5
    tone = (np.sin(ph) + 0.4 * np.sin(2 * ph) + 0.2 * np.sin(3 * ph)) * x ** 2
    add("build", edges(tone, 0.05, 0.008), BUILD0, 0.16)
    dark = pad_chord((52, 57, 62, 64), round(d, 4), fc=700.0, seed=5)[:n]
    brt = pad_chord((52, 57, 62, 64), round(d, 4), fc=2800.0, seed=5)[:n]
    add("bpad", (dark * (1 - x)[:, None] + brt * x[:, None]) * (0.25 + 0.75 * x ** 1.5)[:, None], BUILD0, 1.0)
    climb = [33, 35, 37, 38, 40, 42, 43, 45, 47, 49]            # A1 up the scale to the leading tone C#3
    for b, m in enumerate(climb):
        tb = BUILD0 + b * BEAT
        sub = 2 if b < 4 else 4
        for j in range(sub):
            add("bass", bass_note(m, round(BEAT / sub * 0.92, 4)), tb + j * BEAT / sub,
                (0.60 + 0.055 * b) * (1.0 if j == 0 else 0.85))
        kt = [0.0] if b < 7 else ([0.0, 0.3] if b < 9 else [0.0, 0.15, 0.3, 0.45])
        for j, o in enumerate(kt):
            k(tb + o, (0.68 + 0.035 * b) * (1.0 if j == 0 else 0.8))
        if b % 2 == 1:
            add("snap", snap(b % 2), tb, 1.0, pan=0.08)
        if b >= 6:
            add("clap", clap(), tb, 0.6 + 0.1 * (b - 6))
        for j in range(4):
            add("shaker", shaker(j % 3), tb + j * S16, (0.5 + 0.08 * b) * (1.0 if j % 2 == 0 else 0.7), pan=0.32)
    for j, tk in enumerate(TICKS):
        frac = j / max(1, len(TICKS) - 1)
        m = PENT[min(len(PENT) - 1, j * len(PENT) // len(TICKS))]
        add("tick", tick_note(m), tk, 0.55 + 0.45 * frac, pan=0.3 if j % 2 else -0.3)
        if tk >= STOP - 2.0:
            add("rim", rim(), tk, 0.55 + 0.35 * frac, pan=0.0)

    return kicks


def sidechain(kicks, depth, rel=0.10):
    env = np.ones(N)
    L = int(0.45 * SR)
    t = np.arange(L) / SR
    shape = 1.0 - depth * np.exp(-t / rel)
    a = int(0.005 * SR)
    shape[:a] = np.linspace(1.0, shape[a], a)
    for tk in kicks:
        i = T(tk)
        n = min(L, N - i)
        env[i:i + n] = np.minimum(env[i:i + n], shape[:n])
    return env[:, None]


def final_chord():
    """62.4 s: one warm, wide D(add9) with a soft sub and a little sparkle, ringing out; a soft two-note
    tag at 64.8 s for the logo; a barely-there low pad under the held breath before it."""
    F = np.zeros((N, 2))
    wet_src = np.zeros((N, 2))
    dur = SILENT - END

    def put(buf, sig, t, g=1.0, pan=0.0):
        i = T(t)
        n = min(len(sig), N - i)
        l, r = pan_gains(pan)
        s = sig if sig.ndim == 2 else np.stack([sig, sig], axis=1)
        buf[i:i + n, 0] += s[:n, 0] * g * l * 1.4142
        buf[i:i + n, 1] += s[:n, 1] * g * r * 1.4142

    # the breath: a very quiet low D drone that swells a touch into the chord
    bl = END - STOP - 0.1
    br = pad_chord((50, 57), round(bl, 4), fc=350.0, seed=7)
    tb = np.arange(len(br)) / SR
    put(F, br / np.max(np.abs(br)) * (tb / bl)[:, None] ** 1.5, STOP + 0.1, 0.010)

    notes = (50, 57, 62, 66, 69, 76)
    n = int(dur * SR)
    t = np.arange(n) / SR
    bright = pad_chord(notes, round(dur, 4), fc=2400.0, seed=3)[:n]
    dark = pad_chord(notes, round(dur, 4), fc=800.0, seed=3)[:n]
    x = np.clip(t / 2.0, 0, 1)[:, None]
    pad = (bright * (1 - x) + dark * x) * np.exp(-t / 2.3)[:, None]
    pad[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))[:, None]
    pad /= np.max(np.abs(pad))
    put(F, pad, END, 0.42)
    put(F, ep_chord((62, 66, 69, 74, 76), round(dur, 4), tau=1.6, bright=1.2), END, 1.0)
    for m in (62, 69, 78):
        put(F, hook_note(m, 0.6), END, 0.16)
    sub = np.sin(2 * np.pi * mtof(38) * t) * np.exp(-t / 1.3)
    put(F, edges(sub, 0.012, 0.2), END, 0.42)
    put(F, kick(), END, 0.30)
    for j, (dt, m, p) in enumerate(((0.0, 90, -0.4), (0.12, 93, 0.4), (0.24, 98, -0.2), (0.39, 88, 0.5),
                                    (0.54, 95, -0.5), (0.72, 102, 0.2), (0.93, 98, -0.3), (1.2, 105, 0.35))):
        sp = stereo_voice(mallet, m, 1.4, tau=0.4, bright=0.8)
        put(F, sp, END + dt, 0.11 * (0.86 ** j), pan=p)
        put(wet_src, sp, END + dt, 0.11 * (0.86 ** j), pan=p)
    # logo tag: A6 then D7, soft
    for dt, m, g, p in ((0.0, 93, 0.20, -0.15), (0.15, 98, 0.17, 0.15)):
        tg = stereo_voice(mallet, m, 1.6, tau=0.5, bright=0.9)
        put(F, tg, TAG + dt, g, pan=p)
        put(wet_src, tg, TAG + dt, g * 0.8, pan=p)
    wet_src += 0.6 * F
    return F, wet_src


def main():
    t_start = time.time()
    kicks = build()
    print(f"  events placed in {time.time() - t_start:.1f}s; lift at {LIFT:.3f}s")

    # ---- balance: calibrate each stem by measurement, not by guess
    ref = slice(T(43.2), T(48.0))      # bars 18-19, every groove layer present
    rms_target = {"bass": -16.0, "hook": -20.0, "ep": -23.5, "pad": -28.0, "ctr": -29.0, "arp": -29.0}
    peak_target = {"kick": -5.0, "snap": -9.5, "clap": -13.0, "rim": -15.0, "shaker": -17.5, "hat": -17.5,
                   "fx": -19.0, "tile": -8.0, "accent": -6.5, "room": -52.0, "bed": -42.0,
                   "tick": -7.0, "build": -13.0, "bpad": -15.0}
    for name, buf in STEMS.items():
        if name in rms_target:
            cur = rms_db(buf[ref])
            buf *= db(rms_target[name] - cur)
        else:
            buf *= db(peak_target[name]) / float(np.max(np.abs(buf)))

    # ---- sidechain-style ducking under the kick
    for name, depth in (("bass", 0.42), ("pad", 0.40), ("bpad", 0.30), ("ep", 0.22), ("arp", 0.25), ("ctr", 0.2), ("hook", 0.10)):
        STEMS[name] *= sidechain(kicks, depth).astype(np.float32)

    # ---- delay on the melodic plucks
    for name, g in (("hook", 0.22), ("tile", 0.30), ("accent", 0.25)):
        STEMS[name] = STEMS[name] + (g * feedback_delay(STEMS[name], 0.75 * BEAT, fb=0.38, repeats=4)).astype(np.float32)

    # ---- cut dead at 61.2: everything is cut (6 ms fade), only the reverb tail survives
    mute = np.ones(N)
    a, b = T(STOP - 0.006), T(STOP)
    mute[a:b] = 0.5 + 0.5 * np.cos(np.pi * np.arange(b - a) / (b - a))
    mute[b:] = 0.0
    dry = np.zeros((N, 2))
    send = np.zeros((N, 2))
    sends = {"kick": 0.0, "bass": 0.0, "snap": 0.16, "clap": 0.2, "rim": 0.15, "shaker": 0.05, "hat": 0.05,
             "hook": 0.24, "ep": 0.22, "pad": 0.3, "ctr": 0.5, "arp": 0.3, "fx": 0.3, "tile": 0.5, "accent": 0.4,
             "room": 0.0, "bed": 0.3, "tick": 0.3, "build": 0.25, "bpad": 0.3}
    for name, buf in STEMS.items():
        buf *= mute[:, None].astype(np.float32)
        dry += buf
        send += buf * sends[name]
    wet = convolve_reverb(send, make_ir(rt60=1.3, seed=11))
    tail = np.ones(N)
    tail[b:] = db(-9.0 * np.arange(N - b) / SR)          # the tail thins quickly: a held breath
    wet *= tail[:, None]

    F, fsrc = final_chord()
    fwet = convolve_reverb(fsrc, make_ir(rt60=2.2, seed=12, hi=9000.0))
    bus = dry + 0.9 * wet + db(-7.5) * (F + 0.55 * fwet)

    # ---- gentle width control: mono below ~140 Hz, a touch of extra side above (no zero-phase filter on the
    #      mid channel: it would pre-ring ahead of the kick)
    mid = (bus[:, 0] + bus[:, 1]) * 0.5
    side = (bus[:, 0] - bus[:, 1]) * 0.5
    side = fft_filter(side, lambda fr: g_hp(fr, 140.0, 2) * 1.12, pad=False)
    bus = np.stack([mid + side, mid - side], axis=1)

    # ---- end shape: ring out, fully silent from SILENT
    env = np.ones(N)
    f0, f1 = T(SILENT - 1.5), T(SILENT)
    env[f0:f1] = 0.5 + 0.5 * np.cos(np.pi * np.arange(f1 - f0) / (f1 - f0))
    env[f1:] = 0.0
    bus *= env[:, None]
    bus -= bus.mean(axis=0, keepdims=True) * (env[:, None] > 0)

    y = master(bus, target_lufs=-14.0)
    y *= (env[:, None] > 0)
    assert y.shape == (N, 2)
    out = os.path.join(audio_dir(), "music.wav")
    write_wav(out, y, bits=24)

    # ---- per-stem report (pre-master levels, dBFS RMS over a window where the stem plays)
    print("  stem RMS in bars 18-19 (43.2-48.0s), dBFS, pre-master:")
    for name in ("kick", "bass", "hook", "ep", "pad", "ctr", "arp", "snap", "rim", "shaker", "hat"):
        print(f"    {name:7s} {rms_db(STEMS[name][ref]):7.1f}   peak {to_db(np.max(np.abs(STEMS[name][ref]))):6.1f}")
    print(f"  wrote {out}  ({N} samples, {N / SR:.3f}s) in {time.time() - t_start:.1f}s")


if __name__ == "__main__":
    main()
