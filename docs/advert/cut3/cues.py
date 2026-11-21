#!/usr/bin/env python3
"""Writes $FILM/audio/cues.json: every interface sound, placed against the picture.

Times are seconds on the film's timeline (BRIEF.md) and the measured capture
events in cap/manifest.json. Run this, then mix.py.
"""
import json, os, sys

FILM = os.environ.get("FILM", "/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film")
m = json.load(open(f"{FILM}/cap/manifest.json"))
cues = []
add = lambda sfx, at, gain=0: cues.append({"sfx": sfx, "at": round(at, 3), "gain": gain})

def keys(start, end, n, gain=-6):
    for i in range(n):
        add("key", start + (end - start) * i / max(1, n - 1), gain - (i % 3))

# Opening: the orb, then eight tiles, one a beat.
add("pop", 1.2, -2)
add("press", 2.4)
for i in range(8):
    add("pop", 3.0 + 0.6 * i, -5)
add("press", 9.6)
add("whoosh", 9.45, -3)

# Ask: starts at 18.0. Typing runs at capture speed; the answer is re-timed to 23.4 and its sources to 26.4.
ASK = 18.0
a = m["ask"]["events"]
add("whoosh", ASK - 0.6, -5)
add("press", ASK + a["typeStart"] / 1000 - 0.1)
keys(ASK + a["typeStart"] / 1000, ASK + a["send"] / 1000 - 0.1, 26)
add("send", ASK + a["send"] / 1000, -3)
add("answer", 23.4, -4)
add("pop", 26.4, -8)

# Saved: starts at 28.8. A quote is typed and kept.
SAVED = 28.8
s = m["saved"]["events"]
t0 = s.get("typeStart", s.get("paste", 400)) / 1000
add("whoosh", SAVED - 0.6, -5)
add("press", SAVED + t0 - 0.1)
keys(SAVED + t0, SAVED + s["add"] / 1000 - 0.1, 22, -7)
add("drop", SAVED + s["add"] / 1000 + 0.2, -3)

# Music: starts at 34.8. The page scrolls to the playlists and one opens.
MUSIC = 34.8
mu = m["music"]["events"]
add("whoosh", MUSIC - 0.6, -5)
add("whoosh", MUSIC + mu["scrollStart"] / 1000, -9)
if "open" in mu:
    add("press", MUSIC + mu["open"] / 1000 - 0.05)
    add("pop", MUSIC + mu["open"] / 1000 + 0.05, -4)

# Habits at 40.8, Health at 44.4, the pull-back from 47.4, the wall falling at 52.8.
add("whoosh", 40.2, -5)
add("tick", 40.8 + m["habits"]["events"]["tick"] / 1000, -2)
add("whoosh", 43.9, -6)
add("whoosh", 47.5, -2)
add("whoosh", 52.65, -4)

# Closing line: typed, two phrases selected and retyped. The quickening swaps are ticked by the music itself.
swaps = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "swaps.json")))
keys(52.95, 53.4, 10, -7)
for sw in swaps:
    if sw["how"] == "retype":
        add("select", sw["at"] / 1000, -2)
        keys(sw["at"] / 1000 + 0.12, sw["at"] / 1000 + 0.34, 5, -7)
final = swaps[-1]["at"] / 1000
add("pop", final, -4)        # lands on "good days"
add("whoosh", final, -8)     # the check-in card rising
add("tick", 62.4, -1)        # Great

cues.sort(key=lambda c: c["at"])
json.dump(cues, open(f"{FILM}/audio/cues.json", "w"), indent=1)
print(len(cues), "cues")
