/**
 * Sample AI spend, for sample mode and the screenshots: the server's GET /api/spend answered from memory, in
 * pounds. Three days to look at, picked with localStorage "athena.sample.spend": "under" (the default, £1.20 of
 * £3), "near" (£2.55 of £3, Muse near her cap), "reached" (£3 of £3, Muse at hers) or "none" (no budget yet).
 * Setting the budget, a cap or Allow more lasts until the page reloads.
 */
import { SAMPLE_TEAM_IDS } from "./sample-team";
import { allowStep, budgetState, type AllowMoreBody, type BudgetPatch, type SpendLine, type SpendView } from "../../../lib/spend-types";

type Scene = "under" | "near" | "reached" | "none";

function scene(): Scene {
  try {
    const s = localStorage.getItem("athena.sample.spend");
    return s === "near" || s === "reached" || s === "none" ? s : "under";
  } catch {
    return "under";
  }
}

const { muse, dot, wren } = SAMPLE_TEAM_IDS;
const NAMES: Record<string, string> = { [muse]: "Muse", [dot]: "Dot", [wren]: "Wren" };

/** Today's split in each scene: Ask, then each assistant, background work, pictures. */
const TODAY: Record<Exclude<Scene, "none">, Array<[SpendLine["area"], string | null, number, boolean?]>> = {
  under: [["ask", null, 0.62], ["assistant", muse, 0.31], ["background", null, 0.21], ["pictures", null, 0.06, true]],
  near: [["ask", null, 1.38], ["assistant", muse, 0.46], ["assistant", dot, 0.18], ["background", null, 0.42], ["pictures", null, 0.11, true]],
  reached: [["ask", null, 1.64], ["assistant", muse, 0.5], ["assistant", dot, 0.22], ["background", null, 0.52], ["pictures", null, 0.12, true]],
};

/** The six days before today, oldest first. */
const BEFORE = [1.84, 2.31, 0.96, 2.74, 1.52, 2.1];

interface State {
  daily: number | null;
  caps: Record<string, number>;
  extra: number;
  extraCaps: Record<string, number>;
}
let state: State | null = null;
function current(): State {
  state ??= scene() === "none" ? { daily: null, caps: {}, extra: 0, extraCaps: {} } : { daily: 3, caps: { [muse]: 0.5 }, extra: 0, extraCaps: {} };
  return state;
}

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const round = (n: number) => Math.round(n * 100) / 100;

export function sampleSpend(): SpendView {
  const s = current();
  const rows = TODAY[scene() === "none" ? "under" : (scene() as Exclude<Scene, "none">)];
  const lines: SpendLine[] = rows.map(([area, id, spent, estimated]) => ({ area, ...(id ? { assistant_id: id, name: NAMES[id] } : {}), spent, estimated: !!estimated }));
  const spent = round(lines.reduce((n, l) => n + l.spent, 0));
  const days = [...BEFORE.map((v, i) => ({ day: day(i - 6), spent: v, estimated: i === 3 })), { day: day(0), spent, estimated: true }];
  const week = round(days.reduce((n, d) => n + d.spent, 0));
  // The week's split: today's shares, scaled to the week.
  const weekLines = lines.map((l) => ({ ...l, spent: round((l.spent / spent) * week) }));
  const limit = s.daily === null ? null : round(s.daily + s.extra);
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  return {
    currency: "GBP",
    locale: "en-GB",
    rate: { value: 0.79, as_of: new Date(Date.now() - 5 * 3_600_000).toISOString(), stale: false },
    rate_missing: false,
    today: { day: day(0), spent, estimated: lines.some((l) => l.estimated), lines },
    week: { days, spent: week, lines: weekLines },
    budget: { daily: s.daily, extra: s.extra, limit, state: budgetState(spent, limit), resets_at: midnight.toISOString(), step: allowStep(0.79) },
    assistants: [muse, dot, wren].map((id) => {
      const mine = lines.find((l) => l.assistant_id === id)?.spent ?? 0;
      const cap = s.caps[id] ?? null;
      const extra = s.extraCaps[id] ?? 0;
      return { assistant_id: id, name: NAMES[id], spent: mine, cap, extra, state: budgetState(mine, cap === null ? null : cap + extra) };
    }),
    estimated_models: ["gemini-nano-banana-2.1"],
  };
}

export function sampleSetBudget(patch: BudgetPatch): SpendView {
  const s = current();
  if (patch.daily !== undefined) {
    if (patch.daily !== null && !(patch.daily > 0)) throw new Error("The daily budget needs to be an amount above zero, or left empty for none.");
    s.daily = patch.daily === null ? null : round(patch.daily);
  }
  for (const [id, cap] of Object.entries(patch.assistants ?? {})) {
    if (cap === null) delete s.caps[id];
    else if (cap > 0) s.caps[id] = round(cap);
    else throw new Error("A cap needs to be an amount above zero, or left empty for none.");
  }
  return sampleSpend();
}

export function sampleAllowMore(body: AllowMoreBody): SpendView {
  const s = current();
  const step = allowStep(0.79);
  if (body.assistant_id) s.extraCaps[body.assistant_id] = (s.extraCaps[body.assistant_id] ?? 0) + step;
  else s.extra += step;
  return sampleSpend();
}
