# Sound review, cut 5 r0 (79.2 s)

How I measured: same method as cut 4. The film's audio matches `mix.wav` (lag 0), and sync was checked on frame grids. To see the limiter, I re-rendered `music.py` into scratch (bit-identical) and dumped the bus before the master. Work files are in `review5/w/`.

## What's right

- **Sync:** all 23 camera moves have a whoosh peaking on their fastest frame, and all 30 taps land on their press frame.
- **Team 1:** the taps hit "Tell me when" (31.80) and "At or under" (32.40). The keys type "£28" (33.0–33.23). `set` fires with the "£28 or less" pill (33.60, +10.7 dB over the music in 2–8 kHz).
- **Team 2:** Penny's voice at 44.40 comes with "Penny is searching…". `stepdown` lands on the cut to "£27 at Fenn & Hale" (f1441), and `reached` follows at 48.3 (+3.1 dB in 2–8 kHz).
- **Team 3:** the keys follow the typed job. Acorn cuts in at 55.20 and `hello` plays at 55.35.
- **Brightness is fixed:** 2–4 / 4–8 kHz at −3 / −9 dB from the loudest band (the reference is −4 / −7).
- **Clean:** no clicks, and every new sfx starts and ends at silence. Mix −14.0 LUFS, −1.2 dBTP.

## The big moments (max momentary)

| Moment | LUFS |
|---|---|
| **Logo tag 74.1** | **−6.9** |
| Great chord | −7.5 |
| Step-down 48.5 | −8.8 |
| Pull-back 60.2 / build end | −9.8 |
| Team 1 set 33.8 | −10.2 |
| **Arrival 55.4** | **−10.5** |

The step-down is second, as intended. The arrival comes about eighth, not third. Over 3 s windows it is −12.8 LUFS, under the step-down (−11.1), the pull-back (−11.5) and the build (−10.6).

## Must-fix

**1. The logo tag is louder than the Great chord.** It reaches −6.9 against the chord's −7.5 LUFS momentary. A6 and D7 sit in the presence bell and the +8 dB air shelf.
*Fix:* in `music.py` `final_chord()`, change the tag gains `0.20, 0.17` → `0.11, 0.09`. Target: the tag at −9 LUFS momentary or quieter.

**2. The arrival (55.2) is under-scored:** −10.5 momentary, level with a Team 1 tap.
*Fix (`music.py`):*
- `peak_target["warm"]` −9 → −6.5.
- Add `(ARRIVE, 0.5)` to the crash list beside `(STEP, 0.6)`.
- Add `k(ARRIVE, 0.9)`.

Target: about −9.5 LUFS momentary.

**3. The limiter crushes the 48.0 hit.** The music master cuts 7.2 dB for about 75 ms (7.2/6.4/4.0 dB in 25 ms steps), so the second-biggest hit loses its attack. Across the film the limiter acts on 11.1% of samples (cut 3: 3.5%). The cause at 48.0 is a stack on one sample: the crash, `ep_chord` at 0.55, two bells at 0.4, the kick and the hook downbeat.
*Fix:* strum the STEP accent:
- `ep_chord` gain 0.55 → 0.4.
- Bells at `STEP + 0.03` and `STEP + 0.06`, gain 0.3.

Target: master gain reduction at 48.0 of 3 dB or less.

**4. The face blips are 17 dB apart.** In 2–8 kHz: face1 +0.3, face2 +13.4, face3 −3.5 dB over the music.
*Fix:* `cues.py` gains `(2, 8, 1)` → `(7, 0, 9)`, about +5 dB each.

## Nice-to-haves

1. **Too forward:**
   - The Team 1 tap at 33.54 is +18.8 dB full band over a sparse bar. Change `tap()` gain in Team 1 from 11 to 6.
   - The hire keys are +10.6 dB in 2–8 kHz for 1.8 s. Change their gain from 6 to 1.
2. **The chord is limited 3.5–5.4 dB for its first 2 s.** `CHORD_DB` −4.5 → −6.5 gives the strum back. The pull-back hit at 57.6 takes 5.9 dB too: crash 1.0 → 0.7.
3. **`reached`** gain +4 → +7.
4. **The search figure** starts on the 43.2 whip, 1.2 s before Penny's line. It is quiet (−18 to −21 LUFS) and acceptable. To tie it to her line, start the `search` style at 44.4.
5. **The face blips play over a shot of Acorn alone:** the team first shows at 57.6.

## Verdict

Not yet. Sync and tone are ship-quality. Must-fix 1–4 are about 15 minutes of gain and timing changes plus a re-render. With them in, I'd ship.
