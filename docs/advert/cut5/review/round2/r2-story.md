# Cut 5 round 2 story review (cut5-r1, 81.6 s)

Grids are in `review5/r2/`:
- `all-b`: 28–64 s, every 15f.
- `t2`: 46.4–50.4, every 6f.
- `t3`: 53.0–60.2, every 6f.
- `swap`: 57.4–58.0, every frame.
- `legib`: four frames at half resolution.

## Round 1 must-fixes

| # | Issue | Status | Evidence |
|---|---|---|---|
| 1 | Step 1: what the object is | **Fixed** (gift cue is an accepted app limit) | "Cedar hand balm, 75ml" with Greenleaf is sharp 31.9–32.6, then the camera tilts to Tracking. |
| 2 | Step 2 tied to step 1 | **Fixed, but legibility got worse** | The title, "£27 at Fenn & Hale, under the £28 you asked for" and "Penny checked 1 minute ago" are all in frame 48.2–50.0, and the working line matches the title. The whole card is now framed, though, so the phone column is about 30% of the frame width. The price line and the step are about half their r0 size (`t2`, `legib`). |
| 3 | Hire pulls out | **Fixed** | It stays tight. "Reading the job…" shows 54.6–55.1, and Acorn is revealed in place at 55.2. |
| 4 | What Acorn will do | **Fixed** | "Acorn · Tells you what's due this week" plus her reply "Every Monday at 9:00, I'll tell you what's due this week." hold 55.6–56.8. Then "Acorn is on your team" (57.0–57.5). |
| 5 | Team page | **Fixed within the app limit** | Wren and Acorn are held 58.0–59.6, about 1.6 s. Acorn's avatar flies into her card (57.6–57.9) with no text overprint. Dot's jargon is out of frame. |

## Verdict: ship after two small fixes

The three Team steps now read in order: set a target on the hand balm; Penny searches, then the price steps under the target; hire Acorn, who says what she'll do and joins the team. Both fixes below are camera or capture work only.

## Must-fix

**1. The real brand "Linear" is on screen (53.6–54.2, `t3`).** After typing, the camera follows the sheet down to its suggestion list. The first suggestion, "When a Linear issue is assigned to me, add a to-do", is readable for about 600 ms. That breaks the brief (no real brands in Team shots), and it's work jargon. Pick one:
- Keep the frame on the input and the "Continue" press, with the bottom edge above "Or start from one of these".
- Or capture the sheet with the suggestions hidden or collapsed.

**2. The money shot has shrunk (48.2–50.0, `t2`).** Framing the whole card made the step under "Your £28" and the "£27 at Fenn & Hale" line small. They're fine on a TV and marginal on a phone. Keep the r1 composition for 48.0–48.6 so the title, then the price line and step, read. Then push in about 1.4× on the price line and chart by 48.9, keeping "Penny checked 1 minute ago" just inside the bottom edge. Hold to 50.0. The title can leave the top edge by then, since it has already been read.

## Nice-to-haves

- **Gift cue:** the app never says the balm is for Priya, so step 1 reads as "something I want", not "a gift". If the client wants the gift read, the cheapest place for it is sample copy outside the app limit. Use a rotation slot ("gift idea" in place of "price"), or have Penny's working line say "…for Cedar hand balm, 75ml (gift idea)" if that line is sample copy.
- **Pronoun:** Acorn's card says "**His** first run is Monday at 9:00" (58.0–59.6), but the character reads as female (flower, blazer). Change it to "Her", or to "First run: Monday at 9:00".
- **Wren's card** brings the Lisbon trip back ("booked the Lisbon trip. Two things slipped: th…", 58.0–59.6). Swap it for a domestic line, e.g. "met Elena twice, and kept your evening run going".
- **The Team hold shows two helpers.** A slow 300–400 px tilt from the bottom of Penny's card down to Acorn across 58.0–59.6 would show three faces and sell "team" harder.

## Protect

- The page head landing in Team 1.
- Penny's working line with the selected chip (44.4–46.2).
- The "Listening… → Reading the job… → Acorn" sequence.
- Acorn's job line.
- The avatar flight into the Team page.
- Everything carried over from cut 4.
