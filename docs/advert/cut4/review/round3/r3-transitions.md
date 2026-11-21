# Cut 4 round 3: transitions (r3, final)

Method: as before, re-measured on cut4-r2. Grids are in `review4/r3/` and the measurements in `review4/work3/`. I rebuilt every grid myself; the motion team's grids were not used as evidence.

## Round 2 issues

1. **Cross-dissolves between misaligned layouts: fixed at all four places.**
   - 19.27→19.30 is a clean swap at 26 px/frame (`r3_ans_every_19.1`).
   - 29.5 is a hard-edged clip-wipe, and the slot is now page background, so there is no second poster (`r3_watch_29.4`).
   - 32.07 swaps inside the move.
   - 33.70→33.80 is a hard cut to the thread with the pointer continuous across it (`r3_team_tap_33.2`).
2. **Fast move into white after send: fixed.** The question bubble flies up and the camera rides it (f522–539). The low-edge frames, 17.77–17.83 at 1.25, all still show the bubble (`r3_send_every_17.2`).
3. **Lockup overprint: fixed.** The orb lands alone for 2 frames (59.93), then "Athena" slides out from behind it, with the orb drawn on top, 60.00–60.20 (`r3_lockup_every_59.6`).
4. **Penny's reply hold: better.** It is complete at 34.63 and the camera leaves at about 35.70, so it holds about 1.1 s against a 1.3 s target. That's acceptable.
5. **Lapvona beside the card grow: fixed.** It fades out by 27.77 (`r3_cardpage_27.7`).

Also confirmed:
- Habits: the tick lands at 41.7 and "21 in a row" holds for about 1 s before the pull-back.
- Home: the frame is tight from 9.0 on.
- The pull-back, the "good days" lift and the music grow are unchanged.
- The automatic detector finds only two spikes, at 17.40 and 26.27, and both are deliberate taps.

## Verdict

**Ship, after one fix.** Every transition the reviews flagged is now either clean or deliberate.

## Must-fix

**M1. The Team move into Penny's card is the most violent motion in the film (f961–f975, 32.03–32.50).**
- The camera goes from 7 to 339 px/frame in 6 frames. That is 18% of the frame width per frame: 1.7× the pull-back (201 px/frame) and about twice the reference ad's fastest move.
- It is spent on 13 frames of vertical smear through unreadable Home rows. The motion blur shows about 8 separate steps on the text (`r3_team_whip_every_32.0`).
- A viewer will read it as a glitch, not a whip.

*Fix:* replace the vertical move with a hard cut on the beat at 32400, from the chip strip to the camera pose framed on Penny's card. Keep the pointer continuous in screen space; the reference does exactly this.

If a move is required instead:
- Spread it over 900 ms (a=350, b=550).
- Cap it at about 150 px/frame.
- Start it at 31950 so it does not begin from a near-rest at 7 px/frame.

## Nice-to-haves

1. **Saved card lands as a one-frame pop (f787→788, 26.23→26.27, MAD 13.3, camera at 7 px/frame).** Grow the new card out of the paste field: a `fly` from `sIn` to `newCard`, 260 ms, outCubic, with the list shifting under it.
2. **Watch & read wipe (29.53–29.63).** The Films band shows sandwiched between the old banner and the "Filed in" row. Fade the old page under the clip over p 0–0.3.
3. **Stray press ripple at 33.80–33.90.** It sits on "Penny · Thinking…" in the thread. Drop the ripple, or move the send press onto the composer.
4. **Top edge at 9.67–11.4.** Half of the Ask send button sits at the edge and the chip strip fades in there. Lower the Home pose's y by about 20 world units.
