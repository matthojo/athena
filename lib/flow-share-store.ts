/**
 * Shared flows on the server (lib/flow-share.ts has the format and the pure parts): sharing a flow as a file, and
 * adding one someone shared.
 *
 * - `exportFlowFor`: POST /api/flows/<id>/export. The flow as a file to share, with the owner's edits, links into
 *   their Athena taken out, record ids turned into questions, and the personal-data check run against their own
 *   people, places and the rest (lib/team-share-store.ts knownTerms). Nothing is kept: the edits only change the file.
 * - `flowZip`: the download, once nothing is flagged and no step is blocked.
 * - `addSharedFlow`: what the `#/add` screen's Add does for a flow. The file is read again, never trusted; the flow
 *   is created off, origin `shared`, every tool step waiting for Go, money and the web off, with the owner's answers
 *   in its blanks and any they left listed as unfilled. A catalogue item keeps its listing's id, hash and version.
 */
import { AthenaInputError } from "./db";
import { createFlow, getFlow } from "./flows";
import { knownTerms } from "./team-share-store";
import { writeSkillZip } from "./skill-zip";
import { MAX_QUESTION, MAX_SUMMARY } from "./team-skill";
import { ShareFormatError, type KnownTerm } from "./team-share";
import { exportFlow, FLOW_FILE, importSharedFlow, readSharedFlow, serialiseSharedFlow, type FlowAnswers, type FlowExport, type FlowExportContext, type SharedFlow, type SharedFlowAsk } from "./flow-share";
import { FLOW_LIMITS, VALUE_KINDS, type ValueKind } from "./flow-types";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const CATALOGUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^sha256-[0-9a-f]{64}$/;

/** The sheet's edits, as the server takes them: only what the file can carry, cut to its limits. */
export function readFlowEdits(raw: unknown): NonNullable<FlowExportContext["edits"]> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const asks: SharedFlowAsk[] | undefined = Array.isArray(r.asks)
    ? r.asks
        .slice(0, 20)
        .filter((a): a is Record<string, unknown> => !!a && typeof a === "object" && typeof (a as { key?: unknown }).key === "string" && KEY.test((a as { key: string }).key))
        .map((a) => ({
          key: a.key as string,
          question: str(a.question, MAX_QUESTION * 2) ?? "",
          choices: [],
          fills: (VALUE_KINDS as readonly string[]).includes(a.fills as string) ? (a.fills as ValueKind) : "text",
        }))
    : undefined;
  return {
    name: str(r.name, FLOW_LIMITS.name * 2),
    summary: str(r.summary, MAX_SUMMARY * 2),
    version: str(r.version, 20),
    author: str(r.author, 40),
    asks,
  };
}

/**
 * The flow as a file to share, ready to look over: edits applied, links into this Athena taken out, record ids made
 * questions, the check run. `opts.body` is the request: `{ edits?, fine? }`. Throws AthenaInputError (404) when the
 * flow is gone, and with words when it can't be written as a file.
 */
export async function exportFlowFor(id: string, opts: { body?: Record<string, unknown>; hosts: string[]; known?: KnownTerm[] }): Promise<FlowExport> {
  const flow = await getFlow(id);
  if (!flow) throw new AthenaInputError("That flow isn't there any more", 404);
  const body = opts.body ?? {};
  const fine = Array.isArray(body.fine) ? body.fine.filter((f): f is string => typeof f === "string").slice(0, 200) : [];
  const known = opts.known ?? (await knownTerms());
  try {
    return exportFlow(flow, { ownHosts: opts.hosts, known, edits: readFlowEdits(body.edits), fine });
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(`It can't be shared as it is: ${error.message}`);
    throw error;
  }
}

/** The download: <slug>/flow.json in a zip. */
export function flowZip(x: FlowExport): Uint8Array {
  return writeSkillZip([{ path: `${x.slug}/${FLOW_FILE}`, text: serialiseSharedFlow(x.shared) }]);
}

/**
 * Add a shared flow: read again (whatever the caller says it is), blanks filled from `answers`, created off with
 * origin `shared`. Steps that think stay without an assistant until the owner picks one of theirs; blanks left
 * unanswered stay as unfilled fields. Throws AthenaInputError with words for the owner.
 */
export async function addSharedFlow(shared: SharedFlow, answers: FlowAnswers, catalogue?: { id: string; hash: string; version?: string }): Promise<{ id: string }> {
  let input;
  try {
    input = importSharedFlow(readSharedFlow(shared), answers ?? {});
  } catch (error) {
    if (error instanceof ShareFormatError) throw new AthenaInputError(error.message);
    throw error;
  }
  const { unfilled, ...flowInput } = input;
  let listing: { id: string; hash: string; version?: string } | undefined;
  if (catalogue) {
    if (!CATALOGUE_ID.test(catalogue.id) || !HASH.test(catalogue.hash)) throw new AthenaInputError("That catalogue listing isn't one Athena can read.");
    const version = typeof catalogue.version === "string" ? catalogue.version.trim().slice(0, 20) : "";
    listing = { id: catalogue.id, hash: catalogue.hash, ...(version ? { version } : {}) };
  }
  const flow = await createFlow(flowInput, { unfilled, catalogue: listing });
  return { id: flow.id };
}
