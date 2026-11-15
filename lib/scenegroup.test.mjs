#!/usr/bin/env node
/**
 * lib/scenegroup.mjs 自测（无测试框架，`node lib/scenegroup.test.mjs` 直接跑）。
 *
 * 覆盖（≥8 组）：
 *   1. 同 location 同色调 → 合并成 1 场
 *   2. location 变 → 必分场
 *   3. 相邻 lumaMean 跳变 > 0.18 → 必分场
 *   4. dominantTone 变（暖 → 绿）→ 必分场
 *   5. 时间间隔规则：> 120s 软边界分场；60s 内不切
 *   6. label 生成（地点 · 时段 · 活动）+ activities 去重上限
 *   7. 没有 visual 时也能出结果：basis 写明「仅指标推断」，label 形如「暖色中景 · 3 镜」
 *   8. 空输入 → 0 场（三个入口都安全）
 *   9. 脏数据（metrics=null、缺 start/end）JSON 无 NaN、可 roundtrip
 *  10. describeScenes 回答「一共几场 / 这是哪场」
 *  11. scenesForModel 把每场的代表帧分组并给 promptHint
 *  12. 6 镜头 2 场完整示例（汇报用）；confidence/basis/字段完整性
 *
 * 退出码 0 = 全部通过并打印 PASS 行；1 = 有失败。
 */

import assert from 'node:assert/strict'

import {
  TONE_LABEL,
  VERSION,
  describeScenes,
  groupScenes,
  scenesForModel,
} from './scenegroup.mjs'

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

/** 造一个镜头：时间单位秒，index 从 1 起（与 scenes.scan 一致）。 */
function makeShot(index, { start = null, duration = 4, luma = 0.5, green = 0.02, sat = 0.3, warmth = null, metrics = undefined } = {}) {
  const shot = { index, duration, frames: [`shot-${index}-mid.jpg`] }
  if (start != null) {
    shot.start = start
    shot.end = Number((start + duration).toFixed(3))
  }
  if (metrics !== undefined) {
    shot.metrics = metrics
  } else {
    const built = {
      lumaMean: luma,
      lumaMin: Math.max(0, Number((luma - 0.2).toFixed(3))),
      lumaMax: Math.min(1, Number((luma + 0.2).toFixed(3))),
      saturationMean: sat,
      greenDominance: green,
    }
    if (warmth != null) built.warmth = warmth
    shot.metrics = built
  }
  return shot
}

/** 6 镜头 2 场：沙漠白天（3 镜）→ 城市夜晚（3 镜）。 */
function makeStoryShots() {
  const shots = []
  const visuals = {}
  const descriptors = [
    { location: '沙漠', timeOfDay: '白天', description: '人物在沙丘间行走', keywords: ['沙漠', '行走'], subject: '人物' },
    { location: '沙漠', timeOfDay: '白天', description: '人物在沙丘间行走', keywords: ['沙漠', '行走'], subject: '人物' },
    { location: '沙漠', timeOfDay: '白天', description: '人物停下望向远方', keywords: ['沙漠', '远望'], subject: '人物' },
    { location: '城市', timeOfDay: '夜晚', description: '人物坐在吧台前', keywords: ['城市', '酒吧'], subject: '人物' },
    { location: '城市', timeOfDay: '夜晚', description: '人物端起酒杯', keywords: ['城市', '喝酒'], subject: '人物' },
    { location: '城市', timeOfDay: '夜晚', description: '人物低头沉默', keywords: ['城市', '沉默'], subject: '人物' },
  ]
  descriptors.forEach((visual, position) => {
    const index = position + 1
    const isDesert = position < 3
    shots.push(
      makeShot(index, {
        start: position * 4,
        duration: 4,
        luma: isDesert ? 0.52 : 0.18,
        sat: isDesert ? 0.35 : 0.2,
        green: isDesert ? 0.02 : 0.01,
        warmth: isDesert ? 0.22 : -0.25,
      }),
    )
    visuals[index] = visual
  })
  return { shots, visuals }
}

// ---------------------------------------------------------------------------
// 1. 同 location 同色调 → 合并
// ---------------------------------------------------------------------------

test('同 location 同色调的相邻镜头应合并成 1 场', () => {
  const shots = [0, 4, 8].map((start, position) =>
    makeShot(position + 1, { start, duration: 4, luma: 0.5, warmth: 0.2 }),
  )
  const visuals = {}
  for (let index = 1; index <= 3; index += 1) {
    visuals[index] = { location: '沙漠', timeOfDay: '白天', description: '人物行走' }
  }
  const grouped = groupScenes(shots, visuals)
  assert.equal(grouped.sceneCount, 1, `应合并成 1 场，实际 ${grouped.sceneCount}`)
  assert.deepEqual(grouped.scenes[0].shots, [1, 2, 3])
  assert.equal(grouped.scenes[0].startShot, 1)
  assert.equal(grouped.scenes[0].endShot, 3)
  assert.equal(grouped.scenes[0].dominantTone, 'warm')
  assert.equal(grouped.scenes[0].basisKind, 'visual')
  assertClose(grouped.scenes[0].start, 0, 1e-9, '场起点')
  assertClose(grouped.scenes[0].end, 12, 1e-9, '场终点')
  assert.ok(grouped.scenes[0].basis.some((line) => line.includes('location 相同')), 'basis 应写明同 location')
})

// ---------------------------------------------------------------------------
// 2. location 变 → 必分场
// ---------------------------------------------------------------------------

test('visual.location 不同 → 必分场（即使亮度色调一致）', () => {
  const shots = [makeShot(1, { start: 0 }), makeShot(2, { start: 4 })]
  const visuals = {
    1: { location: '沙漠', timeOfDay: '白天', description: '人物行走' },
    2: { location: '城市', timeOfDay: '白天', description: '人物行走' },
  }
  const grouped = groupScenes(shots, visuals)
  assert.equal(grouped.sceneCount, 2)
  assert.equal(grouped.scenes[0].shots.length, 1)
  assert.equal(grouped.scenes[1].shots.length, 1)
  assert.ok(
    grouped.scenes[1].basis.some((line) => line.includes('location 变化')),
    '第二场 basis 应写明 location 变化',
  )
  assert.ok(String(grouped.scenes[0].label).includes('沙漠'))
  assert.ok(String(grouped.scenes[1].label).includes('城市'))
})

// ---------------------------------------------------------------------------
// 3. luma 跳变 → 必分场
// ---------------------------------------------------------------------------

test('相邻镜头 lumaMean 差 > 0.18 → 必分场（无需 visual）', () => {
  const shots = [
    makeShot(1, { start: 0, luma: 0.62, sat: 0.3 }),
    makeShot(2, { start: 4, luma: 0.3, sat: 0.3 }),
  ]
  const grouped = groupScenes(shots)
  assert.equal(grouped.sceneCount, 2, '亮度跳变 0.32 应切场')
  assert.ok(
    grouped.scenes[1].basis.some((line) => line.includes('亮度跳变') && line.includes('0.32')),
    `basis 应写明亮度跳变，实际 ${JSON.stringify(grouped.scenes[1].basis)}`,
  )
})

test('相邻镜头亮度差小于阈值时不该切场', () => {
  const shots = [
    makeShot(1, { start: 0, luma: 0.52 }),
    makeShot(2, { start: 4, luma: 0.5 }),
  ]
  const grouped = groupScenes(shots)
  assert.equal(grouped.sceneCount, 1, '亮度差 0.02 不应切场')
})

// ---------------------------------------------------------------------------
// 4. dominantTone 变 → 必分场
// ---------------------------------------------------------------------------

test('相邻镜头色调整体变化（暖 → 绿）→ 分场', () => {
  const shots = [
    makeShot(1, { start: 0, luma: 0.5, warmth: 0.25 }),
    makeShot(2, { start: 4, luma: 0.5, green: 0.62 }),
  ]
  const grouped = groupScenes(shots)
  assert.equal(grouped.sceneCount, 2, '暖调 → 绿调应切场')
  assert.ok(
    grouped.scenes[1].basis.some((line) => line.includes('色调变化') && line.includes('green')),
    `basis 应写色调变化，实际 ${JSON.stringify(grouped.scenes[1].basis)}`,
  )
  assert.ok(Object.keys(TONE_LABEL).includes(grouped.scenes[0].dominantTone))
})

// ---------------------------------------------------------------------------
// 5. 时间间隔软规则
// ---------------------------------------------------------------------------

test('同 location 同色调但镜头间隔 > 120s → 软边界分场', () => {
  const shots = [
    makeShot(1, { start: 0, luma: 0.5, warmth: 0.18 }),
    makeShot(2, { start: 200, luma: 0.5, warmth: 0.18 }),
  ]
  const visuals = {
    1: { location: '沙漠', timeOfDay: '白天', description: '人物行走' },
    2: { location: '沙漠', timeOfDay: '白天', description: '人物行走' },
  }
  const grouped = groupScenes(shots, visuals)
  assert.equal(grouped.sceneCount, 2, '间隔 200s > 120s 应软切场')
  assert.ok(
    grouped.scenes[1].basis.some((line) => line.includes('软边界')),
    `basis 应写软边界，实际 ${JSON.stringify(grouped.scenes[1].basis)}`,
  )
  assert.ok(grouped.scenes[1].basis.some((line) => line.includes('200s')))
})

test('同 location 同色调且间隔在 120s 内 → 不切场', () => {
  const shots = [
    makeShot(1, { start: 0, luma: 0.5, warmth: 0.18 }),
    makeShot(2, { start: 60, luma: 0.5, warmth: 0.18 }),
  ]
  const grouped = groupScenes(shots, {
    1: { location: '沙漠', timeOfDay: '白天', description: '人物行走' },
    2: { location: '沙漠', timeOfDay: '白天', description: '人物行走' },
  })
  assert.equal(grouped.sceneCount, 1)
})

// ---------------------------------------------------------------------------
// 6. label / activities
// ---------------------------------------------------------------------------

test('有 visual 时 label 用「地点 · 时段 · 活动」，activities 去重且 ≤3 条', () => {
  const { shots, visuals } = makeStoryShots()
  const grouped = groupScenes(shots, visuals)
  const first = grouped.scenes[0]
  assert.equal(first.label, '沙漠 · 白天 · 人物在沙丘间行走', `label 不符：${first.label}`)
  assert.equal(first.activities.length, 2, `重复描述应去重，实际 ${JSON.stringify(first.activities)}`)
  assert.deepEqual(first.activities, ['人物在沙丘间行走', '人物停下望向远方'])
  const second = grouped.scenes[1]
  assert.equal(second.label, '城市 · 夜晚 · 人物坐在吧台前')
  assert.equal(second.activities.length, 3, '最多 3 条活动')
  for (const scene of grouped.scenes) {
    assert.ok(scene.activities.length <= 3, 'activities 上限 3')
    assert.ok(scene.label.includes(' · '), `label 应为「·」拼接：${scene.label}`)
  }
})

// ---------------------------------------------------------------------------
// 7. 缺 visual：指标推断
// ---------------------------------------------------------------------------

test('没有 visual 标签时只用指标推断，basis 明确写「仅指标推断」', () => {
  const shots = [0, 4, 8].map((start, position) =>
    makeShot(position + 1, { start, duration: 4, luma: 0.42, warmth: 0.2 }),
  )
  const grouped = groupScenes(shots)
  assert.equal(grouped.sceneCount, 1)
  const scene = grouped.scenes[0]
  assert.equal(scene.basisKind, 'metrics')
  assert.equal(scene.activities.length, 0)
  assert.equal(scene.dominantTone, 'warm')
  assert.equal(scene.label, '暖色中景 · 3 镜', `指标 label 不符：${scene.label}`)
  assert.ok(
    scene.basis.some((line) => line.includes('仅指标推断')),
    `basis 应写「仅指标推断」：${JSON.stringify(scene.basis)}`,
  )
  assert.ok(grouped.notes.some((line) => line.includes('仅按指标推断')))
})

test('metrics 缺失时色调证据不足 → 中性，且 basis 说明证据不足', () => {
  const shots = [makeShot(1, { start: 0, metrics: null }), makeShot(2, { start: 4, metrics: null })]
  const grouped = groupScenes(shots)
  assert.equal(grouped.sceneCount, 1, '全无指标时无法切分，应保守合并')
  assert.equal(grouped.scenes[0].dominantTone, 'neutral')
  assert.ok(grouped.scenes[0].basis.some((line) => line.includes('仅指标推断')))
})

test('dominantTone 覆盖 dark / green 两条指标分支', () => {
  const dark = groupScenes([makeShot(1, { start: 0, luma: 0.1, sat: 0.1 })])
  assert.equal(dark.scenes[0].dominantTone, 'dark')
  assert.ok(dark.scenes[0].label.startsWith('暗调'), dark.scenes[0].label)
  const green = groupScenes([makeShot(1, { start: 0, luma: 0.5, green: 0.7, sat: 0.5 })])
  assert.equal(green.scenes[0].dominantTone, 'green')
  assert.ok(green.scenes[0].label.includes('绿调'), green.scenes[0].label)
})

// ---------------------------------------------------------------------------
// 8. 空输入
// ---------------------------------------------------------------------------

test('空输入返回 0 场，三个入口都不抛错', () => {
  for (const input of [[], null, undefined, {}]) {
    const grouped = groupScenes(input)
    assert.equal(grouped.sceneCount, 0)
    assert.deepEqual(grouped.scenes, [])
    assert.ok(Array.isArray(grouped.notes))
  }
  const described = describeScenes(groupScenes([]))
  assert.deepEqual(described.perScene, [])
  assert.ok(described.text.includes('无法分场'), described.text)
  assert.deepEqual(scenesForModel(groupScenes([])), [])
})

// ---------------------------------------------------------------------------
// 9. 脏数据 JSON 安全
// ---------------------------------------------------------------------------

test('脏数据（metrics=null、缺 start/end、空数组元素）JSON 无 NaN 且可 roundtrip', () => {
  const shots = [
    makeShot(1, { metrics: null }),
    { index: 2, frames: [] }, // 没有 duration/start/end/metrics
    makeShot(3, { start: 10, luma: 0.9, metrics: { lumaMean: 0.9 } }),
    null,
    makeShot(5, { start: 20, duration: 3, luma: 0.2, green: 0.7 }),
  ]
  const grouped = groupScenes(shots, { 1: {}, 2: { location: '' } })
  assert.ok(grouped.sceneCount >= 1)
  assertJsonRoundTrip(grouped)
  const described = describeScenes(grouped)
  assertJsonRoundTrip(described)
  const forModel = scenesForModel(grouped, { 1: ['a.jpg'], 3: ['b.jpg'] })
  assertJsonRoundTrip(forModel)
})

// ---------------------------------------------------------------------------
// 10. describeScenes
// ---------------------------------------------------------------------------

test('describeScenes 回答「一共有几场 / 这是哪场」', () => {
  const { shots, visuals } = makeStoryShots()
  const grouped = groupScenes(shots, visuals)
  const described = describeScenes(grouped)
  assert.equal(described.perScene.length, 2)
  assert.ok(described.text.includes('共 2 场（6 个镜头）'), described.text)
  assert.ok(described.text.includes('第 1 场「沙漠 · 白天 · 人物在沙丘间行走」'), described.text)
  assert.ok(described.text.includes('第 2 场「城市 · 夜晚 · 人物坐在吧台前」'), described.text)
  for (const item of described.perScene) {
    assert.ok(item.brief.length > 0)
    assert.ok(item.brief.includes('镜'), item.brief)
    assert.ok(item.brief.includes('置信'), item.brief)
  }
  assertJsonRoundTrip(described)
})

// ---------------------------------------------------------------------------
// 11. scenesForModel
// ---------------------------------------------------------------------------

test('scenesForModel 按场分组代表帧并给 promptHint', () => {
  const { shots, visuals } = makeStoryShots()
  const grouped = groupScenes(shots, visuals)
  const shotFrames = {}
  for (const shot of shots) {
    shotFrames[shot.index] = [`shot-${shot.index}-a.jpg`, `shot-${shot.index}-b.jpg`]
  }
  const batches = scenesForModel(grouped, shotFrames)
  assert.equal(batches.length, 2)
  assert.equal(batches[0].shots.length, 3)
  assert.deepEqual(batches[0].shots[0].frames, ['shot-1-a.jpg', 'shot-1-b.jpg'])
  assert.equal(batches[0].frameCount, 6)
  assert.ok(batches[0].promptHint.includes('第 1 场'))
  assert.ok(batches[0].promptHint.includes('沙漠'))
  assert.ok(batches[1].promptHint.includes('第 2 场'))
  // 数组形态的 shotFrames 也支持（按 index 查）
  const fromArray = scenesForModel(grouped, shots.map((shot) => shot.frames))
  assert.equal(fromArray[0].shots[0].frames.length, 1)
})

// ---------------------------------------------------------------------------
// 12. 字段完整性 / 6 镜头 2 场示例
// ---------------------------------------------------------------------------

test('6 镜头示例：恰好 2 场，字段齐全且可解释', () => {
  const { shots, visuals } = makeStoryShots()
  const grouped = groupScenes(shots, visuals)
  assert.equal(grouped.sceneCount, 2)
  assert.deepEqual(
    grouped.scenes.map((scene) => scene.shots),
    [
      [1, 2, 3],
      [4, 5, 6],
    ],
  )
  assert.deepEqual(
    grouped.scenes.map((scene) => scene.startShot),
    [1, 4],
  )
  assert.deepEqual(
    grouped.scenes.map((scene) => scene.endShot),
    [3, 6],
  )
  assert.deepEqual(
    grouped.scenes.map((scene) => scene.dominantTone),
    ['warm', 'cool'],
  )
  for (const scene of grouped.scenes) {
    assert.ok(Number.isInteger(scene.index))
    assert.ok(['warm', 'cool', 'neutral', 'green', 'dark'].includes(scene.dominantTone))
    assert.ok(typeof scene.label === 'string' && scene.label.length > 0)
    assert.ok(Array.isArray(scene.shots) && scene.shots.length > 0)
    assert.ok(Array.isArray(scene.basis) && scene.basis.length > 0)
    assert.ok(scene.confidence > 0 && scene.confidence <= 1)
    assert.ok(Number.isFinite(scene.start) && Number.isFinite(scene.end))
    assert.ok(scene.start <= scene.end)
    assertJsonSafe(scene)
  }
  // 与 edit3.planScenes 的场序号语义一致：0 起
  assert.deepEqual(
    grouped.scenes.map((scene) => scene.index),
    [0, 1],
  )
})

test('groupScenes 不修改入参（纯函数）', () => {
  const { shots, visuals } = makeStoryShots()
  const snapshot = JSON.stringify({ shots, visuals })
  groupScenes(shots, visuals)
  describeScenes(groupScenes(shots, visuals))
  assert.equal(JSON.stringify({ shots, visuals }), snapshot, '入参被修改了')
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
      `FAIL scenegroup.test.mjs — ${passed}/${tests.length} 通过，${failures.length} 失败（${elapsed.toFixed(0)}ms）\n`,
    )
    for (const { name, error } of failures) {
      process.stdout.write(`  - ${name}: ${error?.message ?? error}\n`)
    }
    return 1
  }

  const story = makeStoryShots()
  const grouped = groupScenes(story.shots, story.visuals)
  const described = describeScenes(grouped)
  process.stdout.write(
    `PASS scenegroup.test.mjs — ${tests.length}/${tests.length} 项通过（${VERSION}，${elapsed.toFixed(0)}ms）\n`,
  )
  process.stdout.write(
    `     6 镜 2 场：sceneCount=${grouped.sceneCount} → ${JSON.stringify(
      grouped.scenes.map((scene) => ({ shots: scene.shots, label: scene.label, tone: scene.dominantTone })),
    )}\n`,
  )
  process.stdout.write(`     ${described.text}\n`)
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
