"""Track the phone in a clip with CSRT, forwards and backwards from a seed frame.
usage: track.py clip.mp4 seed_seconds x y w h out.json
Writes per-frame phone boxes (smoothed) as [[cx, cy, w, h], ...] at the clip frame rate."""
import json, sys
import cv2
import numpy as np

clip, t0, x, y, w, h, out = sys.argv[1], float(sys.argv[2]), *map(int, sys.argv[3:7]), sys.argv[7]
cap = cv2.VideoCapture(clip)
frames = []
while True:
    ok, f = cap.read()
    if not ok:
        break
    frames.append(f)
n = len(frames)
fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
seed = min(n - 1, int(round(t0 * fps)))

def run(order):
    tr = cv2.TrackerCSRT_create()
    tr.init(frames[order[0]], (x, y, w, h))
    res = {order[0]: (x, y, w, h)}
    last = (x, y, w, h)
    for i in order[1:]:
        ok, b = tr.update(frames[i])
        if ok:
            last = b
        res[i] = last
    return res

boxes = {}
boxes.update(run(list(range(seed, n))))
boxes.update(run(list(range(seed, -1, -1))))
arr = np.array([[b[0] + b[2] / 2, b[1] + b[3] / 2, b[2], b[3]] for _, b in sorted(boxes.items())], float)
# Smooth: centred moving average over ~0.5s, edges padded.
k = int(fps * 0.5)
pad = np.pad(arr, ((k, k), (0, 0)), mode="edge")
ker = np.ones(2 * k + 1) / (2 * k + 1)
sm = np.stack([np.convolve(pad[:, j], ker, mode="valid") for j in range(4)], axis=1)
json.dump(sm.round(1).tolist(), open(out, "w"))
print(clip, n, "frames; start", sm[0].round(0).tolist(), "seed", sm[seed].round(0).tolist(), "end", sm[-1].round(0).tolist())
