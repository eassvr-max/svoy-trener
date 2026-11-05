const E = require('/home/claude/trainer/engine.js'); const fs = require('fs');
const sel = JSON.parse(fs.readFileSync('qevd_sel.json')).filter((s) => s.labels[0].includes('plank'));
const clips = [];
for (const s of sel) { const f = `qevd/${String(s.id).padStart(8, '0')}.json`; if (!fs.existsSync(f)) continue;
  const d = JSON.parse(fs.readFileSync(f)); if (d.error) continue; const pt = new E.PersonTracker();
  clips.push({ s, raw: d.frames.map((fr) => { const i = pt.pick(fr.poses); return E.makeFrame(fr.t, i < 0 ? null : fr.poses[i], i < 0 ? null : fr.worlds[i], fr.aspect); }) }); }
const L = (c, re) => c.s.labels.some((l) => re.test(l));
const G = { high: (c) => L(c, /high hips|hips too high/), low: (c) => L(c, /hips too low|butt sinking/), floor: (c) => L(c, /on the floor|on knees|knees on floor/), clean: (c) => !L(c, /high hips|hips too|sinking|on the floor|on knees|knees on floor/) };
for (const [sag, pike] of [[0.02, -0.16], [0.06, -0.2], [0.08, -0.22], [0.1, -0.25], [0.12, -0.3]]) {
  E.PL_T.front.sag = sag; E.PL_T.front.pike = pike; const row = {};
  for (const [g, f] of Object.entries(G)) { const cs = clips.filter(f); let sg = 0, pk = 0;
    for (const c of cs) { const r = E.analyze(c.raw, 'plank'); if (r.faults.some((x) => x.code === 'pl_sag')) sg++; if (r.faults.some((x) => x.code === 'pl_pike')) pk++; }
    row[g] = `n${cs.length} провис ${sg} задран ${pk}`; }
  console.log(`спереди sag>${sag} pike<${pike}:`, JSON.stringify(row));
}
