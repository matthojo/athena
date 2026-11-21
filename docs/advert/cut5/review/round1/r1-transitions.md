# Cut 5 r0: transitions review (r1)

Method: frame grids in `review5/g/`, every frame at the joins and every 2–3 frames across the beats. Per-frame MAD, phase shift and edge energy are in `review5/work/`, checked against `camspeed.json`. I built all evidence myself; motion's own grids were not used.

Headline numbers:
- No frame is faster than 150 px/frame. The fastest moves are 140 (habits-work at 43.2) and 139 (the pull-back).
- Isolated spikes: 17.40 (send, deliberate), **26.30–26.33 (MAD 42–44, the worst in the film)**, 33.60 (the "Tell me" tap) and 44.40 (the Penny chip tap).
- Low-detail frames: 43.30 (edge energy 1.48). Also 74.33–74.40, the orb-alone beat at the lockup, which was accepted in cut 4.

## Verdict

**Not ship-ready yet.** Everything carried over from cut 4 still holds. Three of the new joins between 26 and 58 s break cut 4's own rules, and each is a small, local fix.

## Must-fix

**M1. The Saved card lands as a glitch (f788–790, 26.27–26.33, MAD 42–44).**
- f788: the poster is squashed into the paste field's shape and shows as a black strip inside the input box.
- f789–790: the card flies in with its "L Letterboxd" label blown up to about 2× (`a_saved_land_26.2`). That breaks the brief's own rule: cover-fit, never stretched.

*Fix:*
- Start the `fly` from a square at the left of the input (44×44 world units), cover-fitted, and fly only the `poster` rect.
- Reveal the rest of the card with a clip-grow already at its final position, so its text is never scaled. Use 360 ms with lopP rather than the current 2–3 frames.

**M2. Acorn's arrival text overprints the Team page (f1713–1716, 57.10–57.20).**
- The avatar is carried correctly into its row.
- But "Thanks for having me…" and "Acorn is on your team" fade at partial opacity over the Team rows ("week every Fri", "to-dos: Fix the sync banner"). Cut 4 banned partial blends of misaligned layouts (`l_acorn_team_every_57.0`).

*Fix:* hard-swap the background from the arrival page to the Team page at 57100, inside the pull-back's ramp (already 115 px/frame there), with the avatar `fly` riding on top. Alternatively, take the arrival page's text to 0 over 57000–57066, before the clip starts.

**M3. Habits → Penny working (f1287–1318, 42.90–43.93) repeats cut 4's M1.**
- It is a 1.0 s vertical move at about 140 px/frame.
- It passes through the habit header ("…is on a run of 21 days", partly readable at 42.9–43.0, though the plan says to keep it out of frame), then a near-blank gap (f1299), then Home's nav bar and timeline, all as smear (`m_habits_home_every_42.9`).
- It lands on the chips at 43.9, but Penny's line only arrives at 44.4.

*Fix:* the cut 4 solution.
- Hold Habits to 43150, then hard-cut on the 43200 downbeat to the chips pose, with the pointer continuous in screen space.
- Follow with a 600 ms settle (a=0, b=600, z × 1.03).
- If a move is kept, go sideways at 90 px/frame or less, and frame Home's top so the habit header never enters.

## Nice-to-haves

1. **The money shot is a swap, not a step (f1439→1440, 48.00).** The whole card changes on the beat while the camera is at 31 px/frame, which follows the rule. But the line drop, which is the point of the beat, is never drawn.
   - Add a clip-reveal on the graph rect, left to right, 47600–48000, so the drop under "Your £28" lands on 48000.
   - The hold that follows is good: 1.9 s, `g_done_hold_48.0`.
2. **Hire zoom pump (52.9–55.0).**
   - The camera pulls out to show the neighbouring cards (peak 52 px/frame at 53.4), the "Continue" tap happens at about 15% frame height and can't be read, then it pushes back in (58 px/frame at 54.9).
   - Fix: drop `hire-wide`, stay at the form's zoom, and press Continue at 54600 in close-up. The hard cut to Acorn at 55.2 is good (`i_hire_52.8`).
3. **The "Tell me" tap reflows in one frame (f1007→1008, 33.60, MAD 9.6).** The form collapses and the page jumps up about 150 px, with the dashed "Your £28" line simply appearing.
   - Make it a carried collapse: shift capB by the jump and slide it home over 300 ms.
   - Draw the dashed line left to right over 400 ms.
4. **Penny chip tap (44.40, MAD 22).** Everything changes in one frame and the train card jumps down about 45 px. Slide the working line in over 200 ms.
5. **Dive.** Its speed is up from 83 to 127 px/frame. Within the rule, but check that the harder hit is intended.

## Protect

- **"Tell me when" opening (30.8–32.9).** A lopsided pan onto the Tracking panel, the pointer leading to "Tell me when", and the form opening while the camera settles (`b_track_30.0`).
- **Tracking → Music (35.6–37.0).** A clean pan with the pointer leading (`d_track_music_35.4`).
- **Working → done (46.2–47.2).** A sideways move at 103 px/frame back to the same Tracking card: good object continuity. The old state then holds 0.7 s before the swap.
- **Acorn's arrival (55.2), with the avatar carried into the Team row (57.1–57.4).** That half of M2 works.
- **Everything from cut 4.** Ask, Saved→Watch & read, music grow, pull-back, "good days" lift, lockup. These were checked on the shifted timeline and are unchanged.
