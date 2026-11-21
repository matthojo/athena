# Sound review, cut 4 (r1)

How I measured: the film's audio matches `mix.wav` (lag 0). I rebuilt each cue from the sfx files × its gain × the master gain and compared it with the music in 2–8 kHz. Motion is from `camspeed.json` plus frame differences, and every sync claim was checked on frame grids. Work files are in `review4/sound_work/`.

## Cut 3's issues

| # | Status | Evidence |
|---|---|---|
| 1 Buried | **Mostly fixed** | Camera whooshes are +2 to +21 dB over the music, the 42.0 tick +2.5, the Ask keys +3.4. Still buried: the pops (−17 to −34), `answer` (−1.8), `penny_reply` (−4.9). |
| 2 Early whooshes | **Fixed** | Each peaks within 0 ms of its move's fastest frame (two sit on the wrong move: issues 2 and 5). |
| 3 Ticks | **Fixed** | All 33 land on the phrase-change frame (≤17 ms) and on the grid. |
| 4 Payoff | **Fixed** | Build peak −11.0 LUFS momentary; chord −8.2, the loudest moment. |
| 5 Flat | **Better** | The dropout and the Home/Ask trim work. New sag: issue 6. |
| 6 Dull | **Better** | 2–4 / 4–8 kHz now −11 / −16 dB (were −18 / −24). The reference is −4 / −7. |
| 7, 8 | **Fixed** | The dive whoosh peaks with the camera. The 56.4 silence holds −31 LUFS with one soft whoosh. |

These work: the pull-back (whoosh peaks at 42.87 inside the dropout, crash at 43.2 as the wall resolves), every tap on its press frame, and "Great" darkening at 57.600 with the chord.

## New issues, worst first

**1. Penny's voice plays before her card shows (31.35).** The card enters at 31.50, is readable at 31.70 and settles at about 32.0. The voice rides the tail of the 31.03 whoosh while the frame still shows the train timeline.
*Fix (`cues.py`):* `add("penny", on_grid(ev("team","scrollEnd")), 4)`, which puts it at 31.80, beat 2 of the muted bar.

**2. Her reply is masked, and its whoosh sits on the wrong move (34.43/34.45).** The reply measures −4.9 dB in 2–8 kHz, lands 20 ms after a whoosh, and comes after the hook has returned. The real move, the open at 33.6–34.1 (42 px/frame, fastest at 33.87), has no whoosh.
*Fix:* move that whoosh to 33.70 at −2. Put `penny_reply` at 34.50 at **+5**.

**3. The poster lands in Watch & read silently (≈30.1).** `cues.py` reads `morph.saved.fly1.end` (28.24), which fails `> t_move + 0.3`, so no `drop` is placed.
*Fix:* read `morph.saved.fly3.end` and put `drop` at 30.15 at +1. Raise the 29.53 whoosh from −2 to +2. Swap the buried "Filed" `pop` at 28.86 (−25 dB) for `tick` at −2.

**4. The film card's `drop` is 350 ms late (26.60).** The card fades in at 26.23–26.30, and the camera is leaving by 26.6.
*Fix:* put it at 26.25 (`saved.posterLoaded`).

**5. Ask: three swishes on one slow pan.** One camera peak (18.33), but whooshes at 18.16 and 18.76, plus the music's swoosh from 18.6 into the lift. `answer` (19.2) is masked by the lift hit.
*Fix:* skip a motion peak within 0.8 s of the previous one, which drops 18.763. Delete `answer`.

**6. The rotation opens in a hole (48.0–53.2).** Momentary levels run −16 to −20 LUFS, with −25.3 at 51.2. The build (−19.5) starts quieter than the drop bar before it (−15.3). The day's six phrases play over a near-empty bed, and the rise begins only at 53.2.
*Fix (`music.py` build):*
- bpad envelope `0.25+0.75*x**1.5` → `0.5+0.5*x`
- shaker `0.5+0.08*b` → `0.8+0.05*b`
- bass `0.34+0.032*b` → `0.45+0.03*b`
- kick `0.45+0.025*b` → `0.6+0.015*b`

Target −15 LUFS or louder from 50.4.

**7. Dead air at the start (0–2.4).** It measures −67 to −57 LUFS, then −40 after the orb. Bar 0 has no music, while the reference sits at −15 to −22 from 0.4 s.
*Fix:* a D pad swell from 0.3 s at −30 dBFS RMS, or the hook pickup on the orb at 1.2.

**8. Still dark.** *Fix:* the high shelf at 4500 Hz from +5.5 to +8, the 2800 Hz bell from +4 to +6, the 140 Hz low cut from −3 to −5.

**9. The orb-morph whoosh (59.5) can't be heard** (−23 dB). Delete the `orb` rule. The tag at 59.4 already carries the morph.

**10. Small items.**
- The closing keys start at 48.0, but typing shows from 47.93. Use `keys(47.9, 48.56, 10)`.
- The opening tile `pop`s are buried (−27 to −34 dB) and the music's tile notes already carry them, so cut them.
- The chord jumps 29 LU out of the silence. Consider `CHORD_DB` −5.5.

No clicks: every high-frequency spike in the film is a designed press or key.
