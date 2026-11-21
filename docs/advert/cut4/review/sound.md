# Sound review: Athena launch film v3

How this was measured: film audio matches `mix.wav` to the sample. The effects level is `mix − music`, which is exact (bus gain 1.000, residual −109 dB where no cues play). Motion is the per-frame mean absolute difference from the video. Stems were rebuilt in memory, and no files were written. Plots: `sound-loudness.png`, `sound-motion-vs-cues.png`, `sound-spectrogram-build.png`, `sound-spectrogram-full.png`. Scripts are in `sound_work/`.

## Issues, worst first

**1. The interface sounds are buried, so 12–52 s has almost no sound joining the shots.** The music alone measures −14.02 LUFS and the mix −14.00, so the effects add nothing measurable. Cues peak 10–20 dB under the music in their own window. In 2–8 kHz, the whooshes sit 6–10 dB under, the habit tick (42.0) 14 dB under and the Saved typing 11 dB under. The changes at 18.0, 34.8, 40.8 and 44.4 have no audible sound. Only the music's own swoosh-and-crash markers (12.0, 23.4, 28.8, 48.0) carry a change.
*Fix:* `mix.py` `MUSIC_TRIM_DB = -3`. In `cues.py`: whoosh −5 → +1, tick at 42.0 → +4, drop → +2, press → +3, Saved keys −7 → −2 (or add 29.1–31.8 to `thin()`). In `sfx.whoosh`, move the centre from 600+2300 Hz to 1500+4000 Hz, above the hook and electric piano.

**2. The whooshes come 0.3–0.9 s early.** `cues.py` places each at shot − 0.6 s, but the moves are fastest at or just after the shot start.

| Whoosh (peak) | Move's fastest point | New onset |
|---|---|---|
| 17.40 (17.57) | 17.87 | 17.70 |
| 28.20 (28.37) | 28.83 | 28.66 |
| 34.20 (34.37) | 34.80 | 34.63 |
| 35.40 at −9 dB (35.57) | 36.27, the film's biggest motion | 36.10 at 0 dB |
| 40.20 (40.37) | 40.77 | 40.60 |
| **43.90 (44.07)** | 44.97; the move runs 44.57–45.40, after the whoosh has ended | **44.80** |
| 9.45 (9.62) | 10.80, the dive | add 10.63 |

The 52.65 whoosh is right (+20 ms). Rule: onset = the move's fastest point − 0.17 s. Better: add a symmetric 0.8 s whoosh to `sfx.py` that peaks at 0.4 s.

**3. In the rotation, the ticks fight the grid (55.2–61.2).** The ticks follow `swaps.json` exactly, but 27 of 38 swaps are more than 25 ms off the 16th-note grid (mean 37 ms), so they flam against the straight 16th shakers and the kick roll. From 58.0 the gaps alternate 100 and 133 ms (3 and 4 frames). The speed-up stops 3.2 s before the cut and leaves a lopsided gallop (zoomed panel of `sound-spectrogram-build.png`).
*Fix:* re-time `swaps.json` on musical steps (38 slots, so the copy is unchanged):
- quarter notes at 55.2 and 55.8
- 8th-note triplets from 56.4 to 57.4 (200 ms)
- 16ths from 57.6 to 59.25 (150 ms)
- 16th triplets from 59.4 to 61.1 (100 ms, exactly 3 frames)

The picture rounds to a frame (within 17 ms) and the audio stays exact. Put the last 3 beats' shaker and kick roll on `BEAT/6`.

**4. The build's last 2 s are the loudest part of the film, and the payoff is quieter.** They average −10.8 LUFS momentary. The pull-back averages −12.4, and the final chord −16.5 (62.4–64.8). The limiter acts on 3.5% of blocks. The cause is the kick roll, 5 dB hotter than in the body (−14.4 vs −19.6 dBFS RMS): 0.36 s kicks stacked every 150 ms over 16th bass notes. The 250 Hz–1 kHz range is scooped by 13–16 dB, so the build is thumpy rather than bright.
*Fix:* in the `climb` loop, kick gain flat `0.68` and roll hits `×0.6`. Raise `peak_target["build"]` from −13 to −10. Aim for a momentary level of −12.5 LUFS or below. In `final_chord()`: bus `db(-4.5)` (was −7.5), sparkle 0.2 (was 0.11), sub 0.6 (was 0.42).

**5. The level barely changes, and the "biggest" section isn't bigger.** From 12 to 52.8 s it stays within 1.7 LU, and the pull-back equals Health (−12.4). The reference has three breakdowns (16.5, 26.5, 35.4 s) and comes back about 3 LU louder after the last.
*Fix:* make 46.8–47.4 a one-beat dropout (hook only) and trim 12–28.8 by −1.5 dB.

**6. The mix is dull for phone speakers.** Relative to the loudest band, 2–4 kHz is at −18 dB and 4–8 kHz at −24 dB. The reference is at −4 and −7. Our loudest band is 60–120 Hz, which a phone cannot play.
*Fix:* start the hats at `LEVEL>=3`. Raise the hat and shaker `peak_target` from −17.5 to −14. Add a +4 dB shelf above 5 kHz before `master()`.

**7. The dive's riser peaks over a still frame.** The camera lands at about 11.2, but the riser and crash peak at 12.0. Add the whoosh at 10.63 and shorten the 12.0 swoosh to 0.6 s, or have the picture land at 12.0.

**8. The silence at 61.2 works but is cluttered.** 61.8–62.4 is at −64 dBFS, which is good. The pop and whoosh at 61.2 (−16 dBFS peak) sit on the cut and soften it. Drop the pop. Move the whoosh to 61.30 at −12 dB (the card rises fastest at 61.47).

These are fine: there are no clicks, grid hits are within ±3 ms, the chord lands at 62.40 with the press, and the tempo matches the reference (100 BPM, 5.7 onsets/s).

## Cut 4: "Team" beat
Make it **4.8 or 7.2 s**. A 6 s section is 2.5 bars and would push every later downbeat, including 61.2 and 62.4, off the bar.

Sound idea: give each character a tiny voice. In `sfx.py`, put a pentatonic pulse through two vowel formants (oo 300/870, ah 730/1090, ee 270/2290 Hz), 180 ms long with a +2 semitone upward scoop. The characters pop in one per beat, echoing the tile pops, then hum a three-part chord together on the next downbeat. The music sits at `LEVEL 5` with the hook muted, and a rim fill hands back to the groove.
