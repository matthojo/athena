// Renders film.html to JPEG frames, deterministically: each frame is seek(frame * 1000 / 30) then a screenshot.
// The frame count comes from the page (window.FILM_DURATION_MS); swaps.json is read here and handed to the page.
//
// Motion blur: when the camera moves faster than BLUR_MIN px/frame (window.camSpeed), the frame is the average
// of N sub-frame renders across a 180-degree shutter (t - 8.3 ms .. t + 8.3 ms), N = 5 at the threshold and
// more as it gets faster (one sample per ~8 px of travel, up to 13; above 60 px/frame 16 to 32; times window.blurBoost
// where a morph flies during a camera move), so the smear has no visible
// steps. Every sub-sample shows the same app capture frame (seek(ms, { capMs }) with the frame's own time): only the
// camera, pointer and morphs move within the shutter, so a capture that changes mid-move never double-exposes.
//
//   node render.cjs                      every frame -> $OUT_DIR/000000.jpg ... (stale frames past the end are deleted)
//   node render.cjs --from 360 --to 660  re-render a range (inclusive)
//   node render.cjs --frames 10,20,30    just these frames
//   node render.cjs --ms 600,18600       single moments -> $OUT_DIR/ms_000600.jpg (for looking, not the film)
//   node render.cjs --peaks              write $FILM/motion-peaks.json (each camera move's fastest frame),
//                                        $FILM/camspeed.json (camera speed per frame) and $FILM/film-events.json
//                                        (film ms of each capture event and pointer press as played); renders nothing
//   --pages N                            parallel pages (default 4)
//   --noblur                             skip the motion blur (quick looks)
//
// Env: CAP_DIR  app captures (manifest.json, <shot>/NNNN.jpg, stills/<name>.jpg)
//      LOOK_DIR stand-in stills used when a capture frame is missing
//      OUT_DIR  where the frames go
//      FILM     working folder (default below); CAP_DIR, OUT_DIR default to $FILM/cap and $FILM/frames
const { chromium } = require('playwright');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FILM = process.env.FILM || '/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film5';
const CAP_DIR = path.resolve(process.env.CAP_DIR || FILM + '/cap-r1');
const LOOK_DIR = path.resolve(process.env.LOOK_DIR || FILM + '/../look');
const OUT_DIR = path.resolve(process.env.OUT_DIR || FILM + '/frames');
const FPS = 30, FRAME = 1000 / FPS;
const BLUR_MIN = 25, SHUTTER = FRAME / 2;

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes('--' + name);
const pages = Math.max(1, Math.min(8, Number(arg('pages', 4))));
const msList = arg('ms', null);
const frameList = arg('frames', null);
const noBlur = flag('noblur');

async function average(bufs) {
  let acc = null, info = null;
  for (const b of bufs) {
    const r = await sharp(b).raw().toBuffer({ resolveWithObject: true });
    info = r.info;
    if (!acc) acc = new Uint32Array(r.data.length);
    for (let i = 0; i < r.data.length; i++) acc[i] += r.data[i];
  }
  const n = bufs.length, out = Buffer.alloc(acc.length);
  for (let i = 0; i < acc.length; i++) out[i] = Math.round(acc[i] / n);
  return sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels } }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
}

(async () => {
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(CAP_DIR, 'manifest.json'), 'utf8')); } catch { console.log('no capture manifest: using the stand-in stills'); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const swaps = JSON.parse(fs.readFileSync(path.join(__dirname, 'swaps.json'), 'utf8'));
  const cfg = { cap: pathToFileURL(CAP_DIR).href, look: pathToFileURL(LOOK_DIR).href, manifest, swaps };

  const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--disable-lcd-text', '--allow-file-access-from-files'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(c => { window.__FILM_CFG__ = c; }, cfg);
  const filmUrl = pathToFileURL(path.join(__dirname, 'film.html')).href;

  const probe = await ctx.newPage();
  probe.on('pageerror', e => console.log('PAGE ERROR', e.message));
  await probe.goto(filmUrl);
  const durMs = await probe.evaluate(async () => { await window.seek(0); return window.FILM_DURATION_MS; });
  const TOTAL = Math.round((durMs * FPS) / 1000);
  if (flag('peaks')) {
    const peaks = await probe.evaluate(() => window.filmPeaks());
    const speed = await probe.evaluate(async (n) => { const o = []; for (let f = 0; f < n; f++) o.push(+(await window.camSpeed(f * 1000 / 30)).toFixed(2)); return o; }, TOTAL);
    fs.mkdirSync(FILM, { recursive: true });
    fs.writeFileSync(path.join(FILM, 'motion-peaks.json'), JSON.stringify(peaks, null, 1) + '\n');
    fs.writeFileSync(path.join(FILM, 'camspeed.json'), JSON.stringify(speed) + '\n');
    fs.writeFileSync(path.join(FILM, 'film-events.json'), JSON.stringify(await probe.evaluate(() => window.filmEvents()), null, 1) + '\n');
    console.log(peaks.map(p => `${p.label} ${p.ms}ms ${p.pxPerFrame}px/f`).join('\n'));
    await browser.close();
    return;
  }
  await probe.close();
  const from = Math.max(0, Number(arg('from', 0)));
  const to = Math.min(TOTAL - 1, Number(arg('to', TOTAL - 1)));
  const fullRun = !msList && !frameList && from === 0 && to === TOTAL - 1;

  const jobs = msList
    ? msList.split(',').map(Number).map(ms => ({ ms, file: path.join(OUT_DIR, `ms_${String(Math.round(ms)).padStart(6, '0')}.jpg`) }))
    : (frameList ? frameList.split(',').map(Number) : Array.from({ length: to - from + 1 }, (_, i) => from + i))
      .map(f => ({ ms: f * FRAME, file: path.join(OUT_DIR, String(f).padStart(6, '0') + '.jpg') }));
  const total = jobs.length; let next = 0, done = 0, blurred = 0; const t0 = Date.now();
  if (!msList) console.log(`film is ${durMs}ms = ${TOTAL} frames; rendering ${total} frame(s)`);

  const worker = async (id) => {
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log('PAGE ERROR', e.message));
    await p.goto(filmUrl);
    await p.evaluate(() => window.seek(0));
    if (id === 0) {
      const info = await p.evaluate(() => window.filmInfo(0));
      console.log('fonts', JSON.stringify(info.fonts.funnel && info.fonts.geist), '| manifest shots:', info.manifest.join(' ') || '(none)', '| zmax', JSON.stringify(info.zmax));
      if (!info.fonts.funnel || !info.fonts.geist) throw new Error('fonts did not load');
    }
    while (next < total) {
      const job = jobs[next++];
      const v = noBlur ? 0 : await p.evaluate(ms => window.camSpeed(ms), job.ms);
      if (v > BLUR_MIN) {
        const boost = await p.evaluate(ms => (window.blurBoost ? window.blurBoost(ms) : 1), job.ms);
        const n = Math.min(boost > 1 ? 72 : 32, Math.round(boost * (v > 60 ? Math.max(16, Math.min(32, Math.round(v / 8))) : Math.max(5, Math.min(13, Math.round(v / 8) + 1)))));
        if (process.env.BLUR_DEBUG) console.log("blur", job.ms.toFixed(0), "v", v.toFixed(1), "n", n);
        const bufs = [];
        for (let i = 0; i < n; i++) {
          // (then one animation frame, so the screenshot is of this sub-sample and not a stale composite: without it
          // several sub-samples come back identical and the smear shows steps)
          await p.evaluate(([ms, capMs]) => window.seek(ms, { capMs }).then(() => new Promise(r => requestAnimationFrame(() => r()))), [job.ms + (i / (n - 1) - 0.5) * SHUTTER, job.ms]);
          bufs.push(await p.screenshot({ type: "png" }));
        }
        fs.writeFileSync(job.file, await average(bufs));
        blurred++;
      } else {
        await p.evaluate(ms => window.seek(ms), job.ms);
        await p.screenshot({ path: job.file, type: 'jpeg', quality: 95 });
      }
      if (++done % 100 === 0) console.log(`${done}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s  (${blurred} blurred)`);
    }
    await p.close();
  };
  await Promise.all(Array.from({ length: Math.min(pages, total) }, (_, i) => worker(i)));
  await browser.close();
  if (fullRun) {
    const stale = fs.readdirSync(OUT_DIR).filter(f => /^\d{6}\.jpg$/.test(f) && Number(f.slice(0, 6)) >= TOTAL);
    for (const f of stale) fs.unlinkSync(path.join(OUT_DIR, f));
    if (stale.length) console.log(`deleted ${stale.length} stale frame(s) past ${TOTAL - 1}`);
  }
  console.log(`rendered ${total} frame(s) (${blurred} with motion blur) to ${OUT_DIR} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(e => { console.error(e); process.exit(1); });
