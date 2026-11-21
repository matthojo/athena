# Cut 4 story review (creative director)

Grids are in `review4/r1/`: `all-a`, `all-b` (every 15f); `b1-open`, `b2-home`, `b3-ask`, `b4-saved`, `b5-team`, `b6-music-habit`, `b7-wall`, `b8-rot`, `b9-end` (every 3–6f); `ask-legib`, `saved-legib`, `team-full`, `mid-legib` (large tiles); `ref-grid` (reference ad).

## Cut 3 issues: status

| # | Issue | Status |
|---|---|---|
| 1 | Ask payoff unreadable | **Better.** The scale is right now, but the copy is still 65 words, a camera drift crops the left edge, and lines run off the bottom (see new issue 3). |
| 2 | The day contradicts itself | **Half fixed.** The playlist and habit both say "Evening run". The BA 432 Lisbon flight, "Live times unavailable" and Hertz hire are still in the Home hero shot (9.0–14.4). |
| 3 | Music: Athena does nothing | **Better.** The stats scroll is gone and the tile grows into the sheet. Nothing is pressed after that, and the sheet sits idle for 2 s (38.4–40.4). |
| 4 | Health beat | **Fixed** (cut). |
| 5 | Rotation callbacks | **Fixed.** platform → pricing call → film → gift idea → run → streak, each up ≥0.6 s. |
| 6 | Slow opening | **Fixed.** Line complete by 6.4, dive at 7.2. |
| 7 | Machine-sounding copy | **Mostly fixed.** The greeting is framed out. "Live times unavailable" is still visible 10.0–11.4, then sliced in half by the bottom edge until 14.4. |
| 8 | Logo too brief | **Fixed**, maybe overcorrected: the lockup is complete at 60.2 and then holds static for 4.4 s. |
| 9 | Still pointer on the wall | **Fixed.** |

## New issues, worst first

**1. The gift is for Sophie, but the setup said Priya (33.6–34.4, `b5-team`).** The Ask chips at 15.4–17.2 set up "Remind me to get something for Priya's birthday". Penny's detail line then says "Penny found a lower price for the moka pot on **Sophie's** gift ideas." That breaks the one setup and payoff the film has. Fix the sample copy in `app/src/components/nudge-card.ts:56–57` to "Priya's gift ideas" / "for Priya", then re-capture.

**2. The Team beat doesn't sell Team, and its second half can't be read (31.6–35.8, `b5-team`, `team-full`).** The card itself is good. It is tight, the cat with glasses reads, and "The moka pot is down to £34" is legible at phone size. But nothing says Penny is one of *your team of helpers*. The Athena · Penny · Dot · Wren strip appears for only 0.2 s at 9.8, cropped at the top. After the card, the pointer heads for "Why am I seeing this?" (33.6) rather than a clear action. Penny's 30-word reply finishes at 35.2 and is whipped away by 35.7. Fixes:
- Land at 31.6 framed on the Home chip strip with Penny's chip active. Tilt down to the card by 32.0.
- Cut the detail screen (33.6–34.4).
- Tap "Ask about it" straight into the chat.
- Shorten the reply to one line: "£34 at John Lewis, £8 under. You've bought there before." Hold it ≥1200 ms.

**3. The Ask still asks too much of the viewer (17.2–23.6, `b3-ask`, `ask-legib`).**
- (a) After send, the question disappears and the screen is empty for 1.2 s (17.4–18.6) while the pointer wanders. Capture the sent bubble ("What did Elena say about pricing?") above "5 steps" and keep it in frame.
- (b) The answer is complete by about 21.0, and at 3–4 words/s nobody gets past sentence one. Cut the sample to two lines: "Elena wants to keep Starter as is and test a higher Pro price with new customers. She'd like your view by next Friday."
- (c) A drift from 21.4 to 23.6 crops "Elena" to "ena" on the left. Lock the camera's x, with ≥60 px of margin left of the text.

**4. Home is passive and still says "airport" (9.0–14.4, `b2-home`).** The "12 min late" chip is already on screen at 9.0 and never lands, so for 5 s nothing happens. Below it, "BA 432 to Lisbon" (plus BA and Hertz marks) tells a flight story the evening run contradicts. Fixes:
- Capture the chip arriving at 11400, as planned.
- Change the travelling card sample to a commute train only.
- Or, at minimum, set the frame's bottom edge above the BA row, about 1.15× tighter centred on the train row. That also removes the sliced half-line.

**5. Saved opens too wide (24.6–27.0, `b4-saved`, `saved-legib`).** The phone column is about 25% of the frame width, so the paste and the new card are tiny at phone size. Push in to about 1.6× on the input row (25000–26000), then follow the card. On landing, "Move to Watch & read" leads to a screen titled "Up next" (30.0). Tilt up about 120 px so the "Watch & read" header is in frame by 30400 and the cause and effect reads.

**6. Music and Habit don't pay off "run" or "streak" (36.4–42.8, `b6-music-habit`, `mid-legib`).**
- Music: press "Open in Spotify" at about 39600. Right now the ring lands on the "Ferro" artist chip (38.0), which reads as a stray tap.
- Habit: the sample says "2 in a row", which undercuts "Athena remembers the streak" nine seconds later. Make it 12+ in a row.
- Habit: push in on the card at 41.6–42.6 so the tick and the count read.

**7. The clock disagrees with the day.** Penny says 07:15 and her chat says 07:55, yet the beat sits after the pricing call and the film. Capture Penny at around 13:10 to match the order.

**8. The ending.** The lockup holds 4.4 s with nothing new, and there's no availability or CTA. Either add a line under the wordmark at 61200 (e.g. "On iPhone"), or give 1.2 s back to issue 2. Separately, at 59.8 the orb emerges near the card's top-left, not out of the pressed Great button (detail is the transitions reviewer's area).

## Protect

- The opening's timing.
- The film poster carrying into Watch & read (29.4–30.0).
- The Penny card's framing (32.0–33.4).
- The first six rotation slots and their quarter-note spacing.
- The dead cut to "good days" with "How was today?" rising.
- Great pressed on the chord (57.6).
- The wall's pointer drift.
