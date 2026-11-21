#!/usr/bin/env python3
"""Athena cut 6 final mix: music + interface sounds placed from a cue file.

Run: python3 mix.py   ->  $FILM/audio/mix.wav (exactly 86.400 s, -15 LUFS, true peak under -1.5 dBTP,
digital silence from 86.2 s)

Cue file $FILM/audio/cues.json: [{"sfx": "key", "at": 22.20, "gain": -6}, ...]
  at    seconds from the start of the film (the sound's onset)
  gain  dB relative to the sfx file (optional, default 0)
  over  instead of a fixed gain: dB over the music under it in 2-8 kHz, measured here (audiolib.cue_gain)
  sfx   file name in $FILM/audio/sfx without .wav. "key" and "pop" rotate through their variants
        (key1..key4, pop1..pop3); name a variant explicitly (e.g. "pop2") to pin it.
If cues.json is missing, cues.py's sheet is written first.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audiolib import SR, audio_dir, db, to_db, read_wav, write_wav, master, lufs, cue_gain

DUR = 86.4
SILENT = 86.2
N = int(round(DUR * SR))
ROTATE = {"key": 4, "pop": 3}
TARGET_LUFS, TP_LIMIT = -15.0, -1.6     # cut 6: a tad softer (cut 5: -14 / -1.1); ffmpeg reads ~0.1 dB over our meter
MUSIC_TRIM_DB = -3.0     # the music bed under the effects before the bus is re-mastered (review: sound #1)


def default_cues():
    """The cue sheet cues.py would write now (manifest and motion peaks if present, else the plan's times)."""
    import cues
    return cues.build_cues(verbose=False)


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
    bed = bus.copy()

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
        seg = x[:n] * db(cue_gain(c, x, bed[i:i + len(x)]))
        if n < len(x):                                   # ran off the end of the film: fade, do not chop
            r = min(n, int(0.01 * SR))
            seg = seg.copy()
            seg[-r:] *= np.linspace(1, 0, r)[:, None]
        bus[i:i + n] += seg
        placed += 1
    if skipped:
        print("  WARNING skipped cues (unknown sfx or outside the film):", ", ".join(sorted(set(skipped))))

    print(f"  {placed} cues placed over music at {music_lufs:.2f} LUFS")
    y = master(bus, target_lufs=TARGET_LUFS, tp_limit_db=TP_LIMIT)
    gr = __import__("audiolib").LAST_GR
    with open(os.path.join(d, "mix-limiter.json"), "w") as f:
        json.dump({"max_gr": round(-to_db(gr.min()), 2), "limited_pct": round(100 * float(np.mean(gr < 0.999)), 2)}, f)
    z = int(round(SILENT * SR))
    if np.any(np.abs(bus[z:]) > 1e-9):
        print("  WARNING sound after the silence point: faded")
        r = int(0.02 * SR)
        y[z - r:z] *= np.linspace(1, 0, r)[:, None]
    y[z:] = 0.0
    assert y.shape == (N, 2)
    out = os.path.join(d, "mix.wav")
    write_wav(out, y, bits=24)
    print(f"  wrote {out}  ({N} samples, {N / SR:.3f}s)")


if __name__ == "__main__":
    main()
