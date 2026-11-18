/**
 * Sample mode's own kind of record, so the feature shows without a server:
 * Wines, with Grape (a choice), Region (text), Rating (stars) and Price (a
 * number in £), and four bottles. Château Musar links to Priya, and a sample
 * note mentions it, so Linked, Mentioned in and the Graph all have something
 * to show. Same rules as sample-data.ts: stable ids, only ever shown with
 * the "Sample data" status pill.
 */

import { SAMPLE_IDS } from "./sample-data";
import { customKindKey, type CustomField, type FieldValue } from "../../../lib/custom-field-rules";
import type { CustomKind, CustomRecord } from "../types";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
// Clear of sample-data.ts (≤ 405), sample-memory.ts (500–999) and sample-fields.ts' reading items (950s).
const rid = (n: number) => `5a3e0000-0000-4000-8000-${String(1100 + n).padStart(12, "0")}`;
const fid = (n: number) => `5a3e0000-0000-4000-8000-00000000c${String(100 + n).padStart(3, "0")}`;

export const SAMPLE_KIND_IDS = {
  wines: "5a3e0000-0000-4000-8000-000000001100",
  musar: rid(1),
  tondonia: rid(2),
  barbaresco: rid(3),
  bourgogne: rid(4),
  grape: fid(1),
  region: fid(2),
  rating: fid(3),
  price: fid(4),
} as const;

const WINES = customKindKey(SAMPLE_KIND_IDS.wines);

export function sampleKinds(): CustomKind[] {
  return [
    {
      id: SAMPLE_KIND_IDS.wines,
      kind: WINES,
      name: "Wines",
      one: "wine",
      icon: "wine",
      position: 0,
      record_count: 4,
      archived_at: null,
      created_at: daysAgo(60),
      updated_at: daysAgo(60),
    },
  ];
}

export function sampleKindRecords(): CustomRecord[] {
  const r = (id: string, title: string, body: string, ago: number): CustomRecord => ({
    id,
    kind_id: SAMPLE_KIND_IDS.wines,
    title,
    body,
    archived_at: null,
    created_at: daysAgo(ago + 20),
    updated_at: daysAgo(ago),
  });
  return [
    r(
      SAMPLE_KIND_IDS.musar,
      "Château Musar 2017",
      `Recommended by [@Priya Shah](athena://person/${SAMPLE_IDS.priya}). Smoky, with dried cherries and a long finish. Open an hour before.`,
      4,
    ),
    r(SAMPLE_KIND_IDS.tondonia, "Viña Tondonia Reserva 2012", "Old-school Rioja: savoury, leather and red fruit. Worth keeping a few years.", 12),
    r(SAMPLE_KIND_IDS.barbaresco, "Produttori del Barbaresco 2019", "Roses and tar. Wants food: mushrooms or a slow ragù.", 26),
    r(SAMPLE_KIND_IDS.bourgogne, "Bourgogne Pinot Noir, Domaine Faiveley", "Easy weeknight bottle. Light, bright red fruit.", 40),
  ];
}

/** Wines' fields, joined to sample-fields.ts's own. */
export function sampleKindFields(): CustomField[] {
  const f = (id: string, position: number, label: string, type: CustomField["type"], extra: Partial<CustomField> = {}): CustomField => ({
    id,
    kind: WINES,
    label,
    type,
    options: [],
    unit: "",
    position,
    value_count: 0,
    archived_at: null,
    created_at: daysAgo(60),
    updated_at: daysAgo(60),
    ...extra,
  });
  return [
    f(SAMPLE_KIND_IDS.grape, 0, "Grape", "choice", { options: ["Cinsault", "Nebbiolo", "Pinot Noir", "Syrah", "Tempranillo"] }),
    f(SAMPLE_KIND_IDS.region, 1, "Region", "text"),
    f(SAMPLE_KIND_IDS.rating, 2, "Rating", "rating"),
    f(SAMPLE_KIND_IDS.price, 3, "Price", "number", { unit: "£" }),
  ];
}

export function sampleKindValues(): Array<{ kind: typeof WINES; entity_id: string; field_id: string; value: FieldValue }> {
  const rows: Array<[string, string, string, number, number]> = [
    [SAMPLE_KIND_IDS.musar, "Cinsault", "Bekaa Valley, Lebanon", 5, 32],
    [SAMPLE_KIND_IDS.tondonia, "Tempranillo", "Rioja, Spain", 4, 38],
    [SAMPLE_KIND_IDS.barbaresco, "Nebbiolo", "Piedmont, Italy", 5, 35],
    [SAMPLE_KIND_IDS.bourgogne, "Pinot Noir", "Burgundy, France", 3, 18],
  ];
  return rows.flatMap(([id, grape, region, rating, price]) => [
    { kind: WINES, entity_id: id, field_id: SAMPLE_KIND_IDS.grape, value: grape },
    { kind: WINES, entity_id: id, field_id: SAMPLE_KIND_IDS.region, value: region },
    { kind: WINES, entity_id: id, field_id: SAMPLE_KIND_IDS.rating, value: rating },
    { kind: WINES, entity_id: id, field_id: SAMPLE_KIND_IDS.price, value: price },
  ]);
}
