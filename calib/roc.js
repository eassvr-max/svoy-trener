const R = require('./qevd_res2.json').filter((r) => r.det >= 60 && r.sub === 'squats' && r.reps && r.view === 'front');
const has = (r, ...ls) => r.labels.some((l) => ls.includes(l));
const md = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
const q = (a, p) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const cv = (codes) => (p) => { for (const c of codes) if (p.crit[c] != null) return p.crit[c]; return null; };
const tab = (name, pos, neg, f, ths, perRep = true) => {
  // доля повторов выше порога
  const P = pos.flatMap((r) => r.rp.map(f)).filter((x) => x != null), N = neg.flatMap((r) => r.rp.map(f)).filter((x) => x != null);
  console.log(name, 'повторов +', P.length, '−', N.length, ths.map((t) => `${t}: ${(100 * P.filter((x) => x > t).length / P.length).toFixed(0)}%/${(100 * N.filter((x) => x > t).length / N.length).toFixed(0)}%`).join('  '));
};
const sh = R.filter((r) => has(r, 'shallow', 'insufficient')), ok = R.filter((r) => has(r, '90 degrees', 'over 90 degrees') && !has(r, 'shallow', 'insufficient'));
tab('глубина (ловит/ложно)', sh, ok, cv(['depth', 'sq_depth_minor', 'sq_depth_major']), [10, 12, 14, 16.8, 18, 20, 22, 24]);
const clean = R.filter((r) => has(r, 'no obvious issue') && !has(r, 'shallow', 'insufficient', 'knees over toes', 'back not straight'));
const back = R.filter((r) => has(r, 'back not straight'));
tab('корпус lean (низ)', back, clean, (p) => p.leanB, [25, 30, 35, 40, 45, 50]);
tab('корпус trunk3D (низ)', back, clean, (p) => p.trunkB, [25, 30, 35, 40, 45, 50]);
tab('голова 3D (низ)', back, clean, (p) => p.headB, [0.06, 0.08, 0.1, 0.12, 0.15]);
tab('колени внутрь (no issue)', clean, clean, cv(['knees', 'sq_valgus', 'sq_valgus_minor']), [0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.12]);
const st = cv(['stance', 'sq_stance_narrow', 'sq_stance_wide']);
tab('стойка широкая wide/plie vs shoulder', R.filter((r) => has(r, 'wide', 'plie')), R.filter((r) => has(r, 'shoulder-width')), st, [1.8, 2, 2.2, 2.5, 2.9]);
tab('стойка узкая (−) narrow vs shoulder', R.filter((r) => has(r, 'narrow')), R.filter((r) => has(r, 'shoulder-width')), (p) => { const v = st(p); return v == null ? null : -v; }, [-1, -0.9, -0.85, -0.8]);
