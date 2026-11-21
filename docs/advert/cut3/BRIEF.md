# Athena launch film, cut 3: "Athena remembers the good days"

67.2s, 1920x1080, 30fps (2016 frames), stereo 48kHz. No voiceover, no live action.

## The idea (revised after seeing the reference film)

One continuous take across a single light canvas. A pointer is the lead character: it wanders in, taps,
and everything that happens is something it did. The real app screens sit on the canvas as rounded cards
with no device bezel, laid out like a map; the camera glides and pushes between them and gets close
enough that the UI nearly fills the frame. Almost no words: one small line near the start, one at the
end where a phrase is selected and retyped. No big headlines, no captions over the product, no hard cuts
except where noted. Light, playful, unhurried confidence.

Reference stills (the look to learn from, not to copy; ours uses Athena's own brand, colours and fonts):
`$FILM/../ref/sheet1.jpg`, `sheet2.jpg`, `grid.png`.

Tempo 100 BPM: one beat = 600ms, one bar = 2400ms, 28 bars = 67.2s. Moves start and land on beats.

## Paths
- Source (the director commits; do NOT git commit/push): `/home/user/athena/docs/advert/cut3/`
- Working output: `$FILM` = `/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film`
  - `$FILM/cap/<shot>/0000.jpg…` app captures, 1170x2532 (390x844 at 3x), 30fps, `$FILM/cap/manifest.json`, `$FILM/cap/stills/<name>.jpg`
  - `$FILM/frames/000000.jpg…` final picture frames
  - `$FILM/audio/` music, effects, mix
- Dev server: http://localhost:5199/ (sample mode: `localStorage['athena.mode']='sample'`, abort `**/api/**`).
- Stand-in stills of each view: `$FILM/../look/*.png`.

## Look
- Athena's design: canvas #f4f6f8 with the soft blue/mint aurora haze, ink #15181e, cobalt #2c5fdd, the blue orb.
  Tokens in `app/src/styles/tokens.css`; fonts in `app/public/fonts` (Funnel Display 500–600, Geist).
- Screen cards: the capture with ~44px rounded corners (at 390-wide scale), hairline border, soft restrained shadow. No phone bezel.
- Type is small and quiet: the two lines are Funnel Display 500 at about 56–64px, ink, centred, like a caption on a gallery wall.
- The pointer: a soft round touch pointer (about 44px at film scale: translucent ink disc with a white ring and faint shadow).
  It moves in smooth arcs with ease-in-out, never teleports, presses by shrinking to ~80% with a brief ripple, and usually
  leads the camera by a beat. It is on screen for nearly the whole film.
- Camera: smooth, eased (in-out between holds), always very slightly moving. No bounces.

## Timeline (ms). Version 3: 67.2s, 2016 frames, 28 bars

The film now follows one day: the morning train, a question before a meeting, something found in passing and kept, music for the evening run, the habit ticked, the night's sleep, then everything at once, then the day marked Great.

| # | In–out | What happens |
|---|---|---|
| 1 | 0–2400 | Bare canvas. The pointer drifts in, presses at 1200: the orb pops into being under it. |
| 2 | 2400–9600 | The pointer presses the orb at 2400. Eight Library tiles pop in beneath it, one per beat from 3000. From 6000 the line appears word by word: "Everything you'd otherwise forget". Hold to 9600. |
| 3 | 9600–12000 | The pointer presses the first tile; tiles and line fall away; the tile grows into the Home card as the camera dives in. |
| 4 | 12000–18000 | Morning. Home (shot `home`, starts 12000). Greeting at a readable zoom, then straight down and in on the "12 min late · Platform 7" row, landed by 15000. Hold about 2 seconds, pointer resting beside the chip, then leave. (Shorter than before: do not linger on the train.) |
| 5 | 18000–28800 | Before a meeting. Ask (shot `ask`, starts 18000). Typing at capture speed; the steps squeezed so the first answer words land at 23400; the answer finished with its sources at 26400; hold to 28200. |
| 6 | 28800–34800 | In passing. Saved (shot `saved`, starts 28800): something found during the day is kept (see the manifest events; it is no longer a typed note about a walk). Camera eases in on the new card. |
| 7 | 34800–40800 | Evening run. Music (shot `music`, starts 34800): the Music page, the pointer opens the running playlist or scrolls to the playlists (per the manifest events and rects). |
| 8 | 40800–44400 | Habits (shot `habits`, starts 40800): the pointer ticks today's habit. |
| 8b | 44400–48000 | Health (shot `health`, starts 44400), ending on the Sleep card. |
| 9 | 47400–52800 | The pull-back: the whole wall in frame, landed by 49800, slow drift inward. The wall now holds twelve screens: home, ask, saved, music, habits, health, and stills days, week, trips, money, watch, plus graph playing. |
| 10 | 52800–61200 | The wall falls away. The closing line types on, complete by 53400: "Athena remembers the platform". The phrase is then swapped again and again, quickening to a flicker, exactly per `swaps.json` (same folder as this brief; `how` is type, retype, swap or final). The first two swaps are selected by the pointer and retyped; the rest are instant in-place swaps. "Athena remembers the" never moves. It must feel packed. |
| 11 | 61200–64800 | The line lands on "Athena remembers the good days" at 61200, lifts to the upper third as the check-in card (shot `checkin`, cropped as now) rises beneath it, landed by 61800. The pointer presses "Great" at exactly 62400 (the final chord). Hold. |
| 12 | 64800–67200 | Line and card resolve into the orb + wordmark lockup, fully formed by 65300. Pointer leaves. Hold. Fade to bare canvas over the last 300ms. |

On-screen copy is final. Exactly: "Everything you'd otherwise forget", "Athena remembers the" followed by the phrases in `swaps.json`, and the wordmark "Athena". No other words, no full stops, no logos of other companies.

## Sound map
- 0–2400 almost nothing; a soft pop when the orb appears (1200).
- 2400–9600 light, bouncy groove (bass + snaps/soft kick); a rising mallet note on each tile pop (3000 … 7200).
- 9600–12000 lift and swoosh into the dive; 12000 the full groove.
- 18000–23400 Ask: thin for the typing; lift back to full at 23400 when the answer lands.
- 28800–48000 full, adding layers.
- 48000–52800 the biggest, widest section (the pull-back).
- 52800–61200 the build: drop to bass and snaps at first, then a rise that quickens in step with the swaps (see `swaps.json`), most intense in the last two seconds, cut dead at 61200.
- 61200–62400 a held breath: almost nothing.
- 62400 one warm final chord with a sparkle as "Great" is pressed; a soft tag note at 64800 for the logo; silent by 67000.
