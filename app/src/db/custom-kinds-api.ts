/**
 * The routes for the owner's own kinds of record and their records
 * (netlify/lib/custom-kinds-routes.ts), kept out of api.ts like the custom
 * fields routes. Archiving and permanent delete go through api.ts's
 * setArchived / deleteEntity (kinds "kind" and "record").
 */

import { request } from "./api";
import type { CustomField, FieldType, FieldValue } from "../../../lib/custom-field-rules";
import type { CustomKind, CustomRecord } from "../types";

export async function fetchKinds(includeArchived = false): Promise<CustomKind[]> {
  const { kinds } = await request<{ kinds: CustomKind[] }>(`/kinds${includeArchived ? "?archived=1" : ""}`);
  return kinds;
}

export interface KindInput {
  name?: string;
  /** One of it, for sentences ("wine"); worked out from the name when left out. */
  one?: string;
  icon?: string;
  /** Fields to start with (new kinds only). */
  fields?: Array<{ label: string; type: FieldType; options?: string[]; unit?: string }>;
}

export async function createKind(input: KindInput): Promise<{ kind: CustomKind; fields: CustomField[] }> {
  return request("/kinds", { method: "POST", body: JSON.stringify(input) });
}

export async function updateKind(id: string, patch: KindInput): Promise<CustomKind> {
  return request<CustomKind>(`/kinds/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function reorderKinds(ids: string[]): Promise<CustomKind[]> {
  const { kinds } = await request<{ kinds: CustomKind[] }>("/kinds/order", { method: "POST", body: JSON.stringify({ ids }) });
  return kinds;
}

export async function duplicateKind(id: string): Promise<{ kind: CustomKind; fields: CustomField[] }> {
  return request(`/kinds/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
}

export async function fetchRecords(kindId: string): Promise<CustomRecord[]> {
  const { items } = await request<{ items: CustomRecord[] }>(`/records?${new URLSearchParams({ kind: kindId }).toString()}`);
  return items;
}

/** One record; a 404 (ApiError) when it, or its kind, is archived or gone. */
export async function fetchRecord(id: string): Promise<CustomRecord> {
  return request<CustomRecord>(`/records/${encodeURIComponent(id)}`);
}

export interface RecordInput {
  title?: string;
  body?: string;
  /** Field values by field id or name. */
  values?: Record<string, FieldValue | null>;
}

export async function createRecord(kindId: string, input: RecordInput): Promise<CustomRecord> {
  return request<CustomRecord>("/records", { method: "POST", body: JSON.stringify({ kind: kindId, ...input }) });
}

export async function updateRecord(id: string, patch: RecordInput): Promise<CustomRecord> {
  return request<CustomRecord>(`/records/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function duplicateRecord(id: string): Promise<CustomRecord> {
  return request<CustomRecord>(`/records/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
}
