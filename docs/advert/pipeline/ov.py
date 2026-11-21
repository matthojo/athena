# Builds transparent AR card overlays (ProRes 4444 with alpha) from the ovcap/ captures.
import json, os, sys, glob, subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops
D = os.path.dirname(os.path.abspath(__file__)); CAP = D + '/ovcap/'; OUT = D + '/ov/'
FPS = 30
PAD, RISE = 90, 40
SH_BLUR, SH_ALPHA, SH_DY = 15, 0.18, 12   # ~30px blur (sigma 15), 18% black, 12px down
os.makedirs(OUT, exist_ok=True)

def ease_out(k): return 1 - (1 - k) ** 3
def load(path): return Image.open(path).convert('RGBA')

def rounded_mask(size, r):
    m = Image.new('L', size, 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0]-1, size[1]-1], radius=r, fill=255); return m

def crop_masked(img, box, r):
    """Crop an opaque region inside a card and give it the card's rounded corners."""
    c = img.crop(box); a = ImageChops.multiply(c.getchannel('A'), rounded_mask(c.size, r)); c.putalpha(a); return c

def crop_alpha(img, box=None):
    c = img.crop(box) if box else img
    return c

def stroke_and_shadow(content):
    """content RGBA -> RGBA with 1px-ish white inner stroke (60%) and a soft drop shadow, same size."""
    a = content.getchannel('A')
    inner = a.filter(ImageFilter.MinFilter(5))                     # ~2px erosion at 3x
    ring = ImageChops.subtract(a, inner).point(lambda v: int(v * 0.6))
    white = Image.new('RGBA', content.size, (255, 255, 255, 0)); white.putalpha(ring)
    lit = Image.alpha_composite(content, white)
    sh = a.point(lambda v: int(v * SH_ALPHA)).filter(ImageFilter.GaussianBlur(SH_BLUR))
    sh2 = Image.new('L', sh.size, 0); sh2.paste(sh.crop((0, 0, sh.width, sh.height - SH_DY)), (0, SH_DY)); sh = sh2
    shadow = Image.new('RGBA', content.size, (0, 0, 0, 0)); shadow.putalpha(sh)
    return Image.alpha_composite(shadow, lit)

def place(canvas_size, content, anchor='center', top=None):
    W, H = canvas_size; L = Image.new('RGBA', canvas_size, (0, 0, 0, 0))
    x = (W - content.width) // 2
    y = (H - RISE - content.height) // 2 if anchor == 'center' else top
    L.paste(content, (x, y)); return L

def transform(L, t, dur):
    """Entrance: rise 40px, scale .94->1, opacity 0->1 over .5s ease-out. Exit: .3s fade."""
    k = ease_out(min(1, t / 0.5)); s = 0.94 + 0.06 * k; dy = RISE * (1 - k)
    op = k * (1 - min(1, max(0, (t - (dur - 0.3)) / 0.3)))
    W, H = L.size; cx, cy = W / 2, (H - RISE) / 2
    a = 1 / s
    out = L.transform(L.size, Image.AFFINE, (a, 0, cx - cx * a, 0, a, cy - (cy + dy) * a), resample=Image.BICUBIC)
    if op < 1: out.putalpha(out.getchannel('A').point(lambda v: int(v * op)))
    return out

def write(name, dur, size, content_at, anchor='center', top=None):
    W, H = size; W += W % 2; H += H % 2
    ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                           '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', OUT + name + '.mov'], stdin=subprocess.PIPE)
    n = int(round(dur * FPS)); last_key = None; last = None; mids = {}
    for i in range(n):
        t = i / FPS
        key, content = content_at(t)
        if key != last_key:
            last = None if content is None else stroke_and_shadow(place((W, H), content, anchor, top))
            last_key = key
        frame = Image.new('RGBA', (W, H), (0, 0, 0, 0)) if last is None else transform(last, t, dur)
        if i == n // 2: frame.save(OUT + f'.{name}-mid.png')
        ff.stdin.write(frame.tobytes())
    ff.stdin.close(); ff.wait(); print(name, f'{W}x{H}', n, 'frames')

def seq(name): return sorted(glob.glob(CAP + name + '/*.png'))
def meta(name): return json.load(open(CAP + name + '/meta.json'))
which = sys.argv[1:]; want = lambda n: not which or n in which
S = 3  # px per css px

if want('o1'):
    f = seq('o1'); m = meta('o1'); cy = m['clip']['y']; cd = m['frames'][-1]['card']
    bb = tuple(int(round(v * S)) for v in (cd[0], cd[1] - cy, cd[0] + cd[2], cd[1] + cd[3] - cy))
    c0 = load(f[-1]).crop(bb)
    def at(t):
        i = min(len(f) - 1, int(t * FPS)); c = load(f[i]).crop(bb)
        c.putalpha(ImageChops.multiply(c.getchannel('A'), rounded_mask(c.size, 24 * S))); return (i, c)
    write('o1', 8, (c0.width + 2 * PAD, c0.height + 2 * PAD + RISE), at)

if want('o2'):
    f = seq('o2'); m = meta('o2'); cy = m['clip']['y']
    leg = m['frames'][-1]['leg']; ref = m['frames'][-1]['ref']; card = m['frames'][-1]['card']
    x0, x1 = card[0], card[0] + card[2]
    y0, y1 = leg[1] - 1, ref[1] + ref[3] + 16
    box = tuple(int(round(v * S)) for v in (x0, y0 - cy, x1, y1 - cy))
    TOP = 14 * S
    def at(t):
        i = min(len(f) - 1, int(t * FPS)); c = load(f[i]).crop(box)
        surf = c.getpixel((c.width - 20, 2))
        P = Image.new('RGBA', (c.width, c.height + TOP), surf); P.paste(c, (0, TOP))
        P.putalpha(ImageChops.multiply(P.getchannel('A'), rounded_mask(P.size, 24 * S))); return (i, P)
    w, h = box[2] - box[0], box[3] - box[1] + TOP
    write('o2', 8, (w + 2 * PAD, h + 2 * PAD + RISE), at)

if want('o3'):
    f = seq('o3'); m = meta('o3'); cy = m['clip']['y']; fr = m['frames']
    me = fr[-1]['me']; ans = fr[-1]['answer']
    x0, x1 = 16 - 2, 16 + 308 + 2
    y0, y1 = me[1] - 4, ans[1] + ans[3] + 4
    box = tuple(int(round(v * S)) for v in (x0, y0 - cy, x1, y1 - cy))
    def at(t):
        i = min(len(f) - 1, int(t * FPS))
        if not fr[i]['me']: return ('empty', None)
        img = load(f[i]); M = Image.new('L', img.size, 0); d = ImageDraw.Draw(M)
        for k, r in (('me', 22), ('steps', 22), ('answer', 22)):
            q = fr[i][k]
            if q: d.rounded_rectangle([q[0] * S, (q[1] - cy) * S, (q[0] + q[2]) * S, (q[1] + q[3] - cy) * S], radius=r * S, fill=255)
        img.putalpha(ImageChops.multiply(img.getchannel('A'), M)); return (i, img.crop(box))
    w, h = box[2] - box[0], box[3] - box[1]
    write('o3', 8, (w + 2 * PAD, h + 2 * PAD + RISE), at, anchor='top', top=PAD)

if want('o4'):
    S6 = 6; f = seq('o4'); r = json.load(open(CAP + 'o4-rects.json'))
    c = r['card']; tr = r['toast']
    cbox = tuple(int(round(v * S6)) for v in (c['x'] - 1, c['y'] - 1, c['x'] + c['w'] + 1, c['y'] + c['h'] + 1))
    tbox = tuple(int(round(v * S6)) for v in (tr['x'], tr['y'], tr['x'] + tr['w'], tr['y'] + tr['h']))
    toast = crop_masked(load(f[60]), tbox, int(tr['h'] * S6 / 2))
    GAP = 40; cw, ch = cbox[2] - cbox[0], cbox[3] - cbox[1]
    cw_all = max(cw, toast.width); ch_all = ch + GAP + toast.height + 24
    def at(t):
        i = min(len(f) - 1, int(t * FPS)); card = load(f[i]).crop(cbox)
        if i < 4: card = Image.new('RGBA', card.size, (0, 0, 0, 0))
        k = min(1, max(0, (t - 1.0) / 0.3)) * (1 - min(1, max(0, (t - 4.0) / 0.3)))
        C = Image.new('RGBA', (cw_all, ch_all), (0, 0, 0, 0)); C.paste(card, ((cw_all - cw) // 2, 0))
        key = (min(i, 40), round(k, 2))
        if k > 0:
            T = toast.copy(); T.putalpha(T.getchannel('A').point(lambda v: int(v * ease_out(k))))
            C.alpha_composite(T, ((cw_all - toast.width) // 2, ch + GAP + int(24 * (1 - ease_out(k)))))
        return (key, C)
    write('o4', 7, (cw_all + 2 * PAD, ch_all + 2 * PAD + RISE), at)

if want('o5'):
    f = seq('o5'); m = meta('o5'); cy = m['clip']['y']; fr = m['frames']
    hb = fr[-1]['habits']; card = fr[-1]['card']
    box = tuple(int(round(v * S)) for v in (card[0], hb[1] - 18 - cy, card[0] + card[2], hb[1] + hb[3] + 18 - cy))
    pj = json.load(open(CAP + 'o5-pattern.json')); pr = pj['pat']; pcy = pj['clip']['y']
    pat = load(CAP + 'o5-pattern.png').crop(tuple(int(round(v * S)) for v in (pr[0], pr[1] - pcy, pr[0] + pr[2], pr[1] + pr[3] - pcy)))
    hw, hh = box[2] - box[0], box[3] - box[1]
    Wc, Hc = max(hw, pat.width), max(hh, pat.height)
    def centred(img):
        C = Image.new('RGBA', (Wc, Hc), (0, 0, 0, 0)); C.paste(img, ((Wc - img.width) // 2, (Hc - img.height) // 2)); return C
    def at(t):
        i = min(len(f) - 1, int(t * FPS)); A = centred(crop_masked(load(f[i]), box, 24 * S))
        a = min(1, max(0, (t - 4.4) / 0.4)); a = a * a * (3 - 2 * a)
        if a <= 0: return (i, A)
        if a >= 1: return ('pat', centred(pat))
        return ((i, round(a, 3)), Image.blend(A, centred(pat), a))
    write('o5', 8, (Wc + 2 * PAD, Hc + 2 * PAD + RISE), at)

if want('o6'):
    f = seq('o6'); m = meta('o6'); cy = m['clip']['y']; fr = m['frames']
    card = fr[-1]['card']
    y1 = card[1] + 178
    box = tuple(int(round(v * S)) for v in (card[0], card[1] - cy, card[0] + card[2], y1 - cy))
    def at(t):
        i = min(len(f) - 1, int(t * FPS)); return (i, crop_masked(load(f[i]), box, 24 * S))
    w, h = box[2] - box[0], box[3] - box[1]
    write('o6', 7, (w + 2 * PAD, h + 2 * PAD + RISE), at)
