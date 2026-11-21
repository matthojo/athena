# Sound review, cut 5 round 2 (`cut5-r1.mp4`)

Same method: the film's audio matches `mix.wav` (lag 0), and sync was checked on frame grids (`review5/w/q*.jpg`).

## Round 1 items

| Item | Status | Numbers |
|---|---|---|
| Tag over chord | **Fixed** | Tag −11.6, chord −7.2 LUFS momentary |
| Arrival third | **Better, still tied** | −9.7 (was −10.5); habits −9.5, wall and build end −9.6. Over 3 s it is the quietest big moment (−12.7). |
| 48.0 limiting | **Fixed** | 7.2 → 1.7 dB; step-down a clear second (−8.1) |
| Face blips | **Fixed on mono** | +5.0 each by `band_db` (mono). In stereo power +4.2 / +6.3 / −3.6, because the bed at 58.5 is mostly side reverb. |
| Taps, keys, `reached` | **Fixed** | Taps +0.8 full band, hire keys +5.5, `reached` +4.5 dB in 2–8 kHz |
| Chord / pull-back limiting | **Still there** | 4.2 / 5.7 dB. The 60.0 hit (−11.1) is quieter than the wall 2.6 s later (−9.6). |

No clicks, and brightness holds (−3 / −9 dB at 2–4 / 4–8 kHz).

## Sync on the re-cut picture

- **Whooshes:** 24 of 27 camera peaks have a whoosh within one frame. The three without are deliberate: a slow drift, the 0.8 s spacing rule, and the wall's plateau.
- **Taps:** all 13 from 29 s onward land on their press frame.
- **Team cues:**
  - The keys type "£28".
  - `set` fires as the pill appears (34.2).
  - The `cut_accent` falls on the 43.2 hard cut, and Penny's voice comes with her line (43.8).
  - The step-down lands on "£27" (48.00).
  - `hello` (55.40) plays with "Hi, I'm Acorn" (f1663).

## Verdict: ship after must-fix 1

**Must-fix 1: make the arrival a clear third.** The limiter takes nothing at ARRIVE, so there is headroom.
- `peak_target["warm"]` −6.5 → −5.
- The crash at `ARRIVE` 0.5 → 0.8.
- `hello` gain 7 → 9. It is only +3.5 dB in 2–8 kHz.
- `set` gain 5 → 1. At −9.9 momentary it competes with the arrival.

Target: the arrival at about −8.8, at least 0.7 LU over everything except the step-down and the chord. Add that check to `verify_audio.py`.

## Nice-to-haves

1. **Pull-back:** crash 1.0 → 0.7 and kick at PULL ×0.8, for limiting of 3 dB or less there.
2. **Face blips:** three blips play over two static faces. Use two: one on Acorn's landing at 58.06, one a 16th later. Measure `over` as the max of L and R, not the mono sum.
3. **`cut_accent`** is −10.3 dB full band. That works as a breath; raise it to +4 if a beat is wanted.
