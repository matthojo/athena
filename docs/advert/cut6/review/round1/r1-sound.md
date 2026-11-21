# Sound review, cut 6 r0 (86.4 s, acoustic rebuild)

Same method; the film's audio matches `mix.wav`. Cut 5 means the latest r2 mix in `film5/audio`.

## Does it meet the brief?

**Acoustic rather than synth: yes, on the spectral evidence.**
- **Tile note A4 at 3.0 s:**
  - Cut 6 has peaks at 442, 880, 2430 and 2763 Hz. 2763 = 6.27 × 440 is the kalimba tine's inharmonic mode; 880 is the glockenspiel double and 2430 = 2.76 × 880 its second bar mode.
  - The harmonic series at 3f and 4f (1320, 1760) is **absent**. Cut 5 has both, the signature of its pluck synth.
- **F#5 at 4.2 s:** the same picture, 4649 = 6.27f (tine) and 4085 = 2.76 × 2f (glockenspiel).
- **No saw or square series anywhere:** the only full harmonic series is the reed organ, rolled off above 1.3 kHz.
- **Noise components are present** (nail ticks, felt thumps, organ wind), and every voice in `music.py` calls an audiolib model.

**Softer: yes.**
- −15.4 vs −14.4 LUFS integrated.
- Music limiter 1.4% of samples, max 4.3 dB (cut 5: 9.7%). Mix limiter 1.1%, max 3.3 dB.
- Onsets 5.0/s vs 6.3/s; crest factor +0.9 dB.
- 2–4 kHz 3.9 dB down vs cut 5 (relative to the loudest band: −7 vs −3).

**Cuter: plausibly.** The hook is kalimba with a glockenspiel an octave up (melody now A5–D7). The notes are short struck bars, and the voices rounder.

**Sync: intact.**
- All 32 taps are 0 ms from their press events.
- Whooshes peak on every camera move of 12 px/frame or more.
- All 27 swap ticks land on the phrase-change frame (≤17 ms).
- Flows: "Make it a flow" (61.74 → page at 61.80), the steps arrive with the kalimba landing (62.2–62.47), and the toggle flips at 63.67.

## The verify changes

- **Median baseline: acceptable** (a ringing bed does ripple ±6 dB in 2 ms).
- **Match threshold 0.3 → 0.5: too loose.** At 0.5 a cue that slips onto a same-pitch note passes; I found no slips this time. Use 0.4 now that the template is 40 ms.
- **The real hole:** `before` (line ~291) excludes the opening. That hides must-fix 1, which verify reports as "arrival is a clear third".

## Must-fix

**1. The opening tile run is the second-loudest moment of the film.** It peaks at −9.1 LUFS momentary at 5.3 s, over the step-down (−9.2) and the arrival (−9.5).
*Fix:*
- `music.py`, tile run gain `0.62 + 0.04 * j` → `0.40 + 0.03 * j`. Target −11.5 or quieter.
- `verify_audio.py`: add `"tiles"` and `"dive"` to the `before` set.

**2. The Saved drop is the fifth-loudest moment** (26.4 s, −10.5, above the pull-back's −11.5). The wooden `drop` at gain 5 sits +11.3 dB full band over the bed.
*Fix:* `cues.py` drop gain 5 → 0.

**3. The taps undercut "softer".** The glass and wood taps sit **+20 to +28 dB** over the darker bed in 2–8 kHz: 17.34 +25.9, 53.94 +25.5, 70.76 +28.4. (cut 5: +7 to +16).
*Fix:* in `cues.py`'s press loop, change `g = 4 / 6 / 8` to `0 / 1 / 2` (−6 dB). Target +15 dB or less in 2–8 kHz.

## Nice-to-haves

1. **Pull-back:** it lands about eighth (−11.5). Raise `PULL_LIFT_DB` 1.5 → 3 so it sits under the arrival and over the sections.
2. **Flows:**
   - `pop2` fires at 60.00, but the card only resolves at 60.33–60.47. Move it to 60.45, on the 16th.
   - `flowstep1` at 62.7 is −14.2 dB in 2–8 kHz, effectively silent. Gain 4 → 12, or cut it.
3. **Section whooshes** are now −7 to +1 dB in 2–8 kHz (team-music 35.83 is −6.6). Raise the moves at 23.8 and 35.8 to +4.
4. **Brightness for phones:** −3.9 dB at 2–4 kHz vs cut 5. Get 1–2 dB back with the 2.8 kHz bell.

## Verdict

The timbre rebuild works: it reads acoustic, softer and cuter on every measure I have, and sync is intact. **Don't ship until must-fixes 1–3 are in**, because the loudness ranking is broken at the opening and at the Saved drop, and the taps work against "softer". Three gain changes, a verify fix and a re-render.
