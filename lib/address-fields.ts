/**
 * An account address asked for as labelled fields instead of one line
 * (Octopus: an electricity meter and a gas meter, either or both). Pure, so
 * the PWA checks as you type and the server checks again with the same rules
 * before the adapter turns the values into the address it keeps.
 *
 * The form sends the values as JSON in `url`; the adapter's checkAddress
 * reads them (lib/presets/octopus-meters.ts).
 */

export interface AddressInput {
  key: string;
  label: string;
  placeholder: string;
  /** Checked after trimming, taking out spaces and, with `upper`, uppercasing. */
  pattern: string;
  /** Said when it's filled in but wrong ("An MPAN is 13 digits"). */
  message: string;
  /** Said when the rest of its group is filled in and this isn't. */
  missing: string;
  numeric?: boolean;
  upper?: boolean;
}

export interface AddressGroup {
  key: string;
  title: string;
  inputs: AddressInput[];
  /** An on/off choice that goes with the group (gas in m³). */
  toggle?: { key: string; label: string };
  /** Extra, not an address on its own: filling it in alone isn't enough (Octopus's account number, for costs). */
  optional?: true;
  /** Said under the group. */
  sub?: string;
}

/** A way to fill the groups in from the service itself (Octopus's account number). */
export interface AddressFinder {
  label: string;
  placeholder: string;
  pattern: string;
  message: string;
  sub: string;
  /** The button, the wait, what to do with the answers, an empty answer, and a failure without the service's own words. */
  button: string;
  asking: string;
  pick: string;
  empty: string;
  failed: string;
  /** "group.input" the query is kept in once it finds something (the account number). */
  keeps?: string;
}

export interface AddressFields {
  groups: AddressGroup[];
  /** Said when no group is filled in. */
  none: string;
  finder?: AddressFinder;
  /** The values an address was made from, for the Edit form. */
  read?(address: string): AddressValues | null;
}

export type AddressValues = Record<string, Record<string, string | boolean>>;

export interface AddressCheck {
  /** Cleaned values of the complete groups only. */
  values: AddressValues;
  /** "group.input" → what's wrong with it. */
  errors: Record<string, string>;
  /** Nothing filled in at all. */
  none?: string;
}

export const cleanInput = (input: AddressInput, raw: unknown): string => {
  const v = (typeof raw === "string" ? raw : "").replace(/\s+/g, "");
  return input.upper ? v.toUpperCase() : v;
};

/** Every group optional, but at least one complete, and every field in a started group right. */
export function checkAddressFields(spec: AddressFields, raw: AddressValues): AddressCheck {
  const values: AddressValues = {};
  const errors: Record<string, string> = {};
  for (const g of spec.groups) {
    const got = raw[g.key] ?? {};
    const cleaned = g.inputs.map((i) => [i, cleanInput(i, got[i.key])] as const);
    if (cleaned.every(([, v]) => !v)) continue;
    let ok = true;
    for (const [i, v] of cleaned) {
      const problem = !v ? i.missing : new RegExp(i.pattern).test(v) ? "" : i.message;
      if (problem) {
        errors[`${g.key}.${i.key}`] = problem;
        ok = false;
      }
    }
    if (ok) values[g.key] = { ...Object.fromEntries(cleaned.map(([i, v]) => [i.key, v])), ...(g.toggle ? { [g.toggle.key]: got[g.toggle.key] === true } : {}) };
  }
  const counted = spec.groups.some((g) => !g.optional && values[g.key]);
  const none = !counted && !Object.keys(errors).length ? spec.none : undefined;
  return { values, errors, ...(none ? { none } : {}) };
}

/** The first thing wrong, in words, or "". */
export function firstProblem(c: AddressCheck): string {
  return c.none ?? Object.values(c.errors)[0] ?? "";
}
