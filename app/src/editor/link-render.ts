/**
 * Drawing one link in one of its four modes (Mention, Link, Card, Embed) and
 * one of its states (loading, loaded, failed, offline). Lifted from the
 * approved prototype (docs/notes/rich-links.md); the editor's node views
 * (link-nodes.ts) and the read-only note view call these.
 *
 * A `Thing` is what's drawn: built from the link itself plus, when they've
 * arrived, a web page's preview or a thing's live card (link-data.ts).
 *
 * Embeds are tap to load: until the play button is pressed the embed is a
 * still we hold and our own button. Only then is the provider's iframe made,
 * with stage 1's rules (lib/embeds.ts): `allow` from the embed, a strict
 * referrer, lazy loading and a sandbox. Apple Maps has no player: "Open map"
 * hands the spot to the device's maps app.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { shortDate } from "../lib/format";
import { linkDisplayLabel } from "../lib/markdown-text";
import { MENTION_KIND_LABEL } from "../../../lib/mentions";
import { PROVIDER_NAMES, embedFor, type Embed, type EmbedProvider } from "../../../lib/embeds";
import { openMapUrl as mapAppFor } from "../lib/map-app";
import type { LinkKind } from "../../../lib/links";
import { MODE_LABEL, bareUrl, hostOf, type LinkMode, type LinkTarget } from "./link-model";
import type { LinkPreview, LiveCard } from "./link-data";
import { clockTime } from "../lib/clock";
import { darkSource } from "../lib/appearance";

export type LinkState = "loading" | "loaded" | "failed" | "offline";
export type ThingKind = LinkKind | "web";

export const KIND_ICON: Record<ThingKind, IconName> = {
  person: "person",
  place: "pin",
  organisation: "building",
  event: "calendar",
  note: "note",
  project: "project",
  record: "wine",
  saved: "bookmark",
  todo: "check",
  watch: "tv",
  web: "globe",
};

export const kindLabel = (k: ThingKind): string => (k === "web" ? "Link" : MENTION_KIND_LABEL[k]);

/** What tapping an embed's still does, and the colour of the letter standing in for the provider's icon. */
const PROVIDER_UI: Record<EmbedProvider, { action: "Play" | "Listen" | "Open map" | "Open file" | "Open site"; mark: string }> = {
  youtube: { action: "Play", mark: "#e5322d" },
  vimeo: { action: "Play", mark: "#1ab7ea" },
  loom: { action: "Play", mark: "#625df5" },
  spotify: { action: "Listen", mark: "#1db954" },
  "apple-music": { action: "Listen", mark: "#fa2d48" },
  "google-maps": { action: "Open map", mark: "#34a853" },
  "apple-maps": { action: "Open map", mark: "#3a8bf5" },
  figma: { action: "Open file", mark: "#a259ff" },
  framer: { action: "Open site", mark: "#0055ff" },
};

/** The iframe's sandbox (stage 1): players need scripts and their own origin; nothing else. */
export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-presentation";

export interface Thing {
  target: LinkTarget;
  kind: ThingKind;
  title: string;
  /** Site name for web links; a short kind line for Athena things. */
  site: string;
  url?: string;
  summary?: string | null;
  image?: string | null;
  imageShape?: "wide" | "square" | "tall" | null;
  tint?: string | null;
  favicon?: string | null;
  embed?: Embed | null;
  live?: LiveCard | null;
}

/** A Thing from what's known so far: the link, then its preview or live card. */
export function thingFor(target: LinkTarget, label: string, data: { preview?: LinkPreview | null; live?: LiveCard | null } = {}): Thing {
  if (target.target === "web") {
    const p = data.preview;
    const embed = p?.embed ?? embedFor(target.url);
    const title = p?.title || (label && label !== target.url ? label : bareUrl(target.url));
    return {
      target,
      kind: "web",
      title,
      site: p?.site_name || (embed ? PROVIDER_NAMES[embed.provider] : hostOf(target.url)),
      url: target.url,
      summary: p?.summary ?? null,
      image: p?.image_url ?? null,
      imageShape: p?.shape ?? (p?.image_url ? "wide" : null),
      tint: p?.image_tone ?? null,
      favicon: p?.favicon_url ?? null,
      embed,
    };
  }
  const live = data.live ?? null;
  // The face or icon says what it is, so the agents' "@" isn't shown (as in the approved design).
  const name = live?.title || linkDisplayLabel(target.kind, label).replace(/^@/, "");
  const image = live?.kind === "person" ? live.photo : live?.kind === "watch" ? live.cover : live?.kind === "saved" ? live.image : null;
  return {
    target,
    kind: target.kind,
    title: name,
    site: liveSite(target.kind, live),
    image,
    imageShape: live?.kind === "watch" ? "tall" : image ? "square" : null,
    live,
  };
}

function liveSite(kind: LinkKind, live: LiveCard | null): string {
  if (live?.kind === "person" && live.relation) return live.relation;
  if (live && "subtitle" in live && live.subtitle) return `${MENTION_KIND_LABEL[kind]} · ${live.subtitle}`;
  return MENTION_KIND_LABEL[kind];
}

// ---------- Words for dates ----------

const DAY = 86_400_000;
const daysFrom = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / DAY);

function inWords(iso: string): string {
  const d = daysFrom(iso);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  if (d > 1 && d < 14) return `in ${d} days`;
  if (d >= 14 && d < 62) return `in ${Math.round(d / 7)} weeks`;
  if (d < -1 && d > -14) return `${-d} days ago`;
  return shortDate(iso);
}

const dueLine = (iso: string | null) => (iso ? `Due ${shortDate(iso)}` : "No date");
/** An event's day, with its time when it has one ("YYYY-MM-DD" is a day with no time, read in this device's zone). */
const whenLine = (iso: string) =>
  iso.length === 10
    ? new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(Date.parse(`${iso}T00:00`))
    : `${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(Date.parse(iso))}, ${clockTime(iso)}`;

/** The one-line detail a peek or the @ menu shows for a live card. */
export function liveDetail(live: LiveCard | null | undefined): string {
  if (!live) return "";
  switch (live.kind) {
    case "person":
      return live.lastCatchUp ? `Last catch-up ${shortDate(live.lastCatchUp)}` : (live.relation ?? "");
    case "place":
      return live.area ?? "";
    case "event":
      return whenLine(live.startsAt);
    case "todo":
      return live.done ? "Done" : dueLine(live.due);
    case "watch":
      return live.status;
    case "saved":
      return [live.price, live.shop].filter(Boolean).join(" · ");
    case "note":
      return `Edited ${inWords(live.editedAt)}`;
    default:
      return live.subtitle ?? "";
  }
}

// ---------- Small parts ----------

export const icon = (name: IconName, cls = "rl-ico") => {
  const s = icons[name]();
  s.classList.add(...cls.split(" "));
  return s;
};

const pic = (src: string, cls: string, alt = "") => h("img", { class: cls, src, alt, decoding: "async", draggable: "false", referrerpolicy: "no-referrer" });

/** A site's favicon, or a letter standing in for it (the provider's colour for players). */
export function favicon(t: Thing, cls = "rl-fav"): HTMLElement {
  const ui = t.embed ? PROVIDER_UI[t.embed.provider] : null;
  if (t.favicon && !ui) return h("span", { class: `${cls} rl-fav--img`, "aria-hidden": "true" }, pic(t.favicon, "rl-fav__img"));
  const letter = (t.embed ? PROVIDER_NAMES[t.embed.provider] : t.site)[0]?.toUpperCase() ?? "·";
  return h("span", { class: cls, style: `--mark:${ui?.mark ?? "var(--rl-mark-default)"}`, "aria-hidden": "true" }, letter);
}

/** What leads a mention: a face, the site's mark or the kind's icon. */
function lead(t: Thing, state: LinkState): HTMLElement {
  if (state === "loading") return h("span", { class: "rl-mention__lead rl-sk rl-sk--dot", "aria-hidden": "true" });
  if (t.kind === "person" && t.image && state !== "offline") return h("span", { class: "rl-mention__lead rl-mention__lead--face" }, pic(t.image, "rl-mention__img"));
  if (t.kind === "web") return h("span", { class: "rl-mention__lead" }, favicon(t));
  return h("span", { class: `rl-mention__lead rl-mention__lead--icon rl-k--${t.kind}` }, icon(KIND_ICON[t.kind]));
}

/** Spoken name of a link: its title, then what it is, then how it's shown. */
export function ariaName(t: Thing, mode: LinkMode): string {
  const what = t.embed ? PROVIDER_NAMES[t.embed.provider] : kindLabel(t.kind);
  return `${t.title}, ${what}, shown as ${MODE_LABEL[mode].toLowerCase()}`;
}

function root(tag: "span" | "div", t: Thing, mode: LinkMode, state: LinkState, cls: string, ...kids: (Node | string | null | false)[]) {
  const attrs: Record<string, string> = {
    class: `rl-node ${cls}`,
    "data-rl-mode": mode,
    "data-rl-state": state,
    "data-rl-kind": t.kind,
    tabindex: "0",
    "aria-label": ariaName(t, mode),
    role: mode === "mention" || mode === "link" ? "link" : "group",
  };
  if (t.tint) attrs.style = `--tint:${t.tint}`;
  if (state === "loading") attrs["aria-busy"] = "true";
  return h(tag as "div", attrs, ...kids);
}

// ---------- Mention ----------

function mention(t: Thing, state: LinkState) {
  if (state === "loading")
    return root("span", t, "mention", state, "rl-mention rl-mention--loading", lead(t, state), h("span", { class: "rl-sk rl-sk--text", style: `--w:${Math.min(12, t.title.length) * 0.55}em` }));
  const gone = state === "failed";
  return root(
    "span",
    t,
    "mention",
    state,
    `rl-mention rl-mention--${t.kind}${gone ? " rl-mention--gone" : ""}`,
    lead(t, state),
    h("span", { class: "rl-mention__label" }, gone && t.url ? bareUrl(t.url) : t.title)
  );
}

// ---------- Link ----------

function link(t: Thing, state: LinkState, label: string) {
  if (state === "loading") return root("span", t, "link", state, "rl-link rl-link--loading", label);
  const text = state === "failed" && t.url ? bareUrl(t.url) : label;
  return root("span", t, "link", state, "rl-link", text);
}

// ---------- Card ----------

function siteRow(t: Thing) {
  return h(
    "span",
    { class: "rl-card__site" },
    t.kind === "web" ? favicon(t) : h("span", { class: `rl-fav rl-fav--icon rl-k--${t.kind}` }, icon(KIND_ICON[t.kind])),
    h("span", {}, t.site)
  );
}

const media = (src: string, shape: string, alt = "") => h("span", { class: `rl-media rl-media--${shape}` }, pic(src, "rl-media__img", alt));

function cardSkeleton(t: Thing, shape: string) {
  return root(
    "div",
    t,
    "card",
    "loading",
    `rl-card rl-card--${shape} rl-card--loading`,
    shape !== "none" ? h("span", { class: `rl-media rl-media--${shape} rl-sk` }) : null,
    h(
      "span",
      { class: "rl-card__body" },
      h("span", { class: "rl-sk rl-sk--line", style: "--w:72%" }),
      h("span", { class: "rl-sk rl-sk--line rl-sk--thin", style: "--w:96%" }),
      h("span", { class: "rl-sk rl-sk--line rl-sk--thin", style: "--w:58%" }),
      h("span", { class: "rl-card__site" }, h("span", { class: "rl-sk rl-sk--fav" }), h("span", { class: "rl-sk rl-sk--line rl-sk--thin", style: "--w:7em" }))
    )
  );
}

function cardProblem(t: Thing, state: "failed" | "offline") {
  const offline = state === "offline";
  return root(
    "div",
    t,
    "card",
    state,
    "rl-card rl-card--none rl-card--problem",
    h(
      "span",
      { class: "rl-card__body" },
      h("span", { class: "rl-card__title" }, t.title),
      h("span", { class: "rl-card__problem" }, icon(offline ? "wifiOff" : "link"), offline ? "Preview loads when you're back online" : "This page didn't send a preview"),
      h("span", { class: "rl-card__foot" }, siteRow(t), offline ? null : h("button", { class: "rl-chip", type: "button", "data-rl-retry": "", contenteditable: "false" }, icon("refresh"), "Try again"))
    )
  );
}

function webCard(t: Thing, state: LinkState) {
  // The skeleton takes the final shape when the embed tells us (a player is always wide).
  if (state === "loading") return cardSkeleton(t, t.embed ? "wide" : "wide");
  if (state === "failed" || state === "offline") return cardProblem(t, state);
  const shape = t.image ? (t.imageShape ?? "wide") : "none";
  return root(
    "div",
    t,
    "card",
    state,
    `rl-card rl-card--${shape}`,
    t.image ? media(t.image, shape) : null,
    h("span", { class: "rl-card__body" }, h("span", { class: "rl-card__title" }, t.title), t.summary ? h("span", { class: "rl-card__summary" }, t.summary) : null, siteRow(t))
  );
}

// ---------- Live cards for Athena things ----------

const metaRow = (name: IconName, text: string) => h("span", { class: "rl-meta" }, icon(name), h("span", {}, text));

function liveBody(t: Thing, onTodo?: (done: boolean) => void): { cls: string; kids: (Node | null)[] } {
  const live = t.live;
  const plain = () => ({
    cls: "rl-live--plain",
    kids: [h("span", { class: `rl-tile rl-k--${t.kind}` }, icon(KIND_ICON[t.kind])), h("span", { class: "rl-card__body" }, h("span", { class: "rl-card__title" }, t.title), h("span", { class: "rl-card__kind" }, t.site))],
  });
  if (!live) return plain();
  switch (live.kind) {
    case "person":
      return {
        cls: "rl-live--person",
        kids: [
          h(
            "span",
            { class: "rl-live__head" },
            live.photo ? h("span", { class: "rl-face" }, pic(live.photo, "rl-face__img")) : h("span", { class: "rl-tile rl-k--person" }, icon("person")),
            h("span", { class: "rl-live__names" }, h("span", { class: "rl-card__title" }, t.title), h("span", { class: "rl-card__kind" }, t.site))
          ),
          h(
            "span",
            { class: "rl-live__meta" },
            live.lastCatchUp ? metaRow("chat", `Last catch-up: ${shortDate(live.lastCatchUp)}`) : null,
            live.birthday ? metaRow("gift", `Birthday ${shortDate(live.birthday)}, ${inWords(live.birthday)}`) : null
          ),
        ],
      };
    case "place":
      return {
        cls: "rl-live--place",
        kids: [
          live.map
            ? h(
                "span",
                { class: "rl-media rl-media--square rl-map" },
                h("picture", {}, live.mapDark ? darkSource(live.mapDark) : null, pic(live.map, "rl-media__img", `Map of ${t.title}`))
              )
            : h("span", { class: "rl-tile rl-k--place" }, icon("pin")),
          h("span", { class: "rl-card__body" }, h("span", { class: "rl-card__title" }, t.title), live.area ? h("span", { class: "rl-card__kind" }, live.area) : null, live.lastVisit ? metaRow("clock", `Last there ${shortDate(live.lastVisit)}`) : null),
        ],
      };
    case "todo": {
      const box = h("input", { type: "checkbox", class: "rl-check", "aria-label": `Done: ${t.title}`, contenteditable: "false" }) as HTMLInputElement;
      box.checked = live.done;
      const due = h("span", { class: "rl-card__kind" }, live.done ? "Done" : dueLine(live.due));
      box.addEventListener("change", () => {
        box.closest(".rl-live")?.classList.toggle("is-done", box.checked);
        due.textContent = box.checked ? "Done just now" : dueLine(live.due);
        onTodo?.(box.checked);
      });
      return { cls: `rl-live--todo${live.done ? " is-done" : ""}`, kids: [h("label", { class: "rl-todo" }, box, h("span", { class: "rl-card__body" }, h("span", { class: "rl-card__title" }, t.title), due))] };
    }
    case "watch":
      return {
        cls: "rl-live--watch",
        kids: [
          live.cover ? h("span", { class: "rl-media rl-media--tall" }, pic(live.cover, "rl-media__img")) : h("span", { class: "rl-tile rl-k--watch" }, icon("tv")),
          h(
            "span",
            { class: "rl-card__body" },
            h("span", { class: "rl-card__title" }, t.title),
            h("span", { class: "rl-card__kind" }, live.type),
            h(
              "span",
              { class: "rl-status" },
              h("span", { class: "rl-status__text" }, live.progressText ? `${live.status} · ${live.progressText}` : live.status),
              live.progress != null ? h("span", { class: "rl-bar", style: `--p:${live.progress}`, role: "img", "aria-label": `${Math.round(live.progress * 100)}% through` }) : null
            )
          ),
        ],
      };
    case "saved":
      return {
        cls: "rl-live--saved",
        kids: [
          live.image ? h("span", { class: "rl-media rl-media--square" }, pic(live.image, "rl-media__img")) : h("span", { class: "rl-tile rl-k--saved" }, icon("bookmark")),
          h("span", { class: "rl-card__body" }, h("span", { class: "rl-card__title" }, t.title), live.shop ? h("span", { class: "rl-card__kind" }, live.shop) : null, live.price ? h("span", { class: "rl-price" }, live.price) : null),
        ],
      };
    case "event": {
      const at = Date.parse(live.startsAt);
      return {
        cls: "rl-live--event",
        kids: [
          h(
            "span",
            { class: "rl-date", "aria-hidden": "true" },
            h("span", { class: "rl-date__m" }, new Intl.DateTimeFormat("en-GB", { month: "short" }).format(at)),
            h("span", { class: "rl-date__d" }, String(new Date(at).getDate()))
          ),
          h("span", { class: "rl-card__body" }, h("span", { class: "rl-card__title" }, t.title), h("span", { class: "rl-card__kind" }, whenLine(live.startsAt)), live.where ? metaRow("pin", live.where) : null),
        ],
      };
    }
    case "note":
      return {
        cls: "rl-live--note",
        kids: [
          h(
            "span",
            { class: "rl-card__body" },
            h("span", { class: "rl-live__notehead" }, icon("note"), h("span", { class: "rl-card__title" }, t.title)),
            h("span", { class: "rl-note-lines" }, ...live.lines.slice(0, 3).map((l) => h("span", {}, l))),
            h("span", { class: "rl-card__kind" }, `Edited ${inWords(live.editedAt)}`)
          ),
        ],
      };
    default:
      return plain();
  }
}

function liveCard(t: Thing, state: LinkState, onTodo?: (done: boolean) => void) {
  if (state === "loading") {
    return root(
      "div",
      t,
      "card",
      state,
      `rl-card rl-live rl-live--loading rl-live--${t.kind}`,
      h("span", { class: t.kind === "person" ? "rl-sk rl-sk--face" : "rl-sk rl-sk--tile" }),
      h("span", { class: "rl-card__body" }, h("span", { class: "rl-sk rl-sk--line", style: "--w:60%" }), h("span", { class: "rl-sk rl-sk--line rl-sk--thin", style: "--w:40%" }))
    );
  }
  if (state === "failed") {
    return root(
      "div",
      t,
      "card",
      state,
      "rl-card rl-live rl-live--plain rl-card--problem",
      h("span", { class: `rl-tile rl-k--${t.kind}` }, icon(KIND_ICON[t.kind])),
      h("span", { class: "rl-card__body" }, h("span", { class: "rl-card__title rl-strike" }, t.title), h("span", { class: "rl-card__problem" }, icon("archive"), "Archived. Only the name is kept here"))
    );
  }
  const { cls, kids } = liveBody(t, onTodo);
  const el = root("div", t, "card", state, `rl-card rl-live ${cls}`, ...kids);
  if (state === "offline") el.append(h("span", { class: "rl-stale", title: "Saved on this device. It updates when you're back online" }, icon("wifiOff"), "Not updated"));
  return el;
}

// ---------- Embed ----------

/** The iframe for an embed, made only when its still is tapped. */
export function embedFrame(e: Embed, title: string): HTMLIFrameElement | null {
  if (!e.embedUrl) return null;
  const f = h("iframe", {
    class: "rl-embed__frame",
    src: e.embedUrl,
    title: `${title}, from ${PROVIDER_NAMES[e.provider]}`,
    allow: e.allow,
    referrerpolicy: "strict-origin",
    loading: "lazy",
    sandbox: EMBED_SANDBOX,
    allowfullscreen: "",
  }) as HTMLIFrameElement;
  if (e.aspect) f.style.aspectRatio = String(e.aspect);
  else if (e.height) f.style.height = `${e.height}px`;
  return f;
}

/** Where "Open map" goes for a map with no player: the maps app picked for this device (Settings → Maps and artwork). */
export const openMapUrl = (e: Embed, title: string): string | null => mapAppFor({ at: e.at ?? null, query: e.title ?? title }) ?? e.openUrl;

function embed(t: Thing, state: LinkState, onPlay?: (el: HTMLElement, byKeyboard: boolean) => void) {
  const e = t.embed;
  if (!e) return webCard(t, state);
  const name = PROVIDER_NAMES[e.provider];
  const ui = PROVIDER_UI[e.provider];
  const shape = e.kind;
  if (state === "loading") {
    return root(
      "div",
      t,
      "embed",
      state,
      `rl-embed rl-embed--${shape} rl-embed--loading`,
      h("span", { class: "rl-embed__stage rl-sk" }, h("span", { class: "rl-play rl-play--ghost", "aria-hidden": "true" })),
      h("span", { class: "rl-embed__bar" }, h("span", { class: "rl-sk rl-sk--fav" }), h("span", { class: "rl-sk rl-sk--line rl-sk--thin", style: "--w:50%" }))
    );
  }
  if (state === "failed") {
    return root(
      "div",
      t,
      "embed",
      state,
      `rl-embed rl-embed--${shape} rl-embed--failed`,
      h(
        "span",
        { class: "rl-embed__stage rl-embed__stage--empty" },
        favicon(t, "rl-fav rl-fav--big"),
        h("span", { class: "rl-embed__msg" }, `${name} doesn't allow this one to play here`),
        h("a", { class: "rl-chip", href: e.openUrl, target: "_blank", rel: "noopener noreferrer", "data-rl-open": "", contenteditable: "false" }, icon("external"), `Open in ${name}`)
      ),
      h("span", { class: "rl-embed__bar" }, favicon(t), h("span", { class: "rl-embed__title" }, t.title))
    );
  }
  const offline = state === "offline";
  const opensApp = !e.embedUrl;
  const playIcon = shape === "video" || shape === "audio" ? "play" : "external";
  const play = opensApp
    ? h(
        "a",
        { class: "rl-play", href: openMapUrl(e, t.title) ?? e.openUrl, target: "_blank", rel: "noopener noreferrer", "aria-label": `${ui.action}: ${t.title}, opens your maps app`, contenteditable: "false" },
        icon(playIcon, "rl-ico rl-play__ico"),
        h("span", { class: "rl-play__label" }, ui.action)
      )
    : h(
        "button",
        { class: "rl-play", type: "button", "data-rl-play": "", "aria-label": `${ui.action}: ${t.title}, loads from ${name}`, disabled: offline, contenteditable: "false" },
        icon(playIcon, "rl-ico rl-play__ico"),
        h("span", { class: "rl-play__label" }, ui.action)
      );
  const note = offline
    ? h("span", { class: "rl-embed__note" }, icon("wifiOff"), "Plays when you're back online")
    : opensApp
      ? null
      : h("span", { class: "rl-embed__note" }, `Tap to load from ${name}`);
  let el: HTMLElement;
  if (shape === "audio") {
    const noteInline = note ? (note.classList.add("rl-embed__note--inline"), note) : null;
    el = root(
      "div",
      t,
      "embed",
      state,
      "rl-embed rl-embed--audio",
      h("span", { class: "rl-embed__art" }, t.image ? pic(t.image, "rl-embed__still") : null),
      h(
        "span",
        { class: "rl-embed__info" },
        h("span", { class: "rl-card__title" }, t.title),
        h("span", { class: "rl-card__site" }, favicon(t), h("span", {}, t.site)),
        h("span", { class: "rl-embed__audiofoot" }, play, noteInline)
      )
    );
  } else {
    const stage = h("span", { class: "rl-embed__stage" }, t.image ? pic(t.image, "rl-embed__still") : null, h("span", { class: "rl-embed__scrim", "aria-hidden": "true" }), play, note);
    if (e.aspect) stage.style.aspectRatio = String(e.aspect);
    el = root("div", t, "embed", state, `rl-embed rl-embed--${shape}`, stage, h("span", { class: "rl-embed__bar" }, favicon(t), h("span", { class: "rl-embed__title" }, t.title), h("span", { class: "rl-embed__site" }, name)));
  }
  if (!opensApp && onPlay) {
    play.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      // detail 0: Enter or Space on the button, not a tap.
      onPlay(el, (ev as MouseEvent).detail === 0);
    });
  }
  return el;
}

/**
 * Swap an embed's still for the provider's player. Only ever called from a
 * tap or a key on the play button.
 */
export function loadPlayer(el: HTMLElement, t: Thing, focus = false): HTMLIFrameElement | null {
  const e = t.embed;
  if (!e) return null;
  const frame = embedFrame(e, t.title);
  if (!frame) return null;
  const holder = h("span", { class: `rl-embed__player rl-embed__player--${e.kind}` }, frame);
  if (e.kind === "audio") el.replaceChildren(holder);
  else el.querySelector(".rl-embed__stage")?.replaceWith(holder);
  el.classList.add("is-playing");
  // From the keyboard, focus follows into the player; a tap leaves it be.
  if (focus) frame.focus({ preventScroll: true });
  return frame;
}

export interface RenderHooks {
  /** A to-do card's tick. */
  onTodo?: (done: boolean) => void;
  /** An embed's play button; `byKeyboard` when it was Enter or Space. */
  onPlay?: (el: HTMLElement, byKeyboard: boolean) => void;
}

/** One link, drawn. `label` is the words a Link shows. */
export function renderLink(t: Thing, mode: LinkMode, state: LinkState = "loaded", label = t.title, hooks: RenderHooks = {}): HTMLElement {
  if (mode === "mention") return mention(t, state);
  if (mode === "link") return link(t, state, label);
  if (mode === "embed") return embed(t, state, hooks.onPlay);
  return t.kind === "web" ? webCard(t, state) : liveCard(t, state, hooks.onTodo);
}
