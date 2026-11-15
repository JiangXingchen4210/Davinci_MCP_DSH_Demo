"""擦除资产生成：大块=前后帧配准中位数干净板；小块=时域邻帧补丁；输出 RGBA 序列供 Fusion alpha 合成。"""
import subprocess, os, sys, json, glob
import numpy as np, cv2

cfg = json.loads(sys.stdin.read())
src, inSec, outSec = cfg['src'], float(cfg['inSec']), float(cfg['outSec'])
W, H, FPS = int(cfg.get('width', 1920)), int(cfg.get('height', 1012)), int(cfg.get('fps', 24))
size, method, outDir = cfg.get('size', 'large'), cfg.get('method', 'plate'), cfg['outDir']
protect = cfg.get('protectBox')
box = cfg.get('box') or {'x':0,'y':0,'w':int(W*0.3),'h':int(H*0.8)}
vision = cfg['vision']
os.makedirs(outDir + '/frames', exist_ok=True); os.makedirs(outDir + '/rgba', exist_ok=True)
os.makedirs(outDir + '/cand', exist_ok=True)
N = int(round((outSec - inSec) * FPS))
def ff(*a): subprocess.run(['ffmpeg','-v','error',*a,'-y'], check=True)
def grab(t, path):
    ff('-ss', f'{t:.3f}', '-i', src, '-frames:v', '1', '-vf', f'scale={W}:{H}', path)
def person_mask(path):
    out = path + '.pm.png'
    subprocess.run([vision, 'person-mask', '--in', path, '--out', out], check=True, capture_output=True)
    return cv2.resize(cv2.imread(out, 0), (W, H), interpolation=cv2.INTER_LINEAR)

# 1) 用帧
inc = f'{outDir}/frames/%04d.jpg'
ff('-ss', f'{inSec:.3f}', '-t', f'{(outSec-inSec):.3f}', '-i', src, '-vf', f'scale={W}:{H}', inc.replace('%04d','%04d'))
frames = sorted(glob.glob(outDir + '/frames/*.jpg'))[:N]

# 2) 干净候选：整条素材每 0.25s 一帧（含剪辑点前后）
dur = float(subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',src],capture_output=True,text=True).stdout.strip())
cands = []
for t in np.arange(0.04, dur, 0.25):
    p = f'{outDir}/cand/{t:.2f}.jpg'
    grab(float(t), p)
    cands.append((p, person_mask(p)))
print('candidates', len(cands), flush=True)

# 3) ECC 配准到参考帧后取逐像素中位数（只采纳「该像素没被目标挡住」的样本）
ref = cv2.cvtColor(cv2.imread(cands[0][0]), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
def align(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5)
        _, warp = cv2.findTransformECC(ref, g, warp, cv2.MOTION_AFFINE, crit, None, 5)
    except cv2.error:
        pass
    return cv2.warpAffine(img, warp, (W, H), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)

if method == 'fullframe' or (size == 'large' and method == 'plate'):
    acc = np.zeros((H, W, 3), np.float32); cnt = np.zeros((H, W), np.float32)
    for p, m in cands:
        img = align(cv2.imread(p)).astype(np.float32)
        ok = (m < 60)
        acc[ok] += img[ok]; cnt[ok] += 1
    have = cnt > 0
    plate = np.zeros_like(acc)
    plate[have] = acc[have] / cnt[have, None]
    hole = (~have).astype(np.uint8) * 255
    if hole.any():
        filled = cv2.inpaint(plate.astype(np.uint8), cv2.dilate(hole, np.ones((9,9),np.uint8)), 7, cv2.INPAINT_TELEA)
        plate[~have] = filled[~have].astype(np.float32)
    plate = np.clip(plate, 0, 255).astype(np.uint8)
else:
    # 时域中位数（±0.5s）作为补丁底板：小物体/慢速大物体都适用
    seq = [cv2.imread(f).astype(np.float32) for f in frames]
    k = int(0.5 * FPS)
    plate = None
    if seq:
        thumbs = []
        for i in range(len(seq)):
            lo, hi = max(0, i-k), min(len(seq)-1, i+k)
            thumbs.append(np.median(np.stack(seq[lo:hi+1]), axis=0))
        # 统一用首帧中位数作底板（后续 alpha 逐帧限制替换区域）
        plate = np.clip(thumbs[0] if thumbs else seq[0], 0, 255).astype(np.uint8)
if plate is None:
    plate = np.zeros((H, W, 3), np.uint8)
cv2.imwrite(outDir + '/plate.png', plate)

# 3.5) 板→当前帧配准 + 曝光匹配（消除闪动和山脊错位）
plate_gray_ref = cv2.cvtColor(plate, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
def plate_for_frame(f):
    img = cv2.imread(f)
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 50, 1e-5)
        _, warp = cv2.findTransformECC(plate_gray_ref, g, warp, cv2.MOTION_AFFINE, crit, None, 5)
        aligned = cv2.warpAffine(plate, warp, (W, H), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    except cv2.error:
        aligned = plate.copy()
    # 曝光匹配：用画面整体均值比例校正（防止逐帧忽明忽暗）
    a = aligned.astype(np.float32); f32 = img.astype(np.float32)
    mg, mf = float(a.mean()), float(f32.mean())
    if mg > 1 and 0.5 < mf / mg < 2.0:
        a = np.clip(a * (mf / mg), 0, 255)
    return a.astype(np.uint8)

# 3.6) 全帧比对：板配准到当前帧 → 全帧 diff → 扣除保护框：大物体=人物分割取「最暗的那个人」；小物体=与板差异
os.makedirs(outDir + '/matte', exist_ok=True)
for i, f in enumerate(frames):
    img = cv2.imread(f)
    if method == 'fullframe':
        frame_plate = plate_for_frame(f)
        d = np.abs(img.astype(np.float32) - frame_plate.astype(np.float32)).max(axis=2)
        matte = (d > 20).astype(np.uint8) * 255
        matte = cv2.dilate(matte, np.ones((9,9), np.uint8), iterations=2)
        matte = cv2.GaussianBlur(matte, (25,25), 0)
        if protect:
            px, py, pw, ph = int(protect['x']), int(protect['y']), int(protect['w']), int(protect['h'])
            guard = np.zeros((H, W), np.uint8); guard[py:py+ph, px:px+pw] = 255
            guard = cv2.GaussianBlur(guard, (31,31), 0)
            matte = (matte.astype(np.float32) * (1 - guard.astype(np.float32) / 255.0)).astype(np.uint8)
    elif size == 'large':
        m = person_mask(f)
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        n, lab, stats, cent = cv2.connectedComponentsWithStats((m > 127).astype(np.uint8), 8)
        best = None
        for j in range(1, n):
            if stats[j, cv2.CC_STAT_AREA] < H*W*0.008: continue
            if cent[j][0] > W*0.62: continue
            mean = float(g[lab == j].mean())
            if best is None or mean < best[0]: best = (mean, j)
        matte = ((lab == best[1]) * 255).astype(np.uint8) if best else np.zeros((H, W), np.uint8)
        matte = cv2.dilate(matte, np.ones((25,25), np.uint8), iterations=1)
        matte = cv2.GaussianBlur(matte, (41,41), 0)
    else:
        diff = np.abs(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32) - cv2.cvtColor(plate, cv2.COLOR_BGR2GRAY).astype(np.float32))
        matte = (diff > 18).astype(np.uint8) * 255
        x, y, w, h = int(box['x']), int(box['y']), int(box['w']), int(box['h'])
        region = np.zeros((H, W), np.uint8); region[y:y+h, x:x+w] = 255
        matte = cv2.bitwise_and(matte, region)
        matte = cv2.dilate(matte, np.ones((9,9), np.uint8), iterations=2)
        matte = cv2.GaussianBlur(matte, (21,21), 0)
    cv2.imwrite(f"{outDir}/matte/{i+1:04d}.png", matte)

    cv2.imwrite(f"{outDir}/rgba/{i+1:04d}.png", np.dstack([frame_plate, matte]))
print(json.dumps({'ok': True, 'frames': len(frames), 'plate': outDir + '/plate.png', 'rgba': outDir + '/rgba/0001.png'}))
