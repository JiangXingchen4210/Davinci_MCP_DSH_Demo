/** 指定 itemId 时跨全部视频轨查找（不假设 V1–V4，空轨不提前结束）。 */
import { findVideoTrackForItem, notFoundError } from './timeline_lookup.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
const tracks = (map) => Object.entries(map).map(([index, items]) => ({ trackIndex: Number(index), items }))
const clip = (id, start = 0) => ({ id, start, kind: 'clip' })

// V1/V2 为空，目标在 V3
const onV3 = tracks({ 1: [], 2: [], 3: [clip('target-V3')] })
const hit3 = findVideoTrackForItem(onV3, 'target-V3')
assert(hit3?.trackIndex === 3, `目标在 V3 时应定位到 V3，实际 ${JSON.stringify(hit3)}`)

// 空轨不能提前结束：V1–V4 空、目标在 V5
const onV5 = tracks({ 1: [], 2: [], 3: [], 4: [], 5: [clip('target-V5')] })
const hit5 = findVideoTrackForItem(onV5, 'target-V5')
assert(hit5?.trackIndex === 5, `目标在 V5 时应继续查找并定位，实际 ${JSON.stringify(hit5)}`)

// 目标确实不存在 → null，调用方给出包含目标 ID 的错误
const missing = findVideoTrackForItem(onV5, 'nope')
assert(missing === null, '不存在的目标必须返回 null')
const err = notFoundError('nope', 5)
assert(err.includes('nope') && err.includes('V1–V5'), `错误信息应包含目标 ID 与检查范围，实际 ${err}`)

if (failures) { console.error(`FAIL timeline_lookup.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS timeline_lookup.test.mjs — V3/V5 定位正确，缺失目标报含 ID 的错误')
