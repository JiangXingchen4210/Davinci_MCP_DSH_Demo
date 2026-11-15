/**
 * 调色护栏（Grade Guard）—— 用「帧统计」管住 Vibe / 三级节点的力度。
 *
 * 这次实测暴露的问题：满强度赛博朋克把夜戏的黑位压爆，出现黑色断层、整屏发蓝。
 * 于是把「力度」变成可测量、可拒绝的约束，而不是靠感觉：
 *   · blackPct / nearBlackPct —— 近黑像素占比，涨幅超过阈值 → 黑色断层
 *   · shadowBlueCast         —— 暗部蓝偏（B-R，0–255），过大 → 「整屏发蓝」
 *   · hueShift               —— 全局色相偏移，过大 → 偏色跑偏
 *   · satDelta               —— 饱和度变化，过大 → 过艳
 *   · whitePct               —— 高光溢出
 * 超限时给出 {ok:false, violations, recommendedStrength}，调用方自动降强度重试。
 *
 * 只用 ffmpeg 解码（二进制必须走 Buffer，否则 utf8 会毁掉像素数据）。
 */

import { execFile } from 'node:child_process'

const DEFAULT_WIDTH = 320
const LIMITS = Object.freeze({
  blackPctDelta: 2.0, // 百分点
  nearBlackPctDelta: 3.5,
  shadowBlueCastDeltaMax: 8, // 暗部蓝偏的「增量」（0–255 通道差），不是绝对值——素材本身就可能偏蓝
  hueShiftMaxDeg: 14,
  satDeltaMax: 0.12,
  whitePctDelta: 1.5,
})

function runBinary(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(-500) || 'ffmpeg 失败'))
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
    })
  })
}

export async function decodeSmall(imagePath, width = DEFAULT_WIDTH) {
  const buffer = await runBinary([
    '-v', 'error', '-i', imagePath, '-frames:v', '1',
    '-vf', `scale=${width}:-2,format=rgb24`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ])
  const rows = Math.floor(buffer.length / (width * 3))
  if (rows < 8) throw new Error(`解码结果太小：${buffer.length} 字节`)
  return { width, height: rows, data: buffer.subarray(0, rows * width * 3) }
}

function hueDegrees(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return null
  let hue
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  hue *= 60
  if (hue < 0) hue += 360
  return hue
}

/** 逐像素统计（一次遍历算完）。 */
export function measureRgb(buffer, width, height) {
  let count = 0
  let black = 0
  let nearBlack = 0
  let white = 0
  let lumaSum = 0
  let satSum = 0
  let shadowB = 0
  let shadowR = 0
  let shadowCount = 0
  const hueBins = new Array(36).fill(0)
  let hueWeighted = 0
  let hueWeight = 0
  for (let i = 0; i < width * height; i += 1) {
    const r = buffer[i * 3] / 255
    const g = buffer[i * 3 + 1] / 255
    const b = buffer[i * 3 + 2] / 255
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max <= 0 ? 0 : (max - min) / max
    lumaSum += luma
    satSum += sat
    if (luma < 0.03) black += 1
    if (luma < 0.06) nearBlack += 1
    if (luma > 0.98) white += 1
    // 暗部统计要排除「高饱和深蓝/深红」：否则纯蓝色块（luma≈0.07）会被当成暗部，
    // 蓝偏指标直接爆表（实测合成图 delta 235）。黑平衡看的是低饱和阴影。
    if (luma < 0.2 && sat < 0.55) {
      shadowR += r
      shadowB += b
      shadowCount += 1
    }
    const hue = hueDegrees(r, g, b)
    if (hue !== null && sat >= 0.12) {
      hueBins[Math.min(35, Math.floor(hue / 10))] += 1
      hueWeighted += hue * sat
      hueWeight += sat
    }
    count += 1
  }
  const pct = (value) => (count === 0 ? 0 : Number(((value / count) * 100).toFixed(2)))
  // 主导色相：取加权平均（只统计有饱和的像素）
  const meanHue = hueWeight > 0 ? Number((hueWeighted / hueWeight).toFixed(1)) : null
  return {
    width,
    height,
    pixels: count,
    lumaMean: Number((lumaSum / Math.max(1, count)).toFixed(4)),
    satMean: Number((satSum / Math.max(1, count)).toFixed(4)),
    blackPct: pct(black),
    nearBlackPct: pct(nearBlack),
    whitePct: pct(white),
    shadowBlueCast: shadowCount === 0 ? 0 : Number((((shadowB - shadowR) / shadowCount) * 255).toFixed(2)),
    shadowPct: pct(shadowCount),
    meanHue,
    hueHistogram: hueBins,
  }
}

export async function measureFrame(imagePath, options = {}) {
  const decoded = await decodeSmall(imagePath, options.width ?? DEFAULT_WIDTH)
  return measureRgb(decoded.data, decoded.width, decoded.height)
}

function hueDistance(a, b) {
  if (a == null || b == null) return 0
  const diff = Math.abs(a - b) % 360
  return diff > 180 ? 360 - diff : diff
}

/**
 * 前后对比 → 是否越过护栏。`recommendedStrength` 按最严重的越界比例给出（0.05–1）。
 */
export function evaluate(before, after, limits = {}) {
  const thresholds = { ...LIMITS, ...limits }
  const violations = []
  const deltaBlack = Number((after.blackPct - before.blackPct).toFixed(2))
  const deltaNearBlack = Number((after.nearBlackPct - before.nearBlackPct).toFixed(2))
  const deltaWhite = Number((after.whitePct - before.whitePct).toFixed(2))
  const satDelta = Number(Math.abs(after.satMean - before.satMean).toFixed(4))
  const hueShift = Number(hueDistance(before.meanHue, after.meanHue).toFixed(1))
  const shadowBlueCast = Number(after.shadowBlueCast.toFixed(2))
  const shadowBlueCastDelta = Number((after.shadowBlueCast - before.shadowBlueCast).toFixed(2))

  if (deltaBlack > thresholds.blackPctDelta) {
    violations.push({ id: 'black-clip', severity: 'high', actual: deltaBlack, limit: thresholds.blackPctDelta, detail: `近黑像素增加 ${deltaBlack}pp（上限 ${thresholds.blackPctDelta}pp）→ 黑色断层` })
  }
  if (deltaNearBlack > thresholds.nearBlackPctDelta) {
    violations.push({ id: 'near-black-clip', severity: 'high', actual: deltaNearBlack, limit: thresholds.nearBlackPctDelta, detail: `暗部压死 ${deltaNearBlack}pp（上限 ${thresholds.nearBlackPctDelta}pp）` })
  }
  // 暗部样本太少时这个指标不可靠（例如白天/高调素材），不判违规
  const shadowUsable = (before.shadowPct ?? 100) >= 1 && (after.shadowPct ?? 100) >= 1
  if (shadowUsable && shadowBlueCastDelta > thresholds.shadowBlueCastDeltaMax) {
    violations.push({ id: 'shadow-blue-cast', severity: 'medium', actual: shadowBlueCastDelta, limit: thresholds.shadowBlueCastDeltaMax, detail: `暗部蓝偏比原片多 ${shadowBlueCastDelta}/255（上限 ${thresholds.shadowBlueCastDeltaMax}）→ 整屏发蓝` })
  }
  if (hueShift > thresholds.hueShiftMaxDeg) {
    violations.push({ id: 'hue-shift', severity: 'medium', actual: hueShift, limit: thresholds.hueShiftMaxDeg, detail: `全局色相偏移 ${hueShift}°（上限 ${thresholds.hueShiftMaxDeg}°）` })
  }
  if (satDelta > thresholds.satDeltaMax) {
    violations.push({ id: 'saturation', severity: 'low', actual: satDelta, limit: thresholds.satDeltaMax, detail: `饱和度变化 ${satDelta}（上限 ${thresholds.satDeltaMax}）` })
  }
  if (deltaWhite > thresholds.whitePctDelta) {
    violations.push({ id: 'white-clip', severity: 'medium', actual: deltaWhite, limit: thresholds.whitePctDelta, detail: `高光溢出 ${deltaWhite}pp（上限 ${thresholds.whitePctDelta}pp）` })
  }

  // 建议强度：按越界最严重的比例缩放，最低 0.05
  let recommendedStrength = 1
  for (const violation of violations) {
    const ratio = violation.limit / Math.max(1e-6, violation.actual)
    recommendedStrength = Math.min(recommendedStrength, ratio)
  }
  recommendedStrength = Math.max(0.05, Math.min(1, Number(recommendedStrength.toFixed(2))))

  return {
    ok: violations.length === 0,
    before,
    after,
    deltas: { blackPct: deltaBlack, nearBlackPct: deltaNearBlack, whitePct: deltaWhite, satDelta, hueShift, shadowBlueCast },
    violations,
    shadowUsable,
    recommendedStrength,
    thresholds,
  }
}

/** Vibe 默认强度：有越界就降到建议值（只想「一点点」）。 */
export function pickStrength(requested, evaluation) {
  const wanted = Number.isFinite(Number(requested)) ? Number(requested) : 0.35
  if (!evaluation || evaluation.ok) return { strength: wanted, reduced: false, reason: null }
  const chosen = Math.min(wanted, evaluation.recommendedStrength)
  return { strength: Number(chosen.toFixed(2)), reduced: chosen < wanted, reason: evaluation.violations.map((v) => v.id).join(',') }
}

export const GRADE_GUARD_LIMITS = LIMITS
