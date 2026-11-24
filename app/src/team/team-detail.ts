/**
 * Team: one assistant, #/team/<id> (docs/team.md, "Detail page"). It reads
 * like a colleague's desk, not a settings form:
 *
 * - The hero: the character, its name and job (both editable where they
 *   stand), what it's doing right now, and Chat and Run now, with a quiet
 *   Rename beside them that puts the name into edit. Run now is
 *   asking someone to start: they answer in their own tone, look up to
 *   think, and say each step as they go (detail-work.ts shows the run).
 * - What it has done (detail-work.ts), first: each run opens its
 *   conversation; one that didn't finish offers Try again.
 * - An imported assistant's accounts (detail-accounts.ts): the connected
 *   accounts it may open, one tick each, beside its brief.
 * - How it works for you (detail-brief.ts): its brief as sentences you tap
 *   to change, its skill (team-skill-section.ts), what it knows about you,
 *   and its personality and looks.
 * - Share, as a file someone else can import (share-sheet.ts).
 * - Pause and Delete, calm, at the end. Delete is confirmed.
 *
 * On a wide screen the work sits on the left and how it works on the right.
 */
import { spendCapSection } from "../components/spend-cap";
import "../styles/team-detail.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openSheet } from "../components/sheet";
import { confirmDialog } from "../components/confirm";
import { showToast } from "../components/toast";
import { openAsk } from "../lib/open-ask";
import { onThreadsChange, requestOpen } from "../db/ask-threads";
import { planCounts, waitsFrom } from "./page-pulse";
import { deleteAssistant, getAssistant, listRuns, runNow, updateAssistant, type TeamAssistant, type TeamRun } from "../db/team";
import { MAX_JOB, MAX_NAME } from "../../../lib/team-types";
import { renderAvatarTile, setAvatarMood, updateAvatar, wardrobe } from "./avatar";
import { paintWho } from "./dot-colour";
import { skillSection } from "./team-skill-section";
import { pageStatusParts } from "./trigger-editor-words";
import { briefSection, memorySection, personalitySection, triggerInput } from "./detail-brief";
import { workSection } from "./detail-work";
import { trackingSection } from "./detail-tracking";
import { modelsSection } from "./detail-models";
import { accountsSection } from "./detail-accounts";
import { cap, isLive, liveWords, pronouns, startLine } from "./detail-words";
import { openShareAssistant } from "./share-sheet";
import { assistantFlowsSection } from "../flows/assistant-flows";
import { flowsChanged } from "../db/flows";
import { catalogueStatus } from "../community/status";

export { triggerInput };

export interface TeamDetailContext {
  id: string;
  /** Back to the team. */
  back: () => void;
}

/** How often the page looks for new work: quickly while a run is going, now and then otherwise. */
const LIVE_MS = 3000;
const IDLE_MS = 30_000;

/** A one-line field that reads as text until you touch it. Enter or leaving saves; Esc puts it back. */
function inPlace(value: string, opts: { cls: string; label: string; max: number; multiline?: boolean; save: (v: string) => Promise<boolean> }): HTMLInputElement | HTMLTextAreaElement {
  const field = (opts.multiline ? h("textarea", { class: `td-inplace ${opts.cls}`, rows: 1, maxlength: opts.max, "aria-label": opts.label, spellcheck: opts.max > 60 ? "true" : "false", autocapitalize: opts.max > 60 ? "sentences" : "words", enterkeyhint: "done" }, value) : h("input", { class: `td-inplace ${opts.cls}`, type: "text", value, maxlength: opts.max, "aria-label": opts.label, autocomplete: "off", autocapitalize: "words", spellcheck: "false", enterkeyhint: "done" })) as HTMLInputElement | HTMLTextAreaElement;
  let saved = value;
  const fit = () => {
    if (!opts.multiline) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  };
  field.addEventListener("input", fit);
  requestAnimationFrame(fit);
  new ResizeObserver(fit).observe(field);
  const commit = async () => {
    const v = field.value.trim().replace(/\s+/g, " ");
    if (!v) {
      field.value = saved;
      fit();
      return;
    }
    if (v === saved) return;
    if (await opts.save(v)) saved = v;
    else field.value = saved;
    fit();
  };
  field.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      field.blur();
    } else if (ke.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      field.value = saved;
      fit();
      field.blur();
    }
  });
  field.addEventListener("blur", () => void commit());
  return field;
}

export function renderTeamDetail(ctx: TeamDetailContext): { el: HTMLElement; destroy: () => void } {
  const back = h("button", { class: "td-back", type: "button" }, icons.back(), h("span", {}, "Team"));
  back.addEventListener("click", ctx.back);
  const body = h("div", { class: "td-body", "aria-busy": "true" });
  const el = h("div", { class: "view team-detail" }, h("div", { class: "td-top" }, back), catalogueStatus("assistant", ctx.id), body);
  let alive = true;
  let a: TeamAssistant;
  let runs: TeamRun[] = [];
  let timer = 0;
  let sayTimer = 0;
  let moodTimer = 0;
  /** Set while Run now waits for its first step, so the hero keeps saying "On it!" a moment. */
  let starting = false;

  /** Save a change; on failure say so and report it, so the caller can put the old value back. */
  async function save(patch: Parameters<typeof updateAssistant>[1]): Promise<boolean> {
    try {
      a = await updateAssistant(a.id, patch);
      paintHero();
      // A new job or instructions: its skill may no longer match, so the section looks again (and offers an update).
      if (patch.job !== undefined || patch.instructions !== undefined) skill?.reload();
      if (patch.name !== undefined || patch.personality !== undefined) paintAll();
      // Its triggers are its flows: "<Name>'s flows" reads them again.
      if (patch.triggers !== undefined || patch.paused !== undefined) flowsChanged();
      return true;
    } catch (e) {
      showToast(e instanceof Error && e.message ? `Couldn't save that: ${e.message}` : "Couldn't save that. Try again.");
      return false;
    }
  }

  // ---------- the hero ----------
  let heroSvg: SVGSVGElement;
  let heroTile: HTMLElement;
  let disc: HTMLElement;
  const status = h("p", { class: "td-status", "aria-live": "polite" });
  const bubble = h("p", { class: "td-say", "aria-hidden": "true", hidden: true });
  // "Chat with <Name>"; on a phone the name sits just above, so the button says "Chat" and its label keeps the rest.
  const chatWho = h("span", { class: "td-chat__who" });
  const chat = h("button", { class: "btn btn--primary td-chat", type: "button" }, icons.chat(), h("span", {}, "Chat", chatWho));
  const start = h("button", { class: "btn btn--soft td-start", type: "button" }, icons.play(), h("span", {}, "Run now"));
  const resume = h("button", { class: "btn btn--soft td-start", type: "button" }, icons.play(), h("span", {}, "Turn back on"));
  // Rename: quiet, beside Chat and Run now. It focuses the name in the same tap, so a phone raises its keyboard.
  const rename = h("button", { class: "btn btn--ghost td-rename", type: "button" }, icons.pen(), h("span", {}, "Rename"));
  let nameField: HTMLInputElement | HTMLTextAreaElement | null = null;
  let pageTitle: HTMLElement | null = null;
  rename.addEventListener("click", () => {
    if (!nameField) return;
    nameField.focus();
    nameField.select();
  });
  const pausedNote = h("p", { class: "td-paused", hidden: true });
  chat.addEventListener("click", () => openAsk({ assistantId: a.id }));
  start.addEventListener("click", () => void begin());
  resume.addEventListener("click", () => void setPaused(false));

  /** Say something beside the avatar for a moment. */
  function say(text: string, ms = 2600) {
    window.clearTimeout(sayTimer);
    bubble.textContent = text;
    bubble.hidden = false;
    bubble.classList.remove("is-in");
    void bubble.offsetWidth;
    bubble.classList.add("is-in");
    sayTimer = window.setTimeout(() => (bubble.hidden = true), ms);
  }

  function mood(m: "idle" | "working" | "happy", ms = 0) {
    if (!heroSvg) return;
    window.clearTimeout(moodTimer);
    setAvatarMood(heroSvg, m);
    if (ms) moodTimer = window.setTimeout(() => heroSvg && setAvatarMood(heroSvg, live() ? "working" : "idle"), ms);
  }

  const live = () => runs.find(isLive) ?? null;

  function paintHero() {
    if (pageTitle) pageTitle.textContent = a.name;
    const now = live();
    const working = !!now || starting;
    el.classList.toggle("is-paused", a.paused);
    el.classList.toggle("is-working", working);
    // The page is one assistant's: its working dot is in its own colour (owner, 16 Nov 2026).
    paintWho(el, a.avatar);
    // At rest: what it's watching and when it last ran, in parts that wrap between them, not mid-phrase.
    const parts = working ? [`${now ? liveWords(now) : "About to start"}…`] : pageStatusParts(a);
    const line = `${working ? "live:" : ""}${parts.join(" · ")}`;
    // Only when it changes, so a screen reader hears each step once.
    if (status.dataset.line !== line) {
      status.dataset.line = line;
      status.replaceChildren(
        ...(working
          ? [h("span", { class: "team-dot", "aria-hidden": "true" }), parts[0]]
          : [h("span", { class: "td-status__parts" }, h("span", { class: "td-status__list" }, ...parts.map((p) => h("span", { class: "td-status__part" }, p))))])
      );
    }
    chatWho.textContent = ` with ${a.name}`;
    chat.setAttribute("aria-label", `Chat with ${a.name}`);
    start.hidden = a.paused;
    resume.hidden = !a.paused;
    start.setAttribute("aria-disabled", working ? "true" : "false");
    start.lastElementChild!.textContent = working ? "Working…" : "Run now";
    pausedNote.hidden = !a.paused;
    const p = pronouns(a.personality);
    pausedNote.textContent = `${a.name} is paused. ${cap(p.their)} triggers won't start ${p.them} until you turn ${p.them} back on. You can still chat.`;
  }

  function hero(): HTMLElement {
    // Drawn at 148 (the wide page's size); team-detail.css sets 96px on a phone. Ears rise past the tile at both.
    heroTile = renderAvatarTile(a.avatar, { size: 148, animate: true });
    heroTile.classList.add("td-face");
    heroSvg = heroTile.firstElementChild as SVGSVGElement;
    disc = h("button", { class: "td-disc", type: "button", "aria-label": `Customise how ${a.name} looks` }, heroTile);
    disc.addEventListener("click", customise);
    // Multiline so a long name wraps rather than clips; Enter still saves.
    // The name is a field, so the page's h1 says it for screen readers (paintHero keeps it current).
    pageTitle = h("h1", { class: "visually-hidden" }, a.name);
    const name = inPlace(a.name, { cls: "td-name", label: "Name", max: MAX_NAME, multiline: true, save: (v) => save({ name: v }) });
    nameField = name;
    // While the name is being changed, Rename steps back: the field is the focus.
    const heroEl = () => name.closest(".td-hero");
    name.addEventListener("focus", () => heroEl()?.classList.add("is-renaming"));
    name.addEventListener("blur", () => heroEl()?.classList.remove("is-renaming"));
    const job = inPlace(a.job, { cls: "td-job", label: "Job", max: MAX_JOB, multiline: true, save: (v) => save({ job: v }) });
    paintHero();
    return h(
      "header",
      { class: "td-hero" },
      h("div", { class: "td-figure" }, disc, bubble),
      h("div", { class: "td-id" }, pageTitle, name, job, status),
      h("div", { class: "td-actions" }, chat, start, resume, rename)
    );
  }

  function customise() {
    let next = a.avatar;
    const ward = wardrobe(a.avatar, (spec) => {
      next = spec;
      updateAvatar(heroTile, spec);
    });
    openSheet({
      label: "Customise character",
      title: `Customise ${a.name}`,
      body: h("div", { class: "td-wardrobe" }, ward),
      variant: "tall",
      onClose: async () => {
        if (JSON.stringify(next) === JSON.stringify(a.avatar)) return;
        if (await save({ avatar: next })) personality.paint();
        else {
          updateAvatar(heroTile, a.avatar);
        }
      },
    });
  }

  // ---------- Run now: asking them to start ----------
  async function begin() {
    if (start.getAttribute("aria-disabled") === "true" || a.paused) return;
    starting = true;
    say(startLine(a.personality));
    mood("working");
    paintHero();
    try {
      const run = await runNow(a.id);
      if (!alive) return;
      runs = [run, ...runs.filter((r) => r.id !== run.id)];
      work.paint(a, runs);
    } catch (e) {
      starting = false;
      mood("idle");
      bubble.hidden = true;
      showToast(e instanceof Error && e.message ? e.message : `${a.name} couldn't start just now. Try again.`);
    }
    // Keep "On it!" up a moment before the first step takes over.
    window.setTimeout(() => {
      starting = false;
      if (alive) paintHero();
    }, 1200);
    paintHero();
    look(LIVE_MS);
  }

  /** Look for new work: quickly while a run is going, now and then otherwise, and never while the page is hidden. */
  function look(ms = live() ? LIVE_MS : IDLE_MS) {
    window.clearTimeout(timer);
    if (!alive) return;
    timer = window.setTimeout(async () => {
      if (document.hidden) return look();
      const fresh = await listRuns(a.id).catch(() => null);
      if (!alive) return;
      if (fresh) {
        const was = new Map(runs.map((r) => [r.id, r.status]));
        const finished = fresh.filter((r) => !isLive(r) && was.has(r.id) && isLive({ status: was.get(r.id)! }));
        const began = fresh.some((r) => isLive(r) && !was.has(r.id));
        runs = fresh;
        if (began) mood("working");
        if (finished.length) {
          const ok = finished.some((r) => r.status === "done");
          if (ok) {
            mood("happy", 2600);
            say("Done.", 2400);
          } else mood("idle");
          const again = await getAssistant(a.id).catch(() => null);
          if (!alive) return;
          if (again) a = again;
          memory.paint();
        } else if (!live() && !starting) mood("idle");
        plans = await planCounts(runs);
        if (!alive) return;
        work.paint(a, runs);
        paintHero();
      }
      look();
    }, ms);
  }

  /** Open the conversation a run kept, the way Settings → What Ask did opens one. */
  async function openRun(r: TeamRun) {
    if (!r.thread_id) return openAsk({ assistantId: a.id });
    requestOpen(r.thread_id);
    location.hash = "#/ask";
  }

  // ---------- pause and delete ----------
  async function setPaused(paused: boolean) {
    if (await save({ paused })) {
      end.paint();
      showToast(paused ? `Paused ${a.name}` : `${a.name} is back on`);
    }
  }

  function endSection(): { el: HTMLElement; paint: () => void } {
    const text = h("span", { class: "td-allow__text" });
    const toggle = h("button", { class: "btn btn--soft btn--sm", type: "button" });
    toggle.addEventListener("click", () => void setPaused(!a.paused));
    const del = h("button", { class: "btn btn--ghost btn--sm td-delete", type: "button", "data-edit": "delete" }, icons.trash(), h("span", {}));
    del.addEventListener("click", async () => {
      const p = pronouns(a.personality);
      const ok = await confirmDialog({
        title: `Delete ${a.name}?`,
        body: `${a.name}'s triggers, skill, memory and runs go too. ${cap(p.their)} conversations stay in Ask. This can't be undone.`,
        confirmLabel: `Delete ${a.name}`,
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteAssistant(a.id);
        showToast(`Deleted ${a.name}`);
        ctx.back();
      } catch {
        showToast("Couldn't delete that. Try again.");
      }
    });
    const el = h("section", { class: "td-sec td-end", "aria-label": "Pause or delete" }, h("div", { class: "td-end__row" }, text, toggle), del);
    const paint = () => {
      const p = pronouns(a.personality);
      text.replaceChildren(
        h("span", { class: "td-allow__label" }, a.paused ? `${a.name} is paused` : `Pause ${a.name}`),
        h("span", { class: "td-allow__detail" }, a.paused ? `Turn ${p.them} back on and ${p.their} flows run again.` : `Every flow ${p.they} ${p.plural ? "run" : "runs"} stops until you turn ${p.them} back on, handed ones too. You can still chat.`)
      );
      toggle.textContent = a.paused ? "Turn back on" : "Pause";
      del.lastElementChild!.textContent = `Delete ${a.name}`;
    };
    return { el, paint };
  }

  /** Share: the assistant as a file someone else can import (share-sheet.ts). */
  function shareSection(): { el: HTMLElement; paint: () => void } {
    const text = h("span", { class: "td-allow__text" });
    const go = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Share");
    go.addEventListener("click", () => openShareAssistant(a));
    const el = h("section", { class: "td-sec td-end", "aria-label": "Share" }, h("div", { class: "td-end__row" }, text, go));
    const paint = () => {
      const p = pronouns(a.personality);
      text.replaceChildren(h("span", { class: "td-allow__label" }, `Share ${a.name}`), h("span", { class: "td-allow__detail" }, `As a file someone else can import into their own Athena. ${cap(p.their)} memory and your accounts stay here.`));
      go.setAttribute("aria-label", `Share ${a.name} as a file`);
    };
    return { el, paint };
  }

  // ---------- the page ----------
  /** This device's conversations that may still hold a plan, by run id: what waits for Go (team/page-pulse.ts). */
  let plans = new Map<string, readonly unknown[]>();
  const work = workSection({ open: (r) => void openRun(r), start: () => void begin(), waitsOf: () => waitsFrom(plans) });
  /** Read the conversations again, then the work: a Go in Ask lowers what waits. */
  const rePlan = async () => {
    plans = await planCounts(runs);
    if (alive && a) work.paint(a, runs);
  };
  const offThreads = onThreadsChange(() => void rePlan());
  let skill: ReturnType<typeof skillSection> | null = null;
  const briefCtx = { get: () => a, save };
  const brief = briefSection(briefCtx);
  const memory = memorySection(briefCtx);
  const personality = personalitySection({ ...briefCtx, customise });
  const end = endSection();
  const share = shareSection();
  // An imported assistant's accounts (detail-accounts.ts): hidden for one made here.
  const accounts = accountsSection({ ...briefCtx, alive: () => alive });
  // What it tracks (detail-tracking.ts): hidden when it tracks nothing.
  const tracking = trackingSection(() => a, () => alive);
  // "<Name>'s flows" and Give <Name> a flow (flows/assistant-flows.ts): hidden until they load.
  const flows = assistantFlowsSection(() => a, () => alive);
  // How it thinks (detail-models.ts): made once the assistant has loaded.
  let models: ReturnType<typeof modelsSection> | null = null;

  function paintAll() {
    paintHero();
    work.paint(a, runs);
    brief.paint();
    memory.paint();
    personality.paint();
    share.paint();
    accounts.paint();
    end.paint();
    tracking.paint();
    flows.paint();
    models?.paint();
    skill?.reload();
  }

  function draw() {
    skill = skillSection(
      () => a,
      () => alive
    );
    brief.paint();
    memory.paint();
    personality.paint();
    share.paint();
    accounts.paint();
    end.paint();
    work.paint(a, runs);
    tracking.paint();
    flows.paint();
    models ??= modelsSection(() => a);
    body.replaceChildren(
      hero(),
      pausedNote,
      h("div", { class: "td-layout" }, h("div", { class: "td-main" }, work.el, flows.el, tracking.el), h("div", { class: "td-aside" }, brief.el, accounts.el, models.el, skill.el, memory.el, personality.el, spendCapSection(a.id), share.el, end.el))
    );
    if (live()) mood("working");
  }

  async function load() {
    try {
      const [found, rs] = await Promise.all([getAssistant(ctx.id), listRuns(ctx.id).catch(() => [] as TeamRun[])]);
      if (!alive) return;
      body.removeAttribute("aria-busy");
      if (!found) {
        const b = h("button", { class: "btn btn--soft", type: "button" }, "Back to your team");
        b.addEventListener("click", ctx.back);
        return void body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "That assistant isn't here any more"), h("p", { class: "empty__sub" }, "It may have been deleted on another device."), b));
      }
      a = found;
      runs = rs;
      plans = await planCounts(runs);
      if (!alive) return;
      draw();
      look();
    } catch {
      if (alive) body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "This assistant didn't load"), h("p", { class: "empty__sub" }, "Check you're online and try again.")));
    }
  }

  void load();
  return {
    el,
    destroy() {
      alive = false;
      offThreads();
      tracking.destroy();
      flows.destroy();
      models?.destroy();
      window.clearTimeout(timer);
      window.clearTimeout(sayTimer);
      window.clearTimeout(moodTimer);
    },
  };
}
