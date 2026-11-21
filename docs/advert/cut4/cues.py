#!/usr/bin/env python3
"""Writes $FILM/audio/cues.json: every interface sound, placed against the picture (cut 4, 64.8 s).

Sources, best first:
  $FILM/motion-peaks.json   the camera's fastest frame for each move (motion agent). Each whoosh starts
                            0.17 s before that frame, so its peak lands on it. Missing: placeholders at
                            each section boundary + 0.4 s.
  $FILM/film-events.json    film times (ms) of the events film.js uses, {"saved.paste": 25200, ...} (motion
                            agent). Wins over everything below.
  anchor= in build_cues      the motion agent's event times, used until film-events.json exists.
  $FILM/cap/manifest.json   measured capture events, film time = shot start + event ms (Ask is re-timed so
                            the answer lands at 19.2 s), or relative to an anchored event in a re-timed shot.
  swaps.json                the closing line (typed, two retypes; the swap ticks are in the music).
Run this, then mix.py. Re-run both whenever motion-peaks.json or the manifest changes.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from audiolib import film_dir

BEAT, S16 = 0.6, 0.15
WHOOSH_LEAD = 0.17          # sfx.whoosh / whoosh_big peak this far in
SHOT_START = {"home": 9.6, "ask": 14.4, "saved": 24.0, "team": 31.2, "music": 36.0, "habits": 40.8}
STOP, GREAT, DROPOUT = 56.4, 57.6, (42.6, 43.2)

# camera moves: label -> (placeholder fastest point, sfx, gain dB). Review sound #1 asked +1; measured against the
# brighter cut 4 music, +4 puts a move's whoosh at or above the music in 2-8 kHz.
MOVES = {
    "dive": (7.2 + 0.4, "whoosh_big", 4),
    "home-ask": (14.4 + 0.4, "whoosh", 4),
    "ask-saved": (24.0 + 0.4, "whoosh", 4),
    "saved-team": (31.2 + 0.4, "whoosh", 4),
    "team-music": (36.0 + 0.4, "whoosh", 4),
    "music-habits": (40.8 + 0.4, "whoosh", 4),
    "pullback": (43.2 + 0.4, "whoosh_big", 4),
    "wall-exit": (48.0 + 0.4, "whoosh", 2),
}
FINALE_LABELS = ("checkin", "finale", "card", "lift", "good-days")   # the card rising after the dead cut
IN_SHOT_GAIN = -2           # in-shot reframes (saved-open, team-open, ...): a lighter touch
LABEL_GAIN = {"saved-watch": 2}   # in-shot moves that carry a story beat (the poster flying into Watch & read)
SKIP_LABELS = ("orb",)      # the Great -> orb morph: the logo tag carries it; a whoosh there measured inaudible
CUT_NEAR = 0.35             # a camera peak this close to a hard cut is the move the cut replaced: no whoosh
FLIGHT_GAIN = -4            # the poster's flight into Watch & read, when the camera itself barely moves
MIN_PX_PER_FRAME = 9        # slower than this is a drift, not a move: no whoosh (the poster's fly is 9.5)
MIN_GAP = 0.8               # one whoosh per move: a peak within 0.8 s of the last one kept is the same move
CAM_MIN_PX, CAM_PROM = 20.0, 8.0   # camspeed.json maxima the peaks file doesn't list (e.g. an in-shot open)


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def cam_peaks(film, labelled):
    """Local maxima of camspeed.json (px/frame for every 30 fps frame) that motion-peaks.json doesn't list."""
    c = load(os.path.join(film, "camspeed.json"))
    if not isinstance(c, list) or len(c) < 3:
        return []
    out = []
    for i in range(1, len(c) - 1):
        v = c[i]
        if not isinstance(v, (int, float)) or v < CAM_MIN_PX or not (v > c[i - 1] and v >= c[i + 1]):
            continue
        lo = min(c[max(0, i - 15):i + 16])
        t = i / 30.0
        if v - lo >= CAM_PROM and all(abs(t - lt) > 0.3 for lt in labelled):
            out.append(("cam", t, float(v)))
    return out


def motion_peaks(film):
    """[(label, seconds, pxPerFrame or None)] from motion-peaks.json (list of dicts or a label->ms map)."""
    raw = load(os.path.join(film, "motion-peaks.json"))
    out = []
    if isinstance(raw, dict):
        raw = raw.get("peaks", raw)
    if isinstance(raw, dict):
        for k, v in raw.items():
            ms = v.get("ms", v.get("at")) if isinstance(v, dict) else v
            px = v.get("pxPerFrame") if isinstance(v, dict) else None
            if isinstance(ms, (int, float)):
                out.append((str(k), ms / 1000.0, px))
    elif isinstance(raw, list):
        for v in raw:
            if not isinstance(v, dict):
                continue
            ms = v.get("ms", v.get("at"))
            if isinstance(ms, (int, float)):
                lbl = str(v.get("label", v.get("name", "move")))
                if v.get("cut") is True or str(v.get("kind", v.get("type", ""))).lower() == "cut" or lbl.endswith("-cut"):
                    lbl = "cut:" + lbl                      # a hard cut, not a move
                out.append((lbl, ms / 1000.0, v.get("pxPerFrame")))
    return out


def build_cues(film=None, verbose=True):
    film = film or film_dir()
    cues = []

    def add(sfx, at, gain=0):
        cues.append({"sfx": sfx, "at": round(at, 3), "gain": gain})

    def keys(start, end, n, gain=-2):
        for i in range(n):
            add("key", start + (end - start) * i / max(1, n - 1), gain - (i % 3))

    cap_dir = os.environ.get("CAP_DIR", os.path.join(film, "cap"))
    man = load(os.path.join(cap_dir, "manifest.json")) or {}
    fev = load(os.path.join(film, "film-events.json")) or {}
    ready = os.path.exists(os.path.join(cap_dir, "READY"))
    used = []

    def cap(shot, nm):
        e = (man.get(shot) or {}).get("events") or {}
        return e[nm] / 1000.0 if isinstance(e.get(nm), (int, float)) else None

    def ev(shot, *names, anchor=None, rel=None):
        """Film time (s) of an event. Order: film-events.json (the times film.js really uses), then the motion
        agent's anchor, then the capture manifest. rel=(name, t): place it at t + the capture's gap from that
        event (for shots film.js re-times, where shot start + event ms would be wrong)."""
        for nm in names:
            v = fev.get(f"{shot}.{nm}")
            if isinstance(v, (int, float)):
                used.append(f"film-events {shot}.{nm}")
                return v / 1000.0
        if anchor is not None:
            used.append(f"anchor {shot}.{names[0]}")
            return anchor
        for nm in names:
            c = cap(shot, nm)
            if c is None:
                continue
            if rel is not None:
                b = cap(shot, rel[0])
                if b is None:
                    continue
                used.append(f"manifest {shot}.{nm} rel {rel[0]}")
                return rel[1] + c - b
            used.append(f"manifest {shot}.{nm}")
            return SHOT_START[shot] + c
        return None

    def on_grid(t, tol=0.04):
        """A pitched sound near the grid goes on it (the picture can't see 40 ms; the groove can)."""
        g = round(t / S16) * S16
        return g if abs(g - t) <= tol else t

    # ---- pointer taps: every press film.js plays (film-events press.NN), else the ones placed below
    fpress = sorted(v / 1000.0 for k, v in fev.items() if k.startswith("press.") and isinstance(v, (int, float)))

    def tap(t, gain=8):
        if not fpress:
            add("press", t, gain)

    # ---- whooshes: one per camera move, onset 0.17 s before its fastest frame
    peaks = motion_peaks(film)
    have = {lbl for lbl, _, _ in peaks}
    extra = cam_peaks(film, [t for _, t, _ in peaks]) if peaks else []
    if peaks:                                   # placeholders only for named moves the peaks file lacks
        peaks += [(lbl, t, None) for lbl, (t, _, _) in MOVES.items() if lbl not in have]
    else:
        peaks = [(lbl, t, None) for lbl, (t, _, _) in MOVES.items()]
    last, skipped = -9.0, []
    # hard picture cuts: film-events keys "cut.*", "*.cut", "*.hardCut", or motion peaks of kind "cut"
    cuts = sorted({v / 1000.0 for k, v in fev.items() if isinstance(v, (int, float))
                   and (k.startswith("cut.") or k.endswith(".cut") or k.endswith(".hardCut"))}
                  | {t for lbl, t, _ in peaks if lbl.startswith("cut:")})
    for lbl, t, px in sorted(peaks + extra, key=lambda p: p[1]):
        if (px is not None and px < MIN_PX_PER_FRAME) or lbl.startswith(SKIP_LABELS) or lbl.startswith("cut:"):
            continue
        if any(abs(t - tc) <= CUT_NEAR for tc in cuts):
            skipped.append(f"{lbl}@{t:.2f} (cut)")
            continue
        if any(lbl.startswith(f) for f in FINALE_LABELS):
            add("whoosh", max(STOP + 0.1, t - WHOOSH_LEAD), -12)      # review: sound #8, soft, after the dead cut
            continue
        if t - last < MIN_GAP:
            skipped.append(f"{lbl}@{t:.2f}")
            continue
        last = t
        sfx, g = MOVES[lbl][1:] if lbl in MOVES else ("whoosh", IN_SHOT_GAIN)
        if px is not None:                          # r2: the gain follows the camera's speed
            g = 4 if px >= 50 else (0 if px >= 25 else -2)
        g = max(g, LABEL_GAIN.get(lbl, g))
        add(sfx, t - WHOOSH_LEAD, g)
    if not any(any(l.startswith(f) for f in FINALE_LABELS) for l in have):
        add("whoosh", STOP + 0.1, -12)                                 # the check-in card rising (fastest ~56.57)

    # ---- opening: the orb pops under the press (the eight tiles are carried by the music's tile notes and the taps)
    tap(1.2 - 0.02, 6)
    add("pop", 1.2, -2)
    tap(7.2 - 0.03, 8)

    # ---- Home: the train chip turns to "12 min late"
    t_chip = ev("home", "lateChip")
    if t_chip is not None:
        add("chip", on_grid(t_chip), 3)

    # ---- Ask: typing at capture speed; the answer lands on the lift at 19.2
    t_type = ev("ask", "typeStart") or 15.0
    t_send = ev("ask", "send") or 17.4
    tap(t_type - 0.1, 8)
    keys(t_type, t_send - 0.1, max(6, int((t_send - 0.1 - t_type) / 0.09)), -2)
    add("send", t_send, 0)
    # (no chime at 19.2: the music's lift is the answer's arrival; a chime under it measured masked)

    # ---- Saved film: the link pasted (two keystrokes, cmd-V), the film card lands, opened, moved to Watch & read
    t_paste = ev("saved", "paste", anchor=25.2)
    tap(t_paste - 0.08, 8)                                 # tap the field
    add("key2", t_paste - 0.09, 2)                         # cmd
    add("key3", t_paste, 4)                                # V: the link appears
    add("select", t_paste + 0.01, 0)
    t_land = ev("saved", "posterLoaded", "cardLand", rel=("paste", t_paste)) or t_paste + 0.6
    add("drop", t_land, 3)                                 # a soft land as the film card fades in
    t_open = ev("saved", "open", anchor=27.0)
    tap(t_open - 0.04, 8)                                  # tap the card
    t_move = ev("saved", "move", anchor=28.2)
    tap(t_move - 0.04, 8)                                  # tap "Move to Watch & read"
    t_filed = ev("saved", "filed", "toast") or t_move
    add("tick", t_filed + 0.06, -2)                        # "Filed": a small check, not a buried pop
    # the poster lands in Watch & read at the end of the last fly segment (morph.saved.flyN.end, highest N)
    # flights are numbered as film.js builds them, not by time: take the last one to START (after "Move")
    flies = sorted((fev[k[:-4]] / 1000.0, int(k.split(".")[2][3:]), v / 1000.0) for k, v in fev.items()
                   if k.startswith("morph.saved.fly") and k.endswith(".end") and k.split(".")[2][3:].isdigit()
                   and isinstance(v, (int, float)) and isinstance(fev.get(k[:-4]), (int, float))
                   and fev[k[:-4]] / 1000.0 > t_move)
    flies = [(n, end) for _, n, end in flies]
    # it reaches its slot when the first segment of that last flight group ends (grow2 can finish before fly3)
    if flies:
        s0 = fev.get(f"morph.saved.fly{flies[-1][0]}")
        group = [v / 1000.0 for k, v in fev.items() if k.startswith("morph.saved.") and k.endswith(".end")
                 and isinstance(v, (int, float)) and fev.get(k[:-4]) == s0]
        t_landed = min(group + [flies[-1][1]])
    else:
        t_landed = ev("saved", "landed", rel=("move", t_move))
    if t_landed is not None and t_landed > t_move + 0.3:
        add("land", t_landed - 0.04, 5)                    # the poster settles in Watch & read
    if flies and isinstance(fev.get(f"morph.saved.fly{flies[-1][0]}"), (int, float)):
        t_fly = fev[f"morph.saved.fly{flies[-1][0]}"] / 1000.0 + 0.05      # r3: the flight itself, 50 ms in
        if not any(c["sfx"].startswith("whoosh") and abs(c["at"] - t_fly) < 0.5 for c in cues):
            add("whoosh", t_fly, FLIGHT_GAIN)

    # ---- Team: Penny's card arrives with her little voice; a soft tap on the card's button; she replies
    # her voice when the card has settled and reads (scrollEnd), on the grid: beat 2 of the hook-less bar
    t_card = ev("team", "scrollEnd") or (lambda v: v + 0.43 if v else 31.8)(ev("team", "cardVisible", "card"))
    add("penny", on_grid(t_card, 0.06), 7)
    t_faces = ev("team", "chips", "faces")                 # the Penny/Dot/Wren chips (if film.js marks them)
    if t_faces is not None:
        t0f = math.ceil((t_faces + 0.3) / S16 - 1e-6) * S16   # r3: as the camera settles on them, on the grid
        for j in range(3):
            tf = t0f + j * S16
            if abs(tf - on_grid(t_card, 0.06)) > 0.1 and not any(abs(tf - tc) < 0.08 for tc in cuts):
                add(f"face{j + 1}", tf, -3)                 # under Penny: she is the voice
    t_tap = ev("team", "tap", "open", anchor=34.2)
    tap(t_tap - 0.04, 6)                                   # soft tap ("Ask about it" / "Open it")
    t_sent = ev("team", "send", anchor=34.8)
    add("send", t_sent, 2)
    t_reply = ev("team", "reply", rel=("send", t_sent))
    if t_reply is not None and t_reply - t_card > 0.6 and t_reply < 36.0:
        add("penny_reply", on_grid(t_reply, 0.06), 7)

    # ---- Music: tap "Evening run", the tile grows into the sheet
    t_mo = ev("music", "open", anchor=37.8)
    tap(t_mo - 0.05, 8)
    add("pop", t_mo + 0.05, 1)

    # ---- Habits: the tick
    t_tick = ev("habits", "tick", anchor=42.0)
    if DROPOUT[0] - 0.05 <= t_tick < DROPOUT[1]:
        print("  NOTE habits tick falls in the dropout; it still plays")
    add("tick", t_tick, 5)

    # ---- the closing line: typed, two phrases selected and retyped. The quickening swaps are ticked by the music.
    swaps = load(os.path.join(HERE, "swaps.json")) or []
    for sw in swaps:
        at = sw["at"] / 1000.0
        if sw.get("how") == "type":
            t0 = fev.get("line2.typeStart")
            t0 = t0 / 1000.0 if isinstance(t0, (int, float)) and t0 / 1000.0 < at else at - 0.7
            keys(t0, at - 0.04, max(6, int(round((at - 0.04 - t0) / 0.066)) + 1), 0)
        elif sw.get("how") == "retype":
            add("select", at, 4)
            keys(at + 0.12, at + 0.34, 5, 0)
    # 56.4: dead cut, no pop. 57.6: "Great" on the final chord.
    tap(GREAT - 0.02, 6)
    add("tick", GREAT, 4)

    last = -1.0
    for t in fpress:
        if t - last < 0.03:
            continue
        last = t
        g = 4 if 2.9 < t < 5.2 else (6 if t < 2.6 or abs(t - GREAT) < 0.05 else 8)   # the tile run softer
        add("press", t - 0.02, g)

    # the cut accent: full on a bare cut, a touch under when something else (Penny's voice) lands with it
    for tc in cuts:
        tg = on_grid(tc)
        busy = any(abs(c["at"] - tg) < 0.05 and c["sfx"] not in ("key", "press") for c in cues)
        add("cut_accent", tg, -6 if busy else 0)

    cues.sort(key=lambda c: c["at"])
    if verbose:
        print(f"  pointer presses: {len(fpress)} from film-events.json" if fpress else "  pointer presses: placed from events")
        print(f"  motion peaks: {len(have)} from motion-peaks.json, {len(extra)} more from camspeed.json; "
              f"same-move peaks skipped: {', '.join(skipped) or 'none'}" if have else
              "  motion peaks: none yet, whooshes on placeholders (boundary + 0.4 s)")
        print(f"  manifest: {'READY' if ready else 'not ready'}; events used: {', '.join(used) or 'none (plan fallbacks)'}")
    return cues


def main():
    film = film_dir()
    cues = build_cues(film)
    out = os.path.join(film, "audio", "cues.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(cues, f, indent=1)
    print(f"  {len(cues)} cues -> {out}")


if __name__ == "__main__":
    main()
