/**
 * Sound output for Talk and voice previews. iOS only lets a page make sound
 * after a tap, and only from an AudioContext started inside that tap, so
 * unlockAudio() must be called synchronously from the click handler, before
 * any await. One context is kept and reused: every tap after the first finds
 * it already running.
 *
 * iOS also routes sound to the quiet earpiece while the microphone is open.
 * Safari 17's Audio Session API says which mode we're in, so replies come
 * out of the speaker at full volume: "play-and-record" while listening,
 * "playback" while speaking, back to "auto" when Talk ends.
 */

let shared: AudioContext | null = null;

export function unlockAudio(): AudioContext | null {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!shared || shared.state === "closed") shared = new Ctx({ latencyHint: "interactive" });
  void shared.resume().catch(() => undefined);
  // A one-sample silent buffer, played inside the tap, is what fully unlocks output on older iOS.
  try {
    const src = shared.createBufferSource();
    src.buffer = shared.createBuffer(1, 1, shared.sampleRate);
    src.connect(shared.destination);
    src.start();
  } catch {
    // not fatal: resume() above is usually enough
  }
  return shared;
}

type SessionType = "auto" | "playback" | "play-and-record";

export function setAudioSession(type: SessionType): void {
  const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
  if (!session) return;
  try {
    session.type = type;
  } catch {
    // unsupported value on this version: leave it to the browser
  }
}
