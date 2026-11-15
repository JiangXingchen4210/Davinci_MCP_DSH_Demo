#!/usr/bin/env node
/**
 * lib/edit3.mjs 自测（无测试框架，`node lib/edit3.test.mjs` 直接跑）。
 *
 * 覆盖：
 *   - planSelects：6 个假镜头（黑场 / 极糊 / 过短 / 3 个可用）→ 黑场与极糊被剔除，
 *     totalDuration 命中 targetDuration，每条 edit 都有可解释 reason
 *   - planSelects：按目标时长截断、单镜上限截断、剩余时长不足最小镜头时跳过
 *   - planSelects：preferSharp 重排（清晰度高的在前），默认保留原时序
 *   - planSelects：空输入 / 字段缺失 / JSON 安全
 *   - planScenes：按输入 sceneBoundary 归并 3 场；无边界时合成 1 场
 *   - planScenes：dominantTone（green/warm/dark）与 activity（low/medium/high）
 *   - planScenes：输入已是场景数组时只汇总、不重新切分；空输入
 *
 * 退出码 0 = 全部通过并打印 PASS 行；1 = 有失败。
 */

import assert from 'node:assert/strict'

import { planScenes, planSelects, VERSION } from './edit3.mjs'

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

// ---------------------------------------------------------------------------
// 测试数据：6 个镜头（0 黑场 / 1 极糊 / 2 过短 / 3-5 可用）
// ---------------------------------------------------------------------------

function makeShots() {
  return [
    { index: 0, duration: 1.0, metrics: { meanLuma: 0.01, sharpness: 0.5 } }, // 黑场
    { index: 1, duration: 2.0, metrics: { meanLuma: 0.4, sharpness: 0.05 } }, // 极糊
    { index: 2, duration: 0.2, metrics: { meanLuma: 0.4, sharpness: 0.6 } }, // 过短
    { index: 3, duration: 2.0, metrics: { meanLuma: 0.42, sharpness: 0.62 } },
    { index: 4, duration: 2.5, metrics: { meanLuma: 0.38, sharpness: 0.55 } },
    { index: 5, duration: 8.0, metrics: { meanLuma: 0.5, sharpness: 0.7 } },
  ]
}

// ---------------------------------------------------------------------------
// planSelects
// ---------------------------------------------------------------------------

test('planSelects：剔除黑场/极糊/过短，totalDuration 命中 targetDuration', () => {
  const result = planSelects({ shots: makeShots(), targetDuration: 6 })
  const editIndices = result.edits.map((edit) => edit.shotIndex)
  assert.deepEqual(editIndices, [3, 4, 5], `可用镜头应是 3/4/5，实际 ${editIndices}`)

  const droppedIndices = result.dropped.map((entry) => entry.shotIndex).sort()
  assert.deepEqual(droppedIndices, [0, 1, 2], `应剔除 0/1/2，实际 ${droppedIndices}`)

  const stages = new Set(result.dropped.map((entry) => entry.stage))
  assert.ok(stages.has('black'), '应记录黑场剔除')
  assert.ok(stages.has('blurry'), '应记录极糊剔除')
  assert.ok(stages.has('too-short'), '应记录过短剔除')

  assertClose(result.totalDuration, 6, 1e-6, 'totalDuration')
  assert.equal(result.targetDuration, 6)

  // 每条 edit 必须可解释：reason 非空，in/out 与 duration 自洽
  for (const edit of result.edits) {
    assert.ok(typeof edit.reason === 'string' && edit.reason.length > 0, `shot ${edit.shotIndex} 缺少 reason`)
    assertClose(edit.out - edit.in, edit.duration, 1e-6, `shot ${edit.shotIndex} out-in`)
  }
  // 最后一个镜头被目标时长截断，reason 要说明
  const last = result.edits[result.edits.length - 1]
  assert.equal(last.shotIndex, 5)
  assertClose(last.duration, 1.5, 1e-6, 'shot5 被截断到 1.5s')
  assert.match(last.reason, /截断/, `截断原因应写进 reason，实际：${last.reason}`)
  assert.ok(result.notes.some((note) => note.includes('命中目标')), 'notes 应说明总时长命中目标')
})

test('planSelects：dropped 的 reason 可读（含具体数值）', () => {
  const result = planSelects({ shots: makeShots() })
  const byIndex = new Map(result.dropped.map((entry) => [entry.shotIndex, entry]))
  assert.match(byIndex.get(0).reason, /黑场/)
  assert.match(byIndex.get(1).reason, /极糊/)
  assert.match(byIndex.get(2).reason, /过短/)
  for (const entry of result.dropped) {
    assert.ok(Number.isFinite(entry.shotIndex), 'dropped 必须带 shotIndex')
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 8, `reason 太短：${entry.reason}`)
    assert.ok(typeof entry.stage === 'string' && entry.stage.length > 0)
  }
})

test('planSelects：默认保留原时序（shotIndex 递增）', () => {
  const result = planSelects({ shots: makeShots(), targetDuration: 6 })
  const indices = result.edits.map((edit) => edit.shotIndex)
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), '默认必须保留原时序')
})

test('planSelects：preferSharp 按清晰度从高到低重排', () => {
  const result = planSelects({ shots: makeShots(), preferSharp: true })
  const indices = result.edits.map((edit) => edit.shotIndex)
  // 清晰度：shot5 0.70 > shot3 0.62 > shot4 0.55
  assert.deepEqual(indices, [5, 3, 4], `应按清晰度排序，实际 ${indices}`)
  assert.ok(result.notes.some((note) => note.includes('preferSharp')), 'notes 应说明重排')
})

test('planSelects：maxShotDuration 截断超长镜头', () => {
  const result = planSelects({ shots: makeShots(), maxShotDuration: 4 })
  const shot5 = result.edits.find((edit) => edit.shotIndex === 5)
  assert.ok(shot5, 'shot5 应仍在结果里')
  assertClose(shot5.duration, 4, 1e-6, 'shot5 应被截到 4s')
  assert.match(shot5.reason, /单镜上限/)
})

test('planSelects：目标时长太小 → 后续镜头以 target 阶段略过', () => {
  const result = planSelects({ shots: makeShots(), targetDuration: 2 })
  assert.equal(result.edits.length, 1)
  assert.equal(result.edits[0].shotIndex, 3)
  const targetDrops = result.dropped.filter((entry) => entry.stage === 'target')
  assert.equal(targetDrops.length, 2, `应略过 2 个镜头，实际 ${targetDrops.length}`)
  assertClose(result.totalDuration, 2, 1e-6, 'totalDuration')
})

test('planSelects：空输入 / 字段缺失 / 非法时长不崩', () => {
  const empty = planSelects({})
  assert.deepEqual(empty.edits, [])
  assert.equal(empty.totalDuration, 0)
  assert.deepEqual(empty.dropped, [])

  const broken = planSelects({
    shots: [
      {},
      { duration: 0 },
      { duration: -3 },
      { duration: 2 }, // 无 metrics → 不可判黑场/糊，保留
      { start: 1, end: 4, metrics: { meanLuma: 0.5 } }, // 用 start/end 推时长
    ],
  })
  assert.equal(broken.edits.length, 2, `只有 2 个可用，实际 ${JSON.stringify(broken.edits)}`)
  assert.ok(broken.dropped.length >= 3)
  // start/end 推出的镜头 in 点应等于 start
  const fromRange = broken.edits.find((edit) => edit.shotIndex === 4)
  assertClose(fromRange.in, 1, 1e-6, 'start/end 镜头的 in 点')
  assertClose(fromRange.duration, 3, 1e-6, 'start/end 镜头的时长')
})

test('planSelects：输出 JSON 安全（无 NaN/Infinity/undefined）', () => {
  const cases = [
    planSelects({ shots: makeShots(), targetDuration: 6 }),
    planSelects({ shots: makeShots(), preferSharp: true, maxShotDuration: 3 }),
    planSelects({ shots: makeShots(), targetDuration: 2 }),
    planSelects({ shots: [] }),
  ]
  assertJsonRoundTrip(cases, 'planSelects 全部样本')
})

// ---------------------------------------------------------------------------
// planScenes
// ---------------------------------------------------------------------------

function makeSceneShots() {
  return [
    { index: 0, duration: 2, sceneBoundary: true, metrics: { greenDominance: 0.7, meanLuma: 0.3, motion: 0.2 } },
    { index: 1, duration: 2, metrics: { greenDominance: 0.6, meanLuma: 0.32, motion: 0.25 } },
    { index: 2, duration: 3, sceneBoundary: true, metrics: { warmth: 0.3, meanLuma: 0.5, motion: 0.5 } },
    { index: 3, duration: 3, metrics: { warmth: 0.35, meanLuma: 0.52, motion: 0.55 } },
    { index: 4, duration: 1.5, sceneBoundary: true, metrics: { meanLuma: 0.15, motion: 0.8 } },
    { index: 5, duration: 1.5, metrics: { meanLuma: 0.18, motion: 0.85 } },
  ]
}

test('planScenes：按 sceneBoundary 归并 3 场', () => {
  const result = planScenes(makeSceneShots())
  assert.equal(result.sceneCount, 3, `应为 3 场，实际 ${result.sceneCount}`)
  assert.deepEqual(result.scenes.map((scene) => scene.shots), [[0, 1], [2, 3], [4, 5]])
  assert.deepEqual(result.scenes.map((scene) => scene.shotCount), [2, 2, 2])
  assert.deepEqual(result.scenes.map((scene) => scene.index), [0, 1, 2])
  assert.ok(result.notes.some((note) => note.includes('sceneBoundary')), 'notes 应说明按边界归并')
  assert.ok(result.notes.some((note) => note.includes('未用色调相似度猜测')), 'notes 应说明没有猜切点')
})

test('planScenes：dominantTone / activity 汇总正确', () => {
  const result = planScenes(makeSceneShots())
  assert.equal(result.scenes[0].dominantTone, 'green', '第 1 场应判绿调')
  assert.equal(result.scenes[0].activity, 'low', 'motion 0.2 应是 low')
  assert.equal(result.scenes[1].dominantTone, 'warm', '第 2 场应判暖调')
  assert.equal(result.scenes[1].activity, 'medium', 'motion 0.5 应是 medium')
  assert.equal(result.scenes[2].dominantTone, 'dark', '第 3 场亮度 0.15 应判暗调')
  assert.equal(result.scenes[2].activity, 'high', 'motion 0.8 应是 high')
  assertClose(result.scenes[0].duration, 4, 1e-6, '第 1 场时长')
})

test('planScenes：没有 sceneBoundary → 只合成 1 场', () => {
  const shots = makeSceneShots().map(({ sceneBoundary, ...rest }) => rest)
  const result = planScenes(shots)
  assert.equal(result.sceneCount, 1)
  assert.equal(result.scenes[0].shotCount, shots.length)
  assert.deepEqual(result.scenes[0].shots, [0, 1, 2, 3, 4, 5])
})

test('planScenes：首个镜头带 sceneBoundary 不会切出空场', () => {
  const shots = [
    { index: 0, duration: 1, sceneBoundary: true, metrics: { meanLuma: 0.5 } },
    { index: 1, duration: 1, metrics: { meanLuma: 0.5 } },
  ]
  const result = planScenes(shots)
  assert.equal(result.sceneCount, 1)
  assert.deepEqual(result.scenes[0].shots, [0, 1])
})

test('planScenes：输入已是场景数组（每项带 shots）→ 只汇总不重切', () => {
  const scenes = [
    { shots: [{ duration: 2, metrics: { warmth: 0.3, motion: 0.1 } }, { duration: 3, metrics: { warmth: 0.2, motion: 0.2 } }] },
    { shots: [{ duration: 1, metrics: { greenDominance: 0.9, motion: 0.9 } }] },
  ]
  const result = planScenes(scenes)
  assert.equal(result.sceneCount, 2)
  assert.equal(result.scenes[0].shotCount, 2)
  assert.equal(result.scenes[1].shotCount, 1)
  assert.equal(result.scenes[1].dominantTone, 'green')
  assert.ok(result.notes.some((note) => note.includes('不再归并')), 'notes 应说明沿用原切分')
})

test('planScenes：空输入不崩，JSON 安全', () => {
  const empty = planScenes([])
  assert.equal(empty.sceneCount, 0)
  assert.deepEqual(empty.scenes, [])
  assert.ok(empty.notes.length > 0)

  const noMetrics = planScenes([{ index: 0, duration: 2 }, { index: 1, duration: 2 }])
  assert.equal(noMetrics.sceneCount, 1)
  assert.equal(noMetrics.scenes[0].dominantTone, 'unknown')
  assert.equal(noMetrics.scenes[0].activity, 'unknown')
  assertJsonRoundTrip([empty, noMetrics, planScenes(makeSceneShots())], 'planScenes 全部样本')
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
      `FAIL edit3.test.mjs — ${passed}/${tests.length} 通过，${failures.length} 失败（${elapsed.toFixed(0)}ms）\n`,
    )
    for (const { name, error } of failures) {
      process.stdout.write(`  - ${name}: ${error?.message ?? error}\n`)
    }
    return 1
  }

  // 汇报用的实测输出
  const selects = planSelects({ shots: makeShots(), targetDuration: 6 })
  const scenes = planScenes(makeSceneShots())
  process.stdout.write(
    `PASS edit3.test.mjs — ${tests.length}/${tests.length} 项通过（${VERSION}，${elapsed.toFixed(0)}ms）\n`,
  )
  process.stdout.write(
    `     planSelects(target=6s)：保留 ${JSON.stringify(selects.edits.map((e) => e.shotIndex))}，` +
      `剔除 ${JSON.stringify(selects.dropped.map((d) => d.shotIndex))}，totalDuration=${selects.totalDuration}s\n`,
  )
  process.stdout.write(
    `     planScenes：${scenes.sceneCount} 场 → ${JSON.stringify(
      scenes.scenes.map((scene) => ({ shots: scene.shots, tone: scene.dominantTone, activity: scene.activity })),
    )}\n`,
  )
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
