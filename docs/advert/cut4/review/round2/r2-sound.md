# Sound review, cut 4 round 2 (`cut4-r1.mp4`)

How I measured: same method as round 1. The film's audio matches `mix.wav` (lag 0). Cues are rebuilt in isolation against the music. Sync was checked on frame grids (`review4/sound_work/r2_*.jpg`).

## Round 1 issues

| # | Status | Numbers |
|---|---|---|
| 1 Penny early | **Fixed** | Now 32.40, on the beat. The card settles at 32.33–32.40. +14.4 dB over the music in 2–8 kHz. |
| 2 Reply masked | **Fixed** | The whoosh is on the open's camera peak (33.867). The reply went from −4.9 to −0.3 dB in 2–8 kHz. |
| 3 Poster silent | **Better** | The `drop` at 30.23 comes after the poster reaches its slot (30.03–30.07) and measures −11.4 dB in 2–8 kHz. The fly lost its whoosh (9.5 px/frame is under `MIN_PX`). "Filed" `tick` +0.3 dB (was −25). |
| 4 Card drop | **Fixed** | 26.233, on the cross-fade. |
| 5 Ask clutter | **Fixed** | One whoosh per move, no chime, no music swoosh. |
| 6 Rotation hole | **Fixed** | 50.4–54.0 at −14.2 LUFS (was −19.5); the lowest block −17.7 (was −25.3). |
| 7 Opening | **Better** | 0–2.4 s at −28.1 LUFS. The 0.4–0.8 block is still −45. |
| 8 Dark | **Better, not enough** | 2–4 / 4–8 kHz −9 / −14 dB (were −11 / −16). The reference is −4 / −7. |
| 9, 10 | **Fixed** | Orb whoosh gone, keys start at 47.9, tile pops cut. |

The `CHORD_DB` change did nothing: the master put back the gain, so the chord is still −8.3 momentary.

Still right: every whoosh peaks on its camera maximum (16 of 16 matched moves). All 33 swap ticks start on the phrase-change frame (≤17 ms). Every tap is on its press frame, including the new Spotify tap at 39.56. The dead cut holds at −27.5 to −37.7 LUFS, and the chord lands on "Great" at 57.600.

## New issues, worst first

**1. The "12 min late" chip lands silently (11.43).** The re-cut picture moved it from 9.6, where the music crashes, to `home.lateChip` 11.4. The first story beat has no sound.
*Fix:* `add("chip", on_grid(ev("home","lateChip")), 0)` → 11.40. New `sfx.chip()`: a falling F#6→D6 bell pair, 60 ms apart, with `tick()`'s 3 kHz click.

**2. The send whip is under-scored (17.433, 73 px/frame).** `ask-steps` isn't in `MOVES`, so it gets −2 dB and measures −0.5 dB in 2–8 kHz. Moves of similar speed get +4.
*Fix:* set whoosh gain by speed in `cues.py`: `4 if px>=50 else (0 if px>=25 else -2)`.

**3. Drops vanish on a phone.** Their body is 110–220 Hz. The card drop measures −13 dB in 2–8 kHz and the poster drop −11.4.
*Fix:*
- In `sfx.drop`, raise the click from 0.25 to 0.6 and its low-pass from 1800 to 5000 Hz.
- Put the poster drop at 30.00, +3.
- Give the fly a whoosh: `MIN_PX_PER_FRAME` 8, or `whoosh` at 29.45, −4.

**4. Still 5–7 dB darker than the reference.** More high shelf won't help, because the master levels the mix by its loudest band (60–120 Hz).
*Fix:* `rms_target["bass"]` −17.5 → −19.5 and `peak_target["kick"]` −5 → −6.5. That lifts everything above 1 kHz about 2 dB after the master.

**5. The build is flat.** It runs from −14.1 to −12.3 LUFS momentary (+1.8 LU) and never goes above the pull-back (−12.1).
*Fix:* widen the build's loudness ride against the pull-back from −2.8→−1.5 LU to −4→+1.

**6. Optional.** The Penny, Dot and Wren chips show at 31.6–32.0 with no sound. Add three `voice()` blips at −6, a 16th apart.

## Verdict

Close: in sync and clean. I'd ship it after fixes 1–3, which are about ten minutes of cue edits. The single biggest lift is fix 4: pull the bass and kick down 1.5–2 dB, so every cue, the hook and Penny gain about 2 dB on phone speakers.
