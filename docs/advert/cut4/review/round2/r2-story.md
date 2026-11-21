# Cut 4 round 2 story review (creative director)

Film: `cut4-r1.mp4`. The grids are in `review4/r2/`:
- Whole film: `all-a`, `all-b`.
- Beats: `b2-home`, `b3-ask`, `b4-saved`, `b5-team`, `b6-music-habit`, `b9-end`.
- Frame by frame: `team-dx1`, `team-dx2`, `team-reply`, `habit-tick`, `music-press`.
- Large: `team-legib`, `greet`.

## Round 1 issues

| # | Issue | Status | Evidence |
|---|---|---|---|
| 1 | Sophie vs Priya | **Fixed** | 34.0 "Penny found a lower price for the moka pot on Priya's gift ideas" (`b5-team`) |
| 2 | Team doesn't sell Team; reply unreadable | **Better** | The strip sits above the train card for all of Home (9.8–14.0) and opens the Team beat (31.6–32.0). Still wrong: the Athena chip is the selected one, not Penny's. Two 6-frame double exposures (32.07–32.27, the train card showing through Penny's card; 33.73–33.93, two headlines stacked). The detail screen is still in (33.9–34.4). The reply holds about 800 ms (34.85–35.65), not ≥1200 (`team-dx1`, `team-dx2`, `team-reply`) |
| 3 | Ask overload | **Fixed** | The question bubble stays on screen 17.8–19.6. Two sentences with no crop, held 2.8 s, plus the "Pricing check-in with Elena · Call · Granola" source card. Only 2 near-blank frames remain, at 17.4–17.6 (`b3-ask`) |
| 4 | Home passive, airport story | **Better** | "On time" flips to "12 min late" live at 11.4, which is a real moment. The BA 432 / Hertz rows are still in frame 8.4–11.2, with a sliced flight row at 10.6–11.2 (`b2-home`) |
| 5 | Saved too wide; "Up next" | **Fixed** | The paste row reads at 25.4–26.2, and the "Watch & read" title is in frame on landing at 30.0–30.6 (`b4-saved`) |
| 6 | Music/Habit don't pay off | **Better** | "Open in Spotify" is pressed (39.5–39.9), but it's tiny and nothing follows. The streak is real (20 → 21), but "21 in a row" appears at 42.47 and blurs at 42.70, about 250 ms (`habit-tick`, `music-press`) |
| 7 | Clock vs story | **Fixed** | Penny's card says 12:30 and her chat 13:10 |
| 8 | Ending | Client decision (not counted) | Side note for transitions: "Ath" overprints the fading card at 59.9, and the "a" of the wordmark is clipped at 60.0 (`b9-end`) |

## Remaining issues, worst first

**1. The habit payoff flashes by (42.47–42.70).** The count is the beat's whole point and the setup for "streak" in the rotation. Move the tick to about 41700 so "21 in a row" lands by about 42000 and holds ≥700 ms before the 42.8 move. The wall downbeat stays at 43200. If the capture allows, have the count change on the same frame as the tick.

**2. Team: link Penny's chip to her card, and give her reply its time (31.6–35.7).**
- Before the tilt, add a 300 ms press ring on the **Penny** chip at about 31800, so her chip and her card read as one character. At the moment the selected chip is Athena's.
- Cut the detail screen (33.9–34.4) and go straight from "Ask about it" to the chat. That also removes the stacked-headline exposure.
- Give the freed ~500 ms to the reply hold (≥1300 ms).
- Fix the train card showing through Penny's card at 32.07–32.27: Home's scroll must finish before her card is drawn.
- Reply copy: it repeats the card ("£8 under what it was when you saved it"). Make it add something, e.g. "Yes. £34 is the lowest since you saved it. Good time to buy."

**3. The machine-sounding greeting is back on screen (31.0–31.9, `greet`).** "Mentoring with Priya at 16:00 is today, and four new notes" passes through in large type, sliced by the top edge, as the camera lands for Team. Either start the Team frame with its top edge on the "Ask Athena" bar, or change the sample copy to "Mentoring with Priya at 4, and four new notes."

**4. Home opens on the flight (8.4–11.2).** The camera only tightens after the landing. Put the final crop on the 9300 keyframe so BA 432 and Hertz never show and nothing is sliced at 10.6–11.2.

**5. The Music payoff is too small to see (39.5–39.9).** The button is about 10 px tall at phone size, and the press leads nowhere. Push in to about 1.5× on "Open in Spotify" between 39200 and 39900. Or show a one-line "Opening Spotify…" toast after the press.

**6. Smaller points:**
- The habit header "Evening run is on a run of 20 days" (41.0–41.6) reads as an accidental pun. Change it to "20 days in a row".
- 28.4–29.6: the "Good afternoon / Mentoring…" column peeks in at the right edge. Crop it out or blur it.

## Protect

- The live "On time → 12 min late" flip.
- The chip strip above the train card in Home.
- The Ask answer with its source card.
- The paste push-in and the poster carrying into Watch & read.
- Penny's card framing (32.4–33.6).
- The rotation's first six slots.
- The good-days lift with Great on the chord.

## Verdict

The story now holds together. It reads as one day, and every beat has an action and a readable result. That is a big step from v1. I wouldn't ship it yet: the 250 ms streak count and the Team beat's double exposures and short reply hold make it look unfinished on a second viewing. Fixing issues 1 and 2 is about a day of timing and capture work, and after that I'd ship.

**The single change that lifts it most** is to tie Penny's chip to her card: press-ring on Penny's chip, her card arrives, cut the detail screen, hold her reply for 1.3 s. It turns the new feature from "a notification" into "one of your team did this for you".
