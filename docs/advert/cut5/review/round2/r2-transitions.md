# Cut 5 r1: transitions review (r2)

Method: frame grids in `review5/g2/` (every frame at the joins) and measurements in `review5/work2/`. I built all evidence myself.
- No frame is faster than 150 px/frame; the maximum is 136, at the pull-back.
- The only low-detail frames are the accepted ones at the send (17.8) and the lockup's orb (76.7).
- The remaining frame spikes are all deliberate hard cuts or taps: 43.20, 43.80, 55.20, 56.80 and 34.20.

## Round 1 items

**M1. Saved card landing: fixed.** Only the poster flies, from a cover-fitted square at the input's left. The card body sits at its final position and its text never scales. The 26.3 spike (MAD 42–44) is gone (`a_saved_every_26.1`).

**M2. Acorn's text over the Team page: fixed, but a new flaw appeared.** The page swap happens inside the move at 57.60 and the text no longer overprints. However, the flying avatar is now drawn semi-transparent over Wren's card (see M2b below).

**M3. Habits → Penny: fixed.** There is a clean hard cut at 43.17→43.20 to the chips pose. The habit header never enters the frame, and there is no smear or blank frame (`c_habits_cut_every_43.0`).

**Hire stays tight: fixed.** Continue is pressed in close-up (54.0–54.1), "Reading the job…" holds for about 0.6 s, and Acorn appears on 55.20.

Nice-to-haves:
- **Still there:** the one-frame reflow after "Tell me" (now at 34.20), and the chip tap (43.80).
- **Skipped:** drawing the price step, as motion said.

## Verdict

**Ship, after one small fix.** Every round 1 must-fix is fixed. The one thing a viewer would still notice is the double face during Acorn's flight.

## Must-fix

**M2b. Acorn's avatar flies translucent across Wren (f1731–1736, 57.70–57.87).**
- The bunny is drawn at partial opacity and passes over Wren's face and text, so for 4–6 frames two faces are superimposed (`g_acorn_every_57.4`).
- At f1737 it lands about 25 px above its slot, overlapping the bottom edge of Wren's card, and settles by 58.00.

*Fix:*
- Draw the flying avatar at opacity 1, with the move's motion blur only and no fade.
- Route it in from the left of the column (x − 120 world units) instead of straight down through Wren's row.
- End the flight exactly on the `acornAvatar` rect at 57900 (lopP, 300 ms) so there is no settle.

## Nice-to-haves

1. **The money shot is smaller (48.2–49.0).** After the swap at 48.00 the camera pulls out to fit the title, so the step under "Your £28" takes up about a third of the frame. Push in to 1.25× on the chart rect over 48600–49400, keeping the title at the top edge.
2. **"Tell me" reflow (34.20).** Shift capB by the jump and slide it home over 300 ms.
3. **Team 1 header hold (31.7–32.5).** It holds about 0.8 s against the plan's 1.2 s. Move the tilt to Tracking from about 32500 to 32900.
4. **Acorn's line (55.70–56.80).** "Every Monday at 9:00, I'll tell you…" holds about 1.1 s. Start the 56800 swap at 56950.

## Protect

- The Habits → chips hard cut.
- The poster-only fly into the Saved card.
- The tight hire and Continue press.
- The silhouette becoming Acorn on 55.20.
- Working → done.
- Tracking → Music.
- The Team page hold (58.0–59.5).
- All of cut 4.
