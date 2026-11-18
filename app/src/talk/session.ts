/**
 * Talk: a spoken back-and-forth in Ask. The owner speaks; ElevenLabs
 * transcribes it as they go; the words run through Ask exactly as if typed
 * (search for a question, the assistant for an instruction, receipts and
 * choices on screen); Athena says the reply in the owner's chosen voice; then
 * it listens again, until they end it.
 *
 * One state at a time, shown by the orb in the talk bar that takes the
 * composer's place:
 *   listening → thinking → speaking → listening …
 * plus "paused" (nothing said for a while, so the microphone is released)
 * and "problem" (something to fix, said plainly, with a way to fix it).
 *
 * The microphone is open only while listening: it's released before Athena
 * thinks or speaks, so it never hears itself and the iPhone's orange dot
 * goes out between turns. Tapping the orb while Athena speaks stops it and
 * listens (barge-in); tapping it while listening means "I'm done". Leaving
 * the app or the page ends Talk at once.
 *
 * Sample mode has no server: the same bar runs a canned exchange, with a
 * simulated voice level and no sound, so every state can be seen.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { setAudioSession } from "../lib/audio";
import { MicError, type MicProblem } from "../lib/recorder";
import { prefersReducedMotion } from "../lib/motion";
import { fetchVoiceStatus, talkListenUrl, talkSpeak, VoiceApiError, type VoiceProblem } from "../db/voice-api";
import { openMic, type Mic } from "./mic";
import { ListenError, startListening, type Listening, type ListenProblem } from "./listener";
import { playPcmStream, type Playback } from "./player";
import { LinkDown, openTalkLink, type Spoken, type TalkLink } from "./link";

export interface TalkHost {
  /** The Ask view: it gets data-talk="<state>", and its big intro orb gets --talk-level, so it follows along. */
  view: HTMLElement;
  /** The composer: the talk bar takes the place of its controls while Talk is on. */
  bar: HTMLElement;
  /** Run one turn through Ask (search or the assistant) and return what to say back, or null. */
  ask: (text: string) => Promise<string | null>;
  /** Talk is over: put the composer back. */
  ended: () => void;
  /** Open the ElevenLabs connection in Settings → Voice (a key or voice to fix). */
  openSetup: () => void;
  /** Mark the reply being read out (data-speaking on its message), or clear the mark. */
  speaking: (on: boolean) => void;
}

export interface TalkSession {
  /** A turn that didn't come from the microphone: a choice or suggestion tapped. */
  submit: (text: string) => void;
  /** What Athena is doing right now ("Looking for Rowan…"): it takes the place of "Thinking" in the bar. Never spoken. null clears it. */
  step: (text: string | null) => void;
  end: () => void;
}

type State = "starting" | "listening" | "thinking" | "speaking" | "paused" | "problem";

/** Nothing heard for this long: stop listening, so the microphone isn't left open. */
const QUIET_MS = 12_000;
/** One turn can't run longer than this; what was heard is sent. */
const MAX_TURN_MS = 60_000;
/** A prefetched listening token is good for 15 minutes; don't cut it fine. */
const TOKEN_FRESH_MS = 10 * 60_000;

const HINTS: Record<State, string> = {
  starting: "Getting the microphone ready…",
  listening: "Go ahead. I'll answer when you pause.",
  thinking: "One moment…",
  speaking: "Tap the orb to interrupt.",
  paused: "Microphone off. Tap the orb to carry on.",
  problem: "",
};
/** Listening while a reply's choices are on screen. */
const CHOICE_HINT = "Tap a choice, or say it.";

const LABELS: Record<State, string> = {
  starting: "Starting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  paused: "Paused",
  problem: "Talk paused",
};

const ORB_LABELS: Record<State, string> = {
  starting: "Starting",
  listening: "I'm done talking",
  thinking: "Athena is thinking",
  speaking: "Stop and listen",
  paused: "Keep talking",
  problem: "Try again",
};

interface Problem {
  title: string;
  line: string;
  /** A button beside the message, e.g. "Set up" → Settings → Voice. */
  action?: { label: string; run: () => void };
  /** Tapping the orb tries again. */
  retry: boolean;
}

const MIC_PROBLEMS: Record<MicProblem, Omit<Problem, "action">> = {
  denied: { title: "Microphone is blocked", line: "Allow it for Athena in Settings, then tap the orb.", retry: true },
  missing: { title: "No microphone found", line: "Connect one, then tap the orb.", retry: true },
  busy: { title: "The microphone is busy", line: "Another app has it. Tap the orb to retry.", retry: true },
  unsupported: { title: "Talk doesn't work here", line: "Try Safari or Chrome.", retry: false },
};

// The second has sample mode's written answer (components/ask-answer.ts), so it's spoken without its citation numbers.
const SAMPLE_TURNS = ["What did I decide about the Q3 planning doc?", "What did Elena say about pricing?"];

export function startTalk(ctx: AudioContext | null, host: TalkHost, opts: { sample: boolean }): TalkSession {
  const sample = opts.sample;

  // ---------- The bar ----------
  const orb = h("span", { class: "orb talk-orb", "aria-hidden": "true" });
  const orbBtn = h("button", { class: "talk-bar__orb", type: "button" }, orb) as HTMLButtonElement;
  const stateEl = h("p", { class: "talk-bar__state" });
  const lineText = h("span", {});
  const lineEl = h("p", { class: "talk-bar__line" }, lineText);
  const actionBtn = h("button", { class: "btn btn--primary btn--sm talk-bar__action", type: "button", hidden: true }) as HTMLButtonElement;
  const endBtn = h("button", { class: "btn btn--soft btn--sm talk-bar__end", type: "button", "aria-label": "End the conversation" }, icons.close(), h("span", {}, "End")) as HTMLButtonElement;
  const bar = h(
    "div",
    { class: "talk-bar", role: "group", "aria-label": "Talking with Athena" },
    orbBtn,
    h("div", { class: "talk-bar__body" }, stateEl, lineEl),
    actionBtn,
    endBtn
  );
  const live = h("span", { class: "visually-hidden talk-live", role: "status", "aria-live": "polite" });

  // ---------- The stage ----------
  // A large orb, centred above the bar, with the conversation softened
  // behind it. It lifts out of the composer's orb when Talk starts and settles
  // back into it at the end. The bar keeps the words and End. On a very short
  // screen (voice.css) the stage is hidden and the bar's own orb is used.
  const layer = (name: string) => h("span", { class: `talk-stage__${name}`, "aria-hidden": "true" });
  const stageGlow = layer("glow");
  const stageEar = layer("ear");
  const stageOrb = h("span", { class: "orb talk-orb", "aria-hidden": "true" });
  const stageBtn = h(
    "button",
    { class: "talk-stage__orb", type: "button" },
    stageGlow,
    layer("ripple"),
    layer("ripple"),
    layer("ripple"),
    layer("gather"),
    layer("gather"),
    stageEar,
    layer("arc"),
    stageOrb
  ) as HTMLButtonElement;
  const stage = h("div", { class: "talk-stage" }, h("div", { class: "talk-stage__scrim" }), h("div", { class: "talk-stage__area" }, stageBtn));

  /** Fit the stage to the Ask column, above the composer; the sidebar and the conversations list stay clear. */
  const column = host.view.querySelector<HTMLElement>(".ask__col") ?? host.view;
  function placeStage() {
    const col = column.getBoundingClientRect();
    const top = host.bar.getBoundingClientRect().top;
    stage.style.setProperty("--stage-left", `${Math.round(col.left)}px`);
    stage.style.setProperty("--stage-width", `${Math.round(col.width)}px`);
    stage.style.setProperty("--stage-bottom", `${Math.max(0, Math.round(window.innerHeight - top))}px`);
    // The dim runs from the conversations list (or the sidebar) to the window's edge, so the sidebar stays bright.
    const rail = host.view.querySelector<HTMLElement>(".ask__rail")?.getBoundingClientRect();
    const page = (host.view.parentElement ?? host.view).getBoundingClientRect();
    const from = Math.round(Math.max(page.left, rail && rail.width > 0 && rail.left >= 0 && rail.right <= col.left ? rail.right : 0));
    stage.style.setProperty("--scrim-left", `${from}px`);
  }
  const fits = () => getComputedStyle(stage).display !== "none";
  /** A reply with choices is on screen: the orb waits in the bar, so they can be read and tapped. */
  let settled = false;
  const staged = () => fits() && !settled;
  /** The composer's own orb: where the stage orb comes from and goes back to. */
  const homeOrb = () => host.bar.querySelector<HTMLElement>(".talk-btn .orb");
  const motionOk = !prefersReducedMotion();

  /** Move the stage orb between its place and the composer's orb, as one continuous motion. */
  function fly(from: DOMRect, dir: "in" | "out"): Animation {
    flight?.cancel();
    const to = stageBtn.getBoundingClientRect();
    const k = from.width / to.width;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const away = `translate(${dx}px, ${dy}px) scale(${k})`;
    return (flight = stageBtn.animate(
      dir === "in" ? [{ transform: away }, { transform: "none" }] : [{ transform: "none" }, { transform: away }],
      dir === "in"
        ? { duration: 760, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
        : { duration: 520, easing: "cubic-bezier(0.5, 0, 0.2, 1)", fill: "forwards" }
    ));
  }
  let flight: Animation | null = null;

  const focusWasOnHost = host.bar.contains(document.activeElement);
  const origin = homeOrb()?.getBoundingClientRect();
  host.bar.classList.add("talk-active");
  host.bar.append(bar, live);
  host.view.classList.add("is-talking");
  host.view.append(stage);
  placeStage();
  const thread = host.view.querySelector<HTMLElement>(".thread");
  /** The latest message offers choices that haven't been answered. */
  const choicesShown = () => {
    const msgs = thread?.querySelectorAll(":scope > .msg");
    return !!msgs?.[msgs.length - 1]?.querySelector(".choices");
  };
  settled = choicesShown();
  stage.classList.toggle("is-settled", settled);
  if (staged()) {
    host.view.classList.add("talk-staged");
    if (motionOk && origin && origin.width > 0) fly(origin, "in");
    else stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
    requestAnimationFrame(() => stage.classList.add("is-on"));
  }
  /**
   * Choices on screen: the stage orb settles into the bar's orb, the same motion
   * as End. They're answered, or a new turn starts: it rises back to the stage.
   */
  function settle(on: boolean) {
    if (on === settled || !alive) return;
    const wasStaged = staged();
    settled = on;
    if (!fits()) {
      stage.classList.toggle("is-settled", on);
      return;
    }
    const barOrb = orbBtn.getBoundingClientRect();
    if (on) {
      host.view.classList.remove("talk-staged");
      stage.classList.remove("is-on");
      if (!wasStaged) return stage.classList.add("is-settled");
      const home = orbBtn.getBoundingClientRect();
      if (!motionOk || home.width === 0) return stage.classList.add("is-settled");
      bar.classList.add("is-landing");
      const done = () => {
        if (!settled) return;
        bar.classList.remove("is-landing");
        stage.classList.add("is-settled");
        flight?.cancel();
        flight = null;
      };
      fly(home, "out").finished.then(done, () => undefined);
    } else {
      // From wherever it is now: from the bar, or midway if it hadn't landed.
      const from = flight ? stageBtn.getBoundingClientRect() : barOrb;
      bar.classList.remove("is-landing");
      stage.classList.remove("is-settled");
      host.view.classList.add("talk-staged");
      requestAnimationFrame(() => stage.classList.add("is-on"));
      if (motionOk && from.width > 0) fly(from, "in");
      else stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
    }
    shownBar = -1;
    if (state === "listening" && !lineEl.classList.contains("is-heard")) paint();
    if (stage.contains(document.activeElement) || orbBtn === document.activeElement) (on ? orbBtn : stageBtn).focus();
  }
  const watchChoices = new MutationObserver(() => settle(choicesShown()));
  if (thread) watchChoices.observe(thread, { childList: true, subtree: true });

  // Turning a phone on its side can hide or show the stage (voice.css).
  const relayout = () => {
    placeStage();
    host.view.classList.toggle("talk-staged", staged());
    shownBar = -1;
  };
  const barSize = new ResizeObserver(relayout);
  barSize.observe(host.bar);
  window.addEventListener("resize", relayout);
  if (focusWasOnHost) (staged() ? stageBtn : orbBtn).focus();

  let state: State = "starting";
  let problem: Problem | null = null;
  let alive = true;
  /** Bumped on every change of phase; work from an older phase sees it and stops. */
  let phase = 0;
  let mic: Mic | null = null;
  let listening: Listening | null = null;
  let playback: Playback | null = null;
  let speakAbort: AbortController | null = null;
  /** The session socket Athena's voice arrives on; without it each reply is a POST /api/talk/speak. */
  let link: TalkLink | null = null;
  let prefetched: { at: number; url: Promise<{ url: string } | { error: unknown }> } | null = null;
  let level = 0;
  let levelSource: (() => number) | null = null;
  let raf = 0;
  let notice: string | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let sampleTurn = 0;
  /** Sample mode's "I'm done": skip to the end of the canned words. */
  let sampleFinish: (() => void) | null = null;

  /** The step on screen while thinking (ask.ts sends them); shown only, never spoken. */
  let stepText: string | null = null;
  const announce = (text: string) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 60);
  };

  function paint(line?: string) {
    bar.dataset.state = state;
    stage.dataset.state = state;
    host.view.dataset.talk = state;
    stateEl.textContent = state === "problem" && problem ? problem.title : state === "thinking" && stepText ? stepText : LABELS[state];
    stateEl.classList.toggle("is-step", state === "thinking" && !!stepText);
    lineText.textContent = line ?? (state === "problem" && problem ? problem.line : (notice ?? (settled && state === "listening" ? CHOICE_HINT : HINTS[state])));
    lineEl.classList.toggle("is-heard", !!line);
    fitLine();
    for (const b of [orbBtn, stageBtn]) {
      b.setAttribute("aria-label", ORB_LABELS[state]);
      b.setAttribute("aria-disabled", String(state === "thinking" || state === "starting" || (state === "problem" && !problem?.retry)));
    }
    const action = state === "problem" ? problem?.action : undefined;
    actionBtn.hidden = !action;
    if (action) actionBtn.textContent = action.label;
  }

  /** Long transcripts show their latest words, fading in from the left. */
  function fitLine() {
    lineEl.classList.remove("is-long");
    if (lineText.scrollWidth > lineEl.clientWidth + 1) lineEl.classList.add("is-long");
  }

  function setState(next: State, line?: string) {
    const changed = next !== state;
    if (next !== "thinking") stepText = null;
    if (changed && (state === "speaking" || next === "speaking")) markSpoken(next === "speaking");
    state = next;
    paint(line);
    if (changed) announce(state === "problem" && problem ? `${problem.title}. ${problem.line}` : LABELS[state]);
  }

  function showNotice(text: string) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = null;
      if (state === "listening" && !lineEl.classList.contains("is-heard")) paint();
    }, 5000);
  }

  // ---------- Level → orb ----------
  const reduced = prefersReducedMotion();
  const intro = host.view.querySelector<HTMLElement>(".ask__intro");
  // --talk-level doesn't inherit (voice.css), so a change restyles only the
  // few elements that draw with it, not the bar's or the view's contents.
  // Only the orb on show: the stage's (its glow, ring and orb), or the bar's when there's no stage.
  const orbLayers = () => (host.view.classList.contains("talk-staged") ? [stageGlow, stageEar, stageOrb] : [orbBtn, orb]);
  const introLayers = intro ? [intro, ...intro.querySelectorAll<HTMLElement>(":scope > .orb")] : [];
  const setLevel = (els: HTMLElement[], v: number) => els.forEach((el) => el.style.setProperty("--talk-level", String(v)));
  /** The small orb beside the reply being read out: it moves with the voice too. */
  let replyOrb: HTMLElement | null = null;
  function markSpoken(on: boolean) {
    replyOrb?.style.removeProperty("--talk-level");
    host.speaking(on);
    replyOrb = on ? host.view.querySelector<HTMLElement>(".msg[data-speaking] > .orb") : null;
    shownBar = -1;
  }
  let last = performance.now();
  let shownBar = -1;
  let shownIntro = -1;
  const tick = (now: number) => {
    const dt = Math.min(100, now - last);
    last = now;
    const target = levelSource ? levelSource() : 0;
    // Quick to rise, slow to fall, so the orb breathes with the voice rather
    // than flickers. Timed in milliseconds, so it's the same at 60 or 120Hz.
    level += (target - level) * (1 - Math.exp(-dt / (target > level ? 45 : 200)));
    const shown = reduced ? 0 : Math.round(level * 100) / 100;
    // Written only when it changes, and to the big orb only while it's on screen.
    if (shown !== shownBar) setLevel(replyOrb ? [...orbLayers(), replyOrb] : orbLayers(), (shownBar = shown));
    const onIntro = intro && !intro.hidden ? shown : 0;
    if (onIntro !== shownIntro) setLevel(introLayers, (shownIntro = onIntro));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  // ---------- Cleaning up a phase ----------
  function quietDown() {
    sampleFinish = null;
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    listening?.cancel();
    listening = null;
    mic?.stop();
    mic = null;
    speakAbort?.abort();
    speakAbort = null;
    playback?.stop();
    playback = null;
    levelSource = null;
  }

  function prefetchToken() {
    if (sample || (prefetched && Date.now() - prefetched.at < TOKEN_FRESH_MS)) return;
    prefetched = { at: Date.now(), url: talkListenUrl().then((r) => ({ url: r.url }), (error: unknown) => ({ error })) };
  }

  /** A listening URL: the one fetched ahead if it's fresh, else a new one. A fault on our side isn't retried. */
  async function nextUrl(): Promise<string> {
    const p = prefetched && Date.now() - prefetched.at < TOKEN_FRESH_MS ? prefetched : null;
    prefetched = null;
    const got = p ? await p.url : null;
    if (got && "url" in got) return got.url;
    if (got && got.error instanceof VoiceApiError && got.error.reason && got.error.reason !== "unreachable" && got.error.reason !== "busy") throw got.error;
    return (await talkListenUrl()).url;
  }

  // ---------- Problems ----------
  function voiceProblem(reason: VoiceProblem | ListenProblem | null, status?: number): Problem {
    const fix = { label: "Open Voice settings", run: () => host.openSetup() };
    switch (reason) {
      case "not_connected":
        return { title: "Talk needs ElevenLabs", line: "Add your key in Settings → Voice to start.", action: { label: "Set up", run: () => host.openSetup() }, retry: true };
      case "bad_key":
        return { title: "ElevenLabs refused the key", line: "Replace it in Settings → Voice.", action: fix, retry: true };
      case "not_allowed":
        return { title: "The key can't do this", line: "Allow Text to Speech and Speech to Text for it.", action: fix, retry: true };
      case "no_credits":
        return { title: "Out of ElevenLabs credits", line: "Talk works again when your plan renews.", retry: true };
      case "voice":
        return { title: "That voice won't work", line: "Pick another in Settings → Voice.", action: fix, retry: true };
      case "terms":
        return { title: "One step in ElevenLabs", line: "Accept the Speech to Text terms there, then tap the orb.", retry: true };
      case "busy":
        return { title: "ElevenLabs is busy", line: "Tap the orb to try again.", retry: true };
      case "setup":
        return { title: "Talk isn't set up yet", line: "Athena's server needs its encryption key.", retry: false };
      default:
        return status === 401
          ? { title: "Athena isn't connected", line: "Sign out from the menu, then sign in again.", retry: false }
          : !navigator.onLine
            ? { title: "You're offline", line: "Tap the orb when you're back online.", retry: true }
            : { title: "Lost the connection", line: "Tap the orb to try again.", retry: true };
    }
  }

  function fail(p: Problem) {
    quietDown();
    phase++;
    problem = p;
    setState("problem");
    setAudioSession("auto");
  }

  function problemFrom(error: unknown): Problem {
    if (error instanceof MicError) return MIC_PROBLEMS[error.problem];
    if (error instanceof VoiceApiError) return voiceProblem(error.reason, error.status);
    if (error instanceof ListenError) return voiceProblem(error.problem);
    return voiceProblem(null);
  }

  // ---------- Listening ----------
  async function listen() {
    if (!alive) return;
    quietDown();
    const my = ++phase;
    problem = null;
    setState(sample ? "listening" : "starting");
    if (sample) return sampleListen(my);
    if (!navigator.onLine) return fail(voiceProblem(null));
    // The token first (usually fetched already, while Athena was speaking), so
    // nobody is asked for the microphone when ElevenLabs isn't set up.
    let url: string;
    try {
      url = await nextUrl();
    } catch (error) {
      if (my !== phase) return;
      return fail(problemFrom(error));
    }
    if (my !== phase) return;
    setAudioSession("play-and-record");
    let m: Mic;
    try {
      m = await openMic(ctx!);
    } catch (error) {
      if (my !== phase) return;
      return fail(problemFrom(error));
    }
    if (my !== phase) {
      m.stop();
      return;
    }
    mic = m;
    levelSource = m.level;
    setState("listening");
    let heard = false;
    const l = startListening({
      url,
      mic: m,
      onPartial: (text) => {
        if (my !== phase) return;
        heard = true;
        clearTimeout(quietTimer);
        notice = null;
        paint(text);
      },
    });
    listening = l;
    m.onEnded(() => my === phase && l.finishNow());
    quietTimer = setTimeout(() => my === phase && !heard && pause(), QUIET_MS);
    maxTimer = setTimeout(() => my === phase && l.finishNow(), MAX_TURN_MS);
    let text: string;
    try {
      text = await l.result;
    } catch (error) {
      if (my !== phase) return;
      return fail(problemFrom(error));
    }
    if (my !== phase) return;
    if (!text) return heard ? void listen() : pause();
    void respond(text);
  }

  function pause() {
    quietDown();
    phase++;
    setState("paused");
    setAudioSession("auto");
  }

  // ---------- Thinking and speaking ----------
  async function respond(text: string) {
    quietDown();
    const my = ++phase;
    setState("thinking");
    link?.warm();
    prefetchToken();
    let reply: string | null = null;
    try {
      reply = await host.ask(text);
    } catch {
      reply = "That didn't go through. Try again in a moment.";
    }
    if (my !== phase || !alive) return;
    if (reply) await speak(reply, my);
    if (my === phase && alive) void listen();
  }

  async function speak(text: string, my: number) {
    setState("speaking");
    if (sample) return sampleSpeak(text, my);
    setAudioSession("playback");
    speakAbort = new AbortController();
    try {
      const signal = speakAbort.signal;
      const viaLink: Spoken | null = link
        ? await link.speak(text, signal).catch((error: unknown) => {
            if (error instanceof LinkDown) return null;
            throw error;
          })
        : null;
      const { body, sampleRate } = viaLink ?? (await talkSpeak(text, { signal }));
      if (my !== phase) return;
      playback = playPcmStream(ctx!, body, sampleRate);
      levelSource = playback.level;
      await playback.done;
    } catch (error) {
      if (my !== phase || (error as { name?: string })?.name === "AbortError") return;
      const reason = error instanceof VoiceApiError ? error.reason : null;
      // A key or credit problem will stop listening too: say so now, plainly.
      if (reason === "bad_key" || reason === "no_credits" || reason === "voice" || reason === "not_connected" || reason === "not_allowed") {
        fail(voiceProblem(reason, (error as VoiceApiError).status));
        return;
      }
      showNotice("Couldn't play that reply, but it's on screen.");
    } finally {
      if (my === phase) {
        playback = null;
        levelSource = null;
      }
    }
  }

  // ---------- Sample mode ----------
  function sampleListen(my: number) {
    if (sampleTurn >= SAMPLE_TURNS.length) {
      sampleTurn = 0;
      showNotice("End of the sample. Tap the orb to replay it.");
      pause();
      return;
    }
    const words = SAMPLE_TURNS[sampleTurn++].split(" ");
    sampleFinish = () => {
      sampleFinish = null;
      void respond(words.join(" "));
    };
    let shown = 0;
    let speaking = false;
    const started = performance.now();
    levelSource = () => {
      if (!speaking) return 0.04 + Math.random() * 0.03;
      const t = performance.now() - started;
      return Math.min(1, 0.25 + Math.max(0, Math.sin(t / 90) * Math.sin(t / 330 + 1)) * 0.65);
    };
    const step = () => {
      if (my !== phase) return;
      speaking = true;
      shown++;
      paint(words.slice(0, shown).join(" "));
      if (shown < words.length) quietTimer = setTimeout(step, 210 + Math.random() * 120);
      else
        quietTimer = setTimeout(() => {
          speaking = false;
          if (my === phase) void respond(words.join(" "));
        }, 900);
    };
    quietTimer = setTimeout(step, 900);
  }

  function sampleSpeak(text: string, my: number): Promise<void> {
    showNotice("No sound in sample mode.");
    paint();
    const started = performance.now();
    levelSource = () => {
      const t = performance.now() - started;
      return Math.min(1, 0.2 + Math.max(0, Math.sin(t / 110) * Math.sin(t / 470 + 0.4)) * 0.75);
    };
    const ms = Math.max(1800, text.split(/\s+/).length * 280);
    return new Promise((resolve) => {
      quietTimer = setTimeout(() => {
        if (my === phase) levelSource = null;
        notice = null;
        resolve();
      }, ms);
      speakAbort = new AbortController();
      speakAbort.signal.addEventListener("abort", () => {
        notice = null;
        resolve();
      });
    });
  }

  // ---------- Taps ----------
  const onOrb = () => {
    if (state === "listening") (listening?.finishNow ?? sampleFinish ?? (() => undefined))();
    else if (state === "speaking") void listen(); // barge-in: stop talking and listen
    else if (state === "paused") void listen();
    else if (state === "problem" && problem?.retry) void listen();
  };
  orbBtn.addEventListener("click", onOrb);
  stageBtn.addEventListener("click", onOrb);
  actionBtn.addEventListener("click", () => problem?.action?.run());
  endBtn.addEventListener("click", () => end());

  // ---------- Leaving ----------
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    end();
  };
  const onHidden = () => {
    if (document.visibilityState !== "hidden") return;
    end();
    // Say why when they come back, rather than to an empty room.
    const back = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", back);
      showToast("Talk ended when Athena went to the background", { icon: "micOff" });
    };
    document.addEventListener("visibilitychange", back);
  };
  const onPageHide = () => end();
  const onOffline = () => {
    if (state === "listening" || state === "starting" || state === "speaking") fail(voiceProblem(null));
  };
  window.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("offline", onOffline);
  window.addEventListener("resize", fitLine);

  function end() {
    if (!alive) return;
    alive = false;
    phase++;
    quietDown();
    link?.close();
    link = null;
    clearTimeout(noticeTimer);
    cancelAnimationFrame(raf);
    setAudioSession("auto");
    window.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("resize", fitLine);
    window.removeEventListener("resize", relayout);
    barSize.disconnect();
    watchChoices.disconnect();
    if (state === "speaking") markSpoken(false);
    const focusWasInside = bar.contains(document.activeElement) || stage.contains(document.activeElement);
    const wasStaged = staged();
    bar.remove();
    host.bar.classList.remove("talk-active");
    host.view.classList.remove("is-talking", "talk-staged");
    // The stage orb settles back into the composer's orb, which waits hidden until it lands.
    const home = homeOrb()?.getBoundingClientRect();
    stage.dataset.state = "ending";
    stage.classList.remove("is-on");
    stageBtn.disabled = true;
    if (wasStaged && motionOk && home && home.width > 0 && document.visibilityState === "visible") {
      host.bar.classList.add("talk-landing");
      const done = () => {
        stage.remove();
        host.bar.classList.remove("talk-landing");
      };
      fly(home, "out").finished.then(done, done);
    } else if (wasStaged && document.visibilityState === "visible") {
      stage.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: "ease-out", fill: "forwards" }).finished.then(
        () => stage.remove(),
        () => stage.remove()
      );
    } else stage.remove();
    delete host.view.dataset.talk;
    introLayers.forEach((el) => el.style.removeProperty("--talk-level"));
    // The announcement outlives the bar, then goes too.
    live.textContent = "Talk ended";
    setTimeout(() => live.remove(), 1500);
    host.ended();
    if (focusWasInside) host.bar.querySelector<HTMLElement>(".talk-btn")?.focus();
  }

  /** Check ElevenLabs is set up before asking for the microphone; the first listen fetches its token meanwhile. */
  async function begin() {
    if (!sample && !ctx) return fail(MIC_PROBLEMS.unsupported);
    if (!sample) {
      const my = phase;
      try {
        const s = await fetchVoiceStatus();
        if (my !== phase || !alive) return;
        if (!s.connected) return fail(voiceProblem("not_connected"));
      } catch {
        // Can't tell: listening will say what's wrong.
      }
    }
    if (!sample && alive) link = openTalkLink();
    prefetchToken();
    void listen();
  }

  paint();
  void begin();

  return {
    submit(text: string) {
      if (!alive) return;
      void respond(text);
    },
    step(text: string | null) {
      if (!alive) return;
      stepText = text;
      if (state === "thinking") paint();
    },
    end,
  };
}
