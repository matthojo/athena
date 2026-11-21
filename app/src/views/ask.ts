/**
 * Ask: a conversational surface over Athena. A question gets a written answer
 * from Athena and the connected accounts, with numbered sources
 * (components/ask-answer.ts, lib/answer.ts); offline, in sample mode or when
 * that fails, it gets an honest keyword match (lib/ask.ts): the notes, people
 * and to-dos that mention it, never invented prose. An instruction ("add the
 * Lego Ferrari to Rowan's Christmas gift ideas") goes to the assistant (lib/assistant.ts, Claude via
 * AI Gateway), which does the setup itself and answers with a row per
 * change, each with Open and Undo, or with choices when it needs a pick.
 *
 * Every conversation is kept (db/ask-threads.ts: IndexedDB, synced to the
 * server): Ask reopens on your last chat, New starts another, and Chats
 * lists the past ones (a sheet on a phone, a column beside the conversation
 * on a wide screen) to switch to, rename or delete. A search answer is kept
 * as a reference (the question, its keywords and the ids of what matched),
 * and reopening it loads those items as they are now. The chat on screen
 * also lives in module state, so a reply still on its way lands in it after
 * a tab switch.
 *
 * A question can also be spoken: while the box is empty its button is a mic
 * (components/voice.ts), and the transcript is asked exactly as if typed.
 * Beside it, the orb starts Talk (talk/session.ts, loaded on first use): a
 * spoken back-and-forth through the same ask(), with each reply read out in
 * the owner's ElevenLabs voice.
 */

import { attachSpendNotice } from "../components/spend-notice";
import { placeMenuAcross } from "../lib/menu-place";
import { openDay } from "../lib/day-link";
import { h, svg } from "../lib/dom";
import { paintWho as giveWhoColour } from "../team/dot-colour";
import { icons, type IconName } from "../components/icons";
import { brandLogo } from "../components/brand-logo";
import "../styles/documents.css";
import { voiceButton, voiceSupported } from "../components/voice";
import { highlight, noteParts, TYPE_ICON } from "../components/note-row";
import { openCommitmentSheet } from "../components/commitment-sheet";
import { draftRequestChannel, openDraftSheet, sampleDraftChange } from "../components/draft-sheet";
import { moveCard, slotCard } from "../components/slot-card";
import { createCard } from "../components/create-sheet";
import { confirmCard } from "../components/ask-confirm";
import { sampleCard, sampleEvent, sampleProposal, SAMPLE_EVENT_ID, type SchedulingCard } from "../db/scheduling";
import { dayIn, timeIn } from "../lib/create-event";
import { localToday } from "../lib/time";
import { addDays } from "../../../lib/dates";
import { entryCard, formatMoney, healthCard, readingCard, spendingCard } from "../../../lib/ask-logging";
import { loadManualHealth } from "../db/health";
import { loadHouse } from "../db/house";
import { zonedInstant } from "../components/create-sheet";
import { openReadingSheet } from "./reading";
import { openItem } from "../lib/open-item";
import { askNotes, keywords, type AskAnswer } from "../lib/ask";
import { findNote, notesSnapshot, onNotes, refreshNotes } from "../db/data";
import { loadCommitments, loadInteractions, loadReading, memoryChanged, recall } from "../db/memory";
import { recordsChanged } from "../db/records";
import { logisticsChanged } from "../db/trips";
import { customKindsChanged, findCustomRecord, kindById } from "../db/custom-kinds";
import { entityIcon, kindIcon } from "../lib/entity-icon";
import { LIVE_ONLY_KEPT } from "../../../lib/answer-text";
import { ApiError, askAthena, isSampleMode, request as apiRequest, resumeRun, serverKeepsRuns, StreamBroken, undoAssistantChange, warmAsk } from "../db/api";
import { samplePeople } from "../db/sample-data";
import {
  answerFallbackNote,
  answerHistory,
  answerReplyEl,
  hasSampleAnswer,
  sampleAnswer,
  spokenAnswer,
  SAMPLE_QUESTION,
  SAMPLE_LIFE_QUESTION,
  SAMPLE_PATTERNS_QUESTION,
  SAMPLE_TRIP_QUESTION,
  sampleAnswerSteps,
  sampleFollowUp,
  sampleFound,
  savingFromKept,
  keptFromSaving,
  type AnswerMessage,
  type FoundReceipt,
} from "../components/ask-answer";
import { findRecord } from "../db/records";
import { getThread, isStale, relevant, searchThreads, setThreadArchived, takeOpenRequest, type ThreadMatch, type ThreadFilter, listThreads, onThreadsChange, renameThread, saveThread, setLastOpened, syncAskThreads, threadTitle, threadToOpen, receiptFromKept, type KeptReceipt, type SavedAnswer } from "../db/ask-threads";
import { openSheet, type SheetHandle } from "../components/sheet";
import { confirmDialog } from "../components/confirm";
import { showToast } from "../components/toast";
import { compactTime, countWord, dayBucket, hueFor, initials, plural, shortDate } from "../lib/format";
import { prefersReducedMotion, scrollBehavior } from "../lib/motion";
import { applyText, draftParts, type TextEvent } from "../lib/ask-stream";
import { draftRich, lastLine, richNodes, withoutCitations } from "../lib/ask-rich";
import { acted, generalNote, heldNote, isGeneral, isGeneralNote, type ActedKept, type AskActed, type AskReply } from "../lib/ask-contract";
import { BUSY_STEP_ID, busyStepText, withRetry } from "../lib/ask-retry";
import { asksToKeepRecipe, recipeFromReply } from "../lib/ask-reply-recipe";
import { TRY_AGAIN_LABEL, TRY_NOW_LABEL, UNREACHED_NOTE, UNREACHED_RETRYING, afterFailure, isFallback, takeOfflineFallbacks, writeButton, type FallbackCause } from "../lib/ask-fallback";
import { sampleBackOnline, sampleOffline, takeSampleFault } from "../lib/ask-sample-faults";
import { addVersion, beforeEdit, lastMine, loadSlot, pickVersion, saveSlot, versionLabel, type Slot } from "../lib/ask-versions";
import { pinnedAnswers, setPinned, type PinnedAnswer } from "../lib/ask-pins";
import { askKeyAction } from "../lib/ask-keys";
import { leaveAsk, onAskRequest, takeAskRequest, type AskAbout, type OpenAskOptions } from "../lib/open-ask";
import { askCard } from "../components/ask-choices";
import { composerFiles, messageFiles, noteFilesChanged } from "../components/attachments";
import { mentionInput } from "../components/mention-input";
import { linkTextNodes } from "../components/link-text";
import { findMentions, mentionById, mentionThumb, rememberMention } from "../db/mentions";
import { mentionsToText } from "../../../lib/mentions";
import { formatAthenaLink, replaceAthenaLinks } from "../../../lib/links";
import { sourceText } from "../lib/sources";
import { unlockAudio } from "../lib/audio";
import { talkSupported } from "../db/voice-api";
import type { TalkSession } from "../talk/session";
import "../styles/voice.css";
import "../styles/ask-threads.css";
import "../styles/ask-remembered.css";
import "../styles/mentions.css";
import "../styles/ask-steps.css";
import "../styles/ask-polish.css";
import "../styles/ask-choices.css";
import "../styles/ask-plans.css";
import "../styles/skills.css";
import { fetchTonight, goPlan, undoPlanAll } from "../db/ask-plans";
import { SAMPLE_PLAN_REQUEST, SAMPLE_ROUTINE_REQUEST, samplePlan, sampleRoutineChange } from "../db/sample-ask-plans";
import type { AnswerReply, AnswerSource, RelatedItem } from "../../../lib/answer-text";
import { lineupCard } from "../team/lineup-card";
import { askFlowCard, FLOW_WORDS, sampleFlowReply } from "../components/ask-flow-card";
import { draftLineup } from "../db/assignments";
import type { AskConfirmCard, AskFile, AskStep, AskThread, WatchPick, AssistantChange, AssistantReply, AssistantTurn, EntityKind, Note, RecallHit, RecallKind, SavedAskMessage } from "../types";
import { pageHead } from "../components/page-head";
import { ATHENA, checkedWith, findWho, loadTeam, pickWho, teamLoaded, teammateSources, whoLead, whoMark, whoOf, type Who } from "../components/ask-who";
import { ATHENA_STATUS, WORKING } from "../lib/who-status";
import { isLive, splitReport, workingWords } from "../lib/team-report";
import { whenShort } from "../team/page-words";
import { listRuns, onTeamChange, type TeamAssistant, type TeamRun } from "../db/team";
import { onTeamActivity } from "../lib/team-live";
import { mentionMenu } from "../components/mention-menu";
import { draftFromChat, pickableSkills, holdSkillDraft, onSkillsChange, sampleUsedSkill, type AppSkill } from "../db/skills";
import { matchSkills, slashCommand } from "../../../lib/skills";
import { takeNudgeCard } from "../lib/ask-nudge";
import { askSeedCard } from "../components/nudge-card";
import { PICTURE_STEP, SAMPLE_PROMPTS, modelLine, paintSamplePicture, pictureCard, picturesEl, samplePictureAsk, samplePictureModel, syncPictureSlots, takeSampleFellBack, type ModelNote, type ShownPicture } from "../components/ask-picture";
import { archiveSamplePicture, pictureKey, restorePicture } from "../db/ask-pictures";
import { modelLabel } from "../../../lib/model-label";
import type { ModelRef } from "../../../lib/model-types";
import { thinkingModel, visionWarning, visionWords, type VisionWarning } from "../lib/vision-warning";
import { loadModels } from "../db/models";
import { CANT_CHANGE, PICTURE_SETTING, PICTURES_OFF_TEXT } from "../../../lib/picture-words";

export interface AskContext {
  openNote: (note: Note) => void;
  openLink: (kind: EntityKind, id: string) => void;
}

/** What any reply can carry besides itself: its words while they're written, Stop, a pin and its other versions. */
interface ReplyState {
  /** A skill the owner picked with "/" for this request (its id): Try again sends it again. */
  skill?: string;
  /** The words so far while it's written (lib/ask-stream.ts); gone once the reply lands. */
  draft?: string;
  /** Its words were shown as they came, so the steps are folded already. */
  drafted?: boolean;
  /** The owner stopped it part-way. */
  stopped?: boolean;
  /** Its run on the server (lib/ask-run.ts), while how it ended isn't known: sent again under this id it's followed, never repeated. */
  run?: string;
  /** Only the run's id is left (the app was closed part-way): follow it rather than ask. */
  resume?: boolean;
  pinned_at?: string;
  /** Every version when it was written again (lib/ask-versions.ts), shared by all of them. */
  slot?: Slot<Message>;
}

/** What you've done with what a reply did: `undone` holds the changes reversed here; `answered` once a choice is made. */
interface ActState {
  undone: Set<string>;
  undoing: Set<string>;
  /** Changes whose undo no longer works: their Undo is hidden. */
  gone: Set<string>;
  answered: boolean;
  /** A plan's ticked steps (all, until the owner unticks one), and Go or Undo all under way. */
  ticked?: Set<number>;
  going?: boolean;
  undoingAll?: boolean;
}

const noActs = (): ActState => ({ undone: new Set(), undoing: new Set(), gone: new Set(), answered: false });

/** Any reply that can hold receipts, choices, cards and a plan: every reply from Ask's one assistant, and the older instruction replies kept in conversations. */
export type Acting = ActState & { at: string; reply: AskActed | null };


/**
 * A reply from before Ask was one assistant, kept in older conversations: an instruction's (text, receipts,
 * choices), and tonight's picks, which still come this way. New replies are all `answer` messages.
 */
interface AssistantMessage extends ReplyState, ActState {
  role: "assistant";
  at: string;
  /** What was sent, so Try again can ask it again. */
  request: AssistantTurn[];
  reply: AssistantReply | null;
  error: string | null;
  /** What it did on the way (lib/steps.ts): live while it works, then folded under "N steps". */
  steps: AskStep[];
  /** Fold the steps away once, as the reply lands (not when reopened). */
  foldLive?: boolean;
  stepsOpen?: boolean;
}

/** What a search answer found, by id: what's kept, and what's loaded again on reopening. */
interface AnswerRefs {
  notes: string[];
  others: Array<{ kind: RecallKind; id: string }>;
}

/** A reply from Ask (components/ask-answer.ts): its answer and whatever the turn did, with when it came and, reopened, what's kept of it until it loads. */
type WrittenMessage = AnswerMessage & ReplyState & ActState & {
  /**
   * Its connection was lost while the server may still have been working on it (a run the server keeps):
   * writing it again follows that run under the same id, so nothing it changed is changed twice.
   */
  lostRun?: string;
  at: string;
  /** Its keyword-search fallback, by reference. */
  terms: string[];
  refs: AnswerRefs | null;
  saved: Extract<SavedAskMessage, { role: "answer" }> | null;
  steps: AskStep[];
  foldLive?: boolean;
  stepsOpen?: boolean;
};

interface AthenaMessage {
  role: "athena";
  at: string;
  question: string;
  terms: string[];
  /** null while searching, or while a reopened answer loads its items. */
  answer: AskAnswer | null;
  refs: AnswerRefs | null;
}

type MeMessage = Extract<SavedAskMessage, { role: "me" }>;
type Message = MeMessage | AthenaMessage | AssistantMessage | WrittenMessage;

/** Your last message can be edited: it's there and it's yours (a Team run's opening line isn't). */
const canEditLast = (messages: readonly Message[]) => {
  const mine = messages[lastMine(messages)];
  return mine?.role === "me" && !mine.run_line;
};

/** A chat as Ask holds it. `saved`: it's in the store (a new chat isn't, until its first message). */
interface Chat {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
  saved: boolean;
  locked?: boolean;
  /** One of the Team's assistants this conversation is with; null: Athena (docs/team.md). */
  assistant_id?: string | null;
}

const newChat = (assistantId: string | null = null): Chat => {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: "", created_at: now, updated_at: now, messages: [], saved: false, assistant_id: assistantId };
};

/** The chat on screen, kept across tab switches (null until Ask first opens). */
let chat: Chat | null = null;
/** When Ask was last left or hidden: after 12 hours away it opens on a new conversation. */
let awaySince: string | null = null;
/** Back in Ask within this long of leaving it (a source opened, then back): the conversation you were in is still up. */
const BACK_SOON_MS = 2 * 60_000;

const refKey = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;

/** A connection to ask over (sample mode can stage being without one: lib/ask-sample-faults.ts). */
const isOnline = () => navigator.onLine && !sampleOffline();

/** One message as saved, with its pin, Stop and other versions. */
function toSaved(m: Message): SavedAskMessage | null {
  const one = savedOne(m);
  if (!one || (m.role !== "answer" && m.role !== "assistant")) return one;
  return { ...one, ...(m.pinned_at ? { pinned_at: m.pinned_at } : {}), ...saveSlot(m.slot, savedOne) } as SavedAskMessage;
}

function savedOne(m: Message): SavedAskMessage | null {
  if (m.role === "me") return { role: "me", text: m.text, at: m.at, ...(m.files?.length ? { files: m.files } : {}), ...(m.run ? { run: m.run } : {}), ...(m.run_line ? { run_line: true } : {}), ...(m.model ? { model: m.model } : {}) };
  if (m.role === "answer") {
    // Reopened and still loading: what was kept stands (with an Undo made since).
    if (m.saved && !m.reply && !m.fallback) {
      // Its versions and pin are the slot's, saved once around it.
      const { versions: _v, version: _n, pinned_at: _p, ...kept } = m.saved;
      return { ...kept, ...receiptToSave(m), ...actsToSave(m, kept as ActedKept) } as SavedAskMessage;
    }
    // Read live from Linear or GitHub (someone's work, maybe): kept only as a line saying so, never its text, sources or follow-ups.
    if (m.reply?.live_only) {
      const r = m.reply;
      return { role: "answer", at: m.at, question: m.question, text: LIVE_ONLY_KEPT, sources: [], related: [], searched: r.searched, skipped: [], found: false, flagged: r.flagged, sample: m.sample, note: null, fallback: null, live_only: true, ...stepsToSave(m.steps) };
    }
    if (m.reply) {
      const r = m.reply;
      return {
        role: "answer",
        at: m.at,
        question: m.question,
        text: r.text,
        // Athena's own by id only; a connected account's keeps its title (it can't be loaded again).
        sources: r.sources.map((s) => ({ n: s.n, kind: s.kind, id: s.id, url: s.url, date: s.date, account: s.account, ...(s.id ? {} : { title: s.title }), ...(s.art ? { art: s.art } : {}), ...(s.detail ? { detail: s.detail } : {}) })),
        related: r.related.map((x) => ({ kind: x.kind, id: x.id })),
        // A general answer is kept as the line it shows (lib/ask-contract.ts).
        searched: isGeneral(r) ? generalNote(r) : r.searched,
        skipped: r.skipped,
        found: r.found,
        flagged: r.flagged,
        sample: m.sample,
        note: null,
        fallback: null,
        ...(r.next?.length ? { next: r.next } : {}),
        ...(r.clarify ? { clarify: true } : {}),
        ...(r.asks?.length ? { asks: r.asks } : {}),
        ...(r.skills?.length ? { skills: r.skills } : {}),
        ...keptModel(r as ModelNote),
        ...(m.stopped ? { stopped: true } : {}),
        ...stepsToSave(m.steps),
        ...receiptToSave(m),
        ...actsToSave(m, r),
      } as SavedAskMessage;
    }
    if (m.refs) {
      return {
        role: "answer",
        at: m.at,
        question: m.question,
        text: "",
        sources: [],
        related: [],
        searched: "",
        skipped: [],
        found: false,
        flagged: false,
        sample: m.sample,
        note: m.note,
        fallback: { terms: m.terms, ...m.refs },
        // A follow-up with no reply: kept as that, so the chat reopened shows why and Try again, never a search.
        ...(m.unreached ? { unreached: m.unreached } : {}),
        // Its run may still be going on the server: kept, so writing it again follows that run rather than starting another.
        ...(m.lostRun ? { run: m.lostRun } : {}),
      } as SavedAskMessage;
    }
    return null;
  }
  if (m.role === "athena") {
    if (!m.refs) return null;
    return { role: "athena", at: m.at, question: m.question, terms: m.terms, notes: m.refs.notes, others: m.refs.others };
  }
  return {
    role: "assistant",
    at: m.at,
    request: m.request,
    reply: m.reply,
    error: m.error,
    undone: [...m.undone],
    ...(m.gone.size ? { gone: [...m.gone] } : {}),
    answered: m.answered,
    ...(m.stopped ? { stopped: true } : {}),
    ...(m.reply ? stepsToSave(m.steps) : {}),
    // Still working: its run, so the app reopened part-way follows it rather than asking again.
    ...(m.run && !m.reply ? { run: m.run } : {}),
  };
}

/** Kept with the conversation: the lines as they ended, so a reopened reply still shows "N steps". */
function stepsToSave(steps: AskStep[]): { steps?: string[] } {
  const done = shownSteps(steps).map((x) => x.text);
  return done.length ? { steps: done } : {};
}

/** What a reply did (its receipts, choices, cards and plan) and what's been done with it since: kept with the conversation, so it's all there when reopened. */
function actsToSave(m: ActState, r: AskActed): ActedKept {
  if (!acted(r)) return {};
  return {
    ...(r.lineup ? { lineup: r.lineup } : {}),
    ...(r.flow ? { flow: r.flow } : {}),
    ...(r.changes?.length ? { changes: r.changes } : {}),
    ...(r.choices?.length ? { choices: r.choices } : {}),
    ...(r.scheduling ? { scheduling: r.scheduling } : {}),
    ...(r.confirm?.length ? { confirm: r.confirm } : {}),
    ...(r.plan ? { plan: r.plan } : {}),
    ...(r.picks?.length ? { picks: r.picks } : {}),
    ...(m.undone.size ? { undone: [...m.undone] } : {}),
    ...(m.gone.size ? { gone: [...m.gone] } : {}),
    ...(m.answered ? { answered: true } : {}),
  };
}

/** What a kept reply did, read back onto the reply it's shown from. */
function actsFromSaved(k: ActedKept): AskActed {
  return {
    ...(k.lineup ? { lineup: k.lineup } : {}),
    ...(k.flow ? { flow: k.flow } : {}),
    ...(k.changes?.length ? { changes: k.changes } : {}),
    ...(k.choices?.length ? { choices: k.choices } : {}),
    ...(k.scheduling ? { scheduling: k.scheduling } : {}),
    ...(k.confirm?.length ? { confirm: k.confirm } : {}),
    ...(k.plan ? { plan: k.plan } : {}),
    ...(k.picks?.length ? { picks: k.picks } : {}),
  };
}

/** What the answer saved to Athena, with what was undone, so a reopened conversation still shows it with Undo. */
function receiptToSave(m: WrittenMessage): { receipt?: KeptReceipt } {
  const receipt = keptFromSaving(m.saving);
  return receipt ? { receipt } : {};
}

const stepsFrom = (texts: string[] | undefined): AskStep[] => (texts ?? []).map((text, i) => ({ id: `saved:${i}`, text, done: true }));

/** A saved message read back; a reply written more than once comes back with all its versions. */
function fromSaved(s: SavedAskMessage): Message {
  if (s.role !== "answer" && s.role !== "assistant") return fromSavedOne(s);
  const slot = loadSlot(s, fromSavedOne);
  const m = (slot ? slot.all[slot.index] : fromSavedOne(s)) as AssistantMessage | WrittenMessage;
  if (slot) for (const v of slot.all) (v as ReplyState).slot = slot;
  if (s.pinned_at) m.pinned_at = s.pinned_at;
  return m;
}

function fromSavedOne(s: SavedAskMessage): Message {
  if (s.role === "me") return { ...s };
  if (s.role === "answer") {
    const fb = s.fallback;
    const k = s as ActedKept & { run?: unknown; unreached?: unknown };
    const unreached = fb && typeof k.unreached === "string" && k.unreached in UNREACHED_NOTE ? (k.unreached as FallbackCause) : undefined;
    return {
      role: "answer",
      at: s.at,
      question: s.question,
      reply: null,
      // An unreached follow-up has nothing to load: it's there as soon as the chat opens. Asked again only by a tap (or the connection coming back).
      fallback: unreached ? { terms: [], notes: [], others: [], state: "online" } : null,
      ...(unreached ? { unreached, autoTried: true, offline: unreached === "offline" } : {}),
      note: s.note,
      sample: s.sample,
      terms: fb?.terms ?? [],
      refs: fb ? { notes: fb.notes, others: fb.others } : null,
      saved: s,
      steps: stepsFrom(s.steps),
      saving: savingFromKept(receiptFromKept((s as SavedAnswer).receipt)),
      ...noActs(),
      undone: new Set(k.undone ?? []),
      gone: new Set(k.gone ?? []),
      answered: k.answered === true,
      ...(fb && typeof k.run === "string" ? { lostRun: k.run } : {}),
      ...(s.stopped ? { stopped: true } : {}),
    };
  }
  if (s.role === "athena") return { role: "athena", at: s.at, question: s.question, terms: s.terms, answer: null, refs: { notes: s.notes, others: s.others } };
  return {
    role: "assistant",
    at: s.at,
    request: s.request,
    reply: s.reply,
    // Saved while it was still working (the app closed mid-request): say so, with Try again.
    error: s.reply || s.error ? s.error : "This didn't finish. Try again.",
    undone: new Set(s.undone),
    undoing: new Set(),
    gone: new Set(s.gone ?? []),
    answered: s.answered,
    steps: stepsFrom(s.steps),
    ...(s.stopped ? { stopped: true } : {}),
    // Saved while its run was going: Ask follows the run when the chat is shown, and so does Try again.
    ...(s.run && !s.reply ? { run: s.run, resume: true } : {}),
  };
}

function toChat(t: AskThread): Chat {
  const c: Chat = { id: t.id, title: t.title, created_at: t.created_at, updated_at: t.updated_at, messages: t.messages.map(fromSaved), saved: true, locked: t.locked, assistant_id: t.assistant_id ?? null };
  // An Undo on a kept receipt is kept too.
  for (const m of c.messages) if (m.role === "answer" && m.saving) m.saving.onChange = () => keep(c);
  return c;
}

function toThread(c: Chat): AskThread {
  return {
    id: c.id,
    title: c.title,
    ...(c.assistant_id ? { assistant_id: c.assistant_id } : {}),
    created_at: c.created_at,
    updated_at: c.updated_at,
    messages: c.messages.map(toSaved).filter((m): m is SavedAskMessage => !!m),
  };
}

/** Keep a chat after something in it changed. */
function keep(c: Chat) {
  if (!c.messages.length || c.locked) return;
  c.updated_at = new Date().toISOString();
  if (!c.saved) void setLastOpened(c.id);
  c.saved = true;
  void saveThread(toThread(c));
}

/** A reopened search answer: the same notes and matches, as they are now. Anything deleted since drops out. */
async function loadAnswer(m: AthenaMessage): Promise<AskAnswer> {
  const refs = m.refs ?? { notes: [], others: [] };
  const sample = isSampleMode();
  const live = sample && notesSnapshot().loaded ? new Set(notesSnapshot().notes.map((n) => n.id)) : null;
  const notes = (await Promise.all(refs.notes.map((id) => findNote(id).catch(() => null)))).filter(
    (n): n is Note => !!n && !n.archived_at && (!live || live.has(n.id))
  );
  let others: RecallHit[] = [];
  if (refs.others.length) {
    const found = new Map<string, RecallHit>();
    const { hits } = await recall(m.terms.join(" or ")).catch(() => ({ hits: [] as RecallHit[] }));
    for (const hit of hits) found.set(refKey(hit), hit);
    const missing = refs.others.filter((r) => !found.has(refKey(r)));
    const kinds = new Set(missing.map((r) => r.kind));
    const [commitments, reading, interactions] = await Promise.all([
      kinds.has("commitment") ? loadCommitments().then((r) => r.items).catch(() => []) : [],
      kinds.has("reading") ? loadReading().then((r) => r.items).catch(() => []) : [],
      kinds.has("interaction") ? loadInteractions().then((r) => r.items).catch(() => []) : [],
    ]);
    for (const c of commitments) if (!c.archived_at) found.set(refKey({ kind: "commitment", id: c.id }), { kind: "commitment", id: c.id, title: c.title, snippet: c.notes, at: c.updated_at, person: c.person, rank: 0 });
    for (const r of reading) if (!r.archived_at) found.set(refKey({ kind: "reading", id: r.id }), { kind: "reading", id: r.id, title: r.title, snippet: r.author, at: r.updated_at, person: null, rank: 0 });
    for (const i of interactions) if (!i.archived_at) found.set(refKey({ kind: "interaction", id: i.id }), { kind: "interaction", id: i.id, title: i.summary.slice(0, 80), snippet: i.summary, at: i.at, person: i.people[0] ?? null, rank: 0 });
    for (const r of missing.filter((x) => x.kind === "person")) {
      const p = await findRecord("person", r.id).catch(() => null);
      if (p && !p.archived_at) found.set(refKey(r), { kind: "person", id: p.id, title: p.name, snippet: p.relationship ?? "", at: p.updated_at, person: null, rank: 0 });
    }
    for (const r of missing.filter((x) => x.kind === "record")) {
      const rec = await findCustomRecord(r.id).catch(() => null);
      const k = rec ? kindById(rec.kind_id) : undefined;
      if (rec && k) found.set(refKey(r), { kind: "record", id: rec.id, title: rec.title, snippet: "", at: rec.updated_at, person: null, rank: 0, custom_kind: { id: k.id, one: k.one } });
    }
    others = refs.others.map((r) => found.get(refKey(r))).filter((h): h is RecallHit => !!h);
  }
  return { terms: m.terms, notes, others, state: sample ? "sample" : navigator.onLine ? "online" : "offline" };
}

/** A reopened written answer: Athena's own sources and related items as they are now; anything deleted since drops out. */
async function loadWritten(s: Extract<SavedAskMessage, { role: "answer" }>): Promise<AskReply> {
  const todoIds = [...s.sources.filter((x) => x.kind === "todo" && x.id).map((x) => x.id!), ...s.related.filter((x) => x.kind === "todo").map((x) => x.id)];
  const todos = todoIds.length ? await loadCommitments().then((r) => r.items).catch(() => []) : [];
  const look = async (kind: string, id: string): Promise<{ title: string; snippet: string; date: string | null } | null> => {
    if (kind === "note") {
      const n = await findNote(id).catch(() => null);
      if (!n || n.archived_at) return null;
      const { title, rest } = noteParts(n);
      return { title, snippet: rest.replace(/\s+/g, " ").slice(0, 160), date: n.updated_at.slice(0, 10) };
    }
    if (kind === "person") {
      const p = await findRecord("person", id).catch(() => null);
      return p && !p.archived_at ? { title: p.name, snippet: p.relationship ?? "", date: null } : null;
    }
    if (kind === "todo") {
      const t = todos.find((x) => x.id === id && !x.archived_at);
      return t ? { title: t.title, snippet: t.notes, date: t.due_on ?? null } : null;
    }
    if (kind === "record") {
      const r = await findCustomRecord(id).catch(() => null);
      const k = r ? kindById(r.kind_id) : undefined;
      return r ? { title: r.title, snippet: k ? k.one.charAt(0).toUpperCase() + k.one.slice(1) : "", date: null } : null;
    }
    if (kind === "watch") {
      const w = await loadReading().then((r) => r.items.find((x) => x.id === id && !x.archived_at)).catch(() => undefined);
      return w ? { title: w.title, snippet: w.author, date: null } : null;
    }
    return null;
  };
  // A cover and a Watch & read title's state come back as they were kept.
  const kept = (src: (typeof s.sources)[number]) => ({ ...(src.art ? { art: src.art } : {}), ...(src.detail ? { detail: src.detail } : {}) });
  const sources: AnswerSource[] = [];
  for (const src of s.sources) {
    if (!src.id) {
      sources.push({ n: src.n, kind: src.kind as AnswerSource["kind"], id: null, url: src.url, date: src.date, account: src.account, title: src.title ?? "", ...kept(src) });
      continue;
    }
    const now = await look(src.kind, src.id);
    if (now) sources.push({ n: src.n, kind: src.kind as AnswerSource["kind"], id: src.id, url: src.url, date: src.date, account: src.account, title: now.title, ...kept(src) });
  }
  const related: RelatedItem[] = [];
  for (const r of s.related) {
    const now = await look(r.kind, r.id);
    if (now) related.push({ kind: r.kind, id: r.id, title: now.title, snippet: now.snippet, date: now.date });
  }
  return { ...(isGeneralNote(s.searched) ? { general: true } : {}), text: s.text, sources, related, searched: s.searched, skipped: s.skipped, found: s.found, flagged: s.flagged, ...(s.next?.length ? { next: s.next } : {}), ...(s.clarify ? { clarify: true } : {}), ...(s.asks?.length ? { asks: s.asks } : {}), ...(s.skills?.length ? { skills: s.skills } : {}), ...keptModel(s as ModelNote), ...actsFromSaved(s as ActedKept) };
}

/** Pictures and which model answered: kept with the reply, and read back as they were. */
function keptModel(r: ModelNote): ModelNote {
  return {
    ...(r.pictures?.length ? { pictures: r.pictures } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.fell_back ? { fell_back: true } : {}),
    ...(r.tried ? { tried: r.tried } : {}),
  };
}

/** Undo on an older note edit would put back text written since: hide it once the note has moved on. */
async function checkUndos(m: Acting): Promise<boolean> {
  let changed = false;
  for (const c of m.reply?.changes ?? []) {
    const key = changeKey(c);
    if (!c.undo || m.undone.has(key) || m.gone.has(key) || c.kind !== "note" || c.action !== "updated") continue;
    const note = await findNote(c.id).catch(() => null);
    if (!note || note.archived_at || Date.parse(note.updated_at) > Date.parse(m.at) + 10_000) {
      m.gone.add(key);
      changed = true;
    }
  }
  return changed;
}

const quote = (t: string) => `“${t}”`;

const RECALL_ICON: Record<RecallHit["kind"], IconName> = {
  note: "note",
  commitment: "loop",
  fact: "sparkle",
  person: "person",
  interaction: "chat",
  reading: "bookmark",
  record: "folder",
  day: "calendar",
};

const recallIcon = (hit: RecallHit): IconName => (hit.kind === "record" ? entityIcon("record", hit.custom_kind?.id) : RECALL_ICON[hit.kind]);

function recallMeta(hit: RecallHit): string {
  const who = hit.person?.name;
  switch (hit.kind) {
    case "commitment":
      return who ? `To do · ${who}` : "To do";
    case "fact":
      return who ? `About ${who}` : "About you";
    case "interaction":
      return `Catch-up${who ? ` with ${who}` : ""} · ${shortDate(hit.at)}`;
    case "person":
      return hit.snippet || "Person";
    case "reading":
      return "Watch & read";
    case "day":
      return [shortDate(hit.at), hit.snippet].filter(Boolean).join(" · ");
    case "record": {
      const one = hit.custom_kind?.one ?? "";
      return [one.charAt(0).toUpperCase() + one.slice(1), hit.snippet].filter(Boolean).join(" · ");
    }
    default:
      return "";
  }
}

/** Open a recall hit where it lives: a person's profile, a to-do's sheet, its Watch & read sheet. */
async function openHit(hit: RecallHit, ctx: AskContext) {
  if (hit.kind === "person") return ctx.openLink("person", hit.id);
  if (hit.kind === "record") return ctx.openLink("record", hit.id);
  if (hit.kind === "day") return openDay(hit.id);
  if ((hit.kind === "fact" || hit.kind === "interaction") && hit.person) return ctx.openLink("person", hit.person.id);
  if (hit.kind === "commitment") {
    const c = (await loadCommitments()).items.find((x) => x.id === hit.id);
    if (c) openCommitmentSheet(c);
    return;
  }
  if (hit.kind === "reading") {
    const r = (await loadReading()).items.find((x) => x.id === hit.id);
    if (r) openReadingSheet(r);
  }
}

const CHANGE_ICON: Record<AssistantChange["kind"], IconName> = {
  picture: "image",
  field: "sliders",
  note: "note",
  person: "person",
  people: "people",
  commitment: "loop",
  reminder: "bell",
  fact: "sparkle",
  interaction: "chat",
  draft: "mail",
  reading: "bookmark",
  kind: "folder",
  record: "folder",
  place: "pin",
  organisation: "building",
  event: "calendar",
  goal: "target",
  asset: "shield",
  project: "project",
  trip: "suitcase",
  booking: "ticket",
  purchase: "parcel",
  link: "link",
  document: "external",
  recipe: "pot",
  routine: "refresh",
  skill: "book",
  price: "tag",
  tracker: "tag",
};

/** A change's icon: a record or one of the owner's own kinds shows that kind's own. */
const changeIcon = (c: AssistantChange): IconName =>
  c.icon ? kindIcon({ icon: c.icon }) : c.open?.kind === "draft" && c.open.draft.channel && c.open.draft.channel !== "email" ? "chat" : CHANGE_ICON[c.kind];

const changeKey = (c: AssistantChange) => `${c.kind}:${c.id}:${c.action}`;

/** The rest of the app reloads what the assistant changed. */
function changedElsewhere() {
  void refreshNotes();
  memoryChanged();
  recordsChanged();
  customKindsChanged();
  logisticsChanged();
}

/** A chip in a message: Saved, a to-do or a Watch & read title open here (lib/open-item.ts); the rest as links do. */
async function openMention(kind: string, id: string, ctx: AskContext) {
  if (!(await openItem({ kind, id }))) ctx.openLink(kind as EntityKind, id);
}

async function openChange(c: AssistantChange, ctx: AskContext) {
  const open = c.open;
  if (!open) return;
  if (open.kind === "draft") {
    openDraftSheet({ draft: open.draft });
    return;
  }
  // A Google Doc or Notion page Athena made (lib/documents.ts).
  if (open.kind === "doc") {
    window.open(open.url, "_blank", "noopener");
    return;
  }
  if (open.kind === "commitment") {
    const found = (await loadCommitments()).items.find((x) => x.id === open.id);
    if (found) openCommitmentSheet(found);
    return;
  }
  if (open.kind === "reading") {
    const found = (await loadReading()).items.find((x) => x.id === open.id);
    if (found) openReadingSheet(found);
    return;
  }
  // A kept price (record_price): its saved item, where the price history is.
  if (open.kind === "saved") {
    location.hash = `#/saved/${encodeURIComponent(open.id)}`;
    return;
  }
  // A routine is a Team assistant now (save_routine makes one): its page, where it can be paused or changed.
  if (open.kind === "routine") {
    location.hash = `#/team/${open.id}`;
    return;
  }
  // One of the owner's own kinds: its Library section.
  if (open.kind === "kind") {
    if (kindById(open.id)) location.hash = `#/kind/${encodeURIComponent(open.id)}`;
    else showToast("That isn't available. It may be archived", { icon: "archive" });
    return;
  }
  // Goals, life admin and Settings' fields open here (lib/open-item.ts).
  if (await openItem(open)) return;
  ctx.openLink(open.kind as EntityKind, open.id);
}

/** The connection went (or the platform answered for a server that was restarting), so how the run ended isn't known. */
const lostTouch = (error: unknown) => error instanceof StreamBroken || error instanceof TypeError || (error instanceof ApiError && (error.status === 502 || error.status === 504));

const CANCEL = /^(cancel|no|not now|never ?mind|leave it|skip)\b/i;

/** A change, as a row: tap it to open what changed; Undo on the right. */
/** Reverse one change from a reply, and remember it was. */
async function undoChange(key: string, undoOp: NonNullable<AssistantChange["undo"]>, m: Acting, repaint: () => void, save: () => void, activityId?: string) {
  m.undoing.add(key);
  repaint();
  try {
    await undoAssistantChange(undoOp, activityId);
    m.undone.add(key);
    changedElsewhere();
    save();
  } catch (error) {
    // Refused (what it changed has moved on or gone): hide Undo quietly. Anything else is worth a retry.
    if (error instanceof ApiError && error.status && error.status >= 400 && error.status < 500 && error.status !== 429) {
      m.gone.add(key);
      save();
    } else showToast("Couldn't undo that. Try again in a moment.", { icon: "restore" });
  } finally {
    m.undoing.delete(key);
    repaint();
  }
}

/** A detail Ask remembered ("remember that I'm vegetarian"): one line in the reply, "Remembered · Undo", rather than a receipt row. */
function rememberedLine(c: AssistantChange, m: Acting, repaint: () => void, save: () => void): HTMLElement {
  const key = changeKey(c);
  const what = c.title === "You" ? c.detail : `${c.title} · ${c.detail}`;
  if (m.undone.has(key)) return h("p", { class: "remembered is-undone", title: what }, icons.restore(), h("span", {}, "Forgotten"));
  const undo = c.undo && !m.gone.has(key)
    ? (h("button", { class: "remembered__undo", type: "button", "aria-label": `Undo: forget ${what}`, disabled: m.undoing.has(key) }, m.undoing.has(key) ? "Undoing…" : "Undo") as HTMLButtonElement)
    : null;
  if (undo) undo.addEventListener("click", () => void undoChange(key, c.undo!, m, repaint, save, c.activity_id));
  const known = h("a", { class: "remembered__what", href: "#/settings/knows", title: "See everything Athena knows" }, what);
  return h("p", { class: "remembered", role: "status" }, icons.check(), h("span", {}, "Remembered"), ...(undo ? [h("span", { class: "remembered__dot", "aria-hidden": "true" }, "·"), undo] : []), known);
}

function changeRow(c: AssistantChange, i: number, m: Acting, ctx: AskContext, repaint: () => void, save: () => void): HTMLElement {
  const key = changeKey(c);
  const undone = m.undone.has(key);
  const undoing = m.undoing.has(key);
  const doc = c.open?.kind === "doc" ? c.open : null;
  const lead =
    c.kind === "person"
      ? h("span", { class: "avatar avatar--row", style: `--h:${hueFor(c.title)}`, "aria-hidden": "true" }, initials(c.title))
      : doc
        ? brandLogo(doc.provider, "sm")
        : h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[changeIcon(c)]());
  const body = h(
    "span",
    { class: "change__body" },
    h("span", { class: "change__title" }, c.title),
    h("span", { class: "change__detail" }, c.detail)
  );
  // Opening an archived item would only say it's archived, so an undone creation stops opening.
  const canOpen = !!c.open && !(undone && c.action === "created");
  const main = canOpen
    ? h("button", { class: "change__main", type: "button", "aria-label": doc ? `${doc.provider === "notion" ? "Open in Notion" : "Open in Docs"}: ${c.title}` : `Open ${c.title}` }, lead, body)
    : h("div", { class: "change__main" }, lead, body);
  if (canOpen) main.addEventListener("click", () => void openChange(c, ctx));

  let trailing: HTMLElement | null = null;
  if (undone) trailing = h("span", { class: "change__state" }, icons.restore(), "Undone");
  else if (c.undo && !m.gone.has(key)) {
    const undoOp = c.undo;
    const undo = h(
      "button",
      { class: "btn btn--soft btn--sm change__undo", type: "button", "aria-label": `Undo: ${c.label}`, disabled: undoing },
      undoing ? "Undoing…" : "Undo"
    ) as HTMLButtonElement;
    undo.addEventListener("click", () => void undoChange(key, undoOp, m, repaint, save, c.activity_id));
    trailing = undo;
  }
  // A doc or page says where it opens, beside Undo.
  const openIn =
    doc && !undone
      ? h("a", { class: "btn btn--soft btn--sm change__open", href: doc.url, target: "_blank", rel: "noopener noreferrer" }, doc.provider === "notion" ? "Open in Notion" : "Open in Docs")
      : null;
  return h("div", { class: `change${undone ? " is-undone" : ""}${openIn ? " change--doc" : ""}`, style: `--i:${i}` }, main, openIn, trailing);
}

function assistantEl(m: AssistantMessage, ctx: AskContext, choose: (text: string) => void, retry: () => void, repaint: () => void, save: () => void): HTMLElement {
  const orb = (thinking = false) => h("span", { class: `orb${thinking ? " orb--thinking" : ""}`, "aria-hidden": "true" });

  if (!m.reply && !m.error) return workingEl(m, "Athena is working on it", "Working on it…", "Still working…", "assistant");

  if (!m.reply) {
    const again = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.refresh(), "Try again");
    again.addEventListener("click", retry);
    return h(
      "div",
      { class: "msg msg--athena" },
      orb(),
      h("div", { class: "bubble assist__error" }, h("p", {}, m.error), m.request.length ? h("div", { class: "assist__retry" }, again) : null)
    );
  }

  const { text } = m.reply;
  const parts = actedEls(m, ctx, choose, repaint, save);
  const did = (m.reply.changes ?? []).length > 0;
  return h(
    "div",
    { class: "msg msg--athena" },
    orb(),
    h(
      "div",
      { class: "assist" },
      h("div", { class: "bubble" }, stepsFold(m), h("p", {}, ...linkTextNodes(text, (kind, id) => void openMention(kind, id, ctx))), ...parts.within),
      ...parts.cards,
      m.reply.picks?.length ? picksEl(m.reply.picks) : null,
      parts.changes,
      h("p", { class: "assist__foot" }, icons.sparkle(), m.reply.picks ? "From your own list" : did ? "Done by the Agent" : m.reply.plan && !m.reply.plan.ran ? "Planned by the Agent" : "From the Agent")
    )
  );
}

/**
 * What a reply did, as the pieces that go with its words. `within` sits in the bubble under the text: what it
 * remembered ("Remembered · Undo") and the choices it's waiting on. `cards` follow the bubble: times to pick, what
 * would leave Athena (each waits for a tap, security review M7) and a plan. `changes` is the receipts, each with
 * Open and Undo.
 */
function actedEls(m: Acting, ctx: AskContext, choose: (text: string) => void, repaint: () => void, save: () => void): { within: HTMLElement[]; cards: HTMLElement[]; changes: HTMLElement | null } {
  const r = m.reply ?? {};
  const all = r.changes ?? [];
  // What Ask remembered shows in the bubble; everything else as receipt rows.
  const remembered = all.filter((c) => c.kind === "fact");
  // A picture shows as itself, with its own Undo (components/ask-picture.ts), when the reply carries it.
  const shownPics = new Set(((r as ModelNote).pictures ?? []).map((p) => p.file.id));
  const changes = all.filter((c) => c.kind !== "fact" && !(c.kind === "picture" && shownPics.has(c.id)));
  const choices = r.choices ?? [];
  const picks =
    choices.length && !m.answered
      ? h(
          "div",
          { class: "choices" },
          ...choices.map((choice, i) => {
            const tone = CANCEL.test(choice) ? "btn--ghost" : i === 0 ? "btn--primary" : "btn--soft";
            const b = h("button", { class: `btn ${tone} btn--block`, type: "button" }, choice);
            b.addEventListener("click", () => choose(choice));
            return b;
          })
        )
      : null;
  const scheduling = r.scheduling;
  return {
    within: [...remembered.map((c) => rememberedLine(c, m, repaint, save)), ...(picks ? [picks] : [])],
    cards: [
      ...(scheduling ? [scheduling.kind === "slots" ? slotCard(scheduling.card) : scheduling.kind === "move" ? moveCard(scheduling.move) : createCard(scheduling.create)] : []),
      ...(r.confirm ?? []).map((card) => confirmCard(card)),
      ...(r.plan ? [planEl(m, r.plan, repaint, save)] : []),
      // start_assignment's lineup: reorder, swap, set checkpoints, then Go (team/lineup-card.ts). Kept with the conversation, started or not.
      ...(r.lineup ? [lineupCard({ lineup: r.lineup.lineup, fallback: r.lineup.fallback, draftId: r.lineup.id, startedId: r.lineup.started, onChange: (l) => ((r.lineup!.lineup = l), save()), onStarted: (a) => ((r.lineup!.started = a.id), save()) })] : []),
      // propose_flow's flow, kept off: Turn on and Edit steps (components/ask-flow-card.ts). Kept with the conversation, on or off.
      ...(r.flow ? [askFlowCard({ card: r.flow, onChange: (on) => ((r.flow!.on = on), save()) })] : []),
      // Tonight's picks, however they were asked for: the card the evening chip shows.
      ...(r.picks?.length ? [picksEl(r.picks)] : []),
    ],
    changes: changes.length
      ? h("div", { class: "card card--flush changes", role: "list", "aria-label": changes.length === 1 ? "What changed" : `What changed: ${changes.length} things` }, ...changes.map((c, i) => changeRow(c, i, m, ctx, repaint, save)))
      : null,
  };
}

// ---------- Plans (lib/ask-plans.ts) and tonight's picks ----------

/**
 * A plan: each step with a tick, and Go. Nothing has changed until Go; then
 * each step says how it went, its receipt joins the reply's (each with Undo),
 * and Undo all takes the lot back, newest first.
 */
export function planEl(m: Acting, plan: NonNullable<AskActed["plan"]>, repaint: () => void, save: () => void): HTMLElement {
  const ran = plan.ran;
  const ticked = (m.ticked ??= new Set(plan.steps.map((_, i) => i)));
  // One step held back by what the turn read first (lib/ask-guard.ts) is a change to confirm, not a plan to tick through.
  const held = !ran ? heldNote(plan.why) : null;
  const one = plan.steps.length === 1;
  const head = h("p", { class: "plan__head" }, icons.checklist(), ran ? "Done" : plan.proposed ? "Your routine suggests" : held && one ? "Waiting for you" : "The plan");
  if (!ran) {
    const go = h("button", { class: "btn btn--primary plan__go", type: "button", disabled: m.going || !ticked.size }, m.going ? "Going…" : ticked.size === plan.steps.length ? "Go" : `Go with ${ticked.size} of ${plan.steps.length}`) as HTMLButtonElement;
    const rows = plan.steps.map((step, i) => {
      const box = h("input", { type: "checkbox", class: "plan__tick", checked: ticked.has(i), disabled: m.going }) as HTMLInputElement;
      box.addEventListener("change", () => {
        if (box.checked) ticked.add(i);
        else ticked.delete(i);
        repaint();
      });
      return h("label", { class: "plan__step", style: `--i:${i}` }, box, h("span", { class: "plan__label" }, step.label));
    });
    go.addEventListener("click", async () => {
      m.going = true;
      repaint();
      try {
        const done = await goPlan(plan, [...ticked].sort((a, b) => a - b));
        if (m.reply) {
          m.reply.plan = done.plan;
          m.reply.changes = [...(m.reply.changes ?? []), ...done.changes];
        }
        changedElsewhere();
        save();
      } catch (error) {
        showToast(error instanceof Error && error.message && !(error instanceof ApiError && !error.status) ? error.message : "Go didn't go through. Try again in a moment.", { icon: "refresh" });
      } finally {
        m.going = false;
        repaint();
      }
    });
    return h(
      "section",
      { class: `card plan${held ? " plan--held" : ""}`, "aria-label": held && one ? "A change waiting for you" : "Plan" },
      head,
      h("div", { class: "plan__steps" }, ...rows),
      h("div", { class: "plan__foot" }, h("p", { class: "plan__note" }, held ?? (plan.proposed || one ? "Nothing changes until you tap Go." : "Untick anything you don't want. Nothing changes until you tap Go.")), go)
    );
  }
  const STATUS = { done: ["check", "Done"], skipped: ["minus", "Skipped"], failed: ["close", "Didn't work"] } as const;
  const rows = plan.steps.map((step, i) => {
    const r = ran.results[i] ?? { status: "skipped" as const, changes: [] };
    const [icon, word] = STATUS[r.status];
    return h(
      "div",
      { class: `plan__step plan__step--${r.status}`, style: `--i:${i}` },
      h("span", { class: "plan__mark", "aria-hidden": "true" }, icons[icon]()),
      h("span", { class: "plan__label" }, step.label, h("span", { class: "plan__state" }, r.error ? `${word}: ${r.error}` : word))
    );
  });
  const made = ran.results.flatMap((r) => r.changes).filter((c) => c.undo);
  const standing = made.filter((c) => !m.undone.has(changeKey(c)) && !m.gone.has(changeKey(c)));
  let all: HTMLElement | null = null;
  if (made.length > 1 && standing.length) {
    all = h("button", { class: "btn btn--soft btn--sm plan__undo", type: "button", disabled: m.undoingAll }, m.undoingAll ? "Undoing…" : "Undo all") as HTMLButtonElement;
    all.addEventListener("click", async () => {
      m.undoingAll = true;
      repaint();
      try {
        const out = await undoPlanAll(plan);
        for (const c of made) {
          const r = out.find((x) => x.activity_id && x.activity_id === c.activity_id);
          if (r?.ok) m.undone.add(changeKey(c));
          else if (r) m.gone.add(changeKey(c));
        }
        if (out.some((x) => !x.ok)) showToast("Some of it couldn't be undone: it has changed since.", { icon: "restore" });
        changedElsewhere();
        save();
      } catch {
        showToast("Couldn't undo that. Try again in a moment.", { icon: "restore" });
      } finally {
        m.undoingAll = false;
        repaint();
      }
    });
  } else if (made.length > 1) all = h("span", { class: "change__state" }, icons.restore(), "All undone");
  return h("section", { class: "card plan plan--ran", "aria-label": "Plan, done" }, h("div", { class: "plan__top" }, head, all), h("div", { class: "plan__steps" }, ...rows));
}

/**
 * A follow-up whose reply couldn't be had: why, in a sentence, and Try again. No keyword search of its words:
 * your message above is kept as sent, and asking again sends it with the same conversation before it.
 */
function unreachedEl(m: WrittenMessage, onRetry: (() => void) | null): HTMLElement {
  const cause = m.unreached!;
  const waiting = !!m.retryAt;
  const offline = cause === "offline";
  const again = onRetry && cause !== "setup" && !(offline && !isOnline()) ? h("button", { class: `btn ${waiting ? "btn--soft" : "btn--primary"} btn--sm unreached__again`, type: "button" }, icons.refresh(), waiting ? TRY_NOW_LABEL : TRY_AGAIN_LABEL) : null;
  again?.addEventListener("click", () => {
    if ((again as HTMLButtonElement).disabled) return;
    (again as HTMLButtonElement).disabled = true;
    onRetry!();
  });
  return h(
    "div",
    { class: "msg msg--athena" },
    h("span", { class: "orb", "aria-hidden": "true" }),
    h(
      "div",
      { class: `bubble unreached${waiting ? " unreached--waiting" : ""}`, role: "status" },
      h("p", { class: "unreached__why" }, h("span", { class: "unreached__icon", "aria-hidden": "true" }, offline ? icons.wifiOff() : icons.cloud()), h("span", {}, waiting ? UNREACHED_RETRYING : UNREACHED_NOTE[cause])),
      again,
      waiting ? h("span", { class: "unreached__wait", "aria-hidden": "true", style: `--wait:${Math.max(0, m.retryAt! - Date.now())}ms` }) : null
    )
  );
}

/** Tonight's picks: each from the owner's own list, with why it fits. Tap one to open it. */
function picksEl(picks: WatchPick[]): HTMLElement {
  return h(
    "div",
    { class: "card card--flush picks", role: "list", "aria-label": "Tonight's picks" },
    ...picks.map((p, i) => {
      const row = h(
        "button",
        { class: "picks__row", type: "button", role: "listitem", style: `--i:${i}` },
        h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[p.kind === "tv" ? "tv" : "film"]()),
        h("span", { class: "picks__body" }, h("span", { class: "picks__title" }, p.title), h("span", { class: "picks__why" }, p.why), h("span", { class: "picks__from" }, p.from))
      );
      row.addEventListener("click", () => void openItem({ kind: "reading", id: p.id }));
      return row;
    })
  );
}

/** The evening chip's words. */
export const TONIGHT = "Something to watch tonight";

// ---------- Steps ----------

/** The lines worth showing: not taken back, and (once it's over) finished. */
const shownSteps = (steps: AskStep[]) => steps.filter((x) => !x.dropped && x.done);

/** Merge one step in: the same id replaces the line before it. */
function addStep(steps: AskStep[], step: AskStep) {
  const i = steps.findIndex((x) => x.id === step.id);
  if (i >= 0) steps[i] = step;
  else steps.push(step);
}

/** The line Talk's bar shows: what's running, else what last finished. */
function currentStep(steps: AskStep[]): string | null {
  const live = steps.filter((x) => !x.dropped);
  const running = live.filter((x) => !x.done);
  const now = running[running.length - 1];
  if (now) return `${now.text}…`;
  const last = live[live.length - 1];
  return last ? last.text : null;
}

/** A reply still coming: no words yet, nothing gone wrong, nothing kept in their place. */
const isWorking = (m: Message): boolean => (m.role === "assistant" ? !m.reply && !m.error : m.role === "answer" ? !m.reply && !m.fallback && !m.saved : false);

/** A message being worked on: its working view, so a step can land in it without repainting the chat. */
const stepViews = new WeakMap<object, (steps: AskStep[]) => void>();
/** Ask's own lines when a reply couldn't be had (lib/ask-fallback.ts), said as the assistant in its conversation. */
function assistantVoice(name: string): Array<[RegExp, string]> {
  return [
    [/^Athena couldn't write an answer just now, so this is a keyword search\.$/, `${name} couldn't reply just now, so this is a keyword search of your notes.`],
    [/^You're offline, so this is a keyword search\. I'll write the answer when you're back online\.$/, `You're offline, so this is a keyword search of your notes. ${name} will reply when you're back online.`],
    [/^You're offline, so I haven't answered this yet\. I'll answer when you're back online\.$/, `You're offline. ${name} will answer when you're back online.`],
    [/^(Athena's AI is busy|Athena's AI couldn't be reached|Athena couldn't sign you in), so I haven't answered this yet\./, `$1, so ${name} hasn't answered this yet.`],
  ];
}
function voiceOf(node: HTMLElement, name: string): void {
  const rules = assistantVoice(name);
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const text = t.textContent?.trim();
    if (!text) continue;
    for (const [re, to] of rules) if (re.test(text)) t.textContent = text.replace(re, to);
  }
}

/** Sample mode's Moss (db/sample-team.ts), whom Athena checks with about gift prices. */
const SAMPLE_MUSE_ID = "5a3e0000-0000-4000-8000-0000000e0001";
/** What a teammate said when Ask checked with it (reply.checked, from check_with_assistant). */
type CheckedReply = { assistant_id: string; name: string; question?: string; answer: string };
/** A message an assistant is working on: its status pill, so the current step shows beside its avatar. */
const pillViews = new WeakMap<object, (step: string | null) => void>();

function stepRow(step: AskStep, i = 0): HTMLElement {
  const row = h(
    "li",
    { class: "step", style: `--i:${i}` },
    h("span", { class: "step__mark", "aria-hidden": "true" }, h("span", { class: "step__spin" }), icons.check()),
    h("span", { class: "step__text" }, step.text)
  );
  paintRow(row, step);
  return row;
}

function paintRow(row: HTMLElement, step: AskStep) {
  row.dataset.state = step.done ? "done" : "running";
  if (step.changes?.length) row.dataset.change = "";
  const text = row.querySelector<HTMLElement>(".step__text")!;
  if (text.textContent !== step.text) {
    text.textContent = step.text;
    // The finished line settles in where the running one was.
    text.classList.remove("is-new");
    void text.offsetWidth;
    text.classList.add("is-new");
  }
}

/** A reply being written: its words so far (lib/ask-stream.ts), set as they arrive. */
const draftViews = new WeakMap<object, (text: string) => void>();

/**
 * The words so far, in a paragraph styled as the finished reply's. Bursts
 * from the network are let out a few characters a frame, so it reads as
 * writing rather than jumping; with reduced motion they show at once and
 * there's no caret. Citation markers are quiet placeholders until the
 * sources come. Hidden from screen readers: the finished reply is announced.
 */
function draftPara(cls: string): { el: HTMLElement; set: (raw: string) => void } {
  const p = h("p", { class: `${cls} answer__draft`.trim(), "aria-hidden": "true" });
  return written(p, (sofar) =>
    p.replaceChildren(...draftParts(sofar).flatMap((x) => (typeof x === "number" ? [h("span", { class: "cite cite--draft" }, String(x))] : linkTextNodes(x, () => undefined))), h("span", { class: "draft__caret" }))
  );
}

/**
 * A written answer's words so far, drawn as the finished answer will be
 * (lib/ask-rich.ts): the same paragraphs, list and bold, so nothing moves
 * when it lands. The caret sits at the end of the last line.
 */
function draftAnswer(): { el: HTMLElement; set: (raw: string) => void } {
  const el = h("div", { class: "answer__text rich answer__draft", "aria-hidden": "true" });
  return written(el, (sofar) => {
    const nodes = richNodes(draftRich(sofar), { cite: (n) => h("span", { class: "cite cite--draft" }, String(n)), text: (t) => linkTextNodes(t, () => undefined), open: true });
    lastLine(nodes).append(h("span", { class: "draft__caret" }));
    el.replaceChildren(...nodes);
  });
}

/** Words let out a few characters a frame into `el`, drawn by `render`. */
function written(el: HTMLElement, render: (sofar: string) => void): { el: HTMLElement; set: (raw: string) => void } {
  let target = "";
  let shown = 0;
  let frame = 0;
  const tick = () => {
    frame = 0;
    const left = target.length - shown;
    if (left <= 0) return;
    shown = Math.min(target.length, shown + Math.max(2, Math.ceil(left / 8)));
    render(target.slice(0, shown));
    if (shown < target.length) frame = requestAnimationFrame(tick);
  };
  return {
    el,
    set(raw) {
      if (!raw.startsWith(target.slice(0, shown))) shown = 0;
      target = raw;
      if (prefersReducedMotion() || !el.isConnected) {
        shown = target.length;
        render(target);
      } else if (!frame) frame = requestAnimationFrame(tick);
    },
  };
}

/** While Athena works: one line per step as it happens, the running one spinning; dots while it thinks between steps. */
function workingEl(m: { steps: AskStep[]; foldLive?: boolean; stepsOpen?: boolean } & ReplyState, label: string, caption: string, later: string, kind: "answer" | "assistant" = "answer"): HTMLElement {
  const list = h("ol", { class: "steps__list", hidden: true });
  const say = h("span", { class: "assist__working" }, caption);
  // A request can take a few calls; say so rather than look stuck.
  setTimeout(() => (say.textContent = later), 8000);
  const idle = h("div", { class: "steps__idle" }, h("span", { class: "typing-dots" }, h("span", {}), h("span", {}), h("span", {})), say);
  const live = h("span", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const rows = new Map<string, HTMLElement>();
  // A picture being made: its placeholder in the reply, where the picture will land (components/ask-picture.ts).
  const pics = h("div", { class: "pics-live", hidden: true });
  const set = (steps: AskStep[]) => {
    syncPictureSlots(pics, steps);
    const shown = steps.filter((x) => !x.dropped);
    for (const [id, row] of rows)
      if (!shown.some((x) => x.id === id)) {
        row.remove();
        rows.delete(id);
      }
    for (const step of shown) {
      const row = rows.get(step.id);
      if (row) paintRow(row, step);
      else {
        const made = stepRow(step);
        rows.set(step.id, made);
        list.append(made);
        live.textContent = step.text;
      }
    }
    list.hidden = !shown.length;
    say.hidden = !!shown.length;
    // Between steps it's thinking: the dots, under the lines.
    idle.hidden = shown.some((x) => !x.done);
  };
  set(m.steps);
  stepViews.set(m, set);
  const orb = h("span", { class: "orb orb--thinking", "aria-hidden": "true" });
  const stepsLive = h("div", { class: "steps steps--live" }, list, idle);
  const bubble = h("div", { class: "bubble steps-bubble" }, stepsLive, pics, live);
  // The reply's column, as the finished one has it, so its words land where they'll stay.
  const col = h("div", { class: "assist" });
  const node = h("div", { class: "msg msg--athena", "aria-label": label }, orb, bubble);
  // Its words, as they're written: the steps fold the way they will when it lands, and the words take the reply's place.
  let draft: ReturnType<typeof draftPara> | null = null;
  let fold: HTMLElement | null = null;
  draftViews.set(m, (text) => {
    if (!text) {
      // Taken back (a tool call follows): back to the steps.
      if (!draft) return;
      draft.el.remove();
      fold?.replaceWith(stepsLive);
      fold = null;
      col.replaceWith(bubble);
      bubble.className = "bubble steps-bubble";
      orb.classList.add("orb--thinking");
      draft = null;
      m.drafted = false;
      return;
    }
    if (!draft) {
      draft = kind === "answer" ? draftAnswer() : draftPara("");
      m.foldLive = true;
      fold = stepsFold(m);
      if (fold) stepsLive.replaceWith(fold);
      else stepsLive.remove();
      bubble.className = kind === "answer" ? "bubble answer-bubble" : "bubble";
      bubble.append(draft.el);
      bubble.replaceWith(col);
      col.append(bubble);
      orb.classList.remove("orb--thinking");
      m.drafted = true;
    }
    draft.set(text);
  });
  if (m.draft) draftViews.get(m)!(m.draft);
  return node;
}

/** A written answer (components/ask-answer.ts) with its folded steps at the top of its bubble. */
function withSteps(node: HTMLElement, m: WrittenMessage): HTMLElement {
  const fold = stepsFold(m);
  const bubble = node.querySelector<HTMLElement>(".bubble");
  if (fold && bubble) bubble.prepend(fold);
  return node;
}

let foldIds = 0;

/** Once the reply is in: its steps folded into "N steps", tap to open. Folds away as the reply lands. */
function stepsFold(m: { steps: AskStep[]; foldLive?: boolean; stepsOpen?: boolean }): HTMLElement | null {
  const done = shownSteps(m.steps);
  if (!done.length) return null;
  const id = `ask-steps-${++foldIds}`;
  const count = `${done.length} ${done.length === 1 ? "step" : "steps"}`;
  const toggle = h(
    "button",
    { class: "steps__toggle", type: "button", "aria-expanded": m.stepsOpen ? "true" : "false", "aria-controls": id },
    h("span", { class: "steps__count" }, count),
    icons.chevronDown()
  );
  const list = h("ol", { class: "steps__list", id, "aria-label": "What Athena did" }, ...done.map((x, i) => stepRow(x, i)));
  const el = h("div", { class: "steps steps--fold", "data-open": m.stepsOpen ? "true" : "false" }, toggle, h("div", { class: "steps__panel" }, h("div", { class: "steps__clip" }, list)));
  const setOpen = (open: boolean) => {
    el.dataset.open = String(open);
    toggle.setAttribute("aria-expanded", String(open));
    list.inert = !open;
  };
  setOpen(!!m.stepsOpen);
  toggle.addEventListener("click", () => {
    m.stepsOpen = !m.stepsOpen;
    setOpen(m.stepsOpen);
  });
  if (m.foldLive && !m.stepsOpen) {
    // Arrives open, as the working lines were, then folds away under the reply.
    m.foldLive = false;
    el.dataset.live = "";
    setOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setOpen(false)));
  }
  return el;
}

/** Ask about this (lib/open-ask.ts): the chip's icon for what it's about. */
function aboutIcon(a: AskAbout): IconName {
  if (a.kind === "todo") return "loop";
  if (a.kind === "watch") return "tv";
  if (a.kind === "record") return entityIcon("record", null, a.id);
  return entityIcon(a.kind);
}

/**
 * A reply stopped part-way: the words so far, without sources (they come only with the finished reply), and
 * whatever it had changed by then, with Undo. The server makes a change last and checks for Stop first, so there's
 * usually nothing; a change already under way finishes and comes back here.
 */
function stoppedAnswer(draft: string, steps: AskStep[] = []): AskReply {
  const said = withoutCitations(draftRich(draft));
  const made = steps.flatMap((x) => x.changes ?? []);
  const midChange = steps.some((x) => x.acts && !x.done && !x.dropped);
  const tail = made.length ? "Stopped. Here's what I'd changed by then." : midChange ? "Stopped while a change was under way. Check whether it went through." : "";
  const text = [said ? `${said}…` : "", tail].filter(Boolean).join("\n\n") || "You stopped this before I'd written anything.";
  return { text, sources: [], related: [], searched: "Stopped", skipped: [], found: false, flagged: false, ...(made.length ? { changes: made } : {}) };
}

/** Sample mode's stand-in for the assistant has no made-up reply for this message. */
class SampleHasNone extends Error {}
const SAMPLE_NONE_NOTE = "Sample mode has no written answer for this one, so this is a keyword search of the sample notes.";

/** The connection went part-way on a server that doesn't keep runs, after a change had started: it isn't asked again. What arrived is the reply. */
function droppedAnswer(made: AssistantChange[]): AskReply {
  const text = made.length
    ? "The connection dropped part-way. Here's what I'd changed by then, so check before you ask again."
    : "The connection dropped while I was making a change. Check whether it went through before you ask again.";
  return { text, sources: [], related: [], searched: "", skipped: [], found: false, flagged: false, ...(made.length ? { changes: made } : {}) };
}

/** Sample mode writes its answer a word at a time, as a real one arrives. */
async function playSampleText(text: string, onText: (e: TextEvent) => void, signal: AbortSignal) {
  for (const piece of text.match(/\S+\s*/g) ?? []) {
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    onText({ delta: piece });
    await new Promise((r) => setTimeout(r, 55));
  }
  if (signal.aborted) throw new DOMException("Stopped", "AbortError");
}

/**
 * Sample mode's pictures: painted on the device, shown the way a made one is (its placeholder, then the picture,
 * then the words), with its receipt and Undo. "Make it night time" after one changes it. Staged off, the reply says
 * where to turn pictures on (components/ask-picture.ts has the staging keys).
 */
async function samplePicture(q: string, c: Chat, step: (x: AskStep) => void, text: ((e: TextEvent) => void) | null | undefined, signal: AbortSignal): Promise<AskReply | null> {
  // The newest picture still in the conversation: an archived one isn't changed.
  const last = [...c.messages].reverse().flatMap((x) => (x.role === "answer" || x.role === "assistant" ? ((x.reply as ModelNote | null)?.pictures ?? []).filter((p) => !x.undone.has(pictureKey(p.file.id)) && !p.file.removed) : []))[0] ?? null;
  const wants = samplePictureAsk(mentionsToText(q), last);
  if (!wants) return null;
  // The sample's AI models settings say which picture model, if any (owner, 17 Nov 2026): Settings, AI models.
  const ref = await samplePictureModel(c.assistant_id ?? null);
  const plainReply = async (said: string, extra: Partial<AskReply> = {}): Promise<AskReply> => {
    const r: AskReply = { text: said, sources: [], related: [], searched: "", skipped: [], found: false, flagged: false, ...extra };
    if (text) await playSampleText(r.text, text, signal);
    return r;
  };
  if (!ref) return plainReply(PICTURES_OFF_TEXT, { setting: PICTURE_SETTING });
  const change = wants === "change";
  if (change && ref.provider !== "gemini") return plainReply(CANT_CHANGE);
  const file = await paintSamplePicture(change ? "night" : "dusk");
  const words = SAMPLE_PROMPTS[change ? "night" : "dusk"];
  const id = `${PICTURE_STEP}${file.id}`;
  const doing = change ? "Changing the picture" : "Making a picture";
  step({ id, text: doing, done: false });
  await new Promise((r) => setTimeout(r, 3200));
  if (signal.aborted) throw new DOMException("Stopped", "AbortError");
  step({ id, text: change ? "Changed the picture" : "Made a picture", done: true });
  const picture: ShownPicture = { file, alt: words.alt, prompt: words.prompt, ref, ...(change && last ? { from: [last.file.id] } : {}) };
  const said = change ? "Here it is at night, with the beam across the water." : "Here's your lighthouse at dusk, in watercolour.";
  if (text) await playSampleText(said, text, signal);
  const change_: AssistantChange = {
    kind: "picture",
    id: file.id,
    action: "created",
    title: file.name.replace(/\.\w+$/, ""),
    detail: `${change ? "Changed" : "Made"} with ${modelLabel(ref)}`,
    label: `${change ? "Changed a picture" : "Made a picture"}: ${words.alt}`,
    open: null,
    undo: { op: "remove_picture", file_id: file.id, thread_id: c.id },
  };
  return { text: said, sources: [], related: [], searched: "", skipped: [], found: true, flagged: false, changes: [change_], next: change ? ["Make it a winter morning", "Save it to a note"] : ["Make it night time", "Make it wider"], ...({ pictures: [picture] } as ModelNote), ...(takeSampleFellBack() ?? {}) } as AskReply;
}

/** Sample mode's follow-ups, as a real answer's would read. */
function sampleNext(q: string): string[] {
  if (/\bpric|\belena\b/i.test(q)) return ["When is the renewal?", "What did Priya say about it?", "Remind me before the call"];
  if (/\b(fl(?:y|ew|ights?)|trip|lisbon)\b/i.test(q)) return ["Where did I stay?", "When do I fly back?"];
  if (/\bsleep|slept\b/i.test(q)) return ["What makes it worse?", "Show last week's sleep"];
  return ["Tell me more", "What else happened that week?"];
}

/** Sample mode's written answer (components/ask-answer.ts), the way a real one gets there. */
const SAMPLE_ANSWER_STEPS: Array<[string, string]> = [
  ["Searching your notes", "Found 4 matches in your notes"],
  ["Searching Granola", "Searched Granola"],
  ["Searching Gmail (work)", "Searched Gmail (work)"],
  ["Reading a call", "Read a call"],
  ["Reading 2 emails", "Read 2 emails"],
];

/** Sample mode has no server: steps that play out like a real request's, from the sample data. */
async function playSampleSteps(steps: Array<[string, string]>, onStep: (step: AskStep) => void) {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await pause(700);
  for (const [i, [running, done]] of steps.entries()) {
    onStep({ id: `sample:${i}`, text: running, done: false });
    await pause(650 + ((i * 337) % 400));
    onStep({ id: `sample:${i}`, text: done, done: true });
    await pause(180);
  }
  await pause(500);
}

/** What sample mode's assistant "does" for an instruction: finds anyone it names, then explains it can't change anything. */
function sampleInstructionSteps(q: string): Array<[string, string]> {
  const firstName = (name: string) => name.replace(/^Dr\.\s+/, "").split(/\s+/)[0];
  const words = new Set(q.toLowerCase().split(/[^\p{L}]+/u));
  const person = samplePeople().find((p) => words.has(firstName(p.name).toLowerCase()));
  const first = person && firstName(person.name);
  const drafting = person ? draftRequestChannel(q) : null;
  const noun = drafting === "email" ? "an email" : drafting === "slack" ? "a Slack message" : drafting === "text" ? "a text" : "a WhatsApp";
  return [
    ...(person && first ? ([[`Looking for ${first}`, `Found ${person.name}`]] as Array<[string, string]>) : []),
    ...(drafting ? ([[`Writing ${noun}`, `Wrote ${noun} for you to send`]] as Array<[string, string]>) : [
      ["Searching notes", "Found 3 notes"],
      ["Checking your to-dos", "Found 2 open to-dos"],
    ] as Array<[string, string]>),
  ];
}

function termsText(terms: string[]): string {
  if (terms.length <= 1) return terms.map(quote).join("");
  return `${terms.slice(0, -1).map(quote).join(", ")} or ${quote(terms[terms.length - 1])}`;
}

/** Examples from the owner's own people and days (lib/home-personal.ts askExamples), once they've loaded. */
let ownerExamples: { questions: string[]; instruction: string } | null = null;

/** No notes yet (day one): things Ask can already do, from the diary and by remembering. */
const DAY_ONE = ["Remind me to ring Mum on Sunday", "What's on this week?", "Remember that I don't eat meat"];

/** A real owner with no notes yet: Ask is Athena itself, not "your notes". */
const noNotesYet = () => !isSampleMode() && notesSnapshot().loaded && !notesSnapshot().notes.length;

/** Sample mode's answers to "find a time" and "move the design review": a reply and its card. */
/** Sample mode: "I spent £4 on coffee", "slept 7 hours", "watched Perfect Days last night", "electricity meter reads 12345" each show a logging card. */
async function sampleLog(q: string): Promise<[string, AskConfirmCard] | null> {
  const today = localToday();
  const spent = /\b(?:spent|paid)\s+([£$€]?\d[\d,.]*)\s+(?:on|at|for)\s+(?:a\s+|an\s+)?([\p{L}' -]{2,40}?)(?:\s+(yesterday))?[.!]?$/iu.exec(q);
  if (spent) {
    const what = spent[2].trim();
    const category = /coffee|lunch|breakfast|dinner|cafe|café|pub|restaurant/i.test(what) ? "eating_out" : /taxi|train|bus|uber|fuel|petrol/i.test(what) ? "transport" : /shop|grocer|tesco|sainsbury/i.test(what) ? "groceries" : "general";
    const card = spendingCard({ amount: spent[1], what: what[0].toUpperCase() + what.slice(1), category, date: spent[3] ? addDays(today, -1) : today }, { today });
    return [`Ready to add ${formatMoney(card.amount, card.currency)} on ${what}. Tap Add to save it.`, card];
  }
  const slept = /\bslept\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\b/i.exec(q);
  if (slept) {
    const ran = /\bran\s+(\d+(?:\.\d+)?)\s*k(?:m)?\b(?:\s+in\s+(\d+)\s*min)?/i.exec(q);
    // What sample mode keeps as typed in for today (db/health.ts), as a real request reads it.
    const card = healthCard({ sleep_hours: Number(slept[1]), ...(ran ? { workout: { type: "run", minutes: Number(ran[2] ?? 30), km: Number(ran[1]) } } : {}) }, { today }, await loadManualHealth(today));
    const keeps = card.keeps.length ? ` Your ${card.keeps.length > 1 ? `${card.keeps.slice(0, -1).join(", ")} and ${card.keeps[card.keeps.length - 1]}` : card.keeps[0]} stay as you typed ${card.keeps.length > 1 ? "them" : "it"}.` : "";
    return [`Ready to save to today's health.${keeps} Tap Save to keep it.`, card];
  }
  const watched = /^(?:i\s+)?(watched|listened to|read|played)\s+(.+?)(\s+last night|\s+yesterday)?[.!]?$/i.exec(q.trim());
  if (watched) {
    const kind = watched[1].toLowerCase() === "listened to" ? "listened" : (watched[1].toLowerCase() as "watched" | "read" | "played");
    const card = entryCard({ kind, title: watched[2].trim(), date: watched[3] ? addDays(today, -1) : today }, { today });
    return [`Ready to add ${card.entry.title} to ${watched[3] ? "yesterday" : "today"}. Tap Add to keep it.`, card];
  }
  const meter = /\b(electricity|gas)\s+(?:meter\s+)?(?:reads|reading is|is at|is|says)\s+([\d,]+(?:\.\d+)?)/i.exec(q);
  if (meter) {
    const fuel = meter[1].toLowerCase() as "electricity" | "gas";
    const value = Number(meter[2].replace(/,/g, ""));
    const unit = fuel === "gas" && !Number.isInteger(value) ? "m3" : "kwh";
    // Sample mode's own readings (db/house.ts), so the card shows what was used since the last one.
    const card = readingCard({ fuel, value, unit }, { today }, (await loadHouse()).readings ?? []);
    return [`Ready to add the ${fuel} reading. Tap Add to save it.`, card];
  }
  return null;
}

/** Sample mode: declining the design review, or sending a note to Google Docs or Notion, shows its confirm card. Nothing is sent. */
function sampleConfirm(q: string): [string, AskConfirmCard] | null {
  if (/\bdesign review\b/i.test(q) && /\b(can't make|can’t make|cannot make|decline|skip|won't make|won’t make)\b/i.test(q)) {
    const ev = sampleEvent();
    return ["Ready to decline the design review. Tap Decline to answer.", { kind: "rsvp", event_id: ev.id, title: ev.title, starts_at: ev.starts_at, date: ev.starts_at.slice(0, 10), answer: "declined", sends_to: "Google Calendar" }];
  }
  const to = /\bnotion\b/i.test(q) ? "notion" : /\bgoogle docs?\b/i.test(q) ? "google-docs" : null;
  if (to && /\b(send|export|share|copy)\b/i.test(q)) {
    return [`Ready to send your weekly review to ${to === "notion" ? "Notion" : "Google Docs"}. Tap Send to make it.`, { kind: "send_note", note_id: "5a3e0000-0000-4000-8000-00000000d0c1", title: "Weekly review", to, updates: false }];
  }
  return null;
}

function sampleScheduling(q: string): [string, SchedulingCard] | null {
  // "Lunch with Priya Thursday at 1": an event to check, with Priya invited.
  const adding = /^(?:(?:add|put|book|schedule|set up)\s+(?:in\s+)?(?:a\s+|an\s+)?)?(lunch|dinner|breakfast|brunch|coffee|drinks|call|meeting|catch[ -]?up|1:1)\s+with\s+(\p{L}+)/iu.exec(q.trim());
  if (adding && (dayIn(q, localToday()) || /\bat\s+\d/i.test(q))) {
    const what = adding[1].toLowerCase();
    const who = adding[2][0].toUpperCase() + adding[2].slice(1).toLowerCase();
    const day = dayIn(q, localToday()) ?? localToday();
    const hhmm = /\bat\s+(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:am|pm))/i.exec(q);
    // "at 1" for lunch is 13:00: a bare hour under 8 is the afternoon.
    const time = timeIn(q) ?? (hhmm ? `${String(Number(hhmm[1]) < 8 ? Number(hhmm[1]) + 12 : Number(hhmm[1])).padStart(2, "0")}:${hhmm[2] ?? "00"}` : "13:00");
    const meal = /lunch|dinner|breakfast|brunch/.test(what);
    const title = `${what[0].toUpperCase()}${what.slice(1)} with ${who}`;
    const create = sampleProposal({ title, start: zonedInstant(day, time, "Europe/London"), minutes: meal ? 60 : 30, who: [{ name: who }] });
    return [create.attendees.length ? `${title} is ready to check. Tap Add and ${who} gets an invite.` : `${title} is ready to check. Athena has no email for ${who}, so they won't get an invite.`, { kind: "create", create }];
  }
  const moving = /\b(move|reschedule|shift|push)\b/i.test(q);
  if (moving && /\bdesign review\b/i.test(q) && /\b(to|at)\b/i.test(q)) {
    const card = sampleCard({ event_id: SAMPLE_EVENT_ID });
    return ["Ready to move the design review. Check the new time and tap Move.", { kind: "move", move: { event_id: SAMPLE_EVENT_ID, title: "Design review", from: sampleEvent().starts_at, start: card.slots[1].start, end: card.slots[1].end } }];
  }
  if (moving && /\bdesign review\b/i.test(q)) return ["Three times that work for you and Priya. Couldn't see Marcus's calendar, so they're planned around you two.", { kind: "slots", card: sampleCard({ event_id: SAMPLE_EVENT_ID, who: [{ name: "Priya Shah" }, { name: "Marcus Webb" }] }) }];
  if (/\b(find|suggest|when can|free|time for|times? (for|to))\b/i.test(q) && /\b(call|meet|meeting|chat|catch[ -]?up|time|slot|1:1)\b/i.test(q)) {
    const minutes = Number(/(\d+)\s*(min|minute)/i.exec(q)?.[1]) || (/\bhour\b/i.test(q) ? 60 : 30);
    const who = /\bpriya\b/i.test(q) && !/\bmarcus\b/i.test(q) ? [{ name: "Priya Shah" }] : [{ name: "Priya Shah" }, { name: "Marcus Webb" }];
    const card = sampleCard({ minutes, who });
    return [who.length > 1 ? "Three times that work for you and Priya. Couldn't see Marcus's calendar, so they're planned around you two." : "Three times you and Priya are both free.", { kind: "slots", card }];
  }
  return null;
}

function suggestions(): string[] {
  // On an evening, the chip for tonight's picks from the owner's own list leads.
  const evening = new Date().getHours() >= 17;
  const base = baseSuggestions();
  return evening ? [TONIGHT, ...base.filter((x) => x !== TONIGHT)].slice(0, Math.max(base.length, 4)) : base;
}

function baseSuggestions(): string[] {
  if (noNotesYet()) return DAY_ONE;
  if (ownerExamples) return [...ownerExamples.questions, ownerExamples.instruction];
  const freq = new Map<string, number>();
  // A briefing's date tag ("2026-11-06") makes no sense as a question.
  for (const n of notesSnapshot().notes.slice(0, 60)) for (const t of n.tags) if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) freq.set(t, (freq.get(t) ?? 0) + 1);
  const tags = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 3);
  // Sample mode leads with the question it has a written answer for.
  if (isSampleMode()) return [SAMPLE_QUESTION, SAMPLE_TRIP_QUESTION, SAMPLE_LIFE_QUESTION, SAMPLE_PATTERNS_QUESTION];
  // Days questions beside the notes ones: coffee and sleep, habits, and spending (each opened only for its kind of question).
  const days = ["How much coffee did I have the week I slept badly?", "Which habits did I keep in October?", "What do I spend on eating out a month?"];
  if (tags.length) return [...tags.slice(0, 2).map((t) => `What have I noted about ${t}?`), ...days.slice(1)];
  return ["What did I decide about planning?", "Notes from my last meeting", ...days];
}

function answerLead({ terms, notes, others }: AskAnswer): string {
  return !terms.length
    ? "Ask with a few specific words, like a name, a project or a topic, and I'll find the notes that mention them."
    : notes.length
      ? `${countWord(notes.length)} ${plural(notes.length, "note mentions", "notes mention")} ${termsText(terms)}.`
      : others.length
        ? `No notes mention ${termsText(terms)}, but Athena knows this:`
        : `Nothing in your notes mentions ${termsText(terms)} yet.`;
}

const SPOKEN_KIND: Record<RecallHit["kind"], string> = {
  note: "a note",
  commitment: "a to-do",
  fact: "a detail",
  person: "a person",
  interaction: "a catch-up",
  reading: "something to read",
  record: "something you keep",
  day: "a day",
};

/** What Talk says back: the answer's first sentence and its top match. The rest is on screen. */
function spokenFor(m: Message | null): string | null {
  if (!m) return null;
  if (m.role === "assistant") return m.reply ? mentionsToText(m.reply.text) : m.error;
  if (m.role === "answer" && m.unreached && !m.reply) return UNREACHED_NOTE[m.unreached];
  if (m.role === "answer") return m.reply ? spokenAnswer(m.reply) : spokenFor({ role: "athena", at: m.at, question: m.question, terms: m.terms, answer: m.fallback, refs: m.refs });
  if (m.role !== "athena" || !m.answer) return null;
  const { terms, notes, others } = m.answer;
  if (!terms.length) return "Try asking with a name, a project or a topic.";
  if (notes.length) {
    const { title } = noteParts(notes[0]);
    return `${answerLead(m.answer)} ${notes.length === 1 ? "It's" : "The closest is"} ${quote(title)}.`;
  }
  if (others.length) {
    const hit = others[0];
    return `No notes mention ${termsText(terms)}, but there's ${SPOKEN_KIND[hit.kind]}: ${quote(hit.title || hit.snippet.slice(0, 80))}.`;
  }
  return answerLead(m.answer);
}

/** A keyword search's reply; `note` says why it's a search rather than a written answer. */
/** A reopened answer, loading what it found as it is now. */
function loadingEl(): HTMLElement {
  return h(
    "div",
    { class: "msg msg--athena", "aria-busy": "true", "aria-label": "Loading this answer" },
    h("span", { class: "orb", "aria-hidden": "true" }),
    h("div", { class: "bubble bubble--loading", "aria-hidden": "true" }, h("span", { class: "skeleton-line" }), h("span", { class: "skeleton-line skeleton-line--short" }))
  );
}

function answerEl(m: AthenaMessage, ctx: AskContext, note: string | null = null, onWrite: (() => void) | null = null): HTMLElement {
  const answer = m.answer;
  if (!answer && m.refs) return loadingEl();
  if (!answer) {
    return h(
      "div",
      { class: "msg msg--athena", "aria-label": "Athena is searching" },
      h("span", { class: "orb orb--thinking", "aria-hidden": "true" }),
      h("div", { class: "bubble" }, h("span", { class: "typing-dots" }, h("span", {}), h("span", {}), h("span", {})))
    );
  }

  const { terms, notes, others } = answer;
  const lead = answerLead(answer);

  const other = others.map((hit) => {
    const b = h(
      "button",
      { class: "answer", type: "button" },
      h("span", { class: "tile tile--sm" }, icons[recallIcon(hit)]()),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title" }, ...highlight(hit.title || hit.snippet.slice(0, 80), terms)),
        hit.snippet && hit.snippet !== hit.title && hit.kind !== "fact" && hit.kind !== "person" ?h("span", { class: "row__snippet" }, ...highlight(hit.snippet.slice(0, 160), terms)) : null,
        h("span", { class: "row__meta" }, recallMeta(hit))
      )
    );
    b.addEventListener("click", () => void openHit(hit, ctx));
    return b;
  });

  const answers = notes.map((n) => {
    const { title, rest } = noteParts(n);
    const b = h(
      "button",
      { class: "answer", type: "button" },
      h("span", { class: "tile tile--sm" }, icons[TYPE_ICON[n.type]]()),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title" }, ...highlight(title, terms)),
        rest ? h("span", { class: "row__snippet" }, ...highlight(rest.replace(/\s+/g, " ").slice(0, 160), terms)) : null,
        h("span", { class: "row__meta" }, sourceText(n.source))
      )
    );
    b.addEventListener("click", () => ctx.openNote(n));
    return b;
  });

  return h(
    "div",
    { class: "msg msg--athena" },
    h("span", { class: "orb", "aria-hidden": "true" }),
    h(
      "div",
      { class: "bubble" },
      // In place of a written answer: why, and the button that writes it here.
      note || onWrite ? h("div", { class: "fallback" }, note ? h("p", { class: "fallback__why" }, note) : null, onWrite ? writeButton(onWrite, icons.sparkle()) : null) : null,
      h("p", {}, lead),
      answers.length ? h("div", { class: "answers" }, ...answers) : null,
      other.length && answers.length ? h("p", { class: "answers__label" }, "Also in Athena") : null,
      other.length ? h("div", { class: "answers" }, ...other) : null,
      terms.length
        ? h(
            "p",
            { class: "bubble__foot" },
            icons.sparkle(),
            answer.state === "sample" ? "Keyword match on sample data" : "Keyword match across notes, people and to-dos"
          )
        : null
    )
  );
}

/** "Today", "Yesterday", "Tuesday", "3 November": the divider above a day's first message. */

const DRAFT = "athena.askDraft";
/** What's typed in Ask and not yet sent, kept on this device so nothing is lost. */
function saveDraft(text: string) {
  try {
    if (text.trim()) localStorage.setItem(DRAFT, text);
    else localStorage.removeItem(DRAFT);
  } catch {
    // private window: fine
  }
}
function loadDraft(): string {
  try {
    return localStorage.getItem(DRAFT) ?? "";
  } catch {
    return "";
  }
}

/** The files a written answer reads: this message's, then the conversation's latest, five at most (not ones since deleted). */
/** The thinking model the owner picked for their last message only (the photo warning), sent with it and with Try again. */
function onlyModel(c: Chat): { model?: ModelRef } {
  const mine = [...c.messages].reverse().find((m) => m.role === "me");
  return mine?.role === "me" && mine.model ? { model: mine.model } : {};
}

function recentFiles(c: Chat, sent: AskFile[]): string[] {
  const ids = sent.map((f) => f.id);
  const add = (f: AskFile) => !f.removed && !ids.includes(f.id) && ids.length < 5 && ids.push(f.id);
  for (let i = c.messages.length - 1; i >= 0 && ids.length < 5; i--) {
    const m = c.messages[i];
    if (m.role === "me") for (const f of m.files ?? []) add(f);
    // Pictures Ask made, so "make it night time" can change one. Not one that's archived.
    if ((m.role === "answer" || m.role === "assistant") && m.reply) for (const p of (m.reply as ModelNote).pictures ?? []) if (!m.undone.has(pictureKey(p.file.id))) add(p.file);
  }
  return ids;
}

/** Keep the summaries Athena wrote for files on the messages that carry them, so Conversations search finds them. */
function keepSummaries(c: Chat, summaries: Record<string, string> | undefined): void {
  if (!summaries) return;
  for (const m of c.messages) if (m.role === "me") for (const f of m.files ?? []) if (summaries[f.id] && !f.summary) f.summary = summaries[f.id];
}

function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(d);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }).format(d);
}

const timeOf = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** The chat list: grouped by when each was last used, the open one marked; tap to switch, ⋯ to rename or delete. */
/** Pinned: each answer with what was asked, to open at that reply or unpin. */
function pinnedGroup(pins: PinnedAnswer[], open: (p: PinnedAnswer) => void, unpin: (p: PinnedAnswer) => void): HTMLElement {
  return h(
    "section",
    { class: "chats__pinned", "aria-label": "Pinned" },
    h("p", { class: "chats__group" }, "Pinned"),
    ...pins.map((p, i) => {
      const main = h(
        "button",
        { class: "chat-row__main chat-row__main--found", type: "button" },
        h("span", { class: "chat-row__title" }, p.question || "Pinned answer"),
        p.text ? h("span", { class: "chat-row__snippet" }, p.text) : null,
        h("span", { class: "chat-row__time" }, compactTime(p.pinned_at))
      );
      main.addEventListener("click", () => open(p));
      const off = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost chat-row__more chat-row__unpin", type: "button", "aria-label": `Unpin ${p.question || "this answer"}`, title: "Unpin" }, icons.thumbtack());
      off.addEventListener("click", () => unpin(p));
      return h("div", { class: "chat-row chat-row--pinned", style: `--i:${Math.min(i, 12)}` }, main, off);
    })
  );
}

function chatList(opts: {
  threads: AskThread[];
  currentId: string | null;
  open: (id: string) => void;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  /** Searching: what matched, best first, with the line that matched. */
  search?: { query: string; matches: ThreadMatch[] } | null;
  /** Pinned answers (lib/ask-pins.ts), above the conversations. */
  pinned?: PinnedAnswer[];
  openPin?: (p: PinnedAnswer) => void;
  unpin?: (p: PinnedAnswer) => void;
}): HTMLElement {
  const list = h("div", { class: "chats__list" });
  if (!opts.search && opts.pinned?.length) list.append(pinnedGroup(opts.pinned, opts.openPin!, opts.unpin!));
  const search = opts.search ?? null;
  const threads = search ? search.matches.map((m) => m.thread) : opts.threads;
  const snippets = new Map(search?.matches.map((m) => [m.thread.id, m.snippet]) ?? []);
  const terms = search ? search.query.toLowerCase().split(/\s+/).filter((w) => w.length > 1) : [];
  if (!threads.length) {
    list.append(
      h(
        "p",
        { class: "chats__empty" },
        search ? `Nothing in your conversations mentions “${search.query.trim()}”.` : "Your conversations will be here. Ask something to start one."
      )
    );
    return list;
  }
  const menuId = `chat-menu-${Math.random().toString(36).slice(2)}`;
  const menu = h("div", { class: "menu chat-menu", id: menuId, popover: "auto" }) as HTMLElement & { hidePopover?: () => void };
  let menuFor: { id: string; row: HTMLElement; anchor: HTMLElement } | null = null;

  function startRename(id: string, row: HTMLElement) {
    const t = opts.threads.find((x) => x.id === id);
    if (!t) return;
    const input = h("input", { class: "chat-row__input", type: "text", value: threadTitle(t), maxlength: 120, "aria-label": "Conversation name", enterkeyhint: "done" }) as HTMLInputElement;
    const title = row.querySelector<HTMLElement>(".chat-row__title");
    if (!title) return;
    row.classList.add("is-renaming");
    title.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      row.classList.remove("is-renaming");
      input.replaceWith(h("span", { class: "chat-row__title" }, save && value ? value : threadTitle(t)));
      if (save && value && value !== threadTitle(t)) opts.rename(id, value);
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  const item = (icon: IconName, label: string, run: () => void, cls = "") => {
    const b = h("button", { class: `menu__item ${cls}`, type: "button" }, icons[icon](), label);
    b.addEventListener("click", () => {
      menu.hidePopover?.();
      run();
    });
    return b;
  };
  menu.replaceChildren(
    item("pen", "Rename", () => menuFor && startRename(menuFor.id, menuFor.row)),
    item("archive", "Archive", () => menuFor && opts.remove(menuFor.id))
  );
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open" || !menuFor) return;
    const r = menuFor.anchor.getBoundingClientRect();
    const below = r.bottom + 6 + 110 < window.innerHeight;
    menu.style.top = below ? `${r.bottom + 6}px` : `${r.top - 6 - 104}px`;
    placeMenuAcross(menu, menuFor.anchor);
  });

  let group = "";
  let i = 0;
  if (search) list.append(h("p", { class: "chats__group" }, `${countWord(threads.length)} ${plural(threads.length, "conversation", "conversations")}`));
  for (const t of threads) {
    const bucket = dayBucket(t.updated_at);
    if (!search && bucket !== group) {
      group = bucket;
      list.append(h("p", { class: "chats__group" }, bucket));
    }
    const current = t.id === opts.currentId;
    const snippet = snippets.get(t.id);
    const main = h(
      "button",
      { class: `chat-row__main${search ? " chat-row__main--found" : ""}`, type: "button", ...(current ? { "aria-current": "true" } : {}) },
      h("span", { class: "chat-row__title" }, ...(search ? highlight(threadTitle(t), terms) : [threadTitle(t)])),
      snippet ? h("span", { class: "chat-row__snippet" }, ...highlight(snippet, terms)) : null,
      h("span", { class: "chat-row__time" }, compactTime(t.updated_at))
    );
    const more = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost chat-row__more", type: "button", "aria-label": `More for ${threadTitle(t)}`, popovertarget: menuId }, icons.more());
    const row = h("div", { class: `chat-row${current ? " is-current" : ""}`, style: `--i:${Math.min(i++, 12)}` }, main, more);
    main.addEventListener("click", () => {
      if (!row.classList.contains("is-renaming")) opts.open(t.id);
    });
    main.addEventListener("dblclick", (e) => {
      e.preventDefault();
      startRename(t.id, row);
    });
    more.addEventListener("click", () => (menuFor = { id: t.id, row, anchor: more }));
    list.append(row);
  }
  list.append(menu);
  return list;
}

export function renderAsk(ctx: AskContext): { el: HTMLElement; destroy: () => void } {
  const threadEl = h("div", { class: "thread", "aria-live": "polite" });
  // Typing @ mentions anything in Athena as a chip; the message goes with its athena:// links (components/mention-input.ts).
  const input = mentionInput({
    placeholder: "Ask, or tell me what to do…",
    label: "Ask your notes",
    search: findMentions,
    thumb: mentionThumb,
    onPick: rememberMention,
    lookup: mentionById,
    onInput: () => paintEmpty(),
    onSubmit: () => form.requestSubmit(),
  });
  const send = h("button", { class: "send-btn", type: "submit", "aria-label": "Ask", disabled: true }, icons.arrowUp()) as HTMLButtonElement;
  // Photos, screenshots, PDFs and text files go with the message (components/attachments.ts).
  const files = composerFiles({
    thread: () => current().id,
    onChange: () => {
      // The photo it was about was taken out: nothing to warn about.
      if (vision && !files.peek().some((f) => f.type.startsWith("image/") || f.type === "application/pdf")) dropVision();
      paintEmpty();
    },
  });
  // While a reply is written, Stop takes the send button's place.
  const stopBtn = h("button", { class: "send-btn send-btn--stop", type: "button", "aria-label": "Stop", title: "Stop", hidden: true }, icons.stop()) as HTMLButtonElement;
  // Above the box, moving with it: what the next message is about (openAsk), and the message being edited.
  const composerTop = h("div", { class: "composer-top", hidden: true });
  const form = h("form", { class: "composer-bar", "data-empty": "true" }, composerTop, files.status, files.el, files.button, input.el, send, stopBtn);
  /** In place of the box, in a conversation with an assistant no longer on the team. */
  const goneText = h("span", { class: "who-gone__text" });
  const goneTalk = h("button", { class: "btn btn--primary btn--sm", type: "button" }, "Ask Athena instead");
  goneTalk.addEventListener("click", () => {
    talkTo(null);
    input.focus();
  });
  const goneBar = h("div", { class: "who-gone", hidden: true }, goneText, goneTalk);
  const voice = voiceSupported()
    ? voiceButton({
        purpose: "ask",
        host: form,
        className: "send-btn",
        // The intro orb breathes while it listens.
        begin: () => {
          el.classList.add("is-listening");
          const done = () => el.classList.remove("is-listening");
          return {
            text: (text) => {
              done();
              void ask(text);
            },
            abandon: done,
          };
        },
      })
    : null;
  if (voice) {
    form.classList.add("composer-bar--voice");
    send.before(voice.el);
  }

  // Talk: the orb starts a spoken back-and-forth (talk/session.ts, loaded on first tap).
  let talk: TalkSession | null = null;
  let talkLoading = false;
  /** The reply Talk reads out: its message gets data-speaking while it does. */
  let spoken: Message | null = null;
  let destroyed = false;
  /** The reply being written in a chat, and how to stop it. One at a time. */
  let live: { c: Chat; m: Message; stop: AbortController } | null = null;
  /** Your last message, back in the box: sending replaces it and the reply under it. */
  let editing: { c: Chat; files: AskFile[] } | null = null;
  /** What the next message is about (openAsk): a chip above the box, sent as an @ mention. */
  let about: AskAbout | null = null;
  /** A skill picked with "/" for the next message: a chip above the box, loaded before Ask starts. */
  let picked: AppSkill | null = null;
  /** The skill the message being sent right now goes with. */
  let askingSkill: string | null = null;
  /** Who the conversation on screen is with (docs/team.md): Athena, or one of the Team's assistants. */
  let who: Who = ATHENA;
  /** Whose conversations the list shows: Athena's (null) or one assistant's. Follows the open conversation. */
  let listWho: ThreadFilter = null;
  /** The team, for the list's filter. */
  let teamNow: TeamAssistant[] = [];
  const talkBtn = talkSupported()
    ? (h(
        "button",
        { class: "talk-btn", type: "button", "aria-label": "Talk with Athena", title: "Talk with Athena" },
        h("span", { class: "orb", "aria-hidden": "true" }),
        svg(`<svg class="talk-btn__wave" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 10.5v3M10 7.5v9M13.5 9v6M17 10.5v3"/></svg>`)
      ) as HTMLButtonElement)
    : null;
  if (talkBtn) {
    form.classList.add("composer-bar--talk");
    send.before(talkBtn);
    talkBtn.addEventListener("click", () => {
      if (talk || talkLoading) return;
      // Inside the tap, before any await: iOS only lets sound start here.
      const audio = isSampleMode() ? null : unlockAudio();
      talkLoading = true;
      void import("../talk/session")
        .then(({ startTalk }) => {
          if (destroyed) return;
          talk = startTalk(
            audio,
            {
              view: el,
              bar: form,
              ask: async (text) => {
                const reply = await ask(text);
                if (reply) showReplyStart(reply);
                spoken = reply;
                return spokenFor(reply);
              },
              ended: () => {
                talk = null;
                paintTail();
              },
              openSetup: () => (location.hash = "#/settings/voice"),
              speaking: (on) => {
                el.querySelector(".msg[data-speaking]")?.removeAttribute("data-speaking");
                if (on && spoken) nodes.get(spoken)?.setAttribute("data-speaking", "");
              },
            },
            { sample: isSampleMode() }
          );
          // Follow-ups aren't offered while you talk.
          paintTail();
        })
        .catch(() => showToast("Talk didn't load. Check you're online and try again.", { icon: "wifiOff" }))
        .finally(() => (talkLoading = false));
    });
  }
  /** A tapped choice or suggestion: through Talk while it's on, so the answer is spoken too. */
  const say = (text: string) => (talk ? talk.submit(text) : void ask(text));
  const paintEmpty = () => {
    const hasFiles = files.count() > 0;
    const empty = !input.text.trim() && !hasFiles;
    const busy = !!live && live.c === current();
    send.hidden = busy;
    stopBtn.hidden = !busy;
    voice?.el.toggleAttribute("hidden", busy);
    // Files still on their way: the question waits with them.
    send.disabled = empty || !files.ready();
    send.setAttribute("aria-label", hasFiles && !files.ready() ? "Waiting for files to upload" : "Ask");
    form.dataset.empty = String(empty);
    form.classList.toggle("has-files", hasFiles);
    input.placeholder = about ? `Ask about ${about.label}…` : hasFiles ? "Ask about this…" : who.id ? `Ask ${who.name}…` : "Ask, or tell me what to do…";
    saveDraft(input.value);
  };

  const suggestionRow = h("div", { class: "suggestions" });
  const introTitle = h("h2", { class: "page-title" }, "Ask your notes");
  const introLede = h("p", {}, "Ask about anything in your notes, calls and email, or tell me what to do.");
  const paintSuggestions = () => {
    // A fresh conversation with an assistant: its character, its name and its job.
    if (who.id) {
      introMark.replaceChildren(whoMark(who, 72));
      introTitle.textContent = who.gone ? who.name : `Ask ${who.name}`;
      introLede.textContent = who.gone ? "No longer on your team." : who.job || who.status;
      suggestionRow.replaceChildren();
      void paintRecent(who);
      return;
    }
    recentSlot.replaceChildren();
    introMark.replaceChildren(h("span", { class: "orb", "aria-hidden": "true" }));
    const fresh = noNotesYet();
    introTitle.textContent = fresh ? "Ask Athena" : "Ask your notes";
    introLede.textContent = fresh ? "Ask what's coming up, or tell me what to remember or do. It works from your first day." : "Ask about anything in your notes, calls and email, or tell me what to do.";
    suggestionRow.replaceChildren(
      ...suggestions().map((s) => {
        const b = h("button", { class: "chip", type: "button" }, s);
        // The evening chip is a button for tonight's picks, which need no model; every other chip just says its words.
        b.addEventListener("click", () => (s === TONIGHT && !talk ? void ask(s, { picks: true }) : say(s)));
        return b;
      })
    );
  };
  const introMark = h("span", { class: "ask__intro-who" }, h("span", { class: "orb", "aria-hidden": "true" }));
  /** A fresh conversation with an assistant: what it's done lately, each opening its conversation (docs/team.md, "Ask"). */
  const recentSlot = h("div", { class: "who-recent-slot" });
  const intro = h("div", { class: "ask__intro" }, introMark, introTitle, introLede, suggestionRow, recentSlot);
  async function paintRecent(of: Who) {
    const id = of.id;
    if (!id || of.gone) return void recentSlot.replaceChildren();
    const runs = await listRuns(id).catch(() => [] as TeamRun[]);
    if (destroyed || who.id !== id) return;
    const shown = runs.filter((r) => r.status !== "failed" || r.thread_id).slice(0, 3);
    if (!shown.length) return void recentSlot.replaceChildren();
    // The Team page's words for when: the device's clock today, then "Yesterday", "Friday", "3 Nov".
    const when = (iso: string) => whenShort(iso);
    const items = shown.map((r) => {
      const working = isLive(r);
      const said = working ? workingWords(of.name, r) : r.status === "failed" ? "Didn't finish" : splitReport(r.summary ?? "").said || "Done";
      // Going now: "Now" with the breathing dot in its own colour, as the Team page's Recent runs.
      const body = [h("span", { class: "who-recent__when" }, working ? h("span", { class: "team-dot", "aria-hidden": "true" }) : null, working ? "Now" : when(r.finished_at ?? r.started_at)), h("span", { class: "who-recent__said" }, said)];
      if (!r.thread_id) return h("li", {}, giveWhoColour(h("div", { class: "who-recent__item", "data-working": working ? "" : undefined }, ...body), working ? of.avatar : null));
      const b = giveWhoColour(h("button", { class: "who-recent__item", type: "button", "data-working": working ? "" : undefined }, ...body), working ? of.avatar : null);
      const thread = r.thread_id;
      b.addEventListener("click", () => void syncAskThreads().catch(() => undefined).then(() => openChat(thread)));
      return h("li", {}, b);
    });
    recentSlot.replaceChildren(h("section", { class: "who-recent", "aria-label": `What ${of.name} did lately` }, h("p", { class: "who-recent__title" }, "Lately"), h("ul", { class: "who-recent__list" }, ...items)));
  }
  // The examples come from the owner's people and recent days: the profile's important people, their latest catch-ups and birthdays.
  void Promise.all([import("../components/home-personal"), import("../lib/home-personal")])
    .then(async ([{ ownerContext }, { askExamples }]) => {
      const c = await ownerContext();
      if (!c.askPeople.length) return;
      // Sample mode keeps the questions it has a written answer for.
      ownerExamples = askExamples({ people: c.askPeople, place: c.place, fixed: isSampleMode() ? [SAMPLE_QUESTION, SAMPLE_LIFE_QUESTION] : undefined });
      paintSuggestions();
    })
    .catch(() => undefined);

  // ---------- Head: Chats, the chat's name, New ----------
  const chatsBtn = h(
    "button",
    { class: "ask__chats-btn", type: "button", "aria-haspopup": "dialog" },
    icons.chat(),
    h("span", {}, "Conversations")
  ) as HTMLButtonElement;
  const titleEl = h("p", { class: "ask__title" });
  const newBtn = h("button", { class: "icon-btn icon-btn--ghost ask__new", type: "button", "aria-label": "New conversation", title: "New conversation" }, icons.pen()) as HTMLButtonElement;
  // Ask's menu: Skills, and making one from this conversation.
  const menuBtn = h("button", { class: "icon-btn icon-btn--ghost ask__menu-btn", type: "button", "aria-label": "More", title: "More", popovertarget: "ask-menu" }, icons.more()) as HTMLButtonElement;
  const askMenu = h("div", { class: "menu ask-menu", id: "ask-menu", popover: "auto" }) as HTMLElement & { hidePopover?: () => void };
  const menuItem = (icon: IconName, label: string, run: () => void) => {
    const b = h("button", { class: "menu__item", type: "button" }, icons[icon](), label);
    b.addEventListener("click", () => {
      askMenu.hidePopover?.();
      run();
    });
    return b;
  };
  askMenu.append(
    menuItem("book", "Skills", () => (location.hash = "#/settings/skills")),
    menuItem("sparkle", "Make this a skill", () => void makeSkill())
  );
  // Wide screens hide the head: the rail's head has the same button.
  const railMenuBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost ask__menu-btn", type: "button", "aria-label": "More", title: "More", popovertarget: "ask-menu" }, icons.more()) as HTMLButtonElement;
  let menuFrom = menuBtn;
  menuBtn.addEventListener("click", () => (menuFrom = menuBtn));
  railMenuBtn.addEventListener("click", () => (menuFrom = railMenuBtn));
  askMenu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = menuFrom.getBoundingClientRect();
    askMenu.style.top = `${r.bottom + 6}px`;
    placeMenuAcross(askMenu, menuFrom);
  });
  // Who you're talking to, in the middle of the head: tap it to pick someone else (components/ask-who.ts).
  const whoMarkSlot = h("span", { class: "ask-who__mark" });
  const whoName = h("span", {});
  const whoStatus = h("span", { class: "ask-who__status" });
  const whoBtn = h(
    "button",
    { class: "ask-who", type: "button", "aria-haspopup": "menu" },
    whoMarkSlot,
    h("span", { class: "ask-who__text" }, h("span", { class: "ask-who__name" }, whoName, icons.chevronDown()), whoStatus)
  ) as HTMLButtonElement;
  whoBtn.addEventListener("click", () => pickWho({ anchor: whoBtn, current: who.id, onPick: (w) => talkTo(w.id) }));
  const head = h("header", { class: "ask__head" }, chatsBtn, whoBtn, h("span", { class: "ask__head-actions" }, menuBtn, newBtn));

  // Wide screens: the list sits beside the conversation.
  const railList = h("div", { class: "ask__rail-list" });
  const railNew = h("button", { class: "icon-btn icon-btn--sm ask__rail-new", type: "button", "aria-label": "New conversation", title: "New conversation" }, icons.pen()) as HTMLButtonElement;
  // Searching the list: every word must appear, in the name or anything said.
  let listSearch: { query: string; matches: ThreadMatch[] } | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const searchBox = () => {
    const field = h("input", { type: "search", placeholder: "Search conversations", autocomplete: "off", "aria-label": "Search conversations", enterkeyhint: "search", value: listSearch?.query ?? "" }) as HTMLInputElement;
    field.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const query = field.value;
        const matches = query.trim() ? await searchThreads(query.split(/\s+/), { every: true }) : [];
        if (field.value !== query) return;
        listSearch = query.trim() ? { query, matches } : null;
        void paintList();
      }, 120);
    });
    field.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && field.value) {
        e.preventDefault();
        e.stopPropagation();
        field.value = "";
        field.dispatchEvent(new Event("input"));
      }
    });
    return h("label", { class: "search chats__search" }, icons.search(), field);
  };
  const railSearch = searchBox();
  const rail = h("aside", { class: "ask__rail", "aria-label": "Conversations" }, h("div", { class: "ask__rail-head" }, h("h2", { class: "ask__rail-title" }, "Conversations"), h("span", { class: "ask__head-actions" }, railMenuBtn, railNew)), railSearch, railList);
  const wide = window.matchMedia("(min-width: 1200px)");

  const column = h("div", { class: "ask__col" }, head, intro, threadEl, form, goneBar);
  // The page's title, on the same line as every other page's on a wide screen; on a phone the welcome says it, so it's only for screen readers there.
  // The menu sits outside the head, which wide screens hide.
  const el = h("div", { class: "view ask" }, pageHead({ class: "ask__page-head", title: "Ask" }), rail, column, askMenu);

  // Only new messages are appended (re-attaching a node would replay its
  // entrance animation); a chat opened or restored doesn't animate.
  let nodes = new Map<Message, HTMLElement>();
  const ownerOf = new WeakMap<Message, Chat>();
  const buildBare = (m: Message, c: Chat): HTMLElement =>
    m.role === "me" && m.run_line
      ? // What set off a Team run: not the owner's words, so a quiet line, not their bubble.
        h("div", { class: "msg msg--run" }, h("p", { class: "msg__run" }, m.text))
      : m.role === "me"
      ? h(
          "div",
          { class: `msg msg--me${m.files?.length ? " msg--files" : ""}` },
          // Photos and files sit on their own above the words, like a message app.
          m.files?.length ? messageFiles(m.files) : null,
          m.text ? h("div", { class: "bubble" }, ...linkTextNodes(m.text, (kind, id) => void openMention(kind, id, ctx))) : null
        )
      : m.role === "assistant"
        ? assistantEl(
            m,
            ctx,
            say,
            () => void regenerate(m, c),
            () => rebuild(m),
            () => {
              rebuild(m);
              keep(c);
            }
          )
        : m.role === "answer"
          ? m.reply
            ? withPictures(withActs(withSteps(answerReplyEl(m, ctx, () => rebuild(m)), m), m, c), m, c)
            : m.unreached
              ? unreachedEl(m, c.locked ? null : () => void writeAnswer(m, c))
            : m.fallback
              ? answerEl({ role: "athena", at: m.at, question: m.question, terms: m.terms, answer: m.fallback, refs: m.refs }, ctx, m.note, c.locked || (m.offline && !isOnline()) || m.note === SAMPLE_NONE_NOTE ? null : () => void writeAnswer(m, c))
              : m.saved
                ? loadingEl()
                : workingEl(m, "Athena is looking into it", "Searching your notes, calls and email…", "Still looking…")
          : answerEl(m, ctx);

  /** A reply's bubble in a column of its own, so cards and follow-ups line up under it (the orb stays beside the bubble). */
  const columnOf = (node: HTMLElement): HTMLElement | null => {
    const had = node.querySelector<HTMLElement>(":scope > .assist");
    if (had) return had;
    const bubble = node.querySelector<HTMLElement>(":scope > .bubble");
    if (!bubble) return null;
    const col = h("div", { class: "assist" });
    bubble.replaceWith(col);
    col.append(bubble);
    return col;
  };

  /**
   * What the reply did, with its words: what it remembered and the choices it's waiting on inside the bubble,
   * under the text; then, under the bubble, anything that waits for a tap, a plan, and the receipts with Undo.
   */
  function withActs(node: HTMLElement, m: WrittenMessage, c: Chat): HTMLElement {
    if (!acted(m.reply)) return node;
    const save = () => {
      rebuild(m);
      keep(c);
    };
    const parts = actedEls(m, ctx, say, () => rebuild(m), save);
    const col = columnOf(node);
    if (!col) return node;
    const bubble = col.querySelector<HTMLElement>(".bubble");
    const textEl = col.querySelector<HTMLElement>(".answer__text");
    if (parts.within.length) (textEl ?? bubble)?.[textEl ? "after" : "append"](...parts.within);
    // The receipts sit in the bubble, straight under the words: what was done is part of the reply, not a footnote to it.
    if (parts.changes) {
      parts.changes.classList.add("found__list");
      const done = h("div", { class: "found acted" }, parts.changes);
      // Before the sources: "I've added a to-do" is followed by the to-do, then by what was read.
      const after = parts.within.at(-1) ?? textEl;
      if (after) after.after(done);
      else bubble?.prepend(done);
    }
    // What waits for a tap, and a plan, are cards of their own under the bubble.
    col.append(...parts.cards);
    node.classList.add("msg--acted");
    return node;
  }

  /**
   * The pictures a reply made, at the top of its bubble above the words (components/ask-picture.ts): open full
   * size, Save to a note, Download, and Undo, which is the picture's receipt in What Ask did.
   */
  /** Pictures on their way back from Archived, by Undo key. */
  const restoring = new Set<string>();
  function withPictures(node: HTMLElement, m: WrittenMessage, c: Chat): HTMLElement {
    const shown = (m.reply as ModelNote | null)?.pictures ?? [];
    if (!shown.length) return node;
    const save = () => {
      rebuild(m);
      keep(c);
    };
    const all = () =>
      c.messages.flatMap((x) => (x.role === "answer" ? ((x.reply as ModelNote | null)?.pictures ?? []).map((p) => p.file) : x.role === "me" ? (x.files ?? []).filter((f) => f.type.startsWith("image/")) : []));
    const cards = shown.map((p: ShownPicture) => {
      const ch = m.reply?.changes?.find((x) => x.kind === "picture" && x.id === p.file.id);
      const key = ch ? changeKey(ch) : "";
      const state = ch && restoring.has(key) ? "restoring" : ch && m.undone.has(key) ? "undone" : ch && m.undoing.has(key) ? "undoing" : !ch?.undo || m.gone.has(key) ? "gone" : "ready";
      return pictureCard(p, {
        state,
        // Undo archives it (owner, 17 Nov 2026): on the Archived page, and Restore here puts it back.
        onUndo: ch?.undo
          ? () =>
              void undoChange(key, ch.undo!, m, () => rebuild(m), save, ch.activity_id).then(() => {
                if (isSampleMode() && m.undone.has(key)) archiveSamplePicture(c.id, p.file, p.note ? 1 : 0);
              })
          : undefined,
        onRestore: ch
          ? () => {
              restoring.add(key);
              rebuild(m);
              void restorePicture({ thread_id: c.id, file: p.file }, { thread: false })
                .then(() => {
                  m.undone.delete(key);
                  save();
                })
                .catch(() => showToast(navigator.onLine ? "Couldn't restore the picture. Try again." : "You're offline. Restore it once you're back online.", { icon: "restore" }))
                .finally(() => {
                  restoring.delete(key);
                  rebuild(m);
                });
            }
          : undefined,
        onSaved: (note) => {
          p.note = note;
          save();
        },
        all,
      });
    });
    const el = picturesEl(cards);
    const textEl = node.querySelector<HTMLElement>(".answer__text");
    if (el && textEl) textEl.before(el);
    else if (el) node.querySelector(".bubble")?.prepend(el);
    return node;
  }

  const build = (m: Message, c: Chat): HTMLElement => {
    const node = buildBare(m, c);
    decorate(node, m, c);
    attachSpendNotice(node, m as { reply?: unknown; question?: unknown }, say);
    leadWith(node, m, c);
    void addPast(node, m, c);
    return node;
  };

  /**
   * A reply in a conversation with an assistant carries its small avatar and
   * name, with the current step in the pill while it works. Any reply that
   * checked with a teammate says so: "Checked with Moss".
   */
  function leadWith(node: HTMLElement, m: Message, c: Chat) {
    if (m.role === "me") return;
    const reply = m.role === "answer" || m.role === "assistant" ? (m.reply as { sources?: { kind: string }[]; checked?: CheckedReply[] } | null) : null;
    const chips = teammateSources(reply?.sources, reply?.checked).map(checkedWith);
    // Inside the reply's column, above its words.
    if (chips.length) (node.querySelector<HTMLElement>(":scope > .assist") ?? node.querySelector<HTMLElement>(":scope > .bubble") ?? node).prepend(...chips);
    if (!c.assistant_id) return;
    const name = who.id === c.assistant_id ? who.name : "";
    // Its own words under its reply and plan: "Done by Moss", "Moss suggests", never "the Agent" or "your routine".
    if (name) {
      const said: Record<string, string> = { "Done by the Agent": `Done by ${name}`, "Planned by the Agent": `Planned by ${name}`, "From the Agent": `From ${name}` };
      const foot = node.querySelector<HTMLElement>(".assist__foot");
      // decorate() has wrapped its words in .foot__text by now.
      for (const t of foot ? [...(foot.querySelector(".foot__text") ?? foot).childNodes] : []) if (t.nodeType === Node.TEXT_NODE && t.textContent && said[t.textContent]) t.textContent = said[t.textContent];
      const head = node.querySelector<HTMLElement>(".plan__head");
      const headText = head?.lastChild?.nodeType === Node.TEXT_NODE ? head.lastChild : null;
      if (headText?.textContent === "Your routine suggests") headText.textContent = `${name} suggests`;
      // When it couldn't reply, it says so itself: Athena didn't answer here, and "I" isn't Athena.
      voiceOf(node, name);
    }
    const lead = whoLead(who.id === c.assistant_id ? who : { id: c.assistant_id, name: "", avatar: null, status: "" });
    node.prepend(lead.el);
    node.classList.add("msg--who");
    const working = isWorking(m);
    // The head says "Working" while the newest reply here is still coming, and goes back once it lands.
    if (c === chat && m === c.messages[c.messages.length - 1]) paintWhoStatus();
    if (!working) return;
    lead.step(("steps" in m ? currentStep(m.steps) : null) ?? "Thinking");
    pillViews.set(m, lead.step);
  }

  /** A finished reply: in its column (so follow-ups sit under it), with its versions, Try again and Pin on its last line. */
  function decorate(node: HTMLElement, m: Message, c: Chat) {
    if (m.role !== "answer" && m.role !== "assistant") return;
    if (m.role === "answer" ? !m.reply && !m.fallback : !m.reply) return;
    if (m.role === "answer") columnOf(node);
    // A follow-up that couldn't be reached isn't a reply yet: nothing to pin or to keep versions of. Its own button asks again.
    if (m.role === "answer" && !m.reply && m.unreached) return;
    const foot = node.querySelector<HTMLElement>(".bubble__foot, .assist__foot");
    // A quiet "Used: Meeting prep" for the skills it followed; each opens its skill.
    const used = m.reply?.skills ?? [];
    if (used.length) {
      const line = h("p", { class: "answer__used" }, h("span", {}, "Used:"), ...used.flatMap((u, i) => [i ? ", " : " ", h("a", { href: `#/settings/skills/${encodeURIComponent(u.id)}` }, u.name)]));
      if (foot) foot.before(line);
      else node.querySelector(".bubble")?.append(line);
    }
    // "Answered with Gemini 3.5 Flash", or that the chosen model didn't answer (components/ask-picture.ts).
    const model = m.role === "answer" ? modelLine(m.reply as ModelNote | null) : null;
    if (model) {
      if (foot) foot.before(model);
      else node.querySelector(".bubble")?.append(model);
    }
    const bar = replyBar(m, c);
    if (foot) {
      foot.classList.add("has-actions");
      // Its words and icon stay together; the bar takes the rest of the line, or its own line on a phone.
      foot.replaceChildren(h("span", { class: "foot__text" }, ...foot.childNodes), bar);
    } else node.querySelector(".bubble")?.append(h("p", { class: "bubble__foot has-actions" }, bar));
  }

  /** "‹ 2 of 2 ›", Try again (written again, the old one kept) and Pin. */
  function replyBar(m: AssistantMessage | WrittenMessage, c: Chat): HTMLElement {
    const bar = h("span", { class: "reply-bar" });
    const label = versionLabel(m.slot);
    if (label && m.slot) {
      const slot = m.slot;
      const prev = h("button", { class: "icon-btn icon-btn--xs icon-btn--ghost", type: "button", "aria-label": "Previous version", disabled: slot.index === 0 }, icons.back());
      const next = h("button", { class: "icon-btn icon-btn--xs icon-btn--ghost", type: "button", "aria-label": "Next version", disabled: slot.index === slot.all.length - 1 }, icons.chevronRight());
      prev.addEventListener("click", () => showVersion(m, c, slot.index - 1));
      next.addEventListener("click", () => showVersion(m, c, slot.index + 1));
      bar.append(h("span", { class: "reply-bar__versions" }, prev, h("span", { class: "reply-bar__count" }, label), next));
    }
    if (canRetry(m)) {
      const again = h("button", { class: "icon-btn icon-btn--xs icon-btn--ghost", type: "button", "aria-label": "Try again", title: "Try again" }, icons.refresh());
      again.addEventListener("click", () => void regenerate(m, c));
      bar.append(again);
    }
    const on = !!m.pinned_at;
    const pin = h("button", { class: `icon-btn icon-btn--xs icon-btn--ghost reply-bar__pin${on ? " is-on" : ""}`, type: "button", "aria-pressed": String(on), "aria-label": on ? "Unpin" : "Pin", title: on ? "Unpin" : "Pin to the top of Conversations" }, icons.thumbtack());
    pin.addEventListener("click", () => togglePin(m, c));
    bar.append(pin);
    return bar;
  }

  /** Any reply can be written again (a reply that changed things asks first: regenerate). */
  const canRetry = (m: AssistantMessage | WrittenMessage) => (m.role === "answer" ? !isFallback(m) : !!m.reply) && !current().locked;

  /** The one automatic retry of a follow-up that couldn't be reached, by its message: cleared when it's asked again by hand. */
  const retryTimers = new WeakMap<WrittenMessage, number>();

  /** "Write the answer" on a keyword search, or Try again on a follow-up that couldn't be reached: the reply takes its place, where it is. */
  async function writeAnswer(m: WrittenMessage, c: Chat) {
    const i = c.messages.indexOf(m);
    if (live || c.locked || i < 0 || !isFallback(m)) return void rebuild(m);
    const before = c.messages.slice(0, i);
    const j = lastMine(before);
    const mine = before[j];
    const prior: Chat = { ...c, messages: mine?.role === "me" ? before.slice(0, j) : before };
    const sent = mine?.role === "me" ? (mine.files ?? []) : [];
    await writtenAnswer(c, m.question, answerHistory(prior.messages), sent, recentFiles(prior, sent), null, null, m);
    if (chat === c) paintTail();
  }

  /** The connection is back and this chat is open: each keyword search shown for want of one is written, once (lib/ask-fallback.ts). */
  async function writeOfflineOnes() {
    const c = chat;
    if (!c || destroyed) return;
    const due = takeOfflineFallbacks(c.messages.filter((m): m is WrittenMessage => m.role === "answer"), { open: el.isConnected && !c.locked, online: isOnline(), busy: !!live });
    for (const m of due) if (chat === c && !destroyed) await writeAnswer(m, c);
  }
  const onOnline = () => {
    sampleBackOnline();
    void writeOfflineOnes();
  };
  window.addEventListener("online", onOnline);

  /** Under an answer: other conversations that talked about the same thing, to jump back into. Found on this device. */
  async function addPast(node: HTMLElement, m: Message, c: Chat) {
    if (m.role !== "athena" && m.role !== "answer") return;
    if (m.role === "athena" ? !m.answer : (!m.reply && !m.fallback) || (!m.reply && !!m.unreached)) return;
    // A reply the AI budget stopped answered nothing: no past conversations under it (components/spend-notice.ts).
    if (m.role === "answer" && (m.reply as { budget?: unknown } | null)?.budget) return;
    const words = keywords(mentionsToText(m.question));
    // Only the same one's conversations: Athena's past chats for Athena, an assistant's own for it.
    const found = (await searchThreads(words, { except: c.id, limit: 6 })).filter((t) => relevant(t) && (t.thread.assistant_id ?? null) === (c.assistant_id ?? null)).slice(0, 3);
    const bubble = node.querySelector<HTMLElement>(".bubble");
    if (!found.length || !bubble) return;
    const rows = found.map(({ thread, snippet }) => {
      const b = h(
        "button",
        { class: "answer", type: "button" },
        h("span", { class: "tile tile--sm" }, icons.chat()),
        h(
          "span",
          { class: "row__body" },
          h("span", { class: "row__title" }, ...highlight(threadTitle(thread), words)),
          snippet ? h("span", { class: "row__snippet" }, ...highlight(snippet, words)) : null,
          h("span", { class: "row__meta" }, `Conversation · ${compactTime(thread.updated_at)}`)
        )
      );
      b.addEventListener("click", () => void openChat(thread.id));
      return b;
    });
    const foot = bubble.querySelector(":scope > .bubble__foot");
    bubble.insertBefore(h("p", { class: "answers__label" }, "In past conversations"), foot);
    bubble.insertBefore(h("div", { class: "answers" }, ...rows), foot);
    // It grew an answer above the end: stay at the end if that's where you were.
    if (chat === c && pinned) scrollToEnd(true);
  }

  /** Swap a message's node for a fresh one (no entrance animation). Messages of a chat not on screen just wait. */
  function rebuild(m: Message) {
    const old = nodes.get(m);
    const c = ownerOf.get(m);
    if (!old || !c) return;
    const node = build(m, c);
    node.style.animation = "none";
    old.replaceWith(node);
    nodes.set(m, node);
    if (chat === c) paintTail();
  }

  /** Put another message in a reply's place (a version, or one being written again), without animating. */
  function place(c: Chat, old: Message, next: Message) {
    const i = c.messages.indexOf(old);
    if (i < 0) return;
    c.messages[i] = next;
    ownerOf.set(next, c);
    const was = nodes.get(old);
    nodes.delete(old);
    if (!was) return;
    const node = build(next, c);
    node.style.animation = "none";
    was.replaceWith(node);
    nodes.set(next, node);
  }

  /**
   * The end of the conversation: follow-ups under the last reply (not while
   * you talk or while a reply is written), and Edit beside your last message.
   */
  function paintTail() {
    for (const x of threadEl.querySelectorAll(".followups, .msg__edit")) x.remove();
    for (const x of threadEl.querySelectorAll(".msg--me.is-editing")) x.classList.remove("is-editing");
    const c = current();
    if (c.locked) return;
    const msgs = c.messages;
    const busy = !!live && live.c === c;
    // Under the latest reply, lined up with its bubble (the orb stays beside the bubble). Not while you talk or it's written.
    const latest = msgs[msgs.length - 1];
    for (const m of talk || busy || !latest ? [] : [latest]) {
      if (m.role !== "answer" && m.role !== "assistant") continue;
      const waitingPick = !!m.reply?.choices?.length && !m.answered;
      const next = waitingPick ? [] : (m.reply?.next ?? []);
      const node = nodes.get(m);
      if (next.length && node) {
        // Follow-ups under the last reply: keep the end in view if that's where you are (a long reply keeps its start).
        if (pinned) settle(m);
        // After a question back from Athena these are its choices, not follow-ups: a card of their own.
        if (m.role === "answer" && m.reply?.clarify) {
          const asks = m.reply.asks?.length ? m.reply.asks : [{ question: m.reply.text, options: next }];
          node.after(askCard(asks, { send: say, own: () => input.focus() }));
        } else {
          node.after(
            h(
              "div",
              { class: "followups", role: "group", "aria-label": "Ask next" },
              ...next.map((t, i) => {
                const b = h("button", { class: "chip followups__chip", type: "button", style: `--i:${i}` }, t);
                b.addEventListener("click", () => say(t));
                return b;
              })
            )
          );
        }
      }
    }
    const j = lastMine(msgs);
    const mine = msgs[j];
    const node = mine ? nodes.get(mine) : null;
    if (!node || mine.role !== "me" || mine.run_line || !mine.text.trim()) return;
    if (editing?.c === c) return void node.classList.add("is-editing");
    if (busy) return;
    const edit = h("button", { class: "msg__edit", type: "button", "aria-label": "Edit your message", title: "Edit (↑)" }, icons.pen(), h("span", {}, "Edit"));
    edit.addEventListener("click", startEdit);
    node.prepend(edit);
  }

  /** In Talk, a reply taller than half the screen is shown from its start, where the spoken part is. */
  function showReplyStart(m: Message) {
    const node = nodes.get(m);
    if (!node) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (node.isConnected && node.getBoundingClientRect().height > window.innerHeight * 0.5) node.scrollIntoView({ block: "start", behavior: scrollBehavior() });
      })
    );
  }

  /** To the very end, so the last reply and its follow-ups sit fully above the box (which is sticky at the end). */
  function scrollToEnd(instant = false) {
    if (!threadEl.lastElementChild) return;
    requestAnimationFrame(() => {
      const s = scroller();
      s?.scrollTo({ top: s.scrollHeight, behavior: instant ? "auto" : scrollBehavior() });
    });
  }

  /**
   * How far the chat can scroll before a reply's question reaches the top,
   * and how far it is from the end. A long answer is read from its start, so
   * the chat never scrolls its start out of view by itself.
   */
  function reach(m: Message): { room: number; toEnd: number; s: Element } | null {
    const node = nodes.get(m);
    const s = scroller();
    const c = ownerOf.get(m);
    if (!node?.isConnected || !s || !c) return null;
    const before = c.messages[c.messages.indexOf(m) - 1];
    const mine = before?.role === "me" ? nodes.get(before) : undefined;
    const anchor = mine?.isConnected ? mine : node;
    return { room: roomAbove(anchor, s), toEnd: s.scrollHeight - s.scrollTop - s.clientHeight, s };
  }

  /** How far this can move up before it meets the head of the chat (or the top of the page, where there's no head). */
  function roomAbove(anchor: Element, s: Element): number {
    const hb = head.getBoundingClientRect();
    const top = hb.height && getComputedStyle(head).position === "sticky" ? hb.bottom : s === document.scrollingElement ? 0 : s.getBoundingClientRect().top;
    // A little air above it; more where there's no head over it (a wide screen).
    return anchor.getBoundingClientRect().top - top - (hb.height ? 12 : 24);
  }

  /** While a reply is written: follow its end, until its question is at the top. */
  function follow(m: Message) {
    requestAnimationFrame(() => {
      const r = reach(m);
      if (!r) return;
      const by = Math.min(r.toEnd, r.room);
      if (by > 0) r.s.scrollTo({ top: r.s.scrollTop + by, behavior: "auto" });
    });
  }

  /** A reply has landed: to the end when it all fits; a longer one stays where it's being read, or is shown from its start. */
  function settle(m: Message) {
    requestAnimationFrame(() => {
      const r = reach(m);
      if (!r || r.room >= r.toEnd) scrollToEnd();
      // Not for a few pixels: a nudge that small only reads as a twitch.
      else if (r.room > 8) r.s.scrollTo({ top: r.s.scrollTop + r.room, behavior: scrollBehavior() });
      // Once that scroll has come to rest (and the tab bar is back, if the keyboard just closed), nothing to tap is left behind the bars.
      window.setTimeout(() => clearBars(m), 420);
    });
  }

  /** The top of what covers the foot of the chat: the box you type in, and the tab bar when it's showing. */
  function barsTop(): number {
    const tops = [form, document.querySelector<HTMLElement>(".dock__bar")]
      .map((e) => (e && getComputedStyle(e).opacity !== "0" ? e.getBoundingClientRect() : null))
      .filter((r): r is DOMRect => !!r && r.height > 0 && r.top < window.innerHeight)
      .map((r) => r.top);
    return Math.min(window.innerHeight, ...tops);
  }

  /**
   * The last reply clears the box and the tab bar (owner, 12 Nov 2026: a reply's button sat behind them on iPhone).
   * A reply that fits between the head and the bars is brought wholly above them, follow-ups included. One too
   * long to fit is read from its start, as far up as it goes, and the thing it asks you to tap (Try again, Write the answer, Go, a choice) is never left behind them.
   */
  function clearBars(m: Message | undefined = chat?.messages[chat.messages.length - 1]) {
    const c = chat;
    const node = m && nodes.get(m);
    const s = scroller();
    if (destroyed || !c || !m || !node?.isConnected || !s || c.messages[c.messages.length - 1] !== m || (live && live.c === c)) return;
    const limit = barsTop() - 12;
    const tail = threadEl.lastElementChild ?? node;
    const over = Math.max(tail.getBoundingClientRect().bottom, node.getBoundingClientRect().bottom) - limit;
    const toEnd = s.scrollHeight - s.scrollTop - s.clientHeight;
    if (over <= 1 || toEnd <= 1) return;
    // How far it can move up with its own start still in view: your question may go, the reply's first line never does.
    const room = Math.max(0, roomAbove(node, s));
    const action = node.querySelector<HTMLElement>(".unreached__again, .answer__write, .plan__go, .choices .btn");
    const need = action ? action.getBoundingClientRect().bottom - limit : 0;
    const by = Math.min(toEnd, Math.max(Math.min(over, room), need));
    if (by > 1) s.scrollTo({ top: s.scrollTop + by, behavior: scrollBehavior() });
  }

  // The bars move by themselves: the tab bar comes back when the keyboard closes, the box grows as you type. If the chat was at its end, it stays there.
  let wasTyping = document.body.classList.contains("typing");
  const barsWatch = new MutationObserver(() => {
    const typing = document.body.classList.contains("typing");
    if (typing === wasTyping) return;
    wasTyping = typing;
    if (!pinned) return;
    window.setTimeout(() => (pinned ? scrollToEnd() : undefined), 360);
    window.setTimeout(() => clearBars(), 800);
  });
  barsWatch.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  const current = (): Chat => (chat ??= newChat());

  function paintHead() {
    const c = current();
    const has = c.messages.length > 0;
    titleEl.textContent = has ? threadTitle(toThread(c)) : "";
    titleEl.title = titleEl.textContent;
    newBtn.hidden = !has;
    railNew.disabled = !has;
    el.classList.toggle("ask--empty", !has);
    el.classList.toggle("ask--fresh", !has && !threads.length);
    paintWho();
  }

  /** The head's who: their mark, name and status line (Athena's is the conversation's name). Looks them up when the conversation changes hands. */
  /** Assistants on a run right now (lib/team-live.ts), by id. */
  let onRun = new Set<string>();
  const offActivity = onTeamActivity((runs) => {
    const next = new Set(runs.filter(isLive).map((r) => r.assistant_id));
    if ([...next].join() === [...onRun].join()) return;
    onRun = next;
    if (!destroyed) paintWhoStatus();
  });

  function paintWho() {
    const id = current().assistant_id ?? null;
    if (who.id !== id) {
      who = id ? { id, name: "", avatar: null, status: "" } : ATHENA;
      if (id)
        void findWho(id).then((w) => {
          if (destroyed || (current().assistant_id ?? null) !== id) return;
          who = w;
          paintWho();
          paintSuggestions();
          paintEmpty();
          // Replies drawn before the team loaded get their avatar now.
          for (const m of nodes.keys()) if (m.role !== "me") rebuild(m);
        });
      paintSuggestions();
      paintEmpty();
    }
    whoMarkSlot.replaceChildren(whoMark(who, 32));
    whoName.textContent = who.name;
    // One who has left the team can't be asked again: the box gives way to a line saying so, and the way on.
    form.hidden = !!who.gone;
    goneBar.hidden = !who.gone;
    if (who.gone) goneText.textContent = `${who.name} isn't on your team any more.`;
    paintWhoStatus();
    whoBtn.setAttribute("aria-label", `Talking to ${who.name || "an assistant"}. Choose who to ask`);
  }

  /**
   * The line under the head's name: the assistant's status, or just "Working"
   * while its newest reply here is still coming (owner, 15 Nov 2026). The step
   * itself is in the pill beside the reply, in full, so the head never cuts it short.
   */
  function paintWhoStatus() {
    const c = chat;
    const last = c?.messages[c.messages.length - 1];
    // Working here, or on a run of its own: the sidebar, Home and the Team page say "Working" then too.
    const busy = (!!who.id && !!c && c.assistant_id === who.id && !!last && isWorking(last)) || (!!who.id && onRun.has(who.id));
    const status = busy ? WORKING : who.id ? who.status : titleEl.textContent || ATHENA_STATUS;
    if (whoStatus.textContent !== status || busy !== whoStatus.classList.contains("is-working")) {
      // Working: the breathing dot in the assistant's own colour (owner, 16 Nov 2026), and its ring in the head.
      if (busy) whoStatus.replaceChildren(h("span", { class: "team-dot ask-who__dot", "aria-hidden": "true" }), status);
      else whoStatus.textContent = status;
    }
    whoStatus.title = status;
    whoStatus.classList.toggle("is-working", busy);
    giveWhoColour(whoBtn, busy ? who.avatar : null);
  }

  /** Talk to someone else: a new conversation with them (or this empty one, handed over). */
  function talkTo(id: string | null) {
    const c = current();
    listWho = id;
    if (!c.messages.length) {
      c.assistant_id = id;
      void paintList();
      paintHead();
    } else {
      show(newChat(id), { remember: false });
      void setLastOpened(null);
    }
    input.focus({ preventScroll: true });
  }

  let lastDay = "";
  let unfinished: HTMLElement | null = null;

  /**
   * The chat ends on your words with no reply: the app closed before the
   * answer came. Say so, with Try again, which answers it where it is.
   */
  function markUnfinished(c: Chat) {
    unfinished?.remove();
    unfinished = null;
    const last = c.messages[c.messages.length - 1];
    if (!last || last.role !== "me" || answering.has(last) || c.locked) return;
    // It was sent as a run, which carries on without the app: pick that up rather than say it didn't finish.
    if (last.run && !live && navigator.onLine && !isSampleMode()) return void pickUp(c, last);
    const again = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.refresh(), "Try again");
    again.addEventListener("click", () => {
      unfinished?.remove();
      unfinished = null;
      const before = c.messages.slice(0, -1);
      answering.add(last);
      void respond(c, last.text, null, answerHistory(before), last.files ?? []).finally(() => answering.delete(last));
    });
    unfinished = h(
      "div",
      { class: "msg msg--athena" },
      h("span", { class: "orb", "aria-hidden": "true" }),
      h("div", { class: "bubble assist__error" }, h("p", {}, "This didn't finish."), h("div", { class: "assist__retry" }, again))
    );
    unfinished.style.animation = "none";
    threadEl.append(unfinished);
  }

  /**
   * The chat ends on a reply that was still being worked on when the app
   * closed. Its run carried on without the app, so follow it by its id.
   * (Without this, its Try again would ask a second time.)
   */
  function followUnfinished(c: Chat) {
    const last = c.messages[c.messages.length - 1];
    if (last?.role !== "assistant" || !last.resume || !last.run || last.reply || live || !navigator.onLine || isSampleMode()) return;
    const run = last.run;
    const i = c.messages.indexOf(last);
    const mine = c.messages[lastMine(c.messages.slice(0, i))];
    if (mine?.role !== "me") return;
    // Followed under its id, in its place; if the server no longer knows it, its "This didn't finish" comes back.
    void writtenAnswer(c, mine.text, answerHistory(c.messages.slice(0, c.messages.indexOf(mine))), mine.files ?? [], [], { replace: last, join: () => undefined }, run).catch(() => {
      last.run = undefined;
      last.resume = false;
      last.error = "This didn't finish. Try again.";
      c.messages.push(last);
      if (chat === c) paint(false);
    });
  }

  function paint(animate: boolean) {
    const c = current();
    intro.hidden = c.messages.length > 0;
    if (unfinished && c.messages[c.messages.length - 1]?.role !== "me") {
      unfinished.remove();
      unfinished = null;
    }
    for (const m of c.messages) {
      if (nodes.has(m)) continue;
      // A divider above the first message of each day, with the time it started.
      const day = new Date(m.at).toDateString();
      if (day !== lastDay && m.role === "me") {
        lastDay = day;
        const divider = h("p", { class: "thread__day" }, h("span", {}, dayLabel(m.at)), h("span", { class: "thread__time" }, timeOf(m.at)));
        if (!animate) divider.style.animation = "none";
        threadEl.append(divider);
      }
      const node = build(m, c);
      if (!animate) node.style.animation = "none";
      nodes.set(m, node);
      ownerOf.set(m, c);
      threadEl.append(node);
    }
    paintHead();
    paintTail();
    scrollToEnd(!animate);
  }

  /** Put a chat on screen: everything at once, then reopened answers fill in as they load. */
  function show(c: Chat, opts: { remember?: boolean } = {}) {
    chat = c;
    listWho = c.assistant_id ?? null;
    nodes = new Map();
    lastDay = "";
    threadEl.replaceChildren();
    threadEl.classList.remove("is-entering");
    void threadEl.offsetWidth;
    threadEl.classList.add("is-entering");
    unfinished = null;
    paint(false);
    markUnfinished(c);
    followUnfinished(c);
    if (opts.remember !== false && c.saved) void setLastOpened(c.id);
    void hydrate(c);
    void paintList();
  }

  /** Load what reopened answers found, and check old undos still make sense. The chat stays at its end as they fill in. */
  async function hydrate(c: Chat) {
    const loads: Promise<unknown>[] = [];
    for (const m of c.messages) {
      if (m.role === "athena" && !m.answer && m.refs) {
        loads.push(
          loadAnswer(m).then((answer) => {
            m.answer = answer;
            rebuild(m);
            if (chat === c && pinned) scrollToEnd(true);
          })
        );
      } else if (m.role === "answer" && m.saved && !m.reply && !m.fallback) {
        const saved = m.saved;
        const load = saved.fallback
          ? loadAnswer({ role: "athena", at: m.at, question: m.question, terms: m.terms, answer: null, refs: m.refs }).then((a) => (m.fallback = a))
          : loadWritten(saved)
              .then((r) => (m.reply = r))
              // An Undo on an older note edit would put back text written since: hidden once the note has moved on.
              .then((r) => (r.changes?.length ? checkUndos(m) : false));
        loads.push(
          load.then(() => {
            rebuild(m);
            if (chat === c && pinned) scrollToEnd(true);
          })
        );
      } else if (m.role === "assistant" && m.reply?.changes.length) {
        loads.push(checkUndos(m).then((changed) => changed && rebuild(m)));
      }
    }
    await Promise.allSettled(loads);
  }

  /** Still at the end of the chat (nobody scrolled up while it loaded). */
  let pinned = true;
  // The page scrolls on a phone; on a desktop, .main does.
  const scroller = () => {
    const main = document.querySelector<HTMLElement>(".main");
    return main && main.scrollHeight > main.clientHeight + 1 ? main : document.scrollingElement;
  };
  const onScroll = () => {
    const s = scroller();
    if (s) pinned = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  };
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });

  // ---------- Chat list ----------
  let sheet: SheetHandle | null = null;
  let threads: AskThread[] = [];

  /** The list's filter: Athena, then each assistant, when there's a team. */
  function whoFilter(): HTMLElement | null {
    if (!teamNow.length) return null;
    const chip = (id: string | null, name: string, mark: HTMLElement) => {
      const b = h("button", { class: "chip who-filter__chip", type: "button", "aria-pressed": String(listWho === id) }, mark, name);
      b.addEventListener("click", () => {
        if (listWho === id) return;
        listWho = id;
        void paintList();
      });
      return b;
    };
    return h(
      "div",
      { class: "who-filter", role: "group", "aria-label": "Whose conversations" },
      chip(null, "Athena", whoMark(ATHENA, 20)),
      ...teamNow.map((a) => chip(a.id, a.name, whoMark({ avatar: a.avatar, name: a.name }, 20)))
    );
  }

  async function paintList() {
    // Athena's list also keeps the conversations of assistants no longer on the team, so they stay reachable.
    const onTeam = listWho === null ? await loadTeam() : [];
    threads = listWho === null && teamLoaded() ? (await listThreads("all")).filter((t) => !t.assistant_id || !onTeam.some((a) => a.id === t.assistant_id)) : await listThreads(listWho);
    if (destroyed) return;
    const listOpts = {
      threads,
      currentId: chat?.saved ? chat.id : null,
      open: (id: string) => void openChat(id),
      rename: (id: string, title: string) => void rename(id, title),
      remove: (id: string) => void remove(id),
      search: listSearch,
      pinned: pinnedAnswers(threads),
      openPin: (p: PinnedAnswer) => void openPin(p),
      unpin: (p: PinnedAnswer) => void unpin(p),
    };
    railSearch.hidden = threads.length < 2 && !listSearch;
    railList.replaceChildren(...[whoFilter(), chatList(listOpts)].filter((x): x is HTMLElement => !!x));
    sheetRepaint?.();
    paintHead();
  }

  /** On a phone (and narrower windows): the list in a sheet, with New at the top. Picking a chat closes it. */
  let sheetRepaint: (() => void) | null = null;
  function openList() {
    if (sheet) return;
    const sheetList = () =>
      chatList({
        threads,
        currentId: chat?.saved ? chat.id : null,
        open: (id) => {
          sheet?.close();
          void openChat(id);
        },
        rename: (id, title) => void rename(id, title),
        remove: (id) => void remove(id),
        search: listSearch,
        pinned: pinnedAnswers(threads),
        openPin: (p) => {
          sheet?.close();
          void openPin(p);
        },
        unpin: (p) => void unpin(p),
      });
    const start = h("button", { class: "btn btn--primary btn--block chats__new", type: "button", hidden: !current().messages.length }, icons.pen(), "New conversation");
    start.addEventListener("click", () => {
      sheet?.close();
      startNew();
    });
    const filterSlot = h("div", { class: "who-filter-slot" }, whoFilter());
    const body = h("div", { class: "chats" }, start, filterSlot, threads.length > 1 ? searchBox() : null, sheetList());
    sheetRepaint = () => {
      // Nothing left to pick from: the sheet has done its job (unless it's a filter showing nobody's chats).
      if (!threads.length && !listSearch && !teamNow.length) return sheet?.close();
      start.hidden = !current().messages.length;
      filterSlot.replaceChildren(...[whoFilter()].filter((x): x is HTMLElement => !!x));
      body.querySelector(".chats__list")?.replaceWith(sheetList());
    };
    sheet = openSheet({
      label: "Conversations",
      title: "Conversations",
      body,
      onClose: () => {
        sheet = null;
        sheetRepaint = null;
        // The search was for this look at the list.
        if (listSearch) {
          listSearch = null;
          (railSearch.querySelector("input") as HTMLInputElement).value = "";
          void paintList();
        }
      },
    });
  }

  /** A pinned answer: its conversation, at that reply. */
  async function openPin(p: PinnedAnswer) {
    await openChat(p.threadId);
    const m = chat?.id === p.threadId ? chat.messages[p.index] : undefined;
    const node = m ? nodes.get(m) : undefined;
    if (!node) return;
    pinned = false;
    requestAnimationFrame(() => node.scrollIntoView({ block: "center", behavior: scrollBehavior() }));
    node.classList.remove("is-found");
    void node.offsetWidth;
    node.classList.add("is-found");
  }

  /** Unpin from the list: in the conversation on screen, or in the store. */
  async function unpin(p: PinnedAnswer) {
    const m = chat?.id === p.threadId ? chat.messages[p.index] : undefined;
    if (chat && m && (m.role === "answer" || m.role === "assistant")) return togglePin(m, chat);
    const t = await getThread(p.threadId);
    const s = t?.messages[p.index];
    if (!t || !s || (s.role !== "answer" && s.role !== "assistant")) return;
    delete s.pinned_at;
    await saveThread({ ...t, updated_at: new Date().toISOString() });
    void paintList();
    showToast("Unpinned", { icon: "restore" });
  }

  async function openChat(id: string) {
    if (chat?.id === id) return;
    const t = await getThread(id);
    if (!t || destroyed) return;
    show(toChat(t));
    input.focus({ preventScroll: true });
  }

  function startNew() {
    waitingForLast = false;
    if (!current().messages.length) {
      input.focus();
      return;
    }
    show(newChat(), { remember: false });
    void setLastOpened(null);
    input.focus();
  }

  async function rename(id: string, title: string) {
    const t = await renameThread(id, title);
    if (t && chat?.id === id) {
      chat.title = t.title;
      chat.updated_at = t.updated_at;
      paintHead();
    }
  }

  /** Archive a conversation: out of the list everywhere, waiting on the Archived page. Undo brings it straight back. */
  async function remove(id: string) {
    // The sheet would cover the Undo toast.
    sheet?.close();
    const wasOpen = chat?.id === id;
    if (!(await setThreadArchived(id, true))) return;
    if (wasOpen) {
      const next = (await listThreads())[0];
      if (next && !isStale(next.updated_at)) show(toChat(next));
      else {
        show(newChat(), { remember: false });
        void setLastOpened(null);
      }
    }
    showToast("Conversation archived", {
      icon: "archive",
      action: {
        label: "Undo",
        run: () =>
          void setThreadArchived(id, false).then((t) => {
            if (t && wasOpen && !destroyed && !chat?.messages.length) show(toChat(t));
          }),
      },
    });
  }

  chatsBtn.addEventListener("click", openList);
  newBtn.addEventListener("click", startNew);
  railNew.addEventListener("click", startNew);

  // ---------- A reply being written: its words, and Stop ----------

  function begin(c: Chat, m: Message): AbortController {
    const stop = new AbortController();
    live = { c, m, stop };
    paintEmpty();
    paintTail();
    return stop;
  }

  function end(stop: AbortController) {
    if (live?.stop === stop) live = null;
    paintEmpty();
    paintTail();
    // A reconnect that came while this was being written: its turn now.
    if (!live) queueMicrotask(() => void writeOfflineOnes());
  }

  stopBtn.addEventListener("click", () => {
    if (!live) return;
    (live.m as ReplyState).stopped = true;
    live.stop.abort();
    input.focus({ preventScroll: true });
  });

  /** More of a reply's words (lib/ask-stream.ts): into its draft, at the end of the chat if that's where you are. */
  function onText(m: AssistantMessage | WrittenMessage, e: TextEvent) {
    m.draft = applyText(m.draft ?? "", e);
    draftViews.get(m)?.(m.draft);
    if (chat && nodes.get(m)?.isConnected && pinned) follow(m);
  }

  /** Words only while Talk is off: Talk speaks the finished reply as it always has. */
  const liveText = (m: AssistantMessage | WrittenMessage) => (talk ? undefined : (e: TextEvent) => onText(m, e));

  // ---------- Written again, versions, pins ----------
  /** Write a reply again where it is. The new one shows; the old one stays a tap away ("1 of 2"). */
  async function regenerate(m: AssistantMessage | WrittenMessage, c: Chat) {
    if (live || c.locked) return;
    // Its changes still stand: running it again may make them again, so say so first.
    const standing = (m.reply?.changes ?? []).filter((x) => !m.undone.has(changeKey(x)));
    if (
      standing.length &&
      !(await confirmDialog({
        title: "Write this reply again?",
        body: `It ${standing.length === 1 ? "made a change that's" : `made ${standing.length} changes that are`} still in place. Writing it again may make ${standing.length === 1 ? "it" : "them"} a second time.${standing.every((x) => x.undo) ? ` To avoid that, undo ${standing.length === 1 ? "it" : "them"} first.` : ""}`,
        confirmLabel: "Try again",
      }))
    )
      return;
    const i = c.messages.indexOf(m);
    const before = c.messages.slice(0, i);
    const j = lastMine(before);
    const mine = before[j];
    if (i < 0 || !mine || mine.role !== "me") return;
    const prior: Chat = { ...c, messages: before.slice(0, j) };
    const join = (next: WrittenMessage) => {
      const slot = addVersion(m.slot, m, next);
      for (const v of slot.all) (v as ReplyState).slot = slot;
      if (m.pinned_at) next.pinned_at = m.pinned_at;
      delete m.pinned_at;
    };
    // An older instruction reply is written again the same way as any other: by Ask's one assistant.
    const sent = mine.files ?? [];
    await writtenAnswer(c, m.role === "answer" ? m.question : mine.text, answerHistory(prior.messages), sent, recentFiles(prior, sent), { replace: m, join });
    if (chat === c) paintTail();
  }

  /** Show another version of a reply. */
  function showVersion(m: AssistantMessage | WrittenMessage, c: Chat, index: number) {
    const slot = m.slot;
    if (!slot || live?.m === m) return;
    slot.index = pickVersion(slot, index).index;
    const v = slot.all[slot.index] as AssistantMessage | WrittenMessage;
    if (v === m) return;
    if (m.pinned_at) v.pinned_at = m.pinned_at;
    delete m.pinned_at;
    place(c, m, v);
    // A reopened version loads what it cited, as the one on screen did.
    void hydrate({ ...c, messages: [v] });
    keep(c);
    paintTail();
  }

  function togglePin(m: AssistantMessage | WrittenMessage, c: Chat) {
    const on = !m.pinned_at;
    setPinned(m, on);
    rebuild(m);
    keep(c);
    void paintList();
    showToast(on ? "Pinned to the top of Conversations" : "Unpinned", { icon: on ? "check" : "restore" });
  }

  // ---------- Edit your last message; what the next one is about ----------

  function paintComposerTop() {
    const parts: HTMLElement[] = [];
    if (about) {
      const a = about;
      const remove = h("button", { class: "ask-about__remove", type: "button", "aria-label": `Remove ${a.label}` }, icons.close());
      remove.addEventListener("click", () => {
        about = null;
        paintComposerTop();
        input.focus();
      });
      parts.push(h("span", { class: "ask-about", title: `Asking about ${a.label}` }, h("span", { class: "ask-about__icon", "aria-hidden": "true" }, icons[aboutIcon(a)]()), h("span", { class: "ask-about__label" }, a.label), remove));
    }
    if (picked) {
      const p = picked;
      const remove = h("button", { class: "ask-about__remove", type: "button", "aria-label": `Don't use ${p.title}` }, icons.close());
      remove.addEventListener("click", () => {
        picked = null;
        paintComposerTop();
        input.focus();
      });
      parts.push(h("span", { class: "ask-about ask-skill", title: `Using ${p.title}` }, h("span", { class: "ask-about__icon", "aria-hidden": "true" }, icons.book()), h("span", { class: "ask-about__label" }, `Using ${p.title}`), remove));
    }
    if (editing) {
      const cancel = h("button", { class: "link-btn", type: "button" }, "Cancel");
      cancel.addEventListener("click", cancelEdit);
      parts.push(h("span", { class: "composer-top__editing" }, icons.pen(), h("span", {}, "Editing your message"), cancel));
    }
    if (vision) parts.push(visionCard(vision));
    composerTop.replaceChildren(...parts);
    composerTop.hidden = !parts.length;
    paintEmpty();
  }

  // ---------- A photo for a model that can't see it (lib/vision-warning.ts) ----------

  /** The warning on show, and what was typed when it came up. */
  let vision: VisionWarning | null = null;
  /** The owner's choice for the message the warning was about: send it as it is, or with this model. */
  let visionChoice: "anyway" | ModelRef | null = null;

  /** Above the box: what the model can't see, Use Claude Sonnet 5.5 for this message, and Send anyway. */
  function visionCard(w: VisionWarning): HTMLElement {
    const words = visionWords(w);
    const use = h("button", { class: "btn btn--primary btn--sm vision-warn__use", type: "button" }, words.use) as HTMLButtonElement;
    const anyway = h("button", { class: "btn btn--soft btn--sm vision-warn__anyway", type: "button" }, words.anyway) as HTMLButtonElement;
    const close = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost vision-warn__close", type: "button", "aria-label": "Not now" }, icons.close());
    use.addEventListener("click", () => chooseVision(w.instead));
    anyway.addEventListener("click", () => chooseVision("anyway"));
    close.addEventListener("click", () => {
      dropVision();
      input.focus();
    });
    const title = h("p", { class: "vision-warn__title", id: "vision-warn-title" }, words.title);
    return h(
      "div",
      { class: "vision-warn", role: "group", "aria-labelledby": "vision-warn-title", "aria-describedby": "vision-warn-body" },
      h("span", { class: "vision-warn__icon", "aria-hidden": "true" }, icons.image()),
      h("div", { class: "vision-warn__text" }, title, h("p", { class: "vision-warn__body", id: "vision-warn-body" }, words.body)),
      close,
      h("div", { class: "vision-warn__actions" }, use, anyway),
    );
  }

  function dropVision() {
    if (!vision) return;
    vision = null;
    paintComposerTop();
  }

  function chooseVision(choice: "anyway" | ModelRef) {
    visionChoice = choice;
    vision = null;
    paintComposerTop();
    form.requestSubmit();
  }

  /** Would this message's photos go to a model that can't see them? Quick: a slow or missing model list never holds a message up. */
  async function checkVision(c: Chat, sending: AskFile[]): Promise<VisionWarning | null> {
    if (!sending.some((f) => f.type.startsWith("image/") || f.type === "application/pdf")) return null;
    const m = await Promise.race([loadModels().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    if (!m) return null;
    return visionWarning(thinkingModel(m.effective, c.assistant_id), m.catalogue, sending);
  }

  function startEdit() {
    const c = current();
    const mine = c.messages[lastMine(c.messages)];
    if (!mine || mine.role !== "me" || mine.run_line || c.locked) return;
    editing = { c, files: mine.files ?? [] };
    input.value = mine.text;
    paintEmpty();
    paintComposerTop();
    paintTail();
    input.focus();
  }

  function cancelEdit() {
    if (!editing) return;
    editing = null;
    input.value = "";
    paintEmpty();
    paintComposerTop();
    paintTail();
    input.focus();
  }

  /** openAsk() (lib/open-ask.ts): about something starts a fresh conversation; words go in the box; send asks them. */
  function applyAsk(o: OpenAskOptions) {
    // Opened to talk to someone (Home's chips, an assistant's page): a conversation with them.
    if (o.assistantId !== undefined && (current().assistant_id ?? null) !== (o.assistantId || null)) talkTo(o.assistantId || null);
    if (o.context && current().messages.length && !talk) startNew();
    if (o.context) about = o.context;
    paintComposerTop();
    if (o.prompt !== undefined) input.value = o.prompt;
    paintEmpty();
    if (o.send && input.text.trim()) void ask(input.value);
    // Ask may not be on the page yet when it's opened this way.
    else requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }

  /**
   * Sample mode: one of the stand-in's made-up replies that change, plan or prepare something (a time to pick, a
   * plan, a routine, a card that waits for a tap, a draft), with its steps played out as a real one's would be.
   * Each belongs to the sample that makes it; null when none of them is for this message. Nothing here judges
   * whether a message is a question or a request.
   */
  async function sampleRequestReply(q: string, step: (x: AskStep) => void, history: ReturnType<typeof answerHistory> = []): Promise<AskReply | null> {
    const none = { sources: [], related: [], searched: "", skipped: [], found: true, flagged: false };
    const plain = replaceAthenaLinks(q, () => "");
    // A follow-up acts on the reply before it: "Turn this into a recipe" keeps the recipe that reply gave, from its own text.
    if (asksToKeepRecipe(plain)) {
      const before = history.at(-1);
      const asked = history.at(-2);
      const found = before?.role === "assistant" ? recipeFromReply(before.text, asked?.role === "user" ? asked.text : "") : null;
      if (found) {
        await playSampleSteps([["Saving a recipe", `Saved ${found.title} to Recipes`]], step);
        const { sampleCreate } = await import("../db/sample-recipes");
        const kept = sampleCreate({ title: found.title, ingredients: found.ingredients, steps: found.steps, servings: 16, total_minutes: found.minutes });
        const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
        const detail = [count(found.ingredients.length, "ingredient"), found.minutes ? `${found.minutes} min` : ""].filter(Boolean).join(" · ");
        return {
          ...none,
          text: `Saved **${found.title}** to your recipes.`,
          changes: [{ kind: "recipe", id: kept.id, action: "created", title: found.title, detail, label: `${found.title}: ${detail}`, open: { kind: "recipe", id: kept.id }, undo: { op: "sample" } }],
        };
      }
    }
    // An assignment (docs/team.md "Assignments"): the lineup comes back as a card for Go, as start_assignment's does.
    if (/\bassignment\b/i.test(plain)) {
      await playSampleSteps([["Picking a lineup", "Picked a lineup"]], step);
      const { lineup, fallback } = await draftLineup(plain.replace(/^.*?\bassignment\b[\s:,.-]*(?:to|for|on)?\s*/i, "") || plain);
      return { ...none, text: "Here's who I'd put on it, in order. Change anything you like. Nothing runs until you tap Go.", lineup: { lineup, fallback } };
    }
    // "Whenever…", "every time…": a flow, drawn and kept off, as propose_flow's is (components/ask-flow-card.ts).
    if (FLOW_WORDS.test(plain)) {
      await playSampleSteps([["Drawing a flow", "Drew a flow"]], step);
      const made = sampleFlowReply(plain);
      return { ...none, text: made.text, flow: made.card, ...(made.changes ? { changes: made.changes } : {}) };
    }
    const scheduling = sampleScheduling(q);
    if (scheduling) {
      // Finding a time works in sample mode: a made-up week, Priya's calendar seen and Marcus's not.
      const [text, card] = scheduling;
      await playSampleSteps(
        card.kind === "slots"
          ? [["Checking your calendars", "Checked your calendars"], ["Checking Priya's and Marcus's calendars", "Checked Priya's calendar"]]
          : card.kind === "create"
            ? [["Finding who to invite", card.create.attendees.length ? `Found ${card.create.attendees.map((a) => a.name).join(", ")}` : "No email found"], ["Checking your calendars", "Checked your calendars"]]
            : [["Finding the design review", "Found the design review"]],
        step
      );
      return { ...none, text, scheduling: card };
    }
    if (SAMPLE_PLAN_REQUEST.test(q) || SAMPLE_ROUTINE_REQUEST.test(q)) {
      // A plan (two or more changes) or a routine, as a real request gets them.
      const routine = SAMPLE_ROUTINE_REQUEST.test(q);
      await playSampleSteps(routine ? [["Setting up a routine", "Set up a routine"]] : [["Finding the 3pm", "Found the design review"], ["Looking for Marcus", "Found Marcus Webb"], ["Planning the changes", "Planned 3 changes"]], step);
      return routine
        ? { ...none, text: "Done. Every Friday at 16:00 I'll look at what slipped and send it to your phone. You can pause or change it in Settings → Ask.", changes: [sampleRoutineChange()] }
        : { ...none, text: "Here's the plan: three changes, and nothing happens until you tap Go.", plan: samplePlan() };
    }
    // What would leave Athena waits as a card for a tap, as a real request does (security review M7); a drafting request gets a sample draft to open.
    const waiting = (await sampleLog(plain)) ?? sampleConfirm(plain);
    const drafted = waiting ? null : sampleDraftChange(plain, samplePeople());
    if (!waiting && !drafted) return null;
    await playSampleSteps(sampleInstructionSteps(plain), step);
    const mail = drafted?.change.open?.kind === "draft" && drafted.change.open.draft.channel === "email" ? drafted.change.open.draft : null;
    if (waiting) return { ...none, text: waiting[0], confirm: [waiting[1]] };
    if (mail) return { ...none, text: drafted!.text, confirm: [{ kind: "draft", draft: mail, title: drafted!.change.title, to: mail.to[0]?.name ?? "", drafts_in: "Gmail" }] };
    return { ...none, text: drafted!.text, changes: [drafted!.change] };
  }

  /** Your message remembers the run answering it (or forgets it), so the app reopened part-way can pick the run up. */
  function noteRun(c: Chat, m: Message, run: MeMessage["run"] | null) {
    const mine = c.messages[c.messages.indexOf(m) - 1];
    if (mine?.role !== "me" || (!run && !mine.run)) return;
    mine.run = run ?? undefined;
    keep(c);
  }

  /** Take a reply that came to nothing out of the chat. */
  function discard(c: Chat, m: Message) {
    const i = c.messages.indexOf(m);
    if (i >= 0) c.messages.splice(i, 1);
    nodes.get(m)?.remove();
    nodes.delete(m);
  }

  /**
   * The chat ends on your words, sent as a run: the app closed (or this is
   * another device) before the reply landed. The run carried on without it,
   * so follow it by its id. If the server doesn't know it, it's "This didn't
   * finish" as before.
   */
  async function pickUp(c: Chat, mine: MeMessage) {
    const run = mine.run!;
    const before = c.messages.slice(0, -1);
    answering.add(mine);
    try {
      await writtenAnswer(c, mine.text, answerHistory(before), mine.files ?? [], [], null, run.id);
      return;
    } catch {
      // Not there to follow: the note below.
    } finally {
      answering.delete(mine);
    }
    mine.run = undefined;
    keep(c);
    if (chat === c) markUnfinished(c);
  }

  /** A step arrived: into the message, its working lines and Talk's bar. */
  function onStep(m: AssistantMessage | WrittenMessage, step: AskStep) {
    // The finished line doesn't repeat whether it acts; keep what the running one said.
    const before = m.steps.find((x) => x.id === step.id);
    if (before?.acts) step = { ...step, acts: true };
    addStep(m.steps, step);
    stepViews.get(m)?.(m.steps);
    const now = currentStep(m.steps);
    pillViews.get(m)?.(now);
    talk?.step(currentStep(m.steps));
    if (chat && nodes.get(m)?.isConnected && pinned) follow(m);
  }

  /** Ask one thing (typed, tapped or spoken) in the chat on screen; resolves to Athena's reply once it's there. */
  async function ask(question: string, opts: { picks?: boolean } = {}): Promise<Message | null> {
    let q = question.trim();
    if (!q && !files.count()) return null;
    // Files still uploading (or waiting for a connection): nothing is sent, nothing is cleared.
    if (files.count() && !files.ready()) return null;
    const c = current();
    if (c.locked) return null;
    // A photo or PDF for a thinking model that can't see it: say so first, and send once the owner chooses.
    const chose = visionChoice;
    visionChoice = null;
    if (!chose) {
      const w = await checkVision(c, [...(editing?.c === c ? editing.files : []), ...files.peek()]);
      if (w) {
        vision = w;
        paintComposerTop();
        composerTop.querySelector<HTMLButtonElement>(".vision-warn__use")?.focus({ preventScroll: true });
        return null;
      }
    }
    vision = null;
    const only = chose && chose !== "anyway" ? chose : null;
    // An edited message: it, and everything after it, gives way to the new one (lib/ask-versions.ts).
    let carried: AskFile[] = [];
    if (editing?.c === c) {
      if (live?.c === c) live.stop.abort();
      carried = editing.files;
      editing = null;
      c.messages = beforeEdit(c.messages);
      show(c, { remember: false });
    }
    editing = null;
    // "/meeting-prep my 3pm": the skill, then the request. "/meet" alone picks the best match and waits for the request.
    const slash = q.startsWith("/") ? slashCommand(q) ?? { name: q.slice(1).trim(), rest: "" } : null;
    if (slash && !files.count()) {
      const match = skillMatches(slash.name)[0] ?? null;
      if (match) {
        picked = match;
        q = slash.rest;
        if (!q) {
          input.value = "";
          closeSkillMenu();
          paintComposerTop();
          input.focus();
          return null;
        }
      }
    }
    const skill = picked;
    picked = null;
    closeSkillMenu();
    const sent = [...carried, ...files.take()];
    input.value = "";
    // About something (openAsk): it goes as an @ mention, so Athena gets exactly that item.
    const a = about;
    about = null;
    paintComposerTop();
    if (a) q = `${formatAthenaLink(a.kind, a.id, `@${a.label}`)} ${q}`.trim();
    paintEmpty();
    const last = c.messages[c.messages.length - 1];
    // Athena asked you to pick, and this is your answer (tapped or typed).
    const waiting = (last?.role === "assistant" || last?.role === "answer") && !!last.reply?.choices?.length && !last.answered ? last : null;
    // The conversation so far, before this message joins it: one history, whatever each turn was.
    const asked = answerHistory(c.messages);
    const mine = { role: "me" as const, text: q, at: new Date().toISOString(), ...(sent.length ? { files: sent } : {}), ...(only ? { model: only } : {}) };
    answering.add(mine);
    c.messages.push(mine);
    if (chat === c) paint(true);
    keep(c);
    void paintList();
    askingSkill = skill?.id ?? null;
    try {
      // The evening chip's own action; nothing reads the words of a message to choose it.
      if (opts.picks && !waiting) return await tonight(c);
      return await respond(c, q, waiting, asked, sent);
    } finally {
      askingSkill = null;
      answering.delete(mine);
    }
  }

  /** Your words that are being answered right now (so one isn't mistaken for a question left unanswered). */
  const answering = new WeakSet<Message>();

  /** Something to watch tonight: picks from the owner's own list, ranked against their taste. No model, no search. */
  async function tonight(c: Chat): Promise<Message> {
    const pending: AssistantMessage = { role: "assistant", at: new Date().toISOString(), request: [], reply: null, error: null, undone: new Set(), undoing: new Set(), gone: new Set(), answered: false, steps: [] };
    c.messages.push(pending);
    if (chat === c) paint(true);
    try {
      const { free, picks } = await fetchTonight();
      const lead = !picks.length
        ? "Your watchlist has no films or shows waiting. Add some to Watch & read and I'll pick from them."
        : `${free ? "Your evening's clear. " : "You've got plans this evening, but for later: "}${picks.length === 1 ? "one" : countWord(picks.length).toLowerCase()} from your own list.`;
      pending.reply = { text: lead, changes: [], choices: [], picks };
    } catch {
      pending.error = "I couldn't read your watchlist just now. Try again in a moment.";
    }
    pending.foldLive = true;
    rebuild(pending);
    keep(c);
    if (chat === c) scrollToEnd();
    return pending;
  }

  /**
   * Reply to a message already in the chat. Every message goes the same way: to Ask's one assistant, which reads
   * it and answers, changes things, or both (writtenAnswer). Nothing here reads a message to decide where it goes.
   * (Sample mode has no server: there, writtenAnswer's stand-in for the assistant plays a made-up reply.)
   */
  async function respond(c: Chat, q: string, waiting: AssistantMessage | WrittenMessage | null, asked: ReturnType<typeof answerHistory>, sent: AskFile[] = []): Promise<Message> {
    if (waiting) {
      waiting.answered = true;
      rebuild(waiting);
    }
    return writtenAnswer(c, q, asked, sent, recentFiles(c, sent));
  }

  /**
   * One reply from Ask's one assistant: an answer with sources, the changes
   * the message asked for, or both. It keeps trying before it gives up
   * (lib/ask-retry.ts): busy is asked again twice, with a step saying so, and
   * a dropped connection once. If it still can't be had, the keyword search,
   * saying why, with a button that writes the reply in its place.
   *
   * A reply may change something, so it's never asked twice by accident: a
   * try that lost its connection is sent again under the same run id, which
   * the server follows rather than starts again (lib/ask-run.ts).
   */
  async function writtenAnswer(
    c: Chat,
    q: string,
    history: ReturnType<typeof answerHistory>,
    sent: AskFile[] = [],
    fileIds: string[] = [],
    /** Written again in another reply's place (regenerate), joining its versions. */
    again: { replace: AssistantMessage | WrittenMessage; join: (fresh: WrittenMessage) => void } | null = null,
    /** Only its run's id is left (the app was closed part-way): follow that. If the server doesn't have it, this throws and nothing is left in the chat. */
    resume: string | null = null,
    /** A keyword search shown in its place ("Write the answer", or the connection came back): the reply is written into the same message. */
    into: WrittenMessage | null = null
  ): Promise<Message> {
    const pending: WrittenMessage = into ?? { role: "answer", at: new Date().toISOString(), question: q, reply: null, fallback: null, note: null, sample: isSampleMode(), terms: [], refs: null, saved: null, steps: [], ...noActs(), ...(askingSkill ? { skill: askingSkill } : again?.replace.skill ? { skill: again.replace.skill } : {}) };
    if (into) {
      window.clearTimeout(retryTimers.get(into));
      Object.assign(into, { unreached: undefined, retryAt: undefined, fallback: null, note: null, offline: false, terms: [], refs: null, saved: null, steps: [], draft: undefined, drafted: false, stopped: false, foldLive: false, stepsOpen: false });
      rebuild(into);
    } else if (again) {
      again.join(pending);
      place(c, again.replace, pending);
    } else {
      c.messages.push(pending);
      if (chat === c) paint(true);
    }
    const step = (x: AskStep) => onStep(pending, x);
    const stop = begin(c, pending);
    const text = liveText(pending);
    /** Back to an empty working view: no steps, no words. */
    const clear = () => {
      pending.steps = [];
      stepViews.get(pending)?.(pending.steps);
      pending.draft = "";
      draftViews.get(pending)?.("");
    };
    const online = () => isOnline();
    /** What the try that dropped had done by then (its steps are cleared before the next try starts). */
    let dropped: { made: AssistantChange[]; acting: boolean } | null = null;
    /** One try at the reply. `last`: the failure this try follows. */
    const once = async (tryNo: number, last: unknown): Promise<AskReply> => {
      if (pending.sample) {
        const fault = takeSampleFault();
        if (fault === "busy") throw new ApiError("Too many requests", 429);
        if (fault === "offline") throw new TypeError("Failed to fetch");
        if (fault === "down") throw new ApiError("Athena's AI couldn't be reached", 500);
        if (sent.length) {
          // Sample mode keeps files on this device and shows them, but can't read them.
          await playSampleSteps(sent.map((f) => [`Reading ${f.name}`, `Read ${f.name}`] as [string, string]), step);
          const one = sent.length === 1;
          const names = one ? sent[0].name : sent.length === 2 ? "both files" : "these files";
          // Which model this would have gone to: the one picked for this message, else the chat's (the photo warning shows both).
          const think = onlyModel(c).model ?? thinkingModel((await loadModels().catch(() => null))?.effective, c.assistant_id);
          return { text: `In sample mode I can keep and show ${names}, but not read ${one ? "it" : "them"}. Connect Athena and I'll read ${one ? "it" : "them"} for you.`, sources: [], related: [], searched: "Kept on this device", skipped: [], found: false, flagged: false, ...(think ? { model: think } : {}) } as AskReply;
        }
        // Asking Athena about the Lego Ferrari: she checks with Moss, who watches gift prices (docs/team.md, "Checked with Moss").
        if (!c.assistant_id && /\b(lego|ferrari)\b/i.test(q)) {
          await playSampleSteps([["Checking with Moss", "Checked with Moss"]], step);
          const said = "The Lego Ferrari is £34 at Smyths, £8 under the price when you saved it. You bought from them last Christmas.";
          const checked = { text: "It's down to £34 at Smyths, £8 less than when you saved it [1].", sources: [{ n: 1, kind: "assistant", id: SAMPLE_MUSE_ID, url: null, title: "Moss", date: null, account: null } as unknown as AnswerSource], related: [], searched: "Checked with Moss", skipped: [], found: true, flagged: false, checked: [{ assistant_id: SAMPLE_MUSE_ID, name: "Moss", question: q, answer: said }] };
          if (text) await playSampleText(checked.text, text, stop.signal);
          return checked;
        }
        // Talking to Moss about the Lego Ferrari: she answers from her own job, not Athena's sample answer.
        if (c.assistant_id === SAMPLE_MUSE_ID && /\b(lego|ferrari|price|gift)/i.test(q)) {
          await playSampleSteps([["Looking at your gift ideas", "Looked at your gift ideas"], ["Checking prices", "Checked prices"]], step);
          // Moss thinks with Gemini 3.5 Flash in sample mode: her replies say so (components/ask-picture.ts modelLine).
          const own = { text: "The Lego Ferrari is £34 at Smyths, £8 under the price when you saved it. You bought from them last Christmas, so I'd get it there.", sources: [], related: [], searched: "Checked prices", skipped: [], found: true, flagged: false, model: { provider: "gemini" as const, model: "gemini-3.5-flash" } };
          if (text) await playSampleText(own.text, text, stop.signal);
          return own;
        }
        // A picture, made on the device (components/ask-picture.ts): or, with pictures staged off, where to turn them on.
        const pictured = await samplePicture(q, c, step, text, stop.signal);
        if (pictured) return pictured;
        const plain = mentionsToText(q);
        // The stand-in for the assistant has a few made-up replies. With none for this message, it's the keyword search over the sample notes, saying so.
        // A made-up reply that changes, plans or prepares something comes first (a time to pick names Priya, and so does a canned answer).
        const made = await sampleRequestReply(q, step, history);
        if (made) return made;
        if (!hasSampleAnswer(q)) throw new SampleHasNone();
        // A question and a request in one message ("What did Elena say about pricing, and add a to-do to follow up"): one reply with both.
        const mixed = hasSampleAnswer(q) ? sampleFollowUp(plain) : null;
        const [answer] = await Promise.all([sampleAnswer(q), playSampleSteps([...(sampleAnswerSteps(q) ?? SAMPLE_ANSWER_STEPS), ...(mixed ? [mixed.step] : [])], step)]);
        const reply: AskReply = mixed ? { ...answer, text: `${answer.text}\n\n${mixed.text}`, changes: [mixed.change], next: mixed.next } : answer;
        // Its words as they'd be written, and the follow-ups that come with them.
        if (text) await playSampleText(reply.text, text, stop.signal);
        return { ...reply, next: reply.next ?? sampleNext(q), ...(/\bpric|\belena\b/i.test(q) ? { skills: [sampleUsedSkill()] } : {}), ...(takeSampleFellBack() ?? {}) };
      }
      // No connection: nothing to try. The catch below shows the keyword search and says so.
      if (!navigator.onLine) throw new TypeError("Failed to fetch");
      // This message's own files are read whole; earlier ones go as their summaries.
      const own = sent.map((f) => f.id);
      const earlier = fileIds.filter((id) => !own.includes(id));
      // The last try lost its connection: how it ended isn't known, and it may have changed something.
      const lost = tryNo > 0 && lostTouch(last) && !!pending.run;
      if (lost && !serverKeepsRuns()) {
        // No kept run: the request ended with its connection. If a change had started it isn't asked again; otherwise it's asked the plain way.
        if (dropped?.made.length || dropped?.acting) return droppedAnswer(dropped.made);
        return askAthena(q, history, undefined, own, earlier, { signal: stop.signal, skill: pending.skill, threadId: c.id, assistantId: c.assistant_id ?? undefined, ...onlyModel(c) });
      }
      // A try that was answered (busy, say) is finished with: the next is a run of its own. One that lost its
      // connection, now or before this message fell back to a keyword search, is sent again under the same id.
      pending.run = tryNo === 0 && resume ? resume : lost ? pending.run! : (tryNo === 0 && pending.lostRun) || crypto.randomUUID();
      if (!again && !into) noteRun(c, pending, { id: pending.run, kind: "answer" });
      const follow = { onText: text, signal: stop.signal, skill: pending.skill, threadId: c.id, assistantId: c.assistant_id ?? undefined, run: pending.run, ...onlyModel(c) };
      return resume ? resumeRun(resume, step, follow) : askAthena(q, history, step, own, earlier, follow);
    };
    try {
      // A run picked up by its id is followed, never asked again: if the server doesn't have it, there's nothing to retry.
      pending.reply = resume
        ? await once(0, null)
        : await withRetry(once, {
            signal: stop.signal,
            online,
            onWait: (w) => {
              if (w.kind === "dropped") dropped = { made: pending.steps.flatMap((x) => x.changes ?? []), acting: pending.steps.some((x) => x.acts) };
              clear();
              step({ id: BUSY_STEP_ID, text: busyStepText(w), done: false });
            },
            onRetry: clear,
          });
      pending.lostRun = undefined;
      keepSummaries(c, pending.reply.file_summaries);
      if (!pending.drafted) pending.foldLive = true;
    } catch (error) {
      if (stop.signal.aborted && pending.stopped) {
        // Stopped: what was written so far stays, without its sources, with anything it had changed by then.
        pending.reply = stoppedAnswer(pending.draft ?? "", pending.steps);
        return finishAnswer(c, pending, stop);
      }
      // The connection went, not the run: the server may still be on it. Writing this again follows it under the same id.
      pending.lostRun = pending.run && serverKeepsRuns() && lostTouch(error) ? pending.run : undefined;
      if (resume) {
        end(stop);
        discard(c, pending);
        throw error;
      }
      const connected = online();
      pending.steps = [];
      // A follow-up means something only with the turns before it: its words are never keyword-searched (owner, 12 Nov 2026).
      // The message is kept, the reply says plainly that it couldn't be had, and it's asked again by itself, once.
      const failed = error instanceof SampleHasNone ? null : afterFailure(error, { online: connected, earlierTurns: history.length, alreadyTried: !!pending.autoTried });
      if (failed?.show === "unreached") {
        pending.unreached = failed.cause;
        pending.note = null;
        pending.offline = failed.cause === "offline";
        pending.fallback = { terms: [], notes: [], others: [], state: connected ? "online" : "offline" };
        pending.terms = [];
        pending.refs = { notes: [], others: [] };
        if (failed.retryInMs !== null) {
          pending.retryAt = Date.now() + failed.retryInMs;
          retryTimers.set(
            pending,
            window.setTimeout(() => {
              pending.retryAt = undefined;
              // Still waiting, still on screen, and nothing else being written: ask again. Otherwise it's Try again's to do.
              if (destroyed || chat !== c || live || !isFallback(pending) || !pending.unreached) return void (nodes.get(pending)?.isConnected && rebuild(pending));
              void writeAnswer(pending, c);
            }, failed.retryInMs)
          );
        }
        pending.autoTried = true;
        return finishAnswer(c, pending, stop);
      }
      pending.note = error instanceof SampleHasNone ? SAMPLE_NONE_NOTE : answerFallbackNote(error, connected);
      // For want of a connection: written by itself, once, when one returns and this chat is open.
      pending.offline = !connected;
      // Offline there was nothing to wait for: a beat, so the search doesn't flash in.
      const [fallback] = await Promise.all([askNotes(mentionsToText(q)), connected ? null : new Promise((r) => setTimeout(r, 450))]);
      pending.fallback = fallback;
      pending.terms = fallback.terms;
      pending.refs = { notes: fallback.notes.map((n) => n.id), others: fallback.others.map((o) => ({ kind: o.kind, id: o.id })) };
    }
    return finishAnswer(c, pending, stop);
  }

  function finishAnswer(c: Chat, pending: WrittenMessage, stop: AbortController): WrittenMessage {
    pending.at = new Date().toISOString();
    pending.draft = undefined;
    pending.run = undefined;
    // A run that may still be going stays on your message, so the app reopened follows it rather than asking again.
    if (!pending.lostRun) noteRun(c, pending, null);
    const made = pending.reply?.changes ?? [];
    if (made.length) changedElsewhere();
    // A file Athena put on a note: that note loads its Files fresh.
    for (const ch of made) if (/^Attached /.test(ch.detail) && ch.kind === "note") noteFilesChanged(ch.id);
    end(stop);
    talk?.step(null);
    rebuild(pending);
    keep(c);
    if (chat === c) settle(pending);
    if (pending.reply && !pending.stopped) void saveFound(c, pending);
    return pending;
  }

  /**
   * What the answer rests on from an account that Athena didn't have (an old
   * booking email), saved straight away, with no tap (ask-import.ts). Offline,
   * or with nothing new cited, nothing is sent. It shows under the answer.
   */
  async function saveFound(c: Chat, m: WrittenMessage) {
    const imports = (m.reply as (AnswerReply & { imports?: unknown[] }) | null)?.imports;
    const sample = m.sample ? sampleFound(m.question) : null;
    if (!sample && (!imports?.length || !navigator.onLine)) return;
    const saving: NonNullable<AnswerMessage["saving"]> = { status: "saving", receipt: null, undone: new Set(), undoing: new Set() };
    m.saving = saving;
    rebuild(m);
    try {
      if (sample) await new Promise((r) => setTimeout(r, 1600));
      // The server gives an import three minutes (ask-import.ts).
      const receipt = sample ?? (await apiRequest<FoundReceipt>("/assistant/import", { method: "POST", body: JSON.stringify({ imports }), signal: AbortSignal.timeout(200_000) }));
      saving.receipt = receipt;
      saving.status = "done";
      saving.onChange = () => keep(c);
      if (!sample && receipt.saved.length) changedElsewhere();
    } catch {
      saving.status = "failed";
    }
    rebuild(m);
    if (saving.status === "done") keep(c);
    if (chat === c) scrollToEnd();
  }

  // A screenshot pasted, or files dropped on Ask, join the message.
  input.el.addEventListener("paste", (e) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (!pasted.length) return;
    e.preventDefault();
    void files.add(pasted);
  });
  let drags = 0;
  const hasFilesIn = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  el.addEventListener("dragenter", (e) => {
    if (!hasFilesIn(e)) return;
    e.preventDefault();
    drags++;
    el.classList.add("is-dropping");
  });
  el.addEventListener("dragover", (e) => hasFilesIn(e) && e.preventDefault());
  el.addEventListener("dragleave", () => {
    if (--drags <= 0) {
      drags = 0;
      el.classList.remove("is-dropping");
    }
  });
  el.addEventListener("drop", (e) => {
    if (!hasFilesIn(e)) return;
    e.preventDefault();
    drags = 0;
    el.classList.remove("is-dropping");
    void files.add(e.dataTransfer?.files ?? []);
  });
  // Ask opened: the server wakes and gets ready for the first question (routes/assistant.ts).
  if (!isSampleMode() && navigator.onLine) void warmAsk();
  // What was typed and not yet sent comes back (another tab, a reload).
  input.value = loadDraft();
  paintEmpty();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void ask(input.value);
  });

  // ---------- "/" picks a skill ----------
  let skillList: AppSkill[] = [];
  const loadSkillList = () => void pickableSkills().then((list) => (skillList = list), () => undefined);
  loadSkillList();
  const unsubSkills = onSkillsChange(loadSkillList);
  let skillRows: AppSkill[] = [];
  /** On skills first, then off ones, each best match first. */
  const skillMatches = (typed: string) => [...matchSkills(skillList.filter((s) => s.enabled), typed), ...matchSkills(skillList.filter((s) => !s.enabled), typed)];
  const skillMenu = mentionMenu({ emptyText: "No skills match", label: "Skills", onPick: (i) => pickSkill(skillRows[i]) });
  let skillMenuOpen = false;
  function closeSkillMenu() {
    if (!skillMenuOpen) return;
    skillMenuOpen = false;
    skillMenu.remove();
  }
  function pickSkill(s: AppSkill | undefined) {
    if (!s) return;
    picked = s;
    input.value = "";
    closeSkillMenu();
    paintComposerTop();
    input.focus();
  }
  function paintSkillMenu() {
    const t = input.text;
    const typing = /^\/[a-z0-9-]*$/i.test(t.trim()) && !t.includes(" ");
    if (!typing) return closeSkillMenu();
    skillRows = skillMatches(t.trim().toLowerCase());
    // Off ones are listed after the on ones, quietly marked: picking one uses it for this message only.
    const rows = skillRows.map((s) => ({ title: s.title, sub: s.enabled ? s.description : `Off · ${s.description}`, icon: "book" as IconName }));
    skillMenu.set(rows, t.trim());
    if (!skillList.length) skillMenu.set([], "");
    if (!skillMenuOpen) {
      document.body.append(skillMenu.el);
      skillMenuOpen = true;
    }
    skillMenu.place({ above: form.getBoundingClientRect(), sheet: window.matchMedia("(max-width: 719px)").matches });
  }
  input.el.addEventListener("input", paintSkillMenu);
  input.el.addEventListener(
    "keydown",
    (e) => {
      if (!skillMenuOpen) return;
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        stop();
        skillMenu.move(e.key === "ArrowDown" ? 1 : -1);
      } else if ((e.key === "Enter" || e.key === "Tab") && skillRows.length) {
        stop();
        pickSkill(skillRows[skillMenu.active]);
      } else if (e.key === "Escape") {
        stop();
        closeSkillMenu();
      }
    },
    true
  );

  /** "Make this a skill": Ask drafts one from this conversation and the editor opens on it. Nothing is saved until the owner taps Save there. */
  async function makeSkill() {
    const c = current();
    const turns = c.messages.flatMap((m): Array<{ role: "user" | "assistant"; text: string }> =>
      m.role === "me" ? [{ role: "user", text: mentionsToText(m.text) }] : m.role === "answer" && m.reply ? [{ role: "assistant", text: m.reply.text }] : m.role === "assistant" && m.reply ? [{ role: "assistant", text: m.reply.text }] : []
    );
    if (!turns.some((t) => t.role === "user")) return showToast("Ask something first, then make it a skill.", { icon: "sparkle" });
    showToast("Drafting a skill from this conversation…", { icon: "sparkle" });
    try {
      const d = await draftFromChat(turns);
      holdSkillDraft({ ...d, from: "chat", source: { kind: "chat" } });
      location.hash = "#/settings/skills/new";
    } catch (error) {
      showToast(error instanceof Error && error.message && !/fetch|network/i.test(error.message) ? error.message : "Couldn't draft a skill just now. Check you're online.", { icon: "wifiOff" });
    }
  }

  // ---------- Open on a new conversation ----------
  // Ask opens ready for a new question (owner, 11 Nov 2026); the last conversation waits in the list. Two things keep the one
  // you were in: a reply that's still being written, and coming straight back (you tapped a source and returned).
  /** Opened with no chat to go back to (a new device): the first sync may bring one, so open it then. */
  let waitingForLast = false;
  const asked = takeOpenRequest();
  // Opened with openAsk() (lib/open-ask.ts): about something, it's a fresh conversation.
  const opening = takeAskRequest();
  // A reply still being written when you left carries on (the server keeps the run): its conversation stays up to receive it.
  const lastHere = chat?.messages[chat.messages.length - 1] as { run?: string; reply?: unknown } | undefined;
  const answeringNow = !!lastHere?.run && !lastHere.reply;
  const justLeft = !!awaySince && Date.now() - Date.parse(awaySince) < BACK_SOON_MS;
  if (chat && chat.messages.length && !answeringNow && !justLeft) {
    chat = newChat();
    void setLastOpened(null);
  }
  awaySince = null;
  // Opened on a nudge (lib/ask-nudge.ts): like openAsk() about something, with the nudge's card above a fresh chat.
  const nudge = takeNudgeCard();
  if (opening?.context || nudge) {
    if (chat?.messages.length || nudge) chat = newChat();
    show(current(), { remember: false });
    if (nudge) threadEl.prepend(askSeedCard({ context: nudge.context, nudge }));
  } else if (asked && (chat?.id !== asked || !answeringNow)) {
    // Opened from the search bar, or from Archived (a picture restored): that conversation, as it's kept now.
    intro.hidden = true;
    void getThread(asked).then((t) => {
      if (destroyed) return;
      show(t ? toChat(t) : current());
    });
  } else show(current(), { remember: false });
  void syncAskThreads();
  if (opening) applyAsk(opening);
  const offAsk = onAskRequest((o) => {
    // A nudge while Ask is on screen: a fresh chat with its card, then the request as usual.
    const n = takeNudgeCard();
    if (n) {
      show(newChat(), { remember: false });
      threadEl.prepend(askSeedCard({ context: n.context, nudge: n }));
    }
    applyAsk(o);
  });

  // ---------- Keys (lib/ask-keys.ts): Esc goes back, ↑ edits your last message ----------
  const onKey = (e: KeyboardEvent) => {
    // Talk and the mic use Esc themselves.
    if (talk || el.classList.contains("is-listening")) return;
    const active = document.activeElement;
    const inComposer = !!active && input.el.contains(active);
    let menuOpen = input.suggesting;
    try {
      menuOpen ||= !!document.querySelector(".menu:popover-open");
    } catch {
      // no :popover-open here
    }
    const typing = !!active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active as HTMLElement).isContentEditable);
    const action = askKeyAction(e, {
      onAsk: el.isConnected,
      dialogOpen: !!document.querySelector("dialog[open]"),
      inEditor: typing && !inComposer,
      inComposer,
      composerEmpty: !input.text.trim() && !files.count(),
      menuOpen,
      editing: !!editing,
      canEdit: !current().locked && canEditLast(current().messages),
    });
    if (!action || action === "open") return;
    e.preventDefault();
    if (action === "close") leaveAsk();
    else if (action === "cancel-edit") cancelEdit();
    else startEdit();
  };
  window.addEventListener("keydown", onKey);

  /** Chats changed (a sync, or another view): refresh the list; take a newer copy of the open chat if nothing here is waiting. */
  const offThreads = onThreadsChange(() => {
    void paintList();
    const c = chat;
    if (c && !c.saved && !c.messages.length && waitingForLast) {
      void threadToOpen().then((t) => {
        if (t && !destroyed && chat === c && !c.messages.length && waitingForLast) show(toChat(t), { remember: false });
      });
      return;
    }
    if (!c?.saved) return;
    const busy = c.messages.some(
      (m) => (m.role === "assistant" && !m.reply && !m.error) || (m.role === "athena" && !m.refs) || (m.role === "answer" && !m.reply && !m.refs && !m.saved)
    );
    if (busy) return;
    void getThread(c.id).then((t) => {
      if (destroyed || chat !== c) return;
      if (!t) {
        const next = threads[0];
        show(next ? toChat(next) : newChat(), { remember: false });
      } else if (t.updated_at > c.updated_at) show(toChat(t), { remember: false });
    });
  });
  const onWide = () => sheet?.close();
  // Back after 12 hours with the app left open on Ask: a fresh conversation, unless something's been typed.
  const onVisible = () => {
    if (document.visibilityState === "hidden") return void (awaySince = new Date().toISOString());
    const away = awaySince;
    awaySince = null;
    if (away && isStale(away) && current().messages.length && !input.text.trim() && !talk) {
      show(newChat(), { remember: false });
      void setLastOpened(null);
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  wide.addEventListener("change", onWide);

  const onTeam = () =>
    void loadTeam().then((list) => {
      if (destroyed) return;
      teamNow = list;
      void paintList();
      if (who.id) {
        const a = list.find((x) => x.id === who.id);
        if (a) who = whoOf(a);
        paintWho();
      }
    });
  onTeam();
  const offTeam = onTeamChange(onTeam);
  const unsubscribe = onNotes(paintSuggestions);
  if (!notesSnapshot().loaded) paintSuggestions();
  return {
    el,
    destroy() {
      destroyed = true;
      barsWatch.disconnect();
      // Leaving Ask doesn't stop a reply: it lands in its conversation as before.
      offAsk();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("online", onOnline);
      talk?.end();
      unsubscribe();
      offTeam();
      offThreads();
      offActivity();
      wide.removeEventListener("change", onWide);
      document.removeEventListener("visibilitychange", onVisible);
      awaySince = new Date().toISOString();
      window.removeEventListener("scroll", onScroll, { capture: true });
      sheet?.close();
      voice?.destroy();
      files.destroy();
      input.destroy();
      unsubSkills();
      closeSkillMenu();
    },
  };
}
