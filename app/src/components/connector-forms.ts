/**
 * The Sources sheets for accounts and collections:
 *  - Add an account: a directory of services grouped by what they're for
 *    (search, jump to a group), optionally filtered to the services that feed
 *    one recipe, then a short connect step: whose account it is, the
 *    one-time setup steps when a service needs your own sign-in client, and
 *    a key checked as soon as it's pasted.
 *    OAuth services leave for the provider's sign-in page and come back to
 *    #/settings/accounts?connected=<id>, which opens account-connected.ts.
 *  - Rename an account, and its sign-in settings (key, client, OAuth).
 *  - Collections: pick what to collect, then accounts, label and schedule.
 *
 * Built only with h() and text nodes.
 */

import "../styles/accounts.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { showToast } from "./toast";
import { FILE_IMPORTS, backfillMark, fileImportHome, fileImportLine, openFileImport } from "../views/connect";
import { brandLogo } from "./brand-logo";
import { plural } from "../lib/format";
import { checkConnector, createConnector, deleteConnector, findConnectorAddress, signInConnector, updateConnector } from "../db/api";
import { addressFields } from "./address-fields";
import { errorText, serviceLabel } from "../lib/connectors-ui";
import { CONNECTOR_CATEGORIES, CONNECTOR_PRESETS, RECIPES, directApi, ownClientName, presetFor, type ConnectorPreset, type OAuthGrant, type OAuthTokenAuth } from "../../../lib/connector-presets";
import { clientGuide, keyGuide, keyShape, serverPages, setupBlock } from "./setup-steps";
import { closeThen, openConnected, type ConnectedContext } from "./account-connected";
import type { Connector, ConnectorAuthType, ConnectorOAuthSettings, ConnectorsState, RecipeId } from "../types";

let seq = 0;

/** A label-left, value-right row (the same rows record profiles use). */
function prop(label: string, control: HTMLElement): HTMLElement {
  if (!control.id) control.id = `cf-${++seq}`;
  return h("div", { class: "prop" }, h("label", { class: "prop__label", for: control.id }, label), h("span", { class: "prop__control" }, control));
}

function textInput(value: string, attrs: Record<string, string | boolean | undefined> = {}): HTMLInputElement {
  const el = h("input", { class: "prop__input", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", ...attrs }) as HTMLInputElement;
  el.value = value;
  return el;
}

function section(label: string | null, ...children: Array<HTMLElement | null>): HTMLElement {
  return h("section", { class: "group" }, label ? h("h3", { class: "group__label" }, label) : null, ...children);
}

const note = (text: string | HTMLElement) => h("p", { class: "form__hint" }, text);

function selectInput(options: Array<[string, string]>, value: string): HTMLSelectElement {
  const el = h("select", { class: "prop__input prop__select" }, ...options.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  el.value = value;
  return el;
}

/** The redirect address to register with a provider, with a Copy button. */
function redirectRow(redirect: string): HTMLElement {
  const copy = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Copy");
  copy.addEventListener("click", () => void navigator.clipboard?.writeText(redirect).then(() => showToast("Address copied", { icon: "check" })));
  return h("div", { class: "cf-redirect" }, h("span", { class: "cf-redirect__label" }, "Redirect address"), h("div", { class: "form__copy" }, h("code", {}, redirect), copy));
}

/** A folded group: "Technical details", "Sign-in settings". */
function fold(summary: string, ...children: Array<HTMLElement | null>): HTMLDetailsElement {
  return h("details", { class: "form__more acct-fold" }, h("summary", {}, summary), h("div", { class: "group" }, ...children)) as HTMLDetailsElement;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Slice D's `setup.own_clients`: which sign-in clients a new account can reuse, by name only. Optional until D lands. */
type OwnClients = Partial<Record<string, { from: string; name: string }>>;
const ownClients = (s: ConnectorsState): OwnClients => (s.setup as ConnectorsState["setup"] & { own_clients?: OwnClients }).own_clients ?? {};

// ---------- OAuth for custom servers ----------

interface CustomOAuthFields {
  /** The client, and the redirect address. */
  group: HTMLElement;
  /** Endpoints, scope, audience, client auth. */
  settings: HTMLElement;
  grant: () => OAuthGrant;
  /** What to send: `oauth` and `scope` always, the client only if typed. */
  payload: () => Record<string, unknown>;
}

/**
 * Plain OAuth 2 options for an "Other MCP server": browser sign-in or client
 * credentials, your own client, and the provider's URLs when the server
 * doesn't publish them. Shared by the connect and sign-in settings sheets.
 */
function customOAuthFields(redirect: string, existing: Connector | null, onChange: () => void): CustomOAuthFields {
  const o = existing?.oauth ?? {};
  const grant = selectInput(
    [
      ["authorization_code", "Sign in with a browser"],
      ["client_credentials", "Client ID and secret only"],
    ],
    o.grant ?? "authorization_code"
  );
  const clientId = textInput("", { placeholder: existing?.has_own_client ? "Saved · paste to replace" : "Client ID" });
  const clientSecret = textInput("", { type: "password", placeholder: existing?.has_client_secret ? "Saved · paste to replace" : "Client secret" });
  const authUrl = textInput(o.authorization_endpoint ?? "", { type: "url", inputmode: "url", placeholder: "Found automatically" });
  const tokenUrl = textInput(o.token_endpoint ?? "", { type: "url", inputmode: "url", placeholder: "Found automatically" });
  const scope = textInput(existing?.scope ?? "", { placeholder: "Server default" });
  const audience = textInput(o.audience ?? "", { placeholder: "None" });
  const tokenAuth = selectInput(
    [
      ["", "Automatic"],
      ["client_secret_basic", "HTTP Basic"],
      ["client_secret_post", "In the request body"],
    ],
    o.token_auth ?? ""
  );

  const redirectBox = redirectRow(redirect);
  const clientNote = note("");
  const authRow = prop("Sign-in URL", authUrl);
  const group = h(
    "div",
    { class: "group" },
    h("div", { class: "card card--flush fields" }, prop("How", grant), prop("Client ID", clientId), prop("Secret", clientSecret)),
    redirectBox,
    clientNote
  );
  const settings = h(
    "div",
    { class: "group" },
    h("div", { class: "card card--flush fields" }, authRow, prop("Token URL", tokenUrl), prop("Scope", scope), prop("Audience", audience), prop("Client auth", tokenAuth)),
    note("Leave the URLs empty if the server publishes them, as most do. Scopes are space-separated; read-only scopes keep the account read-only at the provider too.")
  );

  function paint() {
    const cc = grant.value === "client_credentials";
    redirectBox.hidden = cc;
    authRow.hidden = cc;
    clientNote.textContent = cc
      ? "No browser sign-in: Athena swaps the ID and secret for access, and renews it. Both are needed."
      : existing?.has_own_client
        ? "Replacing the client signs this account out. Paste just a secret to change only that."
        : "Only if the server asks for one. Most register Athena themselves.";
    onChange();
  }
  grant.addEventListener("change", paint);
  paint();

  return {
    group,
    settings,
    grant: () => grant.value as OAuthGrant,
    payload() {
      const cc = grant.value === "client_credentials";
      const oauth: ConnectorOAuthSettings = {
        grant: grant.value as OAuthGrant,
        authorization_endpoint: cc ? undefined : authUrl.value.trim() || undefined,
        token_endpoint: tokenUrl.value.trim() || undefined,
        audience: audience.value.trim() || undefined,
        token_auth: (tokenAuth.value || undefined) as OAuthTokenAuth | undefined,
      };
      const out: Record<string, unknown> = { oauth, scope: scope.value.trim() };
      if (clientId.value.trim()) out.client_id = clientId.value.trim();
      if (clientSecret.value.trim()) out.client_secret = clientSecret.value.trim();
      return out;
    },
  };
}

// ---------- sign-in helpers (shared with the detail pane) ----------

/**
 * Sign in: off to the provider's page for a browser sign-in, or (client
 * credentials, or a still-valid sign-in) straight to checking the account.
 */
export async function startSignIn(c: Connector): Promise<"redirect" | "done"> {
  const r = await signInConnector(c.id);
  if (r.authorization_url) {
    location.assign(r.authorization_url);
    return "redirect";
  }
  await checkTools(c);
  return "done";
}

/** Check the account answers, and say so. */
export async function checkTools(c: Connector): Promise<Connector | null> {
  try {
    const updated = await checkConnector(c.id);
    showToast(`${updated.name} is working`, { icon: "check" });
    return updated;
  } catch (err) {
    showToast(errorText(err, `Couldn't reach ${c.name}`), { icon: "close", timeoutMs: 6000 });
    return null;
  }
}

/** The word a button uses for where a sign-in goes: "Google" for Gmail. */
export function signInWhere(c: Pick<Connector, "provider" | "server_info">): string {
  const p = presetFor(c.provider);
  return p.id === "custom" ? serviceLabel(c) : p.needsOwnClient ? ownClientName(p) : p.label;
}

// ---------- Whose account is it? ----------

type Whose = "work" | "personal" | "other";

/** Work for work tools, Personal for entertainment and health, and the one you haven't got yet for a second Gmail. */
function defaultWhose(preset: ConnectorPreset, state: ConnectorsState): Whose {
  const have = new Set(state.connectors.filter((c) => c.provider === preset.id).map((c) => c.account_label.toLowerCase()));
  if (have.has("work") && !have.has("personal")) return "personal";
  if (have.has("personal") && !have.has("work")) return "work";
  return preset.category === "entertainment" || preset.category === "social" || preset.category === "health" || preset.category === "travel" || preset.id.startsWith("icloud-") ? "personal" : "work";
}

interface WhoseField {
  el: HTMLElement;
  label: () => string;
  name: () => string;
  /** Points at what's missing, or returns null when it's all there. */
  missing: () => string | null;
}

/**
 * Work · Personal · Other, and the name it makes ("Work Gmail"), with a
 * Rename link. A custom server has no service name to build on, so its name
 * is a field from the start.
 */
function whoseField(opts: { service: string | null; whose: Whose; label?: string; name?: string; showName?: boolean }): WhoseField {
  let whose: Whose = opts.whose;
  const other = textInput(whose === "other" ? (opts.label ?? "") : "", { placeholder: "Client, family, side project…", autocapitalize: "words", spellcheck: "true", "aria-label": "Whose account" });
  const name = textInput(opts.name ?? "", { placeholder: opts.service ? `e.g. Work ${opts.service}` : "e.g. Company wiki", autocapitalize: "words", spellcheck: "true" });
  // The name follows the choice ("Personal Gmail") until you type your own.
  let nameTouched = !opts.service;
  let nameOpen = !!opts.showName || !opts.service;
  const chips = (["work", "personal", "other"] as Whose[]).map((w) => {
    const b = h("button", { class: "chip acct-whose__chip", type: "button", role: "radio", "aria-checked": String(w === whose) }, cap(w)) as HTMLButtonElement;
    b.addEventListener("click", () => {
      whose = w;
      paint();
      if (w === "other") other.focus();
    });
    b.addEventListener("keydown", (e) => {
      const i = chips.indexOf(b);
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = chips[(i + step + chips.length) % chips.length];
      next.click();
      next.focus();
    });
    return b;
  });
  const label = () => (whose === "other" ? other.value.trim().toLowerCase() : whose);
  const auto = () => (opts.service ? [cap(label()), opts.service].filter(Boolean).join(" ") : "");
  if (opts.name && opts.name !== auto()) nameTouched = true;
  const savedAs = h("strong", {});
  const renameBtn = h("button", { class: "acct-link", type: "button" }, "Rename");
  const nameLine = h("p", { class: "acct-whose__name" }, "Saved as ", savedAs, " ", renameBtn);
  const nameRow = h("div", { class: "card card--flush fields acct-whose__rename" }, prop("Name", name));
  const otherRow = h("div", { class: "card card--flush fields" }, prop("Whose", other));
  renameBtn.addEventListener("click", () => {
    nameOpen = true;
    if (!name.value) name.value = auto();
    paint();
    name.focus();
    name.select();
  });
  name.addEventListener("input", () => (nameTouched = true));
  other.addEventListener("input", () => paint());

  function paint() {
    chips.forEach((c, i) => c.setAttribute("aria-checked", String((["work", "personal", "other"] as Whose[])[i] === whose)));
    chips.forEach((c) => (c.tabIndex = c.getAttribute("aria-checked") === "true" ? 0 : -1));
    otherRow.hidden = whose !== "other";
    if (!nameTouched) name.value = auto();
    savedAs.textContent = name.value || auto() || "…";
    nameLine.hidden = nameOpen;
    nameRow.hidden = !nameOpen;
  }
  paint();

  const el = h(
    "section",
    { class: "group acct-whose" },
    h("h3", { class: "group__label", id: `whose-${++seq}` }, "Whose account is it?"),
    h("div", { class: "chip-row acct-whose__chips", role: "radiogroup", "aria-labelledby": `whose-${seq}` }, ...chips),
    otherRow,
    nameLine,
    nameRow
  );
  return {
    el,
    label,
    name: () => name.value.trim() || auto(),
    missing() {
      if (whose === "other" && !other.value.trim()) {
        other.focus();
        return "Say whose account it is.";
      }
      if (!(name.value.trim() || auto())) {
        name.focus();
        return "Give the account a name.";
      }
      return null;
    },
  };
}

// ---------- Add an account ----------

export interface AddAccountOptions {
  /** Show only the services that feed this recipe ("Services for Life log"). */
  recipe?: RecipeId;
  /** Show only one group of services ("health"), for a first-run starter. */
  category?: string;
  /** For the connected sheet when no browser sign-in was needed (a key, client credentials). */
  connected?: ConnectedContext;
  /** The guided setup: services that sign in with one tap first, and those that need your own sign-in setup say so. */
  easyFirst?: boolean;
}

export function openAddAccount(state: ConnectorsState, done: () => void, opts: AddAccountOptions = {}): void {
  const body = h("div", { class: "cf" });
  const sheet = openSheet({ label: "Add an account", title: "Add an account", body, variant: "tall" });
  showDirectory(sheet, body, state, done, opts, opts.recipe ?? null);
}

/** Directory groups for food and mind until CONNECTOR_CATEGORIES has them; the Apple Health card shows in these and Health. */
const MIND_GROUPS = [
  { id: "food", label: "Food and drink" },
  { id: "habits", label: "Habits and mind" },
];
const APPLE_GROUPS = ["health", "food", "habits"];

/** Recipes a service feeds, other than Custom (which every service feeds). */
const feeds = (p: ConnectorPreset, recipe: RecipeId) => p.id !== "custom" && p.recipes.includes(recipe);

function showDirectory(sheet: SheetHandle, body: HTMLElement, state: ConnectorsState, done: () => void, opts: AddAccountOptions, recipe: RecipeId | null) {
  sheet.setTitle("Add an account");
  sheet.setBack(null);
  const scroller = () => body.closest<HTMLElement>(".sheet__scroll");
  const input = h("input", { type: "search", placeholder: "Search services", autocomplete: "off", "aria-label": "Search services", enterkeyhint: "go" }) as HTMLInputElement;
  const list = h("div", { class: "dir dir--services" });
  const jump = h("nav", { class: "chip-row dir__jump", "aria-label": "Jump to a group" });
  const status = h("p", { class: "visually-hidden", role: "status" });
  const foldText = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const recipeLabel = recipe ? RECIPES.find((r) => r.id === recipe)?.label ?? "" : "";

  // A section per category, in CONNECTOR_CATEGORIES order; A to Z inside one, with "Other MCP server" last.
  const groups = CONNECTOR_CATEGORIES.map((c) => ({
    ...c,
    presets: CONNECTOR_PRESETS.filter((p) => p.category === c.id && (!recipe || feeds(p, recipe)) && (!recipe || !opts.category || p.category === opts.category)).sort((a, b) => Number(a.id === "custom") - Number(b.id === "custom") || (opts.easyFirst ? Number(!!a.needsOwnClient) - Number(!!b.needsOwnClient) : 0) || a.label.localeCompare(b.label)),
  })).filter((g) => g.presets.length);
  // Food and drink, and Habits and mind (connectors-research-2, "Where new areas live"): Apple Health and Oura feed both, so
  // each shows here as well as under Health. If CONNECTOR_CATEGORIES gains these ids, that category is used instead.
  const ouraPreset = CONNECTOR_PRESETS.find((p) => p.id === "oura");
  if (!opts.category && (!recipe || recipe === "life-log")) {
    const at = groups.findIndex((g) => g.id === "health") + 1 || groups.length;
    const extra = MIND_GROUPS.filter((v) => !CONNECTOR_CATEGORIES.some((c) => c.id === v.id)).map((v) => ({ ...v, presets: ouraPreset ? [ouraPreset] : [] }) as unknown as (typeof groups)[number]);
    groups.splice(at, 0, ...extra);
    // Habits and mind is a real category (Habitify, lib/presets/life.ts): Oura joins its presets there instead of a second group.
    for (const g of groups) if (g.id === "habits" && ouraPreset && !g.presets.includes(ouraPreset)) g.presets = [...g.presets, ouraPreset].sort((x, y) => x.label.localeCompare(y.label));
  }

  /** The text with each search word marked, for the name and tagline. */
  function marked(text: string, words: string[]): Array<string | HTMLElement> {
    if (!words.length) return [text];
    const folded = foldText(text);
    const hit = new Array<boolean>(text.length).fill(false);
    for (const w of words) for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + 1)) hit.fill(true, i, i + w.length);
    const out: Array<string | HTMLElement> = [];
    for (let i = 0; i < text.length; ) {
      let j = i;
      while (j < text.length && hit[j] === hit[i]) j++;
      out.push(hit[i] ? h("mark", { class: "dir__hit" }, text.slice(i, j)) : text.slice(i, j));
      i = j;
    }
    return out;
  }

  function card(p: ConnectorPreset, words: string[]): HTMLElement {
    const count = state.connectors.filter((c) => c.provider === p.id).length;
    // Only what helps you choose: how many you have, or that it reuses a setup you've done.
    const reuse = p.needsOwnClient && p.ownClientLabel && ownClients(state)[p.ownClientLabel];
    const meta = count ? `${count} connected` : reuse ? `Uses your ${ownClientName(p)} setup` : opts.easyFirst && p.needsOwnClient ? `Needs a ${ownClientName(p)} setup first` : "";
    const el = h(
      "button",
      { class: "dir__card", type: "button" },
      brandLogo(p.id, "md"),
      h(
        "span",
        { class: "dir__body" },
        h("span", { class: "dir__name" }, ...marked(p.label, words)),
        h("span", { class: "dir__tagline" }, ...marked(p.tagline, words)),
        meta && (count || reuse) ? h("span", { class: "dir__meta dir__meta--on" }, icons.check(), meta) : meta ? h("span", { class: "dir__meta" }, meta) : null
      ),
      h("span", { class: "dir__chev" }, icons.chevronRight())
    );
    el.addEventListener("click", () => showConnect(sheet, body, state, p, done, opts, recipe));
    return el;
  }

  /**
   * Health: Apple Health comes from the iPhone Shortcut, not an account. Food
   * and mind apps with no API of their own write to it, so searching for one
   * finds this card and says so (connectors-research-2).
   */
  const VIA_HEALTH = ["MyFitnessPal", "Cronometer", "MacroFactor", "Lose It!", "Yazio", "Headspace", "Calm"];
  const appleWords = (words: string[]) => !words.length || words.every((w) => foldText(`Apple Health iPhone Shortcut sleep steps food drink calories coffee caffeine water alcohol mindful meditation State of Mind health ${VIA_HEALTH.join(" ")}`).includes(w));
  function appleHealthCard(words: string[], group = "health"): HTMLElement[] {
    if (!APPLE_GROUPS.includes(group) || (recipe && recipe !== "life-log") || !appleWords(words)) return [];
    const via = words.length ? VIA_HEALTH.find((a) => words.some((w) => foldText(a).includes(w))) : undefined;
    const tagline = via ? `${via} comes in through Apple Health` : group === "food" ? "Calories, water, coffee and drinks" : group === "habits" ? "Mindful minutes and State of Mind" : "Sleep, steps, food and mindful minutes";
    const el = h(
      "button",
      { class: "dir__card", type: "button" },
      h("span", { class: "logo logo--md logo--custom", "aria-hidden": "true" }, icons.heart()),
      h("span", { class: "dir__body" }, h("span", { class: "dir__name" }, ...marked("Apple Health", words)), h("span", { class: "dir__tagline" }, ...marked(tagline, words)), h("span", { class: "dir__meta" }, "Set up from your iPhone")),
      h("span", { class: "dir__chev" }, icons.chevronRight())
    );
    el.addEventListener("click", () => {
      sheet.close();
      location.hash = "#/settings/iphone?tab=health";
    });
    return [el];
  }

  /** Places and travel: Google Maps Timeline is a file, not an account, so its card opens the import (components/timeline-import.ts). */
  function timelineCard(words: string[]): HTMLElement[] {
    if (words.length && !words.every((w) => foldText("Google Maps Timeline import a file places and travel").includes(w))) return [];
    const el = h(
      "button",
      { class: "dir__card", type: "button" },
      h("span", { class: "logo logo--md logo--custom", "aria-hidden": "true" }, icons.pin()),
      h("span", { class: "dir__body" }, h("span", { class: "dir__name" }, ...marked("Google Maps Timeline", words)), h("span", { class: "dir__tagline" }, ...marked("Import a file from your phone", words))),
      h("span", { class: "dir__chev" }, icons.chevronRight())
    );
    el.addEventListener("click", () => {
      // Wait for this sheet's history step to go before the import sheet opens.
      let opened = false;
      const go = () => {
        if (opened) return;
        opened = true;
        window.removeEventListener("popstate", go);
        void import("./timeline-import").then((m) => m.openTimelineImport(done));
      };
      window.addEventListener("popstate", go);
      setTimeout(go, 400);
      sheet.close();
    });
    return [el];
  }

  /** Apps whose history comes from an export file (views/connect.ts): a card in their group that opens the import. */
  function fileCards(groupId: string, groupLabel: string, words: string[]): HTMLElement[] {
    return FILE_IMPORTS.filter((f) => fileImportHome(f.format) === groupId && words.every((w) => foldText(`${f.name} ${f.tagline} ${f.aliases} ${groupLabel} import a file`).includes(w))).map((f) => {
      const last = fileImportLine(f);
      const el = h(
        "button",
        { class: "dir__card", type: "button" },
        backfillMark(f.format, "md"),
        h(
          "span",
          { class: "dir__body" },
          h("span", { class: "dir__name" }, ...marked(f.name, words)),
          h("span", { class: "dir__tagline" }, ...marked(f.tagline, words)),
          last ? h("span", { class: "dir__meta dir__meta--on" }, icons.check(), last.when) : null
        ),
        h("span", { class: "dir__chev" }, icons.chevronRight())
      );
      el.addEventListener("click", () => {
        // As the Timeline card: let this sheet's history step go before the import's opens.
        let opened = false;
        const go = () => {
          if (opened) return;
          opened = true;
          window.removeEventListener("popstate", go);
          openFileImport(f.format, done);
        };
        window.addEventListener("popstate", go);
        setTimeout(go, 400);
        sheet.close();
      });
      return el;
    });
  }

  let first: ConnectorPreset | null = null;
  const sections = new Map<string, HTMLElement>();
  const chips = new Map<string, HTMLButtonElement>();

  function paint() {
    const words = foldText(input.value).split(/\s+/).filter(Boolean);
    const shown = groups
      // A group listed twice gets its file cards once.
      .map((g, i) => ({ ...g, presets: g.presets.filter((p) => words.every((w) => foldText(`${p.label} ${p.tagline} ${g.label} ${(p.aliases ?? []).join(" ")}`).includes(w))), files: groups.findIndex((x) => x.id === g.id) === i ? fileCards(g.id, g.label, words) : [] }))
      .filter((g) => g.presets.length || g.files.length || appleHealthCard(words, g.id).length);
    first = shown.find((g) => g.presets.length)?.presets[0] ?? null;
    sections.clear();
    // Apple Health and Oura can sit in more than one group: each counts once.
    const total = new Set(shown.flatMap((g) => [...g.presets.map((p) => p.id), ...(appleHealthCard(words, g.id).length ? ["apple_health"] : [])])).size + shown.reduce((n, g) => n + g.files.length, 0);
    status.textContent = words.length ? (total ? `${total} ${plural(total, "service", "services")}` : "No services") : "";
    list.replaceChildren(
      ...(shown.length
        ? shown.map((g) => {
            const s = h("section", { class: "group dir__group", "aria-labelledby": `dir-${g.id}` }, h("h3", { class: "group__label", id: `dir-${g.id}` }, ...marked(g.label, words)), h("div", { class: "dir__grid" }, ...g.presets.map((p) => card(p, words)), ...(g.id === "travel" ? timelineCard(words) : []), ...appleHealthCard(words, g.id), ...g.files));
            sections.set(g.id, s);
            return s;
          })
        : [
            h(
              "div",
              { class: "dir__empty" },
              h("p", { class: "form__hint dir__none" }, words.length ? `No service matches “${input.value.trim()}”. “Other MCP server” takes any address.` : `Nothing feeds ${recipeLabel} yet. “Other MCP server” takes any address.`),
              card(presetFor("custom"), [])
            ),
          ])
    );
    for (const [id, chip] of chips) {
      const sh = shown.find((g) => g.id === id);
      const n = sh ? sh.presets.length + sh.files.length + appleHealthCard(words, id).length : 0;
      chip.disabled = !n;
      chip.querySelector(".chip__count")!.textContent = String(n);
    }
    spy();
  }

  jump.append(
    ...groups.map((g) => {
      const chip = h("button", { class: "chip dir__chip", type: "button" }, g.label, h("span", { class: "chip__count" })) as HTMLButtonElement;
      chip.addEventListener("click", () => {
        const s = sections.get(g.id);
        const sc = scroller();
        if (!s || !sc) return;
        pinned = g.id;
        spy();
        const head = body.querySelector<HTMLElement>(".dir__head")!.offsetHeight;
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        sc.scrollTo({ top: sc.scrollTop + s.getBoundingClientRect().top - sc.getBoundingClientRect().top - head, behavior: reduce ? "auto" : "smooth" });
      });
      chips.set(g.id, chip);
      return chip;
    })
  );

  /** Marks the chip of the group at the top of the list, and keeps it in view. */
  let current = "";
  // The tapped group stays marked until you scroll by hand, even if it's too near the end to reach the top.
  let pinned = "";
  function spy() {
    const sc = scroller();
    if (!sc) return;
    if (pinned && !sections.has(pinned)) pinned = "";
    const line = body.querySelector<HTMLElement>(".dir__head")!.getBoundingClientRect().bottom + 8;
    let id = sections.keys().next().value ?? "";
    for (const [gid, s] of sections) if (s.getBoundingClientRect().top <= line) id = gid;
    // At the very bottom, the last group wins even if it's too short to reach the top.
    if (sc.scrollTop > 0 && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) id = [...sections.keys()].pop() ?? id;
    if (pinned) id = pinned;
    if (id === current) return;
    current = id;
    for (const [gid, chip] of chips) chip.toggleAttribute("aria-current", gid === id);
    const chip = chips.get(id);
    if (chip) jump.scrollTo({ left: chip.offsetLeft - jump.clientWidth / 2 + chip.offsetWidth / 2, behavior: "smooth" });
  }

  input.addEventListener("input", () => {
    pinned = "";
    scroller()?.scrollTo({ top: 0 });
    paint();
  });
  // Enter opens the first service found.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && first && input.value.trim()) {
      e.preventDefault();
      showConnect(sheet, body, state, first, done, opts, recipe);
    }
  });

  // Filtered for a recipe: say so, with a way out to every service.
  let filterBar: HTMLElement | null = null;
  if (recipe) {
    const all = h("button", { class: "acct-link", type: "button" }, "Show all services");
    all.addEventListener("click", () => showDirectory(sheet, body, state, done, { ...opts, category: undefined }, null));
    const group = opts.category ? CONNECTOR_CATEGORIES.find((c) => c.id === opts.category)?.label : null;
    filterBar = h("div", { class: "acct-filter" }, h("span", { class: "acct-filter__text" }, ...(group ? [h("strong", {}, group), " services"] : ["Services for ", h("strong", {}, recipeLabel)])), all);
  }
  body.replaceChildren(h("div", { class: "dir__head" }, filterBar, h("label", { class: "search dir__search" }, icons.search(), input), groups.length > 1 ? jump : null), status, list);
  paint();
  const sc = scroller();
  sc?.scrollTo({ top: 0 });
  // Listeners on the shared scroller end once another step replaces the directory.
  const off = new AbortController();
  let raf = 0;
  const live = () => body.contains(list) || (off.abort(), false);
  sc?.addEventListener("scroll", () => live() && (cancelAnimationFrame(raf), (raf = requestAnimationFrame(spy))), { passive: true, signal: off.signal });
  for (const type of ["wheel", "touchstart", "keydown"]) sc?.addEventListener(type, () => live() && (pinned = ""), { passive: true, signal: off.signal });
  // Opened at a group (Leave by's "Add a journey planner"): every service, scrolled to that group once the sheet has laid out.
  if (opts.category && !recipe) requestAnimationFrame(() => requestAnimationFrame(() => chips.get(opts.category!)?.click()));
}

function showConnect(sheet: SheetHandle, body: HTMLElement, state: ConnectorsState, preset: ConnectorPreset, done: () => void, opts: AddAccountOptions, recipe: RecipeId | null) {
  const isCustom = preset.id === "custom";
  sheet.setTitle(isCustom ? "Other MCP server" : `Connect ${preset.label}`);
  sheet.setBack(() => showDirectory(sheet, body, state, done, opts, recipe));

  const redirect = state.setup.callback_url;
  const whose = whoseField({ service: isCustom ? null : preset.label, whose: defaultWhose(preset, state) });
  const url = textInput(preset.url, { type: preset.address?.text ? "text" : "url", placeholder: preset.urlHint ?? "https://…/mcp", inputmode: preset.address?.text ? "text" : "url", "aria-label": preset.address?.label ?? "Server address" });
  const token = textInput("", { type: "password", placeholder: "Paste it here", autocomplete: "off", "aria-label": `${preset.label} key` });
  const idLabel = preset.clientFields?.id ?? "Client ID";
  const secretLabel = preset.clientFields?.secret ?? "Secret";
  const clientId = textInput("", { placeholder: preset.clientIdHint ?? (preset.ownClientLabel === "Google" ? "…apps.googleusercontent.com" : "Client ID"), "aria-label": idLabel });
  const clientSecret = textInput("", { type: "password", placeholder: preset.clientFields ? secretLabel : "Client secret", "aria-label": preset.clientFields?.secret ?? "Client secret" });
  const scope = textInput(preset.scope, { placeholder: "Server default" });
  const error = h("p", { class: "form__error", role: "alert" });
  const submit = h("button", { class: "btn btn--primary btn--block acct-submit", type: "submit" }) as HTMLButtonElement;
  // An address asked for as labelled groups (Octopus's meters), found with the key just pasted.
  const fieldsSpec = !isCustom ? preset.address?.fields : undefined;
  const fields = fieldsSpec
    ? addressFields(fieldsSpec, {
        find: (query) => {
          if (!token.value.trim()) return Promise.reject(new Error(`Paste your ${preset.label} key first.`));
          return findConnectorAddress({ provider: preset.id, query, token: token.value.trim() });
        },
      })
    : null;

  // How it signs in: the preset's way first. Others are a link ("Use an API key instead"), or a choice for a custom server.
  const auths: ConnectorAuthType[] = [preset.auth, ...(preset.altAuth ?? [])];
  let auth: ConnectorAuthType = preset.auth;

  // Your own sign-in client: reuse the one you set up for another account where slice D offers it.
  const clientKey = preset.ownClientLabel ?? preset.label;
  const reusable = preset.needsOwnClient ? ownClients(state)[clientKey] : undefined;
  let reuse = !!reusable;

  // ----- key (token services) -----
  const keyState = h("p", { class: "acct-key__state", role: "status" });
  const shape = keyShape(preset.id);
  // A username that goes with the key (iCloud: an Apple ID and an app-specific password), checked as a pair.
  const userSpec = preset.username;
  const username = userSpec
    ? textInput("", { placeholder: userSpec.placeholder, autocomplete: userSpec.autocomplete, inputmode: userSpec.inputmode, autocapitalize: "off", spellcheck: "false", "aria-label": userSpec.label })
    : null;
  const checker = userSpec ? ownClientName(preset) : isCustom ? "the server" : preset.label;
  if (userSpec) {
    token.setAttribute("aria-label", "App-specific password");
  }
  // A key that comes with a client and a token URL (DVSA's MOT History): all four in one card, in the order the email gives them.
  const credSpec = preset.clientCredentials;
  const tokenUrl = credSpec ? textInput("", { type: "url", inputmode: "url", placeholder: credSpec.hint, "aria-label": "Token URL" }) : null;
  if (credSpec) {
    clientId.setAttribute("placeholder", "Client ID");
    clientSecret.setAttribute("placeholder", "Client secret");
    token.setAttribute("aria-label", "API key");
  }
  const credMissing = () => (credSpec ? [clientId, clientSecret, token, tokenUrl!].find((i) => !i.value.trim()) ?? null : null);
  const keyField = h(
    "div",
    { class: "acct-key" },
    h(
      "div",
      { class: "card card--flush fields" },
      username ? prop(userSpec!.label, username) : null,
      credSpec ? prop("Client ID", clientId) : null,
      credSpec ? prop("Client secret", clientSecret) : null,
      prop(userSpec ? "Password" : credSpec ? "API key" : "Key", token),
      credSpec ? prop("Token URL", tokenUrl!) : null
    ),
    keyState
  );
  for (const input of [token, username]) {
    input?.addEventListener("input", () => {
      keyState.textContent = "";
      keyState.className = "acct-key__state";
    });
  }
  // A paste is the moment to check: shape first, here, then with the service itself.
  token.addEventListener("paste", () =>
    setTimeout(() => {
      const v = token.value.trim();
      if (!v) return;
      if (shape && !shape.test.test(v)) return keyNote("warn", `That doesn't look like ${userSpec ? "an app-specific password" : `a ${preset.label} key`}. ${shape.hint}`);
      if (username && !username.value.trim()) {
        keyNote("", `Add your ${userSpec!.label} and Athena checks both.`);
        username.focus();
        return;
      }
      const gap = credMissing();
      if (gap) {
        keyNote("", "Add all four from DVSA's email and Athena checks them together.");
        gap.focus();
        return;
      }
      // Fields come after the key (Octopus's meters): leave them to be filled in.
      if (!whose.missing() && (!isCustom || url.value.trim()) && !fields) form.requestSubmit();
    })
  );
  // The Apple ID pasted last: check the pair then too.
  username?.addEventListener("paste", () =>
    setTimeout(() => {
      const v = token.value.trim();
      if (username.value.trim() && v && (!shape || shape.test.test(v)) && !whose.missing()) form.requestSubmit();
    })
  );
  // Your second iCloud service: the Apple ID and password you already gave, copied on the server.
  const pairFrom = userSpec
    ? state.connectors.find((c) => c.auth_type === "token" && c.has_token && c.status !== "needs_auth" && presetFor(c.provider).username?.label === userSpec.label)
    : undefined;
  let reusePair = !!pairFrom;
  const differentPair = h("button", { class: "acct-link", type: "button" }, `Use a different ${userSpec?.label ?? "key"}`);
  const pairLine = pairFrom
    ? h(
        "div",
        { class: "acct-reuse" },
        h("span", { class: "acct-reuse__icon" }, icons.check()),
        h("p", { class: "acct-reuse__text" }, `Uses your ${userSpec!.label} from ${pairFrom.name}`)
      )
    : null;
  differentPair.addEventListener("click", () => {
    reusePair = false;
    paint();
    username?.focus();
  });
  function keyNote(tone: "warn" | "good" | "", text: string) {
    keyState.className = `acct-key__state${tone ? ` acct-key__state--${tone}` : ""}`;
    keyState.textContent = text;
  }
  const keyGroup = section(
    isCustom ? "Key" : userSpec ? "Your app-specific password" : `Your ${preset.label} key`,
    setupBlock(keyGuide(preset, keyField)),
    note(userSpec ? "Kept encrypted on Athena's server, with your Apple ID." : "Kept encrypted on Athena's server and never shown again.")
  );

  // A step that opens a page on your own server (Mastodon) follows the address you type.
  if (keyGroup.querySelector("a[data-open-on]")) {
    url.addEventListener("input", () => serverPages(keyGroup, url.value));
    serverPages(keyGroup, url.value);
  }

  // ----- own client (Google, Microsoft, Trakt…) -----
  // Each box is placed once: in the step where you copy it, or under Technical details.
  const fieldCard = (...rows: HTMLElement[]) => h("div", { class: "card card--flush fields" }, ...rows);
  const bothField = () => fieldCard(prop(idLabel, clientId), prop(secretLabel, clientSecret));
  const guide = preset.needsOwnClient ? clientGuide(preset, redirect, { id: () => fieldCard(prop(idLabel, clientId)), secret: () => fieldCard(prop(secretLabel, clientSecret)), both: bothField }) : null;
  const setupGroup = guide
    ? h(
        "section",
        { class: "group acct-setup" },
        h("h3", { class: "group__label" }, `Set up ${ownClientName(preset)} once`),
        h(
          "p",
          { class: "acct-setup__lede" },
          `${ownClientName(preset)} makes you register Athena yourself.${guide.minutes ? ` It takes about ${guide.minutes} minutes,` : ""} and your next ${ownClientName(preset)} account skips this.`
        ),
        setupBlock(guide)
      )
    : null;
  const differentClient = h("button", { class: "acct-link", type: "button" }, "Use a different client");
  const reuseLine = reusable
    ? h(
        "div",
        { class: "acct-reuse" },
        h("span", { class: "acct-reuse__icon" }, icons.check()),
        h("p", { class: "acct-reuse__text" }, `Uses your ${ownClientName(preset)} setup from ${reusable.name}`)
      )
    : null;
  differentClient.addEventListener("click", () => {
    reuse = false;
    paint();
    setupGroup?.querySelector<HTMLElement>("a, button, input")?.focus();
  });

  // ----- custom server -----
  let ready = false;
  const custom = isCustom ? customOAuthFields(redirect, null, () => ready && paint()) : null;
  const authSeg = h("div", { class: "seg", role: "radiogroup", "aria-label": "How it signs in" });
  const authLabel: Record<ConnectorAuthType, string> = { oauth: "Sign in", token: "Key", none: "Nothing" };
  const segButtons = auths.map((a) => {
    const b = h("button", { class: "seg__item", type: "button", role: "radio", "aria-checked": String(a === auth) }, authLabel[a]);
    b.addEventListener("click", () => {
      auth = a;
      paint();
    });
    return b;
  });
  authSeg.append(...segButtons);
  const serverGroup = isCustom || !preset.url
    ? section(
        isCustom ? "Server" : preset.address?.section ?? (preset.urlHint ? "Your profile" : "Address"),
        fields ? fields.el : h("div", { class: "card card--flush fields" }, prop(preset.address?.label ?? (preset.urlHint && !isCustom ? "Link" : "Address"), url)),
        isCustom ? h("div", { class: "acct-auth" }, h("p", { class: "acct-auth__label" }, "It needs"), authSeg) : null,
        preset.urlHint && !isCustom ? note(preset.help) : null
      )
    : null;

  // "Or use an API key instead" for services that take either (Linear, GitHub).
  const altAuth = !isCustom && auths.length > 1 ? auths.find((a) => a !== preset.auth) ?? null : null;
  const switchAuth = altAuth ? h("button", { class: "acct-link acct-switch", type: "button" }) : null;
  switchAuth?.addEventListener("click", () => {
    auth = auth === preset.auth ? altAuth! : preset.auth;
    paint();
  });

  // ----- technical details -----
  const ownClientFold = !preset.needsOwnClient && !isCustom && !preset.clientCredentials ? h("div", { class: "group" }, h("p", { class: "acct-fold__title" }, "Your own sign-in client"), note("Only if your workspace asks for one."), bothField(), redirectRow(redirect)) : null;
  const technical = fold(
    "Technical details",
    isCustom ? custom!.group : null,
    isCustom ? custom!.settings : null,
    !isCustom ? h("div", { class: "card card--flush fields" }, prop("Scope", scope), !preset.urlHint && preset.url ? prop("Address", url) : null) : null,
    !isCustom ? note("Space-separated scopes. Read-only scopes keep the account read-only at the provider too.") : null,
    ownClientFold,
    reusable ? h("div", { class: "acct-fold__row" }, differentClient) : null
  );

  // The service's own note (a plan it needs, a switch to turn on first), for sign-in. A key has its own steps.
  // "Signs in with your Linear account" is what the button says already, and the key has its own link.
  const helpText = preset.help
    .split(/(?<=\.)\s+/)
    .filter((s) => !new RegExp(`^Signs in with your ${preset.label.replace(/[^\w\s]/g, ".")} account\.?$`, "i").test(s.trim()) && !(altAuth && /\binstead\b/i.test(s)))
    .join(" ")
    .replace(new RegExp(`^Signs in with your ${preset.label.replace(/[^\w\s]/g, ".")} account,?\s*`, "i"), "")
    .trim();
  const help = !preset.needsOwnClient && helpText && !preset.urlHint && !isCustom ? h("p", { class: "acct-help" }, cap(helpText)) : null;

  function paint() {
    const oauth = auth === "oauth";
    keyGroup.hidden = auth !== "token" || reusePair;
    if (pairLine) pairLine.hidden = !reusePair;
    differentPair.hidden = !reusePair;
    // Netflix has no sign-in, so its note is the only thing to say (lib/presets/netflix.ts).
    if (help) help.hidden = auth !== "oauth" && preset.id !== "netflix" && !preset.live;
    if (setupGroup) setupGroup.hidden = !oauth || reuse;
    if (reuseLine) reuseLine.hidden = !oauth || !reuse;
    differentClient.hidden = !reuse;
    if (ownClientFold) ownClientFold.hidden = !oauth;
    segButtons.forEach((b, i) => b.setAttribute("aria-checked", String(auths[i] === auth)));
    if (custom) {
      custom.group.hidden = !oauth;
      custom.settings.hidden = !oauth;
      technical.hidden = !oauth;
    }
    // iCloud's addresses are fixed and it has no scopes: nothing technical to change. Nor for a preset set out as data (address, setup).
    if (userSpec || preset.id === "netflix" || ((preset.address || preset.setup) && !reusable)) technical.hidden = true;
    // A service Athena reads itself with a key or a profile link: its address and scopes are fixed, so nothing to change.
    if (!isCustom && auth !== "oauth" && directApi({ provider: preset.id, auth_type: auth })) technical.hidden = true;
    if (switchAuth) switchAuth.textContent = auth === preset.auth ? (altAuth === "token" ? "Use an API key instead" : `Sign in with ${preset.label} instead`) : auth === "token" ? `Sign in with ${preset.label} instead` : "Use an API key instead";
    submit.textContent = preset.id === "netflix" || (preset.live && auth === "none") ? `Add ${preset.label}` :
      auth !== "oauth" || custom?.grant() === "client_credentials" ? (auth === "token" && !reusePair ? "Check and connect" : "Connect") : isCustom ? "Continue to sign in" : `Continue to ${preset.needsOwnClient ? ownClientName(preset) : preset.label}`;
  }

  const form: HTMLFormElement = h(
    "form",
    { class: "cf-form acct-form", novalidate: true },
    h(
      "div",
      { class: "cf-hero cf-hero--row" },
      brandLogo(preset.id, "lg"),
      h("div", { class: "cf-hero__text" }, h("h3", { class: "cf-hero__name" }, preset.label), h("p", { class: "cf-hero__help" }, preset.tagline))
    ),
    whose.el,
    fields ? null : serverGroup,
    reuseLine,
    pairLine,
    pairFrom ? h("div", { class: "acct-fold__row" }, differentPair) : null,
    setupGroup,
    keyGroup,
    fields ? serverGroup : null,
    help,
    switchAuth ? h("div", { class: "acct-fold__row" }, switchAuth) : null,
    technical,
    error,
    submit,
    h("p", { class: "cf-foot" }, icons.check(), preset.live ? preset.live.foot : preset.id === "netflix" ? "Athena never signs in to Netflix. It reads only the files you choose." : preset.category === "travel" ? "Athena only reads and never checks in. Where you've been is encrypted." : preset.category === "health" ? `Athena only reads, and encrypts every health figure.${preset.id === "strava" ? " By connecting, you accept Strava's API terms for personal use." : ""}` : "Athena only reads. It never sends, edits or deletes.")
  ) as HTMLFormElement;
  paint();
  ready = true;
  body.replaceChildren(form);
  body.closest(".sheet__scroll")?.scrollTo({ top: 0 });

  /** The account's in, without a browser step: show what it's for. */
  function finished(c: Connector) {
    const next: ConnectorsState = { ...state, connectors: [...state.connectors.filter((x) => x.id !== c.id), c] };
    closeThen(sheet.close, () => openConnected(next, c.id, opts.connected ?? {}));
    done();
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const missing = whose.missing();
    if (missing) {
      error.textContent = missing;
      return;
    }
    if (fields && !fields.check()) {
      error.textContent = fields.problem();
      fields.focus();
      return;
    }
    if ((isCustom || !preset.url) && !fields && !url.value.trim()) {
      error.textContent = preset.address?.missing ?? "Paste the server's address.";
      url.focus();
      return;
    }
    if (auth === "token" && !reusePair && username && !username.value.trim()) {
      error.textContent = `Add your ${userSpec!.label}.`;
      username.focus();
      return;
    }
    if (auth === "token" && credMissing()) {
      error.textContent = "Paste all four from DVSA's email: client ID, client secret, API key and token URL.";
      credMissing()!.focus();
      return;
    }
    if (auth === "token" && !reusePair && !token.value.trim()) {
      error.textContent = userSpec ? "Paste the app-specific password." : `Paste your ${preset.label} key.`;
      token.focus();
      return;
    }
    if (auth === "oauth" && preset.needsOwnClient && !reuse && (!clientId.value.trim() || (!preset.noClientSecret && !clientSecret.value.trim()))) {
      error.textContent = preset.noClientSecret ? "Paste the client ID from the last step." : preset.clientFields ? `Paste the ${preset.clientFields.id} and ${preset.clientFields.secret} from the last step.` : "Paste the client ID and secret from the last step.";
      (clientId.value.trim() ? clientSecret : clientId).focus();
      return;
    }
    submit.disabled = true;
    const was = submit.textContent;
    submit.textContent = auth === "token" ? `Checking with ${checker}…` : "Connecting…";
    if (auth === "token" && !reusePair) keyNote("", `Checking with ${checker}…`);
    let created: Connector | null = null;
    try {
      const payload: Record<string, unknown> = {
        name: whose.name(),
        account_label: whose.label(),
        provider: preset.id,
        url: fields ? fields.json() : url.value.trim() || preset.url,
        auth_type: auth,
        scope: scope.value.trim(),
      };
      if (auth === "token" && reusePair && pairFrom) payload.key_from = pairFrom.id;
      else if (auth === "token") {
        payload.token = token.value.trim();
        if (username) payload.username = username.value.trim();
        if (credSpec) Object.assign(payload, { client_id: clientId.value.trim(), client_secret: clientSecret.value.trim(), token_url: tokenUrl!.value.trim() });
      }
      if (custom && auth === "oauth") Object.assign(payload, custom.payload());
      else if (auth === "oauth" && reuse && reusable) payload.client_from = reusable.from;
      else if (auth === "oauth" && clientId.value.trim()) {
        payload.client_id = clientId.value.trim();
        if (!preset.noClientSecret) payload.client_secret = clientSecret.value.trim();
      }
      created = await createConnector(payload);
      if (created.auth_type === "oauth") {
        try {
          const r = await signInConnector(created.id);
          if (r.authorization_url) {
            location.assign(r.authorization_url);
            return;
          }
          finished(await checkConnector(created.id));
        } catch (err) {
          // The account exists now: fix it from its page rather than adding it twice.
          sheet.close();
          done();
          showToast(errorText(err, "Couldn't sign in"), { icon: "close", timeoutMs: 8000 });
        }
        return;
      }
      // A key is checked before the account is kept, so a bad one fails here and not on the first run.
      try {
        finished(await checkConnector(created.id));
      } catch (err) {
        await deleteConnector(created.id).catch(() => undefined);
        // The key may be fine and the address not (a Mastodon server that can't be found): say that, in the service's words.
        const said = errorText(err, "");
        if (auth === "token" && /profile link/i.test(said)) throw new Error(said);
        // A meter it can't find (Octopus) is the address's fault, not the key's: say it by the button.
        if (auth === "token" && fields && /can't find that/i.test(said)) throw new Error(said);
        const refusal = userSpec
          ? `${checker} didn't accept that. Check your ${userSpec.label}, and use an app-specific password, not your usual one.`
          : `${isCustom ? "The server" : preset.label} didn't accept that key. Check you copied all of it.`;
        // A preset set out as data (Plex, Jellyfin) says exactly what was wrong: the key, the address, or a server Athena can't reach.
        throw Object.assign(new Error(auth === "token" ? (reusePair || preset.setup ? errorText(err, refusal) : refusal) : errorText(err, "Athena couldn't reach that server.")), { key: !reusePair });
      }
    } catch (err) {
      const msg = errorText(err, "Couldn't add that account.");
      if (auth === "token" && (err as { key?: boolean }).key) {
        keyNote("warn", msg);
        token.focus();
        token.select();
      } else {
        keyNote("", "");
        error.textContent = msg;
      }
      submit.disabled = false;
      submit.textContent = was;
    }
  });
}

// ---------- Rename an account ----------

export function openRenameAccount(c: Connector, done: () => void): void {
  const l = c.account_label.toLowerCase();
  const whose = whoseField({
    service: c.provider === "custom" ? null : serviceLabel(c),
    whose: l === "work" || l === "personal" ? l : l ? "other" : "work",
    label: c.account_label,
    name: c.name,
    showName: true,
  });
  const error = h("p", { class: "form__error", role: "alert" });
  const submit = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Save") as HTMLButtonElement;
  const form = h("form", { class: "cf-form acct-form", novalidate: true }, whose.el, note("New notes are filed under the new label. Notes already saved keep theirs."), error, submit);
  const sheet = openSheet({ label: `Rename ${c.name}`, title: "Rename", body: form, variant: "compose" });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const missing = whose.missing();
    if (missing) {
      error.textContent = missing;
      return;
    }
    submit.disabled = true;
    try {
      await updateConnector(c.id, { name: whose.name(), account_label: whose.label() });
      sheet.close();
      showToast("Saved", { icon: "check" });
      done();
    } catch (err) {
      error.textContent = errorText(err, "Couldn't save.");
      submit.disabled = false;
    }
  });
}

// ---------- Sign-in settings ----------

/**
 * The key, client and OAuth settings, for when a fix needs more than the
 * problem box offers. `redirect` is the server's callback address
 * (ConnectorsState.setup.callback_url).
 */
export function openEditAccount(c: Connector, done: () => void, redirect: string, sharedLine: string | null = null): void {
  const preset = presetFor(c.provider);
  const custom = c.provider === "custom" && c.auth_type === "oauth" ? customOAuthFields(redirect, c, () => undefined) : null;
  const token = textInput("", { type: "password", placeholder: c.has_token ? "Saved · paste to replace" : "Paste it here" });
  // iCloud: the Apple ID is sealed with the password, so it's never shown here.
  const userSpec = preset.username;
  const username = userSpec ? textInput("", { placeholder: "Saved · type to replace", autocomplete: userSpec.autocomplete, inputmode: userSpec.inputmode, autocapitalize: "off", spellcheck: "false" }) : null;
  const clientId = textInput("", { placeholder: c.has_own_client ? "Saved · paste to replace" : "Client ID" });
  const clientSecret = textInput("", { type: "password", placeholder: "Client secret" });
  // DVSA's MOT History: the key comes with a client and a token URL, all replaced together.
  const credSpec = c.auth_type === "token" ? preset.clientCredentials : undefined;
  const tokenUrl = credSpec ? textInput("", { type: "url", inputmode: "url", placeholder: "Saved · paste to replace", "aria-label": "Token URL" }) : null;
  if (credSpec) {
    clientId.setAttribute("placeholder", "Saved · paste to replace");
    clientSecret.setAttribute("placeholder", "Saved · paste to replace");
  }
  const error = h("p", { class: "form__error", role: "alert" });
  const submit = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Save") as HTMLButtonElement;
  // An address asked for as fields (Octopus's meters): shown as it is, changed here, found with the saved key or a new one.
  const fieldsSpec = c.auth_type === "token" ? preset.address?.fields : undefined;
  const fields = fieldsSpec
    ? addressFields(fieldsSpec, {
        initial: fieldsSpec.read?.(c.url) ?? null,
        find: (query) => findConnectorAddress({ provider: c.provider, query, ...(token.value.trim() ? { token: token.value.trim() } : { connector_id: c.id }) }),
      })
    : null;

  const form = h(
    "form",
    { class: "cf-form acct-form", novalidate: true },
    c.auth_type === "token" && userSpec
      ? section(
          `${userSpec.label} and password`,
          h("div", { class: "card card--flush fields" }, prop(userSpec.label, username!), prop("New password", token)),
          note(`Leave them empty to keep the ones you have. A new ${userSpec.label} needs its own app-specific password.`),
          sharedLine ? note(sharedLine) : null
        )
      : c.auth_type === "token" && credSpec
        ? section(
            "DVSA's four details",
            h("div", { class: "card card--flush fields" }, prop("Client ID", clientId), prop("Client secret", clientSecret), prop("API key", token), prop("Token URL", tokenUrl!)),
            note("Leave them empty to keep what you have. To change any of them, paste all four from DVSA's email and Athena checks them together.")
          )
        : c.auth_type === "token"
          ? section("Key", h("div", { class: "card card--flush fields" }, prop("New key", token)), note("Leave empty to keep the one you have."))
          : null,
    fields ? section(preset.address!.section, fields.el) : null,
    custom ? section("Sign-in client", custom.group) : null,
    custom ? section("Addresses and scope", custom.settings) : null,
    c.auth_type === "oauth" && !custom
      ? section(
          preset.needsOwnClient ? `${ownClientName(preset)} sign-in client` : "Sign-in client",
          h("div", { class: "card card--flush fields" }, prop("Client ID", clientId), preset.noClientSecret ? null : prop("Secret", clientSecret)),
          redirectRow(redirect),
          note(preset.noClientSecret ? "A new client ID signs this account out; sign in again afterwards." : "A new client ID signs this account out; sign in again afterwards. A new secret on its own keeps you signed in.")
        )
      : null,
    error,
    submit
  );
  const sheet = openSheet({ label: `Sign-in settings for ${c.name}`, title: "Sign-in settings", body: form, variant: "tall" });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const patch: Record<string, unknown> = {};
      if (fields?.changed()) {
        if (!fields.check()) {
          error.textContent = fields.problem();
          fields.focus();
          submit.disabled = false;
          return;
        }
        patch.url = fields.json();
      }
      if (token.value.trim()) patch.token = token.value.trim();
      if (username?.value.trim()) {
        if (!patch.token) throw new Error(`Paste the app-specific password for that ${userSpec!.label} too.`);
        patch.username = username.value.trim();
      }
      if (credSpec) {
        const four = [clientId, clientSecret, token, tokenUrl!];
        if (four.some((i) => i.value.trim())) {
          const gap = four.find((i) => !i.value.trim());
          if (gap) {
            error.textContent = "Paste all four from DVSA's email: client ID, client secret, API key and token URL.";
            gap.focus();
            submit.disabled = false;
            return;
          }
          Object.assign(patch, { client_id: clientId.value.trim(), client_secret: clientSecret.value.trim(), token_url: tokenUrl!.value.trim() });
        }
      } else if (custom) Object.assign(patch, custom.payload());
      else if (clientId.value.trim() || clientSecret.value.trim()) {
        if (clientId.value.trim()) patch.client_id = clientId.value.trim();
        if (!preset.noClientSecret) patch.client_secret = clientSecret.value.trim();
      }
      const updated = await updateConnector(c.id, patch);
      sheet.close();
      const signedOut = c.auth_type === "oauth" && updated.status === "needs_auth" && c.status !== "needs_auth";
      if (custom?.grant() === "client_credentials" && (signedOut || patch.client_secret || updated.status !== "connected")) {
        // No browser step: get access with the new settings now, and check the account.
        await startSignIn(updated).catch((err) => showToast(errorText(err, "Couldn't get access"), { icon: "close", timeoutMs: 8000 }));
      } else if (patch.token || patch.url) {
        await checkTools(updated);
      } else {
        showToast(signedOut ? `Saved. Sign in to ${signInWhere(c)} again to use it` : "Saved", { icon: "check" });
      }
      done();
    } catch (err) {
      error.textContent = errorText(err, "Couldn't save.");
      submit.disabled = false;
    }
  });
}
