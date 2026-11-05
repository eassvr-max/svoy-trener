// Калибровка порогов по «хорошим» повторам + честная проверка «без этого человека» (leave-one-subject-out)
const E = require('/home/claude/trainer/engine.js');
const fs = require('fs');
const DIR = '/home/claude/bench/mendeley';
const ex = process.argv[2] || 'squat', exf = ex === 'pushup' ? 'push_up' : 'squat';
const reps = [];   // {subj, q, view, vals:{criterion: value}}
const videos = [];
for (const f of fs.readdirSync(DIR).filter((x) => x.includes(`_${exf}_`) && x.endsWith('.json'))) {
  const p = f.replace('.json', '').replace('push_up', 'pushup').split('_'); const subj = +p[1], q = p[3], view = p[4];
  const d = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')); if (d.error) continue;
  const pt = new E.PersonTracker();
  const r = E.analyze(d.frames.map((fr) => { const i = pt.pick(fr.poses); return E.makeFrame(fr.t, i < 0 ? null : fr.poses[i], i < 0 ? null : fr.worlds[i], fr.aspect); }), ex);
  const vid = { subj, q, view, n: r.reps, reps: [] };
  for (const rep of r.repsDetail) {
    const vals = {};
    for (const c of rep.criteria) if (c.value != null && c.status !== 'na') vals[c.code.replace(/^(sq|pu)_/, '').replace(/_(major|minor)$/, '').replace(/^valgus$/, 'knees').replace(/^shift$/, 'balance').replace(/^fast$/, 'tempo').replace(/^stance_(narrow|wide)$/, 'stance').replace(/^hips_first$/, 'hips').replace(/^sag$|^pike$/, 'line')] = c.value;
    vid.reps.push(vals); reps.push({ subj, q, view, vals });
  }
  videos.push(vid);
}
const pct = (a, x) => { a = a.filter(Number.isFinite).sort((u, v) => u - v); return a.length ? a[Math.min(a.length - 1, Math.floor(x * (a.length - 1)))] : NaN; };
// направление: для какого критерия «плохо» — это большое значение (+1) или маленькое (−1)
const DIR_SIGN = { depth: +1, trunk: +1, hips: +1, knees: +1, heels: +1, lockout: +1, tempo: -1, stance: -1, balance: +1, line: +1, elbows: +1, head: +1 };
const crits = [...new Set(reps.flatMap((r) => Object.keys(r.vals)))].filter((c) => DIR_SIGN[c] != null);
const views = ['front', 'diagonal', 'side'];
function thresholds(R, q = 0.9) {
  const T = {};
  for (const v of views) for (const c of crits) {
    const g = R.filter((r) => r.view === v && r.q === 'good').map((r) => r.vals[c]).filter(Number.isFinite);
    if (g.length < 15) continue;
    T[`${v}|${c}`] = DIR_SIGN[c] > 0 ? pct(g, q) : pct(g, 1 - q);
  }
  return T;
}
const flagged = (T, view, vals, c) => { const t = T[`${view}|${c}`]; if (t == null || vals[c] == null) return false; return DIR_SIGN[c] > 0 ? vals[c] > t : vals[c] < t; };
// LOSO: пороги без этого человека; видео «плохое», если доля повторов с замечаниями ≥ порога
function score(T, vid, use) { if (!vid.reps.length) return 0; let bad = 0; for (const v of vid.reps) if (use.some((c) => flagged(T, vid.view, v, c))) bad++; return bad / vid.reps.length; }
function auc(p, n) { let s = 0; for (const a of p) for (const b of n) s += a > b ? 1 : a === b ? 0.5 : 0; return s / (p.length * n.length); }
const subjects = [...new Set(videos.map((v) => v.subj))];
const sets = JSON.parse(process.argv[3] || '{"все":null}'); const QQ = +(process.argv[4] || 0.9);
for (const [name, use1] of Object.entries(sets)) {
  const use0 = use1 || crits;
  const sc = [];
  for (const s of subjects) {
    const T = thresholds(reps.filter((r) => r.subj !== s), QQ);
    for (const vid of videos.filter((v) => v.subj === s)) sc.push({ ...vid, sc: score(T, vid, use0) });
  }
  for (const v of [...views, 'все']) {
    const S = sc.filter((x) => v === 'все' || x.view === v);
    const g = S.filter((x) => x.q === 'good').map((x) => x.sc), b = S.filter((x) => x.q === 'bad').map((x) => x.sc);
    let best = { acc: 0 }; for (let th = 0.05; th <= 0.95; th += 0.05) { const acc = (g.filter((x) => x < th).length + b.filter((x) => x >= th).length) / (g.length + b.length); if (acc > best.acc) best = { acc, th }; }
    const acc50 = (g.filter((x) => x < 0.5).length + b.filter((x) => x >= 0.5).length) / (g.length + b.length);
    console.log(`${name.padEnd(15)} ${v.padEnd(8)} AUC ${auc(b, g).toFixed(2)}  точность (порог 50% повторов) ${(acc50 * 100).toFixed(0)}%   хороших с замечаниями в среднем ${(100 * g.reduce((a, x) => a + x, 0) / g.length).toFixed(0)}% повторов, плохих ${(100 * b.reduce((a, x) => a + x, 0) / b.length).toFixed(0)}%`);
  }
}
if (process.argv[5]) { const T = thresholds(reps, QQ);
console.log('\nПороги (90-й процентиль правильных повторов):'); for (const k of Object.keys(T).sort()) console.log('  ' + k.padEnd(20), +T[k].toFixed(3));
}
