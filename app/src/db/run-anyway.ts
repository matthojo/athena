/**
 * Run anyway (lib/spend.ts, docs/ai-models.md): when Ask couldn't check today's AI budget, its reply carries a
 * one-time token. The notice (components/spend-notice.ts) arms it for the message it's about, then sends that
 * message again; askAthena (db/api.ts) takes it once. Any other message, or a second send, goes without it.
 */
let armed: { token: string; question: string } | null = null;

/** The next send of `question` carries `token`, once. */
export function armRunAnyway(token: string, question: string): void {
  armed = { token, question: question.trim() };
}

/** The request body's `run_anyway`, for this send only: the armed token when it's for this message. Always disarms. */
export function runAnywayFlag(question: string): { run_anyway?: string } {
  const a = armed;
  armed = null;
  return a && a.question === question.trim() ? { run_anyway: a.token } : {};
}

/** When a token stops being honoured (ms since epoch), from its first part; 0 when it can't be read. */
export function runAnywayUntil(token: string): number {
  const part = token.split(".")[0] ?? "";
  return /^[0-9a-z]{1,12}$/.test(part) ? parseInt(part, 36) : 0;
}
