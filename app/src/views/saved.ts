/**
 * Saved (#/saved): links, images, quotes, snippets and notes sent to Athena
 * from the Share sheet, Siri, the browser extension or the share target.
 *
 *  - #/saved: the cards, newest first, grouped Today / Yesterday / earlier,
 *    with a filter row (All · Links · Images · Quotes · Snippets · Notes),
 *    search (words in the readable copy count too) and a box to paste a
 *    link or keep a thought.
 *  - #/saved/<id>: one item. A link opens as a reader (the readable copy,
 *    the original link, your note); an image opens large; a quote as a card
 *    with its source.
 *  - #/saved/shared: where the installed app's share target lands
 *    (sw.js keeps what was shared; this sends it and says "Saved", or asks
 *    first when sw.js couldn't tell the share came from the OS).
 *  - Actions (components/saved-actions.ts): an item page suggests the best
 *    fit ("Move to Watch & read") with More actions; cards have a quick
 *    action (hover, or long-press); what an action filed is under Filed.
 *
 * The page's text is never HTML from the page: the readable copy is plain
 * paragraphs, drawn here with textContent.
 */

import { openAsk } from "../lib/open-ask";
import { savedTitle } from "../../../lib/mentions";
import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { librarySegments } from "../components/library-nav";
import { showToast } from "../components/toast";
import { confirmDialog } from "../components/confirm";
import { autoTextarea } from "../components/fields";
import { hueFor, plural, relativeTime } from "../lib/format";
import { localToday } from "../lib/time";
import { isSampleMode } from "../db/api";
import { savesAtOnce, setAlwaysSaveShares } from "../db/share-prefs";
import { forgetSavedImage, getSavedItem, loadSaved, onSavedChange, patchSaved, refetchSaved, removeSaved, saveNew, savedImageUrl, type SavedItem, type SavedKind, type SavedPage } from "../db/saved";
import { readingTime } from "../../../lib/saved-rules";
import { filedLine, quickAction, savedActionsPanel, thingText } from "../components/saved-actions";
import type { ViewId } from "../components/nav";
import "../styles/saved.css";
import "../styles/life.css"; // the "always save" row on the share prompt, as in Settings (life-prefs__row)
import "../styles/knows.css";
import { pageHead } from "../components/page-head";
import { kindMark, trackerHref, trackingFor, trackingPanel, untilGone } from "../components/tracking";
import { openTrackSheet } from "../components/track-sheet";
import { getTracker, listTrackers, onTrackersChange, stopTracking, updateTracker, type TrackerView } from "../db/trackers";
import { checkedLine, readTracker, trackerGlance, trackerGlanceParts } from "../lib/tracker-words";

type Go = (view: ViewId, opts?: { noteId?: string | null }) => void;

const KIND_LABEL: Record<SavedKind, { one: string; many: string; icon: IconName }> = {
  link: { one: "Link", many: "Links", icon: "link" },
  image: { one: "Image", many: "Images", icon: "image" },
  quote: { one: "Quote", many: "Quotes", icon: "quote" },
  snippet: { one: "Snippet", many: "Snippets", icon: "code" },
  note: { one: "Note", many: "Notes", icon: "note" },
};
type Filter = SavedKind | null | "filed" | "tracking";
const FILTERS: Filter[] = [null, "link", "image", "quote", "snippet", "note", "tracking", "filed"];

/** Where a recipe link went, when the server filed it into Recipes. */
const recipeHref = (item: SavedItem): string | null => (item.filed?.action === "recipe" && item.filed.href?.startsWith("#/recipes/") ? item.filed.href : null);

const safeHref = (raw: string | null | undefined) => (raw && /^https?:\/\//i.test(raw) ? raw : null);
const hostOf = (raw: string | null | undefined) => {
  try {
    return raw ? new URL(raw).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
};

/** "Today", "Yesterday", "Earlier this week", "Earlier this month", "October". */
function bucketOf(day: string, today: string): string {
  const diff = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "Earlier this week";
  if (day.slice(0, 7) === today.slice(0, 7)) return "Earlier this month";
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-GB", { month: "long", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(Date.parse(`${day}T12:00:00Z`));
}

/** A site's mark: its first letter on a tint of its own. */
function siteMark(name: string): HTMLElement {
  return h("span", { class: "sv-site__mark", style: `--hue:${hueFor(name)}`, "aria-hidden": "true" }, name.replace(/^the\s+/i, "").charAt(0).toUpperCase());
}

function siteLine(item: SavedItem, extra?: string | null): HTMLElement | null {
  const name = item.site ?? hostOf(item.url ?? item.source_url);
  if (!name && !extra) return null;
  return h("span", { class: "sv-site" }, name ? siteMark(name) : null, h("span", { class: "sv-site__name" }, [name, extra].filter(Boolean).join(" · ")));
}

/** The image box: its shape from the start, its tone while it loads, faded in. */
export function savedPicture(item: SavedItem, size: "sm" | "lg", opts: { maxRatio?: number; minRatio?: number; alt?: string } = {}): HTMLElement | null {
  if (!item.image_url) return null;
  const w = item.image_w ?? 4;
  const hgt = item.image_h ?? 3;
  const ratio = Math.min(opts.maxRatio ?? 2, Math.max(opts.minRatio ?? 0.62, w / hgt));
  const img = h("img", { alt: opts.alt ?? "", decoding: "async", draggable: "false" }) as HTMLImageElement;
  const box = h("span", { class: "sv-pic", style: `aspect-ratio:${ratio};--ar:${ratio};${item.image_tone ? `--tone:${item.image_tone}` : ""}` }, img);
  img.addEventListener("load", () => box.classList.add("is-loaded"));
  const load = () =>
    void savedImageUrl(item, size).then((url) => {
      if (url) img.src = url;
      else box.classList.add("is-missing");
    });
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { rootMargin: "300px" }
    );
    requestAnimationFrame(() => io.observe(box));
  } else load();
  return box;
}

function metaLine(item: SavedItem): string {
  const read = item.kind === "link" ? readingTime(item.words) ?? (item.fetch_status === "preview" ? "Preview" : null) : null;
  return [read, relativeTime(item.saved_at).replace(/^in /, "")].filter(Boolean).join(" · ");
}

/** One card, sized by what it holds. */
export function savedCard(item: SavedItem & { match?: string }, open: (item: SavedItem) => void): HTMLElement {
  const body: (Node | null)[] = [];
  const kind = item.kind;
  if (kind === "link") {
    body.push(savedPicture(item, "sm", { maxRatio: 1.9, minRatio: 1.2 }));
    body.push(
      h(
        "span",
        { class: "sv-card__body" },
        siteLine(item),
        h("span", { class: "sv-card__title" }, item.title ?? hostOf(item.url) ?? "Untitled link"),
        thingText(item) ? h("span", { class: "sv-card__what" }, thingText(item)) : null,
        !item.image_url && item.excerpt ? h("span", { class: "sv-card__excerpt" }, item.excerpt) : null,
        item.match ? h("span", { class: "sv-card__match" }, item.match) : null,
        item.note ? h("span", { class: "sv-card__note" }, icons.pen(), h("span", {}, item.note)) : null,
        h("span", { class: "sv-card__meta" }, metaLine(item))
      )
    );
  } else if (kind === "image") {
    body.push(savedPicture(item, "sm", { maxRatio: 1.6, minRatio: 0.66, alt: item.note ?? "Saved image" }));
    const caption = item.note ?? item.title;
    body.push(h("span", { class: "sv-card__body sv-card__body--tight" }, caption ? h("span", { class: "sv-card__caption" }, caption) : null, h("span", { class: "sv-card__meta" }, [hostOf(item.source_url), metaLine(item)].filter(Boolean).join(" · "))));
  } else if (kind === "quote") {
    const by = [item.author, item.title ?? item.site ?? hostOf(item.source_url)].filter(Boolean).join(", ");
    body.push(
      h(
        "span",
        { class: "sv-card__body sv-quote" },
        h("span", { class: "sv-quote__mark", "aria-hidden": "true" }, "“"),
        h("span", { class: "sv-quote__text" }, (item.quote ?? "").replace(/^[“"]|[”"]$/g, "")),
        by ? h("span", { class: "sv-quote__by" }, by) : null,
        item.match && item.match !== item.quote ? h("span", { class: "sv-card__match" }, item.match) : null,
        h("span", { class: "sv-card__meta" }, metaLine(item))
      )
    );
  } else if (kind === "snippet") {
    body.push(
      h(
        "span",
        { class: "sv-card__body" },
        h("span", { class: "sv-code" }, h("code", {}, item.quote ?? "")),
        item.note ? h("span", { class: "sv-card__caption" }, item.note) : null,
        h("span", { class: "sv-card__meta" }, [item.site ?? hostOf(item.source_url), metaLine(item)].filter(Boolean).join(" · "))
      )
    );
  } else {
    body.push(h("span", { class: "sv-card__body" }, h("span", { class: "sv-card__text" }, item.quote ?? item.note ?? ""), item.match ? h("span", { class: "sv-card__match" }, item.match) : null, h("span", { class: "sv-card__meta" }, metaLine(item))));
  }
  const filed = filedLine(item);
  if (filed) body.push(h("span", { class: "sv-card__filed" }, filed));
  const label = `${KIND_LABEL[kind].one}: ${item.title ?? item.quote?.slice(0, 80) ?? item.note ?? ""}${item.filed ? `, filed in ${item.filed.label}` : ""}`;
  const card = h("button", { class: `sv-card sv-card--${kind}`, type: "button", "aria-label": label }, ...body);
  card.addEventListener("click", () => open(item));
  return card;
}

/** A tracker on its own, as a card: what it follows, where it stands now, who checked. */
export function trackerCard(view: TrackerView, open: (v: TrackerView) => void): HTMLElement {
  const r = readTracker(view);
  const site = hostOf(view.url);
  const glance = r ? trackerGlance(r) : "Nothing read yet";
  const parts = r ? trackerGlanceParts(r) : null;
  const who = r ? checkedLine(r.latest) : null;
  const card = h(
    "button",
    { class: `sv-card sv-card--tracker${r?.target === "reached" ? " is-reached" : ""}`, type: "button", "aria-label": `Tracking: ${view.name}, ${glance}` },
    h(
      "span",
      { class: "sv-card__body" },
      h("span", { class: "sv-site" }, h("span", { class: "sv-site__mark sv-site__mark--track", "aria-hidden": "true" }, kindMark(view)), h("span", { class: "sv-site__name" }, [cap(view.label), site].filter(Boolean).join(" · "))),
      h("span", { class: "sv-card__title" }, view.name || cap(view.label)),
      h("span", { class: "sv-card__track" }, r?.target === "reached" ? h("span", { class: "tk-hit tk-hit--sm", "aria-hidden": "true" }) : null, parts?.value ?? "Nothing read yet"),
      parts ? h("span", { class: "sv-card__tracknote" }, parts.note) : null,
      h("span", { class: "sv-card__meta" }, who ?? (view.assistant_id ? "Waiting for its first check" : `Started ${relativeTime(view.created_at).replace(/^in /, "")}`))
    )
  );
  card.addEventListener("click", () => open(view));
  return card;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// ---------- the list ----------

export function renderSaved(ctx: { go: Go; itemId: string | null; isDesktop: () => boolean }): { el: HTMLElement; destroy: () => void } {
  if (ctx.itemId === "shared") return renderShared(ctx);
  if (ctx.itemId?.startsWith("tracker-")) return renderTracker(ctx.itemId.slice("tracker-".length), ctx);
  if (ctx.itemId && ctx.itemId !== "tracking") return renderItem(ctx.itemId, ctx);

  // #/saved/tracking opens on what you track on its own.
  let kind: Filter = ctx.itemId === "tracking" ? "tracking" : null;
  /** Trackers that stand on their own: their own kind in Saved. */
  let tracked: TrackerView[] = [];
  let query = "";
  let page: SavedPage | null = null;
  let alive = true;
  let seq = 0;

  const open = (item: SavedItem) => {
    history.pushState(history.state, "", `#/saved/${encodeURIComponent(item.id)}`);
    ctx.go("saved", { noteId: item.id });
  };
  const openTracker = (v: TrackerView) => {
    history.pushState(history.state, "", trackerHref(v));
    ctx.go("saved", { noteId: `tracker-${v.id}` });
  };

  const count = h("span", { class: "notes__count" });
  const input = h("input", { type: "search", placeholder: "Search what you've saved", "aria-label": "Search saved", autocomplete: "off", enterkeyhint: "search" }) as HTMLInputElement;
  const search = h("label", { class: "search sv-search" }, icons.search(), input);
  const chips = h("div", { class: "chip-row sv-filters", role: "toolbar", "aria-label": "Show" });

  const quick = h("input", { class: "quick-add__input", type: "text", placeholder: "Paste a link, or keep a thought", "aria-label": "Save a link or a thought", autocomplete: "off", enterkeyhint: "done" }) as HTMLInputElement;
  const quickForm = h("form", { class: "quick-add sv-quick" }, h("span", { class: "quick-add__icon", "aria-hidden": "true" }, icons.plus()), quick);
  quickForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = quick.value.trim();
    if (!text) return;
    quick.disabled = true;
    try {
      const { item, existing } = await saveNew({ text, source: "app" });
      quick.value = "";
      const recipe = recipeHref(item);
      if (recipe) showToast(existing ? "Already in Recipes" : `Saved to Recipes: “${item.title ?? hostOf(item.url) ?? "recipe"}”`, { icon: "pot", action: { label: "Open", run: () => (location.hash = recipe) } });
      else showToast(existing ? "Already in Saved" : item.kind === "link" ? `Saved “${item.title ?? hostOf(item.url) ?? "link"}”` : "Saved", { icon: "check" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff", timeoutMs: 4000 });
    } finally {
      quick.disabled = false;
    }
  });

  const list = h("div", { class: "sv-list", "aria-live": "polite" });
  const el = h(
    "div",
    { class: "view saved" },
    pageHead({
      segments: librarySegments("saved", ctx.go),
      title: "Saved",
      count,
      lede: "What you send from your phone or browser, kept on the day you saved it.",
      below: [h("div", { class: "sv-tools" }, search, quickForm), chips],
    }),
    list
  );

  function paintChips() {
    const c = page?.counts;
    chips.replaceChildren(
      ...FILTERS.filter((k) => !c || k === null || k === "tracking" || (c[k] ?? 0) > 0 || k === kind).map((k) => {
        const name = k === "filed" ? "Filed" : k === "tracking" ? "Tracking" : k ? KIND_LABEL[k].many : "All";
        const n = k === "tracking" ? tracked.length : c ? (k ? (c[k] ?? 0) : c.all + tracked.length) : null;
        const b = h("button", { class: `chip${k === "filed" ? " sv-filters__filed" : ""}`, type: "button", "aria-pressed": String(k === kind) }, name, n !== null && (k !== "tracking" || n > 0) ? h("span", { class: "chip__count" }, String(n)) : null);
        b.addEventListener("click", () => {
          if (kind === k) return;
          kind = k;
          paintChips();
          void load();
        });
        return b;
      })
    );
    // The chosen one in view, when it starts off the edge (#/saved/tracking).
    requestAnimationFrame(() => (chips.querySelector('[aria-pressed="true"]') as HTMLElement | null)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }

  function empty(): HTMLElement {
    if (query || kind) {
      return h(
        "div",
        { class: "empty" },
        h("span", { class: "tile" }, icons.search()),
        h("p", { class: "empty__title" }, query ? `Nothing saved matches “${query}”` : kind === "filed" ? "Nothing filed" : kind === "tracking" ? "Nothing tracked on its own yet" : `No ${KIND_LABEL[kind as SavedKind].many.toLowerCase()} yet`),
        h("p", { class: "empty__sub" }, query ? "Search looks in titles, your notes, quotes and the text of saved pages." : kind === "filed" ? "Move a saved book, film or video to Watch & read, or a find to someone's gift ideas, and it shows here with where it went." : "Try another filter, or All.")
      );
    }
    const how = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.phone(), "Set up your iPhone");
    how.addEventListener("click", () => ctx.go("settings", { noteId: "iphone" }));
    return h(
      "div",
      { class: "empty sv-empty" },
      h("span", { class: "tile" }, icons.bookmark()),
      h("p", { class: "empty__title" }, "Nothing saved yet"),
      h("p", { class: "empty__sub" }, "Share a page or a photo to Athena from your iPhone or browser, or paste a link above. Each one shows on the day you saved it."),
      how
    );
  }

  /** What you track on its own: newest check first, with a way to start one. */
  function paintTracking() {
    const q = query.toLowerCase();
    const shown = tracked
      .filter((t) => !q || `${t.name} ${t.label} ${t.url ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => (b.points[b.points.length - 1]?.checked_at ?? b.created_at).localeCompare(a.points[a.points.length - 1]?.checked_at ?? a.created_at));
    const start = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Track something");
    start.addEventListener("click", () => openTrackSheet({ onCreated: openTracker }));
    const intro = h("div", { class: "sv-trackhead" }, h("p", { class: "sv-trackhead__text" }, "Numbers and states you follow on their own. What you track on a saved item is on its page."), start);
    if (!shown.length) {
      list.replaceChildren(
        intro,
        h("div", { class: "empty sv-empty" }, h("span", { class: "tile" }, kindMark({ kind: "number" })), h("p", { class: "empty__title" }, q ? `Nothing tracked matches “${query}”` : "Nothing tracked on its own yet"), h("p", { class: "empty__sub" }, "A tariff, a waiting list, anything you check now and then. Athena keeps each check so you can see how it moves."))
      );
      return;
    }
    list.replaceChildren(intro, h("div", { class: "sv-grid" }, ...shown.map((t) => trackerCard(t, openTracker))));
  }

  function paint() {
    if (!page) return;
    count.textContent = String(page.counts.all + tracked.length);
    paintChips();
    if (kind === "tracking") return paintTracking();
    // Trackers on their own sit with the rest, on the day they started.
    const own = !kind && !query ? tracked.map((t) => ({ t, at: t.created_at, day: localToday(new Date(t.created_at)) })) : [];
    if (!page.items.length && !own.length) {
      list.replaceChildren(empty());
      return;
    }
    if (query) {
      list.replaceChildren(
        h("p", { class: "sv-found" }, `${page.items.length} ${plural(page.items.length, "match", "matches")}${page.more ? " (the best ones)" : ""}`),
        h("div", { class: "sv-grid" }, ...page.items.map(cardFor))
      );
      return;
    }
    if (kind === "filed") {
      list.replaceChildren(h("div", { class: "sv-grid" }, ...page.items.map(cardFor)));
      return;
    }
    const today = localToday();
    const groups = new Map<string, Array<{ at: string; el: () => HTMLElement }>>();
    const into = (day: string, at: string, el: () => HTMLElement) => {
      const b = bucketOf(day, today);
      groups.set(b, [...(groups.get(b) ?? []), { at, el }]);
    };
    const merged = [...page.items.map((i) => ({ day: i.saved_on, at: i.saved_at, el: () => cardFor(i) })), ...own.map((o) => ({ day: o.day, at: o.at, el: () => trackerCard(o.t, openTracker) }))].sort((a, b) => b.at.localeCompare(a.at));
    for (const m of merged) into(m.day, m.at, m.el);
    list.replaceChildren(
      ...[...groups].map(([label, items], gi) =>
        h(
          "section",
          { class: "sv-group reveal", style: `--i:${Math.min(gi, 5)}`, "aria-label": label },
          h("h2", { class: "group__label sv-group__label" }, label, h("span", { class: "group__count" }, String(items.length))),
          h("div", { class: "sv-grid" }, ...items.map((x) => x.el()))
        )
      )
    );
  }

  // The list reloads on any change (onSavedChange), so a filed card leaves by itself.
  const cardFor = (i: SavedItem & { match?: string }) => quickAction(i, savedCard(i, open), () => undefined);

  async function load() {
    const mine = ++seq;
    try {
      const [next, own] = await Promise.all([
        loadSaved({ kind: kind === "filed" || kind === "tracking" ? null : kind, filed: kind === "filed", q: query || undefined, limit: 120 }),
        listTrackers({ standalone: true }).catch(() => [] as TrackerView[]),
      ]);
      if (!alive || mine !== seq) return;
      page = next;
      tracked = own;
      paint();
    } catch (error) {
      if (!alive || mine !== seq) return;
      list.replaceChildren(h("div", { class: "empty" }, h("span", { class: "tile" }, icons.wifiOff()), h("p", { class: "empty__title" }, "Saved can't load right now"), h("p", { class: "empty__sub" }, error instanceof Error ? error.message : "Try again in a moment.")));
    }
  }

  let typing: number | undefined;
  input.addEventListener("input", () => {
    clearTimeout(typing);
    typing = window.setTimeout(() => {
      query = input.value.trim();
      void load();
    }, 220);
  });

  paintChips();
  list.append(h("div", { class: "sv-grid sv-grid--skeleton", "aria-hidden": "true" }, ...Array.from({ length: 6 }, (_, i) => h("span", { class: "sv-card sv-card--ghost", style: `--h:${[180, 120, 220, 140, 200, 110][i]}px` }))));
  void load();
  const off = onSavedChange(() => void load());
  const offTracked = onTrackersChange(() => void load());
  return {
    el,
    destroy: () => {
      alive = false;
      off();
      offTracked();
    },
  };
}

// ---------- one item ----------

/** A saved link that looks like a product: it has a price, it's a gift idea, or it's a shop's page. */
export function looksLikeProduct(item: Pick<SavedItem, "kind" | "thing" | "facts" | "filed">): boolean {
  return item.kind === "link" && (!!item.facts?.price || item.filed?.action === "gift_idea" || item.thing === "product");
}

/** The readable copy as nodes: "## " headings, "> " quotes, "• " lists, ``` code, paragraphs. */
export function readableNodes(text: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b) continue;
    if (b.startsWith("```")) out.push(h("pre", { class: "sv-reader__pre" }, h("code", {}, b.replace(/^```\w*\n?|\n?```$/g, ""))));
    else if (b.startsWith("## ")) out.push(h("h2", {}, b.slice(3)));
    else if (b.startsWith("> ")) out.push(h("blockquote", {}, b.replace(/^>\s?/gm, "")));
    else if (b.startsWith("• ")) out.push(h("ul", {}, ...b.split("\n").map((l) => h("li", {}, l.replace(/^•\s*/, "")))));
    else out.push(h("p", {}, b));
  }
  return out;
}

function backBar(ctx: { go: Go }, label = "Saved"): HTMLElement {
  const back = h("button", { class: "lib-nav__back sv-back", type: "button" }, icons.back(), label);
  back.addEventListener("click", () => {
    if (history.length > 1 && /#\/saved\//.test(location.hash) && history.state !== null) history.back();
    else ctx.go("saved");
  });
  return back;
}

function renderItem(id: string, ctx: { go: Go; isDesktop: () => boolean }): { el: HTMLElement; destroy: () => void } {
  const el = h("div", { class: "view saved sv-item", "aria-busy": "true" }, h("div", { class: "sv-item__bar" }, backBar(ctx)));
  let alive = true;

  const paint = (item: SavedItem) => {
    el.removeAttribute("aria-busy");
    el.dataset.kind = item.kind;
    const original = safeHref(item.url ?? item.source_url);

    // The owner's note: edited in place, saved when it loses focus.
    const note = autoTextarea(item.note ?? "", { class: "sv-note__input", placeholder: "Add a note", "aria-label": "Your note" }, 44);
    note.addEventListener("change", async () => {
      try {
        item = await patchSaved(item.id, { note: note.value.trim() || null });
        showToast("Note saved", { icon: "check" });
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't save the note", { icon: "wifiOff" });
      }
    });
    const noteBox = h("div", { class: "sv-note" }, h("span", { class: "sv-note__label" }, icons.pen(), "Your note"), note);

    const actions = h("div", { class: "sv-actions" });
    if (original) actions.append(h("a", { class: "btn btn--primary btn--sm", href: original, target: "_blank", rel: "noopener noreferrer" }, item.kind === "link" ? "Open original" : "Open source", icons.external()));
    if (item.kind === "quote" || item.kind === "snippet" || item.kind === "note") {
      const copy = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.copy(), "Copy");
      copy.addEventListener("click", () => void navigator.clipboard?.writeText(item.quote ?? "").then(() => showToast("Copied", { icon: "check" })));
      actions.append(copy);
    }
    if (item.kind === "link") {
      const again = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.refresh(), "Read again");
      again.addEventListener("click", async () => {
        again.setAttribute("aria-busy", "true");
        try {
          const fresh = await refetchSaved(item.id);
          if (alive) paint(fresh);
          showToast(fresh.has_readable ? "Updated from the page" : "The page has no article text to keep", { icon: fresh.has_readable ? "check" : "link" });
        } catch (error) {
          showToast(error instanceof Error ? error.message : "Couldn't read the page", { icon: "wifiOff" });
        } finally {
          again.removeAttribute("aria-busy");
        }
      });
      actions.append(again);
    }
    // Track this (components/track-sheet.ts). A product (a price, a gift idea, a shop's page) keeps Tracking in its
    // place, saying when nothing is tracked yet; any other link has it in the actions until something is.
    let trackedHere: TrackerView[] = [];
    const productLike = looksLikeProduct(item);
    const trackThis = h("button", { class: "btn btn--soft btn--sm", type: "button", hidden: true }, icons.target(), "Track this");
    const openTrack = () => openTrackSheet({ item, existing: trackedHere });
    trackThis.addEventListener("click", openTrack);
    const tracking =
      item.kind === "link"
        ? trackingFor(item.id, {
            onTrackMore: openTrack,
            productLike,
            onCount: (n, views) => {
              trackedHere = views;
              trackThis.hidden = productLike || n > 0;
            },
          })
        : null;
    if (item.kind === "link") actions.append(trackThis);
    // Ask with this one attached (lib/open-ask.ts).
    const askAbout = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.chat(), "Ask about this");
    askAbout.addEventListener("click", () => openAsk({ context: { kind: "saved", id: item.id, label: savedTitle(item) } }));
    actions.append(askAbout);
    const archive = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Archive" }, icons.archive());
    archive.addEventListener("click", async () => {
      await patchSaved(item.id, { archived: true });
      showToast("Archived", { icon: "archive", action: { label: "Undo", run: () => void patchSaved(item.id, { archived: false }) } });
      ctx.go("saved");
    });
    const del = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Delete" }, icons.trash());
    del.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Delete for good?", body: "It goes from Saved and from its day. This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
      await removeSaved(item.id);
      forgetSavedImage(item.id);
      showToast("Deleted", { icon: "trash" });
      ctx.go("saved");
    });
    actions.append(h("span", { class: "sv-actions__spacer" }), archive, del);
    const doPanel = savedActionsPanel(item, (next) => alive && paint({ ...item, ...next, readable: item.readable }));

    const savedLine = h("p", { class: "sv-saved-on" }, `Saved ${new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(Date.parse(item.saved_at))}`, " · ");
    const dayLink = h("a", { href: `#/days/${item.saved_on}` }, "Open the day");
    savedLine.append(dayLink);

    let main: HTMLElement;
    if (item.kind === "link") {
      const byline = [item.author, item.published_at ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(Date.parse(`${item.published_at}T12:00:00Z`)) : null, readingTime(item.words)].filter(Boolean).join(" · ");
      const text = item.readable ? h("div", { class: "sv-reader__text" }, ...readableNodes(item.readable)) : h("div", { class: "sv-reader__none" }, h("p", {}, item.excerpt ?? "No article text on this page."), h("p", { class: "sv-reader__none-sub" }, item.fetch_status === "failed" ? "Athena couldn't read the page when you saved it. Try Read again, or open the original." : item.thing && !["article", "video"].includes(item.thing) ? "Athena kept the page's summary." : "It looks like a video or a post, so Athena kept the preview."));
      main = h(
        "article",
        { class: "sv-reader" },
        savedPicture(item, "lg", { maxRatio: 2.4, minRatio: 1.9, alt: "" }),
        h("header", { class: "sv-reader__head" }, siteLine(item), h("h1", { class: "sv-reader__title" }, item.title ?? hostOf(item.url) ?? "Untitled link"), byline ? h("p", { class: "sv-reader__byline" }, byline) : null),
        // What it tracks (components/tracking.ts): its price, its stock, anything else. Hidden until it tracks something.
        tracking,
        actions,
        doPanel,
        noteBox,
        text,
        savedLine
      );
    } else if (item.kind === "image") {
      const pic = savedPicture(item, "lg", { maxRatio: 3, minRatio: 0.4, alt: item.note ?? "Saved image" });
      pic?.classList.add("sv-viewer__pic");
      pic?.addEventListener("click", () => el.classList.toggle("is-zoomed"));
      main = h("article", { class: "sv-viewer" }, h("div", { class: "sv-viewer__stage" }, pic), h("div", { class: "sv-viewer__side" }, siteLine(item, "Image"), noteBox, actions, doPanel, savedLine));
    } else if (item.kind === "quote") {
      const by = [item.author, item.title].filter(Boolean).join(", ");
      main = h(
        "article",
        { class: "sv-quote-page" },
        h("figure", { class: "sv-quote-card" }, h("span", { class: "sv-quote__mark", "aria-hidden": "true" }, "“"), h("blockquote", { class: "sv-quote-card__text" }, (item.quote ?? "").replace(/^[“"]|[”"]$/g, "")), by || item.site ? h("figcaption", { class: "sv-quote-card__by" }, by ? h("span", {}, by) : null, siteLine(item)) : null),
        actions,
        doPanel,
        noteBox,
        savedLine
      );
    } else {
      main = h(
        "article",
        { class: "sv-text-page" },
        siteLine(item, KIND_LABEL[item.kind].one),
        item.kind === "snippet" ? h("pre", { class: "sv-reader__pre sv-reader__pre--big" }, h("code", {}, item.quote ?? "")) : h("p", { class: "sv-text-page__text" }, item.quote ?? ""),
        actions,
        doPanel,
        noteBox,
        savedLine
      );
    }
    el.replaceChildren(h("div", { class: "sv-item__bar" }, backBar(ctx)), main);
  };

  getSavedItem(id).then(
    (item) => alive && paint(item),
    () => {
      if (!alive) return;
      el.removeAttribute("aria-busy");
      el.append(h("div", { class: "empty" }, h("span", { class: "tile" }, icons.bookmark()), h("p", { class: "empty__title" }, "That isn't in Saved any more"), h("p", { class: "empty__sub" }, "It may have been deleted on another device.")));
    }
  );
  return {
    el,
    destroy: () => {
      alive = false;
    },
  };
}

// ---------- a tracker on its own ----------

/** #/saved/tracker-<id>: one thing tracked on its own ("Octopus tariff"): its name and page, then its block. */
function renderTracker(id: string, ctx: { go: Go }): { el: HTMLElement; destroy: () => void } {
  const el = h("div", { class: "view saved sv-item sv-tracker", "aria-busy": "true" }, h("div", { class: "sv-item__bar" }, backBar(ctx)));
  let alive = true;
  let stopped = false;
  const leave = () => {
    stopped = true;
    history.replaceState(history.state, "", "#/saved/tracking");
    ctx.go("saved", { noteId: "tracking" });
  };

  const paint = async () => {
    const view = await getTracker(id).catch(() => null);
    if (!alive || stopped) return;
    el.removeAttribute("aria-busy");
    if (!view) {
      el.replaceChildren(h("div", { class: "sv-item__bar" }, backBar(ctx)), h("div", { class: "empty" }, h("span", { class: "tile" }, kindMark({ kind: "number" })), h("p", { class: "empty__title" }, "That isn't tracked any more"), h("p", { class: "empty__sub" }, "It may have been stopped on another device.")));
      return;
    }
    const page = safeHref(view.url);
    const host = hostOf(view.url);
    // The name, edited where it stands.
    const name = h("input", { class: "sv-tracker__name", type: "text", value: view.name, maxlength: 80, "aria-label": "Name", autocomplete: "off", spellcheck: "false", enterkeyhint: "done" }) as HTMLInputElement;
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
      if (e.key === "Escape") {
        name.value = view.name;
        name.blur();
      }
    });
    name.addEventListener("change", async () => {
      const next = name.value.replace(/\s+/g, " ").trim();
      if (!next || next === view.name) return void (name.value = view.name);
      await updateTracker(view.id, { name: next });
      showToast("Renamed", { icon: "check" });
    });
    // Who checks it is said on its block (components/tracking.ts), with a way to change it.
    const started = `Started ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(Date.parse(view.created_at))}`;
    const actions = h("div", { class: "sv-actions" });
    if (page) actions.append(h("a", { class: "btn btn--primary btn--sm", href: page, target: "_blank", rel: "noopener noreferrer" }, "Open page", icons.external()));
    const askAbout = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.chat(), "Ask about this");
    askAbout.addEventListener("click", () => openAsk({ prompt: `How has ${view.name} changed?` }));
    actions.append(askAbout);
    const stop = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Stop tracking" }, icons.trash());
    stop.addEventListener("click", async () => {
      const undo = await stopTracking(view);
      showToast(`Stopped tracking ${view.name}`, { icon: "trash", timeoutMs: 6500, action: { label: "Undo", run: () => void undo().then(() => {
        history.pushState(history.state, "", trackerHref(view));
        ctx.go("saved", { noteId: `tracker-${view.id}` });
      }) } });
      leave();
    });
    actions.append(h("span", { class: "sv-actions__spacer" }), stop);
    const panel = trackingPanel([view], { title: null, onStop: leave });
    el.replaceChildren(
      h("div", { class: "sv-item__bar" }, backBar(ctx)),
      h(
        "article",
        { class: "sv-reader sv-tracker__page" },
        h("header", { class: "sv-reader__head" }, h("span", { class: "sv-site" }, h("span", { class: "sv-site__mark sv-site__mark--track", "aria-hidden": "true" }, kindMark(view)), h("span", { class: "sv-site__name" }, ["Tracking", host].filter(Boolean).join(" · "))), h("h1", { class: "sv-reader__title" }, name), h("p", { class: "sv-reader__byline" }, started)),
        panel,
        actions
      )
    );
  };
  void paint();
  const off = onTrackersChange(() => void paint());
  untilGone(el, () => off());
  return {
    el,
    destroy: () => {
      alive = false;
      off();
    },
  };
}

// ---------- the share target ----------

export interface SharedPayload {
  title?: string;
  text?: string;
  url?: string;
  image?: Blob | null;
  /** sw.js could tell this came from the OS share sheet, not a web page's form. Saved without asking only then. */
  trusted?: boolean;
}

/** What sw.js kept from the share (Cache Storage, "athena-share"), taken once. */
async function takeShared(): Promise<SharedPayload | null> {
  try {
    const cache = await caches.open("athena-share");
    const meta = await cache.match("/share-target/meta");
    if (!meta) return null;
    const raw = (await meta.json()) as SharedPayload;
    const data: SharedPayload = { title: raw.title, text: raw.text, url: raw.url, trusted: raw.trusted === true };
    const file = await cache.match("/share-target/file");
    const image = file ? await file.blob() : null;
    await Promise.all([cache.delete("/share-target/meta"), cache.delete("/share-target/file")]);
    return { ...data, image };
  } catch {
    return null;
  }
}

/** For screenshots and tests: what the share would hold (sample mode, ?demo). */
const demoShare = (): SharedPayload => ({ title: "Why sleep is when you learn", text: "", url: "https://longform.example/science/why-sleep-is-when-you-learn", trusted: true });

function renderShared(ctx: { go: Go }): { el: HTMLElement; destroy: () => void } {
  const status = h("div", { class: "sv-shared__status", role: "status" }, h("span", { class: "sv-shared__spinner", "aria-hidden": "true" }), h("p", { class: "sv-shared__title" }, "Saving…"));
  const card = h("div", { class: "sv-shared__card" });
  const el = h("div", { class: "view saved sv-shared" }, status, card);
  let alive = true;

  const done = (item: SavedItem, existing: boolean) => {
    // A recipe link lands in Recipes (lib/recipes.ts files it there; Saved keeps a pointer).
    const recipe = recipeHref(item);
    const open = h("button", { class: "btn btn--primary", type: "button" }, recipe ? "Open the recipe" : item.kind === "link" ? "Open in Saved" : "Open");
    open.addEventListener("click", () => (recipe ? (location.hash = recipe) : ctx.go("saved", { noteId: item.id })));
    const all = h("button", { class: "btn btn--ghost", type: "button" }, "All saved");
    all.addEventListener("click", () => ctx.go("saved"));
    status.replaceChildren(
      h("span", { class: "sv-shared__tick", "aria-hidden": "true" }, icons.check()),
      h("p", { class: "sv-shared__title" }, recipe ? (existing ? "Already in Recipes" : "Saved to Recipes") : existing ? "Already in Saved" : "Saved"),
      h("p", { class: "sv-shared__sub" }, existing ? "You kept this before. It's still on the day you first saved it." : item.kind === "link" && item.has_readable ? "With a readable copy, on today's page." : "On today's page.")
    );
    card.replaceChildren(savedCard(item, () => ctx.go("saved", { noteId: item.id })), h("div", { class: "sv-shared__actions" }, open, all));
    el.classList.add("is-done");
  };

  void (async () => {
    // ?demo stands in for a share only in sample mode: on a real account a link alone must never save.
    const demo = isSampleMode() && new URLSearchParams(location.hash.split("?")[1] ?? "").has("demo");
    const shared = (await takeShared()) ?? (demo ? demoShare() : null);
    if (!alive) return;
    if (!shared || (!shared.url && !shared.text && !shared.image)) {
      status.replaceChildren(h("span", { class: "sv-shared__tick sv-shared__tick--quiet", "aria-hidden": "true" }, icons.bookmark()), h("p", { class: "sv-shared__title" }, "Nothing to save"), h("p", { class: "sv-shared__sub" }, "Share a page, a picture or some text to Athena and it lands here."));
      const all = h("button", { class: "btn btn--ghost", type: "button" }, "Open Saved");
      all.addEventListener("click", () => ctx.go("saved"));
      card.replaceChildren(all);
      return;
    }
    const save = async () => {
      status.replaceChildren(h("span", { class: "sv-shared__spinner", "aria-hidden": "true" }), h("p", { class: "sv-shared__title" }, "Saving…"));
      card.replaceChildren();
      try {
        // Android puts the link in text more often than in url.
        const { item, existing } = await saveNew({ url: shared.url || undefined, text: shared.text || undefined, title: shared.title || undefined, image: shared.image, source: "share-target", client_id: crypto.randomUUID?.() });
        if (alive) done(item, existing);
      } catch (error) {
        status.replaceChildren(h("span", { class: "sv-shared__tick sv-shared__tick--bad", "aria-hidden": "true" }, icons.wifiOff()), h("p", { class: "sv-shared__title" }, "Couldn't save that"), h("p", { class: "sv-shared__sub" }, error instanceof Error ? error.message : "Try sharing it again."));
      }
    };
    // From the OS, or the owner ticked "Always save what I share from this device". Another site's form never gets
    // this far: sw.js refuses it before the setting is looked at.
    if (savesAtOnce(shared)) return void save();
    // Not known to be from the share sheet: show what arrived, and save only on a tap.
    const what = [shared.title, shared.url, shared.text].map((t) => (t ?? "").trim()).filter(Boolean);
    const lines = what.filter((t, i) => what.indexOf(t) === i).map((t) => (t.length > 280 ? `${t.slice(0, 280)}…` : t));
    if (shared.image) lines.push("With a picture.");
    status.replaceChildren(
      h("span", { class: "sv-shared__tick sv-shared__tick--quiet", "aria-hidden": "true" }, icons.bookmark()),
      h("p", { class: "sv-shared__title" }, "Save this to Athena?"),
      h("p", { class: "sv-shared__sub" }, "Athena couldn't tell this came from your share sheet, so it's waiting for you."),
      ...lines.map((t) => {
        const line = h("p", { class: "sv-shared__sub" }, t);
        line.style.overflowWrap = "anywhere";
        return line;
      })
    );
    // The same row as Settings → About you (components/share-setting.ts); nothing is stored until Save.
    const box = h("input", { type: "checkbox", role: "switch", class: "switch", id: "share-always-box", "aria-describedby": "share-always-box-sub" }) as HTMLInputElement;
    const always = h(
      "div",
      { class: "card ask-money-card" },
      h(
        "label",
        { class: "life-prefs__row ask-money", for: "share-always-box" },
        h("span", { class: "life-prefs__words" }, h("span", { class: "life-prefs__name" }, "Always save what I share from this device"), h("span", { class: "life-prefs__sub", id: "share-always-box-sub" }, "Future shares from here save without asking. You can turn this off in Settings.")),
        box
      )
    );
    always.style.textAlign = "left";
    const yes = h("button", { class: "btn btn--primary", type: "button" }, "Save");
    yes.addEventListener("click", () => {
      // Only once ticked and saved.
      if (box.checked) setAlwaysSaveShares(true);
      void save();
    });
    const no = h("button", { class: "btn btn--ghost", type: "button" }, "Don't save");
    no.addEventListener("click", () => ctx.go("saved"));
    card.replaceChildren(always, h("div", { class: "sv-shared__actions" }, yes, no));
  })();
  return {
    el,
    destroy: () => {
      alive = false;
    },
  };
}
