/**
 * Assignments, for the app (docs/team.md "Routes and client";
 * /api/team/assignments on the server). Sample mode keeps its own set
 * (db/sample-assignments.ts) and every change stays on this page.
 */
import { ApiError, getToken, isSampleMode, request } from "./api";
import { createAssistant, listTeam } from "./team";
import { sampleAssignments } from "./sample-assignments";
import { teamFull } from "../team/assign-words";
import { MAX_ASSISTANTS, type TeamAssistant } from "../../../lib/team-types";
import type { Assignment, Checkpoint, DocumentFile, KeptAssistant, Lineup, StageAnswer, Suggestions } from "../../../lib/assignment-types";

export type { Assignment, Lineup };

const BASE = "/team/assignments";
const at = (id: string, rest = "") => `${BASE}/${encodeURIComponent(id)}${rest}`;
const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const listeners = new Set<() => void>();
/** An assignment started, moved on, was answered, stopped or removed: Team chat, its page and the counts follow. */
export function onAssignmentsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** Tell everything that shows assignments to look again (Team chat does after a plan's Go). */
export const assignmentsChanged = (): void => listeners.forEach((fn) => fn());

/** The server counts stages from 1; the app counts from 0, as its lists do. Changed here, on the way in and out. */
const fromWire = (a: Assignment): Assignment => ({ ...a, stages: a.stages.map((s) => ({ ...s, position: s.position - 1, sent_back_from: s.sent_back_from == null ? null : s.sent_back_from - 1 })) });

/** The server may answer with the assignment itself or `{ assignment }`. */
const one = (r: Assignment | { assignment: Assignment }): Assignment => fromWire("assignment" in r ? r.assignment : r);

async function change(sample: () => Assignment, real: () => Promise<Assignment | { assignment: Assignment }>): Promise<Assignment> {
  const a = isSampleMode() ? sample() : one(await real());
  assignmentsChanged();
  return a;
}

/** A proposed lineup for a brief. `fallback`: the plain one, when the model's didn't check out. Nothing runs before Go. */
export async function draftLineup(text: string): Promise<{ lineup: Lineup; fallback?: boolean }> {
  if (isSampleMode()) {
    await new Promise((r) => setTimeout(r, 700));
    return sampleAssignments().draft(text);
  }
  return request(`${BASE}/lineup`, json("POST", { text }));
}

/** Go on the lineup card: the accepted lineup starts. `draftId`: the draft Ask's start_assignment kept, which this replaces. */
export async function startAssignment(lineup: Lineup, draftId?: string | null): Promise<Assignment> {
  const team = isSampleMode() ? await listTeam() : [];
  return change(
    () => sampleAssignments().start(lineup, team),
    () => request(BASE, json("POST", draftId ? { ...lineup, id: draftId } : lineup))
  );
}

/** Newest first. */
export async function listAssignments(): Promise<Assignment[]> {
  if (isSampleMode()) return sampleAssignments().list();
  const r = await request<Assignment[] | { assignments: Assignment[] }>(BASE);
  return (Array.isArray(r) ? r : r.assignments).map(fromWire);
}

export async function getAssignment(id: string): Promise<Assignment | null> {
  if (isSampleMode()) return sampleAssignments().get(id);
  try {
    return one(await request<Assignment | { assignment: Assignment }>(at(id)));
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

/** The default checkpoint, or whether questions take the suggested answer. */
export const patchAssignment = (id: string, patch: { checkpoint?: Checkpoint; suggestions?: Suggestions }): Promise<Assignment> =>
  change(
    () => sampleAssignments().patch(id, patch),
    () => request(at(id), json("PATCH", patch))
  );

/** A stage that hasn't run: whether it stops for approval. `n` is its position. */
export const patchStage = (id: string, n: number, patch: { checkpoint: Checkpoint }): Promise<Assignment> =>
  change(
    () => sampleAssignments().patchStage(id, n, patch),
    () => request(at(id, `/stages/${n + 1}`), json("PATCH", patch))
  );

/** Approve the stage that waits. */
export const go = (id: string): Promise<Assignment> =>
  change(
    () => sampleAssignments().go(id),
    () => request(at(id, "/go"), json("POST"))
  );

/** Answer the waiting stage's questions, or take its suggestions (`from_here`: and every later one's). */
export const answer = (id: string, answers: StageAnswer[] | { use: "suggested"; from_here?: boolean }): Promise<Assignment> =>
  change(
    () => sampleAssignments().answer(id, answers),
    () => request(at(id, "/answer"), json("POST", Array.isArray(answers) ? { answers } : answers))
  );

/** Send the work back to the waiting stage or an earlier one (`to`: its position), with a note. */
export const sendBack = (id: string, input: { to: number; note: string }): Promise<Assignment> =>
  change(
    () => sampleAssignments().sendBack(id, input),
    () => request(at(id, "/send-back"), json("POST", { ...input, to: input.to + 1 }))
  );

export const stop = (id: string): Promise<Assignment> =>
  change(
    () => sampleAssignments().stop(id),
    () => request(at(id, "/stop"), json("POST"))
  );

export async function deleteAssignment(id: string): Promise<void> {
  if (isSampleMode()) sampleAssignments().remove(id);
  else await request<unknown>(at(id), json("DELETE"));
  assignmentsChanged();
}

/**
 * "Keep <Name> on the team": a guest becomes a standing assistant. The
 * server answers 409 when the team is full; its words (or ours, the same)
 * come back as the error's message.
 */
export async function keepAssistant(id: string): Promise<TeamAssistant> {
  let kept: TeamAssistant;
  if (isSampleMode()) {
    const guest = sampleAssignments().guestOf(id);
    if (!guest) throw new Error("That guest isn't there any more");
    if ((await listTeam()).length >= MAX_ASSISTANTS) throw new ApiError(teamFull(guest.name), 409);
    kept = await createAssistant({ name: guest.name, job: guest.job, instructions: guest.job, avatar: guest.avatar, allow: [] });
    sampleAssignments().kept(id, kept.id);
  } else {
    try {
      kept = (await request<KeptAssistant>(`/team/${encodeURIComponent(id)}/keep`, json("POST"))).assistant;
    } catch (error) {
      if ((error as { status?: number }).status === 409 && !(error as Error).message?.trim()) throw new ApiError("Your team is full. Remove an assistant first.", 409);
      throw error;
    }
  }
  assignmentsChanged();
  return kept;
}

/** A document's bytes, through GET /api/files/:id/download, saved under its own name. */
export async function downloadDocument(file: DocumentFile): Promise<void> {
  let blob: Blob;
  if (isSampleMode()) blob = new Blob([`# ${file.name.replace(/\.\w+$/, "")}\n\nThis is sample data, so the file holds only this line.\n`], { type: "text/markdown" });
  else {
    const token = getToken();
    const res = await fetch(`/api/files/${encodeURIComponent(file.file_id)}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
    blob = await res.blob();
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: isSampleMode() ? file.name.replace(/\.docx$/, ".md") : file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
