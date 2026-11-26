/**
 * Team setup, #/team/new.
 * Hiring an assistant, as a conversation. A full-screen sheet on phones and a
 * centred 560px panel on desktop, with the character pinned at the top:
 *
 *   1. The job        one sentence (or an idea to start from) → draftAssistant() and teamQuestions()
 *   2. The talk       it arrives, says hello and what it'll do, asks its questions
 *                     one at a time, then sets out how it'll work: when it starts
 *                     and what it may do alone (setup-talk.ts). "Add <Name> to your team".
 *      Name and look  from the talk: rename it, dress it (the wardrobe), and choose
 *                     what "Someone else" keeps.
 *   3. First day      it joins and gets going: its skill being written, when it
 *                     starts, and a first run you can watch (setup-first-day.ts).
 *
 * The answers go with the new assistant: the server writes its skill from
 * them.
 *
 * The draft lives on the device (setup-draft.ts) until the assistant is
 * added. Enter moves on; ⌘/Ctrl+Enter adds. Esc or a drag down closes,
 * keeping the draft; Esc in Name and look goes back to the talk.
 */
import { communityHash } from "../community/words";
import "../styles/team-setup.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openSheet, type SheetHandle } from "../components/sheet";
import { prefersReducedMotion } from "../lib/motion";
import { openAsk } from "../lib/open-ask";
import { createAssistant, draftAssistant, teamQuestions, type TeamAssistant } from "../db/team";
import { answersFor } from "./setup-questions";
import { MAX_ASSISTANTS, MAX_NAME, type AvatarSpec } from "../../../lib/team-types";
import { avatarFromSeed, nameFromSeed, newSeed, personalityFromSeed, renderAvatarTile, setAvatarMood, shuffleSpec, updateAvatar, wardrobe, type AvatarMood } from "./avatar";
import { allowFor } from "./setup-allow";
import { jobFromText, triggersFromText } from "./setup-guess";
import { clearSetup, emptyDraft, hasProgress, loadSetup, saveSetup, type SetupDraft, type SetupLock } from "./setup-draft";
import { talk, type TalkHandle } from "./setup-talk";
import { firstDay } from "./setup-first-day";
import { askWebOn, draftWantsWeb, rememberWebHint, type WebInput } from "./web-access";

export const EXAMPLES = ["When a Linear issue is assigned to me, add a to-do", "When I save a gift idea, find a good price", "Every Friday at 5, sum up my week"];

/** What "Someone else" can keep, in the order Name and look shows them. */
const LOCKS: ReadonlyArray<{ part: SetupLock; label: string }> = [
  { part: "name", label: "Name" },
  { part: "personality", label: "Personality" },
  { part: "look", label: "Look" },
];

const TONE_WORD: Record<string, string> = { warm: "Warm", crisp: "Crisp", playful: "Playful", calm: "Calm", wry: "Wry" };
/** Long enough that each line of the wait can be read; the real draft usually takes longer. */
const THINK_MIN_MS = 1500;
/** What it's doing while the draft and the questions come back. Each is true of the two calls in flight. */
const THINKING = ["Reading the job…", "Working out when to start…", "Thinking of questions to ask…"];
const THINK_STEP_MS = 1100;
/** The character everyone meets before a job gives it a face. */
const SILHOUETTE: AvatarSpec = { v: 1, seed: "athena-new-assistant", species: "bear", fur: "cream", accent: "peach", eyes: "round", mouth: "small-smile", outfit: "tee", outfitColor: "oat", accessories: [] };

const finePointer = () => window.matchMedia("(pointer: fine)").matches;
/** Key hints only where there are keys to press: a mouse or trackpad, no touch screen, and the room of a wide sheet (styles/team-setup.css hides them too). */
const keysHint = () => window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 640px)").matches;
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SetupOptions {
  /** Names already on the team, so a fresh one doesn't repeat them. */
  taken: string[];
  /** How many assistants there are now. */
  count: number;
  /** A sentence to start from (an example chip on the empty Team page). */
  text?: string;
  onAdded: (a: TeamAssistant) => void;
  onClose: () => void;
  /** "Or add one someone shared": setup closes, then the Add screen opens (app/src/add/). */
  onImport?: () => void;
}

type Scene = "job" | "talk" | "look" | "day";

/** The hiring stage's character in its tile; before it has a look, the tile is plain. */
function silhouetteTile(spec: AvatarSpec, size: number, animate: boolean): HTMLElement {
  const t = renderAvatarTile(spec, { size, animate });
  t.classList.add("ts-disc");
  if (spec === SILHOUETTE) t.style.setProperty("--kit-tint", "var(--sunken)");
  return t;
}

export function openSetup(opts: SetupOptions): SheetHandle {
  let d: SetupDraft = opts.text ? emptyDraft(opts.text) : (loadSetup() ?? emptyDraft());
  const restored = !opts.text && hasProgress(d);
  let scene: Scene = d.step === 1 ? "talk" : "job";
  let busy = false;
  let added: TeamAssistant | null = null;
  let thinkTimer = 0;
  let moodTimer = 0;
  const persist = () => {
    if (!added) saveSetup({ ...d, step: scene === "job" ? 0 : 1 });
  };

  // ---------- the pinned character ----------
  // The kit's tile, drawn at the first day's size; team-setup.css sizes it per scene (--disc).
  const disc = silhouetteTile(d.avatar ?? SILHOUETTE, 136, true);
  const svg = disc.firstElementChild as SVGSVGElement;
  const nameEl = h("span", { class: "ts-plate__name" });
  const statusEl = h("span", { class: "ts-plate__status", "aria-live": "polite" });
  const plate = h("button", { class: "ts-plate", type: "button", disabled: true }, nameEl, statusEl);
  const bubble = h("p", { class: "ts-bubble", "aria-live": "polite" });
  const figure = h("div", { class: "ts-figure" }, disc, plate);
  const stage = h("div", { class: "ts-stage" }, figure, bubble);
  plate.addEventListener("click", () => scene === "talk" && show("look"));

  const mood = (m: AvatarMood, ms = 0) => {
    clearTimeout(moodTimer);
    setAvatarMood(svg, m);
    if (ms) moodTimer = window.setTimeout(() => setAvatarMood(svg, "idle"), ms);
  };

  function paintCharacter() {
    const has = !!d.avatar;
    stage.classList.toggle("is-silhouette", !has);
    if (has) updateAvatar(disc, d.avatar!);
    else disc.style.setProperty("--kit-tint", "var(--sunken)");
    const name = d.name.trim();
    nameEl.textContent = has ? name || "Your assistant" : "Your new assistant";
    plate.disabled = !(has && scene === "talk");
    plate.setAttribute("aria-label", has && scene === "talk" ? `${name || "Your assistant"}. Change name and look` : "");
    if (!plate.getAttribute("aria-label")) plate.removeAttribute("aria-label");
    if (busy) return;
    statusEl.textContent =
      scene === "day" && added ? "Joined today" : has && scene !== "job" ? d.job : scene === "job" && d.text.trim() ? "Listening…" : has ? "Waiting for a new job" : "Waiting for a job";
  }

  /** It arrives: settles in (scale from 0.92 and fade, 320ms, exponential ease-out) and looks pleased. */
  function settle() {
    svg.classList.remove("kit-enter");
    void svg.getBoundingClientRect();
    svg.classList.add("kit-enter");
    mood("happy", 1400);
  }

  // ---------- the scenes ----------
  const view = h("div", { class: "ts-view" });
  const primary = h("button", { class: "btn btn--primary ts-primary", type: "button" });
  const startOver = h("button", { class: "btn btn--ghost btn--sm ts-over", type: "button", hidden: true }, "Start over");
  const skip = h("button", { class: "btn btn--soft ts-skip", type: "button", hidden: true }, "Skip the questions");
  const hint = h("span", { class: "ts-hint", "aria-hidden": "true" });
  const foot = h("div", { class: "ts-foot" }, startOver, skip, hint, primary);
  const error = h("p", { class: "ts-error", role: "alert", hidden: true });
  const root = h("div", { class: "ts" }, stage, view, error, foot);
  /** More below the fold: the foot gets a hairline, so the hidden rows read as scrollable. */
  const raise = () => requestAnimationFrame(() => foot.classList.toggle("is-raised", view.scrollHeight - view.scrollTop - view.clientHeight > 4));
  // Scrolled down, the character steps back to a badge; back near the top, it returns. The gap stops it flickering.
  view.addEventListener(
    "scroll",
    () => {
      // The talk docks its character once instead (dock), so the transcript never resizes under you.
      if (scene === "talk") return raise();
      if (view.scrollTop > 24) stage.classList.add("is-compact");
      else if (view.scrollTop < 2) stage.classList.remove("is-compact");
      raise();
    },
    { passive: true }
  );

  /** Once the talk outgrows the screen, the character docks into a small header, like a chat's, and stays there. */
  const dock = () =>
    requestAnimationFrame(() => {
      if (scene === "talk" && view.scrollHeight > view.clientHeight + 8) stage.classList.add("is-docked");
    });

  const showError = (msg: string | null) => {
    error.hidden = !msg;
    error.textContent = msg ?? "";
  };

  interface Built {
    el: HTMLElement;
    focus: () => void;
  }

  const heading = (text: string, lede?: string) => {
    const h2 = h("h2", { class: "ts-q", tabindex: -1 }, text);
    return { h2, nodes: [h2, lede ? h("p", { class: "ts-lede" }, lede) : null] };
  };

  let field: HTMLTextAreaElement | null = null;

  function jobScene(): Built {
    const { h2, nodes } = heading("What's the job?", "Describe it in a sentence. You can change it later.");
    const f = h("textarea", { class: "ts-ask", rows: 3, maxlength: 400, placeholder: "Every Monday at 9, tell me what's due this week", "aria-label": "What's the job?", enterkeyhint: "next" }, d.text) as HTMLTextAreaElement;
    field = f;
    const fit = () => {
      f.style.height = "auto";
      f.style.height = `${Math.min(f.scrollHeight + 2, 220)}px`;
    };
    const chips = EXAMPLES.map((ex) => {
      const c = h("button", { class: "ts-example", type: "button", "aria-pressed": "false" }, ex);
      c.addEventListener("click", () => {
        f.value = ex;
        f.dispatchEvent(new Event("input"));
        if (finePointer()) {
          f.focus();
          f.setSelectionRange(ex.length, ex.length);
        }
      });
      return c;
    });
    const pressChips = () => chips.forEach((c, i) => c.setAttribute("aria-pressed", f.value.trim() === EXAMPLES[i] ? "true" : "false"));
    f.addEventListener("input", () => {
      d.text = f.value;
      persist();
      paintCharacter();
      pressChips();
      syncFoot();
      fit();
    });
    pressChips();
    const shared = opts.onImport ? h("button", { class: "link-btn ts-shared", type: "button" }, "Or add one someone shared") : null;
    shared?.addEventListener("click", () => {
      sheet.close();
      window.setTimeout(() => opts.onImport?.(), 450);
    });
    // Community (app/src/community/page.ts): assistants other people shared, reviewed.
    const browse = h("button", { class: "link-btn ts-shared", type: "button" }, "Or browse Community");
    browse.addEventListener("click", () => {
      sheet.close();
      window.setTimeout(() => (location.hash = communityHash("assistant")), 450);
    });
    const el = h("section", { class: "ts-step" }, ...nodes, f, h("p", { class: "ts-label" }, "Or start from one of these"), h("div", { class: "ts-examples" }, ...chips), shared, browse);
    requestAnimationFrame(fit);
    return { el, focus: () => (finePointer() ? f.focus() : h2.focus()) };
  }

  let conversation: TalkHandle | null = null;
  // "Let Ask search the web": the terms say so when it's off, rather than offer a switch that can't do anything.
  let webSetting: boolean | null = null;
  void askWebOn(true).then((on) => {
    webSetting = on;
    if (d.webSuggested) conversation?.render();
  });
  let conversationFrom: string | null = null;

  function talkScene(): Built {
    // One conversation per draft: coming back from Name and look, or from an unchanged job, doesn't replay it.
    if (!conversation || conversationFrom !== d.draftedFrom) {
      conversation = talk(() => d, view, {
        onChange: () => {
          persist();
          syncFoot();
        },
        onTerms: persist,
        onShuffle: someoneElse,
        onLook: () => show("look"),
        onStartOver: restored ? () => startAgain() : undefined,
        onSpoke: (who) => {
          if (who === "you") mood("happy", 900);
          dock();
        },
      }, { restored: restored && conversation === null && d.step === 1, webSetting: () => webSetting });
      conversationFrom = d.draftedFrom;
    } else conversation.render();
    const el = h("section", { class: "ts-step ts-step--talk" }, conversation.el);
    return { el, focus: () => conversation?.focus() };
  }

  function lookScene(): Built {
    const name = h("input", { class: "ts-name", type: "text", value: d.name, maxlength: MAX_NAME, "aria-label": "Name", autocomplete: "off", spellcheck: "false", enterkeyhint: "done" }) as HTMLInputElement;
    const tone = h("p", { class: "ts-tone" }, d.personality ? [TONE_WORD[d.personality.tone] ?? d.personality.tone, ...d.personality.traits].join(" · ") : "");
    name.addEventListener("input", () => {
      d.name = name.value;
      if (!d.locks.includes("name")) {
        d.locks = [...d.locks, "name"];
        syncLocks();
      }
      persist();
      paintCharacter();
      syncFoot();
    });
    const lockBtns = LOCKS.map(({ part, label }) => {
      const b = h("button", { class: "ts-lock", type: "button", "aria-pressed": "false", "data-part": part }, label);
      b.addEventListener("click", () => {
        d.locks = d.locks.includes(part) ? d.locks.filter((p) => p !== part) : [...d.locks, part];
        syncLocks();
        persist();
      });
      return b;
    });
    const syncLocks = () => lockBtns.forEach((b) => b.setAttribute("aria-pressed", d.locks.includes(b.dataset.part as SetupLock) ? "true" : "false"));
    syncLocks();
    const ward = wardrobe(d.avatar!, (spec) => {
      d.avatar = spec;
      if (!d.locks.includes("look")) {
        d.locks = [...d.locks, "look"];
        syncLocks();
      }
      persist();
      paintCharacter();
    });
    // The preview first, then who it is, then how it looks: the name and the keeps sit under the wardrobe's own preview.
    const who = h(
      "div",
      { class: "ts-who" },
      h("label", { class: "ts-name-row" }, h("span", { class: "ts-label" }, "Name"), h("span", { class: "ts-name-wrap" }, name, icons.pen())),
      tone,
      h("div", { class: "ts-locks" }, h("p", { class: "ts-label", id: "ts-locks-l" }, "Keep when you ask for someone else"), h("div", { class: "ts-locks__row", role: "group", "aria-labelledby": "ts-locks-l" }, ...lockBtns))
    );
    const wrap = h("div", { class: "ts-wardrobe" }, ward);
    const preview = ward.querySelector(".kit-wr-stage");
    if (preview) preview.after(who);
    else wrap.prepend(who);
    const el = h("section", { class: "ts-step ts-step--look" }, wrap);
    return { el, focus: () => (finePointer() ? name.focus() : el.querySelector<HTMLElement>(".ts-name")?.blur()) };
  }

  let stopDay: (() => void) | null = null;

  function dayScene(): Built {
    const made = added!;
    const day = firstDay(made, d, {
      mood: (m) => mood(m, m === "happy" ? 1600 : 0),
      say: (text) => {
        bubble.textContent = text;
        bubble.classList.remove("is-new");
        void bubble.offsetWidth;
        bubble.classList.add("is-new");
      },
      hello: () => {
        sheet.close();
        window.setTimeout(() => openAsk({ assistantId: made.id }), 420);
      },
    });
    stopDay = day.stop;
    const { h2, nodes } = heading(`${made.name} is on your team`);
    h2.classList.add("ts-q--center");
    return { el: h("section", { class: "ts-step ts-step--day" }, ...nodes, day.el), focus: () => h2.focus() };
  }

  const build = (s: Scene): Built => ({ job: jobScene, talk: talkScene, look: lookScene, day: dayScene })[s]();

  let current: Built = build(scene);
  view.append(current.el);

  function syncFoot() {
    const talkDone = scene === "talk" && !!conversation?.done();
    const name = d.name.trim() || "it";
    primary.hidden = scene === "talk" && !talkDone;
    skip.hidden = !(scene === "talk" && !talkDone);
    primary.textContent = scene === "job" ? "Continue" : scene === "talk" ? `Add ${name} to your team` : "Done";
    const ok = !busy && (scene === "job" ? d.text.trim().length >= 3 : scene === "talk" ? d.name.trim().length > 0 : scene === "look" ? d.name.trim().length > 0 : true);
    primary.setAttribute("aria-disabled", ok ? "false" : "true");
    primary.classList.toggle("is-waiting", busy);
    startOver.hidden = !(scene === "job" && (restored || d.seed) && d.text.trim().length > 0);
    hint.textContent = !keysHint() ? "" : scene === "job" ? "↵ to continue" : talkDone ? `${mac ? "⌘↵" : "Ctrl+↵"} to add` : "";
    raise();
  }

  const ORDER: Scene[] = ["job", "talk", "look", "day"];

  function show(next: Scene) {
    if (next === scene) return;
    const dir = ORDER.indexOf(next) > ORDER.indexOf(scene) ? "fwd" : "back";
    const old = current.el;
    const from = scene;
    scene = next;
    current = build(scene);
    showError(null);
    if (prefersReducedMotion()) old.remove();
    else {
      old.classList.add(`is-leaving-${dir}`);
      old.setAttribute("aria-hidden", "true");
      old.addEventListener("animationend", () => old.remove(), { once: true });
      window.setTimeout(() => old.remove(), 400);
      current.el.classList.add(`is-entering-${dir}`);
    }
    view.append(current.el);
    stage.hidden = scene === "look";
    stage.classList.toggle("is-meet", scene === "day");
    stage.classList.toggle("is-talk", scene === "talk");
    if (scene !== "talk") stage.classList.remove("is-docked");
    else dock();
    root.classList.toggle("is-look", scene === "look");
    sheet.setTitle(scene === "look" ? "Name and look" : "New assistant");
    sheet.setBack(scene === "talk" ? () => show("job") : scene === "look" ? () => show("talk") : null);
    paintCharacter();
    syncFoot();
    persist();
    if (scene === "talk" && from === "job") settle();
    if (scene === "day") settle();
    view.scrollTop = 0;
    stage.classList.remove("is-compact");
    requestAnimationFrame(() => current.focus());
  }

  function thinking(on: boolean) {
    stage.classList.toggle("is-thinking", on);
    clearInterval(thinkTimer);
    if (on) {
      mood("thinking");
      let i = 0;
      statusEl.textContent = THINKING[0];
      thinkTimer = window.setInterval(() => {
        i = Math.min(i + 1, THINKING.length - 1);
        statusEl.textContent = THINKING[i];
      }, THINK_STEP_MS);
    } else mood("idle");
  }

  async function draft() {
    const text = d.text.trim();
    if (d.seed && d.avatar && d.draftedFrom === text) return show("talk");
    busy = true;
    syncFoot();
    showError(null);
    thinking(true);
    if (field) field.readOnly = true;
    try {
      // The questions come with the draft: one wait. None (or a failure) means it has nothing to ask.
      const [p, questions] = await Promise.all([draftAssistant(text), teamQuestions(text).catch(() => []), wait(THINK_MIN_MS)]);
      // Someone you've already met keeps their name and face when the job changes.
      const keep = !!(d.seed && d.avatar);
      const seed = keep ? d.seed! : p.seed || newSeed();
      // A null name means "pick one from the seed".
      const proposed = p.name;
      const name = keep ? d.name : proposed && !opts.taken.some((t) => t.toLowerCase() === proposed.toLowerCase()) ? proposed : nameFromSeed(seed, opts.taken);
      d = {
        ...d,
        draftedFrom: text,
        seed,
        name,
        // A thin draft (no job of its own, no triggers) gets them read from the sentence.
        job: p.job && p.job.trim().toLowerCase() !== text.toLowerCase() ? p.job : jobFromText(text),
        instructions: p.instructions || text,
        triggers: p.triggers?.length ? p.triggers : triggersFromText(text),
        offered: allowFor(`${text} ${p.job}`, p.allow ?? []),
        allow: [],
        // Off by default; proposed, switched on, when the job needs something online.
        webSuggested: draftWantsWeb(p),
        web: draftWantsWeb(p),
        avatar: keep ? d.avatar : avatarFromSeed(seed),
        personality: keep ? d.personality : personalityFromSeed(seed),
        locks: keep ? d.locks : [],
        questions,
        answers: {},
        asked: 0,
        skipped: false,
      };
      busy = false;
      thinking(false);
      show("talk");
    } catch {
      busy = false;
      thinking(false);
      if (field) field.readOnly = false;
      paintCharacter();
      syncFoot();
      showError("That didn't go through. Check you're online and try again.");
      field?.focus();
    }
  }

  /** "Someone else": a fresh character for the same job, keeping what you chose to keep. */
  function someoneElse() {
    if (!d.avatar) return;
    const seed = newSeed();
    if (!d.locks.includes("look")) d.avatar = shuffleSpec(d.avatar, new Set(), seed);
    d.seed = seed;
    if (!d.locks.includes("name")) d.name = nameFromSeed(seed, [...opts.taken, d.name]);
    if (!d.locks.includes("personality")) d.personality = personalityFromSeed(seed);
    persist();
    paintCharacter();
    settle();
    conversation?.render();
    syncFoot();
  }

  async function add() {
    busy = true;
    syncFoot();
    showError(null);
    try {
      const input: WebInput & { answers: ReturnType<typeof answersFor> } = {
        name: d.name.trim(),
        job: d.job,
        instructions: d.instructions,
        personality: d.personality ?? undefined,
        avatar: d.avatar ?? undefined,
        allow: d.allow,
        triggers: d.triggers,
        web: d.web,
        answers: answersFor(d.questions, d.answers),
      };
      const made = await createAssistant(input);
      // Its page says so if the switch is off while the job needs it.
      rememberWebHint(made.id, d.webSuggested);
      added = made;
      clearSetup();
      busy = false;
      opts.onAdded(made);
      show("day");
    } catch (e) {
      busy = false;
      syncFoot();
      showError(e instanceof Error && e.message ? e.message : "That didn't go through. Try again.");
    }
  }

  function skipQuestions() {
    if (busy) return;
    d.skipped = true;
    persist();
    conversation?.render();
    syncFoot();
    dock();
  }

  function act() {
    if (busy || primary.getAttribute("aria-disabled") === "true") return;
    if (scene === "job") void draft();
    else if (scene === "talk") void add();
    else if (scene === "look") show("talk");
    else sheet.close();
  }

  function startAgain() {
    d = emptyDraft();
    clearSetup();
    conversation = null;
    svg.classList.remove("kit-enter");
    updateAvatar(svg, SILHOUETTE);
    if (scene !== "job") show("job");
    else if (field) {
      field.value = "";
      field.dispatchEvent(new Event("input"));
      field.focus();
    }
    paintCharacter();
    syncFoot();
  }

  primary.addEventListener("click", act);
  skip.addEventListener("click", skipQuestions);
  startOver.addEventListener("click", startAgain);

  root.addEventListener(
    "keydown",
    (e) => {
      // Esc in Name and look steps back to the talk instead of closing.
      if (e.key === "Escape" && scene === "look") {
        e.preventDefault();
        e.stopPropagation();
        show("talk");
      }
    },
    true
  );

  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const t = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      // ⌘↵ in the talk adds it, passing over any questions left.
      if (scene === "talk" && !conversation?.done()) {
        skipQuestions();
        return;
      }
      act();
      return;
    }
    if (e.shiftKey || e.altKey) return;
    // Enter moves on from a text field or from the scene itself, never from a control that Enter works.
    const typing = t.matches("textarea.ts-ask, input.ts-name");
    if (!typing && t.closest("button, a, input, select, textarea, label, [role=radio], [role=switch]")) return;
    if (scene === "talk" && !conversation?.done()) return;
    e.preventDefault();
    act();
  });

  // ---------- the sheet ----------
  const full = opts.count >= MAX_ASSISTANTS && !restored;
  const body = full
    ? h(
        "div",
        { class: "ts ts--full" },
        h("div", { class: "ts-stage is-silhouette" }, h("div", { class: "ts-figure" }, silhouetteTile(SILHOUETTE, 120, false))),
        h("h2", { class: "ts-q" }, "Your team is full"),
        h("p", { class: "ts-lede" }, `A team has ${MAX_ASSISTANTS} assistants at most. Remove one to make room for another.`)
      )
    : root;
  const sheet = openSheet({
    label: "New assistant",
    title: "New assistant",
    body,
    variant: "tall",
    onClose: () => {
      clearInterval(thinkTimer);
      clearTimeout(moodTimer);
      stopDay?.();
      opts.onClose();
    },
  });
  sheet.dialog.classList.add("team-setup-sheet");
  if (full) return sheet;

  sheet.setBack(scene === "talk" ? () => show("job") : null);
  stage.classList.toggle("is-talk", scene === "talk");
  dock();
  paintCharacter();
  syncFoot();
  requestAnimationFrame(() => current.focus());
  new ResizeObserver(raise).observe(view);
  persist();
  return sheet;
}
