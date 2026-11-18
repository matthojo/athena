/**
 * Home appliances (Home Connect: Bosch, Siemens, Neff, Gaggenau): what each
 * one is doing, in plain words, and when a programme finished.
 *
 * Home Connect has no history of past runs. Athena looks every 15 minutes
 * (netlify/lib/home/appliance-sync.ts), remembers what it saw, and when an
 * appliance that was running no longer is, that's a finished cycle: one
 * entry on that day ("Dishwasher: Eco 50, 3h 15m"). A cycle's start and
 * end are therefore known to the nearest look, about a quarter of an hour;
 * the start is exact when the appliance says how long it has been running.
 * A programme shorter than the gap between two looks can be missed.
 *
 * Pure: the sync, the tool, House and the tests all use it.
 */

/** One appliance as Home Connect lists it, with what its status and active programme said. */
export interface ApplianceSnapshot {
  id: string;
  name: string;
  /** "Dishwasher", "Washer", "Oven"… Home Connect's own word. */
  type: string;
  brand: string;
  connected: boolean;
  /** The last part of BSH.Common.Status.OperationState: "Run", "Finished", "Ready"… Absent when offline or not said. */
  state?: string;
  /** "Open", "Closed", "Locked". */
  door?: string;
  /** The active programme, when one is. */
  program?: { key: string; name?: string };
  remaining_s?: number;
  elapsed_s?: number;
  /** 0 to 100. */
  progress?: number;
}

/** A programme under way, as Athena has followed it. */
export interface ApplianceRun {
  /** ISO. */
  started: string;
  /** "Eco 50". */
  program?: string;
}

/** A programme that finished. */
export interface ApplianceCycle {
  started: string;
  ended: string;
  program?: string;
}

/** What Athena keeps about one appliance between looks. */
export interface ApplianceState extends ApplianceSnapshot {
  /** When it was last looked at (ISO). */
  seen: string;
  /** The programme it's in the middle of. */
  run?: ApplianceRun;
  /** The last one it finished. */
  last?: ApplianceCycle;
}

/** Kept sealed in settings (lib/appliance-store.ts), by account. */
export interface ApplianceStore {
  /** Connector id → what was last seen. */
  accounts: Record<string, { at: string; appliances: ApplianceState[]; /** Home Connect asked Athena to wait: no look before this (ISO). */ resume_at?: string }>;
}

/** Appliance types whose programmes are worth a line on the day. A fridge has none; a coffee is over in a minute. */
const CYCLE_TYPES = new Set(["Dishwasher", "Washer", "Dryer", "WasherDryer", "Oven", "Microwave", "CleaningRobot", "CookProcessor", "WarmingDrawer"]);
export const hasCycles = (type: string): boolean => CYCLE_TYPES.has(type);

const TYPE_WORDS: Record<string, string> = {
  AirConditioner: "Air conditioner",
  CleaningRobot: "Robot vacuum",
  CoffeeMaker: "Coffee machine",
  CookProcessor: "Cook processor",
  Dishwasher: "Dishwasher",
  Dryer: "Tumble dryer",
  Freezer: "Freezer",
  FridgeFreezer: "Fridge freezer",
  Hob: "Hob",
  Hood: "Extractor hood",
  Microwave: "Microwave",
  Oven: "Oven",
  Refrigerator: "Fridge",
  WarmingDrawer: "Warming drawer",
  Washer: "Washing machine",
  WasherDryer: "Washer dryer",
  WineCooler: "Wine cooler",
};

/** "Washing machine" for "Washer"; an unknown type as Home Connect spells it, spaced. */
export function typeWord(type: string): string {
  return TYPE_WORDS[type] ?? (type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase()).trim() || "Appliance");
}

/** What the owner calls it: its own name when they gave it one, otherwise what it is. */
export function applianceName(a: Pick<ApplianceSnapshot, "name" | "type">): string {
  const name = (a.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || typeWord(a.type);
}

/** The last part of an enum value: "BSH.Common.EnumType.OperationState.Run" → "Run". */
export const enumTail = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const tail = value.split(".").pop() ?? "";
  return /^[A-Za-z0-9]{1,40}$/.test(tail) ? tail : undefined;
};

/**
 * A programme's name: Home Connect's own when it gives one, otherwise read
 * off the key ("Dishcare.Dishwasher.Program.Eco50" → "Eco 50").
 */
export function programName(program: { key?: string; name?: string } | undefined): string | undefined {
  if (!program) return undefined;
  const given = (program.name ?? "").replace(/\s+/g, " ").trim();
  if (given) return given.slice(0, 80);
  const tail = (program.key ?? "").split(".Program.").pop() ?? "";
  if (!tail || tail === program.key) return undefined;
  const words = tail
    .split(".")
    .filter(Boolean)
    .map((w) => w.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/([0-9])([A-Za-z])/g, "$1 $2"))
    .join(" ")
    .trim();
  return words ? words.slice(0, 80) : undefined;
}

const STATE_WORDS: Record<string, string> = {
  Inactive: "Off",
  Ready: "Ready",
  DelayedStart: "Waiting to start",
  Run: "Running",
  Pause: "Paused",
  ActionRequired: "Needs attention",
  Finished: "Finished",
  Error: "Has a fault",
  Aborting: "Stopping",
};

/** In the middle of a programme. A delayed start hasn't begun. */
export const isRunning = (state: string | undefined): boolean => state === "Run" || state === "Pause" || state === "ActionRequired";

const minutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
/** "48m", "2h", "3h 15m". */
export function durationWords(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60);
  return h ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${m}m`;
}

/** What it's doing now, in a few words: "Running Eco 50, 1h 20m left", "Finished", "Offline". */
export function stateLine(a: ApplianceSnapshot & { run?: ApplianceRun }): string {
  if (!a.connected) return "Offline";
  const program = programName(a.program) ?? a.run?.program;
  if (isRunning(a.state)) {
    const left = typeof a.remaining_s === "number" && a.remaining_s > 0 ? `, ${durationWords(minutes(a.remaining_s))} left` : "";
    const word = a.state === "Run" ? "Running" : STATE_WORDS[a.state!];
    return `${word}${program ? ` ${program}` : ""}${left}`;
  }
  if (a.door === "Open" && (a.state === "Ready" || a.state === "Inactive" || !a.state)) return "Door open";
  return (a.state && STATE_WORDS[a.state]) || "On";
}

/** A run with no end in sight is dropped after this long: the appliance went offline mid-cycle and never said it finished. */
export const RUN_LOST_MS = 12 * 3600_000;

/**
 * One look at one appliance, against what was kept: what to keep now, and
 * the cycle that finished between the two looks, if one did.
 */
export function step(prev: ApplianceState | undefined, now: ApplianceSnapshot, at: Date): { next: ApplianceState; finished?: ApplianceCycle } {
  const seen = at.toISOString();
  const next: ApplianceState = { ...now, seen, ...(prev?.last ? { last: prev.last } : {}) };
  const program = programName(now.program);

  // Offline, or it said nothing about its state: what was known stands, for a while.
  if (!now.connected || !now.state) {
    if (prev?.run && at.getTime() - Date.parse(prev.run.started) < RUN_LOST_MS) next.run = prev.run;
    return { next };
  }

  if (isRunning(now.state)) {
    if (prev?.run) next.run = { started: prev.run.started, ...(program ?? prev.run.program ? { program: program ?? prev.run.program } : {}) };
    else {
      // Its own count of how long it has run puts the start before this look.
      const elapsed = typeof now.elapsed_s === "number" && now.elapsed_s > 0 && now.elapsed_s < RUN_LOST_MS / 1000 ? now.elapsed_s * 1000 : 0;
      next.run = { started: new Date(at.getTime() - elapsed).toISOString(), ...(program ? { program } : {}) };
    }
    return { next };
  }

  // Not running now. If it was, that programme is over: finished, or the door was opened before this look.
  if (prev?.run && hasCycles(now.type) && now.state !== "Error" && now.state !== "Aborting") {
    const finished: ApplianceCycle = { started: prev.run.started, ended: seen, ...(prev.run.program ? { program: prev.run.program } : {}) };
    next.last = finished;
    return { next, finished };
  }
  return { next };
}

/** The day entry for a finished cycle: "Dishwasher", "Eco 50", how long, on the day it ended. */
export function cycleEntry(a: Pick<ApplianceSnapshot, "id" | "name" | "type">, c: ApplianceCycle): { title: string; subtitle?: string; at: string; minutes: number; external_id: string } {
  const mins = Math.max(1, Math.round((Date.parse(c.ended) - Date.parse(c.started)) / 60_000));
  return { title: applianceName(a), ...(c.program ? { subtitle: c.program } : {}), at: c.ended, minutes: mins, external_id: `${a.id}:${c.started}` };
}

// ---------- For the House page ----------

/** One appliance as House shows it. */
export interface HouseAppliance {
  /** "Dishwasher", or the owner's own name for it. */
  name: string;
  /** "Dishwasher", "Washing machine". */
  what: string;
  brand?: string;
  /** "Running Eco 50, 1h 20m left", "Finished", "Offline". */
  now: string;
  running: boolean;
  /** The last programme it finished, as far as Athena saw. */
  last?: { program?: string; ended: string; minutes: number };
  /** When Athena last looked (ISO). */
  seen: string;
}

/** Every appliance Athena has seen, running ones first, then by name. */
export function houseAppliances(store: ApplianceStore): HouseAppliance[] {
  const out: HouseAppliance[] = [];
  for (const account of Object.values(store.accounts ?? {})) {
    for (const a of account.appliances ?? []) {
      out.push({
        name: applianceName(a),
        what: typeWord(a.type),
        ...(a.brand ? { brand: a.brand } : {}),
        now: stateLine(a),
        running: a.connected && isRunning(a.state),
        ...(a.last ? { last: { ...(a.last.program ? { program: a.last.program } : {}), ended: a.last.ended, minutes: Math.max(1, Math.round((Date.parse(a.last.ended) - Date.parse(a.last.started)) / 60_000)) } } : {}),
        seen: a.seen,
      });
    }
  }
  return out.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}
