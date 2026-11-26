/**
 * The guided setup's status and progress (GET and POST /api/setup,
 * netlify/lib/setup-routes.ts). Before this device has a key, the browser's
 * site session (it got past the site password) is enough to read the status.
 *
 * Sample mode never calls the server: #/welcome?step=site&key=missing and the
 * like draw the guide on made-up checks, for screenshots and review.
 */

import { isSampleMode, request } from "../db/api";
import { GUIDE_STEPS, type GuideChange, type GuideStep, type SetupStatus } from "../../../lib/setup-guide";

/** This device's note that the guide is done here, so a launch doesn't wait on the server to find out. */
const DONE_HERE = "athena.guide";

export function guideDoneHere(): boolean {
  try {
    return localStorage.getItem(DONE_HERE) === "done";
  } catch {
    return false;
  }
}

export function markGuideDoneHere(done = true): void {
  try {
    if (done) localStorage.setItem(DONE_HERE, "done");
    else localStorage.removeItem(DONE_HERE);
  } catch {
    // private mode: the server is asked again next launch
  }
}

const LATER = "athena.guide.later";

/** "Not now" on a fix puts it off for a day on this device. */
export function putGuideOff(): void {
  try {
    localStorage.setItem(LATER, String(Date.now()));
  } catch {
    // it asks again next launch
  }
}

export function guidePutOff(): boolean {
  try {
    const at = Number(localStorage.getItem(LATER));
    return Number.isFinite(at) && Date.now() - at < 86_400_000;
  } catch {
    return false;
  }
}

/** The status, or null when the server can't be reached in `waitMs`. */
export async function fetchSetup(waitMs = 4000): Promise<SetupStatus | null> {
  if (isSampleMode()) return sampleSetup();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs));
  return Promise.race([request<SetupStatus>("/setup").catch(() => null), timeout]);
}

export async function saveGuide(change: GuideChange): Promise<SetupStatus | null> {
  if (isSampleMode()) return null;
  return request<SetupStatus>("/setup", { method: "POST", body: JSON.stringify(change) });
}

/** The preview's params: #/welcome?step=site&key=missing&ai=0&fix=1. */
export function previewParams(): URLSearchParams {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

/** Made-up checks for sample mode, from the preview's params. */
export function sampleSetup(): SetupStatus {
  const p = previewParams();
  const key = p.get("key");
  const data_key = key === "missing" || key === "invalid" ? key : "set";
  const checks = { database: true, data_key, connector_key: p.get("connector") !== "0", ai: p.get("ai") !== "0", preview: false } as SetupStatus["checks"];
  const step = p.get("step");
  const ready = checks.database && checks.data_key === "set" && checks.connector_key;
  return {
    checks,
    ready,
    guide: { step: (GUIDE_STEPS as readonly string[]).includes(step ?? "") ? (step as GuideStep) : "welcome", completed_at: null, reason: p.get("fix") === "1" ? "fix" : "new" },
    site_name: "athena-example",
    data_key_id: null,
  };
}
