/** 按 vidoe 轨查找片段（纯函数，便于单测）：不假设只有 V1–V4。 */
export function findVideoTrackForItem(tracks, itemId) {
  const list = Array.isArray(tracks) ? tracks : []
  for (const track of list) {
    const hit = (track.items ?? []).find((item) => item && item.id === itemId)
    if (hit) return { trackIndex: track.trackIndex, item: hit }
  }
  return null
}

export function notFoundError(itemId, trackCount) {
  return `在 V1–V${trackCount} 上找不到片段 ${itemId}（已检查全部视频轨）`
}
