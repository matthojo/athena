/**
 * #/community (and #/community?kind=flow): the reviewed catalogue of assistants, skills and flows other people
 * shared. A filter by kind, a search, featured picks first and then the newest. Each row says what it is, who made
 * it, what it reaches in plain words, and the accounts it needs, marked connected or not; tapping one opens its
 * preview at #/add?catalogue=<id>, where nothing is kept until the owner says Add.
 *
 * Only Athena's server reads the catalogue (app/src/db/community.ts → GET /api/community). A plain line under the
 * title says what is read and from where, with the switch that stops it. States: loading, offline, unreachable,
 * an empty search, the check switched off, and not set up.
 */
import "../styles/community.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { pageHead } from "../components/page-head";
import { showToast } from "../components/toast";
import { brandLogo } from "../components/brand-logo";
import { shortDate } from "../lib/format";
import { accountName } from "../team/share-words";
import { addHash, ADD_ROUTE, fetchCatalogue, setCommunityCheck, type CatalogueView } from "../db/community";
import { itemAccounts } from "../db/item-accounts";
import type { CatalogueItem } from "../../../lib/catalogue-types";
import type { ShareKind } from "../../../lib/share-kinds";
import { communityHash, filtered, KIND_WORDS, readKind, tierDetail, tierWords, type KindFilter } from "./words";

const KIND_ICON: Record<ShareKind, IconName> = { assistant: "person", skill: "book", flow: "loop" };
/** The tier's mark: inside Athena, AI, a lookup, the web. */
const tierIcon = (r: CatalogueItem["reach"]): IconName => (r.tier === 1 ? "shield" : r.tier === 3 ? "globe" : r.model ? "sparkle" : "cloud");
const FILTERS: KindFilter[] = ["all", "assistant", "skill", "flow"];
const filterLabel = (k: KindFilter) => (k === "all" ? "All" : KIND_WORDS[k].many);

/** The search box and filter as the address gives them: #/community?kind=flow. */
export function renderCommunity(ctx: { query: string | null }): { el: HTMLElement; destroy: () => void } {
  const params = new URLSearchParams(ctx.query ?? "");
  let kind = readKind(params.get("kind"));
  let query = "";
  let view: CatalogueView | null = null;
  let connected = new Set<string>();
  let alive = true;

  // ---------- the head ----------
  const fromFile = h("a", { class: "btn btn--soft btn--sm", href: ADD_ROUTE }, icons.plus(), h("span", {}, "From a file or link"));
  const head = pageHead({ title: "Community", lede: "Assistants, skills and flows other people made. Each one is reviewed before it's listed, and nothing is added until you say so.", actions: [fromFile] });

  // The plain line: what's read, from where, and the switch.
  const swId = "community-check";
  const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id: swId, "aria-describedby": `${swId}-line`, disabled: true }) as HTMLInputElement;
  const lineText = h("span", { class: "cm-check__text", id: `${swId}-line` });
  const check = h("div", { class: "cm-check", hidden: true }, icons.cloud(), h("label", { class: "cm-check__label", for: swId }, lineText), sw);

  // ---------- the controls ----------
  const searchInput = h("input", { type: "search", placeholder: "Search Community", "aria-label": "Search Community", autocomplete: "off", enterkeyhint: "search" }) as HTMLInputElement;
  const search = h("label", { class: "search cm-search" }, icons.search(), searchInput);
  const filterButtons = FILTERS.map((k) => {
    const count = h("span", { class: "cm-filter__count" });
    const b = h("button", { class: "cm-filter", type: "button", "data-kind": k, "aria-pressed": String(k === kind) }, h("span", {}, filterLabel(k)), count) as HTMLButtonElement;
    b.addEventListener("click", () => {
      if (kind === k) return;
      kind = k;
      history.replaceState(history.state, "", communityHash(kind));
      paint();
    });
    return { b, count, k };
  });
  const filter = h("div", { class: "cm-filters", role: "group", "aria-label": "Show" }, ...filterButtons.map((f) => f.b));
  const controls = h("div", { class: "cm-controls", hidden: true }, search, filter);

  const note = h("p", { class: "cm-note", role: "status", hidden: true });
  const results = h("p", { class: "cm-results visually-hidden", role: "status", "aria-live": "polite" });
  const list = h("div", { class: "cm-list", "aria-busy": "true" }, skeleton());
  const el = h("div", { class: "view community" }, head, check, controls, note, results, list);

  let typing: ReturnType<typeof setTimeout> | undefined;
  searchInput.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      query = searchInput.value;
      paint();
    }, 120);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value) {
      e.preventDefault();
      clearSearch();
    }
  });

  function clearSearch() {
    searchInput.value = "";
    query = "";
    paint();
    searchInput.focus();
  }

  sw.addEventListener("change", async () => {
    const on = sw.checked;
    sw.disabled = true;
    try {
      await setCommunityCheck(on);
      showToast(on ? "Athena will check the Community catalogue" : "Athena won't contact the Community catalogue", { icon: "check" });
      if (on) {
        list.setAttribute("aria-busy", "true");
        list.replaceChildren(skeleton());
        await load();
      } else if (view) {
        view = { ...view, on: false, items: [], error: null };
        paint();
      }
    } catch {
      sw.checked = !on;
      showToast("That didn't save. Check you're online", { icon: "wifiOff" });
    } finally {
      sw.disabled = false;
    }
  });

  // ---------- states ----------

  function state(o: { icon: IconName; title: string; sub: string; actions?: HTMLElement[] }): HTMLElement {
    return h("div", { class: "empty cm-state" }, h("span", { class: "tile", "aria-hidden": "true" }, icons[o.icon]()), h("p", { class: "empty__title" }, o.title), h("p", { class: "empty__sub" }, o.sub), o.actions?.length ? h("div", { class: "cm-state__acts" }, ...o.actions) : null);
  }

  const addLink = (cls = "btn btn--soft btn--sm") => h("a", { class: cls, href: ADD_ROUTE }, "Add from a file or link");

  function retryButton(): HTMLElement {
    const b = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.refresh(), h("span", {}, "Try again"));
    b.addEventListener("click", () => {
      list.setAttribute("aria-busy", "true");
      list.replaceChildren(skeleton());
      void load();
    });
    return b;
  }

  function show(...nodes: HTMLElement[]) {
    list.removeAttribute("aria-busy");
    list.replaceChildren(...nodes);
  }

  // ---------- the list ----------

  function row(item: CatalogueItem, added: boolean): HTMLElement {
    const tier = tierWords(item.reach);
    const needs = item.needs.map((p) => {
      const yes = connected.has(p);
      return h(
        "li",
        { class: `cm-need${yes ? " is-connected" : ""}` },
        brandLogo(p, "sm"),
        h("span", { class: "cm-need__name" }, accountName(p)),
        yes ? h("span", { class: "cm-need__mark", "aria-hidden": "true" }, icons.check()) : h("span", { class: "cm-need__state" }, "not connected")
      );
    });
    const needWords = item.needs.length ? ` Needs ${item.needs.map((p) => `${accountName(p)}, ${connected.has(p) ? "connected" : "not connected"}`).join("; ")}.` : "";
    const by = item.author ? `by ${item.author}` : "Author not named";
    const label = `${item.name}. ${KIND_WORDS[item.kind].one} ${by}. ${item.summary} ${tier}.${needWords}${added ? " Already added." : ""}`;
    return h(
      "a",
      { class: `cm-row cm-row--${item.kind}`, href: addHash({ catalogue: item.id }), "data-id": item.id, "aria-label": label },
      h("span", { class: `tile tile--sm cm-row__tile cm-row__tile--${item.kind}`, "aria-hidden": "true" }, icons[KIND_ICON[item.kind]]()),
      h(
        "span",
        { class: "cm-row__body" },
        h("span", { class: "cm-row__top" }, h("span", { class: "cm-row__name" }, item.name), added ? h("span", { class: "badge cm-row__added" }, "Added") : null),
        h("span", { class: "cm-row__summary" }, item.summary),
        h("span", { class: "cm-row__meta" }, h("span", { class: "cm-row__kind" }, KIND_WORDS[item.kind].one), h("span", { class: "cm-row__by" }, by)),
        h("ul", { class: "cm-needs", "aria-hidden": "true" }, h("li", { class: `cm-tier cm-tier--${item.reach.tier}`, title: tierDetail(item.reach.tier) }, icons[tierIcon(item.reach)](), h("span", {}, tier)), ...needs)
      ),
      h("span", { class: "cm-row__chevron", "aria-hidden": "true" }, icons.chevronRight())
    );
  }

  function group(title: string, items: CatalogueItem[], added: Set<string>): HTMLElement[] {
    if (!items.length) return [];
    return [h("h2", { class: "cm-group__title" }, title), h("div", { class: "card card--flush cm-group" }, ...items.map((i) => row(i, added.has(i.id))))];
  }

  function paint() {
    if (!alive || !view) return;
    const v = view;
    check.hidden = !v.configured;
    sw.checked = v.on;
    sw.disabled = false;
    lineText.replaceChildren(
      v.on
        ? h("span", {}, "Athena's server reads this list from ", h("strong", {}, v.host ?? "the catalogue"), " once a day, and an item when you open it. Nothing about you is sent.")
        : h("span", {}, "Athena doesn't contact ", h("strong", {}, v.host ?? "the catalogue"), " while this is off.")
    );
    const browsing = v.configured && v.on && v.items.length > 0;
    controls.hidden = !browsing;
    note.hidden = true;

    if (!v.configured) {
      return show(state({ icon: "globe", title: "Community isn't set up yet", sub: "This Athena has no catalogue address, so there's nothing to browse. Whoever runs it can add one. You can still add an item someone sent you.", actions: [addLink()] }));
    }
    if (!v.on) {
      const on = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Turn it on");
      on.addEventListener("click", () => {
        sw.checked = true;
        sw.dispatchEvent(new Event("change"));
      });
      return show(state({ icon: "cloud", title: "Checking the catalogue is off", sub: "Turn it on to browse what other people shared, and to hear about updates to what you added from it. You can still add an item from a file or a link.", actions: [on, addLink()] }));
    }
    if (!v.items.length) {
      if (v.error) return show(state({ icon: "cloud", title: "Community didn't load", sub: `${v.error} Try again in a few minutes.`, actions: [retryButton()] }));
      return show(state({ icon: "globe", title: "Nothing listed yet", sub: "The catalogue is empty for now. Check back later." }));
    }
    if (v.error) {
      note.hidden = false;
      note.replaceChildren(icons.clock(), h("span", {}, `${v.error} This is the list from ${v.generated_at ? shortDate(v.generated_at) : "earlier"}.`));
    }

    const { items, counts } = filtered(v.items, kind, query, accountName);
    for (const f of filterButtons) {
      f.b.setAttribute("aria-pressed", String(f.k === kind));
      f.count.textContent = String(counts[f.k]);
    }
    const added = new Set(v.added);
    const searching = query.trim().length > 0;
    results.textContent = searching ? `${items.length} ${items.length === 1 ? "result" : "results"}` : "";
    if (!items.length) {
      const clear = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Clear search");
      clear.addEventListener("click", clearSearch);
      const where = kind === "all" ? "" : ` in ${KIND_WORDS[kind].many.toLowerCase()}`;
      return show(state({ icon: "search", title: searching ? `Nothing matches “${query.trim()}”${where}` : `No ${KIND_WORDS[kind as ShareKind].many.toLowerCase()} yet`, sub: searching ? "Try fewer words, or a name, an account or an author." : "Try another kind.", actions: searching ? [clear] : [] }));
    }
    if (searching) return show(...group(`${items.length} ${items.length === 1 ? "result" : "results"}`, items, added));
    const featured = items.filter((i) => i.featured);
    const rest = items.filter((i) => !i.featured);
    show(...group("Featured", featured, added), ...group("Newest", rest, added));
  }

  async function load() {
    try {
      const [v, accounts] = await Promise.all([fetchCatalogue(), itemAccounts().catch(() => [])]);
      if (!alive) return;
      view = v;
      connected = new Set(accounts.map((a) => a.provider));
      paint();
    } catch (e) {
      if (!alive) return;
      const offline = (typeof navigator !== "undefined" && navigator.onLine === false) || e instanceof TypeError;
      check.hidden = true;
      controls.hidden = true;
      show(
        offline
          ? state({ icon: "wifiOff", title: "You're offline", sub: "Community needs a connection to your Athena. Try again when you're back online.", actions: [retryButton()] })
          : state({ icon: "cloud", title: "Community didn't load", sub: e instanceof Error && e.message ? e.message : "Try again in a few minutes.", actions: [retryButton()] })
      );
    }
  }

  const back = () => alive && view === null && void load();
  window.addEventListener("online", back);
  void load();
  return {
    el,
    destroy() {
      alive = false;
      clearTimeout(typing);
      window.removeEventListener("online", back);
    },
  };
}

/** Rows shaped like the real ones while the list loads. */
function skeleton(): HTMLElement {
  const line = (w: string, hgt = 12) => h("span", { class: "skeleton", style: `height:${hgt}px;width:${w}` });
  return h(
    "div",
    { class: "cm-skeleton", "aria-hidden": "true" },
    line("90px", 14),
    h(
      "div",
      { class: "card card--flush cm-group" },
      ...["62%", "48%", "70%", "55%"].map((w) => h("div", { class: "cm-row cm-row--ghost" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "cm-row__body" }, line(w, 14), line("88%"), line("40%"))))
    )
  );
}
