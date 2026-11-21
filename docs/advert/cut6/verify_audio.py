#!/usr/bin/env python3
"""Checks for the cut 6 soundtrack (86.4 s, -15 LUFS, true peak under -1.5 dBTP, light limiting): length, peak, loudness (ffmpeg), grid onsets, swap ticks on the musical
steps, section levels (build momentary, chord on top, the "reached" bar second), dropout, silence; for the mix,
every named cue against its picture event, where it really sounds (matched filter) and how far it stands over
the music in 2-8 kHz.

Run: python3 verify_audio.py [music|mix]      (default: both)
"""
import json
import os
import re
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audiolib import SR, audio_dir, to_db, read_wav, rms_db, g_lp, g_hp, fft_filter, band_db, cue_gain
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


NAMED = ("chip", "send", "drop", "land", "set", "penny", "stepdown", "reached", "hello", "face1", "face2", "face3", "cut_accent",
         "tick", "whoosh", "whoosh_big", "select", "pop", "pop2", "flowstep1", "flowstep2", "flowstep3", "flowstep4", "toggle")
TARGET_LUFS, TP_MIX = -15.0, -1.5
EVENT_OF = {  # cue -> (film-events key, cue time relative to the event) for the cut 5 beats
    "set": ("track.targetSet", 0.0), "penny": ("work.working", 0.0), "stepdown": ("work.stepDown", -0.6),
    "reached": ("work.reached", 0.3), "hello": ("hire.hello", 0.0), "chip": ("home.lateChip", 0.0),
    "toggle": ("flows.on", 0.0), "pop2": ("flows.suggest", 0.0)}


def check_cues(x):
    """Each named cue: is cues.json what cues.py would write now; where the sound really is in the mix (matched
    filter against its own file, ms from the cue time); its level over the music bed in 2-8 kHz; its offset
    from the picture event in film-events.json (when that exists)."""
    import cues as C
    from audiolib import film_dir, db
    d = audio_dir()
    try:
        with open(os.path.join(d, "cues.json")) as f:
            sheet = json.load(f)
    except (OSError, ValueError):
        print("  cues.json missing")
        return False
    now = C.build_cues(verbose=False)
    key_ = lambda c: (c["sfx"], c["at"], c.get("gain", 0), c.get("over", -99))
    fresh = sorted(map(key_, sheet)) == sorted(map(key_, now))
    print(f"  cues.json: {len(sheet)} cues, {'matches' if fresh else 'DIFFERS from'} what cues.py writes now"
          f"{'' if fresh else ' (re-run cues.py and mix.py)'}")
    fev, _ = C.film_events(film_dir())
    fpress = sorted(v / 1000.0 for k, v in fev.items() if k.startswith("press.") and isinstance(v, (int, float)))
    music = read_wav(os.path.join(d, "music.wav")) * 10 ** (-3.0 / 20)
    mono = x.mean(axis=1)
    ok = fresh
    print("  named cues: at (s), found in the mix (ms from the cue), 2-8 kHz over the music (dB), vs picture event (ms)")
    worst_keys = 0.0
    for c in sorted(sheet, key=lambda c: c["at"]):
        nm = c["sfx"]
        if nm not in NAMED and not nm.startswith(("key", "press")):
            continue
        fn = nm if os.path.exists(os.path.join(d, "sfx", nm + ".wav")) else nm + "1"
        tpl = read_wav(os.path.join(d, "sfx", fn + ".wav"))
        i = int(round(c["at"] * SR))
        n = min(len(tpl), int((0.6 if nm == 'stepdown' else 0.25) * SR), len(x) - i)
        over = band_db(tpl[:n] * db(cue_gain(c, tpl, music[i:i + len(tpl)]))) - band_db(music[i:i + n])
        if nm.startswith(("key", "press")):
            if nm == "press" and fpress:
                worst_keys = max(worst_keys, min(abs(c["at"] + 0.02 - t) for t in fpress) * 1000)
            continue
        m = tpl[: int(0.04 * SR)].mean(axis=1)              # the attack: a ringing bar's later periods match anywhere
        a = max(i - int(0.03 * SR), 0)
        seg = mono[a:a + len(m) + int(0.06 * SR)]
        cc = np.correlate(seg, m, "valid")
        e = np.sqrt(np.convolve(seg ** 2, np.ones(len(m)), "valid") * np.sum(m ** 2)) + 1e-12
        lag = int(np.argmax(cc / e))
        off = (a + lag - i) / SR * 1000
        strength = float(cc[lag] / e[lag])
        evs = ""
        if nm in EVENT_OF and isinstance(fev.get(EVENT_OF[nm][0]), (int, float)):
            key, rel = EVENT_OF[nm]
            dv = (c["at"] - rel - fev[key] / 1000.0) * 1000
            evs = f"  {key} {dv:+.0f} ms"
            if abs(dv) > 60 and nm not in ("reached", "hello", "chip"):
                ok = False
                evs += " CHECK"
        flag = "" if strength < 0.3 or abs(off) <= 5 else " CHECK"   # a weak match is masking, not a slip
        print(f"    {nm:11s} {c['at']:7.3f}  {off:+5.1f} ms (match {strength:.2f})  {over:+5.1f} dB{evs}{flag}")
        if nm in ("set", "penny", "stepdown", "reached", "hello") and over < 0.0:
            print(f"      CHECK {nm} is under the music in 2-8 kHz")
            ok = False
    if fpress:
        print(f"  taps: {len(fpress)} presses in film-events.json; worst tap is {worst_keys:.0f} ms from its press")
        ok &= worst_keys <= 20
    return ok


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
                        "loudnorm=I=-15:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True)
    j = json.loads(re.search(r"\{[^{}]*\}", r.stderr[r.stderr.rfind("[Parsed_loudnorm"):], re.S).group(0))
    print(f"  ffmpeg loudnorm: I {j['input_i']} LUFS, TP {j['input_tp']} dBTP, LRA {j['input_lra']}")
    ok &= abs(float(j["input_i"]) - TARGET_LUFS) < 0.5 and float(j["input_tp"]) <= (TP_MIX if name == "mix" else -0.1)   # music.wav is an intermediate

    print("  onsets (offset from the grid in ms, dB above the preceding 30 ms):")
    hf = (1000, 9000)     # transients only: a bass note sounding just before a downbeat must not hide it
    pts = [("groove in", 2.4, None),     # full band: the opening pad masks 1-9 kHz, and narrow low bands pre-ring
           ("full groove", M.HOME, hf), ("lift", M.LIFT, hf), ("pull-back", M.PULL, hf), ("flow's steps", M.FLOWSTEP, hf),
           ("step down", M.STEP, hf), ("arrival", M.ARRIVE, (300, 9000)), ("accent 1", M.ACCENTS[0], hf), ("accent 2", M.ACCENTS[1], hf), ("final chord", M.END, hf),
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
            ("14.4-lift thin", 14.4, L), ("lift-24 full", L, 24.0), ("24-31.2 saved", 24.0, 31.2), ("31.2-36 team1", 31.2, 36.0),
            ("36-40.8 music", 36.0, 40.8), ("40.8-43.2 habits", 40.8, 43.2),
            ("team2 search", M.TEAM2, M.STEP), ("team2 reached", M.STEP, M.HIRE),
            ("50.4-arrive hire", M.HIRE, M.ARRIVE), ("arrival", M.ARRIVE, M.TEAMPAGE), ("team page", M.TEAMPAGE, M.FLOWS),
            ("flows card", M.FLOWS, M.FLOWSTEP), ("flows steps", M.FLOWSTEP, M.DROPOUT[0]),
            ("dropout", M.DROPOUT[0], M.DROPOUT[1]), ("pull-back", M.PULL, M.ROT), ("drop", M.ROT, M.BUILD0),
            ("build", M.BUILD0, M.BUILD0 + 4.0), ("build end", M.STOP - 2.0, M.STOP),
            ("breath", M.STOP + 0.1, M.END - 0.1), ("chord", M.END, M.TAG), ("lockup", M.TAG, M.TAG + 3.0),
            ("end", M.SILENT, M.DUR)]
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
    rising = all(b > a - 0.6 for a, b in zip(per, per[1:])) and per[-1] > per[0] + 0.8 and per[0] >= TARGET_LUFS - 1.5
    print(f"  build loudness per second from {M.BUILD0} (LUFS): " + " ".join(f"{v:.1f}" for v in per) +
          f" -> {'rising, no hole' if rising else 'CHECK (want >= -16.5 at the start, rising)'}")
    bmax = lm["build end"][0]
    pb = lm["pull-back"][0]
    bend_ok = pb - 0.3 <= bmax <= lm["chord"][0] - 1.0
    print(f"  build end momentary mean {bmax:.1f} LUFS (r2: at or above the pull-back {pb:.1f}, 1 LU or more under the chord) "
          f"-> {'OK' if bend_ok else 'CHECK'}")
    top = max(lm[k][0] for k in lm if k != "chord" and k != "breath")
    print(f"  final chord {lm['chord'][0]:.1f} LUFS vs loudest other section {top:.1f} -> "
          f"{'the peak' if lm['chord'][0] > top + 1.0 else 'CHECK'}")
    cmax = float(mom[(tM > M.END) & (tM <= M.END + 1.0)].max())
    omax = float(mom[tM <= M.STOP].max())
    t_omax = float(tM[tM <= M.STOP][np.argmax(mom[tM <= M.STOP])])
    loudest = cmax >= omax + 0.5
    print(f"  loudest 400 ms: chord {cmax:.1f} LUFS, anywhere before it {omax:.1f} (at {t_omax:.1f}s) -> "
          f"{'the chord is the loudest moment' if loudest else 'CHECK'}")
    ok &= loudest
    # r1 sound: the logo tag under the chord; the arrival the third-biggest moment before the pull-back
    def mx(t0, t1):
        m_ = (tM > t0) & (tM <= t1)
        return float(mom[m_].max())
    tag = mx(M.TAG + 0.4, M.TAG + 2.0)
    arr, stp = mx(M.ARRIVE, M.ARRIVE + 1.0), mx(M.STEP, M.STEP + 1.2)
    others = {nm_: mx(a_, b_) for nm_, a_, b_ in (("home", 9.6, 14.4), ("ask", 14.4, 24.0), ("saved", 24.0, 31.2),
              ("team 1", 31.2, 36.0), ("music", 36.0, 40.8), ("habits", 40.8, 43.4), ("search", 43.6, M.STEP),
              ("hire", M.HIRE + 0.4, M.ARRIVE), ("team page", M.ARRIVE + 1.4, M.FLOWS),
              ("flows", M.FLOWS, M.DROPOUT[0]))}
    third = max(others.values())
    t_ok = tag <= cmax - 1.0
    hit, wall = mx(M.PULL, M.PULL + 1.2), mx(M.PULL + 1.2, M.ROT + 0.4)
    others.update({"pull-back hit": hit, "wall": wall, "drop": mx(M.ROT + 0.4, M.BUILD0), "build": mx(M.BUILD0, M.STOP)})
    third = max(others.values())
    # r2: with its voice (so judged in the mix), the arrival is a clear third: 0.7 LU over everything but the
    # step down and the chord, and not over the step down
    a_ok = name != 'mix' or (arr >= third + 0.7 and arr <= stp)
    h_ok = hit >= wall - 0.2
    print(f"  pull-back hit {hit:.1f} LUFS, the wall after it {wall:.1f} -> {'OK' if h_ok else 'CHECK (the hit should be at least as loud)'}")
    ok &= h_ok
    print(f"  big moments (max momentary LUFS): chord {cmax:.1f}, tag {tag:.1f} -> {'tag under the chord' if t_ok else 'CHECK tag'}; "
          f"step down {stp:.1f}, arrival {arr:.1f}, pull-back {mx(M.PULL, M.PULL + 1.2):.1f}, build end {mx(M.STOP - 1.0, M.STOP):.1f}; "
          f"next biggest: {max(others, key=others.get)} {third:.1f} -> {'arrival is a clear third' if a_ok else 'CHECK arrival (want >= 0.7 over it, under the step down)'}")
    ok &= t_ok and a_ok
    try:
        with open(os.path.join(audio_dir(), "music-limiter.json")) as f:
            lim = json.load(f)
        l_ok = lim["step"] <= 3.0 and lim["pull"] <= 3.0 and lim["chord"] <= 3.0 and lim["limited_pct"] <= 3.0
        print(f"  music master limiter (dB) at the hits: " + ", ".join(f"{k_} {v_}" for k_, v_ in lim.items()) +
              f" -> {'OK' if l_ok else 'CHECK (cut 6 wants <= 3 dB at step / pull / chord, <= 3% of samples limited)'}")
        if name == "mix":
            with open(os.path.join(audio_dir(), "mix-limiter.json")) as f:
                ml = json.load(f)
            m_ok = ml["max_gr"] <= 4.0 and ml["limited_pct"] <= 3.0
            print(f"  mix master limiter: max {ml['max_gr']} dB, {ml['limited_pct']}% of samples -> "
                  f"{'OK' if m_ok else 'CHECK (want <= 4 dB, <= 3%)'}")
            l_ok &= m_ok
        ok &= l_ok
    except (OSError, ValueError, KeyError):
        print("  music-limiter.json missing (re-run music.py)")
    pre = rms_db(x[int((M.DROPOUT[0] - M.BEAT) * SR):int(M.DROPOUT[0] * SR)])
    drop_gap = pre - lv["dropout"]
    print(f"  dropout is {drop_gap:.1f} dB under the beat before it")
    # cut 5: the "reached" bar is the second-biggest moment: over everything before the pull-back, under the chord
    rb = (tM > M.STEP + 0.4) & (tM <= M.STEP + M.BAR + 1e-9)
    reached = float(mom[rb].mean())
    before = max(lm[k][0] for k in lm if k.split(" ")[-1] in ("home", "thin", "full", "saved", "team1", "music", "habits", "search", "hire", "arrival", "page", "card", "steps"))
    r_ok = reached >= before + (0.3 if name == 'mix' else -0.5) and reached <= lm["chord"][0] - 1.0
    print(f"  reached bar {reached:.1f} LUFS: loudest section before the pull-back otherwise {before:.1f}, chord "
          f"{lm['chord'][0]:.1f} -> {'OK' if r_ok else 'CHECK'}")
    s_ok = lm["team2 search"][0] <= lm["40.8-43.2 habits"][0] - 2.0 and lm["31.2-36 team1"][0] <= lm["36-40.8 music"][0] - 1.0
    print(f"  search bed {lm['team2 search'][0]:.1f} (habits {lm['40.8-43.2 habits'][0]:.1f}), Team 1 {lm['31.2-36 team1'][0]:.1f} "
          f"(music {lm['36-40.8 music'][0]:.1f}) -> {'light enough' if s_ok else 'CHECK'}")
    ok &= r_ok and s_ok
    last = rms_db(x[int((M.STOP - 1) * SR):int(M.STOP * SR)])
    gap = last - lv["breath"]
    print(f"  breath is {gap:.1f} dB below the last second of the build ({last:.1f}) -> {'OK' if gap >= 25 else 'FAIL'}")
    ok &= rising and gap >= 25 and bend_ok and lm["chord"][0] > top + 1.0
    tail = np.max(np.abs(x[int(round(M.SILENT * SR)):]))
    print(f"  max |x| after {M.SILENT}s: {tail:.2e} -> {'OK (digital silence)' if tail == 0 else 'FAIL'}")
    ok &= tail == 0
    if name == "music":
        ok &= lv["9.6-14.4 home"] - 25 < lv["0-2.4 room"] < lv["9.6-14.4 home"] - 10   # the opening pad: there, but quiet
        ok &= lv["14.4-lift thin"] < lv["lift-24 full"] - 1.5
        ok &= lv["drop"] < lv["pull-back"] - 2.5
        ok &= drop_gap > 3
    else:
        ok &= check_cues(x)
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
