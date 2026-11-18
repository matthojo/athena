/**
 * Is a message asking for something to watch? Pure, with no imports, so the
 * app can use it (lib/watch-tonight.ts reads the database).
 */

const WHEN = "(?:tonight|this evening|later|now|next|today|this weekend|this afternoon|together)";

/**
 * A message asking for something to watch, in any of the ways people say
 * it: "Something to watch tonight", "What's something we can watch
 * tonight?", "what should we watch?", "pick a film for tonight". Ask
 * answers those from the owner's own list (GET /api/watch-tonight), not by
 * searching notes for the word "watch".
 *
 * Not one: a question about the past ("what did we watch last night?"), or
 * about a named title ("where can I watch Dune?", "what can I watch
 * Severance on?"), which are for the written answer.
 */
export function asksWhatToWatch(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  if (!t || t.length > 90) return false;
  if (/\b(did|watched|was|were|have (?:i|we)|had|last night|yesterday|last (?:week|month|year)|ago)\b/.test(t)) return false;
  if (!/\b(?:what|what's|whats|something|anything|suggest|recommend|pick|choose|find|give (?:me|us)|got any|any|ideas?)\b/.test(t)) return false;
  // "… watch", with nothing after it but when, who with or what for: no title follows.
  const tail = /\b(?:to watch|(?:can|could|should|shall|do|might|will) (?:i|we) watch|(?:i|we) (?:can|could|should) watch)((?: (?:tonight|this evening|later|now|next|today|this weekend|this afternoon|together|with (?:the |my |our )?[a-z]+|for (?:the |my |our )?[a-z ]{1,20}))*)\s*[?.!]*$/.exec(t);
  if (tail) return true;
  // "a film for tonight", "what film tonight", "film night ideas".
  return new RegExp(`\\b(?:film|movie|show|series|box ?set)s?\\b[^?.!]{0,30}\\b${WHEN}\\b\\s*[?.!]*$`).test(t) || /\b(?:film|movie) night\b/.test(t);
}
