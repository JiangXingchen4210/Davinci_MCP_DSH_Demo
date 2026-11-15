/** 分层预览节点状态：未知状态零写入；已知关闭节点在成功/失败后都保持关闭；恢复失败可报告。 */
import { normalizeNodes, planStageEnabled, planRestore, summarizeRestore } from './preview_state.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }

// 1) 未知状态（probe 没给 enabled）→ 预演「切层」必须零写入
const unknownRaw = [
  { node_index: 1, label: 'L1 · 01 输入', enabled: true },
  { node_index: 2, label: 'L1 · 02 白平衡' },              // 没有 enabled
  { node_index: 14, label: 'L3 · 14 风格 LUT', enabled: false },
]
const unknownNodes = normalizeNodes(unknownRaw)
const stagePlan = planStageEnabled(unknownNodes, 'L1')
assert(stagePlan.ok === false && stagePlan.writes.length === 0, '未知状态时切层计划必须零写入')
assert(stagePlan.unknown.includes(2), `应指出未知节点编号，实际 ${JSON.stringify(stagePlan.unknown)}`)
const restorePlanUnknown = planRestore(unknownNodes)
assert(restorePlanUnknown.ok === false && restorePlanUnknown.writes.length === 0, '未知状态时恢复计划也必须零写入')

// 2) 已知状态：L3 关闭的节点，切 L1 时被打开，恢复时必须回到关闭
const knownRaw = [
  { node_index: 1, label: 'L1 · 01 输入', enabled: true },
  { node_index: 5, label: 'L2 · 05 曲线', enabled: true },
  { node_index: 14, label: 'L3 · 14 风格 LUT', enabled: false },
  { node_index: 15, label: 'L3 · 15 质感', enabled: true },
]
const knownNodes = normalizeNodes(knownRaw)
const toL1 = planStageEnabled(knownNodes, 'L1')
assert(toL1.ok === true, '已知状态时切层应成功')
assert(toL1.writes.find((w) => w.index === 14)?.enabled === false, 'L3 节点在 L1 预览时应被临时关闭')
const restore = planRestore(knownNodes)
assert(restore.ok === true, '已知状态时恢复计划应成功')
assert(restore.writes.find((w) => w.index === 14)?.enabled === false, '恢复必须把 #14 还原为关闭（不是一律打开）')
assert(restore.writes.find((w) => w.index === 15)?.enabled === true, '恢复必须把原本打开的 #15 保持打开')

// 3) 恢复结果汇总：部分失败要给出节点编号
const summary = summarizeRestore([{ index: 2, ok: true }, { index: 14, ok: false }])
assert(summary.restored === false && summary.failed.includes(14), '恢复失败必须报告节点编号')
const okSummary = summarizeRestore([{ index: 2, ok: true }, { index: 14, ok: true }])
assert(okSummary.restored === true && okSummary.failed.length === 0, '全部成功时 restored 必须为 true')

if (failures) { console.error(`FAIL preview_state.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS preview_state.test.mjs — 未知状态零写入；关闭节点保持关闭；恢复失败可定位')
