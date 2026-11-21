"""Shared numpy-only audio helpers for the cut 6 soundtrack (music.py, sfx.py, mix.py), and the acoustic
instrument models both music.py and sfx.py play (felt piano, kalimba, glockenspiel, celesta, marimba, wood,
Karplus-Strong ukulele and upright bass, felt kick, brushes, shaker, snaps)."""
import os
import wave
import numpy as np

SR = 48000
DEFAULT_FILM = "/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film6"


def film_dir():
    return os.environ.get("FILM", DEFAULT_FILM)


def audio_dir():
    d = os.path.join(film_dir(), "audio")
    os.makedirs(d, exist_ok=True)
    return d


def db(x):
    return 10.0 ** (x / 20.0)


def to_db(x):
    return 20.0 * np.log10(max(float(x), 1e-12))


def mtof(m):
    return 440.0 * 2.0 ** ((m - 69) / 12.0)


def rms_db(x):
    return to_db(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


# ---------------------------------------------------------------- wav io
def write_wav(path, x, bits=24):
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 1:
        x = np.stack([x, x], axis=1)
    x = np.clip(x, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(x.shape[1])
        w.setframerate(SR)
        if bits == 16:
            w.setsampwidth(2)
            w.writeframes(np.round(x * 32767.0).astype("<i2").tobytes())
        else:
            w.setsampwidth(3)
            v = np.round(x * 8388607.0).astype("<i4").reshape(-1)
            w.writeframes(v.view(np.uint8).reshape(-1, 4)[:, :3].tobytes())


def read_wav(path):
    with wave.open(path, "rb") as w:
        ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if sr != SR:
        raise ValueError(f"{path}: expected {SR} Hz, got {sr}")
    if sw == 2:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        a = np.zeros((b.shape[0], 4), dtype=np.uint8)
        a[:, :3] = b
        a[:, 3] = (b[:, 2] >> 7) * 255
        x = a.reshape(-1).view("<i4").astype(np.float64) / 8388608.0
    else:
        raise ValueError(f"{path}: unsupported sample width {sw}")
    x = x.reshape(-1, ch)
    if ch == 1:
        x = np.repeat(x, 2, axis=1)
    return x


# ---------------------------------------------------------------- filters (FFT domain, zero phase)
def g_lp(f, fc, order=2):
    return 1.0 / np.sqrt(1.0 + (f / fc) ** (2 * order))


def g_hp(f, fc, order=2):
    with np.errstate(divide="ignore"):
        r = np.where(f > 0, fc / np.maximum(f, 1e-9), np.inf)
    return 1.0 / np.sqrt(1.0 + r ** (2 * order))


def fft_filter(x, gain, pad=True):
    """Apply a real magnitude response gain(f) to x (n,) or (n,ch)."""
    n = x.shape[0]
    m = n * 2 if pad else n
    X = np.fft.rfft(x, n=m, axis=0)
    g = gain(np.fft.rfftfreq(m, 1.0 / SR))
    if x.ndim == 2:
        g = g[:, None]
    return np.fft.irfft(X * g, n=m, axis=0)[:n]


def edges(sig, attack=0.002, release=0.01):
    """Raised-cosine fade in/out so nothing starts or stops with a click."""
    sig = sig.copy()
    a = max(1, int(attack * SR))
    r = max(1, int(release * SR))
    a = min(a, len(sig))
    r = min(r, len(sig))
    wa = 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    wr = 0.5 + 0.5 * np.cos(np.pi * (np.arange(r) + 1) / r)
    if sig.ndim == 2:
        wa, wr = wa[:, None], wr[:, None]
    sig[:a] *= wa
    sig[-r:] *= wr
    return sig


def pan_gains(p):
    a = (np.clip(p, -1, 1) + 1.0) * np.pi / 4.0
    return np.cos(a), np.sin(a)


def band_db(x, lo=2000.0, hi=8000.0):
    """RMS level (dB) of the 2-8 kHz band a phone speaker plays best; for stereo, the louder of L and R (r2: a
    mono sum under-reads a bed that is mostly side reverb)."""
    y = fft_filter(x, lambda f: g_hp(f, lo, 4) * g_lp(f, hi, 4))
    return rms_db(y) if y.ndim == 1 else max(rms_db(y[:, 0]), rms_db(y[:, 1]))


def cue_gain(cue, sfx, bed):
    """A cue's gain in dB. {"gain": g} is fixed. {"over": d} is measured: the gain that puts the sound d dB over
    the music bed under it in 2-8 kHz (first 0.25 s), held within -6..+12 dB. So a cue that moves with the
    picture keeps its place in the mix whatever the music is doing there."""
    if "over" not in cue:
        return float(cue.get("gain", 0.0))
    n = min(len(sfx), len(bed), int(0.25 * SR))
    if n < 64:
        return float(cue.get("gain", 0.0))
    return float(np.clip(float(cue["over"]) - (band_db(sfx[:n]) - band_db(bed[:n])), -6.0, 12.0))


# ---------------------------------------------------------------- reverb / delay
def make_ir(rt60=1.4, seed=1, predelay=0.012, lo=250.0, hi=7500.0, split=2500.0, hi_factor=0.5):
    """Stereo synthetic room: decaying noise, highs decay faster, channels decorrelated."""
    rng = np.random.default_rng(seed)
    n = int(rt60 * 1.25 * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal((n, 2))
    low = fft_filter(noise, lambda f: g_lp(f, split, 2)) * np.exp(-6.908 * t / rt60)[:, None]
    high = fft_filter(noise, lambda f: g_hp(f, split, 2)) * np.exp(-6.908 * t / (rt60 * hi_factor))[:, None]
    ir = fft_filter(low + high, lambda f: g_hp(f, lo, 2) * g_lp(f, hi, 2))
    ir = edges(ir, 0.004, 0.05)
    ir = np.concatenate([np.zeros((int(predelay * SR), 2)), ir])
    ir /= np.sqrt(np.sum(ir ** 2, axis=0, keepdims=True))
    return ir


def convolve_reverb(x, ir):
    n = x.shape[0]
    m = 1
    while m < n + ir.shape[0]:
        m *= 2
    X = np.fft.rfft(x, n=m, axis=0)
    H = np.fft.rfft(ir, n=m, axis=0)
    return np.fft.irfft(X * H, n=m, axis=0)[:n]


def feedback_delay(x, time, fb=0.35, repeats=4, pingpong=True, lp=3500.0):
    """Wet-only feedback delay (sum of attenuated, shifted copies), optionally ping-pong."""
    d = int(round(time * SR))
    out = np.zeros_like(x, dtype=np.float64)
    for k in range(1, repeats + 1):
        s = k * d
        if s >= len(x):
            break
        src = x[:, ::-1] if (pingpong and k % 2 == 1) else x
        out[s:] += src[: len(x) - s] * (fb ** (k - 1))
    return fft_filter(out, lambda f: g_lp(f, lp, 1) * g_hp(f, 250.0, 1), pad=False)


# ---------------------------------------------------------------- dynamics / metering
def _sliding_min(x, w):
    """Centered sliding minimum over w samples."""
    r = x.copy()
    c = 1
    while 2 * c <= w:
        r[:-c] = np.minimum(r[:-c], r[c:])
        c *= 2
    if c < w:
        s = w - c
        r[:-s] = np.minimum(r[:-s], r[s:])
    h = w // 2
    out = np.empty_like(r)
    out[h:] = r[: len(r) - h]
    out[:h] = r[0]
    return out


def _boxcar(x, L):
    k = np.concatenate([[0.0], np.cumsum(x)])
    h = L // 2
    idx = np.arange(len(x))
    lo = np.clip(idx - h, 0, len(x))
    hi = np.clip(idx - h + L, 0, len(x))
    return (k[hi] - k[lo]) / np.maximum(hi - lo, 1)


def limiter(x, ceiling=db(-1.5), hold_ms=40.0, smooth_ms=10.0):
    """Look-ahead peak limiter: transparent gain riding, guaranteed |y| <= ceiling."""
    peak = np.max(np.abs(x), axis=1)
    g = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    W = int(hold_ms * 1e-3 * SR) | 1
    L = int(smooth_ms * 1e-3 * SR) | 1
    g = _sliding_min(g, W)
    g = _boxcar(_boxcar(g, L), L)
    y = x * g[:, None]
    return np.clip(y, -ceiling, ceiling), g


def lufs(x):
    """Integrated loudness, ITU-R BS.1770-4 (K-weighting applied in the frequency domain)."""
    n = x.shape[0]
    w = np.exp(-2j * np.pi * np.fft.rfftfreq(n, 1.0))

    def H(b, a):
        return (b[0] + b[1] * w + b[2] * w * w) / (a[0] + a[1] * w + a[2] * w * w)

    K = H([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]) * \
        H([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])
    y = np.fft.irfft(np.fft.rfft(x, axis=0) * K[:, None], n=n, axis=0)
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    cs = np.concatenate([np.zeros((1, y.shape[1])), np.cumsum(y * y, axis=0)])
    starts = np.arange(0, n - blk + 1, hop)
    z = ((cs[starts + blk] - cs[starts]) / blk).sum(axis=1)
    l = -0.691 + 10 * np.log10(np.maximum(z, 1e-12))
    z1 = z[l > -70.0]
    if len(z1) == 0:
        return -70.0
    rel = -0.691 + 10 * np.log10(np.mean(z1)) - 10.0
    z2 = z[(l > -70.0) & (l > rel)]
    return float(-0.691 + 10 * np.log10(np.mean(z2)))


def true_peak_db(x, os_factor=4):
    """Inter-sample peak estimate via FFT oversampling."""
    n = x.shape[0]
    pk = 0.0
    for c in range(x.shape[1]):
        X = np.fft.rfft(x[:, c])
        Y = np.zeros(n * os_factor // 2 + 1, dtype=complex)
        Y[: len(X)] = X
        pk = max(pk, float(np.max(np.abs(np.fft.irfft(Y, n=n * os_factor)))) * os_factor)
    return to_db(pk)


LAST_GR = None      # the limiter's gain curve from the last master() call (for reports)


def master(bus, target_lufs=-15.0, ceiling_db=-1.5, tp_limit_db=-1.6, verbose=True):
    """Gain into a look-ahead limiter until integrated loudness hits the target; keep true peak under limit."""
    g = db(target_lufs - lufs(bus))
    ceil = ceiling_db
    y = bus
    for _ in range(3):
        for _ in range(4):
            y, gr = limiter(bus * g, db(ceil))
            L = lufs(y)
            if abs(L - target_lufs) < 0.03:
                break
            g *= db(target_lufs - L)
        tp = true_peak_db(y)
        if tp <= tp_limit_db - 0.05:
            break
        ceil -= (tp - (tp_limit_db - 0.15))
    global LAST_GR
    LAST_GR = gr
    if verbose:
        sec = [-to_db(gr[i:i + 6 * SR].min()) for i in range(0, len(gr), 6 * SR)]
        print("  master: max gain reduction per 6 s block (dB): " + " ".join(f"{v:.1f}" for v in sec))
        print(f"  master: gain {to_db(g):+.2f} dB, limiter ceiling {ceil:.2f} dBFS, max gain reduction "
              f"{-to_db(gr.min()):.2f} dB at {np.argmin(gr) / SR:.2f}s, limiting {100 * np.mean(gr < 0.999):.1f}% of samples")
        print(f"  master: {L:.2f} LUFS integrated, sample peak {to_db(np.max(np.abs(y))):.2f} dBFS, true peak {tp:.2f} dBTP")
    return y


# ================================================================ acoustic instrument models (cut 6)
# Everything below imitates a real, played instrument: struck bars with their own inharmonic partials, a felt
# piano with stretched partials and beating unison strings, plucked strings by Karplus-Strong. Each returns a
# mono float64 array that starts on its onset (no lead-in) and ends at silence.
def _t(dur):
    n = max(1, int(round(dur * SR)))
    return n, np.arange(n) / SR


def _nz(n, seed):
    return np.random.default_rng(seed).standard_normal(n)


def struck_bar(f, dur, ratios, amps, taus, attack=0.0015, bend=0.0, seed=0, thump=0.0, thump_lp=900.0):
    """A struck or plucked bar / tine / plate: a sum of decaying partials at its own (inharmonic) ratios.
    attack: the mallet's or thumb's contact time (a raised-cosine rise; felt is slow, metal is fast).
    bend: the note starts this fraction sharp and settles in 30 ms (a tine bending as it is let go).
    thump: a little low-passed noise for the contact itself (a thumb, a felt mallet)."""
    n, t = _t(dur)
    out = np.zeros(n)
    fb = 1.0 + bend * np.exp(-t / 0.03)
    for r, a, tau in zip(ratios, amps, taus):
        fk = f * r
        if fk > 15000.0 or a == 0:
            continue
        ph = 2 * np.pi * np.cumsum(fk * fb) / SR
        out += a * np.sin(ph) * np.exp(-t / tau)
    if thump:
        th = fft_filter(_nz(n, 400 + seed), lambda fr: g_lp(fr, thump_lp, 2)) * np.exp(-t / 0.004)
        out += thump * th / (np.max(np.abs(th[: int(0.01 * SR) + 1])) + 1e-9)
    a = max(2, int(attack * SR))
    out[:a] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    return edges(out, 0.0002, min(0.15, dur * 0.3))


def kalimba(midi, dur=1.4, vel=1.0, seed=0):
    """Kalimba: a steel tine plucked by a thumb. Clamped-free tine partials (1 : 6.27 : 17.5) whose overtones
    die in tens of ms, a few cents' bend as the tine is released, a soft thumb thump, a ~3 ms rise (skin, not a
    plectrum). The fundamental rings longer on low tines."""
    f = mtof(midi)
    tau = 0.6 * (523.0 / f) ** 0.45
    return struck_bar(f, dur, (1.0, 2.0, 6.27, 17.5), (1.0, 0.05, 0.22 * vel, 0.05 * vel),
                      (tau, tau * 0.25, 0.045, 0.012), attack=0.0028, bend=0.004, seed=seed, thump=0.10 * vel)


def glock(midi, dur=1.6, vel=1.0, seed=0):
    """Glockenspiel with soft (rubber) mallets: free-free bar partials 1 : 2.76 : 5.40 : 8.93, long fundamental,
    the upper modes gone in a few tenths; a 1.2 ms contact."""
    f = mtof(midi)
    tau = 1.1 * (1047.0 / f) ** 0.3
    return struck_bar(f, dur, (1.0, 2.76, 5.40, 8.93), (1.0, 0.28 * vel, 0.10 * vel, 0.04 * vel),
                      (tau, 0.28, 0.08, 0.03), attack=0.0012, seed=seed)


def celesta(midi, dur=1.6, vel=1.0, seed=0):
    """Celesta: felt hammers on steel plates over wooden resonators, so rounder than the glockenspiel: a strong
    fundamental, a quiet octave, a short 4.1x 'ping' at the strike and a 4 ms felt contact."""
    f = mtof(midi)
    tau = 0.8 * (1047.0 / f) ** 0.4
    return struck_bar(f, dur, (1.0, 2.0, 3.0, 4.1), (1.0, 0.10, 0.03, 0.10 * vel),
                      (tau, tau * 0.4, tau * 0.2, 0.035), attack=0.004, seed=seed, thump=0.04, thump_lp=1500.0)


def marimba(midi, dur=0.6, vel=1.0, seed=0):
    """Marimba with soft yarn mallets: a rosewood bar tuned so its 2nd mode is two octaves up (1 : 3.93 : 9.2),
    the tube resonator holding the fundamental a little longer; quick decay, a felt contact of ~2.5 ms."""
    f = mtof(midi)
    tau = 0.35 * (440.0 / f) ** 0.6
    return struck_bar(f, dur, (1.0, 3.93, 9.2), (1.0, 0.20 * vel, 0.05 * vel), (tau, 0.035, 0.010),
                      attack=0.0025, seed=seed, thump=0.06 * vel, thump_lp=1200.0)


def wood(f, dur=0.09, vel=1.0, seed=0):
    """Woodblock / temple block 'tock': a hollow block's two low modes (1 : 1.53 : 2.31) gone in ~25 ms, over a
    2 ms stick click. f is its pitch (the block's size)."""
    n, t = _t(dur)
    out = struck_bar(f, dur, (1.0, 1.53, 2.31), (1.0, 0.45, 0.18), (0.022, 0.012, 0.008), attack=0.0008, seed=seed)
    ck = fft_filter(_nz(n, 410 + seed), lambda fr: g_hp(fr, 1500.0, 2) * g_lp(fr, 6000.0, 2)) * np.exp(-t / 0.0015)
    return edges(out + 0.25 * vel * ck / (np.max(np.abs(ck)) + 1e-9), 0.0003, 0.02)


def felt_piano(midi, dur=1.5, vel=0.7, seed=0, release=0.12):
    """Soft felt piano ("una corda" with a felt strip): partials stretched by string stiffness
    f_k = k f sqrt(1 + B k^2); a felt hammer's spectrum (highs rolled off, more so when played softly); each
    partial with a fast 'prompt' decay and a slow aftersound; three unison strings a cent apart, so the tone
    beats slowly; a 5 ms rise and a low felt thump; the damper comes down over `release` s at the end."""
    f = mtof(midi)
    n, t = _t(dur)
    B = 0.00025 * (f / 261.6) ** 0.7
    fc = 600.0 + 1200.0 * vel
    tau1 = 0.9 * (261.6 / f) ** 0.55
    rng = np.random.default_rng(int(midi) * 7 + seed)
    out = np.zeros(n)
    for k in range(1, 30):
        fk = k * f * np.sqrt(1 + B * k * k)
        if fk > 9000.0:
            break
        a = (1.0 / k ** 0.9) / (1.0 + (fk / fc) ** 3)
        if a < 1e-3:
            continue
        tp = tau1 / (1.0 + 0.7 * (k - 1))
        env = 0.75 * np.exp(-t / tp) + 0.25 * np.exp(-t / (tp * 5.0))
        beat = 1.0 - 0.18 * (1 - np.cos(2 * np.pi * (0.4 + 0.25 * k) * t + rng.uniform(0, 6.28)))
        out += a * env * beat * np.sin(2 * np.pi * fk * t + rng.uniform(0, 6.28))
    th = fft_filter(_nz(n, 420 + seed), lambda fr: g_lp(fr, 350.0, 2)) * np.exp(-t / 0.012)
    out += 0.05 * th / (np.std(th[: int(0.02 * SR)]) * 3 + 1e-9)
    a = int(0.005 * SR)
    out[:a] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    return edges(out, 0.0002, min(release, dur * 0.4))


def ks_string(f, dur, t60=1.5, soft=1, pluck_pos=0.18, exc_lp=3000.0, seed=0):
    """Karplus-Strong plucked string, block-vectorised (the loop runs once per period, not per sample).
    The loop filter is a 2- or 3-tap average (soft=1: [.25 .5 .25], a nylon/gut string; soft=0: [.5 .5]) convolved
    with a linear fractional delay so the pitch is exact; a loss per period sets the decay (t60, seconds to
    -60 dB at the fundamental). The excitation is a burst of low-passed noise with a pluck-position comb
    (a finger plucking 18% along the string: no harsh pick)."""
    P = SR / f
    kernel = np.array([0.25, 0.5, 0.25]) if soft else np.array([0.5, 0.5])
    kd = (len(kernel) - 1) / 2.0
    L = int(np.floor(P - kd))
    w = P - kd - L
    taps = np.convolve(kernel, [1.0 - w, w])
    g = 10.0 ** (-3.0 / (t60 * f))
    n = int(round(dur * SR))
    O = len(taps) + 1
    y = np.zeros(n + O + L)
    rng = np.random.default_rng(seed)
    e = rng.standard_normal(L * 3)
    e = fft_filter(e, lambda fr: g_lp(fr, exc_lp, 2))[L:2 * L]
    e = e - np.roll(e, int(round(pluck_pos * L)))
    e -= e.mean()
    y[O:O + L] = e / (np.max(np.abs(e)) + 1e-9)
    s = O + L
    while s < O + n:
        m = min(L, O + n - s)
        acc = np.zeros(m)
        for j, a in enumerate(taps):
            acc += a * y[s - L - j:s - L - j + m]
        y[s:s + m] = g * acc
        s += m
    out = y[O:O + n]
    return out


def body_filter(x, modes, seed=0):
    """A wooden body: the string's signal plus a few damped resonances (Hz, gain, decay s) excited by it."""
    n_ir = int(0.12 * SR)
    t = np.arange(n_ir) / SR
    ir = np.zeros(n_ir)
    ir[0] = 1.0
    for fr, gn, tau in modes:
        ir += gn * np.sin(2 * np.pi * fr * t) * np.exp(-t / tau) * (2 * np.pi * fr / SR)
    from scipy.signal import fftconvolve
    return fftconvolve(x, ir)[: len(x)]


UKE_STRINGS = (67, 60, 64, 69)        # G4 C4 E4 A4, re-entrant tuning
UKE_BODY = ((260.0, 9.0, 0.020), (440.0, 6.0, 0.012), (610.0, 4.0, 0.010), (1050.0, 2.0, 0.006))


def uke_string(midi, dur=1.2, vel=0.8, seed=0):
    """One ukulele string: nylon Karplus-Strong (soft loop filter, a finger's low-passed pluck) through a small
    spruce body (resonances at 260, 440, 610, 1050 Hz)."""
    f = mtof(midi)
    x = ks_string(f, dur, t60=1.1 * (330.0 / f) ** 0.3, soft=1, pluck_pos=0.2, exc_lp=1800.0 + 2200.0 * vel, seed=seed)
    y = body_filter(x, UKE_BODY) * 0.5 + 0.5 * x
    return edges(y, 0.0015, min(0.06, dur * 0.3))


def upright_bass(midi, dur=0.8, vel=0.8, seed=0):
    """Plucked upright (or acoustic) bass: a gut-like Karplus-Strong string with a very soft, low-passed finger
    pluck, a woody body (110 / 210 / 330 Hz) and a short finger 'thup'; the hand mutes it at `dur`."""
    f = mtof(midi)
    n, t = _t(dur)
    x = ks_string(f, dur, t60=1.6, soft=1, pluck_pos=0.25, exc_lp=450.0 + 300.0 * vel, seed=seed)
    y = 0.6 * x + 0.4 * body_filter(x, ((110.0, 6.0, 0.03), (210.0, 5.0, 0.02), (330.0, 3.0, 0.012)))
    thup = fft_filter(_nz(n, 430 + seed), lambda fr: g_lp(fr, 500.0, 2) * g_hp(fr, 60.0, 1)) * np.exp(-t / 0.008)
    y += 0.12 * vel * thup / (np.max(np.abs(thup)) + 1e-9) * np.max(np.abs(y[: int(0.05 * SR)]) + 1e-9)
    return edges(y, 0.002, min(0.05, dur * 0.3))


def felt_kick(vel=1.0, short=False):
    """A concert bass drum hit with a felt beater, close and small: the head's modes (1 : 1.59 : 2.14) around
    55 Hz with a slight pitch drop, a 4 ms felt contact (no click), a woody shell knock at 150 Hz. Round, no
    808 boom: 0.25 s (0.11 s for rolls)."""
    dur = 0.11 if short else 0.28
    n, t = _t(dur)
    f = 55.0 * (1.0 + 0.25 * np.exp(-t / 0.02))
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = (np.sin(ph) * np.exp(-t / (0.05 if short else 0.11)) + 0.30 * np.sin(1.59 * ph) * np.exp(-t / 0.05)
            + 0.15 * np.sin(2.14 * ph) * np.exp(-t / 0.03))
    knock = np.sin(2 * np.pi * 150.0 * t) * np.exp(-t / 0.018) * 0.25
    felt = fft_filter(_nz(n, 440), lambda fr: g_lp(fr, 700.0, 2)) * np.exp(-t / 0.006)
    out = body + knock + 0.12 * vel * felt / (np.max(np.abs(felt)) + 1e-9)
    a = int(0.004 * SR)
    out[:a] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    return edges(out * vel, 0.0002, 0.03)


def low_tom(midi=45, vel=1.0):
    """A soft floor tom hit with a felt mallet: modes 1 : 1.5 : 1.98 with a little pitch drop, ~0.3 s."""
    n, t = _t(0.35)
    f = mtof(midi) * (1.0 + 0.12 * np.exp(-t / 0.03))
    ph = 2 * np.pi * np.cumsum(f) / SR
    out = np.sin(ph) * np.exp(-t / 0.14) + 0.35 * np.sin(1.5 * ph) * np.exp(-t / 0.06) + 0.18 * np.sin(1.98 * ph) * np.exp(-t / 0.04)
    a = int(0.003 * SR)
    out[:a] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    return edges(out * vel, 0.0002, 0.04)


def brush_tap(var=0, dur=0.22):
    """A brushed snare backbeat: hundreds of wires landing over ~5 ms (a softened noise attack), a breathy
    1-8 kHz splash that decays over ~0.1 s, the snares under it, and a faint 190 Hz drum body. Stereo."""
    n, t = _t(dur)
    rng = np.random.default_rng(450 + var)
    nz = fft_filter(rng.standard_normal((n, 2)), lambda fr: g_hp(fr, 900.0, 2) * g_lp(fr, 7500.0, 2))
    env = (1 - np.exp(-t / 0.0025)) * (np.exp(-t / 0.035) + 0.25 * np.exp(-t / 0.12))
    body = np.sin(2 * np.pi * (190.0 + 10 * var) * t) * np.exp(-t / 0.03) * 0.25
    common = nz.mean(axis=1, keepdims=True)
    sig = (0.6 * common + 0.5 * nz) * env[:, None] / 2.0 + body[:, None]
    return edges(sig, 0.0005, 0.03)


def brush_swish(dur=0.5, seed=0):
    """A brush swept across the head (the jazz circle): a soft band of noise that rises and falls over `dur`,
    its centre drifting with the stroke. Stereo, very breathy."""
    n, t = _t(dur)
    rng = np.random.default_rng(460 + seed)
    nz = fft_filter(rng.standard_normal((n, 2)), lambda fr: g_hp(fr, 1800.0, 2) * g_lp(fr, 6500.0, 2))
    x = t / dur
    env = np.sin(np.pi * x) ** 1.5 * (0.7 + 0.3 * np.sin(2 * np.pi * x))
    return edges(nz * env[:, None] / 2.0, 0.003, 0.02)


def shaker_hit(var=0, vel=1.0):
    """An egg shaker: beads hitting the shell as a burst of tiny grains (sparse impulses, 3-9 kHz), a soft
    ~8 ms rise and ~40 ms fall. Stereo."""
    n, t = _t(0.12)
    rng = np.random.default_rng(470 + var)
    grains = (rng.random((n, 2)) < 0.25) * rng.standard_normal((n, 2))
    nz = fft_filter(grains, lambda fr: g_hp(fr, 3000.0, 3) * g_lp(fr, 9000.0, 2))
    env = (1 - np.exp(-t / 0.008)) * np.exp(-t / 0.030)
    return edges(nz * env[:, None] * vel, 0.002, 0.02)


def finger_snap(var=0):
    """A finger snap: the finger hitting the palm, a short 1.4-3.5 kHz pop with a little skin resonance, gone in
    ~30 ms. Stereo."""
    n, t = _t(0.08)
    rng = np.random.default_rng(480 + var)
    nz = fft_filter(rng.standard_normal((n, 2)), lambda fr: g_hp(fr, 1200.0, 2) * g_lp(fr, 3600.0, 2))
    env = np.exp(-t / 0.006) + 0.15 * np.exp(-t / 0.02)
    tone = np.sin(2 * np.pi * (1850.0 + 70 * var) * t) * np.exp(-t / 0.008) * 0.6
    common = nz.mean(axis=1, keepdims=True)
    sig = (0.8 * common + 0.3 * nz) * env[:, None] / 2.5 + tone[:, None] * 0.5
    return edges(sig, 0.0006, 0.02)


def soft_clap(var=0):
    """A soft hand clap (cupped hands): three skin bursts 9 ms apart, then a short room, all under 4 kHz."""
    n, t = _t(0.2)
    rng = np.random.default_rng(490 + var)
    nz = fft_filter(rng.standard_normal((n, 2)), lambda fr: g_hp(fr, 600.0, 2) * g_lp(fr, 3800.0, 2))
    env = np.zeros(n)
    for d in (0.0, 0.009, 0.019):
        i = int(d * SR)
        env[i:] += np.exp(-t[: n - i] / 0.005)
    i = int(0.026 * SR)
    env[i:] += 0.5 * np.exp(-t[: n - i] / 0.04)
    common = nz.mean(axis=1, keepdims=True)
    return edges((0.6 * common + 0.5 * nz) * env[:, None] / 2.5, 0.0008, 0.03)


def mark_tree(n_bars=9, dur=1.4, down=True, seed=0):
    """A mark tree (bar chimes) brushed by a finger: n small brass rods, each a glassy inharmonic ping, 22 ms
    apart, high to low. A sparkle, not a cymbal. Stereo."""
    rng = np.random.default_rng(500 + seed)
    nn, _ = _t(dur)
    out = np.zeros((nn, 2))
    fr = np.geomspace(6200.0, 2600.0, n_bars) if down else np.geomspace(2600.0, 6200.0, n_bars)
    for j, f in enumerate(fr):
        f *= 1.0 + rng.uniform(-0.01, 0.01)
        s = struck_bar(f, dur - 0.022 * j, (1.0, 2.76, 5.4), (1.0, 0.2, 0.05), (0.45, 0.1, 0.03), attack=0.0006)
        i = int(0.022 * j * SR)
        p = -0.6 + 1.2 * j / max(1, n_bars - 1)
        l, r = pan_gains(p)
        out[i:i + len(s), 0] += s * l * (0.9 ** j)
        out[i:i + len(s), 1] += s * r * (0.9 ** j)
    return edges(out, 0.0005, 0.1)


def breath_air(dur, f0=500.0, f1=3000.0, seed=0, shape=2.0):
    """Soft breathy air (a long exhale): noise through a gentle band whose centre glides f0 -> f1, the band
    wide and the slopes shallow so it never whistles; swells by t^shape and ends on its last sample. Stereo."""
    n, t = _t(dur)
    rng = np.random.default_rng(510 + seed)
    nz = rng.standard_normal((n, 2))
    X = np.fft.rfft(nz, axis=0)
    fr = np.fft.rfftfreq(n, 1.0 / SR)
    # time-varying band done in a few overlapping segments (cheap, no sweep artefacts at this softness)
    out = np.zeros((n, 2))
    segs = 8
    for s in range(segs):
        c = f0 * (f1 / f0) ** ((s + 0.5) / segs)
        g = g_hp(fr, c * 0.55, 1) * g_lp(fr, c * 1.6, 2)
        y = np.fft.irfft(X * g[:, None], n=n, axis=0)
        w = np.clip(1 - np.abs((t / dur) * segs - (s + 0.5)), 0, 1)
        out += y * w[:, None]
    env = (t / dur) ** shape
    return edges(out * env[:, None], 0.01, 0.02)


def reed_chord(notes, dur, bright=1.0, seed=0):
    """A small harmonium / reed organ, played softly: each note two free reeds (a few cents apart), the reed's
    full harmonic series rolled off above ~1.6 kHz by the cabinet, a bellows swell (0.18 s), a slight bellows
    wobble and a little wind noise. Stereo (one reed per side mostly)."""
    n, t = _t(dur)
    rng = np.random.default_rng(520 + seed)
    out = np.zeros((n, 2))
    fc = 1300.0 * bright
    wob = 1.0 + 0.025 * np.sin(2 * np.pi * 4.6 * t + rng.uniform(0, 6.28))
    for m in notes:
        for ch, det in ((0, -3.0), (1, 3.0)):
            f = mtof(m) * 2 ** (det / 1200.0)
            kmax = max(1, min(18, int(6000.0 / f)))
            for k in range(1, kmax + 1):
                a = (1.0 / k ** 0.8) / (1.0 + (k * f / fc) ** 3)
                out[:, ch] += a * np.sin(2 * np.pi * f * k * t + rng.uniform(0, 6.28))
    out /= max(1, len(notes))
    wind = fft_filter(rng.standard_normal((n, 2)), lambda fr: g_hp(fr, 800.0, 1) * g_lp(fr, 3000.0, 2)) * 0.01
    sw = np.sin(0.5 * np.pi * np.clip(t / 0.18, 0, 1)) ** 2
    return edges((out + wind) * (sw * wob)[:, None], 0.002, min(0.2, dur * 0.3))
