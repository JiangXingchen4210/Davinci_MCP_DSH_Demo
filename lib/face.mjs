/**
 * 面向对象调色：人脸/人体检测与跟踪（为「跟踪调色」打基础）。
 *
 * 为什么先做检测+跟踪：Resolve 的窗口调色要么手动画（脚本 API 没有 AddNode/跟踪器），
 * 要么走 Fusion 的 Tracker。可编程的第一步是**知道人脸在哪、怎么动**，
 * 然后用「窗口参数 + 关键帧时间点」去驱动（面板/后续 Fusion 模块消费）。
 *
 * 输出去重后的轨迹：同一张脸跨帧用 IoU 匹配，带 EMA 平滑与漂移统计，
 * 这样即使某些帧检测抖动，窗口也不会跟着抖。
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const BINARY = path.join(LIB_DIR, '.build', 'vision')

function runVision(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(BINARY, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim().slice(-500) || 'vision 失败'))
      try {
        resolve(JSON.parse(String(stdout)))
      } catch {
        reject(new Error(`vision 输出不是 JSON：${String(stdout).slice(0, 200)}`))
      }
    })
  })
}

export async function detectFaces(imagePath, options = {}) {
  const result = await runVision(['detect-face', '--in', imagePath, '--max', String(options.max ?? 8)])
  if (!result.ok) throw new Error(result.error ?? 'detect-face 失败')
  return result
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

const smooth = (previous, next, alpha = 0.35) => ({
  x: previous.x + (next.x - previous.x) * alpha,
  y: previous.y + (next.y - previous.y) * alpha,
  w: previous.w + (next.w - previous.w) * alpha,
  h: previous.h + (next.h - previous.h) * alpha,
})

/**
 * 跨帧跟踪人脸：返回 tracks [{id, frames:[{t, box, confidence, smoothed}], medianBox, driftPx, coverage}]
 * @param {Array<{t:number,path:string}>} frames 按时间排序的抽帧
 */
export async function trackFaces(frames, options = {}) {
  const alpha = Number(options.alpha) || 0.35
  const minIou = Number(options.minIou) || 0.12
  const tracks = []
  const perFrame = []
  for (const frame of frames) {
    let detected
    try {
      detected = await detectFaces(frame.path, options)
    } catch (error) {
      perFrame.push({ t: frame.t, path: frame.path, error: String(error.message ?? error), faces: [] })
      continue
    }
    const faces = detected.faces ?? []
    perFrame.push({ t: frame.t, path: frame.path, faces, width: detected.width, height: detected.height })
    for (const face of faces) {
      // 找 IoU 最大的已有轨迹
      let best = null
      let bestIou = 0
      for (const track of tracks) {
        const last = track.frames[track.frames.length - 1]
        if (!last) continue
        const score = iou(last.box, face)
        if (score > bestIou) {
          bestIou = score
          best = track
        }
      }
      if (best && bestIou >= minIou) {
        const smoothed = smooth(best.frames[best.frames.length - 1].smoothed, face, alpha)
        best.frames.push({ t: frame.t, box: face, confidence: face.confidence, smoothed })
      } else {
        tracks.push({
          id: tracks.length + 1,
          frames: [{ t: frame.t, box: face, confidence: face.confidence, smoothed: { x: face.x, y: face.y, w: face.w, h: face.h } }],
        })
      }
    }
  }

  // 统计每条轨迹：中位框、漂移、覆盖帧数
  const summarize = (track) => {
    const sorted = (key, values) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
    const medianBox = {
      x: Number(sorted('x', track.frames.map((frame) => frame.smoothed.x)).toFixed(1)),
      y: Number(sorted('y', track.frames.map((frame) => frame.smoothed.y)).toFixed(1)),
      w: Number(sorted('w', track.frames.map((frame) => frame.smoothed.w)).toFixed(1)),
      h: Number(sorted('h', track.frames.map((frame) => frame.smoothed.h)).toFixed(1)),
    }
    const centers = track.frames.map((frame) => ({ x: frame.smoothed.x + frame.smoothed.w / 2, y: frame.smoothed.y + frame.smoothed.h / 2 }))
    const driftPx = centers.length > 1
      ? Number(Math.hypot(centers[centers.length - 1].x - centers[0].x, centers[centers.length - 1].y - centers[0].y).toFixed(1))
      : 0
    return {
      id: track.id,
      frames: track.frames,
      frameCount: track.frames.length,
      coverage: Number((track.frames.length / Math.max(1, frames.length)).toFixed(2)),
      medianBox,
      driftPx,
      avgConfidence: Number((track.frames.reduce((acc, frame) => acc + frame.confidence, 0) / track.frames.length).toFixed(3)),
    }
  }

  // 合并被切碎的轨迹：后者起始帧的框与前者末帧框有重叠就并起来（人脸检测偶发漏帧很常见）
  let merged = tracks.map((track) => ({ ...track, frames: [...track.frames] }))
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < merged.length; i += 1) {
      for (let j = 0; j < merged.length; j += 1) {
        if (i === j) continue
        const a = merged[i]
        const b = merged[j]
        if (!a.frames.length || !b.frames.length) continue
        const aLast = a.frames[a.frames.length - 1]
        const bFirst = b.frames[0]
        if (bFirst.t <= aLast.t) continue
        if (iou(aLast.box, bFirst.box) >= 0.12) {
          a.frames.push(...b.frames)
          merged.splice(j, 1)
          changed = true
          break outer
        }
      }
    }
  }
  const summarized = merged.map(summarize).sort((a, b) => b.frameCount - a.frameCount)
  return {
    ok: true,
    frameCount: frames.length,
    trackCount: summarized.length,
    tracks: summarized,
    primary: summarized[0] ?? null,
    perFrame,
  }
}

/**
 * 跟踪结果 → 调色窗口建议（给面板/Fusion 用；本插件不直接写窗口 keyframe）。
 */
export function planFaceGrade(track, options = {}) {
  if (!track?.medianBox) return { ok: false, reason: '没有可用的人脸轨迹' }
  const pad = Number(options.pad) || 0.35
  const box = track.medianBox
  const windowRect = {
    x: Math.max(0, Math.round(box.x - box.w * pad)),
    y: Math.max(0, Math.round(box.y - box.h * pad)),
    w: Math.round(box.w * (1 + pad * 2)),
    h: Math.round(box.h * (1 + pad * 2)),
  }
  const moving = (track.driftPx ?? 0) > Math.max(12, box.w * 0.25)
  return {
    ok: true,
    windowRect,
    feather: Number((Math.min(windowRect.w, windowRect.h) * 0.25).toFixed(1)),
    mode: moving ? 'tracked-window' : 'static-window',
    confidence: track.avgConfidence,
    coverage: track.coverage,
    keyframeTimes: track.frames.map((frame) => ({ t: Number(frame.t.toFixed(2)), x: Math.round(frame.smoothed.x), y: Math.round(frame.smoothed.y), w: Math.round(frame.smoothed.w), h: Math.round(frame.smoothed.h) })),
    notes: moving
      ? [`人脸在 ${track.frameCount} 帧里移动了 ${track.driftPx}px → 需要逐帧关键帧（静态窗口会有明显漏边）`]
      : ['人脸位置基本稳定 → 静态窗口 + 羽化即可'],
  }
}
