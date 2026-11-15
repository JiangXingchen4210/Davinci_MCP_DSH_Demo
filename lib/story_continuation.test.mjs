/** 接戏条 + 台词覆盖率自检：B 重复 A 结尾时必须紧跟 A；独立语义台词不能被漏掉。 */
import { buildContinuationGraph, dialogueInventory, planStoryEdit, validatePlan } from './story.mjs'

let failures = 0
const assert = (condition, message) => { if (!condition) { failures += 1; console.log(`  FAIL ${message}`) } }

// A 说完整句；B 从 A 的结尾重复起（实拍接戏的典型形态）
const shots = [
  { index: 1, clipId: 'A', name: 'A条', start: 0, end: 8, duration: 8, recordStart: 86400,
    transcript: [{ start: 1.0, end: 4.0, text: '你好我是Deepseek很高兴认识你', speaker: 'S1' }] },
  { index: 2, clipId: 'B', name: 'B条', start: 0, end: 8, duration: 8, recordStart: 86496,
    transcript: [{ start: 1.2, end: 3.0, text: '很高兴认识你你叫什么名字', speaker: 'S2' }] },
  // 独立的第三句语义（不能因为控时长被丢掉）
  { index: 3, clipId: 'C', name: 'C条', start: 0, end: 8, duration: 8, recordStart: 86592,
    transcript: [{ start: 1.5, end: 3.2, text: '我在西南开大车已经十二年了', speaker: 'S1' }] },
  // C 的重拍条（同句不同说法，语义相同）
  { index: 4, clipId: 'D', name: 'D条', start: 0, end: 8, duration: 8, recordStart: 86688,
    transcript: [{ start: 1.4, end: 3.4, text: '我当年的时候开大车在西南', speaker: 'S1' }] },
]

// 1) 衔接图：1→2 必须是 continuation（B 重复 A 结尾）
const graph = buildContinuationGraph(shots)
const pair12 = graph.pairs.find((pair) => pair.fromShot === 1 && pair.toShot === 2)
console.log('pairs:', graph.pairs.map((pair) => `${pair.fromShot}→${pair.toShot}:${pair.kind}(${pair.overlapChars})`))
assert(pair12, '应检出 1→2 的接戏关系')
assert(pair12.kind === 'continuation', `1→2 应为 continuation，实际 ${pair12?.kind}`)
assert(pair12.overlapChars >= 5, `重叠字数应 ≥5，实际 ${pair12?.overlapChars}`)
assert(graph.chains.some((chain) => chain.join('→').startsWith('1→2')), '应串成 1→2 的链')

// 2) 台词清单：C/D 视为同一句语义（互含关系）
const inventory = dialogueInventory(shots)
console.log('inventory:', inventory.map((line) => line.text))
assert(inventory.some((line) => line.text.includes('西南')), '应包含西南那句')
const xiNan = inventory.filter((line) => line.text.includes('西南') || line.text.includes('开大车'))
assert(xiNan.length === 1, `「西南开大车」与「开大车在西南」应合并为同一句，实际 ${xiNan.length} 组`)

// 3) 方案：必须包含 A、B 的衔接，且 C/D 那句不能漏
const plan = planStoryEdit({ shots, targetDuration: 10, options: { fps: 24 } })
console.log('edits:', plan.edits.map((edit) => `#${edit.shotIndex}:${edit.kind}:${(edit.text ?? '').slice(0, 12)}`))
console.log('coverage:', JSON.stringify(plan.coverage), '| dropped:', plan.droppedDialogue.map((line) => line.text))
const shotOrder = [...new Set(plan.edits.map((edit) => edit.shotIndex))]
assert(shotOrder.includes(1) && shotOrder.includes(2), `A/B 两条接戏条都应在成片里，实际 ${shotOrder.join(',')}`)
const indexOfA = shotOrder.indexOf(1)
const indexOfB = shotOrder.indexOf(2)
assert(indexOfA >= 0 && indexOfB === indexOfA + 1, `B 必须紧跟 A（实际顺序 ${shotOrder.join('→')}）`)
assert(plan.coverage.ratio === 1, `台词覆盖率应为 1，实际 ${plan.coverage.ratio}（dropped: ${plan.droppedDialogue.map((line) => line.text)}）`)
assert(plan.droppedDialogue.length === 0, '不应有台词被漏掉')

// 4) B 的开头（重复部分）必须在成片里——这是接戏的「钩子」
const editB = plan.edits.find((edit) => edit.shotIndex === 2)
assert(editB && editB.in <= 1.0, `B 的入点应早于重复台词起点（实际 in=${editB?.in}）`)

// 5) 校验器：把 B 挪走应报 chain-gap
const broken = validatePlan({ edits: plan.edits.filter((edit) => edit.shotIndex !== 2), shots, continuation: graph })
assert(broken.issues.some((issue) => issue.id === 'chain-split'), '去掉 B 后应报 chain-split')

if (failures > 0) { console.error(`FAIL story_continuation.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log(`PASS story_continuation.test.mjs — 检出接戏 ${graph.pairs.length} 处、B 紧跟 A、台词覆盖率 ${plan.coverage.ratio}、无遗漏`)
