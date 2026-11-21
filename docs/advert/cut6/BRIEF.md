# Athena launch film, cut 6: "Athena remembers the good days"

86.4s, 1920x1080, 30fps (2592 frames), stereo 48kHz. No voiceover, no live action. `PLAN.md` is the source
for what is in this cut; this brief is the motion spec that `film.js` implements.

## The idea

One continuous take across a single light canvas. A pointer is the lead character: it wanders in, taps,
and everything that happens is something it did. The real app screens sit on the canvas as rounded cards
with no device bezel, laid out like a map; the camera glides and pushes between them and gets close
enough that the UI nearly fills the frame. Almost no words. Light, playful, unhurried confidence.

Tempo 100 BPM: one beat = 600ms, one bar = 2400ms, 36 bars = 86.4s.

Cut 6 is cut 5 re-fitted to captures of the current app (every rect re-measured; every cut 5 review fix kept), plus
one new bar and a half: **Flows** (60000–64800). Everything from the pull-back on is cut 5's, 4800 ms later.

## Paths
- Source: `docs/advert/cut6/` (film.html/css/js, render.cjs, swaps.json).
- Working output: `$FILM` = `/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film6`
  - `$FILM/cap/<shot>/0000.jpg…` app captures (390x844 CSS at 3x or more), `$FILM/cap/manifest.json`, `$FILM/cap/stills/<name>.jpg`
  - `$FILM/frames/000000.jpg…` final picture frames; `$FILM/motion-peaks.json`, `$FILM/camspeed.json`, `$FILM/film-events.json` for the sound (hard cuts carry `cut: true`).

## Look
- Canvas #f4f6f8 with the soft blue/mint aurora haze, ink #15181e, cobalt #2c5fdd, the blue orb. Funnel Display, Geist.
- Screen cards: the capture with ~44px rounded corners (at 390-wide scale), hairline border, soft shadow. No bezel.
- The pointer: a soft round touch pointer, presses by shrinking to ~80% with a ripple, stretches along fast travel.

## Motion rules (carried from cut 4)
- **One camera.** A sum of eased moves; each move's speed rises along a smoothstep for ~900ms and settles over
  ~1500ms (lopsided), and moves overlap, so speed carries from one beat into the next. Holds are slow drifts that
  lean toward the next card. Nothing stops dead. The next screen's action starts while the camera is still settling.
- **Motion blur.** Above 25 px/frame of on-screen travel, each frame averages 5-13 sub-frame renders (16 above 60
  px/frame) over a 180-degree shutter (`render.cjs`). Every sub-sample shows the same app capture frame
  (`seek(ms, { capMs })`): only the camera, pointer and morphs move within the shutter, so nothing double-exposes.
- **Framing.** A pose on a card between ~2.1x and 2.49x would show slivers of the neighbouring cards; such poses are
  pushed to 2.49x (about 25 px clear).
- **Never two layouts at partial opacity.** A change of screen is either carried (the same object kept in place while
  the rest opens round it, or the page scrolled as one stitched page) or swapped on a camera move's fastest frame,
  where the blur hides it. No page cross-fades, no second copy of a flying thing.
- **The pointer leads.** It leaves its target ~1200ms before a move's fastest moment (the camera starts ~300ms
  after it), swings toward the side the next card comes from, and homes in on the next target as the camera lands.
  On a lead it is never carried by the world.
- **Morphs.** A tapped thing grows into the view it opens. Two are *carried*: the next view starts shifted so the
  same object sits where the tapped one was, and slides home on the camera's own curve as the clip grows round it
  (the Saved card becomes its item page, the poster riding up into the banner; Penny's Home card becomes her card at
  the head of her thread, the camera riding up with it). The "Evening run" tile grows into its sheet. The film's
  poster flies from its item page into its place as the first cover in Watch & read's Films row while Watch & read
  grows open round it (an empty slot waits where it lands, so there is never a second copy). Flying crops are
  cover-fitted, never stretched, and cross-fade from the start crop to the end crop mid-flight.
  The pressed Great circle becomes the orb.
- **The wall is two rows.** The day runs left to right along the lower row (Home, Ask, Saved, the gift idea's
  page, Music, Habits); the upper row holds Home with Penny at work, the gift idea's page when her check comes in and
  the New assistant sheet, right to left. Habits to Home is a hard cut on the 43200 downbeat (the pointer stays where
  it is on screen), so neither Habits' header nor Home's greeting crosses the frame.
- **Neighbours away.** While the camera is on the New assistant sheet its two neighbours are faded out (while off
  frame) and come back for the wall, so a frame taller than the no-sliver zoom shows the sheet alone.
- **State changes the app makes in one frame, and the film's own skips** (the Tracking panel redrawing when a check
  comes in; from the chat to "... is on your team"; from there to the Team page) happen on a beat, on the fastest
  frame of a camera move, as a whole-page swap, never a blend; the thing that matters (the chart, the face) stays put
  or is carried across. The only things laid over the app's pixels are its own pixels from another frame (a flying
  crop, a cover in the page's own background colour where a carried thing has yet to land).
- **Blur sub-samples.** Flying crops are placed by transform (a resized image is re-rastered late and came back
  stale in the sub-samples, which showed as steps in the smear); `window.blurBoost` asks `render.cjs` for more
  samples where a crop flies during a camera move.
- Captures play through per-shot time maps so their events land on beats (see `buildMaps` in `film.js`).

## Timeline (ms)

| ms | What happens |
|---|---|
| 0–31200 | As cut 4: the opening (orb 1200, tiles 3000–5100, the line 5400–6600), the dive (7200, peak ~8130), Home (late chip on 11400), Ask (peak 14400, sent ~17400, the answer on 19200), Saved (peak 24000, paste 25200, card tapped 27600, Move 28800, the link 29400, the poster flies into Watch & read). Round 1: when the saved film's card lands (26266–26626) only its poster flies, from a 44-unit square at the left of the paste field (cover-fitted) to the head of the card, 360 ms on the lopsided curve, while the rest of the card is uncovered where it stands, top to bottom; its text is never scaled. |
| 30300–36000 | **Team 1, "Tell me when"** (peak 31200): lands on the gift idea's page head: the item's title and under it the Tracking panel's sentence, chart and "Tell me when" toggle (2.5x), held to ~32600 with the pointer beside the title. Then in on the sentence, the chart and the toggle (from 32500, peak ~33000). Toggle tapped on 33000: the camera eases down to the form's "At or under" row, the bottom edge in the gap above the amount field (its grey placeholder out of frame); "At or under" on 33400; the field comes into frame as 28 is typed from 33700; "Tell me" on 34200: the form closes, the sentence becomes "You asked to hear at £28 or less", the pill and the dashed "Your £28" line appear on that frame (the app's one-frame redraw; the chart rescales, so nothing is wiped or drawn over it), inside the camera's move back up and in (3.7x). Held ~34900–35600. |
| 35400–40800 | Music (peak 36000): as cut 4 ("Evening run" 37800, Open in Spotify 39600). |
| 39900–43200 | Habits (peak 40800): as cut 4 (ticked 41700, "21 in a row"), held to the last frame before 43200. |
| 43200–45900 | **Team 2, Penny works**: hard cut on 43200 to Home's Ask box and the Athena · Penny · Dot · Wren chips (a touch wide, a 600 ms settle in). Penny's chip tapped on 43800: the box turns to "Ask Penny, or give her a job…" and her working line shows under the chips, its dot breathing; a push in to 5x on the chips and the line. Held to ~46000. |
| 45900–49600 | **Team 2, it's reached** (peak 46600): left to the same Tracking panel exactly as Team 1 left it (sentence, chart with the dashed line, pill), seen for ~0.8 s; then one ease out and up to the whole page head whose fastest frame is 48000: on that frame her check is in (the app's one-frame redraw: the line steps down under the dashed line, "£27 at Fenn & Hale, under the £28 you asked for."), and the frame lands with the item's title at the top and "Penny checked 1 minute ago · Fenn & Hale" inside the bottom edge, held to ~48600 so the title reads; then a push in (1.3x, 48550–49300) on the "£27 at Fenn & Hale ..." line and the chart, "Penny checked ..." still inside the bottom edge, held to ~49900. |
| 49850–55200 | **Team 3, hire** (peak 50400): the "New assistant" sheet: the waiting silhouette, "What's the job?", the field. The sentence is typed 50700–53100 at the capture's own speed. The frame stays there, its bottom edge just under the field (the suggestions below it name a real product and never enter frame): the pointer goes down out of frame to Continue, pressed on 54000 (heard, and seen in the plate turning to "Reading the job…"), and the camera eases to the chat's framing while the silhouette thinks. |
| 55200–56950 | On **55200** the assistant is there in the silhouette's place (the app's own reveal, its cross-fade frames skipped): Acorn, its name plate "Tells you what's due this week", the job as sent; "Hi, I'm Acorn. Happy to help with this." on 55400 and "Every Monday at 9:00, I'll tell you what's due this week." on 55600, held to 56950. |
| 56950–57600 | The film skips the questions: on the fastest frame of a push in, "Acorn is on your team" (the face grows in place, carried; its bubble "Thanks for having me. I'll get started." 100 ms later). |
| 57600–59400 | The Team page (the capture's end hold): on the fastest frame of the move down and out the page is swapped whole (no blend) and the face comes in from the left of the column (its own tile from the Team page, opaque, 120 units, 300 ms on the lopsided curve), ending exactly on its place at 57900; Wren's and Acorn's cards whole in frame, Dot's above the frame. Settled ~58000–59400. |
| 59400–64050 | The pull-back (peak ~59670, the wall mostly revealed on 60000). Twelve screens: upper row Days, Watch & read, Health, Team, the gift idea's page (reached), Money; lower row Home, Ask, Watch & read (the film), a Tracking page (still `tracking`), Music, Habits. The pointer goes to the new face first. Drift in to 1.10x. |
| 64050–65100 | The wall falls away column by column; the camera tilts down after it. |
| 64700–73200 | "Athena remembers the …" types on, then the phrases per `swaps.json`: seven readable on quarter notes from 65400 (platform, pricing call, film, price, run, streak, Monday list), then 200 ms, 150 ms, 100 ms steps to 73100. |
| 73200 | "good days". Holds 250 ms, then the line lifts and the check-in card rises on the same curve, 150 ms behind. |
| 74400 | "Great" pressed on the final chord. |
| 76200–77400 | The pressed Great circle becomes the orb; the wordmark slides out from behind it. Held. |
| 81300–81600 | Fade to bare canvas. |

On-screen copy is final. Exactly: "Everything you'd otherwise forget", "Athena remembers the" followed by the
phrases in `swaps.json`, and the wordmark "Athena". No other words of the film's own, no full stops, no logos of other companies.

The word "Muse" never appears. Team's sample shops and products are made up (Greenleaf, Fenn & Hale, Copperkettle).
