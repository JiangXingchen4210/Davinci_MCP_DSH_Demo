/** 同一段表演在源文件中整体平移，相对切点与理由必须不变（坐标系回归）。 */
import { planStoryEdit } from './story.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }

const motion = {
  samples: [
    { t: 0.2, energy: 0.8 }, { t: 0.5, energy: 0.9 }, { t: 0.8, energy: 0.85 },
    { t: 1.1, energy: 0.7 }, { t: 1.4, energy: 0.6 }, { t: 1.7, energy: 0.4 },
    { t: 2.0, energy: 0.05 }, { t: 2.2, energy: 0.03 }, { t: 2.5, energy: 0.04 },
    { t: 2.8, energy: 0.5 }, { t: 3.1, energy: 0.7 }, { t: 3.5, energy: 0.8 },
  ],
  stillThreshold: 0.1,
  stills: [{ start: 2.0, end: 2.6, duration: 0.6 }],
  valleys: [2.0, 2.2, 2.5],
  peaks: [0.5, 3.1],
}

const makeShot = (start) => ({
  index: 1,
  clipId: 'clip-shift',
  name: '同一段表演',
  start,
  end: start + 6,
  duration: 6,
  motion,
  transcript: [
    { start: start + 0.5, end: start + 1.6, text: '你确定要这么做吗？', speaker: 'S1' },
    { start: start + 2.4, end: start + 3.8, text: '我们没有别的选择了。', speaker: 'S2' },
    { start: start + 4.2, end: start + 5.4, text: '上车吧来不及了。', speaker: 'S1' },
  ],
})

const pick = (start) => {
  const plan = planStoryEdit({ shots: [makeShot(start)], targetDuration: 6, options: { minShot: 1.0 } })
  return plan.edits.map((edit) => ({ kind: edit.kind, in: Number(edit.in.toFixed(3)), out: Number(edit.out.toFixed(3)), reason: edit.reason, cutQuality: edit.cutQuality ?? null }))
}

const base = pick(0)
const shifted = pick(40)
assert(base.length === shifted.length, `平移后片段数量应一致：${base.length} vs ${shifted.length}`)
for (let index = 0; index < Math.min(base.length, shifted.length); index += 1) {
  assert(base[index].in === shifted[index].in, `第 ${index + 1} 段入点应不变：${base[index].in} vs ${shifted[index].in}`)
  assert(base[index].out === shifted[index].out, `第 ${index + 1} 段出点应不变：${base[index].out} vs ${shifted[index].out}`)
  assert(base[index].reason === shifted[index].reason, `第 ${index + 1} 段理由应不变`)
  assert(base[index].cutQuality === shifted[index].cutQuality, `第 ${index + 1} 段切点质量应不变：${base[index].cutQuality} vs ${shifted[index].cutQuality}`)
}
if (base.length === 0) { failures += 1; console.log('  FAIL 没有生成任何 edit，无法验证平移不变性') }

if (failures) { console.error(`FAIL story_offset.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log(`PASS story_offset.test.mjs — 源整体平移 40s，${base.length} 段的相对切点/理由/质量完全一致`)
