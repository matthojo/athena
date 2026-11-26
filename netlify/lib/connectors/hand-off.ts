/**
 * Handing work to a background function (collect-run.ts, backfill-run.ts):
 * how long to wait for it, and what counts as it taking the work.
 */

/** A hand-off waits this long for the background function to answer (it answers 202 at once). */
export const HAND_OFF_MS = 5_000;

/**
 * Did a background function take the hand-off? It answers 202 once deployed
 * and 204 under `netlify dev`. A redirect or a 200 is never it (the login
 * page, say), so neither counts; hand-offs are sent with redirect "manual".
 */
export const handedOff = (status: number): boolean => status === 202 || status === 204;
