# Athena launch film, cut 4: "Athena remembers the good days"

64.8s, 1920x1080, 30fps (1944 frames), stereo 48kHz. No voiceover, no live action. `PLAN.md` is the source
for what is in this cut; this brief is the motion spec that `film.js` implements.

## The idea

One continuous take across a single light canvas. A pointer is the lead character: it wanders in, taps,
and everything that happens is something it did. The real app screens sit on the canvas as rounded cards
with no device bezel, laid out like a map; the camera glides and pushes between them and gets close
enough that the UI nearly fills the frame. Almost no words. Light, playful, unhurried confidence.

Tempo 100 BPM: one beat = 600ms, one bar = 2400ms, 27 bars = 64.8s.

## Paths
- Source: `docs/advert/cut4/` (film.html/css/js, render.cjs, swaps.json).
- Working output: `$FILM` = `/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film4`
  - `$FILM/cap/<shot>/0000.jpg…` app captures (390x844 CSS at 3x or more), `$FILM/cap/manifest.json`, `$FILM/cap/stills/<name>.jpg`
  - `$FILM/frames/000000.jpg…` final picture frames; `$FILM/motion-peaks.json`, `$FILM/camspeed.json` for the sound.

## Look
- Canvas #f4f6f8 with the soft blue/mint aurora haze, ink #15181e, cobalt #2c5fdd, the blue orb. Funnel Display, Geist.
- Screen cards: the capture with ~44px rounded corners (at 390-wide scale), hairline border, soft shadow. No bezel.
- The pointer: a soft round touch pointer, presses by shrinking to ~80% with a ripple, stretches along fast travel.

## Motion rules (cut 4)
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
- Captures play through per-shot time maps so their events land on beats (see `buildMaps` in `film.js`).

## Timeline (ms)

| ms | What happens |
|---|---|
| 0–2400 | Bare canvas. The pointer drifts in, presses at 1200: the orb pops. Presses the orb at 2400. |
| 3000–5100 | Eight Library tiles pop, every half beat, each tapped by the pointer. |
| 5400–6600 | "Everything you'd otherwise forget", word by word, complete by 6600. |
| 6300–7200 | The pointer heads for tile 1; the camera (which carries the whole opening) leans in toward it. |
| 7200–9300 | Tile 1 pressed: the dive (peak ~8200). Tile 1 opens into the Home card; the other tiles, the orb and the line stay opaque and are flung out of frame by the zoom, fading only over 7900–8100. Lands on the train row and carries on into the tight framing. |
| 9600–14400 | Home, tight (3.75x) from the dive's landing: the chips, the card head, the train row and its code; the bottom edge at y 568, above the flight row before and after the live update. "On time" becomes "12 min late · Platform 7" on 11400. |
| 13500–15900 | Move to Ask (peak 14400); the question starts typing at ~15000 while the camera settles. |
| 17400–24000 | Sent: the question flies from the box up to its place as the sent bubble (760 ms, on the camera's own curve, its place patched with the page's background until it lands); the capture jumps past the route change's blank frames; the camera rides it up to the question and the steps. Then one push to the answer (≥60 px margins, bottom edge in a gap), held. The capture's re-render frames are swapped on their middle frame, never blended. |
| 23100–31200 | Saved (peak 24000): push in on the paste row (25200); the card lands (26600), tapped on 27600: the card becomes its page, poster into banner (carried), Lapvona beside it fading out in 120 ms; framed at 2.49x (no neighbour in frame) down to the Move button, tapped on 28800; the "Watch & read" link on 29400: Watch & read opens out of the poster's box (lop clip-grow, no page fade) while the poster lifts off and flies to its place first in the Films row (that place is the page's background until it lands). Held to ~30800 with the page's title in frame. |
| 30300–36100 | Team (peak 31200): lands with the top edge on the Ask bar (greeting out of frame), the chips in frame and the pointer on Penny's chip (no press); 32000–32600 the page scrolls to her card as one carried move (the two frames stitched as one page, the nav fixed, motion-blurred); tight on her card to 33600; "Ask about it": Home holds until the team-reply move's fastest frame (33800, ~40 px/frame) and cuts straight to her chat, her question sent (no detail page); steps to 34100; her one-line reply streams 34100–34600 and holds ≥1300 ms. |
| 35500–40800 | Music (peak ~36100): straight onto Playlists; "Evening run" tapped on 37800 and carried into its sheet (the ER thumbnail on the tile, the tile's maroon clearing); pushed in to 3.75x on "Open in Spotify" (39100–39900), pressed on 39600. |
| 39900–43200 | Habits (peak 40800): pushed in on the run's card (the habit header out of frame); ticked on 41700, "21 in a row" by 41800, held to the pull-back. |
| 42600–45500 | The pull-back: fast early (peak ~42870) so the wall is mostly revealed on the 43200 downbeat, long settle. Twelve screens incl. the Team grid. Drift in to 1.10x; the pointer wanders across the wall. |
| 47250–48300 | The wall falls away column by column (600ms per card, 70ms apart); the camera tilts down after it. |
| 47900–56400 | "Athena remembers the …" types on, then the phrases per `swaps.json`: six readable on quarter notes (platform, pricing call, film, gift idea, run, streak), then 200ms, 150ms, 100ms steps to 56300. |
| 56400 | "good days". Holds 250ms, then the line lifts and the check-in card rises on the same curve, 150ms behind. |
| 57600 | "Great" pressed on the final chord. |
| 59400–60600 | The pressed Great circle leaves the card and becomes the orb; the line and card drop away first (down 80, to 96%, inCubic, 59500–59920); from 60000 the wordmark "Athena" slides out from behind the orb, clipped at the orb's right edge, the orb drawn above it. Held. |
| 64500–64800 | Fade to bare canvas. |

On-screen copy is final. Exactly: "Everything you'd otherwise forget", "Athena remembers the" followed by the
phrases in `swaps.json`, and the wordmark "Athena". No other words, no full stops, no logos of other companies.
