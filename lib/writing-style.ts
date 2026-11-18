/**
 * How anything an AI writes into Athena should read: notes, to-dos, catch-up
 * summaries, details about people and event notes. The aim is notes that read
 * as if the owner jotted them, without the stock phrasing models fall back on
 * (em dashes, "delve", "pivotal", sum-up closers and so on).
 *
 * NOTE_STYLE goes into every prompt that writes to Athena: the collection
 * recipes, the Ask assistant and the MCP server. styleProblems() is the
 * mechanical half: the collection runner uses it to send a save back once for
 * a rewrite, and the MCP server reports it on note writes.
 *
 * The checker only looks for things that are almost never right in a note.
 * Words that are fine in a literal sense (landscape, navigate, ecosystem, key)
 * are left to the prompt. Quotes, code and link labels are skipped, because
 * they're someone else's words or names.
 */

export const NOTE_STYLE = `Writing style for everything you save (note titles and bodies, to-dos, catch-up summaries, details about people, event notes):
- Write like the owner jotting their own notes: plain, short and specific. Keep the names, dates, numbers and decisions from the source, and add nothing to make it sound better.
- No em dashes (— or --). Use a comma, a colon, a full stop or brackets instead. In a title, separate the parts with " · ".
- No inflated or filler words: delve, leverage, robust, seamless, pivotal, crucial, comprehensive, meticulous, landscape, tapestry, realm, ecosystem, synergy, navigate, foster, streamline, empower, underscore, showcase, utilise, "in order to", "serves as", "it's worth noting", "notably", "key takeaways".
- Don't tell the owner what something means or how important it is ("a pivotal moment", "highlights the importance of", "marks a shift"). Say what happened.
- No "it's not X, it's Y" reversals, no rhetorical questions, no padding things out into threes, and no closing line that sums up ("Overall, …", "In summary, …").
- When the source names who said or decided something, name them. Never "the team felt" or "stakeholders agreed". If the source doesn't say, leave it out rather than guess.
- Bold almost never. Use a list only for a real list (decisions, action items). Headings in sentence case.
- Quoted words, and names or subject lines copied from the source, stay exactly as the source has them, even when they break these rules.`;

/** The same rules in one line, for tool descriptions where space is tight. */
export const NOTE_STYLE_SHORT =
  "Write plainly, like the owner's own notes: no em dashes (use a comma, colon, full stop or brackets; ' · ' in titles), " +
  "no filler such as delve, leverage, robust, seamless, pivotal, crucial, 'in order to', 'it's worth noting', " +
  "and no sum-up closers. Quotes and names copied from the source stay as they are.";

/** For emails Athena drafts for the owner to send (lib/drafts.ts): their voice, not a note's. */
export const EMAIL_STYLE = `How to write the email:
- Write as the owner, in the first person, to someone they know. Warm, direct and short: two to five sentences is usual. British English.
- Open with their first name ("Hi Priya,"). Say the point in the first sentence. No "I hope this email finds you well", "just circling back", "per my last email" or "I wanted to reach out".
- Plain text only: no Markdown, no bold, no bullet points unless it's a genuine list of items.
- No em dashes (— or --). Use a comma, a full stop or brackets. None of: delve, leverage, robust, seamless, pivotal, crucial, synergy, "in order to", "it's worth noting".
- Only say what the context supports. Never claim something is attached, done or agreed unless the context says so. If the owner has to add something before sending (a file, a figure, a time), leave one short note in square brackets where it goes, like [attach the deck].
- Chasing someone: friendly, no guilt. Remind them what they offered and, if it helps, give an easy next step.
- End with a short sign-off line ("Thanks," or "Best,") and no name: their email signature adds it.`;

/** For a text message (SMS or iMessage) the owner sends from their phone. */
export const TEXT_STYLE = `How to write the text:
- Write as the owner, in the first person, to someone they know. One to three short sentences, under 300 characters. British English.
- Casual and direct, the way people text: no "Dear", no subject, no sign-off and no name at the end. A first name to open is fine but not needed.
- Plain text only: no Markdown, no lists, no links unless the context gives one.
- No em dashes (— or --). None of: delve, leverage, robust, seamless, pivotal, crucial, "in order to", "it's worth noting".
- Only say what the context supports. If the owner has to add something before sending (a time, a figure), leave one short note in square brackets where it goes, like [add the time].
- An emoji only if the owner's own messages to them use them.`;

/** For a WhatsApp (or Telegram) message: as casual as a text, a little room for detail. */
export const WHATSAPP_STYLE = `How to write the WhatsApp message:
- Write as the owner, in the first person, to someone they know. One to four short sentences, under 400 characters. British English.
- Casual and friendly, the way people write on WhatsApp: no "Dear", no subject, no sign-off and no name at the end.
- Plain text only: no Markdown headings or bullet points. Line breaks are fine between two separate thoughts.
- No em dashes (— or --). None of: delve, leverage, robust, seamless, pivotal, crucial, "in order to", "it's worth noting".
- Only say what the context supports. If the owner has to add something before sending, leave one short note in square brackets where it goes, like [add the address].`;

/** For a Slack DM: short and plain, work-friendly. */
export const SLACK_STYLE = `How to write the Slack message:
- Write as the owner, in the first person, to a colleague or someone they work with. One to three sentences, under 500 characters. British English.
- Short and plain: say the point first. Open with "Hi Priya" or just the point; no sign-off, no name at the end, no "Hope you're well".
- No Markdown headings or bold. A short list only for separate items, like three links.
- No em dashes (— or --). None of: delve, leverage, robust, seamless, pivotal, crucial, synergy, "in order to", "it's worth noting", "circle back", "touch base".
- Only say what the context supports. If the owner has to add something before sending, leave one short note in square brackets where it goes, like [link the doc].`;

/** For a Telegram message: the same as WhatsApp. */
export const TELEGRAM_STYLE = WHATSAPP_STYLE.replace(/WhatsApp/g, "Telegram");

export type MessageChannel = "email" | "text" | "whatsapp" | "telegram" | "slack";

/** The writing rules for a draft on that channel. */
export function messageStyle(channel: MessageChannel): string {
  return channel === "text" ? TEXT_STYLE : channel === "whatsapp" ? WHATSAPP_STYLE : channel === "telegram" ? TELEGRAM_STYLE : channel === "slack" ? SLACK_STYLE : EMAIL_STYLE;
}

/** How long a message on each channel can run before it reads like an email. Email has no cap. */
export const MESSAGE_MAX_CHARS: Readonly<Record<MessageChannel, number | null>> = { email: null, text: 320, whatsapp: 450, telegram: 450, slack: 600 };

const EMAIL_OPENERS: Array<[RegExp, string]> = [
  [/\bhope (?:this|the) (?:e-?mail|message) finds you\b/i, "\"hope this email finds you well\""],
  [/\b(?:just )?circling back\b/i, "\"circling back\""],
  [/\bper my last (?:e-?mail|message)\b/i, "\"per my last email\""],
  [/\bI (?:wanted|just wanted) to reach out\b/i, "\"I wanted to reach out\""],
  [/\btouch(?:ing)? base\b/i, "\"touch base\""],
];

/**
 * What in a draft breaks its channel's rules: everything styleProblems
 * finds, the stock email openers, and for texts, WhatsApp and Slack a
 * sign-off, Markdown or running too long. Empty when it's fine.
 */
export function messageStyleProblems(text: string, channel: MessageChannel): string[] {
  const problems = styleProblems(text);
  const prose = ownProse(text);
  for (const [pattern, label] of EMAIL_OPENERS) if (pattern.test(prose)) problems.push(label);
  if (channel === "email") return problems;
  const max = MESSAGE_MAX_CHARS[channel];
  if (max && text.trim().length > max) problems.push(`longer than ${max} characters`);
  // A sign-off on its own line at the end: "Thanks,", "Best,", "Cheers, Jordan".
  if (/\n\s*(?:thanks|many thanks|best|best wishes|kind regards|regards|cheers|all the best|warmly)\b[^\n]{0,20}$/i.test(text.trim())) problems.push("a sign-off");
  if (/^\s*dear\b/i.test(text)) problems.push('"Dear"');
  if (/\*\*[^*\n]+\*\*|^#{1,6}\s/m.test(text)) problems.push("Markdown");
  if (channel !== "slack" && /^\s*[-*•]\s/m.test(text)) problems.push("bullet points");
  return problems;
}

const WORDS: Array<[RegExp, string]> = [
  [/\bdelv(?:e|es|ed|ing)\b/i, "delve"],
  [/\bleverag(?:e|es|ed|ing)\b/i, "leverage"],
  [/\brobust(?:ly|ness)?\b/i, "robust"],
  [/\bseamless(?:ly)?\b/i, "seamless"],
  [/\bpivotal\b/i, "pivotal"],
  [/\bcrucial(?:ly)?\b/i, "crucial"],
  [/\bcomprehensive(?:ly)?\b/i, "comprehensive"],
  [/\bmeticulous(?:ly)?\b/i, "meticulous"],
  [/\btapestry\b/i, "tapestry"],
  [/\bsynerg(?:y|ies|istic)\b/i, "synergy"],
  [/\bunderscor(?:e|es|ed|ing)\b/i, "underscore"],
  [/\bshowcas(?:e|es|ed|ing)\b/i, "showcase"],
  [/\butili[sz](?:e|es|ed|ing|ation)\b/i, "utilise"],
  [/\bgame[- ]?chang(?:er|ers|ing)\b/i, "game-changer"],
  [/\btestament to\b/i, "testament to"],
  [/\bin order to\b/i, "in order to"],
  [/\bserv(?:es|ed|ing) as\b/i, "serves as"],
  [/\b(?:it'?s|it is) worth noting\b/i, "it's worth noting"],
  [/(?:^|[.!?]\s+)notably\b/im, "notably"],
  [/\bkey takeaways?\b/i, "key takeaways"],
  [/(?:^|[.!?]\s+)(?:overall|in summary|in conclusion|to summari[sz]e),/im, "a sum-up closer"],
];

/** Drop the parts that aren't the writer's own prose: code, quotes, link labels and URLs. */
function ownProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/\[[^\]\n]*\]\([^)\s]*\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/“[^”\n]*”/g, " ")
    .replace(/"[^"\n]*"/g, " ");
}

/**
 * What in `text` breaks NOTE_STYLE, as short descriptions ("em dash",
 * "\"leverage\""). Empty when it's fine.
 */
export function styleProblems(text: string): string[] {
  const prose = ownProse(text);
  const problems: string[] = [];
  // Em dashes, the "--" stand-in, and a spaced en dash used as a dash (unspaced ranges like 9–10 are fine).
  if (/—|\s--\s|\s–\s/.test(prose)) problems.push("em dash");
  for (const [pattern, label] of WORDS) if (pattern.test(prose)) problems.push(label === "a sum-up closer" ? label : `"${label}"`);
  return problems;
}
