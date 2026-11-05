// Итоговая проверка движка как есть: видео «плохое», если в ≥ порога повторов есть серьёзное замечание
const E = require('/home/claude/trainer/engine.js');
const fs = require('fs');
const ex = process.argv[2] || 'squat', exf = ex === 'pushup' ? 'push_up' : 'squat';
const V = [];
for (const f of fs.readdirSync('mendeley').filter((x) => x.includes(`_${exf}_`) && x.endsWith('.json'))) {
  const p = f.replace('.json', '').replace('push_up', 'pushup').split('_');
  const d = JSON.parse(fs.readFileSync('mendeley/' + f, 'utf8')); if (d.error) continue;
  const pt = new E.PersonTracker();
  const r = E.analyze(d.frames.map((fr) => { const i = pt.pick(fr.poses); return E.makeFrame(fr.t, i < 0 ? null : fr.poses[i], i < 0 ? null : fr.worlds[i], fr.aspect); }), ex);
  const badFrac = r.reps ? r.repsDetail.filter((x) => !x.good).length / r.reps : NaN;
  V.push({ f, q: p[3], view: p[4], reps: r.reps, score: r.score, badFrac, top: r.priority?.code || '-' });
}
function auc(p, n) { let s = 0; for (const a of p) for (const b of n) s += a > b ? 1 : a === b ? 0.5 : 0; return s / (p.length * n.length); }
for (const v of ['front', 'diagonal', 'side', 'все']) {
  const S = V.filter((x) => (v === 'все' || x.view === v) && x.reps > 0);
  const g = S.filter((x) => x.q === 'good'), b = S.filter((x) => x.q === 'bad');
  const acc = (th) => (g.filter((x) => x.badFrac < th).length + b.filter((x) => x.badFrac >= th).length) / S.length;
  const z = V.filter((x) => (v === 'все' || x.view === v) && !x.reps).length;
  console.log(`${v.padEnd(9)} видео ${S.length}  AUC ${auc(b.map((x) => x.badFrac), g.map((x) => x.badFrac)).toFixed(2)}  точность ${(acc(0.3) * 100).toFixed(0)}% (порог 30%) / ${(acc(0.5) * 100).toFixed(0)}% (50%)   хорошие: серьёзных замечаний в ${(100 * g.reduce((a, x) => a + x.badFrac, 0) / g.length).toFixed(0)}% повторов, плохие: ${(100 * b.reduce((a, x) => a + x.badFrac, 0) / b.length).toFixed(0)}%   без повторов: ${z}`);
}
const cnt = {}; for (const x of V.filter((x) => x.q === 'bad')) cnt[x.top] = (cnt[x.top] || 0) + 1; console.log('главная ошибка в «плохих» видео:', JSON.stringify(cnt));
const cg = {}; for (const x of V.filter((x) => x.q === 'good')) cg[x.top] = (cg[x.top] || 0) + 1; console.log('главная «ошибка» в хороших:', JSON.stringify(cg));
