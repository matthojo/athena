/**
 * The guided setup a new owner goes through after deploying their own copy:
 * connect this device, check the site's settings, say who they are, add their
 * first sources, get Athena on their phone, done (app/src/guide/).
 *
 * Whether it shows comes from two things. The environment: the database,
 * ATHENA_DATA_KEY and CONNECTOR_ENCRYPTION_KEY must be in place, and Netlify AI
 * Gateway's keys should be. And the progress kept in one settings row,
 * `setup_guide`. It shows until the owner finishes it, and again whenever a
 * required setting goes missing. A copy that was in use before the guide
 * existed counts as finished.
 *
 * This file is pure; netlify/lib/setup-routes.ts reads the environment and
 * the database.
 */

export const GUIDE_KEY = "setup_guide";

export const GUIDE_STEPS = ["welcome", "site", "about", "sources", "phone", "done"] as const;
export type GuideStep = (typeof GUIDE_STEPS)[number];

export const isGuideStep = (v: unknown): v is GuideStep => typeof v === "string" && (GUIDE_STEPS as readonly string[]).includes(v);

export interface GuideProgress {
  /** The step to resume at; null before the guide is opened. */
  step: GuideStep | null;
  /** When the owner finished it; null while it's still to do. */
  completed_at: string | null;
}

export const EMPTY_GUIDE: GuideProgress = { step: null, completed_at: null };

/** What's stored, checked: anything malformed reads as not started. */
export function readGuide(raw: unknown): GuideProgress {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_GUIDE };
  const r = raw as Record<string, unknown>;
  return {
    step: isGuideStep(r.step) ? r.step : null,
    completed_at: typeof r.completed_at === "string" && !Number.isNaN(Date.parse(r.completed_at)) ? r.completed_at : null,
  };
}

/** A change to the progress (POST /api/setup): the step the owner is on, finished, or start again. */
export interface GuideChange {
  step?: GuideStep;
  complete?: boolean;
  restart?: boolean;
}

export class GuideInputError extends Error {}

export function parseGuideChange(body: unknown): GuideChange {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new GuideInputError("Send a JSON object");
  const b = body as Record<string, unknown>;
  const change: GuideChange = {};
  if ("step" in b) {
    if (!isGuideStep(b.step)) throw new GuideInputError(`step: one of ${GUIDE_STEPS.join(", ")}`);
    change.step = b.step;
  }
  for (const k of ["complete", "restart"] as const) {
    if (k in b) {
      if (typeof b[k] !== "boolean") throw new GuideInputError(`${k}: true or false`);
      change[k] = b[k] as boolean;
    }
  }
  if (!Object.keys(change).length) throw new GuideInputError("Nothing to change: send step, complete or restart");
  return change;
}

export function applyGuideChange(was: GuideProgress, change: GuideChange, now: Date = new Date()): GuideProgress {
  const next: GuideProgress = change.restart ? { ...EMPTY_GUIDE } : { ...was };
  if (change.step) next.step = change.step;
  if (change.complete === true) next.completed_at = now.toISOString();
  if (change.complete === false) next.completed_at = null;
  return next;
}

/** What the environment has, as the guide's site step shows it. Booleans and names only, never a value. */
export interface SiteChecks {
  /** Netlify Database answers. */
  database: boolean;
  /** ATHENA_DATA_KEY: set and valid, not set, or set but not 64 hex characters. */
  data_key: "set" | "missing" | "invalid";
  /** CONNECTOR_ENCRYPTION_KEY is set and valid. */
  connector_key: boolean;
  /** Claude is reachable: AI Gateway's keys (or the owner's own) are in the environment. */
  ai: boolean;
  /** A deploy preview or branch deploy, or a copy whose data is encrypted under a key it doesn't have. Never guided. */
  preview: boolean;
}

/** The settings Athena can't run without. AI isn't one: everything but Ask and collections works without it. */
export function siteReady(c: SiteChecks): boolean {
  return c.database && c.data_key === "set" && c.connector_key;
}

/** Signs that a copy was in use before the guide existed. */
export interface UseSigns {
  notes: number;
  connectors: number;
  /** When Home first opened for this owner (lib/profile.ts `started_at`), if it was kept. */
  started_at: string | null;
}

const DAY_MS = 86_400_000;

/** Already in use: a few notes, an account, or a first week that began more than two days ago. */
export function inUse(s: UseSigns, now: Date = new Date()): boolean {
  if (s.notes > 5 || s.connectors > 0) return true;
  const t = s.started_at ? Date.parse(s.started_at) : NaN;
  return !Number.isNaN(t) && now.getTime() - t > 2 * DAY_MS;
}

export type GuideReason = "new" | "fix" | null;

/**
 * Why the guide should show, or null. "new": not finished yet. "fix": finished,
 * but a required setting has gone missing since. A deploy preview is never
 * guided: it has no data key on purpose.
 */
export function guideReason(progress: GuideProgress, checks: SiteChecks, used: boolean): GuideReason {
  if (checks.preview) return null;
  const finished = !!progress.completed_at || used;
  if (!finished) return "new";
  return siteReady(checks) ? null : "fix";
}

/** GET /api/setup. */
export interface SetupStatus {
  checks: SiteChecks;
  ready: boolean;
  guide: GuideProgress & { reason: GuideReason };
  /** Netlify's name for this site, for links into its settings; null when Netlify doesn't say. */
  site_name: string | null;
  /** The id of the data key in use (lib/data-box.ts), so the guide can tell the owner it's the key they saved. Signed-in callers only. */
  data_key_id?: string | null;
}

/** Netlify's address for one of this site's settings pages. */
export function netlifyPage(siteName: string | null, page: "env" | "deploys"): string {
  if (!siteName || !/^[a-z0-9-]+$/i.test(siteName)) return "https://app.netlify.com/";
  return `https://app.netlify.com/projects/${siteName}/${page === "env" ? "configuration/env" : "deploys"}`;
}
