#!/usr/bin/env node
/**
 * lib/editscore.mjs 自测（无测试框架，`node lib/editscore.test.mjs` 直接跑）。
 *
 * 覆盖（≥10 组）：
 *   1. scoreShots：更锐 → 分更高（单调）
 *   2. scoreShots：更稳（motion 小）→ 分更高
 *   3. scoreShots：黑场低分且 reason 写明「黑场」
 *   4. scoreShots：缺指标 → 分项中性 0.5 且 reasons 说明；breakdown 六项齐全
 *   5. planRhythm：目标时长误差 <10%、切点按节拍整数倍、edits 保持原时序、每刀有 reason
 *   6. planRhythm：低分镜头被 dropped 且 reason 可读
 *   7. planRhythm：pacing（cutsPerMinute/avgShotLength/energyCurve）自洽
 *   8. planRhythm：节奏曲线——开头两刀短、中段长、结尾收
 *   9. planRhythm：bpm 与 beatSeconds 等价
 *  10. planRhythm：目标短于最短镜头 / 节拍长于目标时安全降级
 *  11. planRhythm：不给 scores 时内部调用 scoreShots（黑场被 dropped）
 *  12. 空输入全部安全（scoreShots / planRhythm / narrativeSummary）
 *  13. narrativeSummary：一句话说明含刀数/场数/场标签
 *  14. 三个导出 JSON 安全（无 NaN、可 roundtrip）
 *
 * 退出码 0 = 全部通过并打印 PASS 行；1 = 有失败。
 */

import assert from 'node:assert/strict'

import { narrativeSummary, planRhythm, scoreShots, VERSION } from './editscore.mjs'

// ---------------------------------------------------------------------------
// 测试小工具
// ---------------------------------------------------------------------------

const tests = []

function test(name, fn) {
  tests.push({ name, fn })
}

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: 期望 ≈ ${expected}（±${tolerance}），实际 ${actual}`,
  )
}

function assertJsonSafe(value, trail = '$') {
  if (value === null) return
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${trail}: 出现非有限数字 ${value}`)
    return
  }
  if (typeof value === 'string' || typeof value === 'boolean') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${trail}[${index}]`))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.notEqual(item, undefined, `${trail}.${key}: undefined 无法 JSON 化`)
      assertJsonSafe(item, `${trail}.${key}`)
    }
    return
  }
  assert.fail(`${trail}: 不可 JSON 化的值（${typeof value}）`)
}

function assertJsonRoundTrip(value, label) {
  assertJsonSafe(value, label)
  const text = JSON.stringify(value)
  assert.ok(typeof text === 'string' && text.length > 0, `${label}: JSON.stringify 返回空`)
  assert.deepEqual(JSON.parse(text), value)
}

/** 造一个镜头（单位秒，index 从 1 起）。 */
function makeShot(
  index,
  {
    start = null,
    duration = 3,
    luma = 0.5,
    lumaMin = null,
    lumaMax = null,
    sharpness = 0.7,
    motion = 0.3,
    stability = null,
    sat = 0.3,
    green = 0.02,
    warmth = null,
    black = false,
    metrics = undefined,
  } = {},
) {
  const shot = { index, duration, frames: [] }
  if (start != null) {
    shot.start = start
    shot.end = Number((start + duration).toFixed(3))
  }
  if (black) shot.black = true
  if (metrics !== undefined) {
    shot.metrics = metrics
    return shot
  }
  const built = {
    lumaMean: luma,
    lumaMin: lumaMin != null ? lumaMin : Math.max(0, Number((luma - 0.2).toFixed(4))),
    lumaMax: lumaMax != null ? lumaMax : Math.min(1, Number((luma + 0.2).toFixed(4))),
    saturationMean: sat,
    greenDominance: green,
    sharpness,
    motion,
  }
  if (stability != null) built.stability = stability
  if (warmth != null) built.warmth = warmth
  shot.metrics = built
  return shot
}

function makeLinearShots(count = 8, duration = 6) {
  return Array.from({ length: count }, (_, position) =>
    makeShot(position + 1, { start: position * duration, duration, luma: 0.5, sharpness: 0.75, motion: 0.3 }),
  )
}

const SCORES_18S = Object.freeze({
  1: 0.9,
  2: 0.85,
  3: 0.8,
  4: 0.1, // 低分，应被 dropped
  5: 0.88,
  6: 0.82,
  7: 0.86,
  8: 0.78,
  9: 0.84,
  10: 0.5,
})

// ---------------------------------------------------------------------------
// 1–2. scoreShots 单调性
// ---------------------------------------------------------------------------

test('scoreShots：越锐利分越高（单调）', () => {
  const shots = [0.2, 0.55, 0.9].map((sharpness, position) =>
    makeShot(position + 1, { start: position * 3, sharpness }),
  )
  const scores = scoreShots(shots)
  assert.equal(scores.length, 3)
  assert.ok(scores[2].score > scores[1].score, `0.9 锐应高于 0.55：${scores[2].score} vs ${scores[1].score}`)
  assert.ok(scores[1].score > scores[0].score, `0.55 锐应高于 0.2：${scores[1].score} vs ${scores[0].score}`)
  assert.ok(scores[2].breakdown.sharpness > scores[0].breakdown.sharpness)
  for (const entry of scores) {
    assert.ok(entry.score >= 0 && entry.score <= 1, `分数越界：${entry.score}`)
  }
})

test('scoreShots：越稳（motion 越小）分越高', () => {
  const motions = [0.9, 0.5, 0.05]
  const shots = motions.map((motion, position) =>
    makeShot(position + 1, { start: position * 3, motion }),
  )
  const scores = scoreShots(shots)
  assert.ok(
    scores[2].score > scores[1].score && scores[1].score > scores[0].score,
    `更稳应更高分：${scores.map((entry) => entry.score).join(' / ')}`,
  )
  assert.ok(scores[2].breakdown.stability > scores[0].breakdown.stability)
})

test('scoreShots：stability 指标优先于 motion，motionIsStability 可反转', () => {
  const withStability = [
    makeShot(1, { start: 0, stability: 0.9, motion: 0.8 }),
    makeShot(2, { start: 3, stability: 0.2, motion: 0.1 }),
  ]
  const scores = scoreShots(withStability)
  assert.equal(scores[0].breakdown.stability, 0.9, '有 stability 指标时应直接采用')
  assert.equal(scores[1].breakdown.stability, 0.2)
  // 只有 motion 时：默认「越大越不稳」，motionIsStability=true 时把 motion 当稳定度
  const onlyMotion = [
    makeShot(3, { start: 0, motion: 0.1 }),
    makeShot(4, { start: 3, motion: 0.1 }),
  ]
  assertClose(scoreShots(onlyMotion)[0].breakdown.stability, 0.9, 1e-9, 'motion 0.1 取反')
  const inverted = scoreShots(onlyMotion, { motionIsStability: true })
  assertClose(inverted[0].breakdown.stability, 0.1, 1e-9, 'motionIsStability 时 motion 即稳定度')
})

// ---------------------------------------------------------------------------
// 3. 黑场
// ---------------------------------------------------------------------------

test('scoreShots：黑场低分且 reason 写明「黑场」', () => {
  const shots = [
    makeShot(1, { start: 0, luma: 0.01, lumaMin: 0, lumaMax: 0.02 }),
    makeShot(2, { start: 3, luma: 0.5 }),
  ]
  const scores = scoreShots(shots)
  assert.ok(scores[0].score < 0.2, `黑场分数应很低，实际 ${scores[0].score}`)
  assert.ok(scores[0].score < scores[1].score)
  assert.ok(scores[0].reasons.some((reason) => reason.includes('黑场')), JSON.stringify(scores[0].reasons))
})

test('scoreShots：缺失指标给中性 0.5 且 reasons 说明，breakdown 六项齐全', () => {
  const scores = scoreShots([makeShot(1, { start: 0, metrics: {} })])
  assert.equal(scores.length, 1)
  const { breakdown, reasons } = scores[0]
  assert.deepEqual(Object.keys(breakdown).sort(), [
    'duration',
    'exposure',
    'motion',
    'sharpness',
    'stability',
    'toneConsistency',
  ])
  for (const key of ['sharpness', 'exposure', 'stability', 'motion', 'toneConsistency']) {
    assert.equal(breakdown[key], 0.5, `${key} 应为中性 0.5`)
  }
  assert.equal(breakdown.duration, 1, '时长 3s 在理想区间内应为 1')
  assert.ok(scores[0].score > 0.5 && scores[0].score < 0.6, `中性分应约 0.56，实际 ${scores[0].score}`)
  const joined = reasons.join('\n')
  for (const word of ['清晰度', '曝光', '稳定度', '运动量', '色调一致性']) {
    assert.ok(joined.includes(word), `reasons 缺少 ${word}：${joined}`)
  }
  assert.ok(joined.includes('中性'), 'reasons 应说明取中性')
})

// ---------------------------------------------------------------------------
// 5–7. planRhythm 主流程
// ---------------------------------------------------------------------------

test('planRhythm：目标 18s / 0.5s 节拍 —— 误差 <10%、时长是节拍整数倍、保持原时序、每刀有 reason', () => {
  const shots = makeLinearShots(10, 3)
  const plan = planRhythm({
    shots,
    scores: { ...SCORES_18S },
    targetDuration: 18,
    beatSeconds: 0.5,
  })
  assert.ok(plan.edits.length >= 3, `至少 3 刀，实际 ${plan.edits.length}`)
  // 原时序
  const indices = plan.edits.map((edit) => edit.shotIndex)
  assert.deepEqual(indices, indices.slice().sort((left, right) => left - right), `应保持原时序：${indices}`)
  // 目标误差 <10%
  assertClose(plan.totalDuration, 18, 1.8, '总时长')
  assert.ok(Math.abs(plan.totalDuration - 18) / 18 < 0.1, `误差应 <10%，实际 ${plan.totalDuration}`)
  // 每刀：节拍整数倍、reason 有「高分」、in/out 自洽
  for (const edit of plan.edits) {
    const beats = edit.duration / 0.5
    assert.ok(Math.abs(beats - Math.round(beats)) < 1e-6, `duration ${edit.duration} 不是 0.5 的整数倍`)
    assert.ok(Math.round(beats) >= 1, '至少 1 个节拍')
    assert.ok(typeof edit.reason === 'string' && edit.reason.includes('高分'), edit.reason)
    assert.ok(edit.reason.includes('对齐 0.5s 节拍'), edit.reason)
    assertClose(edit.out, edit.in + edit.duration, 1e-6, `out ≠ in + duration（shot ${edit.shotIndex}）`)
    assert.ok(edit.score >= 0 && edit.score <= 1)
  }
  // 总时长 == 各刀之和
  const sum = plan.edits.reduce((total, edit) => total + edit.duration, 0)
  assertClose(plan.totalDuration, sum, 1e-6, 'totalDuration 应等于各刀之和')
  // 节拍信息
  assert.equal(plan.pacing.beatSeconds, 0.5)
  assert.ok(plan.notes.some((note) => note.includes('节拍')), JSON.stringify(plan.notes))
  assertJsonRoundTrip(plan)
})

test('planRhythm：低分镜头被 dropped 且 reason 可读', () => {
  const shots = makeLinearShots(10, 3)
  const plan = planRhythm({
    shots,
    scores: { ...SCORES_18S },
    targetDuration: 18,
    beatSeconds: 0.5,
  })
  const dropped = plan.dropped.find((item) => item.shotIndex === 4)
  assert.ok(dropped, `shot 4（分数 0.1）应被 dropped，实际 ${JSON.stringify(plan.dropped)}`)
  assert.equal(dropped.stage, 'low-score')
  assert.ok(dropped.reason.includes('分数'), dropped.reason)
  assert.ok(dropped.reason.includes('0.10'), dropped.reason)
  // 没被选中的镜头也不能凭空出现
  const picked = new Set(plan.edits.map((edit) => edit.shotIndex))
  for (const item of plan.dropped) {
    assert.ok(!picked.has(item.shotIndex), `dropped 却出现在 edits：${item.shotIndex}`)
  }
})

test('planRhythm：pacing（cutsPerMinute / avgShotLength / energyCurve）自洽且可展示', () => {
  const shots = makeLinearShots(8, 6)
  const plan = planRhythm({ shots, targetDuration: 30, beatSeconds: 0.5 })
  const { pacing } = plan
  assertClose(pacing.cutsPerMinute, (Math.max(0, plan.edits.length - 1) / plan.totalDuration) * 60, 0.02, 'cutsPerMinute（按相邻镜头边界计数）')
  assertClose(pacing.avgShotLength, plan.totalDuration / plan.edits.length, 0.01, 'avgShotLength')
  assert.equal(pacing.energyCurve.length, plan.edits.length, 'energyCurve 应与 edits 一一对应')
  for (const energy of pacing.energyCurve) {
    assert.ok(energy > 0 && energy <= 1, `energy 应在 (0,1]：${energy}`)
  }
  // 更短的镜头 → 能量更高
  const sortedByDuration = plan.edits
    .map((edit, position) => ({ duration: edit.duration, energy: pacing.energyCurve[position] }))
    .sort((left, right) => left.duration - right.duration)
  assert.ok(
    sortedByDuration[0].energy >= sortedByDuration[sortedByDuration.length - 1].energy,
    '越短能量应越高',
  )
  assert.ok(pacing.cutsPerMinute > 0 && pacing.cutsPerMinute < 120, `cutsPerMinute 应在合理区间：${pacing.cutsPerMinute}`)
})

// ---------------------------------------------------------------------------
// 8. 节奏曲线
// ---------------------------------------------------------------------------

test('planRhythm：节奏曲线——开头两刀短、中段长、结尾收', () => {
  const shots = makeLinearShots(8, 6)
  const plan = planRhythm({ shots, targetDuration: 30, beatSeconds: 0.5 })
  const durations = plan.edits.map((edit) => edit.duration)
  assert.equal(durations.length, 8, `目标 30s / 6s 素材应排 8 刀，实际 ${durations.length}`)
  const middle = durations.slice(2, -1)
  assert.ok(durations[0] < Math.max(...middle), `开场 ${durations[0]}s 应短于中段 ${Math.max(...middle)}s`)
  assert.ok(durations[1] < Math.max(...middle), `第二刀 ${durations[1]}s 也应偏短`)
  assert.ok(durations[durations.length - 1] < Math.max(...middle), `结尾 ${durations[durations.length - 1]}s 应收住`)
  assert.ok(
    plan.edits[0].reason.includes('开场快切'),
    `第一刀 reason 应说明开场快切：${plan.edits[0].reason}`,
  )
  assert.ok(
    plan.edits[plan.edits.length - 1].reason.includes('结尾收束'),
    `最后一刀 reason 应说明结尾收束：${plan.edits[plan.edits.length - 1].reason}`,
  )
  assertClose(plan.totalDuration, 30, 3, '总时长')
})

// ---------------------------------------------------------------------------
// 9. bpm 等价
// ---------------------------------------------------------------------------

test('planRhythm：bpm=120 与 beatSeconds=0.5 结果一致', () => {
  const shots = makeLinearShots(10, 3)
  const viaBpm = planRhythm({
    shots,
    scores: { ...SCORES_18S },
    targetDuration: 18,
    bpm: 120,
  })
  const viaBeat = planRhythm({
    shots,
    scores: { ...SCORES_18S },
    targetDuration: 18,
    beatSeconds: 0.5,
  })
  assert.equal(viaBpm.pacing.beatSeconds, 0.5)
  assert.deepEqual(
    viaBpm.edits.map((edit) => edit.duration),
    viaBeat.edits.map((edit) => edit.duration),
  )
  assert.deepEqual(
    viaBpm.edits.map((edit) => edit.reason),
    viaBeat.edits.map((edit) => edit.reason),
  )
})

// ---------------------------------------------------------------------------
// 10. 边界：目标过短 / 节拍过长
// ---------------------------------------------------------------------------

test('planRhythm：目标短于最短镜头时安全降级为 1 刀', () => {
  const shots = makeLinearShots(3, 3)
  const plan = planRhythm({ shots, targetDuration: 0.5, minShot: 1 })
  assert.equal(plan.edits.length, 1, `应出 1 刀，实际 ${plan.edits.length}`)
  assert.ok(plan.edits[0].duration <= 0.6, `时长应贴近 0.5s，实际 ${plan.edits[0].duration}`)
  assert.ok(plan.totalDuration <= 0.6)
})

test('planRhythm：节拍长于目标时不做节拍对齐并说明原因', () => {
  const shots = makeLinearShots(3, 3)
  const plan = planRhythm({ shots, targetDuration: 2, beatSeconds: 3 })
  assert.ok(plan.edits.length >= 1)
  assert.ok(plan.notes.some((note) => note.includes('未做节拍对齐')), JSON.stringify(plan.notes))
  const beats = plan.edits[0].duration / 3
  assert.ok(Math.abs(beats - Math.round(beats)) > 1e-6, '不该被对齐到 3s 节拍')
})

test('planRhythm：全部低于阈值 → 0 刀且 dropped 带原因', () => {
  const shots = makeLinearShots(4, 3)
  const scores = { 1: 0.2, 2: 0.21, 3: 0.19, 4: 0.22 }
  const plan = planRhythm({ shots, scores, targetDuration: 6, minScore: 0.9 })
  assert.deepEqual(plan.edits, [])
  assert.equal(plan.totalDuration, 0)
  assert.equal(plan.dropped.length, 4)
  for (const item of plan.dropped) {
    assert.equal(item.stage, 'low-score')
    assert.ok(item.reason.includes('分数'))
  }
  assert.equal(plan.pacing.cutsPerMinute, 0)
  assert.deepEqual(plan.pacing.energyCurve, [])
})

// ---------------------------------------------------------------------------
// 11. 不给 scores 时内部打分
// ---------------------------------------------------------------------------

test('planRhythm：不给 scores 时内部调用 scoreShots，黑场镜头被 dropped', () => {
  const shots = [
    makeShot(1, { start: 0, luma: 0.5 }),
    makeShot(2, { start: 3, luma: 0.01, lumaMin: 0, lumaMax: 0.02 }), // 黑场
    makeShot(3, { start: 6, luma: 0.48 }),
    makeShot(4, { start: 9, luma: 0.52 }),
    makeShot(5, { start: 12, luma: 0.5 }),
    makeShot(6, { start: 15, luma: 0.49 }),
  ]
  const plan = planRhythm({ shots, targetDuration: 12 })
  const blackDropped = plan.dropped.find((item) => item.shotIndex === 2)
  assert.ok(blackDropped, `黑场镜头应被 dropped：${JSON.stringify(plan.dropped)}`)
  assert.equal(blackDropped.stage, 'low-score')
  assert.ok(plan.edits.length >= 1)
  for (const edit of plan.edits) {
    assert.ok(edit.score >= 0 && edit.score <= 1)
    assert.ok(edit.reason.length > 0)
  }
  assert.ok(!plan.edits.some((edit) => edit.shotIndex === 2), '黑场不该出现在成片里')
})

// ---------------------------------------------------------------------------
// 12. 空输入
// ---------------------------------------------------------------------------

test('空输入：scoreShots / planRhythm / narrativeSummary 全部安全', () => {
  assert.deepEqual(scoreShots([]), [])
  assert.deepEqual(scoreShots(null), [])
  for (const plan of [planRhythm({}), planRhythm({ shots: [] }), planRhythm()]) {
    assert.deepEqual(plan.edits, [])
    assert.equal(plan.totalDuration, 0)
    assert.equal(plan.pacing.cutsPerMinute, 0)
    assert.equal(plan.pacing.avgShotLength, 0)
    assert.deepEqual(plan.pacing.energyCurve, [])
    assert.deepEqual(plan.dropped, [])
    assertJsonRoundTrip(plan)
  }
  const emptySummary = narrativeSummary({ edits: [], scenes: null })
  assert.equal(typeof emptySummary, 'string')
  assert.ok(emptySummary.includes('没有可用镜头'), emptySummary)
})

// ---------------------------------------------------------------------------
// 13. narrativeSummary
// ---------------------------------------------------------------------------

test('narrativeSummary：一句话含刀数 / 场数 / 首尾场标签', () => {
  const shots = makeLinearShots(10, 3)
  const plan = planRhythm({ shots, scores: { ...SCORES_18S }, targetDuration: 18, beatSeconds: 0.5 })
  const scenes = [
    { index: 0, label: '沙漠 · 白天 · 人物行走', shots: [1, 2, 3] },
    { index: 1, label: '城市 · 夜晚 · 人物坐在吧台前', shots: [4, 5, 6] },
  ]
  const summary = narrativeSummary({ edits: plan.edits, scenes })
  assert.ok(summary.includes(`${plan.edits.length} 刀`), summary)
  assert.ok(summary.includes('覆盖 2 场戏'), summary)
  assert.ok(summary.includes('沙漠 · 白天 · 人物行走'), summary)
  assert.ok(summary.includes('城市 · 夜晚 · 人物坐在吧台前'), summary)
  assert.ok(summary.endsWith('。'), summary)
  // 也接受 groupScenes 的返回对象
  const fromGrouped = narrativeSummary({ edits: plan.edits, scenes: { sceneCount: 2, scenes } })
  assert.ok(fromGrouped.includes('覆盖 2 场戏'), fromGrouped)
  // 没有 scenes 也能用
  const plain = narrativeSummary({ edits: plan.edits })
  assert.ok(plain.includes('刀'), plain)
  assert.ok(!plain.includes('覆盖'), plain)
})

// ---------------------------------------------------------------------------
// 14. JSON 安全
// ---------------------------------------------------------------------------

test('三个导出结果 JSON 安全（无 NaN / undefined，可 roundtrip）', () => {
  const shots = makeLinearShots(10, 3)
  const scores = scoreShots(shots)
  assertJsonRoundTrip(scores, 'scoreShots')
  const plan = planRhythm({ shots, targetDuration: 18, beatSeconds: 0.5 })
  assertJsonRoundTrip(plan, 'planRhythm')
  assertJsonRoundTrip({ summary: narrativeSummary({ edits: plan.edits }) }, 'narrativeSummary')
})

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------

async function main() {
  let passed = 0
  const failures = []
  const startedAt = performance.now()

  for (const { name, fn } of tests) {
    try {
      await fn()
      passed += 1
      process.stdout.write(`ok   ${name}\n`)
    } catch (error) {
      failures.push({ name, error })
      process.stdout.write(`FAIL ${name}\n     ${error?.message ?? error}\n`)
    }
  }

  const elapsed = performance.now() - startedAt
  process.stdout.write('\n')
  if (failures.length > 0) {
    process.stdout.write(
      `FAIL editscore.test.mjs — ${passed}/${tests.length} 通过，${failures.length} 失败（${elapsed.toFixed(0)}ms）\n`,
    )
    for (const { name, error } of failures) {
      process.stdout.write(`  - ${name}: ${error?.message ?? error}\n`)
    }
    return 1
  }

  const demoShots = makeLinearShots(10, 3)
  const demo = planRhythm({ shots: demoShots, scores: { ...SCORES_18S }, targetDuration: 18, beatSeconds: 0.5 })
  const scores = scoreShots(demoShots)
  process.stdout.write(
    `PASS editscore.test.mjs — ${tests.length}/${tests.length} 项通过（${VERSION}，${elapsed.toFixed(0)}ms）\n`,
  )
  process.stdout.write(
    `     打分示例：shot1=${scores[0].score}（${scores[0].breakdown.sharpness} 锐 / ${scores[0].breakdown.stability} 稳）` +
      `  shot2 黑场样例略\n`,
  )
  process.stdout.write(
    `     planRhythm(target=18s, beat=0.5s)：${demo.edits.length} 刀 / ${demo.totalDuration}s，` +
      `cutsPerMinute=${demo.pacing.cutsPerMinute}，avgShotLength=${demo.pacing.avgShotLength}s\n`,
  )
  process.stdout.write(
    `     edits[0]=${JSON.stringify(demo.edits[0])}\n` +
      `     edits[1]=${JSON.stringify(demo.edits[1])}\n`,
  )
  process.stdout.write(`     dropped=${JSON.stringify(demo.dropped.map((item) => ({ shotIndex: item.shotIndex, stage: item.stage })))}\n`)
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`测试基础设施失败：${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
