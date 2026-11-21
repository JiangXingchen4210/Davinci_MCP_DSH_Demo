#!/usr/bin/env python3
"""RVM / Depth Anything v2 ONNX sidecar for davinci-console-demo.

Usage:
  video_matting.py rvm --frames DIR --boxes boxes.json --out DIR --model model.onnx [--downsample 0.375] [--refine]
  video_matting.py depth --frames DIR --out DIR --model model.onnx
"""
import argparse, json, os, sys
import numpy as np
import cv2
import onnxruntime as ort


def read_frames(directory):
    names = sorted(n for n in os.listdir(directory) if n.lower().endswith(('.png', '.jpg', '.jpeg')))
    if not names:
        raise SystemExit(f'no frames in {directory}')
    return [os.path.join(directory, n) for n in names]


def load_rgb(path):
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f'read failed: {path}')
    return img


def guided_filter(guide, src, radius=8, eps=1e-4):
    guide = guide.astype(np.float32) / 255.0
    src = src.astype(np.float32)
    ksize = (2 * radius + 1, 2 * radius + 1)
    mean_i = cv2.blur(guide, ksize)
    mean_p = cv2.blur(src, ksize)
    corr_i = cv2.blur(guide * guide, ksize)
    corr_ip = cv2.blur(guide * src, ksize)
    var_i = corr_i - mean_i * mean_i
    cov_ip = corr_ip - mean_i * mean_p
    a = cov_ip / (var_i + eps)
    b = mean_p - a * mean_i
    mean_a = cv2.blur(a, ksize)
    mean_b = cv2.blur(b, ksize)
    return np.clip(mean_a * guide + mean_b, 0, 1)


def pad32(img, value=0):
    h, w = img.shape[:2]
    ph, pw = (32 - h % 32) % 32, (32 - w % 32) % 32
    if ph or pw:
        img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_CONSTANT, value=value)
    return img, (h, w)


def run_rvm(args):
    os.makedirs(args.out, exist_ok=True)
    frames = read_frames(args.frames)
    boxes = None
    if args.boxes and os.path.exists(args.boxes):
        boxes = json.load(open(args.boxes))
    session = ort.InferenceSession(args.model, providers=['CPUExecutionProvider'])
    inputs = {i.name: i for i in session.get_inputs()}
    outputs = [o.name for o in session.get_outputs()]
    if 'src' not in inputs:
        raise SystemExit(f'RVM model inputs unexpected: {list(inputs)}')
    rec_names = sorted([n for n in inputs if n.startswith('r') and n.endswith('i')], key=lambda n: int(''.join(c for c in n if c.isdigit()) or 0))
    rec = {name: np.zeros([1, 1, 1, 1], np.float32) for name in rec_names}
    has_ratio = 'downsample_ratio' in inputs
    warmup = max(0, int(args.warmup))
    if warmup >= len(frames):
        raise SystemExit(f'warmup {warmup} >= frames {len(frames)}')
    prev_output_alpha = None
    iou_values = []
    written = 0

    for idx, frame_path in enumerate(frames):
        full = load_rgb(frame_path)
        # 固定整帧输入：RVM 的 recurrent state 形状不变；跟踪只用来给 mask 加空间门限，
        # 不用逐帧裁切（裁切边界会在腿上留下水平接缝）。
        work, (oh, ow) = pad32(full)
        src = cv2.cvtColor(work, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        src = np.transpose(src, (2, 0, 1))[None]
        feed = {'src': src}
        feed.update(rec)
        if has_ratio:
            feed['downsample_ratio'] = np.array([args.downsample], np.float32)
        result = session.run(None, feed)
        named = dict(zip(outputs, result))
        pha = named.get('pha'); fgr = named.get('fgr')
        if pha is None:
            raise SystemExit(f'RVM outputs missing pha: {outputs}')
        alpha = pha[0, 0, :oh, :ow]
        fg = fgr[0, :, :oh, :ow].transpose(1, 2, 0)
        if args.refine:
            gray = cv2.cvtColor(full, cv2.COLOR_BGR2GRAY)
            alpha = guided_filter(gray, alpha, radius=8, eps=1e-4)
        # 跟踪门限：只保留跟踪框（含 padding）内的 alpha，其余置 0；
        # 这是“跟踪作用于 mask”，但不是多目标实例分割。
        if boxes:
            box = boxes[idx] if idx < len(boxes) else boxes[-1]
            x, y, w, h = [int(round(box[k])) for k in ('x', 'y', 'w', 'h')]
            pad = int(max(w, h) * float(args.gate_padding))
            x0, y0 = max(0, x - pad), max(0, y - pad)
            x1, y1 = min(full.shape[1], x + w + pad), min(full.shape[0], y + h + pad)
            gate = np.zeros_like(alpha, dtype=np.float32)
            gate[y0:y1, x0:x1] = 1.0
            gate = cv2.GaussianBlur(gate, (0, 0), sigmaX=16)
            alpha = alpha * gate
        # 时域一致性：只比较正式输出帧之间的相邻 alpha IoU；warmup 帧只喂状态，
        # 不进入统计（否则 first3 会被 warmup 内部跳变污染）。
        if idx < warmup:
            for name in rec_names:
                out_name = name[:-1] + 'o'
                if out_name in named:
                    rec[name] = named[out_name]
            continue
        rgba = np.zeros((full.shape[0], full.shape[1], 4), np.uint16)
        rgba[..., :3] = (np.clip(fg[:, :, ::-1], 0, 1) * 255.0).astype(np.float32).astype(np.uint16) * 257
        rgba[..., 3] = np.clip(alpha, 0, 1).astype(np.float32) * 65535
        out = os.path.join(args.out, f'frame-{written:04d}.png')
        if not cv2.imwrite(out, rgba):
            raise RuntimeError(f'write failed: {out}')
        if prev_output_alpha is not None:
            a = prev_output_alpha > 0.5
            b = alpha > 0.5
            union = int(np.logical_or(a, b).sum())
            inter = int(np.logical_and(a, b).sum())
            if union > 0:
                iou_values.append(inter / union)
        prev_output_alpha = alpha
        written += 1
        for name in rec_names:
            out_name = name[:-1] + 'o'
            if out_name in named:
                rec[name] = named[out_name]
    stats = {
        'count': len(iou_values),
        'mean': float(sum(iou_values) / len(iou_values)) if iou_values else None,
        'min': float(min(iou_values)) if iou_values else None,
        'first3': [round(v, 4) for v in iou_values[:3]],
        'first3Mean': float(sum(iou_values[:3]) / len(iou_values[:3])) if iou_values[:3] else None,
        'lowFrames': [{'index': i, 'iou': round(v, 4)} for i, v in enumerate(iou_values) if v < 0.95][:20],
    }
    print(json.dumps({'ok': True, 'frames': written, 'warmup': warmup, 'out': args.out, 'temporalIoU': stats}))


def run_occlude(args):
    os.makedirs(args.out, exist_ok=True)
    alpha_files = read_frames(args.alpha)
    target_depth = read_frames(args.target_depth)
    fg_depth = read_frames(args.fg_depth)
    if not (len(alpha_files) == len(target_depth) == len(fg_depth)):
        raise SystemExit(f'frame count mismatch: alpha={len(alpha_files)} targetDepth={len(target_depth)} fgDepth={len(fg_depth)}')
    total = 0
    for idx, (a_path, td_path, fd_path) in enumerate(zip(alpha_files, target_depth, fg_depth)):
        rgba = cv2.imread(a_path, cv2.IMREAD_UNCHANGED)
        if rgba is None or rgba.shape[2] != 4:
            raise SystemExit(f'alpha is not RGBA: {a_path}')
        scale = 65535.0 if rgba.dtype == np.uint16 else 255.0
        alpha = rgba[..., 3].astype(np.float32) / scale
        td = cv2.imread(td_path, cv2.IMREAD_UNCHANGED).astype(np.float32)
        fd = cv2.imread(fd_path, cv2.IMREAD_UNCHANGED).astype(np.float32)
        td_scale = 65535.0 if td.max() > 255 else 255.0
        fd_scale = 65535.0 if fd.max() > 255 else 255.0
        td = td / td_scale
        fd = fd / fd_scale
        td = cv2.resize(td, (alpha.shape[1], alpha.shape[0]), interpolation=cv2.INTER_LINEAR)
        fd = cv2.resize(fd, (alpha.shape[1], alpha.shape[0]), interpolation=cv2.INTER_LINEAR)
        td = cv2.GaussianBlur(td, (0, 0), 3)
        fd = cv2.GaussianBlur(fd, (0, 0), 3)
        # 目标画面里比前景更靠近相机的像素（如近处叶片）应遮住人物
        occ = ((td > fd + 0.08) & (alpha > 0.02)).astype(np.float32)
        occ = cv2.GaussianBlur(occ, (0, 0), 4)
        a2 = alpha * (1.0 - np.clip(occ * 2.0, 0, 1))
        total += int(np.sum((a2 < alpha - 0.02)))
        out = rgba.copy()
        out[..., 3] = (np.clip(a2, 0, 1) * scale).astype(np.uint16 if rgba.dtype == np.uint16 else np.uint8)
        out_path = os.path.join(args.out, f'frame-{idx:04d}.png')
        if not cv2.imwrite(out_path, out):
            raise RuntimeError(f'write failed: {out_path}')
    print(json.dumps({'ok': True, 'frames': len(alpha_files), 'occludedPixels': total, 'out': args.out}))


def run_depth(args):
    os.makedirs(args.out, exist_ok=True)
    frames = read_frames(args.frames)
    session = ort.InferenceSession(args.model, providers=['CPUExecutionProvider'])
    inp = session.get_inputs()[0]
    out = session.get_outputs()[0]
    mean = np.array([0.485, 0.456, 0.406], np.float32)
    std = np.array([0.229, 0.224, 0.225], np.float32)
    for idx, frame_path in enumerate(frames):
        img = load_rgb(frame_path)
        h, w = img.shape[:2]
        # 保持长边 518，保证足够细节；模型全卷积，尺寸可变
        scale = 518.0 / max(h, w)
        nh, nw = max(32, int(round(h * scale / 32)) * 32), max(32, int(round(w * scale / 32)) * 32)
        resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        rgb = (rgb - mean) / std
        tensor = np.transpose(rgb, (2, 0, 1))[None]
        result = session.run(None, {inp.name: tensor})
        depth = np.squeeze(result[0])
        if depth.ndim == 3:
            depth = depth[0]
        depth = cv2.resize(depth, (w, h), interpolation=cv2.INTER_CUBIC)
        d = depth.astype(np.float32)
        lo, hi = np.percentile(d, 1), np.percentile(d, 99)
        d = np.clip((d - lo) / max(1e-6, hi - lo), 0, 1)
        # 深度图：亮=近（Depth Anything 输出越大越近）
        png = (d * 65535).astype(np.uint16)
        out_path = os.path.join(args.out, f'frame-{idx:04d}.png')
        if not cv2.imwrite(out_path, png):
            raise RuntimeError(f'write failed: {out_path}')
    print(json.dumps({'ok': True, 'frames': len(frames), 'out': args.out}))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='mode', required=True)
    r = sub.add_parser('rvm')
    r.add_argument('--frames', required=True)
    r.add_argument('--boxes')
    r.add_argument('--out', required=True)
    r.add_argument('--model', required=True)
    r.add_argument('--downsample', type=float, default=0.375)
    r.add_argument('--refine', action='store_true')
    r.add_argument('--warmup', type=int, default=0)
    r.add_argument('--gate-padding', type=float, default=0.15)
    d = sub.add_parser('depth')
    d.add_argument('--frames', required=True)
    d.add_argument('--out', required=True)
    d.add_argument('--model', required=True)
    o = sub.add_parser('occlude')
    o.add_argument('--alpha', required=True)
    o.add_argument('--target-depth', required=True)
    o.add_argument('--fg-depth', required=True)
    o.add_argument('--out', required=True)
    args = ap.parse_args()
    if args.mode == 'rvm':
        run_rvm(args)
    elif args.mode == 'depth':
        run_depth(args)
    else:
        run_occlude(args)


if __name__ == '__main__':
    main()
