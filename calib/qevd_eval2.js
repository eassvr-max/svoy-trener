// QEVD: движок + сырые 3D-признаки по повторам → qevd_res2.json (для калибровки по тысячам клипов)
const E = require('/home/claude/trainer/engine.js');
const fs = require('fs');
const sel = [...JSON.parse(fs.readFileSync('/home/claude/bench/qevd_sel.json')), ...JSON.parse(fs.readFileSync('/home/claude/bench/qevd_sel2.json'))];
const EX = (l) => l.startsWith('pushups') ? 'pushup' : l.startsWith('squats') ? 'squat' : l.includes('plank') ? 'plank' : l.includes('lunge') ? 'lunge' : null;
const med = (a) => { a = a.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y); return a.length ? +a[a.length >> 1].toFixed(4) : null; };
const mx = (a) => { a = a.filter((x) => x != null && Number.isFinite(x)); return a.length ? +Math.max(...a).toFixed(4) : null; };
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (a) => Math.hypot(...a), mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
// 3D-признаки одного кадра (мировые координаты MediaPipe: y вниз, метры)
function x3(w) {
  if (!w) return null;
  const sh = mid(w[11], w[12]), hip = mid(w[23], w[24]), ear = mid(w[7], w[8]), nose = w[0];
  const torso = sub(sh, hip), tl = nrm(torso) || 1e-6, tu = torso.map((v) => v / tl);
  const ne = sub(ear, sh), perp = ne.map((v, i) => v - dot(ne, tu) * tu[i]);
  const head = perp[1] / tl; // >0 — ухо ниже продолжения линии таз→плечо (голова опущена)
  const trunk = Math.acos(Math.max(-1, Math.min(1, -torso[1] / tl))) * 180 / Math.PI; // 0 — корпус вертикален
  // направление «вперёд»: горизонталь, перпендикулярная линии таза, в сторону носа
  const hl = sub(w[24], w[23]); let fwd = [-hl[2], 0, hl[0]]; const fl = nrm(fwd) || 1e-6; fwd = fwd.map((v) => v / fl);
  if (dot(sub(nose, hip), fwd) < 0) fwd = fwd.map((v) => -v);
  const leg = (h, k, a) => nrm(sub(w[h], w[k])) + nrm(sub(w[k], w[a]));
  const kot = (k, toe, h, a) => dot(sub(w[k], w[toe]), fwd) / (leg(h, k, a) || 1e-6); // >0 — колено впереди носка
  const ang = (a, b, c) => { const u = sub(w[a], w[b]), v = sub(w[c], w[b]); return Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (nrm(u) * nrm(v) || 1e-6)))) * 180 / Math.PI; };
  return { head, trunk, kotL: kot(25, 31, 23, 27), kotR: kot(26, 32, 24, 28), kneeL: ang(23, 25, 27), kneeR: ang(24, 26, 28) };
}
const out = [];
for (const s of sel) {
  const f = `/home/claude/bench/qevd/${String(s.id).padStart(8, '0')}.json`;
  if (!fs.existsSync(f)) continue;
  let d; try { d = JSON.parse(fs.readFileSync(f)); } catch { continue; } if (d.error) continue;
  const ex = EX(s.labels[0]); if (!ex) continue;
  const pt = new E.PersonTracker(); const W = [];
  const raw = d.frames.map((fr) => { const i = pt.pick(fr.poses); W.push(i < 0 ? null : fr.worlds[i]);
    return E.makeFrame(fr.t, i < 0 ? null : fr.poses[i], i < 0 ? null : fr.worlds[i], fr.aspect); });
  let r; try { r = E.analyze(raw, ex); } catch (e) { continue; }
  const X = W.map(x3), T = d.frames.map((fr) => fr.t);
  const rec = { id: s.id, ex, sub: s.labels[0].split(' - ')[0], labels: s.labels.map((l) => l.split(' - ')[1]), view: r.meta.view, det: r.meta.detectedPct,
    reps: r.reps, score: r.score, faults: (r.faults || []).map((x) => x.code), dur: T[T.length - 1] || 0 };
  if (ex === 'plank') {
    const ok = r.frames.map((fr) => fr.ok && fr.support);
    rec.pl = { line: med(r.frames.filter((fr, k) => ok[k]).map((fr) => fr.bodyLine)), head2: med(r.frames.filter((fr, k) => ok[k]).map((fr) => fr.head)),
      head3: med(X.filter((x, k) => x && ok[k]).map((x) => x.head)), tilt: med(r.frames.filter((fr, k) => ok[k]).map((fr) => fr.bodyTilt)),
      n: ok.filter(Boolean).length, hold: r.holdSec, good: r.goodSec };
  } else {
    rec.rp = (r.repsDetail || []).map((p) => {
      const ks = T.map((t, k) => k).filter((k) => T[k] >= p.start && T[k] <= p.end && r.frames[k].ok);
      // низ повтора: минимум высоты таза (присед, выпад) / минимум угла локтя (отжимание)
      const key = (k) => ex === 'pushup' ? r.frames[k].elbow : r.frames[k].hipH;
      const kb = ks.reduce((a, k) => (a == null || key(k) < key(a) ? k : a), null);
      const near = ks.filter((k) => Math.abs(T[k] - T[kb]) <= 0.2);
      const crit = Object.fromEntries(p.criteria.map((c) => [c.code, c.value]));
      const xb = near.map((k) => X[k]).filter(Boolean);
      return { crit, codes: p.criteria.filter((c) => c.status === 'major' || c.status === 'minor').map((c) => c.code),
        trunkB: med(xb.map((x) => x.trunk)), trunkMax: mx(ks.map((k) => X[k]?.trunk)), headB: med(xb.map((x) => x.head)),
        kotB: med(xb.map((x) => Math.max(x.kotL, x.kotR))), kneeMin: med(xb.map((x) => Math.min(x.kneeL, x.kneeR))), kneeMax: med(xb.map((x) => Math.max(x.kneeL, x.kneeR))),
        leanB: med(near.map((k) => r.frames[k].lean)), lineB: med(ks.map((k) => r.frames[k].bodyLine)) };
    });
  }
  out.push(rec);
}
fs.writeFileSync('/home/claude/bench/qevd_res2.json', JSON.stringify(out));
console.log('клипов:', out.length);
