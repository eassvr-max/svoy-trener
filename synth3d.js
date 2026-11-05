// Синтетический 3D-«человек»: строим позу в метрах, ставим камеру под нужным углом
// и получаем то же, что отдаёт MediaPipe: 2D-точки кадра (0..1) и 3D world-точки (м).
// Тело: X — влево от человека, Y — вверх от пола, Z — вперёд (куда смотрит человек).
'use strict';
const rad = (d) => d * Math.PI / 180;
const V = (x, y, z) => ({ x, y, z });
const add = (a, b) => V(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a, k) => V(a.x * k, a.y * k, a.z * k);
const len = (a) => Math.hypot(a.x, a.y, a.z);
const unit = (a) => mul(a, 1 / (len(a) || 1));
const midp = (a, b) => mul(add(a, b), 0.5);

function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
function gauss(r) { return (r() + r() + r() + r() - 2) * 0.87; }

// ---------- позы ----------
function squatPose({ F = 0, lean = 10, valgus = 0, heelLift = 0, shift = 0 }) {
  const P = new Array(33);
  const alpha = 0.28 * F, beta = F - alpha;
  for (const [sx, s] of [[1, 'L'], [-1, 'R']]) {
    const A = V(sx * 0.13, 0.08 + heelLift * 0.7, 0);
    const kneeOut = sx * (0.13 + 0.05 * F / 120) - sx * valgus * 0.16 * (F / 120);
    const K = V(kneeOut, A.y + 0.43 * Math.cos(rad(alpha)), 0.43 * Math.sin(rad(alpha)));
    const H = V(sx * 0.09 + shift, K.y + 0.43 * Math.cos(rad(beta)), K.z - 0.43 * Math.sin(rad(beta)));
    const ix = s === 'L' ? { hip: 23, kn: 25, an: 27, heel: 29, toe: 31 } : { hip: 24, kn: 26, an: 28, heel: 30, toe: 32 };
    P[ix.hip] = H; P[ix.kn] = K; P[ix.an] = A;
    P[ix.heel] = V(sx * 0.13, 0.03 + heelLift, -0.06);
    P[ix.toe] = V(sx * 0.15, 0.02, 0.17);
  }
  const hc = midp(P[23], P[24]);
  const up = V(0, Math.cos(rad(lean)), Math.sin(rad(lean)));
  const shc = add(hc, mul(up, 0.5));
  for (const [sx, sh, el, wr, ear] of [[1, 11, 13, 15, 7], [-1, 12, 14, 16, 8]]) {
    P[sh] = add(shc, V(sx * 0.18, 0, 0));
    P[el] = add(P[sh], V(0, -0.02, 0.28));
    P[wr] = add(P[el], V(0, 0, 0.26));
    P[ear] = add(add(shc, mul(up, 0.2)), V(sx * 0.07, 0, 0.02));
  }
  P[0] = add(add(shc, mul(up, 0.2)), V(0, -0.02, 0.1));
  return fill(P);
}

function pushupPose({ elbow = 165, sag = 0, flare = 40, headDrop = 0, kneeSupport = false }) {
  const P = new Array(33);
  const u = 0.3, f = 0.27;
  const D = Math.sqrt(u * u + f * f - 2 * u * f * Math.cos(rad(elbow)));
  for (const [sx, sh, el, wr] of [[1, 11, 13, 15], [-1, 12, 14, 16]]) {
    const W = V(sx * 0.24, 0.03, 0);
    const S = V(sx * 0.2, 0.03 + D, 0);
    const a = (u * u - f * f + D * D) / (2 * D), b = Math.sqrt(Math.max(0, u * u - a * a));
    const e = V(sx * Math.sin(rad(flare)), 0, -Math.cos(rad(flare)));
    P[sh] = S; P[wr] = W; P[el] = add(add(S, V(0, -a, 0)), mul(e, b));
  }
  const Sc = midp(P[11], P[12]);
  const Ac = kneeSupport ? V(0, 0.06, -0.95) : V(0, 0.08, -1.45);
  const L = len(sub(Ac, Sc));
  const Hc = add(add(Sc, mul(sub(Ac, Sc), 0.42)), V(0, -sag * L, 0));
  const Kc = kneeSupport ? Ac : add(add(Sc, mul(sub(Ac, Sc), 0.72)), V(0, -sag * L * 0.5, 0));
  const Ankc = kneeSupport ? V(0, 0.15, -1.35) : Ac;
  for (const [sx, hip, kn, an, heel, toe] of [[1, 23, 25, 27, 29, 31], [-1, 24, 26, 28, 30, 32]]) {
    P[hip] = add(Hc, V(sx * 0.09, 0, 0)); P[kn] = add(Kc, V(sx * 0.1, 0, 0)); P[an] = add(Ankc, V(sx * 0.1, 0, 0));
    P[heel] = add(P[an], V(0, 0.05, -0.05)); P[toe] = add(P[an], V(0, -0.06, 0.08));
  }
  const fwd = unit(sub(Sc, Hc));
  for (const [sx, ear] of [[1, 7], [-1, 8]]) P[ear] = add(add(Sc, mul(fwd, 0.22)), V(sx * 0.07, -headDrop, 0));
  P[0] = add(add(Sc, mul(fwd, 0.25)), V(0, -0.04 - headDrop, 0.04));
  return fill(P);
}

function plankPose({ sag = 0, headDrop = 0, shoulderFwd = 0 }) {
  const P = new Array(33);
  for (const [sx, sh, el, wr] of [[1, 11, 13, 15], [-1, 12, 14, 16]]) {
    P[el] = V(sx * 0.18, 0.03, 0); P[wr] = V(sx * 0.13, 0.03, 0.27);
    P[sh] = V(sx * 0.2, 0.33, shoulderFwd);
  }
  const Sc = midp(P[11], P[12]), Ac = V(0, 0.08, -1.42);
  const L = len(sub(Ac, Sc));
  const Hc = add(add(Sc, mul(sub(Ac, Sc), 0.42)), V(0, -sag * L, 0));
  const Kc = add(add(Sc, mul(sub(Ac, Sc), 0.72)), V(0, -sag * L * 0.5, 0));
  for (const [sx, hip, kn, an, heel, toe] of [[1, 23, 25, 27, 29, 31], [-1, 24, 26, 28, 30, 32]]) {
    P[hip] = add(Hc, V(sx * 0.09, 0, 0)); P[kn] = add(Kc, V(sx * 0.1, 0, 0)); P[an] = add(Ac, V(sx * 0.1, 0, 0));
    P[heel] = add(P[an], V(0, 0.05, -0.05)); P[toe] = add(P[an], V(0, -0.06, 0.08));
  }
  const fwd = unit(sub(Sc, Hc));
  for (const [sx, ear] of [[1, 7], [-1, 8]]) P[ear] = add(add(Sc, mul(fwd, 0.22)), V(sx * 0.07, -headDrop, 0));
  P[0] = add(add(Sc, mul(fwd, 0.25)), V(0, -0.04 - headDrop, 0.04));
  return fill(P);
}

// Выпад (сплит-присед): стопы на месте, таз опускается; drop 0..1 — глубина, hipZ — вынос таза вперёд (колено за носок)
function ikFwd(H, A, l1, l2) { // двухзвенник в плоскости yz, колено сгибается вперёд (+z)
  const d = sub(A, H), L = Math.min(len(d), l1 + l2 - 1e-6);
  const u = unit(d), a = (l1 * l1 - l2 * l2 + L * L) / (2 * L), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let perp = unit(V(0, -u.z, u.y)); if (perp.z < 0) perp = mul(perp, -1);
  return add(add(H, mul(u, a)), mul(perp, h));
}
function lungePose({ drop = 0, hipZ = 0.02, lean = 5, front = 'L' }) {
  const P = new Array(33);
  const sf = front === 'L' ? 1 : -1;
  const Af = V(sf * 0.12, 0.08, 0.38), Ar = V(-sf * 0.12, 0.12, -0.52);
  const hy = 0.92 - drop * 0.44;
  const Hf = V(sf * 0.09, hy, hipZ), Hr = V(-sf * 0.09, hy, hipZ);
  const Kf = ikFwd(Hf, Af, 0.43, 0.43), Kr = ikFwd(Hr, Ar, 0.43, 0.43);
  const fi = front === 'L' ? { hip: 23, kn: 25, an: 27, heel: 29, toe: 31 } : { hip: 24, kn: 26, an: 28, heel: 30, toe: 32 };
  const ri = front === 'L' ? { hip: 24, kn: 26, an: 28, heel: 30, toe: 32 } : { hip: 23, kn: 25, an: 27, heel: 29, toe: 31 };
  P[fi.hip] = Hf; P[fi.kn] = Kf; P[fi.an] = Af; P[fi.heel] = add(Af, V(0, -0.05, -0.06)); P[fi.toe] = add(Af, V(0, -0.06, 0.17));
  P[ri.hip] = Hr; P[ri.kn] = Kr; P[ri.an] = Ar; P[ri.heel] = add(Ar, V(0, 0.05, -0.05)); P[ri.toe] = add(Ar, V(0, -0.1, 0.12));
  const Hc = midp(Hf, Hr);
  const up = V(0, Math.cos(rad(lean)), Math.sin(rad(lean)));
  const shc = add(Hc, mul(up, 0.5));
  for (const [sx, sh, el, wr, ear] of [[1, 11, 13, 15, 7], [-1, 12, 14, 16, 8]]) {
    P[sh] = add(shc, V(sx * 0.18, 0, 0)); P[el] = add(P[sh], V(sx * 0.05, -0.27, 0.02)); P[wr] = add(P[el], V(sx * 0.02, -0.25, 0.03));
    P[ear] = add(add(shc, mul(up, 0.2)), V(sx * 0.07, 0, 0.02));
  }
  P[0] = add(add(shc, mul(up, 0.2)), V(0, -0.02, 0.1));
  return fill(P);
}

// недостающие точки лица/кистей — рядом с ближайшими суставами
function fill(P) {
  const near = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 9: 0, 10: 0, 17: 15, 19: 15, 21: 15, 18: 16, 20: 16, 22: 16 };
  for (let i = 0; i < 33; i++) if (!P[i]) P[i] = P[near[i] ?? 0];
  return P;
}

// ---------- камера ----------
const LEFT = new Set([1, 2, 3, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]);
function render(P, yaw, { aspect = 16 / 9, r, scale = 0.45, cx = 0.5, floorY = 0.93, noise = 1 } = {}) {
  const u = V(Math.cos(rad(yaw)), 0, Math.sin(rad(yaw)));
  const d = V(-Math.sin(rad(yaw)), 0, Math.cos(rad(yaw)));
  const hc = midp(P[23], P[24]);
  const xs = P.map((p) => p.x * u.x + p.z * u.z);
  const xmid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const sideness = Math.abs(Math.sin(rad(yaw)));
  const lm = [], wl = [];
  for (let i = 0; i < 33; i++) {
    const p = P[i];
    const ix = p.x * u.x + p.z * u.z - xmid;
    // видимость: в профиль дальняя сторона (левая при yaw>0) видна хуже
    const far = yaw > 0 ? LEFT.has(i) : false;
    const vis = 0.97 - (far ? 0.45 * sideness : 0);
    lm.push({ x: cx + ix * scale / aspect + gauss(r) * 0.003 * noise, y: floorY - p.y * scale + gauss(r) * 0.003 * noise, z: 0, visibility: vis });
    const q = sub(p, hc);
    wl.push({ x: q.x * u.x + q.z * u.z + gauss(r) * 0.01 * noise, y: -q.y + gauss(r) * 0.01 * noise, z: -(q.x * d.x + q.z * d.z) + gauss(r) * 0.03 * noise });
  }
  return { lm, wl };
}

// подъём гантелей на бицепс: flex — сгиб локтя (0 — рука прямая), upper — плечо уходит вперёд, lean — наклон корпуса (<0 — назад)
function curlPose({ flexL = 0, flexR = 0, upper = 0, lean = 3 }) {
  const P = squatPose({ F: 0, lean });
  for (const [sh, el, wr, flex] of [[11, 13, 15, flexL], [12, 14, 16, flexR]]) {
    const u = upper * Math.min(1, flex / 90), a = rad(u), b = rad(u + flex);
    P[el] = add(P[sh], V(0, -0.28 * Math.cos(a), 0.28 * Math.sin(a)));
    P[wr] = add(P[el], V(0, -0.26 * Math.cos(b), 0.26 * Math.sin(b)));
  }
  for (const i of [17, 18, 19, 20, 21, 22]) P[i] = undefined;
  return fill(P);
}

// последовательность кадров: phases = [[сек, (u)=>поза], ...]
function sequence(phases, yaw, { fps = 30, seed = 11, dropout = 0, aspect = 16 / 9, noise = 1 } = {}) {
  const r = rng(seed), out = [];
  let t = 0;
  for (const [dur, fn] of phases) {
    const n = Math.round(dur * fps);
    for (let i = 0; i < n; i++) {
      if (dropout && r() < dropout) out.push({ t, lm: null, wl: null, aspect });
      else { const { lm, wl } = render(fn(i / n), yaw, { aspect, r, noise }); out.push({ t, lm, wl, aspect }); }
      t += 1 / fps;
    }
  }
  return out;
}

const wave = (u) => (1 - Math.cos(2 * Math.PI * u)) / 2;
module.exports = { curlPose, lungePose, squatPose, pushupPose, plankPose, render, sequence, wave };
