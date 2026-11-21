# Cut 6 r0: picture review (transitions and story, r1)

Method: frame grids in `review6/g/`, every frame at the joins and every 2–3 frames across each beat, plus full-resolution stills where the grid tiles are too small to judge. Per-frame MAD, phase shift and edge energy are in `review6/work/`, checked against `camspeed.json`. I built all evidence myself.

## Rule checks (whole film)

- **Speed:** no frame is faster than 150 px/frame. The fastest is the wall exit at 136 (69.8); the pull-back peaks at 105.
- **Blank frames:** only the accepted ones at the send (17.8) and the lockup's orb (81.5).
- **Frame spikes:** 43.20 (cut), 43.80 (chip), 55.20 (Acorn), 56.97 (arrival page), 34.20 (Tell me) and 17.40 (send) are all deliberate and unchanged from cut 5. The only new one is 61.80, the Flows tap (see M1).
- **Partial blends:** none. Acorn's flight is now opaque and comes in from the left (57.7–57.9, `f_acorn_every_57.55`), so cut 5's M2b is fixed.
- **Off-brand:** I saw no "Muse" or "Linear" anywhere. The hire's suggestion list, which named Linear in cut 5, is gone (`e_hire_53.2`).
- **Re-captured beats 8–60 s:** Home, Ask, Saved, Tracking, Music, Habits, Penny and the hire all read as in cut 5 on the new build (`o1_0-30`, `o2_30-57`).

## Verdict

**Ship, after one fix.** The new Flows beat mostly reads. The only thing a first-time viewer would notice is that the moment "one tap made this" doesn't feel caused.

## Does the Flows beat read?

**What Athena noticed: yes.**
- The suggestion card is large and fully legible from 60.6 to 61.8: "You look for a present a week before birthdays. Four times since September. Want Athena to do it for you?"
- That is 1.2 s, the minimum for text that matters. The pointer leads to "Make it a flow" (`b_flows_61.0`).

**What the tap did: partly.**
- The steps are large and legible at full resolution: "WHEN A week before a birthday, at 9:00" and "THEN Find gift ideas · Gift ideas for the person" (`s_flow_f1890_full`).
- They hold 62.4–64.4, and the switch going On at 63.6 reads.
- The problem is the join between the tap and the page (M1).

**Connection to the gift story: adequate.** "Present", "birthday" and "Find gift ideas" rhyme with Priya's birthday and the hand balm. A viewer gets it, but nothing names Penny or Priya, so it reads as a new topic rather than the payoff. See nice-to-have 1.

## Must-fix

**M1. The Flows tap is a jump cut into a moving camera (f1853→1854, 61.77→61.80, then f1854–1866).**
- On the tap frame the picture cuts from the suggestion card straight to the flow page at about 2×, with its title filling the frame (MAD 16.8).
- The pointer is not in the same screen place: it jumps from the button, lower left, to the middle of the WHEN row.
- The camera then immediately pulls out at up to 81 px/frame (flow-open, peak 61.93), so the steps resolve as a blurred zoom over 61.83–62.20.
- The brief says the page grows out of the card. What's on screen is a cut followed by a whoosh, so the cause and effect of the tap is lost.

*Fix:* a carried grow, like Penny's thread.
- At 61800, clip-grow from the suggestion card's rect to full over 560 ms (lopP), with `fromB` aligned so "Birthday heads-up" starts on the card's title line. The card's "Birthday heads-up" chip is the same object.
- Set the camera to the final flow pose (the framing of f1890) by 61700 and keep it still through the grow. Delete the `flow-open` move, so the steps land at rest on 62400.
- Keep the pointer in screen space and move it to the switch by 63400.

## Nice-to-haves

1. **Tie the flow to the story.** If the app allows a named person in the trigger ("A week before Priya's birthday"), or Penny as the THEN step ("Penny finds gift ideas"), it would pay off the gift thread. Otherwise, hold the suggestion card to 62.0 so that "Four times since September" lands: a 1.4 s hold.
2. **"No assistant · no AI spend"** under the title reads as jargon and slightly undercuts the Team story. Frame the top edge just under the title row, and move the switch's reveal with it.
3. **THEN card cut by the bottom edge (62.4–64.4).** The text is whole, but the card's lower edge is cut. Raise the pose by about 40 world units, or zoom 0.95×.
4. **Real brands on the wall (66–69).** The Money card shows Spotify and PureGym. They are tiny, but sample names would be safer.
5. **Team → Flows (59.3–60.6).** The Team page drift and the Flows move overlap, which is fine. But Acorn's card zooms to about 2× as a smear before the jump to Flows. Start `team-flows` at 59500, a=500, so the Team page leaves sooner.

## Protect

- The Flows suggestion card framing and hold.
- The steps page framing (f1890) and the switch going On.
- Acorn's opaque flight from the left.
- The Habits → chips hard cut.
- The poster-only Saved fly.
- The tight hire.
- The silhouette becoming Acorn.
- The pull-back wall with the flow and Team on it.
- The rotation ("Monday list", "birthdays").
- "Good days", Great and the lockup.
