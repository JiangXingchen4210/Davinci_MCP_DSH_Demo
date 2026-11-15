import { classifyEraseTarget, planErase } from './erase_plan.mjs'
let failures = 0
const assert = (c, m) => { if (!c) { failures += 1; console.log('  FAIL', m) } }
// 大物体：人物框
const person = classifyEraseTarget({ box: { w: 520, h: 780 } })
assert(person.kind === 'large', `人物应判为大物体，实际 ${person.kind}`)
// 小物体：钢丝
const wire = classifyEraseTarget({ box: { w: 900, h: 6 } })
assert(wire.kind === 'small', `钢丝应判为小物体，实际 ${wire.kind}`)
// 小物体：小道具
const prop = classifyEraseTarget({ box: { w: 40, h: 60 } })
assert(prop.kind === 'small', `小道具应判为小物体，实际 ${prop.kind}`)
// 方案：大物体默认干净板、小物体默认跟随
const big = planErase({ box: { w: 520, h: 780 } })
assert(big.method === 'plate' && big.size === 'large', `大物体应推荐 plate，实际 ${big.method}`)
const small = planErase({ box: { w: 900, h: 6 } })
assert(small.method === 'follow' && small.size === 'small', `小物体应推荐 follow，实际 ${small.method}`)
// 用户可强制覆盖
const forced = planErase({ box: { w: 520, h: 780 }, size: 'small', method: 'follow' })
assert(forced.size === 'small' && forced.method === 'follow', '应尊重用户手动选择')
assert(forced.steps.some((s) => s.includes('trackBox')), '小物体方案应包含跟踪步骤')
const bigPlate = planErase({ box: { w: 520, h: 780 } })
assert(bigPlate.steps.some((s) => s.includes('中位数')), '大物体方案应包含干净板中位数步骤')
if (failures) { console.error(`FAIL erase_plan.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS erase_plan.test.mjs — 大小物体分类正确、plate/follow 推荐与覆盖正确、方案步骤齐全')
