/**
 * The microphone for Talk, as raw 16 kHz 16-bit PCM in ~100 ms pieces: what
 * ElevenLabs' realtime transcription takes. Web Audio does the capture (not
 * MediaRecorder, whose formats differ by browser and only arrive in blobs):
 * an AudioWorklet hands over samples off the main thread, falling back to a
 * ScriptProcessor where worklets aren't available, and they're averaged
 * down from the device rate (48 kHz on an iPhone) to 16 kHz here.
 *
 * Open only while listening: stop() releases the microphone (the iPhone's
 * orange dot goes out) and nothing is kept.
 */

import { MicError, type MicProblem } from "../lib/recorder";

export const MIC_RATE = 16_000;
/** 100 ms of audio at 16 kHz. */
const CHUNK = 1600;

export interface Mic {
  /** Input loudness right now, 0–1, for the orb. */
  level: () => number;
  /** Called with each ~100 ms of PCM. */
  onChunk: (fn: (pcm: Int16Array) => void) => void;
  /** Called if the microphone goes away (unplugged, another app took it). */
  onEnded: (fn: () => void) => void;
  stop: () => void;
}

/** The tap that hands samples over off the main thread: app/public/talk-worklet.js, a file of Athena's own (no blob: script). */
const WORKLET_URL = "/talk-worklet.js";
const loaded = new WeakSet<AudioContext>();

/** Box-filter downsampling: each output sample is the mean of the input samples it covers. */
export class Downsampler {
  private carry = new Float32Array(0);
  private pos = 0;
  constructor(private readonly ratio: number) {}

  push(input: Float32Array): Float32Array {
    const data = new Float32Array(this.carry.length + input.length);
    data.set(this.carry);
    data.set(input, this.carry.length);
    const out = new Float32Array(Math.max(0, Math.floor((data.length - this.pos) / this.ratio)));
    let pos = this.pos;
    let k = 0;
    while (k < out.length && pos + this.ratio <= data.length) {
      const start = Math.floor(pos);
      const end = Math.max(start + 1, Math.floor(pos + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += data[i];
      out[k++] = sum / (end - start);
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.carry = data.slice(keep);
    this.pos = pos - keep;
    return out.subarray(0, k);
  }
}

export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function problemOf(error: unknown): MicProblem {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "missing";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "unsupported";
}

export async function openMic(ctx: AudioContext): Promise<Mic> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (error) {
    throw new MicError(problemOf(error));
  }
  try {
    return await wire(ctx, stream);
  } catch {
    // Web Audio couldn't take the stream: let go of the microphone rather than leave it held.
    for (const track of stream.getTracks()) track.stop();
    throw new MicError("unsupported");
  }
}

/** Connect an open microphone to the level meter and the PCM tap. */
async function wire(ctx: AudioContext, stream: MediaStream): Promise<Mic> {
  void ctx.resume().catch(() => undefined);

  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  // Taps have to reach the destination to be pulled; a muted gain keeps them silent.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sink.connect(ctx.destination);

  const down = new Downsampler(ctx.sampleRate / MIC_RATE);
  let pending = new Int16Array(0);
  let chunkFn: ((pcm: Int16Array) => void) | null = null;
  let stopped = false;

  const take = (frame: Float32Array) => {
    if (stopped) return;
    const pcm = toPcm16(down.push(frame));
    const joined = new Int16Array(pending.length + pcm.length);
    joined.set(pending);
    joined.set(pcm, pending.length);
    let at = 0;
    while (joined.length - at >= CHUNK) {
      chunkFn?.(joined.slice(at, at + CHUNK));
      at += CHUNK;
    }
    pending = joined.slice(at);
  };

  let tap: AudioNode;
  try {
    if (!ctx.audioWorklet) throw new Error("no worklet");
    if (!loaded.has(ctx)) {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      loaded.add(ctx);
    }
    const node = new AudioWorkletNode(ctx, "athena-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => take(e.data);
    tap = node;
  } catch {
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => take(e.inputBuffer.getChannelData(0));
    tap = node;
  }
  source.connect(tap);
  tap.connect(sink);

  let endedFn: (() => void) | null = null;
  for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => !stopped && endedFn?.());

  return {
    level() {
      if (stopped) return 0;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      const db = 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-8);
      // -60 dB (a quiet room) to -14 dB (close, clear speech) fills it.
      return Math.min(1, Math.max(0, (db + 60) / 46));
    },
    onChunk(fn) {
      chunkFn = fn;
    },
    onEnded(fn) {
      endedFn = fn;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      chunkFn = null;
      if (tap instanceof AudioWorkletNode) tap.port.onmessage = null;
      else (tap as ScriptProcessorNode).onaudioprocess = null;
      for (const node of [source, analyser, tap, sink]) {
        try {
          node.disconnect();
        } catch {
          // already disconnected
        }
      }
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
