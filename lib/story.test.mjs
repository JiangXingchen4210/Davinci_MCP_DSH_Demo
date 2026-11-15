/**
 * 剧情剪辑引擎自检：证明三点——
 *  1) 台词句绝不被切断（对比「旧版按均分切」的碎句）
 *  2) 切点落在运动谷值/静止段（不在动作中间）
 *  3) 说话人轮次按时间顺序保留，不前后颠倒
 */

import { normaliseTranscript, buildScript, buildUnits, planStoryEdit, validatePlan, splitSentences } from './story.mjs'

let failures = 0
const assert = (condition, message) => {
  if (!condition) {
    failures += 1
    console.log(`  FAIL ${message}`)
  }
}

// 运动曲线：0–2s 有人在走（能量高），2.0–2.6s 停稳（谷值），2.6–5s 又动
const motionCurve = {
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

const shots = [
  {
    index: 1,
    clipId: 'clip-a',
    name: 'A 走向车',
    start: 10,
    end: 16,
    duration: 6,
    motion: motionCurve,
    transcript: [
      { start: 10.5, end: 11.6, text: '你确定要这么做吗？', speaker: 'S1' },
      { start: 12.4, end: 13.8, text: '我们没有别的选择了。', speaker: 'S2' },
    ],
  },
  {
    index: 2,
    clipId: 'clip-b',
    name: 'B 车旁',
    start: 20,
    end: 24,
    duration: 4,
    motion: { ...motionCurve, stills: [{ start: 21.8, end: 22.4, duration: 0.6 }], valleys: [21.8, 22.2] },
    transcript: [{ start: 20.6, end: 22.2, text: '上车吧，来不及了。', speaker: 'S1' }],
  },
]

// 1) 句子切分
assert(splitSentences('你确定吗？我们没有选择。走！').length === 3, 'splitSentences 应切出 3 句')
// 2) 台词标准化 + 说话人
const normalised = normaliseTranscript(shots[0].transcript)
assert(normalised.length === 2, `标准化后应保留 2 句，实际 ${normalised.length}`)
assert(normalised[0].speaker === 'S1' && normalised[1].speaker === 'S2', '说话人应保留原始标签')
const inferred = normaliseTranscript([
  { start: 0, end: 1, text: '第一句。' },
  { start: 1.5, end: 2.5, text: '第二句。' },
  { start: 3.4, end: 4.2, text: '第三句。' },
])
assert(inferred[0].speaker === 'S1', '无标签时应推断 S1')
assert(inferred[1].speaker === 'S2', `静音+句末应切到 S2，实际 ${inferred[1].speaker}`)
assert(inferred[2].speaker === 'S1' || inferred[2].speaker === 'S2', '第三句应继续推断说话人')

// 3) 剧本
const script = buildScript(shots)
assert(script.lines.length === 3, `剧本应有 3 句台词，实际 ${script.lines.length}`)
assert(script.speakerCount === 2, `应有 2 个说话人，实际 ${script.speakerCount}`)
assert(script.lines[0].text.includes('确定'), '剧本顺序应按镜头/时间排列')

// 4) 单元
const units = buildUnits(shots)
assert(units.some((unit) => unit.kind === 'dialogue'), '应有台词单元')
assert(units.some((unit) => unit.kind === 'silent'), '应有静默动作单元')

// 5) 方案：碎句必须为 0
const plan = planStoryEdit({ shots, targetDuration: 12, options: { minShot: 1.0 } })
const sentenceIssues = plan.diagnostics.issues.filter((issue) => issue.id === 'sentence-split')
assert(sentenceIssues.length === 0, `不应有碎句，实际 ${sentenceIssues.length} 处：${JSON.stringify(sentenceIssues)}`)
const midAction = plan.diagnostics.issues.filter((issue) => issue.id === 'mid-action')
assert(midAction.length === 0, `不应在动作中间切，实际 ${midAction.length} 处：${JSON.stringify(midAction)}`)
assert(plan.edits.length >= 2, `至少应选出 2 刀，实际 ${plan.edits.length}`)
for (const edit of plan.edits) {
  assert(typeof edit.reason === 'string' && edit.reason.length > 4, `每刀都要有可解释理由：${JSON.stringify(edit)}`)
  assert(edit.kind !== 'dialogue' || (edit.text && edit.text.length > 0), '台词刀必须带台词文本')
}
const trueDuration = plan.edits.reduce((acc, edit) => acc + edit.duration, 0)
assert(Math.abs(trueDuration - plan.totalDuration) < 1e-6, 'totalDuration 应与各刀之和一致')
assert(plan.totalDuration <= 12 * 1.25, `总时长不应大幅超出目标：${plan.totalDuration}`)

// 6) 反例：把一句台词硬切成两段，必须被抓出来
const badPlan = {
  edits: [{ index: 1, shotIndex: 1, in: 11.0, out: 11.3, duration: 0.3, kind: 'dialogue', speaker: 'S1', text: '你确定要这么做吗？' }],
  shots,
}
const badDiagnostics = validatePlan({ edits: badPlan.edits, shots })
assert(!badDiagnostics.ok, '碎句方案必须校验失败')
assert(badDiagnostics.issues.some((issue) => issue.id === 'sentence-split'), '碎句方案应报告 sentence-split')

// 7) 说话人顺序：方案里的台词顺序与剧本一致
const planTexts = plan.edits.filter((edit) => edit.text).map((edit) => edit.text)
const scriptTexts = script.lines.map((line) => line.text)
let cursor = 0
for (const text of planTexts) {
  const index = scriptTexts.indexOf(text, cursor)
  assert(index >= cursor, `台词顺序被破坏：「${text}」出现在剧本更早的位置`)
  if (index >= 0) cursor = index + 1
}

console.log('剧本预览：', plan.edits.map((edit) => `${edit.kind === 'dialogue' ? `[${edit.speaker}] ${edit.text.slice(0, 14)}` : '[动作]'}`).join(' | '))
if (failures > 0) {
  console.error(`FAIL story.test.mjs — ${failures} 项断言失败`)
  process.exitCode = 1
} else {
  console.log(
    `PASS story.test.mjs — ${plan.edits.length} 刀、碎句 0、动作中间切 0、台词顺序保持、每刀有理由（总长 ${plan.totalDuration}s / 目标 12s）`,
  )
}
