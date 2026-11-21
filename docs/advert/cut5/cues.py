#!/usr/bin/env python3
"""Writes $FILM/audio/cues.json: every interface sound, placed against the picture (cut 5, 81.6 s).

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
Run this, then mix.py. Re-run both whenever motion-peaks.json, film-events.json or the manifest changes.
(music.py reads two events itself, work.stepDown and hire.arrive: re-run it first if either moved to another
bar / beat; this file prints a NOTE when the music on disk no longer matches.)

New in cut 5 (film-events keys, all optional; the plan's times stand in):
  track.tellMeWhen / atOrUnder / amount / tellMe   presses (taps come from press.NN), track.typeStart/typeEnd if
                            the amount is typed, track.targetSet -> "set"
  work.working -> Penny's voice; work.stepDown -> "stepdown" (its landing on that frame); work.reached -> "reached"
  hire.typeStart/typeEnd -> keys; hire.arrive / hire.hello -> "hello"; hire.faces -> two face blips
  as the new face lands on the Team page, 57.6-59.4 (else straight after the hello); hire.joined -> a soft pop
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
SHOT_START = {"home": 9.6, "ask": 14.4, "saved": 24.0, "track": 31.2, "music": 36.0, "habits": 40.8, "work": 43.2,
              "hire": 50.4}
STOP, GREAT, DROPOUT = 73.2, 74.4, (59.4, 60.0)
STEP_DEFAULT, ARRIVE_DEFAULT = 48.0, 55.2      # music.py's defaults for work.stepDown and hire.arrive
STEP_LEAD, HELLO_LEN = 0.6, 0.36               # sfx.stepdown lands this far in; sfx.hello is said by here

# camera moves: label -> (placeholder fastest point, sfx, gain dB). Review sound #1 asked +1; measured against the
# brighter cut 4 music, +4 puts a move's whoosh at or above the music in 2-8 kHz.
MOVES = {
    "dive": (7.2 + 0.4, "whoosh_big", 4),
    "home-ask": (14.4 + 0.4, "whoosh", 4),
    "ask-saved": (24.0 + 0.4, "whoosh", 4),
    "saved-track": (31.2 + 0.4, "whoosh", 4),
    "track-music": (36.0 + 0.4, "whoosh", 4),
    "music-habits": (40.8 + 0.4, "whoosh", 4),
    "habits-work": (43.2 + 0.4, "whoosh", 4),
    "work-hire": (50.4 + 0.4, "whoosh", 4),
    "pullback": (60.0 + 0.4, "whoosh_big", 4),
    "wall-exit": (64.8 + 0.4, "whoosh", 2),
}
PLACEHOLDER_NEAR = 1.0      # a named move the peaks file lacks gets its placeholder only if no peak is this close
FINALE_LABELS = ("checkin", "finale", "card", "lift", "good-days")   # the card rising after the dead cut
IN_SHOT_GAIN = -2           # in-shot reframes (saved-open, team-open, ...): a lighter touch
LABEL_GAIN = {"saved-watch": 2}   # in-shot moves that carry a story beat (the poster flying into Watch & read)
SKIP_LABELS = ("orb",)      # the Great -> orb morph: the logo tag carries it; a whoosh there measured inaudible
SOFT_CUTS = ("cut.hire",)   # a state swap inside a continuous push in, not a camera cut: no accent, keep the whoosh
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


def film_events(film, verbose=False):
    """film-events.json, and how far (s) its late events were moved. Motion data rendered for another timeline
    (its Great is not on GREAT): until the re-render lands, everything after the arrival bar moves by the
    difference, and we say so. A no-op once the data is current."""
    fev = load(os.path.join(film, "film-events.json")) or {}
    gp = fev.get("checkin.press")
    late = (GREAT - gp / 1000.0) if isinstance(gp, (int, float)) and abs(gp / 1000.0 - GREAT) > 0.05 else 0.0
    if late:
        fev = {k: (v + late * 1000.0 if isinstance(v, (int, float)) and v > 57650 else v) for k, v in fev.items()}
        if verbose:
            print(f"  NOTE film-events.json is from another timeline (Great at {gp / 1000.0:.1f}, not {GREAT}): "
                  f"events after 57.65 s and camera peaks after 57.0 s moved {late:+.1f} s until motion re-renders")
    return fev, late


def build_cues(film=None, verbose=True):
    film = film or film_dir()
    cues = []

    def add(sfx, at, gain=0, over=None):
        cues.append({"sfx": sfx, "at": round(at, 3), "gain": gain})
        if over is not None:             # mix.py measures the gain instead: this many dB over the music in 2-8 kHz
            cues[-1]["over"] = over

    def keys(start, end, n, gain=-2):
        for i in range(n):
            add("key", start + (end - start) * i / max(1, n - 1), gain - (i % 3))

    cap_dir = os.environ.get("CAP_DIR", os.path.join(film, "cap"))
    man = load(os.path.join(cap_dir, "manifest.json")) or {}
    fev, late = film_events(film, verbose)
    ready = os.path.exists(os.path.join(cap_dir, "READY"))
    used = []

    def cap(shot, nm):
        e = (man.get(shot) or {}).get("events") or {}
        return e[nm] / 1000.0 if isinstance(e.get(nm), (int, float)) else None

    def ev(shot, *names, anchor=None, rel=None, film_only=False):
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
        if film_only:                    # a shot film.js cuts down and re-times: its capture clock means nothing
            return None
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
    peaks = [(lbl, t + late if t > 57.0 else t, px) for lbl, t, px in motion_peaks(film)]
    have = {lbl for lbl, _, _ in peaks}
    extra = cam_peaks(film, [t - late if t > 57.0 + late else t for _, t, _ in peaks]) if peaks else []
    extra = [(lbl, t + late if t > 57.0 else t, px) for lbl, t, px in extra]
    if peaks:                                   # placeholders only for named moves the peaks file lacks
        real = [t for _, t, _ in peaks]         # (and only where it has nothing: the labels may differ)
        peaks += [(lbl, t, None) for lbl, (t, _, _) in MOVES.items()
                  if lbl not in have and all(abs(t - r) > PLACEHOLDER_NEAR for r in real)]
    else:
        peaks = [(lbl, t, None) for lbl, (t, _, _) in MOVES.items()]
    last, skipped, last_px, last_lbl, last_cue = -9.0, [], None, "", None
    # hard picture cuts: film-events keys "cut.*", "*.cut", "*.hardCut", or motion peaks of kind "cut"
    cuts = sorted({v / 1000.0 for k, v in fev.items() if isinstance(v, (int, float)) and k not in SOFT_CUTS
                   and (k.startswith("cut.") or k.endswith(".cut") or k.endswith(".hardCut"))}
                  | {t for lbl, t, _ in peaks if lbl.startswith("cut:")})
    for lbl, t, px in sorted(peaks + extra, key=lambda p: p[1]):
        if (px is not None and px < MIN_PX_PER_FRAME) or lbl.startswith(SKIP_LABELS) or lbl.startswith("cut:"):
            continue
        if any(abs(t - tc) <= CUT_NEAR for tc in cuts):
            skipped.append(f"{lbl}@{t:.2f} (cut)")
            continue
        if any(lbl.startswith(f) for f in FINALE_LABELS):
            if t >= STOP - 0.5:
                add("whoosh", max(STOP + 0.1, t - WHOOSH_LEAD), -14)  # review: sound #8, soft, after the dead cut
            continue
        if t - last < MIN_GAP:
            # one whoosh for the pair: the first, unless this one is clearly the bigger move (twice the speed)
            if px is not None and last_px is not None and px >= 2 * last_px and cues and cues[-1] is last_cue:
                skipped.append(f"{last_lbl}@{last:.2f} (for {lbl})")
                cues.pop()
            else:
                skipped.append(f"{lbl}@{t:.2f}")
                continue
        last, last_px, last_lbl = t, px, lbl
        sfx, g = MOVES[lbl][1:] if lbl in MOVES else ("whoosh", IN_SHOT_GAIN)
        if px is not None:                          # r2: the gain follows the camera's speed
            g = 4 if px >= 50 else (0 if px >= 25 else -2)
        g = max(g, LABEL_GAIN.get(lbl, g))
        add(sfx, t - WHOOSH_LEAD, g)
        last_cue = cues[-1]
    if not any(any(l.startswith(f) for f in FINALE_LABELS) for l in have):
        add("whoosh", STOP + 0.1, -12)                                 # the check-in card rising (fastest ~73.4)

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

    # ---- Team 1, "Tell me when": a tap for each press (Tell me when, At or under, the amount, Tell me), then
    #      the small "set" when the target pill and the dashed line appear
    t_tmw = ev("track", "tellMeWhen", anchor=32.4)
    t_aou = ev("track", "atOrUnder", anchor=33.0)
    t_amt = ev("track", "amount", "typeEnd", anchor=33.6)
    t_tell = ev("track", "tellMe", anchor=34.2)
    for t in (t_tmw, t_aou, t_tell):
        tap(t - 0.04, 6)
    t_ty0, t_ty1 = ev("track", "typeStart"), ev("track", "typeEnd")
    if t_ty0 is not None:                                  # the amount typed: one key a character ("28")
        t_ty1 = t_ty1 if t_ty1 is not None and t_ty1 > t_ty0 else t_ty0 + 0.12
        keys(t_ty0, t_ty1, max(2, min(4, int(round((t_ty1 - t_ty0) / 0.09)) + 1)), 2)
    else:
        tap(t_amt - 0.04, 6)
    t_set = ev("track", "targetSet", "target", "set")
    t_set = t_set if t_set is not None else t_tell + 0.3
    add("set", on_grid(t_set), 1)                          # r2: at 5 it competed with the arrival
    t_wipe = fev.get("morph.track.wipe")                   # the dashed "Your £28" line being drawn: a thread of air
    if isinstance(t_wipe, (int, float)):
        add("select", t_wipe / 1000.0 + 0.03, -2)

    # ---- Music: tap "Evening run", the tile grows into the sheet
    t_mo = ev("music", "open", anchor=37.8)
    tap(t_mo - 0.05, 8)
    add("pop", t_mo + 0.05, 1)

    # ---- Habits: the tick
    t_tick = ev("habits", "tick", anchor=42.0)
    add("tick", t_tick, 5)

    # ---- Team 2: Penny's voice when her working line shows (the music ticks and searches under her), the price
    #      stepping down so its last step lands on the frame it drops under the target, then the bright "reached"
    t_work = ev("work", "working", "workingLine", anchor=44.4)
    add("penny", on_grid(t_work, 0.06), 8)
    t_step = ev("work", "stepDown", "result", anchor=STEP_DEFAULT)
    add("stepdown", t_step - STEP_LEAD, 6)
    t_reach = ev("work", "reached", "reachedLine", film_only=True)
    if t_reach is None or t_reach < t_step + 0.2:
        t_reach = t_step + BEAT / 2                        # half a beat after the landing, so both are heard
    add("reached", on_grid(t_reach, 0.06), 5.5)   # r1 asked +7: that put this window over the chord
    if t_work > t_step - 1.2:
        print(f"  NOTE Penny's working line ({t_work:.2f}) is under 1.2 s before the step down ({t_step:.2f})")

    # ---- Team 3, hire: the job typed in one sentence, sent; the new character says hello in its own small
    #      voice (the music's warm chord is under it) and the team's three faces answer
    t_h0 = ev("hire", "typeStart", anchor=51.0)
    t_h1 = ev("hire", "typeEnd", "typed", anchor=53.4)
    tap(t_h0 - 0.1, 8)
    if t_h1 > t_h0:
        keys(t_h0, t_h1 - 0.05, max(6, int((t_h1 - 0.05 - t_h0) / 0.09)), 1)   # over a groove, not Ask's thin bars (r1: 6 was forward)
    t_sub = ev("hire", "submit", "send", "hire", anchor=54.0)
    tap(t_sub - 0.04, 8)
    t_arr = ev("hire", "arrive", "appear", anchor=ARRIVE_DEFAULT)
    t_hello = ev("hire", "hello", film_only=True)
    t_hello = t_hello if t_hello is not None and t_hello >= t_arr else t_arr
    t_hello = on_grid(t_hello, 0.06) if on_grid(t_hello, 0.06) >= t_hello - 0.02 else t_hello   # never ahead of its bubble
    add("hello", t_hello, 9)
    t_faces = ev("hire", "faces", "team", film_only=True)
    if t_faces is not None and t_faces > DROPOUT[0] - 3 * S16:
        t_faces = None       # the Team page would only show inside the pull-back: they answer the hello instead
    # r2: two blips, a fifth apart: D6 on the frame the new face lands in the list, A6 a 16th later (the list
    # answering). Without that frame: on the next 16th after the hello.
    t0f = math.ceil((t_hello + HELLO_LEN + 0.06) / S16 - 1e-6) * S16
    if t_faces is not None and t_faces >= t_hello + HELLO_LEN:
        t0f = t_faces
    for j, f in enumerate(("face1", "face3")):
        add(f, t0f + j * S16, (1, 9)[j], over=5)           # level measured by mix.py: even wherever they land
    t_join = ev("hire", "joined", film_only=True)
    if t_join is not None and t_join > t0f + 2 * S16 + 0.3 and t_join < DROPOUT[0] - 0.1:
        add("pop3", on_grid(t_join), 0)                    # "... is on your team"
    try:                                                   # the music scores two of these events: say so if it is stale
        import music as M_
        if abs(M_.STEP - t_step) > 0.05:
            print(f"  NOTE the step down is at {t_step:.2f} but music.py is built for {M_.STEP:.2f}: re-run music.py")
        if abs(M_.ARRIVE - t_arr) > 0.31:
            print(f"  NOTE the arrival is at {t_arr:.2f} but music.py is built for {M_.ARRIVE:.2f}: re-run music.py")
    except Exception as e:                                 # numpy missing etc.: the cue sheet doesn't need it
        print(f"  (music.py not checked: {e})")

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
    # 73.2: dead cut, no pop. 74.4: "Great" on the final chord.
    tap(GREAT - 0.02, 6)
    add("tick", GREAT, 4)

    last = -1.0
    for t in fpress:
        if t - last < 0.03:
            continue
        last = t
        g = 4 if 2.9 < t < 5.2 else (6 if t < 2.6 or abs(t - GREAT) < 0.05 else 8)   # the tile run softer
        if SHOT_START["track"] <= t < SHOT_START["music"]:
            g = 6                                            # r1 sound: 11 stuck out over the sparse bars
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
