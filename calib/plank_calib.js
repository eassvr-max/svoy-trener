// Калибровка оценки линии тела на размеченных кадрах реальных людей (C — правильно, H — таз задран, L — провисает)
const E = require('/home/claude/trainer/engine.js');
const fs = require('fs');
const NAMES = ['nose','left_shoulder','right_shoulder','left_elbow','right_elbow','left_wrist','right_wrist','left_hip','right_hip','left_knee','right_knee','left_ankle','right_ankle','left_heel','right_heel','left_foot_index','right_foot_index'];
const IDX = [0,11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32];
function load(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n'); const head = lines[0].split(',');
  return lines.slice(1).map((ln) => {
    const v = ln.split(','); const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
    NAMES.forEach((n, k) => { const c = head.indexOf(n + '_x'); lm[IDX[k]] = { x: +v[c], y: +v[c + 1], z: +v[c + 2], visibility: +v[c + 3] }; });
    for (const [e, src] of [[7, 0], [8, 0]]) lm[e] = { ...lm[src], visibility: 0 }; // ушей в наборе нет
    return { label: v[0], lm };
  });
}
const aspect = +(process.argv[3] || 16 / 9);
const rows = load(process.argv[2]);
const feats = rows.map((r) => ({ label: r.label, f: E.features(E.makeFrame(0, r.lm, null, aspect)) })).filter((x) => x.f.ok);
const by = {}; for (const x of feats) (by[x.label] ??= []).push(x.f.bodyLine);
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };
for (const k of ['C', 'H', 'L']) { const a = by[k]; console.log(k, 'n=' + a.length, 'перцентили 5/25/50/75/95:', [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => pct(a, q).toFixed(3)).join(' ')); }
// точность при текущих и подобранных порогах
function acc(sagT, pikeT) {
  let ok = 0; const cm = { C: { C: 0, H: 0, L: 0 }, H: { C: 0, H: 0, L: 0 }, L: { C: 0, H: 0, L: 0 } };
  for (const x of feats) { const p = x.f.bodyLine > sagT ? 'L' : x.f.bodyLine < pikeT ? 'H' : 'C'; cm[x.label][p]++; if (p === x.label) ok++; }
  return { acc: ok / feats.length, cm };
}
const cur = acc(+(process.env.S||0.05), +(process.env.P||-0.08)); console.log('текущие пороги (+0.05/−0.08): точность', (cur.acc * 100).toFixed(1) + '%', JSON.stringify(cur.cm));
let best = null;
for (let s = 0.0; s <= 0.12; s += 0.005) for (let p = -0.15; p <= 0; p += 0.005) { const a = acc(s, p); if (!best || a.acc > best.acc) best = { ...a, s, p }; }
console.log(`лучшие пороги (+${best.s.toFixed(3)}/${best.p.toFixed(3)}): точность`, (best.acc * 100).toFixed(1) + '%', JSON.stringify(best.cm));
console.log(JSON.stringify({ s: best.s, p: best.p }));
