# Cut 4 round 2: transitions (r2)

Method: as in r1, re-measured on the new frames. Grids are in `review4/r2/` and the measurements in `review4/work2/`. The isolated-spike detector (MAD > 2.5× the frames around it) now finds **no** spikes. In r1 it found three.

## Round 1 issues

1. **Sub-frame double exposures: fixed.** The `capMs` change worked. At 31.3–31.6 the vertical shift that used to jump −150 px/frame is gone, and the Team scroll finishes off-screen. The double exposures that remain now come from deliberate cross-blends (new #1).
2. **Ask answer crop: fixed.** The left margin is clean and the last line is whole, from 20.0 to 23.4 (`r2_ask_hold_19.5`).
3. **Penny one-frame swap: better, still visible.** It is now a 5-frame cross-fade (33.73–33.90). The two titles, "The moka pot is down to £34", sit about 25 px apart, so they read as a double image (`r2_penny_tap_every_33.67`). The pointer now lifts after the press, which is fixed.
4. **Music grow pop: fixed.** A maroon tile grows into the sheet over 37.83–38.10, with no white flash and no MAD spike (`r2_music_36.9`). The "Open in Spotify" press reads.
5. **Blank frames after send: still there, and worse.** f522–528 (17.40–17.57) are pure white, with edge energy 0.35 against 0.4 in v1. They now sit inside the film's fifth-fastest move, ask-steps, at 73 px/frame. The question bubble only appears at 17.77 (`r2_ask_blank_every_17.25`).
6. **Saved→Watch & read: different, not better.** The 3-frame stacked glitch has become a 10-frame dissolve of two whole pages (29.53–29.87). A faded second copy of the cover also sits in the slot while the poster flies, which the brief says must never happen (`r2_watch_every_29.55`).
7. **The pointer parking: better.** It parks for at most about 0.6 s now (39.9–40.5).
8. **Bare middle of the dive: better.** The tiles and orb are flung out of frame. Only 3 frames dip low (8.03–8.10, edge energy 1.35).
9. **Lockup: better.** There is no near-blank frame, and the wordmark wipes out from behind the orb. But the reveal starts at 59.87, while the card is still at about 40%. So "Ath…" overprints "THIS EVENING · MONDAY", and the orb covers the "A" until 60.13 (`r2_lockup_59.4`).

## New or remaining issues, worst first

**1. Cross-dissolves between misaligned text layouts (four places).**
- 32.07–32.27: Penny's card is overprinted with "TRAVELLING TODAY / Heathrow Express". MAD reaches 17 with dy −92 (`r2_team_tilt_every_32.0`).
- 33.73–33.90: the Penny tap.
- 29.53–29.87: the Watch & read page.
- 19.23–19.30: the `covers` blend at frames 276–280 shows "Found 4 matches" behind "Elena wants to keep", and two orbs.

*Fix:* never mix two layouts at partial opacity.
- When the camera is moving above 25 px/frame, swap the layout on the move's fastest frame: `mix = t >= tPeak ? 1 : 0`. The blur hides the swap.
- Otherwise carry the content. Align `fromB` on the title baseline (Penny), and use a lopP clip-grow with no fade of the page (Watch & read). For 32.07, put the scroll and the card's arrival in one carried move.
- Draw the slot as the page background colour, not a faded cover.

**2. Whip into white after send (17.40–17.57).**
*Fix:*
- Add a `MAP.ask` key at send+1 frame that jumps straight to the first capture frame with the question bubble, so the route-change blanks are skipped.
- Fly the question: `fly` from `input` to `question`, 520 ms, lopP. Start `ask-steps` 150 ms later with a=500, so the camera rides the bubble instead of crossing empty card.

**3. Lockup overprint (59.87–60.13).**
*Fix:*
- Start the wordmark clip at 60000, once the card's opacity is below 0.1.
- Put the clip's left edge at the orb's centre x plus its radius, and draw the orb above the wordmark.
- Let the card drop (+60 y, inCubic, 59500–59950) rather than fading in place.

**4. Penny's reply holds about 0.9 s, not ≥1200 ms.** It is complete at 34.97, and `team-music` is already at 26 px/frame by 35.6.
*Fix:* start `team-music` at 35500, with a=800.

**5. Minor:** Lapvona stays fully opaque beside the card→page grow (27.7–27.95); fade it out over 120 ms.

**Protect:** the pull-back (62% of the reveal by 43.2), the "good days" lift, Ask→Saved, the music grow and the Habits push all hold up.

## Verdict

**Not ship-ready yet, but close.** The camera itself is now at a standard I'd ship. The curves, pacing, pointer, blur, pull-back and music grow all hold up frame by frame. What still reads as amateur is the four soft double-image dissolves and the white whip after send. Together they are about 27 frames.

**The single change that would lift it most:** a compositor rule that two layouts are never blended at partial opacity. Swap at the move's peak frame inside the blur, or carry the object. That one rule clears issues #1 and #3 and most of #2.
