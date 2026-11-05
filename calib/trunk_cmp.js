// сравнение признаков наклона корпуса спереди: QEVD (back not straight vs чистые) и Mendeley (bad vs good, фронт)
const E = require('/home/claude/trainer/engine.js'); const fs = require('fs');
const run = (file, ex) => { const d = JSON.parse(fs.readFileSync(file)); if (d.error) return []; globalThis.__dbgTrunk = []; const pt = new E.PersonTracker();
  E.analyze(d.frames.map((fr) => { const i = pt.pick(fr.poses); return E.makeFrame(fr.t, i < 0 ? null : fr.poses[i], i < 0 ? null : fr.worlds[i], fr.aspect); }), ex); return globalThis.__dbgTrunk; };
const R = require('./qevd_res2.json').filter((r) => r.sub === 'squats' && r.reps && r.view === 'front');
const has = (r, ...ls) => r.labels.some((l) => ls.includes(l));
const Q = { back: [], clean: [] };
for (const r of R) { const g = has(r, 'back not straight') ? 'back' : has(r, 'no obvious issue') && !has(r, 'shallow', 'insufficient', 'knees over toes') ? 'clean' : null; if (g) Q[g].push(...run(`qevd/${String(r.id).padStart(8, '0')}.json`, 'squat')); }
const M = { bad: [], good: [] };
for (const f of fs.readdirSync('mendeley').filter((x) => x.includes('_squat_') && x.includes('front'))) { const q = f.split('_')[3]; (M[q] ||= []).push(...run('mendeley/' + f, 'squat')); }
const pr = (name, A, f, ths) => console.log(name.padEnd(28), Object.entries(A).map(([k, v]) => `${k}(${v.length}): ` + ths.map((t) => (100 * v.filter((x) => f(x) > t).length / v.length).toFixed(0)).join('/')).join('  '), ' пороги', ths.join('/'));
for (const [n, f, th] of [['lean', (x) => x[0], [30, 35, 40, 45, 50]], ['lean−shin', (x) => x[0] - x[1], [0, 5, 10, 15, 20, 25]], ['shin', (x) => x[1], [20, 30, 40]]]) { pr('QEVD ' + n, Q, f, th); pr('Mendeley ' + n, M, f, th); }
