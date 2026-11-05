"""QEVD Part-1 (4 тыс. клипов): позы heavy-моделью с прореживанием кадров. Планка 5 к/с, остальное 10 к/с."""
import sys, os, json, cv2, mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
SRC, OUT = '/home/claude/qevd_mp4', '/home/claude/bench/qevd'
part, nparts = int(sys.argv[1]), int(sys.argv[2])
order = {'squats': 0, 'pushups': 1, 'alternating forward lunges': 2, 'lunges (right leg out in front)': 2, 'lunges (left leg out in front)': 2,
         'elbow plank': 3, 'pushups (on knees)': 4, 'high plank': 5}
sel = sorted(json.load(open('/home/claude/bench/qevd_sel2.json')), key=lambda s: (order.get(s['labels'][0].split(' - ')[0], 9), s['id']))
for k, s in enumerate(sel):
    if k % nparts != part: continue
    name = '%08d' % s['id']; out = f'{OUT}/{name}.json'
    if os.path.exists(out): continue
    stride = 6 if 'plank' in s['labels'][0] else 3
    try:
        det = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path='/home/claude/models/heavy.task'), running_mode=vision.RunningMode.VIDEO,
            num_poses=1, min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.6))
        cap = cv2.VideoCapture(f'{SRC}/{name}.mp4'); fps = cap.get(cv2.CAP_PROP_FPS) or 30
        frames, i = [], 0
        while True:
            ok = cap.grab()
            if not ok: break
            if i % stride == 0:
                ok, img = cap.retrieve(); h, w = img.shape[:2]
                r = det.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)), int(i * 1000 / fps))
                frames.append({'t': i / fps, 'aspect': w / h,
                    'poses': [[{'x': p.x, 'y': p.y, 'z': p.z, 'visibility': p.visibility} for p in L] for L in r.pose_landmarks],
                    'worlds': [[{'x': p.x, 'y': p.y, 'z': p.z} for p in L] for L in r.pose_world_landmarks]})
            i += 1
        det.close()
        json.dump({'src': name, 'fps': fps / stride, 'frames': frames}, open(out + '.tmp', 'w')); os.rename(out + '.tmp', out)
        print(name, len(frames), flush=True)
    except Exception as e:
        print('ОШИБКА', name, e, flush=True); open(out, 'w').write('{"error": true}')
print('ВСЁ', flush=True)
