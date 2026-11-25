/**
 * Settings → Check-ins (#/settings/checkins). Each routine, the morning
 * preparation and the evening reflection: on or off, how many questions a
 * day (1 to 10), its questions in the order they're asked (up and down),
 * which are asked every day (pinned), remove, and add from the library.
 * Below, the owner's own questions: write one with a type picker (a scale
 * with its sentence and five steps, choices, areas, or a written answer),
 * change it, or delete it. Every change saves the whole set-up at once
 * (PUT /api/checkins/settings) and needs a connection. Times live with
 * Notifications (components/notification-settings.ts), linked from here.
 *
 * Sharing (lib/checkin-share.ts): "Share" under your questions opens a sheet
 * to pick some and download them as a file (checkin-share-sheet.ts). Sets
 * added from a file or Community are listed under "From other people", each
 * with its questions, a switch (off: its questions wait) and Remove, and
 * Community's word on it (an update, or that it was taken down). A question
 * from a set says so in its routine. "Browse Community" opens the check-in
 * questions there.
 */

import "../styles/checkin.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { DELETE_OWN_BODY, moved, ownAnswersWords, OWN_ANSWERS_WORDS, ownId, ownQuestionProblem, ROUTINE_NAME, TYPE_NAME } from "./checkin-rules";
import { loadCheckinSettings, removeCheckinSet, saveCheckinSettings, setCheckinSetPaused, type CheckinSet, type CheckinSettings, type CheckinSettingsView } from "../db/checkins";
import { catalogueStatus } from "../community/status";
import { communityHash } from "../community/words";
import { forgetUpdates } from "../db/community";
import { fromSetWords, removeSetBody, SETS_ANSWERS_WORDS, setMetaWords, setSwitchWords } from "./checkin-share-words";
import { AREAS, CHECKIN_KINDS, EMOTIONS, MAX_OWN_QUESTIONS, MAX_PER_DAY, MORE_AREAS, MORE_EMOTIONS, ownMirror, type CheckinKind, type CheckinQuestion, type QuestionType } from "../../../lib/checkin-types";

export const TYPE_ICON: Record<QuestionType, IconName> = { scale: "sliders", choices: "tag", areas: "target", text: "pen" };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

export function checkinSettingsSection(ctx: { openNotifications: () => void }): { el: HTMLElement; destroy: () => void } {
  let view: CheckinSettingsView | null = null;
  let draft: CheckinSettings | null = null;
  let failed = false;
  let dead = false;

  const body = h("div", { class: "checkin-set" });
  const times = h("button", { class: "settings__link", type: "button" }, "Notifications");
  times.addEventListener("click", ctx.openNotifications);
  const el = h(
    "section",
    { class: "settings__section settings__section--checkins", "aria-labelledby": "settings-checkins" },
    h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-checkins" }, icons.chat(), "Check-ins")),
    h("p", { class: "settings__lede" }, "A few questions to start the day and a few to end it, one to a screen. Changes apply from the next check-in."),
    h("p", { class: "settings__note" }, icons.bell(), "Set the reminder times in ", times),
    body
  );

  const library = (): CheckinQuestion[] => view?.library ?? [];
  const find = (id: string) => draft?.own.find((q) => q.id === id) ?? library().find((q) => q.id === id);
  const setOf = (q: CheckinQuestion): CheckinSet | null => (q.set ? (view?.sets.find((x) => x.id === q.set) ?? null) : null);
  /** "Yours", or the set it came from: a question's word on whose it is. Null for Athena's own. */
  const whose = (q: CheckinQuestion): string | null => {
    if (q.preset) return null;
    const set = setOf(q);
    return set ? fromSetWords(set.name, set.paused) : "Yours";
  };

  async function save(next: CheckinSettings) {
    const before = draft;
    draft = next;
    paint();
    try {
      view = await saveCheckinSettings(next);
      if (dead) return;
      draft = { morning: view.morning, evening: view.evening, own: view.own };
      paint();
    } catch (error) {
      draft = before;
      paint();
      const offline = !navigator.onLine || error instanceof TypeError;
      showToast(offline ? "Changing check-ins needs a connection" : error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff", timeoutMs: 4000 });
    }
  }

  const change = (fn: (s: CheckinSettings) => void) => {
    if (!draft) return;
    const next = clone(draft);
    fn(next);
    void save(next);
  };

  function routineCard(kind: CheckinKind): HTMLElement {
    const r = draft![kind];
    const id = `checkin-on-${kind}`;
    const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-sub` }) as HTMLInputElement;
    sw.checked = r.enabled;
    sw.addEventListener("change", () => change((s) => (s[kind].enabled = sw.checked)));

    const count = Math.min(r.per_day, MAX_PER_DAY);
    const step = (dir: -1 | 1) => {
      const b = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": dir < 0 ? "One fewer" : "One more", disabled: dir < 0 ? count <= 1 : count >= MAX_PER_DAY }, dir < 0 ? icons.minus() : icons.plus());
      b.addEventListener("click", () => change((s) => (s[kind].per_day = Math.min(MAX_PER_DAY, Math.max(1, s[kind].per_day + dir)))));
      return b;
    };
    const perDay = h(
      "div",
      { class: "checkin-set__perday" },
      h("span", { class: "checkin-set__perday-label", id: `${id}-count` }, "Questions a day"),
      h("span", { class: "checkin-set__stepper", role: "group", "aria-labelledby": `${id}-count` }, step(-1), h("output", { class: "checkin-set__count", "aria-live": "polite" }, String(count)), step(1))
    );
    const pinnedCount = r.questions.filter((q) => q.pinned).length;
    const asked = r.questions.length < count ? `All ${r.questions.length} are asked each day. Add more to take turns.` : pinnedCount >= count ? "Only the pinned ones are asked: there's no room for the others to take turns." : "Pinned ones are asked every day. The rest take turns.";

    const rows = r.questions.map((x, i) => {
      const q = find(x.id);
      if (!q) return null;
      const pin = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost checkin-set__pin", type: "button", "aria-pressed": String(x.pinned), "aria-label": `Ask “${q.prompt}” every day` }, icons.thumbtack());
      pin.addEventListener("click", () => change((s) => (s[kind].questions[i].pinned = !x.pinned)));
      const arrow = (dir: "up" | "down") => {
        const to = dir === "up" ? i - 1 : i + 1;
        const b = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "data-dir": dir, "aria-label": `Move “${q.prompt}” ${dir}`, disabled: to < 0 || to >= r.questions.length }, dir === "up" ? icons.arrowUp() : icons.arrowDown());
        b.addEventListener("click", () => change((s) => (s[kind].questions = moved(s[kind].questions, i, to))));
        return b;
      };
      const remove = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Remove “${q.prompt}”` }, icons.close());
      remove.addEventListener("click", () => change((s) => s[kind].questions.splice(i, 1)));
      return h(
        "div",
        { class: `row checkin-set__row${setOf(q)?.paused ? " is-waiting" : ""}`, "data-id": x.id },
        h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[TYPE_ICON[q.type]]()),
        h("span", { class: "row__body" }, h("span", { class: "row__title" }, q.prompt), h("span", { class: "row__meta" }, [TYPE_NAME[q.type], whose(q), x.pinned ? "Every day" : null].filter(Boolean).join(" · "))),
        h("span", { class: "checkin-set__tools" }, pin, arrow("up"), arrow("down"), remove)
      );
    });

    const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add a question");
    add.addEventListener("click", () => openLibrary(kind));
    return h(
      "div",
      { class: `card checkin-set__routine${r.enabled ? "" : " is-off"}` },
      h(
        "label",
        { class: "checkin-set__switch", for: id },
        h("span", { class: "checkin-set__words" }, h("span", { class: "checkin-set__name" }, ROUTINE_NAME[kind]), h("span", { class: "checkin-set__sub", id: `${id}-sub` }, r.enabled ? `On. ${count} ${count === 1 ? "question" : "questions"} a day.` : "Off")),
        sw
      ),
      perDay,
      h("p", { class: "checkin-set__hint" }, asked),
      rows.some(Boolean) ? h("div", { class: "card card--flush list checkin-set__list" }, ...rows) : h("p", { class: "checkin-set__hint" }, "No questions yet."),
      h("div", { class: "settings__actions" }, add)
    );
  }

  function ownCard(): HTMLElement {
    const all = draft!.own;
    const own = all.filter((q) => !q.set);
    const rows = own.map((q) => {
      const b = h(
        "button",
        { class: "row checkin-set__row", type: "button", "aria-label": `${q.prompt}. Edit` },
        h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[TYPE_ICON[q.type]]()),
        h("span", { class: "row__body" }, h("span", { class: "row__title" }, q.prompt), h("span", { class: "row__meta" }, [TYPE_NAME[q.type], q.kinds.map((k) => (k === "morning" ? "Morning" : "Evening")).join(" and ")].join(" · "))),
        h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight())
      );
      b.addEventListener("click", () => openEditor(q));
      return b;
    });
    const add = h("button", { class: "btn btn--soft btn--sm", type: "button", disabled: all.length >= MAX_OWN_QUESTIONS }, icons.plus(), "Write your own");
    add.addEventListener("click", () => openEditor(null));
    const share = h("button", { class: "btn btn--ghost btn--sm", type: "button", disabled: !own.length }, icons.external(), "Share");
    share.addEventListener("click", () => void import("./checkin-share-sheet").then((m) => m.openShareCheckins(draft?.own ?? [])));
    return h(
      "div",
      { class: "checkin-set__own" },
      h("h3", { class: "checkin-set__title" }, "Your questions"),
      own.length ? h("div", { class: "card card--flush list" }, ...rows) : h("p", { class: "checkin-set__hint" }, "Ask yourself something Athena's questions don't cover."),
      h("p", { class: "checkin-set__hint" }, OWN_ANSWERS_WORDS),
      h("div", { class: "settings__actions" }, add, share)
    );
  }

  // ---------- Sets from other people ----------
  async function changeSet(fn: () => Promise<CheckinSettingsView>, done: string) {
    try {
      view = await fn();
      if (dead) return;
      draft = { morning: view.morning, evening: view.evening, own: view.own };
      forgetUpdates();
      paint();
      showToast(done, { icon: "check" });
    } catch (error) {
      const offline = !navigator.onLine || error instanceof TypeError;
      showToast(offline ? "Changing check-ins needs a connection" : error instanceof Error ? error.message : "That didn't save", { icon: "wifiOff", timeoutMs: 4000 });
      paint();
    }
  }

  function setCard(set: CheckinSet): HTMLElement {
    const qs = draft!.own.filter((q) => q.set === set.id);
    const id = `checkin-set-${set.id.slice(0, 8)}`;
    const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-sub` }) as HTMLInputElement;
    sw.checked = !set.paused;
    sw.addEventListener("change", () => {
      sw.disabled = true;
      void changeSet(() => setCheckinSetPaused(set.id, !sw.checked), sw.checked ? `${set.name} is on again` : `${set.name} is switched off`);
    });
    const remove = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, icons.trash(), "Remove");
    remove.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: `Remove ${set.name}?`, body: removeSetBody, confirmLabel: "Remove", danger: true }))) return;
      void changeSet(() => removeCheckinSet(set.id), `Removed ${set.name}`);
    });
    const questions = h(
      "details",
      { class: "checkin-set__qs" },
      h("summary", {}, qs.length === 1 ? "Its question" : `Its ${qs.length} questions`, icons.chevronDown()),
      h(
        "div",
        { class: "card card--flush list" },
        ...qs.map((q) => {
          const b = h(
            "button",
            { class: "row checkin-set__row", type: "button", "aria-label": `${q.prompt}. Edit` },
            h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[TYPE_ICON[q.type]]()),
            h("span", { class: "row__body" }, h("span", { class: "row__title" }, q.prompt), h("span", { class: "row__meta" }, [TYPE_NAME[q.type], q.kinds.map((k) => (k === "morning" ? "Morning" : "Evening")).join(" and ")].join(" · "))),
            h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight())
          );
          b.addEventListener("click", () => openEditor(q));
          return b;
        })
      )
    );
    return h(
      "article",
      { class: `card checkin-set__set${set.paused ? " is-off" : ""}`, "data-set": set.id },
      h(
        "div",
        { class: "checkin-set__set-head" },
        h("span", { class: "tile tile--sm checkin-set__set-tile", "aria-hidden": "true" }, icons.chat()),
        h("span", { class: "row__body" }, h("span", { class: "row__title" }, set.name), h("span", { class: "row__meta" }, setMetaWords(set, qs.length))),
        h("label", { class: "visually-hidden", for: id }, `Ask the questions from ${set.name}`),
        sw
      ),
      set.summary ? h("p", { class: "checkin-set__set-summary" }, set.summary) : null,
      h("p", { class: "checkin-set__hint", id: `${id}-sub` }, setSwitchWords(set.paused)),
      set.catalogue_id ? catalogueStatus("checkin", set.id, { actions: false }) : null,
      qs.length ? questions : null,
      h("div", { class: "settings__actions" }, remove)
    );
  }

  function setsCard(): HTMLElement {
    const sets = view?.sets ?? [];
    const browse = h("a", { class: "btn btn--soft btn--sm", href: communityHash("checkin") }, icons.globe(), "Browse Community");
    const file = h("a", { class: "btn btn--ghost btn--sm", href: "#/add" }, icons.plus(), "Add from a file");
    return h(
      "div",
      { class: "checkin-set__own checkin-set__others" },
      h("h3", { class: "checkin-set__title" }, "From other people"),
      ...(sets.length
        ? [h("p", { class: "checkin-set__hint" }, "Questions you added from Community or a file. Switch a set off and its questions wait; remove it and they go."), h("p", { class: "checkin-set__hint" }, SETS_ANSWERS_WORDS)]
        : [h("p", { class: "checkin-set__hint" }, "Other people share the questions they ask themselves. Have a look for some that suit you.")]),
      ...sets.map(setCard),
      h("div", { class: "settings__actions" }, browse, file)
    );
  }

  function paint() {
    if (dead) return;
    if (!draft) {
      body.replaceChildren(
        failed
          ? h("div", { class: "empty settings__empty" }, h("p", { class: "empty__title" }, "Check-ins didn't load"), h("p", { class: "empty__sub" }, "They need a connection the first time. Check you're online and try again."))
          : h("div", { class: "card checkin-set__routine" }, h("span", { class: "skeleton", style: "height:14px;width:50%" }), h("span", { class: "skeleton", style: "height:14px;width:80%" }))
      );
      return;
    }
    body.replaceChildren(...CHECKIN_KINDS.map(routineCard), ownCard(), setsCard());
  }

  // ---------- Add from the library ----------
  function openLibrary(kind: CheckinKind) {
    const list = h("div", { class: "checkin-lib" });
    const sheet = openSheet({ label: "Add a question", title: `Add to the ${ROUTINE_NAME[kind].toLowerCase()}`, body: list });
    const paintLib = () => {
      const have = new Set(draft?.[kind].questions.map((x) => x.id));
      const all = [...library().filter((q) => q.preset), ...(draft?.own ?? [])].filter((q) => q.kinds.includes(kind) && !have.has(q.id));
      const write = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, icons.pen(), "Write your own");
      write.addEventListener("click", () => {
        sheet.close();
        openEditor(null, kind);
      });
      list.replaceChildren(
        all.length
          ? h(
              "div",
              { class: "card card--flush list" },
              ...all.map((q) => {
                const b = h(
                  "button",
                  { class: "row", type: "button" },
                  h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[TYPE_ICON[q.type]]()),
                  h("span", { class: "row__body" }, h("span", { class: "row__title" }, q.prompt), h("span", { class: "row__meta" }, [TYPE_NAME[q.type], whose(q)].filter(Boolean).join(" · "))),
                  h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.plus())
                );
                b.addEventListener("click", () => {
                  change((s) => s[kind].questions.push({ id: q.id, pinned: false }));
                  showToast(`Added to the ${ROUTINE_NAME[kind].toLowerCase()}`, { icon: "check" });
                  sheet.close();
                });
                return b;
              })
            )
          : h("p", { class: "checkin-set__hint" }, "Every question that fits is already in."),
        h("div", { class: "settings__actions" }, write)
      );
    };
    paintLib();
  }

  // ---------- Write or change your own ----------
  function openEditor(was: CheckinQuestion | null, forKind?: CheckinKind) {
    const q: CheckinQuestion = was
      ? clone(was)
      : { id: ownId(), type: "scale", prompt: "", kinds: forKind ? [forKind] : ["morning", "evening"], low: "Not at all", high: "Very", lead: "", levels: ["", "", "", "", ""], mirror: ownMirror("scale"), preset: false };
    const form = h("form", { class: "checkin-edit", novalidate: true }) as HTMLFormElement;
    const sheet = openSheet({ label: was ? "Change your question" : "Write a question", title: was ? "Your question" : "New question", body: form, variant: "tall" });

    const input = (label: string, value: string, set: (v: string) => void, attrs: Record<string, string | number> = {}) => {
      const id = `ce-${Math.random().toString(36).slice(2, 8)}`;
      const f = h("input", { class: "field", id, value, ...attrs }) as HTMLInputElement;
      f.addEventListener("input", () => set(f.value));
      return h("div", { class: "checkin-edit__field" }, h("label", { class: "field-label", for: id }, label), f);
    };
    const lines = (label: string, value: string[] | undefined, set: (v: string[]) => void) => {
      const id = `ce-${Math.random().toString(36).slice(2, 8)}`;
      const f = h("textarea", { class: "field checkin-edit__lines", id, rows: 5 }) as HTMLTextAreaElement;
      f.value = (value ?? []).join("\n");
      f.addEventListener("input", () => set(f.value.split("\n").map((x) => x.trim()).filter(Boolean)));
      return h("div", { class: "checkin-edit__field" }, h("label", { class: "field-label", for: id }, label), f, h("p", { class: "form__hint" }, "One a line."));
    };

    const typeFields = h("div", { class: "checkin-edit__type-fields" });
    // Where this question's answers go, for the kind of answer picked: said where the question is written.
    const goes = h("p", { class: "form__hint checkin-edit__goes" });
    const paintType = () => {
      const t = q.type;
      goes.replaceChildren(icons.note(), h("span", {}, ownAnswersWords(t)));
      if (t === "scale") {
        q.levels ??= ["", "", "", "", ""];
        q.low ??= "Not at all";
        q.high ??= "Very";
        q.lead ??= "";
        typeFields.replaceChildren(
          input("Start of the sentence", q.lead, (v) => (q.lead = v), { placeholder: "Today I feel" }),
          h(
            "fieldset",
            { class: "checkin-edit__levels" },
            h("legend", { class: "field-label" }, "Five steps, lowest first"),
            ...q.levels.map((l, i) => {
              const f = h("input", { class: "field", value: l, "aria-label": `Step ${i + 1}`, placeholder: ["drained", "a bit low", "okay", "good", "great"][i] }) as HTMLInputElement;
              f.addEventListener("input", () => (q.levels![i] = f.value));
              return f;
            })
          ),
          h("div", { class: "checkin-edit__pair" }, input("Low end", q.low, (v) => (q.low = v)), input("High end", q.high, (v) => (q.high = v)))
        );
      } else if (t === "choices" || t === "areas") {
        q.options ??= t === "areas" ? [...AREAS] : [...EMOTIONS];
        q.more ??= t === "areas" ? [...MORE_AREAS] : [...MORE_EMOTIONS];
        typeFields.replaceChildren(
          lines("Choices", q.options, (v) => (q.options = v)),
          lines(t === "areas" ? "More, behind Show all" : "More, behind Show more", q.more, (v) => (q.more = v)),
          ...(t === "areas" ? [h("p", { class: "form__hint" }, "Athena's areas have their own icons. Others get a tag.")] : [])
        );
      } else {
        const id = "ce-deeper";
        const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id }) as HTMLInputElement;
        sw.checked = !!q.deeper;
        sw.addEventListener("change", () => (q.deeper = sw.checked));
        typeFields.replaceChildren(
          input("Hint in the empty box", q.placeholder ?? "", (v) => (q.placeholder = v), { placeholder: "A few words is enough." }),
          h("label", { class: "checkin-set__switch", for: id }, h("span", { class: "checkin-set__words" }, h("span", { class: "checkin-set__name" }, "Offer Go deeper"), h("span", { class: "checkin-set__sub" }, "Athena asks one follow-up question, which you can answer or skip.")), sw)
        );
      }
    };

    const types = h(
      "div",
      { class: "checkin-edit__types", role: "radiogroup", "aria-label": "Kind of answer" },
      ...(["scale", "choices", "areas", "text"] as const).map((t) => {
        const b = h("button", { class: "checkin-edit__type", type: "button", role: "radio", "aria-checked": String(q.type === t) }, icons[TYPE_ICON[t]](), TYPE_NAME[t]);
        b.addEventListener("click", () => {
          if (q.type === t) return;
          q.type = t;
          types.querySelectorAll("[role=radio]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
          paintType();
        });
        return b;
      })
    );

    const kindBox = (k: CheckinKind) => {
      const c = h("input", { type: "checkbox", class: "checkin-edit__check" }) as HTMLInputElement;
      c.checked = q.kinds.includes(k);
      c.addEventListener("change", () => (q.kinds = CHECKIN_KINDS.filter((x) => (x === k ? c.checked : q.kinds.includes(x)))));
      return h("label", { class: "checkin-edit__kind" }, c, k === "morning" ? "Morning" : "Evening");
    };

    const problem = h("p", { class: "form__error", role: "alert" });
    const del = was ? h("button", { class: "btn btn--ghost btn--danger", type: "button" }, icons.trash(), "Delete") : null;
    del?.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Delete this question?", body: DELETE_OWN_BODY, confirmLabel: "Delete", danger: true }))) return;
      change((s) => {
        s.own = s.own.filter((x) => x.id !== q.id);
        for (const k of CHECKIN_KINDS) s[k].questions = s[k].questions.filter((x) => x.id !== q.id);
      });
      sheet.close();
    });

    form.append(
      h("div", { class: "checkin-edit__field" }, h("span", { class: "field-label" }, "Kind of answer"), types),
      input("Question", q.prompt, (v) => (q.prompt = v), { placeholder: "How did you sleep?", maxlength: 160 }),
      h("fieldset", { class: "checkin-edit__kinds" }, h("legend", { class: "field-label" }, "Ask it in"), kindBox("morning"), kindBox("evening")),
      typeFields,
      goes,
      problem,
      h("div", { class: "checkin-edit__foot" }, del, h("span", { class: "checkin__spacer" }), h("button", { class: "btn btn--primary", type: "submit" }, icons.check(), "Save"))
    );
    paintType();

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      // Only what this type uses is kept.
      // A question from a set stays that set's, so Remove and the switch still find it.
      // Where answers go is Athena's to say, by type (ownMirror), for the owner's own and a set's alike; the server says it again.
      const out: CheckinQuestion = { id: q.id, type: q.type, prompt: q.prompt.trim(), kinds: q.kinds, mirror: ownMirror(q.type), preset: false, ...(q.set ? { set: q.set } : {}) };
      if (q.type === "scale") Object.assign(out, { lead: q.lead?.trim(), levels: q.levels?.map((l) => l.trim()), low: q.low?.trim() || "Not at all", high: q.high?.trim() || "Very" });
      if (q.type === "choices" || q.type === "areas") Object.assign(out, { options: q.options, more: q.more?.length ? q.more : undefined });
      if (q.type === "text") Object.assign(out, { placeholder: q.placeholder?.trim() || undefined, deeper: !!q.deeper });
      const why = ownQuestionProblem(out);
      problem.textContent = why ?? "";
      if (why) return;
      change((s) => {
        const at = s.own.findIndex((x) => x.id === out.id);
        if (at >= 0) s.own[at] = out;
        else s.own.push(out);
        // In the routines it's asked in, and out of any it no longer is.
        for (const k of CHECKIN_KINDS) {
          const has = s[k].questions.some((x) => x.id === out.id);
          if (out.kinds.includes(k) && !has) s[k].questions.push({ id: out.id, pinned: false });
          if (!out.kinds.includes(k) && has) s[k].questions = s[k].questions.filter((x) => x.id !== out.id);
        }
      });
      sheet.close();
    });
  }

  paint();
  loadCheckinSettings().then(
    (v) => {
      view = v;
      draft = { morning: v.morning, evening: v.evening, own: v.own };
      paint();
    },
    () => {
      failed = true;
      paint();
    }
  );
  return {
    el,
    destroy: () => {
      dead = true;
    },
  };
}
