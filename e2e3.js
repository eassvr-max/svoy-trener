const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const synth = fs.readFileSync(path.join(__dirname, 'synth3d.js'), 'utf8');
const phrases = require('./tools/phrases.json');
// поддельный голосовой пакет: у каждой фразы «запись» с её текстом внутри, чтобы проверить склейку
const pack = {}; for (const p of phrases) pack[p] = 'data:audio/wav;base64,' + Buffer.from(p).toString('base64');
const MOCK = `
var module = { exports: {} };
${synth}
window.SYN = module.exports;
window.VOICE_PACK = ${JSON.stringify(pack)};
window.__played = [];
window.Audio = function (src) { this.src = src; this.play = () => { window.__played.push(decodeURIComponent(escape(atob(src.split(',')[1])))); setTimeout(() => this.onended && this.onended(), 30); return Promise.resolve(); }; this.pause = () => {}; };
(() => {
  const S = window.SYN; let k = 1; const r = () => (k = (k * 16807) % 2147483647) / 2147483647;
  const plan = [{}, {}, { hipZ: 0.3 }, { drop: 0.3 }, { front: 'R' }, { front: 'R' }, { front: 'R', hipZ: 0.3 }];
  function pose(t) { t -= 1.2; if (t < 0 || t >= plan.length * 2.6) return S.lungePose({ drop: 0, front: t < 0 ? 'L' : 'R' });
    const i = Math.floor(t / 2.6), u = (t % 2.6) / 2.6, w = S.wave(u), p = plan[i];
    return S.lungePose({ drop: (p.drop ?? 1) * w, hipZ: 0.02 + ((p.hipZ ?? 0.02) - 0.02) * w, front: p.front || 'L' }); }
  window.__MOCK_POSE__ = { detectForVideo(v) { const { lm, wl } = S.render(pose(v.currentTime), 90, { r, cx: 0.5 }); return { landmarks: [lm], worldLandmarks: [wl] }; } };
})();`;
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 400, height: 860 } })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.join(__dirname, 'dist/svoy-trener.html'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shots/v6-home.png' });
  const opts = await page.$$eval('#voice-sel option', (o) => o.map((x) => x.textContent));
  console.log('голоса в списке:', opts);
  await page.click('#voice-test'); await page.waitForTimeout(400);
  console.log('проверка голоса проиграла:', await page.evaluate(() => window.__played.splice(0)));
  await page.click('[data-ex="lunge"]');
  await page.setInputFiles('#file', path.join(__dirname, 'test27.mp4'));
  await page.waitForSelector('#screen-report:not([hidden])', { timeout: 150000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'shots/v6-lunge-report.png', fullPage: true });
  const res = await page.evaluate(() => window.svoyTrenerLastResult);
  console.log('выпады: повторов', res.reps, '| ноги', res.repsDetail.map((r) => r.leg).join(''), '|', res.repsDetail.map((r) => r.faults.join('+') || 'ok').join(' | '));
  console.log('итог озвучен записями:', await page.evaluate(() => window.__played.splice(0)));
  console.log('ошибки страницы:', errors.length ? errors : 'нет');
  await browser.close();
})();
