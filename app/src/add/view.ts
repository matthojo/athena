/**
 * `#/add`: the one screen through which every shared item enters Athena (lib/community-api.ts). An assistant, a
 * skill or a flow, from a Community listing (`#/add?catalogue=<id>`), a GitHub link (`#/add?link=<url>`), a file,
 * zip or folder picked or dropped here, held by another page (add/hold.ts), or shared to the installed app.
 *
 * One layout for all three kinds, read top to bottom in the order the owner decides in: what it is and who made
 * it; where it came from ("Not from Community" unless it did); what it can reach, in plain words worked out from
 * its files; the accounts it needs and whether they're connected; its questions; which accounts it may open (all
 * unticked); what it may do alone (all unticked; "Always asks first" for what it can't be given); then the whole
 * of it, readable. Nothing is kept until Add, and what's added starts switched off.
 */
import "./add.css";
// The sticky foot is shared with the flow page (styles/flows.css, "Sticky foot").
import "../styles/flows.css";
import "../styles/skills.css";
import "../styles/team-share.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { pageHead } from "../components/page-head";
import { brandLogo } from "../components/brand-logo";
import { accountTicks, cantWorkNote } from "../components/account-ticks";
import { personPicker } from "../components/person-picker";
import { isSampleMode } from "../db/api";
import { addItem, addHash, isNewerFormat, parseAddHash, previewAdd, type AddChoices, type AddPreview, type AddSource } from "../db/community";
import { itemAccounts, type AccountRow } from "../db/item-accounts";
import { listTeam } from "../db/team";
import { loadCatalog } from "../db/flows";
import type { CatalogEntry } from "../../../lib/flow-types";
import { liveContexts, loadContexts } from "../db/todo-contexts";
import { renderAvatarTile, avatarFromSeed } from "../team/avatar";
import { questionsForm, type AnswerMap } from "../team/setup-questions";
import { triggerSentence } from "../team/trigger-editor-words";
import { accountName } from "../team/share-words";
import { asksFirstWords, SHARED_TOOLS, splitWouldLike } from "../../../lib/shared-limits";
import { linkedHosts, shareSeed } from "../../../lib/team-share";
import { MAX_ASSISTANTS } from "../../../lib/team-types";
import { MAX_ANSWER } from "../../../lib/team-skill";
import type { ShareKind } from "../../../lib/share-kinds";
import type { ViewId } from "../components/nav";
import { sharedFlowSteps } from "./flow-steps";
import { tierIcon } from "../community/words";
import { entriesOf, filesFromDrop, takeHeldFiles, takeSharedFile } from "./hold";
import { SAMPLE_LINKS } from "./sample-items";
import { addedWords, addLabel, basedOnWords, checkinAddedWords, fillsWords, haveWords, KIND_LABEL, landsWords, makerWords, offWords, originWords, reachWords, updatedWords, updateLandsWords } from "./words";
import { checkinPreview } from "./checkin-preview";
import { loadCheckinSettings, type CheckinSettingsView } from "../db/checkins";
import { promptsHere, samePrompt } from "../../../lib/checkin-share";
import { CHECKIN_KINDS, type CheckinKind } from "../../../lib/checkin-types";
import type { AddResult } from "../../../lib/community-api";

type Go = (view: ViewId, opts?: { source?: string | null; noteId?: string | null }) => void;

export interface AddViewContext {
  go: Go;
}

const errorText = (error: unknown) => (error instanceof Error && error.message && !/fetch|network|Failed|^\d{3} /i.test(error.message) ? error.message : "That didn't work. Check you're online and try again.");

const KIND_ICON: Record<ShareKind, keyof typeof icons> = { assistant: "team", skill: "book", flow: "loop", checkin: "chat" };

const size = (text: string) => {
  const n = new TextEncoder().encode(text).byteLength;
  return n < 1024 ? `${n} bytes` : `${Math.round(n / 102.4) / 10} KB`;
};

export function renderAdd(ctx: AddViewContext): { el: HTMLElement; destroy: () => void } {
  let alive = true;
  const body = h("div", { class: "add__body" });
  const el = h("div", { class: "view add" }, body);
  /** Moves focus to the new state's heading, so a screen reader hears where it is. */
  const focusHeading = () => requestAnimationFrame(() => body.querySelector<HTMLElement>("h1, h2")?.focus({ preventScroll: false }));
  // Back to where the owner came from; on a phone there's no sidebar to do it.
  const back = h("button", { class: "flow-back add-back", type: "button" }, icons.back(), h("span", {}, "Back"));
  back.addEventListener("click", () => (history.length > 1 ? history.back() : ctx.go("home")));
  const show = (...kids: Array<Node | null>) => {
    if (!alive) return;
    body.replaceChildren(h("div", { class: "add-top" }, back), ...kids.filter((k): k is Node => !!k));
    window.scrollTo({ top: 0 });
  };

  // ---------- ways in ----------

  const fileInput = h("input", { type: "file", multiple: true, accept: ".zip,.json,.md,application/zip,application/json,text/markdown", hidden: true }) as HTMLInputElement;
  const folderInput = h("input", { type: "file", hidden: true, webkitdirectory: "", multiple: true }) as HTMLInputElement;
  fileInput.addEventListener("change", () => fromFiles([...(fileInput.files ?? [])]));
  folderInput.addEventListener("change", () => fromFiles([...(folderInput.files ?? [])]));

  function fromFiles(files: File[]) {
    fileInput.value = "";
    folderInput.value = "";
    if (!files.length) return;
    void load(async () => {
      const { entries, name } = await entriesOf(files);
      return previewAdd({ files: entries, name } as AddSource);
    });
  }

  function choose(problem?: string) {
    const url = h("input", { class: "field add-link__field", type: "url", inputmode: "url", placeholder: "https://github.com/…", "aria-label": "GitHub link", "aria-describedby": "add-link-hint", autocomplete: "off", spellcheck: false, required: true }) as HTMLInputElement;
    const look = h("button", { class: "btn btn--primary", type: "submit" }, "Look at it");
    const form = h("form", { class: "add-link" }, h("label", { class: "add-link__label", for: "add-link-url" }, "Or paste a link"), h("div", { class: "add-link__row" }, url, look), h("p", { class: "form__hint", id: "add-link-hint" }, "A public GitHub folder, or the assistant.json, SKILL.md, flow.json or checkin.json in it."));
    url.id = "add-link-url";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const link = url.value.trim();
      if (!link) return url.focus();
      history.replaceState(history.state, "", addHash({ link }));
      void load(() => previewAdd({ link }));
    });

    const pickFile = h("button", { class: "btn btn--soft", type: "button" }, icons.arrowUp(), "Choose a file");
    const pickFolder = h("button", { class: "btn btn--soft", type: "button" }, icons.folder(), "Choose a folder");
    pickFile.addEventListener("click", () => fileInput.click());
    pickFolder.addEventListener("click", () => folderInput.click());
    const drop = h(
      "div",
      { class: "add-drop" },
      h("span", { class: "add-drop__icon", "aria-hidden": "true" }, icons.arrowUp()),
      h("p", { class: "add-drop__title" }, "Drop a file or folder here"),
      h("p", { class: "add-drop__sub" }, "A .zip, an assistant.json, a SKILL.md, a flow.json or a checkin.json, or the folder that holds one"),
      h("div", { class: "add-drop__actions" }, pickFile, pickFolder)
    );

    const samples = isSampleMode()
      ? h(
          "section",
          { class: "add-samples", "aria-labelledby": "add-samples-title" },
          h("h2", { class: "add-sec__title", id: "add-samples-title" }, "Try a made-up one"),
          h(
            "div",
            { class: "card card--flush list" },
            ...SAMPLE_LINKS.map((s) => {
              const a = h("a", { class: "row", href: addHash({ link: s.link }) }, h("span", { class: "row__body" }, h("span", { class: "row__title" }, s.title), h("span", { class: "row__meta add-samples__link" }, s.link.replace("https://", ""))), h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
              return a;
            })
          )
        )
      : null;

    show(
      pageHead({ title: "Add something shared", lede: "An assistant, a skill, a flow or some check-in questions someone shared. You'll see all of it before anything is added." }),
      problem ? h("p", { class: "add-problem", role: "alert" }, icons.flag(), h("span", {}, problem)) : null,
      drop,
      form,
      samples,
      fileInput,
      folderInput
    );
  }

  // ---------- loading, and what went wrong ----------

  async function load(get: () => Promise<AddPreview>) {
    show(
      pageHead({ title: "Reading it…" }),
      h(
        "div",
        { class: "add-loading", role: "status" },
        h("span", { class: "orb orb--thinking", "aria-hidden": "true" }),
        h("p", {}, "Athena is reading its files and working out what it can reach. Nothing is added yet.")
      )
    );
    try {
      const p = await get();
      if (alive) await previewScreen(p);
    } catch (error) {
      if (!alive) return;
      if (isNewerFormat(error)) newer();
      else failed(errorText(error));
    }
  }

  function failed(message: string) {
    const again = h("button", { class: "btn btn--primary", type: "button" }, "Try something else");
    again.addEventListener("click", startOver);
    show(
      pageHead({ title: "Athena couldn't read that" }),
      h("div", { class: "add-state add-state--bad", role: "alert" }, h("span", { class: "add-state__icon", "aria-hidden": "true" }, icons.flag()), h("p", { class: "add-state__text" }, message), h("p", { class: "add-state__sub" }, "Nothing was added.")),
      h("div", { class: "add-state__actions" }, again)
    );
    focusHeading();
  }

  function newer() {
    const again = h("button", { class: "btn btn--soft", type: "button" }, "Add something else");
    again.addEventListener("click", startOver);
    show(
      pageHead({ title: "Update Athena to add this" }),
      h(
        "div",
        { class: "add-state", role: "status" },
        h("span", { class: "add-state__icon add-state__icon--accent", "aria-hidden": "true" }, icons.refresh()),
        h("p", { class: "add-state__text" }, "It was made for a newer version of Athena than this one, so this copy can't read all of it yet."),
        h("p", { class: "add-state__sub" }, "Once your Athena is updated, open the same link or file again. Nothing was added.")
      ),
      h("div", { class: "add-state__actions" }, again)
    );
    focusHeading();
  }

  function startOver() {
    el.classList.remove("add--checkin");
    history.replaceState(history.state, "", "#/add");
    choose();
    focusHeading();
  }

  // ---------- the preview ----------

  async function previewScreen(p: AddPreview) {
    const needs = p.reach.needs;
    const [accounts, team, catalog, checkinSettings] = await Promise.all([
      (p.kind === "flow" || p.kind === "checkin") && !needs.length ? Promise.resolve([] as AccountRow[]) : itemAccounts(needs).catch(() => null),
      p.kind === "assistant" ? listTeam().catch(() => null) : Promise.resolve(null),
      // A flow's steps are named as the flow editor names them.
      p.kind === "flow" ? loadCatalog().catch(() => [] as CatalogEntry[]) : Promise.resolve([] as CatalogEntry[]),
      // Check-in questions are marked when the owner already has their words, and a routine that's off is named.
      p.kind === "checkin" ? loadCheckinSettings().catch(() => null) : Promise.resolve(null as CheckinSettingsView | null),
    ]);
    if (!alive) return;
    const room = p.kind !== "assistant" || !team || team.length < MAX_ASSISTANTS;
    const item = p.item;
    const name = p.name;
    const answers: Record<string, string> = {};
    const checks: Array<() => string | null> = [];

    // Who and what.
    const lead =
      item.kind === "assistant"
        ? renderAvatarTile(item.shared.avatar ?? avatarFromSeed(shareSeed(item.shared)), { size: 72, animate: true })
        : h("span", { class: `add-hero__tile add-hero__tile--${p.kind}`, "aria-hidden": "true" }, icons[KIND_ICON[p.kind]]());
    const title = h("h1", { class: "page-title add-hero__name", tabindex: "-1" }, name);
    const job = item.kind === "assistant" && item.shared.name ? h("p", { class: "add-hero__job" }, item.shared.job) : null;
    const hero = h(
      "header",
      { class: "add-hero" },
      lead,
      h("div", { class: "add-hero__text" }, h("span", { class: `add-kind add-kind--${p.kind}` }, KIND_LABEL[p.kind]), title, job, p.summary ? h("p", { class: "add-hero__summary" }, p.summary) : null)
    );

    const origin = originWords(p);
    // Who made it: the file's word, else the catalogue's (the same name the Community list shows).
    const maker = makerWords({ ...p.header, author: p.header.author ?? p.listing?.author ?? undefined, version: p.header.version ?? p.listing?.version ?? undefined });
    const based = basedOnWords(p.header);
    const facts = h(
      "div",
      { class: "add-facts card" },
      h(
        "div",
        { class: `add-fact add-fact--${origin.community ? "community" : "outside"}` },
        h("span", { class: "add-fact__icon", "aria-hidden": "true" }, origin.community ? icons.shield() : icons.link()),
        h("span", { class: "add-fact__text" }, h("span", { class: "add-fact__title" }, origin.title), h("span", { class: "add-fact__sub" }, origin.community ? origin.detail : `${origin.detail}. Nobody reviewed it for Athena.`))
      ),
      h(
        "div",
        { class: "add-fact" },
        h("span", { class: "add-fact__icon", "aria-hidden": "true" }, icons.person()),
        h("span", { class: "add-fact__text" }, h("span", { class: "add-fact__title" }, maker || "Its author didn't say who they are"), based ? h("span", { class: "add-fact__sub" }, based) : null)
      )
    );

    // What it can reach, worked out from its files.
    const reach = reachWords(p.reach, p.kind);
    const reachIcon = icons[tierIcon(p.reach)]();
    const reachCard = h(
      "section",
      { class: `add-reach add-reach--${p.reach.tier}`, "aria-labelledby": "add-reach-title" },
      h("span", { class: "add-reach__icon", "aria-hidden": "true" }, reachIcon),
      h(
        "div",
        { class: "add-reach__text" },
        h("p", { class: "add-reach__eyebrow" }, "What it can reach"),
        h("h2", { class: "add-reach__title", id: "add-reach-title" }, reach.title),
        reach.lines.length > 1 ? h("ul", { class: "add-reach__lines" }, ...reach.lines.map((l) => h("li", {}, l))) : reach.lines.length ? h("p", { class: "add-reach__line" }, reach.lines[0]) : null,
        h("p", { class: "add-reach__note" }, "Athena worked this out from its files, not from what its author says.")
      )
    );

    const section = (id: string, heading: string, ...kids: Array<Node | null>) => h("section", { class: "add-sec", "aria-labelledby": `add-${id}` }, h("h2", { class: "add-sec__title", id: `add-${id}` }, heading), ...kids.filter((k): k is Node => !!k));

    // What it needs, and whether each is connected.
    const connected = (provider: string) => !!accounts?.some((a) => a.provider === provider);
    const needsSec = needs.length
      ? section(
          "needs",
          "What it needs",
          h(
            "ul",
            { class: "add-needs card card--flush" },
            ...needs.map((n) => {
              const on = connected(n);
              const nice = accounts?.find((a) => a.provider === n)?.name ?? accountName(n);
              return h(
                "li",
                { class: `add-need${on ? " is-on" : ""}` },
                brandLogo(n, "sm"),
                h("span", { class: "add-need__text" }, h("span", { class: "add-need__name" }, nice), h("span", { class: "add-need__state" }, on ? "Connected" : accounts ? "Not connected" : "Couldn't check")),
                on ? h("span", { class: "add-need__tick", "aria-hidden": "true" }, icons.check()) : accounts ? h("a", { class: "btn btn--soft btn--sm", href: "#/settings/accounts" }, `Connect ${nice}`) : null
              );
            })
          ),
          needs.some((n) => !connected(n)) && accounts ? h("p", { class: "form__hint" }, "You can add it now and connect later. What it does with an account starts once that account is connected and ticked.") : null
        )
      : null;

    // Its questions.
    let questionsSec: HTMLElement | null = null;
    if (item.kind === "assistant" && item.shared.asks.length) {
      const withChoices = item.shared.asks.map((q, i) => ({ id: `q${i + 1}`, question: q.question, choices: q.choices, allowOther: true })).filter((q) => q.choices.length);
      let picked: AnswerMap = {};
      const sync = () => {
        for (const q of withChoices) {
          const raw = picked[q.id] ?? "";
          const v = raw.startsWith("other:") ? raw.slice(6) : raw;
          if (v.trim()) answers[q.question] = v;
          else delete answers[q.question];
        }
      };
      const free = item.shared.asks.filter((q) => !q.choices.length).map((q, i) => {
        const input = h("input", { class: "field", type: "text", maxlength: MAX_ANSWER, autocomplete: "off", id: `add-free-${i}` }) as HTMLInputElement;
        input.addEventListener("input", () => (input.value.trim() ? (answers[q.question] = input.value) : delete answers[q.question]));
        return h("div", { class: "add-q" }, h("label", { class: "tq__q", for: `add-free-${i}` }, q.question), input);
      });
      questionsSec = section(
        "questions",
        `${name} asks`,
        h("div", { class: "add-questions" }, withChoices.length ? questionsForm(withChoices, picked, (m) => ((picked = m), sync())) : null, ...free),
        h("p", { class: "form__hint" }, "Your answers go into its skill. You can skip any of them.")
      );
    }
    if (item.kind === "flow" && item.flow.asks.length) {
      // A question that names a to-do context offers the owner's own.
      if (item.flow.asks.some((a) => a.pick === "area" || a.pick === "where")) await loadContexts().catch(() => null);
      if (!alive) return;
      const rows = item.flow.asks.map((a, i) => {
        const id = `add-ask-${i}`;
        const set = (v: string) => (v.trim() ? (answers[a.key] = v.trim()) : delete answers[a.key]);
        const error = h("p", { class: "add-q__error", id: `${id}-error`, hidden: true });
        let field: HTMLElement;
        let focus: () => void;
        if (a.fills === "person") {
          const picker = personPicker({ value: null, label: a.question, placeholder: "Pick someone", onChange: (person) => set(person?.id ?? "") });
          field = picker.el;
          focus = picker.focus;
        } else if (a.fills === "text" && (a.choices.length || ((a.pick === "area" || a.pick === "where") && liveContexts(a.pick).length))) {
          const qid = `ask${i}`;
          let picked: AnswerMap = {};
          const own = a.pick === "area" || a.pick === "where";
          const choices = own ? liveContexts(a.pick as "area" | "where").map((c) => c.name) : a.choices;
          field = questionsForm([{ id: qid, question: a.question, choices, allowOther: !own }], picked, (m) => {
            picked = m;
            const raw = m[qid] ?? "";
            set(raw.startsWith("other:") ? raw.slice(6) : raw);
          });
          field.classList.add("add-q__choices");
          focus = () => field.querySelector<HTMLElement>("[role=radio]")?.focus();
        } else {
          const input = h("input", { class: "field", type: "text", maxlength: MAX_ANSWER, autocomplete: "off", id, "aria-describedby": `${id}-error` }) as HTMLInputElement;
          input.addEventListener("input", () => set(input.value));
          field = input;
          focus = () => input.focus();
        }
        checks.push(() => {
          const missing = !answers[a.key];
          error.hidden = !missing;
          error.textContent = missing ? "Answer this to add the flow." : "";
          return missing ? (focus(), a.question) : null;
        });
        const hint = fillsWords(a.fills, a.pick);
        // A row of choices labels itself (questionsForm); a field or picker gets the question as its label.
        const label = field.classList.contains("add-q__choices") ? null : h("label", { class: "tq__q", for: id }, a.question);
        return h("div", { class: "add-q" }, label, hint ? h("p", { class: "form__hint" }, hint) : null, field, error);
      });
      questionsSec = section("questions", "Its questions", h("p", { class: "form__hint add-sec__lede" }, "Each answer fills a gap in its steps. You'll see where below."), h("div", { class: "add-questions" }, ...rows));
    }

    // Check-in questions: every one, grouped by routine, as it would be asked; one the owner has already is marked.
    let joinsKinds: CheckinKind[] = [];
    let offNote: HTMLElement | null = null;
    if (item.kind === "checkin") {
      const have = checkinSettings ? promptsHere(checkinSettings) : new Set<string>();
      const fresh = item.checkins.questions.filter((q) => !have.has(samePrompt(q.prompt)));
      joinsKinds = CHECKIN_KINDS.filter((k) => fresh.some((q) => q.kinds.includes(k)));
      const off = checkinSettings ? joinsKinds.filter((k) => !checkinSettings[k].enabled) : [];
      const offText = offWords(off);
      offNote = offText ? h("p", { class: "add-note add-note--calm" }, icons.toggle(), h("span", {}, offText)) : null;
      const repeated = item.checkins.questions.length - fresh.length;
      questionsSec = section(
        "questions",
        item.checkins.questions.length === 1 ? "Its question" : `Its ${item.checkins.questions.length} questions`,
        h("p", { class: "form__hint add-sec__lede" }, repeated ? `Each one as it would be asked. ${repeated === 1 ? "You already have one of them" : `You already have ${repeated} of them`}, so ${repeated === 1 ? "it's" : "they're"} marked and won't be added twice.` : "Each one as it would be asked, one to a screen."),
        checkinPreview(item.checkins.questions, (q) => have.has(samePrompt(q.prompt)))
      );
    }

    // Accounts it may open: assistants and skills, all unticked, the ones it needs first.
    let accountsValue: () => string[] = () => [];
    let accountsSec: HTMLElement | null = null;
    if (item.kind === "assistant" || item.kind === "skill") {
      const who = item.kind === "assistant" ? name : "Ask";
      if (accounts) {
        const cantWork = cantWorkNote({ name, needs, accounts, nameOf: accountName });
        const t = accountTicks({ accounts, ticked: [], needs, idPrefix: "add-acct", label: `Accounts ${name} can open`, onTick: cantWork.update });
        cantWork.update([]);
        accountsValue = t.value;
        accountsSec = section(
          "accounts",
          "Accounts it can open",
          h("p", { class: "form__hint add-sec__lede" }, item.kind === "assistant" ? `${who} opens only the accounts you tick, in its runs and in chat. You can change this on its page.` : "Someone else wrote this skill. While Ask uses it, Ask opens only the accounts you tick here."),
          h("div", { class: "acct-rows" }, cantWork.el, t.el)
        );
      } else accountsSec = section("accounts", "Accounts it can open", h("p", { class: "form__hint" }, "Your accounts didn't load, so it will open none. You can tick them on its page once it's added."));
    }

    // What it may do alone.
    let allowValue: () => string[] = () => [];
    let webBox: HTMLInputElement | null = null;
    let aloneSec: HTMLElement | null = null;
    let asksFirstSec: HTMLElement | null = null;
    if (item.kind === "assistant") {
      const { offered, asksFirst } = splitWouldLike(item.shared.would_like);
      const ticks = offered.filter((tool) => SHARED_TOOLS[tool]).map((tool, i) => {
        const o = SHARED_TOOLS[tool];
        const box = h("input", { type: "checkbox", class: "wf-tick__box", value: tool, id: `add-allow-${i}` }) as HTMLInputElement;
        return { box, el: h("label", { class: "wf-tick", for: `add-allow-${i}` }, box, h("span", {}, h("span", { class: "wf-tick__label" }, o.label), o.detail ? h("span", { class: "row__meta" }, o.detail) : null)) };
      });
      allowValue = () => ticks.filter((t) => t.box.checked).map((t) => t.box.value);
      webBox = item.shared.web ? (h("input", { type: "checkbox", class: "wf-tick__box", id: "add-web" }) as HTMLInputElement) : null;
      aloneSec = section(
        "alone",
        "What it may do alone",
        ticks.length || webBox
          ? h("p", { class: "form__hint add-sec__lede" }, `${name} would like to do these without asking. Anything you leave unticked waits for your approval.`)
          : h("p", { class: "form__hint" }, `Nothing. Every change ${name} wants to make waits for your approval.`),
        ...ticks.map((t) => t.el),
        webBox ? h("label", { class: "wf-tick", for: "add-web" }, webBox, h("span", {}, h("span", { class: "wf-tick__label" }, "Search the web"), h("span", { class: "row__meta" }, "Searches and reads the pages it finds, while “Let Ask search the web” is on"))) : null
      );
      if (asksFirst.length)
        asksFirstSec = section(
          "asks-first",
          "Always asks first",
          h("p", { class: "form__hint add-sec__lede" }, `${name} also asked to do these alone. Something someone else shared can't, so each one waits for your approval.`),
          h("ul", { class: "wf-asks" }, ...asksFirst.map((t) => {
            const o = asksFirstWords(t);
            return h("li", { class: "wf-tick wf-tick--fixed" }, icons.shield(), h("span", {}, h("span", { class: "wf-tick__label" }, o.label), h("span", { class: "row__meta" }, o.detail)));
          }))
        );
    } else if (item.kind === "skill") {
      aloneSec = section("alone", "What it may do alone", h("p", { class: "form__hint" }, "Nothing. A skill only changes how Ask goes about a request: changes still wait for your approval, and nothing is sent."));
    } else if (item.kind === "checkin") {
      aloneSec = section("alone", "Where your answers go", h("p", { class: "add-usewhen" }, "They stay in your check-ins, with the rest of your answers. These questions don't copy them anywhere else, and they don't change how many questions you're asked each day."));
    } else {
      const lines: string[] = ["Every step that changes something waits for your approval, even if the flow asked to run on its own."];
      if (item.flow.steps.length && JSON.stringify(item.flow.steps).includes('"kind":"think"')) lines.push("Its thinking steps need an assistant. Choose one on the flow's page once it's added.");
      if (item.flow.money) lines.push("It asks to read your spending. That stays off until you allow it on the flow's page.");
      if (item.flow.web) lines.push("It asks to search the web. That stays off until you allow it.");
      aloneSec = section("alone", "What it may do alone", lines.length > 1 ? h("ul", { class: "add-bullets" }, ...lines.map((l) => h("li", {}, l))) : h("p", { class: "add-usewhen" }, lines[0]));
    }

    // Notes: sites its words link to, an earlier copy, a full team.
    const texts = item.kind === "assistant" ? [item.shared.instructions, item.shared.summary, item.skill?.body ?? "", ...(item.skill?.files.map((f) => f.text) ?? [])] : item.kind === "skill" ? [item.skill.body, ...item.skill.files.map((f) => f.text)] : item.kind === "checkin" ? [item.checkins.summary, ...item.checkins.questions.map((q) => q.prompt)] : [];
    const links = linkedHosts(texts);
    const notes = [
      links.length ? h("p", { class: "add-note" }, icons.globe(), h("span", {}, `Its words link to ${links.join(", ")}. Athena didn't check ${links.length === 1 ? "that site" : "those sites"}.`)) : null,
      !room ? h("p", { class: "add-note add-note--bad", role: "alert" }, icons.flag(), h("span", {}, `Your team has ${MAX_ASSISTANTS} assistants, the most it can have. Remove one to make room.`)) : null,
    ];

    // All of it, readable.
    const content = (() => {
      const pre = (text: string, cls = "") => h("pre", { class: `skill-pre add-pre${cls}` }, text);
      const fileDetails = (files: Array<{ path: string; text: string }>) => files.map((f) => h("details", { class: "skill-file" }, h("summary", {}, icons.note(), h("span", { class: "skill-file__name" }, f.path), h("span", { class: "skill-file__size" }, size(f.text))), pre(f.text)));
      const skipped = p.skipped.length ? h("div", { class: "add-skipped" }, h("p", { class: "add-sub" }, "Not used"), h("ul", { class: "skill-skipped", "aria-label": "Files not used" }, ...p.skipped.map((s) => h("li", {}, h("span", { class: "skill-file__name" }, s.path), h("span", { class: "skill-skipped__why" }, s.reason))))) : null;
      if (item.kind === "flow") return section("content", "Its steps", sharedFlowSteps(item.flow, catalog), skipped);
      // Its questions above are all of it; only files left out are listed.
      if (item.kind === "checkin") return skipped ? section("content", "Not used", skipped) : null;
      if (item.kind === "skill") {
        const s = item.skill;
        return section("content", "All of it", h("p", { class: "add-sub" }, "Use when"), h("p", { class: "add-usewhen" }, s.description), h("p", { class: "add-sub" }, "Instructions"), pre(s.body, " skill-pre--body"), s.files.length ? h("p", { class: "add-sub" }, s.files.length === 1 ? "1 file" : `${s.files.length} files`) : null, ...fileDetails(s.files), skipped);
      }
      const w = item.shared;
      const sk = item.skill;
      return section(
        "content",
        "All of it",
        h("p", { class: "add-sub" }, "When it runs"),
        h("ul", { class: "add-bullets" }, ...(w.triggers.length ? w.triggers.map((t) => h("li", {}, triggerSentence(t))) : [h("li", {}, "Only when you chat with it or tap Run now")])),
        h("p", { class: "add-sub" }, "Instructions"),
        pre(w.instructions || "None. It works from its job."),
        h("p", { class: "add-sub" }, "Skill"),
        sk ? pre(sk.body, " skill-pre--body") : h("p", { class: "form__hint" }, "It has no skill of its own. Athena writes one from its job and your answers when you add it."),
        ...(sk ? fileDetails(sk.files) : []),
        skipped
      );
    })();

    // Already here: say so first, with a way to open it, and Update when the listing is newer. A second copy is a
    // deliberate extra tap (the owner's decision, 24 Nov 2026).
    const had = p.existing;
    const w = had ? haveWords(p.kind, had, p.listing?.version ?? null) : null;
    let copyBtn: HTMLButtonElement | null = null;
    const haveCard =
      had && w
        ? h(
            "section",
            { class: `add-have${had.newer ? " add-have--newer" : ""}`, "aria-labelledby": "add-have-title" },
            h("span", { class: "add-have__icon", "aria-hidden": "true" }, had.newer ? icons.refresh() : icons.check()),
            h("div", { class: "add-have__text" }, h("h2", { class: "add-have__title", id: "add-have-title" }, w.title), h("p", { class: "add-have__sub" }, w.detail)),
            h("div", { class: "add-have__acts" }, h("a", { class: "btn btn--soft btn--sm", href: had.href }, w.open), (copyBtn = h("button", { class: "add-have__copy", type: "button" }, "Add a second copy") as HTMLButtonElement))
          )
        : null;
    let copying = !had;

    // Add, or Update.
    const addBtn = h("button", { class: "btn btn--primary add-foot__add", type: "button", disabled: !room && !had?.newer }, icons.plus(), addLabel(p.kind, name)) as HTMLButtonElement;
    const cancel = h("button", { class: "btn btn--ghost add-foot__cancel", type: "button" }, "Cancel");
    const problem = h("p", { class: "add-foot__problem", role: "alert", hidden: true });
    const label = () => (copying ? addLabel(p.kind, name) : had?.newer ? `Update ${name}` : w!.open);
    const paintFoot = () => {
      addBtn.replaceChildren(copying ? icons.plus() : had?.newer ? icons.refresh() : icons.arrowRight(), label());
      addBtn.disabled = copying && !room;
      if (copyBtn) copyBtn.hidden = copying;
    };
    copyBtn?.addEventListener("click", () => {
      copying = true;
      paintFoot();
      paintNote();
      addBtn.focus();
    });
    cancel.addEventListener("click", startOver);
    addBtn.addEventListener("click", async () => {
      if (had && !copying && !had.newer) {
        location.hash = had.href;
        return;
      }
      const missing = checks.map((c) => c()).find(Boolean);
      if (missing) {
        problem.hidden = false;
        problem.textContent = `Answer “${missing}” first.`;
        return;
      }
      problem.hidden = true;
      addBtn.disabled = true;
      addBtn.classList.add("is-busy");
      addBtn.lastChild!.textContent = copying ? "Adding…" : "Updating…";
      const choices: AddChoices = { answers: { ...answers }, accounts: accountsValue(), allow: allowValue(), web: !!webBox?.checked, money: false, assistant_id: null, replace: copying ? null : had!.id };
      try {
        const result = await addItem(p, choices);
        added(p.kind, name, result.href, !!result.updated, result, joinsKinds);
      } catch (error) {
        if (!alive) return;
        addBtn.disabled = false;
        addBtn.classList.remove("is-busy");
        addBtn.lastChild!.textContent = label();
        problem.hidden = false;
        problem.textContent = errorText(error);
      }
    });
    const footNote = h("p", { class: "add-foot__note" });
    const paintNote = () => (footNote.textContent = copying ? landsWords(p.kind) : had?.newer ? updateLandsWords(p.kind) : "");
    paintFoot();
    paintNote();
    const foot = h("div", { class: "add-foot" }, problem, h("div", { class: "add-foot__row" }, cancel, addBtn), footNote);

    if (p.kind === "checkin") el.classList.add("add--checkin");
    show(hero, haveCard, facts, reachCard, ...notes, offNote, needsSec, questionsSec, accountsSec, aloneSec, asksFirstSec, content, foot);
    focusHeading();
  }

  // ---------- added ----------

  function added(kind: ShareKind, name: string, href: string, updated = false, result?: AddResult, joins: CheckinKind[] = []) {
    const w = kind === "checkin" && result?.checkins && !updated ? checkinAddedWords(name, result.checkins, joins) : updated ? updatedWords(kind, name) : addedWords(kind, name);
    const open = h("a", { class: "btn btn--primary", href }, w.open, icons.arrowRight());
    const more = h("button", { class: "btn btn--soft", type: "button" }, "Add something else");
    more.addEventListener("click", startOver);
    show(
      h(
        "div",
        { class: "add-done", role: "status" },
        h("span", { class: "add-done__mark", "aria-hidden": "true" }, icons.check()),
        h("h1", { class: "page-title add-done__title", tabindex: "-1" }, w.title),
        h("p", { class: "add-done__body" }, w.body),
        h("div", { class: "add-done__actions" }, open, more)
      )
    );
    history.replaceState(history.state, "", "#/add");
    focusHeading();
  }

  // ---------- start ----------

  const source = parseAddHash(location.hash) ?? { files: [] };
  if ("catalogue" in source || "link" in source) {
    void load(() => previewAdd(source));
  } else {
    const held = takeHeldFiles();
    if (held) fromFiles(held);
    else {
      choose();
      // A file shared to the installed app waits in Cache Storage (sw.js).
      void takeSharedFile().then((f) => f && alive && fromFiles([f]));
    }
  }

  // Dropping a file or folder anywhere on the screen, while it's choosing.
  const over = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    el.classList.add("is-dragging");
  };
  const leave = (e: DragEvent) => {
    if (e.target === el || !el.contains(e.relatedTarget as Node)) el.classList.remove("is-dragging");
  };
  const dropped = async (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    el.classList.remove("is-dragging");
    fromFiles(await filesFromDrop(e.dataTransfer));
  };
  el.addEventListener("dragover", over);
  el.addEventListener("dragleave", leave);
  el.addEventListener("drop", (e) => void dropped(e));
  return {
    el,
    destroy: () => {
      alive = false;
    },
  };
}
