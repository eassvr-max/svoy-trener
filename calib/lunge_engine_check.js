const E = require('/home/claude/trainer/engine.js');
const fs = require('fs');
const NAMES = ['nose','left_shoulder','right_shoulder','left_hip','right_hip','left_knee','right_knee','left_ankle','right_ankle','left_heel','right_heel','left_foot_index','right_foot_index'];
const IDX = [0,11,12,23,24,25,26,27,28,29,30,31,32];
for (const file of ['err.train.csv', 'err.test.csv']) {
  const lines = fs.readFileSync('/home/claude/datasets/Exercise-Correction/core/lunge_model/' + file, 'utf8').trim().split('\n'); const h = lines[0].split(',');
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const ln of lines.slice(1)) {
    const v = ln.split(','); const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
    NAMES.forEach((n, k) => { const c = h.indexOf(n + '_x'); lm[IDX[k]] = { x: +v[c], y: +v[c + 1], z: +v[c + 2], visibility: +v[c + 3] }; });
    for (const [a, b] of [[13, 11], [14, 12], [15, 11], [16, 12], [7, 0], [8, 0]]) lm[a] = { ...lm[b], visibility: 0 };
    const f = E.features(E.makeFrame(0, lm, null, 16 / 9));
    const front = f.leg.L.thighV >= f.leg.R.thighV ? 'L' : 'R';
    const pred = f.leg[front].shinFwd > E.LU_T.shinMajor;
    const err = v[0] === 'L';
    if (pred && err) tp++; else if (!pred && !err) tn++; else if (pred) fp++; else fn++;
  }
  console.log(`${file}: точность ${(100 * (tp + tn) / (tp + tn + fp + fn)).toFixed(1)}%  правильных с ложным замечанием ${(100 * fp / (fp + tn)).toFixed(1)}%  пропущено ошибок ${(100 * fn / (fn + tp)).toFixed(1)}%`);
}
