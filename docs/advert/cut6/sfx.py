#!/usr/bin/env python3
"""Athena cut 5 interface sounds: short, quiet one-shots, 48 kHz stereo, tuned to the music (D major).

Run: python3 sfx.py  ->  $FILM/audio/sfx/*.wav
Every file starts at its onset (no lead-in), so a cue time is the moment the sound is heard.
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audiolib import SR, audio_dir, db, to_db, mtof, write_wav, g_lp, g_hp, fft_filter, edges, make_ir, convolve_reverb


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
    """Soft keyboard tick: a tiny filtered click over a short low 'thock'. Four slightly different keys."""
    n, t = tgrid(0.06)
    centre = (2600.0, 2950.0, 2350.0, 3200.0)[var]
    body_f = (mtof(57), mtof(59), mtof(54), mtof(62))[var]      # A3 B3 F#3 D4
    click = fft_filter(noise(n, 100 + var), lambda f: g_hp(f, centre * 0.6, 2) * g_lp(f, centre * 1.6, 2))
    click *= np.exp(-t / 0.0035)[:, None]
    body = np.sin(2 * np.pi * body_f * t) * np.exp(-t / 0.011)
    return norm(edges(0.8 * click + 0.55 * body[:, None], 0.0006, 0.02), -15.0)


def send():
    """Short airy whoosh upward."""
    dur = 0.36
    x, t = chirp_noise(dur, lambda t: 900.0 * (5600.0 / 900.0) ** (t / dur), 1100.0, 110)
    env = np.sin(np.pi * np.clip(t / dur, 0, 1) ** 0.7) ** 2
    tone = np.sin(2 * np.pi * np.cumsum(mtof(81) * 2 ** (t / dur * 5 / 12.0)) / SR) * env * 0.05   # faint A5->D6 glide
    return norm(edges(x * env[:, None] + tone[:, None], 0.01, 0.04), -15.0)


def bell(midi, dur, tau):
    n, t = tgrid(dur)
    f = mtof(midi)
    s = (np.sin(2 * np.pi * f * t) * np.exp(-t / tau)
         + 0.25 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / (tau * 0.5))
         + 0.10 * np.sin(2 * np.pi * 4 * f * t) * np.exp(-t / (tau * 0.2)))
    return edges(s, 0.003, 0.05)


def answer():
    """Gentle two-note chime, A5 then D6 (lands on the tonic), with a little room."""
    n, _ = tgrid(1.3)
    x = np.zeros((n, 2))
    a = bell(81, 1.1, 0.30)
    b = bell(86, 1.1, 0.38)
    x[: len(a), 0] += a * 1.0
    x[: len(a), 1] += a * 0.8
    i = int(0.12 * SR)
    x[i:i + len(b), 0] += b[: n - i] * 0.8
    x[i:i + len(b), 1] += b[: n - i] * 1.0
    wet = convolve_reverb(x, make_ir(rt60=0.9, seed=21))
    return norm(edges(x + 0.25 * wet, 0.002, 0.15), -13.0)


def drop():
    """Soft thock for a card landing: A3 falling to A2 with a felted click."""
    n, t = tgrid(0.22)
    f = 110.0 + 110.0 * np.exp(-t / 0.018)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.045)
    click = fft_filter(noise(n, 120), lambda fr: g_lp(fr, 5000.0, 2) * g_hp(fr, 300.0, 1)) * np.exp(-t / 0.006)[:, None]
    return norm(edges(body[:, None] + 0.6 * click, 0.001, 0.04), -12.0)      # r2: the click carries it on a phone


def land():
    """Something settling into its slot (the poster in Watch & read): drop()'s thock, lighter, under a papery
    1.5-6 kHz click and a tiny D7, so a phone speaker hears it (drop()'s body sits at 110-220 Hz)."""
    n, t = tgrid(0.22)
    f = 110.0 + 110.0 * np.exp(-t / 0.018)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.04)
    click = fft_filter(noise(n, 125), lambda fr: g_hp(fr, 1500.0, 2) * g_lp(fr, 6000.0, 2)) * np.exp(-t / 0.007)[:, None]
    tone = np.sin(2 * np.pi * mtof(98) * t) * np.exp(-t / 0.05)
    return norm(edges(0.45 * body[:, None] + 0.9 * click + 0.35 * tone[:, None], 0.001, 0.04), -12.0)


def tick():
    """Check-off: a crisp click with a bright F#6 + F#7/A7 tone (cut 3's sat at 1.5-1.8 kHz, under the hats'
    neighbours; the octave puts it in the 2-8 kHz a phone speaker plays) over a tiny low thock."""
    n, t = tgrid(0.2)
    click = fft_filter(noise(n, 130), lambda fr: g_hp(fr, 3000.0, 2) * g_lp(fr, 9000.0, 2)) * np.exp(-t / 0.003)[:, None]
    tone = (0.6 * np.sin(2 * np.pi * mtof(90) * t) * np.exp(-t / 0.05)
            + np.sin(2 * np.pi * mtof(102) * t) * np.exp(-t / 0.045) + 0.5 * np.sin(2 * np.pi * mtof(105) * t) * np.exp(-t / 0.03))
    low = np.sin(2 * np.pi * mtof(66) * t) * np.exp(-t / 0.012) * 0.3
    return norm(edges(0.8 * click + 0.5 * tone[:, None] + low[:, None], 0.0006, 0.04), -13.0)


WHOOSH_PEAK = 0.17      # every whoosh peaks this far in: cue onset = the camera move's fastest frame - 0.17 s


def whoosh():
    """Soft transition swish; peaks 0.17 s in, drifts left to right. The band rides 1.5-4 kHz, above the hook
    and the electric piano, where a phone speaker is loudest (cut 3 sat at 0.6-2.9 kHz and was buried)."""
    dur = 0.62
    x, t = chirp_noise(dur, lambda t: 1500.0 + 2500.0 * np.exp(-((t - 0.19) / 0.15) ** 2), 1800.0, 140)
    env = np.where(t < WHOOSH_PEAK, np.sin(0.5 * np.pi * t / WHOOSH_PEAK) ** 2, np.exp(-(t - WHOOSH_PEAK) / 0.13))
    p = np.clip(t / dur, 0, 1)
    pan = np.stack([np.cos(p * np.pi / 2) * 0.8 + 0.3, np.sin(p * np.pi / 2) * 0.8 + 0.3], axis=1)
    return norm(edges(x * env[:, None] * pan, 0.01, 0.06), -15.0)


def whoosh_big():
    """The dive and the pull-back: the same 0.17 s peak, a longer tail and a little low air for weight."""
    dur = 0.95
    x, t = chirp_noise(dur, lambda t: 1300.0 + 2700.0 * np.exp(-((t - 0.2) / 0.2) ** 2), 2200.0, 145)
    env = np.where(t < WHOOSH_PEAK, np.sin(0.5 * np.pi * t / WHOOSH_PEAK) ** 2, np.exp(-(t - WHOOSH_PEAK) / 0.24))
    n = len(t)
    low = fft_filter(noise(n, 146), lambda f: g_hp(f, 160.0, 2) * g_lp(f, 650.0, 2))
    p = np.clip(t / dur, 0, 1)
    pan = np.stack([np.cos(p * np.pi / 2) * 0.8 + 0.3, np.sin(p * np.pi / 2) * 0.8 + 0.3], axis=1)
    sig = (x + 0.5 * low / np.std(low) * np.std(x)) * env[:, None] * pan
    return norm(edges(sig, 0.01, 0.08), -14.0)


FORMANTS = {  # (F1, F2, F3) Hz
    "oo": (300.0, 870.0, 2240.0), "ah": (730.0, 1090.0, 2440.0), "ee": (270.0, 2290.0, 3010.0),
    "eh": (530.0, 1840.0, 2480.0), "oh": (570.0, 840.0, 2410.0)}


def voice(midi, v0="ee", v1="ah", dur=0.18, scoop=2.0, seed=0):
    """A tiny pitched vowel: a band-limited pulse at a pentatonic pitch, shaped by three formants that glide
    from vowel v0 to v1, with a soft nasal onset and a +scoop semitone upward scoop into the note.
    Cute, not cartoon: short, little vibrato, no pitch wobble at the end."""
    n, t = tgrid(dur + 0.12)
    x = np.clip(t / dur, 0, 1)
    sm = lambda u: u * u * (3 - 2 * u)
    f0 = mtof(midi) * 2 ** ((-scoop * (1 - sm(np.clip(t / 0.07, 0, 1))) + 0.12 * np.sin(2 * np.pi * 6.0 * t) * np.clip((t - 0.06) / 0.08, 0, 1)) / 12.0)
    ph = 2 * np.pi * np.cumsum(f0) / SR
    a, b = np.array(FORMANTS[v0]), np.array(FORMANTS[v1])
    mix = sm(np.clip((x - 0.15) / 0.6, 0, 1))[:, None]
    F = a[None, :] * (1 - mix) + b[None, :] * mix
    B = np.array([130.0, 220.0, 320.0])
    G = np.array([1.0, 0.7, 0.35])
    sig = np.zeros(n)
    for k in range(1, 24):
        fk = k * f0
        if mtof(midi) * k > 9000:
            break
        g = (G[None, :] / (1.0 + ((fk[:, None] - F) / (B / 2.0)) ** 2)).sum(axis=1) / k ** 0.8 + 0.02 / k ** 1.5
        sig += g * np.sin(k * ph)
    onset = np.clip(t / 0.03, 0, 1)                                  # "m": the highs open a beat after the body
    sig = sig * (0.35 + 0.65 * onset) + 0.25 * (1 - onset) * np.sin(ph) * (t < 0.03)
    env = np.where(t < 0.012, np.sin(0.5 * np.pi * t / 0.012) ** 2, 1.0) * np.where(t > dur - 0.06, np.exp(-(t - (dur - 0.06)) / 0.035), 1.0)
    breath = fft_filter(noise(n, 300 + seed, 1)[:, 0], lambda f: g_hp(f, 2500.0, 2) * g_lp(f, 7000.0, 2)) * np.exp(-t / 0.02) * 0.02
    dry = edges(sig * env + breath, 0.001, 0.03)
    st_ = np.stack([dry, dry], axis=1)
    wet = convolve_reverb(st_, make_ir(rt60=0.5, seed=23))
    return norm(edges(st_ + 0.18 * wet, 0.001, 0.04), -13.0)


def penny():
    """Penny's card arrives: F#5 (the major third over the bar's D), "ee" opening to "ah", a 2-semitone scoop up."""
    return voice(78, "ee", "ah", 0.18, 2.0, seed=1)


def face(v):
    """The team's faces popping in (Penny, Dot, Wren): tiny 90 ms vowel blips on D6, F#6, A6."""
    return voice((86, 90, 93)[v], ("ee", "oo", "ah")[v], ("ah", "ee", "oo")[v], 0.09, 1.0, seed=10 + v)


def penny_reply():
    """Penny answers: a step higher, A5, "eh" rounding to "oo", a touch quieter in the cue sheet."""
    return voice(81, "eh", "oo", 0.17, 2.0, seed=2)


STEP_LEAD = 0.6         # stepdown(): the landing is this far in; cue onset = the price drop's frame - 0.6 s
HELLO_LEN = 0.36        # hello(): both syllables are out by here; the team answers after it


def set_target():
    """The target is set (the "At or under £28" pill and the dashed line appear): a soft latch, then two small
    bells a fourth apart, A6 up to D7, 70 ms apart. Small and neat: a pin pushed into a board."""
    n, t = tgrid(0.55)
    x = np.zeros((n, 2))
    latch = fft_filter(noise(n, 180), lambda fr: g_hp(fr, 1800.0, 2) * g_lp(fr, 7000.0, 2)) * np.exp(-t / 0.004)[:, None]
    thock = np.sin(2 * np.pi * mtof(69) * (1 - 0.15 * np.exp(-t / 0.01)) * t) * np.exp(-t / 0.018)
    a = bell(93, 0.45, 0.10)
    b = bell(98, 0.45, 0.16)
    x[: len(a), 0] += 0.8 * a
    x[: len(a), 1] += 0.65 * a
    i = int(0.07 * SR)
    x[i:i + len(b), 0] += 0.8 * b[: n - i]
    x[i:i + len(b), 1] += 1.0 * b[: n - i]
    return norm(edges(x + 0.7 * latch + 0.45 * thock[:, None], 0.0006, 0.08), -13.0)


def stepdown():
    """The price stepping down under the target: five mallet steps down the pentatonic, B5 A5 F#5 E5 D5, on the
    16ths of one beat (the off ones 20 ms late, like the groove), each with a small wooden click, getting firmer;
    the last lands STEP_LEAD (0.6 s) in, on the tonic, with a D3 thock and its octave on top."""
    n, t = tgrid(STEP_LEAD + 0.9)
    x = np.zeros((n, 2))
    steps = ((0.0, 83), (0.17, 81), (0.30, 78), (0.47, 76), (STEP_LEAD, 74))
    for j, (at, m) in enumerate(steps):
        last = j == len(steps) - 1
        d = 0.85 if last else 0.3
        nn, tt = tgrid(d)
        f = mtof(m)
        note = (np.sin(2 * np.pi * f * tt) * np.exp(-tt / (0.4 if last else 0.09))
                + 0.35 * np.sin(2 * np.pi * 2 * f * tt) * np.exp(-tt / (0.2 if last else 0.05))
                + 0.25 * np.sin(2 * np.pi * 4 * f * tt) * np.exp(-tt / 0.03))
        click = fft_filter(noise(nn, 190 + j, 1)[:, 0], lambda fr: g_hp(fr, 2200.0, 2) * g_lp(fr, 7500.0, 2)) * np.exp(-tt / 0.003)
        sig = edges(note + 0.6 * click, 0.0008, 0.04) * (0.8 + 0.05 * j)
        if last:
            fl = mtof(50) + 40.0 * np.exp(-tt / 0.015)
            sig = 1.1 * sig + 0.7 * edges(np.sin(2 * np.pi * np.cumsum(fl) / SR) * np.exp(-tt / 0.07), 0.001, 0.04)
            sig += 0.3 * edges(np.sin(2 * np.pi * 2 * f * tt) * np.exp(-tt / 0.3), 0.001, 0.04)
        i = int(at * SR)
        p = -0.4 + 0.2 * j                                   # walks left to right, lands in the middle
        x[i:i + nn, 0] += sig * (1 - 0.5 * max(p, 0))
        x[i:i + nn, 1] += sig * (1 + 0.5 * min(p, 0))
    wet = convolve_reverb(x, make_ir(rt60=0.7, seed=24))
    return norm(edges(x + 0.15 * wet, 0.0006, 0.1), -11.0)


def reached():
    """Reached: the bright one. A quick D major run up, D6 F#6 A6 to a ringing D7 (55 ms apart), an A7 glint on
    top, in a little room. The same family as answer() and chip(), an octave of sparkle above them."""
    n, t = tgrid(1.6)
    x = np.zeros((n, 2))
    for j, (m, g, tau) in enumerate(((86, 0.7, 0.16), (90, 0.75, 0.18), (93, 0.85, 0.22), (98, 1.0, 0.5), (105, 0.3, 0.25))):
        b = bell(m, 1.4, tau)
        i = int((0.055 * min(j, 3) + (0.02 if j == 4 else 0.0)) * SR)
        p = (-0.5, 0.5, -0.25, 0.0, 0.3)[j]
        x[i:i + len(b), 0] += g * b * (1 - 0.6 * max(p, 0))
        x[i:i + len(b), 1] += g * b * (1 + 0.6 * min(p, 0))
    click = fft_filter(noise(n, 200), lambda fr: g_hp(fr, 3000.0, 2) * g_lp(fr, 9000.0, 2)) * np.exp(-t / 0.003)[:, None]
    wet = convolve_reverb(x, make_ir(rt60=1.1, seed=25))
    return norm(edges(x + 0.4 * click + 0.3 * wet, 0.0006, 0.2), -11.0)


def hello():
    """The new assistant says hello: its own small voice, not Penny's. Two syllables, "eh" on B5 then a longer
    "oh" on D6 (Penny is one "ee-ah" on F#5): higher, rounder, and it ends on the tonic, where the team's three
    blips (D6, F#6, A6) pick it up."""
    a = voice(83, "eh", "eh", 0.085, 1.0, seed=5)
    b = voice(86, "eh", "oh", 0.17, 1.5, seed=6)
    i = int(0.13 * SR)
    n = i + len(b)
    x = np.zeros((n, 2))
    x[: len(a)] += 0.8 * a
    x[i:] += b
    return norm(x, -12.0)


def chip():
    """A status chip changes ("12 min late"): a falling F#6 -> D6 bell pair 60 ms apart over tick()'s 3 kHz click."""
    n, t = tgrid(0.7)
    x = np.zeros((n, 2))
    a = bell(90, 0.6, 0.16)
    b = bell(86, 0.6, 0.2)
    x[: len(a), 0] += a
    x[: len(a), 1] += 0.85 * a
    i = int(0.06 * SR)
    x[i:i + len(b), 0] += 0.8 * b[: n - i]
    x[i:i + len(b), 1] += 0.95 * b[: n - i]
    click = fft_filter(noise(n, 131), lambda fr: g_hp(fr, 3000.0, 2) * g_lp(fr, 9000.0, 2)) * np.exp(-t / 0.003)[:, None]
    return norm(edges(x + 0.6 * click, 0.0006, 0.08), -13.0)


def cut_accent():
    """A hard picture cut on the beat: a tight 'tsk' of air (2-8 kHz, ~25 ms) over a short D2 thump. No swish:
    nothing travels across a cut."""
    n, t = tgrid(0.2)
    tsk = fft_filter(noise(n, 175), lambda fr: g_hp(fr, 2000.0, 2) * g_lp(fr, 8000.0, 2)) * np.exp(-t / 0.008)[:, None]
    f = mtof(38) + 30.0 * np.exp(-t / 0.015)
    thump = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.045)
    return norm(edges(0.8 * tsk + 0.7 * thump[:, None], 0.0005, 0.04), -13.0)


def cut():
    """Very subtle low thump on D2."""
    n, t = tgrid(0.26)
    f = mtof(38) + 22.0 * np.exp(-t / 0.02)
    return norm(edges(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.07), 0.003, 0.05), -12.0)


def pop(var):
    """Soft round pop (a tile or the orb appearing): a quick upward blip, D5 / F#5 / A5."""
    n, t = tgrid(0.16)
    f1 = mtof((74, 78, 81)[var])
    f = f1 * (1.0 - 0.45 * np.exp(-t / 0.012))
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = (np.sin(ph) + 0.18 * np.sin(2 * ph)) * np.exp(-t / 0.032)
    air = fft_filter(noise(n, 150 + var), lambda fr: g_hp(fr, 900.0, 2) * g_lp(fr, 3500.0, 2)) * np.exp(-t / 0.005)[:, None]
    return norm(edges(body[:, None] + 0.12 * air, 0.0015, 0.04), -13.0)


def press():
    """Very soft pointer tap: a felt-tip touch."""
    n, t = tgrid(0.09)
    body = np.sin(2 * np.pi * mtof(62) * (1 - 0.2 * np.exp(-t / 0.01)) * t) * np.exp(-t / 0.014)
    click = fft_filter(noise(n, 160), lambda fr: g_hp(fr, 1800.0, 2) * g_lp(fr, 6000.0, 2)) * np.exp(-t / 0.003)[:, None]
    return norm(edges(body[:, None] + 0.7 * click, 0.001, 0.03), -18.0)


def select():
    """Tiny rising swipe for a text selection: a thread of air with a faint F#6->A6 glide."""
    dur = 0.24
    x, t = chirp_noise(dur, lambda t: 2200.0 * (6500.0 / 2200.0) ** (t / dur), 800.0, 170)
    env = np.sin(np.pi * np.clip(t / dur, 0, 1) ** 0.8) ** 2
    tone = np.sin(2 * np.pi * np.cumsum(mtof(90) * 2 ** (t / dur * 3 / 12.0)) / SR) * env * 0.10
    return norm(edges(x * env[:, None] + tone[:, None], 0.008, 0.04), -17.0)


def main():
    d = os.path.join(audio_dir(), "sfx")
    os.makedirs(d, exist_ok=True)
    files = {"send": send(), "answer": answer(), "drop": drop(), "tick": tick(), "whoosh": whoosh(), "cut": cut(),
             "press": press(), "select": select(), "whoosh_big": whoosh_big(), "penny": penny(),
             "penny_reply": penny_reply(), "chip": chip(), "land": land(), "cut_accent": cut_accent(), "face1": face(0), "face2": face(1), "face3": face(2),
             "set": set_target(), "stepdown": stepdown(), "reached": reached(), "hello": hello()}
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
