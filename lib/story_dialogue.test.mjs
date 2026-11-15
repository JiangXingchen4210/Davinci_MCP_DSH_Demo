/** 台词完整性自检：场记口令不算台词；所有台词必须进成片（宁可超时长也不漏）。 */
import { isCueLine, buildScript, dialogueInventory, planStoryEdit } from './story.mjs'

let failures = 0
const assert = (condition, message) => { if (!condition) { failures += 1; console.log(`  FAIL ${message}`) } }

// 1) 场记口令识别：不能误杀正常台词
for (const cue of ['Rolling', 'Rolling!', 'Action', 'Cut', '开机', '保一条', 'NG', '一二三']) {
  assert(isCueLine(cue), `应识别为口令：${cue}`)
}
for (const line of ['走吧', '开始做吧', '我们走吧', '你确定要这么做吗', 'Cut the rope']) {
  assert(!isCueLine(line), `不应识别为口令：${line}`)
}

// 2) 剧本：口令进 lines 但不进台词覆盖率
const shots = [
  { index: 1, clipId: 'A', start: 0, end: 12, duration: 12, recordStart: 86400, transcript: [
    { start: 0.5, end: 1.2, text: 'Rolling', speaker: 'S1' },
    { start: 1.5, end: 3.0, text: '你确定要这么做吗', speaker: 'S1' },
    { start: 3.5, end: 5.0, text: '我们没有别的选择了', speaker: 'S2' },
    { start: 5.5, end: 7.0, text: '上车吧来不及了', speaker: 'S1' },
  ]},
  { index: 2, clipId: 'B', start: 0, end: 12, duration: 12, recordStart: 86400 + 288, transcript: [
    { start: 0.5, end: 1.0, text: '开机', speaker: 'S1' },
    { start: 1.5, end: 3.0, text: '再等我一分钟', speaker: 'S2' },
    { start: 3.5, end: 5.5, text: '我要打个电话', speaker: 'S2' },
    { start: 6.0, end: 8.0, text: '好', speaker: 'S1' },
    { start: 8.5, end: 10.0, text: '你叫什么名字', speaker: 'S1' },
  ]},
]
const script = buildScript(shots, { fps: 24 })
console.log('lines:', script.lines.length, '| cues:', script.cueCount, '| dialogue:', script.dialogueLines.length)
assert(script.cueCount === 3, `应识别出 3 句口令（Rolling/开机/好），实际 ${script.cueCount}`)
const inventory = dialogueInventory(shots)
console.log('inventory:', inventory.map((line) => line.text))
assert(!inventory.some((line) => /rolling|开机/i.test(line.text)), '口令不能进入台词清单')
assert(inventory.filter((line) => /你确定|别的选择|上车|再等|电话|名字/.test(line.text)).length >= 6, '真台词应全部进入清单')

// 3) 漏台词修复：目标时长故意很小，所有台词仍必须进成片
const plan = planStoryEdit({ shots, targetDuration: 6, options: { fps: 24 } })
const texts = plan.edits.filter((edit) => edit.kind === 'dialogue').map((edit) => edit.text)
console.log('edits:', plan.edits.map((edit) => `${edit.shotIndex}:${(edit.text ?? '').slice(0, 8)}`))
console.log('coverage:', JSON.stringify(plan.coverage), '| dropped:', plan.droppedDialogue.map((line) => line.text), '| total:', plan.totalDuration)
assert(plan.coverage.ratio === 1, `台词覆盖率必须 1.0，实际 ${plan.coverage.ratio}`)
assert(plan.droppedDialogue.length === 0, `不能漏台词，实际漏 ${plan.droppedDialogue.length} 句`)
for (const must of ['你确定要这么做吗', '我们没有别的选择了', '上车吧来不及了', '再等我一分钟', '我要打个电话', '你叫什么名字']) {
  assert(texts.some((text) => text && text.includes(must.slice(0, 4))), `成片里缺台词：${must}`)
}
assert(plan.totalDuration > 6, `为了保台词应超过目标时长（实际 ${plan.totalDuration}s / 目标 6s）`)

if (failures > 0) { console.error(`FAIL story_dialogue.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log(`PASS story_dialogue.test.mjs — 口令 ${script.cueCount} 句已排除；6 句台词 100% 进成片（超时长 ${plan.totalDuration}s/6s）`)
