#!/usr/bin/env python3
"""Athena cut 6 interface sounds: short, quiet one-shots, 48 kHz stereo, tuned to the music (D major).
Cut 6 palette: small wooden and glass taps, soft pops and bubbles, breathy air for the moves, kalimba and
glockenspiel for the story beats, gentler vowel voices (all from audiolib's acoustic models).

Run: python3 sfx.py  ->  $FILM/audio/sfx/*.wav
Every file starts at its onset (no lead-in), so a cue time is the moment the sound is heard.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audiolib import SR, audio_dir, db, to_db, mtof, write_wav, g_lp, g_hp, fft_filter, edges, make_ir, convolve_reverb
from audiolib import kalimba, glock, celesta, marimba, wood, felt_kick, low_tom, breath_air


def tgrid(dur):
    n = int(dur * SR)
    return n, np.arange(n) / SR


def noise(n, seed, ch=2):
    return np.random.default_rng(seed).standard_normal((n, ch))


def st(x):
    return x if x.ndim == 2 else np.stack([x, x], axis=1)


def norm(x, peak_db):
    x = st(x)
    x = x - x.mean(axis=0, keepdims=True)
    return x * (db(peak_db) / np.max(np.abs(x)))


def chirp_noise(dur, freqs, bw, seed):
    """Band of noise whose centre follows freqs(t): air that moves, with no filter sweep artefacts."""
    n, t = tgrid(dur)
    nz = fft_filter(noise(n, seed), lambda f: g_lp(f, bw / 2.0, 3))
    ph = 2 * np.pi * np.cumsum(freqs(t)) / SR
    return nz * np.stack([np.cos(ph), np.sin(ph)], axis=1), t


def key(var):
    """A keystroke: a small wooden tap (a tiny block, four sizes, 2.0-2.7 kHz, gone in ~12 ms) over a faint felt
    thock, like typing on a wooden toy keyboard."""
    f = (2150.0, 2450.0, 2000.0, 2700.0)[var]
    tap = wood(f, 0.05, vel=0.6, seed=100 + var)
    n, t = tgrid(0.05)
    body = np.sin(2 * np.pi * (mtof(57), mtof(59), mtof(54), mtof(62))[var] * t) * np.exp(-t / 0.008)
    return norm(edges(tap + 0.25 * body, 0.0006, 0.015), -16.0)


def send():
    """Sending: a short, soft breath upward with a little glass 'tink' (D7 on a glockenspiel) as it leaves."""
    dur = 0.36
    x = breath_air(dur, 800.0, 3600.0, seed=110, shape=1.0)
    n, t = tgrid(dur)
    env = np.sin(np.pi * np.clip(t / dur, 0, 1) ** 0.7) ** 2
    x = x * env[:, None] / (np.max(np.abs(x)) + 1e-9)
    tk = glock(98, dur, vel=0.6, seed=111)
    i = int(0.22 * SR)
    x[i:, :] += 0.25 * tk[: n - i, None]
    return norm(edges(x, 0.01, 0.04), -16.0)


def answer():
    """A gentle two-note kalimba answer, A5 then D6 (lands on the tonic), with a little room."""
    n, _ = tgrid(1.3)
    x = np.zeros((n, 2))
    a = kalimba(81, 1.1, seed=21)
    b = kalimba(86, 1.1, seed=22)
    x[: len(a), 0] += a * 1.0
    x[: len(a), 1] += a * 0.8
    i = int(0.12 * SR)
    x[i:i + len(b), 0] += b[: n - i] * 0.8
    x[i:i + len(b), 1] += b[: n - i] * 1.0
    wet = convolve_reverb(x, make_ir(rt60=0.9, seed=21))
    return norm(edges(x + 0.25 * wet, 0.002, 0.15), -13.0)


def drop():
    """A card landing: a low soft-mallet marimba 'tok' (A3) with a papery 1.5-5 kHz brush of contact on top, so
    a phone speaker hears it."""
    n, t = tgrid(0.25)
    body = marimba(57, 0.25, vel=0.8, seed=120)
    click = fft_filter(noise(n, 120), lambda fr: g_hp(fr, 1500.0, 2) * g_lp(fr, 5000.0, 2)) * np.exp(-t / 0.005)[:, None]
    return norm(edges(body[:, None] + 0.35 * click / np.max(np.abs(click)), 0.001, 0.04), -12.0)


def land():
    """Something settling into its slot (the poster in Watch & read): drop()'s wooden tok, lighter, a papery click
    and a tiny glass D7, so a phone speaker hears it."""
    n, t = tgrid(0.3)
    body = marimba(62, 0.3, vel=0.7, seed=125)
    click = fft_filter(noise(n, 125), lambda fr: g_hp(fr, 1500.0, 2) * g_lp(fr, 6000.0, 2)) * np.exp(-t / 0.006)[:, None]
    tone = glock(98, 0.3, vel=0.5, seed=126)
    return norm(edges(0.6 * body[:, None] + 0.35 * click / np.max(np.abs(click)) + 0.35 * tone[:, None], 0.001, 0.04), -12.0)


def tick():
    """Check-off: a small glass tap, two glockenspiel bars struck together (F#6 and D7, the D7 louder), over a
    tiny wooden click."""
    n, t = tgrid(0.35)
    tone = 0.55 * glock(90, 0.35, vel=0.6, seed=130) + glock(98, 0.35, vel=0.6, seed=131)
    ck = wood(2600.0, 0.35, vel=0.5, seed=132)
    return norm(edges(0.6 * tone[:, None] + 0.45 * ck[:, None], 0.0006, 0.06), -13.0)


WHOOSH_PEAK = 0.17      # every whoosh peaks this far in: cue onset = the camera move's fastest frame - 0.17 s


def _air_move(dur, lo, hi, tail, seed, peak=WHOOSH_PEAK):
    """A soft breath past the ear: wide, gently filtered noise whose band lifts towards the peak and settles,
    the level a smooth rise to `peak` s and an exhale after; drifts left to right."""
    n, t = tgrid(dur)
    x = breath_air(dur, lo, hi, seed=seed, shape=0.0)
    x /= np.max(np.abs(x)) + 1e-9
    env = np.where(t < peak, np.sin(0.5 * np.pi * t / peak) ** 2, np.exp(-(t - peak) / tail))
    p = np.clip(t / dur, 0, 1)
    pan = np.stack([np.cos(p * np.pi / 2) * 0.7 + 0.35, np.sin(p * np.pi / 2) * 0.7 + 0.35], axis=1)
    return x * env[:, None] * pan


def whoosh():
    """A camera move: soft breathy air (1-3.5 kHz, no whistle), peaking 0.17 s in, drifting left to right."""
    return norm(edges(_air_move(0.62, 1000.0, 3500.0, 0.13, 140), 0.01, 0.06), -17.0)


def whoosh_big():
    """The dive and the pull-back: the same 0.17 s peak, a longer exhale and a little low air for weight."""
    dur = 0.95
    x = _air_move(dur, 700.0, 3200.0, 0.24, 145)
    n, t = tgrid(dur)
    low = fft_filter(noise(n, 146), lambda f: g_hp(f, 160.0, 2) * g_lp(f, 600.0, 2))
    env = np.where(t < WHOOSH_PEAK, np.sin(0.5 * np.pi * t / WHOOSH_PEAK) ** 2, np.exp(-(t - WHOOSH_PEAK) / 0.24))
    x = x + 0.4 * low / np.std(low) * np.std(x) * env[:, None]
    return norm(edges(x, 0.01, 0.08), -16.0)


FORMANTS = {  # (F1, F2, F3) Hz
    "oo": (300.0, 870.0, 2240.0), "ah": (730.0, 1090.0, 2440.0), "ee": (270.0, 2290.0, 3010.0),
    "eh": (530.0, 1840.0, 2480.0), "oh": (570.0, 840.0, 2410.0)}


def voice(midi, v0="ee", v1="ah", dur=0.18, scoop=2.0, seed=0):
    """A tiny pitched vowel, rounder and gentler than cut 5's: a soft glottal source (harmonics falling at
    k^-1.6, not a buzzy pulse), three wide formants that glide from vowel v0 to v1 with the upper two turned
    down, a 25 ms rise, a +scoop semitone upward scoop into the note and a little vibrato (5.5 Hz, +-0.3 st)
    that blooms after 70 ms, a breath of air at the start, a small room."""
    n, t = tgrid(dur + 0.14)
    x = np.clip(t / dur, 0, 1)
    sm = lambda u: u * u * (3 - 2 * u)
    vib = 0.3 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.07) / 0.08, 0, 1)
    f0 = mtof(midi) * 2 ** ((-scoop * (1 - sm(np.clip(t / 0.08, 0, 1))) + vib) / 12.0)
    ph = 2 * np.pi * np.cumsum(f0) / SR
    a, b = np.array(FORMANTS[v0]), np.array(FORMANTS[v1])
    mix = sm(np.clip((x - 0.15) / 0.6, 0, 1))[:, None]
    F = a[None, :] * (1 - mix) + b[None, :] * mix
    B = np.array([180.0, 300.0, 420.0])
    G = np.array([1.0, 0.45, 0.15])
    sig = np.zeros(n)
    for k in range(1, 16):
        fk = k * f0
        if mtof(midi) * k > 6000:
            break
        g = (G[None, :] / (1.0 + ((fk[:, None] - F) / (B / 2.0)) ** 2)).sum(axis=1) / k ** 1.6 + 0.05 / k ** 2
        sig += g * np.sin(k * ph)
    env = np.where(t < 0.025, np.sin(0.5 * np.pi * t / 0.025) ** 2, 1.0) * np.where(t > dur - 0.06, np.exp(-(t - (dur - 0.06)) / 0.04), 1.0)
    breath = fft_filter(noise(n, 300 + seed, 1)[:, 0], lambda f: g_hp(f, 1500.0, 2) * g_lp(f, 5000.0, 2)) * np.exp(-t / 0.03) * 0.012
    dry = edges(sig * env + breath, 0.001, 0.03)
    st_ = np.stack([dry, dry], axis=1)
    wet = convolve_reverb(st_, make_ir(rt60=0.5, seed=23))
    return norm(edges(st_ + 0.2 * wet, 0.001, 0.04), -13.0)


def penny():
    """Penny's card arrives: F#5 (the major third over the bar's D), "ee" opening to "ah", a 2-semitone scoop up."""
    return voice(78, "ee", "ah", 0.2, 2.0, seed=1)


def face(v):
    """The team's faces popping in (Penny, Dot, Wren): tiny 100 ms vowel blips on D6, F#6, A6."""
    return voice((86, 90, 93)[v], ("ee", "oo", "ah")[v], ("ah", "ee", "oo")[v], 0.1, 1.0, seed=10 + v)


def penny_reply():
    """Penny answers: a step higher, A5, "eh" rounding to "oo", a touch quieter in the cue sheet."""
    return voice(81, "eh", "oo", 0.18, 2.0, seed=2)


STEP_LEAD = 0.6         # stepdown(): the landing is this far in; cue onset = the price drop's frame - 0.6 s
HELLO_LEN = 0.36        # hello(): both syllables are out by here; the team answers after it


def bubble(f0=500.0, f1=1400.0, dur=0.12, seed=0):
    """A water bubble: a sine whose pitch rises fast (a bubble's resonance as it shrinks), ~60 ms."""
    n, t = tgrid(dur)
    f = f0 * (f1 / f0) ** np.clip(t / 0.04, 0, 1) ** 0.7
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = (np.sin(ph) + 0.3 * np.sin(2 * ph) + 0.12 * np.sin(3 * ph)) * np.exp(-t / 0.035)
    s += 0.25 * np.sin(4 * ph) * np.exp(-t / 0.008)          # the 'plip' of the surface: a phone speaker hears it
    a = int(0.002 * SR)
    s[:a] *= np.linspace(0, 1, a)
    return edges(s, 0.0002, 0.02)


def set_target():
    """The target is set (the "At or under" pill and the dashed line appear): a round water bubble, then two small
    glockenspiel bells a fourth apart, A6 up to D7, 70 ms apart. Small and neat."""
    n, t = tgrid(0.6)
    x = np.zeros((n, 2))
    bb = bubble(520.0, 1500.0, 0.12, seed=180)
    a = glock(93, 0.5, vel=0.6, seed=181)
    b = glock(98, 0.5, vel=0.6, seed=182)
    x[: len(bb)] += 0.9 * bb[:, None]
    i = int(0.035 * SR)
    x[i:i + len(a), 0] += 0.55 * a[: n - i]
    x[i:i + len(a), 1] += 0.45 * a[: n - i]
    i = int(0.105 * SR)
    x[i:i + len(b), 0] += 0.55 * b[: n - i]
    x[i:i + len(b), 1] += 0.7 * b[: n - i]
    return norm(edges(x, 0.0006, 0.08), -13.0)


def stepdown():
    """The price stepping down under the target: five kalimba steps down the pentatonic, B5 A5 F#5 E5 D5, on the
    16ths of one beat (the off ones 20 ms late, like the groove), each with a small wooden click, getting firmer;
    the last lands STEP_LEAD (0.6 s) in, on the tonic, with a soft low tom on D3 and a glockenspiel octave above."""
    n, t = tgrid(STEP_LEAD + 1.0)
    x = np.zeros((n, 2))
    steps = ((0.0, 83), (0.17, 81), (0.30, 78), (0.47, 76), (STEP_LEAD, 74))
    for j, (at, m) in enumerate(steps):
        last = j == len(steps) - 1
        d = 0.95 if last else 0.45
        note = kalimba(m, d, vel=1.0, seed=190 + j)
        ck = wood(2300.0 + 150 * j, d, vel=0.6, seed=195 + j)
        sig = (note + 0.35 * ck) * (0.8 + 0.05 * j)
        if last:
            tom = low_tom(50, 1.0)[: len(sig)]
            sig = 1.1 * sig
            sig[: len(tom)] += 0.6 * tom
            g8 = glock(86, d, vel=0.8, seed=199)
            sig += 0.35 * g8
        i = int(at * SR)
        nn = min(len(sig), n - i)
        p = -0.4 + 0.2 * j                                   # walks left to right, lands in the middle
        x[i:i + nn, 0] += sig[:nn] * (1 - 0.5 * max(p, 0))
        x[i:i + nn, 1] += sig[:nn] * (1 + 0.5 * min(p, 0))
    wet = convolve_reverb(x, make_ir(rt60=0.7, seed=24))
    return norm(edges(x + 0.15 * wet, 0.0006, 0.1), -11.0)


def reached():
    """Reached: the bright one. A quick D major run up on glockenspiel and celesta, D6 F#6 A6 to a ringing D7
    (55 ms apart), an A7 glint on top, in a little room."""
    n, t = tgrid(1.6)
    x = np.zeros((n, 2))
    for j, (m, g) in enumerate(((86, 0.7), (90, 0.75), (93, 0.85), (98, 1.0), (105, 0.25))):
        b = (celesta if j % 2 else glock)(m, 1.4, vel=0.8, seed=200 + j)
        i = int((0.055 * min(j, 3) + (0.02 if j == 4 else 0.0)) * SR)
        p = (-0.5, 0.5, -0.25, 0.0, 0.3)[j]
        x[i:i + len(b), 0] += g * b * (1 - 0.6 * max(p, 0))
        x[i:i + len(b), 1] += g * b * (1 + 0.6 * min(p, 0))
    wet = convolve_reverb(x, make_ir(rt60=1.1, seed=25))
    return norm(edges(x + 0.3 * wet, 0.0006, 0.2), -11.0)


def hello():
    """The new assistant says hello: its own small voice, not Penny's. Two syllables, "eh" on B5 then a longer
    "oh" on D6 (Penny is one "ee-ah" on F#5): higher, rounder, and it ends on the tonic, where the team's
    blips (D6, A6) pick it up."""
    a = voice(83, "eh", "eh", 0.09, 1.0, seed=5)
    b = voice(86, "eh", "oh", 0.18, 1.5, seed=6)
    i = int(0.13 * SR)
    n = i + len(b)
    x = np.zeros((n, 2))
    x[: len(a)] += 0.8 * a
    x[i:] += b
    return norm(x, -12.0)


def chip():
    """A status chip changes ("12 min late"): a falling F#6 -> D6 pair on glass (glockenspiel), 60 ms apart,
    over a small wooden click."""
    n, t = tgrid(0.7)
    x = np.zeros((n, 2))
    a = glock(90, 0.6, vel=0.7, seed=210)
    b = glock(86, 0.6, vel=0.7, seed=211)
    x[: len(a), 0] += a
    x[: len(a), 1] += 0.85 * a
    i = int(0.06 * SR)
    x[i:i + len(b), 0] += 0.8 * b[: n - i]
    x[i:i + len(b), 1] += 0.95 * b[: n - i]
    ck = wood(2600.0, 0.7, vel=0.6, seed=212)
    return norm(edges(x + 0.4 * ck[:, None], 0.0006, 0.08), -13.0)


def cut_accent():
    """A hard picture cut on the beat: a low woodblock 'tock' with a puff of air under it, and a soft felt
    thump. Nothing travels across a cut."""
    n, t = tgrid(0.2)
    tk = wood(700.0, 0.2, vel=0.8, seed=175)
    puff = fft_filter(noise(n, 175), lambda fr: g_hp(fr, 1200.0, 1) * g_lp(fr, 4000.0, 2)) * np.exp(-t / 0.012)[:, None]
    thump = felt_kick(0.8)[:n]
    thump = np.pad(thump, (0, n - len(thump)))
    return norm(edges(0.8 * tk[:, None] + 0.15 * puff / np.max(np.abs(puff)) + 0.5 * thump[:, None], 0.0005, 0.04), -13.0)


def cut():
    """Very subtle felt thump."""
    n, t = tgrid(0.26)
    x = felt_kick(0.7)
    return norm(edges(np.pad(x, (0, max(0, n - len(x))))[:n], 0.003, 0.05), -12.0)


def pop(var):
    """A soft round pop (a tile or the orb appearing): a bubble 'plop' landing on D5 / F#5 / A5."""
    f1 = mtof((74, 78, 81)[var])
    b = bubble(f1 * 0.55, f1, 0.16, seed=150 + var)
    return norm(edges(b, 0.0015, 0.04), -13.0)


def press():
    """Very soft pointer tap: a fingertip on a small wooden block."""
    x = wood(1700.0, 0.06, vel=0.4, seed=160)
    n, t = tgrid(0.06)
    body = np.sin(2 * np.pi * mtof(62) * t) * np.exp(-t / 0.01)
    return norm(edges(x + 0.4 * body, 0.001, 0.02), -18.0)


def select():
    """A text selection: a thread of breath rising, with a faint glass F#6 as it ends."""
    dur = 0.24
    x = breath_air(dur, 1800.0, 5000.0, seed=170, shape=0.0)
    n, t = tgrid(dur)
    env = np.sin(np.pi * np.clip(t / dur, 0, 1) ** 0.8) ** 2
    x = x / (np.max(np.abs(x)) + 1e-9) * env[:, None]
    g = glock(90, dur, vel=0.4, seed=171)
    i = int(0.14 * SR)
    x[i:, :] += 0.2 * g[: n - i, None]
    return norm(edges(x, 0.008, 0.04), -17.0)


def flowstep(var):
    """One of the flow's steps arriving ("When ..." / "Then ..."): a small soft-mallet marimba plink with a glass
    glint and a tiny bubble under it, climbing A6, B6, D7, E7 step by step."""
    m = (81, 83, 86, 88)[var]
    n, t = tgrid(0.45)
    x = marimba(m, 0.45, vel=0.8, seed=220 + var) + 0.3 * glock(m + 12, 0.45, vel=0.5, seed=224 + var)
    bb = bubble(mtof(m) * 0.5, mtof(m), 0.1, seed=228 + var)
    x[: len(bb)] += 0.35 * bb
    return norm(edges(x, 0.0008, 0.06), -14.0)


def toggle():
    """The flow's switch turning on: a soft wooden click, then a bubble rising to A6."""
    n, t = tgrid(0.25)
    ck = wood(1900.0, 0.25, vel=0.6, seed=230)
    bb = bubble(mtof(81) * 0.6, mtof(93), 0.15, seed=231)
    i = int(0.03 * SR)
    ck[i:i + len(bb)] += 0.8 * bb[: n - i]
    return norm(edges(ck, 0.0006, 0.05), -14.0)


def main():
    d = os.path.join(audio_dir(), "sfx")
    os.makedirs(d, exist_ok=True)
    files = {"send": send(), "answer": answer(), "drop": drop(), "tick": tick(), "whoosh": whoosh(), "cut": cut(),
             "press": press(), "select": select(), "whoosh_big": whoosh_big(), "penny": penny(),
             "penny_reply": penny_reply(), "chip": chip(), "land": land(), "cut_accent": cut_accent(), "face1": face(0), "face2": face(1), "face3": face(2),
             "set": set_target(), "stepdown": stepdown(), "reached": reached(), "hello": hello(), "toggle": toggle()}
    for v in range(4):
        files[f"flowstep{v + 1}"] = flowstep(v)
    files["flowstep"] = files["flowstep1"]
    for v in range(4):
        files[f"key{v + 1}"] = key(v)
    files["key"] = files["key1"]
    for v in range(3):
        files[f"pop{v + 1}"] = pop(v)
    files["pop"] = files["pop1"]
    for name, x in sorted(files.items()):
        write_wav(os.path.join(d, name + ".wav"), x, bits=24)
        print(f"  {name:11s} {len(x) / SR * 1000:6.0f} ms  peak {to_db(np.max(np.abs(x))):6.1f} dBFS  "
              f"dc {abs(x.mean()):.1e}")
    print(f"  wrote {len(files)} files to {d}")


if __name__ == "__main__":
    main()
