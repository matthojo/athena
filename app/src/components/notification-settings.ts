/**
 * Notifications: turning them on for this device, and choosing what comes.
 *
 *  - pushCard(): this device's state in words, with the one next step. On
 *    iPhone, web push needs Athena on the Home Screen (iOS 16.4+), so a Safari
 *    tab says how to add it. The permission prompt only ever comes from a
 *    tap. A device whose subscription was made with an older server key is
 *    moved to the current one quietly.
 *  - notificationsSection(): Settings → Notifications (#/settings/notifications):
 *    the card, a switch per kind, the evening prompt's time and quiet hours.
 *    The switches live on the server (lib/nudges.ts), so they apply to every
 *    device with notifications on.
 *
 * iOS shows no action buttons on web notifications, so every notification is
 * one tap that opens the right page (app/public/sw.js). Words: docs/notes/nudges.md.
 */

import "../styles/nudges.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { showToast } from "./toast";
import { DEFAULT_PREFS, type NotificationPrefs, type NudgeKind } from "../../../lib/nudges";
import { RULES, settingsRuleIds } from "../lib/nudge-rules";
import { DEFAULT_PROACTIVE, fetchProactive, saveProactive, unmuteRule, type JourneyPlanners, type ProactivePatch, type ProactivePrefs, type RuleId } from "../db/nudges";
import { RULE_IDS, TRAVEL_MODES, type TravelMode } from "../../../lib/proactive/types";
import { TRAVEL_WORDS } from "../lib/travel-words";
import { loadCheckinSettings, onCheckinsChange } from "../db/checkins";
import { deletePushSubscription, fetchNotificationPrefs, fetchPushKey, isSampleMode, saveNotificationPrefs, savePushSubscription, sendTestPush } from "../db/api";

export const COPY = {
  heading: "Notifications",
  lede: "Choose what reaches your phone, and when it stays quiet.",
  notInstalledTitle: "Add Athena to your Home Screen first",
  notInstalledBody: "On iPhone, notifications only work from the Home Screen. In Safari, tap Share, then Add to Home Screen, and open Athena from there.",
  unsupportedTitle: "This browser can't show notifications",
  unsupportedIos: "Notifications need iOS 16.4 or later, with Athena on the Home Screen.",
  unsupportedOther: "Try Athena in a current version of Safari, Chrome, Edge or Firefox.",
  sampleTitle: "Connect Athena to get notifications",
  sampleBody: "Notifications come from your own Athena, so they need a connection rather than sample data.",
  offlineTitle: "You're offline",
  offlineBody: "Turning notifications on needs a connection. Try again when you're back online.",
  noKeyTitle: "Notifications aren't ready yet",
  noKeyBody: "Athena couldn't get notifications ready. Try again in a minute.",
  deniedTitle: "Notifications are blocked",
  deniedIos: "Turn them back on in Settings → Notifications → Athena, then come back here.",
  deniedOther: "Allow notifications for this site in your browser's site settings, then come back here.",
  offTitle: "Notifications are off on this device",
  offBody: "Turn them on to get the ones you choose below.",
  turnOn: "Turn on notifications",
  onTitle: "Notifications are on",
  onBody: "This device gets the ones switched on below.",
  test: "Send a test",
  turnOff: "Turn off",
  toastOn: "Notifications are on for this device",
  toastOff: "Notifications are off for this device",
  toastTestSent: "Test sent. It should arrive in a moment",
  toastTestNone: "No devices took the test",
  kindsLabel: "What you get",
  kindsHint: "These apply to every device with notifications on.",
  athenaLabel: "Nudges from Athena",
  athenaHint: "Each one opens Ask with the details ready, and says why it came. They arrive in your working hours (Settings → Days), at most a few a day.",
  pausedUntil: (d: string) => `Paused until ${d} after “Fewer like this”`,
  resume: "Resume",
  noPlanner: "No journey planner yet, so these times are estimates.",
  addPlanner: "Add a journey planner",
  usualTravel: "How you usually travel",
  noDriveKey: "Drive times need Google Maps. Without it, Leave by can't time a drive.",
  addGoogle: "Add Google Maps",
  replyAfter: "Nudge after",
  replyDays: (n: number) => `${n} working day${n === 1 ? "" : "s"}`,
  quietLabel: "Quiet hours",
  quietTitle: "Quiet hours",
  quietMeta: "Nothing arrives in these hours. Reminders wait until they end.",
  from: "From",
  to: "To",
  saveFailed: "That didn't save. Check you're online",
} as const;

/** What the lines depend on besides the switches: whether the evening routine is on (app/src/db/checkins.ts). */
type KindContext = { reflecting: boolean };

const KINDS: Array<{ kind: NudgeKind; icon: IconName; title: string; meta: (p: NotificationPrefs, c: KindContext) => string }> = [
  { kind: "briefing", icon: "cup", title: "Morning briefing", meta: () => "7:30 each morning, with your day ahead" },
  { kind: "events", icon: "calendar", title: "Events and travel", meta: () => "30 minutes before each event, and 3 hours before a flight" },
  { kind: "reminders", icon: "clock", title: "Your reminders", meta: () => "The ones you set, when they're due" },
  { kind: "morning", icon: "leaf", title: "Morning check-in", meta: (p) => `At ${p.morning_at}. Only sent when your morning check-in is on` },
  { kind: "evening", icon: "pen", title: "How was today?", meta: (p, c) => (c.reflecting ? `At ${p.evening_at}. Opens your evening reflection` : `At ${p.evening_at}, if you haven't added a mood or a line`) },
  { kind: "weekly", icon: "week", title: "Weekly review", meta: () => "Sunday evening, a look back at your week" },
];

// ---------- this device ----------

type PushState =
  | { kind: "unsupported"; ios: boolean }
  | { kind: "not-installed" }
  | { kind: "sample" }
  | { kind: "offline" }
  | { kind: "no-server-key" }
  | { kind: "denied" }
  | { kind: "off"; key: string }
  | { kind: "on"; sub: PushSubscription };

export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** VAPID public keys are base64url; PushManager wants bytes. */
function keyBytes(base64url: string): Uint8Array {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(sub: PushSubscription, key: string): boolean {
  const had = sub.options?.applicationServerKey;
  if (!had) return true; // Can't tell: leave it be.
  const a = new Uint8Array(had);
  const b = keyBytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function detect(): Promise<PushState> {
  // A Safari tab on iPhone never gets push: it has to be the Home Screen app.
  if (isIos() && !isStandalone()) return { kind: "not-installed" };
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!supported) return { kind: "unsupported", ios: isIos() };
  if (isSampleMode()) return { kind: "sample" };
  if (Notification.permission === "denied") return { kind: "denied" };
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  let key: string | null;
  try {
    key = await fetchPushKey();
  } catch {
    return sub && Notification.permission === "granted" ? { kind: "on", sub } : { kind: "offline" };
  }
  if (!key) return { kind: "no-server-key" };
  if (sub && Notification.permission === "granted") {
    try {
      // The server's key changed (it made a new one): move this device over.
      if (!sameKey(sub, key)) {
        await sub.unsubscribe();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource });
      }
      // Cheap, and puts the device back if the server lost it.
      await savePushSubscription(sub.toJSON());
      return { kind: "on", sub };
    } catch {
      return { kind: "off", key };
    }
  }
  return { kind: "off", key };
}

/** This device's notification state, with the next step. `onChange` hears when it turns on or off. */
export function pushCard(opts: { onChange?: (on: boolean) => void } = {}): { el: HTMLElement; refresh: () => Promise<void> } {
  const card = h("section", { class: "card reminders__card", "aria-live": "polite" });

  const paint = (icon: IconName, title: string, body: string, ...actions: HTMLElement[]) =>
    card.replaceChildren(
      h("div", { class: "reminders__head" }, h("span", { class: "tile" }, icons[icon]()), h("div", {}, h("p", { class: "empty__title" }, title), h("p", { class: "empty__sub" }, body))),
      ...(actions.length ? [h("div", { class: "reminders__actions" }, ...actions)] : [])
    );

  const button = (label: string, cls: string, run: () => Promise<void>) => {
    const b = h("button", { class: `btn ${cls}`, type: "button" }, label) as HTMLButtonElement;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await run();
      } finally {
        b.disabled = false;
      }
    });
    return b;
  };

  async function turnOn(key: string) {
    // Straight from the tap: iOS only shows the prompt for a user gesture.
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource });
        await savePushSubscription(sub.toJSON());
        showToast(COPY.toastOn, { icon: "bell" });
      } catch (error) {
        showToast(error instanceof Error ? `Couldn't turn on notifications: ${error.message}` : "Couldn't turn on notifications", { icon: "close", timeoutMs: 5000 });
      }
    }
    await refresh();
  }

  async function turnOff(sub: PushSubscription) {
    try {
      await deletePushSubscription(sub.endpoint).catch(() => undefined);
      await sub.unsubscribe();
      showToast(COPY.toastOff, { icon: "bell" });
    } catch {
      showToast("Couldn't turn notifications off", { icon: "close" });
    }
    await refresh();
  }

  async function refresh() {
    const state = await detect();
    opts.onChange?.(state.kind === "on");
    switch (state.kind) {
      case "not-installed":
        return paint("bell", COPY.notInstalledTitle, COPY.notInstalledBody);
      case "unsupported":
        return paint("bell", COPY.unsupportedTitle, state.ios ? COPY.unsupportedIos : COPY.unsupportedOther);
      case "sample":
        return paint("plug", COPY.sampleTitle, COPY.sampleBody);
      case "offline":
        return paint("wifiOff", COPY.offlineTitle, COPY.offlineBody);
      case "no-server-key":
        return paint("bell", COPY.noKeyTitle, COPY.noKeyBody);
      case "denied":
        return paint("bell", COPY.deniedTitle, isIos() ? COPY.deniedIos : COPY.deniedOther);
      case "off":
        return paint("bell", COPY.offTitle, COPY.offBody, button(COPY.turnOn, "btn--primary", () => turnOn(state.key)));
      case "on":
        return paint(
          "check",
          COPY.onTitle,
          COPY.onBody,
          button(COPY.test, "btn--soft", async () => {
            try {
              const r = await sendTestPush();
              showToast(r.sent ? COPY.toastTestSent : COPY.toastTestNone, { icon: "bell" });
            } catch (error) {
              showToast(error instanceof Error ? error.message : "Couldn't send a test", { icon: "close" });
            }
          }),
          button(COPY.turnOff, "btn--ghost", () => turnOff(state.sub))
        );
    }
  }

  card.replaceChildren(h("div", { class: "skeleton", style: "height:56px;width:100%" }));
  return { el: card, refresh };
}

// ---------- Settings → Notifications ----------

function group(label: string, ...children: HTMLElement[]): HTMLElement {
  return h("section", { class: "group" }, h("div", { class: "group__head" }, h("h3", { class: "group__label" }, label)), ...children);
}

function timeInput(value: string, label: string, onChange: (v: string) => void): HTMLInputElement {
  const input = h("input", { class: "field nudge-time", type: "time", step: 300, "aria-label": label, value }) as HTMLInputElement;
  input.addEventListener("change", () => /^\d\d:\d\d$/.test(input.value) && onChange(input.value));
  return input;
}

export function notificationsSection(): { el: HTMLElement; destroy: () => void } {
  let prefs: NotificationPrefs = { ...DEFAULT_PREFS };
  const context: KindContext = { reflecting: false };
  const kinds = h("div", { class: "card card--flush list" });
  const quiet = h("div", { class: "card card--flush list" });
  const athena = h("div", { class: "card card--flush list" });
  let proactive: ProactivePrefs = { ...DEFAULT_PROACTIVE, rules: { ...DEFAULT_PROACTIVE.rules } };
  let mutes: Partial<Record<RuleId, string>> = {};
  /** Unknown until the server says; then whether Leave by has TfL or Google Maps. */
  let planners: JourneyPlanners | null = null;
  const card = pushCard();

  /** A rule's switch: shown at once, put back if the server says no. */
  async function saveRule(patch: ProactivePatch) {
    const before = proactive;
    proactive = { ...proactive, ...patch, rules: { ...proactive.rules, ...(patch.rules ?? {}) } } as ProactivePrefs;
    paintAthena();
    try {
      proactive = await saveProactive(patch);
    } catch {
      proactive = before;
      showToast(COPY.saveFailed, { icon: "wifiOff" });
    }
    paintAthena();
  }

  function paintAthena() {
    const day = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(new Date(iso));
    athena.replaceChildren(
      ...settingsRuleIds(RULE_IDS).map((aid) => {
        // "flow" may not be a RuleId yet (the engine adds it): the prefs are read as if it were, on by default like Team's.
        const id = aid as RuleId;
        const r = RULES[aid];
        const on = proactive.rules[id] ?? true;
        const muted = mutes[id] && Date.parse(mutes[id]!) > Date.now() ? mutes[id]! : null;
        let extra: HTMLElement | undefined;
        if (muted && on) {
          const resume = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, COPY.resume);
          resume.addEventListener("click", async () => {
            await unmuteRule(id).catch(() => showToast(COPY.saveFailed, { icon: "wifiOff" }));
            delete mutes[id];
            paintAthena();
          });
          extra = h("div", { class: "nudge-extra" }, h("span", { class: "nudge-extra__label" }, COPY.pausedUntil(day(muted))), resume);
        } else if (id === "leave_by" && on) {
          // How the owner usually travels (each event can choose its own), then what's missing for it (Sources → Places and travel).
          const pick = h("select", { class: "field nudge-time", "aria-label": COPY.usualTravel }, ...TRAVEL_MODES.map((m) => h("option", { value: m, selected: m === proactive.travel_mode }, TRAVEL_WORDS[m]))) as HTMLSelectElement;
          pick.addEventListener("change", () => void saveRule({ travel_mode: pick.value as TravelMode }));
          const rows: HTMLElement[] = [h("label", { class: "nudge-extra" }, h("span", { class: "nudge-extra__label" }, COPY.usualTravel), pick)];
          if (planners && proactive.travel_mode === "drive" && !planners.google) {
            rows.push(h("div", { class: "nudge-extra nudge-extra--stack" }, h("span", { class: "nudge-extra__label" }, COPY.noDriveKey), h("a", { class: "btn btn--soft btn--sm", href: "#/settings/sources?add=travel" }, COPY.addGoogle)));
          } else if (planners && !planners.tfl && !planners.google) {
            // No journey planner: say the times are guesses, and where to add one.
            rows.push(h("div", { class: "nudge-extra nudge-extra--stack" }, h("span", { class: "nudge-extra__label" }, COPY.noPlanner), h("a", { class: "btn btn--soft btn--sm", href: "#/settings/sources?add=travel" }, COPY.addPlanner)));
          }
          extra = h("div", { class: "nudge-extras" }, ...rows);
        } else if (id === "awaiting_reply" && on) {
          const pick = h("select", { class: "field nudge-time", "aria-label": COPY.replyAfter }, ...[2, 3, 4, 5, 7].map((n) => h("option", { value: String(n), selected: n === proactive.reply_days }, COPY.replyDays(n)))) as HTMLSelectElement;
          pick.addEventListener("change", () => void saveRule({ reply_days: Number(pick.value) }));
          extra = h("label", { class: "nudge-extra" }, h("span", { class: "nudge-extra__label" }, COPY.replyAfter), pick);
        }
        return switchRow(r.icon, r.name, r.meta, on, (next) => void saveRule({ rules: { [id]: next } }), extra);
      })
    );
  }

  /** Show the change at once; put it back if the server says no. Sample mode keeps it on this page. */
  async function save(patch: Partial<NotificationPrefs>) {
    const before = prefs;
    prefs = { ...prefs, ...patch };
    paint();
    if (isSampleMode()) return;
    try {
      prefs = await saveNotificationPrefs(patch);
    } catch {
      prefs = before;
      showToast(COPY.saveFailed, { icon: "wifiOff" });
    }
    paint();
  }

  function switchRow(icon: IconName, title: string, meta: string, on: boolean, toggle: (on: boolean) => void, extra?: HTMLElement): HTMLElement {
    const sw = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": title }) as HTMLInputElement;
    sw.checked = on;
    sw.addEventListener("change", () => toggle(sw.checked));
    const row = h(
      "div",
      { class: "row nudge-row" },
      h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[icon]()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, title), h("span", { class: "row__meta" }, meta)),
      sw
    );
    return extra ? h("div", { class: "nudge-item" }, row, extra) : row;
  }

  function paint() {
    kinds.replaceChildren(
      ...KINDS.map((k) =>
        switchRow(
          k.icon,
          k.title,
          k.meta(prefs, context),
          prefs[k.kind],
          (on) => void save({ [k.kind]: on }),
          k.kind === "evening" && prefs.evening
            ? h("label", { class: "nudge-extra" }, h("span", { class: "nudge-extra__label" }, "Ask at"), timeInput(prefs.evening_at, "Ask at", (v) => void save({ evening_at: v })))
            : k.kind === "morning" && prefs.morning
              ? h("label", { class: "nudge-extra" }, h("span", { class: "nudge-extra__label" }, "Send at"), timeInput(prefs.morning_at, "Morning check-in at", (v) => void save({ morning_at: v })))
              : undefined
        )
      )
    );
    const q = prefs.quiet;
    quiet.replaceChildren(
      switchRow(
        "bed",
        COPY.quietTitle,
        COPY.quietMeta,
        !!q,
        (on) => void save({ quiet: on ? { from: "22:00", to: "07:00" } : null }),
        q
          ? h(
              "div",
              { class: "nudge-extra" },
              h("label", { class: "nudge-extra__pair" }, h("span", { class: "nudge-extra__label" }, COPY.from), timeInput(q.from, "Quiet from", (v) => v !== q.to && void save({ quiet: { from: v, to: q.to } }))),
              h("label", { class: "nudge-extra__pair" }, h("span", { class: "nudge-extra__label" }, COPY.to), timeInput(q.to, "Quiet until", (v) => v !== q.from && void save({ quiet: { from: q.from, to: v } })))
            )
          : undefined
      )
    );
  }

  paint();
  paintAthena();
  void fetchProactive().then(
    (r) => {
      proactive = r.prefs;
      mutes = r.mutes;
      planners = r.planners ?? null;
      paintAthena();
    },
    () => undefined
  );
  if (!isSampleMode())
    void fetchNotificationPrefs().then(
      (p) => {
        prefs = p;
        paint();
      },
      () => undefined
    );
  // The evening line says it opens the reflection while the evening routine is on.
  const readRoutines = () =>
    void loadCheckinSettings().then(
      (c) => {
        context.reflecting = c.evening.enabled;
        paint();
      },
      () => undefined
    );
  readRoutines();
  const offCheckins = onCheckinsChange(readRoutines);
  void card.refresh();
  const onVisible = () => document.visibilityState === "visible" && void card.refresh();
  document.addEventListener("visibilitychange", onVisible);

  return {
    el: h(
      "section",
      { class: "settings__section settings__section--notifications", "aria-labelledby": "settings-notifications" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-notifications" }, icons.bell(), COPY.heading)),
      h("p", { class: "settings__lede" }, COPY.lede),
      h("div", { class: "settings__body nudges" }, card.el, group(COPY.kindsLabel, kinds, h("p", { class: "form__hint" }, COPY.kindsHint)), group(COPY.athenaLabel, athena, h("p", { class: "form__hint" }, COPY.athenaHint)), group(COPY.quietLabel, quiet))
    ),
    destroy: () => {
      document.removeEventListener("visibilitychange", onVisible);
      offCheckins();
    },
  };
}
