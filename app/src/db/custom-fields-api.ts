/**
 * The custom fields routes (netlify/lib/custom-fields-routes.ts), kept out of
 * api.ts so both db/custom-fields.ts and the outbox (db/sync.ts) can call
 * them without importing each other.
 */

import { request } from "./api";
import type { CustomField, CustomValue, FieldKind, FieldType, FieldValue } from "../../../lib/custom-field-rules";

export async function fetchFields(includeArchived = false): Promise<CustomField[]> {
  const { fields } = await request<{ fields: CustomField[] }>(`/custom-fields${includeArchived ? "?archived=1" : ""}`);
  return fields;
}

export interface FieldInput {
  kind?: FieldKind;
  label?: string;
  type?: FieldType;
  options?: string[];
  /** Options renamed in this edit: values using `from` follow to `to`. */
  renames?: Array<{ from: string; to: string }>;
  unit?: string;
}

export async function createField(input: FieldInput): Promise<CustomField> {
  return request<CustomField>("/custom-fields", { method: "POST", body: JSON.stringify(input) });
}

export async function updateField(id: string, patch: FieldInput): Promise<CustomField> {
  return request<CustomField>(`/custom-fields/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function archiveField(id: string, archived: boolean): Promise<CustomField> {
  return request<CustomField>(`/custom-fields/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`, { method: "POST" });
}

export async function reorderFields(kind: FieldKind, ids: string[]): Promise<CustomField[]> {
  const { fields } = await request<{ fields: CustomField[] }>("/custom-fields/order", { method: "POST", body: JSON.stringify({ kind, ids }) });
  return fields;
}

/** A kind's live fields and their values: every record's, or one record's. */
export async function fetchValues(kind: FieldKind, id?: string): Promise<{ fields: CustomField[]; values: CustomValue[] }> {
  const qs = new URLSearchParams({ kind });
  if (id) qs.set("id", id);
  return request(`/custom-values?${qs.toString()}`);
}

export async function putValue(input: { field_id: string; entity_id: string; entity_kind: FieldKind; value: FieldValue | null }): Promise<{ field: CustomField; value: CustomValue | null }> {
  return request("/custom-values", { method: "PUT", body: JSON.stringify(input) });
}
