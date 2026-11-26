/**
 * The guided setup (lib/setup-guide.ts): what a new owner sees after
 * deploying their own copy and typing the site password, until Athena is
 * ready to use. One card on the aurora, like the Connect screen it replaces
 * for a new owner, that moves through five steps after a welcome:
 *
 *   welcome  what's ahead, or carry on
 *   site     the environment variables Athena runs on, and the data key,
 *            made here and added in Netlify by the owner. Read with the site
 *            session alone (GET /api/setup), before this device has a key
 *   connect  connect this device (the access token). After the site: a
 *            device's key is kept under the data key (lib/api-keys.ts)
 *   about    their name, and the time zone from this device
 *   sources  the first accounts, by what they'd get (Sources' starters)
 *   phone    the Home Screen and notifications
 *   done     what happens next, then Home
 *
 * Progress is kept on the server (POST /api/setup), so it carries on from
 * another device, or after an account's sign-in sends the browser away and
 * back (#/settings/accounts?connected=<id> lands back on Sources here).
 *
 * "fix" is the same card for an owner whose site has lost a required
 * setting: only the site step, then back to the app.
 */

import "../styles/guide.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { brandMark } from "../components/brand-mark";
import { brandLogo } from "../components/brand-logo";
import { mountToastStack, showToast } from "../components/toast";
import { checkHealth, fetchConnectors, isApiKey, isSampleMode, saveTimeZone, signIn, hasToken } from "../db/api";
import { saveProfile } from "../db/profile";
import { rememberName, rememberedName } from "../components/home-personal";
import { deviceZone } from "../lib/time";
import { netlifyPage, type GuideStep, type SetupStatus } from "../../../lib/setup-guide";
import { CONNECTOR_PRESETS, type RecipeId } from "../../../lib/connector-presets";
import { fetchSetup, markGuideDoneHere, putGuideOff, saveGuide } from "./api";
import { dataKeyId, forgetSessionDataKey, sessionDataKey } from "./data-key";
import { COUNTED, STEP_NAMES, stepOf, WORDS } from "./words";
import type { ConnectorsState } from "../types";

export interface GuideOptions {
  status: SetupStatus | null;
  /** Where to start; the saved step otherwise. */
  start?: GuideStep;
  /** Back from an account's sign-in: its id, to offer what to collect from it. */
  connected?: string | null;
  /** Finished (or put off): open the app. */
  onDone: () => void;
}

/** What Sources' first run offers, by what you'd get (components/connector-settings.ts). */
interface Starter {
  recipe: RecipeId;
  title: string;
  line: string;
  category?: string;
}

/** An environment variable's name in a sentence, set as code. */
const ENV_NAME = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/;

/** Sources' starters shown before "More": email, calendar, work and downtime. */
const FIRST_STARTERS = 4;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function renderGuide(opts: GuideOptions): HTMLElement {
  const sample = isSampleMode();
  let status = opts.status;
  const fix = status?.guide.reason === "fix";
  const flow: GuideStep[] = fix ? ["site"] : ["welcome", "site", "connect", "about", "sources", "phone", "done"];
  const saved = status?.guide.step;
  let step: GuideStep = opts.start ?? (fix ? "site" : saved && flow.includes(saved) && (hasToken() || sample) ? saved : "welcome");
  if (!flow.includes(step)) step = flow[0];

  /** What the done step sums up. */
  const facts = { sources: 0, notify: false };
  let stopPolling: (() => void) | null = null;

  const progress = h("ol", { class: "guide__progress", "aria-label": "Setup steps" });
  const kicker = h("p", { class: "guide__kicker" });
  const body = h("div", { class: "guide__body" });
  const actions = h("div", { class: "guide__actions" });
  const card = h(
    "main",
    { class: "guide__card", "aria-labelledby": "guide-title" },
    h("div", { class: "guide__top" }, brandMark(), fix ? null : progress),
    kicker,
    body,
    actions
  );
  const el = h("div", { class: "guide" }, card, mountToastStack());
  if (sample) el.append(h("p", { class: "guide__sample" }, WORDS.samplePreview));

  function paintProgress() {
    progress.replaceChildren(
      ...COUNTED.map((s, i) => {
        const at = COUNTED.indexOf(step as (typeof COUNTED)[number]);
        const state = step === "done" || i < at ? "done" : i === at ? "now" : "next";
        return h("li", { class: `guide__dot guide__dot--${state}`, "aria-current": state === "now" ? "step" : undefined }, h("span", { class: "visually-hidden" }, `${STEP_NAMES[s]}${state === "done" ? ", done" : ""}`));
      })
    );
    kicker.textContent = fix ? "" : stepOf(step);
    kicker.hidden = !kicker.textContent;
  }

  /** Move to a step: the card's content slides in from the side it comes from. */
  function go(next: GuideStep, dir: 1 | -1 = 1) {
    stopPolling?.();
    stopPolling = null;
    step = next;
    if (!sample && hasToken() && next !== "welcome") void saveGuide({ step: next }).catch(() => undefined);
    if (!sample) history.replaceState(history.state, "", `#/welcome`);
    paintProgress();
    body.classList.remove("is-in-next", "is-in-back");
    paintStep();
    if (!reduced()) {
      void body.offsetWidth;
      body.classList.add(dir > 0 ? "is-in-next" : "is-in-back");
    }
    // The new step's heading takes focus, so a screen reader hears where it is.
    body.querySelector<HTMLElement>("#guide-title")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
  }

  const nextOf = (s: GuideStep) => flow[flow.indexOf(s) + 1] ?? null;
  const prevOf = (s: GuideStep) => flow[flow.indexOf(s) - 1] ?? null;

  /** The step's buttons: Back on the left, the main one on the right, and a quieter one beside it. */
  function setActions(main: HTMLButtonElement | null, extra: HTMLElement | null = null, back = true) {
    const prev = prevOf(step);
    const showBack = back && prev && prev !== "welcome";
    const b = showBack ? h("button", { class: "btn btn--ghost guide__back", type: "button" }, icons.back(), WORDS.back) : null;
    b?.addEventListener("click", () => go(prev!, -1));
    const buttons = [b, extra, main].filter((x): x is HTMLElement => !!x);
    actions.replaceChildren(...(buttons.length ? [b, h("span", { class: "guide__spacer" }), extra, main].filter((x): x is HTMLElement => !!x) : []));
    actions.hidden = !buttons.length;
  }

  const title = (text: string) => h("h1", { class: "guide__title", id: "guide-title", tabindex: "-1" }, text);
  const lede = (text: string) => h("p", { class: "guide__lede" }, text);
  const primary = (label: string, run: () => void | Promise<void>) => {
    const b = h("button", { class: "btn btn--primary guide__main", type: "button" }, label, icons.arrowRight()) as HTMLButtonElement;
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
  const quiet = (label: string, run: () => void) => {
    const b = h("button", { class: "btn btn--ghost", type: "button" }, label);
    b.addEventListener("click", run);
    return b;
  };

  function paintStep() {
    if (step === "welcome") return welcomeStep();
    if (step === "site") return siteStep();
    if (step === "connect") return connectStep();
    if (step === "about") return aboutStep();
    if (step === "sources") return sourcesStep();
    if (step === "phone") return phoneStep();
    return doneStep();
  }

  // ---------- Welcome: what's ahead ----------

  function welcomeStep() {
    const plan = h(
      "ol",
      { class: "guide__plan" },
      ...WORDS.welcome.plan.map(([name, line], i) => h("li", { class: "guide__plan-item" }, h("span", { class: "guide__plan-n", "aria-hidden": "true" }, String(i + 1)), h("span", {}, h("span", { class: "guide__plan-name" }, name), h("span", { class: "guide__plan-line" }, line))))
    );
    const resume = hasToken() && !sample && saved && saved !== "welcome" ? saved : null;
    body.replaceChildren(title(WORDS.welcome.title), lede(resume ? WORDS.welcome.resumeLede : WORDS.welcome.lede), plan);
    setActions(primary(resume ? WORDS.welcome.resume : WORDS.welcome.start, () => go(resume ?? "site")), null, false);
  }

  // ---------- Connect: this device's key ----------

  function connectStep() {
    const onward = () => go(nextOf("connect")!);
    const tokenPreview = sample && new URLSearchParams(location.hash.split("?")[1] ?? "").get("token") === "1";
    if ((hasToken() || sample) && !tokenPreview) {
      body.replaceChildren(title(WORDS.connect.title), lede(WORDS.connect.connectedLede));
      setActions(primary(WORDS.next, onward));
      return;
    }
    const input = h("input", {
      class: "field",
      type: "password",
      id: "guide-token",
      name: "athena-token",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      placeholder: WORDS.connect.tokenPlaceholder,
      "aria-describedby": "guide-token-help",
    }) as HTMLInputElement;
    const error = h("p", { class: "connect__error", role: "alert" });
    const help = h("p", { class: "connect__help", id: "guide-token-help" }, WORDS.connect.tokenHelpLead, h("code", {}, "MCP_BEARER_TOKEN"), WORDS.connect.tokenHelpTail);
    const submit = h("button", { class: "btn btn--primary btn--block", type: "submit" }, WORDS.connect.submit) as HTMLButtonElement;
    const form = h("form", { class: "connect__form guide__token" }, h("label", { class: "field-label", for: "guide-token" }, WORDS.connect.tokenLabel), input, help, error, submit);
    const again = (message: string) => {
      error.textContent = message;
      submit.disabled = false;
      submit.textContent = WORDS.connect.submit;
      input.focus();
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = input.value.trim();
      if (tokenPreview) return onward();
      if (!token) return again(WORDS.connect.empty);
      submit.disabled = true;
      submit.textContent = WORDS.connect.connecting;
      error.textContent = "";
      // A device's key is kept under the data key, so the server says so here if it isn't set yet (lib/api-keys.ts).
      const result = await signIn(token);
      if (!result.ok) return again(result.reason === "refused" ? WORDS.connect.refused : result.reason === "unreachable" ? WORDS.connect.unreachable : result.message || WORDS.connect.unreachable);
      input.value = "";
      if (isApiKey(token) && !(await checkHealth())) return again(WORDS.connect.unreachable);
      // Connected: the full status, and on to where the owner left off (from another device), else the next step.
      status = (await fetchSetup()) ?? status;
      const at = status?.guide.step;
      const later = at && flow.indexOf(at) > flow.indexOf("connect") ? at : null;
      if (later) go(later);
      else onward();
    });
    body.replaceChildren(title(WORDS.connect.title), lede(WORDS.connect.lede), form, h("p", { class: "connect__foot" }, WORDS.connect.foot));
    setActions(null);
  }

  // ---------- Site: the environment variables ----------

  function siteStep() {
    const list = h("ul", { class: "guide__checks" });
    const keyBox = h("div", { class: "guide__key-wrap" });
    const allSet = h("p", { class: "guide__ok", hidden: true }, icons.check(), WORDS.site.allSet);
    const later = fix && !sample ? quiet(WORDS.later, () => {
      putGuideOff();
      opts.onDone();
    }) : null;
    const next = primary(fix ? WORDS.site.fixDone : WORDS.next, () => (fix ? finish() : go(nextOf("site")!)));
    body.replaceChildren(title(fix ? WORDS.site.fixTitle : WORDS.site.title), lede(fix ? WORDS.site.fixLede : WORDS.site.lede), list, allSet, keyBox);
    setActions(next, later);

    const row = (tone: "good" | "bad" | "warn", name: string, line: string, mono = false) =>
      h(
        "li",
        { class: `guide__check guide__check--${tone}` },
        h("span", { class: "guide__check-mark", "aria-hidden": "true" }, tone === "good" ? icons.check() : tone === "warn" ? icons.clock() : icons.minus()),
        h("span", { class: "guide__check-body" }, h("span", { class: `guide__check-name${mono ? " guide__check-name--mono" : ""}` }, name), h("span", { class: "guide__check-line" }, line))
      );

    let keyShown = false;
    function paint() {
      if (!status) {
        list.replaceChildren(h("li", { class: "guide__check guide__check--warn" }, h("span", { class: "guide__check-body" }, h("span", { class: "guide__check-line" }, WORDS.site.offline))));
        const again = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.refresh(), WORDS.site.checkAgain);
        again.addEventListener("click", () => void recheck());
        keyBox.replaceChildren(again);
        next.disabled = true;
        return;
      }
      const c = status.checks;
      list.replaceChildren(
        row(c.database ? "good" : "bad", WORDS.site.database.name, c.database ? WORDS.site.database.ok : WORDS.site.database.bad),
        row(c.connector_key ? "good" : "bad", WORDS.site.connectorKey.name, c.connector_key ? WORDS.site.connectorKey.ok : WORDS.site.connectorKey.bad, true),
        row(c.data_key === "set" ? "good" : "bad", WORDS.site.dataKey.name, c.data_key === "set" ? WORDS.site.dataKey.ok : c.data_key === "invalid" ? WORDS.site.dataKey.invalid : WORDS.site.dataKey.bad, true),
        row(c.ai ? "good" : "warn", WORDS.site.ai.name, c.ai ? WORDS.site.ai.ok : WORDS.site.ai.bad)
      );
      next.disabled = !status.ready;
      allSet.hidden = !status.ready || keyShown;
      if (c.data_key !== "set") {
        keyShown = true;
        if (!keyBox.childElementCount) keyBox.replaceChildren(dataKeyPanel());
      } else if (keyShown) {
        void keySetNote().then((n) => keyBox.replaceChildren(n));
        forgetSessionDataKey();
      } else if (!c.connector_key || !c.database) {
        const again = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.refresh(), WORDS.site.checkAgain);
        again.addEventListener("click", () => void recheck());
        keyBox.replaceChildren(again);
      } else {
        keyBox.replaceChildren();
      }
    }

    async function recheck() {
      if (sample) {
        // The preview's deploy lands at once, with the key shown here.
        if (status && status.checks.data_key !== "set") {
          status = { ...status, checks: { ...status.checks, data_key: "set" }, ready: status.checks.database && status.checks.connector_key, data_key_id: await dataKeyId(sessionDataKey()) };
        }
        if (step === "site") paint();
        return;
      }
      const s = await fetchSetup();
      if (s) status = s;
      if (step === "site") paint();
    }

    /** Once the key is in: whether it's the one shown here. */
    async function keySetNote(): Promise<HTMLElement> {
      let same: boolean | null = null;
      try {
        const id = status?.data_key_id;
        if (id) same = (await dataKeyId(sessionDataKey())) === id;
      } catch {
        same = null;
      }
      return h(
        "div",
        { class: "guide__panel guide__panel--good", role: "status" },
        h("p", { class: "guide__panel-title" }, icons.shield(), WORDS.key.set),
        same === null ? null : h("p", { class: "guide__panel-line" }, same ? WORDS.key.matches : WORDS.key.differs)
      );
    }

    function dataKeyPanel(): HTMLElement {
      const key = sessionDataKey();
      const keyText = h("code", { class: "guide__key", id: "guide-key" }, key);
      const copy = h("button", { class: "btn btn--soft btn--sm guide__copy", type: "button", "aria-describedby": "guide-key" }, icons.copy(), WORDS.key.copy) as HTMLButtonElement;
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(key);
          copy.replaceChildren(icons.check(), WORDS.key.copied);
          setTimeout(() => copy.replaceChildren(icons.copy(), WORDS.key.copy), 2400);
        } catch {
          // No clipboard (an older browser, or not allowed): select it so it can be copied by hand.
          const range = document.createRange();
          range.selectNodeContents(keyText);
          const sel = getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      });
      const tick = h("input", { type: "checkbox", id: "guide-saved", class: "guide__tick" }) as HTMLInputElement;
      const site = status?.site_name ?? null;
      const stepsList = h(
        "ol",
        { class: "guide__steps" },
        ...WORDS.key.steps.map(([line, link], i) =>
          h(
            "li",
            { class: "guide__step" },
            h("span", {}, ...line.split(ENV_NAME).map((part, j) => (j % 2 ? h("code", {}, part) : part))),
            link ? h("a", { class: "btn btn--soft btn--sm guide__out", href: netlifyPage(site, i === 0 ? "env" : "deploys"), target: "_blank", rel: "noopener noreferrer" }, link, icons.external()) : null
          )
        )
      );
      const wait = h("div", { class: "guide__wait", role: "status", hidden: true });
      const done = h("button", { class: "btn btn--primary btn--block", type: "button" }, WORDS.key.done) as HTMLButtonElement;
      const howTo = h("div", { class: "guide__how", hidden: true }, h("p", { class: "guide__panel-title" }, WORDS.key.stepsTitle), stepsList, done, wait);
      tick.addEventListener("change", () => {
        howTo.hidden = !tick.checked;
        if (tick.checked && !reduced()) howTo.classList.add("is-in");
      });
      done.addEventListener("click", () => {
        done.hidden = true;
        wait.hidden = false;
        const now = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, WORDS.key.checkNow);
        now.addEventListener("click", () => void recheck());
        wait.replaceChildren(h("span", { class: "guide__spinner", "aria-hidden": "true" }), h("span", { class: "guide__wait-text" }, WORDS.key.waiting), now);
        const timer = setInterval(() => void recheck(), 8000);
        stopPolling = () => clearInterval(timer);
      });
      return h(
        "section",
        { class: "guide__panel", "aria-labelledby": "guide-key-title" },
        h("h2", { class: "guide__panel-head", id: "guide-key-title" }, icons.key(), WORDS.key.title),
        h("p", { class: "guide__panel-line" }, WORDS.key.why),
        h("p", { class: "guide__panel-line guide__panel-line--warn" }, WORDS.key.warn),
        h("div", { class: "guide__key-row" }, h("span", { class: "visually-hidden" }, WORDS.key.label), keyText, copy),
        h("p", { class: "guide__fine" }, WORDS.key.madeHere),
        h("label", { class: "guide__saved", for: "guide-saved" }, tick, h("span", {}, WORDS.key.saved)),
        howTo
      );
    }

    if (!status && !sample) {
      list.replaceChildren(h("li", { class: "guide__check" }, h("span", { class: "guide__check-body" }, h("span", { class: "guide__check-line" }, WORDS.site.checking))));
      next.disabled = true;
      void recheck();
    } else {
      paint();
    }
  }

  // ---------- About: the name ----------

  function aboutStep() {
    const input = h("input", { class: "field", id: "guide-name", type: "text", autocomplete: "given-name", maxlength: "40", placeholder: WORDS.about.placeholder, enterkeyhint: "done", value: sample ? "" : rememberedName() ?? "" }) as HTMLInputElement;
    const zone = deviceZone();
    const error = h("p", { class: "connect__error", role: "alert" });
    const save = async () => {
      const name = input.value.replace(/\s+/g, " ").trim().slice(0, 40);
      error.textContent = "";
      if (!sample) {
        try {
          if (name) {
            await saveProfile([{ key: "Name", value: name }]);
            rememberName(name);
          }
          await saveTimeZone(zone);
          try {
            localStorage.setItem("athena.tz", zone);
          } catch {
            // it's sent again next launch
          }
        } catch {
          error.textContent = WORDS.about.saveFailed;
          return;
        }
      }
      go(nextOf("about")!);
    };
    const form = h("form", { class: "connect__form" }, h("label", { class: "field-label", for: "guide-name" }, WORDS.about.label), input, error);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void save();
    });
    body.replaceChildren(title(WORDS.about.title), lede(WORDS.about.lede), form, h("p", { class: "guide__fine guide__zone" }, icons.clock(), WORDS.about.zone(zone.replace(/_/g, " "))));
    setActions(primary(WORDS.next, save), quiet(WORDS.skip, () => go(nextOf("about")!)));
    setTimeout(() => input.focus({ preventScroll: true }), reduced() ? 0 : 320);
  }

  // ---------- Sources: the first accounts ----------

  function sourcesStep() {
    const connected = h("div", { class: "guide__connected", hidden: true });
    const grid = h("div", { class: "guide__starters" });
    const browse = h("button", { class: "src-browse guide__browse", type: "button" }, WORDS.sources.browse);
    const onward = () => go(nextOf("sources")!);
    let showAll = false;
    const more = h("button", { class: "src-browse guide__more", type: "button", "aria-expanded": "false" });
    more.addEventListener("click", () => {
      showAll = !showAll;
      paint();
    });

    body.replaceChildren(
      title(WORDS.sources.title),
      lede(WORDS.sources.lede),
      connected,
      h("p", { class: "guide__label" }, WORDS.sources.pickLabel),
      grid,
      h("div", { class: "guide__links" }, more, browse),
      h("p", { class: "guide__fine" }, WORDS.sources.google),
      h("p", { class: "guide__fine guide__shield" }, icons.shield(), WORDS.sources.shield),
      ...(sample ? [h("p", { class: "guide__panel guide__panel-line" }, WORDS.sources.sample)] : [])
    );
    setActions(primary(WORDS.skip, onward));

    let state: ConnectorsState | null = null;
    let starters: Starter[] = [];
    let forms: typeof import("../components/connector-forms") | null = null;

    const add = (recipe?: RecipeId, category?: string) => {
      if (sample || !state || !forms) return showToast(WORDS.sources.sample, { icon: "plug" });
      forms.openAddAccount(state, () => void load(), { recipe, category, easyFirst: true });
    };
    browse.addEventListener("click", () => add());

    function paint() {
      const shown = showAll ? starters : starters.slice(0, FIRST_STARTERS);
      more.hidden = starters.length <= FIRST_STARTERS;
      more.textContent = showAll ? WORDS.sources.fewer : WORDS.sources.more(starters.length - FIRST_STARTERS);
      more.setAttribute("aria-expanded", String(showAll));
      grid.replaceChildren(
        ...shown.map((st) => {
          const logos = CONNECTOR_PRESETS.filter((p) => p.id !== "custom" && p.recipes.includes(st.recipe) && (st.category ? p.category === st.category : p.category !== "health" && p.category !== "travel"))
.slice(0, 3);
          const b = h(
            "button",
            { class: "card src-starter guide__starter", type: "button", "aria-label": `${st.title}: ${st.line}` },
            h("span", { class: "src-starter__body" }, h("span", { class: "src-starter__title" }, st.title), h("span", { class: "src-starter__line" }, st.line), h("span", { class: "src-starter__logos", "aria-hidden": "true" }, ...logos.map((p) => brandLogo(p.id, "sm")))),
            h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight())
          );
          b.addEventListener("click", () => add(st.recipe, st.category));
          return b;
        })
      );
      const accounts = state?.connectors ?? [];
      facts.sources = accounts.length;
      connected.hidden = !accounts.length;
      connected.replaceChildren(
        h("p", { class: "guide__label" }, WORDS.sources.connectedLabel),
        h(
          "div",
          { class: "card card--flush list guide__accounts" },
          ...accounts.map((c) => {
            const collecting = state!.collections.some((col) => col.connector_ids.includes(c.id) && (col.enabled || col.schedule === "manual"));
            return h(
              "div",
              { class: "row" },
              brandLogo(c.provider, "md"),
              h("span", { class: "row__body" }, h("span", { class: "row__title" }, c.name), h("span", { class: "row__meta" }, collecting ? WORDS.sources.collecting : WORDS.sources.notCollecting)),
              h("span", { class: "guide__tickmark", "aria-hidden": "true" }, icons.check())
            );
          })
        )
      );
      // Nothing connected yet: the way on is skipping, said as such.
      setActions(primary(accounts.length ? WORDS.next : WORDS.skip, onward));
    }

    async function load() {
      const settings = await import("../components/connector-settings");
      starters = settings.SOURCE_STARTERS;
      if (sample) return paint();
      try {
        [state, forms] = await Promise.all([fetchConnectors(), import("../components/connector-forms")]);
      } catch {
        showToast(WORDS.sources.loadFailed, { icon: "wifiOff", timeoutMs: 5000 });
      }
      if (step !== "sources") return;
      paint();
      // Back from a sign-in: what to collect from it, as Sources would offer.
      const id = opts.connected;
      if (id && state?.connectors.some((c) => c.id === id)) {
        opts.connected = null;
        const m = await import("../components/account-connected");
        m.openConnected(state, id, { reload: () => load() });
      }
    }
    void load();
  }

  // ---------- Phone: the Home Screen and notifications ----------

  function phoneStep() {
    const parts: HTMLElement[] = [title(WORDS.phone.title), lede(WORDS.phone.lede)];
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const phoneish = ios || /Android/.test(navigator.userAgent);
    const installed = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const panel = (icon: HTMLElement | SVGElement, head: string, line: string, ...more: Array<HTMLElement | null>) =>
      h("section", { class: "guide__panel" }, h("p", { class: "guide__panel-title" }, icon, head), h("p", { class: "guide__panel-line" }, line), ...more.filter((x): x is HTMLElement => !!x));

    if (installed) {
      parts.push(panel(icons.check(), WORDS.phone.installedTitle, WORDS.phone.installed));
    } else if (ios) {
      parts.push(panel(icons.phone(), WORDS.phone.iosTitle, WORDS.phone.ios));
    } else {
      if (!phoneish) {
        const site = location.host;
        const copy = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.link(), WORDS.phone.copyLink);
        copy.addEventListener("click", () => void navigator.clipboard?.writeText(location.origin).then(() => showToast(WORDS.key.copied, { icon: "check" })).catch(() => undefined));
        parts.push(panel(icons.phone(), WORDS.phone.elsewhereTitle, WORDS.phone.elsewhere(site), copy));
      }
      if (installPrompt) {
        const install = h("button", { class: "btn btn--soft btn--sm", type: "button" }, WORDS.phone.installButton);
        install.addEventListener("click", async () => {
          const p = installPrompt;
          installPrompt = null;
          await p?.prompt();
          install.remove();
        });
        parts.push(panel(icons.laptop(), WORDS.phone.installTitle, WORDS.phone.install, install));
      }
    }
    const notify = h("div", { class: "guide__notify" }, h("p", { class: "guide__label" }, WORDS.phone.notifyTitle));
    parts.push(notify);
    body.replaceChildren(...parts);
    void import("../components/notification-settings").then((m) => {
      if (step !== "phone") return;
      const push = m.pushCard({ onChange: (on) => (facts.notify = on) });
      notify.append(push.el);
      void push.refresh();
    });
    setActions(primary(WORDS.next, () => go(nextOf("phone")!)));
  }

  // ---------- Done: what happens next ----------

  function doneStep() {
    const sum = WORDS.done.summary;
    const chips = [
      sum.device,
      status?.checks.data_key === "set" || sample ? sum.key : null,
      facts.sources ? sum.sources(facts.sources) : sum.noSources,
      facts.notify ? sum.notify : null,
    ].filter((x): x is string => !!x);
    body.replaceChildren(
      title(WORDS.done.title),
      h("ul", { class: "guide__summary", "aria-label": "Set up" }, ...chips.map((c) => h("li", { class: `guide__chip${c === sum.noSources ? " guide__chip--quiet" : ""}` }, c === sum.noSources ? null : icons.check(), c))),
      h("p", { class: "guide__label" }, WORDS.done.lede),
      h("ol", { class: "guide__next" }, ...WORDS.done.next(facts.sources).map(([when, what]) => h("li", { class: "guide__next-item" }, h("span", { class: "guide__next-when" }, when), h("span", { class: "guide__next-what" }, what))))
    );
    setActions(primary(WORDS.done.open, finish), null, false);
    // How many sources, if the owner skipped straight here.
    if (!sample && !facts.sources) {
      void fetchConnectors()
        .then((s) => {
          if (step === "done" && s.connectors.length) {
            facts.sources = s.connectors.length;
            doneStep();
          }
        })
        .catch(() => undefined);
    }
  }

  async function finish() {
    stopPolling?.();
    if (!sample) {
      await saveGuide({ step: "done", complete: true }).catch(() => undefined);
      markGuideDoneHere();
    }
    opts.onDone();
  }

  paintProgress();
  paintStep();
  if (!sample) history.replaceState(history.state, "", `#/welcome`);
  return el;
}

// ---------- Installing as an app (Chrome, Edge) ----------

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
}
let installPrompt: InstallPrompt | null = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e as InstallPrompt;
});
