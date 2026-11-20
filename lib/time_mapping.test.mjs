/** 源帧→秒→时间线 的换算回归：59.94 源第 120 帧必须是 2.002s，不是 5s。 */
import { sourceFrameToSeconds, timelineOffsetToSourceFrames, sourceFrameToTimelineOffset, framesToTimecode, rateValue } from './time_mapping.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`)

near(sourceFrameToSeconds(120, '59.94'), 2.002, 0.002, '59.94 源第 120 帧')
near(sourceFrameToSeconds(120, '60000/1001'), 2.002, 0.002, '分数形式源帧率')
near(sourceFrameToSeconds(120, '24'), 5.0, 1e-6, '24fps 错误基准（用于对照）')

// 24p 时间线上，59.94 源偏移 48 帧 = 120 源帧
near(timelineOffsetToSourceFrames(48, '24', '59.94'), 119.88, 0.02, '24p 时间线 48 帧 → 源帧')
// 非零 source in：源帧 120、源入点 48 → 时间线偏移约 28.828 帧
near(sourceFrameToTimelineOffset(120, 48, '24', '59.94'), (72) * (24 / 59.94), 1e-3, '非零 source in 映射')
// retime 50%：时间线偏移减半
near(timelineOffsetToSourceFrames(48, '24', '59.94', 0.5), 59.94, 0.02, '50% 慢放映射')

// 时间码：23.976 非 drop 用 ':'; 29.97 drop 用 ';'
assert(framesToTimecode(24, '23.976', false) === '00:00:01:00', `23.976 1 秒时间码，实际 ${framesToTimecode(24, '23.976', false)}`)
assert(framesToTimecode(1800, '29.97', true) === '00:01:00;02', `29.97 drop-frame 1 分钟，实际 ${framesToTimecode(1800, '29.97', true)}`)
assert(framesToTimecode(1800, '29.97', false) === '00:01:00:00', '非 drop 应不偏移')
near(rateValue('59.94'), 59.94006, 1e-4, '59.94 数值')

if (failures) { console.error(`FAIL time_mapping.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS time_mapping.test.mjs — 59.94 第120帧=2.002s；时间线/源帧换算、非零入点、retime、drop-frame 正确')
