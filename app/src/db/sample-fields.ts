/**
 * Sample mode's own fields, so the feature shows without a server, every type
 * somewhere: Shoe size, Clothing size and Interests on people, Rating and
 * Would recommend on Watch & read, Good for, Booking link and Last
 * visited on places, How we know them on organisations, Dress code on events,
 * and the sample Wines' Grape, Region, Rating and Price (sample-kinds.ts).
 * Same rules as sample-data.ts: stable ids, only ever shown with the "Sample
 * data" status pill.
 */

import { SAMPLE_IDS } from "./sample-data";
import { sampleKindFields, sampleKindValues } from "./sample-kinds";
import { addDays } from "../../../lib/dates";
import { localToday } from "../lib/time";
import type { CustomField, FieldKind, FieldType, FieldValue } from "../../../lib/custom-field-rules";

const fid = (n: number) => `5a3e0000-0000-4000-8000-00000000c${String(n).padStart(3, "0")}`;
const reading = (n: number) => `5a3e0000-0000-4000-8000-${String(950 + n).padStart(12, "0")}`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

export const SAMPLE_FIELD_IDS = {
  shoe: fid(1),
  size: fid(2),
  interests: fid(3),
  rating: fid(4),
  recommend: fid(5),
  goodFor: fid(6),
  booking: fid(7),
  visited: fid(8),
  howWeMet: fid(9),
  dressCode: fid(10),
} as const;

export function sampleFields(): CustomField[] {
  const f = (id: string, kind: FieldKind, position: number, label: string, type: FieldType, extra: Partial<CustomField> = {}): CustomField => ({
    id,
    kind,
    label,
    type,
    options: [],
    unit: "",
    position,
    value_count: 0,
    archived_at: null,
    created_at: daysAgo(40),
    updated_at: daysAgo(40),
    ...extra,
  });
  return [
    f(SAMPLE_FIELD_IDS.shoe, "person", 0, "Shoe size", "number", { unit: "UK" }),
    f(SAMPLE_FIELD_IDS.size, "person", 1, "Clothing size", "choice", { options: ["XS", "S", "M", "L", "XL"] }),
    f(SAMPLE_FIELD_IDS.interests, "person", 2, "Interests", "choices", { options: ["Climbing", "Crosswords", "Design", "Gardening", "Jazz", "Running"] }),
    f(SAMPLE_FIELD_IDS.rating, "reading", 0, "Rating", "rating"),
    f(SAMPLE_FIELD_IDS.recommend, "reading", 1, "Would recommend", "boolean"),
    f(SAMPLE_FIELD_IDS.goodFor, "place", 0, "Good for", "choices", { options: ["Dinner", "Lunch", "Groups", "A quiet catch-up"] }),
    f(SAMPLE_FIELD_IDS.booking, "place", 1, "Booking link", "link"),
    f(SAMPLE_FIELD_IDS.visited, "place", 2, "Last visited", "date"),
    f(SAMPLE_FIELD_IDS.howWeMet, "organisation", 0, "How we know them", "long_text"),
    f(SAMPLE_FIELD_IDS.dressCode, "event", 0, "Dress code", "text"),
    ...sampleKindFields(),
  ];
}

export interface SampleValue {
  kind: FieldKind;
  entity_id: string;
  field_id: string;
  value: FieldValue;
}

export function sampleValues(): SampleValue[] {
  const v = (kind: FieldKind, entity_id: string, field_id: string, value: FieldValue): SampleValue => ({ kind, entity_id, field_id, value });
  return [
    v("person", SAMPLE_IDS.priya, SAMPLE_FIELD_IDS.shoe, 6),
    v("person", SAMPLE_IDS.priya, SAMPLE_FIELD_IDS.size, "M"),
    v("person", SAMPLE_IDS.priya, SAMPLE_FIELD_IDS.interests, ["Design", "Running"]),
    v("person", SAMPLE_IDS.mum, SAMPLE_FIELD_IDS.shoe, 5),
    v("person", SAMPLE_IDS.mum, SAMPLE_FIELD_IDS.interests, ["Gardening", "Crosswords"]),
    v("person", SAMPLE_IDS.marcus, SAMPLE_FIELD_IDS.interests, ["Jazz"]),
    v("reading", reading(1), SAMPLE_FIELD_IDS.rating, 4),
    v("reading", reading(5), SAMPLE_FIELD_IDS.rating, 5),
    v("reading", reading(29), SAMPLE_FIELD_IDS.rating, 5),
    v("reading", reading(12), SAMPLE_FIELD_IDS.rating, 5),
    v("reading", reading(14), SAMPLE_FIELD_IDS.rating, 4.5),
    v("reading", reading(8), SAMPLE_FIELD_IDS.rating, 4),
    v("reading", reading(5), SAMPLE_FIELD_IDS.recommend, true),
    v("place", SAMPLE_IDS.dishoom, SAMPLE_FIELD_IDS.goodFor, ["Dinner", "Groups"]),
    v("place", SAMPLE_IDS.dishoom, SAMPLE_FIELD_IDS.booking, "https://www.dishoom.com/kings-cross"),
    v("place", SAMPLE_IDS.dishoom, SAMPLE_FIELD_IDS.visited, addDays(localToday(), -18)),
    v("organisation", SAMPLE_IDS.netlify, SAMPLE_FIELD_IDS.howWeMet, "Where Priya works. Her team runs the design system the onboarding work builds on."),
    ...sampleKindValues(),
  ];
}
