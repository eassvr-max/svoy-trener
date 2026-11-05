// Проверка страницы v2 целиком. Нейросеть подменена: «видит» синтетического 3D-человека из synth3d.js.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const synth = fs.readFileSync(path.join(__dirname, 'synth3d.js'), 'utf8');
const MOCK = `
var module = { exports: {} };
${synth}
window.SYN = module.exports;
(() => {
  const S = window.SYN; let k = 1;
  const r = () => (k = (k * 16807) % 2147483647) / 2147483647;
  const plan = [{},{F:130},{},{F:78},{lean:68},{},{valgus:0},{F:105},{}];
  function pose(t) {
    t -= 1.2;
    if (t < 0 || (!window.__loop && t >= plan.length * 2.6)) return S.squatPose({});
    const i = Math.floor(t / 2.6) % plan.length, u = (t % 2.6) / 2.6, w = S.wave(u), p = plan[i];
    const F = p.F ?? 125, lean = p.lean ?? 35;
    return S.squatPose({ F: F * w, lean: 8 + (lean - 8) * w });
  }
  window.__MOCK_POSE__ = { detectForVideo(v) {
    const t = v.srcObject ? performance.now() / 1000 - (window.__t0 ??= performance.now() / 1000) - 3.5 : v.currentTime;
    const { lm, wl } = S.render(pose(t), 90, { r, cx: 0.45 });
    return { landmarks: [lm], worldLandmarks: [wl] };
  }};
})();`;

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 1, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.join(__dirname, 'dist/svoy-trener.html'));
  await page.click('[data-ex="squat"]');
  await page.screenshot({ path: 'shots/v2-setup.png' });
  await page.setInputFiles('#file', path.join(__dirname, 'test27.mp4'));
  await page.waitForTimeout(9000);
  await page.screenshot({ path: 'shots/v2-work.png' });
  await page.waitForSelector('#screen-report:not([hidden])', { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shots/v2-report.png', fullPage: true });
  const res = await page.evaluate(() => window.svoyTrenerLastResult);
  console.log('ФАЙЛ: reps', res.reps, 'score', res.score, '|', res.repsDetail.map((r) => `${r.n}:${r.score}:${r.faults.join('+') || 'ok'}`).join(' '));
  console.log('meta', JSON.stringify(res.meta));

  // живая камера (фейковая камера Chromium + подменная модель): план 4 повтора × 2 подхода, отдых 15 с
  await page.click('#btn-again');
  await page.evaluate(() => { window.__t0 = undefined; window.__loop = true; window.__said = [];
    const orig = speechSynthesis.speak.bind(speechSynthesis); speechSynthesis.speak = (u) => { window.__said.push(u.text); orig(u); }; });
  const planTxt = await page.evaluate(() => [document.getElementById('pl-target').textContent, document.getElementById('pl-sets').textContent, document.getElementById('pl-why').textContent]);
  console.log('план по умолчанию:', planTxt.join(' / '));
  for (let i = 0; i < 8; i++) await page.click('[data-pl="target"][data-d="-1"]');
  await page.click('[data-pl="sets"][data-d="-1"]');
  for (let i = 0; i < 4; i++) await page.click('[data-pl="rest"][data-d="-1"]');
  await page.screenshot({ path: 'shots/v2-plan.png' });
  await page.click('#btn-camera');
  await page.waitForTimeout(14000);
  await page.screenshot({ path: 'shots/v2-live.png' });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'shots/v2-rest.png' });
  await page.waitForSelector('#screen-report:not([hidden])', { timeout: 60000 });
  await page.waitForTimeout(1500);
  const live = await page.evaluate(() => window.svoyTrenerLastResult);
  console.log('КАМЕРА: подходы', JSON.stringify(live.sets), 'reps', live.reps, 'score', live.score);
  console.log('голос:', (await page.evaluate(() => window.__said)).join(' | '));
  await page.screenshot({ path: 'shots/v2-live-report.png', fullPage: true });
  const hist = await page.evaluate(() => localStorage.getItem('st_hist_squat'));
  console.log('история:', hist);
  await page.click('#btn-again');
  console.log('план на следующий раз:', await page.evaluate(() => document.getElementById('pl-target').textContent + ' — ' + document.getElementById('pl-why').textContent));
  console.log('ошибки страницы:', errors.length ? errors : 'нет');
  await browser.close();
})();
