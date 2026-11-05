/* Свой тренер — движок анализа техники v2.
 *
 * Конвейер:
 *   кадры (2D-точки + 3D world-точки MediaPipe)
 *   → заполнение пропусков и сглаживание (офлайн: гауссово, без запаздывания; онлайн: One Euro)
 *   → признаки кадра (углы суставов в 2D и 3D, смешанные с учётом ракурса)
 *   → поиск повторов по форме сигнала, под амплитуду конкретного человека
 *   → оценка каждого повтора по профессиональным критериям (с измеренными значениями и баллом 0–100)
 *   → итог подхода: сильные стороны, главная задача, подводящие упражнения.
 *
 * Без DOM: работает и в браузере, и в Node (для тестов).
 */
(function (root) {
  'use strict';

  // ---------------- индексы точек MediaPipe ----------------
  const I = { nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
    lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };
  const SIDES = {
    L: { ear: 7, sh: 11, el: 13, wr: 15, hip: 23, kn: 25, an: 27, heel: 29, toe: 31 },
    R: { ear: 8, sh: 12, el: 14, wr: 16, hip: 24, kn: 26, an: 28, heel: 30, toe: 32 },
  };
  const DEG = 180 / Math.PI;

  // ---------------- векторная математика ----------------
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) });
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: (a.z || 0) + (b.z || 0) });
  const mul = (a, k) => ({ x: a.x * k, y: a.y * k, z: (a.z || 0) * k });
  const dot = (a, b) => a.x * b.x + a.y * b.y + (a.z || 0) * (b.z || 0);
  const norm = (a) => Math.hypot(a.x, a.y, a.z || 0);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2, v: Math.min(a.v ?? 1, b.v ?? 1) });
  const flat = (p) => ({ x: p.x, y: p.y, z: 0 });
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const lerp = (a, b, k) => a + (b - a) * k;
  function angBetween(u, v) {
    const d = norm(u) * norm(v);
    return d ? Math.acos(clamp(dot(u, v) / d, -1, 1)) * DEG : 0;
  }
  const jointAngle = (a, b, c) => angBetween(sub(a, b), sub(c, b));
  // угол вектора от вертикали «вверх» (ось y направлена вниз и в кадре, и в world-координатах MediaPipe)
  const fromVertical = (v) => angBetween(v, { x: 0, y: -1, z: 0 });
  const lineFromVertical = (v) => { const a = fromVertical(v); return Math.min(a, 180 - a); };
  // насколько вектор опущен ниже горизонтали: >0 — конец ниже начала
  const belowHorizontal = (v) => { const n = norm(v); return n ? Math.asin(clamp(v.y / n, -1, 1)) * DEG : 0; };
  // смещение точки P от прямой A→B, перпендикулярно, со знаком «вниз = +», в долях |AB|
  function lineOffset(a, b, p) {
    const d = sub(b, a), L2 = dot(d, d);
    if (!L2) return 0;
    const k = dot(sub(p, a), d) / L2;
    const off = sub(p, add(a, mul(d, k)));
    const m = norm(off) / Math.sqrt(L2);
    return off.y >= 0 ? m : -m;
  }
  function percentile(arr, q) {
    const s = arr.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return NaN;
    const i = clamp((s.length - 1) * q, 0, s.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
    return lerp(s[lo], s[hi], i - lo);
  }
  const mean = (arr) => { const s = arr.filter(Number.isFinite); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN; };
  const maxOf = (arr) => arr.reduce((m, x) => (Number.isFinite(x) && x > m ? x : m), -Infinity);
  const minOf = (arr) => arr.reduce((m, x) => (Number.isFinite(x) && x < m ? x : m), Infinity);

  // ---------------- кадры ----------------
  // Кадр: { t, img: [{x,y,v}] — x умножен на соотношение сторон (чтобы углы в кадре были честными),
  //         w: [{x,y,z,v}] | null — метрические 3D-координаты MediaPipe (центр — между тазобедренными) }
  function makeFrame(t, lm, wl, aspect) {
    if (!lm) return { t, img: null, w: null };
    return {
      t, aspect,
      img: lm.map((p) => ({ x: p.x * aspect, y: p.y, v: p.visibility ?? 1 })),
      w: wl ? wl.map((p, i) => ({ x: p.x, y: p.y, z: p.z, v: lm[i].visibility ?? 1 })) : null,
    };
  }

  // Если в кадре несколько людей — берём самого крупного и уверенно видимого
  function pickPerson(landmarksList) {
    if (!landmarksList || !landmarksList.length) return -1;
    let best = 0, bestScore = -1;
    landmarksList.forEach((lm, i) => {
      let x0 = 1, x1 = 0, y0 = 1, y1 = 0, vs = 0;
      for (const p of lm) { if ((p.visibility ?? 1) < 0.5) continue; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); vs += p.visibility ?? 1; }
      const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
      const centre = 1 - Math.min(1, Math.abs((x0 + x1) / 2 - 0.5) * 1.2);
      const score = area * (vs / lm.length) * (0.6 + 0.4 * centre);
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  // Слежение за человеком: держимся того, кого выбрали раньше (по положению и размеру), а не самого крупного в каждом кадре
  class PersonTracker {
    constructor() { this.prev = null; }
    pick(list) {
      if (!list || !list.length) return -1;
      const box = (lm) => { const v = lm.filter((p) => (p.visibility ?? 1) > 0.3); const xs = (v.length ? v : lm).map((p) => p.x), ys = (v.length ? v : lm).map((p) => p.y);
        return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, h: Math.max(...ys) - Math.min(...ys) }; };
      let i = 0;
      if (list.length > 1) {
        if (!this.prev) i = pickPerson(list);
        else {
          let best = Infinity;
          list.forEach((lm, k) => { const b = box(lm); const d = Math.hypot(b.cx - this.prev.cx, b.cy - this.prev.cy) + Math.abs(Math.log((b.h + 1e-3) / (this.prev.h + 1e-3))) * 0.3; if (d < best) { best = d; i = k; } });
        }
      }
      const b = box(list[i]);
      this.prev = this.prev ? { cx: lerp(this.prev.cx, b.cx, 0.5), cy: lerp(this.prev.cy, b.cy, 0.5), h: lerp(this.prev.h, b.h, 0.5) } : b;
      return i;
    }
  }

  // ---------------- сглаживание ----------------
  // Онлайн: One Euro filter — мало дрожания в покое и малая задержка при быстром движении
  class OneEuro {
    constructor(minCutoff = 1.7, beta = 0.6, dCutoff = 1.2) { Object.assign(this, { minCutoff, beta, dCutoff }); this.x = null; this.dx = 0; this.t = null; }
    static alpha(cut, dt) { const r = 2 * Math.PI * cut * dt; return r / (r + 1); }
    filter(x, t) {
      if (this.x == null || this.t == null || t <= this.t) { this.x = x; this.t = t; return x; }
      const dt = Math.min(0.2, t - this.t); this.t = t;
      const dx = (x - this.x) / dt;
      this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
      const cut = this.minCutoff + this.beta * Math.abs(this.dx);
      this.x += OneEuro.alpha(cut, dt) * (x - this.x);
      return this.x;
    }
  }
  class FrameFilter {
    constructor() { this.img = null; this.w = null; }
    apply(fr) {
      if (!fr.img) return fr;
      const mk = () => Array.from({ length: 33 }, () => ({ x: new OneEuro(), y: new OneEuro(), z: new OneEuro(1.2, 0.4) }));
      if (!this.img) this.img = mk();
      if (fr.w && !this.w) this.w = mk();
      const img = fr.img.map((p, i) => ({ x: this.img[i].x.filter(p.x, fr.t), y: this.img[i].y.filter(p.y, fr.t), v: p.v }));
      const w = fr.w ? fr.w.map((p, i) => ({ x: this.w[i].x.filter(p.x, fr.t), y: this.w[i].y.filter(p.y, fr.t), z: this.w[i].z.filter(p.z, fr.t), v: p.v })) : null;
      return { t: fr.t, img, w, aspect: fr.aspect };
    }
  }

  // Офлайн: линейно заполняем короткие пропуски (≤0.4 с), затем гауссово сглаживание в обе стороны по времени
  function smoothOffline(frames, sigma = 0.045) {
    const n = frames.length;
    const out = frames.map((f) => ({ t: f.t, img: f.img, w: f.w, interp: false, aspect: f.aspect }));
    // заполнение пропусков
    let i = 0;
    while (i < n) {
      if (out[i].img) { i++; continue; }
      let j = i; while (j < n && !out[j].img) j++;
      const a = i - 1, b = j;
      if (a >= 0 && b < n && out[b].t - out[a].t <= 0.4) {
        for (let k = i; k < j; k++) {
          const u = (out[k].t - out[a].t) / (out[b].t - out[a].t);
          const L = (A, B) => A.map((p, m) => ({ x: lerp(p.x, B[m].x, u), y: lerp(p.y, B[m].y, u), z: lerp(p.z || 0, B[m].z || 0, u), v: Math.min(p.v, B[m].v) * 0.8 }));
          out[k] = { t: out[k].t, img: L(out[a].img, out[b].img), w: out[a].w && out[b].w ? L(out[a].w, out[b].w) : null, interp: true, aspect: out[a].aspect };
        }
      }
      i = j;
    }
    // гауссово сглаживание
    const res = new Array(n);
    const R = 3 * sigma;
    let lo = 0;
    for (let k = 0; k < n; k++) {
      if (!out[k].img) { res[k] = out[k]; continue; }
      while (out[lo].t < out[k].t - R) lo++;
      const accI = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0, s: 0 }));
      const hasW = !!out[k].w;
      const accW = hasW ? Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, s: 0 })) : null;
      for (let m = lo; m < n && out[m].t <= out[k].t + R; m++) {
        const f = out[m]; if (!f.img) continue;
        const dt = f.t - out[k].t, g = Math.exp(-(dt * dt) / (2 * sigma * sigma));
        for (let p = 0; p < 33; p++) {
          const q = f.img[p], wv = g * (0.15 + q.v);
          const A = accI[p]; A.x += q.x * wv; A.y += q.y * wv; A.v += q.v * g; A.s += wv;
          if (hasW && f.w) { const B = accW[p], r = f.w[p]; B.x += r.x * wv; B.y += r.y * wv; B.z += r.z * wv; B.s += wv; }
        }
      }
      // координаты сглажены, видимость оставляем исходной
      const img = accI.map((A, p) => ({ x: A.x / A.s, y: A.y / A.s, v: out[k].img[p].v }));
      const w = hasW ? accW.map((B) => (B.s ? { x: B.x / B.s, y: B.y / B.s, z: B.z / B.s } : { x: 0, y: 0, z: 0 })) : null;
      if (w) for (let p = 0; p < 33; p++) w[p].v = out[k].img[p].v;
      res[k] = { t: out[k].t, img, w, interp: out[k].interp, aspect: out[k].aspect };
    }
    return res;
  }

  // ---------------- признаки кадра ----------------
  // Ракурс: 0° — человек лицом/спиной к камере, 90° — боком
  function yawOf(fr) {
    const im = fr.img;
    const torso = norm(sub(mid(im[11], im[12]), mid(im[23], im[24]))) || 1e-6;
    const sw = Math.abs(im[11].x - im[12].x) / torso, hw = Math.abs(im[23].x - im[24].x) / torso;
    const yaw2d = Math.acos(clamp(((sw / 0.75) + (hw / 0.5)) / 2, 0, 1)) * DEG;
    if (!fr.w) return yaw2d;
    const w = fr.w;
    const s = sub(w[11], w[12]), h = sub(w[23], w[24]);
    const yaw3d = Math.atan2(Math.abs(s.z + h.z), Math.abs(s.x + h.x)) * DEG;
    // на реальных видео объёмная оценка разделяет ракурсы чисто (спереди 1–3°, диагональ 24–47°, сбоку 79–86°),
    // а плоская путает диагональ с фасом — берём в основном объёмную
    return 0.85 * yaw3d + 0.15 * yaw2d;
  }
  // Ракурс по углу поворота (откалибровано на 3 ракурсах реальных видео 26 человек)
  const FRONT_MAX = 15, SIDE_MIN = 60;
  const sidenessOf = (yaw) => clamp((yaw - 15) / 50, 0, 1);
  const viewOf = (yaw) => (yaw < FRONT_MAX ? 'front' : yaw > SIDE_MIN ? 'side' : 'angle');

  function features(fr) {
    const f = { t: fr.t, ok: !!fr.img };
    if (!fr.img) return f;
    const im = fr.img, w = fr.w;
    const yaw = yawOf(fr), s = sidenessOf(yaw);
    f.yaw = yaw; f.side = s; f.view = viewOf(yaw);
    const vis = (i) => im[i].v ?? 1;
    // ближняя к камере сторона
    const vL = vis(11) + vis(23) + vis(25) + vis(27) + vis(13), vR = vis(12) + vis(24) + vis(26) + vis(28) + vis(14);
    f.near = vL >= vR ? 'L' : 'R';
    const N = SIDES[f.near];
    // смешивание 2D (точнее в профиль) и 3D (нужно в фас и под углом)
    const blend = (v2, v3) => (v3 == null || !Number.isFinite(v3) ? v2 : lerp(v3, v2, s));
    // вес стороны: видимость модели в профиль занижена, поэтому только как мягкий вес + бонус ближней стороне
    const sideW = (S, side, keys) => 0.25 + Math.min(...keys.map((k) => vis(S[k]))) + (side === f.near ? 0.5 * s : 0);

    // --- ноги: считаем обе стороны отдельно; какую взять — решает трекер сторон (защита от путаницы ног) ---
    const flexLeg = (S) => blend(180 - jointAngle(flat(im[S.hip]), flat(im[S.kn]), flat(im[S.an])), w ? 180 - jointAngle(w[S.hip], w[S.kn], w[S.an]) : null);
    // на сколько градусов бедро выше параллели (колено ниже таза → >0), ≤0 — параллель и ниже
    const thighLeg = (S) => blend(belowHorizontal(flat(sub(im[S.kn], im[S.hip]))), w ? belowHorizontal(sub(w[S.kn], w[S.hip])) : null);
    const shinLeg = (S) => blend(fromVertical(flat(sub(im[S.kn], im[S.an]))), w ? fromVertical(sub(w[S.kn], w[S.an])) : null);
    f.leg = {};
    for (const side of ['L', 'R']) {
      const S = SIDES[side];
      const hp = im[S.heel], tp = im[S.toe];
      f.leg[side] = { flex: flexLeg(S), thigh: thighLeg(S), shin: shinLeg(S), w: sideW(S, side, ['hip', 'kn', 'an']),
        // наклон голени со знаком: + колено впереди голеностопа (по направлению стопы), − позади (слишком широкий шаг)
        shinFwd: Math.atan2((im[S.kn].x - im[S.an].x) * (Math.sign(im[S.toe].x - im[S.heel].x) || 1), Math.abs(im[S.an].y - im[S.kn].y) + 1e-6) * DEG,
        // угол бедра от вертикальной линии (0 — бедро вертикально, 90 — горизонтально), без учёта направления
        thighV: blend(lineFromVertical(flat(sub(im[S.kn], im[S.hip]))), w ? lineFromVertical(sub(w[S.kn], w[S.hip])) : null),
        len2: [norm(flat(sub(im[S.hip], im[S.kn]))), norm(flat(sub(im[S.kn], im[S.an])))],
        len3: w ? [norm(sub(w[S.hip], w[S.kn])), norm(sub(w[S.kn], w[S.an]))] : null,
        heel: Math.min(vis(S.heel), vis(S.toe)) >= 0.25 ? Math.atan2(tp.y - hp.y, Math.abs(tp.x - hp.x) + 1e-6) * DEG : null };
    }
    f.kneeFlexL = f.leg.L.flex; f.kneeFlexR = f.leg.R.flex;
    const hipM = mid(im[23], im[24]), shM = mid(im[11], im[12]);
    const lean2 = fromVertical(flat(sub(im[N.sh], im[N.hip])));
    const lean3 = w ? fromVertical(sub(mid(w[11], w[12]), mid(w[23], w[24]))) : null;
    f.lean = blend(lean2, lean3);
    // длина ноги = бедро + голень (а не расстояние таз–стопа: в глубоком приседе оно сжимается почти до нуля,
    // и все величины «в долях ноги» раздувались в разы — нашлось на клипах QEVD)
    const seg = (a, b) => norm(flat(sub(im[a], im[b])));
    const legLen = (seg(23, 25) + seg(25, 27) + seg(24, 26) + seg(26, 28)) / 2 || 1e-6;
    f.legLen = legLen;
    // колени внутрь (только в фас): смещение колена внутрь от линии таз–голеностоп, в долях длины ноги
    const midX = hipM.x;
    const medial = (S) => {
      const h = im[S.hip], k = im[S.kn], a = im[S.an];
      // если таз почти на уровне стоп по вертикали (сильное сокращение ноги в кадре), продолжение линии таз–голеностоп
      // взрывается — на реальных клипах QEVD давало «колено внутрь на 47000%». Такие кадры не оцениваем.
      if (a.y - h.y < 0.15 * legLen) return 0; // стопа не ниже таза — сбой распознавания
      const xl = h.x + (a.x - h.x) * (k.y - h.y) / (a.y - h.y);
      return clamp((Math.abs(xl - midX) - Math.abs(k.x - midX)) / legLen, -0.4, 0.4);
    };
    f.valgusL = medial(SIDES.L); f.valgusR = medial(SIDES.R);
    f.valgus = Math.max(f.valgusL, f.valgusR);
    f.hipShift = (hipM.x - mid(im[27], im[28]).x) / legLen;
    f.hipH = mid(im[27], im[28]).y - hipM.y; // высота таза над голеностопами в кадре
    f.stance = norm(flat(sub(im[31], im[32]))) / (norm(flat(sub(im[11], im[12]))) || 1e-6); // ширина стоп / ширина плеч (смысл есть только в фас)

    // --- руки и корпус (отжимания, планка) ---
    // в профиль 2D точнее (3D-координаты рук у модели ошибаются на 30–40°), спереди/под углом нужен 3D
    const elbowArm = (S) => blend(jointAngle(flat(im[S.sh]), flat(im[S.el]), flat(im[S.wr])), w ? jointAngle(w[S.sh], w[S.el], w[S.wr]) : null);
    f.arm = {};
    for (const side of ['L', 'R']) {
      const S = SIDES[side];
      f.arm[side] = { elbow: elbowArm(S), w: sideW(S, side, ['sh', 'el', 'wr']),
        len2: [norm(flat(sub(im[S.sh], im[S.el]))), norm(flat(sub(im[S.el], im[S.wr])))],
        len3: w ? [norm(sub(w[S.sh], w[S.el])), norm(sub(w[S.el], w[S.wr]))] : null };
    }
    const aw = (side) => f.arm[side].w;
    f.flare = w ? (angBetween(sub(w[13], w[11]), sub(w[23], w[11])) * aw('L') + angBetween(sub(w[14], w[12]), sub(w[24], w[12])) * aw('R')) / (aw('L') + aw('R')) : null;
    const inside = (p) => p.y > -0.03 && p.y < 1.03 && p.x > -0.03 && p.x < (fr.aspect || 1) + 0.03;
    const footOk = inside(im[N.an]) && (vis(N.an) >= 0.2 || vis(N.kn) < 0.2);
    f.kneeSupport = !footOk;
    const A2 = footOk ? im[N.an] : im[N.kn];
    const off2 = lineOffset(flat(im[N.sh]), flat(A2), flat(im[N.hip]));
    let off3 = null, tilt3 = null;
    if (w) {
      const S3 = mid(w[11], w[12]), H3 = mid(w[23], w[24]), A3 = footOk ? mid(w[27], w[28]) : mid(w[25], w[26]);
      off3 = lineOffset(S3, A3, H3);
      tilt3 = Math.abs(belowHorizontal(sub(A3, S3)));
    }
    f.bodyLine = blend(off2, off3);
    f.bodyTilt = blend(Math.abs(belowHorizontal(flat(sub(A2, im[N.sh])))), tilt3);
    // голова: ухо относительно продолжения линии таз→плечо (>0 — голова опущена)
    f.head = vis(N.ear) > 0.3 ? lineOffset(flat(im[N.hip]), flat(im[N.sh]), flat(im[N.ear])) : null;
    // плечи над локтями (планка): + — плечи впереди локтей
    const dir = Math.sign(im[N.sh].x - im[N.hip].x) || 1;
    const ua = norm(flat(sub(im[N.sh], im[N.el]))) || 1e-6;
    f.shOverEl = (im[N.sh].x - im[N.el].x) * dir / ua;
    f.support = Math.max(im[N.el].y, im[N.wr].y) > im[N.sh].y;
    f.shM = shM; f.hipM = hipM;
    // «в кадре»: вместо порогов видимости (в профиль модель занижает её даже для хорошо видимых суставов)
    const allIn = (ids) => ids.every((i) => inside(im[i]));
    const anyVis = (ids, th) => ids.some((i) => vis(i) >= th);
    f.inFrame = {
      legs: allIn([23, 24, 25, 26, 27, 28]) && anyVis([25, 26, 27, 28], 0.02),
      arms: allIn([11, 12, 13, 14, 15, 16]),
      torso: allIn([11, 12, 23, 24]) && anyVis([11, 12, 23, 24], 0.5),
    };
    return f;
  }

  // ---------------- выбор стороны (защита от путаницы левой/правой) ----------------
  // Нейросеть иногда «склеивает» колено одной ноги с голеностопом другой — один из углов становится абсурдным.
  // Если стороны согласны — усредняем; если нет — берём ту, что ближе к недавней истории движения.
  // Правдоподобие стороны: «сломанная» конечность выдаёт себя неправдоподобно короткими или длинными костями.
  // ref — типичные длины костей этого человека (2D в долях кадра и 3D в метрах).
  function boneErr(limb, ref, s) {
    if (!ref) return 0;
    const e = (v, r) => (r > 1e-6 && v > 1e-6 ? Math.abs(Math.log(v / r)) : 1);
    let err = 0;
    if (limb.len3 && ref.len3) err += Math.max(e(limb.len3[0], ref.len3[0]), e(limb.len3[1], ref.len3[1]));
    // в 2D кости укорачиваются из-за ракурса — учитываем только в профиль
    if (ref.len2) err += s * Math.max(e(limb.len2[0], ref.len2[0]), e(limb.len2[1], ref.len2[1]));
    return err;
  }
  class SideTracker {
    constructor(tol = 25) { this.tol = tol; this.prev = null; }
    pick(a, b, wa, wb, ea = 0, eb = 0) {
      let val, side;
      if (!Number.isFinite(a) || !Number.isFinite(b)) { val = Number.isFinite(a) ? a : b; side = Number.isFinite(a) ? 'L' : 'R'; }
      else if (Math.abs(a - b) <= this.tol) { val = (a * wa + b * wb) / (wa + wb); side = wa >= wb ? 'L' : 'R'; }
      else if (Math.abs(ea - eb) > 0.18) { [val, side] = ea < eb ? [a, 'L'] : [b, 'R']; } // кости выдают сломанную сторону
      else if (this.prev == null) { val = wa >= wb ? a : b; side = wa >= wb ? 'L' : 'R'; }
      else {
        const da = Math.abs(a - this.prev) - 6 * (wa > wb ? 1 : 0), db = Math.abs(b - this.prev) - 6 * (wb > wa ? 1 : 0);
        [val, side] = da <= db ? [a, 'L'] : [b, 'R'];
      }
      this.prev = this.prev == null ? val : lerp(this.prev, val, 0.6);
      return { val, side };
    }
  }
  function resolveOne(f, st) {
    if (!f.ok) return f;
    const eL = boneErr(f.leg.L, st.refLeg, f.side), eR = boneErr(f.leg.R, st.refLeg, f.side);
    const l = st.legs.pick(f.leg.L.flex, f.leg.R.flex, f.leg.L.w, f.leg.R.w, eL, eR);
    f.kneeFlex = l.val; f.legSide = l.side;
    f.legBad = st.refLeg ? Math.min(eL, eR) > 0.55 : false; // обе ноги неправдоподобны — кадру не верим
    const agree = Math.abs(f.leg.L.flex - f.leg.R.flex) <= st.legs.tol;
    const wl = f.leg.L.w, wr = f.leg.R.w;
    f.thigh = agree ? (f.leg.L.thigh * wl + f.leg.R.thigh * wr) / (wl + wr) : f.leg[l.side].thigh;
    f.shin = agree ? (f.leg.L.shin * wl + f.leg.R.shin * wr) / (wl + wr) : f.leg[l.side].shin;
    // пятка — с той ноги, которой доверяем, и только если её стопа правдоподобна
    const hs = agree ? (f.leg[f.near].heel != null ? f.near : l.side) : l.side;
    f.heelTilt = f.leg[hs].heel;
    const aL = boneErr(f.arm.L, st.refArm, f.side), aR = boneErr(f.arm.R, st.refArm, f.side);
    const a = st.arms.pick(f.arm.L.elbow, f.arm.R.elbow, f.arm.L.w, f.arm.R.w, aL, aR);
    f.elbow = a.val; f.armSide = a.side; f.elbowFlex = 180 - a.val;
    f.armBad = st.refArm ? Math.min(aL, aR) > 0.55 : false;
    return f;
  }
  // типичные длины костей: 75-й перцентиль по обеим сторонам (сбои модели обычно укорачивают кость)
  function boneRef(F, key) {
    const take = (getter) => percentile(F.flatMap((f) => (f.ok ? ['L', 'R'].map((sd) => getter(f[key][sd])) : [])).filter((x) => x > 1e-6), 0.75);
    const prof = F.filter((f) => f.ok && f.view === 'side');
    const len2 = prof.length > 10 ? [take((l) => l.len2[0]), take((l) => l.len2[1])] : null;
    const has3 = F.some((f) => f.ok && f[key].L.len3);
    const len3 = has3 ? [take((l) => (l.len3 ? l.len3[0] : NaN)), take((l) => (l.len3 ? l.len3[1] : NaN))] : null;
    return { len2, len3 };
  }
  const newTrackers = () => ({ legs: new SideTracker(25), arms: new SideTracker(30), refLeg: null, refArm: null });
  // офлайн: стартуем с кадра, где стороны согласны, затем медианный фильтр 5 кадров срезает одиночные выбросы
  function resolveAll(F) {
    const st = newTrackers();
    if (F.some((f) => f.ok)) { st.refLeg = boneRef(F, 'leg'); st.refArm = boneRef(F, 'arm'); }
    const firstAgree = (key, sub2) => F.find((f) => f.ok && Math.abs(f[key].L[sub2] - f[key].R[sub2]) <= 15);
    const fl = firstAgree('leg', 'flex'), fa = firstAgree('arm', 'elbow');
    if (fl) st.legs.prev = (fl.leg.L.flex + fl.leg.R.flex) / 2;
    if (fa) st.arms.prev = (fa.arm.L.elbow + fa.arm.R.elbow) / 2;
    F.forEach((f) => resolveOne(f, st));
    for (const key of ['kneeFlex', 'thigh', 'shin', 'elbow', 'lean', 'bodyLine']) medianFilter(F, key, 2);
    for (const f of F) if (f.ok) f.elbowFlex = 180 - f.elbow;
    const ref = percentile(F.filter((f) => f.ok && f.hipH > 0).map((f) => f.hipH), 0.9);
    for (const f of F) if (f.ok) f.hipDrop = ref > 0 ? clamp(100 * (ref - f.hipH) / ref, -20, 90) : 0;
    medianFilter(F, 'hipDrop', 2);
    return F;
  }
  function medianFilter(F, key, r) {
    const src = F.map((f) => (f.ok ? f[key] : NaN));
    for (let i = 0; i < F.length; i++) {
      if (!F[i].ok) continue;
      const win = [];
      for (let j = Math.max(0, i - r); j <= Math.min(F.length - 1, i + r); j++) if (Number.isFinite(src[j])) win.push(src[j]);
      win.sort((x, y) => x - y);
      F[i][key] = win[Math.floor(win.length / 2)];
    }
  }

  // ---------------- поиск повторов (офлайн) ----------------
  function segmentReps(F, sigKey, opt) {
    const { minProm, endFrac = 0.22, minDur = 0.45, valid } = opt;
    const n = F.length;
    const sig = F.map((f, i) => (valid(f) ? f[sigKey] : NaN));
    const base = percentile(sig, 0.08);
    if (!Number.isFinite(base)) return { reps: [], base };
    // локальные максимумы в окне ±0.35 с
    const peaks = [];
    for (let i = 0; i < n; i++) {
      const v = sig[i]; if (!Number.isFinite(v) || v < base + minProm) continue;
      let isMax = true;
      for (let j = i - 1; j >= 0 && F[i].t - F[j].t <= 0.35; j--) if (sig[j] > v) { isMax = false; break; }
      if (isMax) for (let j = i + 1; j < n && F[j].t - F[i].t <= 0.35; j++) if (sig[j] >= v) { isMax = false; break; }
      if (isMax) peaks.push(i);
    }
    // объединяем пики, между которыми человек не вернулся в исходное положение
    const merged = [];
    for (const p of peaks) {
      const q = merged[merged.length - 1];
      if (q != null) {
        let m = Infinity; for (let k = q; k <= p; k++) if (Number.isFinite(sig[k])) m = Math.min(m, sig[k]);
        const lowPeak = Math.min(sig[p], sig[q]);
        if (m > base + 0.45 * (lowPeak - base)) { if (sig[p] > sig[q]) merged[merged.length - 1] = p; continue; }
      }
      merged.push(p);
    }
    const reps = [];
    merged.forEach((p, idx) => {
      const prev = idx ? merged[idx - 1] : 0, next = idx < merged.length - 1 ? merged[idx + 1] : n - 1;
      let baseL = Infinity, baseR = Infinity;
      for (let k = prev; k <= p; k++) if (Number.isFinite(sig[k])) baseL = Math.min(baseL, sig[k]);
      for (let k = p; k <= next; k++) if (Number.isFinite(sig[k])) baseR = Math.min(baseR, sig[k]);
      const thL = baseL + endFrac * (sig[p] - baseL), thR = baseR + endFrac * (sig[p] - baseR);
      let s = -1, e = -1;
      for (let k = p; k >= prev; k--) if (sig[k] <= thL) { s = k; break; }
      for (let k = p; k <= next; k++) if (sig[k] <= thR) { e = k; break; }
      if (s < 0 || e < 0) return; // повтор обрезан началом/концом видео
      // повтор засчитываем, только если до и после него видно исходное положение (видео не начинается посреди повтора)
      if (sig[p] - baseL < 0.7 * minProm || sig[p] - baseR < 0.7 * minProm) return;
      if (F[e].t - F[s].t < minDur) return;
      // верхняя точка до и после (для проверки полного выпрямления)
      let topBefore = Infinity, topAfter = Infinity;
      for (let k = s; k >= prev && F[s].t - F[k].t < 0.5; k--) if (Number.isFinite(sig[k])) topBefore = Math.min(topBefore, sig[k]);
      for (let k = e; k <= next && F[k].t - F[e].t < 0.5; k++) if (Number.isFinite(sig[k])) topAfter = Math.min(topAfter, sig[k]);
      reps.push({ s, p, e, top: Number.isFinite(topAfter) ? topAfter : topBefore }); // выпрямление — в завершении повтора
    });
    return { reps, base };
  }

  // ---------------- каталог ошибок и речь тренера ----------------
  const FAULTS = {
    sq_depth_major: { ex: 'squat', title: 'Полуприсед — не хватает глубины', severity: 'major', group: 'depth',
      cues: ['Глубже', 'Ниже, до параллели', 'Ещё ниже'],
      tip: 'Опускайтесь, пока бедро не станет параллельно полу (таз на уровне коленей).',
      drill: 'Приседания до опоры (стул или скамья) с паузой 2 с внизу — 3×8. Опору постепенно ниже.' },
    sq_depth_minor: { ex: 'squat', title: 'Чуть не доходите до параллели', severity: 'minor', group: 'depth',
      cues: ['Чуть глубже', 'Ещё немного ниже'],
      tip: 'Не хватает совсем немного: добавьте 5–10 см глубины, сохраняя спину ровной.',
      drill: 'Присед с паузой 2 с в нижней точке — 3×6, учит «доставать» глубину.' },
    sq_trunk: { ex: 'squat', title: 'Корпус заваливается вперёд', severity: 'major', group: 'trunk',
      cues: ['Грудь выше', 'Держи корпус', 'Не заваливайся вперёд'],
      tip: 'В нижней точке наклон корпуса заметно больше наклона голени — нагрузка уходит в поясницу. Держите грудь раскрытой, садитесь «между ног».',
      drill: 'Гоблет-присед с гантелью или бутылкой воды у груди — 3×8.' },
    sq_hips_first: { ex: 'squat', title: 'Таз поднимается раньше груди', severity: 'major', group: 'trunk',
      cues: ['Вставай грудью', 'Таз и плечи вместе', 'Грудь вперёд-вверх'],
      tip: 'На подъёме таз уходит вверх, а плечи отстают — присед превращается в наклон. Поднимайтесь грудью, таз и плечи — одновременно.',
      drill: 'Присед в темпе 3-1-1 (3 с вниз, 1 с пауза, 1 с вверх) — 3×6.' },
    sq_valgus: { ex: 'squat', title: 'Колени заваливаются внутрь', severity: 'major', group: 'knees',
      cues: ['Колени наружу', 'Колени по носкам', 'Разводи колени'],
      tip: 'Колени уходят внутрь от линии стоп — лишняя нагрузка на колено. Направляйте колени по линии носков.',
      drill: 'Присед с мини-резинкой над коленями — 3×12; ягодичный мост с резинкой — 3×15.' },
    sq_valgus_minor: { ex: 'squat', title: 'Колени слегка уходят внутрь', severity: 'minor', group: 'knees',
      cues: ['Колени чуть наружу'],
      tip: 'Небольшое сведение коленей: следите, чтобы колено шло над вторым-третьим пальцем стопы.',
      drill: 'Присед с мини-резинкой над коленями — 2×12 в разминке.' },
    sq_heels: { ex: 'squat', title: 'Пятки отрываются от пола', severity: 'major', group: 'heels',
      cues: ['Пятки в пол', 'Вес на пятки'],
      tip: 'Вес уходит на носки. Держите давление на пятку и середину стопы; часто причина — тугой голеностоп.',
      drill: 'Мобилизация голеностопа у стены — 2×10 на ногу; присед с пятками на небольшой подкладке.' },
    sq_shift: { ex: 'squat', title: 'Таз смещается в сторону', severity: 'minor', group: 'balance',
      cues: ['Ровно по центру', 'Вес на обе ноги'],
      tip: 'В нижней точке таз уходит в одну сторону — одна нога работает больше другой.',
      drill: 'Присед перед зеркалом с паузой внизу; выпады на каждую ногу отдельно — 3×8.' },
    sq_stance_narrow: { ex: 'squat', title: 'Слишком узкая постановка стоп', severity: 'minor', group: 'stance',
      cues: ['Ноги чуть шире', 'Стопы на ширине плеч'],
      tip: 'Стопы почти вместе — так сложнее держать баланс и колени. Поставьте стопы примерно на ширине плеч или чуть шире, носки слегка наружу.',
      drill: 'Перед подходом отметьте положение стоп (лента на полу) и приседайте, не сдвигая их.' },
    sq_stance_wide: { ex: 'squat', title: 'Слишком широкая постановка стоп', severity: 'minor', group: 'stance',
      cues: ['Ноги чуть уже', 'Стопы ближе'],
      tip: 'Стопы намного шире плеч — это уже присед-сумо с другой нагрузкой. Для классического приседа поставьте стопы на ширине плеч или чуть шире.',
      drill: 'Перед подходом отметьте положение стоп (лента на полу) и приседайте, не сдвигая их.' },
    sq_lockout: { ex: 'squat', title: 'Не выпрямляетесь полностью', severity: 'minor', group: 'lockout',
      cues: ['Выпрямись до конца', 'Встань полностью'],
      tip: 'Наверху колени и таз остаются согнутыми. Завершайте каждый повтор полным выпрямлением и сжатием ягодиц.',
      drill: 'Ягодичный мост с паузой 2 с наверху — 3×12.' },
    sq_fast: { ex: 'squat', title: 'Слишком быстрый спуск', severity: 'minor', group: 'tempo',
      cues: ['Медленнее вниз', 'Контролируй спуск'],
      tip: 'Вы «падаете» вниз. Опускайтесь подконтрольно за 2 секунды.',
      drill: 'Счёт вслух «раз-два» на спуске в каждом повторе.' },

    pu_depth_major: { ex: 'pushup', title: 'Неполная амплитуда', severity: 'major', group: 'depth',
      cues: ['Ниже', 'Грудью к полу', 'Глубже'],
      tip: 'Опускайтесь, пока локти не согнутся хотя бы до 90°, грудь почти у пола.',
      drill: 'Негативные отжимания: медленно вниз за 3–4 с — 3×5; или отжимания от скамьи в полную амплитуду.' },
    pu_depth_minor: { ex: 'pushup', title: 'Чуть не хватает глубины', severity: 'minor', group: 'depth',
      cues: ['Чуть ниже'],
      tip: 'Добавьте несколько сантиметров глубины — до угла в локтях около 90°.',
      drill: 'Отжимания с паузой 1 с внизу — 3×6.' },
    pu_lockout: { ex: 'pushup', title: 'Руки не выпрямляются наверху', severity: 'minor', group: 'lockout',
      cues: ['Выпрями руки', 'До конца вверх'],
      tip: 'Наверху доводите руки до полного выпрямления — так работает вся амплитуда.',
      drill: 'Удержание упора лёжа на прямых руках 3×20 с.' },
    pu_sag: { ex: 'pushup', title: 'Таз провисает', severity: 'major', group: 'line',
      cues: ['Пресс!', 'Подтяни живот', 'Таз выше'],
      tip: 'Таз опускается ниже линии плечи–пятки — поясница прогибается. Напрягите пресс и ягодицы.',
      drill: 'Планка с подкрученным тазом 3×30 с; отжимания от возвышения, пока не держится линия.' },
    pu_sag_minor: { ex: 'pushup', title: 'Таз слегка проседает', severity: 'minor', group: 'line',
      cues: ['Держи линию'],
      tip: 'Небольшой прогиб в пояснице. Чуть сильнее напрягайте ягодицы.',
      drill: 'Планка 3×30 с с акцентом на ягодицы.' },
    pu_pike: { ex: 'pushup', title: 'Таз задран вверх', severity: 'major', group: 'line',
      cues: ['Таз ниже', 'Ровная линия'],
      tip: 'Таз выше линии плечи–пятки — нагрузка уходит с груди в плечи. Опустите таз.',
      drill: 'Отжимания перед зеркалом или с палкой вдоль спины — 3×6.' },
    pu_flare: { ex: 'pushup', title: 'Локти разведены в стороны', severity: 'minor', group: 'elbows',
      cues: ['Локти ближе к корпусу', 'Локти назад'],
      tip: 'Локти почти перпендикулярны корпусу — это нагружает плечевой сустав. Держите угол около 45°.',
      drill: 'Отжимания с ладонями чуть уже плеч и локтями «назад, к рёбрам» — 3×8.' },
    pu_head: { ex: 'pushup', title: 'Голова опускается к полу', severity: 'minor', group: 'head',
      cues: ['Голову ровно', 'Шея прямая'],
      tip: 'Голова свисает — держите шею продолжением спины, взгляд в пол чуть впереди ладоней.',
      drill: 'Отжимания с фиксацией взгляда на точке в 20–30 см перед ладонями.' },
    pu_fast: { ex: 'pushup', title: 'Слишком быстрое опускание', severity: 'minor', group: 'tempo',
      cues: ['Медленнее вниз'],
      tip: 'Опускайтесь за 1–2 секунды, не «роняйте» корпус.',
      drill: 'Отжимания в темпе 2-0-1.' },

    lu_knee_toe: { ex: 'lunge', title: 'Колено уходит далеко за носок', severity: 'major', group: 'knee',
      cues: ['Колено над пяткой', 'Шаг шире', 'Голень вертикально'],
      tip: 'Голень передней ноги сильно наклонена вперёд — колено выходит за носок и нагружает сустав. Делайте шаг шире и опускайтесь вниз, а не вперёд: голень почти вертикальна.',
      drill: 'Статический выпад у стены: носок передней ноги в 10 см от стены, колено её не касается — 3×8 на ногу.' },
    lu_wide: { ex: 'lunge', title: 'Слишком широкий шаг', severity: 'minor', group: 'knee',
      cues: ['Шаг чуть короче', 'Голень вертикально'],
      tip: 'Передняя стопа ушла слишком далеко вперёд: голень наклонена назад, и опуститься глубоко не получается. Сделайте шаг чуть короче — голень передней ноги должна быть почти вертикальной.',
      drill: 'Отметьте на полу положение стоп для выпада и делайте 3×8 на ногу из одной и той же стойки.' },
    lu_depth_major: { ex: 'lunge', title: 'Неглубокий выпад', severity: 'major', group: 'depth',
      cues: ['Ниже', 'Колено к полу', 'Глубже'],
      tip: 'Опускайтесь, пока колено задней ноги почти не коснётся пола, а угол в переднем колене не станет около 90°.',
      drill: 'Выпад на месте с паузой 1 с внизу — 3×8 на ногу; можно держаться за опору.' },
    lu_depth_minor: { ex: 'lunge', title: 'Чуть не хватает глубины', severity: 'minor', group: 'depth',
      cues: ['Чуть ниже'],
      tip: 'Добавьте немного глубины: переднее колено — около 90°.',
      drill: 'Выпад с паузой внизу — 2×8 на ногу.' },
    lu_trunk: { ex: 'lunge', title: 'Корпус наклоняется вперёд', severity: 'minor', group: 'trunk',
      cues: ['Корпус вертикально', 'Грудь вверх'],
      tip: 'В выпаде корпус держите почти вертикально, плечи над тазом — так нагрузка идёт в ноги, а не в поясницу.',
      drill: 'Выпад с руками на поясе перед зеркалом — 2×8 на ногу.' },
    lu_valgus: { ex: 'lunge', title: 'Колено передней ноги уходит внутрь', severity: 'minor', group: 'knees',
      cues: ['Колено по носку'],
      tip: 'Переднее колено должно смотреть по линии носка, не заваливаться внутрь.',
      drill: 'Выпад с мини-резинкой над коленом, натянутой наружу — 2×8 на ногу.' },
    lu_fast: { ex: 'lunge', title: 'Слишком быстро', severity: 'minor', group: 'tempo',
      cues: ['Медленнее'],
      tip: 'Опускайтесь подконтрольно, без рывка.',
      drill: 'Счёт «раз-два» на спуске.' },

    pl_sag: { ex: 'plank', title: 'Таз провисает', severity: 'major', group: 'line',
      cues: ['Подтяни живот', 'Таз выше', 'Пресс!'],
      tip: 'Подкрутите таз (копчик к пяткам), напрягите пресс и ягодицы.',
      drill: 'Короткие подходы по 20 с с идеальной линией вместо одного длинного с провисом.' },
    pl_pike: { ex: 'plank', title: 'Таз задран вверх', severity: 'major', group: 'line',
      cues: ['Таз ниже', 'Ровная линия'],
      tip: 'Опустите таз до прямой линии плечи–таз–пятки.',
      drill: 'Планка у зеркала или с палкой вдоль спины.' },
    pl_head: { ex: 'plank', title: 'Голова опущена', severity: 'minor', group: 'head',
      cues: ['Голову ровно'],
      tip: 'Держите шею продолжением спины, взгляд в пол под собой.',
      drill: 'Фиксируйте взгляд на точке между ладонями.' },
    pl_shoulders: { ex: 'plank', title: 'Плечи не над локтями', severity: 'minor', group: 'shoulders',
      cues: ['Плечи над локтями'],
      tip: 'Плечи заметно впереди или позади локтей. Ставьте локти точно под плечами.',
      drill: 'Перед подходом проверьте положение локтей по отметке на коврике.' },
  };

  const STRENGTHS = {
    squat: { depth: 'Хорошая глубина приседа', trunk: 'Корпус держите ровно', knees: 'Колени стабильно идут по линии носков',
      heels: 'Пятки уверенно на полу', balance: 'Вес распределён ровно', stance: 'Правильная ширина стойки', lockout: 'Полностью выпрямляетесь наверху', tempo: 'Подконтрольный темп' },
    pushup: { depth: 'Полная амплитуда', line: 'Тело держится прямой линией', elbows: 'Локти в правильном положении',
      lockout: 'Полное выпрямление рук', head: 'Голова в нейтральном положении', tempo: 'Подконтрольный темп' },
    lunge: { knee: 'Голень передней ноги вертикальна — колено не уходит за носок', depth: 'Хорошая глубина выпада', trunk: 'Корпус держите вертикально', knees: 'Колено идёт по линии носка', tempo: 'Подконтрольный темп' },
    plank: { line: 'Ровная линия тела', head: 'Нейтральное положение головы', shoulders: 'Плечи над локтями' },
  };

  const pick = (arr, rnd = Math.random) => arr[Math.floor(rnd() * arr.length) % arr.length];

  // ---------------- пороги, откалиброванные на реальных людях ----------------
  // Mendeley Multi-View Fitness (CC BY 4.0): 26 человек, 3 ракурса, метки «хорошо/плохо» от авторов набора.
  // major ≈ 96-й процентиль правильных повторов, minor ≈ 90-й: на одобренной технике замечание звучит редко.
  const SQ_T = {
    side:  { depthMinor: 20, depthMajor: 27, trunkDiff: 42, trunkLean: 45, hips: 8, heels: 11, lockout: 32 },
    angle: { depthMinor: 53, depthMajor: 58, trunkDiff: 23, trunkLean: 45, hips: 10, lockout: 27 },
    front: { ratioMinor: 0.64, ratioMajor: 0.68, kneesMinor: 0.08, kneesMajor: 0.12, shift: 0.06, narrow: 0.85, wide: 2.2, trunkLean: 35, trunkDiff: 20 }, // уточнено на ~800 повторах QEVD
    fastEcc: 0.45,
  };
  // Выпады: откалибровано на Exercise-Correction (MIT), ~19 тыс. размеченных кадров реальных людей
  // (наклон голени передней ноги вперёд > 20° → «колено за носок»: 95,0% точности на отложенной части)
  // trunk и valgus уточнены на ~240 повторах выпадов QEVD: при 0.06 «колено внутрь» звучало у половины правильных выпадов
  const LU_T = { shinMajor: 20, shinBack: 20, kneeMinor: 110, kneeMajor: 125, trunk: 22, valgus: 0.15, fastEcc: 0.4 };
  const PU_T = {
    side:  { depthMinor: 100, depthMajor: 110, sagMajor: 0.045, sagMinor: 0.035, pike: -0.16, head: 0.2, lockout: 140, flare: 80, line: true },
    angle: { depthMinor: 100, depthMajor: 110, sagMajor: 0.08, sagMinor: 0.065, pike: -0.2, lockout: 140, flare: 70, line: true },
    front: { depthMinor: 125, depthMajor: 132, lockout: 140, flare: 90, line: false }, // QEVD спереди: при 115 ругались на 27% правильных повторов, при 125 — на 11% // спереди линию тела не измерить: тело сжато перспективой
    fastEcc: 0.3,
  };

  // Планка. Сбоку/под углом пороги откалиброваны на ~29 тыс. кадров (Exercise-Correction, 99,3%).
  // Спереди (камера на полу перед лицом — как снимает большинство) линия тела меряется только по 3D-оценке нейросети,
  // и разброс у правильных планок QEVD огромный (−0,5…+0,1), поэтому спереди ловим только грубые ошибки.
  const PL_T = {
    side: { sag: 0.02, pike: -0.16, shoulders: true },
    angle: { sag: 0.02, pike: -0.16, shoulders: true },
    front: { sag: 0.08, pike: -0.22, head: 0.85, shoulders: false },
    // на прямых руках спереди 3D-линия у правильных планок смещена «вверх» (медиана −0,09 по 122 клипам QEVD)
    frontStraight: { sag: 0.08, pike: -0.3, head: 0.85, shoulders: false }, // плечо над локтем спереди не видно; голова — по 1300 клипам QEVD
  };

  // ---------------- оценка повтора ----------------
  const crit = (code, status, value, label) => ({ code, status, value, label });
  const PENALTY = { major: 25, minor: 10 };

  // «исходное положение» для сравнения: кадры до начала и после конца повтора (≤0.5 с)
  function topFrames(F, rep) {
    const out = [];
    for (let k = rep.s; k >= 0 && F[rep.s].t - F[k].t <= 0.5; k--) out.push(F[k]);
    for (let k = rep.e; k < F.length && F[k].t - F[rep.e].t <= 0.5; k++) out.push(F[k]);
    return out;
  }

  function evalSquat(F, rep) {
    // кадры, где таз «провалился» ниже стоп, — сбой распознавания (бывает в глубоком приседе лицом к камере)
    const R = F.slice(rep.s, rep.e + 1).filter((f) => f.ok && !(f.hipH < 0.15 * f.legLen));
    const P = F[rep.p];
    const C = [];
    const frac = (v) => R.filter((f) => f.view === v).length / R.length;
    const frontFrac = frac('front'), sideOnly = frac('side');
    const repView = frontFrac >= 0.5 ? 'front' : sideOnly >= 0.5 ? 'side' : 'angle';
    const T = SQ_T[repView];
    // 1. Глубина. Сбоку и под углом — угол бедра к горизонтали.
    //    Спереди нейросеть плохо оценивает глубину сцены, поэтому меряем, насколько опустился таз
    //    относительно своей высоты стоя (параллель ≈ 0,5).
    const frontish = frontFrac >= 0.5;
    let thighMin = minOf(R.map((f) => f.thigh)), depthTxt, depthLevel;
    if (frontish) {
      const top = topFrames(F, rep).filter((f) => f.ok && f.hipH > 0);
      const stand = top.length ? percentile(top.map((f) => f.hipH), 0.7) : maxOf(R.map((f) => f.hipH));
      const ratio = minOf(R.map((f) => f.hipH)) / (stand || 1);
      depthTxt = `таз опустился до ${Math.round(ratio * 100)}% высоты стоя` + (ratio <= T.ratioMinor ? ' — глубина в норме' : '');
      depthLevel = ratio > T.ratioMajor ? 'major' : ratio > T.ratioMinor ? 'minor' : 'ok';
      thighMin = Math.max(0, Math.round((ratio - 0.5) * 120)); // приблизительно в «градусах выше параллели» — для отчёта об усталости
    } else {
      depthLevel = thighMin > T.depthMajor ? 'major' : thighMin > T.depthMinor ? 'minor' : 'ok';
      depthTxt = depthLevel === 'ok' ? 'глубина в норме' : `не хватает глубины (бедро на ~${Math.round(thighMin - T.depthMinor + 10)}° выше нормы)`;
    }
    if (depthLevel === 'major') C.push(crit('sq_depth_major', 'major', Math.round(thighMin), depthTxt));
    else if (depthLevel === 'minor') C.push(crit('sq_depth_minor', 'minor', Math.round(thighMin), depthTxt));
    else C.push(crit('depth', 'ok', Math.round(thighMin), depthTxt));

    // 2. Корпус относительно голени — в момент прихода в нижнюю точку
    const peakFlex = P.kneeFlex;
    let b0 = rep.p;
    for (let k = rep.s; k <= rep.p; k++) if (F[k].ok && F[k].kneeFlex >= peakFlex - 6) { b0 = k; break; }
    const B = F[b0];
    const leanB = B.lean, shinB = B.shin, diff = leanB - shinB;
    const trunkTxt = `корпус ${Math.round(leanB)}°, голень ${Math.round(shinB)}°`;
    if (frontFrac < 0.5) {
      if (leanB > T.trunkLean && diff > T.trunkDiff) C.push(crit('sq_trunk', 'major', Math.round(diff), trunkTxt));
      else C.push(crit('trunk', 'ok', Math.round(diff), trunkTxt));
      // 3. Таз раньше груди: насколько вырос наклон корпуса от низа до первой половины подъёма
      const endFlex = F[rep.e].kneeFlex;
      let leanMaxUp = leanB;
      for (let k = b0; k <= rep.e; k++) {
        const f = F[k]; if (!f.ok) continue;
        if (k > rep.p && f.kneeFlex < peakFlex - 0.5 * (peakFlex - endFlex)) break;
        leanMaxUp = Math.max(leanMaxUp, f.lean);
      }
      const rise = leanMaxUp - leanB;
      if (rise > T.hips) C.push(crit('sq_hips_first', 'major', Math.round(rise), `наклон корпуса вырос на ${Math.round(rise)}° в начале подъёма`));
      else C.push(crit('hips', 'ok', Math.round(rise), 'таз и плечи поднимаются вместе'));
    } else {
      // спереди сравнить корпус с голенью нельзя, но сильный наклон корпуса в нижней точке виден по 3D:
      // корпус >35° и впереди голени >20°: у 4% правильных повторов Mendeley и 2% QEVD; ловит ~20% «спина не прямая» QEVD
      const nearB = R.filter((f) => Math.abs(f.t - P.t) <= 0.2);
      const leanF = nearB.length ? percentile(nearB.map((f) => f.lean), 0.5) : P.lean;
      const shinF = nearB.length ? percentile(nearB.map((f) => f.shin), 0.5) : P.shin;
      if (leanF > T.trunkLean && leanF - shinF > T.trunkDiff) C.push(crit('sq_trunk', 'major', Math.round(leanF), `корпус наклонён на ${Math.round(leanF)}° — грудь падает вперёд`));
      else C.push(crit('trunk', 'ok', Math.round(leanF), `корпус ${Math.round(leanF)}° от вертикали`));
    }

    // 4. Колени внутрь (в фас)
    if (frontFrac >= 0.5) {
      const top = topFrames(F, rep).filter((f) => f.ok);
      const baseL = mean(top.map((f) => f.valgusL)), baseR = mean(top.map((f) => f.valgusR));
      let worst = -Infinity;
      for (const f of R) if (f.kneeFlex > 0.4 * peakFlex) worst = Math.max(worst, f.valgusL - baseL, f.valgusR - baseR);
      const txt = worst > 0.01 ? `колено уходит внутрь на ${Math.round(worst * 100)}% длины ноги` : 'колени над стопами';
      if (worst > T.kneesMajor) C.push(crit('sq_valgus', 'major', +worst.toFixed(3), txt));
      else if (worst > T.kneesMinor) C.push(crit('sq_valgus_minor', 'minor', +worst.toFixed(3), txt));
      else C.push(crit('knees', 'ok', +worst.toFixed(3), txt));
      // перекос таза
      const sh0 = mean(top.map((f) => f.hipShift));
      const shiftMax = maxOf(R.map((f) => Math.abs(f.hipShift - sh0)));
      if (shiftMax > T.shift) C.push(crit('sq_shift', 'minor', +shiftMax.toFixed(3), `таз смещается на ${Math.round(shiftMax * 100)}% длины ноги`));
      else C.push(crit('balance', 'ok', +shiftMax.toFixed(3), 'таз по центру'));
    } else {
      C.push(crit('knees', 'na', null, 'колени проверяются, когда камера спереди'));
    }

    // 5. Пятки (в профиль)
    if (sideOnly > 0.6) {
      const top = topFrames(F, rep).filter((f) => f.ok && f.heelTilt != null);
      const tilts = R.filter((f) => f.heelTilt != null);
      if (top.length && tilts.length > R.length * 0.35) {
        const b = mean(top.map((f) => f.heelTilt));
        const lift = percentile(tilts.map((f) => f.heelTilt - b), 0.8); // устойчивый подъём, а не одиночный выброс
        if (lift > T.heels) C.push(crit('sq_heels', 'major', Math.round(lift), `стопа наклоняется на ${Math.round(lift)}°`));
        else C.push(crit('heels', 'ok', Math.round(lift), 'пятки на полу'));
      }
    }

    // 6. Ширина стойки (в фас): норма по данным реальных людей — стопы в 1,2–2,8 ширины плеч
    if (frontish) {
      const st = percentile(R.map((f) => f.stance), 0.5);
      const txt = `стопы на ${st.toFixed(1)} ширины плеч`;
      if (st < T.narrow) C.push(crit('sq_stance_narrow', 'minor', +st.toFixed(2), txt));
      else if (st > T.wide) C.push(crit('sq_stance_wide', 'minor', +st.toFixed(2), txt));
      else C.push(crit('stance', 'ok', +st.toFixed(2), txt));
    }
    // 7. Выпрямление наверху — только сбоку и под углом (спереди угол колена у нейросети ненадёжен)
    if (Number.isFinite(rep.top) && !frontish) {
      if (rep.top > T.lockout) C.push(crit('sq_lockout', 'minor', Math.round(rep.top), `наверху колено согнуто на ${Math.round(rep.top)}°`));
      else C.push(crit('lockout', 'ok', Math.round(rep.top), 'полное выпрямление'));
    }

    // 8. Темп
    const ecc = P.t - F[rep.s].t, con = F[rep.e].t - P.t;
    if (ecc < SQ_T.fastEcc) C.push(crit('sq_fast', 'minor', +ecc.toFixed(2), `спуск за ${ecc.toFixed(1)} с`));
    else C.push(crit('tempo', 'ok', +ecc.toFixed(2), `спуск ${ecc.toFixed(1)} с, подъём ${con.toFixed(1)} с`));

    return { criteria: C, ecc, con, depthValue: thighMin, depthText: depthTxt };
  }

  function evalPushup(F, rep) {
    const R = F.slice(rep.s, rep.e + 1).filter((f) => f.ok);
    const P = F[rep.p];
    const C = [];
    const frac = (v) => R.filter((f) => f.view === v).length / R.length;
    const repView = frac('front') >= 0.5 ? 'front' : frac('side') >= 0.5 ? 'side' : 'angle';
    const T = PU_T[repView];
    const minElbow = minOf(R.map((f) => f.elbow));
    const txt = `локоть до ${Math.round(minElbow)}°`;
    if (minElbow > T.depthMajor) C.push(crit('pu_depth_major', 'major', Math.round(minElbow), txt));
    else if (minElbow > T.depthMinor) C.push(crit('pu_depth_minor', 'minor', Math.round(minElbow), txt));
    else C.push(crit('depth', 'ok', Math.round(minElbow), txt));

    const topElbow = Number.isFinite(rep.top) ? 180 - rep.top : NaN;
    if (Number.isFinite(topElbow)) {
      if (topElbow < T.lockout) C.push(crit('pu_lockout', 'minor', Math.round(topElbow), `наверху локоть ${Math.round(topElbow)}°`));
      else C.push(crit('lockout', 'ok', Math.round(topElbow), 'руки выпрямлены'));
    }

    if (T.line) {
      const lines = R.map((f) => f.bodyLine);
      const sag = percentile(lines, 0.9), pike = percentile(lines, 0.1); // устойчивое отклонение, а не одиночный кадр
      if (sag > T.sagMajor) C.push(crit('pu_sag', 'major', +sag.toFixed(3), `таз ниже линии на ${Math.round(sag * 100)}% длины тела`));
      else if (pike < T.pike) C.push(crit('pu_pike', 'major', +pike.toFixed(3), `таз выше линии на ${Math.round(-pike * 100)}% длины тела`));
      else if (sag > T.sagMinor) C.push(crit('pu_sag_minor', 'minor', +sag.toFixed(3), `небольшой прогиб (${Math.round(sag * 100)}%)`));
      else C.push(crit('line', 'ok', +Math.max(sag, -pike, 0).toFixed(3), 'тело — прямая линия'));
    } else C.push(crit('line', 'na', null, 'линия тела лучше видна сбоку'));

    if (P.flare != null) {
      const flare = mean(F.slice(rep.s, rep.e + 1).filter((f) => f.ok && f.elbow < P.elbow + 15).map((f) => f.flare));
      if (flare > T.flare) C.push(crit('pu_flare', 'minor', Math.round(flare), `локти под ${Math.round(flare)}° к корпусу`));
      else C.push(crit('elbows', 'ok', Math.round(flare), `локти под ${Math.round(flare)}° к корпусу`));
    }

    if (T.head) {
      const heads = R.filter((f) => f.view === 'side').map((f) => f.head).filter((x) => x != null);
      if (heads.length > R.length * 0.5) {
        const h = percentile(heads, 0.8);
        if (h > T.head) C.push(crit('pu_head', 'minor', +h.toFixed(2), 'голова ниже линии корпуса'));
        else C.push(crit('head', 'ok', +h.toFixed(2), 'голова на линии корпуса'));
      }
    }

    const ecc = P.t - F[rep.s].t, con = F[rep.e].t - P.t;
    if (ecc < PU_T.fastEcc) C.push(crit('pu_fast', 'minor', +ecc.toFixed(2), `опускание за ${ecc.toFixed(1)} с`));
    else C.push(crit('tempo', 'ok', +ecc.toFixed(2), `вниз ${ecc.toFixed(1)} с, вверх ${con.toFixed(1)} с`));
    return { criteria: C, ecc, con, depthValue: minElbow, depthText: txt };
  }

  function evalLunge(F, rep) {
    const R = F.slice(rep.s, rep.e + 1).filter((f) => f.ok);
    const C = [];
    const frac = (v) => R.filter((f) => f.view === v).length / R.length;
    const repView = frac('front') >= 0.5 ? 'front' : frac('side') >= 0.5 ? 'side' : 'angle';
    // кадры около нижней точки
    const tP = F[rep.p].t;
    const B = R.filter((f) => Math.abs(f.t - tP) <= 0.2);
    // передняя нога — у неё бедро ближе к горизонтали (у задней бедро почти вертикально)
    const tv = (sd) => percentile(B.map((f) => f.leg[sd].thighV), 0.5);
    const front = tv('L') >= tv('R') ? 'L' : 'R';
    const shin = percentile(B.map((f) => f.leg[front].shinFwd), 0.5);
    const knee = percentile(B.map((f) => 180 - f.leg[front].flex), 0.5);
    const leg = front === 'L' ? 'левая' : 'правая';
    if (repView !== 'front') {
      if (shin > LU_T.shinMajor) C.push(crit('lu_knee_toe', 'major', Math.round(shin), `голень наклонена вперёд на ${Math.round(shin)}° (${leg} впереди)`));
      else if (shin < -LU_T.shinBack) C.push(crit('lu_wide', 'minor', Math.round(shin), `голень наклонена назад на ${Math.round(-shin)}° — шаг слишком широкий`));
      else C.push(crit('knee', 'ok', Math.round(shin), `голень ${Math.round(Math.abs(shin))}° от вертикали`));
    } else C.push(crit('knee', 'na', null, 'вынос колена виден только сбоку'));
    const ktxt = `переднее колено ${Math.round(knee)}°`;
    if (knee > LU_T.kneeMajor) C.push(crit('lu_depth_major', 'major', Math.round(knee), ktxt));
    else if (knee > LU_T.kneeMinor) C.push(crit('lu_depth_minor', 'minor', Math.round(knee), ktxt));
    else C.push(crit('depth', 'ok', Math.round(knee), ktxt));
    if (repView !== 'front') {
      const lean = percentile(B.map((f) => f.lean), 0.5);
      if (lean > LU_T.trunk) C.push(crit('lu_trunk', 'minor', Math.round(lean), `корпус наклонён на ${Math.round(lean)}°`));
      else C.push(crit('trunk', 'ok', Math.round(lean), `корпус ${Math.round(lean)}° от вертикали`));
    } else {
      const top = topFrames(F, rep).filter((f) => f.ok);
      const key = front === 'L' ? 'valgusL' : 'valgusR';
      const base = mean(top.map((f) => f[key]));
      const worst = maxOf(B.map((f) => f[key] - base));
      if (worst > LU_T.valgus) C.push(crit('lu_valgus', 'minor', +worst.toFixed(3), `колено внутрь на ${Math.round(worst * 100)}% длины ноги`));
      else C.push(crit('knees', 'ok', +worst.toFixed(3), 'колено по линии носка'));
    }
    const ecc = tP - F[rep.s].t, con = F[rep.e].t - tP;
    if (ecc < LU_T.fastEcc) C.push(crit('lu_fast', 'minor', +ecc.toFixed(2), `спуск за ${ecc.toFixed(1)} с`));
    else C.push(crit('tempo', 'ok', +ecc.toFixed(2), `вниз ${ecc.toFixed(1)} с, вверх ${con.toFixed(1)} с`));
    return { criteria: C, ecc, con, depthValue: knee, depthText: ktxt, leg: front };
  }

  function scoreOf(C) {
    let s = 100;
    for (const c of C) if (PENALTY[c.status]) s -= PENALTY[c.status];
    return Math.max(0, s);
  }

  // ---------------- конфигурация упражнений ----------------
  const EXERCISES = {
    squat: { sig: 'kneeFlex', minProm: 32, met: 5.0, eval: evalSquat,
      valid: (f) => f.ok && f.inFrame.legs && f.inFrame.torso && !f.legBad },
    pushup: { sig: 'elbowFlex', minProm: 28, met: 8.0, eval: evalPushup,
      valid: (f) => f.ok && f.inFrame.arms && f.inFrame.torso && !f.armBad && f.bodyTilt < 40 },
    lunge: { sig: 'hipDrop', minProm: 10, met: 5.0, eval: evalLunge,
      valid: (f) => f.ok && f.inFrame.legs && f.inFrame.torso && !f.legBad },
    plank: { met: 3.8, valid: (f) => f.ok && f.inFrame.torso && f.bodyTilt < 35 && f.support },
  };

  // ---------------- анализ записанного подхода ----------------
  function analyze(rawFrames, exercise, opts = {}) {
    const weight = opts.weightKg || 70;
    const sm = smoothOffline(rawFrames);
    const F = resolveAll(sm.map(features));
    const cfg = EXERCISES[exercise];
    const detected = F.filter((f) => f.ok).length / Math.max(1, F.length);
    const views = F.filter((f) => f.ok).map((f) => f.yaw);
        const yawMed = percentile(views, 0.5);
    const meta = { frames: F.length, detectedPct: Math.round(detected * 100), view: Number.isFinite(yawMed) ? viewOf(yawMed) : 'side' };
    if (exercise === 'plank') return { ...analyzePlank(F, cfg, weight), meta, frames: F };

    const { reps } = segmentReps(F, cfg.sig, { minProm: cfg.minProm, valid: cfg.valid });
    const repsDetail = reps.map((r, i) => {
      const ev = cfg.eval(F, r);
      const faults = ev.criteria.filter((c) => c.status === 'major' || c.status === 'minor').map((c) => c.code);
      const score = scoreOf(ev.criteria);
      const rv = (() => { const R = F.slice(r.s, r.e + 1).filter((f) => f.ok); const fr = (v) => R.filter((f) => f.view === v).length / (R.length || 1); return fr('front') >= 0.5 ? 'front' : fr('side') >= 0.5 ? 'side' : 'angle'; })();
      return { view: rv, n: i + 1, start: F[r.s].t, end: F[r.e].t, bottomT: F[r.p].t, bottomIdx: r.p, duration: +(F[r.e].t - F[r.s].t).toFixed(2),
        score, good: !faults.some((c) => FAULTS[c].severity === 'major'), faults, criteria: ev.criteria,
        ecc: +ev.ecc.toFixed(2), con: +ev.con.toFixed(2), depthValue: ev.depthValue, depthText: ev.depthText, leg: ev.leg };
    });
    const res = summarizeReps(exercise, repsDetail, weight, cfg.met);
    res.meta = meta; res.frames = F;
    return res;
  }

  function summarizeReps(exercise, reps, weight, met) {
    const n = reps.length;
    const counts = {};
    for (const r of reps) for (const c of r.faults) counts[c] = (counts[c] || 0) + 1;
    const faults = Object.entries(counts).map(([code, count]) => ({ code, count, ...FAULTS[code] }))
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'major' ? -1 : 1) || b.count - a.count);
    // итог: половина — средний балл повторов, половина — доля повторов без серьёзных ошибок
    // (иначе 3 ошибочных повтора из 7 давали бы «отличную технику»)
    const score = n ? Math.round(0.5 * reps.reduce((s, r) => s + r.score, 0) / n + 0.5 * 100 * reps.filter((r) => r.good).length / n) : 0;
    const dur = n ? reps[n - 1].end - reps[0].start : 0;

    // сильные стороны — группы критериев, которые проверялись и ни разу не нарушались
    const checked = new Set(), broken = new Set();
    for (const r of reps) for (const c of r.criteria) {
      const g = FAULTS[c.code]?.group || c.code;
      if (c.status !== 'na') checked.add(g === 'hips' ? 'trunk' : g);
      if (c.status === 'major' || c.status === 'minor') broken.add(FAULTS[c.code].group);
    }
    const S = STRENGTHS[exercise] || {};
    const strengths = [...checked].filter((g) => !broken.has(g) && S[g]).map((g) => S[g]);

    // наблюдения по подходу в целом
    const notes = [];
    if (n >= 6) {
      const k = Math.max(2, Math.floor(n / 3));
      const first = mean(reps.slice(0, k).map((r) => r.depthValue)), last = mean(reps.slice(-k).map((r) => r.depthValue));
      const worse = exercise === 'squat' ? last - first : last - first; // в обоих случаях рост значения = хуже
      if (worse > 8) notes.push(exercise === 'squat'
        ? 'К концу подхода глубина уменьшается — признак усталости. Лучше сделать меньше повторов, но все качественные.'
        : 'К концу подхода амплитуда уменьшается — признак усталости. Остановитесь, когда не получается опуститься до 90°.');
      const sf = mean(reps.slice(0, k).map((r) => r.score)), sl = mean(reps.slice(-k).map((r) => r.score));
      if (sf - sl >= 20) notes.push(`Качество падает к концу подхода: первые повторы в среднем ${Math.round(sf)} баллов, последние — ${Math.round(sl)}.`);
    }
    const crits = reps.flatMap((r) => r.criteria);
    if (exercise === 'squat' && crits.some((c) => c.code === 'knees' && c.status === 'na') && !crits.some((c) => c.group === 'knees' || /valgus/.test(c.code)))
      notes.push('Камера стояла сбоку: глубина и спина проверены, а колени — нет. Снимите следующий подход спереди.');
    if (exercise === 'squat' && crits.some((c) => c.code === 'trunk' && c.status === 'na'))
      notes.push('Камера стояла спереди: колени проверены, но наклон корпуса лучше оценивать сбоку.');
    if (exercise === 'lunge' && n >= 4) {
      const byLeg = (L) => reps.filter((r) => r.leg === L);
      const l = byLeg('L'), r2 = byLeg('R');
      if (l.length >= 2 && r2.length >= 2) {
        const dl = mean(l.map((x) => x.depthValue)), dr = mean(r2.map((x) => x.depthValue));
        if (Math.abs(dl - dr) > 12) notes.push(`${dl > dr ? 'На левой' : 'На правой'} ноге выпад заметно мельче (колено ${Math.round(Math.max(dl, dr))}° против ${Math.round(Math.min(dl, dr))}°) — добавьте пару повторов на слабую сторону.`);
        const sl = l.filter((x) => !x.good).length / l.length, sr = r2.filter((x) => !x.good).length / r2.length;
        if (Math.abs(sl - sr) >= 0.4) notes.push(`Ошибок больше, когда впереди ${sl > sr ? 'левая' : 'правая'} нога — уделите ей внимание.`);
      } else if (n >= 6 && (l.length === 0 || r2.length === 0)) notes.push('Все выпады — на одну ногу. Не забудьте сделать столько же на другую.');
    }
    if (exercise === 'lunge' && reps.some((r) => r.criteria.some((c) => c.code === 'knee' && c.status === 'na')))
      notes.push('Камера стояла спереди: вынос колена за носок проверяется только сбоку. Снимите подход сбоку.');
    // честные ограничения ракурса — по результатам проверки на 26 реальных людях
    const viewsUsed = reps.map((r) => r.view);
    const share = (v) => viewsUsed.filter((x) => x === v).length / (viewsUsed.length || 1);
    if (exercise === 'pushup' && share('front') >= 0.5)
      notes.push('Отжимания сняты спереди — с этого ракурса не видно линию тела и плохо видна глубина. Для точной оценки поставьте телефон сбоку.');
    if (exercise === 'squat' && share('angle') >= 0.5)
      notes.push('Камера стояла по диагонали — это наименее точный ракурс для оценки глубины. Для точной проверки снимите подход сбоку или спереди.');

    const priority = faults[0] || null;
    return {
      exercise, reps: n, goodReps: reps.filter((r) => r.good).length, score, repsDetail: reps,
      durationSec: Math.round(dur), kcal: +(met * 3.5 * weight / 200 * (dur / 60)).toFixed(1),
      faults, strengths, notes, priority, coachText: coachText(exercise, n, score, strengths, faults, notes),
    };
  }

  function analyzePlank(F, cfg, weight) {
    let hold = 0, good = 0; const segSec = {};
    const offs = []; // пороги линии тела откалиброваны на ~29 тыс. размеченных кадров реальных людей (точность 99,3% на отложенной части)
    const run = {}; // длительность текущей ошибки — засчитываем, только если держится ≥0.5 с
    let first = null, last = null;
    for (let k = 1; k < F.length; k++) {
      const f = F[k], dt = clamp(f.t - F[k - 1].t, 0, 0.3);
      if (!cfg.valid(f)) { for (const c in run) run[c] = 0; continue; }
      if (first == null) first = f.t; last = f.t;
      hold += dt; offs.push([f.t, f.bodyLine]);
      const now = [];
      const T = f.view === 'front' && f.elbow > 140 ? PL_T.frontStraight : PL_T[f.view] || PL_T.side;
      if (f.bodyLine > T.sag) now.push('pl_sag');
      if (f.bodyLine < T.pike) now.push('pl_pike');
      if (f.head != null && ((f.view === 'side' && f.head > 0.15) || (f.view === 'front' && f.head > T.head))) now.push('pl_head');
      if (T.shoulders && Math.abs(f.shOverEl) > 0.45 && f.bodyLine >= T.pike && f.bodyLine <= T.sag) now.push('pl_shoulders'); // при задранном/провисшем тазе плечи смещаются сами — не дублируем
      for (const c of Object.keys(FAULTS).filter((x) => x.startsWith('pl_'))) run[c] = now.includes(c) ? (run[c] || 0) + dt : 0;
      const active = now.filter((c) => run[c] >= 0.5);
      for (const c of active) segSec[c] = (segSec[c] || 0) + dt;
      if (!active.length) good += dt;
    }
    const faults = Object.entries(segSec).filter(([, s]) => s >= 1).map(([code, s]) => ({ code, seconds: Math.round(s), ...FAULTS[code] }))
      .sort((a, b) => b.seconds - a.seconds);
    const notes = [];
    const frontShare = F.filter((f) => cfg.valid(f) && f.view === 'front').length / Math.max(1, F.filter((f) => cfg.valid(f)).length);
    if (hold > 3 && frontShare > 0.5)
      notes.push('Камера стояла спереди: так видно только сильный провис или задранный таз. Чтобы проверить линию тела точно, поставьте камеру сбоку на уровне пола.');
    if (offs.length > 30 && hold > 15) {
      const k = Math.floor(offs.length / 3);
      const a = mean(offs.slice(0, k).map((x) => x[1])), b = mean(offs.slice(-k).map((x) => x[1]));
      if (b - a > 0.025) notes.push('К концу удержания таз постепенно проседает — признак усталости пресса. Лучше несколько коротких подходов с идеальной линией.');
    }
    const goodPct = hold ? Math.round(100 * good / hold) : 0;
    const groups = new Set(faults.map((f) => f.group));
    const strengths = hold > 3 ? Object.entries(STRENGTHS.plank).filter(([g]) => !groups.has(g)).map(([, t]) => t) : [];
    return {
      exercise: 'plank', holdSec: Math.round(hold), goodSec: Math.round(good), goodPct, score: goodPct,
      durationSec: Math.round(hold), kcal: +(cfg.met * 3.5 * weight / 200 * (hold / 60)).toFixed(1),
      faults, strengths, notes, priority: faults[0] || null,
      coachText: coachText('plank', Math.round(hold), goodPct, strengths, faults, notes),
    };
  }

  function coachText(ex, n, score, strengths, faults, notes) {
    if (!n) return ex === 'plank'
      ? 'Не получилось распознать планку. Поставьте камеру сбоку на уровне пола так, чтобы было видно тело целиком.'
      : 'Не получилось засчитать повторы. Проверьте, что в кадре видно всё тело, свет падает спереди, а движение выполнено полностью.';
    const parts = [];
    if (score >= 85) parts.push(pick(['Отличный подход!', 'Очень чисто!', 'Сильная техника!']));
    else if (score >= 65) parts.push(pick(['Хороший подход, есть что подточить.', 'Неплохо — основа уже правильная.']));
    else parts.push(pick(['Есть над чем поработать — разберём по шагам.', 'Технику стоит поправить, но это решаемо.']));
    if (strengths.length) parts.push('Что получается: ' + strengths.slice(0, 3).map((s) => s.toLowerCase()).join(', ') + '.');
    if (faults.length) {
      const f = faults[0];
      parts.push(`Главное сейчас — ${f.title.toLowerCase()}${f.count ? ` (${f.count} из ${n})` : ''}. ${f.tip}`);
      parts.push(`Упражнение в помощь: ${f.drill}`);
      if (faults.length > 1) parts.push(`Следующий шаг после этого — ${faults[1].title.toLowerCase()}.`);
    }
    if (notes.length) parts.push(notes[0]);
    return parts.join(' ');
  }

  // ---------------- голос тренера ----------------
  // Поведение по образцу живых тренеров (QEVD-FIT-COACH, 149 записанных тренировок, 5480 реплик):
  // реплика примерно каждые 4–6 с (медиана паузы 4,7 с, минимум ~2,3 с); ~треть — похвала и мотивация,
  // ~треть — подсказки по технике; вехи на 5/10/15 повторах; похвала + подсказка в одной фразе; образные подсказки.
  const VOICE = {
    start: ['Поехали!', 'Начинаем, я смотрю!', 'Отлично, начали!'],
    goodStart: ['Хорошее начало!', 'Отличный старт!', 'Вот так, хорошо пошло!'],
    praise: ['Отлично!', 'Вот так!', 'Хорошо!', 'Чисто!', 'Красиво!', 'Так держать!', 'Супер!', 'Да, вот это техника!'],
    praiseEx: {
      squat: ['Вот это присед!', 'Отличный присед!', 'Вижу невидимый стул — отлично!'],
      pushup: ['Отличное отжимание!', 'Вот это амплитуда!'],
      lunge: ['Отличный выпад!', 'Ровно и глубоко — супер!'],
      plank: ['Держишь отлично!', 'Ровная линия — супер!'],
    },
    better: ['Вот, уже лучше!', 'Да, вот так!', 'Исправлено — отлично!', 'Уже лучше, продолжай!'],
    filler: ['Хорошо работаешь!', 'Отличный темп!', 'Так держать, продолжаем!', 'Дыши ровно.', 'Молодец, не сбавляй!', 'Всё получается!'],
    idle: ['Не останавливайся!', 'Передохнул — и снова в работу!', 'Давай ещё пару повторов!', 'Продолжаем, ты можешь!'],
    plankHold: ['Держим!', 'Дыши ровно, держим!', 'Ещё немного!', 'Отлично держишь!', 'Не сдавайся!'],
    milestone: {
      5: ['Пять! Так держать!', 'Пять повторов, отлично!'],
      10: ['Десять! Отличная работа!', 'Уже десять, продолжаем!'],
      15: ['Пятнадцать! Супер!'],
      20: ['Двадцать! Потрясающе!'],
    },
    // второе и далее повторение той же ошибки — образ и объяснение вместо короткой команды
    explain: {
      depth: { squat: ['Представь стульчик за пятками — садись на него.', 'Ещё ниже, ты можешь! Бёдра до параллели.'],
               pushup: ['Почти коснись пола грудью.', 'Опускайся, пока локти не согнутся до прямого угла.'],
               lunge: ['Опусти заднее колено почти до пола.', 'Согни обе ноги — заднее колено к полу.'] },
      trunk: { squat: ['Садись между пяток, а грудь держи высоко.'], lunge: ['Корпус как свеча — строго вертикально.'] },
      knees: { squat: ['Разводи колени, будто раздвигаешь пол стопами.'] },
      knee: { lunge: ['Опускайся вниз, а не вперёд — колено над пяткой.'] },
      line: { pushup: ['Тело как доска — напряги пресс и ягодицы.'], plank: ['Подкрути таз, тело — ровная доска.'] },
      heels: { squat: ['Перенеси вес на пятки, пальцы можно даже приподнять.'] },
    },
    nudgePraise: ['Хорошо', 'Отлично', 'Неплохо'],
    nudge: { // мягкая подсказка к похвале: «Хорошо, а теперь …»
      sq_depth_minor: 'а теперь чуть глубже', pu_depth_minor: 'а теперь чуть ниже', lu_depth_minor: 'а теперь чуть глубже',
      sq_lockout: 'и выпрямляйся до конца', pu_lockout: 'и выпрямляй руки до конца', pu_sag_minor: 'и держи линию тела',
      sq_fast: 'и чуть медленнее вниз', pu_fast: 'и медленнее вниз', lu_fast: 'и помедленнее', lu_trunk: 'и корпус повыше',
      sq_valgus_minor: 'и колени чуть наружу', lu_wide: 'и шаг чуть короче', pu_flare: 'и локти ближе к корпусу', pu_head: 'и голову ровно',
      sq_shift: 'и вес на обе ноги', sq_stance_narrow: 'и ноги чуть шире',
    },
  };

  // ---------------- план тренировки: сколько повторов и подходов ----------------
  const plural = (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many; };
  const repsWord = (n) => plural(n, 'повторение', 'повторения', 'повторений');
  const secWord = (n) => plural(n, 'секунду', 'секунды', 'секунд');
  // Стартовые объёмы — умеренные, как у тренера на первой встрече. Выпады — всего на обе ноги.
  const PLAN_BASE = {
    squat: { target: 12, sets: 3, rest: 60, step: 2, min: 6, max: 40 },
    pushup: { target: 8, sets: 3, rest: 60, step: 2, min: 4, max: 40 },
    lunge: { target: 12, sets: 3, rest: 60, step: 2, min: 6, max: 40 },
    plank: { target: 30, sets: 3, rest: 45, step: 10, min: 15, max: 180 },
  };
  // Прогрессия как у живого тренера: всё сделано и чисто — добавляем; не справился или техника развалилась — снижаем.
  function nextPlan(ex, last) {
    const b = PLAN_BASE[ex], plan = { target: b.target, sets: b.sets, rest: b.rest, unit: ex === 'plank' ? 'sec' : 'reps', why: 'Стартовый план — по нему посмотрим, как пойдёт.' };
    if (!last || !last.sets?.length) return plan;
    plan.sets = last.setsPlanned || b.sets;
    const done = last.sets.filter((x) => x.done >= last.target).length;
    const q = last.goodPct ?? 100;
    const unitTxt = (n) => plan.unit === 'sec' ? `${n} ${secWord(n)}` : `${n} ${repsWord(n)}`;
    if (done >= plan.sets && q >= 80) { plan.target = Math.min(b.max, last.target + b.step); plan.why = `В прошлый раз все подходы сделаны чисто — добавляю ${unitTxt(b.step)}.`; }
    else if (done === 0 || q < 50) { plan.target = Math.max(b.min, last.target - b.step); plan.why = q < 50 ? 'В прошлый раз техника страдала — делаем меньше, но чище.' : 'В прошлый раз было тяжеловато — немного снижаю.'; }
    else { plan.target = last.target; plan.why = done < plan.sets ? 'Закрепим прошлый объём — цель сделать все подходы целиком.' : 'Закрепим прошлый объём — цель сделать все повторы чисто.'; }
    return plan;
  }
  const SETV = {
    intro: (p, k) => {
      const what = p.unit === 'sec' ? `Держим ${p.target} ${secWord(p.target)}.` : `Делаем ${p.target} ${repsWord(p.target)}.`;
      return k === 1 ? (p.sets > 1 ? `Подход первый. ${what} Поехали!` : `${what} Поехали!`)
        : k === p.sets ? `Последний подход! ${what} Поехали!` : `Подход ${['', 'первый', 'второй', 'третий', 'четвёртый', 'пятый', 'шестой'][k] || k}. ${what} Поехали!`;
    },
    left: { 3: 'Ещё три!', 2: 'Ещё два!', 1: 'Последний!' },
    half: ['Половина! Так держать!', 'Половина позади!'],
    doneSet: (rest) => [`Есть! Подход сделан. Отдых ${rest} ${secWord(rest)}.`],
    doneAll: ['Есть! Тренировка выполнена, ты молодец!', 'Всё! Отличная работа, тренировка сделана!'],
    over: ['Подход уже сделан — можно отдыхать.'],
    push: (n) => n === 1 ? 'Ещё один, давай!' : `Ещё ${['', 'один', 'два', 'три'][n] || n}, давай!`,
    tenLeft: 'Ещё десять секунд!',
    restSoon: 'Через десять секунд следующий подход. Приготовься!',
  };

  class CoachVoice {
    constructor(ex, rnd = Math.random) {
      this.ex = ex; this.rnd = rnd; this.lastT = -99; this.lastSaid = ''; this.started = false;
      this.faultRuns = {}; this.lastMajor = []; this.lastRepT = null; this.idleSaid = -99; this.nGood = 0;
      this.plan = null; this.setNo = 0; this.repBase = 0; this.holdBase = 0; this.setDone = false; this.saidOver = false;
    }
    // новый подход: тренер сам называет цель («Делаем 12 повторений»), считает остаток и закрывает подход
    startSet(plan, setNo, repsSoFar = 0, holdSoFar = 0) {
      this.plan = plan; this.setNo = setNo; this.repBase = repsSoFar; this.holdBase = holdSoFar;
      this.setDone = false; this.saidOver = false; this.saidHalf = false; this.saidTen = false; this.started = false;
      this.lastTens = Math.floor(holdSoFar / 10); this.lastRepT = null; this.nGood = 0; this.lastMajor = []; this.faultRuns = {}; this.hadFault = false;
    }
    takeDone() { if (this.setDone === true) { this.setDone = 'taken'; return true; } return false; }
    pick(arr) { const opts = arr.filter((x) => x !== this.lastSaid); const a = opts.length ? opts : arr; return a[Math.floor(this.rnd() * a.length) % a.length]; }
    say(t, text, minGap = 2.3) {
      if (!text || t - this.lastT < minGap) return null;
      this.lastT = t; this.lastSaid = text; return text;
    }
    // inRep — ошибка, замеченная прямо во время движения; rep — итог повтора; status — 'ok' | 'nopose'
    decide(t, { inRep = [], rep = null, status = 'ok', hold = null } = {}) {
      if (status !== 'ok') return null;
      if (!this.started) { this.started = true; return this.say(t, this.plan ? SETV.intro(this.plan, this.setNo) : this.pick(VOICE.start), 0); }
      if (this.ex === 'plank') return this.plank(t, inRep, hold);
      // 1) подсказка прямо в движении — только при новой ошибке и не чаще раза в 2 повтора на одну группу
      for (const c of inRep) {
        const g = FAULTS[c].group, run = this.faultRuns[g] || 0;
        if (run >= 1 && run % 2 === 1) continue;
        const said = this.say(t, this.pick(FAULTS[c].cues), 1.5); if (said) return said;
      }
      if (rep) {
        this.lastRepT = t;
        const major = rep.faults.filter((c) => FAULTS[c].severity === 'major');
        // счёт к цели подхода важнее всего остального; подсказку по технике приклеиваем к нему
        if (this.plan && this.plan.unit === 'reps') {
          const k = rep.n - this.repBase, left = this.plan.target - k;
          if (left === 0 && !this.setDone) {
            this.setDone = true;
            return this.say(t, this.setNo >= this.plan.sets ? this.pick(SETV.doneAll) : this.pick(SETV.doneSet(this.plan.rest)), 0);
          }
          if (left < 0) { if (!this.saidOver) { this.saidOver = true; return this.say(t, SETV.over[0], 0.8); } return null; }
          if (left <= 3) {
            const cue = major.length && (this.faultRuns[FAULTS[major[0]].group] || 0) < 2 ? ' ' + this.pick(FAULTS[major[0]].cues) : '';
            if (major.length) { this.lastMajor = major; const g = FAULTS[major[0]].group; this.faultRuns[g] = (this.faultRuns[g] || 0) + 1; }
            return this.say(t, SETV.left[left] + cue, 0.8);
          }
          if (!major.length && !this.saidHalf && this.plan.target >= 8 && k === Math.ceil(this.plan.target / 2)) { this.saidHalf = true; return this.say(t, this.pick(SETV.half), 1.0); }
        }
        const minor = rep.faults.filter((c) => FAULTS[c].severity === 'minor');
        const groups = new Set(major.map((c) => FAULTS[c].group));
        for (const g of Object.keys(this.faultRuns)) if (!groups.has(g)) this.faultRuns[g] = 0;
        if (!major.length) {
          this.nGood++;
          const fixed = this.lastMajor.length > 0;
          this.lastMajor = [];
          const n = rep.n - this.repBase;
          if (VOICE.milestone[n]) return this.say(t, this.pick(VOICE.milestone[n]), 1.0);
          if (n > 20 && n % 5 === 0) return this.say(t, `${n}! Супер!`, 1.0);
          if (fixed) return this.say(t, this.pick(VOICE.better), 1.2);
          if (n === 2 && this.nGood === 2) return this.say(t, this.pick(VOICE.goodStart));
          if (minor.length && VOICE.nudge[minor[0]] && this.rnd() < 0.7) return this.say(t, `${this.pick(VOICE.nudgePraise)}, ${VOICE.nudge[minor[0]]}!`);
          if (t - this.lastT > 3.5) return this.say(t, this.rnd() < 0.5 && VOICE.praiseEx[this.ex] ? this.pick(VOICE.praiseEx[this.ex]) : this.pick(VOICE.praise));
          return null;
        }
        // ошибка: короткая команда → образ/объяснение → пауза (не нудим) → снова
        this.lastMajor = major;
        const c = major[0], g = FAULTS[c].group;
        const run = (this.faultRuns[g] = (this.faultRuns[g] || 0) + 1);
        if (run === 1) return this.say(t, this.pick(FAULTS[c].cues), 1.2);
        if (run === 2) { const ex = VOICE.explain[g]?.[this.ex]; return this.say(t, ex ? this.pick(ex) : this.pick(FAULTS[c].cues), 1.2); }
        if (run % 3 === 0) return this.say(t, this.pick(FAULTS[c].cues), 1.2);
        return null;
      }
      // 2) человек остановился
      if (this.plan && this.setDone) return null; // подход закрыт — молчим, идёт отдых
      if (this.lastRepT != null && t - this.lastRepT > 7 && t - this.idleSaid > 8) {
        this.idleSaid = t;
        const left = this.plan && this.plan.unit === 'reps' ? this.plan.target - (this.repsNow - this.repBase) : null;
        return this.say(t, left != null && left > 0 && left <= 3 ? SETV.push(left) : this.pick(VOICE.idle));
      }
      // 3) давно молчим, а человек работает — короткая мотивация
      if (this.lastRepT != null && t - this.lastRepT < 4 && t - this.lastT > 7) return this.say(t, this.pick(VOICE.filler));
      return null;
    }
    plank(t, live, hold) {
      this.fT ??= {}; this.fRun ??= {};
      if (live.length) {
        this.badSince = t; this.hadFault = true;
        const c = live[0];
        if (t - (this.fT[c] ?? -99) > 4) {
          this.fT[c] = t; const run = (this.fRun[c] = (this.fRun[c] || 0) + 1);
          const ex = run >= 2 ? VOICE.explain[FAULTS[c].group]?.plank : null;
          return this.say(t, ex ? this.pick(ex) : this.pick(FAULTS[c].cues), 1.5);
        }
        return null;
      }
      // «уже лучше» — только если ошибка была и уже 1,5 с всё правильно
      if (this.hadFault && t - this.badSince > 1.5) { this.hadFault = false; this.fRun = {}; return this.say(t, this.pick(VOICE.better), 1.5); }
      if (this.plan && this.plan.unit === 'sec') {
        const h = (hold || 0) - this.holdBase, left = this.plan.target - h;
        if (this.setDone) return null;
        if (left <= 0) { this.setDone = true; return this.say(t, this.setNo >= this.plan.sets ? this.pick(SETV.doneAll) : this.pick(SETV.doneSet(this.plan.rest)), 0); }
        if (left <= 10 && this.plan.target >= 20 && !this.saidTen) { this.saidTen = true; return this.say(t, SETV.tenLeft, 1.0); }
        const tens = Math.floor(h / 10);
        if (tens > (this.lastTens || 0) && left > 10) { this.lastTens = tens; return this.say(t, `${tens * 10} секунд`, 1.0); }
        if (t - this.lastT > 6) return this.say(t, this.pick(VOICE.plankHold));
        return null;
      }
      const tens = Math.floor((hold || 0) / 10);
      if (tens > (this.lastTens || 0)) { this.lastTens = tens; return this.say(t, tens % 3 === 0 ? `${tens * 10} секунд! ${this.pick(VOICE.plankHold)}` : `${tens * 10} секунд`, 1.0); }
      if (t - this.lastT > 6) return this.say(t, this.pick(VOICE.plankHold));
      return null;
    }
  }

  // Все фразы тренера, разбитые на кусочки для записи голосом (составные фразы склеиваются из кусочков)
  function allPhrases() {
    const set = new Set();
    const add = (t) => { if (!t) return; for (const p of String(t).split(/(?<=[!.?])\s+/)) { const x = p.trim(); if (x) set.add(x); } };
    for (const f of Object.values(FAULTS)) f.cues.forEach(add);
    for (const k of ['start', 'goodStart', 'praise', 'better', 'filler', 'idle', 'plankHold']) VOICE[k].forEach(add);
    Object.values(VOICE.praiseEx).flat().forEach(add);
    Object.values(VOICE.milestone).flat().forEach(add);
    for (const g of Object.values(VOICE.explain)) Object.values(g).flat().forEach(add);
    for (const p of VOICE.nudgePraise) for (const n of Object.values(VOICE.nudge)) set.add(`${p}, ${n}!`); // «Хорошо, а теперь чуть глубже!» — целиком
    for (let n = 25; n <= 100; n += 5) set.add(`${n}!`); set.add('Супер!');
    for (let n = 10; n <= 600; n += 10) { set.add(`${n} секунд`); set.add(`${n} секунд!`); }
    ['Привет! Я твой тренер.', 'Начинаем — ниже, до параллели!', 'Вот так, отлично!', 'Готовимся', 'Займите исходное положение', 'Поехали!', 'Разбираю видео'].forEach(add);
    SUMMARY.head.forEach(add); SUMMARY.tail.forEach(add);
    for (let k = 1; k <= 6; k++) for (const ex of Object.keys(PLAN_BASE)) { const b = PLAN_BASE[ex];
      for (let n = b.min; n <= b.max; n += ex === 'plank' ? 5 : 1) add(SETV.intro({ target: n, sets: 6, unit: ex === 'plank' ? 'sec' : 'reps' }, k)); add(SETV.intro({ target: b.target, sets: 1, unit: ex === 'plank' ? 'sec' : 'reps' }, 1)); }
    Object.values(SETV.left).forEach(add); SETV.half.forEach(add); SETV.doneAll.forEach(add); SETV.over.forEach(add);
    for (const r of [30, 45, 60, 90, 120]) { SETV.doneSet(r).forEach(add); add(`Отдых ${r} ${secWord(r)}.`); }
    [1, 2, 3].forEach((n) => add(SETV.push(n))); add(SETV.tenLeft); add(SETV.restSoon); add('Следующий подход!');
    for (const n of [2, 4, 6, 10]) add(`Ещё ${n} ${repsWord(n)}.`);
    for (const f of Object.values(FAULTS)) add(`Главное — ${f.title.toLowerCase()}.`);
    return [...set];
  }
  // итоговая фраза после подхода — из готовых кусочков, чтобы её можно было озвучить записанным голосом
  const SUMMARY = {
    head: ['Отличный подход!', 'Хороший подход, есть что подточить.', 'Есть над чем поработать.', 'Не получилось засчитать повторы.', 'Планка засчитана!', 'Не получилось распознать планку.'],
    tail: ['Техника чистая, так держать!', 'Подробности — в отчёте.'],
  };
  function spokenSummary(r) {
    if (r.exercise === 'plank') {
      if (!r.holdSec) return SUMMARY.head[5];
      return `${SUMMARY.head[4]} ${r.priority ? `Главное — ${r.priority.title.toLowerCase()}.` : SUMMARY.tail[0]}`;
    }
    if (!r.reps) return SUMMARY.head[3];
    const head = r.score >= 85 ? SUMMARY.head[0] : r.score >= 65 ? SUMMARY.head[1] : SUMMARY.head[2];
    return `${head} ${r.priority ? `Главное — ${r.priority.title.toLowerCase()}.` : SUMMARY.tail[0]} ${SUMMARY.tail[1]}`;
  }
  function _unused() {
    return [...set];
  }

  // ---------------- живая сессия (камера) ----------------
  // Считает повторы на лету, даёт голосовые подсказки внутри повтора и сразу после него.
  // Итоговый отчёт всё равно строится через analyze() по всем записанным кадрам — так точнее.
  class LiveSession {
    constructor(exercise, opts = {}) {
      this.ex = exercise; this.cfg = EXERCISES[exercise];
      this.raw = []; this.F = []; this.filter = new FrameFilter(); this.trk = newTrackers();
      this.state = 'up'; this.base = null; this.peak = null; this.startIdx = 0;
      this.reps = []; this.lastFaults = []; this.goodStreak = 0;
      this.instant = {}; this.saidInRep = new Set();
      this.rnd = opts.random || Math.random;
      this.hold = 0; this.lastCueT = -99; this.lastAnnounce = 0; this.prevT = null;
      this.voice = new CoachVoice(exercise, this.rnd);
    }

    push(t, lm, wl, aspect) {
      const raw = makeFrame(t, lm, wl, aspect);
      this.raw.push(raw);
      const fr = this.filter.apply(raw);
      const f0 = features(fr);
      // типичные длины костей уточняются по ходу тренировки
      if (f0.ok && (this.F.length % 30 === 0) && this.F.length >= 30) { const recent = this.F.slice(-300).filter((x) => x.ok); this.trk.refLeg = boneRef(recent, 'leg'); this.trk.refArm = boneRef(recent, 'arm'); }
      const f = resolveOne(f0, this.trk);
      if (f.ok && f.hipH > 0) { this.hipRef = this.hipRef == null ? f.hipH : Math.max(f.hipH, this.hipRef * 0.999); f.hipDrop = clamp(100 * (this.hipRef - f.hipH) / this.hipRef, -20, 90); }
      this.F.push(f);
      const out = { status: 'ok', message: '', live: [], say: null, rep: null, f };
      if (!f.ok) { out.status = 'nopose'; out.message = 'Не вижу вас в кадре'; return out; }
      if (!this.cfg.valid(f)) {
        out.status = 'nopose';
        out.message = this.ex === 'squat' ? 'Встаньте так, чтобы было видно тело целиком — от плеч до стоп'
          : 'Примите исходное положение боком к камере — должно быть видно тело целиком';
        return out;
      }
      const res = this.ex === 'plank' ? this.plank(f, out) : this.repStep(f, out);
      // что и когда сказать — решает «голос тренера»
      this.voice.repsNow = this.reps.length;
      res.say = this.voice.decide(f.t, { inRep: res.newLive || [], rep: res.rep, status: res.status, hold: this.hold });
      res.setDone = this.voice.takeDone();
      return res;
    }

    // мгновенные ошибки для подсказок прямо во время движения
    instantFaults(f) {
      const now = [];
      if (this.ex === 'squat') {
        if (f.view !== 'front' && f.kneeFlex > 60 && f.lean > SQ_T[f.view].trunkLean + 5 && f.lean - f.shin > SQ_T[f.view].trunkDiff + 5) now.push('sq_trunk');
        if (f.view === 'front' && f.kneeFlex > 50 && this.valBase && Math.max(f.valgusL - this.valBase.L, f.valgusR - this.valBase.R) > SQ_T.front.kneesMajor) now.push('sq_valgus');
      } else if (this.ex === 'lunge') {
        if (f.view !== 'front' && f.hipDrop > 15) {
          const front = f.leg.L.thighV >= f.leg.R.thighV ? 'L' : 'R';
          if (f.leg[front].shinFwd > LU_T.shinMajor + 5) now.push('lu_knee_toe');
        }
      } else if (this.ex === 'pushup') {
        if (f.view !== 'front' && f.bodyLine > PU_T[f.view].sagMajor + 0.01) now.push('pu_sag');
        if (f.view !== 'front' && f.bodyLine < PU_T[f.view].pike - 0.01) now.push('pu_pike');
      }
      const res = [];
      for (const c of now) { this.instant[c] = (this.instant[c] ?? f.t); if (f.t - this.instant[c] >= 0.25) res.push(c); }
      for (const c in this.instant) if (!now.includes(c)) delete this.instant[c];
      return res;
    }

    repStep(f, out) {
      const sig = f[this.cfg.sig], prom = this.cfg.minProm;
      const i = this.F.length - 1;
      if (this.state === 'up') {
        // опорное положение «наверху» плавно подстраивается
        this.base = this.base == null ? sig : Math.min(sig, this.base + 0.04 * (sig - this.base) + 0.02);
        if (this.ex === 'squat' && f.view === 'front' && sig < this.base + 10) {
          this.valBase = this.valBase ? { L: lerp(this.valBase.L, f.valgusL, 0.1), R: lerp(this.valBase.R, f.valgusR, 0.1) } : { L: f.valgusL, R: f.valgusR };
        }
        if (sig < this.base + 0.22 * prom) this.startIdx = i;
        if (sig > this.base + 0.6 * prom) { this.state = 'down'; this.peak = sig; this.saidInRep.clear(); }
      } else {
        this.peak = Math.max(this.peak, sig);
        out.newLive = [];
        for (const c of this.instantFaults(f)) {
          out.live.push(c);
          if (!this.saidInRep.has(FAULTS[c].group)) { this.saidInRep.add(FAULTS[c].group); out.newLive.push(c); }
        }
        const endTh = this.base + 0.22 * (this.peak - this.base);
        if (sig < endTh) {
          this.state = 'up';
          if (this.peak - this.base >= 0.8 * prom && f.t - this.F[this.startIdx].t >= 0.45) {
            const rep = this.evaluateLast(this.startIdx, i);
            if (rep) out.rep = rep;
          }
        }
      }
      return out;
    }

    evaluateLast(s, e) {
      const F = this.F;
      let p = s; for (let k = s; k <= e; k++) if ((F[k][this.cfg.sig] ?? -1) > (F[p][this.cfg.sig] ?? -1)) p = k;
      const top = Math.min(F[s][this.cfg.sig], F[e][this.cfg.sig]);
      const ev = this.cfg.eval(F, { s, p, e, top: NaN });
      void top;
      const faults = ev.criteria.filter((c) => c.status === 'major' || c.status === 'minor').map((c) => c.code);
      const rep = { n: this.reps.length + 1, score: scoreOf(ev.criteria), faults, criteria: ev.criteria,
        good: !faults.some((c) => FAULTS[c].severity === 'major'), bottomT: F[p].t, depthText: ev.depthText, leg: ev.leg };
      this.reps.push(rep);
      return rep;
    }

    plank(f, out) {
      const dt = this.prevT == null ? 0 : clamp(f.t - this.prevT, 0, 0.3);
      this.prevT = f.t;
      if (!this.cfg.valid(f)) return out;
      this.hold += dt;
      const now = [];
      const T = PL_T[f.view] || PL_T.side;
      if (f.bodyLine > T.sag + 0.005) now.push('pl_sag');
      if (f.bodyLine < T.pike - 0.01) now.push('pl_pike');
      const live = [];
      for (const c of now) { this.instant[c] = this.instant[c] ?? f.t; if (f.t - this.instant[c] >= 0.5) live.push(c); }
      for (const c in this.instant) if (!now.includes(c)) delete this.instant[c];
      out.live = live; out.newLive = live;
      out.hold = this.hold;
      return out;
    }

    // план подходов: цель и счёт ведёт голос тренера
    startSet(plan, setNo) { this.voice.startSet(plan, setNo, this.reps.length, this.hold); }
    finish(weightKg) { return analyze(this.raw, this.ex, { weightKg }); }
  }

  const api = { nextPlan, PLAN_BASE, plural, repsWord, secWord, SETV, PL_T, spokenSummary, allPhrases, CoachVoice, VOICE, LU_T, SQ_T, PU_T, viewOf, I, SIDES, FAULTS, EXERCISES, makeFrame, pickPerson, PersonTracker, smoothOffline, features, segmentReps, analyze, LiveSession, OneEuro, yawOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrainerEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
