const E = require('/home/claude/trainer/engine.js'); const fs = require('fs');
const R = require('./qevd_res2.json').filter((r) => r.det >= 60 && r.sub === 'elbow plank' && r.pl && r.pl.n >= 5 && r.view === 'front');
const has = (r, ...l) => r.labels.some((x) => l.includes(x));
const bad = /high hips|hips too|sinking|on the floor|on knees|knees on floor|head|looking|shaking|stopping|not visible|rounded|knees bent|elbows bent|moving/;
const G = { 'голова вниз': R.filter((r) => has(r, 'head down')), 'чистые': R.filter((r) => !r.labels.some((l) => bad.test(l))), 'таз высоко': R.filter((r) => has(r, 'high hips')) };
const raws = new Map(); const raw = (r) => { if (!raws.has(r.id)) { const d = JSON.parse(fs.readFileSync(`qevd/${String(r.id).padStart(8, '0')}.json`)); const pt = new E.PersonTracker();
  raws.set(r.id, d.frames.map((fr) => { const i = pt.pick(fr.poses); return E.makeFrame(fr.t, i < 0 ? null : fr.poses[i], i < 0 ? null : fr.worlds[i], fr.aspect); })); } return raws.get(r.id); };
for (const t of [0.5, 0.7, 0.9]) { E.PL_T.front.head = t;
  console.log('head>' + t, Object.entries(G).map(([k, g]) => { let h = 0, any = 0; for (const r of g) { const a = E.analyze(raw(r), 'plank'); if (a.faults.some((f) => f.code === 'pl_head')) h++; if (a.faults.length) any++; } return `${k}: голова ${h}/${g.length}, любое ${any}`; }).join(' | ')); }
