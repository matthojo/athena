# Cut 4 plan

Source for cut 4. It starts as a copy of cut 3 (`../cut3/` stays as it was).
Three reviews of cut 3 are in `review/` (story, transitions, sound): read the one
for your area in full. This plan says which of their fixes are in.

## Client notes for cut 4

1. Saved: the saved thing is a film. Paste `https://letterboxd.com/film/guardians-of-the-galaxy/`.
   Sample mode now lands it as a film card ("Guardians of the Galaxy", Film · 2014 · James Gunn,
   "Move to Watch & read"). Capture with `CAP_FILM_POSTER=$FILM/assets/film-poster.jpg` so the card
   shows the real poster. The poster stays out of the repo.
2. Team: a new beat for the Team feature. The gift-price assistant is **Penny** (never "Muse",
   a competitor's name). Penny's sample find is now a moka pot at John Lewis, £34, £8 under.
3. Transitions are the main area of craft for this cut.

Sample data already changed for this cut: playlist "Evening run" (was Morning run), habit
"Evening run" (was Evening walk), Elena's answer says "Pro price" (was Team price).

## Timeline: 64.8 s, 27 bars at 100 BPM (bar 2400 ms, beat 600 ms)

| ms | Beat | What happens |
|---|---|---|
| 0–7200 | Opening | Orb pops (press 1200). Eight Library tiles pop every half beat 3000–5100. "Everything you'd otherwise forget" complete by 6600. Pointer moves towards tile 1 from ~6600; dive starts 7200 (cubic ease, not quintic), tiles fall during the dive. |
| 7200–9600 | Dive | Lands on Home by ~9300, no dead stop: the landing carries straight into framing the train. |
| 9600–14400 | Home | Train row: "12 min late · Platform 7" chip lands by ~11400 and holds ~2 s. Frame tight on the train; keep the flight rows and the greeting out of frame if possible. |
| 14400–24000 | Ask | The pricing question; answer words anchored to the music lift at 19200; push in so the first sentence of the answer fills ~60% of frame height; finished answer holds ≥2.4 s. No in/out zoom pumping. |
| 24000–31200 | Saved film | Paste the Letterboxd link, film card lands with the poster, open it, tap "Move to Watch & read" (ideally the poster card carries into Watch & read as a morph or match-cut). |
| 31200–36000 | Team: Penny | A "From Penny" card arrives on Home ("The moka pot is down to £34"), framed tight on the cat avatar and that line; holds 3 beats; pointer taps "Open it" and her reply/Team detail is the next thing seen. Penny's face must read at phone size. |
| 36000–40800 | Music | Land on Playlists directly (no long stats scroll), tap "Evening run", sheet opens; the tile grows into the sheet, no hard pop. |
| 40800–43200 | Habits | Tick "Evening run". |
| 43200–48000 | Pull-back | Fast-early ease so most of the reveal lands on the 43200 downbeat (music hit); wall of 12 screens includes the Team grid (Penny, Dot, Wren); slow drift to 1.10× and a moving pointer, no freeze. Health beat is cut (its screen can stay on the wall). |
| 48000–56400 | Rotation | "Athena remembers the …" per `swaps.json`, re-timed on musical steps (see below). |
| 56400 | "good days" | Dead cut in the music; the check-in card "How was today?" rises. |
| 57600 | Great | "Great" pressed exactly on the final chord. |
| 59400–64800 | Lockup | The pressed Great circle becomes the orb (morph, not a dissolve); wordmark "Athena"; fully formed by ~60600 and held; fade in the last 300 ms. |

## Rotation (`swaps.json`)

The first six readable slots retell the day in order: platform, pricing call, film, gift idea,
run, streak. No later duplicates of these. Keep it packed (films, albums, bills, MOT, etc.)
and end on "good days" at 56400. Timing on musical steps, quantised, picture rounding to the
nearest frame: quarter notes, then 8th-note triplets (200 ms), then 16ths (150 ms), then 16th
triplets (100 ms = 3 frames) up to 56300. The swap ticks sit exactly on those steps.

## Transitions (motion)

From `review/transitions.md`; all in:
- One continuous camera: a spline through keyframes so speed carries from move to move. No
  stop-whip-stop. Lopsided eases (≈900 ms in, ≈1500 ms out); next content arrives while the
  camera is still decelerating.
- Motion blur: average ~5 sub-frame samples whenever the camera moves faster than ~25 px/frame.
- The pointer leads: it heads to the next target ~900 ms before a move, the camera follows
  ~300 ms later; slight stretch along fast travel. It is never dragged by the world.
- At least one morph from the reference playbook: Great → orb is required; Saved card → Watch &
  read cover if the capture allows.
- Wall exits over ≥500 ms, not 260 ms. Finale line and card share one curve.

## Sound

From `review/sound.md`; all eight fixes are in, on the new timeline. Plus the Team beat:
a small pitched vowel voice for Penny when her card arrives (one per beat if more faces show),
hook muted underneath, rim fill back into the groove. Whooshes start 0.17 s before each move's
fastest point, so take the camera curve from `film.js` once the motion pass settles (the motion
agent writes `$FILM/motion-peaks.json`: the time of each move's fastest frame).

## Ownership

- Capture: `capture.cjs`, `$FILM/cap/` (new shots: saved film, team/Penny; re-shoot every shot on
  the merged app because Home and the nav changed). Writes `cap/manifest.json`.
- Motion: `film.html`, `film.css`, `film.js`, `render.cjs`, `swaps.json`, `BRIEF.md`.
- Sound: `music.py`, `sfx.py`, `mix.py`, `audiolib.py`, `cues.py`, `verify_audio.py`.
- Paths: `FILM=/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film4`.
