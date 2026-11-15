/** 三层节点图自检：节点数 ≥12、三层齐全、一个节点只放一个工具、顺序可解释。 */
import { buildThreeLayerGraph, toDrxNodes, LAYERS } from './nodegraph.mjs'

let failures = 0
const assert = (condition, message) => { if (!condition) { failures += 1; console.log(`  FAIL ${message}`) } }

const graph = buildThreeLayerGraph({
  consistency: { gain: 1.05, lift: -0.006, gamma: 1.08, warmth: 0.012, saturation: 1.02 },
  look: { preset: 'godfather', strength: 0.6 },
  shot: { layers: { skin: { meanHuePercent: 6.2 }, background: { meanHuePercent: 62 } } },
  texture: { halation: { strength: 0.5 }, glow: { strength: 0.2 }, grain: { amount: 8 } },
  styleStrength: 0.8,
})
console.log('nodes:', graph.nodeCount, '| layers:', graph.layers.map((layer) => `${layer.id}:${layer.nodes.length}`).join(' '))
assert(graph.nodeCount === 15, `应为 15 个真实节点（不允许空的分隔/占位节点），实际 ${graph.nodeCount}`)
const separators = graph.nodes.filter((node) => node.tool === 'separator')
assert(separators.length === 0, `不允许再出现空的分隔节点（每个节点都必须参与渲染），实际 ${separators.length}`)
const needsParams = graph.nodes.filter((node) => !['input', 'lookLut', 'texture'].includes(node.tool))
assert(needsParams.every((node) => node.tool && node.tool !== 'separator' && Object.keys(node.params).some((key) => key !== 'space')), '除风格 LUT/质感（参数由外部挂载）外，每个节点都必须带真实工具参数')
assert(graph.layerCount === 3, `应有 3 层，实际 ${graph.layerCount}`)
assert(LAYERS.length === 3, '常量里应有 3 层定义')
for (const layer of graph.layers) {
  assert(layer.nodes.length >= 3, `${layer.id} 每层至少 3 个节点，实际 ${layer.nodes.length}`)
}
// 一个节点只放一个工具：params 里除 space 外只允许出现一个工具参数族
const TOOL_KEYS = ['gain', 'lift', 'gamma', 'contrast', 'pivot', 'saturation', 'hueShift', 'customCurves', 'qualifier', 'lumaQualifier', 'softClipHigh']
for (const node of graph.nodes) {
  if (node.tool === 'input' || node.tool === 'lookLut' || node.tool === 'texture' || node.tool === 'separator') continue
  const keys = Object.keys(node.params).filter((key) => key !== 'space')
  assert(keys.length >= 1, `${node.label} 参数不能为空`)
  // 允许 balance/exposure 只带 gain；sat 只带 saturation；contrast 允许 lift+gamma+contrast（同一工具：对比）
  const families = new Set(keys.map((key) => (['gain'].includes(key) ? 'gain' : ['lift'].includes(key) ? 'lift' : key)))
  const allowed = {
    balance: ['gain'],
    exposure: ['gain'],
    contrast: ['lift', 'gamma', 'contrast', 'pivot', 'softClipHigh'],
    curve: ['customCurves'],
    hue: ['hueShift'],
    saturation: ['saturation'],
    splitTone: ['lumaQualifier', 'gain', 'saturation'],
    skinKey: ['qualifier', 'saturation', 'gain', 'matteFinesse'],
    bgKey: ['qualifier', 'gain', 'saturation', 'matteFinesse'],
  }[node.tool] ?? []
  for (const key of families) {
    assert(allowed.includes(key), `${node.label}（${node.tool}）出现不属于该工具的参数：${key}`)
  }
}
// 三层顺序：L1 全部在 L2 之前，L2 在 L3 之前
const order = graph.nodes.map((node) => node.layer)
const firstL2 = order.indexOf('L2')
const firstL3 = order.indexOf('L3')
assert(order.slice(0, firstL2).every((layer) => layer === 'L1'), 'L1 节点必须全部排在 L2 之前')
assert(order.slice(firstL2, firstL3).every((layer) => layer === 'L2'), 'L2 节点必须全部排在 L3 之前')
assert(order.slice(firstL3).every((layer) => layer === 'L3'), 'L3 节点必须在最后')
// drx 转换
const drx = toDrxNodes(graph)
assert(drx.newNodes.length === graph.nodeCount - 1, `drx 新节点数应为 ${graph.nodeCount - 1}，实际 ${drx.newNodes.length}`)
assert(drx.newNodes.every((node) => node.label && !/^—/.test(node.label)), 'drx 里不应再出现分隔节点')
const expectedLookIndex = graph.nodes.findIndex((node) => node.tool === 'lookLut') + 1
assert(drx.lookNodeIndex === expectedLookIndex, `风格 LUT 应在第 ${expectedLookIndex} 个节点，实际 ${drx.lookNodeIndex}`)
// 三层分行排布：L1/L2/L3 的 yPos 必须不同且递增；label 带层名
const ys = drx.newNodes.map((node) => ({ y: node.yPos, xPos: node.xPos, label: node.label }))
const lb = [{ y: drx.base.yPos, xPos: drx.base.xPos, label: drx.base.label }]
const l1 = [...lb, ...ys].filter((item) => item.label.startsWith('L1 ·'))
const l2 = ys.filter((item) => item.label.startsWith('L2 ·'))
const l3 = ys.filter((item) => item.label.startsWith('L3 ·'))
assert(l1.length > 0 && l2.length > 0 && l3.length > 0, '三层标签都要存在')
assert(l1.every((item) => item.y === 120), `L1 应排在第 1 行 y=120，实际 ${[...new Set(l1.map((i) => i.y))]}`)
assert(l2.every((item) => item.y === 440), `L2 应排在第 2 行 y=440，实际 ${[...new Set(l2.map((i) => i.y))]}`)
assert(l3.every((item) => item.y === 760), `L3 应排在第 3 行 y=760，实际 ${[...new Set(l3.map((i) => i.y))]}`)
assert(l1.every((item) => item.xPos >= 290) && l2.every((item) => item.xPos >= 330), 'L1/L2 的 x 应逐层右移')
// 同一行内节点间距必须 ≥495（250 时实测会叠在一起）
const xs = [...l1, ...l2, ...l3].map((item) => item.xPos).sort((a, b) => a - b)
for (let i = 1; i < xs.length; i += 1) {
  // 只比较同一行的相邻节点
}
for (const row of [l1, l2, l3]) {
  const sorted = row.map((item) => item.xPos).sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i += 1) assert(sorted[i] - sorted[i - 1] >= 495, `同一行节点间距应 ≥495，实际 ${sorted[i] - sorted[i - 1]}`)
}
const expectedTextureIndex = graph.nodes.findIndex((node) => node.tool === 'texture') + 1
assert(drx.textureNodeIndex === expectedTextureIndex, `质感节点应在第 ${expectedTextureIndex} 个节点，实际 ${drx.textureNodeIndex}`)
const json = JSON.stringify(graph)
assert(!/NaN|Infinity/.test(json), 'JSON 里不能出现 NaN/Infinity')

if (failures > 0) { console.error(`FAIL nodegraph.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log(`PASS nodegraph.test.mjs — ${graph.nodeCount} 节点 / 3 层（L1 4 · L2 5 · L3 4）、单工具、顺序正确、LUT 在 #${drx.lookNodeIndex}`)
