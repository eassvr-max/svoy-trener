// Калибровка по QEVD: для каждой размеченной ошибки — AUC признака и сравнение с порогами движка
const R = require('./qevd_res2.json').filter((r) => r.det >= 60);
const has = (r, ...ls) => r.labels.some((l) => ls.includes(l));
const md = (a) => { a = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
const q = (a, p) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null; };
function auc(p, n) { p = p.filter((x) => x != null); n = n.filter((x) => x != null); if (!p.length || !n.length) return NaN;
  let s = 0; for (const a of p) for (const b of n) s += a > b ? 1 : a === b ? 0.5 : 0; return s / (p.length * n.length); }
const repM = (r, key, agg = md) => (r.rp && r.rp.length ? agg(r.rp.map((p) => typeof key === 'function' ? key(p) : p[key])) : null);
const critV = (codes) => (p) => { for (const c of codes) if (p.crit[c] != null) return p.crit[c]; return null; };
const flagged = (r, codes) => (r.rp || []).some((p) => p.codes.some((c) => codes.includes(c)));
function row(name, pos, neg, val, codes, dir = 1) {
  const P = pos.map(val), N = neg.map(val);
  const a = auc(P.map((x) => x == null ? null : dir * x), N.map((x) => x == null ? null : dir * x));
  const f = (g) => codes ? `${g.filter((r) => flagged(r, codes)).length}/${g.length}` : '-';
  console.log(`${name.padEnd(44)} n+ ${String(P.filter((x) => x != null).length).padStart(4)} n− ${String(N.filter((x) => x != null).length).padStart(4)}  AUC ${a.toFixed(2)}  медиана + ${fmt(md(P))} / − ${fmt(md(N))}  p10/p90 −: ${fmt(q(N, 0.1))}…${fmt(q(N, 0.9))}  флаг движка: ош ${f(pos)} норм ${f(neg)}`);
}
const fmt = (x) => x == null ? '—' : (+x).toFixed(Math.abs(x) < 2 ? 3 : 0);
const views = {}; for (const r of R) views[r.ex + ':' + r.view] = (views[r.ex + ':' + r.view] || 0) + 1; console.log('клипов', R.length, JSON.stringify(views));

console.log('\n=== ПРИСЕДАНИЯ (с повторами) ===');
const SQ = R.filter((r) => r.sub === 'squats' && r.reps);
const sqDepth = (r) => repM(r, critV(['depth', 'sq_depth_minor', 'sq_depth_major']));
row('глубина: shallow/insufficient vs 90/over 90', SQ.filter((r) => has(r, 'shallow', 'insufficient')), SQ.filter((r) => has(r, '90 degrees', 'over 90 degrees') && !has(r, 'shallow', 'insufficient')), sqDepth, ['sq_depth_minor', 'sq_depth_major']);
const clean = SQ.filter((r) => has(r, 'no obvious issue') && !has(r, 'shallow', 'insufficient', 'knees over toes', 'back not straight'));
row('колени за носки (3D kot) vs no issue', SQ.filter((r) => has(r, 'knees over toes')), clean, (r) => repM(r, 'kotB', (a) => q(a, 0.99)), null);
row('спина: trunkB (3D, низ) back not straight', SQ.filter((r) => has(r, 'back not straight')), clean, (r) => repM(r, 'trunkB', (a) => q(a, 0.99)), ['sq_trunk']);
row('спина: trunkMax', SQ.filter((r) => has(r, 'back not straight')), clean, (r) => repM(r, 'trunkMax', (a) => q(a, 0.99)), ['sq_trunk']);
row('спина: голова (3D) back not straight', SQ.filter((r) => has(r, 'back not straight')), clean, (r) => repM(r, 'headB', (a) => q(a, 0.99)), null);
const st = (r) => repM(r, critV(['stance', 'sq_stance_narrow', 'sq_stance_wide']));
row('стойка: narrow vs shoulder-width (меньше=уже)', SQ.filter((r) => has(r, 'narrow')), SQ.filter((r) => has(r, 'shoulder-width')), st, ['sq_stance_narrow'], -1);
row('стойка: wide/plie vs shoulder-width', SQ.filter((r) => has(r, 'wide', 'plie')), SQ.filter((r) => has(r, 'shoulder-width')), st, ['sq_stance_wide']);
row('колени внутрь: no issue — частота флага', clean, clean, (r) => repM(r, critV(['knees', 'sq_valgus', 'sq_valgus_minor']), (a) => q(a, 0.99)), ['sq_valgus', 'sq_valgus_minor']);
console.log('  стойка: перцентили shoulder-width', [0.02, 0.05, 0.1, 0.9, 0.95, 0.98].map((p) => fmt(q(SQ.filter((r) => has(r, 'shoulder-width')).map(st), p))).join(' '));
console.log('  глубина: перцентили 90/over90', [0.5, 0.8, 0.9, 0.95].map((p) => fmt(q(SQ.filter((r) => has(r, '90 degrees', 'over 90 degrees')).map(sqDepth), p))).join(' '), ' shallow:', [0.1, 0.25, 0.5].map((p) => fmt(q(SQ.filter((r) => has(r, 'shallow', 'insufficient')).map(sqDepth), p))).join(' '));

for (const sub of ['pushups', 'pushups (on knees)']) {
  console.log(`\n=== ${sub.toUpperCase()} ===`);
  const PU = R.filter((r) => r.sub === sub && r.reps);
  const el = (r) => repM(r, critV(['depth', 'pu_depth_minor', 'pu_depth_major']));
  row('глубина: shallow/insufficient vs 90/deep', PU.filter((r) => has(r, 'shallow', 'insufficient')), PU.filter((r) => has(r, '90 degrees', 'deep') && !has(r, 'shallow', 'insufficient')), el, ['pu_depth_minor', 'pu_depth_major']);
  const pc = PU.filter((r) => !has(r, 'elevated hips', 'butt sinking', 'child pose cheat'));
  row('таз задран (lineB, меньше=выше)', PU.filter((r) => has(r, 'elevated hips')), pc, (r) => repM(r, 'lineB'), ['pu_pike'], -1);
  row('таз провис (lineB)', PU.filter((r) => has(r, 'butt sinking')), pc, (r) => repM(r, 'lineB'), ['pu_sag', 'pu_sag_minor']);
  console.log('  локоть: перцентили 90/deep', [0.5, 0.8, 0.9, 0.95].map((p) => fmt(q(PU.filter((r) => has(r, '90 degrees', 'deep')).map(el), p))).join(' '), ' shallow:', [0.1, 0.25, 0.5].map((p) => fmt(q(PU.filter((r) => has(r, 'shallow', 'insufficient')).map(el), p))).join(' '));
}

for (const sub of ['elbow plank', 'high plank']) {
  console.log(`\n=== ${sub.toUpperCase()} ===`);
  const PL = R.filter((r) => r.sub === sub && r.pl && r.pl.n >= 5);
  const bad = /high hips|hips too|sinking|on the floor|on knees|knees on floor|head|looking|shaking|stopping|not visible|rounded|knees bent|elbows bent|moving/;
  const pc = PL.filter((r) => !r.labels.some((l) => bad.test(l)));
  const pf = (codes) => (r) => r.faults.some((c) => codes.includes(c));
  const rowP = (name, pos, neg, val, codes, dir = 1) => {
    const P = pos.map(val), N = neg.map(val); const a = auc(P.map((x) => x == null ? null : dir * x), N.map((x) => x == null ? null : dir * x));
    console.log(`${name.padEnd(44)} n+ ${String(pos.length).padStart(4)} n− ${String(neg.length).padStart(4)}  AUC ${a.toFixed(2)}  медиана + ${fmt(md(P))} / − ${fmt(md(N))}  p5/p95 −: ${fmt(q(N, 0.05))}…${fmt(q(N, 0.95))}` + (codes ? `  флаг: ош ${pos.filter(pf(codes)).length}/${pos.length} норм ${neg.filter(pf(codes)).length}/${neg.length}` : ''));
  };
  rowP('таз высоко (line, меньше=выше)', PL.filter((r) => has(r, 'high hips', 'hips too high')), pc, (r) => r.pl.line, ['pl_pike'], -1);
  rowP('таз провис (line)', PL.filter((r) => has(r, 'butt sinking', 'hips too low')), pc, (r) => r.pl.line, ['pl_sag']);
  rowP('таз на полу (line)', PL.filter((r) => r.labels.some((l) => /on the floor|knees on floor|on knees/.test(l))), pc, (r) => r.pl.line, ['pl_sag']);
  rowP('голова вниз (head3)', PL.filter((r) => has(r, 'head down')), pc, (r) => r.pl.head3, null);
  rowP('голова вверх (head3, меньше=выше)', PL.filter((r) => has(r, 'head up', 'looking up')), pc, (r) => r.pl.head3, null, -1);
  rowP('голова вниз (head2)', PL.filter((r) => has(r, 'head down')), pc, (r) => r.pl.head2, null);
  console.log('  чистые: доля с замечаниями движка', pc.filter((r) => r.faults.length).length + '/' + pc.length, JSON.stringify(pc.flatMap((r) => r.faults).reduce((a, c) => (a[c] = (a[c] || 0) + 1, a), {})));
}

console.log('\n=== ВЫПАДЫ ===');
const LU = R.filter((r) => r.ex === 'lunge' && r.reps);
const kn = (r) => repM(r, critV(['depth', 'lu_depth_minor', 'lu_depth_major']));
for (const d of [1, 2, 3, 4, 5]) { const g = LU.filter((r) => has(r, 'depth=' + d)); console.log(`  depth=${d}: n ${g.length} колено медиана ${fmt(md(g.map(kn)))} флаг ${g.filter((r) => flagged(r, ['lu_depth_minor', 'lu_depth_major'])).length}`); }
const lc = LU.filter((r) => has(r, 'no obvious issue'));
row('недостаточно: insufficient vs no issue', LU.filter((r) => has(r, 'insufficient')), lc, kn, ['lu_depth_minor', 'lu_depth_major']);
row('задняя нога прямая (kneeMax 3D)', LU.filter((r) => has(r, 'not bending back leg')), lc, (r) => repM(r, 'kneeMax'), null);
row('задняя нога прямая (kneeMin 3D)', LU.filter((r) => has(r, 'not bending back leg')), lc, (r) => repM(r, 'kneeMin'), null);
row('наклон вперёд (trunkB 3D)', LU.filter((r) => has(r, 'leaning forward')), lc, (r) => repM(r, 'trunkB', (a) => q(a, 0.99)), ['lu_trunk']);
row('наклон вперёд (leanB)', LU.filter((r) => has(r, 'leaning forward')), lc, (r) => repM(r, 'leanB', (a) => q(a, 0.99)), ['lu_trunk']);
row('колено за носок (3D kot)', LU.filter((r) => r.labels.some((l) => /over toes/.test(l))), lc, (r) => repM(r, 'kotB', (a) => q(a, 0.99)), ['lu_knee_toe']);
console.log('  no issue: доля с замечаниями', lc.filter((r) => (r.rp || []).some((p) => p.codes.length)).length + '/' + lc.length, JSON.stringify(lc.flatMap((r) => r.rp.flatMap((p) => p.codes)).reduce((a, c) => (a[c] = (a[c] || 0) + 1, a), {})));
