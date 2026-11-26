/**
 * Talk's microphone tap (src/talk/mic.ts loads it with audioWorklet.addModule):
 * hands the input's samples to the page in blocks of 2048, off the main thread.
 *
 * A file of its own, served from Athena like the app's other files, so the
 * Content-Security-Policy (netlify.toml) needs no blob: for script. The
 * service worker keeps a copy and refreshes it in the background, so a device
 * may run the previous copy once after an update: the processor's name and
 * what it posts stay the same.
 */
class AthenaTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("athena-tap", AthenaTap);
