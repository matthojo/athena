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

After a capture, set `saved.cover` to `{"from": 84, "to": 93}` in `cap/manifest.json`: the Saved list fades out and back as it re-renders, and the compositor dissolves across those frames instead.

Nobody has listened to the track on speakers: it was checked by measurement only (loudness, peaks, onsets on the grid).

## Film poster (cut 4)

The Saved beat pastes a Letterboxd link for Guardians of the Galaxy. In the app,
sample mode shows an illustrated poster (`app/public/sample/saved/film.webp`).
For the film only, `CAP_FILM_POSTER=/path/to/poster.jpg node capture.cjs saved`
serves the studio poster in its place. That poster is kept out of the repo, and
the film needs rights clearance before it is published with it.
