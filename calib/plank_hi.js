const E = require('/home/claude/trainer/engine.js'); const fs = require('fs');
const R = require('./qevd_res2.json').filter((r) => r.det >= 60 && r.sub === 'high plank' && r.pl && r.pl.n >= 5 && r.view === 'front');
const has = (r, ...l) => r.labels.some((x) => l.includes(x));
const bad = /high hips|hips too|sinking|on the floor|on knees|knees on floor|head|looking|shaking|stopping|not visible|rounded|knees bent|elbows bent|moving/;
const G = { 'таз высоко': R.filter((r) => has(r, 'hips too high')), 'чистые': R.filter((r) => !r.labels.some((l) => bad.test(l))), 'таз низко': R.filter((r) => has(r, 'hips too low')) };
const raws = new Map(); const raw = (r) => { if (!raws.has(r.id)) { const d = JSON.parse(fs.readFileSync(`qevd/${String(r.id).padStart(8, '0')}.json`)); const pt = new E.PersonTracker();
  raws.set(r.id, d.frames.map((fr) => { const i = pt.pick(fr.poses); return E.makeFrame(fr.t, i < 0 ? null : fr.poses[i], i < 0 ? null : fr.worlds[i], fr.aspect); })); } return raws.get(r.id); };
for (const t of [-0.22, -0.28, -0.32, -0.36]) { E.PL_T.frontStraight.pike = t;
  console.log('pike<' + t, Object.entries(G).map(([k, g]) => { const c = {}; for (const r of g) for (const f of E.analyze(raw(r), 'plank').faults) c[f.code] = (c[f.code] || 0) + 1; return `${k}(${g.length}): ${JSON.stringify(c)}`; }).join(' | ')); }
