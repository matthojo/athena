#!/usr/bin/env python3
"""Athena cut 6 music bed. 86.400 s (36 bars), 48 kHz stereo, 100 BPM, bar 1 beat 1 at t=0.

D major, playful and warm: a children's-TV / indie app-ad band, all synthesised with numpy but modelled on
acoustic instruments (audiolib's models): the hook on kalimba with a glockenspiel double, ukulele strums on the
groove, felt-piano chords, a plucked upright bass, celesta counter-lines, a marimba arp, a quiet reed organ for
glue; brushed snare, egg shaker, finger snaps and soft claps, woodblocks, a felt bass drum; mark-tree sparkles
instead of crashes and soft breathy air instead of risers.
Run: python3 music.py   ->  $FILM/audio/music.wav

Cut 6 timeline (PLAN.md): opening 0-7.2 (orb 1.2, tiles every half beat 3.0-5.1), dive 7.2, Home 9.6,
Ask 14.4 (thin until the lift at 19.2), Saved 24.0, Team 1 "Tell me when" 31.2 (two light, curious bars, a wood
fill back), Music 36.0, Habits 40.8, Team 2 43.2 (Penny searching: a woodblock tick-tock and a scanning marimba
until the price steps down on the STEP downbeat, 48.0 or 45.6, where the full groove comes back on the tonic),
Team 3 hire 50.4 (an easy groove under the typing; the warm chord at ARRIVE, 55.2), the Team page held 57.6 (one
calm bar), Flows 60.0 (one light bar for the suggestion card, then a little ascending kalimba run onto FLOWSTEP,
62.4, as the flow's steps arrive; a lifted bar after it), one-beat dropout 64.2-64.8 (hook only), pull-back hit
64.8, rotation 69.6 (drop bar, then the build 72.0-78.0 with a wooden tock on every swap, its percussion on the
swaps' own steps), dead cut 78.0, final chord 79.2 ("Great"), logo tag 81.0, digital silence from 86.2.

STEP, ARRIVE and FLOWSTEP follow $FILM/film-events.json (work.stepDown, hire.arrive, flows.steps) when it exists:
re-run this file if one moves. Everything else the picture can move is a cue (cues.py + mix.py).
"""
import json
import os
import sys
import time
from functools import lru_cache

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audiolib
from audiolib import (SR, audio_dir, film_dir, db, to_db, mtof, rms_db, write_wav, g_lp, g_hp, fft_filter, edges,
                      pan_gains, make_ir, convolve_reverb, feedback_delay, master)
from audiolib import (kalimba, glock, celesta, marimba, wood, felt_piano, uke_string, upright_bass, felt_kick,
                      low_tom, brush_tap, brush_swish, shaker_hit, finger_snap, soft_clap, mark_tree, breath_air,
                      reed_chord, struck_bar)

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
DUR = 86.4
N = int(round(DUR * SR))
LIFT = round(LIFT_MS / 1000.0 / BEAT) * BEAT
LIFT = min(max(LIFT, THIN_START_MS / 1000.0 + BEAT), ASK_END_MS / 1000.0)
THIN0 = THIN_START_MS / 1000.0
ORB = 1.2                   # the orb pops under the pointer's press
TILES = [3.0 + 0.5 * BEAT * k for k in range(8)]   # one every half beat, 3.0 to 5.1
TILE_NOTES = [69, 71, 74, 76, 78, 81, 83, 86]   # A4 B4 D5 E5 F#5 A5 B5 D6: D major pentatonic up to the tonic
HOME = 9.6                  # the dive lands: full groove
SAVED = 24.0
TEAM1 = 31.2                # "Tell me when": two light, curious bars; a wood fill hands back to the groove
MUSIC = 36.0
HABITS = 40.8
TEAM2 = 43.2                # Penny works: the groove thins to a ticking, searching bed
HIRE = 50.4                 # the job typed; the new character arrives at ARRIVE
TEAMPAGE = 57.6             # the Team page held, the new face beside the others: one calm bar
FLOWS = 60.0                # the Flows page: the suggestion card (one light bar)
DROPOUT = (64.2, 64.8)      # one beat, hook only
PULL = 64.8                 # the pull-back reveal lands on this downbeat
ROT = 69.6                  # the wall goes, the closing line types on
BUILD0 = 72.0               # the rise starts; a pitched wooden tock on every swap from here on
STOP = 78.0                 # cut dead
END = 79.2                  # final chord ("Great" is pressed)
TAG = 81.0                  # logo tag (lockup)
SILENT = 86.2               # digital silence from here


def _film_event(key):
    try:
        with open(os.path.join(film_dir(), "film-events.json")) as f:
            v = json.load(f).get(key)
        return v / 1000.0 if isinstance(v, (int, float)) else None
    except (OSError, ValueError, AttributeError):
        return None


# the price steps down under the target: a downbeat, 48.0 (default) or 45.6 (work.stepDown decides)
_s = _film_event("work.stepDown")
STEP = 45.6 if _s is not None and abs(_s - 45.6) < abs(_s - 48.0) else 48.0
# the new character arrives: a beat between 52.8 and 56.4 (hire.arrive decides), default 55.2
_a = _film_event("hire.arrive")
ARRIVE = min(max(round((_a if _a is not None else 55.2) / BEAT) * BEAT, 52.8), 56.4)
# Penny's working line shows: the ticking, scanning figure starts with it (work.working, on a 16th), default 44.4
_w = _film_event("work.working")
WORK = round((_w if _w is not None and TEAM2 <= _w < STEP - BEAT else 44.4) / (BEAT / 4)) * (BEAT / 4)
# the flow's steps arrive: the kalimba run lands here (flows.steps, on a 16th between 61.2 and 63.6), default 62.4
_f = _film_event("flows.steps")
if _f is None:
    _f = _film_event("flows.step1")
FLOWSTEP = min(max(round((_f if _f is not None else 62.4) / S16) * S16, 61.2), 63.6)
BED_AT, BED_RMS = 0.1, -33.0  # the opening reed bed: starts swelling at 0.1 s, -33 dBFS RMS over 0.9-2.4 s
# phone voicing (cut 5: 9.5 / 8.5 / 5.0, no mud cut): the wooden instruments pile up at 250-500 Hz, so a broad
# dip there (MUD_DB) and a bell / shelf a little under cut 5's: brighter than the raw band, a touch softer than cut 5
AIR_DB, PRESENCE_DB, LOWCUT_DB, MUD_DB = 8.0, 8.0, 5.0, -3.0
BUILD_BASS = (0.45, 0.03)     # rotation build: bass climb gain a + b*beat
BUILD_KICK = (0.60, 0.015)    # rotation build: kick gain a + b*beat (roll hits x0.6)
BUILD_RIDE = (-2.0, 0.5)      # the build's bed ridden from -4 to +0.5 LU against the pull-back (see ride_build)
ARRIVE_LIFT_DB = 0.5          # bus ride over the arrival (see main)
STEP_LIFT_DB = 1.5            # and over the bar after the step down (the second-biggest moment)
PULL_LIFT_DB = 1.5            # and over the pull-back's first beat and a bit, after the hit itself
CHORD_DB = float(os.environ.get("CHORD_DB", -7.5))   # final chord bus level (cut 5: -5.5, limited 4 dB)
MUSIC_LUFS = -15.0            # the intermediate master (mix.py trims the bed 3 dB and masters again to -15)
PENT = [74, 76, 78, 81, 83, 86, 88, 90, 93, 95, 98, 100]     # D major pentatonic, D5 up to E7
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "swaps.json")) as _f:
    SWAP_LIST = json.load(_f)
_shift = STOP * 1000.0 - max(float(q["at"]) for q in SWAP_LIST)   # an older cut's list: its last swap is the dead cut
SWAPS = [(float(q["at"]) + _shift) / 1000.0 for q in SWAP_LIST]
RETYPES = [(float(q["at"]) + _shift) / 1000.0 for q in SWAP_LIST if q.get("how") == "retype"]
ACCENTS = RETYPES[:2] if len(RETYPES) >= 2 else [ROT + 2 * BEAT, ROT + 3 * BEAT]   # the pointer's two retypes


def snap_step(t):
    """Nearest point on the build's musical steps (16ths and 16th triplets, both anchored to the bar).
    The picture rounds a swap to a frame; the audio stays exactly on the grid."""
    c = [round(t / S16) * S16, round(t / (BEAT / 6)) * (BEAT / 6)]
    best = min(c, key=lambda v: abs(v - t))
    return best if abs(best - t) <= 0.02 else t


TICKS = [snap_step(t) for t in SWAPS if BUILD0 - 0.02 <= t < STOP - 1e-3]


def beat_ticks(b):
    tb = BUILD0 + b * BEAT
    return sorted(t for t in TICKS if tb - 1e-3 <= t < tb + BEAT - 1e-3)


def build_step(b):
    """Subdivision (s) of build beat b, read from the swap ticks inside that beat: BEAT (one or none), S16, BEAT/3,
    BEAT/6, or 0.0 for a beat whose ticks change step half way (its percussion then plays on the ticks)."""
    tb = BUILD0 + b * BEAT
    ins = beat_ticks(b)
    if len(ins) < 2:
        return BEAT
    for step in (S16, BEAT / 3, BEAT / 6):
        if all(abs((t - tb) / step - round((t - tb) / step)) < 0.02 for t in ins):
            if min(y - x for x, y in zip(ins, ins[1:])) >= step - 1e-3:
                return step
    return 0.0


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
    l, r = pan_gains(pan)
    if sig.ndim == 1:
        buf[i:i + n, 0] += (sig[:n] * (gain * l * 1.4142)).astype(np.float32)
        buf[i:i + n, 1] += (sig[:n] * (gain * r * 1.4142)).astype(np.float32)
    else:
        buf[i:i + n, 0] += (sig[:n, 0] * (gain * l * 1.4142)).astype(np.float32)
        buf[i:i + n, 1] += (sig[:n, 1] * (gain * r * 1.4142)).astype(np.float32)


def _noise(n, seed, ch=1):
    r = np.random.default_rng(seed).standard_normal((n, ch))
    return r[:, 0] if ch == 1 else r


# ------------------------------------------------------------------ the band (cached renders of audiolib's models)
@lru_cache(maxsize=None)
def hook_note(midi, dur=0.9):
    """The hook: a kalimba tine (mono; the pan, the room and the echo give it width)."""
    return kalimba(midi, dur, vel=1.0, seed=midi)


@lru_cache(maxsize=None)
def glock_note(midi, dur=1.2, vel=1.0):
    return glock(midi, dur, vel=vel, seed=midi)


@lru_cache(maxsize=None)
def celesta_note(midi, dur=1.6):
    return celesta(midi, dur, seed=midi)


@lru_cache(maxsize=None)
def marimba_note(midi, dur=0.35, vel=1.0):
    return marimba(midi, dur, vel=vel, seed=midi)


@lru_cache(maxsize=None)
def piano_note(midi, dur, vel=0.6):
    return felt_piano(midi, dur, vel=vel, seed=1)


@lru_cache(maxsize=None)
def piano_chord(notes, dur, vel=0.6, roll=0.006):
    """Felt-piano chord, the hand rolling it upwards by `roll` s a note (the first note is on the beat); notes
    spread across the stereo field low-left to high-right, like sitting at the keyboard."""
    out = np.zeros((int(round((dur + roll * len(notes)) * SR)), 2))
    for j, m in enumerate(sorted(notes)):
        x = piano_note(m, round(dur, 4), vel)
        i = int(round(j * roll * SR))
        p = -0.35 + 0.7 * j / max(1, len(notes) - 1)
        l, r = pan_gains(p)
        out[i:i + len(x), 0] += x * l
        out[i:i + len(x), 1] += x * r
    return out / np.sqrt(len(notes))


@lru_cache(maxsize=None)
def bass_note(midi, dur, vel=0.8):
    return upright_bass(midi, dur, vel=vel, seed=midi)


@lru_cache(maxsize=None)
def uke_note(midi, dur, vel):
    return uke_string(midi, dur, vel=vel, seed=midi * 3 + int(vel * 10))


UKE = {"D": (69, 62, 66, 69), "Bm": (71, 62, 66, 71), "G": (67, 62, 67, 71), "A": (69, 62, 64, 69),   # A: Asus4
       "D/F#": (69, 62, 66, 69), "A/C#": (69, 61, 64, 69)}


@lru_cache(maxsize=None)
def strum(name, down=True, vel=0.8, dur=0.6, spread=0.011):
    """A ukulele strum: the four strings G4 C4 E4 A4 struck in turn, `spread` s apart (down: G string first; up:
    from the A string, only three strings and softer). The first string is on the beat."""
    notes = UKE[name]
    order = list(range(4)) if down else [3, 2, 1]
    sp = spread if down else spread * 0.7
    out = np.zeros((int(round((dur + sp * 4) * SR)), 2))
    for j, s in enumerate(order):
        x = uke_note(notes[s], round(dur, 4), round(vel * (1.0 if down else 0.7) * (1 - 0.05 * j), 2))
        i = int(round(j * sp * SR))
        p = -0.15 + 0.1 * s
        l, r = pan_gains(p)
        out[i:i + len(x), 0] += x * l
        out[i:i + len(x), 1] += x * r
    return out


@lru_cache(maxsize=None)
def reed(notes, dur, bright=1.0, seed=0):
    return reed_chord(notes, dur, bright=bright, seed=seed)


@lru_cache(maxsize=None)
def kick(soft=1.0, short=False):
    return felt_kick(vel=soft, short=short)


@lru_cache(maxsize=None)
def snare(var=0):
    return brush_tap(var % 3)


@lru_cache(maxsize=None)
def swish(dur, seed=0):
    return brush_swish(dur, seed)


@lru_cache(maxsize=None)
def snap(var=0):
    return finger_snap(var)


@lru_cache(maxsize=None)
def clap(var=0):
    return soft_clap(var)


@lru_cache(maxsize=None)
def wblock(f, vel=1.0):
    return wood(f, 0.09, vel=vel, seed=int(f))


@lru_cache(maxsize=None)
def shaker(var=0):
    return shaker_hit(var % 4)


@lru_cache(maxsize=None)
def tamb(var=0):
    """A tambourine tapped with fingertips (only in the biggest bars): a few jingle pairs, glassy 5-11 kHz
    pings that decay in ~60 ms, over a soft skin tap. Stereo."""
    n = int(0.16 * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(530 + var)
    out = np.zeros((n, 2))
    for j in range(6):
        f = rng.uniform(5200.0, 10500.0)
        d = rng.uniform(0.0, 0.006)
        i = int(d * SR)
        s = np.sin(2 * np.pi * f * t[: n - i]) * np.exp(-t[: n - i] / rng.uniform(0.03, 0.07))
        p = rng.uniform(-0.6, 0.6)
        l, r = pan_gains(p)
        out[i:, 0] += s * l
        out[i:, 1] += s * r
    skin = fft_filter(_noise(n, 535 + var, 2), lambda fr: g_hp(fr, 600.0, 2) * g_lp(fr, 3000.0, 2)) * np.exp(-t / 0.01)[:, None]
    return edges(out / 3.0 + 0.2 * skin, 0.0005, 0.03)


@lru_cache(maxsize=None)
def chimes(n_bars=9, dur=1.4, down=True, seed=0):
    return mark_tree(n_bars, dur, down, seed)


@lru_cache(maxsize=None)
def air(dur, f0=500.0, f1=3000.0, seed=0):
    return breath_air(dur, f0, f1, seed)


@lru_cache(maxsize=None)
def tag_tick():
    """The logo tag's glass tick: a 1 ms, 3-9 kHz tap on the glockenspiel bar, so the tag starts on its first ms
    over the chord's ringing sparkles."""
    n = int(0.03 * SR)
    t = np.arange(n) / SR
    ck = fft_filter(_noise(n, 77), lambda fr: g_hp(fr, 3000.0, 2) * g_lp(fr, 9000.0, 2)) * np.exp(-t / 0.0012)
    return edges(ck / np.max(np.abs(ck)) + 0.5 * glock_note(110, 0.03, 0.5), 0.0002, 0.01)


@lru_cache(maxsize=None)
def tick_note(midi):
    """The swap tick: a small pitched wooden 'tock' (a xylophone bar hit with a hard rubber mallet: rosewood
    partials 1 : 3.93 : 9.2 gone in ~50 ms) over a 1.5 ms stick click. Climbs the pentatonic through the build."""
    f = mtof(midi)
    n = int(0.14 * SR)
    t = np.arange(n) / SR
    bar = struck_bar(f, 0.14, (1.0, 3.93, 9.2), (1.0, 0.25, 0.06), (0.045, 0.02, 0.008), attack=0.0006)
    ck = fft_filter(_noise(n, 90), lambda fr: g_hp(fr, 2000.0, 2) * g_lp(fr, 7000.0, 2)) * np.exp(-t / 0.0015)
    return edges(bar + 0.3 * ck / np.max(np.abs(ck)), 0.0003, 0.02)


@lru_cache(maxsize=None)
def tock(var=0):
    """A clock's tick-tock for Penny's search: two woodblocks a fourth apart (the 'tick' higher)."""
    return wood((1180.0, 885.0)[var], 0.08, vel=1.0, seed=95 + var)


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
# 1-3 opening and dive | 4-5 Home | 6-7 Ask (thin) | 8-9 the lift | 10-12 Saved | 13-14 Team 1 (curious)
# 15-16 Music | 17 Habits | 18-20 Team 2: the search hangs on IV and V, the step down lands on the tonic
# 21-22 hire (typing) | 23 the arrival on a warm D/F# | 24 the Team page: IV, then V
# 25 Flows: vi then IV under the suggestion card, the kalimba run up | 26 the steps land on I, V under the dropout
# 27-28 pull-back (tonic on the hit) | 29 the drop
BARS = {1: ["D"], 2: ["Bm"], 3: ["G", "A"],
        4: ["D"], 5: ["Bm"], 6: ["G"], 7: ["A"], 8: ["D"], 9: ["Bm"],
        10: ["G"], 11: ["A"], 12: ["G", "A"], 13: ["D"], 14: ["Bm"], 15: ["G"], 16: ["A"],
        17: ["Bm", "A/C#"], 18: ["G"], 19: ["A"], 20: ["D"],
        21: ["Bm"], 22: ["G"], 23: ["D/F#"], 24: ["G", "A"], 25: ["Bm", "G"], 26: ["D", "A"],
        27: ["D"], 28: ["G", "A"], 29: ["D"]}
# 1 light, 2 fill, 3 full, 4 brighter, 5 +counter line and wood ghosts, 6 +arp and the glockenspiel double,
# 7 +16th shaker accents, brighter reed, 8 the biggest (claps, tambourine); 0 = the drop that opens the build
LEVEL = {1: 1, 2: 1, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 3, 9: 3,
         10: 4, 11: 4, 12: 4, 13: 3, 14: 3, 15: 6, 16: 6, 17: 7, 18: 2, 19: 2, 20: 8,
         21: 3, 22: 3, 23: 6, 24: 3, 25: 3, 26: 5, 27: 8, 28: 7, 29: 0}
# bars with their own texture: "curious" (Team 1), "search" (Penny working, up to the STEP downbeat), "type"
# (the job being typed: no hook, the keys are the lead; a long celesta note keeps it warm), "calm" (the Team
# page: room for the faces) and "flow" (the Flows card: light, no hook, the kalimba run at its end)
STYLE = {13: "curious", 14: "curious", 18: "search", 19: "search", 21: "type", 22: "type", 24: "calm", 25: "flow"}
STEP_BAR = int(round(STEP / BAR))
if STEP_BAR == 19:                               # the step down a bar earlier: V, I, then IV for the hold
    BARS.update({18: ["A"], 19: ["D"], 20: ["G"]})
    LEVEL.update({19: 8, 20: 6})
    del STYLE[19]
ARRIVE_BAR = int(ARRIVE // BAR)
FLOW_BAR = int(FLOWSTEP // BAR)                  # the bar the steps land in (26 by default)
FILL_BARS = (3, 14)          # wood fill into the next bar (the dive; Team 1 back into the groove)
LAST_BAR = max(BARS)
# Team 1's question: a short rising figure that ends in the air (C#6 over D, E6 over Bm)
CURIOUS = {13: [(0, 74), (3, 78), (6, 81), (11, 85)], 14: [(0, 74), (3, 78), (6, 83), (11, 88)]}
# the flow's run: six kalimba 16ths up the pentatonic into the landing on D6 (FLOWSTEP)
FLOW_RUN = [69, 71, 74, 76, 78, 81]
FLOW_LAND = 86


def chord_at(bar, i16):
    c = BARS[bar]
    return c[0] if len(c) == 1 or i16 < 8 else c[1]


def thin(t):
    return THIN0 <= t < LIFT - 1e-6


def hook_muted(t):
    """The arrival: the hook steps aside for two beats, for the new character's voice."""
    return ARRIVE - 1e-6 <= t < ARRIVE + 2 * BEAT - 1e-6


BASS_CURIOUS = [(0, 0, 2.0, 0.95), (6, 12, 0.9, 0.6), (8, 0, 2.0, 0.85), (14, 7, 1.0, 0.7)]
BASS_SEARCH = [(0, 0, 7.0, 0.9), (8, 0, 7.0, 0.75)]          # a held pedal: the floor stays, the line waits
BASS_FLOW = [(0, 0, 3.5, 0.85), (8, 0, 3.5, 0.8), (14, 7, 1.0, 0.6)]
BASS_FULL = [(0, 0, 2.0, 1.0), (3, 0, 0.9, 0.8), (6, 12, 0.9, 0.72), (8, 0, 2.0, 0.95), (11, 0, 0.9, 0.8), (14, 7, 1.0, 0.8)]
PIANO_COMP = [(0, 3.5, 1.0), (6, 1.4, 0.7), (10, 2.6, 0.85)]
# the island strum: down on 1, down-up on 2-and, up on 3-and, down-up on 4 (16th index, down?, velocity)
UKE_FULL = [(0, True, 0.9), (4, True, 0.7), (6, False, 0.6), (10, False, 0.6), (12, True, 0.75), (14, False, 0.55)]
UKE_SOFT = [(0, True, 0.7), (8, True, 0.6)]


def build():
    kicks = []

    def k(t, g=1.0, short=False):
        add("kick", kick(short=short), t, g)
        kicks.append(t)

    # ---- bar 0: room tone, a very quiet reed bed, a glockenspiel / kalimba pop when the orb appears
    n = T(4.2)
    room = fft_filter(_noise(n, 5, 2), lambda fr: g_lp(fr, 450.0, 1) * g_hp(fr, 70.0, 2))
    tt = np.arange(n) / SR
    room *= (np.clip(tt / 0.6, 0, 1) * np.clip((4.2 - tt) / 1.6, 0, 1))[:, None]
    add("room", room, 0.0)
    # a quiet D chord on the reed organ swells in from 0.1 s so the film never opens on dead air; it hands over
    # to the tiles by ~4.5 s. Level set by measurement in main() (BED_RMS over 0.9-2.4 s).
    bl = 4.4
    bed = reed((50, 57, 62, 66), bl, bright=0.7, seed=1)
    tb = np.arange(len(bed)) / SR
    swell = np.sin(0.5 * np.pi * np.clip(tb / 0.7, 0, 1)) ** 2 * np.clip((bl - tb) / 1.6, 0, 1) ** 1.5
    add("bed", bed * swell[:, None], BED_AT)
    add("tile", hook_note(74, 1.2), ORB, 0.22)
    add("tile", glock_note(86, 1.2, 0.8), ORB + 0.004, 0.16)
    add("tile", bass_note(50, 0.4), ORB, 0.14)

    # ---- eight tile notes climbing the pentatonic on the kalimba, one every half beat from 3.0 s, a glockenspiel
    #      octave above on each, softer
    #      each note damped just before the next, as a player's thumb stops the tine it just played (the last rings)
    for j, (t, m) in enumerate(zip(TILES, TILE_NOTES)):
        d = round(TILES[j + 1] - t - 0.004, 4) if j + 1 < len(TILES) else 1.2
        add("tile", hook_note(m, d), t, 0.62 + 0.04 * j, pan=-0.28 + 0.08 * j)
        add("tile", glock_note(m + 12, d if j + 1 < len(TILES) else 1.0, 0.7), t, 0.16, pan=0.28 - 0.08 * j)

    # ---- the band, bar by bar
    for bar in range(1, LAST_BAR + 1):
        lvl = LEVEL[bar]
        drop = lvl == 0
        t0 = bar * BAR
        fill = bar in FILL_BARS
        style = STYLE.get(bar)
        curious, search, typing, calm, flow = (style == s for s in ("curious", "search", "type", "calm", "flow"))
        soft = typing or calm or flow

        # felt bass drum (soft, on 1 and 3 with a little push)
        if not drop:
            pat = [(0, 1.0), (8, 0.92)]
            if lvl >= 2:
                pat.append((10, 0.6))
            if curious:
                pat = [(0, 0.8), (10, 0.55)]
            if search:
                pat = [(0, 0.7)]
            if soft:
                pat = [(0, 0.8), (8, 0.7)]
            for i, g in pat:
                if not thin(t0 + i * S16):
                    k(pos(bar, i), g * (0.8 if lvl == 1 or (i == 0 and abs(t0 - PULL) < 1e-6) else 1.0))

        # brushed snare on 2 and 4; finger snaps with it from the second layer; soft claps in the biggest bars
        for n_, i in enumerate((4, 12)):
            if search:
                continue
            add("snare", snare(n_ + bar), pos(bar, i), (1.0 if not drop else 0.9) * (0.75 if curious or soft else 1.0), pan=0.05)
            if lvl >= 4 or curious:
                add("snap", snap(n_), pos(bar, i) + 0.004, 0.8 if curious else 1.0, pan=0.35)
            if lvl >= 8:
                add("clap", clap(n_), pos(bar, i), 1.0, pan=-0.1)
        # woodblock ghost notes (the old rim ghosts) and the fills
        if (lvl >= 5 or curious or soft) and not fill:
            for i, g in ((7, 0.32), (13, 0.38)):
                add("wood", wblock(1250.0), pos(bar, i), g, pan=-0.3)
        if fill:
            for i, g, f in ((12, 0.35, 900.0), (13, 0.45, 1050.0), (14, 0.6, 1250.0), (15, 0.8, 1480.0)):
                add("wood", wblock(f), pos(bar, i), g, pan=-0.2 + 0.1 * (i - 12))

        # egg shaker (swung 16ths); brush swishes on the off-8ths (where cut 5 had closed hats); tambourine on
        # the off-8ths of the biggest bars
        if lvl >= 2:
            for i in range(16):
                g = (0.50, 0.30, 0.90, 0.36)[i % 4] * (0.75 if thin(t0 + i * S16) or lvl == 2 or curious else 0.6 if soft else 1.0)
                if lvl >= 7 and i % 4 == 2:
                    g *= 1.2
                add("shaker", shaker(i), pos(bar, i), g, pan=0.32)
        if lvl >= 3 and not curious and not search:
            for i in (2, 6, 10, 14):
                if not thin(t0 + i * S16):
                    add("brushsw", swish(0.28, i % 3), pos(bar, i) - 0.05, 0.6 if soft else 0.8 if lvl == 3 else 1.0, pan=-0.3)
        if lvl >= 8:
            for i in (2, 6, 10, 14):
                add("tamb", tamb(i % 3), pos(bar, i), 0.9, pan=-0.35)

        # plucked upright bass
        for i, off, d16, g in (BASS_CURIOUS if curious else BASS_SEARCH if search else BASS_FLOW if flow else BASS_FULL):
            tg = t0 + i * S16
            c = CH[chord_at(bar, i)]
            g *= {0: 0.68, 1: 0.72, 8: 1.06}.get(lvl, 0.85 if thin(tg) else 1.0)
            add("bass", bass_note(c["bass"] + off, round(d16 * S16 + 0.05, 4), 0.8 if g > 0.7 else 0.6), pos(bar, i), g)

        # felt piano comp (and the search's one held chord a bar)
        if lvl >= 2:
            for i, d16, g in (PIANO_COMP[:1] if search or soft else PIANO_COMP):
                if bar == STEP_BAR and i == 0:
                    continue                      # the STEP accent is this downbeat's chord
                if bar == FLOW_BAR and abs(pos(bar, i) - FLOWSTEP) < 0.01:
                    continue                      # and the flow's landing likewise
                c = CH[chord_at(bar, i)]
                d = round((8.0 if soft else d16) * S16 + 0.3, 4)
                add("ep", piano_chord(c["ep"], d, {7: 0.7, 8: 0.75}.get(lvl, 0.6)), pos(bar, i), g)
                if soft and len(BARS[bar]) == 2:
                    c2 = CH[BARS[bar][1]]
                    add("ep", piano_chord(c2["ep"], d, 0.55), pos(bar, 8), 0.85)

        # ukulele: the island strum on the groove; two soft downstrokes in the light bars; none in the search
        if (lvl >= 3 or soft) and not search and not curious:
            pattern = UKE_SOFT if soft else UKE_FULL
            for i, down, v in pattern:
                tg = t0 + i * S16
                if thin(tg):
                    continue
                name = chord_at(bar, i)
                add("uke", strum(name, down, round(v * (1.1 if lvl >= 7 else 1.0), 2), round(2 * S16 + 0.25, 4)),
                    pos(bar, i), 1.0, pan=0.15)

        # reed organ (soft glue; widest and brightest in the big section)
        if lvl >= 3 or search:
            br = {2: 0.8 + 0.2 * (bar - 18), 3: 0.85, 4: 0.95, 5: 1.0, 6: 1.1, 7: 1.25, 8: 1.4}[lvl]
            chords = BARS[bar]
            seg = BAR / len(chords)
            for s, name in enumerate(chords):
                g = {2: 0.9, 3: 0.8, 4: 0.9, 5: 1.0, 6: 1.1, 7: 1.3, 8: 1.6}[lvl]
                add("pad", reed(CH[name]["pad"], round(seg + 0.14, 4), br, s), t0 + s * seg, g)

        # hook on the kalimba (Team 1 asks its question instead; the search and the light bars have none)
        if curious:
            for i, m in CURIOUS[bar]:
                add("hook", hook_note(m), pos(bar, i), 0.8 if i else 0.9)
                if i == 11:                                   # the raised eyebrow: a glockenspiel octave on the last note
                    add("hook", glock_note(m + 12, 1.0, 0.8), pos(bar, i), 0.35)
        elif typing or flow:
            pass
        elif lvl >= 3 or drop:
            for i, m in HOOK[BARS[bar][0]]:
                if len(BARS[bar]) == 2 and i >= 8:
                    continue
                tg = t0 + i * S16
                if thin(tg) or hook_muted(tg) or (drop and i > 6) or calm:
                    continue
                if bar == FLOW_BAR and abs(pos(bar, i) - FLOWSTEP) < 0.01:
                    continue                                  # the run's landing is this note
                at_step = i == 0 and (bar == STEP_BAR or abs(t0 - PULL) < 1e-6)
                add("hook", hook_note(m), pos(bar, i), (1.0 if i % 4 == 0 else 0.85) * (0.8 if drop else 1.0) * (0.7 if at_step and bar == STEP_BAR else 0.78 if at_step else 1.0))
                if lvl >= 6 and not at_step:      # the glockenspiel doubles it an octave up, softer from B6
                    add("hook", glock_note(m + 12, 1.0, 0.8), pos(bar, i) + 0.003, {6: 0.30, 7: 0.36}.get(lvl, 0.42) * (0.5 if m + 12 >= 95 else 1.0))
            if len(BARS[bar]) == 2 and not drop:
                tail = [(8, 81), (12, 76)] + ([(14, 81)] if t0 + BAR > DROPOUT[0] > t0 else [])
                for i, m in tail:
                    if not thin(t0 + i * S16) and not hook_muted(t0 + i * S16):
                        add("hook", hook_note(m), pos(bar, i), 0.65 if DROPOUT[0] - 1e-6 <= t0 + i * S16 < DROPOUT[1] else 1.0)
                        if lvl >= 6:
                            add("hook", glock_note(m + 12, 1.0, 0.8), pos(bar, i) + 0.003, {6: 0.30, 7: 0.36}.get(lvl, 0.42))

        # celesta counter line (long soft high notes) from the second layer on
        if lvl >= 5 or search or soft:
            names = BARS[bar]
            if len(names) == 1:
                notes = CTR[names[0]]
                for j, (i, m) in enumerate(notes):
                    d = (notes[j + 1][0] if j + 1 < len(notes) else 16) - i
                    add("ctr", celesta_note(m, round(d * S16 + 0.6, 4)), pos(bar, i), 0.6 if hook_muted(t0) else 1.0, pan=0.25)
            else:
                for s, name in enumerate(names):
                    if flow and s == 1:
                        continue                              # the kalimba run has this half
                    add("ctr", celesta_note(CTR[name][0][1], round(8 * S16 + 0.6, 4)), pos(bar, 8 * s), 1.0, pan=0.25)

        # quiet 16th marimba arp from the third layer on
        if lvl >= 6:
            seq = [0, 1, 2, 1]
            for i in range(16):
                tones = CH[chord_at(bar, i)]["ep"]
                m = tones[seq[i % 4]] + 12
                add("arp", marimba_note(m, 0.3, 0.8), pos(bar, i), 1.0 if i % 4 in (0, 3) else 0.65,
                    pan=0.5 if i % 2 else -0.5)

        # Penny searching: a clock's woodblock tick-tock on the 8ths and a scanning marimba figure, four notes up,
        # one step on, again
        if search:
            k0 = (bar - 18) * 2
            last_beat = bar == STEP_BAR - 1       # the beat before the step down is left to the descending steps
            for i in range(0, 12 if last_beat else 16, 2):
                if t0 + i * S16 < WORK - 1e-6:            # nothing ticks until her working line is up
                    continue
                add("tock", tock((i // 2) % 2), pos(bar, i), 1.0 if i % 4 == 0 else 0.75, pan=-0.35 if (i // 2) % 2 else 0.35)
            for i in range(12 if last_beat else 16):
                if t0 + i * S16 < WORK - 1e-6:
                    continue
                m = PENT[min(len(PENT) - 1, k0 + i // 4 + i % 4)]
                add("seek", marimba_note(m, 0.3, 0.9), pos(bar, i), (0.6 + 0.4 * (i % 4) / 3) * (1.0 + 0.2 * (bar - 18)),
                    pan=0.45 if i % 2 else -0.45)

        # the dive's fill: a marimba run up into the full groove
        if bar == FILL_BARS[0]:
            for i, m in ((8, 76), (10, 78), (12, 81), (14, 83)):
                add("tile", marimba_note(m, 0.5, 1.0), pos(bar, i), 0.5 + 0.03 * i)

    # ---- the flow's run: six kalimba 16ths up into FLOWSTEP, landing on D6 with a glockenspiel D7 and a celesta
    #      A6 just after it (a small, bright arrival: it must stay under the step down and the arrival)
    for j, m in enumerate(FLOW_RUN):
        tr = FLOWSTEP - (len(FLOW_RUN) - j) * S16
        tr += SWING if round((tr % BAR) / S16) % 2 else 0.0
        add("flow", hook_note(m), tr, 0.55 + 0.07 * j, pan=-0.4 + 0.12 * j)
    add("flow", hook_note(FLOW_LAND, 1.4), FLOWSTEP, 1.0, pan=0.1)
    add("flow", glock_note(FLOW_LAND + 12, 1.6, 0.9), FLOWSTEP, 0.45, pan=0.25)
    add("flow", celesta_note(93, 1.4), FLOWSTEP + 0.15, 0.35, pan=-0.2)
    nm = chord_at(FLOW_BAR, int(round((FLOWSTEP % BAR) / S16)) % 16)
    add("flow", piano_chord(CH[nm]["ep"] + tuple(m + 12 for m in CH[nm]["ep"]), 1.2, 0.7), FLOWSTEP, 0.6)
    if not any(abs(tk - FLOWSTEP) < 1e-3 for tk in kicks):
        k(FLOWSTEP, 0.8)

    # ---- section markers: mark-tree sparkles into the changes, soft breaths that end on the downbeat
    for t, g in ((HOME, 0.8), (LIFT, 0.7), (SAVED, 0.5), (MUSIC, 0.4), (STEP, 0.6), (ARRIVE, 0.8), (FLOWSTEP, 0.4), (PULL, 0.7)):
        add("fx", chimes(9, 1.4, True, int(t * 10) % 7), t, g)
    for t in (HOME, PULL):                  # a finger snap on the section's downbeat: the band arrives on the 1
        add("snap", snap(2), t, 1.0, pan=0.2)
    for t, d, g in ((HOME, 0.6, 0.9), (SAVED, 0.6, 0.45)):     # a breath in, easing off 0.15 s before the downbeat
        a_ = air(d, 600.0, 2600.0, int(t))
        a_ = a_ * np.clip((d - np.arange(len(a_)) / SR) / 0.15, 0, 1)[:, None] ** 2
        add("fx", a_, t - d, g)

    # ---- the lift (answer lands): a clear arrival wherever in the bar it falls
    lb, li = int(LIFT // BAR), int(round((LIFT % BAR) / S16)) % 16
    if lb in BARS and THIN0 < LIFT < ASK_END_MS / 1000.0:
        name = chord_at(lb, li)
        if not any(abs(tk - LIFT) < 1e-3 for tk in kicks):
            k(LIFT, 1.0)
        add("accent", piano_chord(tuple(CH[name]["ep"]) + tuple(m + 12 for m in CH[name]["ep"]), 0.9, 0.8), LIFT, 0.8)
        add("accent", strum(name, True, 0.9, 0.8), LIFT, 0.6)
        if li not in [i for i, _ in HOOK[name]]:
            add("hook", hook_note(HOOK[name][0][1]), LIFT, 1.0)

    # ---- the price steps down under the target (STEP): the band comes home on the tonic, a bright piano chord,
    #      a big ukulele downstroke and two glockenspiel bells, strummed (the descending steps and "reached" are cues)
    name = BARS[STEP_BAR][0]
    notes = CH[name]["ep"]
    add("accent", piano_chord(tuple(notes) + tuple(m + 12 for m in notes), 1.2, 0.85), STEP, 0.65)
    add("accent", strum(name, True, 1.0, 0.9), STEP + 0.005, 0.7)
    add("accent", glock_note(90, 1.4, 1.0), STEP, 0.25)
    for dt, m in ((0.03, 78), (0.06, 86)):
        add("accent", glock_note(m, 1.4, 1.0), STEP + dt, 0.3)

    # ---- the pull-back hit: the tonic chord, bright, a ukulele downstroke and two bells strummed behind it
    notes = CH["D"]["ep"]
    add("accent", piano_chord(tuple(notes) + tuple(m + 12 for m in notes), 1.2, 0.85), PULL, 0.8)
    add("accent", strum("D", True, 1.0, 0.9), PULL + 0.005, 0.5)
    add("accent", glock_note(90, 1.4, 1.0), PULL, 0.25)
    for dt, m in ((0.04, 81), (0.07, 86)):
        add("accent", glock_note(m, 1.4, 1.0), PULL + dt, 0.3)

    # ---- the new character arrives (ARRIVE): the warmest chord in the film, a slow felt-piano roll of D/F# add9,
    #      a slow ukulele strum, celesta an octave up, a reed swell (its voice and the team's blips are cues)
    name = chord_at(ARRIVE_BAR, int(round((ARRIVE % BAR) / S16)) % 16)
    add("accent", piano_chord(tuple(CH[name]["ep"]) + tuple(m + 12 for m in CH[name]["ep"]), 1.2, 0.8), ARRIVE, 0.6)
    if not any(abs(tk - ARRIVE) < 1e-3 for tk in kicks):
        k(ARRIVE, 0.9)
    for j, m in enumerate((54, 57, 62, 64, 69, 74)):
        add("warm", piano_note(m, 2.2, 0.6), ARRIVE + 0.03 * j, 1.0 - 0.06 * j, pan=-0.3 + 0.12 * j)
    add("warm", strum("D/F#", True, 0.8, 1.6, 0.03), ARRIVE + 0.02, 0.8, pan=0.2)
    for j, m in enumerate((74, 78, 81, 88)):
        add("warm", celesta_note(m, 1.6), ARRIVE + 0.04 + 0.03 * j, 0.45, pan=0.3 - 0.15 * j)
    wp = reed((50, 57, 62, 64, 66), 2.3, 1.1, 9)
    tw = np.arange(len(wp)) / SR
    add("warm", wp * (np.sin(0.5 * np.pi * np.clip(tw / 0.25, 0, 1)) ** 2 * np.exp(-tw / 1.2))[:, None], ARRIVE, 1.6)

    # ---- accents on the two early swaps (the pointer's retypes), inside the drop bar
    for t, bells in ((ACCENTS[0], (78, 81)), (ACCENTS[1], (81, 86))):
        k(t, 0.85)
        notes = CH["D"]["ep"]
        add("accent", piano_chord(tuple(notes) + tuple(m + 12 for m in notes), 0.9, 0.85), t, 0.9)
        for m in bells:
            add("accent", glock_note(m, 1.0, 1.0), t, 0.4)
        add("accent", wblock(1250.0), t, 0.5)

    # ---- the build, BUILD0 -> STOP: everything rises; the percussion follows the swaps' own steps
    #      (quarters, 8th triplets, 16ths, 16th triplets), so the ticks never flam against it
    d = STOP - BUILD0
    n = int(round(d * SR))
    t = np.arange(n) / SR
    x = t / d
    br = air(round(d, 4), 350.0, 5000.0, 81)[:n]
    add("build", br / np.max(np.abs(br)), BUILD0, 1.0)
    roll = np.zeros((n, 2))                                   # a brush roll swelling under it (overlapping swishes)
    for j in range(int(d / 0.1)):
        s = swish(0.3, j % 3)
        i = int(j * 0.1 * SR)
        m = min(len(s), n - i)
        roll[i:i + m] += s[:m] * (0.15 + 0.85 * (j * 0.1 / d) ** 2)
    add("build", roll / np.max(np.abs(roll)), BUILD0, 0.5)
    dark = reed((52, 57, 62, 64), round(d, 4), 0.6, 5)[:n]
    brt = reed((52, 57, 62, 64), round(d, 4), 1.5, 5)[:n]
    add("bpad", (dark * (1 - x)[:, None] + brt * x[:, None]) * (0.5 + 0.5 * x)[:, None], BUILD0, 1.0)
    climb = [33, 35, 37, 38, 40, 42, 43, 45, 47, 49]            # A1 up the scale to the leading tone C#3
    nb = int(round(d / BEAT))
    for b in range(nb):
        m = climb[min(b, len(climb) - 1)]
        tb = BUILD0 + b * BEAT
        step = build_step(b)
        ins = beat_ticks(b)
        if step == 0.0:                                     # a beat whose ticks change step: play on the ticks
            offs = [tk - tb for tk in ins]
        else:
            offs = [j * step for j in range(int(round(BEAT / step)))]
        quarter = step >= BEAT - 1e-6
        sext = 0 < step <= BEAT / 6 + 1e-6
        trip = abs(step - BEAT / 3) < 1e-3
        sub = 2 if quarter else (3 if trip or sext else 4)
        for j in range(sub):
            add("bass", bass_note(m, round(BEAT / sub * 0.92, 4), 0.9), tb + j * BEAT / sub,
                (BUILD_BASS[0] + BUILD_BASS[1] * b) * (1.0 if j == 0 else 0.8))
        # kick: quarters, then 8ths, then the roll on the 16th-triplet steps (the last beat every step)
        if quarter or trip:
            kt = [0.0]
        elif step == 0.0 or not sext:
            kt = [0.0, BEAT / 2] if step != 0.0 else [0.0]
        elif b < nb - 1:
            kt = [0.0, BEAT / 3, 2 * BEAT / 3]
        else:
            kt = [j * BEAT / 6 for j in range(6)]
        for j, o in enumerate(kt):
            k(tb + o, (BUILD_KICK[0] + BUILD_KICK[1] * b) * (1.0 if j == 0 else 0.6), short=sext)
        if b % 2 == 1:
            add("snare", snare(b), tb, 1.0, pan=0.05)
            add("snap", snap(b % 2), tb + 0.004, 0.9, pan=0.35)
        if b >= nb - 4:
            add("clap", clap(b % 2), tb, 0.5 + 0.07 * (b - (nb - 4)))
            if b == nb - 1:
                for j, o in enumerate((0.0, BEAT / 3, 2 * BEAT / 3)):
                    add("tom", low_tom(45 - 3 * j, 1.0), tb + o, 0.8 + 0.1 * j)
        sh = offs if not quarter else [j * S16 for j in range(4)]
        for j, o in enumerate(sh):
            add("shaker", shaker(j), tb + o, (0.8 + 0.05 * b) * (1.0 if j % 2 == 0 else 0.7), pan=0.32)
    for j, tk in enumerate(TICKS):
        frac = j / max(1, len(TICKS) - 1)
        m = PENT[min(len(PENT) - 1, j * len(PENT) // len(TICKS))]
        add("tick", tick_note(m), tk, 0.55 + 0.45 * frac, pan=0.3 if j % 2 else -0.3)
        if tk >= STOP - 2 * BEAT - 1e-3:
            add("wood", wblock(1480.0), tk, 0.3 + 0.2 * frac, pan=0.0)

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
    """Mix automation over the rotation build: the swaps' percussion gets denser by itself, so the bed is ridden
    to a gentle ramp instead, from BUILD_RIDE[0] to BUILD_RIDE[1] LU relative to the pull-back. Measured, not
    guessed: a 0.6 s K-weighted loudness of the bus, the gain smoothed over a beat and a half, held within +-8 dB."""
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
    g = np.clip(target - L, -8.0, 6.0)
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
    """END (79.2 s, "Great"): one warm, wide D(add9): a slow felt-piano roll up from a low D, a ukulele strum, a
    reed organ underneath, an upright-bass D and a soft felt bass drum, celesta and glockenspiel sparkles falling
    around it, ringing out under the lockup; a soft two-note glockenspiel tag at TAG (81.0 s) for the logo; a
    barely-there low reed under the held breath before it."""
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

    # the breath: a very quiet low D on the reed organ that swells a touch into the chord
    bl = END - STOP - 0.1
    br = reed((50, 57), round(bl, 4), 0.5, 7)
    tb = np.arange(len(br)) / SR
    put(F, br / np.max(np.abs(br)) * (tb / bl)[:, None] ** 1.5, STOP + 0.1, 0.005)

    notes = (50, 57, 62, 66, 69, 76)
    n = int(dur * SR)
    t = np.arange(n) / SR
    pad = reed(notes, round(dur, 4), 1.0, 3)[:n] * np.exp(-t / 3.0)[:, None]
    pad /= np.max(np.abs(pad))
    put(F, pad, END, 0.80)
    # a quick upward roll on the felt piano (22 ms a note): warmer than a block chord, onsets don't stack
    for j, m in enumerate((38, 50, 57, 62, 66, 69, 74, 76)):
        put(F, piano_note(m, round(dur - 0.1, 4), 0.75), END + 0.022 * j, (0.20 if m < 50 else 0.16), pan=-0.35 + 0.1 * j)
    put(F, strum("D", True, 0.9, 2.5, 0.03), END + 0.03, 0.25, pan=0.2)
    for j, m in enumerate((62, 69, 78)):
        put(F, hook_note(m, 1.2), END + 0.025 * j, 0.14)
    put(F, bass_note(38, 3.0, 0.7), END + 0.04, 0.35)
    for j, (dt, m, p) in enumerate(((0.06, 90, -0.4), (0.12, 93, 0.4), (0.24, 98, -0.2), (0.39, 88, 0.5),
                                    (0.54, 95, -0.5), (0.72, 102, 0.2), (0.93, 98, -0.3), (1.2, 105, 0.35))):
        sp = celesta_note(m, 1.4) if j % 2 else glock_note(m, 1.4, 0.7)
        put(F, sp, END + dt, 0.2 * (0.86 ** j), pan=p)
        put(wet_src, sp, END + dt, 0.2 * (0.86 ** j), pan=p)
    put(F, chimes(11, 2.0, True, 3), END + 0.02, 0.10)
    # logo tag: A6 then D7 on the glockenspiel, soft
    for dt, m, g, p in ((0.0, 93, 0.14, -0.15), (0.15, 98, 0.11, 0.15)):
        tg = glock_note(m, 1.8, 1.0)
        put(F, tg, TAG + dt, g, pan=p)
        put(wet_src, tg, TAG + dt, g * 0.8, pan=p)
        put(F, tag_tick(), TAG + dt, g * 2.0, pan=p)                      # a glass tick on each: its first ms is the onset
    wet_src += 0.6 * F
    return F, wet_src


def main():
    t_start = time.time()
    kicks = build()
    print(f"  events placed in {time.time() - t_start:.1f}s; lift at {LIFT:.3f}s, step down at {STEP:.1f}s, "
          f"arrival at {ARRIVE:.1f}s, flow's steps at {FLOWSTEP:.2f}s")

    # ---- balance: calibrate each stem by measurement, not by guess
    ref = slice(T(PULL), T(ROT))       # bars 27-28 (the pull-back), every groove layer present
    rms_target = {"bass": -21.0, "hook": -20.5, "ep": -24.0, "uke": -23.5, "pad": -31.0, "ctr": -29.5, "arp": -30.0}
    peak_target = {"kick": -10.0, "snare": -14.0, "snap": -17.0, "clap": -16.0, "wood": -17.0, "shaker": -17.0,
                   "brushsw": -25.0, "tamb": -21.0, "tom": -12.0,
                   "fx": -21.0, "tile": -8.0, "accent": -7.0, "room": -52.0, "flow": -10.0,
                   "tick": -10.0, "build": -12.0, "bpad": -12.0, "tock": -15.0, "seek": -16.0, "warm": -5.5}
    for name, buf in STEMS.items():
        if name == "bed":
            buf *= db(BED_RMS - rms_db(buf[T(0.9):T(2.4)]))
        elif name in rms_target:
            cur = rms_db(buf[ref])
            buf *= db(rms_target[name] - cur)
        else:
            buf *= db(peak_target[name]) / float(np.max(np.abs(buf)))

    # ---- a band breathes, it doesn't pump: only the bass gives the bass drum a little room
    STEMS["bass"] *= sidechain(kicks, 0.15).astype(np.float32)

    if os.environ.get("STEM_WINDOWS"):     # debugging aid: STEM_WINDOWS="41.7-42.1,41.1-41.5" prints each stem's RMS there
        wins = [tuple(float(v) for v in w.split("-")) for w in os.environ["STEM_WINDOWS"].split(",")]
        for name, buf in sorted(STEMS.items()):
            print(f"    {name:7s} " + "  ".join(f"{rms_db(buf[T(x):T(y)]):7.1f}" for x, y in wins))
        sys.exit(0)

    # ---- a little echo on the kalimba and the tiles (less than cut 5's synth plucks: it's a room, not a delay)
    for name, g in (("hook", 0.14), ("tile", 0.12), ("accent", 0.12), ("seek", 0.2), ("flow", 0.18)):
        STEMS[name] = STEMS[name] + (g * feedback_delay(STEMS[name], 0.75 * BEAT, fb=0.35, repeats=3)).astype(np.float32)

    # ---- the one-beat dropout before the pull-back: only the hook (and its echoes) and the riser are left
    keep = {"hook", "fx", "tick", "accent", "build", "bpad", "warm", "flow"}
    hole = np.ones(N)
    a, b = T(DROPOUT[0] - 0.01), T(DROPOUT[0])
    hole[a:b] = 0.5 + 0.5 * np.cos(np.pi * np.arange(b - a) / (b - a))
    a, b = b, T(DROPOUT[1] - 0.002)
    hole[a:b] = 0.0
    hole[b:T(DROPOUT[1])] = np.linspace(0.0, 1.0, T(DROPOUT[1]) - b)
    for name, buf in STEMS.items():
        if name not in keep:
            buf *= hole[:, None].astype(np.float32)
    STEMS["flow"] *= np.where(np.arange(N) >= T(DROPOUT[0]), 0.4, 1.0)[:, None].astype(np.float32)

    # ---- cut dead at STOP: everything is cut (6 ms fade), only the reverb tail survives
    mute = np.ones(N)
    a, b = T(STOP - 0.006), T(STOP)
    mute[a:b] = 0.5 + 0.5 * np.cos(np.pi * np.arange(b - a) / (b - a))
    mute[b:] = 0.0
    dry = np.zeros((N, 2))
    send = np.zeros((N, 2))
    sends = {"kick": 0.05, "bass": 0.05, "snare": 0.25, "snap": 0.25, "clap": 0.25, "wood": 0.2, "shaker": 0.08,
             "brushsw": 0.1, "tamb": 0.1, "tom": 0.2, "uke": 0.25,
             "hook": 0.3, "ep": 0.3, "pad": 0.3, "ctr": 0.5, "arp": 0.3, "fx": 0.4, "tile": 0.5, "accent": 0.4,
             "room": 0.0, "bed": 0.3, "tick": 0.3, "build": 0.25, "bpad": 0.3, "tock": 0.25, "seek": 0.4,
             "warm": 0.5, "flow": 0.45}
    for name, buf in STEMS.items():
        buf *= mute[:, None].astype(np.float32)
        dry += buf
        send += buf * sends[name]
    wet = convolve_reverb(send, make_ir(rt60=1.2, seed=11, hi=6500.0))
    tail = np.ones(N)
    tail[b:] = db(-18.0 * np.arange(N - b) / SR)         # the tail thins quickly: a held breath
    wet *= tail[:, None]

    F, fsrc = final_chord()
    fwet = convolve_reverb(fsrc, make_ir(rt60=2.2, seed=12, hi=8000.0))
    bus = dry + 0.9 * wet
    # Home and Ask sit 1.5 dB under the rest, so the level has somewhere to go
    trim = np.ones(N)
    for t_a, t_b in ((HOME, ASK_END_MS / 1000.0),):
        r = T(0.05)
        trim[T(t_a):T(t_b)] = db(-1.5)
        trim[T(t_a) - r:T(t_a)] = np.linspace(1.0, db(-1.5), r)
        trim[T(t_b):T(t_b) + r] = np.linspace(db(-1.5), 1.0, r)
    # Music and Habits (lvl 6-7, the busiest bars before the arrival) sit 1 dB down, so the arrival stands clear
    r = T(0.05)
    trim[T(MUSIC):T(TEAM2)] *= db(-1.0)
    trim[T(MUSIC) - r:T(MUSIC)] *= np.linspace(1.0, db(-1.0), r)
    trim[T(TEAM2):T(TEAM2) + r] *= np.linspace(db(-1.0), 1.0, r)
    # the arrival ridden up ARRIVE_LIFT_DB for its first beat and a half, easing back over the next beat
    r = T(0.004)
    i0, i1, i2 = T(ARRIVE), T(ARRIVE + 1.5 * BEAT), T(ARRIVE + 2.5 * BEAT)
    trim[i0 - r:i0] *= np.linspace(1.0, db(ARRIVE_LIFT_DB), r)
    trim[i0:i1] *= db(ARRIVE_LIFT_DB)
    trim[i1:i2] *= db(ARRIVE_LIFT_DB * (0.5 + 0.5 * np.cos(np.pi * np.arange(i2 - i1) / (i2 - i1))))
    # the bar after the step down likewise, STEP_LIFT_DB from 100 ms after it, easing back over its last beat
    k0, k1, k2, k3 = T(STEP + 0.1), T(STEP + 0.2), T(STEP + BAR - BEAT), T(STEP + BAR)
    trim[k0:k1] *= db(STEP_LIFT_DB * np.linspace(0.0, 1.0, k1 - k0))
    trim[k1:k2] *= db(STEP_LIFT_DB)
    trim[k2:k3] *= db(STEP_LIFT_DB * (0.5 + 0.5 * np.cos(np.pi * np.arange(k3 - k2) / (k3 - k2))))
    # the pull-back's first bar likewise, PULL_LIFT_DB from just after the hit (its first 100 ms stay as they are)
    j0, j1, j2, j3 = T(PULL + 0.1), T(PULL + 0.2), T(PULL + 0.8), T(PULL + 1.2)
    trim[j0:j1] *= db(PULL_LIFT_DB * np.linspace(0.0, 1.0, j1 - j0))
    trim[j1:j2] *= db(PULL_LIFT_DB)
    trim[j2:j3] *= db(PULL_LIFT_DB * (0.5 + 0.5 * np.cos(np.pi * np.arange(j3 - j2) / (j3 - j2))))
    bus *= trim[:, None]
    bus += db(CHORD_DB) * (F + 0.55 * fwet)

    # ---- gentle width control: mono below ~140 Hz, a touch of extra side above
    mid = (bus[:, 0] + bus[:, 1]) * 0.5
    side = (bus[:, 0] - bus[:, 1]) * 0.5
    side = fft_filter(side, lambda fr: g_hp(fr, 140.0, 2) * 1.12, pad=False)
    bus = np.stack([mid + side, mid - side], axis=1)

    # ---- phone-speaker voicing (AIR_DB, PRESENCE_DB, LOWCUT_DB): a shelf above ~4.5 kHz, presence around 2.8 kHz,
    #      less below ~140 Hz. All broad first-order shapes.
    def shelf(fr, fc, gdb):
        A = db(gdb)
        return np.sqrt((1.0 + (A * fr / fc) ** 2) / (1.0 + (fr / fc) ** 2))

    def bell(fr, fc, gdb, q=0.8):
        return 1.0 + (db(gdb) - 1.0) / (1.0 + (q * (fr / fc - fc / np.maximum(fr, 1.0))) ** 2)

    bus = fft_filter(bus, lambda fr: shelf(fr, 4500.0, AIR_DB) * bell(fr, 2800.0, PRESENCE_DB, q=0.7) / shelf(fr, 140.0, LOWCUT_DB)
                     * bell(fr, 380.0, MUD_DB, q=0.9),
                     pad=False)

    bus = ride_build(bus)      # after the voicing EQ, so it rides what the master will hear

    # ---- end shape: ring out, fully silent from SILENT
    env = np.ones(N)
    f0, f1 = T(SILENT - 1.5), T(SILENT)
    env[f0:f1] = 0.5 + 0.5 * np.cos(np.pi * np.arange(f1 - f0) / (f1 - f0))
    env[f1:] = 0.0
    bus *= env[:, None]
    bus -= bus.mean(axis=0, keepdims=True) * (env[:, None] > 0)

    y = master(bus, target_lufs=MUSIC_LUFS, tp_limit_db=-0.3)   # an intermediate: mix.py trims it 3 dB and masters again
    y *= (env[:, None] > 0)
    assert y.shape == (N, 2)
    out = os.path.join(audio_dir(), "music.wav")
    write_wav(out, y, bits=24)
    # ---- what the limiter took at each big hit (25 ms either side), for verify_audio.py
    gr = audiolib.LAST_GR
    hits = {name: round(-to_db(gr[T(t - 0.025):T(t + 0.1)].min()), 2)
            for name, t in (("home", HOME), ("step", STEP), ("arrive", ARRIVE), ("flow", FLOWSTEP), ("pull", PULL), ("chord", END))}
    hits["limited_pct"] = round(100 * float(np.mean(gr < 0.999)), 1)
    hits["max_gr"] = round(-to_db(gr.min()), 2)
    with open(os.path.join(audio_dir(), "music-limiter.json"), "w") as f:
        json.dump(hits, f)
    print("  limiter at the hits (dB): " + ", ".join(f"{k} {v}" for k, v in hits.items()))
    for name, t in (("step", STEP), ("pull", PULL)):
        pk = sorted(((to_db(np.max(np.abs(b[T(t):T(t + 0.06)]))), n) for n, b in STEMS.items()), reverse=True)[:6]
        print(f"  loudest stems in the 60 ms after {name}: " + ", ".join(f"{n} {v:.1f}" for v, n in pk))

    # ---- per-stem report (pre-master levels, dBFS RMS over a window where the stem plays)
    print(f"  stem RMS in bars 27-28 ({PULL}-{ROT}s), dBFS, pre-master:")
    for name in ("kick", "bass", "hook", "ep", "uke", "pad", "ctr", "arp", "snare", "snap", "wood", "shaker", "brushsw", "tamb"):
        print(f"    {name:7s} {rms_db(STEMS[name][ref]):7.1f}   peak {to_db(np.max(np.abs(STEMS[name][ref]))):6.1f}")
    print(f"  wrote {out}  ({N} samples, {N / SR:.3f}s) in {time.time() - t_start:.1f}s")


if __name__ == "__main__":
    main()
