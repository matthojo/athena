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
