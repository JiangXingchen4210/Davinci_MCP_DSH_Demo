/**
 * 叠加 comp 的安全边界：只允许删除/替换插件自己创建的 comp。
 * 片段里已有用户自己的 Fusion comp 时，默认拒绝而不是清空。
 */
export const OVERLAY_COMP_NAME = 'AutoOverlay'

export function planOverlayCompAction(names, compName = OVERLAY_COMP_NAME) {
  const list = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name) : []
  const ours = list.filter((name) => name === compName)
  const others = list.filter((name) => name !== compName)
  if (ours.length > 0) {
    return { action: 'replace', deleteNames: ours, keep: others, compName }
  }
  if (others.length > 0) {
    return {
      action: 'refuse',
      deleteNames: [],
      keep: others,
      compName,
      reason: `片段已有 ${others.length} 个非插件 Fusion comp（${others.join(' / ')}）；为避免误删，未做任何修改。请先手动处理，或明确允许后再叠加。`,
    }
  }
  return { action: 'create', deleteNames: [], keep: [], compName }
}
