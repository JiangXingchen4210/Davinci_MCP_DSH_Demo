/** 视频抠像常用纯逻辑：主体框归一化/像素化、插件 alpha 片段命名。 */

/** 归一化框（0..1）→ 像素框；已是像素框则原样 clamp。返回 null 表示无效。 */
export function normalizeSubjectBox(box, width, height) {
  if (!box || typeof box !== 'object') return null
  const values = ['x', 'y', 'w', 'h'].map((key) => Number(box[key]))
  if (values.some((value) => !Number.isFinite(value))) return null
  let [x, y, w, h] = values
  if (w <= 0 || h <= 0 || width <= 0 || height <= 0) return null
  const normalized = x <= 1.001 && y <= 1.001 && w <= 1.001 && h <= 1.001
  if (normalized) {
    x *= width
    y *= height
    w *= width
    h *= height
  }
  // 允许框中心略出界，但保证宽高有效、起点不越过画幅
  return {
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y)),
    w: Math.min(width - x, w),
    h: Math.min(height - y, h),
  }
}

/** 插件生成的 alpha 片段名（重复点击时只允许替换这些，不删用户片段）。 */
export function isDerivedAlphaName(name) {
  return /^alpha(?:-normalized)?\.mov$/i.test(String(name ?? ''))
}

/** 判断 V2 片段与 [start,end) 是否重叠（帧号）。 */
export function overlapsRange(item, start, end) {
  const itemStart = Number(item?.start)
  const itemEnd = Number(item?.end)
  return Number.isFinite(itemStart) && Number.isFinite(itemEnd) && itemStart < end && itemEnd > start
}
