# Cut 4 round 3 story review (final pass)

Film: `cut4-r2.mp4`. Grids are in `review4/r3/`: `all-a` and `all-b` (whole film, every 15f), `home` and `habit-music` (every 3f), `team` (every 3f), `end` (every 2f).

## Round 2 issues

| # | Issue | Status | Evidence |
|---|---|---|---|
| 1 | Habit payoff flashes by | **Fixed** | The tick lands at about 41.8. "21 in a row" is sharp 41.9–42.7, about 800 ms (`habit-music`). |
| 2 | Team: Penny chip, detail page, double exposures, reply hold, reply copy | **Fixed** | The pointer presses Penny's chip at 31.8–32.0, then the camera scrolls to her card. The card holds 32.55–33.7. The tap cuts straight to the chat (33.8) with "Penny · Looking at your gift ideas…". The new reply is complete at 34.6 and sharp until about 35.7 (1.1 s). Neither double exposure is there any more (`team`). |
| 3 | Greeting in frame | **Fixed** (motion only) | "new notes." passes blurred at 31.4–31.6 and is out of frame once the camera settles at 31.7. |
| 4 | Home opens on the flight | **Mostly fixed** | The tight crop holds from 9.2. "10:40 BA 432 to Lisbon" is still legible at the bottom edge during the landing push, 8.6–9.1 (`home`). |
| 5 | Spotify payoff too small | **Fixed** | The push-in reads, and "Open in Spotify" is pressed at 39.65–39.8 (`habit-music`). |
| 6 | Copy nits | Out of scope | The habit header wording and the right-edge column peek were not rechecked as must-fix. |
| — | Lockup (client call) | Re-staged, works | The orb rises out of the pressed Great (59.6–59.9) and the wordmark slides out from under it (60.0–60.2). Nothing is overprinted or clipped any more (`end`). |

Nothing got worse.

## Verdict: ship

The day reads as one story: late train, pricing answer, film filed, Penny's price find, run playlist, streak, "good days". Each beat has a visible action and a result you can read in the time it's up. The Team beat now sells Team: a chip strip of four helpers, a press on Penny, her card, then her one-line answer.

## Must-fix

None. Nothing left is something a first-time viewer would notice at phone or TV size.

## Nice-to-haves (only if there's a spare render)

1. **Home landing, 8.6–9.1.** The flight row is readable at the bottom edge for about 500 ms during the push. Reach the tight crop about 300 ms earlier (by 8800), or end the push with the bottom edge above the flight row.
2. **Penny's reply hold, 34.6–35.7.** It holds 1.1 s against the 1.2 s target. Start the Music move 100–150 ms later if the music grid allows. Otherwise leave it.
3. **The scroll from the chip strip to the card, 32.1–32.4.** Four frames are fully smeared. Cap the blur samples a little so the card's top edge stays legible as it arrives. (Transitions call.)
4. **Penny's card hold, 32.55–33.7, about 1.15 s.** The headline reads. The body line ("That's £8 under…") doesn't for a first-time viewer, but that's acceptable because the reply restates it.
