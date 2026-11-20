/**
 * 混合帧率剪辑的时间换算：源帧（按源帧率）与时间线帧（按时间线帧率）必须分开。
 *
 * 关键不变量（edit.auto 的 bug 就出在这里）：
 *   - Resolve 的 source_start/source_end 是「源帧率」的帧号；建时间线时 start_frame/end_frame 也按源帧解释
 *   - record_frame 与片段时长是「时间线帧率」的帧号
 *   混合 29.97/59.94/23.976 素材时，不能拿同一个 fps 同时算两边。
 */

const num = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function framesForSeconds(seconds, fps) {
  const s = num(seconds)
  const f = num(fps)
  if (s === null || f === null || f <= 0) return null
  return Math.round(s * f)
}

/**
 * 把「秒」的剪辑点夹到该镜头的可用源区间，产出 create_timeline_from_clips 的 clip_infos。
 * 入参 shots 用 shotIndex 建索引；每个 shot 至少包含：
 *   clipId, sourceFps, timelineFps(可选，缺失时用默认), sourceStartFrame, sourceEndFrame
 * 返回的 record_frame 连续累加，durationFrames 是时间线帧。
 */
export function buildClipInfos({ shots, edits, timelineFps }) {
  const tlFps = num(timelineFps)
  if (!Array.isArray(shots) || !Array.isArray(edits) || tlFps === null || tlFps <= 0) return { clipInfos: [], totalFrames: 0 }
  const byIndex = new Map(shots.map((shot) => [shot.index, shot]))
  let cursor = 0
  const clipInfos = []
  for (const edit of edits) {
    const shot = byIndex.get(edit.shotIndex)
    if (!shot?.clipId) continue
    const sourceFps = num(shot.sourceFps) ?? num(timelineFps)
    if (sourceFps === null || sourceFps <= 0) continue
    const sourceStart = num(shot.sourceStartFrame) ?? 0
    const sourceEnd = num(shot.sourceEndFrame) ?? (sourceStart + Math.max(1, Math.round((num(shot.duration) ?? 0) * sourceFps)))
    const inSec = num(edit.in) ?? (num(shot.start) ?? sourceStart / sourceFps)
    const outSec = num(edit.out) ?? (num(shot.end) ?? sourceEnd / sourceFps)
    const startFrame = Math.max(sourceStart, framesForSeconds(inSec, sourceFps) ?? sourceStart)
    const endFrame = Math.min(sourceEnd, framesForSeconds(outSec, sourceFps) ?? sourceEnd)
    if (endFrame <= startFrame) continue
    // Resolve 把源帧区间换成时间线时长时是 floor（实测 59.94→24：167 源帧=66 时间线帧），
    // 这里必须跟它一致，否则 record_frame 累计会比实际时长多 1 帧，产生 1 帧黑缝。
    const durationFrames = Math.max(1, Math.floor(((endFrame - startFrame) / sourceFps) * tlFps + 1e-6))
    clipInfos.push({
      clip_id: shot.clipId,
      start_frame: startFrame,
      end_frame: endFrame,
      record_frame: cursor,
      track_index: 1,
      durationFrames,
    })
    cursor += durationFrames
  }
  return { clipInfos, totalFrames: cursor }
}

/** 去掉内部字段后的参数（create_timeline_from_clips 只认 start/end/record/track）。 */
export function toResolveClipInfos(clipInfos) {
  return (clipInfos ?? []).map(({ clip_id, start_frame, end_frame, record_frame, track_index }) => ({
    clip_id, start_frame, end_frame, record_frame, track_index,
  }))
}
