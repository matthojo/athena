# Transitions review: Athena launch film v3

Method: `buildCamera()` ported to Python for exact camera speed and zoom per frame, plus per-frame mean abs diff (MAD) and phase-correlation shift on the film and the reference. Overview: `tr_motion_timeline.png`. Work files: `transitions-work/`.

## Ranked problems (worst first)

**1. Every card change uses the same stop, whip, stop (17.4–18.6, 28.2–29.4, 34.2–35.4, 40.2–41.4, 44.4–45.6).**
All five are the same move: a 1200ms symmetric cubic centred on the boundary. Each one starts and ends on a zero-velocity `hold()`. Peaks are 165, 107, 147, 114 and 111 px/frame. There is no motion blur either. In frames 539 and 540, the text is pin-sharp and jumps about 136px between them (`tr_whip_539_540.jpg`), so dense UI type will strobe. It reads as a slideshow with swipe transitions, not one continuous take.
*Fix:* make the moves asymmetric, with an ease-in of about 900ms and an ease-out of about 1500ms (start at T−1200, land at T+1200). Replace per-segment eases and linear holds with one Catmull-Rom spline through the keys, so velocity carries into the next drift. Turn 1–2 of the five into the transition types under "Steal". For motion blur, average 5 sub-frame `seek()`s across a 180° shutter (±8ms) whenever camera speed is above 25 px/frame.

**2. The dive (9.6–11.4) is dead for 700ms, then slams.**
`inOutStrong` (quintic) gives 0% of the zoom by 9.9, 7% by 10.2, then 86% of a 6.75× zoom between 10.3 and 10.7 (peak 16.4%/frame). MAD falls to 0.5 at frames 305–309: tiles and line are gone, and the only thing on screen is a 60px card at x≈310. That card then sweeps about 650px diagonally while zooming (`tr_02b_dive_everyframe.jpg`). After landing, the picture sits near-static from 11.0 to 12.6 (MAD 0.1–0.7).
*Fix:* switch to cubic `inOut`, and start a pre-push at 9300 while the pointer approaches tile 1, so tile 1 drifts toward centre before the press. Delay the tile and line fall to 9750–10400 so it overlaps the zoom. Merge the 11400/12600 keys so the landing slides straight into the move down to the chip.

**3. The pull-back (47.4–49.8) lands late, after a reversal, and then freezes.**
From 45.6 to 47.4 the camera zooms in (2.2→2.55), then reverses into the pull-out. The first 800ms of the pull covers only 7% of it. 73% happens between 48.4 and 48.8 (−10.6%/frame), which is 400–800ms after the 48.0 "biggest" music hit. Then 49.2–52.6 is effectively still: the "drift inward" is 1.03 over 3s, or 0.03%/frame (`tr_08_pull.jpg`).
*Fix:* drop the health drift-in, or make it a slight drift out. Pull from 47400 with an expo-out curve so most of the reveal lands on 48000, with a long tail to 49800. Then drift to 1.10 by 52600.

**4. Music (35.4–39.2): the fastest motion in the film is an app scroll, followed by a pop.**
The capture scrolls 2188px in 1.6s, measured at 280–330 px/frame vertical at 36.17–36.33 (MAD 41.8, the film's maximum). That scroll comes straight after a 3-frame stop at 35.4–35.5 (a 1.01 zoom twitch). At 37.8 (frame 1134) the playlist opens as a one-frame hard cut (MAD 26.4), and the camera only re-frames 37.9–39.2, so the content arrives before the camera (`tr_13_music_scroll.jpg`).
*Fix:* time-remap the scroll the way `askCapTime` does, eased and at most about 900 px/s. Alternatively, use a `cover` blend over the mid-scroll and let the camera do the travel. For the open, grow the `tile` rect into the sheet over 250ms (outExpo), and start the reframe 300ms before the press.

**5. The pointer rides along in transitions instead of leading them.**
Its keys are card-relative (`cd()`), so it gets dragged by the pan: in 40.6–41.0 it moves 1264→424 px along with the world (`tr_06_music_habits.jpg`). Or it hangs still mid-gap (frames 539–540: 34px against the world's 136px). The brief says it leads by a beat; in the reference the cursor flicks at 11.2 and the zoom follows 300ms later (`tr_ref_A_icon_dive.jpg`).
*Fix:* for each move, add a screen-space key at T−900 toward the edge the next card enters from, and let the camera start 300ms later. Stretch the pointer along its velocity (scaleX 1+v/400) so fast moves smear.

**6. Ask (18.6–26.4) pumps the zoom.**
The zoom goes in to 2.9, out to 2.1, back in to 2.9, stops dead for 300ms (24.6–24.9), then goes out to 2.2. That is four reversals in 8 seconds. Typing also starts on the exact frame the whip lands (18.6).
*Fix:* delete the `tAns+1200` and `tAns+1500` keys and run one `inOutSoft` from tAns to tDone at about 2.5. Land the whip 200ms before `typeStart`.

**7. The finale hand-offs don't match.**
- **Lift (61.2):** the line eases with cubic `inOut` (slow start) while the card rises on quartic-out (fast start). In frames 1841–1843 the card header crowds the still-low line, and the lift begins on the same frame "good days" lands (`tr_10_lift.jpg`). *Fix:* use one curve for both, start the card 150ms after the line, and hold the phrase for 300ms (lift 61500–62000, still before Great at 62400).
- **Lockup (64.8):** the line and card collapse in 240ms. Frame 1949 shows the orb superimposed on the ghosted card, so it reads as a dissolve rather than a resolve (`tr_11_lockup.jpg`). *Fix:* match-cut. The filled "Great" circle at `CK.great` travels and scales into the orb over 500ms (outExpo) while the card fades underneath.

**8. The wall vanishes in about 260ms (52.62–52.9).**
The whole wall goes in roughly 9 frames (MAD spike 8.5 at frames 1581–1587), right after 3.4s of stillness. It reads as a glitch, not a fall (`tr_09_wallfall.jpg`).
*Fix:* stagger columns by 70ms (currently 18ms) with 600ms per card. Tilt the camera down (+200 world y) so it follows the fall, and have the pointer flick downward at 52.4 to set it off.

## Steal from the reference

1. **Object continuity instead of a pan** (ref 11.3–11.9 and 22.4–23.0, `tr_ref_A_icon_dive.jpg`, `tr_ref_C.jpg`). The icon blooms into the document, and later the document collapses back into its icon while the neighbouring icons slide in, then decays 12→2 px/frame without stopping. *For us:* at ask→saved and health→pull, collapse the outgoing card into its Library tile and bloom the next one out of its own tile.
2. **A hard cut on the beat, with the pointer continuous across it** (ref 13.35, a single-frame cut followed by stillness; `tr_ref_B_cut.jpg`). *For us:* at 18000, cut straight from home to Ask with the pointer in the same screen spot., saving a 1.2s whip.
3. **An asymmetric whip where the next content arrives during the deceleration** (ref 41.0–43.4, `tr_ref_E_whip.jpg`). The camera ramps from 4 to 67 px/frame (16% of frame width per frame) over 1.6s, the headline starts typing while it is still settling, and the cursor rotates and smears in its direction of travel. Our peak (8.6% of width per frame) is not the problem; the symmetric shape and the dead stops are.
