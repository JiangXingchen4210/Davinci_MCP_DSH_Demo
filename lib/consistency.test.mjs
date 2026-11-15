/** 一致性自检：曝光/黑位/白平衡不同的镜头应被修正到 hero 基准，残差显著下降。 */
import { buildConsistencyPlan, measureInconsistency, statsFromAnalysis } from './consistency.mjs'

let failures = 0
const assert = (condition, message) => { if (!condition) { failures += 1; console.log(`  FAIL ${message}`) } }

const makeStats = (p5, p50, p95, sat, r, b, shadowLuma) => ({ p5, p50, p95, sat, r, g: p50 * 255, b, shadowLuma, shadowR: r * 0.9, shadowB: b * 1.0, coverage: 100 })

const hero = { id: 'hero', stats: makeStats(0.06, 0.35, 0.82, 0.35, 120, 105, 0.05) }
const shots = [
  { id: 'shotA', stats: makeStats(0.10, 0.45, 0.86, 0.30, 110, 118, 0.09) }, // 黑位抬高、偏冷
  { id: 'shotB', stats: makeStats(0.03, 0.28, 0.70, 0.42, 135, 100, 0.025) }, // 更暗、偏暖
  { id: 'shotC', stats: makeStats(0.06, 0.35, 0.82, 0.35, 120, 105, 0.05) }, // 与 hero 相同
]

const before = measureInconsistency([hero, ...shots])
console.log('before:', JSON.stringify({ blackSpread: before.blackSpread, midSpread: before.midSpread, wbSpread: before.wbSpread, verdict: before.verdict, score: before.score }))
assert(before.ok, '不一致度应可计算')
assert(before.verdict !== 'consistent', `三镜头应判为不一致，实际 ${before.verdict}`)

const plan = buildConsistencyPlan(hero, shots)
console.log('plan:', plan.entries.map((entry) => `${entry.id}: gain=${entry.corrections?.gain} lift=${entry.corrections?.lift} warmth=${entry.corrections?.warmth}`))
assert(plan.ok, '计划应生成')
const shotA = plan.entries.find((entry) => entry.id === 'shotA')
assert(shotA.corrections.lift < 0, `shotA 黑位偏高 → lift 应为负，实际 ${shotA.corrections.lift}`)
assert(shotA.corrections.gain > 0.9, 'shotA 曝光不应被推极端')
const shotB = plan.entries.find((entry) => entry.id === 'shotB')
assert(shotB.corrections.gain > 1, `shotB 更暗 → gain 应 >1，实际 ${shotB.corrections.gain}`)
const shotC = plan.entries.find((entry) => entry.id === 'shotC')
assert(Math.abs(shotC.corrections.gain - 1) < 0.02 && Math.abs(shotC.corrections.lift) < 0.005, '与 hero 相同的镜头应几乎不需要修正')
// 修正后残差应显著小于修正前
for (const entry of plan.entries.filter((item) => item.ok)) {
  const beforeBlack = Math.abs(entry.before.blackDelta)
  const afterBlack = Math.abs(entry.residual.blackDelta)
  assert(afterBlack <= beforeBlack + 0.005, `${entry.id} 黑位残差应下降：${beforeBlack} → ${afterBlack}`)
  assert(Math.abs(entry.residual.midDelta) < 0.05, `${entry.id} 中灰残差应很小，实际 ${entry.residual.midDelta}`)
}
// 模拟套用后再量不一致度（线性近似）
const afterStats = [hero, ...plan.entries.filter((entry) => entry.ok).map((entry) => {
  const shot = shots.find((item) => item.id === entry.id).stats
  const applyGamma = (value) => value <= 0 ? value : Math.pow(value, entry.corrections.gamma ?? 1)
  return { id: entry.id, stats: makeStats(applyGamma(shot.p5 * entry.corrections.gain + entry.corrections.lift), applyGamma(shot.p50 * entry.corrections.gain + entry.corrections.lift), applyGamma(shot.p95 * entry.corrections.gain + entry.corrections.lift), shot.sat * entry.corrections.saturation, shot.r * Math.exp(entry.corrections.warmth), shot.b * Math.exp(-entry.corrections.warmth), applyGamma(shot.shadowLuma * entry.corrections.gain + entry.corrections.lift)) }
})]
const after = measureInconsistency(afterStats)
console.log('after:', JSON.stringify({ blackSpread: after.blackSpread, midSpread: after.midSpread, wbSpread: after.wbSpread, verdict: after.verdict, score: after.score }))
assert(after.score < before.score, `一致性应改善：${before.score} → ${after.score}`)
assert(after.blackSpread < before.blackSpread, `黑位离散应下降：${before.blackSpread} → ${after.blackSpread}`)

if (failures > 0) { console.error(`FAIL consistency.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log(`PASS consistency.test.mjs — 修正后 score ${before.score} → ${after.score}，黑位离散 ${before.blackSpread} → ${after.blackSpread}`)
