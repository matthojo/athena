# Athena advert (parked)

A 60-second advert, "Always with you". It's parked: two cuts exist and the owner will pick it up later. Nothing here is part of the app or the build.

- **Cut 1:** lifestyle shots intercut with the app on a floating phone, with a calm piano bed.
- **Cut 2 (current):** real app cards float above each person's phone, tracked through the shot, with an upbeat instrumental.

The rendered videos aren't in the repo. The owner has both cuts, and the source media lives in the services below, so nothing needs generating again.

## Where the media is

**Runway** (Kling 3.0 Pro, 1080p, 24fps, 60 credits per 5s). Cut 2 uses these 10s clips, by task ID:

| Scene | Task |
|---|---|
| Kitchen at dawn | `0b86c21e-6527-4d80-836d-29a877afbcde` |
| Train platform | `1dfa6195-9974-4f96-a416-552bea43bf4c` |
| Café, Ask by voice | `aef8102b-3ef0-41af-b90c-3a59ca54733f` |
| Market stall | `00f094f3-b44d-41e1-8845-35bbbb93c1e5` |
| Riverside, wheelchair | `8f0f45a7-8e3c-4670-a43b-04c1e6e28b2c` |
| Sofa at night | `b62eb4b7-215b-40f8-8273-05714a05bbd0` |

Cut 1's 5s clips are also in the Runway library, under the same prompts.

**ElevenLabs** flows:

- **"Athena advert audio":**
  - The voiceover, take 1 of the voice "Charlotte - British Female", model eleven_v4. The full read is in `script.md`.
  - The calm music (cut 1).
  - The upbeat instrumental (cut 2 uses the second take).
  - A transcript with word timings.
- **"Athena UI sounds":** the seven interface sounds, four takes each.

## Pipeline

All scripts are in `pipeline/`. They expect a working folder (`AD_DIR`) containing:

- `life10/` with the downloaded clips `a1.mp4` to `a6.mp4`
- `ov/` with the card overlays `o1.mov` to `o6.mov` (ProRes 4444 with alpha)
- `app/` with the end card `s13.mp4`
- `audio/` with the voiceover and music

To get footage on the same 24fps timeline as cut 2, download the clips again from the task IDs above.

| Script | What it does |
|---|---|
| `capture2.cjs`, `comp.py`, `endcard.cjs` | Cut 1's product shots: the app in sample mode, frame-stepped with a fake clock, captured at 3x and composited into a phone. Also the end card. |
| `capture3.cjs`, `o4rects.cjs`, `ov.py` | Cut 2's card overlays: transparent per-card captures with a rise-in, shadow and stroke, written as ProRes 4444. |
| `track.py` | Tracks the phone in a clip with OpenCV CSRT, forwards and backwards from a seed box, then smooths the result. `python track.py clip.mp4 seed_s x y w h out.json` |
| `composite.py` | Floats an overlay up and to the right of the tracked phone, adds a soft light on the phone and fades the card if the shot ends first. |
| `assemble.sh` | Builds cut 1. |
| `build2.sh` | Builds cut 2: the six composited scenes plus the end card, with effects placed on the card moments, mixed with the voiceover and ducked music. |

You'll need:

- The app dev server: `npm run dev:app -- --port 5199`. Captures use sample mode, so no real data is used.
- Playwright.
- ffmpeg.
- A Python virtualenv with `opencv-contrib-python-headless` and `numpy`.

## Open notes for the next pass

- The Ask card's footer reads "sample data". Mask it out.
- The morning card shows the full four-leg trip and is tall. Consider showing two legs.
- In the riverside scene the phone is held sideways. Reshoot it upright (60 credits).
- The train delay card is staged for capture: sample mode is late from the start, so the delay is hidden, then revealed.
