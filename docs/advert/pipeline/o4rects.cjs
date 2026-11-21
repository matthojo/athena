// Measures the new Saved card and the "Saved" toast in the same layout the o4 capture used.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 340, height: 844 }, colorScheme: 'light', timezoneId: 'Europe/London', locale: 'en-GB', isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => localStorage.setItem('athena.mode', 'sample'));
  await ctx.route('**/api/**', r => r.abort());
  const p = await ctx.newPage(); await p.clock.install({ time: new Date('2026-11-09T13:10:00Z') });
  await p.goto('http://localhost:5199/#/saved'); await p.waitForTimeout(2500);
  await p.getByPlaceholder('Paste a link, or keep a thought').click();
  await p.keyboard.type('Walk to work on Fridays. Take the long way past the river.');
  await p.evaluate(() => { document.scrollingElement.scrollTop = 0; });
  await p.keyboard.press('Enter'); await p.waitForTimeout(1200);
  const r = await p.evaluate(() => {
    const find = (txt, exact) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) if (exact ? n.textContent.trim() === txt : n.textContent.includes(txt)) return n.parentElement; };
    const up = el => { while (el && getComputedStyle(el).borderRadius === '0px') el = el.parentElement; return el; };
    const card = up(find('Walk to work on Fridays')); const toast = document.querySelector('.toast');
    const R = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: getComputedStyle(el).borderRadius, cls: el.className }; };
    return { card: R(card), toast: R(toast), scroll: scrollY };
  });
  console.log(JSON.stringify(r)); require('fs').writeFileSync(__dirname + '/ovcap/o4-rects.json', JSON.stringify(r));
  await b.close();
})();
