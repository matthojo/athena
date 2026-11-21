/**
 * FlowText (lib/flow-types.ts): words and value chips, in order. Pure
 * helpers the step sheet uses, kept apart from the page so they're tested.
 */
import { FLOW_LIMITS, type FlowText, type ValueRef } from "../../../lib/flow-types";

export const sameRef = (a: ValueRef, b: ValueRef): boolean => a.from === b.from && a.key === b.key;
export const refKey = (r: ValueRef): string => `${r.from}.${r.key}`;

/** Join neighbouring words, drop empty ones, and keep each run of words within FLOW_LIMITS.text. */
export function normaliseText(parts: ReadonlyArray<string | ValueRef>): FlowText {
  const out: FlowText = [];
  for (const p of parts) {
    if (typeof p === "string") {
      if (!p) continue;
      const last = out[out.length - 1];
      if (typeof last === "string") out[out.length - 1] = (last + p).slice(0, FLOW_LIMITS.text);
      else out.push(p.slice(0, FLOW_LIMITS.text));
    } else out.push({ from: p.from, key: p.key });
  }
  // Leading and trailing spaces are the editor's, not the owner's.
  if (typeof out[0] === "string") out[0] = (out[0] as string).replace(/^\s+/, "");
  const end = out.length - 1;
  if (typeof out[end] === "string") out[end] = (out[end] as string).replace(/\s+$/, "");
  return out.filter((p) => p !== "");
}

/** The values a piece of text uses. */
export const refsOf = (t: FlowText): ValueRef[] => t.filter((p): p is ValueRef => typeof p !== "string");

/** Replace every use of a value with another (or take it out, with null). */
export function swapRef(t: FlowText, from: ValueRef, to: ValueRef | null): FlowText {
  return normaliseText(t.flatMap((p) => (typeof p !== "string" && sameRef(p, from) ? (to ? [to] : []) : [p])));
}

/** Text from a plain string: what a new step's fields start as. */
export const textOf = (s: string): FlowText => (s ? [s] : []);
