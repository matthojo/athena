#!/usr/bin/env python3
"""Athena cut 3 interface sounds: short, quiet one-shots, 48 kHz stereo, tuned to the music (D major).

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
    click = fft_filter(noise(n, 120), lambda fr: g_lp(fr, 1800.0, 2) * g_hp(fr, 300.0, 1)) * np.exp(-t / 0.006)[:, None]
    return norm(edges(body[:, None] + 0.25 * click, 0.001, 0.04), -12.0)


def tick():
    """Check-off: a crisp small click with a tiny F#6/A6 tone."""
    n, t = tgrid(0.2)
    click = fft_filter(noise(n, 130), lambda fr: g_hp(fr, 3000.0, 2) * g_lp(fr, 9000.0, 2)) * np.exp(-t / 0.003)[:, None]
    tone = (np.sin(2 * np.pi * mtof(90) * t) * np.exp(-t / 0.05) + 0.45 * np.sin(2 * np.pi * mtof(93) * t) * np.exp(-t / 0.035))
    low = np.sin(2 * np.pi * mtof(66) * t) * np.exp(-t / 0.012) * 0.4
    return norm(edges(0.7 * click + 0.55 * tone[:, None] + low[:, None], 0.0006, 0.04), -13.0)


def whoosh():
    """Soft transition swish; peaks about 0.17 s in, drifts left to right."""
    dur = 0.62
    x, t = chirp_noise(dur, lambda t: 600.0 + 2300.0 * np.exp(-((t - 0.2) / 0.16) ** 2), 1500.0, 140)
    env = np.where(t < 0.17, np.sin(0.5 * np.pi * t / 0.17) ** 2, np.exp(-(t - 0.17) / 0.13))
    p = np.clip(t / dur, 0, 1)
    pan = np.stack([np.cos(p * np.pi / 2) * 0.8 + 0.3, np.sin(p * np.pi / 2) * 0.8 + 0.3], axis=1)
    return norm(edges(x * env[:, None] * pan, 0.01, 0.06), -15.0)


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
    click = fft_filter(noise(n, 160), lambda fr: g_hp(fr, 1200.0, 2) * g_lp(fr, 4000.0, 2)) * np.exp(-t / 0.003)[:, None]
    return norm(edges(body[:, None] + 0.3 * click, 0.001, 0.03), -18.0)


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
             "press": press(), "select": select()}
    for v in range(4):
        files[f"key{v + 1}"] = key(v)
    files["key"] = files["key1"]
    for v in range(3):
        files[f"pop{v + 1}"] = pop(v)
    files["pop"] = files["pop1"]
    for name, x in sorted(files.items()):
        write_wav(os.path.join(d, name + ".wav"), x, bits=24)
        print(f"  {name:8s} {len(x) / SR * 1000:6.0f} ms  peak {to_db(np.max(np.abs(x))):6.1f} dBFS  "
              f"dc {abs(x.mean()):.1e}")
    print(f"  wrote {len(files)} files to {d}")


if __name__ == "__main__":
    main()
