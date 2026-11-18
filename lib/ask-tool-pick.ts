/**
 * Which of a connected account's tools an answer is offered, and what to do
 * with a tool whose definition the model's provider won't take.
 *
 * Some servers offer hundreds of tools (PostHog: over 300). Sending them all
 * with every question costs time and money, crowds out the ones that matter,
 * and one bad definition among them fails the whole request. So an account
 * with many tools offers the ones that fit the question: its words against
 * each tool's name and description, with the service's usual search tools
 * kept in front.
 *
 * A definition the provider refuses is the server's own (Athena doesn't
 * write it). The tool stays, with a plain "any object" definition: the
 * model reads the description and the server still checks what it's sent.
 * Which tools needed that is remembered for as long as this server runs, so
 * the next question doesn't find out again.
 *
 * Pure but for that memory.
 */

/** An account offers at most this many tools to one answer. */
export const MAX_TOOLS_PER_ACCOUNT = 16;

const STOP = new Set(
  "the a an and or of to in on at for from with by is are was were be been do does did what which who whom when where why how my our your their me we you it its this that these those current status latest any some all about into over can could should would will tell show give get got have has had".split(" "),
);

/** A message's words that could name a thing: lower case, no stop words, plurals folded ("experiments" → "experiment"). */
export function questionWords(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return [...out];
}

export interface PickableTool {
  name: string;
  description: string;
}

/** How well a tool fits the question: a word in its name counts three times one in its description. */
export function toolFit(words: string[], tool: PickableTool): number {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let score = 0;
  for (const w of words) {
    if (name.includes(w)) score += 3;
    else if (description.includes(w)) score += 1;
  }
  return score;
}

/**
 * The tools of one account to offer for this question: all of them when
 * there are few; otherwise the best fits, in the order given (the caller
 * puts the service's usual tools first), topped up from the front when few
 * fit. The order of what's kept doesn't change.
 */
export function pickTools<T extends PickableTool>(question: string, tools: T[], max = MAX_TOOLS_PER_ACCOUNT): T[] {
  if (tools.length <= max) return tools;
  const words = questionWords(question);
  const ranked = tools.map((tool, i) => ({ tool, i, fit: toolFit(words, tool) }));
  const keep = new Set(
    [...ranked]
      .sort((a, b) => b.fit - a.fit || a.i - b.i)
      .slice(0, max)
      .map((x) => x.i),
  );
  return ranked.filter((x) => keep.has(x.i)).map((x) => x.tool);
}

// ---------- Definitions the provider refused ----------

/** What a refused tool is offered with instead: any object. The description still says what it takes. */
export const ANY_OBJECT = { type: "object", additionalProperties: true } as const;

const refused = new Set<string>();

/** Was this tool's own definition refused before, since this server started? */
export const wasRefused = (name: string): boolean => refused.has(name);
export const rememberRefused = (name: string): void => void refused.add(name);
/** For tests. */
export const forgetRefused = (): void => refused.clear();
