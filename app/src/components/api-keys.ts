/**
 * API keys (lib/api-keys.ts), in Settings: what lets other things use Athena
 * without the app's own sign-in. A capture key is for an iPhone Shortcut
 * (sends things in, reads nothing back); a Claude key is for Claude as a
 * connector (Athena's tools, nothing else); a full-access key is for a script
 * or a device. A key is shown once, when it's made, and removing it stops it
 * straight away. Settings → From your iPhone makes capture keys here too.
 *
 * Seeing, making and removing keys needs the access token Athena was set up
 * with: the server answers anything else 403 master_required. When the app
 * is signed in with a device key, listKeys / makeKey / removeKey below ask
 * for that token once and hold it in memory until the page is closed; it is
 * never written to the device.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { field, input } from "./fields";
import { ApiError, fetchApiKeys, isSampleMode, makeApiKey, removeApiKey } from "../db/api";
import { relativeTime } from "../lib/format";
import { extensionCard } from "./extension-card";
import type { ApiKey } from "../types";

type Scope = ApiKey["scope"];

export const SCOPE: Record<Scope, { label: string; detail: string; icon: "mic" | "key" | "plug" }> = {
  capture: { label: "Capture only", detail: "For an iPhone Shortcut. It can send things in to be filed, and can't read anything.", icon: "mic" },
  mcp: { label: "Agent only", detail: "For an AI agent you connect to Athena. It can read and add through Athena's tools. It can't delete, see archived items or use anything else.", icon: "plug" },
  full: { label: "Full access", detail: "For your own scripts. It can read and change everything, like the app, except these keys.", icon: "key" },
};
const SCOPE_ORDER: Scope[] = ["capture", "mcp", "full"];

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

// ---------- the access token, for managing keys ----------

/** The access token, once given, for this page only. Never stored. */
let master: string | null = null;
const needsMaster = (error: unknown) => error instanceof ApiError && error.status === 403 && error.message === "master_required";

/** Ask for the access token. Null when the sheet is closed without one. */
function askMaster(): Promise<string | null> {
  return new Promise((resolve) => {
    let given: string | null = null;
    const token = input("password", "", { placeholder: "Paste your access token", autocomplete: "off", autocapitalize: "none", spellcheck: false });
    const go = h("button", { class: "btn btn--primary", type: "submit" }, "Continue");
    const form = h(
      "form",
      { class: "api-key" },
      h("p", { class: "settings__lede" }, "Keys are managed with the access token you set Athena up with, not this device's sign-in. It's used for this and isn't kept on this device."),
      h("div", { class: "card card--flush fields" }, field("Access token", token)),
      h("div", { class: "api-key__actions" }, go)
    );
    const sheet = openSheet({ label: "Access token", title: "Enter your access token", body: form, onClose: () => resolve(given) });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!token.value.trim()) return token.focus();
      given = token.value.trim();
      sheet.close();
    });
  });
}

async function withMaster<T>(path: string, init: RequestInit, token: string): Promise<T> {
  const res = await fetch(`/api/api-keys${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    master = null;
    throw new ApiError("That isn't your access token. Check it and try again.", res.status);
  }
  if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`, res.status);
  return (await res.json()) as T;
}

/**
 * Run a keys request as the app is signed in; if the server wants the access
 * token instead, ask for it (unless `ask` is false) and run it with that.
 */
async function keys<T>(plain: () => Promise<T>, path: string, init: RequestInit, ask = true): Promise<T> {
  if (!master) {
    try {
      return await plain();
    } catch (error) {
      if (!needsMaster(error) || !ask) throw error;
    }
    master = await askMaster();
    if (!master) throw new ApiError("Enter your access token to manage keys.", 403);
  }
  return withMaster<T>(path, init, master);
}

/** The owner's keys. With `ask` false it throws rather than asking for the access token. */
export const listKeys = (ask = true): Promise<ApiKey[]> => keys(async () => ({ keys: await fetchApiKeys() }), "", {}, ask).then((r) => r.keys);
/** Make a key; its token comes back only here. */
export const makeKey = (label: string, scope: Scope): Promise<{ key: ApiKey; token: string }> => keys(() => makeApiKey(label, scope), "", { method: "POST", body: JSON.stringify({ label, scope }) });
/** Remove a key. */
export const removeKey = async (id: string): Promise<void> => void (await keys<unknown>(() => removeApiKey(id), `/${encodeURIComponent(id)}`, { method: "DELETE" }));

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`${what} copied`, { icon: "check" });
  } catch {
    showToast(`Couldn't copy the ${what.toLowerCase()}`, { icon: "close" });
  }
}

/** Ask, then remove a key. Resolves true once it's gone. */
export async function confirmRemoveKey(k: ApiKey): Promise<boolean> {
  const ok = await confirmDialog({
    title: `Remove “${k.label}”?`,
    body: k.scope === "capture" ? "The Shortcut using this key stops working straight away. What it already sent stays in Athena." : "Anything using this key stops working straight away. If a device is signed in with it, that device is signed out.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) return false;
  try {
    await removeKey(k.id);
    showToast("Key removed", { icon: "trash" });
    return true;
  } catch (error) {
    showToast(errorText(error, "Couldn't remove it"), { icon: "close" });
    return false;
  }
}

/** A freshly made key, to copy now: Athena never shows it again. */
export function freshKeyCard(token: string): HTMLElement {
  const copy = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Copy");
  copy.addEventListener("click", () => void copyText(token, "Key"));
  return h(
    "div",
    { class: "conn-callout api-key__fresh" },
    h("span", { class: "conn-callout__icon" }, icons.shield()),
    h(
      "div",
      { class: "conn-callout__body" },
      h("p", { class: "conn-callout__title" }, "Copy your key now"),
      h("p", { class: "conn-callout__sub" }, "Athena only shows it once. If you lose it, remove it and make another."),
      h("div", { class: "api-key__token" }, h("code", { class: "prop__mono" }, token), copy)
    )
  );
}

/** Make a key: a name, what it can do, then the key itself, once. */
export function openNewApiKeySheet(opts: { scope?: Scope; onMade?: (made: { key: ApiKey; token: string }) => void } = {}): void {
  let scope: Scope = opts.scope ?? "capture";
  const root = h("div", { class: "api-key" });
  const sheet = openSheet({ label: "New API key", title: "New API key", body: root });
  const name = input("text", "", { placeholder: "Like iPhone or my agent", autocomplete: "off", maxlength: 60 });

  function choice(s: Scope): HTMLElement {
    const b = h(
      "button",
      { class: "api-key__scope", type: "button", role: "radio", "aria-checked": String(s === scope) },
      h("span", { class: "tile tile--sm" }, icons[SCOPE[s].icon]()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, SCOPE[s].label), h("span", { class: "row__meta" }, SCOPE[s].detail))
    );
    b.addEventListener("click", () => {
      scope = s;
      paint();
    });
    return b;
  }

  function paint(made?: { key: ApiKey; token: string }) {
    if (made) {
      const done = h("button", { class: "btn btn--primary", type: "button" }, "Done");
      done.addEventListener("click", () => sheet.close());
      root.replaceChildren(
        h("p", { class: "api-key__made" }, icons[SCOPE[made.key.scope].icon](), `${made.key.label} · ${SCOPE[made.key.scope].label}`),
        freshKeyCard(made.token),
        h("div", { class: "api-key__actions" }, done)
      );
      return;
    }
    const create = h("button", { class: "btn btn--primary", type: "button" }, icons.plus(), "Make key") as HTMLButtonElement;
    create.addEventListener("click", async () => {
      create.disabled = true;
      try {
        const result = await makeKey(name.value, scope);
        opts.onMade?.(result);
        paint(result);
      } catch (error) {
        create.disabled = false;
        showToast(errorText(error, "Couldn't make the key"), { icon: "close", timeoutMs: 5000 });
      }
    });
    root.replaceChildren(
      h("div", { class: "card card--flush fields" }, field("Name", name)),
      h("div", { class: "api-key__scopes", role: "radiogroup", "aria-label": "What it can do" }, ...SCOPE_ORDER.map(choice)),
      h("div", { class: "api-key__actions" }, create)
    );
  }
  paint();
}

/** Settings → API keys. */
export function apiKeysSection(): { el: HTMLElement; reload: () => Promise<void> } {
  let keys: ApiKey[] | null = null;
  let failed: string | null = null;
  // The app is signed in with a device key: the list needs the access token first.
  let locked = false;
  const body = h("div", { class: "settings__body" });
  const el = h(
    "section",
    { class: "settings__section", id: "api-keys", "aria-labelledby": "settings-keys" },
    h("h2", { class: "settings__heading", id: "settings-keys" }, icons.key(), "API keys"),
    h("p", { class: "settings__lede" }, "Keys let other things use Athena without your sign-in: your iPhone's Shortcut, an AI agent, or a device signed in to this app. Each one is shown once, when it's made, and removing it stops it straight away."),
    body,
    extensionCard()
  );

  function row(k: ApiKey): HTMLElement {
    const remove = h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Remove ${k.label}` }, "Remove");
    remove.addEventListener("click", async () => {
      if (await confirmRemoveKey(k)) void reload();
    });
    const used = k.last_used_at ? `used ${relativeTime(k.last_used_at)}` : "not used yet";
    return h(
      "div",
      { class: "row" },
      h("span", { class: "tile tile--sm" }, icons[SCOPE[k.scope].icon]()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, k.label), h("span", { class: "row__meta" }, `${SCOPE[k.scope].label} · ${used}`)),
      remove
    );
  }

  function paint() {
    if (isSampleMode()) {
      body.replaceChildren(h("div", { class: "card empty empty--compact" }, h("p", { class: "empty__title" }, "Connect Athena to make keys"), h("p", { class: "empty__sub" }, "Keys live on your own Athena server, so they need a connection rather than sample data.")));
      return;
    }
    if (locked) {
      const unlock = h("button", { class: "btn btn--primary", type: "button" }, icons.key(), "Enter access token");
      unlock.addEventListener("click", async () => {
        master = await askMaster();
        if (master) void reload();
      });
      body.replaceChildren(
        h("div", { class: "card empty empty--compact" }, h("p", { class: "empty__title" }, "Your access token is needed here"), h("p", { class: "empty__sub" }, "Seeing, making and removing keys takes the access token you set Athena up with. This device's own sign-in can't do it.")),
        h("div", { class: "settings__actions" }, unlock)
      );
      return;
    }
    const add = h("button", { class: `btn ${keys?.length ? "btn--soft" : "btn--primary"}`, type: "button" }, icons.plus(), "New key");
    add.addEventListener("click", () => openNewApiKeySheet({ onMade: () => void reload() }));
    body.replaceChildren(
      failed
        ? h("div", { class: "card empty empty--compact" }, h("p", { class: "empty__title" }, "Couldn't load your keys"), h("p", { class: "empty__sub" }, failed))
        : keys === null
          ? h("div", { class: "card card--flush list" }, h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:40%" }))))
          : keys.length
            ? h("div", { class: "card card--flush list" }, ...keys.map(row))
            : h("div", { class: "card empty empty--compact" }, h("p", { class: "empty__title" }, "No keys yet"), h("p", { class: "empty__sub" }, "Make one for your iPhone's Shortcut, or for an AI agent.")),
      h("div", { class: "settings__actions" }, add)
    );
  }

  async function reload() {
    if (isSampleMode()) return paint();
    try {
      keys = await listKeys(false);
      failed = null;
      locked = false;
    } catch (error) {
      locked = needsMaster(error);
      failed = locked ? null : errorText(error, "Try again in a moment.");
    }
    paint();
  }

  paint();
  return { el, reload };
}
