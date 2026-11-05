"""Прогон видео через MediaPipe Pose (heavy) → JSON с кадрами для движка «Своего тренера»."""
import sys, json, cv2, mediapipe as mp
from mediapipe.tasks.python import vision, BaseOptions
src, out = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else '/home/claude/models/heavy.task'
opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=model),
    running_mode=vision.RunningMode.VIDEO, num_poses=2,
    min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.6)
det = vision.PoseLandmarker.create_from_options(opts)
cap = cv2.VideoCapture(src); fps = cap.get(cv2.CAP_PROP_FPS) or 30
frames, i = [], 0
while True:
    ok, img = cap.read()
    if not ok: break
    h, w = img.shape[:2]
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    t = i / fps
    r = det.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int(t * 1000))
    poses = [[{'x': p.x, 'y': p.y, 'z': p.z, 'visibility': p.visibility} for p in L] for L in r.pose_landmarks]
    worlds = [[{'x': p.x, 'y': p.y, 'z': p.z} for p in L] for L in r.pose_world_landmarks]
    frames.append({'t': t, 'poses': poses, 'worlds': worlds, 'aspect': w / h})
    i += 1
json.dump({'src': src, 'fps': fps, 'frames': frames}, open(out, 'w'))
print(f'{src}: {i} кадров, человек найден в {sum(1 for f in frames if f["poses"])} кадрах')
