# Composites captured Athena screens into a floating phone on a soft grey ground, 1920x1080 @30fps.
import json, sys, math, subprocess, os
from PIL import Image, ImageDraw, ImageFilter
import numpy as np
D = os.path.dirname(os.path.abspath(__file__)); CAP = D + '/cap/'; OUT = D + '/app/'
W, H, FPS = 1920, 1080, 30
SCREEN_CSS = (390, 844)

def background():
    y, x = np.mgrid[0:H, 0:W]
    r = np.sqrt(((x - W/2) / (W*0.62))**2 + ((y - H*0.46) / (H*0.75))**2).clip(0, 1)
    r = r**1.6
    c0 = np.array([0xf1, 0xf3, 0xf8]); c1 = np.array([0xdc, 0xe1, 0xea])
    img = (c0 * (1 - r[..., None]) + c1 * r[..., None])
    img += np.random.default_rng(1).normal(0, 0.6, img.shape)  # tiny dither, no banding
    return Image.fromarray(img.clip(0, 255).astype('uint8'), 'RGB')
BG = background()

def ease(k): return 4*k**3 if k < .5 else 1 - (-2*k + 2)**3 / 2

class Phone:
    """Bezel + shadow at a fixed px-per-css scale; screens are pasted in per frame."""
    def __init__(self, k):
        self.k = k
        sw, sh = round(SCREEN_CSS[0]*k), round(SCREEN_CSS[1]*k)
        bz, fr = 11*k, 1.6*k
        rs = 47*k
        self.sw, self.sh = sw, sh
        m = int(70*k)  # margin for shadow
        ow, oh = int(sw + 2*(bz+fr)), int(sh + 2*(bz+fr))
        self.size = (ow + 2*m, oh + 2*m)
        self.screen_xy = (int(m + bz + fr), int(m + bz + fr))
        base = Image.new('RGBA', self.size, (0, 0, 0, 0))
        sh_l = Image.new('L', self.size, 0)
        ImageDraw.Draw(sh_l).rounded_rectangle([m+8*k, m+26*k, m+ow-8*k, m+oh+10*k], radius=rs+bz, fill=95)
        sh_l = sh_l.filter(ImageFilter.GaussianBlur(28*k))
        shadow = Image.new('RGBA', self.size, (30, 38, 60, 0)); shadow.putalpha(sh_l)
        base = Image.alpha_composite(base, shadow)
        d = ImageDraw.Draw(base)
        d.rounded_rectangle([m, m, m+ow-1, m+oh-1], radius=rs+bz+fr, fill=(58, 61, 68, 255))
        d.rounded_rectangle([m+fr, m+fr, m+ow-1-fr, m+oh-1-fr], radius=rs+bz, fill=(10, 11, 14, 255))
        self.base = base
        mask = Image.new('L', (sw, sh), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, sw-1, sh-1], radius=rs, fill=255)
        self.mask = mask
    def layer(self, screen):
        L = self.base.copy()
        s = screen.convert('RGB').resize((self.sw, self.sh), Image.LANCZOS)
        L.paste(s, self.screen_xy, self.mask)
        return L
    def css_to_layer(self, cx, cy):
        return (self.screen_xy[0] + cx*self.k, self.screen_xy[1] + cy*self.k)

def place(layer, phone, focus_css, at_xy, scale):
    """Affine-place the phone layer so focus_css lands at at_xy, scaled by `scale` (<=1, relative to layer)."""
    fx, fy = phone.css_to_layer(*focus_css)
    a = 1/scale
    # output (x,y) -> layer ((x-ax)*a + fx, (y-ay)*a + fy)
    coeffs = (a, 0, fx - at_xy[0]*a, 0, a, fy - at_xy[1]*a)
    return layer.transform((W, H), Image.AFFINE, coeffs, resample=Image.BICUBIC)

class Frames:
    def __init__(self, name):
        d = json.load(open(CAP + name + '/frames.json')); self.dir = CAP + name + '/'
        self.fr = d['frames']; self.marks = d['marks']; self.t0 = self.fr[0]['t']; self.cache = {}
    def at(self, t):
        best = self.fr[0]
        for f in self.fr:
            if f['t'] <= t: best = f
            else: break
        if best['file'] not in self.cache:
            self.cache = {best['file']: Image.open(self.dir + best['file']).convert('RGB')}
        return self.cache[best['file']]

def render(name, dur, frame_fn, k_end, focus, scale0, rise=0):
    phone = Phone(k_end)
    n = int(round(dur*FPS))
    ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                           '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT + name + '.mp4'], stdin=subprocess.PIPE)
    for i in range(n):
        k = ease(i / max(1, n-1))
        scale = scale0 + (1 - scale0)*k
        screen = frame_fn(i / FPS)
        L = phone.layer(screen)
        at = (W/2, H/2 + rise*(1-k))
        out = BG.copy().convert('RGBA')
        out = Image.alpha_composite(out, place(L, phone, focus, at, scale))
        ff.stdin.write(out.convert('RGB').tobytes())
    ff.stdin.close(); ff.wait(); print(name, n, 'frames')

class Seq:
    def __init__(self, name, first):
        import glob
        self.files = sorted(glob.glob(D + '/cap2/' + name + '/*.jpg')); self.first = first
    def at(self, sec):
        i = min(len(self.files) - 1, self.first + int(round(sec * FPS)))
        return Image.open(self.files[i]).convert('RGB')

PH_K = 900/844  # normal shots: screen 900px tall at the end of the push-in
CENTER = (195, 422)
which = sys.argv[1:]
want = lambda n: not which or n in which
if want('s02'):
    q = Seq('home', 10); render('s02', 6, q.at, PH_K, CENTER, 0.95, rise=14)
if want('s04'):
    tr = Image.open(CAP + 'train.png')  # dsf 4 still
    render('s04', 5, lambda s: tr, 4.5, (198, 312), 0.94)
if want('s06'):
    q = Seq('ask', 13); render('s06', 7, q.at, PH_K, CENTER, 0.95, rise=10)
if want('s08'):
    q = Seq('saved', 29); render('s08', 4, q.at, PH_K, CENTER, 0.96, rise=8)
if want('s10'):
    q = Seq('habits', 0); pat = Image.open(CAP + 'pattern.png').convert('RGB')
    def fn(s):
        if s < 3.4: return q.at(s)
        a = min(1, (s - 3.4) / 0.3); a0 = q.at(3.4)
        return Image.blend(a0, pat.resize(a0.size, Image.LANCZOS), a)
    render('s10', 6, fn, PH_K, CENTER, 0.95, rise=10)
if want('s12'):
    q = Seq('mood', 6); render('s12', 3, q.at, PH_K, CENTER, 0.97, rise=6)
