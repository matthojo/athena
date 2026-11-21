#!/usr/bin/env python3
"""Athena cut 4 music bed. 64.800 s (27 bars), 48 kHz stereo, 100 BPM, bar 1 beat 1 at t=0.

D major, warm and bouncy. Everything is synthesised with numpy.
Run: python3 music.py   ->  $FILM/audio/music.wav

Cut 4 timeline (PLAN.md): opening 0-7.2 (orb 1.2, tiles every half beat 3.0-5.1), dive 7.2, Home 9.6,
Ask 14.4 (thin until the lift at 19.2), Saved 24.0, Team 31.2 (Penny: hook muted for bar 13, rim fill back),
Music 36.0, Habits 40.8, one-beat dropout 42.6-43.2 (hook only), pull-back hit 43.2, rotation 48.0
(drop bar, then the build 50.4-56.4 with a tick on every swap, its percussion on the swaps' own steps),
dead cut 56.4, final chord 57.6 ("Great"), logo tag 59.4, digital silence from 64.6.
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
LIFT_MS = 19200      # Ask section: groove lifts back to full when the answer lands (snapped to a beat)
THIN_START_MS = 14400
ASK_END_MS = 24000

# ------------------------------------------------------------------ grid
BPM = 100
BEAT = 60.0 / BPM          # 0.6 s
BAR = 4 * BEAT             # 2.4 s
S16 = BEAT / 4             # 0.15 s
SWING = 0.020              # off-16ths land 20 ms late: a little bounce; beats stay dead on the grid
DUR = 64.8
N = int(round(DUR * SR))
LIFT = round(LIFT_MS / 1000.0 / BEAT) * BEAT
LIFT = min(max(LIFT, THIN_START_MS / 1000.0 + BEAT), ASK_END_MS / 1000.0)
THIN0 = THIN_START_MS / 1000.0
ORB = 1.2                   # the orb pops under the pointer's press
TILES = [3.0 + 0.5 * BEAT * k for k in range(8)]   # one every half beat, 3.0 to 5.1
TILE_NOTES = [69, 71, 74, 76, 78, 81, 83, 86]   # A4 B4 D5 E5 F#5 A5 B5 D6: D major pentatonic up to the tonic
HOME = 9.6                  # the dive lands: full groove
SAVED = 24.0
TEAM = 31.2                 # Penny's beat: hook muted for this bar, a rim fill hands back to the groove
MUSIC = 36.0
DROPOUT = (42.6, 43.2)      # one beat, hook only
PULL = 43.2                 # the pull-back reveal lands on this downbeat
ROT = 48.0                  # the wall goes, the closing line types on
BUILD0 = 50.4               # the rise starts; a pitched tick on every swap from here on
STOP = 56.4                 # cut dead
END = 57.6                  # final chord ("Great" is pressed)
TAG = 59.4                  # logo tag (lockup)
SILENT = 64.6               # digital silence from here
BED_AT, BED_RMS = 0.1, -30.0  # the opening pad: starts swelling at 0.1 s, -30 dBFS RMS over 0.9-2.4 s
AIR_DB, PRESENCE_DB, LOWCUT_DB = 8.0, 7.5, 5.0     # phone voicing: shelf >4.5 kHz, bell 2.8 kHz, less below 140 Hz
BUILD_BASS = (0.45, 0.03)     # rotation build: bass climb gain a + b*beat
BUILD_KICK = (0.60, 0.015)    # rotation build: kick gain a + b*beat (roll hits x0.6)
BUILD_RIDE = (-4.0, 0.5)      # the build's bed ridden from -4 to +0.5 LU against the pull-back (see ride_build); r2: ends above it
CHORD_DB = float(os.environ.get("CHORD_DB", -4.5))   # final chord bus level (cut 3: -7.5; r1 tried -5.5: the master put it back)
PENT = [74, 76, 78, 81, 83, 86, 88, 90, 93, 95, 98, 100]     # D major pentatonic, D5 up to E7
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "swaps.json")) as _f:
    SWAP_LIST = json.load(_f)
SWAPS = [float(q["at"]) / 1000.0 for q in SWAP_LIST]
RETYPES = [float(q["at"]) / 1000.0 for q in SWAP_LIST if q.get("how") == "retype"]
ACCENTS = RETYPES[:2] if len(RETYPES) >= 2 else [49.2, 49.8]   # the pointer's two retypes


def snap_step(t):
    """Nearest point on the build's musical steps (16ths and 16th triplets, both anchored to the bar).
    The picture rounds a swap to a frame; the audio stays exactly on the grid."""
    c = [round(t / S16) * S16, round(t / (BEAT / 6)) * (BEAT / 6)]
    best = min(c, key=lambda v: abs(v - t))
    return best if abs(best - t) <= 0.02 else t


TICKS = [snap_step(t) for t in SWAPS if BUILD0 - 0.02 <= t < STOP - 1e-3]


def build_step(b):
    """Subdivision (s) of build beat b, read from the swap ticks inside that beat (quarter if one or none)."""
    tb = BUILD0 + b * BEAT
    ins = sorted(t for t in TICKS if tb - 1e-3 <= t < tb + BEAT - 1e-3)
    if len(ins) < 2:
        return BEAT
    return min(BEAT, min(y - x for x, y in zip(ins, ins[1:])))


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
    amps = 1.0 / k ** 1.15                       # more 2nd-5th harmonic than cut 3: the line reads on a phone
    taus = np.where(k == 1, 0.55, 0.24 / (1.0 + 0.35 * (k - 1)))
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
def kick(soft=1.0, short=False):
    """Soft round kick. short=True: a choked 0.12 s version for rolls, so fast hits don't pile up low end."""
    n = int((0.12 if short else 0.36) * SR)
    t = np.arange(n) / SR
    f = 49.0 + 75.0 * np.exp(-t / 0.028)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / (0.045 if short else 0.13))
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

# bar -> chord(s); two entries = two beats each.
# 1-3 opening and dive | 4-5 Home | 6-7 Ask (thin) | 8-9 the lift | 10-12 Saved | 13-14 Team | 15-16 Music
# 17 Habits, walking up B-C#-D under the dropout | 18-19 pull-back (tonic on the hit) | 20 the drop
BARS = {1: ["D"], 2: ["Bm"], 3: ["G", "A"],
        4: ["D"], 5: ["Bm"], 6: ["G"], 7: ["A"], 8: ["D"], 9: ["Bm"],
        10: ["G"], 11: ["A"], 12: ["G", "A"], 13: ["D"], 14: ["Bm"], 15: ["G"], 16: ["A"],
        17: ["Bm", "A/C#"], 18: ["D"], 19: ["G", "A"], 20: ["D"]}
# 1 light, 2 fill, 3 full (+hats), 4 louder hats, 5 +counter line and rim ghosts, 6 +arp and hook octave,
# 7 +16th hats, brighter pad, 8 the biggest; 0 = the drop that opens the build
LEVEL = {1: 1, 2: 1, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3,
         10: 4, 11: 4, 12: 4, 13: 5, 14: 5, 15: 6, 16: 6, 17: 7, 18: 8, 19: 8, 20: 0}
FILL_BARS = (3, 13)          # rim fill into the next bar (the dive; Penny's bar back into the groove)
LAST_BAR = max(BARS)


def chord_at(bar, i16):
    c = BARS[bar]
    return c[0] if len(c) == 1 or i16 < 8 else c[1]


def thin(t):
    return THIN0 <= t < LIFT - 1e-6


def hook_muted(t):
    """Penny's bar: the hook steps aside for her voice."""
    return TEAM - 1e-6 <= t < TEAM + BAR - 1e-6


BASS_FULL = [(0, 0, 2.0, 1.0), (3, 0, 0.9, 0.8), (6, 12, 0.9, 0.72), (8, 0, 2.0, 0.95), (11, 0, 0.9, 0.8), (14, 7, 1.0, 0.8)]
EP_COMP = [(0, 3.5, 1.0), (6, 1.4, 0.7), (10, 2.6, 0.85)]


def build():
    kicks = []

    def k(t, g=1.0, short=False):
        add("kick", kick(short=short), t, g)
        kicks.append(t)

    # ---- bar 0: room tone, a very quiet bed, a soft pop when the orb appears
    n = T(4.2)
    room = fft_filter(_noise(n, 5, 2), lambda fr: g_lp(fr, 450.0, 1) * g_hp(fr, 70.0, 2))
    tt = np.arange(n) / SR
    room *= (np.clip(tt / 0.6, 0, 1) * np.clip((4.2 - tt) / 1.6, 0, 1))[:, None]
    add("room", room, 0.0)
    # a quiet D pad swells in from 0.3 s so the film never opens on dead air (r1 review #7); it hands over to
    # the groove and the tiles by ~4.5 s. Level set by measurement in main() (BED_RMS over 0.9-2.4 s).
    bl = 4.4
    bed = pad_chord((50, 57, 62, 66), bl, fc=900.0, seed=1)
    tb = np.arange(len(bed)) / SR
    swell = np.sin(0.5 * np.pi * np.clip(tb / 0.7, 0, 1)) ** 2 * np.clip((bl - tb) / 1.6, 0, 1) ** 1.5
    add("bed", bed * swell[:, None], BED_AT)
    add("tile", stereo_voice(mallet, 74, 0.9, tau=0.22, bright=1.2), ORB, 0.26)
    add("tile", stereo_voice(mallet, 86, 0.5, tau=0.10, bright=1.0), ORB, 0.10)
    add("tile", bass_note(50, 0.25)[:, None] * np.ones((1, 2)), ORB, 0.14)

    # ---- eight tile notes climbing the pentatonic, one every half beat from 3.0 s
    for j, (t, m) in enumerate(zip(TILES, TILE_NOTES)):
        add("tile", stereo_voice(mallet, m, 1.0, tau=0.30, bright=1.3), t, 0.62 + 0.04 * j, pan=-0.28 + 0.08 * j)
        add("tile", pluck(m + 12, 0.25, tau=0.07, K=4), t, 0.18)

    # ---- the groove, bar by bar
    for bar in range(1, LAST_BAR + 1):
        lvl = LEVEL[bar]
        drop = lvl == 0
        t0 = bar * BAR
        fill = bar in FILL_BARS

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
        if lvl >= 5 and not fill:
            for i, g in ((7, 0.32), (13, 0.38)):
                add("rim", rim(), pos(bar, i), g, pan=-0.25)
        if fill:
            for i, g in ((12, 0.3), (13, 0.42), (14, 0.58), (15, 0.8)):
                add("rim", rim(), pos(bar, i), g, pan=-0.2)

        # shaker (swung 16ths), hats (from the full groove on: the 2-8 kHz a phone speaker can play)
        if lvl >= 2:
            for i in range(16):
                g = (0.50, 0.30, 0.90, 0.36)[i % 4] * (0.75 if thin(t0 + i * S16) or lvl == 2 else 1.0)
                add("shaker", shaker(i % 3), pos(bar, i), g, pan=0.32)
        if lvl >= 3:
            for i in (2, 6, 10, 14):
                if lvl >= 8:
                    add("hat", hat(True, i % 2), pos(bar, i), 0.9, pan=-0.3)
                elif not thin(t0 + i * S16):
                    add("hat", hat(False, i % 2), pos(bar, i), 0.55 if lvl == 3 else 0.8, pan=-0.3)
        if lvl >= 7:
            for i in range(1, 16, 2):
                add("hat", hat(False, 1), pos(bar, i), 0.38, pan=-0.3)

        # bass
        for i, off, d16, g in BASS_FULL:
            tg = t0 + i * S16
            c = CH[chord_at(bar, i)]
            g *= {0: 0.68, 1: 0.72, 8: 1.06}.get(lvl, 0.85 if thin(tg) else 1.0)
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
                if thin(tg) or hook_muted(tg) or (drop and i > 6):
                    continue
                add("hook", hook_note(m), pos(bar, i), (1.0 if i % 4 == 0 else 0.85) * (0.8 if drop else 1.0))
                if lvl >= 6:
                    add("hook", hook_note(m + 12), pos(bar, i), {6: 0.30, 7: 0.36}.get(lvl, 0.42))
            if len(BARS[bar]) == 2 and not drop:
                tail = [(8, 81), (12, 76)] + ([(14, 81)] if t0 + BAR > DROPOUT[0] > t0 else [])
                for i, m in tail:
                    if not thin(t0 + i * S16) and not hook_muted(t0 + i * S16):
                        add("hook", hook_note(m), pos(bar, i), 0.65 if DROPOUT[0] - 1e-6 <= t0 + i * S16 < DROPOUT[1] else 1.0)
                        if lvl >= 6:
                            add("hook", hook_note(m + 12), pos(bar, i), {6: 0.30, 7: 0.36}.get(lvl, 0.42))

        # counter line (long soft high notes) from the second layer on
        if lvl >= 5:
            names = BARS[bar]
            if len(names) == 1:
                notes = CTR[names[0]]
                for j, (i, m) in enumerate(notes):
                    d = (notes[j + 1][0] if j + 1 < len(notes) else 16) - i
                    add("ctr", stereo_voice(mallet, m, d * S16 + 0.2, tau=0.9, bright=0.6), pos(bar, i),
                        0.6 if hook_muted(t0) else 1.0, pan=0.2)
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

        # the dive's fill: mallet run up into the full groove
        if bar == FILL_BARS[0]:
            for i, m in ((8, 76), (10, 78), (12, 81), (14, 83)):
                add("tile", stereo_voice(mallet, m, 0.6, tau=0.25, bright=1.2), pos(bar, i), 0.5 + 0.03 * i)

    # ---- section markers: soft crashes into the changes, short swooshes (they end on the downbeat)
    for t, g in ((HOME, 0.8), (LIFT, 0.7), (SAVED, 0.5), (MUSIC, 0.4), (PULL, 1.0)):
        add("fx", crash(0.45), t, g)
    # (none into the lift: the Ask pan already has its whoosh, a second swish on one move muddied it; the
    #  pull-back's is a cue, whoosh_big)
    for t, d, g in ((HOME, 0.6, 0.9), (SAVED, 0.6, 0.45)):
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

    # ---- the build, BUILD0 -> STOP: everything rises; the percussion follows the swaps' own steps
    #      (quarters, 8th triplets, 16ths, 16th triplets), so the ticks never flam against it
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
    add("bpad", (dark * (1 - x)[:, None] + brt * x[:, None]) * (0.5 + 0.5 * x)[:, None], BUILD0, 1.0)   # r1: no hole at 50.4
    climb = [33, 35, 37, 38, 40, 42, 43, 45, 47, 49]            # A1 up the scale to the leading tone C#3
    nb = int(round(d / BEAT))
    for b in range(nb):
        m = climb[min(b, len(climb) - 1)]
        tb = BUILD0 + b * BEAT
        step = build_step(b)
        quarter = step >= BEAT - 1e-6
        sext = step <= BEAT / 6 + 1e-6
        trip = not quarter and not sext and abs(step - BEAT / 3) < 1e-3
        sub = 2 if quarter else (3 if trip or sext else 4)
        for j in range(sub):
            add("bass", bass_note(m, round(BEAT / sub * 0.92, 4)), tb + j * BEAT / sub,
                (BUILD_BASS[0] + BUILD_BASS[1] * b) * (1.0 if j == 0 else 0.8))
        # kick: quarters, then 8ths, then the roll on the 16th-triplet steps (the last beat every step)
        if quarter or trip:
            kt = [0.0]
        elif not sext:
            kt = [0.0, BEAT / 2]
        elif b < nb - 1:
            kt = [0.0, BEAT / 3, 2 * BEAT / 3]
        else:
            kt = [j * BEAT / 6 for j in range(6)]
        for j, o in enumerate(kt):
            k(tb + o, (BUILD_KICK[0] + BUILD_KICK[1] * b) * (1.0 if j == 0 else 0.6), short=sext)   # roll hits x0.6
        if b % 2 == 1:
            add("snap", snap(b % 2), tb, 1.0, pan=0.08)
        if b >= nb - 4:
            add("clap", clap(), tb, 0.5 + 0.07 * (b - (nb - 4)))
        sh = S16 if step >= BEAT - 1e-6 else step
        for j in range(int(round(BEAT / sh))):
            add("shaker", shaker(j % 3), tb + j * sh, (0.8 + 0.05 * b) * (1.0 if j % 2 == 0 else 0.7), pan=0.32)
    for j, tk in enumerate(TICKS):
        frac = j / max(1, len(TICKS) - 1)
        m = PENT[min(len(PENT) - 1, j * len(PENT) // len(TICKS))]
        add("tick", tick_note(m), tk, 0.55 + 0.45 * frac, pan=0.3 if j % 2 else -0.3)
        if tk >= STOP - 2 * BEAT - 1e-3:
            add("rim", rim(), tk, 0.3 + 0.2 * frac, pan=0.0)

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


def ride_build(bus):
    """Mix automation over the rotation build (r1 review #6): the swaps' percussion gets denser by itself, so the
    bed is ridden to a gentle ramp instead, from BUILD_RIDE[0] to BUILD_RIDE[1] LU relative to the pull-back.
    The start no longer opens in a hole and the end stays under the payoff chord. Measured, not guessed: a
    0.6 s K-weighted loudness of the bus, the gain smoothed over a beat and a half and held within +-8 dB."""
    from scipy import signal
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]
    i0, i1 = T(BUILD0 - 0.6), T(STOP)
    ref = slice(T(PULL), T(ROT))
    seg = np.concatenate([bus[ref], bus[i0:i1]])
    y = signal.lfilter(b2, a2, signal.lfilter(b1, a1, seg, axis=0), axis=0)
    p = (y ** 2).sum(axis=1)
    nr = ref.stop - ref.start
    L_ref = 10 * np.log10(p[:nr].mean() + 1e-15)
    pb = p[nr:]
    W = T(0.6)
    cs = np.concatenate([[0.0], np.cumsum(pb)])
    idx = np.arange(len(pb))
    lo, hi = np.clip(idx - W // 2, 0, len(pb)), np.clip(idx + W // 2, 0, len(pb))
    L = 10 * np.log10((cs[hi] - cs[lo]) / np.maximum(hi - lo, 1) + 1e-15) - L_ref
    t = (idx + i0) / SR
    x = np.clip((t - BUILD0) / (STOP - BUILD0), 0, 1)
    target = BUILD_RIDE[0] + (BUILD_RIDE[1] - BUILD_RIDE[0]) * x
    g = np.clip(target - L, -8.0, 8.0)
    S = T(0.9)
    k = np.hanning(S)
    g = np.convolve(g, k / k.sum(), mode="same")
    fade = np.clip((t - (BUILD0 - 0.6)) / 0.6, 0, 1)            # ease in over the beat before the build
    g *= fade
    out = bus.copy()
    out[i0:i1] *= db(g)[:, None]
    print(f"  build ride: gain {g[T(0.6):].min():+.1f} to {g[T(0.6):].max():+.1f} dB (start {g[T(0.6) + T(0.3)]:+.1f}, "
          f"end {g[-T(0.3)]:+.1f})")
    return out


def final_chord():
    """END (57.6 s, "Great"): one warm, wide D(add9) with a sub and a sparkle, ringing out under the lockup;
    a soft two-note tag at TAG (59.4 s) for the logo; a barely-there low pad under the held breath before it."""
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
    pad = (bright * (1 - x) + dark * x) * np.exp(-t / 3.0)[:, None]
    pad[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))[:, None]
    pad /= np.max(np.abs(pad))
    put(F, pad, END, 0.42)
    # a quick upward strum (18 ms a note): warmer than a block chord, and the onsets don't stack into one peak
    for j, m in enumerate((62, 66, 69, 74, 76)):
        put(F, stereo_voice(mallet, m, round(dur - 0.1, 4), spread=4.0, tau=1.6, bright=1.2), END + 0.018 * j, 1.0 / 5,
            pan=-0.3 + 0.15 * j)
    for j, m in enumerate((62, 69, 78)):
        put(F, hook_note(m, 0.6), END + 0.025 * j, 0.16)
    sub = np.sin(2 * np.pi * mtof(38) * t) * np.exp(-t / 1.3)
    put(F, edges(sub, 0.012, 0.2), END, 0.5)
    put(F, kick(), END, 0.2)
    for j, (dt, m, p) in enumerate(((0.0, 90, -0.4), (0.12, 93, 0.4), (0.24, 98, -0.2), (0.39, 88, 0.5),
                                    (0.54, 95, -0.5), (0.72, 102, 0.2), (0.93, 98, -0.3), (1.2, 105, 0.35))):
        sp = stereo_voice(mallet, m, 1.4, tau=0.4, bright=0.8)
        put(F, sp, END + dt, 0.2 * (0.86 ** j), pan=p)
        put(wet_src, sp, END + dt, 0.2 * (0.86 ** j), pan=p)
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
    ref = slice(T(43.2), T(48.0))      # bars 18-19 (the pull-back), every groove layer present
    rms_target = {"bass": -19.5, "hook": -20.0, "ep": -23.5, "pad": -28.0, "ctr": -29.0, "arp": -29.0}
    peak_target = {"kick": -6.5, "snap": -9.5, "clap": -13.0, "rim": -15.0, "shaker": -14.0, "hat": -14.0,
                   "fx": -19.0, "tile": -8.0, "accent": -6.5, "room": -52.0,
                   "tick": -9.0, "build": -13.0, "bpad": -16.5}
    for name, buf in STEMS.items():
        if name == "bed":
            buf *= db(BED_RMS - rms_db(buf[T(0.9):T(2.4)]))
        elif name in rms_target:
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

    # ---- the one-beat dropout before the pull-back: only the hook (and its echoes) and the riser are left
    keep = {"hook", "fx", "tick", "accent", "build", "bpad"}
    hole = np.ones(N)
    a, b = T(DROPOUT[0] - 0.01), T(DROPOUT[0])
    hole[a:b] = 0.5 + 0.5 * np.cos(np.pi * np.arange(b - a) / (b - a))
    a, b = b, T(DROPOUT[1] - 0.002)
    hole[a:b] = 0.0
    hole[b:T(DROPOUT[1])] = np.linspace(0.0, 1.0, T(DROPOUT[1]) - b)
    for name, buf in STEMS.items():
        if name not in keep:
            buf *= hole[:, None].astype(np.float32)

    # ---- cut dead at STOP: everything is cut (6 ms fade), only the reverb tail survives
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
    bus = dry + 0.9 * wet
    # Home and Ask sit 1.5 dB under the rest, so the level has somewhere to go (review: sound #5)
    trim = np.ones(N)
    for t_a, t_b in ((HOME, ASK_END_MS / 1000.0),):
        r = T(0.05)
        trim[T(t_a):T(t_b)] = db(-1.5)
        trim[T(t_a) - r:T(t_a)] = np.linspace(1.0, db(-1.5), r)
        trim[T(t_b):T(t_b) + r] = np.linspace(db(-1.5), 1.0, r)
    bus *= trim[:, None]
    bus += db(CHORD_DB) * (F + 0.55 * fwet)

    # ---- gentle width control: mono below ~140 Hz, a touch of extra side above (no zero-phase filter on the
    #      mid channel: it would pre-ring ahead of the kick)
    mid = (bus[:, 0] + bus[:, 1]) * 0.5
    side = (bus[:, 0] - bus[:, 1]) * 0.5
    side = fft_filter(side, lambda fr: g_hp(fr, 140.0, 2) * 1.12, pad=False)
    bus = np.stack([mid + side, mid - side], axis=1)

    # ---- phone-speaker voicing (AIR_DB, PRESENCE_DB, LOWCUT_DB): a shelf above ~4.5 kHz, presence around 2.8 kHz,
    #      less below ~140 Hz (a phone can't play it, and it eats the limiter). All broad first-order shapes.
    def shelf(fr, fc, gdb):
        A = db(gdb)
        return np.sqrt((1.0 + (A * fr / fc) ** 2) / (1.0 + (fr / fc) ** 2))

    def bell(fr, fc, gdb, q=0.8):
        return 1.0 + (db(gdb) - 1.0) / (1.0 + (q * (fr / fc - fc / np.maximum(fr, 1.0))) ** 2)

    bus = fft_filter(bus, lambda fr: shelf(fr, 4500.0, AIR_DB) * bell(fr, 2800.0, PRESENCE_DB, q=0.7) / shelf(fr, 140.0, LOWCUT_DB),
                     pad=False)

    bus = ride_build(bus)      # after the voicing EQ, so it rides what the master will hear

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
