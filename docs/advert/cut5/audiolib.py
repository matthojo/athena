"""Shared numpy-only audio helpers for the cut 5 soundtrack (music.py, sfx.py, mix.py)."""
import os
import wave
import numpy as np

SR = 48000
DEFAULT_FILM = "/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film5"


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


def master(bus, target_lufs=-14.0, ceiling_db=-1.5, tp_limit_db=-1.0, verbose=True):
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
