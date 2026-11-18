/**
 * Before a photo or a PDF goes to a model that can't see it (owner, 17 Nov 2026): Ask's box, and an assistant's
 * chat box, say so first, with "Send anyway" and "Use Claude Sonnet 5.5 for this message". Only when the
 * catalogue says `vision: false` for the turn's thinking model; "unknown" doesn't warn. Pure: tested alone.
 */
import { DEFAULT_MODELS, sameRef, type CatalogueModel, type ModelRef } from "../../../lib/model-types";
import { modelLabel } from "../../../lib/model-label";

/** A file the model would have to see: a photo, or a PDF's pages. */
export const isSeen = (f: { type: string }) => f.type.startsWith("image/") || f.type === "application/pdf";

export interface VisionWarning {
  /** The model that can't see. */
  model: ModelRef;
  name: string;
  /** What it can't see, in words: "photos", "PDF pages", "photos or PDF pages". */
  what: string;
  /** The files it would miss, by name. */
  files: string[];
  /** For this one message instead: the default thinking model. */
  instead: ModelRef;
  insteadName: string;
}

/** The turn's thinking model: an assistant's own when it has one, else the owner's. */
export function thinkingModel(effective: { think: { ref: ModelRef }; assistants?: Record<string, { think: { ref: ModelRef } }> } | null | undefined, assistantId: string | null | undefined): ModelRef | null {
  if (!effective) return null;
  return (assistantId ? effective.assistants?.[assistantId]?.think.ref : undefined) ?? effective.think.ref;
}

/** Should the box warn before sending these files to this model? Null when it can see them, or might. */
export function visionWarning(think: ModelRef | null, catalogue: readonly CatalogueModel[], files: ReadonlyArray<{ type: string; name: string }>): VisionWarning | null {
  if (!think || sameRef(think, DEFAULT_MODELS.think)) return null;
  const seen = files.filter(isSeen);
  if (!seen.length) return null;
  const m = catalogue.find((x) => sameRef(x.ref, think));
  if (m?.abilities.vision !== false) return null;
  const photos = seen.some((f) => f.type.startsWith("image/"));
  const pdfs = seen.some((f) => f.type === "application/pdf");
  return {
    model: think,
    name: m.blurb ? m.name : modelLabel(think),
    what: photos && pdfs ? "photos or PDF pages" : photos ? "photos" : "PDF pages",
    files: seen.map((f) => f.name),
    instead: DEFAULT_MODELS.think,
    insteadName: modelLabel(DEFAULT_MODELS.think),
  };
}

/** The warning's words: "GPT-5.5 nano can't see photos." and what that means for this message. */
export function visionWords(w: VisionWarning): { title: string; body: string; anyway: string; use: string } {
  const one = w.files.length === 1;
  return {
    title: `${w.name} can't see ${w.what}.`,
    body: one ? `It would answer without seeing ${w.files[0]}.` : `It would answer without seeing these ${w.files.length} files.`,
    anyway: "Send anyway",
    use: `Use ${w.insteadName} for this message`,
  };
}
