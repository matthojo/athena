/**
 * Settings → Drafts: the messaging apps you use. Drafts are only offered on
 * apps that are on, and a person's usual channel falls back to the next one
 * when it's off (lib/drafts.ts). Email and Text are on to begin with.
 *
 * The same on every device (GET/PUT /api/settings, lib/draft-prefs.ts),
 * with a copy here in localStorage so the sheet opens without waiting.
 * Sample mode keeps it on this device only.
 */
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { showToast } from "./toast";
import { fetchSettings, isSampleMode, saveDraftChannelsSetting } from "../db/api";
import type { DraftChannel } from "../types";

export const DRAFT_CHANNEL_ORDER: DraftChannel[] = ["email", "text", "whatsapp", "telegram", "slack"];
const DEFAULT: DraftChannel[] = ["email", "text"];
const KEY = "athena.drafts.channels";

const APPS: Record<DraftChannel, { label: string; sub: string; icon: IconName }> = {
  email: { label: "Email", sub: "Gmail or Outlook Drafts, or your mail app", icon: "mail" },
  text: { label: "Text", sub: "Opens Messages with it filled in", icon: "chat" },
  whatsapp: { label: "WhatsApp", sub: "Opens the chat with it filled in", icon: "chat" },
  telegram: { label: "Telegram", sub: "Opens Telegram, and you pick the chat", icon: "send" },
  slack: { label: "Slack", sub: "Copies it and opens the DM", icon: "chat" },
};

const tidy = (raw: unknown): DraftChannel[] => {
  const on = new Set(Array.isArray(raw) ? raw : []);
  const list = DRAFT_CHANNEL_ORDER.filter((c) => on.has(c));
  return list.length ? list : [...DEFAULT];
};

/** The apps you use, as this device last knew them. */
export function draftChannels(): DraftChannel[] {
  try {
    const saved = localStorage.getItem(KEY);
    return saved ? tidy(JSON.parse(saved)) : [...DEFAULT];
  } catch {
    return [...DEFAULT];
  }
}

function keep(list: DraftChannel[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode: this visit only */
  }
}

/** The server's copy, used here when it differs. Quietly does nothing offline or in sample mode. */
export async function syncDraftChannels(): Promise<DraftChannel[]> {
  if (isSampleMode()) return draftChannels();
  try {
    const { draft_channels } = await fetchSettings();
    if (draft_channels) keep(tidy(draft_channels));
  } catch {
    /* offline: this device's copy stands */
  }
  return draftChannels();
}

export function draftSettingsSection(): { el: HTMLElement; destroy: () => void } {
  const switches = new Map<DraftChannel, HTMLInputElement>();
  const paint = (list: DraftChannel[]) => switches.forEach((sw, c) => (sw.checked = list.includes(c)));

  const row = (c: DraftChannel) => {
    const app = APPS[c];
    const id = `draft-app-${c}`;
    const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-sub` }) as HTMLInputElement;
    switches.set(c, sw);
    sw.addEventListener("change", async () => {
      const before = draftChannels();
      const next = DRAFT_CHANNEL_ORDER.filter((x) => (x === c ? sw.checked : before.includes(x)));
      if (!next.length) {
        sw.checked = true;
        showToast("Keep at least one app on", { icon: "chat" });
        return;
      }
      keep(next);
      if (isSampleMode()) return;
      sw.disabled = true;
      try {
        await saveDraftChannelsSetting(next);
      } catch {
        keep(before);
        paint(before);
        showToast("That didn't save. Check you're online", { icon: "wifiOff" });
      } finally {
        sw.disabled = false;
      }
    });
    return h(
      "label",
      { class: "row tool-row", for: id },
      h("span", { class: "tile tile--sm" }, icons[app.icon]()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, app.label), h("span", { class: "row__meta", id: `${id}-sub` }, app.sub)),
      sw
    );
  };

  const list = h("div", { class: "card card--flush list" }, ...DRAFT_CHANNEL_ORDER.map(row));
  paint(draftChannels());
  void syncDraftChannels().then(paint);

  return {
    el: h(
      "section",
      { class: "settings__section settings__section--drafts", "aria-labelledby": "settings-drafts" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-drafts" }, icons.pen(), "Drafts")),
      h("p", { class: "settings__lede" }, "The messaging apps you use. Athena only drafts for these, and picks the one you use most with each person."),
      h(
        "div",
        { class: "settings__body" },
        h("section", { class: "group" }, h("div", { class: "group__head" }, h("h3", { class: "group__label" }, "Messaging apps you use")), list),
        h("p", { class: "form__hint" }, "Athena never sends a message. It opens the app with the words filled in, and you press Send. Signal isn't here because its links can't carry a message.")
      )
    ),
    destroy: () => undefined,
  };
}
