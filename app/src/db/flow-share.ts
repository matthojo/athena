/**
 * Shared flows, for the app (lib/flow-share.ts, lib/flow-share-store.ts and POST /api/flows/<id>/export on the
 * server): a flow as a file someone else can add to their own Athena. Sample mode does the same here, against the
 * sample flows and the sample people, with no server: a download there is flow.json on its own, not a zip.
 *
 * Adding one happens on the `#/add` screen (app/src/db/community.ts); sample mode's Add for a flow is
 * db/flows.ts sampleAddSharedFlow.
 */
import { getToken, isSampleMode, request } from "./api";
import { samplePeople, samplePlaces, sampleOrganisations } from "./sample-data";
import { exportFlow, serialiseSharedFlow, type FlowExport, type FlowExportBlocked, type FlowExportContext } from "../../../lib/flow-share";
import { ShareFormatError, type Finding, type KnownTerm } from "../../../lib/team-share";
import type { Flow } from "../../../lib/flow-types";

export type { FlowExport };
/** What the owner can change in the share sheet. It changes the file, never the flow. */
export type FlowShareEdits = NonNullable<FlowExportContext["edits"]>;

/** Sample mode's own people, places and organisations, as the server would gather them. */
function sampleKnown(): KnownTerm[] {
  const out: KnownTerm[] = [];
  for (const p of samplePeople()) {
    out.push({ term: p.name, kind: "person" });
    const first = p.name.split(" ")[0];
    if (first && first !== p.name) out.push({ term: first, kind: "person", loose: true });
    if (p.email) out.push({ term: p.email, kind: "email" });
  }
  for (const p of samplePlaces()) out.push({ term: p.name, kind: "place" });
  for (const o of sampleOrganisations()) out.push({ term: o.name, kind: "organisation" });
  out.push({ term: "Jordan", kind: "you", loose: true });
  return out;
}

/** The flow as a file to share, with these edits: its questions, what's flagged, what was taken out, what can't go yet. */
export async function checkFlowExport(flow: Flow, edits: FlowShareEdits, fine: string[]): Promise<FlowExport> {
  if (isSampleMode()) {
    try {
      return exportFlow(flow, { ownHosts: [location.hostname], known: sampleKnown(), edits, fine });
    } catch (error) {
      if (error instanceof ShareFormatError) throw new Error(`It can't be shared as it is: ${error.message}`);
      throw error;
    }
  }
  return request<FlowExport>(`/flows/${encodeURIComponent(flow.id)}/export`, { method: "POST", body: JSON.stringify({ edits, fine }) });
}

function save(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2_000);
}

/** What stopped a download: the server looked again and something is still flagged, or a step can't go. */
export interface FlowExportLeft {
  findings: Finding[];
  blocked: FlowExportBlocked[];
}

/**
 * Save the file to this device: a zip with <slug>/flow.json, or flow.json alone in sample mode. The server checks
 * again first and answers with what's left when anything is; nothing is saved then. Null when it saved.
 */
export async function downloadFlowExport(flow: Flow, edits: FlowShareEdits, fine: string[]): Promise<FlowExportLeft | null> {
  if (isSampleMode()) {
    const x = await checkFlowExport(flow, edits, fine);
    if (x.findings.length || x.blocked.length) return { findings: x.findings, blocked: x.blocked };
    save(new Blob([serialiseSharedFlow(x.shared)], { type: "application/json" }), "flow.json");
    return null;
  }
  const token = getToken();
  const res = await fetch(`/api/flows/${encodeURIComponent(flow.id)}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ edits, fine, download: true }),
  });
  if (res.status === 409) {
    const b = (await res.json()) as Partial<FlowExportLeft>;
    return { findings: b.findings ?? [], blocked: b.blocked ?? [] };
  }
  if (!res.ok) {
    const why = await res.json().then((b: { error?: string }) => b.error, () => undefined);
    throw new Error(why ?? "That download didn't work. Try again.");
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "flow.zip";
  save(await res.blob(), name);
  return null;
}
