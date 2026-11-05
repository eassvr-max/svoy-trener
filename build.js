// Собирает один самодостаточный HTML: вставляет engine.js внутрь index.html
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const js = fs.readFileSync(__dirname + '/engine.js', 'utf8');
fs.mkdirSync(__dirname + '/dist', { recursive: true });
// голосовой пакет (если озвучен скриптом tools/make_voice_pack.py) вшивается в страницу
const packPath = __dirname + '/voice-pack.json';
const pack = fs.existsSync(packPath) ? `window.VOICE_PACK = ${fs.readFileSync(packPath, 'utf8')};\n` : '/*__VOICE_PACK__*/\n';
if (fs.existsSync(packPath)) console.log('голосовой пакет вшит:', Object.keys(JSON.parse(fs.readFileSync(packPath, 'utf8'))).length, 'фраз');
fs.writeFileSync(__dirname + '/dist/svoy-trener.html', html.replace('/*__ENGINE__*/', () => pack + js));
console.log('dist/svoy-trener.html', fs.statSync(__dirname + '/dist/svoy-trener.html').size, 'bytes');
