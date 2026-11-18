/**
 * Team chat (docs/team.md "Team chat"): #/team/chat, and #/team/chat/<post
 * id> to open it at a post. One channel for the whole team, standing
 * assistants and guests alike.
 *
 *   the strip   what waits for you, oldest first; its rows are the one count
 *               used everywhere (team/waiting.ts). A run that didn't finish
 *               has Dismiss
 *   threads     one per assignment (its lineup first, its stages under it),
 *               folded to its latest post and whatever waits; other posts
 *               stand alone
 *   posts       each in its assistant's tile and voice; a plan is Ask's
 *               plan card, a question has its choices, an approval has Go
 *               and Send back
 *   the box     a reply in a thread goes to the stage that waits; "@Name"
 *               to that assistant; anything else to Ask
 *
 * It looks again when anything that can settle a post changes, and every
 * few seconds while a stage is working. A thread is redrawn only when it
 * changed, so a half-picked answer stays put.
 */
import "../styles/team-assign.css";
import "../styles/ask-plans.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { dismissPost, getChat, onChatChange, say, type TeamChat, type TeamPost } from "../db/team-chat";
import { listAssignments, type Assignment } from "../db/assignments";
import { whenShort } from "./page-words";
import { paintWho } from "./dot-colour";
import { assignmentLine, threadCount, threadsOf, thingsWait, waitingPosts, waitTitle, WAITS_WORD, type ChatThread } from "./assign-words";
import { answersEl, approvalCard, documentCard, handoffEl, planCard, planElsewhere, questionCard, whoTile, whoWords } from "./chat-posts";
import { openNewAssignment } from "./new-assignment";
import { isSampleMode } from "../db/api";

const BADGE: Partial<Record<TeamPost["kind"], string>> = { failed: "Didn't finish", done: "Done" };

/** One post: who, when, what it said, and the card its kind carries. */
function postEl(p: TeamPost, a: Assignment | undefined): HTMLElement {
  const waits = !!p.waits_for && !p.settled_at;
  const stage = a?.stages.find((s) => s.id === p.stage_id);
  const working = p.kind === "update" && stage?.status === "running" && a?.status === "running" && a.stages.every((s) => s.status !== "running" || s.id === stage.id) && isLatestOf(p, a);
  // A run that didn't finish waits only to be dismissed: it keeps its own badge.
  const asks = waits && p.waits_for !== "dismiss";
  const badge = asks ? WAITS_WORD[p.waits_for!] : BADGE[p.kind];
  const body = h("div", { class: "tpost__body" });
  if (p.from === "owner") {
    return h("li", { class: "tpost tpost--me", id: `post-${p.id}`, tabindex: -1 }, h("div", { class: "tpost__bubble" }, p.text), h("span", { class: "tpost__when" }, whenShort(p.created_at)));
  }
  body.append(h("p", { class: "tpost__text" }, p.text));
  if (p.kind === "handoff" && p.handoff) {
    const hd = handoffEl(p.handoff, { did: false });
    if (hd) body.append(hd);
  } else if (p.kind === "question") {
    if (waits && p.assignment_id && p.who && p.questions?.length) body.append(questionCard(p.assignment_id, p.questions, p.who));
    else if (p.answers?.length) body.append(answersEl(p.answers));
  } else if (p.kind === "approval") {
    if (waits && a && stage) body.append(approvalCard(a, stage));
    else if (p.handoff) {
      const hd = handoffEl(p.handoff);
      if (hd) body.append(hd);
    }
  } else if (p.kind === "plan" || (p.kind === "reply" && !!p.thread_id && p.waits_for === "go")) {
    // A plan, or an "@Name" reply that proposes changes: the plan card, with Go.
    const slot = h("div", { class: "tpost__plan" });
    body.append(slot);
    const name = p.who?.name ?? "Ask";
    void (p.thread_id ? planCard(p.thread_id, p.who?.name) : Promise.resolve(null)).then((card) => slot.replaceChildren(card ?? planElsewhere(p.thread_id, name)));
  } else if (p.kind === "done" && p.documents) {
    body.append(documentCard(p.assignment_title ?? "Document", p.note_id ?? null, p.documents, { openNote: !isSampleMode() }));
  }
  const head = h(
    "div",
    { class: "tpost__head" },
    p.who ? whoWords(p.who) : h("span", { class: "who-words" }, h("span", { class: "who-words__name" }, "Ask"), h("span", { class: "who-words__sub" }, "The lead")),
    working ? h("span", { class: "tpost__badge tpost__badge--working" }, h("span", { class: "team-dot", "aria-hidden": "true" }), "Working") : badge ? h("span", { class: `tpost__badge${asks ? " tpost__badge--waits" : p.kind === "failed" ? " tpost__badge--failed" : ""}` }, badge) : null,
    h("span", { class: "tpost__when" }, whenShort(p.created_at))
  );
  const li = h("li", { class: `tpost${waits ? " tpost--waits" : ""}`, id: `post-${p.id}`, tabindex: -1, "data-kind": p.kind }, whoTile(p.who, 36, working), h("div", { class: "tpost__main" }, head, body));
  return paintWho(li, working && p.who ? p.who.avatar : null);
}

/** The newest post of its stage: only that one wears the working dot. */
const isLatestOf = (p: TeamPost, a: Assignment): boolean => {
  const s = a.stages.find((x) => x.id === p.stage_id);
  return !!s?.started_at && Date.parse(p.created_at) >= Date.parse(s.started_at) - 1000;
};

export function renderTeamChat(ctx: { postId: number | null }): { el: HTMLElement; destroy: () => void } {
  let alive = true;
  let chat: TeamChat = { posts: [], waiting: [], before: null };
  let older: TeamPost[] = [];
  let assignments = new Map<string, Assignment>();
  let replyTo: string | null = null;
  let first = true;
  let timer = 0;
  const open = new Set<string>();
  const drawn = new Map<string, { key: string; el: HTMLElement }>();

  const back = h("a", { class: "ta-back", href: "#/team" }, icons.back(), h("span", {}, "Team"));
  const add = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New assignment");
  add.addEventListener("click", () => openNewAssignment());
  const stripCount = h("h2", { class: "strip__count", id: "tc-strip-h" });
  const stripList = h("ol", { class: "strip__list" });
  const strip = h("section", { class: "strip", "aria-labelledby": "tc-strip-h" }, stripCount, stripList);
  const more = h("button", { class: "link-btn tc__older", type: "button", hidden: true }, "Show earlier posts");
  const list = h("div", { class: "tc__threads", role: "log", "aria-label": "Team chat" });
  const said = h("p", { class: "visually-hidden", "aria-live": "polite" });

  const box = h("textarea", { class: "tc__box", rows: 1, placeholder: "Message Ask, or @Name", "aria-label": "Message the team", maxlength: 2000 }) as HTMLTextAreaElement;
  const sendBtn = h("button", { class: "icon-btn tc__send", type: "submit", "aria-label": "Send", disabled: true }, icons.arrowUp()) as HTMLButtonElement;
  const toChip = h("button", { class: "tc__to", type: "button", hidden: true });
  toChip.addEventListener("click", () => setReply(null));
  const form = h("form", { class: "tc__compose" }, toChip, h("div", { class: "tc__row" }, box, sendBtn));

  function setReply(id: string | null) {
    replyTo = id;
    const title = id ? assignments.get(id)?.title : null;
    toChip.hidden = !title;
    toChip.replaceChildren(h("span", {}, `In ${title ?? ""}`), icons.close());
    toChip.setAttribute("aria-label", `Replying in ${title ?? ""}. Tap to message Ask instead.`);
    box.placeholder = title ? "Reply to the stage that's waiting" : "Message Ask, or @Name";
    if (id) box.focus();
  }

  box.addEventListener("input", () => {
    sendBtn.disabled = !box.value.trim();
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 140)}px`;
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text || sendBtn.getAttribute("aria-busy")) return;
    sendBtn.setAttribute("aria-busy", "true");
    try {
      await say(text, replyTo);
      box.value = "";
      box.style.height = "auto";
      sendBtn.disabled = true;
      await look();
      list.lastElementChild?.scrollIntoView({ block: "end" });
    } catch (err) {
      showToast(err instanceof Error && err.message && !/^\d{3} /.test(err.message) ? err.message : "That didn't send. Try again in a moment.", { icon: "refresh" });
    } finally {
      sendBtn.removeAttribute("aria-busy");
    }
  });

  function reveal(id: number, focus = true) {
    const p = [...older, ...chat.posts].find((x) => x.id === id);
    if (p?.assignment_id && !document.getElementById(`post-${id}`)) {
      open.add(p.assignment_id);
      paint();
    }
    const el = document.getElementById(`post-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.remove("is-found");
    void el.offsetWidth;
    el.classList.add("is-found");
    if (focus) el.focus({ preventScroll: true });
  }

  function threadEl(t: ChatThread): HTMLElement {
    const a = t.assignment_id ? assignments.get(t.assignment_id) : undefined;
    if (!t.assignment_id) return h("ol", { class: "tthread tthread--alone" }, ...t.posts.map((p) => postEl(p, a)));
    const all = open.has(t.assignment_id);
    // Folded: the lineup, whatever waits, and the latest post.
    const shown = all ? t.posts : t.posts.filter((p, i) => i === 0 || i === t.posts.length - 1 || (p.waits_for && !p.settled_at));
    const hidden = t.posts.length - shown.length;
    const fold = h("button", { class: "link-btn tthread__fold", type: "button", "aria-expanded": String(all) }, all ? "Show less" : `Show all ${t.posts.length} posts`);
    fold.addEventListener("click", () => {
      if (all) open.delete(t.assignment_id!);
      else open.add(t.assignment_id!);
      paint();
      document.querySelector<HTMLElement>(`[data-thread="${CSS.escape(t.key)}"] .tthread__fold`)?.focus();
    });
    const reply = h("button", { class: "link-btn tthread__reply", type: "button" }, "Reply");
    reply.addEventListener("click", () => setReply(t.assignment_id));
    const items = shown.map((p) => postEl(p, a));
    if (hidden > 0) items.splice(1, 0, h("li", { class: "tthread__gap" }, fold));
    return h(
      "section",
      { class: `tthread${t.waits ? " thread--waits" : ""}`, "data-thread": t.key, "aria-label": t.title ?? "Assignment" },
      h(
        "header",
        { class: "tthread__head" },
        h("a", { class: "tthread__title", href: `#/team/assignment/${encodeURIComponent(t.assignment_id)}` }, h("span", {}, t.title ?? "Assignment"), icons.chevronRight()),
        h("span", { class: "tthread__meta" }, [a ? assignmentLine(a) : null, threadCount(t)].filter(Boolean).join(" · "))
      ),
      h("ol", { class: "tthread__posts" }, ...items),
      h("footer", { class: "tthread__foot" }, hidden <= 0 && t.posts.length > 2 ? fold : null, a && (a.status === "waiting" || a.status === "running") ? reply : null)
    );
  }

  function paint() {
    const posts = [...older, ...chat.posts];
    const waits = waitingPosts(chat);
    // The strip: the one count (its rows), then each thing that waits, oldest first.
    stripCount.textContent = waits.length ? thingsWait(waits.length) : "Nothing waits for you";
    strip.classList.toggle("strip--quiet", !waits.length);
    stripList.replaceChildren(
      ...waits.map((p) => {
        const b = h(
          "button",
          { class: "strip__item", type: "button" },
          whoTile(p.who, 28),
          h("span", { class: "strip__text" }, h("span", { class: "strip__title" }, waitTitle(p)), h("span", { class: "strip__sub" }, [p.assignment_title, whenShort(p.created_at)].filter(Boolean).join(" · ")))
        );
        b.addEventListener("click", () => reveal(p.id));
        if (p.waits_for !== "dismiss") return h("li", {}, b);
        const gone = h("button", { class: "btn btn--soft btn--sm strip__dismiss", type: "button", "aria-label": `Dismiss: ${waitTitle(p)}` }, "Dismiss");
        gone.addEventListener("click", () => {
          gone.disabled = true;
          void dismissPost(p).catch(() => {
            gone.disabled = false;
            showToast("That didn't dismiss. Try again in a moment.", { icon: "refresh" });
          });
        });
        return h("li", { class: "strip__row" }, b, gone);
      })
    );

    const threads = threadsOf(posts);
    const keep = new Set<string>();
    const order: HTMLElement[] = [];
    for (const t of threads) {
      const a = t.assignment_id ? assignments.get(t.assignment_id) : undefined;
      const key = JSON.stringify([t.posts.map((p) => [p.id, p.settled_at, p.text, p.answers?.length ?? 0]), a ? [a.status, a.sent_back, a.stages.map((s) => [s.status, s.waits_for, s.who.guest])] : null, t.assignment_id ? open.has(t.assignment_id) : 0]);
      let d = drawn.get(t.key);
      if (!d || d.key !== key) drawn.set(t.key, (d = { key, el: threadEl(t) }));
      keep.add(t.key);
      order.push(d.el);
    }
    for (const k of [...drawn.keys()]) if (!keep.has(k)) drawn.delete(k);
    if (order.length !== list.children.length || order.some((n, i) => list.children[i] !== n)) list.replaceChildren(...(order.length ? order : [h("p", { class: "tc__empty" }, "Nothing has been posted yet. Start an assignment, or wait for an assistant's next run.")]));
    more.hidden = olderFrom() == null;
  }

  /** Where "Show earlier posts" carries on from: the last older page's, else the newest page's. */
  let oldestBefore: number | null | undefined;
  const olderFrom = () => (oldestBefore === undefined ? chat.before : oldestBefore);
  more.addEventListener("click", async () => {
    const from = olderFrom();
    if (from == null) return;
    const page = await getChat(from).catch(() => null);
    if (!page || !alive) return;
    older = [...page.posts, ...older];
    oldestBefore = page.before;
    paint();
  });

  async function look(): Promise<void> {
    window.clearTimeout(timer);
    const [c, list2] = await Promise.all([getChat(), listAssignments().catch(() => [...assignments.values()])]);
    if (!alive) return;
    const fresh = c.posts.filter((p) => !chat.posts.some((x) => x.id === p.id));
    chat = c;
    // A newer page may overlap what "Show earlier" loaded.
    older = older.filter((p) => !c.posts.some((x) => x.id === p.id));
    assignments = new Map(list2.map((a) => [a.id, a]));
    paint();
    if (first) {
      first = false;
      el.removeAttribute("aria-busy");
      // Open at the post asked for, else at the oldest thing that waits, else at the newest post.
      const target = ctx.postId ?? waitingPosts(chat)[0]?.id ?? null;
      requestAnimationFrame(() => (target != null ? reveal(target, ctx.postId != null) : list.lastElementChild?.scrollIntoView({ block: "end" })));
    } else if (fresh.length) {
      const p = fresh[fresh.length - 1];
      said.textContent = `${p.who?.name ?? (p.from === "owner" ? "You" : "Ask")}: ${p.text}`;
    }
    if (list2.some((a) => a.status === "running") && document.visibilityState !== "hidden") timer = window.setTimeout(() => void look().catch(() => undefined), 3000);
  }

  const el = h(
    "div",
    { class: "view team-chat", "aria-busy": "true" },
    h("div", { class: "ta-top" }, back),
    h("header", { class: "tc__head" }, h("h1", { class: "page-title" }, "Team chat"), add),
    strip,
    more,
    list,
    form,
    said
  );

  const offChat = onChatChange(() => void look().catch(() => undefined));
  const onVisible = () => document.visibilityState !== "hidden" && void look().catch(() => undefined);
  document.addEventListener("visibilitychange", onVisible);
  void look().catch(() => {
    if (!alive) return;
    el.removeAttribute("aria-busy");
    list.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "Team chat didn't load"), h("p", { class: "empty__sub" }, "Check you're online and try again.")));
  });

  return {
    el,
    destroy() {
      alive = false;
      window.clearTimeout(timer);
      offChat();
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
