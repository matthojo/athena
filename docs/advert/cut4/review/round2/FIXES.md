# Cut 4, round 2: what changes

Reviews of cut4-r1 are beside this file. All three say "close"; these are the fixes that get it
over the line. Timeline stays 64.8 s.

## Sample data (done)
- Penny's reply: "Yes. £34 is the lowest it's been since you saved it. Good time to buy."

## Capture
- Re-shoot `team` only (new reply copy) into film4/cap-r2 (a full copy of cap-r1 with team replaced).

## Motion
1. Rule: never blend two misaligned layouts at partial opacity. Above ~25 px/frame swap on the
   move's fastest frame; otherwise carry the object (title-aligned clip-grow, no page fade). Applies at
   32.07–32.27 (Penny card over Home), 33.73–33.90 (Penny tap), 29.53–29.87 (Watch & read page, and
   no second copy of the poster: draw the slot in the page background), 19.23–19.30 (`covers` blend).
2. No white after send (17.40–17.57): fly the question bubble from the input to its place and let the
   camera ride it (r2-transitions.md #2).
3. Habit payoff: tick at ~41700 so "21 in a row" holds ≥700 ms before the pull-back (43200 stays).
   Keep the habit header ("…is on a run of 20 days") out of frame.
4. Team: pointer goes to Penny's chip in the strip (no fake press: the app focuses Ask when it's tapped),
   then her card; drop the detail screen if it's only a cross-fade; reply holds ≥1300 ms; Home's
   scroll fully done before her card shows (no train card ghost). Keep the Home greeting out of frame.
5. Home opens on the tight crop (no flight rows at 8.4–11.2).
6. Spotify press readable: push in ~1.5× at 39200–39900.
7. Lockup: no overprint; card drops away first, wordmark reveal from 60000 starting right of the orb,
   orb drawn above the wordmark.
8. Lapvona fades out beside the Saved card grow; crop out the "Good afternoon" column at 28.4–29.6.
9. Protect: pull-back, good-days lift, Ask→Saved, music grow, Habits push, poster flight.

## Sound
1. `sfx.chip()` on `home.lateChip` (11.40).
2. Whoosh gain by speed (≥50 px/frame +4, ≥25 0, else −2).
3. Drops audible on a phone (click 0.6, LPF 5 kHz); poster drop on its real landing frame at +3; a
   whoosh for the poster's flight.
4. Bass −2 dB, kick −1.5 dB targets (brighter after the master).
5. Build ride wider so the build ends above the pull-back.
6. Optional: three face blips as the Penny/Dot/Wren chips show.
Re-sync to the new motion data at the end.
