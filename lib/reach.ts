/**
 * Community: what a shared item can reach, worked out from its files and never taken from its author's word. Pure
 * and shared by the server, the app and the catalogue's own checks (each catalogue item carries the Reach its
 * files give; Athena works it out again from the bundle and trusts its own).
 *
 * - Tier 1: a flow whose every step stays inside Athena: finds, adds, checks, questions, waits and pushes.
 * - Tier 2: anything that uses a model (every skill and assistant; a flow's thinking, drafting or assignment steps)
 *   or looks something up outside Athena (the weather, a train, a flight: each named in `lookups`).
 *
 * A set of check-in questions is always tier 1 (owner, 25 Nov 2026). Questions only ask, and answers stay in the
 * owner's Athena (their check-ins, and the day's journal for written answers). "Go deeper" on a written answer sends
 * the question and what the owner wrote to their model for one follow-up, but only when they tap it, as it does for
 * their own questions; the Add screen and the share sheet say so.
 * A note template is always tier 1 too. It's words with {{fields}}, filled only from the owner's own records in their
 * own Athena, and its body is made plain as it's read (lib/template-share.ts), so nothing in it fetches anything.
 * A theme is always tier 1 as well (owner, 25 Nov 2026). It's colours, numbers and a name, read by readTheme(), which
 * keeps nothing that names a typeface or loads anything (lib/theme-share.ts).
 * - Tier 3: it asks to search the web.
 *
 * `needs` is the accounts the file says it needs, by provider, its event trigger's first. A need is never granted
 * by the file: the owner ticks accounts on the preview (lib/shared-limits.ts).
 */
import { readShared, ShareFormatError } from "./team-share";
import { allSharedSteps, checkSharedFlowSteps, FLOW_DRAFT_TOOLS, readSharedFlow, type SharedFlow } from "./flow-share";
import { detectKind, KIND_FILES, kindOfFile, type ShareKind } from "./share-kinds";
import { readSharedCheckins, type SharedCheckins } from "./checkin-share";
import { readSharedTemplate } from "./template-share";
import { readSharedTheme } from "./theme-share";

/** When nothing in a folder names a kind. */
export const NO_KIND_FILE = "There's no assistant.json, SKILL.md, flow.json, checkin.json, template.json or theme.json in that.";

export interface Reach {
  tier: 1 | 2 | 3;
  /** It uses a model: a skill, an assistant, or a flow step that thinks, drafts or starts an assignment. */
  model: boolean;
  /** It asks to search the web. */
  web: boolean;
  /** Outside lookups by tool name, in the order its steps use them: "weather", "train_status". */
  lookups: string[];
  /** Accounts it needs, by provider: "gmail", "linear". */
  needs: string[];
}

/** The outside lookups a flow can make, with the words the preview shows and who answers. */
export const LOOKUP_TOOLS: Readonly<Record<string, { label: string; service: string }>> = {
  weather: { label: "The weather forecast", service: "Open-Meteo" },
  train_status: { label: "Live train times", service: "National Rail" },
  flight_status: { label: "Live flight status", service: "OpenSky" },
};

export const isLookupTool = (tool: string): boolean => Object.prototype.hasOwnProperty.call(LOOKUP_TOOLS, tool);

/** The tier for what an item uses. Pure. */
export function tierOf(r: Pick<Reach, "model" | "web" | "lookups">): Reach["tier"] {
  if (r.web) return 3;
  if (r.model || r.lookups.length) return 2;
  return 1;
}

const reach = (r: Omit<Reach, "tier">): Reach => ({ tier: tierOf(r), ...r });

/** A shared flow's reach. Pure. */
export function reachOfFlow(flow: SharedFlow): Reach {
  let model = false;
  const lookups: string[] = [];
  for (const s of allSharedSteps(flow.steps)) {
    if (s.kind === "think" || s.kind === "assignment") model = true;
    if (s.kind === "tool") {
      if (FLOW_DRAFT_TOOLS.includes(s.tool)) model = true;
      if (isLookupTool(s.tool) && !lookups.includes(s.tool)) lookups.push(s.tool);
    }
  }
  return reach({ model, web: flow.web, lookups, needs: [...flow.needs] });
}

/** A shared assistant's reach: always a model; the web when it asks. Pure. */
export function reachOfAssistant(a: { web: boolean; needs: readonly string[] }): Reach {
  return reach({ model: true, web: a.web, lookups: [], needs: [...a.needs] });
}

/** A skill's reach: a model reads it, and it can ask for nothing more. Pure. */
export function reachOfSkill(): Reach {
  return reach({ model: true, web: false, lookups: [], needs: [] });
}

/** A set of check-in questions' reach: always tier 1. Go deeper reaches a model only when the owner taps it. Pure. */
export function reachOfCheckins(_set: Pick<SharedCheckins, "questions">): Reach {
  return reach({ model: false, web: false, lookups: [], needs: [] });
}

/** A note template's reach: always tier 1. Its fields fill from the owner's own records, and nothing in it fetches. Pure. */
export function reachOfTemplate(): Reach {
  return reach({ model: false, web: false, lookups: [], needs: [] });
}

/** A theme's reach: always tier 1. It's data that only changes how Athena looks, and nothing in it loads. Pure. */
export function reachOfTheme(): Reach {
  return reach({ model: false, web: false, lookups: [], needs: [] });
}

/** The files of an item, as a bundle carries them. */
export interface ReachInput {
  /** Taken from the files when left out. */
  kind?: ShareKind;
  files: ReadonlyArray<{ path: string; text: string }>;
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ShareFormatError(`${file} isn't valid JSON.`);
  }
}

/**
 * What an item's files reach, read from the file that names its kind (the shallowest one). Throws
 * ShareFormatError when the files aren't an item Athena can read, or `kind` doesn't match them. Pure.
 */
export function reachOf(bundle: ReachInput): Reach {
  const kind = detectKind(bundle.files.map((f) => f.path));
  if (!kind) throw new ShareFormatError(NO_KIND_FILE);
  if (bundle.kind && bundle.kind !== kind) throw new ShareFormatError(`That's listed as a ${bundle.kind}, but its files are a ${kind}.`);
  const main = bundle.files
    .filter((f) => kindOfFile(f.path) === kind)
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  switch (kind) {
    case "flow": {
      const flow = readSharedFlow(parseJson(main.text, KIND_FILES.flow));
      checkSharedFlowSteps(flow);
      return reachOfFlow(flow);
    }
    case "assistant":
      return reachOfAssistant(readShared(parseJson(main.text, KIND_FILES.assistant)));
    case "skill":
      return reachOfSkill();
    case "checkin":
      return reachOfCheckins(readSharedCheckins(parseJson(main.text, KIND_FILES.checkin)));
    case "template":
      readSharedTemplate(parseJson(main.text, KIND_FILES.template));
      return reachOfTemplate();
    case "theme":
      readSharedTheme(parseJson(main.text, KIND_FILES.theme));
      return reachOfTheme();
  }
}
