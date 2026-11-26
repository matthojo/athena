/**
 * A model's name as the owner reads it, from its gateway id alone: "gemini-3.5-flash" is "Gemini 3.5 Flash",
 * "claude-sonnet-5-5" is "Claude Sonnet 5.5", "gpt-image-2" is "GPT Image 2". For the "Answered with" line and a
 * picture's receipt, where the catalogue (GET /api/models) may not be at hand. Pure: the server and the app share it.
 */
import { PROVIDER_NAMES, type ModelRef } from "./model-types";

const WORDS: Record<string, string> = { gpt: "GPT", gemini: "Gemini", claude: "Claude", llama: "Llama", ai: "AI", mini: "mini", nano: "nano", oss: "OSS" };

/** "Claude Sonnet 5.5", "Gemini 3 Pro Image", "GPT-5.5", "GPT Image 2". OpenRouter's own prefix ("deepseek/") goes. */
export function modelLabel(ref: ModelRef): string {
  const id = ref.model.split("/").pop()!.replace(/[-_](preview|latest|exp|experimental)$/i, "").replace(/-\d{8}$/, "");
  // "claude-sonnet-5-5": a version written with dashes, at the end.
  const dashed = /^(.*?)-(\d+)-(\d+)$/.exec(id);
  const parts = (dashed ? `${dashed[1]}-${dashed[2]}.${dashed[3]}` : id).split("-").filter(Boolean);
  // "gpt-5.5": GPT keeps its hyphen before a version.
  if (parts[0]?.toLowerCase() === "gpt" && /^\d/.test(parts[1] ?? "")) return [`GPT-${parts[1]}`, ...parts.slice(2).map(word)].join(" ");
  return parts.map(word).join(" ") || ref.model;
}

function word(w: string): string {
  const known = WORDS[w.toLowerCase()];
  if (known) return known;
  if (/^\d/.test(w)) return w;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** The company, as the app names it: "Google" for Gemini. */
export const companyOf = (ref: ModelRef): string => PROVIDER_NAMES[ref.provider];

/** "Gemini" or "Claude": the family a model is known by, for short lines ("Gemini didn't answer"). The company when there's no family. */
export function familyOf(ref: ModelRef): string {
  const first = modelLabel(ref).split(/[\s-]/)[0];
  return ["Claude", "Gemini", "GPT", "Llama"].includes(first) ? first : companyOf(ref);
}

/**
 * The line under a reply that fell back: "Gemini 3.5 Flash didn't answer, so Claude Sonnet 5.5 did." It names the
 * model that didn't answer when the reply carries `tried`; without it, "Your chosen model".
 */
export function fellBackLine(answered: ModelRef, tried?: ModelRef | null): string {
  const who = tried && !(tried.provider === answered.provider && tried.model === answered.model) ? modelLabel(tried) : "Your chosen model";
  return `${who} didn't answer, so ${modelLabel(answered)} did.`;
}
