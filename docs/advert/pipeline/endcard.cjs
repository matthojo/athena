const { chromium } = require('playwright'); const { spawn } = require('child_process');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto('file://' + __dirname + '/endcard.html'); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
  const ff = spawn('ffmpeg', ['-v','error','-y','-f','image2pipe','-framerate','30','-i','-','-c:v','libx264','-preset','slow','-crf','14','-pix_fmt','yuv420p','-movflags','+faststart', __dirname + '/app/s13.mp4']);
  for (let i = 0; i < 120; i++) { await p.evaluate(t => setT(t), i / 30); ff.stdin.write(await p.screenshot({ type: 'png' })); }
  ff.stdin.end(); await new Promise(r => ff.on('close', r)); await b.close(); console.log('s13 done');
})();
