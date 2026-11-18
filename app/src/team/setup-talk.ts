/**
 * Team setup's conversation (docs/team.md, "Setup"). After you give the job,
 * the new assistant introduces itself, says what it'll do, asks its questions
 * one at a time and sets out how it'll work. Your answers are your own
 * bubbles; tap one to change it.
 *
 * The transcript is drawn from the draft every time, so a restored draft
 * comes back as it was. Messages it hasn't shown yet arrive in order, each
 * of its own after a short "typing" beat (none with reduced motion).
 */
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { prefersReducedMotion } from "../lib/motion";
import { MAX_ANSWER } from "../../../lib/team-skill";
import type { TeamQuestion } from "../../../lib/team-types";
import type { SetupDraft } from "./setup-draft";
import { allowOption } from "./setup-allow";
import { inVoice, promiseLine, voice } from "./setup-voice";
import { triggerList } from "./trigger-editor";
import { triggerSentence } from "./trigger-editor-words";
import { WEB_TERM_DETAIL, webLabel, WEB_TERM_SETTING_OFF_DETAIL, webTerm, webTermSettingOff } from "./web-words";

const OTHER = "other:";
/** How long it "types" before a line lands. Long enough to read as a beat, short enough not to wait on. */
const TYPING_MS = 560;

export interface TalkHandlers {
  /** Answers, `asked` or `skipped` changed: save, and redraw the foot. */
  onChange: () => void;
  /** Triggers or switches changed: save only (the transcript keeps its place). */
  onTerms: () => void;
  /** "Someone else": a fresh character for the same job. */
  onShuffle: () => void;
  /** "Name and look". */
  onLook: () => void;
  /** Picked up a saved draft: "Start over". */
  onStartOver?: () => void;
  /** A line landed: the character reacts. */
  onSpoke?: (who: "them" | "you") => void;
}

export interface TalkHandle {
  el: HTMLElement;
  /** Draw again from the draft (after a shuffle, an answer, a skip). */
  render: () => void;
  /** Every question asked or skipped: the terms are out. */
  done: () => boolean;
  /** Move focus to what wants an answer now. */
  focus: () => void;
}

interface Msg {
  key: string;
  who: "them" | "you" | "card" | "note";
  el: HTMLElement;
}

export function talk(d: () => SetupDraft, scroller: HTMLElement, on: TalkHandlers, opts: { restored: boolean; webSetting?: () => boolean | null }): TalkHandle {
  const el = h("div", { class: "ts-talk", role: "log", "aria-live": "polite", "aria-relevant": "additions" });
  const shown = new Set<string>();
  let editing: number | null = null;
  let lastSeed: string | null = null;
  // Focus follows the conversation only for someone using the keyboard; a tap or a click leaves it be.
  let keyboard = false;
  el.addEventListener("keydown", () => (keyboard = true), true);
  el.addEventListener("pointerdown", () => (keyboard = false), true);
  let queue: Promise<void> = Promise.resolve();
  // A restored draft comes back already said: nothing types twice.
  let instant = opts.restored;

  const doneAsking = () => {
    const x = d();
    return x.skipped || x.asked >= x.questions.length;
  };

  const said = (who: "them" | "you", text: string, extra?: Node | null, attrs: Record<string, string> = {}) =>
    h("div", { class: `ts-msg ts-msg--${who}`, ...attrs }, h("p", { class: "ts-said" }, text), extra ?? null);

  function answerText(q: TeamQuestion): string | null {
    const raw = d().answers[q.id] ?? "";
    const v = (raw.startsWith(OTHER) ? raw.slice(OTHER.length) : raw).trim();
    return v || null;
  }

  function setAnswer(qi: number, value: string) {
    const x = d();
    const q = x.questions[qi];
    x.answers = { ...x.answers };
    if (value) x.answers[q.id] = value;
    else delete x.answers[q.id];
    if (editing === qi) editing = null;
    else if (qi === x.asked) x.asked = qi + 1;
    on.onChange();
    on.onSpoke?.("you");
    render();
  }

  /** Answers to tap under a question, plus "Something else" for your own words. */
  function replies(q: TeamQuestion, qi: number): HTMLElement {
    const current = d().answers[q.id] ?? "";
    const group = h("div", { class: "ts-replies__chips", role: "radiogroup", "aria-label": q.question });
    const field = h("input", { class: "ts-replies__field", type: "text", maxlength: MAX_ANSWER, placeholder: "Your answer", "aria-label": `${q.question} Your answer`, autocomplete: "off", enterkeyhint: "send" }) as HTMLInputElement;
    const send = h("button", { class: "icon-btn icon-btn--sm ts-replies__send", type: "button", "aria-label": "Send" }, icons.arrowUp());
    const own = h("div", { class: "ts-replies__own", hidden: true }, field, send);
    if (current.startsWith(OTHER)) field.value = current.slice(OTHER.length);
    const values = [...q.choices, ...(q.allowOther ? [OTHER] : [])];
    const chips = values.map((v, i) => {
      const on = v === OTHER ? current.startsWith(OTHER) : v === current;
      const c = h("button", { class: "ts-reply", type: "button", role: "radio", "aria-checked": on ? "true" : "false", tabindex: on || (!current && i === 0) ? 0 : -1 }, v === OTHER ? "Something else" : v) as HTMLButtonElement;
      c.addEventListener("click", () => {
        if (v !== OTHER) return setAnswer(qi, v);
        chips.forEach((x) => x.setAttribute("aria-checked", x === c ? "true" : "false"));
        own.hidden = false;
        field.focus();
      });
      return c;
    });
    group.addEventListener("keydown", (e) => {
      const i = chips.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (i < 0 || !step) return;
      e.preventDefault();
      chips[(i + step + chips.length) % chips.length].focus();
    });
    const submit = () => {
      const v = field.value.trim();
      if (v) setAnswer(qi, `${OTHER}${v}`);
      else field.focus();
    };
    send.addEventListener("click", submit);
    field.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      submit();
    });
    if (current.startsWith(OTHER)) own.hidden = false;
    group.append(...chips);
    return h("div", { class: "ts-replies" }, group, own);
  }

  /** How it'll work: when it starts and what it may do without asking. */
  function terms(): HTMLElement {
    const x = d();
    const whenText = h("p", { class: "ts-term__v" });
    const paintWhen = () => {
      const ts = d().triggers;
      whenText.replaceChildren(...(ts.length ? ts.map((t) => h("span", { class: "ts-term__line" }, triggerSentence(t))) : [h("span", { class: "ts-term__line" }, "Only when you ask")]));
    };
    paintWhen();
    const change = h("button", { class: "btn btn--ghost btn--sm ts-term__edit", type: "button", "aria-expanded": "false" }, "Change");
    const editor = h("div", { class: "ts-term__editor", hidden: true });
    change.addEventListener("click", () => {
      const open = editor.hidden;
      if (open && !editor.firstChild) {
        editor.append(
          triggerList(
            d().triggers,
            (ts) => {
              d().triggers = ts;
              paintWhen();
              promise?.replaceChildren(promiseLine(d().job, ts));
              on.onTerms();
            },
            d().name || "It"
          ).el
        );
      }
      editor.hidden = !open;
      change.textContent = open ? "Done" : "Change";
      change.setAttribute("aria-expanded", String(open));
    });

    const rows = x.offered.map((tool) => {
      const o = allowOption(tool);
      const id = `ts-allow-${tool}`;
      const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": o.detail ? `${id}-d` : undefined }) as HTMLInputElement;
      sw.checked = x.allow.includes(tool);
      sw.addEventListener("change", () => {
        const y = d();
        y.allow = sw.checked ? [...new Set([...y.allow, tool])] : y.allow.filter((t) => t !== tool);
        on.onTerms();
      });
      return h("label", { class: "ts-allow", for: id }, h("span", { class: "ts-allow__text" }, h("span", { class: "ts-allow__label" }, o.label), o.detail ? h("span", { class: "ts-allow__detail", id: `${id}-d` }, o.detail) : null), sw);
    });

    return h(
      "section",
      { class: "ts-terms", tabindex: -1, "aria-label": `How ${x.name || "it"} will work` },
      h("div", { class: "ts-term" }, h("span", { class: "ts-term__icon", "aria-hidden": "true" }, icons.clock()), h("div", { class: "ts-term__body" }, h("p", { class: "ts-term__k" }, "Starts"), whenText), change),
      editor,
      x.webSuggested ? webTermRow() : null,
      rows.length
        ? h("div", { class: "ts-term ts-term--allow" }, h("span", { class: "ts-term__icon", "aria-hidden": "true" }, icons.check()), h("div", { class: "ts-term__body" }, h("p", { class: "ts-term__k" }, "Can do without asking"), h("p", { class: "ts-term__hint" }, "Anything off becomes a plan you approve.")))
        : null,
      rows.length ? h("div", { class: "ts-allows" }, ...rows) : null,
      h("p", { class: "ts-fine" }, "Every change shows up in What Ask did, where you can undo it.")
    );
  }

  /**
   * The draft said the job needs something online: proposed, switched on, in its own words ("I'll check
   * prices online"), and yours to turn off. With "Let Ask search the web" off it says so instead.
   */
  function webTermRow(): HTMLElement {
    const x = d();
    const icon = h("span", { class: "ts-term__icon", "aria-hidden": "true" }, icons.globe());
    if (opts.webSetting?.() === false) {
      return h("div", { class: "ts-term ts-term--web is-blocked" }, icon, h("div", { class: "ts-term__body" }, h("p", { class: "ts-term__k" }, "Online"), h("p", { class: "ts-term__v" }, webTermSettingOff(x.job)), h("p", { class: "ts-term__hint" }, WEB_TERM_SETTING_OFF_DETAIL)));
    }
    const id = "ts-web";
    const line = h("p", { class: "ts-term__v", id: `${id}-v`, "aria-live": "polite" }, webTerm(x.job, x.web));
    const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-label": x.personality ? webLabel(x.personality) : "Can look things up online on its own", "aria-describedby": `${id}-v ${id}-d`, checked: x.web }) as HTMLInputElement;
    const hint = h("p", { class: "ts-term__hint", id: `${id}-d`, hidden: !x.web }, WEB_TERM_DETAIL);
    sw.addEventListener("change", () => {
      const y = d();
      y.web = sw.checked;
      line.textContent = webTerm(y.job, y.web);
      hint.hidden = !y.web;
      on.onTerms();
    });
    return h(
      "label",
      { class: `ts-term ts-term--web${x.web ? " is-on" : ""}`, for: id },
      icon,
      h("div", { class: "ts-term__body" }, h("p", { class: "ts-term__k" }, "Online"), line, hint),
      sw
    );
  }

  let promise: HTMLElement | null = null;

  function messages(): Msg[] {
    const x = d();
    const name = x.name.trim() || "your assistant";
    const out: Msg[] = [];
    if (opts.restored && on.onStartOver) {
      const over = h("button", { class: "ts-note__btn", type: "button" }, "Start over");
      over.addEventListener("click", () => on.onStartOver?.());
      out.push({ key: "note", who: "note", el: h("p", { class: "ts-note" }, "Picked up where you left off. ", over) });
    }
    out.push({ key: "job", who: "you", el: said("you", x.text.trim()) });
    out.push({ key: "intro", who: "them", el: said("them", voice.intro(x.personality, name)) });
    const other = h("button", { class: "ts-move", type: "button" }, icons.dice(), "Someone else");
    const look = h("button", { class: "ts-move", type: "button" }, icons.pen(), "Name and look");
    other.addEventListener("click", on.onShuffle);
    look.addEventListener("click", on.onLook);
    const pm = said("them", promiseLine(x.job, x.triggers), h("div", { class: "ts-moves" }, other, look));
    promise = pm.querySelector(".ts-said");
    out.push({ key: "promise", who: "them", el: pm });

    if (x.questions.length) out.push({ key: "ask", who: "them", el: said("them", voice.ask(x.personality, x.questions.length)) });
    x.questions.forEach((q, qi) => {
      if (qi > x.asked) return;
      const live = qi === x.asked && !x.skipped;
      // Skipped before it asked anything: it never gets to its first question.
      if (x.skipped && qi === x.asked && qi === 0) return;
      const ans = answerText(q);
      const qEl = said("them", inVoice(q.question), live || editing === qi ? replies(q, qi) : null, { "data-q": String(qi) });
      out.push({ key: `q${qi}`, who: "them", el: qEl });
      if (x.skipped && qi === x.asked) return;
      if (!live && editing !== qi) {
        const b = h("button", { class: "ts-said ts-said--btn", type: "button", "aria-label": `${ans ?? "No answer"}. Change your answer to: ${q.question}` }, ans ?? "No answer");
        b.addEventListener("click", () => {
          editing = qi;
          render();
          requestAnimationFrame(() => el.querySelector<HTMLElement>(`[data-q="${qi}"] [role=radio][tabindex="0"]`)?.focus());
        });
        out.push({ key: `a${qi}`, who: "you", el: h("div", { class: `ts-msg ts-msg--you${ans ? "" : " is-quiet"}` }, b) });
      }
    });

    if (x.skipped && x.asked < x.questions.length) out.push({ key: "skip", who: "you", el: said("you", x.asked ? "Let's skip the rest." : "Let's skip the questions.") });
    if (doneAsking()) {
      const answered = x.questions.some((q) => answerText(q));
      const after = !x.questions.length ? voice.ready() : x.skipped && !answered ? voice.skipped(x.personality) : voice.thanks(x.personality);
      out.push({ key: "thanks", who: "them", el: said("them", after) });
      out.push({ key: "terms", who: "them", el: said("them", voice.terms()) });
      out.push({ key: "card", who: "card", el: h("div", { class: "ts-msg ts-msg--card" }, terms()) });
    }
    return out;
  }

  function typing(): HTMLElement {
    return h("div", { class: "ts-msg ts-msg--them ts-typing", "aria-hidden": "true" }, h("p", { class: "ts-said" }, h("span", {}), h("span", {}), h("span", {})));
  }

  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
  const follow = (node: HTMLElement) => {
    // Keep the newest line in view, without yanking you back if you've scrolled up to read.
    requestAnimationFrame(() => node.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" }));
  };

  function render() {
    // Redrawing replaces the elements: if focus was in here, put it back on what wants an answer.
    const hadFocus = keyboard && (el.contains(document.activeElement) || document.activeElement === document.body);
    const list = messages();
    const pending: Msg[] = [];
    for (const m of list) {
      if (shown.has(m.key)) continue;
      if (instant || prefersReducedMotion() || m.who === "note") shown.add(m.key);
      else {
        m.el.classList.add("is-pending");
        pending.push(m);
      }
    }
    // Someone else: the new candidate's hello and promise arrive again, so the change reads.
    const seed = d().seed;
    if (lastSeed !== null && seed !== lastSeed && !prefersReducedMotion()) for (const m of list) if (m.key === "intro" || m.key === "promise") m.el.classList.add("is-new");
    lastSeed = seed;
    el.replaceChildren(...list.map((m) => m.el));
    instant = false;
    if (!pending.length) {
      if (hadFocus) focusNow(true);
      return;
    }
    const wasNear = nearBottom();
    queue = queue.then(async () => {
      for (const m of pending) {
        if (!m.el.isConnected) return;
        if (m.who === "them") {
          const dots = typing();
          m.el.before(dots);
          if (wasNear) follow(dots);
          await new Promise((r) => setTimeout(r, TYPING_MS));
          dots.remove();
          if (!m.el.isConnected) return;
        }
        shown.add(m.key);
        m.el.classList.remove("is-pending");
        m.el.classList.add("is-new");
        if (m.who === "them") on.onSpoke?.("them");
        if (wasNear || m.who === "card") follow(m.el);
      }
      focusNow(hadFocus);
    });
  }

  /** Focus the answers waiting for you (fine pointers only, so a phone's keyboard stays down), or, after a keyboard answer, the terms. */
  function focusNow(keep = false) {
    const chip = el.querySelector<HTMLElement>(".ts-msg:not(.is-pending) .ts-replies [role=radio][tabindex='0']");
    if (chip && (keep || window.matchMedia("(pointer: fine)").matches)) return chip.focus({ preventScroll: true });
    if (keep && !chip) el.querySelector<HTMLElement>(".ts-msg:not(.is-pending) .ts-terms")?.focus({ preventScroll: true });
  }

  render();
  return { el, render, done: doneAsking, focus: focusNow };
}
