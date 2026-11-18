/**
 * Microphone capture for voice input (components/voice.ts is the only
 * caller). MediaRecorder does the encoding: Chrome, Edge and Firefox give
 * Opus in WebM, Safari gives AAC in MP4, and the server accepts both. An
 * AnalyserNode beside it reports a live level for the meter and remembers the
 * loudest moment, so a recording that never rose above room noise can be
 * dropped on the device instead of spending a model call on silence.
 *
 * Nothing here persists: the recording is a Blob in memory until the caller
 * lets go of it, and the microphone is released the moment recording ends.
 */

/** Speech is fine at this rate, and three minutes stays under a megabyte. */
const BITRATE = 32_000;
const TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"];
/** Peak RMS below this (dBFS) is a quiet room, not a voice. */
const SPEECH_FLOOR_DB = -50;

export type MicProblem = "denied" | "missing" | "busy" | "unsupported";

export class MicError extends Error {
  constructor(public problem: MicProblem) {
    super(problem);
  }
}

export interface Recording {
  blob: Blob;
  durationMs: number;
  /** False only when the meter was working and never heard anything louder than room noise. */
  heardSound: boolean;
}

export interface Recorder {
  /** Current input level, 0–1, for the meter. */
  level: () => number;
  elapsedMs: () => number;
  stop: () => Promise<Recording>;
  cancel: () => void;
  /** Called if the microphone goes away mid-recording (unplugged, interrupted). */
  onInterrupt: (fn: () => void) => void;
}

export function recordingSupported(): boolean {
  return typeof window.MediaRecorder === "function" && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
}

function pickType(): string {
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

function micProblem(error: unknown): MicProblem {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "missing";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "unsupported";
}

/** Whether the browser already knows the answer is "no" (so a tap can explain instead of prompting). */
export async function micBlocked(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    return status?.state === "denied";
  } catch {
    return false; // Safari before 16 has no microphone permission query
  }
}

/**
 * Ask for the microphone and start recording. Must be called from a tap:
 * the AudioContext is created before the first await so iOS lets it run.
 */
export async function startRecorder(): Promise<Recorder> {
  if (!recordingSupported()) throw new MicError("unsupported");
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const audioCtx = Ctx ? new Ctx() : null;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (error) {
    void audioCtx?.close();
    throw new MicError(micProblem(error));
  }

  const mimeType = pickType();
  const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: BITRATE });
  const chunks: Blob[] = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data.size) chunks.push(e.data);
  });

  // ---------- Level meter ----------
  let analyser: AnalyserNode | null = null;
  let samples: Float32Array<ArrayBuffer> | null = null;
  let peakDb = -Infinity;
  // A suspended AudioContext (iOS can refuse to start one) reads as perfect
  // zeros; only a meter that has seen some signal is trusted to call silence.
  let sawSignal = false;
  if (audioCtx) {
    try {
      void audioCtx.resume();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      samples = new Float32Array(analyser.fftSize);
    } catch {
      analyser = null;
    }
  }
  const level = () => {
    if (!analyser || !samples) return 0;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    if (sum > 0) sawSignal = true;
    const db = 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8);
    if (db > peakDb) peakDb = db;
    // -60dB (a quiet room) to -12dB (close, clear speech) fills the meter.
    return Math.min(1, Math.max(0, (db + 60) / 48));
  };
  // The meter only samples while it's on screen, so keep an eye on the peak
  // ourselves too (a hidden tab still records).
  const peakTimer = setInterval(level, 200);

  const startedAt = performance.now();
  let endedAt: number | null = null;
  const elapsedMs = () => (endedAt ?? performance.now()) - startedAt;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    endedAt ??= performance.now();
    clearInterval(peakTimer);
    for (const track of stream.getTracks()) track.stop();
    void audioCtx?.close().catch(() => {});
  };

  let interrupted: (() => void) | null = null;
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => interrupted?.());
  }

  // One piece at the end rather than timed slices: Safari's sliced MP4 is
  // fragmented, and nothing here needs audio before the recording is done.
  recorder.start();

  return {
    level,
    elapsedMs,
    onInterrupt: (fn) => {
      interrupted = fn;
    },
    stop: () =>
      new Promise<Recording>((resolve) => {
        endedAt ??= performance.now();
        const finish = () => {
          const meterWorked = !!analyser && sawSignal && audioCtx?.state === "running";
          release();
          resolve({
            blob: new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }),
            durationMs: elapsedMs(),
            heardSound: !meterWorked || peakDb > SPEECH_FLOOR_DB,
          });
        };
        if (recorder.state === "inactive") finish();
        else {
          recorder.addEventListener("stop", finish, { once: true });
          recorder.stop();
        }
      }),
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      chunks.length = 0;
      release();
    },
  };
}
