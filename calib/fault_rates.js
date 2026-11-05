// Доля повторов с каждым замечанием: отдельно в «хороших» и «плохих» видео, по ракурсам
const E = require('/home/claude/trainer/engine.js');
const fs = require('fs');
const DIR = '/home/claude/bench/mendeley';
const ex = process.argv[2] || 'squat', exf = ex === 'pushup' ? 'push_up' : 'squat';
const stat = {}; const vals = {};
for (const f of fs.readdirSync(DIR).filter((x) => x.includes(`_${exf}_`) && x.endsWith('.json'))) {
  const [, , , q, v] = f.replace('.json', '').replace('push_up', 'pushup').split('_');
  const d = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')); if (d.error) continue;
  const pt = new E.PersonTracker();
  const r = E.analyze(d.frames.map((fr) => { const i = pt.pick(fr.poses); return E.makeFrame(fr.t, i < 0 ? null : fr.poses[i], i < 0 ? null : fr.worlds[i], fr.aspect); }), ex);
  const key = `${v}/${q}`; const S = (stat[key] ??= { videos: 0, reps: 0, zero: 0, scores: [], f: {} });
  S.videos++; S.reps += r.reps; if (!r.reps) S.zero++; S.scores.push(r.score);
  for (const rep of r.repsDetail) {
    for (const c of rep.faults) S.f[c] = (S.f[c] || 0) + 1;
    for (const c of rep.criteria) if (c.value != null) ((vals[`${v}|${c.code.replace(/^(sq|pu)_/, '').replace(/_(major|minor)$/, '')}`] ??= { good: [], bad: [] })[q]).push(c.value);
  }
}
for (const k of Object.keys(stat).sort()) {
  const S = stat[k]; const m = S.scores.sort((a, b) => a - b)[S.scores.length >> 1];
  console.log(`${k.padEnd(14)} видео ${S.videos} повт ${S.reps} (0 повт: ${S.zero}) медиана оценки ${m}  | ` + Object.entries(S.f).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${Math.round(100 * n / S.reps)}%`).join(', '));
}
fs.writeFileSync(`/home/claude/bench/vals_${ex}.json`, JSON.stringify(vals));
