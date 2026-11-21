// Overlay capture: frame-stepped (fake clock + driven CSS animations), transparent page background,
// per-frame PNG with alpha clipped to a region, plus per-frame rects of named selectors.
const { chromium } = require('playwright');
const fs = require('fs');
const ROOT = __dirname + '/ovcap/';
const URL = 'http://localhost:5199/';
const STEP = 1000 / 30;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CLEAR = `html,body,#app,.shell,.main,.view{background:transparent!important;background-image:none!important}
html::before,html::after,body::before,body::after,.shell::before,.shell::after,.main::before,.main::after,.view::before,.view::after{display:none!important}`;

async function setup(b, time, dsf) {
  const ctx = await b.newContext({ viewport: { width: 340, height: 844 }, deviceScaleFactor: dsf, colorScheme: 'light', timezoneId: 'Europe/London', locale: 'en-GB', isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('athena.mode', 'sample');
    const seen = new WeakMap();
    window.__syncAnims = (vt) => {
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
async function prepare(p, route, css = '') {
  await p.goto(URL + route); await sleep(400);
  await p.clock.pauseAt(new Date(await p.evaluate(() => Date.now()) + 50));
  for (let t = 0; t < 2500; t += STEP) { await p.clock.runFor(STEP); await sleep(4); }
  await p.addStyleTag({ content: CLEAR + css });
  for (let t = 0; t < 300; t += STEP) { await p.clock.runFor(STEP); await sleep(4); }
}
async function rects(p, sels) {
  return p.evaluate(sels => Object.fromEntries(Object.entries(sels).map(([k, s]) => {
    const el = typeof s === 'string' ? document.querySelector(s) : null;
    const r = el && el.getBoundingClientRect();
    return [k, r && r.width ? [r.x, r.y, r.width, r.height] : null];
  })), sels);
}
async function record(p, name, durMs, clip, sels, actions = []) {
  const dir = ROOT + name + '/'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const n = Math.round(durMs / STEP); let vt = 0; const todo = [...actions].sort((a, b) => a[0] - b[0]); const log = [];
  for (let i = 0; i < n; i++) {
    while (todo.length && todo[0][0] <= vt) { const [, fn] = todo.shift(); await fn(); }
    await p.clock.runFor(STEP); vt += STEP; await sleep(12);
    await p.evaluate(v => window.__syncAnims(v), vt);
    await p.screenshot({ path: `${dir}${String(i).padStart(4, '0')}.png`, omitBackground: true, clip });
    log.push(await rects(p, sels));
  }
  fs.writeFileSync(dir + 'meta.json', JSON.stringify({ clip, frames: log }));
  console.log(name, n, 'frames');
}
async function scrollEl(p, sel, top) {
  await p.evaluate(([sel, top]) => { const el = document.querySelector(sel); document.scrollingElement.scrollTop += el.getBoundingClientRect().top - top; }, [sel, top]);
}
const box = async (p, sel) => p.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }, sel);
const which = process.argv.slice(2); const want = n => !which.length || which.includes(n);

(async () => {
  const b = await chromium.launch();
  if (want('o1')) {
    const p = await setup(b, '2026-11-09T07:55:00Z', 3);
    await prepare(p, '#/'); await scrollEl(p, 'section.travel', 40);
    const [x, y, w, h] = await box(p, 'section.travel');
    await record(p, 'o1', 8000, { x: 0, y: y - 30, width: 340, height: h + 60 }, { card: 'section.travel' });
    await p.context().close();
  }
  if (want('o2')) {
    const p = await setup(b, '2026-11-09T07:55:00Z', 3);
    await prepare(p, '#/', `
      .ov-pre .tleg__clock{text-decoration-color:transparent!important}
      .ov-pre .tleg__expected{display:inline-block;opacity:0;transform:translateY(6px)}
      .ov-pre .tchip{opacity:0;transform:scale(.8)}`);
    await p.evaluate(() => document.querySelector('li.tleg').classList.add('ov-pre'));
    await p.clock.runFor(200); await sleep(50);
    await p.addStyleTag({ content: `
      .tleg__clock{transition:text-decoration-color .45s ease-out}
      .tleg__expected{display:inline-block;transition:opacity .45s ease-out .12s, transform .5s cubic-bezier(.2,.9,.3,1) .12s}
      .tchip{transition:opacity .35s ease-out .22s, transform .5s cubic-bezier(.3,1.5,.5,1) .22s}` });
    await scrollEl(p, 'li.tleg', 120);
    const [x, y, w, h] = await box(p, 'li.tleg');
    await record(p, 'o2', 8000, { x: 0, y: y - 30, width: 340, height: h + 60 }, { leg: 'li.tleg', ref: 'li.tleg .tleg__ref', card: 'section.travel' },
      [[1200, () => p.evaluate(() => document.querySelector('li.tleg').classList.remove('ov-pre'))]]);
    await p.context().close();
  }
  if (want('o3')) {
    const p = await setup(b, '2026-11-09T12:20:00Z', 3);
    await prepare(p, '#/ask', `.thread__day,.orb,.answer__text,.sources,.pcard--deep,.answer-bubble .steps--fold{display:none!important}
      .ask__bar,.composer,form.ask-form{visibility:hidden!important}`);
    const input = p.getByRole('textbox', { name: 'Ask your notes' });
    await input.click(); await p.keyboard.type('What helps me sleep?');
    await p.evaluate(() => { const a = document.activeElement; a && a.blur && 0; });
    await record(p, 'o3', 8000, { x: 0, y: 40, width: 340, height: 560 }, { me: '.msg--me .bubble', steps: '.steps-bubble', answer: '.answer-bubble' },
      [[600, () => p.keyboard.press('Enter')]]);
    await p.context().close();
  }
  if (want('o4')) {
    const p = await setup(b, '2026-11-09T13:10:00Z', 6);
    await prepare(p, '#/saved');
    await p.getByPlaceholder('Paste a link, or keep a thought').click();
    await p.keyboard.type('Walk to work on Fridays. Take the long way past the river.');
    await p.evaluate(() => { document.scrollingElement.scrollTop = 0; });
    await record(p, 'o4', 7000, { x: 0, y: 0, width: 340, height: 844 }, {},
      [[150, () => p.keyboard.press('Enter')], [400, () => p.evaluate(() => {
        // tag the new card and the toast so their rects are logged
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
        while ((n = w.nextNode())) if (n.textContent.includes('Walk to work on Fridays')) break;
        let el = n && n.parentElement; while (el && getComputedStyle(el).borderRadius === '0px') el = el.parentElement;
        el && (el.dataset.ov = 'card');
      })]]);
    await p.context().close();
  }
  if (want('o5')) {
    const p = await setup(b, '2026-11-09T07:55:00Z', 3);
    await prepare(p, '#/');
    await scrollEl(p, '.today-habits', 200);
    const [x, y, w, h] = await box(p, '.today-habits');
    const ticks = ['Evening walk', 'Fruit and veg', 'Practise piano'].map(t => p.getByText(t, { exact: true }).first());
    await record(p, 'o5', 4600, { x: 0, y: y - 30, width: 340, height: h + 60 }, { habits: '.today-habits', card: 'section.today' },
      [[900, () => ticks[0].click()], [2400, () => ticks[1].click()], [3900, () => ticks[2].click()]]);
    await p.goto(URL + '#/habits'); await sleep(300);
    for (let t = 0; t < 3000; t += STEP) { await p.clock.runFor(STEP); await sleep(6); }
    await p.addStyleTag({ content: CLEAR });
    await p.evaluate(() => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) if (n.textContent.includes('A pattern with your habits')) break;
      let el = n.parentElement; while (el && getComputedStyle(el).borderRadius === '0px') el = el.parentElement;
      el.dataset.ov = 'pat'; document.scrollingElement.scrollTop += el.getBoundingClientRect().top - 200;
    });
    await p.clock.runFor(500); await sleep(200);
    const pb = await box(p, '[data-ov=pat]');
    await p.screenshot({ path: ROOT + 'o5-pattern.png', omitBackground: true, clip: { x: 0, y: pb[1] - 30, width: 340, height: pb[3] + 60 } });
    fs.writeFileSync(ROOT + 'o5-pattern.json', JSON.stringify({ clip: { x: 0, y: pb[1] - 30 }, pat: pb }));
    await p.context().close();
  }
  if (want('o6')) {
    const p = await setup(b, '2026-11-09T21:05:00Z', 3);
    await prepare(p, '#/');
    await scrollEl(p, 'section.today', 120);
    const [x, y, w, h] = await box(p, 'section.today');
    await record(p, 'o6', 7000, { x: 0, y: y - 30, width: 340, height: 330 }, { card: 'section.today', moods: '.today__main--evening' },
      [[1500, () => p.getByText('Good', { exact: true }).first().click()]]);
    await p.context().close();
  }
  await b.close();
})();
