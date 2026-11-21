#!/usr/bin/env python3
"""Checks for the cut 4 soundtrack: length, peak, loudness (ffmpeg), grid onsets, swap ticks on the musical
steps, section levels (build momentary, chord on top), dropout, silence.

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


def momentary(x):
    """BS.1770 momentary loudness (400 ms, 100 ms hop): (end times, LUFS)."""
    from scipy import signal
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]
    y = signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=0), axis=0)
    p = (y ** 2).sum(axis=1)
    cs = np.concatenate([[0], np.cumsum(p)])
    W, H = int(0.4 * SR), int(0.1 * SR)
    idx = np.arange(0, len(p) - W, H)
    return (idx + W) / SR, -0.691 + 10 * np.log10((cs[idx + W] - cs[idx]) / W + 1e-12)


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
    pts = [("groove in", 2.4, None),     # full band: the opening pad masks 1-9 kHz, and narrow low bands pre-ring ("full groove", M.HOME, hf), ("lift", M.LIFT, hf), ("pull-back", M.PULL, hf),
           ("accent 1", M.ACCENTS[0], hf), ("accent 2", M.ACCENTS[1], hf), ("final chord", M.END, hf),
           ("logo tag", M.TAG, (1400, 9000))]
    pts += [(f"tile {i + 1}", t, (350, 6000)) for i, t in enumerate(M.TILES)]
    cue_at = []
    if name == "mix":
        try:
            with open(os.path.join(audio_dir(), "cues.json")) as f:
                cue_at = [float(c["at"]) for c in json.load(f)]
        except (OSError, ValueError):
            pass
    for label, t, band in pts:
        off, rise = onset(x, t, band)
        near = any(t - 0.3 <= c < t - 0.003 for c in cue_at)      # a tap or a whoosh just ahead of the beat
        flag = "OK" if abs(off) <= 5 else ("cue just before (music checked separately)" if near else "CHECK")
        ok &= abs(off) <= 5 or near
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
    # the swaps themselves against the musical steps (16ths / 16th triplets), and the picture's frame rounding
    gerr = [min(abs(a - round(a / M.S16) * M.S16), abs(a - round(a / (M.BEAT / 6)) * (M.BEAT / 6))) * 1000
            for a in M.SWAPS if M.BUILD0 - 0.02 <= a < M.STOP]
    ferr = [abs(a * 30 - round(a * 30)) / 30 * 1000 for a in M.TICKS]
    print(f"  swaps.json vs musical steps: max {max(gerr):.1f} ms, mean {np.mean(gerr):.1f} ms over {len(gerr)}; "
          f"picture frame rounding of the ticks: max {max(ferr):.1f} ms")
    ok &= max(gerr) <= 1.0

    print("  section RMS (dBFS) and loudness (LUFS: mean / max momentary, 400 ms):")
    L = M.LIFT
    secs = [("0-2.4 room", 0, 2.4), ("2.4-7.2 tiles", 2.4, 7.2), ("7.2-9.6 dive", 7.2, 9.6), ("9.6-14.4 home", 9.6, 14.4),
            ("14.4-lift thin", 14.4, L), ("lift-24 full", L, 24.0), ("24-31.2 saved", 24.0, 31.2), ("31.2-36 team", 31.2, 36.0),
            ("36-40.8 music", 36.0, 40.8), ("40.8-42.6 habits", 40.8, 42.6), ("42.6-43.2 dropout", 42.6, 43.2),
            ("43.2-48 pull-back", 43.2, 48.0), ("48-50.4 drop", 48.0, 50.4), ("50.4-54.4 build", 50.4, 54.4),
            ("54.4-56.4 build end", 54.4, 56.4), ("56.5-57.5 breath", 56.5, 57.5), ("57.6-59.4 chord", 57.6, 59.4),
            ("59.4-62.4 lockup", 59.4, 62.4), ("64.6-64.8 end", 64.6, 64.8)]
    tM, mom = momentary(x)
    lv, lm = {}, {}
    for label, a, b in secs:
        lv[label] = rms_db(x[int(a * SR):int(b * SR)])
        m = (tM > a + 0.4) & (tM <= b + 1e-9)
        lm[label] = (float(mom[m].mean()), float(mom[m].max())) if m.any() else (float("nan"), float("nan"))
        print(f"    {label:20s} {lv[label]:7.1f}   {lm[label][0]:6.1f} / {lm[label][1]:6.1f}")
    # loudness (not RMS) per second: the build is ridden to a gentle loudness ramp while its low end thins
    per = []
    for i in range(int(round(M.STOP - M.BUILD0))):
        m = (tM > M.BUILD0 + i + 0.4) & (tM <= M.BUILD0 + i + 1 + 1e-9)
        per.append(float(10 * np.log10(np.mean(10 ** (mom[m] / 10)))))
    rising = all(b > a - 0.6 for a, b in zip(per, per[1:])) and per[-1] > per[0] + 0.8 and per[0] >= -15.5
    print(f"  build loudness per second from {M.BUILD0} (LUFS): " + " ".join(f"{v:.1f}" for v in per) +
          f" -> {'rising, no hole' if rising else 'CHECK (want >= -15.5 at the start, rising)'}")
    bmax = lm["54.4-56.4 build end"][0]
    pb = lm["43.2-48 pull-back"][0]
    bend_ok = pb - 0.3 <= bmax <= lm["57.6-59.4 chord"][0] - 1.0
    print(f"  build end momentary mean {bmax:.1f} LUFS (r2: at or above the pull-back {pb:.1f}, 1 LU or more under the chord) "
          f"-> {'OK' if bend_ok else 'CHECK'}")
    top = max(lm[k][0] for k in lm if k != "57.6-59.4 chord" and k != "56.5-57.5 breath")
    print(f"  final chord {lm['57.6-59.4 chord'][0]:.1f} LUFS vs loudest other section {top:.1f} -> "
          f"{'the peak' if lm['57.6-59.4 chord'][0] > top + 1.0 else 'CHECK'}")
    drop_gap = lv["40.8-42.6 habits"] - lv["42.6-43.2 dropout"]
    print(f"  dropout is {drop_gap:.1f} dB under the habits bar")
    last = rms_db(x[int((M.STOP - 1) * SR):int(M.STOP * SR)])
    gap = last - lv["56.5-57.5 breath"]
    print(f"  breath is {gap:.1f} dB below the last second of the build ({last:.1f}) -> {'OK' if gap >= 25 else 'FAIL'}")
    ok &= rising and gap >= 25 and bend_ok and lm["57.6-59.4 chord"][0] > top + 1.0
    tail = np.max(np.abs(x[int(round(M.SILENT * SR)):]))
    print(f"  max |x| after {M.SILENT}s: {tail:.2e} -> {'OK (digital silence)' if tail == 0 else 'FAIL'}")
    ok &= tail == 0
    if name == "music":
        ok &= lv["9.6-14.4 home"] - 25 < lv["0-2.4 room"] < lv["9.6-14.4 home"] - 10   # the opening pad: there, but quiet
        ok &= lv["14.4-lift thin"] < lv["lift-24 full"] - 1.5
        ok &= lv["48-50.4 drop"] < lv["43.2-48 pull-back"] - 2.5
        ok &= drop_gap > 3
    for label, t in (("cut", M.STOP), ("end", M.SILENT)):
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
