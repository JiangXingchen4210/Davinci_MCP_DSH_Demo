/** 混合帧率：59.94/29.97/23.976 源帧与 24p 时间线帧必须分开换算，record_frame 连续无空隙。 */
import { buildClipInfos, framesForSeconds, toResolveClipInfos } from './edit_timing.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`)

assert(framesForSeconds(2.46, 29.97) === 74, '29.97 2.46s 源帧')
assert(framesForSeconds(3.839, 59.94) === 230, '59.94 3.839s 源帧')
assert(framesForSeconds(3.908, 23.976) === 94, '23.976 3.908s 源帧')

const shots = [
  { index: 1, clipId: 'a', sourceFps: 29.97, sourceStartFrame: 0, sourceEndFrame: 375, start: 0, end: 12.5 },
  { index: 2, clipId: 'b', sourceFps: 59.94, sourceStartFrame: 0, sourceEndFrame: 598, start: 0, end: 9.98 },
  { index: 3, clipId: 'c', sourceFps: 23.976, sourceStartFrame: 0, sourceEndFrame: 708, start: 0, end: 29.5 },
]
const edits = [
  { shotIndex: 1, in: 0, out: 2.46 },
  { shotIndex: 2, in: 0, out: 2.782 },
  { shotIndex: 3, in: 0, out: 3.908 },
]
const { clipInfos, totalFrames } = buildClipInfos({ shots, edits, timelineFps: 24 })
assert(clipInfos.length === 3, '应产出 3 段')
near(totalFrames, 59 + 66 + 94, 1, '总时长≈219 时间线帧')
assert(clipInfos[0].record_frame === 0, '第一段 record=0')
assert(clipInfos[1].record_frame === clipInfos[0].record_frame + clipInfos[0].durationFrames, 'record_frame 连续')
assert(clipInfos[2].record_frame === clipInfos[1].record_frame + clipInfos[1].durationFrames, '第三段连续')
// 源帧按源帧率
near(clipInfos[0].end_frame, 74, 1, '29.97 源 out 帧')
near(clipInfos[1].end_frame, 167, 2, '59.94 源 out 帧')
near(clipInfos[2].end_frame, 94, 1, '23.976 源 out 帧')
// 时间线帧按 24fps
near(clipInfos[0].durationFrames, 59, 1, '29.97→24p 时长')
near(clipInfos[1].durationFrames, 66, 1, '59.94→24p 时长')
near(clipInfos[2].durationFrames, 94, 1, '23.976→24p 时长')
// 夹到可用源区间
const clamped = buildClipInfos({
  shots: [{ index: 1, clipId: 'x', sourceFps: 59.94, sourceStartFrame: 300, sourceEndFrame: 420, start: 5, end: 7 }],
  edits: [{ shotIndex: 1, in: 0, out: 10 }],
  timelineFps: 24,
})
assert(clamped.clipInfos[0].start_frame === 300 && clamped.clipInfos[0].end_frame === 420, '必须夹到 source in/out')
near(clamped.clipInfos[0].durationFrames, 48, 1, '夹取后时间线时长按源帧率换算')
// 输出给 Resolve 的参数没有内部字段
assert(!('durationFrames' in toResolveClipInfos(clipInfos)[0]), 'Resolve 参数不应带内部 durationFrames')

if (failures) { console.error(`FAIL edit_timing.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS edit_timing.test.mjs — 混合 29.97/59.94/23.976 源帧与 24p 时间线帧分离、record 连续、夹取正确')
