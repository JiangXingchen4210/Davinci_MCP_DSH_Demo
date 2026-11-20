import { buildTemporalPrompt, parseTemporalLabels, scoreTemporalWindow, agreement } from './temporal_vision.mjs'
import { extractJsonArray } from './vision_semantic.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
const text = `[
 {"t":0,"description":"学生走上台阶","action":"走路","energy":0.6,"quality":0.9,"themeFit":0.9,"occlusion":false},
 {"t":1,"description":"学生继续走上台阶","action":"走路","energy":0.7,"quality":0.9,"themeFit":0.9,"occlusion":false},
 {"t":2,"description":"树枝遮挡镜头","action":"无","energy":0.1,"quality":0.3,"themeFit":0.4,"occlusion":true}
]`
const parsed = await parseTemporalLabels(text, [0, 1, 2], extractJsonArray)
assert(parsed.ok && parsed.labels.length === 3, '应解析 3 个逐秒标签')
assert(parsed.labels?.[2]?.occlusion === true, '遮挡标记应保留')
const win = scoreTemporalWindow(parsed.labels, { startSec: 0, endSec: 3, durationSec: 1.5, stepSec: 0.25 })
assert(win.ok && win.best.start <= 0.5, '最佳窗口应落在动作清晰的前段')
const bad = scoreTemporalWindow(parsed.labels, { startSec: 0, endSec: 3, durationSec: 3, stepSec: 1 })
assert(bad.ok, '有足够标签时应能评分')
const ref = parsed.labels
const cand = parsed.labels.map((label) => ({ ...label, themeFit: Math.min(1, label.themeFit + 0.05), description: label.description }))
const agree = agreement(ref, cand)
assert(agree.frames === 3 && agree.timeMatch === 1, '同一序列时间应完全匹配')
assert(agree.themeMae <= 0.06, '轻微分数变化应被量化')
assert(buildTemporalPrompt({ theme: 'campus-autumn', times: [0, 1], width: 384 }).includes('0.00s'), '提示词应带时间戳')
assert((await parseTemporalLabels('oops', [0], extractJsonArray)).ok === false, '非 JSON 应失败')

if (failures) { console.error(`FAIL temporal_vision.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS temporal_vision.test.mjs — 逐秒标签/最佳窗口/压缩一致性')
