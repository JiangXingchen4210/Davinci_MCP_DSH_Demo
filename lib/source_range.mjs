/**
 * 剪辑取点必须落在「时间线上该片段实际可用的源区间」内。
 * 素材可能被剪辑师裁过入出点，也可能同一源文件在时间线上出现多次、每次入点不同；
 * 检测镜头（按整段源素材扫描）与可用源区间取交集后，选镜/建线都只消费交集。
 */

const asFrame = (value) => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.round(num) : null
}

/**
 * @param {object} input
 * @param {number} input.shotStartSec 检测镜头的源素材起始秒
 * @param {number} input.shotEndSec   检测镜头的源素材结束秒
 * @param {number} input.fps
 * @param {number} input.sourceStartFrame 时间线片段可用的源起始帧（含）
 * @param {number} input.sourceEndFrame   时间线片段可用的源结束帧（不含）
 * @param {number} [input.recordStart]    该片段在时间线上的记录起始帧
 */
export function intersectShotWithSource(input) {
  const fps = Number(input?.fps)
  const shotStart = asFrame((Number(input?.shotStartSec) || 0) * fps)
  const shotEnd = asFrame((Number(input?.shotEndSec) || 0) * fps)
  const sourceStart = asFrame(input?.sourceStartFrame)
  const sourceEnd = asFrame(input?.sourceEndFrame)
  if (!Number.isFinite(fps) || fps <= 0) return { ok: false, reason: 'fps 无效' }
  if (shotStart === null || shotEnd === null || sourceStart === null || sourceEnd === null) return { ok: false, reason: '帧参数无效' }
  if (sourceEnd <= sourceStart) return { ok: false, reason: '可用源区间为空' }
  const inFrame = Math.max(shotStart, sourceStart)
  const outFrame = Math.min(shotEnd, sourceEnd)
  if (outFrame <= inFrame) return { ok: false, reason: '镜头完全在可用源区间之外', inFrame, outFrame }
  const durationFrames = outFrame - inFrame
  const recordStart = (asFrame(input?.recordStart) ?? 0) + (inFrame - sourceStart)
  return {
    ok: true,
    inFrame,
    outFrame,
    durationFrames,
    recordStart,
    recordEnd: recordStart + durationFrames,
    clippedHeadFrames: inFrame - shotStart,
    clippedTailFrames: shotEnd - outFrame,
  }
}

/** 把 planRhythm 给出的 in/out（秒）夹回该镜头的可用源区间。 */
export function clampEditToSource({ inSec, outSec, fallbackInSec, fallbackOutSec, sourceStartFrame, sourceEndFrame, fps }) {
  const start = Number.isFinite(Number(inSec)) ? Number(inSec) : Number(fallbackInSec)
  const end = Number.isFinite(Number(outSec)) ? Number(outSec) : Number(fallbackOutSec)
  const inFrame = Math.max(asFrame(start * fps) ?? 0, asFrame(sourceStartFrame) ?? 0)
  const outFrame = Math.min(asFrame(end * fps) ?? 0, asFrame(sourceEndFrame) ?? 0)
  if (outFrame <= inFrame) return { ok: false, inFrame, outFrame, durationFrames: 0 }
  return { ok: true, inFrame, outFrame, durationFrames: outFrame - inFrame }
}
