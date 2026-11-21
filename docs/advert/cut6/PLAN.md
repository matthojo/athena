# Cut 6 plan

Cut 6 starts as a copy of cut 5 (`../cut5/` stays as shipped, with its reviews in `../cut5/review/`).
Two client asks: (1) the latest app: the new assistant UI (Team page with Team chat and New
assignment, the assistant's page with its flows and what it may do) and the new **Flows**
feature; (2) the sound **less synth-like, a tad softer, a cuter vibe**. The ending stays as cut 5.

Main was republished as a public history; this branch is rebuilt on it. Every capture must be
re-shot on the current app. Names and copy rules carry over: the gift-price assistant is
**Penny** ("Muse" must never appear on screen; note Meta's real "Muse" models exist in the model
catalogue, never show them either); sample products/shops are made up; real integrations (Linear,
Amazon, Spotify) stay out of frame where possible; the Saved film is Guardians of the Galaxy with
the real poster via `CAP_FILM_POSTER`.

## Timeline: 86.4 s, 36 bars at 100 BPM (bar 2400 ms, beat 600 ms), 2592 frames

| ms | Beat | What happens |
|---|---|---|
| 0–9600 | Opening, dive | As cut 5. |
| 9600–14400 | Home | Late chip lands live at 11400. Home now shows "Flows" and "Team" chips by the Ask box: fine in frame. |
| 14400–24000 | Ask | As cut 5. |
| 24000–31200 | Saved film | As cut 5. |
| 31200–36000 | Team 1 "Tell me when" | As cut 5, on the current Tracking UI. |
| 36000–40800 | Music | As cut 5. |
| 40800–43200 | Habits | As cut 5. |
| 43200–50400 | Team 2 Penny works → reached | As cut 5 (hard cut on 43200; step on 48000), on the current UI. |
| 50400–57600 | Team 3 hire Acorn | As cut 5 (arrival on 55200), current UI. |
| 57600–60000 | Team page | Acorn on the team: the current Team page (with Team chat / New assignment visible is good). |
| 60000–64800 | **Flows** | The Flows page: Athena's suggestion card "You look for a present a week before birthdays. Four times since September. Want Athena to do it for you?" → tap "Make it a flow" → the flow appears as steps (When … / Then …), and it is switched on. The steps arriving on 62400 is the beat's moment. If the suggestion path can't show the steps, use the New flow sheet: a sentence → "Make the steps" → the steps. |
| 64200–64800 | Dropout | |
| 64800–69600 | Pull-back | Reveal lands on 64800; the wall includes Team, Tracking and a Flow. |
| 69600–78000 | Rotation | First readable: platform, pricing call, film, price, run, streak, Monday list, birthdays; then packed; musical steps. |
| 78000 | "good days" | Dead cut; check-in card rises. |
| 79200 | Great | On the final chord. |
| 81000–86400 | Lockup | Great → orb, wordmark; fade last 300 ms. |

## Sound: the new brief

Less synth-like, a tad softer, cuter. Replace the synth palette with acoustic-sounding,
physically modelled or sample-free imitations: felt/soft piano, kalimba or marimba plucks,
glockenspiel/celesta sparkles, a plucked ukulele or nylon guitar (Karplus–Strong), upright or
plucked bass, brushed snare/shaker/finger snaps instead of 808-style kicks and hats. UI sounds
become small wooden/glass taps, soft pops and bubbles; whooshes become soft breathy air, quieter.
Penny's and Acorn's voices stay but gentler and rounder. Overall a little softer: aim -15 LUFS
integrated (was -14), less limiting, peaks rounder; keep the shape (the Great chord loudest, the
price step second, Acorn's arrival third, a dead cut before "good days").

## Rules carried over (all still apply)

One continuous camera, lopsided eases, motion blur, pointer leads; never blend two misaligned
layouts at partial opacity; no whip over ~150 px/frame except the pull-back; important text ≥1.2 s
and never cropped; whooshes/taps/ticks on their picture events; review with frame GRIDS.

## Ownership and paths

- Capture: `capture.cjs`. Motion: `film.html`, `film.css`, `film.js`, `render.cjs`, `swaps.json`,
  `BRIEF.md`. Sound: `music.py`, `sfx.py`, `mix.py`, `audiolib.py`, `cues.py`, `verify_audio.py`.
- `FILM=/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film6`.
  capture.cjs needs an explicit `CAP_DIR` (use `$FILM/cap`).
- Commit only your own files, by name; push with `git push origin claude/friendly-fermi-ci3iwy`
  (pull --rebase first if rejected).
