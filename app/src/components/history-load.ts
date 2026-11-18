/**
 * Loading an account's history (netlify/lib/connectors/backfill.ts), as one
 * row: "Loading your history… 1,240 items so far" while it runs, then
 * "History loaded back to March 2019". Used by the connected sheet and the
 * account's page, which adds "Load history again".
 *
 * The row asks the server every few seconds while the load is running and
 * stops once it's done or the row leaves the page. Built only with h() and
 * text nodes.
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { isSampleMode, request } from "../db/api";
import { errorText } from "../lib/connectors-ui";
import { sampleHistory } from "../db/sample-history";
import { HISTORY_LOADS } from "../../../lib/connector-presets";
import { historyWords, type HistoryStatus } from "../lib/history-words";
import "../styles/history-load.css";

export type { HistoryProgress, HistoryStatus } from "../lib/history-words";
export const loadsHistory = (provider: string) => (HISTORY_LOADS as readonly string[]).includes(provider);

const POLL_MS = 3000;
const longDay = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long" });

async function fetchStatus(id: string): Promise<HistoryStatus | null> {
  if (isSampleMode()) return sampleHistory(id);
  try {
    return await request<HistoryStatus>(`/connectors/${encodeURIComponent(id)}/backfill`);
  } catch {
    return null;
  }
}

/**
 * The row. `again` adds the "Load history again" button. Removes itself if
 * the account turns out to have no history to load.
 */
export function historyRow(c: { id: string; name: string; provider: string }, opts: { again?: boolean } = {}): HTMLElement {
  const title = h("span", { class: "row__title" }, "Loading your history…");
  const meta = h("span", { class: "row__meta" });
  const takeout = h("span", { class: "row__meta hist-row__takeout", hidden: true });
  const tile = h("span", { class: "tile tile--sm hist-row__tile" }, icons.clock());
  const live = h("span", { class: "visually-hidden", role: "status" });
  const again = opts.again ? (h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Load history again") as HTMLButtonElement) : null;
  const row = h("div", { class: "row acct-used hist-row" }, tile, h("span", { class: "row__body" }, title, meta, takeout, live), again);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastState = "";

  const paint = (s: HistoryStatus) => {
    const w = historyWords(s.progress, c.name);
    title.textContent = w.title;
    meta.textContent = w.meta;
    row.classList.toggle("hist-row--busy", w.busy);
    if (again) again.disabled = w.busy;
    if (s.takeout) {
      takeout.hidden = false;
      takeout.textContent = `Your Takeout import from ${longDay(s.takeout.at)} has the videos you watched, which YouTube's API doesn't share`;
    }
    // Say it once when it finishes, not on every count.
    const state = s.progress?.state ?? "";
    if (lastState && state !== lastState && !w.busy) live.textContent = w.title;
    lastState = state;
  };

  const poll = async () => {
    if (!row.isConnected && lastState) return;
    const s = await fetchStatus(c.id);
    if (!s || !s.supported) {
      row.remove();
      return;
    }
    paint(s);
    if (s.progress && (s.progress.state === "running" || s.progress.state === "waiting")) timer = setTimeout(() => void poll(), POLL_MS);
  };

  again?.addEventListener("click", async () => {
    again.disabled = true;
    clearTimeout(timer);
    try {
      const s = isSampleMode() ? sampleHistory(c.id, { again: true }) : await request<HistoryStatus>(`/connectors/${encodeURIComponent(c.id)}/backfill`, { method: "POST" });
      if (s) paint(s);
      timer = setTimeout(() => void poll(), POLL_MS);
    } catch (err) {
      again.disabled = false;
      showToast(errorText(err, "Couldn't start loading it"), { icon: "close", timeoutMs: 6000 });
    }
  });

  void poll();
  return row;
}
