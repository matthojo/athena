# Cut 4 transitions review (r1)

Method: dense grids in this folder (`g*.jpg`, `s_*.jpg`), every 2 frames over ±1.2 s, and every frame at the morphs. Per-frame MAD, phase-correlation shift and edge energy are in `work/`, checked against `camspeed.json`. Frame N = N/30 s.

## (a) Cut 3 issues

1. **Stop, whip, stop: fixed.** Moves are lopsided now (13.6→14.4→15.8), holds drift at 1–3 px/frame, and blur is on. The blur double-exposes (new #1).
2. **Dead dive, then a slam: fixed.** The dive rises smoothly to 81 px/frame at 8.17. Its middle is empty (#8).
3. **Pull-back: fixed.** 63% of the reveal lands by 43.2 and 81% by 43.5, and the drift that follows has a mean MAD of 1.5.
4. **Music scroll and pop: the scroll is fixed, the pop is better but still there (#4).** The fast capture scroll has moved to the Team landing (#1).
5. **Dragged pointer: mostly fixed.** It leads at 14.4, 24.0 and 36.0, and it stretches. It still parks at 31.2 and 40.8 (#7).
6. **Ask zoom pumping: fixed.** The push is now a single one, but it crops the text (#2).
7. **Finale: the lift is fixed, the lockup is better (#9).**
8. **Wall exit: fixed.** It now takes about 600 ms, column by column, and overlaps the type-on.

## (b) New issues, worst first

**1. Double exposures when the app changes during a move (19.17–19.27, 27.73–27.93, 31.33–31.60, 37.83).**
- f576–577 show two or three orbs and two step lists (`g03c`, `s_ask_f552_f576.jpg`).
- f940–948 show "For you / For you", and the phase shift is dy −144 to −196 px/frame during a sideways pan (`g06_team_31.2`).
- Cause: `render.cjs` re-seeks each blur sub-sample (±8.3 ms), so on stretched maps each sample shows a different capture frame.

*Fix:* use `seek(ms, {capMs: job.ms})`. The capture frame is then picked once per output frame, while the camera, pointer and morphs still use `ms`. Also start `MAP.team` with `[[L("team",30300), ss], [L("team",30900), se, "stretch"]]`, so the Home scroll is finished before that card enters frame (about 31.0).

**2. The Ask answer is cropped for 3 s (20.4–23.4).**
- The bottom edge cuts "your to-do list 3 If you'd rather talk it" in half throughout.
- From 21.8 the left edge eats letters: "lena", "ettling", "ustomers" (`g03b`, `g04`).
- Cause: `zA` is set from `0.95W/at.w`, and then `drift(20300,23400,1.05,8,3)` pushes the text past the frame.

*Fix:* `zA = min(0.6H/af.h, 0.86W/at.w)` and `drift(…,1.02,0,2)`. Set the pose's y so the bottom edge falls in a line gap: y1 = at.y + n·lineH + 0.4·lineH.

**3. Penny's "Ask about it" tap swaps in one frame (33.60).**
- MAD at f1008 is 12.1, against 0.2 the frame before, with a −212 px shift. The copy, size and button all change on that frame (`g06b`).
- The ripple then sits on "Why am I seeing this?" for 6 frames, so it looks like a mis-tap.

*Fix:*
- Inside the grow clip, keep capA for 80 ms, then cross-fade to capB over 80–320 ms (inOutSoft).
- Align `fromB` on the title baseline, not the card box.
- Lift the pointer 60 ms after the press and move it up and right with the camera.

**4. The music tile→sheet grow still pops (37.80–37.87).**
- An outExpo ease over 300 ms puts 53% of the grow in the first frame. MAD at f1135 is 14.8, against 4–6 on the frames around it.
- At f1134 the tile goes white with a stray "Ferro" chip.
- The sheet title is cropped until 38.13 (`g07b`).

*Fix:* make it a carried grow: `fromB` is the sheet's ER thumbnail, dur 520, `lopP(p,0.35)`. Fill the clip with the tile's maroon, fading to capB over p 0.15–0.55. Start `music-open` at tMo−450 with a=600.

**5. Blank frames after Ask's send (18.17–18.50).**
- Edge energy over f550–556 is 0.4–1.0, the emptiest stretch apart from 60.0.
- The camera climbs into white space before the steps exist, and the sent question is never seen.

*Fix:* add a `MAP.ask` key so the first step row shows by 18100, or start `ask-steps` at tSend+650 with the sent bubble kept in frame.

**6. The Saved→Watch & read grow glitches (29.40–29.83).**
- f882–884 show a white box with a black half-pill, and two pages stacked.
- Then the landscape banner flies across the Dune cover (f888–894), and a grey empty slot sits there for 13 frames (`g05d`).

*Fix:*
- Use `lopP` for the grow (640 ms) and fade the old page under the clip.
- Start the fly at lt+120 and set `mixB` over p 0.1–0.5.
- Make the slot an outline, not a grey block.

**7. The pointer parks instead of leading (30.2–30.9, 34.8–35.9, 39.6–41.2).**
- It reaches its lead point 0.3–2.1 s early and waits at about 0.8W.
- At Habits it then sits at screen x≈0.6W while the target slides under it (`g08`).

*Fix:* lead at the move's peak −900 ms (`at(39900, st(1800,520))`), then arrive on the target as the camera settles (`at(41300, cd("habits", ...mid(tick)))`). It should never sit parked for more than 600 ms.

**8. The middle of the dive is empty (7.73–8.20).**
- The tiles and the line have faded out while the card is still about 240 px wide, so the frame is about 95% bare canvas (edge energy 0.8–1.3, `g02_dive_a`).

*Fix:* keep the tiles opaque so the zoom flings them out of frame, and fade them only over 7900–8100.

**9. The lockup still dissolves (59.73–60.17).**
- The card and line fade in place, and f1800 is nearly blank (edge energy 0.6, the lowest in the film).
- The wordmark fades in over 4 frames, partly under the orb (`g13b`).

*Fix:*
- Let the card and line fall away (+80 y, scale 0.96, inCubic, 59500–59950) while the orb travels.
- Reveal the wordmark from behind the orb with a left-to-right clip, 60000–60450, outExpo.

**Minor:**
- The blur steps are visible on large type (f229). Use N=16 above 60 px/frame.
- From 28.3 to 29.4 there is a strip of the neighbouring card at the right edge, with cut-off text.
- The Team chip row pops in at the top edge at 9.67.

## (c) Protect these

1. **Pull-back (42.6–44.4).** It peaks at 173 px/frame at 42.87, 63% of the reveal lands on the downbeat, and the settle is long and keeps drifting (`g09`).
2. **"Good days" lift into the check-in card (56.4–57.3).** The phrase holds 300 ms, then the line and card move on one curve 200 ms apart, and Great lands on 57.6 (`g11`, `g12`).

Runner-up: Ask→Saved (23.1–25.2), where the pointer leads by 0.7 s and the paste lands during the settle.
