/**
 * Settings → Maps and artwork (#/settings/maps).
 *
 *  - Day maps: pick MapTiler or Stadia Maps, paste a free key, and see a
 *    sample map in your theme the moment it works. Test and Remove after.
 *  - Posters and covers: which services send their own artwork, how many
 *    images Athena keeps, and an optional TMDB key for film and TV posters
 *    the others don't cover, with a sample poster once it works.
 *  - A line on what leaves Athena.
 *  - Open maps in: Apple Maps, Google Maps or OpenStreetMap for "Open map",
 *    kept on this device (lib/map-app.ts), so it works offline too.
 *
 * Keys go to the server once and never come back (db/art-api.ts). Each is
 * tried before it's kept: a key the service turns down is never saved.
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { mapSketch } from "./day-map";
import { errorText } from "../lib/connectors-ui";
import { prefersReducedMotion } from "../lib/motion";
import {
  addTileKey,
  addTmdbKey,
  fetchMapsArt,
  fetchSample,
  PROVIDER_INFO,
  removeTileKey,
  removeTmdbKey,
  testTileKey,
  testTmdbKey,
  TMDB_KEYS_URL,
  type MapsArtStatus,
  type TileProvider,
} from "../db/art-api";
import { choiceChips } from "./fields";
import { getMapApp, MAP_APP_LABELS, setMapApp } from "../lib/map-app";
import { MAP_APPS, type MapApp } from "../../../lib/embeds";
import "../styles/days-art.css";
import { isDark, onSchemeChange } from "../lib/appearance";

/** Words on this page. */
export const COPY = {
  heading: "Maps and artwork",
  lede: "Athena saves its own copy of each map, poster and cover. Your days load fast, and no other site sees what you open.",
  mapTitle: "Day maps",
  mapSub: "A map of where you went each day, drawn from your places.",
  mapStepAccount: (label: string) => ["Make a free account at ", label, "."],
  mapStepCopy: (p: TileProvider) => (p === "maptiler" ? "Copy the key on the API keys page." : "Create an API key and copy it."),
  stepPaste: "Paste it here.",
  addKey: "Add key",
  checking: "Checking…",
  sampleTag: "Sample · central London",
  working: (label: string) => `Working · ${label}`,
  rejected: (label: string) => `${label} stopped accepting your key. Maps are paused until you add a new one.`,
  mapOn: "Maps are on. Each day with places now shows one.",
  test: "Test",
  testing: "Testing…",
  testedMap: "Your map key works",
  remove: "Remove",
  removeMapTitle: "Remove the map key?",
  removeMapBody: "Days stop showing maps until you add a key again. Maps already saved are kept.",
  mapRemoved: "Map key removed",
  artTitle: "Posters and covers",
  artSub: "These send their own artwork. Athena saves a copy the first time it sees one.",
  artCount: (n: number) => (n === 1 ? "1 image saved" : `${n.toLocaleString()} images saved`),
  tmdbTitle: "Film and TV posters",
  optional: "Optional",
  tmdbSub: "For films and shows the others miss, add a free TMDB key.",
  tmdbStepAccount: ["Make a free account at ", "TMDB", "."],
  tmdbStepCopy: "Under Settings, then API, copy the API key.",
  tmdbOn: "TMDB is on. Missing posters fill in over the next few days.",
  tmdbRejected: "TMDB stopped accepting your key. Add a new one to keep finding posters.",
  testedTmdb: "Your TMDB key works",
  removeTmdbTitle: "Remove the TMDB key?",
  removeTmdbBody: "Posters already saved stay. New films and shows only get artwork from your other services.",
  tmdbRemoved: "TMDB key removed",
  pasteFirst: "Paste the key first.",
  privacy: "Your map service is only asked for squares of map, never for your places. TMDB and Open Library get a title when Athena looks for a poster.",
  noEncryption: "Athena's server needs CONNECTOR_ENCRYPTION_KEY before it can keep a key. The README's Connectors section has the command.",
  loadFailed: "Couldn't load this. Try again in a moment.",
  offline: "This needs a connection. Your keys live on Athena's server.",
  openInTitle: "Open maps in",
  openInSub: "Open map on this device goes here. The map inside a note is always Athena's own copy, whichever you pick.",
};

const SOURCES = ["Letterboxd", "Spotify", "Last.fm", "Steam", "Plex", "Jellyfin", "Open Library"];

export function mapsArtSection(): { el: HTMLElement; destroy: () => void } {
  const body = h("div", { class: "settings__body ma" });
  const el = h(
    "section",
    { class: "settings__section", "aria-labelledby": "settings-maps" },
    h("h2", { class: "settings__heading", id: "settings-maps" }, icons.pin(), COPY.heading),
    h("p", { class: "settings__lede" }, COPY.lede),
    openInCard(),
    body
  );
  let status: MapsArtStatus | null = null;
  let provider: TileProvider = "maptiler";
  let destroyed = false;
  /** Samples handed back by the last add or test, so they show without another request. */
  const fresh: { light?: string; dark?: string; poster?: string } = {};
  const objectUrls: string[] = [];

  async function load() {
    body.replaceChildren(h("div", { class: "ma-card" }, h("span", { class: "skeleton", style: "height:18px;width:120px" }), h("span", { class: "skeleton", style: "aspect-ratio:600/320;width:100%;border-radius:var(--radius-md)" })));
    try {
      status = await fetchMapsArt();
      if (destroyed) return;
      if (status.tiles) provider = status.tiles.provider;
      paint();
    } catch (error) {
      if (destroyed) return;
      body.replaceChildren(h("div", { class: "card empty" }, h("span", { class: "tile" }, icons[navigator.onLine ? "pin" : "wifiOff"]()), h("p", { class: "empty__sub" }, navigator.onLine ? errorText(error, COPY.loadFailed) : COPY.offline)));
    }
  }

  function apply(next: MapsArtStatus, animate = true) {
    if (next.preview) Object.assign(fresh, next.preview);
    status = next;
    paint(animate);
  }

  function paint(animate = false) {
    if (!status) return;
    body.replaceChildren(
      ...(!status.setup.encryption
        ? [h("div", { class: "conn-callout" }, h("span", { class: "conn-callout__icon" }, icons.bell()), h("div", { class: "conn-callout__body" }, h("p", { class: "conn-callout__sub" }, COPY.noEncryption)))]
        : []),
      mapCard(status, animate),
      artCard(status, animate),
      h("p", { class: "ma-note" }, icons.shield(), COPY.privacy)
    );
  }

  // ----- A key form: input, button, error. -----
  function keyForm(opts: { id: string; label: string; submit: (key: string) => Promise<MapsArtStatus>; done: string }): HTMLElement {
    const input = h("input", {
      class: "ma-input",
      id: opts.id,
      type: "password",
      placeholder: "Paste your key",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      enterkeyhint: "done",
      "aria-label": opts.label,
    }) as HTMLInputElement;
    const error = h("p", { class: "ma-error", role: "alert", id: `${opts.id}-error` });
    input.setAttribute("aria-describedby", error.id);
    const button = h("button", { class: "btn btn--primary", type: "submit" }, COPY.addKey) as HTMLButtonElement;
    const form = h("form", { class: "ma-form" }, h("div", { class: "ma-field" }, input, button), error);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.textContent = "";
      input.removeAttribute("aria-invalid");
      if (!input.value.trim()) {
        error.textContent = COPY.pasteFirst;
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      button.disabled = true;
      input.readOnly = true;
      button.textContent = COPY.checking;
      try {
        const next = await opts.submit(input.value.trim());
        input.value = "";
        if (destroyed) return;
        apply(next);
        showToast(opts.done, { icon: "check", timeoutMs: 5000 });
      } catch (err) {
        error.textContent = errorText(err, COPY.loadFailed);
        input.setAttribute("aria-invalid", "true");
        button.disabled = false;
        input.readOnly = false;
        button.textContent = COPY.addKey;
        input.focus();
        input.select();
      }
    });
    return form;
  }

  function steps(...items: Array<Array<string | HTMLElement>>): HTMLElement {
    return h("ol", { class: "ma-steps" }, ...items.map((parts) => h("li", { class: "ma-step" }, h("span", {}, ...parts))));
  }

  const link = (href: string, text: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);

  function actions(test: () => Promise<MapsArtStatus>, tested: string, remove: () => Promise<void>): HTMLElement {
    const t = h("button", { class: "btn btn--soft btn--sm", type: "button" }, COPY.test) as HTMLButtonElement;
    const r = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, COPY.remove) as HTMLButtonElement;
    t.addEventListener("click", async () => {
      t.disabled = true;
      t.textContent = COPY.testing;
      try {
        const next = await test();
        if (destroyed) return;
        apply(next);
        showToast(tested, { icon: "check" });
      } catch (err) {
        showToast(errorText(err, COPY.loadFailed), { icon: "wifiOff", timeoutMs: 6000 });
        if (!destroyed) void load();
      }
    });
    r.addEventListener("click", () => void remove());
    return h("div", { class: "ma-actions" }, t, r);
  }

  /** The saved sample, or the one just made, in the current theme. */
  function sample(which: "map" | "poster", animate: boolean): HTMLElement {
    const box = which === "map" ? h("div", { class: `ma-sample${animate && !prefersReducedMotion() ? " ma-sample--new" : ""}` }, mapSketch()) : h("span", { class: "art-img", style: "--art-ratio:0.6667" });
    const key = which === "poster" ? "poster" : isDark() ? "dark" : "light";
    const show = (src: string) => {
      const img = h("img", { src, alt: which === "map" ? "A sample map in your theme: three stops across central London." : "Paddington 2's poster, found with your TMDB key.", decoding: "async" });
      if (which === "map") box.replaceChildren(img, h("span", { class: "ma-sample__tag" }, COPY.sampleTag));
      else {
        box.classList.add("art-img--in");
        box.replaceChildren(Object.assign(img, { className: "art-img__img" }));
      }
    };
    if (fresh[key]) show(fresh[key]!);
    else
      void fetchSample(key).then((blob) => {
        if (!blob || destroyed) return;
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        show(url);
      });
    return box;
  }

  // ----- Day maps -----
  function mapCard(s: MapsArtStatus, animate: boolean): HTMLElement {
    const head = h("div", { class: "ma-card__head" }, h("div", { class: "ma-card__body" }, h("p", { class: "ma-card__title" }, COPY.mapTitle), h("p", { class: "ma-card__sub" }, COPY.mapSub)));
    if (s.tiles && s.tiles.status === "working") {
      const label = PROVIDER_INFO[s.tiles.provider].label;
      return h(
        "div",
        { class: "ma-card" },
        head,
        sample("map", animate),
        h("div", { class: "ma-row" }, h("span", { class: "ma-status" }, COPY.working(label)), actions(testTileKey, COPY.testedMap, removeMap))
      );
    }
    const info = PROVIDER_INFO[provider];
    const switcher = h("div", { class: "ma-switch", role: "radiogroup", "aria-label": "Map service" });
    const options: TileProvider[] = ["maptiler", "stadia"];
    for (const p of options) {
      const b = h("button", { class: "ma-switch__item", type: "button", role: "radio", "aria-checked": String(p === provider), tabindex: p === provider ? "0" : "-1" }, PROVIDER_INFO[p].label);
      b.addEventListener("click", () => {
        if (p === provider) return;
        provider = p;
        paint();
        body.querySelector<HTMLElement>('.ma-switch__item[aria-checked="true"]')?.focus();
      });
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        provider = provider === "maptiler" ? "stadia" : "maptiler";
        paint();
        body.querySelector<HTMLElement>('.ma-switch__item[aria-checked="true"]')?.focus();
      });
      switcher.append(b);
    }
    const rejected = s.tiles?.status === "rejected";
    return h(
      "div",
      { class: "ma-card" },
      head,
      rejected
        ? h("div", { class: "conn-callout" }, h("span", { class: "conn-callout__icon" }, icons.bell()), h("div", { class: "conn-callout__body" }, h("p", { class: "conn-callout__sub" }, COPY.rejected(PROVIDER_INFO[s.tiles!.provider].label))))
        : h("div", { class: "ma-sample" }, mapSketch()),
      switcher,
      steps(COPY.mapStepAccount(info.label).map((part, i) => (i === 1 ? link(info.signUp, part) : part)), [COPY.mapStepCopy(provider)], [COPY.stepPaste]),
      keyForm({ id: "map-key", label: `${info.label} API key`, submit: (key) => addTileKey(provider, key), done: COPY.mapOn }),
      rejected ? h("div", { class: "ma-row" }, h("span", {}), actions(testTileKey, COPY.testedMap, removeMap)) : null
    );
  }

  async function removeMap() {
    if (!(await confirmDialog({ title: COPY.removeMapTitle, body: COPY.removeMapBody, confirmLabel: COPY.remove, danger: true }))) return;
    try {
      const next = await removeTileKey();
      delete fresh.light;
      delete fresh.dark;
      if (!destroyed) apply(next, false);
      showToast(COPY.mapRemoved, { icon: "check" });
    } catch (err) {
      showToast(errorText(err, COPY.loadFailed), { icon: "wifiOff" });
    }
  }

  // ----- Posters and covers -----
  function artCard(s: MapsArtStatus, animate: boolean): HTMLElement {
    const tmdbHead = h(
      "div",
      { class: "ma-card__head" },
      h("div", { class: "ma-card__body" }, h("p", { class: "ma-card__title" }, COPY.tmdbTitle, h("span", { class: "ma-optional" }, COPY.optional)), h("p", { class: "ma-card__sub" }, COPY.tmdbSub))
    );
    let tmdb: HTMLElement[];
    if (s.tmdb?.status === "working") {
      tmdb = [h("div", { class: "ma-poster" }, sample("poster", animate), h("div", { class: "ma-card__body ma-row" }, h("span", { class: "ma-status" }, COPY.working("TMDB")), actions(testTmdbKey, COPY.testedTmdb, removeTmdb)))];
    } else {
      tmdb = [
        s.tmdb?.status === "rejected"
          ? h("div", { class: "conn-callout" }, h("span", { class: "conn-callout__icon" }, icons.bell()), h("div", { class: "conn-callout__body" }, h("p", { class: "conn-callout__sub" }, COPY.tmdbRejected)))
          : null,
        steps(COPY.tmdbStepAccount.map((part, i) => (i === 1 ? link(TMDB_KEYS_URL, part) : part)), [COPY.tmdbStepCopy], [COPY.stepPaste]),
        keyForm({ id: "tmdb-key", label: "TMDB API key", submit: addTmdbKey, done: COPY.tmdbOn }),
      ].filter((x): x is HTMLElement => !!x);
    }
    return h(
      "div",
      { class: "ma-card" },
      h(
        "div",
        { class: "ma-card__head" },
        h(
          "div",
          { class: "ma-card__body" },
          h("p", { class: "ma-card__title" }, COPY.artTitle),
          h("p", { class: "ma-card__sub" }, COPY.artSub)
        )
      ),
      h("div", { class: "ma-sources" }, ...SOURCES.map((x) => h("span", {}, x))),
      s.art_count ? h("p", { class: "ma-count" }, COPY.artCount(s.art_count)) : null,
      h("hr", { class: "ma-rule" }),
      tmdbHead,
      ...tmdb
    );
  }

  async function removeTmdb() {
    if (!(await confirmDialog({ title: COPY.removeTmdbTitle, body: COPY.removeTmdbBody, confirmLabel: COPY.remove, danger: true }))) return;
    try {
      const next = await removeTmdbKey();
      delete fresh.poster;
      if (!destroyed) apply(next, false);
      showToast(COPY.tmdbRemoved, { icon: "check" });
    } catch (err) {
      showToast(errorText(err, COPY.loadFailed), { icon: "wifiOff" });
    }
  }

  // ----- Open maps in: kept on this device, so it's drawn once and works offline. -----
  function openInCard(): HTMLElement {
    const choice = choiceChips<MapApp>(
      COPY.openInTitle,
      MAP_APPS.map((a) => ({ value: a, label: MAP_APP_LABELS[a] })),
      getMapApp(),
      setMapApp
    );
    return h(
      "div",
      { class: "ma-card ma-open-in" },
      h("div", { class: "ma-card__head" }, h("div", { class: "ma-card__body" }, h("p", { class: "ma-card__title" }, COPY.openInTitle), h("p", { class: "ma-card__sub" }, COPY.openInSub))),
      choice.el
    );
  }

  const stopTheme = onSchemeChange(() => paint());
  void load();
  return {
    el,
    destroy: () => {
      destroyed = true;
      stopTheme();
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
    },
  };
}
