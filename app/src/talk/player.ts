/**
 * Plays Athena's spoken reply as it streams in: raw 16-bit PCM from
 * /api/talk/speak, turned into short AudioBuffers and scheduled back to back
 * on the AudioContext that was unlocked by the tap that started Talk. (Not an
 * <audio> element: it can't send the API's bearer token, and iOS won't play
 * one that starts without a tap.)
 *
 * stop() is barge-in: everything scheduled stops at once and the download is
 * cancelled. level() follows the output for the orb.
 */

export interface Playback {
  /** Resolves when the last sound has played, or straight away after stop(). */
  done: Promise<void>;
  stop: () => void;
  level: () => number;
}

/** About 100 ms per buffer at 24 kHz: few enough nodes, small enough to start fast. */
const MIN_SAMPLES = 2400;
/** A little headroom before the first sound so a slow second chunk doesn't stutter. */
const LEAD_S = 0.12;

export function playPcmStream(ctx: AudioContext, body: ReadableStream<Uint8Array>, sampleRate: number): Playback {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(ctx.destination);
  const levels = new Float32Array(analyser.fftSize);
  const sources = new Set<AudioBufferSourceNode>();
  const reader = body.getReader();
  let nextAt = 0;
  let stopped = false;
  let streamDone = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const maybeFinish = () => {
    if ((streamDone && sources.size === 0) || stopped) {
      try {
        analyser.disconnect();
      } catch {
        // already
      }
      resolveDone();
    }
  };

  const schedule = (pcm: Int16Array) => {
    if (stopped || !pcm.length) return;
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser);
    // Ran dry (a slow network moment): start again just ahead rather than in the past.
    if (nextAt < ctx.currentTime + 0.02) nextAt = ctx.currentTime + (sources.size ? 0.02 : LEAD_S);
    src.start(nextAt);
    nextAt += buffer.duration;
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      maybeFinish();
    };
  };

  void (async () => {
    let carry = new Uint8Array(0);
    let pending: Int16Array[] = [];
    let pendingLen = 0;
    const flush = () => {
      if (!pendingLen) return;
      const joined = new Int16Array(pendingLen);
      let at = 0;
      for (const p of pending) {
        joined.set(p, at);
        at += p.length;
      }
      pending = [];
      pendingLen = 0;
      schedule(joined);
    };
    try {
      void ctx.resume().catch(() => undefined);
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end || stopped) break;
        if (!value?.length) continue;
        // Samples are two bytes; a chunk can end half-way through one.
        const bytes = new Uint8Array(carry.length + value.length);
        bytes.set(carry);
        bytes.set(value, carry.length);
        const whole = bytes.length - (bytes.length % 2);
        carry = bytes.slice(whole);
        const view = new DataView(bytes.buffer, 0, whole);
        const pcm = new Int16Array(whole / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
        pending.push(pcm);
        pendingLen += pcm.length;
        if (pendingLen >= MIN_SAMPLES) flush();
      }
      flush();
    } catch {
      // The connection dropped mid-reply: play what arrived.
    } finally {
      streamDone = true;
      maybeFinish();
    }
  })();

  return {
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      void reader.cancel().catch(() => undefined);
      for (const src of sources) {
        try {
          src.stop();
        } catch {
          // not started yet
        }
      }
      sources.clear();
      maybeFinish();
    },
    level() {
      if (stopped || !sources.size) return 0;
      analyser.getFloatTimeDomainData(levels);
      let sum = 0;
      for (const s of levels) sum += s * s;
      const db = 20 * Math.log10(Math.sqrt(sum / levels.length) || 1e-8);
      return Math.min(1, Math.max(0, (db + 50) / 40));
    },
  };
}
