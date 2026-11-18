/**
 * The step shown while Ask waits on a busy gateway. One id and one pair of
 * lines for both waits: the app's own retry (app/src/lib/ask-retry.ts) and
 * the server's, while lib/ai.ts waits out a refusal for up to a minute
 * (lib/answer.ts). The same id, so one line replaces the other. Pure, no
 * imports: the app bundles it.
 */
export const BUSY_STEP_ID = "ask-busy";
export const BUSY_STEP_FIRST = "Athena's AI is busy. Trying again shortly";
export const BUSY_STEP_AGAIN = "Still busy. Trying again";
