/**
 * Sleep stages as the iPhone Shortcut sends them (lib/health.ts calls this).
 *
 * Find Health Samples for Sleep gives one sample per stage: Deep,
 * Core, REM, Awake, In Bed, or Asleep (an app that doesn't stage). Shortcuts
 * turns a list of samples into text one per line, so what arrives is one of:
 *
 *  - minutes per stage: { deep, core, rem, awake, in_bed, asleep_unspecified }
 *  - one sample per line: "Core,2026-11-06T23:40:00Z,2026-11-07T00:55:00Z"
 *    (stage, start, end) or "Core,75" (stage, minutes)
 *  - parallel lists: stage names in sleep_stages, with sleep_durations, or
 *    sleep_starts and sleep_ends, one per sample
 *  - any of those as newline- or comma-joined text, a list, or JSON
 *
 * Samples with times are merged on a timeline: where they overlap (an
 * iPhone's In Bed around the Watch's stages, or two apps writing the same
 * night) each minute counts once, for the most specific stage. in_bed is the
 * whole time in bed. Samples with only minutes are added up; then staged
 * sleep wins over unstaged "Asleep", which would be the same night twice.
 *
 * Pure: nothing is stored or logged here.
 */
import { asleepMinutes, STAGE_KEYS, type SleepStages, type StageKey } from "./health-line";

/** A breakdown that can't be read. The message names what to change in the Shortcut. */
export class StagesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagesError";
  }
}

/** Stage names only, no times: what an older Shortcut sent as sleep_minutes. */
export class StagesWithoutTimes extends StagesError {}

export const MAX_SAMPLES = 600;

/** Apple's names in any case and spelling ("Asleep Core", "HKCategoryValueSleepAnalysisAsleepREM", "light"). */
export function stageOf(raw: string): StageKey | null {
  const s = raw
    .replace(/^HKCategoryValueSleepAnalysis/i, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, "");
  const t = s.replace(/^asleep(?=.)/, "").replace(/sleep$/, "");
  if (t === "deep") return "deep";
  if (t === "core" || t === "light") return "core";
  if (t === "rem") return "rem";
  if (t === "awake" || t === "wake") return "awake";
  if (t === "inbed" || t === "bed") return "in_bed";
  if (s === "asleep" || s === "sleep" || t === "unspecified" || t === "asleepunspecified") return "asleep_unspecified";
  return null;
}

interface Sample {
  stage: StageKey;
  minutes?: number;
  start?: number;
  end?: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A sample's date: ISO 8601 (what Shortcuts gives with Date Format set to
 * ISO 8601), or the phone's own text ("7 Nov 2026 at 01:23", "Nov 7, 2026
 * at 1:23 AM"), read in `tz`'s offset at that moment (close enough for a
 * night's minutes: only differences are used).
 */
export function readWhen(raw: string): number | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    return Number.isFinite(t) ? t : null;
  }
  const m =
    s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4}),?\s+(?:at\s+)?(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i) ??
    s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(?:at\s+)?(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  const dayFirst = /^\d/.test(m[1]);
  const day = Number(dayFirst ? m[1] : m[2]);
  const mon = MONTHS.indexOf((dayFirst ? m[2] : m[1]).toLowerCase());
  if (mon < 0) return null;
  let hour = Number(m[4]);
  const ampm = m[7]?.toLowerCase().replace(/\./g, "");
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  return Date.UTC(Number(m[3]), mon, day, hour, Number(m[5]), Number(m[6] ?? 0));
}

/**
 * A length: plain numbers are minutes ("75", "75.5"); with units "75 min",
 * "1h 15m", "4500 s", "1 hr"; or a clock "1:15" (h:mm) / "1:15:00".
 */
export function readLength(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  const clock = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) + Number(clock[3] ?? 0) / 60;
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g)];
  if (!parts.length || parts.map((p) => p[0]).join("").replace(/\s+/g, "") !== s.replace(/[\s,]+|and/g, "")) return null;
  return parts.reduce((n, p) => n + Number(p[1]) * (p[2].startsWith("h") ? 60 : p[2].startsWith("s") ? 1 / 60 : 1), 0);
}

const show = (v: unknown) => JSON.stringify(String(v).slice(0, 40));

/** Text, a list or a JSON array, as a list of items. Text splits on new lines (and commas when it's one line). */
function listOf(raw: unknown, field: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") throw new StagesError(`${field}: send text or a list`);
  const s = raw.trim();
  if (/^\[/.test(s)) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON: read it as text
    }
  }
  return s.split(/\r?\n|;/).map((l) => l.trim()).filter(Boolean);
}

/** The words in one line of text: "Core, 75" or "Core,2026-11-06T23:40:00Z,2026-11-07T00:55:00Z" or "Nov 7, 2026 at 1:23 AM". */
function tokens(line: string): string[] {
  const raw = line.split(/\s*[,\t]\s*/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    // A US date carries its own comma: "Nov 7" + "2026 at 1:23 AM".
    if (i + 1 < raw.length && readWhen(raw[i]) === null && readWhen(`${raw[i]}, ${raw[i + 1]}`) !== null) {
      out.push(`${raw[i]}, ${raw[i + 1]}`);
      i++;
    } else out.push(raw[i]);
  }
  return out;
}

const NAMES = "Deep, Core, REM, Awake, In Bed or Asleep";

/** Samples from words: a stage starts each sample; the words after it are its minutes, or its start and end. */
function samplesFromWords(words: string[], field: string): Sample[] {
  const out: Sample[] = [];
  let cur: { stage: StageKey; rest: string[] } | null = null;
  const close = () => {
    if (!cur) return;
    const { stage, rest } = cur;
    if (rest.length === 0) out.push({ stage });
    else if (rest.length === 1) {
      const m = readLength(rest[0]);
      if (m === null) throw new StagesError(`${field}: can't read ${show(rest[0])} as minutes. Send each stage as “Core,75” or with its Start and End Date.`);
      out.push({ stage, minutes: m });
    } else if (rest.length === 2) {
      const [a, b] = rest.map(readWhen);
      if (a === null || b === null) throw new StagesError(`${field}: can't read ${show(a === null ? rest[0] : rest[1])} as a date. In the Shortcut, set each date's Date Format to ISO 8601.`);
      out.push({ stage, start: a, end: b });
    } else throw new StagesError(`${field}: ${show(rest.join(","))} after ${stage} is too much. Send one stage per line: its name, then its minutes or its Start and End Date.`);
    cur = null;
  };
  for (const w of words) {
    const stage = stageOf(w);
    if (stage && !/\d/.test(w)) {
      close();
      cur = { stage, rest: [] };
    } else if (!cur) {
      if (/^[a-z ]+$/i.test(w)) throw new StagesError(`${field}: ${show(w)} isn't a sleep stage. Use Apple's names: ${NAMES}.`);
      throw new StagesError(`${field}: ${show(w)} comes before any stage name. Start each line with the stage, like “Core,75”.`);
    } else cur.rest.push(w);
  }
  close();
  return out;
}

/** One item of a JSON list: { stage|value, minutes|duration, start, end } or a "Core,75" string. */
function samplesFromItem(item: unknown, field: string): Sample[] {
  if (typeof item === "string") return samplesFromWords(tokens(item), field);
  if (!item || typeof item !== "object") throw new StagesError(`${field}: send each stage as text like “Core,75”`);
  const o = item as Record<string, unknown>;
  const name = o.stage ?? o.value ?? o.type ?? o.name;
  const stage = typeof name === "string" ? stageOf(name) : null;
  if (!stage) throw new StagesError(`${field}: ${show(name)} isn't a sleep stage. Use Apple's names: ${NAMES}.`);
  const startRaw = o.start ?? o.start_date ?? o.startDate;
  const endRaw = o.end ?? o.end_date ?? o.endDate;
  if (startRaw !== undefined && endRaw !== undefined) {
    const a = typeof startRaw === "string" ? readWhen(startRaw) : typeof startRaw === "number" ? startRaw : null;
    const b = typeof endRaw === "string" ? readWhen(endRaw) : typeof endRaw === "number" ? endRaw : null;
    if (a === null || b === null) throw new StagesError(`${field}: can't read a ${stage} sample's dates. In the Shortcut, set each date's Date Format to ISO 8601.`);
    return [{ stage, start: a, end: b }];
  }
  const len = o.minutes ?? o.duration;
  if (len === undefined) return [{ stage }];
  const m = readLength(len);
  if (m === null) throw new StagesError(`${field}: can't read ${show(len)} as minutes`);
  return [{ stage, minutes: m }];
}

// Staged readings (the Watch) beat an unstaged "Asleep" from another app, Awake included.
const PRIORITY: StageKey[] = ["deep", "rem", "core", "awake", "asleep_unspecified", "in_bed"];

/** Samples with times on one timeline: each minute once, for its most specific stage; in_bed is the whole span covered. */
function fromTimeline(samples: Array<Sample & { start: number; end: number }>): Record<StageKey, number> {
  const out = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0])) as Record<StageKey, number>;
  const cuts = [...new Set(samples.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const here = samples.filter((s) => s.start <= a && s.end >= b).map((s) => s.stage);
    if (!here.length) continue;
    const mins = (b - a) / 60_000;
    out.in_bed += mins;
    const top = PRIORITY.find((k) => here.includes(k))!;
    if (top !== "in_bed") out[top] += mins;
  }
  return out;
}

/**
 * The breakdown from whatever the Shortcut or an API sent. `durations`,
 * `starts` and `ends` are the parallel lists, when stage names came alone.
 * Throws StagesWithoutTimes when there are names but no times at all.
 */
export function readStages(raw: unknown, more: { durations?: unknown; starts?: unknown; ends?: unknown } = {}, field = "sleep_stages"): SleepStages {
  let samples: Sample[];
  const parallel = more.durations !== undefined || more.starts !== undefined || more.ends !== undefined;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (parallel) throw new StagesError(`${field}: send the stage names as a list when you send their durations or dates`);
    // Minutes per stage, already added up.
    const o = raw as Record<string, unknown>;
    samples = [];
    for (const [k, v] of Object.entries(o)) {
      const stage = (STAGE_KEYS as readonly string[]).includes(k) ? (k as StageKey) : stageOf(k);
      if (!stage) throw new StagesError(`${field}: unknown stage ${k}. Stages: ${STAGE_KEYS.join(", ")}`);
      if (v === undefined || v === null || v === "") continue;
      const m = readLength(v);
      if (m === null) throw new StagesError(`${field}.${k}: send minutes, not ${show(v)}`);
      samples.push({ stage, minutes: m });
    }
    // Already added up by the app: kept as sent, none of the guesses below for raw samples.
    const sums: Partial<Record<StageKey, number>> = {};
    for (const x of samples) sums[x.stage] = (sums[x.stage] ?? 0) + x.minutes!;
    const out = stagesOf(sums) ?? {};
    for (const k of STAGE_KEYS) if ((out[k] ?? 0) > 1440) throw new StagesError(`${field}: ${out[k]} minutes of ${k} is more than a day. Send one night.`);
    if ((asleepMinutes(out) ?? 0) > 1440) throw new StagesError(`${field}: more than a day asleep. Send one night.`);
    return out;
  } else {
    const items = listOf(raw, field);
    if (parallel) {
      const names = items.flatMap((x) => (typeof x === "string" ? x.split(/\s*,\s*/).filter(Boolean) : [x]));
      const stages = names.map((n) => {
        const s = typeof n === "string" ? stageOf(n) : null;
        if (!s) throw new StagesError(`${field}: ${show(n)} isn't a sleep stage. Use Apple's names: ${NAMES}.`);
        return s;
      });
      const flat = (v: unknown, f: string) => listOf(v, f).flatMap((x) => (typeof x === "string" && !readWhen(x) ? x.split(/\s*,\s*/).filter(Boolean) : [x]));
      if (more.durations !== undefined) {
        const lens = flat(more.durations, "sleep_durations");
        if (lens.length !== stages.length) throw new StagesError(`sleep_durations: ${lens.length} ${lens.length === 1 ? "duration" : "durations"} for ${stages.length} stages. Send one for each sample, from the same Find Health Samples.`);
        let mins = lens.map((l) => {
          const m = readLength(l);
          if (m === null) throw new StagesError(`sleep_durations: can't read ${show(l)} as minutes`);
          return m;
        });
        // Shortcuts' Duration can come through in seconds: a "night" of more than a day was seconds.
        const total = mins.reduce((a, b) => a + b, 0);
        if (total > 1440 && total / 60 <= 1440 && lens.every((l) => typeof l === "number" || /^\d+(?:\.\d+)?$/.test(String(l).trim()))) mins = mins.map((m) => m / 60);
        samples = stages.map((stage, i) => ({ stage, minutes: mins[i] }));
      } else {
        if (more.starts === undefined || more.ends === undefined) throw new StagesError(`${field}: send both sleep_starts and sleep_ends, one of each per sample`);
        const starts = listOf(more.starts, "sleep_starts");
        const ends = listOf(more.ends, "sleep_ends");
        if (starts.length !== stages.length || ends.length !== stages.length) throw new StagesError(`sleep_starts and sleep_ends: one of each for each of the ${stages.length} stages, from the same Find Health Samples`);
        samples = stages.map((stage, i) => {
          const a = readWhen(String(starts[i]));
          const b = readWhen(String(ends[i]));
          if (a === null || b === null) throw new StagesError(`sleep_starts: can't read ${show(a === null ? starts[i] : ends[i])} as a date. In the Shortcut, set each date's Date Format to ISO 8601.`);
          return { stage, start: a, end: b };
        });
      }
    } else if (items.every((x) => typeof x === "string")) {
      const lines = items as string[];
      // One line of commas ("Deep,Core,REM") reads as words; several lines are one sample each.
      samples = lines.length === 1 ? samplesFromWords(tokens(lines[0]), field) : lines.flatMap((l) => samplesFromWords(tokens(l), field));
    } else samples = items.flatMap((x) => samplesFromItem(x, field));
  }

  if (samples.length > MAX_SAMPLES) throw new StagesError(`${field}: at most ${MAX_SAMPLES} samples a night`);
  if (!samples.length) return {};
  if (samples.every((s) => s.minutes === undefined && s.start === undefined)) {
    throw new StagesWithoutTimes(`${field}: Athena got the stage names but not how long each lasted`);
  }
  for (const s of samples) {
    if (s.start !== undefined && s.end !== undefined && (s.end < s.start || s.end - s.start > 86_400_000)) throw new StagesError(`${field}: a ${s.stage} sample ends before it starts, or lasts over a day`);
  }

  const timed = samples.filter((s): s is Sample & { start: number; end: number } => s.start !== undefined && s.end !== undefined);
  const out = fromTimeline(timed);
  const plain = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0])) as Record<StageKey, number>;
  for (const s of samples) if (s.minutes !== undefined) plain[s.stage] += s.minutes;
  // Without times, an app's unstaged "Asleep" beside staged sleep is the same night twice.
  if (plain.asleep_unspecified && plain.deep + plain.core + plain.rem > 0) plain.asleep_unspecified = 0;
  for (const k of STAGE_KEYS) out[k] += plain[k];
  // Without times, the time in bed is at least the night it holds.
  const held = out.deep + out.core + out.rem + out.asleep_unspecified + out.awake;
  if (plain.in_bed || plain.awake || held) out.in_bed = Math.max(out.in_bed, held);

  const stages: SleepStages = {};
  for (const k of STAGE_KEYS) {
    const m = Math.round(out[k]);
    if (m > 1440) throw new StagesError(`${field}: ${m} minutes of ${k} is more than a day. Send one night's samples (End Date is yesterday).`);
    if (m > 0) stages[k] = m;
  }
  if ((asleepMinutes(stages) ?? 0) > 1440) throw new StagesError(`${field}: more than a day asleep. Send one night's samples.`);
  return stages;
}

/** Does this text or list look like sleep stage names (what an older Shortcut put in sleep_minutes)? */
export function looksLikeStages(raw: unknown): boolean {
  if (Array.isArray(raw)) return raw.length > 0 && raw.some((x) => (typeof x === "string" && stageOf(x.split(",")[0]) !== null) || (!!x && typeof x === "object"));
  if (typeof raw !== "string") return false;
  const first = raw.trim().split(/[\n,;]/)[0]?.trim() ?? "";
  return stageOf(first) !== null && !/^\d/.test(first);
}

/** An account's night as a breakdown: undefined and zero stages left out, undefined when nothing is left (the adapters call this). */
export function stagesOf(s: Partial<Record<StageKey, number | undefined>>): SleepStages | undefined {
  const out: SleepStages = {};
  for (const k of STAGE_KEYS) {
    const v = s[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.round(v);
  }
  return Object.keys(out).length ? out : undefined;
}
