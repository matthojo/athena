/**
 * #/community (and #/community?kind=flow&sort=downloads): the reviewed catalogue of assistants, skills, flows,
 * check-in questions, note templates and themes other people shared. A theme's row shows its colours, read by the
 * server from its files (CatalogueView `swatches`), in the mode the app is in when it has that mode. A filter by kind, a search, and an order: featured picks first and then the newest, or the
 * most downloaded (offered once the index carries counts). Each row says what it is, who made it, how often it was
 * downloaded when the index says, what it reaches in plain words, and the accounts it needs, marked connected or
 * not; tapping one opens its preview at #/add?catalogue=<id>, where nothing is kept until the owner says Add.
 *
 * Only Athena's server reads the catalogue (app/src/db/community.ts → GET /api/community). A plain line under the
 * title says what is read and from where, with the switch that stops it. Under it, when the list was last read and
 * "Check for new items" (POST /api/community/check: the server reads again only if its copy is over ten minutes old),
 * whose result is said in a polite live region. A kind with nothing listed says when the list was read and offers the
 * same check. States: loading, offline, unreachable, an empty search, the check switched off, and not set up.
 */
import "../styles/community.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { pageHead } from "../components/page-head";
import { librarySegments } from "../components/library-nav";
import type { ViewId } from "../components/nav";
import { showToast } from "../components/toast";
import { brandLogo } from "../components/brand-logo";
import { shortDate } from "../lib/format";
import { accountName } from "../team/share-words";
import { addHash, ADD_ROUTE, checkCatalogue, fetchCatalogue, setCommunityCheck, type CatalogueView } from "../db/community";
import { itemAccounts } from "../db/item-accounts";
import type { CatalogueItem } from "../../../lib/catalogue-types";
import type { ShareKind } from "../../../lib/share-kinds";
import { checkWords, communityHash, downloadWords, emptyKindWords, lastReadWords, filtered, hasDownloads, KIND_WORDS, readKind, readSort, tierDetail, tierIcon, tierWords, type CommunitySort, type KindFilter } from "./words";

const KIND_ICON: Record<ShareKind, IconName> = { assistant: "person", skill: "book", flow: "loop", checkin: "chat", template: "copy", theme: "contrast" };
const FILTERS: KindFilter[] = ["all", "assistant", "skill", "flow", "checkin", "template", "theme"];
const filterLabel = (k: KindFilter) => (k === "all" ? "All" : KIND_WORDS[k].many);

const SORTS: ReadonlyArray<{ sort: CommunitySort; label: string }> = [
  { sort: "featured", label: "Featured first" },
  { sort: "downloads", label: "Most downloaded" },
];

/** The filter and order as the address gives them: #/community?kind=flow&sort=downloads. */
export function renderCommunity(ctx: { query: string | null; go?: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  const params = new URLSearchParams(ctx.query ?? "");
  let kind = readKind(params.get("kind"));
  let sort = readSort(params.get("sort"));
  let query = "";
  let view: CatalogueView | null = null;
  let connected = new Set<string>();
  let alive = true;

  // ---------- the head ----------
  const fromFile = h("a", { class: "btn btn--soft btn--sm", href: ADD_ROUTE }, icons.plus(), h("span", {}, "From a file or link"));
  const head = pageHead({ segments: ctx.go ? librarySegments("community", ctx.go) : undefined, title: "Community", lede: "Assistants, skills, flows, check-in questions, templates and themes other people made. Each one is reviewed before it's listed, and nothing is added until you say so.", actions: [fromFile] });

  // The plain line: what's read, from where, and the switch.
  const swId = "community-check";
  const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id: swId, "aria-describedby": `${swId}-line`, disabled: true }) as HTMLInputElement;
  const lineText = h("span", { class: "cm-check__text", id: `${swId}-line` });
  let checking = false;
  /** Said after a check, until the next paint that isn't one. */
  let said: string | null = null;
  const checkButtons = new Set<HTMLButtonElement>();
  // When the list was read, and a way to ask for a fresh one. The words are a polite live region: a check's result is said.
  const freshText = h("span", { class: "cm-fresh__text", role: "status", "aria-live": "polite" });
  const freshButton = checkButton("btn btn--ghost btn--sm cm-fresh__btn");
  const fresh = h("div", { class: "cm-fresh", hidden: true }, freshText, freshButton);
  const check = h("div", { class: "cm-check", hidden: true }, icons.cloud(), h("label", { class: "cm-check__label", for: swId }, lineText), sw, fresh);

  // ---------- the controls ----------
  const searchInput = h("input", { type: "search", placeholder: "Search Community", "aria-label": "Search Community", autocomplete: "off", enterkeyhint: "search" }) as HTMLInputElement;
  const search = h("label", { class: "search cm-search" }, icons.search(), searchInput);
  const filterButtons = FILTERS.map((k) => {
    const count = h("span", { class: "cm-filter__count" });
    const b = h("button", { class: "cm-filter", type: "button", "data-kind": k, "aria-pressed": String(k === kind) }, h("span", {}, filterLabel(k)), count) as HTMLButtonElement;
    b.addEventListener("click", () => {
      if (kind === k) return;
      kind = k;
      history.replaceState(history.state, "", communityHash(kind, sort));
      paint();
    });
    return { b, count, k };
  });
  const filter = h("div", { class: "cm-filters", role: "group", "aria-label": "Show" }, ...filterButtons.map((f) => f.b));

  // The order: shown beside the list's first heading, once the index carries download counts.
  const sortButtons = SORTS.map((o) => {
    const b = h("button", { class: "cm-sort__item", type: "button", "aria-pressed": String(o.sort === sort) }, o.label) as HTMLButtonElement;
    b.addEventListener("click", () => {
      if (sort === o.sort) return;
      sort = o.sort;
      history.replaceState(history.state, "", communityHash(kind, sort));
      paint();
    });
    return { b, sort: o.sort };
  });
  const sorter = h("div", { class: "cm-sort", role: "group", "aria-label": "Order" }, ...sortButtons.map((s) => s.b));
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

  // ---------- "Check for new items" ----------

  function checkButton(cls: string): HTMLButtonElement {
    const b = h("button", { class: cls, type: "button" }, icons.refresh(), h("span", {}, "Check for new items")) as HTMLButtonElement;
    b.addEventListener("click", () => void runCheck(b));
    checkButtons.add(b);
    return b;
  }

  async function runCheck(from: HTMLButtonElement) {
    if (checking || !view?.on) return;
    checking = true;
    // Disabling a button drops its focus, so note it first.
    const hadFocus = document.activeElement === from;
    const before = new Set(view.items.map((i) => i.id));
    for (const b of checkButtons) {
      b.disabled = true;
      b.setAttribute("aria-busy", "true");
      b.querySelector("span")!.textContent = "Checking";
    }
    try {
      const v = await checkCatalogue();
      if (!alive) return;
      // A failed read still answers with the copy kept, so the list shown stays.
      view = v;
      said = v.on ? checkWords(v, before) : null;
    } catch {
      if (!alive) return;
      said = "That didn't work. Check you're online.";
    } finally {
      checking = false;
      for (const b of [...checkButtons]) {
        b.disabled = false;
        b.removeAttribute("aria-busy");
        b.querySelector("span")!.textContent = "Check for new items";
      }
    }
    paint();
    // Keep focus on a check button: the one pressed, or, when the list was painted again, the empty state's new one
    // or the one under the switch.
    if (hadFocus) (from.isConnected ? from : ((list.querySelector(".cm-state .btn") as HTMLButtonElement | null) ?? freshButton)).focus();
  }

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

  /** A theme's colours in the app's mode when it has that mode, else its other one: page, card, text, accent, then chart colours. */
  function themeColours(item: CatalogueItem): string[] | null {
    const sw = view?.swatches?.[item.id];
    const dark = document.documentElement.dataset.scheme === "dark";
    const list = (dark ? (sw?.dark ?? sw?.light) : (sw?.light ?? sw?.dark)) ?? null;
    return list?.length ? list : null;
  }

  /** A theme's tile: its page with a card on it, a line of its text and its accent. Its icon when its colours didn't load. */
  function themeTile(item: CatalogueItem): HTMLElement | null {
    const list = themeColours(item);
    if (!list) return null;
    const [page, surface, text, accent] = list;
    const tile = h("span", { class: "tile tile--sm cm-row__tile cm-swatch", "aria-hidden": "true" }, h("span", { class: "cm-swatch__card" }, h("span", { class: "cm-swatch__line" }), h("span", { class: "cm-swatch__accent" })));
    tile.style.setProperty("--sw-page", page);
    tile.style.setProperty("--sw-surface", surface ?? page);
    tile.style.setProperty("--sw-text", text ?? "currentColor");
    tile.style.setProperty("--sw-accent", accent ?? text ?? "currentColor");
    return tile;
  }

  /** A theme's palette beside its reach: each of its colours as a dot. */
  function palette(item: CatalogueItem): HTMLElement | null {
    const list = themeColours(item);
    return list ? h("li", { class: "cm-palette" }, ...list.map((c) => h("span", { class: "cm-palette__dot", style: `background:${c}` }))) : null;
  }

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
    const downloads = downloadWords(item.downloads);
    const label = `${item.name}. ${KIND_WORDS[item.kind].one} ${by}.${downloads ? ` ${downloads}.` : ""} ${item.summary} ${tier}.${needWords}${added ? " Already added." : ""}`;
    return h(
      "a",
      { class: `cm-row cm-row--${item.kind}`, href: addHash({ catalogue: item.id }), "data-id": item.id, "aria-label": label },
      (item.kind === "theme" ? themeTile(item) : null) ?? h("span", { class: `tile tile--sm cm-row__tile cm-row__tile--${item.kind}`, "aria-hidden": "true" }, icons[KIND_ICON[item.kind]]()),
      h(
        "span",
        { class: "cm-row__body" },
        h("span", { class: "cm-row__top" }, h("span", { class: "cm-row__name" }, item.name), added ? h("span", { class: "badge cm-row__added" }, "Added") : null),
        h("span", { class: "cm-row__summary" }, item.summary),
        h("span", { class: "cm-row__meta" }, h("span", { class: "cm-row__kind" }, KIND_WORDS[item.kind].one), h("span", { class: "cm-row__by" }, by), downloads ? h("span", { class: "cm-row__downloads" }, downloads) : null),
        h("ul", { class: "cm-needs", "aria-hidden": "true" }, h("li", { class: `cm-tier cm-tier--${item.reach.tier}`, title: tierDetail(item.reach.tier) }, icons[tierIcon(item.reach)](), h("span", {}, tier)), item.kind === "theme" ? palette(item) : null, ...needs)
      ),
      h("span", { class: "cm-row__chevron", "aria-hidden": "true" }, icons.chevronRight())
    );
  }

  /** A heading and its items. The first heading on the page carries the order, when there is one to choose. */
  function group(title: string, items: CatalogueItem[], added: Set<string>, o: { featured?: boolean; first?: boolean } = {}): HTMLElement[] {
    if (!items.length) return [];
    const heading = h("h2", { class: "cm-group__title" }, title);
    const top = o.first && canSort ? h("div", { class: "cm-group__head" }, heading, sorter) : heading;
    return [top, h("div", { class: `card card--flush cm-group${o.featured ? " cm-group--featured" : ""}`, "data-count": String(items.length) }, ...items.map((i) => row(i, added.has(i.id))))];
  }

  let canSort = false;

  function paint() {
    if (!alive || !view) return;
    const v = view;
    check.hidden = !v.configured;
    // Buttons from an empty state that's gone no longer count.
    for (const b of [...checkButtons]) if (b !== freshButton && !b.isConnected) checkButtons.delete(b);
    fresh.hidden = !v.on || !v.fetched_at;
    // A list that couldn't be read again says so here, with when the list shown was read.
    freshText.textContent = said ?? (v.error ? checkWords(v, new Set(v.items.map((i) => i.id))) : lastReadWords(v.fetched_at)) ?? "";
    said = null;
    sw.checked = v.on;
    sw.disabled = false;
    lineText.replaceChildren(
      v.on
        ? h("span", {}, "Athena's server reads this list from ", h("strong", {}, v.host ?? "the catalogue"), " at most once a day, or when you check for new items. It reads a theme's colours once for each version, and an item when you open it. Nothing about you is sent.")
        : h("span", {}, "Athena doesn't contact ", h("strong", {}, v.host ?? "the catalogue"), " while this is off.")
    );
    const browsing = v.configured && v.on && v.items.length > 0;
    controls.hidden = !browsing;
    note.hidden = true;

    if (!v.configured) {
      return show(state({ icon: "globe", title: "Community is switched off here", sub: "Whoever runs this Athena set it to use no catalogue, so there's nothing to browse. You can still add something someone sent you.", actions: [addLink()] }));
    }
    if (!v.on) {
      const on = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Switch it on");
      on.addEventListener("click", () => {
        sw.checked = true;
        sw.dispatchEvent(new Event("change"));
      });
      return show(state({ icon: "cloud", title: "Checking the catalogue is off", sub: "Switch it on to browse what other people shared, and to hear about updates to what you added from it. You can still add an item from a file or a link.", actions: [on, addLink()] }));
    }
    if (!v.items.length) {
      if (v.error) return show(state({ icon: "cloud", title: "Community didn't load", sub: `${v.error} Try again in a few minutes.`, actions: [retryButton()] }));
      const read = lastReadWords(v.fetched_at);
      return show(state({ icon: "globe", title: "Nothing listed yet", sub: read ? `The catalogue is empty for now. ${read}` : "The catalogue is empty for now.", actions: v.fetched_at ? [checkButton("btn btn--soft btn--sm")] : [] }));
    }
    if (v.error && !v.fetched_at) {
      note.hidden = false;
      note.replaceChildren(icons.clock(), h("span", {}, `${v.error} This is the list from ${v.generated_at ? shortDate(v.generated_at) : "earlier"}.`));
    }

    canSort = hasDownloads(v.items);
    const order: CommunitySort = canSort ? sort : "featured";
    for (const s of sortButtons) s.b.setAttribute("aria-pressed", String(s.sort === order));
    const { items, counts } = filtered(v.items, kind, query, accountName, order);
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
      if (searching) return show(state({ icon: "search", title: `Nothing matches “${query.trim()}”${where}`, sub: "Try fewer words, or a name, an account or an author.", actions: [clear] }));
      const empty = emptyKindWords(kind as ShareKind, v.fetched_at);
      return show(state({ icon: "search", title: empty.title, sub: empty.sub, actions: v.fetched_at ? [checkButton("btn btn--soft btn--sm")] : [] }));
    }
    if (searching) return show(...group(`${items.length} ${items.length === 1 ? "result" : "results"}`, items, added, { first: true }));
    // The order's own name is on the button beside it, so the heading says how many.
    if (order === "downloads") return show(...group(kind === "all" ? `${items.length} ${items.length === 1 ? "item" : "items"}` : `${items.length} ${(items.length === 1 ? KIND_WORDS[kind].one : KIND_WORDS[kind].many).toLowerCase()}`, items, added, { first: true }));
    const featured = items.filter((i) => i.featured);
    const rest = items.filter((i) => !i.featured);
    show(...group("Featured", featured, added, { featured: true, first: true }), ...group("Newest", rest, added, { first: !featured.length }));
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
