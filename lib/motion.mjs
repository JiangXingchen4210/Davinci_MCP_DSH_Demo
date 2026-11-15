/**
 * 运动分析 —— 找「动作停稳点」和「动作起势点」，用来避免「人物走到一半就切」。
 *
 * 做法：低分辨率灰度帧序列（ffmpeg rawvideo，必须走 Buffer），逐帧平均绝对差 = 运动能量曲线；
 *   · valley（谷值）= 动作停稳 / 静止的时刻 → 安全的切点
 *   · peak（峰值）  = 动作最剧烈处 → 绝不能切
 * 另外用「能量低于阈值持续 ≥ minStillSec」判定静止段，配合台词边界就能做出「等人物停稳再切」的剪辑。
 */

import { execFile } from 'node:child_process'

const SAMPLE_FPS = 6
const WIDTH = 96

function runBinary(args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(-500) || 'ffmpeg 失败'))
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
    })
  })
}

/** 抽一段低分辨率灰度帧（fps 可调），返回 {width,height,fps,frames:Buffer[]}。 */
export async function sampleGrayFrames(filePath, options = {}) {
  const fps = Math.max(1, Math.min(30, Number(options.fps) || SAMPLE_FPS))
  const startSec = Number.isFinite(options.startSec) ? Math.max(0, Number(options.startSec)) : 0
  const durationSec = Number.isFinite(options.durationSec) ? Math.max(0.1, Number(options.durationSec)) : null
  const args = ['-v', 'error']
  if (startSec > 0) args.push('-ss', String(startSec.toFixed(3)))
  args.push('-i', filePath)
  if (durationSec) args.push('-t', String(durationSec.toFixed(3)))
  args.push(
    '-vf', `fps=${fps},scale=${WIDTH}:-2,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  )
  const buffer = await runBinary(args)
  const frameBytes = Math.floor(buffer.length / (WIDTH * 3)) // 先粗估，下面按实际高度修正
  // 高度 = (总字节 / (宽度 * 帧数)) 不好反推，改用固定宽高比推断：见 decodeGrayFrames
  return { raw: buffer, width: WIDTH, fps, startSec, durationSec }
}

/** 解析 rawvideo 灰度缓冲：高度由 ffmpeg 输出尺寸决定，这里用宽高比估算不靠谱 → 直接返回按行宽切分的帧。 */
export function splitFrames(buffer, width, height) {
  const frameSize = width * height
  if (!(frameSize > 0)) throw new Error('splitFrames 需要正的行宽/行高')
  const count = Math.floor(buffer.length / frameSize)
  const frames = []
  for (let index = 0; index < count; index += 1) {
    frames.push(buffer.subarray(index * frameSize, (index + 1) * frameSize))
  }
  return frames
}

/** 用 ffprobe 拿视频尺寸，然后按比例算出低分辨率高度。 */
export async function probeVideoSize(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath], (error, stdout) => {
      if (error) return reject(new Error('ffprobe 失败'))
      const [width, height] = String(stdout).trim().split(',').map(Number)
      if (!(width > 0 && height > 0)) return reject(new Error('读不到视频尺寸'))
      resolve({ width, height })
    })
  })
}

/**
 * 运动曲线：{samples:[{t,energy}], mean, max, stillThreshold, stills:[{start,end}], valleys:[t…], peaks:[t…]}
 * energy 归一化到 0–1（按该片段的 95 分位缩放，避免不同曝光/噪声导致阈值漂移）。
 */
export function computeMotionCurve(frames, fps, options = {}) {
  if (frames.length < 2) return { samples: [], mean: 0, max: 0, stillThreshold: 0, stills: [], valleys: [], peaks: [] }
  const energies = []
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1]
    const current = frames[index]
    let sum = 0
    const length = Math.min(previous.length, current.length)
    for (let offset = 0; offset < length; offset += 1) {
      sum += Math.abs(current[offset] - previous[offset])
    }
    energies.push(sum / Math.max(1, length) / 255)
  }
  const sorted = [...energies].sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 1
  const scale = Math.max(1e-4, p95)
  const normalised = energies.map((value) => Math.min(1, value / scale))
  const samples = normalised.map((energy, index) => ({ t: Number(((index + 1) / fps).toFixed(3)), energy: Number(energy.toFixed(4)) }))
  const mean = Number((samples.reduce((acc, sample) => acc + sample.energy, 0) / samples.length).toFixed(4))
  // 静止阈值：相对曲线自身的低分位（噪声底）
  const low = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.2))] || 0
  const stillThreshold = Number(Math.max(low / scale, 0.06).toFixed(4))

  const stills = []
  let runStart = null
  samples.forEach((sample, index) => {
    if (sample.energy <= stillThreshold) {
      if (runStart === null) runStart = index
    } else if (runStart !== null) {
      stills.push({ start: samples[runStart].t, end: samples[index].t })
      runStart = null
    }
  })
  if (runStart !== null) stills.push({ start: samples[runStart].t, end: samples[samples.length - 1].t })

  const valleys = []
  const peaks = []
  for (let index = 1; index < samples.length - 1; index += 1) {
    const prev = samples[index - 1].energy
    const curr = samples[index].energy
    const next = samples[index + 1].energy
    if (curr <= prev && curr <= next && curr <= stillThreshold * 1.5) valleys.push(samples[index].t)
    if (curr >= prev && curr >= next && curr >= Math.max(0.5, mean)) peaks.push(samples[index].t)
  }

  return {
    samples,
    mean,
    max: Number(Math.max(...samples.map((sample) => sample.energy)).toFixed(4)),
    stillThreshold,
    stills: stills.map((still) => ({ start: Number(still.start.toFixed(3)), end: Number(still.end.toFixed(3)), duration: Number((still.end - still.start).toFixed(3)) })),
    valleys: valleys.map((time) => Number(time.toFixed(3))),
    peaks: peaks.map((time) => Number(time.toFixed(3))),
  }
}

/** 分析整段素材（默认整片；给 startSec/durationSec 就只分析一段）。 */
export async function analyseClipMotion(filePath, options = {}) {
  const { width, height } = await probeVideoSize(filePath)
  const fps = Math.max(1, Math.min(30, Number(options.fps) || SAMPLE_FPS))
  const lowHeight = Math.max(8, Math.round((height / width) * WIDTH))
  const samples = await sampleGrayFrames(filePath, { ...options, fps })
  const frames = splitFrames(samples.raw, WIDTH, lowHeight)
  const curve = computeMotionCurve(frames, fps, options)
  return { ...curve, width: WIDTH, height: lowHeight, fps, frames: frames.length }
}

/**
 * 在 [from, to] 里挑一个「最安全」的切点：优先落在静止段/谷值，离峰越远越好。
 * 返回 {t, kind:'still'|'valley'|'best-effort', energy, distance}
 */
export function pickSafeCut(curve, from, to, options = {}) {
  const preferStill = options.preferStill !== false
  const candidates = []
  if (preferStill && Array.isArray(curve.stills)) {
    for (const still of curve.stills) {
      const midpoint = (still.start + still.end) / 2
      if (midpoint >= from && midpoint <= to) {
        candidates.push({ t: Number(midpoint.toFixed(3)), kind: 'still', energy: 0, distance: Number(Math.abs(midpoint - from).toFixed(3)) })
      }
    }
  }
  if (Array.isArray(curve.samples)) {
    for (const sample of curve.samples) {
      if (sample.t < from || sample.t > to) continue
      candidates.push({ t: sample.t, kind: sample.energy <= curve.stillThreshold ? 'valley' : 'best-effort', energy: sample.energy, distance: Number(Math.min(sample.t - from, to - sample.t).toFixed(3)) })
    }
  }
  if (candidates.length === 0) return { t: Number(((from + to) / 2).toFixed(3)), kind: 'best-effort', energy: null, distance: 0 }
  // 排序：静止/谷优先，其次能量低，其次靠近目标区间中点
  const rank = { still: 0, valley: 1, 'best-effort': 2 }
  candidates.sort((a, b) => {
    const rankDiff = rank[a.kind] - rank[b.kind]
    if (rankDiff !== 0) return rankDiff
    if (a.energy !== b.energy) return a.energy - b.energy
    return a.distance - b.distance
  })
  return candidates[0]
}
