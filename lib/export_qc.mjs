/** 导出后质检：解析 ffmpeg blackdetect 输出，给黑场区间与总时长。 */
export function parseBlackdetect(text) {
  const intervals = []
  const re = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g
  let match
  while ((match = re.exec(String(text ?? ''))) !== null) {
    const start = Number(match[1]); const end = Number(match[2]); const duration = Number(match[3])
    if (![start, end, duration].every(Number.isFinite)) continue
    intervals.push({ start, end, duration })
  }
  const blackSeconds = intervals.reduce((sum, entry) => sum + entry.duration, 0)
  return { intervals, blackSeconds: Number(blackSeconds.toFixed(3)) }
}

export function qcVerdict({ duration, blackSeconds, maxBlackSeconds = 0.2 }) {
  const dur = Number(duration)
  const black = Number(blackSeconds)
  if (!Number.isFinite(dur) || dur <= 0) return { pass: false, reason: '无法读取导出时长' }
  if (!Number.isFinite(black) || black > maxBlackSeconds) return { pass: false, reason: `检测到黑场 ${black}s（阈值 ${maxBlackSeconds}s）` }
  return { pass: true, reason: '无超过阈值的黑场' }
}
