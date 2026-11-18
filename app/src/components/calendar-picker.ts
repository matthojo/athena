/**
 * Choose which calendars Athena reads, the same on Google Calendar, Outlook
 * and iCloud Calendar. Every calendar on the account, each with its colour,
 * who shared it, and how many events it has in the next 30 days, so the
 * right ones are easy to spot. Calendars that are off with nothing coming
 * up fold away.
 *
 * Where the choice lives differs, so nothing changes for anyone by surprise:
 *  - Google and Outlook save the calendars switched on (`calendars`). Until
 *    the owner chooses, only the main calendar is read, and calendars found
 *    later start off. The main calendar comes first.
 *  - iCloud saves the ones switched off in `scope`, as built, so calendars
 *    found later start on. Busiest first. Athena's own markers in `scope`
 *    (the invites switch) are kept.
 *
 * Built only with h() and text nodes.
 */
import { h } from "../lib/dom";
import { showToast } from "./toast";
import { plural } from "../lib/format";
import { getCalendars, updateConnector, type CalendarChoice } from "../db/api";
import { errorText } from "../lib/connectors-ui";
import type { Connector } from "../types";

type Account = Pick<Connector, "id" | "provider" | "scope" | "calendars">;

/**
 * The last list per account, for a few minutes: a switch saves, the sheet
 * rebuilds, and the picker paints straight away instead of asking the
 * calendar (30 days of events per calendar) all over again.
 */
const recent = new Map<string, { at: number; calendars: CalendarChoice[] }>();
const FRESH_MS = 5 * 60_000;
/** Accounts whose quiet calendars the owner unfolded: they stay open when the sheet rebuilds after a switch. */
const unfolded = new Set<string>();

/** iCloud keeps its choice as the calendars switched off; Google and Outlook as the ones on. */
const savesOff = (c: Pick<Connector, "provider">) => c.provider === "icloud-calendar";

/** "Shared by Rowan · 12 events coming up". */
function metaFor(c: CalendarChoice): string {
  const busy = c.upcoming ? `${c.upcoming} ${plural(c.upcoming, "event", "events")} coming up` : "Nothing coming up";
  const who = c.shared ? (c.owner ? `Shared by ${c.owner.split(" ")[0]}` : "Shared with you") : c.sharedByYou ? "You share this" : c.subscribed ? "Subscribed" : "";
  return who ? `${who} · ${busy}` : busy;
}

/** A hex colour from the calendar, or nothing (the dot then uses the accent). */
const safeColor = (v?: string) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : "");

/** A row-shaped placeholder while the calendars load. */
const placeholder = () =>
  h(
    "div",
    { class: "row cal-pick__row cal-pick__row--loading", "aria-hidden": "true" },
    h("span", { class: "cal-pick__dot skeleton" }),
    h("span", { class: "row__body" }, h("span", { class: "skeleton cal-pick__bar" }), h("span", { class: "skeleton cal-pick__bar cal-pick__bar--short" })),
    h("span", { class: "skeleton cal-pick__knob" })
  );

export function calendarsGroup(c: Account, opts: { onSaved?: () => void } = {}): HTMLElement {
  const off = savesOff(c);
  const list = h(
    "div",
    { class: "card card--flush list cal-pick", "aria-busy": "true" },
    h("span", { class: "visually-hidden" }, "Finding your calendars…"),
    placeholder(),
    placeholder(),
    placeholder()
  );
  const note = h(
    "p",
    { class: "form__hint" },
    off ? "Meetings and Ask read only these. New calendars start on. Changes apply from the next run." : "Meetings and Ask read only these. New calendars start off. Changes apply from the next run."
  );
  const el = h("section", { class: "group cal-picker" }, h("h3", { class: "group__label" }, "Calendars Athena reads"), list, note);
  // Athena's own markers in iCloud's `scope` (the invites switch) aren't calendars: kept as they are.
  const markers = (c.scope ?? "").split(/\s+/).filter((t) => t.includes(":"));

  async function save(rows: Array<{ sw: HTMLInputElement; cal: CalendarChoice }>, changed: HTMLInputElement) {
    const on = rows.filter((r) => r.sw.checked);
    const patch = off
      ? { scope: [...rows.filter((r) => !r.sw.checked).map((r) => r.cal.id), ...markers].join(" ") }
      : { calendars: on.map((r) => r.cal.id) };
    rows.forEach((r) => (r.sw.disabled = true));
    try {
      await updateConnector(c.id, patch);
      const cached = recent.get(c.id);
      if (cached) cached.calendars = cached.calendars.map((x) => ({ ...x, chosen: on.some((r) => r.cal.id === x.id) }));
      showToast(on.length === rows.length ? "Athena reads every calendar" : `Athena reads ${on.length} of ${rows.length} calendars`, { icon: "calendar" });
      opts.onSaved?.();
    } catch (err) {
      changed.checked = !changed.checked;
      showToast(errorText(err, "Couldn't change that"), { icon: "close", timeoutMs: 6000 });
    } finally {
      rows.forEach((r) => (r.sw.disabled = false));
    }
  }

  async function load() {
    list.setAttribute("aria-busy", "true");
    try {
      const hit = recent.get(c.id);
      const calendars = hit && Date.now() - hit.at < FRESH_MS ? hit.calendars : (await getCalendars(c.id)).calendars;
      if (calendars !== hit?.calendars) recent.set(c.id, { at: Date.now(), calendars });
      // Google and Outlook: the main calendar first, as it's the one that starts on. Then the busiest.
      const sorted = [...calendars].sort((a, b) => (off ? 0 : Number(!!b.primary) - Number(!!a.primary)) || b.upcoming - a.upcoming || a.name.localeCompare(b.name));
      const rows = sorted.map((cal) => {
        const sw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": `Read ${cal.name}` }) as HTMLInputElement;
        sw.checked = cal.chosen;
        const dot = h("span", { class: "cal-pick__dot", "aria-hidden": "true" });
        const color = safeColor(cal.color);
        if (color) dot.style.background = color;
        const title = h(
          "span",
          { class: "row__title-line" },
          h("span", { class: "row__title" }, cal.name),
          cal.primary && !off ? h("span", { class: "badge cal-pick__main" }, "Main") : null
        );
        const row = h("label", { class: "row cal-pick__row" }, dot, h("span", { class: "row__body" }, title, h("span", { class: "row__meta" }, metaFor(cal))), sw);
        return { sw, cal, row };
      });
      for (const r of rows)
        r.sw.addEventListener("change", () => {
          if (!rows.some((x) => x.sw.checked)) {
            r.sw.checked = true;
            showToast("Keep at least one calendar on", { icon: "calendar" });
            return;
          }
          void save(rows, r.sw);
        });
      if (!rows.length) {
        list.replaceChildren(h("div", { class: "row" }, h("span", { class: "row__body" }, h("span", { class: "row__title" }, "No calendars yet"), h("span", { class: "row__meta" }, "Add one in your calendar app and it shows here."))));
        return;
      }
      // Quiet calendars (nothing in the next 30 days) that are off fold away, so the busy ones and what follows stay in view.
      // Every calendar Athena reads stays in sight, the main one included.
      const quiet = rows.filter((r) => !r.cal.upcoming && !r.cal.chosen && !(r.cal.primary && !off));
      if (quiet.length >= 2 && quiet.length < rows.length && !unfolded.has(c.id)) {
        const more = h(
          "button",
          { class: "row cal-pick__more", type: "button", "aria-expanded": "false" },
          h("span", { class: "row__body" }, h("span", { class: "row__title cal-pick__more-text" }, `Show ${quiet.length} quiet calendars`))
        );
        quiet.forEach((r) => (r.row.hidden = true));
        more.addEventListener("click", () => {
          unfolded.add(c.id);
          quiet.forEach((r) => (r.row.hidden = false));
          more.remove();
          quiet[0].sw.focus();
        });
        list.replaceChildren(...rows.map((r) => r.row), more);
      } else list.replaceChildren(...rows.map((r) => r.row));
    } catch (err) {
      const retry = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Try again");
      retry.addEventListener("click", () => void load());
      list.replaceChildren(
        h(
          "div",
          { class: "row" },
          h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Couldn't load your calendars"), h("span", { class: "row__meta" }, errorText(err, "Your calendar didn't answer."))),
          retry
        )
      );
    } finally {
      list.setAttribute("aria-busy", "false");
    }
  }
  void load();
  return el;
}
