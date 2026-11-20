/**
 * 源帧 / 时间线帧 / 秒 的换算（考点的核心：混用时间线帧率与源帧率会得到 5s 而不是 2.002s）。
 * 约定：
 *  - sourceFrame = 源文件内的帧号（0 起，按源帧率计）
 *  - timelineFrame = 时间线记录帧（按时间线帧率计）
 *  - retime 不在这里猜：变速片段必须由调用方明确拒绝或另算。
 */
const RATE_ALIASES = new Map([
  ['23.976', [24000, 1001]],
  ['23.98', [24000, 1001]],
  ['24', [24, 1]],
  ['25', [25, 1]],
  ['29.97', [30000, 1001]],
  ['30', [30, 1]],
  ['50', [50, 1]],
  ['59.94', [60000, 1001]],
  ['60', [60, 1]],
])

export function parseRate(value) {
  if (value && typeof value === 'object' && Number(value.num) > 0 && Number(value.den) > 0) {
    return { num: Number(value.num), den: Number(value.den) }
  }
  const text = String(value ?? '').trim()
  if (!text) return null
  const direct = text.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (direct) {
    const num = Number(direct[1]); const den = Number(direct[2])
    return num > 0 && den > 0 ? { num, den } : null
  }
  const normalized = text.replace(/\s*fps$/i, '')
  if (RATE_ALIASES.has(normalized)) {
    const [num, den] = RATE_ALIASES.get(normalized)
    return { num, den }
  }
  const asNumber = Number(normalized)
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null
  if (Math.abs(asNumber - 23.976) < 1e-3) return { num: 24000, den: 1001 }
  if (Math.abs(asNumber - 29.97) < 1e-3) return { num: 30000, den: 1001 }
  if (Math.abs(asNumber - 59.94) < 1e-3) return { num: 60000, den: 1001 }
  return { num: Math.round(asNumber * 1000), den: 1000 }
}

export function rateValue(rate) {
  const parsed = parseRate(rate)
  return parsed ? parsed.num / parsed.den : null
}

/** 源帧号 → 源秒（必须除以源帧率，不能除时间线帧率）。 */
export function sourceFrameToSeconds(sourceFrame, sourceRate) {
  const value = rateValue(sourceRate)
  const frame = Number(sourceFrame)
  if (!Number.isFinite(value) || !Number.isFinite(frame) || frame < 0) return null
  return frame / value
}

/** 时间线内偏移帧 → 源帧偏移（正常速度；变速需调用方另行处理）。 */
export function timelineOffsetToSourceFrames(offsetTimelineFrames, timelineRate, sourceRate, speed = 1) {
  const timeline = rateValue(timelineRate)
  const source = rateValue(sourceRate)
  const offset = Number(offsetTimelineFrames)
  const ratio = Number(speed)
  if (!Number.isFinite(timeline) || !Number.isFinite(source) || !Number.isFinite(offset) || !Number.isFinite(ratio) || ratio <= 0) return null
  return offset * (source / timeline) * ratio
}

/** 源帧在时间线上的位置（用于非零 source in）：timeline frames = (sourceFrame - sourceIn) * timeline/source / speed。 */
export function sourceFrameToTimelineOffset(sourceFrame, sourceInFrame, timelineRate, sourceRate, speed = 1) {
  const timeline = rateValue(timelineRate)
  const source = rateValue(sourceRate)
  const frame = Number(sourceFrame)
  const start = Number(sourceInFrame)
  const ratio = Number(speed)
  if (!Number.isFinite(timeline) || !Number.isFinite(source) || !Number.isFinite(frame) || !Number.isFinite(start) || !Number.isFinite(ratio) || ratio <= 0) return null
  return (frame - start) * (timeline / source) / ratio
}

export function isDropFrameRate(rate) {
  const value = rateValue(rate)
  if (!value) return false
  return Math.abs(value - 29.97) < 1e-3 || Math.abs(value - 59.94) < 1e-3
}

/** 帧号 → 时间码；dropFrame 由调用方明确（29.97/59.94 用 ';'，否则用 ':'）。 */
export function framesToTimecode(frames, rate, dropFrame = false) {
  const value = rateValue(rate)
  const total = Math.max(0, Math.round(Number(frames) || 0))
  if (!Number.isFinite(value)) return null
  const whole = Math.round(value)
  const p = (n) => String(n).padStart(2, '0')
  if (!dropFrame) {
    return `${p(Math.floor(total / (whole * 3600)))}:${p(Math.floor((total % (whole * 3600)) / (whole * 60)))}:${p(Math.floor((total % (whole * 60)) / whole))}:${p(total % whole)}`
  }
  // 29.97/59.94 drop-frame：每分钟丢 2 帧（59.94 每帧数量翻倍），整十分钟不丢
  const dropPerMinute = whole === 30 ? 2 : whole === 60 ? 4 : 0
  if (!dropPerMinute) return framesToTimecode(frames, rate, false)
  const framesPer10Min = whole * 600 - dropPerMinute * 9
  const framesPerMin = whole * 60 - dropPerMinute
  const tenMinutes = Math.floor(total / framesPer10Min)
  const remainder = total % framesPer10Min
  const extraMinutes = Math.min(9, Math.floor(remainder / framesPerMin))
  const dropped = dropPerMinute * (tenMinutes * 9 + extraMinutes)
  let frameNumber = total + dropped
  const fpsInt = whole
  const ff = frameNumber % fpsInt
  const ss = Math.floor(frameNumber / fpsInt) % 60
  const mm = Math.floor(frameNumber / (fpsInt * 60)) % 60
  const hh = Math.floor(frameNumber / (fpsInt * 3600)) % 24
  return `${p(hh)}:${p(mm)}:${p(ss)};${p(ff)}`
}
