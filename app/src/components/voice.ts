/**
 * Voice input: a mic button, and the recording bar it turns into. Used by the
 * note editor's toolbar (dictation, inserted at the cursor) and Ask's
 * composer (a spoken question). Speech goes to /api/voice/transcribe
 * (ElevenLabs Scribe with the owner's key when it's connected, otherwise
 * Gemini through the AI Gateway); only the text comes back, and the
 * recording is dropped as soon as it has been used. Ask's two-way Talk is
 * talk/session.ts, not this.
 *
 * The bar replaces the host's own controls while it's up and says what's
 * happening inline — including "offline" and "microphone blocked" — rather
 * than in a toast, because toasts sit beneath an open sheet.
 *
 * Sample mode has no server, so it records nothing: a gently simulated level
 * and a canned transcript keep the whole flow demoable without a microphone.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { ApiError, isSampleMode, transcribeAudio } from "../db/api";
import { MicError, micBlocked, recordingSupported, startRecorder, type MicProblem, type Recorder, type Recording } from "../lib/recorder";
import { prefersReducedMotion } from "../lib/motion";

export type VoicePurpose = "note" | "ask";

/** What a recording is for: told when its text is ready (or that there won't be any). */
export interface VoiceTarget {
  transcribing?: () => void;
  /** The transcript; never empty. */
  text: (text: string) => void;
  /** Ended without text: cancelled, failed or nothing heard. */
  abandon?: () => void;
}

export interface VoiceButtonOptions {
  purpose: VoicePurpose;
  /** The bar is shown inside this element, in place of its other children. */
  host: HTMLElement;
  /** Extra classes for the mic button, so it matches its surroundings. */
  className: string;
  /** Called on each new recording; null means "not now" (e.g. the editor isn't ready). */
  begin: () => VoiceTarget | null;
  /** Don't take focus (and the caret) from the editor when pressed. */
  keepFocus?: boolean;
}

export interface VoiceButton {
  el: HTMLButtonElement;
  destroy: () => void;
}

const LIMITS: Record<VoicePurpose, number> = { note: 180_000, ask: 30_000 };
/** The timer turns into a countdown this long before the limit. */
const WARN_MS = 15_000;
/** Shorter than this is a mis-tap, not a recording. */
const MIN_MS = 600;
/** Meter bars are 3px wide with 3px gaps, as many as fit. */
const BAR_PITCH = 6;

const COPY: Record<VoicePurpose, { label: string; done: string; offline: string }> = {
  note: { label: "Dictate", done: "Stop and insert", offline: "Dictation needs a connection" },
  ask: { label: "Ask by voice", done: "Stop and ask", offline: "Asking by voice needs a connection" },
};

const MIC_PROBLEMS: Record<MicProblem, string> = {
  denied: "Microphone is blocked. Allow it in this site's settings, then try again.",
  missing: "No microphone found",
  busy: "The microphone is in use by another app",
  unsupported: "Voice input isn't supported in this browser",
};

const NOTHING_HEARD = "Didn't catch anything. Try again a little closer.";

const SAMPLE_TEXT: Record<VoicePurpose, string> = {
  note: "Follow up with Priya about the Q3 planning doc before Thursday's review.",
  ask: "What did I decide about the Q3 planning doc?",
};

export function voiceSupported(): boolean {
  return isSampleMode() || recordingSupported();
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000 - 0.05));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Sample mode's stand-in for the microphone: a plausible, gently moving level. */
function simulatedRecorder(): Recorder {
  const startedAt = performance.now();
  let endedAt: number | null = null;
  const elapsedMs = () => (endedAt ?? performance.now()) - startedAt;
  return {
    level: () => {
      const t = elapsedMs();
      const syllables = Math.max(0, Math.sin(t / 95) * Math.sin(t / 410 + 1.3));
      return Math.min(1, 0.1 + syllables * 0.7 + Math.random() * 0.08);
    },
    elapsedMs,
    onInterrupt: () => {},
    stop: async () => {
      endedAt ??= performance.now();
      return { blob: new Blob([], { type: "audio/webm" }), durationMs: elapsedMs(), heardSound: true };
    },
    cancel: () => {
      endedAt ??= performance.now();
    },
  };
}

async function transcribe(purpose: VoicePurpose, recording: Recording, signal: AbortSignal): Promise<string> {
  if (!isSampleMode()) return transcribeAudio(recording.blob, signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1100);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
  return SAMPLE_TEXT[purpose];
}

/** A failed transcription, worded for the bar; `retry` when trying again could help. */
function failure(error: unknown): { message: string; icon: IconName; retry: boolean } {
  if (!(error instanceof ApiError)) return { message: "Lost the connection", icon: "wifiOff", retry: true };
  switch (error.status) {
    case 400:
      // "Too short": silence compresses to almost nothing.
      return { message: NOTHING_HEARD, icon: "micOff", retry: false };
    case 401:
      return { message: "Athena isn't connected. Sign out from the menu, then sign in again to use voice.", icon: "plug", retry: false };
    case 413:
      return { message: "That's too long to transcribe", icon: "clock", retry: false };
    case 429:
      return { message: "That's a lot of recordings. Try again in a minute.", icon: "clock", retry: true };
    case 503:
      return { message: "Voice isn't set up on this server yet", icon: "micOff", retry: false };
    default:
      return { message: "Couldn't transcribe that", icon: "refresh", retry: true };
  }
}

export function voiceButton(opts: VoiceButtonOptions): VoiceButton {
  const copy = COPY[opts.purpose];
  const el = h(
    "button",
    { class: `voice-btn ${opts.className}`, type: "button", "aria-label": copy.label, title: copy.label },
    icons.mic()
  ) as HTMLButtonElement;
  if (opts.keepFocus) el.addEventListener("mousedown", (e) => e.preventDefault());

  // Announcements outlive the bar, which is removed when it's done.
  const live = h("span", { class: "visually-hidden voice-live", role: "status" });
  const announce = (text: string) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 60);
  };

  /** Whatever is currently in the host (a recording or a notice); ended to make way for the next. */
  let current: { end: () => void } | null = null;

  const paintAvailability = () => {
    const offline = !isSampleMode() && !navigator.onLine;
    if (offline) el.setAttribute("aria-disabled", "true");
    else el.removeAttribute("aria-disabled");
    el.title = offline ? copy.offline : copy.label;
  };
  paintAvailability();
  window.addEventListener("online", paintAvailability);
  window.addEventListener("offline", paintAvailability);

  // A second tap while the permission check is still answering is ignored.
  let starting = false;
  el.addEventListener("click", () => {
    if (current || starting) return;
    if (!isSampleMode() && !navigator.onLine) {
      showNotice(copy.offline, "wifiOff");
      return;
    }
    starting = true;
    void record().finally(() => (starting = false));
  });

  // ---------- Showing and hiding the bar ----------

  function mount(bar: HTMLElement, focusTarget: HTMLElement) {
    const followFocus = document.activeElement === el;
    opts.host.classList.add("voice-active");
    opts.host.append(bar, live);
    // Keyboard (or click) focus was on the mic, which is now hidden: follow it.
    if (followFocus) focusTarget.focus();
  }

  function unmount(bar: HTMLElement) {
    const focusWasInside = bar.contains(document.activeElement);
    bar.remove();
    if (!opts.host.querySelector(".voice-bar")) opts.host.classList.remove("voice-active");
    if (focusWasInside && el.isConnected) el.focus();
  }

  const barButton = (cls: string, label: string, icon: IconName) => {
    const b = h("button", { class: `voice-bar__btn ${cls}`, type: "button", "aria-label": label }, icons[icon]()) as HTMLButtonElement;
    if (opts.keepFocus) b.addEventListener("mousedown", (e) => e.preventDefault());
    return b;
  };

  /**
   * A short explanation in the bar's place. With an action (Retry) it stays
   * until answered, since it's holding a recording; otherwise it goes by itself.
   */
  function showNotice(message: string, icon: IconName, action?: { label: string; run: () => void; dismissed: () => void }) {
    current?.end();
    const dismissBtn = barButton("voice-bar__cancel", "Dismiss", "close");
    const actionBtn = action ? (h("button", { class: "voice-bar__action", type: "button" }, action.label) as HTMLButtonElement) : null;
    if (opts.keepFocus) actionBtn?.addEventListener("mousedown", (e) => e.preventDefault());
    const bar = h(
      "div",
      { class: "voice-bar", "data-state": "notice", role: "group", "aria-label": message },
      dismissBtn,
      h("p", { class: "voice-bar__notice" }, icons[icon](), h("span", {}, message)),
      actionBtn
    );
    const timer = action ? undefined : setTimeout(() => end(), 5000);
    const end = (then?: () => void) => {
      clearTimeout(timer);
      if (current === entry) current = null;
      unmount(bar);
      then?.();
    };
    const entry = { end: () => end(action?.dismissed) };
    current = entry;
    dismissBtn.addEventListener("click", () => end(action?.dismissed));
    actionBtn?.addEventListener("click", () => end(action!.run));
    mount(bar, actionBtn ?? dismissBtn);
    announce(message);
  }

  // ---------- A recording ----------

  async function record() {
    if (!isSampleMode() && (await micBlocked())) {
      showNotice(MIC_PROBLEMS.denied, "micOff");
      return;
    }
    const target = opts.begin();
    if (!target) return;

    const cancelBtn = barButton("voice-bar__cancel", "Cancel recording", "close");
    const doneBtn = barButton("voice-bar__done", copy.done, "check");
    doneBtn.disabled = true;
    const time = h("span", { class: "voice-bar__time", role: "timer" }, "0:00");
    const meter = h("span", { class: "voice-bar__meter", "aria-hidden": "true" });
    let bars: HTMLElement[] = [];
    let levels: number[] = [];
    /** Fill the meter's width with bars, keeping the most recent levels. */
    const fitBars = () => {
      const count = Math.max(12, Math.min(160, Math.floor(meter.clientWidth / BAR_PITCH)));
      if (count === bars.length) return;
      levels = [...new Array<number>(Math.max(0, count - levels.length)).fill(0), ...levels.slice(-count)];
      bars = levels.map((v) => h("span", { style: `transform: scaleY(${(0.16 + v * 0.84).toFixed(3)})` }));
      meter.replaceChildren(...bars);
    };
    const bar = h(
      "div",
      { class: "voice-bar", "data-state": "starting", role: "group", "aria-label": "Recording" },
      cancelBtn,
      h(
        "div",
        { class: "voice-bar__body" },
        h("span", { class: "voice-bar__dot", "aria-hidden": "true" }),
        time,
        // Takes the timer's place while the words come back.
        h("span", { class: "voice-bar__status" }, "Transcribing…"),
        meter
      ),
      doneBtn
    );

    const limit = LIMITS[opts.purpose];
    let recorder: Recorder | null = null;
    let abort = new AbortController();
    let raf = 0;
    let stopped = false; // no more audio: finishing, transcribing or gone
    let shown = true;
    let lastStep = 0;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Ahead of the sheet's own Escape handling, which would close the note.
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };

    /** Take the bar down; the recording itself is handled by the caller. */
    const hide = () => {
      if (!shown) return;
      shown = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", fitBars);
      if (current === entry) current = null;
      unmount(bar);
    };
    const show = (focusTarget: HTMLElement) => {
      shown = true;
      current = entry;
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", fitBars);
      mount(bar, focusTarget);
      fitBars();
    };

    /** Throw it all away: the recording, any upload, the insertion point. */
    function cancel() {
      stopped = true;
      abort.abort();
      recorder?.cancel();
      hide();
      target!.abandon?.();
    }
    const entry = { end: cancel };

    const tick = (now: number) => {
      if (!recorder || stopped) return;
      const elapsed = recorder.elapsedMs();
      const left = limit - elapsed;
      time.textContent = left <= WARN_MS ? `${clock(left)} left` : clock(elapsed);
      if (left <= WARN_MS) bar.dataset.ending = "";
      // Recent levels scroll right to left, newest at the right edge. With
      // reduced motion the meter steps less often and doesn't glide.
      const level = recorder.level();
      const last = levels.length - 1;
      levels[last] = Math.max(levels[last], level);
      if (now - lastStep > (prefersReducedMotion() ? 260 : 75)) {
        lastStep = now;
        levels.shift();
        levels.push(level);
        levels.forEach((v, i) => (bars[i].style.transform = `scaleY(${(0.16 + v * 0.84).toFixed(3)})`));
      }
      if (left <= 0) void finish();
      else raf = requestAnimationFrame(tick);
    };

    async function finish() {
      if (stopped || !recorder) return;
      stopped = true;
      cancelAnimationFrame(raf);
      const recording = await recorder.stop();
      if (!shown) return; // cancelled while stopping
      if (recording.durationMs < MIN_MS) {
        cancel();
      } else if (!recording.heardSound) {
        cancel();
        showNotice(NOTHING_HEARD, "micOff");
      } else {
        await send(recording);
      }
    }

    async function send(recording: Recording) {
      bar.dataset.state = "transcribing";
      bar.setAttribute("aria-label", "Transcribing");
      cancelBtn.setAttribute("aria-label", "Cancel");
      // Disabling a focused button drops focus to <body>; keep it in the bar.
      if (document.activeElement === doneBtn) cancelBtn.focus();
      doneBtn.disabled = true;
      announce("Transcribing");
      target!.transcribing?.();
      const { signal } = abort;
      let text: string;
      try {
        text = (await transcribe(opts.purpose, recording, signal)).trim();
      } catch (error) {
        if (signal.aborted) return;
        hide();
        const f = failure(error);
        if (!f.retry) {
          target!.abandon?.();
          showNotice(f.message, f.icon);
          return;
        }
        // The recording is still in memory, so trying again doesn't mean speaking again.
        showNotice(f.message, f.icon, {
          label: "Retry",
          run: () => {
            abort = new AbortController();
            show(cancelBtn);
            void send(recording);
          },
          dismissed: () => target!.abandon?.(),
        });
        return;
      }
      if (signal.aborted) return;
      hide();
      if (!text) {
        target!.abandon?.();
        showNotice(NOTHING_HEARD, "micOff");
        return;
      }
      target!.text(text);
      announce(opts.purpose === "note" ? "Dictation added" : `Asking: ${text}`);
    }

    cancelBtn.addEventListener("click", cancel);
    doneBtn.addEventListener("click", () => void finish());

    show(cancelBtn);
    try {
      recorder = isSampleMode() ? simulatedRecorder() : await startRecorder();
    } catch (error) {
      cancel();
      showNotice(MIC_PROBLEMS[error instanceof MicError ? error.problem : "unsupported"], "micOff");
      return;
    }
    if (stopped) {
      recorder.cancel(); // cancelled while the permission prompt was up
      return;
    }
    recorder.onInterrupt(() => void finish());
    bar.dataset.state = "recording";
    doneBtn.disabled = false;
    if (document.activeElement === cancelBtn) doneBtn.focus();
    announce("Recording");
    raf = requestAnimationFrame(tick);
  }

  return {
    el,
    destroy() {
      current?.end();
      window.removeEventListener("online", paintAvailability);
      window.removeEventListener("offline", paintAvailability);
    },
  };
}
