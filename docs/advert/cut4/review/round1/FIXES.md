# Cut 4, round 1: what changes

Three reviews of cut 4 v1 are beside this file (transitions, story, sound). This is the
decided list. Timeline stays 64.8 s; key beats stay where they are unless noted.

## Sample data (done, on the branch)

- Penny's gift idea is for **Priya** (pays off "Remind me to get something for Priya's birthday").
- Penny's chat reply is one line: "It's £34 at John Lewis, £8 under what it was when you saved it. Good time to buy."
- Elena's pricing answer is two sentences.
- The Evening run habit hasn't been missed in a month (a real streak).

## Capture

1. Re-shoot `ask` (shorter answer); keep the sent question bubble on screen above the steps.
2. Re-shoot `team` at a clock of about 13:10 so Penny's card time sits after lunch, with Priya
   in the copy and the one-line reply. Start framed so the Athena · Penny · Dot · Wren chip strip is
   on screen, then scroll to her card. Rects for the chip strip (`chips`, `pennyChip`).
3. Re-shoot `habits` so the run's streak shows; rect for the streak/count.
4. `music`: after the sheet opens, press "Open in Spotify" (block the navigation); event + rect.
5. `home`: if the train's late chip can be captured arriving (the live update landing), do it;
   otherwise leave as is.

## Motion (transitions review 1–6 plus story review)

1. Double exposures: pick the capture frame once per output frame (`seek(ms, {capMs})`), and
   fix `MAP.team` so Home's scroll finishes before the card comes into frame.
2. Ask: no crop. `zA = min(0.6H/af.h, 0.86W/at.w)`, gentle drift, bottom edge between lines,
   left margin ≥60 px; the sent question stays in frame; no blank frames after send.
3. Penny: open with the chip strip in frame (sells Team), tilt to her card; the "Ask about it"
   tap cross-fades (no one-frame swap); pointer lifts after the press; her one-line reply holds
   ≥1200 ms.
4. Music: carried grow from the tile into the sheet (no pop, no white flash); press "Open in Spotify".
5. Saved: push in (~1.6×) on the paste row early, follow the card; the grow into Watch & read
   without stacked pages or a grey slot; tilt so the "Watch & read" title is in frame on landing.
6. Home: frame tight enough that the flight row is out of frame; nothing sliced by the edge.
7. Habits: push in so the tick and the streak read.
8. Pointer never parks for long at 31.2, 36.0, 40.8; dive middle less bare; lockup: the orb comes
   out of the pressed Great (no near-blank frame, no 4-frame fade of the wordmark).
9. Protect: the pull-back, the good-days lift, Ask→Saved, the poster into Watch & read, the
   rotation's first six slots, Great on the chord.

## Sound (sound review 1–6 plus smaller items)

Penny's voice on `team.scrollEnd` (on the grid); reply +5 dB at its real time, whoosh on the
open move; poster-landing `drop` from `fly3.end`; louder rotation build from 50.4 (≥ -15 LUFS);
Saved/Ask cue timing; no `answer` chime at 19.2; a quiet pad under the opening; brighter voicing;
drop the inaudible orb-morph whoosh; the smaller items in r1-sound.md. Re-sync to the new
motion-peaks.json and film-events.json at the end.
