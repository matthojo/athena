// Renders film.html to JPEG frames, deterministically: each frame is seek(frame * 1000 / 30) then a screenshot.
// The frame count comes from the page (window.FILM_DURATION_MS); swaps.json is read here and handed to the page.
//
//   node render.cjs                      every frame -> $OUT_DIR/000000.jpg ... (stale frames past the end are deleted)
//   node render.cjs --from 360 --to 660  re-render a range (inclusive)
//   node render.cjs --ms 600,18600       single moments -> $OUT_DIR/ms_000600.jpg (for looking, not the film)
//   --pages N                            parallel pages (default 6)
//
// Env: CAP_DIR  app captures (manifest.json, <shot>/NNNN.jpg, stills/<name>.jpg)
//      LOOK_DIR stand-in stills used when a capture frame is missing
//      OUT_DIR  where the frames go
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const FILM = '/tmp/claude-0/-home-user-athena/92254b34-7623-59d6-a458-adb54d88ca12/scratchpad/film';
const CAP_DIR = path.resolve(process.env.CAP_DIR || FILM + '/cap');
const LOOK_DIR = path.resolve(process.env.LOOK_DIR || FILM + '/../look');
const OUT_DIR = path.resolve(process.env.OUT_DIR || FILM + '/frames');
const FPS = 30;

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const pages = Math.max(1, Math.min(8, Number(arg('pages', 6))));
const msList = arg('ms', null);

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

  // The film says how long it is.
  const probe = await ctx.newPage();
  await probe.goto(filmUrl);
  const durMs = await probe.evaluate(async () => { await window.seek(0); return window.FILM_DURATION_MS; });
  await probe.close();
  const TOTAL = Math.round((durMs * FPS) / 1000);
  const from = Math.max(0, Number(arg('from', 0)));
  const to = Math.min(TOTAL - 1, Number(arg('to', TOTAL - 1)));
  const fullRun = !msList && from === 0 && to === TOTAL - 1;

  // One job list, pulled from by every page.
  const jobs = msList
    ? msList.split(',').map(Number).map(ms => ({ ms, file: path.join(OUT_DIR, `ms_${String(Math.round(ms)).padStart(6, '0')}.jpg`) }))
    : Array.from({ length: to - from + 1 }, (_, i) => ({ ms: ((from + i) * 1000) / FPS, file: path.join(OUT_DIR, String(from + i).padStart(6, '0') + '.jpg') }));
  const total = jobs.length; let next = 0, done = 0; const t0 = Date.now();
  if (!msList) console.log(`film is ${durMs}ms = ${TOTAL} frames; rendering ${from}..${to}`);

  const worker = async (id) => {
    const p = await ctx.newPage();
    p.on('pageerror', e => console.log('PAGE ERROR', e.message));
    await p.goto(filmUrl);
    await p.evaluate(() => window.seek(0));
    if (id === 0) {
      const info = await p.evaluate(() => window.filmInfo(0));
      console.log('fonts', JSON.stringify(info.fonts), '| manifest shots:', info.manifest.join(' ') || '(none)');
      if (!info.fonts.funnel || !info.fonts.geist) throw new Error('fonts did not load');
    }
    while (next < total) {
      const job = jobs[next++];
      await p.evaluate(ms => window.seek(ms), job.ms);
      await p.screenshot({ path: job.file, type: 'jpeg', quality: 95 });
      if (++done % 150 === 0) console.log(`${done}/${total}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    if (id === 0) {
      const info = await p.evaluate(() => window.filmInfo(0));
      console.log("last sources on page 0:", JSON.stringify(info.cards), "| checkin:", JSON.stringify(info.checkin));
    }
    await p.close();
  };
  await Promise.all(Array.from({ length: Math.min(pages, total) }, (_, i) => worker(i)));
  await browser.close();
  if (fullRun) {
    // Frames left over from a longer cut would end up in the encode.
    const stale = fs.readdirSync(OUT_DIR).filter(f => /^\d{6}\.jpg$/.test(f) && Number(f.slice(0, 6)) >= TOTAL);
    for (const f of stale) fs.unlinkSync(path.join(OUT_DIR, f));
    if (stale.length) console.log(`deleted ${stale.length} stale frame(s) past ${TOTAL - 1}`);
  }
  console.log(`rendered ${total} frame(s) to ${OUT_DIR} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(e => { console.error(e); process.exit(1); });
