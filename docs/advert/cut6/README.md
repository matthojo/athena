# Cut 3: "Athena remembers the good days"

A 67-second launch film made entirely in code: the real app in sample mode, one continuous camera move across a wall of screens, a pointer that leads, and a synthesised 100 BPM track. `BRIEF.md` is the spec (idea, look, timeline, the only on-screen copy).

The rendered video isn't in the repo. To rebuild it, set `FILM` to a working folder and run, from the repo root:

```sh
npm run dev:app -- --port 5199                  # the app, for the captures
CAP_DIR=$FILM/cap node docs/advert/cut3/capture.cjs   # app shots and stills, plus manifest.json
python3 docs/advert/cut3/music.py               # the track
python3 docs/advert/cut3/sfx.py                 # interface sounds
python3 docs/advert/cut3/cues.py                # places the sounds from the manifest
python3 docs/advert/cut3/mix.py                 # music + sounds -> audio/mix.wav
CAP_DIR=$FILM/cap OUT_DIR=$FILM/frames node docs/advert/cut3/render.cjs   # 2016 frames
ffmpeg -framerate 30 -i $FILM/frames/%06d.jpg -i $FILM/audio/mix.wav \
  -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -c:a aac -b:a 256k -movflags +faststart athena-launch-film.mp4
```

The scripts default to the folder they were first run in; pass the env vars (`FILM`, `CAP_DIR`, `OUT_DIR`) to point them elsewhere. Needs Playwright, ffmpeg and Python with numpy.

| File | What it does |
|---|---|
| `capture.cjs` | Records each app shot frame by frame against a stepped fake clock, and measures when things happen and where they are on screen. |
| `film.html`, `film.css`, `film.js` | The whole film as a function of time: `window.seek(ms)` draws any frame. Camera, pointer and timings read the capture manifest. |
| `render.cjs` | Screenshots every frame in parallel pages. `--from N --to M` re-renders a range. |
| `music.py`, `sfx.py`, `audiolib.py` | The track and the interface sounds, synthesised with numpy. |
| `cues.py`, `mix.py`, `verify_audio.py` | Places the sounds against the picture, mixes and masters, and checks loudness, grid and silence. |

## Captures (cut 4)

`CAP_DIR=$FILM/cap CAP_FILM_POSTER=$FILM/assets/film-poster.jpg node docs/advert/cut4/capture.cjs [shot ...]`
writes every shot (`home ask saved team music habits health graph checkin stills`) and `cap/manifest.json`.
Event times are ms from the shot's first frame; rects are CSS px in the 390x844 viewport (×`scale` for image pixels).

- `ask` and `team` are shot at 6x (2340x5064, `scale: 6` in their manifest entries; `CAP_HI_SCALE` changes it),
  because the film frames them very tight. Every other shot is 3x (1170x2532).
- `saved` writes its own `cover` (the add re-render) and `covers` (add, move and link): the list blanks for a
  frame at add, the item page redraws with a flat placeholder where the poster was at move, and the link tap cuts
  to Watch & read with the tab rail snapping a frame later. Dissolve across them.
- `team`: the sample "From Penny" card's button reads "Ask about it". It says "Open it" only for a nudge that
  already has a conversation, which sample mode's Penny card doesn't have; showing "Open it" needs an app change.
- Sample mode files the film ("Filed in Watch & read") and adds it to the Watch & read page, first in the
  Films row under "Up next" with its poster as the cover. The `saved` shot taps the "Watch & read" link in
  "Filed in Watch & read", scrolls the Films row into view and holds on it (`rects.watchPoster`).
- Route changes run in a View Transition. A paused animation never finishes, so `capture.cjs` finishes the
  transition's animations once the virtual clock passes their end; otherwise the overlay swallows every tap.

Nobody has listened to the track on speakers: it was checked by measurement only (loudness, peaks, onsets on the grid).

## Film poster (cut 4)

The Saved beat pastes a Letterboxd link for Guardians of the Galaxy. In the app,
sample mode shows an illustrated poster (`app/public/sample/saved/film.webp`).
For the film only, `CAP_FILM_POSTER=/path/to/poster.jpg node capture.cjs saved`
serves the studio poster in its place. That poster is kept out of the repo, and
the film needs rights clearance before it is published with it.

## Cut 4 final (round 3)

64.8 s, 1944 frames. Reviewed over three rounds by a transitions, a story and a sound
reviewer (`review/round1..3/`); all three signed off on round 3.

Rebuild, with `FILM=<scratchpad>/film4` and `CAP_DIR=$FILM/cap-r2` (the final captures):

1. Captures: `CAP_DIR=$FILM/cap-r2 CAP_FILM_POSTER=$FILM/assets/film-poster.jpg node docs/advert/cut4/capture.cjs <shot>`
   (capture.cjs refuses to run without an explicit CAP_DIR).
2. Picture: `CAP_DIR=$FILM/cap-r2 node docs/advert/cut4/render.cjs` (writes `$FILM/frames`, `motion-peaks.json`, `film-events.json`).
3. Sound, from `docs/advert/cut4`: `python3 music.py && python3 cues.py && python3 mix.py && python3 verify_audio.py`.
4. Mux: `ffmpeg -framerate 30 -i $FILM/frames/%06d.jpg -i $FILM/audio/mix.wav -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -c:a aac -b:a 256k -movflags +faststart -shortest athena-launch-film-v4.mp4`

The film's Guardians of the Galaxy poster is the studio artwork, kept outside the repo and served
only during capture; it needs clearing before the film is published.

## Captures (cut 5)

`CAP_DIR=$FILM/cap CAP_FILM_POSTER=$FILM/assets/film-poster.jpg node docs/advert/cut5/capture.cjs [shot ...]`
Shots: `home ask saved track music habits work workDone hire health graph checkin stills`. Cut 4's `team` shot
(Penny's card on Home, "Is that a good price?") is gone: Home no longer has that card, and Team is now three shots.
`tellme`, `penny`, `pennyWork` and `pennyDone` are aliases in the manifest (`{ "alias": "track" }` and so on).
`ask`, `track`, `work` and `workDone` are 6x (`scale: 6`); the rest 3x.

- `saved`: on the merged app the two route changes (open the card, tap "Watch & read") cross-fade for about three
  frames in a View Transition, so `covers` now has four entries: `add`, `open`, `move`, `link`.
- `track` (Team 1): the hand balm's page in Saved, "Tell me when" → "At or under" → 28 → "Tell me". The pill, the
  dashed "Your £28" line and the sentence "You asked to hear at £28 or less." land on the frame of `targetSet`
  (the panel is rebuilt in one frame; nothing animates). The form opening pushes the page's lower half down and
  the dock slides away while the field has focus; the Tracking panel itself does not move.
- `work` (Team 2, Home): the pointer picks Penny's chip; "Penny is searching the web for Cedar hand balm" shows
  under the chips with the breathing dot (the travel card moves down 18 px to make room). Sample mode's Penny is
  on that step only until 5 s after the page opens, so the shot starts with the page. At `finish` the clock jumps
  past the end of her run and the line goes back to "Finds good prices for gift ideas".
- `workDone` (Team 2, the balm's page): Penny's £27 check arrives at `check`; the line steps down under the dashed
  target and the sentence reads "£27 at Fenn & Hale, under the £28 you asked for." with the reached mark. One
  frame, no animation: carry the chart (`chartBefore` and `chart` are the same rect). The "Your £28" label moves
  from the right to the left of the line when the step lands (the app keeps it clear of the line).
- `hire` (Team 3): `#/team/new`, the job typed, Continue, the assistant arrives, says hello and what it will do,
  "Skip the questions", "Add <name> to your team", "<name> is on your team", Done, then the Team page scrolls to
  the new face. The app picks the name and look at random; `CAP_HIRE_SEED` (default 1) fixes `Math.random` for
  this shot so they repeat (`rects.assistant` is the name).
- Stills: `tracking` (the moka pot's page: 12 checks at 4 made-up shops, a target, its stock) and `team`.

How the hand balm's BEFORE state is made (sample mode opens with the story finished: Penny's £27 check and the
£28 target are both there at load). All of it is done off camera in the app's own UI, with the clock:

1. The clock is set an hour back and a price is kept by hand ("All checks" → "Add a price": 31, Greenleaf). With
   one check the panel is a sentence alone; with two it draws the step line, so the dashed target has a picture to
   land on. The panel then says "You checked 10 minutes ago" (`track`) or "19 minutes ago" (`workDone`).
2. Penny's check is removed ("All checks" → its ×).
3. For `track`, the target is cleared (the pill's ×) and the toasts run out before the first frame.
4. For `workDone`, the clock is set to a minute after Penny's check and her check comes back through the removal
   toast's Undo at `check`; the toasts are not drawn in that shot (capture-only CSS). It reads "Penny checked
   1 minute ago". Adding £27 by hand instead would say "You checked", and does not animate either.

### Round 1 re-shoots (`$FILM/cap-r1`)

- `track` now waits 1.5 s before the first tap (`CAP_TRACK_WHEN`), so the first frames hold the object: its
  header (`rects.header`, `site`, `title`), the panel, and the "Gift idea for…" row (`rects.giftRow`). The sample
  balm has no photo, and the row reads "Gift idea for…" with "Product · £31 · Greenleaf" (no name in it).
  The amount field's grey "31" is the app's placeholder (the price now); the app has no empty state for it.
- `workDone` adds the same header rects; the title and "Penny checked 1 minute ago" (`rects.foot`) are in every frame.
- `hire` ends on a 2.6 s hold of the Team page with Dot, Wren and the new face whole between the page head and
  the dock. Four cards are 930 px of page, more than a phone shows, so the whole end state is also kept as a
  still on a taller screen: `stills/teamAfter.jpg` (390x1400), with each card in `rects.teamAfter.cards`.
  `rects.saysFrames` are the frames in which "Every Monday at 9:00, I'll tell you what's due this week." is
  whole and at `rects.saysLine`.

## Cut 5 (final, round 2 polish)

81.6 s, 2448 frames, 34 bars. Team is a three-step story on the merged app: "Tell me when" on a
saved gift idea, Penny working and the price stepping under the target, hiring Acorn. Reviewed
over two rounds (`review/round1`, `review/round2`); all three reviewers signed off after the
polish pass. The sections above this one still describe cut 4's commands; for cut 5 use, with
`FILM=<scratchpad>/film5` and `CAP_DIR=$FILM/cap-r1`:

1. Captures: `CAP_DIR=$FILM/cap-r1 CAP_FILM_POSTER=$FILM/assets/film-poster.jpg node docs/advert/cut5/capture.cjs <shot>`
2. Picture: `CAP_DIR=$FILM/cap-r1 node docs/advert/cut5/render.cjs`
3. Sound, from `docs/advert/cut5`: `python3 music.py && python3 cues.py && python3 mix.py && python3 verify_audio.py`
4. Mux as in cut 4, to `athena-launch-film-v5.mp4`.

The price-drop shot is staged through the app's own controls (a check removed off camera and
restored with Undo on camera); see the capture notes above.

## Captures (cut 6)

`CAP_DIR=$FILM/cap CAP_FILM_POSTER=$FILM/assets/film-poster.jpg node docs/advert/cut6/capture.cjs [shot ...]`
Shots: `home ask saved track music habits work workDone hire flow health graph checkin stills`, all re-shot on the
current app with cut 5's event and rect names. What changed:

- `record` now checks every frame for text painted in the viewport (not under the sticky head or the dock):
  "Muse" is a FAIL line, Linear/Amazon/Spotify a NOTE with the frame range. None has "Muse". Spotify is in
  `music` (the "Open in Spotify" press, as before); Linear is in `hire` (see below). `rectOf` returns null for a part
  the app no longer draws instead of failing the shot.
- `track`/`workDone`: the panel's foot is now "Penny checks this · You checked … ago" (`.tk-who`); `foot`,
  `footBefore` and `footText` measure it.
- `saved`: Watch & read opens on a month summary, In progress and For Christmas before "Up next", so the Films
  row is ~1550 px down. The scroll takes 2 s (`scrollStart` 7100, `scrollEnd` 9100) and the shot is 10.6 s (318 frames).
- `hire`: the Team page now has Team chat / New assignment and a "Waiting for you" card, so Dot, Wren and the new
  face can't all fit. The end hold has Wren's card just under the sticky head (144 px) and Acorn whole under it,
  Dot scrolled out (his job line says "Turns Linear issues…"). The job sheet's starter ideas include "When a Linear
  issue is assigned to me, add a to-do" until Continue: `rects.linearStarter`. `stills/teamAfter.jpg` (390x1400)
  holds all four cards, Dot's Linear line included. Penny's live line on the Team page reads "Reading
  fennandhale.example…" then "Reading greenleaf.example…" (sample domains).
- `checkin`: the card's "Morning preparation" / "Evening reflection" cards are not drawn in this shot
  (capture-only CSS, `CAP_CHECKIN_ROUTINES=1` keeps them), so the card is head, "How was today?", Rough…Great.
  New `rects.greatCircle`.
- New `flow` (Flows beat): `#/flows`, the second suggestion card ("You look for a present a week before
  birthdays / Four times since September. Want Athena to do it for you?") left where the app puts it (dismissing
  the first or scrolling brings the Linear flow up under the dock). "Make it a flow" at 1800 ms; the app makes
  "Birthday heads-up" (kept off) and opens its page: When "A week before a birthday, at 9:00", Then "Find gift
  ideas", "Tell me" (the third under the floating Test button). The On switch at 3600 ("Birthday heads-up is on"
  toast). 6 s, 180 frames, 3x. The route change blends for frames 55–57 (`covers` 54–58). The New flow sheet
  ("Make the steps") can't draft in sample mode (it makes an empty flow), so there is no `flowNew`.
- Stills add `flows` (the list) and `flowEditor` (Birthday heads-up, switched on; rects in the manifest's
  `flowEditorStill`). `team` still shows Dot's Linear line.

## Cut 6 (final)

86.4 s, 2592 frames, 36 bars. Every shot re-captured on the public release of the app; a Flows
beat (Athena's "You look for a present a week before birthdays" suggestion → "Make it a flow" →
"Birthday heads-up" switched on); a new acoustic-style score (kalimba, glockenspiel, celesta,
marimba, felt piano, ukulele, upright bass, brushes) at -15 LUFS. Reviewed by a picture reviewer and
a sound reviewer (`review/round1`); their must-fixes are in. Rebuild with
`FILM=<scratchpad>/film6` and `CAP_DIR=$FILM/cap`:

1. `CAP_DIR=$FILM/cap CAP_FILM_POSTER=$FILM/assets/film-poster.jpg node docs/advert/cut6/capture.cjs <shot>`
2. `CAP_DIR=$FILM/cap node docs/advert/cut6/render.cjs`
3. From `docs/advert/cut6`: `python3 music.py && python3 sfx.py && python3 cues.py && python3 mix.py && python3 verify_audio.py`
4. Mux as before, to `athena-launch-film-v6.mp4`.
