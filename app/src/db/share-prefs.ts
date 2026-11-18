/**
 * "Always save what I share from this device" (owner, 10 Nov 2026).
 *
 * The service worker can tell another site's form from a share (sw.js,
 * shareFrom) and refuses it before anything here is looked at. What it can't
 * do in Chromium is positively recognise the share sheet, so a share with no
 * Origin header is kept unmarked and the app asks before saving. The owner
 * can tick this on that prompt (or in Settings → About you) to have such
 * shares saved at once on this device.
 *
 * Kept in localStorage, per device; Sign out clears it with everything else
 * (db/sign-out.ts).
 */

const KEY = "athena.share.always";

export function alwaysSaveShares(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setAlwaysSaveShares(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the app keeps asking
  }
}

/** Save without asking: the worker marked it as from the OS, or the owner said always on this device. */
export function savesAtOnce(shared: { trusted?: boolean }): boolean {
  return shared.trusted === true || alwaysSaveShares();
}
