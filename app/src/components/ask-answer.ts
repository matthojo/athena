/**
 * Ask's written answers (lib/answer.ts, POST /api/assistant/answer): a few
 * sentences with numbered citations, the sources as chips beneath, then
 * anything else in Athena that matched and what was searched.
 *
 * A citation or a chip opens its source: Athena's own (a note, a person, a
 * to-do) in the app, a call or an email in its own account. Talk says the
 * text without the numbers (spokenAnswer).
 *
 * Offline, or when the answer can't be fetched, Ask falls back to its keyword
 * search; answerFallbackNote says why. Sample mode has one canned answer, with
 * a call, an email, a to-do and a person, so the whole thing can be seen.
 *
 * When an answer rests on something in an account that Athena didn't have
 * (January's flights, booked by email before Athena collected), Ask saves it
 * straight away (POST /api/assistant/import) and shows what it saved under the
 * answer: each thing with a link, and Undo, which archives it.
 */

import { LIVE_ANSWERS_NOT_KEPT } from "../../../lib/answer-text";
import { openDay } from "../lib/day-link";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { showToast } from "./toast";
import { openCommitmentSheet } from "./commitment-sheet";
import { ApiError, undoAssistantChange } from "../db/api";
import { keepReceipt, type KeptReceipt } from "../db/ask-threads";
import { loadCommitments } from "../db/memory";
import { SAMPLE_IDS } from "../db/sample-data";
import { localToday } from "../lib/time";
import { patternCard } from "./patterns-block";
import { linkPieces, linkTextNodes } from "./link-text";
import { openItem } from "../lib/open-item";
import { artImg } from "./art-img";
import { findWho, whoMark } from "./ask-who";
import type { AssistantChange, EntityKind } from "../types";
import { joinList, type AnswerReply, type AnswerSource, type RelatedItem } from "../../../lib/answer-text";
import type { AskAnswer } from "../lib/ask";
import { acted, generalNote, isGeneral, isWebSource, siteName, sourcesOf, type AskReply, type AskSource, type WebSource } from "../lib/ask-contract";
import { FALLBACK_NOTE, fallbackCause, type FallbackCause } from "../lib/ask-fallback";
import { plainText, richNodes } from "../lib/ask-rich";
import type { AskContext } from "../views/ask";
import { isRecipeQuestion, RECIPE_STEPS, sampleRecipeAnswer } from "./ask-recipes-sample";
import { asksToKeepRecipe } from "../lib/ask-reply-recipe";
import { trackingReplyCard } from "./tracking";
import { isPriceHistoryQuestion, samplePriceAnswer } from "../db/sample-trackers";
import "../styles/answer.css";
import "../styles/ask-receipt.css";

export type { AnswerReply, AnswerTurn } from "../../../lib/answer-text";
export type { AskReply } from "../lib/ask-contract";
export { answerHistory } from "../lib/ask-history";

/**
 * A reply from Ask's one assistant: the answer, with whatever the turn did (lib/ask-contract.ts AskReply).
 * `fallback` is the keyword search shown when the reply couldn't be had.
 */
export interface AnswerMessage {
  role: "answer";
  question: string;
  reply: AskReply | null;
  fallback: AskAnswer | null;
  /** Why it fell back, in a sentence. */
  note: string | null;
  /** It fell back for want of a connection: written again, once, when one returns (lib/ask-fallback.ts). */
  offline?: boolean;
  /** A follow-up whose reply couldn't be had: no keyword search of its words, just why, and Try again (lib/ask-fallback.ts). */
  unreached?: FallbackCause;
  /** The one automatic retry has been used (or is on its way: `retryAt`). */
  autoTried?: boolean;
  /** When the automatic retry is due, while it's waiting. */
  retryAt?: number;
  sample: boolean;
  /** What's being saved from the accounts, or was (ask-import.ts). */
  saving?: SavingFound;
}

/** One thing saved from an answer, as POST /api/assistant/import gives it. */
export interface FoundItem {
  kind: "trip" | "booking" | "purchase" | "note" | "event" | "todo" | "detail" | "catch_up" | "reading" | "day";
  title: string;
  href: string;
  undo: Array<Record<string, unknown>>;
  from: string;
}

export interface FoundReceipt {
  saved: FoundItem[];
  review: number;
  already: number;
  failed: string[];
  over_cap: number;
}

export interface SavingFound {
  status: "saving" | "done" | "failed";
  receipt: FoundReceipt | null;
  /** Lines undone here, and ones being undone, by index. */
  undone: Set<number>;
  undoing: Set<number>;
  /** Something changed that the conversation keeps (an Undo). */
  onChange?: () => void;
}

/** The receipt as the conversation keeps it (app/src/db/ask-threads.ts), once saving is done. */
export function keptFromSaving(s: SavingFound | undefined): KeptReceipt | undefined {
  return s?.status === "done" && s.receipt ? keepReceipt(s.receipt, s.undone) : undefined;
}

/** A kept receipt shown again under a reopened answer, Undo and all. One with a kind this build doesn't know isn't shown. */
export function savingFromKept(k: KeptReceipt | null): SavingFound | undefined {
  if (!k || !k.saved.every((l) => l.kind in FOUND_WORD)) return undefined;
  const { undone, ...receipt } = k;
  return { status: "done", receipt: receipt as FoundReceipt, undone: new Set(undone), undoing: new Set() };
}

const SOURCE_ICON: Record<AnswerSource["kind"], IconName> = {
  meeting: "phone",
  email: "mail",
  event: "calendar",
  message: "chat",
  page: "link",
  note: "note",
  person: "person",
  todo: "loop",
  record: "folder",
  day: "calendar",
  saved: "bookmark",
  goal: "target",
  trip: "plane",
  purchase: "bag",
  recipe: "pot",
  watch: "bookmark",
  work: "work",
  film: "film",
  episode: "tv",
  show: "tv",
  video: "play",
  track: "music",
  album: "music",
  artist: "music",
  book: "book",
  game: "game",
  post: "chat",
  comment: "chat",
};

const SOURCE_WORD: Record<AnswerSource["kind"], string> = {
  meeting: "Call",
  email: "Email",
  event: "Event",
  message: "Message",
  page: "Page",
  note: "Note",
  person: "Person",
  todo: "To-do",
  record: "Record",
  day: "Day",
  saved: "Saved",
  goal: "Goal",
  trip: "Trip",
  purchase: "Order",
  recipe: "Recipe",
  watch: "Watch & read",
  work: "Work",
  film: "Film",
  episode: "Episode",
  show: "Show",
  video: "Video",
  track: "Track",
  album: "Album",
  artist: "Artist",
  book: "Book",
  game: "Game",
  post: "Post",
  comment: "Comment",
};

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "Today", "Yesterday", "14 Oct", or "14 Oct 2025" from another year. Dates are calendar days, never shifted between zones. */
function dayLabel(date: string): string {
  const today = localToday();
  if (date === today) return "Today";
  const y = new Date(`${today}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  if (date === y.toISOString().slice(0, 10)) return "Yesterday";
  const at = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(at)) return "";
  return (date.slice(0, 4) === today.slice(0, 4) ? DAY : DAY_YEAR).format(at);
}

/** What Talk says: the answer without its citation numbers, its bold, or its list dashes and step numbers. */
export function spokenAnswer(reply: AnswerReply): string {
  return plainText(reply.text);
}

/** Why Ask is showing a keyword search instead of an answer. */
export function answerFallbackNote(error: unknown, online = true): string {
  return FALLBACK_NOTE[fallbackCause(error, online)];
}

// ---------- Opening a source ----------

/** A source Ask got by checking with an assistant (check_with_assistant): `id` is the assistant. */
const isAssistant = (s: { kind: string }) => s.kind === "assistant";

async function openSource(s: { kind: AnswerSource["kind"] | RelatedItem["kind"] | "web"; id: string | null; url?: string | null; account?: string | null }, ctx: AskContext, sample: boolean, from?: Element) {
  // What the assistant said opens on the reply's "Checked with <Name>"; without it, the assistant's page.
  if (isAssistant(s) && s.id) {
    const chip = from?.closest(".msg")?.querySelector<HTMLButtonElement>(`.checked-with[data-id="${CSS.escape(s.id)}"] .checked-with__btn`);
    if (chip && !chip.disabled) {
      if (chip.getAttribute("aria-expanded") !== "true") chip.click();
      chip.scrollIntoView({ block: "nearest" });
      chip.focus({ preventScroll: true });
    } else location.hash = `#/team/${encodeURIComponent(s.id)}`;
    return;
  }
  if (s.url) {
    if (sample) {
      showToast(`In your own Athena this opens the ${(SOURCE_WORD[s.kind as AnswerSource["kind"]] ?? "source").toLowerCase()} in ${s.account ?? "its account"}`, { icon: "external" });
      return;
    }
    window.open(s.url, "_blank", "noopener");
    return;
  }
  if (!s.id) return;
  if (s.kind === "todo") {
    const found = (await loadCommitments()).items.find((c) => c.id === s.id);
    if (found) openCommitmentSheet(found);
    else showToast("That to-do isn't available. It may be archived", { icon: "loop" });
    return;
  }
  if (s.kind === "day") return openDay(s.id);
  if (s.kind === "saved") {
    location.hash = `#/saved/${encodeURIComponent(s.id)}`;
    return;
  }
  if (s.kind === "recipe") {
    location.hash = `#/recipes/${encodeURIComponent(s.id)}`;
    return;
  }
  if (s.kind === "note" || s.kind === "person" || s.kind === "record") ctx.openLink(s.kind, s.id);
  // A goal, trip or order opens its sheet.
  else await openItem({ kind: s.kind, id: s.id });
}

// ---------- Working ----------

export function answerWorkingEl(): HTMLElement {
  const caption = h("span", { class: "assist__working" }, "Searching your notes, calls and email…");
  // It takes a few lookups; say so rather than look stuck.
  setTimeout(() => (caption.textContent = "Still looking…"), 6000);
  return h(
    "div",
    { class: "msg msg--athena", "aria-label": "Athena is looking into it" },
    h("span", { class: "orb orb--thinking", "aria-hidden": "true" }),
    h("div", { class: "bubble" }, h("span", { class: "typing-dots" }, h("span", {}), h("span", {}), h("span", {})), caption)
  );
}

// ---------- The answer ----------

function sourceLabel(s: AskSource): string {
  if (isWebSource(s)) return [`Source ${s.n}: Web page`, s.title, siteName(s.url)].filter(Boolean).join(", ");
  if (isAssistant(s)) return `Source ${s.n}: what ${s.title} said when Ask checked with it`;
  const date = s.date ? dayLabel(s.date) : "";
  return [`Source ${s.n}: ${SOURCE_WORD[s.kind] ?? "Source"}`, s.title, date, s.account ? `in ${s.account}` : ""].filter(Boolean).join(", ");
}

/** A page from the web: its title, then the site's name. Always a real link; nothing is fetched until it's opened. */
function webChip(s: WebSource, i: number): HTMLElement {
  const site = siteName(s.url);
  return h(
    "li",
    {},
    h(
      "a",
      { class: "source source--web", style: `--i:${i}`, href: s.url, target: "_blank", rel: "noopener noreferrer", "aria-label": `${sourceLabel(s)} (opens the page)`, title: `Open ${site}` },
      h("span", { class: "source__n", "aria-hidden": "true" }, String(s.n)),
      h(
        "span",
        { class: "source__body" },
        h("span", { class: "source__title" }, s.title || site),
        h("span", { class: "source__meta", "aria-hidden": "true" }, h("span", { class: "source__icon" }, icons.globe()), h("span", { class: "source__what" }, site))
      ),
      h("span", { class: "source__out", "aria-hidden": "true" }, icons.external())
    )
  );
}

/** A cover's shape on a source: a sleeve for music, a screen for a video, a poster for the rest; its own when the art says. */
function coverRatio(s: AnswerSource): number {
  if (s.kind === "track" || s.kind === "album") return 1;
  if (s.art && s.art.w > 0 && s.art.h > 0) return Math.max(0.6, Math.min(16 / 9, s.art.w / s.art.h));
  return s.kind === "video" || s.kind === "game" ? 16 / 9 : 2 / 3;
}

/** An assistant Ask checked with: its mini avatar and "Checked with"; opening it shows what it said. */
function assistantChip(s: AnswerSource, i: number, ctx: AskContext, sample: boolean): HTMLElement {
  const mark = h("span", { class: "source__icon" }, icons.sparkle());
  void findWho(s.id).then((who) => who.avatar && mark.replaceChildren(whoMark({ avatar: who.avatar, name: s.title }, 16)));
  const el = h(
    "button",
    { class: "source", type: "button", style: `--i:${i}`, "aria-label": `Source ${s.n}: what ${s.title} said when Ask checked with it`, title: s.title },
    h("span", { class: "source__n", "aria-hidden": "true" }, String(s.n)),
    h("span", { class: "source__body" }, h("span", { class: "source__title" }, s.title), h("span", { class: "source__meta", "aria-hidden": "true" }, mark, h("span", { class: "source__what" }, "Assistant")))
  );
  el.addEventListener("click", () => void openSource(s, ctx, sample, el));
  return el;
}

function sourceChip(s: AskSource, i: number, ctx: AskContext, sample: boolean): HTMLElement {
  if (isWebSource(s)) return webChip(s, i);
  const date = s.date ? dayLabel(s.date) : "";
  // What it is, where, when: "Film · Letterboxd · Sat", as the related rows below say "Note · Today". A Watch & read title says its kind and where it's up to.
  if (isAssistant(s)) return h("li", {}, assistantChip(s, i, ctx, sample));
  const meta = [s.detail ?? SOURCE_WORD[s.kind] ?? "Source", s.account, date].filter(Boolean).join(" · ");
  // With a cover Athena holds (lib/answer-art.ts), the source is a card: the cover, then the same words.
  const cover = s.art ? h("span", { class: "source__cover", "aria-hidden": "true" }, artImg(s.art, { alt: "", size: "sm", ratio: coverRatio(s), fallback: SOURCE_ICON[s.kind] ?? "link" })) : null;
  const inner = [
    h("span", { class: "source__n", "aria-hidden": "true" }, String(s.n)),
    cover,
    h(
      "span",
      { class: "source__body" },
      h("span", { class: "source__title" }, s.title),
      h("span", { class: "source__meta", "aria-hidden": "true" }, h("span", { class: "source__icon" }, icons[SOURCE_ICON[s.kind] ?? "link"]()), h("span", { class: "source__what" }, meta))
    ),
    s.url ? h("span", { class: "source__out", "aria-hidden": "true" }, icons.external()) : null,
  ];
  const attrs = { class: `source${cover ? " source--cover" : ""}`, style: `--i:${i}`, "aria-label": `${sourceLabel(s)}${s.url ? " (opens outside Athena)" : ""}`, title: s.url && s.account ? `Open in ${s.account}` : s.title };
  // External sources are real links (long-press to copy, open in a new tab); Athena's own open a sheet.
  const el = s.url && !sample ? h("a", { ...attrs, href: s.url, target: "_blank", rel: "noopener noreferrer" }, ...inner) : h("button", { ...attrs, type: "button" }, ...inner);
  if (!(s.url && !sample)) el.addEventListener("click", () => void openSource(s, ctx, sample, el));
  return h("li", {}, el);
}

/**
 * The answer's words (lib/ask-rich.ts): paragraphs, "- " lists and bold,
 * with each citation a button that opens its source.
 */
function answerText(reply: AnswerReply, ctx: AskContext, sample: boolean): HTMLElement {
  const byN = new Map(sourcesOf(reply).map((s) => [s.n, s]));
  const cite = (n: number) => {
    const s = byN.get(n);
    if (!s) return null;
    if (isWebSource(s)) return h("a", { class: "cite", href: s.url, target: "_blank", rel: "noopener noreferrer", "aria-label": sourceLabel(s) }, String(n));
    const b = h("button", { class: "cite", type: "button", "aria-label": sourceLabel(s) }, String(n));
    b.addEventListener("click", () => void openSource(s, ctx, sample, b));
    return b;
  };
  // Links in the prose show by their mode (components/link-text.ts), never as Markdown.
  const text = (t: string) => linkTextNodes(t, (kind, id) => void openItem({ kind, id }).then((done) => done || ctx.openLink(kind as EntityKind, id)));
  return h("div", { class: "answer__text rich" }, ...richNodes(reply.text, { cite, text }));
}

const RELATED_ICON: Record<RelatedItem["kind"], IconName> = { note: "note", person: "person", todo: "loop", record: "folder" };

function relatedRow(r: RelatedItem, ctx: AskContext, sample: boolean): HTMLElement {
  const meta = [SOURCE_WORD[r.kind], r.date ? dayLabel(r.date) : ""].filter(Boolean).join(" · ");
  const b = h(
    "button",
    { class: "answer", type: "button" },
    h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[RELATED_ICON[r.kind]]()),
    h(
      "span",
      { class: "row__body" },
      h("span", { class: "row__title" }, r.title),
      r.snippet && r.snippet !== r.title && r.kind !== "person" ? h("span", { class: "row__snippet" }, r.snippet) : null,
      h("span", { class: "row__meta" }, r.kind === "person" && r.snippet ? r.snippet : meta)
    )
  );
  b.addEventListener("click", () => void openSource({ kind: r.kind, id: r.id }, ctx, sample));
  return b;
}

/** What couldn't be searched, with a way to fix a sign-in. */
function skippedLine(skipped: string[]): HTMLElement | null {
  if (!skipped.length) return null;
  const signIn = skipped.some((s) => /needs signing in/.test(s));
  const fix = signIn ? h("a", { class: "answer__fix", href: "#/settings/accounts" }, "Open Sources") : null;
  return h("p", { class: "answer__aside" }, icons.plug(), h("span", {}, `Couldn't search ${joinList(skipped)}.`, fix ? " " : "", fix));
}

const FOUND_ICON: Record<FoundItem["kind"], IconName> = {
  trip: "suitcase", booking: "plane", purchase: "parcel", note: "note", event: "calendar", todo: "loop", detail: "person", catch_up: "chat", reading: "book", day: "calendar",
};

const FOUND_WORD: Record<FoundItem["kind"], string> = {
  trip: "Trip", booking: "Booking", purchase: "Order", note: "Note", event: "Event", todo: "To-do", detail: "Detail", catch_up: "Catch-up", reading: "Watch & read", day: "Day",
};

/** One saved thing: tap to open it in Athena; Undo archives it. */
function foundRow(item: FoundItem, i: number, saving: SavingFound, sample: boolean, repaint: () => void): HTMLElement {
  const undone = saving.undone.has(i);
  const undoing = saving.undoing.has(i);
  const body = h("span", { class: "change__body" }, h("span", { class: "change__title" }, item.title), h("span", { class: "change__detail" }, `${FOUND_WORD[item.kind]} · from ${item.from}`));
  const lead = h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[FOUND_ICON[item.kind]]());
  const main = undone ? h("div", { class: "change__main" }, lead, body) : h("a", { class: "change__main", href: item.href, "aria-label": `Open ${item.title}` }, lead, body);
  let trailing: HTMLElement | null = null;
  if (undone) trailing = h("span", { class: "change__state" }, icons.restore(), "Undone");
  else if (item.undo.length) {
    const b = h("button", { class: "btn btn--soft btn--sm change__undo", type: "button", "aria-label": `Undo saving ${item.title}`, disabled: undoing }, undoing ? "Undoing…" : "Undo") as HTMLButtonElement;
    b.addEventListener("click", async () => {
      saving.undoing.add(i);
      repaint();
      try {
        // Sample mode keeps nothing, so there's nothing to archive.
        if (!sample) for (const op of item.undo) await undoAssistantChange(op);
        saving.undone.add(i);
        saving.onChange?.();
      } catch {
        showToast("Couldn't undo that. Try again in a moment.", { icon: "restore" });
      } finally {
        saving.undoing.delete(i);
        repaint();
      }
    });
    trailing = b;
  }
  return h("div", { class: `change${undone ? " is-undone" : ""}`, style: `--i:${i}` }, main, trailing);
}

/** Under the answer: what's being saved to Athena, then what was, with Undo. Nothing when there was nothing new. */
function foundEl(saving: SavingFound | undefined, sample: boolean, repaint: () => void): HTMLElement | null {
  if (!saving) return null;
  if (saving.status === "saving") return h("p", { class: "answer__aside found__saving", role: "status" }, icons.inbox(), h("span", {}, "Saving this to Athena…"));
  if (saving.status === "failed") return h("p", { class: "answer__aside" }, icons.inbox(), h("span", {}, "Couldn't save this to Athena just now. It's still in your account."));
  const r = saving.receipt;
  if (!r) return null;
  const review = r.review
    ? h("p", { class: "answer__aside" }, icons.inbox(), h("span", {}, `${r.review === 1 ? "One thing I wasn't sure of is" : `${r.review} things I wasn't sure of are`} in Review.`, " ", h("a", { class: "answer__fix", href: "#/review" }, "Open Review")))
    : null;
  const more = r.over_cap ? h("p", { class: "answer__aside" }, icons.inbox(), h("span", {}, "I save up to 5 things from one answer. The rest are still in your account.")) : null;
  const failed = r.failed.length ? h("p", { class: "answer__aside" }, icons.inbox(), h("span", {}, `Couldn't save ${joinList(r.failed)}.`)) : null;
  if (!r.saved.length && !review && !failed) return null;
  return h(
    "div",
    { class: "found" },
    r.saved.length ? h("p", { class: "answers__label" }, "Saved to Athena") : null,
    r.saved.length ? h("div", { class: "card card--flush changes found__list", role: "list", "aria-label": "Saved to Athena" }, ...r.saved.map((item, i) => foundRow(item, i, saving, sample, repaint))) : null,
    review,
    more,
    failed,
  );
}

export function answerReplyEl(m: AnswerMessage, ctx: AskContext, repaint: () => void = () => undefined): HTMLElement {
  const reply = m.reply!;
  // Related items only when they add something: fewer beside a found answer, more when nothing was found.
  // A reply that did something is about that: nothing else is offered beside it.
  // A general answer has nothing of yours behind it, so a keyword match on the question's words isn't related to it.
  const related = acted(reply) || isGeneral(reply) ? [] : reply.related.slice(0, reply.found ? 2 : 3);
  const sources = sourcesOf(reply);
  // No checked source of the owner's is behind it: that's said plainly, in place of "Searched…".
  const general = isGeneral(reply);
  const under = general ? generalNote(reply) : reply.searched;
  return h(
    "div",
    { class: "msg msg--athena" },
    h("span", { class: "orb", "aria-hidden": "true" }),
    h(
      "div",
      { class: "bubble answer-bubble" },
      answerText(reply, ctx, m.sample),
      // An answer that read the price history shows each cited item's line, the same line as its page (components/tracking.ts).
      ...priceTrends(reply),
      sources.length ? h("ul", { class: "sources", "aria-label": `${sources.length === 1 ? "Source" : "Sources"}` }, ...sources.map((s, i) => sourceChip(s, i, ctx, m.sample))) : null,
      reply.patterns?.length ? h("div", { class: "answer-patterns" }, ...reply.patterns.slice(0, 2).map((p) => patternCard(p, { compact: true }))) : null,
      foundEl(m.saving, m.sample, repaint),
      related.length ? h("p", { class: "answers__label" }, "Related in Athena") : null,
      related.length ? h("div", { class: "answers" }, ...related.map((r) => relatedRow(r, ctx, m.sample))) : null,
      reply.flagged
        ? h("p", { class: "answer__aside" }, icons.shield(), h("span", {}, "Something I read looked like it was written to give an assistant instructions. I treated it as plain text."))
        : null,
      skippedLine(reply.skipped),
      // A setting that would let Ask answer ("Let Ask read transactions" while money search is off).
      reply.setting ? h("a", { class: "btn btn--soft btn--sm answer__setting", href: reply.setting.href }, icons.sliders(), reply.setting.label) : null,
      // A reply that only did something searched nothing worth naming: its foot holds just Try again and Pin.
      under
        ? h("p", { class: `bubble__foot${general ? " bubble__foot--general" : ""}` }, general && sources.some(isWebSource) ? icons.globe() : icons.sparkle(), m.sample ? `${under} · sample data` : under)
        : h("p", { class: "bubble__foot bubble__foot--bare" }, ...(m.sample ? [icons.sparkle(), "Sample data"] : []))
    )
  );
}

/** The tracking cards for an answer from tracker_history (lib/ask-tools.ts): its saved sources, at most two. */
function priceTrends(reply: AnswerReply): HTMLElement[] {
  if (!/what you track|saved prices/.test(reply.searched ?? "")) return [];
  return reply.sources
    .filter((s) => s.kind === "saved" && s.id)
    .slice(0, 2)
    .map((s) => trackingReplyCard(s.id!, { name: s.title, open: () => (location.hash = `#/saved/${encodeURIComponent(s.id!)}`) }));
}

// ---------- Sample mode ----------

/** The questions sample mode answers in writing (the rest get the keyword search). */
export const SAMPLE_QUESTION = "What did Elena say about pricing?";
export const SAMPLE_LIFE_QUESTION = "What did I get up to last weekend?";
export const SAMPLE_PATTERNS_QUESTION = "What helps me sleep?";
export const SAMPLE_TRIP_QUESTION = "When did I fly to Lisbon in January?";
/** A list answer from the owner's own to-dos; a general answer with nothing of theirs behind it; and one from the web. */
export const SAMPLE_LIST_QUESTION = "What's on my plate this week?";
export const SAMPLE_GENERAL_QUESTION = "What's the 50/30/20 budgeting rule?";
export const SAMPLE_WEB_QUESTION = "How long does a UK passport renewal take?";
/** Numbered steps, from a note, a person and a to-do. */
export const SAMPLE_STEPS_QUESTION = "What are the next steps for the Q3 planning doc?";

const isListQuestion = (question: string) => /\b(on my plate|to-?dos? (?:this|for the) week|due this week)\b/i.test(question);
const isStepsQuestion = (question: string) => /\b(next steps|steps (?:for|on|to))\b/i.test(question);
const isGeneralQuestion = (question: string) => /\b50\s*\/\s*30\s*\/\s*20\b|\bbudgeting rule\b/i.test(question);
const isWebQuestion = (question: string) => /\bpassport\b/i.test(question);
/** A general answer that is a recipe, for the follow-up "Turn this into a recipe" (the production case of 12 Nov 2026). */
export const SAMPLE_BROWNIE_QUESTION = "How do I make brownies?";
const isBrownieQuestion = (question: string) => /\bbrownies?\b/i.test(question) && !asksToKeepRecipe(question);

/** A question sample mode answers from an old booking email, which it then "saves". */
const isTripQuestion = (question: string) => /\b(fl(?:y|ew|ights?)|trips?|lisbon|travel\w*|holiday)\b/i.test(question) && !/\bpric|\belena\b/i.test(question);

/** A question sample mode answers from its patterns (db/sample-patterns.ts). */
const isPatternsQuestion = (question: string) => /\b(sleep\w*|slept|help(s|ed)? me|patterns?)\b/i.test(question) && !/\bpric|\belena\b/i.test(question);

/** Which Life log sample answers a question: what was watched, what was posted, or a weekend of both. */
function lifeTopic(question: string): "watch" | "reddit" | "weekend" | null {
  if (/\bpric|\belena\b/i.test(question)) return null;
  if (/\b(reddit|post\w*|comment\w*|subreddit)\b/i.test(question)) return "reddit";
  if (/\b(watch\w*|film|films|movies?|tv|shows?|episodes?|letterboxd|trakt)\b/i.test(question)) return "watch";
  if (/\b(weekend|listen\w*|play\w*|music|songs?|tracks?|up to)\b/i.test(question)) return "weekend";
  return null;
}

/** "What's on Priya's plate?": someone else's work, asked of the work accounts live (sample mode's answer). */
const isWorkmateQuestion = (q: string) => /\b(plate|workload|priya)\b/i.test(q);

/**
 * Sample mode: a question that also asks for a to-do ("What did Elena say about pricing, and add a to-do to follow
 * up"). The one reply answers it with its sources and carries the receipt, as a real one does. Null when the
 * message asks for nothing to be added.
 */
export function sampleFollowUp(question: string): { text: string; step: [string, string]; change: AssistantChange; next: string[] } | null {
  const m = /\b(?:and|then|also)\s+(?:please\s+)?(?:add|make|create)\s+(?:me\s+)?a\s+to-?do\s+(?:to\s+)?(.+?)[.!?]?$/i.exec(question.trim());
  if (!m) return null;
  const title = m[1].trim().replace(/^./, (c) => c.toUpperCase());
  const named = /\belena\b/i.test(question) && !/\belena\b/i.test(title) ? `${title} with Elena` : title;
  const id = "5a3e0000-0000-4000-8000-000000993001";
  return {
    text: `I've added a to-do to ${named.replace(/^./, (c) => c.toLowerCase())}.`,
    step: ["Adding a to-do", `Added a to-do: ${named}`],
    change: { kind: "commitment", id, action: "created", title: named, detail: "To do · no date", label: `${named}: To do`, open: { kind: "commitment", id }, undo: { op: "sample" } },
    next: ["Make it due on Friday", "What else did Elena say?"],
  };
}

export function hasSampleAnswer(question: string): boolean {
  return isPriceHistoryQuestion(question) || isBrownieQuestion(question) || isWorkmateQuestion(question) || isListQuestion(question) || isStepsQuestion(question) || isGeneralQuestion(question) || isWebQuestion(question) || isTripQuestion(question) || /\bpric/i.test(question) || /\belena\b/i.test(question) || lifeTopic(question) !== null || isPatternsQuestion(question) || isRecipeQuestion(question);
}

const SEARCH = (name: string): [string, string] => [`Searching ${name}`, `Searched ${name}`];
const NOTES_EMPTY: [string, string] = ["Searching your notes", "Nothing in your notes"];

/** The steps sample mode plays for a question: [while running, once done]. Null for the pricing answer. */
export function sampleAnswerSteps(question: string): Array<[string, string]> | null {
  if (isPriceHistoryQuestion(question)) return [["Checking what you track", "Checked what you track"]];
  if (isListQuestion(question)) return [["Checking your to-dos", "Found 4 open to-dos"], ["Searching notes for planning", "Found 1 note"]];
  if (isStepsQuestion(question)) return [["Searching notes for planning", "Found 1 note"], ["Checking your to-dos", "Found 1 to-do"]];
  if (isGeneralQuestion(question) || isBrownieQuestion(question)) return [NOTES_EMPTY];
  if (isWebQuestion(question)) return [NOTES_EMPTY, ["Searching the web", "Searched the web"]];
  if (isRecipeQuestion(question)) return RECIPE_STEPS;
  if (isWorkmateQuestion(question)) return [SEARCH("Linear"), SEARCH("GitHub")];
  if (isTripQuestion(question)) return [NOTES_EMPTY, SEARCH("Gmail")];
  if (isPatternsQuestion(question)) return [NOTES_EMPTY, ["Looking for patterns in your days", "Looked for patterns in your days"]];
  const topic = lifeTopic(question);
  if (topic === "watch") return [NOTES_EMPTY, SEARCH("Trakt"), SEARCH("Letterboxd")];
  if (topic === "reddit") return [NOTES_EMPTY, SEARCH("Reddit")];
  if (topic === "weekend") return [NOTES_EMPTY, SEARCH("Letterboxd"), SEARCH("Trakt"), SEARCH("Spotify"), SEARCH("Reddit")];
  return null;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_NAME = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });

/** The month a question names ("in March"), else last month: its year, month (0-11) and name. The latest one that isn't in the future. */
function namedMonth(question: string): { y: number; m: number; name: string } {
  const today = new Date(`${localToday()}T12:00:00Z`);
  const named = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`, "i").test(question));
  let y = today.getUTCFullYear();
  let m = named >= 0 ? named : today.getUTCMonth() - 1;
  if (m < 0) (m += 12), y--;
  if (named >= 0 && m > today.getUTCMonth()) y--;
  return { y, m, name: MONTH_NAME.format(Date.UTC(y, m, 15)) };
}

const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, 12)).toISOString().slice(0, 10);

const daysAgo = (n: number) => {
  const d = new Date(`${localToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/** Days back to the Saturday of last weekend (this one's, from Monday to Friday). */
function lastSaturday(): number {
  const since = (new Date(`${localToday()}T12:00:00Z`).getUTCDay() + 1) % 7;
  return since <= 1 ? since + 7 : since;
}

const reply = (text: string, sources: AnswerSource[], searched: string): AnswerReply => ({ text, sources, related: [], searched, skipped: [], found: true, flagged: false });

/** The Life log's sample answers, dated from the question: a film, an episode, a track and a Reddit post between them. */
function sampleLifeAnswer(question: string): AnswerReply {
  const topic = lifeTopic(question);
  if (topic === "watch") {
    const { y, m, name } = namedMonth(question);
    return reply(
      `In ${name} you finished Slow Horses series 4 [1] and watched two films: Past Lives, which you gave four and a half stars [2], and Aftersun [3].`,
      [
        { n: 1, kind: "episode", id: null, url: "https://trakt.tv/shows/slow-horses/seasons/4/episodes/6", title: "Slow Horses, S4 E6", date: ymd(y, m, 9), account: "Trakt" },
        { n: 2, kind: "film", id: null, url: "https://letterboxd.com/sample/film/past-lives/", title: "Past Lives", date: ymd(y, m, 14), account: "Letterboxd" },
        { n: 3, kind: "film", id: null, url: "https://letterboxd.com/sample/film/aftersun/", title: "Aftersun", date: ymd(y, m, 22), account: "Letterboxd" },
      ],
      "Searched your notes, Trakt and Letterboxd",
    );
  }
  if (topic === "reddit") {
    const mon = lastSaturday() + 5;
    return reply(
      "You asked r/espresso how fine to grind for a Flair [1], and in r/cycling you recommended a 28mm tyre for winter [2].",
      [
        { n: 1, kind: "post", id: null, url: "https://www.reddit.com/r/espresso/comments/sample/", title: "Grind size for a Flair 58?", date: daysAgo(mon - 1), account: "Reddit" },
        { n: 2, kind: "comment", id: null, url: "https://www.reddit.com/r/cycling/comments/sample/c/", title: "Winter tyres for commuting", date: daysAgo(mon - 3), account: "Reddit" },
      ],
      "Searched your notes and Reddit",
    );
  }
  const sat = lastSaturday();
  return reply(
    "On Saturday you watched Past Lives and gave it four and a half stars [1], then two episodes of Slow Horses [2]. Starburster by Fontaines D.C. was your most played track that weekend [3]. On Sunday you asked r/espresso how fine to grind for a Flair [4].",
    [
      { n: 1, kind: "film", id: null, url: "https://letterboxd.com/sample/film/past-lives/", title: "Past Lives", date: daysAgo(sat), account: "Letterboxd" },
      { n: 2, kind: "episode", id: null, url: "https://trakt.tv/shows/slow-horses/seasons/4/episodes/3", title: "Slow Horses, S4 E3", date: daysAgo(sat), account: "Trakt" },
      { n: 3, kind: "track", id: null, url: "https://open.spotify.com/track/sample", title: "Starburster", date: daysAgo(sat), account: "Spotify" },
      { n: 4, kind: "post", id: null, url: "https://www.reddit.com/r/espresso/comments/sample/", title: "Grind size for a Flair 58?", date: daysAgo(sat - 1), account: "Reddit" },
    ],
    "Searched your notes, Letterboxd, Trakt, Spotify and Reddit",
  );
}

/** "What helps me sleep?" from sample mode's patterns, citing the latest days each fits. */
async function samplePatternsAnswer(): Promise<AnswerReply> {
  const ps = await (await import("../db/sample-patterns")).samplePatterns(90);
  const yoga = ps.find((p) => p.id === "workout:yoga|sleep|0");
  const watching = ps.find((p) => p.id === "watching|deep|0");
  const last = (dates: string[] | undefined) => dates?.at(-1) ?? daysAgo(2);
  const cards = [yoga, watching].filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ ...p, dates: [] }));
  return withPatterns(cards, reply(
    `Over the last 90 days you've slept about 40 min longer on days you do yoga: longer than usual on ${yoga?.beat ?? 9} of ${yoga?.n_with ?? 12} [1]. On days with 2 hours or more of watching you get about 12 min less deep sleep [2]. These tend to go together in your days; they don't show what causes what.`,
    [
      { n: 1, kind: "day", id: last(yoga?.dates), url: null, title: "A yoga day", date: last(yoga?.dates), account: null },
      { n: 2, kind: "day", id: last(watching?.dates), url: null, title: "A day with a lot of watching", date: last(watching?.dates), account: null },
    ],
    "Searched your notes and your days",
  ));
}

const withPatterns = (patterns: AnswerReply["patterns"], r: AnswerReply): AnswerReply => (patterns?.length ? { ...r, patterns } : r);

/** The month a trip question names, else January. */
const tripMonth = (question: string) => namedMonth(MONTHS.some((m) => new RegExp(`\\b${m}\\b`, "i").test(question)) ? question : "january");

/** "When did I fly to Lisbon in January?": a booking email from before Athena collected, cited from Gmail. */
function sampleTripAnswer(question: string): AnswerReply {
  const { y, m, name } = tripMonth(question);
  const day = (d: number) => new Date(Date.UTC(y, m, d, 12)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return reply(
    `You flew to Lisbon on TAP on ${day(14)} and came back on ${day(18)} [1].`,
    [{ n: 1, kind: "email", id: null, url: "https://mail.google.com/mail/u/0/#all/sample-tap", title: `Your booking is confirmed: London to Lisbon, ${name}`, date: ymd(y, m - 1, 2), account: "Gmail" }],
    "Searched your notes and Gmail",
  );
}

/** Someone else's work, read live from the work accounts: nothing about it is saved, so there's no receipt. */
function sampleWorkmateAnswer(): AnswerReply {
  return LIVE_ANSWERS_NOT_KEPT ? { ...workmateReply(), live_only: true } : workmateReply();
}

function workmateReply(): AnswerReply {
  return reply(
    "Priya has three issues open this cycle: the invoices table migration, in review since Tuesday [1], the flaky checkout test, in progress [2], and VAT numbers on invoices, not started [3]. Priya also has a pull request waiting for a second review [4].",
    [
      { n: 1, kind: "page", id: null, url: "https://linear.app/sample/issue/ENG-1311", title: "ENG-1311 Migrate the invoices table", date: daysAgo(2), account: "Linear" },
      { n: 2, kind: "page", id: null, url: "https://linear.app/sample/issue/ENG-1318", title: "ENG-1318 Fix the flaky checkout test", date: daysAgo(1), account: "Linear" },
      { n: 3, kind: "page", id: null, url: "https://linear.app/sample/issue/ENG-1322", title: "ENG-1322 VAT numbers on invoices", date: daysAgo(4), account: "Linear" },
      { n: 4, kind: "page", id: null, url: "https://github.com/sample/api/pull/5210", title: "Invoices: read from the new table", date: daysAgo(1), account: "GitHub" },
    ],
    "Searched Linear and GitHub",
  );
}

/** What sample mode "saves" from its trip answer: the trip, with Undo. Null for other questions. */
export function sampleFound(question: string): FoundReceipt | null {
  if (!isTripQuestion(question)) return null;
  const { m } = tripMonth(question);
  const mon = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(Date.UTC(2026, m, 15));
  return {
    saved: [{ kind: "trip", title: `Lisbon, 14–18 ${mon}`, href: "#/trips", undo: [{ op: "archive", kind: "trip", id: "sample" }], from: "Gmail" }],
    review: 0,
    already: 0,
    failed: [],
    over_cap: 0,
  };
}

const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });
const weekdayIn = (days: number) => WEEKDAY.format(Date.parse(`${daysAgo(-days)}T12:00:00Z`));
const SAMPLE_TODO = (n: number) => `5a3e0000-0000-4000-8000-0000000005${String(n).padStart(2, "0")}`;

/** "What's on my plate this week?": a list, each line citing one of sample mode's own to-dos. */
function sampleListAnswer(): AnswerReply {
  const r = reply(
    [
      "Four things need you this week, and one is already late:",
      "",
      "- **Book the car's MOT** was due yesterday [1].",
      "- Pick up your prescription today [2].",
      `- Draft the Q3 planning doc by ${weekdayIn(4)} [3]. Your note says to split it into now, next and later [4].`,
      `- Reply to Elena about her pricing memo by ${weekdayIn(6)} [5].`,
      "",
      "Nothing else has a date on it before then.",
    ].join("\n"),
    [
      { n: 1, kind: "todo", id: SAMPLE_TODO(3), url: null, title: "Book the car's MOT", date: daysAgo(1), account: null },
      { n: 2, kind: "todo", id: SAMPLE_TODO(4), url: null, title: "Pick up prescription", date: daysAgo(0), account: null },
      { n: 3, kind: "todo", id: SAMPLE_TODO(5), url: null, title: "Draft the Q3 planning doc", date: daysAgo(-4), account: null },
      { n: 4, kind: "note", id: "5a3e0000-0000-4000-8000-000000000001", url: null, title: "Reframe the Q3 planning doc", date: daysAgo(0), account: null },
      { n: 5, kind: "todo", id: SAMPLE_TODO(6), url: null, title: "Read Elena's pricing memo and reply", date: daysAgo(-6), account: null },
    ],
    "Searched your to-dos and notes",
  );
  return { ...r, next: ["What's due next week?", "Move the MOT to Friday"] };
}

/** "What are the next steps for the Q3 planning doc?": numbered steps, cited inside the items. */
function sampleStepsAnswer(): AnswerReply {
  const r = reply(
    [
      "The Q3 planning doc has three steps left:",
      "",
      "1. **Split the roadmap** into now, next and later [1].",
      "2. Run it past Elena first [1][2].",
      `3. Finish the draft by ${weekdayIn(4)} [3].`,
      "",
      "Your note says the split is easier to defend in review.",
    ].join("\n"),
    [
      { n: 1, kind: "note", id: "5a3e0000-0000-4000-8000-000000000001", url: null, title: "Reframe the Q3 planning doc", date: daysAgo(0), account: null },
      { n: 2, kind: "person", id: SAMPLE_IDS.elena, url: null, title: "Dr. Elena Osei", date: null, account: null },
      { n: 3, kind: "todo", id: SAMPLE_TODO(5), url: null, title: "Draft the Q3 planning doc", date: daysAgo(-4), account: null },
    ],
    "Searched your notes and to-dos",
  );
  return { ...r, next: ["When is the draft due?", "What else is due this week?"] };
}

/** A general answer: nothing of the owner's is behind it, and it says so. */
function sampleGeneralAnswer(): AnswerReply {
  const r = reply(
    [
      "The **50/30/20 rule** splits your take-home pay three ways:",
      "",
      "- Half goes on needs such as rent or mortgage, bills and food.",
      "- 30% goes on wants such as eating out and holidays.",
      "- 20% goes into savings or paying off debt.",
      "",
      "Treat it as a starting point. If your rent is high, needs will take more than half and the other two shrink.",
    ].join("\n"),
    [],
    "Searched your notes",
  );
  return { ...r, found: false, general: true, next: ["Is there a simpler rule?", "How much should I keep for emergencies?"] } as AnswerReply;
}

/** A recipe from general knowledge: ingredients as a list, steps numbered, nothing of the owner's behind it. */
function sampleBrownieAnswer(): AnswerReply {
  const r = reply(
    [
      "**Fudgy brownies** take about 45 minutes and make 16 squares.",
      "",
      "- 200 g dark chocolate",
      "- 175 g unsalted butter",
      "- 3 eggs",
      "- 250 g caster sugar",
      "- 100 g plain flour",
      "- 30 g cocoa powder",
      "",
      "1. Heat the oven to 180°C and line a 20 cm square tin.",
      "2. Melt the chocolate and butter together, then let it cool for 5 minutes.",
      "3. Whisk the eggs and sugar until pale, then fold in the chocolate.",
      "4. Fold in the flour and cocoa, pour into the tin and bake for 25 minutes.",
      "",
      "Leave them to cool in the tin before cutting. They firm up as they cool.",
    ].join("\n"),
    [],
    "Searched your notes",
  );
  return { ...r, found: false, general: true, next: ["Turn this into a recipe"] } as AnswerReply;
}

/** An answer from a web search: its source is a page, shown by its site's name. */
function sampleWebAnswer(): AnswerReply {
  const sources: WebSource[] = [
    { n: 1, kind: "web", id: null, url: "https://www.gov.uk/renew-adult-passport", title: "Renew or replace your adult passport" },
    { n: 2, kind: "web", id: null, url: "https://www.gov.uk/get-a-passport-urgently", title: "Get a passport urgently" },
  ];
  const r = reply(
    "Allow about **three weeks** for a standard renewal, and longer if HM Passport Office asks you for more information [1]. If you travel sooner than that, the one-week Fast Track service costs more and needs an appointment [2].\n\nYou have nothing saved about your own passport, so check its expiry date before you book.",
    [],
    "Searched your notes and the web",
  );
  return { ...r, sources: sources as unknown as AnswerSource[], found: false, general: true, next: ["What does Fast Track cost?", "Remind me to check my passport"] } as AnswerReply;
}

/** A canned answer after a believable pause: the Life log's for a question about watching, playing or posting, else one with a call, an email, a to-do and a person. */
export async function sampleAnswer(question = ""): Promise<AnswerReply> {
  await new Promise((r) => setTimeout(r, 2400));
  if (isPriceHistoryQuestion(question)) return samplePriceAnswer();
  if (isListQuestion(question)) return sampleListAnswer();
  if (isStepsQuestion(question)) return sampleStepsAnswer();
  if (isBrownieQuestion(question)) return sampleBrownieAnswer();
  if (isGeneralQuestion(question)) return sampleGeneralAnswer();
  if (isWebQuestion(question)) return sampleWebAnswer();
  if (isPatternsQuestion(question)) return samplePatternsAnswer();
  if (isRecipeQuestion(question)) return sampleRecipeAnswer(question);
  if (isWorkmateQuestion(question)) return sampleWorkmateAnswer();
  if (isTripQuestion(question)) return sampleTripAnswer(question);
  if (sampleAnswerSteps(question)) return sampleLifeAnswer(question);
  return {
    text: "Elena wants to test two prices before settling on one: keep Starter where it is and try a higher Team price with new customers [1]. She asked you to read her pricing memo and reply with your view by the end of next week [2], which is still on your to-do list [3]. If you'd rather talk it through, she prefers a morning call, before 10 [4].",
    sources: [
      { n: 1, kind: "meeting", id: null, url: "https://notes.granola.ai/d/sample", title: "Pricing check-in with Elena", date: daysAgo(23), account: "Granola" },
      { n: 2, kind: "email", id: null, url: "https://mail.google.com/mail/u/0/#all/sample", title: "Pricing memo, draft 2", date: daysAgo(19), account: "Gmail (work)" },
      { n: 3, kind: "todo", id: "5a3e0000-0000-4000-8000-000000000506", url: null, title: "Read Elena's pricing memo and reply", date: daysAgo(2), account: null },
      { n: 4, kind: "person", id: SAMPLE_IDS.elena, url: null, title: "Dr. Elena Osei", date: null, account: null },
    ],
    related: [
      {
        kind: "note",
        id: "5a3e0000-0000-4000-8000-000000000001",
        title: "Reframe the Q3 planning doc",
        snippet: "Split the roadmap into now/next/later instead of a single flat list. Run it past Dr. Elena Osei first.",
        date: daysAgo(0),
      },
    ],
    searched: "Searched your notes, 3 calls and Gmail",
    skipped: [],
    found: true,
    flagged: false,
  };
}
