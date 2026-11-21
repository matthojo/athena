"""Float an app-card overlay (ProRes 4444 with alpha) above a tracked phone.
usage: composite.py bg.mp4 track.json overlay.mov out.mp4 start len ov_at card_w
  start/len: seconds of bg to use; ov_at: seconds into the shot the overlay begins;
  card_w: overlay width in output pixels."""
import json, subprocess, sys
import numpy as np

bg, trk, ov, out = sys.argv[1:5]
start, length, ov_at, card_w = float(sys.argv[5]), float(sys.argv[6]), float(sys.argv[7]), int(sys.argv[8])
FPS, W, H = 24, 1920, 1080
# Clip-time window where the phone is visible; outside it the card holds its last spot.
VALID = (float(sys.argv[9]), float(sys.argv[10])) if len(sys.argv) > 10 else (0.0, 1e9)
track = json.load(open(trk))
N = int(round(length * FPS))

def probe(path):
    o = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                        "stream=width,height", "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return [int(v) for v in o.strip().split(",")[:2]]

ow, oh = probe(ov)
card_h = int(round(oh * card_w / ow)) // 2 * 2
# Overlay frames, resampled to 24fps and scaled.
ovp = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-i", ov, "-vf",
                        f"fps={FPS},scale={card_w}:{card_h}:flags=lanczos,format=rgba",
                        "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
ov_frames = []
while True:
    b = ovp.stdout.read(card_w * card_h * 4)
    if len(b) < card_w * card_h * 4:
        break
    ov_frames.append(np.frombuffer(b, np.uint8).reshape(card_h, card_w, 4))

bgp = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-ss", str(start), "-i", bg, "-t", str(length),
                        "-vf", f"fps={FPS},scale={W}:{H},eq=contrast=1.03:saturation=0.95:gamma=1.02,format=rgb24",
                        "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
enc = subprocess.Popen(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                        "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow",
                        "-crf", "16", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)

yy, xx = np.mgrid[0:H, 0:W]
M = 48
for i in range(N):
    b = bgp.stdout.read(W * H * 3)
    if len(b) < W * H * 3:
        break
    frame = np.frombuffer(b, np.uint8).reshape(H, W, 3).astype(np.float32)
    t = i / FPS
    tt = min(max(start + t, VALID[0]), VALID[1])
    ti = min(len(track) - 1, int(round(tt * FPS)))
    cx, cy, pw, ph = track[ti]
    j = int(round((t - ov_at) * FPS))
    if 0 <= j < len(ov_frames):
        # Soft light on the phone as the card appears.
        g = max(0.0, 1 - abs(t - ov_at - 0.25) / 0.45)
        if g > 0:
            r2 = ((xx - cx) ** 2 + (yy - (cy - ph * 0.3)) ** 2) / (pw * 0.9) ** 2
            frame += (np.exp(-r2) * 70 * g)[..., None]
        # Card sits up and to the right of the phone, clamped inside the frame.
        x0 = int(cx + pw * 0.55)
        y0 = int(cy - ph * 0.35 - card_h)
        x0 = max(M, min(W - M - card_w, x0))
        y0 = max(M, min(H - M - card_h, y0))
        o = ov_frames[j].astype(np.float32)
        # If the shot ends before the overlay does, fade the card out over the last 0.3s.
        tail = min(1.0, (N - 1 - i) / (0.3 * FPS))
        a = o[..., 3:4] / 255.0 * tail
        roi = frame[y0:y0 + card_h, x0:x0 + card_w]
        frame[y0:y0 + card_h, x0:x0 + card_w] = roi * (1 - a) + o[..., :3] * a
    enc.stdin.write(np.clip(frame, 0, 255).astype(np.uint8).tobytes())
enc.stdin.close()
enc.wait()
print(out, N, "frames, overlay", len(ov_frames), "frames at", card_w, "x", card_h)
