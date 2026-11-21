#!/usr/bin/env python3
"""Checks for the cut 3 soundtrack: length, peak, loudness (ffmpeg), grid onsets, section levels, silence.

Run: python3 verify_audio.py [music|mix]      (default: both)
"""
import json
import os
import re
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audiolib import SR, audio_dir, to_db, read_wav, rms_db, g_lp, g_hp, fft_filter
import music as M


def onset(x, t0, band=None, win=0.04, thresh=6.0):
    """Offset (ms) from t0 of the first moment the 2 ms energy envelope jumps `thresh` dB above the
    level of the 30 ms before the search window; falls back to the steepest 2 ms rise."""
    a, b = max(int((t0 - win - 0.08) * SR), 0), int((t0 + win + 0.05) * SR)
    seg = x[a:b].mean(axis=1)
    if band:
        seg = fft_filter(seg, lambda f: g_hp(f, band[0], 3) * g_lp(f, band[1], 3))
    w = 96
    cs = np.concatenate([[0.0], np.cumsum(seg ** 2)])
    L = 10 * np.log10((cs[w:] - cs[:-w]) / w + 1e-12)       # L[i] = level of samples i..i+w
    lo, hi = int((t0 - win) * SR) - a, int((t0 + win) * SR) - a
    base = np.percentile(L[max(lo - int(0.03 * SR), 0):lo], 90)
    over = np.nonzero(L[lo:hi] > base + thresh)[0]
    if len(over):
        i = lo + int(over[0]) + w                           # window end = the sample that tipped it
        rise = float(L[lo:hi].max() - base)
    else:
        d = L[w:] - L[:-w]
        i = lo + int(np.argmax(d[lo:hi])) + w
        rise = float(d[i - w])
    return (a + i) / SR * 1000 - t0 * 1000, rise


def check(name):
    path = os.path.join(audio_dir(), name + ".wav")
    x = read_wav(path)
    ok = True
    want = M.N
    print(f"== {name}.wav")
    print(f"  samples {len(x)} (want {want} = {want / SR:.3f}s) -> {'OK' if len(x) == want else 'FAIL'}")
    ok &= len(x) == want
    pk = np.max(np.abs(x))
    clipped = int(np.sum(np.abs(x) >= 0.999))
    print(f"  sample peak {to_db(pk):.2f} dBFS, clipped samples {clipped}, DC L/R {x[:, 0].mean():+.1e} {x[:, 1].mean():+.1e}")
    ok &= clipped == 0
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af",
                        "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True)
    j = json.loads(re.search(r"\{[^{}]*\}", r.stderr[r.stderr.rfind("[Parsed_loudnorm"):], re.S).group(0))
    print(f"  ffmpeg loudnorm: I {j['input_i']} LUFS, TP {j['input_tp']} dBTP, LRA {j['input_lra']}")
    ok &= abs(float(j["input_i"]) + 14) < 0.7 and float(j["input_tp"]) < -1.0

    print("  onsets (offset from the grid in ms, dB above the preceding 30 ms):")
    hf = (1000, 9000)     # transients only: a bass note sounding just before a downbeat must not hide it
    pts = [("groove in", 2.4, hf), ("full groove", 12.0, hf), ("lift", M.LIFT, hf), ("pull-back", 48.0, hf),
           ("accent 1", M.ACCENTS[0], hf), ("accent 2", M.ACCENTS[1], hf), ("final chord", M.END, hf),
           ("logo tag", M.TAG, (1400, 9000))]
    pts += [(f"tile {i + 1}", t, (350, 6000)) for i, t in enumerate(M.TILES)]
    for label, t, band in pts:
        off, rise = onset(x, t, band)
        flag = "OK" if abs(off) <= 5 else "CHECK"
        ok &= abs(off) <= 5
        print(f"    {label:12s} {t:6.2f}s  {off:+6.2f} ms  rise {rise:5.1f} dB  {flag}")

    # swap ticks: matched filter against each tick's own waveform (grid percussion sits close by, so a
    # plain energy onset is ambiguous); offset = lag of the correlation peak, strength = normalised peak
    offs = []
    mono = x.mean(axis=1)
    for jn, t in enumerate(M.TICKS):
        tpl = M.tick_note(M.PENT[min(len(M.PENT) - 1, jn * len(M.PENT) // len(M.TICKS))])[: int(0.04 * SR)]
        i0 = int(round((t - 0.03) * SR))
        seg = mono[i0:i0 + len(tpl) + int(0.06 * SR)]
        c = np.correlate(seg, tpl, "valid")
        e = np.sqrt(np.convolve(seg ** 2, np.ones(len(tpl)), "valid") * np.sum(tpl ** 2)) + 1e-12
        lag = int(np.argmax(c))
        offs.append(((i0 + lag) / SR * 1000 - t * 1000, float(c[lag] / e[lag]), t))
    worst = max(offs, key=lambda o: abs(o[0]))
    weak = min(offs, key=lambda o: o[1])
    nbad = sum(abs(o[0]) > 5 for o in offs)
    print(f"  swap ticks: {len(offs)} from {M.TICKS[0]:.3f}s to {M.TICKS[-1]:.3f}s; mean offset {np.mean([o[0] for o in offs]):+.2f} ms, "
          f"worst {worst[0]:+.2f} ms at {worst[2]:.3f}s; weakest match {weak[1]:.2f} at {weak[2]:.3f}s; outside 5 ms: {nbad}")
    ok &= nbad == 0

    print("  section RMS (dBFS):")
    L = M.LIFT
    secs = [("0-2.4 room", 0, 2.4), ("2.4-9.6 light", 2.4, 9.6), ("9.6-12 fill", 9.6, 12), ("12-18 groove A", 12, 18),
            ("18-lift thin", 18, L), ("lift-28.8 full", L, 28.8), ("28.8-33.6", 28.8, 33.6), ("33.6-38.4", 33.6, 38.4),
            ("38.4-43.2", 38.4, 43.2), ("43.2-48", 43.2, 48), ("48-52.8 biggest", 48, 52.8), ("52.8-55.2 drop", 52.8, 55.2),
            ("55.2-61.2 build", 55.2, 61.2), ("61.3-62.3 breath", 61.3, 62.3), ("62.4-64.8 chord", 62.4, 64.8),
            ("64.8-66.9 tag", 64.8, 66.9), ("67.0-67.2 end", 67.0, 67.2)]
    lv = {}
    for label, a, b in secs:
        lv[label] = rms_db(x[int(a * SR):int(b * SR)])
        print(f"    {label:18s} {lv[label]:7.1f}")
    per = [rms_db(x[int((55.2 + i) * SR):int((56.2 + i) * SR)]) for i in range(6)]
    rising = all(b > a for a, b in zip(per, per[1:]))
    print("  build RMS per second from 55.2: " + " ".join(f"{v:.1f}" for v in per) + f" -> {'rising' if rising else 'NOT monotonic'}")
    last = rms_db(x[int(60.2 * SR):int(61.2 * SR)])
    gap = last - lv["61.3-62.3 breath"]
    print(f"  breath 61.3-62.3 is {gap:.1f} dB below the last second of the build ({last:.1f}) -> {'OK' if gap >= 25 else 'FAIL'}")
    ok &= rising and gap >= 25
    tail = np.max(np.abs(x[int(67.0 * SR):]))
    print(f"  max |x| after 67.0s: {tail:.2e} -> {'OK (digital silence)' if tail == 0 else 'FAIL'}")
    ok &= tail == 0
    if name == "music":
        ok &= lv["0-2.4 room"] < lv["12-18 groove A"] - 25
        ok &= lv["18-lift thin"] < lv["lift-28.8 full"] - 1.5
        ok &= lv["52.8-55.2 drop"] < lv["48-52.8 biggest"] - 2.5
    for label, t in (("cut 61.2", 61.2), ("end", M.SILENT)):
        sg = x[int((t - 0.02) * SR):int((t + 0.002) * SR)]
        print(f"  largest sample-to-sample jump just before {label}: {np.max(np.abs(np.diff(sg, axis=0))):.4f}")
    side = (x[:, 0] - x[:, 1]) / 2
    mid = (x[:, 0] + x[:, 1]) / 2
    print(f"  stereo: side/mid {rms_db(side) - rms_db(mid):.1f} dB, L/R correlation {np.corrcoef(x[:, 0], x[:, 1])[0, 1]:.2f}")
    print(f"  RESULT {'PASS' if ok else 'CHECK'}")
    return ok


if __name__ == "__main__":
    names = sys.argv[1:] or ["music", "mix"]
    res = [check(n) for n in names if os.path.exists(os.path.join(audio_dir(), n + ".wav"))]
    sys.exit(0 if all(res) else 1)
