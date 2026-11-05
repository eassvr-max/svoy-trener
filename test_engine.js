// Проверка движка v2 на синтетических 3D-движениях с разных ракурсов камеры
const E = require('./engine.js');
const S = require('./synth3d.js');
const { wave } = S;

let fails = 0;
const check = (name, cond, info = '') => { console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${info ? '  — ' + info : ''}`); if (!cond) fails++; };
const raw = (seq) => seq.map((f) => E.makeFrame(f.t, f.lm, f.wl, f.aspect));
const faultsOf = (res) => res.repsDetail.map((r) => r.faults.join('+') || 'ok').join(' | ');
const has = (res, i, code) => res.repsDetail[i] && res.repsDetail[i].faults.includes(code);
const clean = (res, i) => res.repsDetail[i] && !res.repsDetail[i].faults.some((c) => E.FAULTS[c].severity === 'major');

// ---- генераторы повторов ----
function squat({ F = 125, lean = 35, dur = 2.6, valgus = 0, heel = 0, hipsFirst = 0, shift = 0, topF = 0 } = {}) {
  return [dur, (u) => {
    const w = wave(u);
    const up = u > 0.5 ? Math.sin(Math.PI * Math.min(1, (u - 0.5) / 0.3)) : 0; // начало подъёма
    return S.squatPose({ F: topF + (F - topF) * w, lean: 8 + (lean - 8) * w + hipsFirst * up, valgus: valgus * w, heelLift: heel * w, shift: shift * w });
  }];
}
const stand = (sec = 1.2) => [sec, () => S.squatPose({ F: 0, lean: 8 })];
const pu = ({ elbow = 80, sag = 0, flare = 40, head = 0, dur = 2, top = 168 } = {}) =>
  [dur, (u) => S.pushupPose({ elbow: top - (top - elbow) * wave(u), sag, flare, headDrop: head })];
const puTop = (sec = 1) => [sec, () => S.pushupPose({ elbow: 168 })];

// ===== 1. Присед сбоку =====
{
  const seq = S.sequence([stand(),
    squat(), squat({ F: 130 }), squat(),                 // 0-2 хорошие
    squat({ F: 78 }),                                    // 3 полуприсед
    squat({ F: 95 }),                                    // 4 чуть выше параллели
    squat({ lean: 88 }),                                 // 5 корпус завален
    squat({ hipsFirst: 22 }),                            // 6 таз раньше груди
    squat({ heel: 0.12 }),                               // 7 пятки (≈10+ см — порог, согласованный с шумом нейросети)
    squat({ dur: 0.9 }),                                 // 8 быстрый спуск
    stand()], 90, { seed: 3 });
  const res = E.analyze(raw(seq), 'squat');
  console.log('  ракурс:', res.meta.view, ' повторы:', faultsOf(res));
  check('сбоку: 9 повторов', res.reps === 9, `reps=${res.reps}`);
  check('сбоку: хорошие чистые', [0, 1, 2].every((i) => res.repsDetail[i]?.faults.length === 0), res.repsDetail.slice(0, 3).map((r) => r.depthText).join('; '));
  check('сбоку: полуприсед', has(res, 3, 'sq_depth_major'));
  check('сбоку: чуть выше параллели', has(res, 4, 'sq_depth_minor'), res.repsDetail[4]?.depthText);
  check('сбоку: корпус', has(res, 5, 'sq_trunk'));
  check('сбоку: таз раньше груди', has(res, 6, 'sq_hips_first'));
  check('сбоку: пятки', has(res, 7, 'sq_heels'));
  check('сбоку: быстрый спуск', has(res, 8, 'sq_fast'));
  check('сбоку: колени помечены как «не проверить»', res.notes.some((n) => /спереди/.test(n)));
  console.log('  оценка:', res.score, '\n  тренер:', res.coachText);
}

// ===== 2. Присед спереди =====
{
  const seq = S.sequence([stand(), squat(), squat(), squat({ valgus: 0.8 }), squat({ valgus: 0.8 }), squat({ F: 80 }), squat({ shift: 0.09 }), stand()], 0, { seed: 5 });
  const res = E.analyze(raw(seq), 'squat');
  console.log('  ракурс:', res.meta.view, ' повторы:', faultsOf(res));
  check('спереди: 6 повторов', res.reps === 6, `reps=${res.reps}`);
  check('спереди: хорошие чистые', clean(res, 0) && clean(res, 1), res.repsDetail.slice(0, 2).map((r) => r.depthText).join('; '));
  check('спереди: колени внутрь', has(res, 2, 'sq_valgus') && has(res, 3, 'sq_valgus'));
  check('спереди: глубина по 3D', has(res, 4, 'sq_depth_major'), res.repsDetail[4]?.depthText);
  check('спереди: перекос таза', has(res, 5, 'sq_shift'));
}

// ===== 3. Присед под углом 45° =====
{
  const seq = S.sequence([stand(), squat(), squat(), squat(), squat({ F: 50 }), squat({ F: 50 }), stand()], 45, { seed: 9 });
  const res = E.analyze(raw(seq), 'squat');
  console.log('  ракурс:', res.meta.view, ' повторы:', faultsOf(res), ' глубина:', res.repsDetail.map((r) => Math.round(r.depthValue)).join(','));
  check('45°: 5 повторов', res.reps === 5, `reps=${res.reps}`);
  check('45°: глубина различается верно', clean(res, 0) && clean(res, 1) && has(res, 3, 'sq_depth_major') && has(res, 4, 'sq_depth_major'));
}

// ===== 4. Пропуски кадров и сильный шум =====
{
  const seq = S.sequence([stand(), squat(), squat(), squat(), squat({ F: 60 }), stand()], 80, { seed: 13, dropout: 0.12, noise: 2.5 });
  const res = E.analyze(raw(seq), 'squat');
  check('шум+12% пропусков: 4 повтора', res.reps === 4, `reps=${res.reps}; ${faultsOf(res)}`);
  check('шум: мелкий найден, хорошие не испорчены', has(res, 3, 'sq_depth_major') && clean(res, 0) && clean(res, 1) && clean(res, 2));
}

// ===== 5. Усталость: глубина падает к концу =====
{
  const Fs = [128, 126, 125, 122, 112, 104, 96, 90];
  const seq = S.sequence([stand(), ...Fs.map((F) => squat({ F })), stand()], 90, { seed: 21 });
  const res = E.analyze(raw(seq), 'squat');
  check('усталость замечена', res.notes.some((n) => /усталост/.test(n)), res.notes.join(' / '));
}

// ===== 6. Отжимания сбоку =====
{
  const seq = S.sequence([puTop(), pu(), pu(), pu({ elbow: 120 }), pu({ sag: 0.1 }), pu({ sag: -0.3 }), pu({ head: 0.22 }), pu({ top: 135 }), puTop()], 90, { seed: 7 });
  const res = E.analyze(raw(seq), 'pushup');
  console.log('  повторы:', faultsOf(res));
  check('отжимания: 7 повторов', res.reps === 7, `reps=${res.reps}`);
  check('отжимания: хорошие чистые', clean(res, 0) && clean(res, 1));
  check('отжимания: амплитуда', has(res, 2, 'pu_depth_major'));
  check('отжимания: провис', has(res, 3, 'pu_sag'));
  check('отжимания: таз вверх', has(res, 4, 'pu_pike'));
  check('отжимания: голова', has(res, 5, 'pu_head'));
}
{
  const seq = S.sequence([puTop(), pu(), pu({ top: 124 }), pu({ top: 124 }), pu({ top: 124 }), pu(), puTop()], 90, { seed: 19 });
  const res = E.analyze(raw(seq), 'pushup');
  check('отжимания: руки не выпрямляются', [1, 2, 3].some((i) => has(res, i, 'pu_lockout')) && !has(res, 0, 'pu_lockout') && !has(res, res.repsDetail.length - 1, 'pu_lockout'), faultsOf(res));
}

// ===== 7. Отжимания под углом: локти в стороны =====
{
  const seq = S.sequence([puTop(), pu(), pu(), pu({ flare: 85 }), pu({ flare: 85 }), puTop()], 50, { seed: 17 });
  const res = E.analyze(raw(seq), 'pushup');
  console.log('  повторы:', faultsOf(res), ' локти:', res.repsDetail.map((r) => r.criteria.find((c) => /elbows|flare/.test(c.code))?.value).join(','));
  check('отжимания 50°: 4 повтора', res.reps === 4, `reps=${res.reps}`);
  check('отжимания 50°: локти найдены только где есть', !has(res, 0, 'pu_flare') && has(res, 2, 'pu_flare') && has(res, 3, 'pu_flare'));
}

// ===== 8. Планка =====
{
  const seq = S.sequence([[14, () => S.plankPose({})], [8, () => S.plankPose({ sag: 0.1 })], [8, () => S.plankPose({ sag: -0.03 })]], 90, { seed: 4 });
  const res = E.analyze(raw(seq), 'plank');
  check('планка: ~30 с', Math.abs(res.holdSec - 30) <= 1, `hold=${res.holdSec}`);
  check('планка: ~22 с правильно', Math.abs(res.goodSec - 22) <= 2, `good=${res.goodSec}`);
  check('планка: провис', res.faults[0]?.code === 'pl_sag', res.faults.map((f) => f.code + ':' + f.seconds).join(','));
}

// ===== 8б. Выпады: чередование ног, колено за носок, мелкий выпад =====
{
  const lu = ({ drop = 1, hipZ = 0.02, front = 'L', dur = 2.4 } = {}) => [dur, (u) => { const w = wave(u); return S.lungePose({ drop: drop * w, hipZ: 0.02 + (hipZ - 0.02) * w, front }); }];
  const st = (front = 'L') => [1, () => S.lungePose({ drop: 0, front })];
  const seq = S.sequence([st('L'), lu(), lu(), lu({ hipZ: 0.3 }), lu({ drop: 0.3 }), st('R'), lu({ front: 'R' }), lu({ front: 'R' }), lu({ front: 'R', hipZ: 0.3 }), st('R')], 90, { seed: 31 });
  const res = E.analyze(raw(seq), 'lunge');
  console.log('  повторы:', faultsOf(res), ' ноги:', res.repsDetail.map((r) => r.leg).join(''));
  check('выпады: 7 повторов', res.reps === 7, `reps=${res.reps}`);
  check('выпады: передняя нога определена', res.repsDetail.map((r) => r.leg).join('') === 'LLLLRRR', res.repsDetail.map((r) => r.leg).join(''));
  check('выпады: колено за носок', has(res, 2, 'lu_knee_toe') && has(res, 6, 'lu_knee_toe') && clean(res, 0) && clean(res, 4), faultsOf(res));
  check('выпады: мелкий выпад', has(res, 3, 'lu_depth_major'), faultsOf(res));
}

// ===== 9. Живая сессия: счёт, подсказки, «уже лучше» =====
{
  const seq = S.sequence([stand(), squat(), squat(), squat({ F: 78 }), squat(), squat({ lean: 70 }), squat(), squat(), squat(), stand()], 90, { seed: 8 });
  let k = 0; const rnd = () => ((k = (k * 7 + 3) % 11) / 11);
  const live = new E.LiveSession('squat', { random: rnd });
  const said = [];
  for (const f of seq) { const o = live.push(f.t, f.lm, f.wl, f.aspect); if (o.say) said.push(o.say); }
  console.log('  голос:', said.join(' | '));
  check('онлайн: 8 повторов', live.reps.length === 8, `reps=${live.reps.length}: ${live.reps.map((r) => r.faults.join('+') || 'ok').join(' | ')}`);
  check('онлайн: подсказка про глубину', said.some((s) => /Глубже|Ниже|ниже/.test(s)));
  check('онлайн: «уже лучше» после исправления', said.some((s) => /лучше|Исправил|вот так/i.test(s)));
  const fin = live.finish(70);
  check('онлайн: итог считается офлайн', fin.reps === 8, `reps=${fin.reps}`);
}

// ===== 9б. План подхода: тренер называет цель, считает остаток и закрывает подход =====
{
  const seq = S.sequence([stand(), squat(), squat(), squat(), squat(), squat(), squat(), stand()], 90, { seed: 9 });
  let k = 0; const rnd = () => ((k = (k * 7 + 3) % 11) / 11);
  const live = new E.LiveSession('squat', { random: rnd });
  live.startSet({ target: 5, sets: 2, rest: 60, unit: 'reps' }, 1);
  const said = []; let doneAt = null;
  for (const f of seq) { const o = live.push(f.t, f.lm, f.wl, f.aspect); if (o.say) said.push(o.say); if (o.setDone && doneAt == null) doneAt = live.reps.length; }
  console.log('  голос (план 5):', said.join(' | '));
  check('план: называет цель', /Делаем 5 повторений/.test(said[0] || ''), said[0]);
  check('план: «ещё три / два / последний»', ['Ещё три!', 'Ещё два!', 'Последний!'].every((x) => said.some((s) => s.startsWith(x))));
  check('план: подход закрыт на 5-м повторе', doneAt === 5 && said.some((s) => /Подход сделан. Отдых 60 секунд/.test(s)), `doneAt=${doneAt}`);
  live.startSet({ target: 5, sets: 2, rest: 60, unit: 'reps' }, 2);
  const o2 = live.push(seq[seq.length - 1].t + 0.05, seq[seq.length - 1].lm, seq[seq.length - 1].wl, seq[seq.length - 1].aspect);
  check('план: второй подход — «Последний подход!»', /^Последний подход! Делаем 5 повторений/.test(o2.say || ''), o2.say);
  check('план: прогрессия', E.nextPlan('squat', { target: 12, setsPlanned: 3, sets: [{ done: 12 }, { done: 12 }, { done: 12 }], goodPct: 90 }).target === 14
    && E.nextPlan('squat', { target: 12, setsPlanned: 3, sets: [{ done: 7 }, { done: 6 }], goodPct: 70 }).target === 10);
  check('план: склонения', E.repsWord(1) === 'повторение' && E.repsWord(3) === 'повторения' && E.repsWord(12) === 'повторений' && E.repsWord(21) === 'повторение');
}

// ===== 9в. Бицепс с гантелями: пик, локоть, раскачка, поочерёдные руки; сбоку и спереди =====
for (const yaw of [90, 0]) {
  const stand = () => [0.8, () => S.curlPose({})];
  const curl = (o = {}) => [2.2, (u) => { const w = S.wave(u), fx = (o.F ?? 135) * w;
    return S.curlPose({ flexL: o.alt === 'R' ? 0 : fx, flexR: o.alt === 'L' ? 0 : fx, upper: o.upper ?? 5, lean: 3 - (o.swing ?? 0) * w }); }];
  const seq = S.sequence([stand(), curl(), curl({ F: 85 }), curl({ upper: 50 }), curl({ swing: 18 }), curl({ alt: 'L' }), curl({ alt: 'R' }), curl(), stand()], yaw, { seed: 5 });
  const res = E.analyze(seq.map((f) => E.makeFrame(f.t, f.lm, f.wl, f.aspect)), 'curl');
  const v = yaw === 90 ? 'сбоку' : 'спереди';
  check(`бицепс ${v}: 7 повторов`, res.reps === 7, faultsOf(res));
  check(`бицепс ${v}: чистые повторы без замечаний`, clean(res, 0) && clean(res, 4) && clean(res, 5) && clean(res, 6), faultsOf(res));
  check(`бицепс ${v}: не дожал / локоть / раскачка`, has(res, 1, 'cu_peak_major') && has(res, 2, 'cu_elbow') && has(res, 3, 'cu_swing'), faultsOf(res));
  check(`бицепс ${v}: поочерёдно — рука определена`, res.repsDetail[4].leg !== res.repsDetail[5].leg, res.repsDetail.map((r) => r.leg).join(''));
}
check('бицепс: прогрессия по весу', /тяжелее: гантели 7 кг/.test(E.nextPlan('curl', { target: 14, setsPlanned: 3, sets: [{ done: 14 }, { done: 14 }, { done: 14 }], goodPct: 95, kg: 6 }).why));

// ===== 10. Несколько людей в кадре =====
{
  const r = S.render(S.squatPose({}), 90, { r: () => 0.5 });
  const small = r.lm.map((p) => ({ ...p, x: 0.1 + (p.x - 0.5) * 0.3, y: 0.3 + (p.y - 0.5) * 0.3 }));
  check('выбирается главный человек', E.pickPerson([small, r.lm]) === 1);
}

console.log(fails ? `\n${fails} проверок не прошли` : '\nВсе проверки прошли');
process.exit(fails ? 1 : 0);
