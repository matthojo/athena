/**
 * Settings → About: which version of Athena this is, Check for updates
 * (version-setting.ts), and the details to include in a bug report, with a
 * button that copies them. The details never include content, keys, tokens or
 * the site's address (lib/debug-info.ts), since people paste them somewhere
 * public. The only request this page makes on its own is to this site's
 * /api/health; GitHub is asked only when the owner presses Check for updates.
 */
import "../styles/life.css";
import "../styles/knows.css";
import "../styles/link-text.css";
import "../styles/about.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { appVersion, versionSetting } from "./version-setting";
import { formatBytes, formatDetails, formatWhen, type Detail } from "../lib/debug-info";
import { ATHENA_REPO } from "../lib/version";
import { hasToken, isSampleMode } from "../db/api";
import { pendingOutboxCount } from "../db/sync";
import { getMeta } from "../db/idb";

const REPO_URL = `https://github.com/${ATHENA_REPO}`;

function link(href: string, text: string): HTMLElement {
  return h("a", { class: "text-link", href, target: "_blank", rel: "noopener noreferrer" }, text);
}

function buildCommit(): string {
  return typeof __ATHENA_COMMIT__ === "string" && __ATHENA_COMMIT__ ? __ATHENA_COMMIT__.slice(0, 7) : "unknown";
}

function builtAt(): string {
  return typeof __ATHENA_BUILT_AT__ === "string" ? formatWhen(__ATHENA_BUILT_AT__) : "unknown";
}

async function serverStatus(): Promise<string> {
  if (isSampleMode()) return "Not checked (sample data)";
  const started = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: ctrl.signal });
    const ms = Math.round(performance.now() - started);
    return res.ok ? `Reachable (${ms} ms)` : `Answered ${res.status} (${ms} ms)`;
  } catch {
    return navigator.onLine ? "Not reachable" : "Not reachable (this device is offline)";
  } finally {
    clearTimeout(timer);
  }
}

async function offlineCopy(): Promise<string> {
  const storage = navigator.storage;
  if (!storage?.estimate) return "unknown";
  const { usage, quota } = await storage.estimate();
  const kept = storage.persisted ? await storage.persisted() : false;
  const size = usage === undefined ? "unknown size" : formatBytes(usage);
  const room = quota === undefined ? "" : ` of ${formatBytes(quota)}`;
  return `${size}${room}, ${kept ? "kept by the browser" : "the browser may clear it if space runs low"}`;
}

function installed(): string {
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return standalone ? "Yes, opened as an app" : "No, in a browser tab";
}

function notifications(): string {
  if (typeof Notification === "undefined") return "Not supported here";
  return { granted: "Allowed", denied: "Blocked", default: "Not asked yet" }[Notification.permission] ?? Notification.permission;
}

/** Each detail, and how to get its value: a value now, or one that arrives. */
function gatherers(): Array<{ label: string; get: () => string | Promise<string> }> {
  return [
    { label: "Version", get: () => appVersion() },
    { label: "Build", get: () => `${buildCommit()}, built ${builtAt()}` },
    { label: "Mode", get: () => (isSampleMode() ? "Sample data" : hasToken() ? "Connected" : "Not connected") },
    { label: "Server", get: serverStatus },
    { label: "Waiting to sync", get: async () => { const n = await pendingOutboxCount(); return n === 0 ? "Nothing" : `${n} ${n === 1 ? "change" : "changes"}`; } },
    { label: "Last synced", get: async () => formatWhen(await getMeta("lastSyncAt")) },
    { label: "Offline copy", get: offlineCopy },
    { label: "Offline support", get: () => (navigator.serviceWorker?.controller ? "Active" : "Not active") },
    { label: "Installed", get: installed },
    { label: "Notifications", get: notifications },
    { label: "Time zone", get: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown" },
    { label: "Language", get: () => navigator.language || "unknown" },
    { label: "Screen", get: () => `${innerWidth} × ${innerHeight}, ${devicePixelRatio}x` },
    { label: "Browser", get: () => navigator.userAgent },
  ];
}

export function aboutAthenaSection(): { el: HTMLElement; destroy: () => void } {
  const details: Detail[] = [];
  const list = h("dl", { class: "about-details" });

  for (const g of gatherers()) {
    const detail: Detail = { label: g.label, value: "…" };
    details.push(detail);
    const dd = h("dd", {}, detail.value);
    list.append(h("dt", {}, g.label), dd);
    void Promise.resolve()
      .then(() => g.get())
      .then(
        (value) => value,
        () => "unknown"
      )
      .then((value) => {
        detail.value = value;
        dd.textContent = value;
      });
  }

  const copy = h("button", { class: "btn btn--soft", type: "button" }, icons.copy(), "Copy details");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(formatDetails(details));
      showToast("Details copied", { icon: "check" });
    } catch {
      showToast("Couldn't copy here. Select the details and copy them instead");
    }
  });

  const el = h(
    "section",
    { class: "settings__section", "aria-labelledby": "settings-athena" },
    h("h2", { class: "settings__heading", id: "settings-athena" }, icons.laptop(), "About"),
    h("p", { class: "settings__lede" }, "Which version of Athena this is, and the details to include when you report a problem."),
    h("div", { class: "card settings__sub ask-money-card" }, versionSetting()),
    h("h3", { class: "about__subhead" }, "Details for a bug report"),
    h("p", { class: "about__note" }, "None of these are your content, keys or your site's address, so they're safe to paste into a public issue."),
    h("div", { class: "card settings__sub ask-money-card" }, list),
    h("div", { class: "settings__actions" }, copy),
    h(
      "p",
      { class: "about__links" },
      link(`${REPO_URL}/issues/new`, "Report a problem"),
      " · ",
      link(REPO_URL, "Source code"),
      " · ",
      link(`${REPO_URL}/blob/main/LICENSE`, "License")
    ),
    h("p", { class: "about__note" }, "Athena is free software under the GNU Affero General Public License, version 3 or later.")
  );
  return { el, destroy: () => undefined };
}
