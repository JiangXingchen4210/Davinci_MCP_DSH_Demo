/**
 * 分层预览的节点开关规划（纯函数，可单测）。
 *
 * 规则（对应 0.11.7 修复）：
 *  - 只使用 probe_node_graph 明确返回的 enabled 布尔值；
 *  - 任一可能被修改的节点状态未知 → 不产生任何写入（零次 set_node_enabled），返回可解释错误；
 *  - 恢复按预览前的原始状态逐条写回，而不是一律打开。
 */

export function normalizeNodes(rawNodes) {
  const nodes = Array.isArray(rawNodes) ? rawNodes : []
  return nodes.map((node, offset) => {
    const label = String(node?.label ?? node?.tools?.join(' ') ?? '')
    const index = Number(node?.node_index ?? offset + 1)
    const layerMatch = /^\s*L([123])\b/i.exec(label)
    const numberMatch = /·\s*(\d+)/.exec(label) ?? /(\d+)/.exec(label)
    const number = numberMatch ? Number(numberMatch[1]) : index
    const layer = layerMatch ? `L${layerMatch[1]}` : number <= 4 ? 'L1' : number <= 9 ? 'L2' : 'L3'
    const enabledRaw = node?.enabled ?? node?.is_enabled
    const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : null
    return { index, number, label, layer, enabled, tools: node?.tools ?? [], lut: node?.lut ?? '' }
  })
}

const enabledUpTo = (stage) => (stage === 'source' ? 0 : stage === 'L1' ? 4 : stage === 'L2' ? 9 : 999)

/** 规划“切到某一层”的写入：返回 {ok, writes:[{index,enabled}], unknown:[index], error}。 */
export function planStageEnabled(nodes, stage) {
  const list = Array.isArray(nodes) ? nodes : []
  const unknown = list.filter((node) => typeof node.enabled !== 'boolean').map((node) => node.index)
  if (unknown.length) {
    return { ok: false, reason: 'node_state_unknown', writes: [], unknown, error: `无法读取节点原始开关（节点 ${unknown.join(', ')}），为避免改动调色已取消预览` }
  }
  const upTo = enabledUpTo(stage)
  return { ok: true, writes: list.map((node) => ({ index: node.index, enabled: node.number <= upTo })) }
}

/** 规划“恢复原始状态”的写入。 */
export function planRestore(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const unknown = list.filter((node) => typeof node.enabled !== 'boolean').map((node) => node.index)
  if (unknown.length) {
    return { ok: false, reason: 'node_state_unknown', writes: [], unknown, error: `节点 ${unknown.join(', ')} 的原始开关未知，无法安全还原；预览未执行` }
  }
  return { ok: true, writes: list.map((node) => ({ index: node.index, enabled: node.enabled })) }
}

/** 汇总恢复结果：只有全部成功才算 restored；失败时给出节点编号。 */
export function summarizeRestore(results) {
  const list = Array.isArray(results) ? results : []
  const failed = list.filter((item) => !item.ok).map((item) => item.index)
  return { restored: failed.length === 0, total: list.length, failed }
}

/** 解析 set_node_enabled 的返回值：布尔与 {success:boolean} 都按真实语义判断。 */
export function parseNodeWriteResult(value) {
  if (typeof value === 'boolean') return { ok: value, raw: value }
  if (value && typeof value === 'object' && typeof value.success === 'boolean') return { ok: value.success, raw: value }
  return { ok: false, raw: value ?? null, reason: '节点写入结果无法判定' }
}
