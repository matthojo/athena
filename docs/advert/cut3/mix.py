#!/usr/bin/env python3
"""Athena cut 3 final mix: music + interface sounds placed from a cue file.

Run: python3 mix.py   ->  $FILM/audio/mix.wav (exactly 67.200 s, about -14 LUFS, true peak under -1 dBFS)

Cue file $FILM/audio/cues.json: [{"sfx": "key", "at": 22.20, "gain": -6}, ...]
  at    seconds from the start of the film (the sound's onset)
  gain  dB relative to the sfx file (optional, default 0)
  sfx   file name in $FILM/audio/sfx without .wav. "key" and "pop" rotate through their variants
        (key1..key4, pop1..pop3); name a variant explicitly (e.g. "pop2") to pin it.
If cues.json is missing a default one is written from the brief's timeline.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audiolib import SR, audio_dir, db, to_db, read_wav, write_wav, master, lufs

DUR = 67.2
N = int(round(DUR * SR))
ROTATE = {"key": 4, "pop": 3}
MUSIC_TRIM_DB = 0.0      # level of the music bed under the effects before the bus is re-mastered


def default_cues():
    cues = []

    def keys(t0, t1, gain=-6.0):
        t, i = t0, 0
        while t < t1 - 1e-6:
            jitter = ((i * 37) % 11 - 5) * 0.004         # human, but repeatable
            cues.append({"sfx": "key", "at": round(t + (jitter if i else 0.0), 3), "gain": gain + ((i * 7) % 3 - 1)})
            t += 0.08
            i += 1

    cues.append({"sfx": "pop", "at": 1.2, "gain": -2})
    for i in range(8):
        cues.append({"sfx": "pop", "at": round(3.0 + 0.6 * i, 3), "gain": -5})
    for t in (2.4, 9.6, 18.6):
        cues.append({"sfx": "press", "at": t, "gain": 0})
    for t in (9.6, 21.6, 33.6, 40.8, 44.4, 48.0, 52.8):
        cues.append({"sfx": "whoosh", "at": t, "gain": -4})
    keys(22.2, 24.6)
    cues.append({"sfx": "send", "at": 24.6, "gain": -3})
    cues.append({"sfx": "answer", "at": 27.0, "gain": -4})
    keys(34.0, 36.4)
    cues.append({"sfx": "drop", "at": 36.4, "gain": -3})
    cues.append({"sfx": "tick", "at": 42.0, "gain": -2})
    cues.append({"sfx": "select", "at": 54.0, "gain": -2})
    keys(54.3, 54.3 + 0.08 * 9)
    cues.append({"sfx": "select", "at": 55.2, "gain": -2})
    keys(55.5, 55.5 + 0.08 * 6)
    return sorted(cues, key=lambda c: c["at"])


def main():
    d = audio_dir()
    here = os.path.dirname(os.path.abspath(__file__))
    music_path = os.path.join(d, "music.wav")
    sfx_dir = os.path.join(d, "sfx")
    if not os.path.exists(music_path):
        print("  music.wav missing: rendering it")
        import music
        music.main()
    if not os.path.exists(os.path.join(sfx_dir, "key1.wav")):
        print("  sfx missing: rendering them")
        import sfx
        sfx.main()
    cue_path = os.path.join(d, "cues.json")
    if not os.path.exists(cue_path):
        with open(cue_path, "w") as f:
            json.dump(default_cues(), f, indent=1)
        print(f"  wrote default {cue_path}")
    with open(cue_path) as f:
        cues = json.load(f)

    bus = read_wav(music_path)
    if len(bus) != N:
        sys.exit(f"music.wav is {len(bus)} samples, expected {N}")
    bus = bus * db(MUSIC_TRIM_DB)
    music_lufs = lufs(bus)

    cache, counters, placed, skipped = {}, {}, 0, []
    for c in sorted(cues, key=lambda c: float(c["at"])):
        name = str(c["sfx"])
        if name in ROTATE:
            k = counters.get(name, 0)
            counters[name] = k + 1
            name = f"{name}{k % ROTATE[name] + 1}"
        if name not in cache:
            p = os.path.join(sfx_dir, name + ".wav")
            if not os.path.exists(p):
                skipped.append(name)
                continue
            cache[name] = read_wav(p)
        x = cache[name]
        i = int(round(float(c["at"]) * SR))
        if i < 0 or i >= N:
            skipped.append(f"{name}@{c['at']}")
            continue
        n = min(len(x), N - i)
        seg = x[:n] * db(float(c.get("gain", 0.0)))
        if n < len(x):                                   # ran off the end of the film: fade, do not chop
            r = min(n, int(0.01 * SR))
            seg = seg.copy()
            seg[-r:] *= np.linspace(1, 0, r)[:, None]
        bus[i:i + n] += seg
        placed += 1
    if skipped:
        print("  WARNING skipped cues (unknown sfx or outside the film):", ", ".join(sorted(set(skipped))))

    print(f"  {placed} cues placed over music at {music_lufs:.2f} LUFS")
    y = master(bus, target_lufs=-14.0)
    z = int(67.0 * SR)
    y[z:] = 0.0 if not np.any(np.abs(bus[z:]) > 0) else y[z:]
    assert y.shape == (N, 2)
    out = os.path.join(d, "mix.wav")
    write_wav(out, y, bits=24)
    print(f"  wrote {out}  ({N} samples, {N / SR:.3f}s)")


if __name__ == "__main__":
    main()
