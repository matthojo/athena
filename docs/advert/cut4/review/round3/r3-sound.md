# Sound review, cut 4 round 3 (`cut4-r2.mp4`, final)

Same method: the film's audio matches `mix.wav` (lag 0), frames are re-rendered, and grids are in `sound_work/r3_*.jpg`.

## Round 2 issues

| # | Status | Numbers |
|---|---|---|
| 1 Chip silent | **Fixed** | `chip` at 11.40; the chip changes at f342 (11.40). +9.0 dB full band. |
| 2 Send whip | **Fixed** | +4 dB, peaks on the camera's peak (17.767), +17.5 dB in 2–8 kHz. |
| 3 Drops | **Fixed** | Card drop +1.4 dB in 2–8 kHz (was −13). The poster's `land` at 30.00 hits as it settles (30.00–30.07), level with the music. |
| 4 Dark | **Better** | −7 / −12 dB in 2–4 / 4–8 kHz (were −9 / −14). The reference is −4 / −7. |
| 5 Flat build | **Resolved by decision** | It climbs from −15.5 to −10.8 LUFS, above the pull-back (−12.2) and under the chord (−9.4). |
| 6 Face blips | **Added, loosely tied** | See nice-to-haves. |

## Sync on the re-cut picture

- **Whooshes:** each of the 17 camera peaks of 12 px/frame or more has a whoosh that peaks on that exact frame, including the 339 px/frame Team whip (32.233).
- **Penny:** her voice at 32.55 lands as the whip ends and the card turns sharp (f977). Her reply at 34.05 comes with "Checked prices". Both are audible in 2–8 kHz (+11 and +1 dB over the music).
- **Taps:** every tap is on its press frame (11.40, 26.17, 37.77, 39.56, the habit tick at 41.70). "Great" lands at 57.600 with the chord.
- **Swap ticks:** all 33 start on the frame where the phrase changes (within 17 ms).
- **Dead cut:** −27 / −38 LUFS.
- **Clean:** no clicks, and every new sound starts and ends at silence. The mix is −14.03 LUFS with a −1.36 dBTP true peak.

## Verdict: ship

**Must-fix:** none.

## Nice-to-haves

1. **Brightness for phone speakers:** the mix is still 3–5 dB darker than the reference. In `music.py`, `rms_target["bass"]` −19.5 → −21, or the 2800 Hz bell +6 → +7.5.
2. **The face blips match nothing on screen:** the chips are static from 31.5, and face2 measures −15.9 dB in 2–8 kHz. Cut them, or start them when the camera settles (`on_grid(team.chips + 0.3)`) at 0 dB.
3. **The poster's flight (29.4–30.0) has no whoosh:** add `whoosh` at 29.45 at −4.
4. **The opening still has −45 LUFS at 0.4–0.8 s:** start the pad at 0.1 s.
5. **`land` +5 → +7** if phone tests show the poster landing gets lost.
