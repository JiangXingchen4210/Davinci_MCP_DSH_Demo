/** 自动剪辑必须尊重时间线上片段的源入出点（含同一源文件多次使用、入点不同）。 */
import { intersectShotWithSource, clampEditToSource } from './source_range.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }

// 1) 10 秒 24fps 素材，时间线只留源 4–8 秒（96–192 帧）
const trimmed = intersectShotWithSource({ shotStartSec: 0, shotEndSec: 10, fps: 24, sourceStartFrame: 96, sourceEndFrame: 192, recordStart: 1000 })
assert(trimmed.ok === true, '交集应成立')
assert(trimmed.inFrame === 96 && trimmed.outFrame === 192, `应提交源帧 96–192，实际 ${trimmed.inFrame}–${trimmed.outFrame}`)
assert(trimmed.durationFrames === 96, `时长应为 96 帧，实际 ${trimmed.durationFrames}`)
assert(trimmed.recordStart === 1000, `记录帧应从片段记录起点开始，实际 ${trimmed.recordStart}`)

// 2) 完全在裁剪区外的镜头不入选（源 0–3 秒 vs 可用 4–8 秒）
const outside = intersectShotWithSource({ shotStartSec: 0, shotEndSec: 3, fps: 24, sourceStartFrame: 96, sourceEndFrame: 192 })
assert(outside.ok === false, '完全在可用区间外的镜头必须被排除')

// 3) 未裁切的片段保持原行为
const full = intersectShotWithSource({ shotStartSec: 2, shotEndSec: 5, fps: 24, sourceStartFrame: 0, sourceEndFrame: 240 })
assert(full.ok && full.inFrame === 48 && full.outFrame === 120, `未裁切应取 48–120，实际 ${full.inFrame}–${full.outFrame}`)

// 4) 同一源文件在时间线上用两次、入点不同
const useA = intersectShotWithSource({ shotStartSec: 1, shotEndSec: 3, fps: 24, sourceStartFrame: 0, sourceEndFrame: 96, recordStart: 0 })
const useB = intersectShotWithSource({ shotStartSec: 1, shotEndSec: 3, fps: 24, sourceStartFrame: 96, sourceEndFrame: 192, recordStart: 500 })
assert(useA.ok && useA.inFrame === 24 && useA.outFrame === 72, `第一次使用应取 24–72，实际 ${useA.inFrame}–${useA.outFrame}`)
assert(useB.ok === false, '第二次使用（可用区间 4–8 秒）与镜头 1–3 秒无交集，必须排除；即便同一源文件也不能串用入点')

// 5) 规划出的 in/out 夹回可用区间
const clamp = clampEditToSource({ inSec: 0, outSec: 10, fallbackInSec: 4, fallbackOutSec: 8, sourceStartFrame: 96, sourceEndFrame: 192, fps: 24 })
assert(clamp.ok && clamp.inFrame === 96 && clamp.outFrame === 192, `规划区间应夹回 96–192，实际 ${clamp.inFrame}–${clamp.outFrame}`)

if (failures) { console.error(`FAIL source_range.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS source_range.test.mjs — 裁切入出点/区外镜头/同源多次使用/规划区间夹取均正确')


// 混合帧率：调用方必须传「源帧率」。59.94 素材的 source_start/source_end 是源帧，不是 24p 时间线帧。
{
  const asSource = intersectShotWithSource({ shotStartSec: 0, shotEndSec: 4, fps: 59.94, sourceStartFrame: 0, sourceEndFrame: 240, recordStart: 0 })
  assert(asSource.ok && asSource.durationFrames === 240, '59.94 应按源帧率得到 240 源帧')
  const wrong = intersectShotWithSource({ shotStartSec: 0, shotEndSec: 4, fps: 24, sourceStartFrame: 0, sourceEndFrame: 240, recordStart: 0 })
  assert(wrong.ok && wrong.durationFrames === 96, '用 24fps 误算会得到 96 帧（这正是旧 edit.auto 的 bug）')
  const mapped = intersectShotWithSource({ shotStartSec: 3.6, shotEndSec: 4, fps: 59.94, sourceStartFrame: 0, sourceEndFrame: 240, recordStart: 0 })
  assert(mapped.ok && mapped.inFrame === 216 && mapped.outFrame === 240, '59.94 3.6s 应映射到源帧 216')
}
