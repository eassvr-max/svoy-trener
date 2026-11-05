"""
Озвучка всех фраз «Своего тренера» нейросетевым голосом → voice-pack.json для вшивания в приложение.

Запуск (нужен Python 3.9+ и интернет):
    pip install requests
    # Яндекс SpeechKit (русские голоса: alena, filipp, ermil, jane, omazh, zahar, madirus …)
    python make_voice_pack.py --engine yandex --key <API-ключ> --folder <folder_id> --voice alena --emotion good
    # или ElevenLabs (мультиязычная модель)
    python make_voice_pack.py --engine elevenlabs --key <API-ключ> --voice <voice_id>

Положите рядом со скриптом phrases.json и svoy-trener.html. Скрипт создаст svoy-trener-golos.html
со вшитым голосом — в настройках выберите «Записанный голос тренера ★».
"""
import argparse, base64, json, os, sys, time
import requests

ap = argparse.ArgumentParser()
ap.add_argument('--engine', choices=['yandex', 'elevenlabs'], required=True)
ap.add_argument('--key', default=os.environ.get('TTS_KEY'), help='или переменная окружения TTS_KEY')
ap.add_argument('--folder', help='folder_id в Yandex Cloud (для ключа сервисного аккаунта можно не указывать)')
ap.add_argument('--voice', default='alena')
ap.add_argument('--emotion', default='good', help='Яндекс: neutral | good (не у всех голосов)')
ap.add_argument('--speed', default='1.05')
ap.add_argument('--phrases', default=os.path.join(os.path.dirname(__file__), 'phrases.json'))
ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'voice-pack.json'))
ap.add_argument('--html', default=os.path.join(os.path.dirname(__file__), 'svoy-trener.html'), help='страница тренера, в которую вшить голос')
a = ap.parse_args()

phrases = json.load(open(a.phrases, encoding='utf-8'))
pack = json.load(open(a.out, encoding='utf-8')) if os.path.exists(a.out) else {}

def yandex(text):
    data = {'text': text, 'lang': 'ru-RU', 'voice': a.voice, 'speed': a.speed, 'format': 'mp3'}  # mp3 — играет и на айфоне
    if a.emotion: data['emotion'] = a.emotion
    if a.folder: data['folderId'] = a.folder
    r = requests.post('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize',
                      headers={'Authorization': f'Api-Key {a.key}'}, data=data, timeout=30)
    r.raise_for_status(); return 'data:audio/mpeg;base64,' + base64.b64encode(r.content).decode()

def eleven(text):
    r = requests.post(f'https://api.elevenlabs.io/v1/text-to-speech/{a.voice}',
                      headers={'xi-api-key': a.key, 'accept': 'audio/mpeg'},
                      json={'text': text, 'model_id': 'eleven_multilingual_v2',
                            'voice_settings': {'stability': 0.45, 'similarity_boost': 0.8, 'style': 0.35}}, timeout=60)
    r.raise_for_status(); return 'data:audio/mpeg;base64,' + base64.b64encode(r.content).decode()

synth = yandex if a.engine == 'yandex' else eleven
if not a.key: sys.exit('Нет ключа: --key или TTS_KEY')
pack = {k: v for k, v in pack.items() if k in set(phrases)}  # убираем фразы, которых больше нет
todo = [p for p in phrases if p not in pack]
print(f'Фраз всего {len(phrases)}, озвучить {len(todo)}')
for i, p in enumerate(todo, 1):
    for attempt in range(3):
        try:
            pack[p] = synth(p); break
        except Exception as e:
            print('  повтор:', p, e); time.sleep(2)
    if i % 20 == 0 or i == len(todo):
        json.dump(pack, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False)
        print(f'  {i}/{len(todo)}')
json.dump(pack, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False)
missing = [p for p in phrases if p not in pack]
if missing: print('Не озвучено:', len(missing), missing[:5])
print('Готово:', a.out, f'{os.path.getsize(a.out)/1e6:.1f} МБ')
if os.path.exists(a.html):
    html = open(a.html, encoding='utf-8').read()
    if '/*__VOICE_PACK__*/' not in html:
        sys.exit('В странице нет места для голоса — возьмите свежую версию svoy-trener.html')
    out = a.html.replace('.html', '-golos.html')
    open(out, 'w', encoding='utf-8').write(html.replace('/*__VOICE_PACK__*/', 'window.VOICE_PACK = ' + json.dumps(pack, ensure_ascii=False) + ';'))
    print('Страница с голосом:', out, '— откройте её, в настройках выберите «Записанный голос тренера ★»')
