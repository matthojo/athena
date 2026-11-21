// Deterministic 30fps capture: fake clock paused and stepped 1/30s per frame; CSS/Web animations
// are paused and their currentTime driven from the same virtual clock; each frame is a 3x screenshot.
const { chromium } = require('playwright');
const fs = require('fs');
const ROOT = __dirname + '/cap2/';
const URL = 'http://localhost:5199/';
const STEP = 1000 / 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setup(b, time) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, colorScheme: 'light', timezoneId: 'Europe/London', locale: 'en-GB', isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('athena.mode', 'sample');
    // Drive every CSS/Web animation from a virtual time the recorder sets.
    window.__vt = 0; const seen = new WeakMap();
    window.__syncAnims = (vt) => {
      window.__vt = vt;
      for (const a of document.getAnimations()) {
        if (!seen.has(a)) { const ct = a.currentTime || 0; seen.set(a, vt - ct); try { a.pause(); } catch {} }
        try { a.currentTime = vt - seen.get(a); } catch {}
      }
    };
  });
  await ctx.route('**/api/**', r => r.abort());
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.clock.install({ time: new Date(time) });
  return p;
}

async function record(p, name, durMs, actions = []) {
  const dir = ROOT + name + '/'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const n = Math.round(durMs / STEP); let vt = 0; const todo = [...actions].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < n; i++) {
    while (todo.length && todo[0][0] <= vt) { const [, fn] = todo.shift(); await fn(); }
    await p.clock.runFor(STEP); vt += STEP;
    await sleep(15); // let real async work (IndexedDB, promises) settle
    await p.evaluate(v => window.__syncAnims(v), vt);
    await p.screenshot({ path: `${dir}${String(i).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 95 });
  }
  console.log(name, n, 'frames');
}
function typeActions(p, at, text, per = 85) {
  return [...text].map((ch, i) => [at + i * per + (i % 3) * 12, () => p.keyboard.type(ch)]);
}
async function prepare(p, route, settleMs = 2500) {
  await p.goto(URL + route); await sleep(400);
  await p.clock.pauseAt(new Date(await p.evaluate(() => Date.now()) + 50));
  for (let t = 0; t < settleMs; t += STEP) { await p.clock.runFor(STEP); await sleep(5); }
  await p.evaluate(() => window.__syncAnims(0));
}
async function scrollTo(p, y) { await p.evaluate(y => { document.scrollingElement.scrollTop = y; }, y); }
async function topOf(loc) { return loc.evaluate(el => el.getBoundingClientRect().top + document.scrollingElement.scrollTop); }

const which = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  const want = n => !which.length || which.includes(n);
  if (want('home')) {
    const p = await setup(b, '2026-11-09T07:55:00Z');
    await p.goto(URL + '#/'); await sleep(300);
    await p.clock.pauseAt(new Date(await p.evaluate(() => Date.now()) + 50));
    await record(p, 'home', 6600);
    await p.context().close();
  }
  if (want('ask')) {
    const p = await setup(b, '2026-11-09T12:20:00Z');
    await prepare(p, '#/ask');
    const input = p.getByRole('textbox', { name: 'Ask your notes' });
    await input.click();
    const q = 'What helps me sleep?';
    const acts = typeActions(p, 300, q, 80);
    const sendAt = 300 + q.length * 80 + 350;
    acts.push([sendAt, () => p.keyboard.press('Enter')]);
    await record(p, 'ask', sendAt + 5200, acts);
    fs.writeFileSync(ROOT + 'ask.json', JSON.stringify({ sendAt }));
    await p.context().close();
  }
  if (want('saved')) {
    const p = await setup(b, '2026-11-09T13:10:00Z');
    await prepare(p, '#/saved');
    await p.getByPlaceholder('Paste a link, or keep a thought').click();
    const t = 'Walk to work on Fridays. Take the long way past the river.';
    const acts = typeActions(p, 200, t, 32);
    const addAt = 200 + t.length * 32 + 300;
    acts.push([addAt, () => p.keyboard.press('Enter')]);
    await record(p, 'saved', addAt + 2600, acts);
    fs.writeFileSync(ROOT + 'saved.json', JSON.stringify({ addAt }));
    await p.context().close();
  }
  if (want('habits')) {
    const p = await setup(b, '2026-11-09T07:55:00Z');
    await prepare(p, '#/');
    const walk = p.getByText('Evening walk').first();
    await scrollTo(p, (await topOf(walk)) - 330);
    const fv = p.getByText('Fruit and veg').first();
    await record(p, 'habits', 3600, [[450, () => walk.click()], [1450, () => fv.click()]]);
    await p.context().close();
  }
  if (want('mood')) {
    const p = await setup(b, '2026-11-09T21:05:00Z');
    await prepare(p, '#/');
    await record(p, 'mood', 3200, [[800, () => p.getByText('Good', { exact: true }).first().click()]]);
    await p.context().close();
  }
  await b.close();
})();
