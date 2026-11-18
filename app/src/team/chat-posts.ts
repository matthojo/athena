/**
 * The cards a post or a stage draws, shared by Team chat (team/chat.ts) and
 * the assignment's page (team/assignment-page.ts): a question with its
 * choices, an approval with Go and Send back, a plan (Ask's own plan card),
 * a handoff, and the document. Each acts on the one record behind it, so a
 * Go or an answer anywhere settles it everywhere.
 */
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { whoMark } from "../components/ask-who";
import { answer, assignmentsChanged, downloadDocument, go, sendBack } from "../db/assignments";
import { getThread, requestOpen, saveThread } from "../db/ask-threads";
import { loadDocumentAccounts, PROVIDER_NAME, sendToDocuments, type DocumentProvider } from "../db/documents";
import { renderAvatarTile } from "./avatar";
import { answerBy, FORMAT_NAME, guestLine, ownerAnswers, sizeWords } from "./assign-words";
import type { Assignment, AssignmentStage, DocumentFile, Handoff, StageAnswer, StageQuestion, StageWho } from "../../../lib/assignment-types";

const failed = (e: unknown, fallback: string) => showToast(e instanceof Error && e.message && !/^\d{3} /.test(e.message) ? e.message : fallback, { icon: "refresh" });

/** Whoever posted, in the kit's tile; Ask wears Athena's mark. */
export function whoTile(who: StageWho | null, size: number, working = false): HTMLElement {
  if (!who) return whoMark({ name: "Athena", avatar: null }, size);
  const t = renderAvatarTile(who.avatar, { size, animate: false, ...(working ? { mood: "thinking" as const } : {}) });
  t.classList.add("who-tile");
  return t;
}

/** A name with what's under it: a guest says "Guest". */
export function whoWords(who: StageWho): HTMLElement {
  return h("span", { class: "who-words" }, h("span", { class: "who-words__name" }, who.name), h("span", { class: "who-words__sub" }, guestLine(who)));
}

// ---------- questions ----------

/** Questions already answered: each with its answer and whose it was. */
export function answersEl(answers: readonly StageAnswer[]): HTMLElement {
  return h(
    "dl",
    { class: "qa" },
    ...answers.flatMap((a) => [h("dt", { class: "qa__q" }, a.question), h("dd", { class: `qa__a${a.by === "suggested" ? " qa__a--suggested" : ""}` }, h("span", { class: "qa__answer" }, a.answer), h("span", { class: "qa__by" }, answerBy(a)))])
  );
}

/**
 * A stage's questions: the choices under each, the suggested one marked
 * with why, and the two ways to carry on without answering.
 */
export function questionCard(assignmentId: string, questions: readonly StageQuestion[], who: StageWho): HTMLElement {
  const picked: Array<string | undefined> = questions.map(() => undefined);
  const send = h("button", { class: "btn btn--primary btn--sm qcard__send", type: "button", disabled: true }, questions.length > 1 ? "Send answers" : "Send answer") as HTMLButtonElement;
  const useNow = h("button", { class: "btn btn--soft btn--sm", type: "button" }, questions.length > 1 ? "Use suggestions" : "Use suggestion") as HTMLButtonElement;
  const useOn = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Use suggestions from here on") as HTMLButtonElement;
  const buttons = [send, useNow, useOn];
  const count = () => (send.disabled = picked.some((p) => !p?.trim()));

  const groups = questions.map((q, qi) => {
    const other = q.allowOther ? (h("input", { class: "qcard__other", type: "text", placeholder: "Something else", "aria-label": `${q.question} Your own answer`, maxlength: 200 }) as HTMLInputElement) : null;
    const rows = q.choices.map((c, ci) => {
      const b = h(
        "button",
        { class: "qcard__choice", type: "button", "aria-pressed": "false" },
        h("span", { class: "qcard__mark", "aria-hidden": "true" }),
        h("span", { class: "qcard__text" }, c, ci === q.suggested ? h("span", { class: "qcard__why" }, h("span", { class: "qcard__tag" }, "Suggested"), q.why) : null)
      );
      b.addEventListener("click", () => {
        picked[qi] = picked[qi] === c ? undefined : c;
        if (other) other.value = "";
        for (const r of rows) r.setAttribute("aria-pressed", String(r === b && picked[qi] === c));
        count();
      });
      return b;
    });
    other?.addEventListener("input", () => {
      picked[qi] = other.value.trim() || undefined;
      for (const r of rows) r.setAttribute("aria-pressed", "false");
      count();
    });
    return h("div", { class: "qcard__group", role: "group", "aria-label": q.question }, h("p", { class: "qcard__question" }, q.question), ...rows, other);
  });

  const run = async (b: HTMLButtonElement, what: StageAnswer[] | { use: "suggested"; from_here?: boolean }) => {
    if (buttons.some((x) => x.getAttribute("aria-busy"))) return;
    b.setAttribute("aria-busy", "true");
    buttons.forEach((x) => (x.disabled = true));
    try {
      await answer(assignmentId, what);
      if (!Array.isArray(what) && what.from_here) showToast(`From here on, ${who.name} and the stages after take the suggested answer.`);
    } catch (e) {
      failed(e, "That didn't send. Try again in a moment.");
      b.removeAttribute("aria-busy");
      useNow.disabled = useOn.disabled = false;
      count();
    }
  };
  send.addEventListener("click", () => {
    const mine = ownerAnswers(questions, picked);
    if (mine) void run(send, mine);
  });
  useNow.addEventListener("click", () => void run(useNow, { use: "suggested" }));
  useOn.addEventListener("click", () => void run(useOn, { use: "suggested", from_here: true }));

  return h("section", { class: "card qcard", "aria-label": `${who.name} needs your answer` }, ...groups, h("div", { class: "qcard__foot" }, useOn, useNow, send));
}

// ---------- handoffs and approvals ----------

/** What a stage left for the next: what it did, what's open, where to look. Empty lines are left out. */
export function handoffEl(hd: Handoff, opts: { did?: boolean } = {}): HTMLElement | null {
  const rows: Array<[string, string]> = [];
  if (opts.did !== false && hd.did.trim()) rows.push(["What changed", hd.did]);
  if (hd.open.trim() && !/^nothing( is)? open\.?$/i.test(hd.open.trim())) rows.push(["Still open", hd.open]);
  if (hd.next.trim()) rows.push(["For the next stage", hd.next]);
  if (!rows.length) return null;
  return h("dl", { class: "handoff" }, ...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}

/** A stage that stopped for approval: Go carries on; Send back returns it to a stage with a note. */
export function approvalCard(a: Assignment, s: AssignmentStage): HTMLElement {
  const next = a.stages[s.position + 1];
  const goBtn = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Go") as HTMLButtonElement;
  const back = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-expanded": "false" }, "Send back") as HTMLButtonElement;
  const note = h("textarea", { class: "approve__note", rows: 2, placeholder: "What should change?", "aria-label": "A note to send back with it", maxlength: 1000 }) as HTMLTextAreaElement;
  note.value = s.note ?? "";
  // Back to the stage that waits, or to any before it.
  const to = h("select", { class: "approve__to", "aria-label": "Send it back to" }, ...a.stages.filter((x) => x.position <= s.position).reverse().map((x) => h("option", { value: String(x.position) }, x.who.name))) as HTMLSelectElement;
  const confirm = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Send back") as HTMLButtonElement;
  const cancel = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Cancel") as HTMLButtonElement;
  const form = h("div", { class: "approve__form", hidden: true }, h("label", { class: "approve__row" }, h("span", {}, "Send it back to"), to), note, h("div", { class: "approve__acts" }, cancel, confirm));
  const acts = h("div", { class: "approve__acts" }, back, goBtn);
  const open = (on: boolean) => {
    form.hidden = !on;
    acts.hidden = on;
    back.setAttribute("aria-expanded", String(on));
    if (on) note.focus();
    else back.focus();
  };
  back.addEventListener("click", () => open(true));
  cancel.addEventListener("click", () => open(false));
  const run = async (b: HTMLButtonElement, what: () => Promise<unknown>, fallback: string) => {
    if (b.getAttribute("aria-busy")) return;
    b.setAttribute("aria-busy", "true");
    try {
      await what();
    } catch (e) {
      failed(e, fallback);
      b.removeAttribute("aria-busy");
    }
  };
  goBtn.addEventListener("click", () => void run(goBtn, () => go(a.id), "Go didn't go through. Try again in a moment."));
  confirm.addEventListener("click", () => void run(confirm, () => sendBack(a.id, { to: Number(to.value), note: note.value.trim() }), "That didn't send. Try again in a moment."));
  const hd = s.handoff ? handoffEl(s.handoff) : null;
  return h(
    "section",
    { class: "card approve", "aria-label": `${s.who.name} needs your Go` },
    hd,
    h("p", { class: "approve__note-line" }, next ? `Go lets ${next.who.name} start. Nothing after this stage has run.` : "Go finishes the assignment."),
    acts,
    form
  );
}

// ---------- a plan: Ask's own card ----------

type Kept = { plan?: unknown; changes?: unknown[]; undone?: string[]; gone?: string[]; reply?: { plan?: unknown; changes?: unknown[] } | null; at: string };

/**
 * The plan a run's conversation holds, drawn with Ask's plan card. Go runs
 * it there and here alike: the conversation is saved, so every count drops.
 * Null when the conversation isn't on this device (it opens in Ask instead).
 */
export async function planCard(threadId: string, name?: string): Promise<HTMLElement | null> {
  const thread = await getThread(threadId).catch(() => null);
  if (!thread) return null;
  const messages = thread.messages as unknown as Kept[];
  const m = [...messages].reverse().find((x) => (x.plan ?? x.reply?.plan) != null);
  if (!m) return null;
  const { planEl } = await import("../views/ask");
  const inReply = !!m.reply?.plan;
  type Acting = Parameters<typeof planEl>[0];
  const acting = { undone: new Set(m.undone ?? []), undoing: new Set<string>(), gone: new Set(m.gone ?? []), answered: true, at: m.at, reply: { plan: inReply ? m.reply!.plan : m.plan, changes: [...((inReply ? m.reply!.changes : m.changes) ?? [])] } } as unknown as Acting;
  const slot = h("div", { class: "plan-slot" });
  const save = () => {
    const r = acting.reply!;
    if (inReply) Object.assign(m.reply!, { plan: r.plan, changes: r.changes });
    else Object.assign(m, { plan: r.plan, changes: r.changes });
    Object.assign(m, { undone: [...acting.undone], gone: [...acting.gone] });
    // Saving tells the counts (onThreadsChange); a stage's plan is settled by the server, so assignments look again too.
    void saveThread({ ...thread, updated_at: new Date().toISOString() }).then(assignmentsChanged, () => undefined);
  };
  const paint = () => {
    const card = planEl(acting, acting.reply!.plan!, paint, save);
    // In its own words, as in its conversation: "Dot suggests", never "Your routine suggests".
    const head = card.querySelector(".plan__head")?.lastChild;
    if (name && head?.textContent === "Your routine suggests") head.textContent = `${name} suggests`;
    slot.replaceChildren(card);
  };
  paint();
  return slot;
}

/** A plan whose conversation isn't here: open it in Ask, where its card is. */
export function planElsewhere(threadId: string | null, name: string): HTMLElement {
  const b = h("button", { class: "btn btn--soft btn--sm", type: "button" }, `Open ${name}'s plan in Ask`);
  b.addEventListener("click", () => {
    if (threadId) requestOpen(threadId);
    location.hash = "#/ask";
  });
  return b;
}

// ---------- the document ----------

/** The finished document: each file with Download, and Send to Google Docs or Notion. */
export function documentCard(title: string, noteId: string | null, files: readonly DocumentFile[], opts: { openNote?: boolean } = {}): HTMLElement {
  const rows = files.map((f) => {
    const b = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Download ${f.name}` }, "Download") as HTMLButtonElement;
    b.addEventListener("click", async () => {
      if (b.getAttribute("aria-busy")) return;
      b.setAttribute("aria-busy", "true");
      try {
        await downloadDocument(f);
      } catch (e) {
        failed(e, "The download didn't start. Try again in a moment.");
      } finally {
        b.removeAttribute("aria-busy");
      }
    });
    return h("li", { class: "doc__file" }, h("span", { class: "doc__icon", "aria-hidden": "true" }, icons.note()), h("span", { class: "doc__name" }, h("span", { class: "doc__title" }, f.name), h("span", { class: "doc__meta" }, `${FORMAT_NAME[f.format]} · ${sizeWords(f.size)}`)), b);
  });

  const menu = h("div", { class: "doc__send-menu", hidden: true });
  const sendBtn = h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-expanded": "false" }, "Send to…") as HTMLButtonElement;
  const sendTo = async (to: DocumentProvider, b: HTMLButtonElement) => {
    if (!noteId || b.getAttribute("aria-busy")) return;
    b.setAttribute("aria-busy", "true");
    try {
      const r = await sendToDocuments(noteId, title, to);
      showToast(`${r.updated ? "Updated in" : "Sent to"} ${PROVIDER_NAME[to]}`, { action: { label: "Open", run: () => window.open(r.export.url, "_blank", "noopener") } });
      menu.hidden = true;
      sendBtn.setAttribute("aria-expanded", "false");
    } catch (e) {
      failed(e, `That didn't reach ${PROVIDER_NAME[to]}. Try again in a moment.`);
    } finally {
      b.removeAttribute("aria-busy");
    }
  };
  sendBtn.addEventListener("click", async () => {
    const on = menu.hidden;
    menu.hidden = !on;
    sendBtn.setAttribute("aria-expanded", String(on));
    if (!on || menu.childElementCount) return;
    const accounts = await loadDocumentAccounts().catch(() => []);
    const have = new Set(accounts.map((x) => x.provider));
    const items = (["google-docs", "notion"] as DocumentProvider[]).map((to) => {
      const b = h("button", { class: "btn btn--soft btn--sm", type: "button" }, PROVIDER_NAME[to]) as HTMLButtonElement;
      b.addEventListener("click", () => void sendTo(to, b));
      return b;
    });
    menu.replaceChildren(...items, have.size ? "" : h("p", { class: "doc__hint" }, "Connect Google Docs or Notion in Settings → Sources first."));
  });

  return h(
    "section",
    { class: "card doc", "aria-label": "The document" },
    h("p", { class: "doc__head" }, "The document"),
    files.length ? h("ul", { class: "doc__files" }, ...rows) : h("p", { class: "doc__hint" }, "No file has been made from it yet."),
    noteId ? h("div", { class: "doc__acts" }, opts.openNote ? h("a", { class: "btn btn--ghost btn--sm", href: `#/notes/${encodeURIComponent(noteId)}` }, "Open the note") : null, sendBtn) : null,
    menu
  );
}
