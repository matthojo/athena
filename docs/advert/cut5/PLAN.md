# Cut 5 plan

Cut 5 starts as a copy of cut 4 (`../cut4/` stays as shipped; its three review rounds are in
`../cut4/review/`). The app has moved on: main's new Team work is merged (assistants look things
up online, Tracking with "Tell me when", a visible working state, hiring, tile characters).
Client direction: no length limit; Team becomes a three-step story; the film ends as cut 4 does
(check-in, Great on the chord, orb and wordmark; no end line or URL).

Names: the gift-price assistant is **Penny**. "Muse" must never appear. Sample products and
shops are made up (hand balm, moka pot, Fenn & Hale, Copperkettle); no real brands in Team shots.
The Saved film is still Guardians of the Galaxy with the real poster via `CAP_FILM_POSTER`.

## Timeline: 79.2 s, 33 bars at 100 BPM (bar 2400 ms, beat 600 ms), 2376 frames

| ms | Beat | What happens |
|---|---|---|
| 0–9600 | Opening, dive | As cut 4. |
| 9600–14400 | Home | Train's "12 min late" lands live at 11400. As cut 4. |
| 14400–24000 | Ask | Elena's pricing answer; lift at 19200. As cut 4. |
| 24000–31200 | Saved film | Paste, card, open, Move to Watch & read, poster lands. As cut 4. |
| 31200–36000 | Team 1: "Tell me when" | On a saved gift idea's page (one object for steps 1 and 2; the hand balm fits the sample: saved at £31, later £27, "under the £28 you asked for"), the Tracking panel: tap "Tell me when", "At or under", £28, "Tell me". The target pill and the dashed "Your £28" line appear. |
| 36000–40800 | Music | Evening run playlist, Open in Spotify. As cut 4. |
| 40800–43200 | Habits | Tick, 20 → 21 in a row. As cut 4. |
| 43200–50400 | Team 2: Penny works, then it's reached | Home: the Athena/Penny/Dot/Wren chips and Penny's working line ("Penny is searching the web for …" with the breathing dot). Then the result: the price line steps down under the dashed target, "£27 at Fenn & Hale, under the £28 you asked for." The step down under the line is the money shot; hold it ≥1.5 s. |
| 50400–57600 | Team 3: hire | New assistant: the job typed in one sentence ("Every Monday at 9, tell me what's due this week"), the character appears, says hello, joins the team ("… is on your team"). End on the Team page with the new face beside Penny, Dot and Wren if the app shows it. |
| 57600–62400 | Pull-back | Reveal lands on the 57600 downbeat; wall of 12 screens includes Team and a Tracking page. |
| 62400–70800 | Rotation | "Athena remembers the …"; first readable slots retell the day: platform, pricing call, film, price, run, streak; packed after that; musical steps. |
| 70800 | "good days" | Dead cut; check-in card rises. |
| 72000 | Great | On the final chord. |
| 73800–79200 | Lockup | Great becomes the orb, wordmark slides out; fade last 300 ms. |

## Carry over from cut 4 (all still rules)

- One continuous camera, lopsided eases, motion blur on fast moves, pointer leads.
- Never blend two misaligned layouts at partial opacity: carry the object, or hard cut on the beat
  with the pointer in the same place.
- No whip faster than ~150 px/frame except the pull-back.
- Text that matters holds ≥1.2 s, never cropped by the frame edge; app copy that reads oddly
  (Home greeting, habit header) stays out of frame.
- Sound: whooshes peak on camera peaks, taps on press frames, ticks on swaps, chip sound on the
  late chip, Penny's voice when she appears; the new assistant gets its own small voice when it
  says hello. -14 LUFS, true peak ≤ -1 dBTP, the Great chord is the loudest moment.
- Review with frame GRIDS, not single stills.

## Ownership and paths

- Capture: `capture.cjs`. Motion: `film.html`, `film.css`, `film.js`, `render.cjs`, `swaps.json`,
  `BRIEF.md`. Sound: `music.py`, `sfx.py`, `mix.py`, `audiolib.py`, `cues.py`, `verify_audio.py`.
- `FILM=/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film5`
  (`cap/`, `frames/`, `audio/`, `review/`). capture.cjs needs an explicit `CAP_DIR`.
- Commit only your own files, by name. One agent per role; don't message agents by old names.
