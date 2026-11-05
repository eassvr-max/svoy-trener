"""Пакетный прогон: все mp4 из папки Mendeley → JSON кадров (MediaPipe heavy). Пропускает уже обработанные."""
import sys, os, json, glob, time, cv2, mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
SRC = '/mnt/user-data/uploads/Downloads/Свой тренер/A Multi-View Raw Video Dataset of Seven Fitness Ex/Dataset Exercise Quality-wise'
OUT = '/home/claude/bench/mendeley'
part, nparts = int(sys.argv[1]), int(sys.argv[2])
def make():
    return vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path='/home/claude/models/heavy.task'), running_mode=vision.RunningMode.VIDEO,
        num_poses=2, min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.6))
while True:
    files = sorted(glob.glob(SRC + '/*/*/*.mp4'), key=lambda f: (0 if '/squat/' in f else 1, f))
    todo = [f for i, f in enumerate(files) if i % nparts == part and not os.path.exists(f"{OUT}/{os.path.basename(f)[:-4]}.json")]
    if not todo:
        if os.path.exists(OUT + '/STOP'): break
        time.sleep(20); continue
    for f in todo:
        name = os.path.basename(f)[:-4]
        try:
            det = make(); cap = cv2.VideoCapture(f); fps = cap.get(cv2.CAP_PROP_FPS) or 30
            frames, i = [], 0
            while True:
                ok, img = cap.read()
                if not ok: break
                h, w = img.shape[:2]
                if max(h, w) > 960:
                    s = 960 / max(h, w); img = cv2.resize(img, (int(w * s), int(h * s)))
                r = det.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(img, cv2.COLOR_BGR2RGB)), int(i * 1000 / fps))
                frames.append({'t': i / fps, 'aspect': w / h,
                    'poses': [[{'x': p.x, 'y': p.y, 'z': p.z, 'visibility': p.visibility} for p in L] for L in r.pose_landmarks],
                    'worlds': [[{'x': p.x, 'y': p.y, 'z': p.z} for p in L] for L in r.pose_world_landmarks]})
                i += 1
            det.close()
            json.dump({'src': name, 'fps': fps, 'frames': frames}, open(f"{OUT}/{name}.json.tmp", 'w'))
            os.rename(f"{OUT}/{name}.json.tmp", f"{OUT}/{name}.json")
            print(name, i, 'кадров', flush=True)
        except Exception as e:
            print('ОШИБКА', name, e, flush=True)
            open(f"{OUT}/{name}.json", 'w').write('{"error": true}')
