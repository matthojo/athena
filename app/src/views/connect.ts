/**
 * First-run screen, shown by main.ts when this device has no key yet. Paste
 * the master token (used once to make this device's own key, then dropped) or
 * a full key (kept as it is, in localStorage, sent as a bearer header to
 * /api/*), or look around with sample data: two paths, given the same weight.
 */

import { h } from "../lib/dom";
import { brandMark } from "../components/brand-mark";
import { checkHealth, isApiKey, signIn } from "../db/api";
import { SIGN_IN_HELP_URL } from "../lib/version";
import { CONNECTOR_CATEGORIES } from "../../../lib/connector-presets";
import { request } from "../db/api";
import { lastImportTitle, type ImportLine, type ImportMemo } from "../lib/youtube-import-memo";
import { backfillMark } from "../components/backfill-marks";
import type { FileImportFormat } from "../components/backfill-marks";

export function renderConnect(onDone: (mode: "connected" | "sample") => void): HTMLElement {
  const input = h("input", {
    class: "field",
    type: "password",
    id: "athena-token",
    name: "athena-token",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "Paste your access token or a key",
    "aria-describedby": "athena-token-help",
  }) as HTMLInputElement;
  // Where the token comes from (README "3. Sign in"), in the words the setup steps use.
  const help = h(
    "p",
    { class: "connect__help", id: "athena-token-help" },
    "It's the ",
    h("code", {}, "MCP_BEARER_TOKEN"),
    " you chose when you set up your Athena site. A full-access key made in Settings → API keys, on a device that's already connected, works too. ",
    h("a", { class: "text-link", href: SIGN_IN_HELP_URL, target: "_blank", rel: "noopener noreferrer" }, "Where do I find this?")
  );
  const error = h("p", { class: "connect__error", role: "alert" });
  const connect = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Connect") as HTMLButtonElement;
  const sample = h("button", { class: "btn btn--soft btn--block", type: "button", "aria-describedby": "athena-sample-help" }, "Look around with sample data");
  sample.addEventListener("click", () => onDone("sample"));

  const form = h(
    "form",
    { class: "connect__form" },
    h("label", { class: "field-label", for: "athena-token" }, "Access token"),
    input,
    help,
    error,
    connect
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = input.value.trim();
    if (!token) {
      error.textContent = "Paste a token to continue.";
      input.focus();
      return;
    }
    connect.disabled = true;
    connect.textContent = "Connecting…";
    error.textContent = "";
    const result = await signIn(token);
    if (!result.ok) {
      // Nothing is kept: the master token is only ever used to make this device's key.
      error.textContent =
        result.reason === "refused"
          ? "That token wasn't accepted. Check it and try again."
          : result.reason === "unreachable"
            ? "Couldn't reach Athena. Check you're online and try again."
            : result.message || "That didn't work. Try again.";
      connect.disabled = false;
      connect.textContent = "Connect";
      input.focus();
      return;
    }
    input.value = "";
    if (!isApiKey(token) || (await checkHealth())) {
      onDone("connected");
      return;
    }
    // A pasted key is kept: the backend may simply not be reachable right
    // now, and the app degrades to cached/sample data on its own.
    error.textContent = "Couldn't reach Athena right now. Your key is saved; continuing with what's on this device.";
    setTimeout(() => onDone("connected"), 1200);
  });

  return h(
    "div",
    { class: "connect" },
    h(
      "div",
      { class: "connect__card" },
      brandMark(),
      h(
        "div",
        {},
        h("h1", { class: "page-title" }, "Connect Athena"),
        h(
          "p",
          { class: "connect__body" },
          "Paste your access token to see your own notes, people and days on this device."
        )
      ),
      form,
      h("p", { class: "connect__foot" }, "This device gets its own key, which you can remove in Settings. The token you paste isn't kept."),
      h(
        "div",
        { class: "connect__sample" },
        h("p", { class: "connect__or" }, "Or, without a token"),
        sample,
        h("p", { class: "connect__foot", id: "athena-sample-help" }, "Everything in the sample is made up. Anything you add stays on this device and isn't sent anywhere.")
      )
    )
  );
}

// ---------- Import cards for Sources (Batch C, connectors-research-2) ----------
/*
 * Where each file import lives in Sources: its card in the Add an account
 * directory (components/connector-forms.ts) and its row in "From files" once
 * a file is in (components/connector-settings.ts). The sheet itself
 * (components/backfill-import.ts) loads when a card is tapped, so Sources
 * doesn't load the parsers.
 */

export interface FileImportCard {
  format: FileImportFormat;
  name: string;
  tagline: string;
  /** Searchable words beyond the name and tagline. */
  aliases: string;
  /** For "1,204 habits" on its row: [one, many]. */
  unit: [string, string];
}

// The iPhone-friendly imports first; Loop (Android only) last.
export const FILE_IMPORTS: FileImportCard[] = [
  { format: "daylio", name: "Daylio", tagline: "Moods, activities and notes, from a file", aliases: "mood diary journal activities habits", unit: ["entry", "entries"] },
  { format: "bearable", name: "Bearable", tagline: "Mood, symptoms and factors, from a file", aliases: "mood energy symptoms health habits factors", unit: ["day", "days"] },
  { format: "overcast", name: "Overcast", tagline: "Podcasts you've played, from a file", aliases: "podcast podcasts listening episodes opml", unit: ["episode", "episodes"] },
  { format: "tfl", name: "TfL journeys", tagline: "Oyster and contactless history, from a file", aliases: "transport for london oyster contactless tube underground overground bus train journeys commute", unit: ["journey", "journeys"] },
  { format: "loop", name: "Loop Habit Tracker", tagline: "Habits, from Loop's export", aliases: "habits streaks android checkmarks check-ins", unit: ["check-in", "check-ins"] },
  { format: "amazon", name: "Amazon", tagline: "Orders, Kindle, Audible and Prime Video, from your data export", aliases: "shopping orders purchases returns kindle audible prime video books audiobooks reading watching", unit: ["thing", "things"] },
  { format: "apple_music", name: "Apple Music", tagline: "Every song you've played, from your Apple data", aliases: "music listening songs artists itunes apple privacy history", unit: ["play", "plays"] },
  { format: "spotify_history", name: "Spotify streaming history", tagline: "Every song you've streamed, with times, from your Spotify data", aliases: "spotify music listening songs artists albums extended streaming history privacy", unit: ["play", "plays"] },
  { format: "iplayer", name: "BBC iPlayer", tagline: "What you've watched, from your BBC account data", aliases: "bbc iplayer tv television programmes watching shows series", unit: ["programme", "programmes"] },
];

/** Habits and mood go in Batch B's habits group when it's there, under Health until then. */
const habitsHome = () => CONNECTOR_CATEGORIES.find((c) => /^habit/.test(c.id))?.id ?? "health";

/** The directory group a file import sits in. */
export function fileImportHome(f: FileImportFormat): string {
  return f === "amazon" ? "money" : f === "overcast" || f === "apple_music" || f === "iplayer" || f === "spotify_history" ? "entertainment" : f === "tfl" ? "travel" : habitsHome();
}

/** This device's note of the last import, for the card's meta. */
export const fileImportLine = (c: FileImportCard): ImportLine | null => lastImportTitle(`file-${c.format}`, c.unit);

export { backfillMark };

/** "Imported 7 Nov" and "1,204 habits", from a memo. */
function importLine(m: ImportMemo, unit: [string, string]): ImportLine | null {
  const at = new Date(m.at);
  if (Number.isNaN(at.getTime())) return null;
  const when = at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: at.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  return { when: `Imported ${when}`, count: `${m.items.toLocaleString("en-GB")} ${m.items === 1 ? unit[0] : unit[1]}` };
}

/** Open the import sheet (loaded on demand). */
export function openFileImport(format: FileImportFormat, changed?: () => void): void {
  if (format === "amazon") void import("../components/amazon-import").then((m) => m.openAmazonImport(changed));
  else if (format === "apple_music") void import("../components/apple-music-import").then((m) => m.openAppleMusicImport(changed));
  else if (format === "spotify_history") void import("../components/spotify-history-import").then((m) => m.openSpotifyHistoryImport(changed));
  else if (format === "iplayer") void import("../components/iplayer-import").then((m) => m.openIplayerImport(changed));
  else void import("../components/backfill-import").then((m) => m.openBackfillImport(format, changed));
}

/**
 * Sources' "From files": a row for each app you've imported a file from, with
 * when and how much, and a way to add a newer file. Fills itself from the
 * server (GET /api/days/import); hidden until something's been imported.
 */
export function fileImportsGroup(): { el: HTMLElement; refresh: () => void } {
  const listEl = h("div", { class: "card card--flush list src-list src-files" });
  const label = h("h3", { class: "group__label" }, "From files");
  const el = h("section", { class: "group src-group", hidden: true }, h("div", { class: "group__head" }, label), listEl);
  const row = (c: FileImportCard, memo: ImportMemo) => {
    const t = importLine(memo, c.unit);
    const b = h("button", { class: "btn btn--soft btn--sm acct-history__btn", type: "button", "aria-label": `Import a newer ${c.name} file` }, "Import");
    b.addEventListener("click", () => openFileImport(c.format, refresh));
    return h(
      "div",
      { class: "row acct-used" },
      backfillMark(c.format, "md"),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, c.name), h("span", { class: "row__meta" }, t ? `${t.count} · ${t.when}` : c.tagline)),
      b
    );
  };
  function refresh() {
    void request<{ imports: Partial<Record<FileImportFormat, ImportMemo | null>> }>("/days/import")
      .then((r) => {
        const have = FILE_IMPORTS.filter((c) => r.imports?.[c.format]?.at);
        listEl.replaceChildren(...have.map((c) => row(c, r.imports[c.format]!)));
        label.replaceChildren("From files", h("span", { class: "src-group__count" }, ` · ${have.length}`));
        el.hidden = !have.length;
      })
      .catch(() => undefined);
  }
  refresh();
  return { el, refresh };
}

/**
 * Sample mode shows no accounts, but a file import can run on its own sample:
 * Amazon's card, under Sources' sample notice (components/connector-settings.ts).
 */
export function sampleImportsGroup(): HTMLElement {
  const SAMPLES: Array<[FileImportFormat, string]> = [
    ["amazon", "Orders, Kindle, Audible and Prime Video, with a sample export"],
    ["apple_music", "A year and a half of listening, with a sample file"],
    ["spotify_history", "Six weeks of plays with their times, with a sample file"],
    ["iplayer", "Series and films, with a sample file"],
  ];
  const row = ([format, meta]: [FileImportFormat, string]) => {
    const c = FILE_IMPORTS.find((f) => f.format === format)!;
    const b = h("button", { class: "btn btn--soft btn--sm acct-history__btn", type: "button", "aria-label": `Try the ${c.name} import with a sample` }, "Try it");
    b.addEventListener("click", () => openFileImport(c.format));
    return h("div", { class: "row acct-used" }, backfillMark(c.format, "md"), h("span", { class: "row__body" }, h("span", { class: "row__title" }, c.name), h("span", { class: "row__meta" }, meta)), b);
  };
  return h(
    "section",
    { class: "group src-group" },
    h("div", { class: "group__head" }, h("h3", { class: "group__label" }, "Imports to try")),
    h("div", { class: "card card--flush list src-list src-files" }, ...SAMPLES.map(row))
  );
}
