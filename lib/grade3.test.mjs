#!/usr/bin/env node
/**
 * lib/grade3.mjs 自测（无测试框架，`node lib/grade3.test.mjs` 直接跑）。
 *
 * 覆盖（重点是「整体偏色 vs 键控溢色」必须分开）：
 *   - parseVibe 中文 6 组 / 英文 6 组断言：
 *       · 「太绿了 / 发绿 / too green / greenish」→ global-cast（一级白平衡）
 *       · 「绿幕的绿色溢出 / 绿边 / green spill」→ keyed-spill（二级绿色键控）
 *       · 两者不互相误判（中文、英文各单独验证）
 *       · 肤色 / 背景 / 高光 / 暗部 / 曝光 / 对比 / 饱和 / 风格
 *   - buildTierPlan：节点数 ≥3、含 01/02/03 标签、节点与 tiers 一一对应
 *       · 有 keyed-spill 时出现 04 绿色 qualifier 节点：hueCenter ∈ [25,55]、satHigh ≥70
 *       · 只有 global-cast 时**不**出现 04（这是本模块存在的验收点）
 *       · 只有 keyed-spill 时 01 不自动去绿（保住幕布绿）
 *       · JSON 可序列化、无 NaN/Infinity；全部数值在 CLAMPS 范围内
 *       · 空 analysis / 未知 style / 各种 style 都不崩
 *   - identifyCast：绿偏 / 蓝偏 / 中性 的相对程度
 *
 * 退出码 0 = 全部通过并打印 PASS 行；1 = 有失败。
 */

import assert from 'node:assert/strict'

import { buildTierPlan, CLAMPS, identifyCast, parseVibe, VERSION } from './grade3.mjs'

// ---------------------------------------------------------------------------
// 测试小工具（与 lib/layers.test.mjs 保持同一套风格）
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

/** 递归检查 JSON 安全：不允许 NaN/Infinity/undefined/函数。 */
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
  assert.deepEqual(JSON.parse(text), JSON.parse(text), `${label}: 往返不一致`)
}

function findNode(plan, idPrefix) {
  return plan.nodes.find((node) => node.label.startsWith(idPrefix))
}

/** 校验一个节点的所有已知键都落在 CLAMPS 里（越界只会写成噪音，不会更好看）。 */
function assertNodeRanges(node) {
  const params = node.params
  assert.ok(params && typeof params === 'object', `${node.label}: 缺少 params`)
  assert.ok(
    params.space === 'ui' || params.space === 'drx',
    `${node.label}: space 必须是 ui/drx，实际 ${params.space}`,
  )

  for (const key of ['gain', 'lift', 'gamma', 'offset']) {
    const channels = params[key]
    if (!channels) continue
    const limits = CLAMPS[key]
    for (const channel of ['r', 'g', 'b', 'master']) {
      if (channels[channel] === undefined) continue
      const value = channels[channel]
      assert.ok(Number.isFinite(value), `${node.label}.${key}.${channel}: 非有限数字 ${value}`)
      assert.ok(
        value >= limits[0] && value <= limits[1],
        `${node.label}.${key}.${channel}: ${value} 超出 [${limits[0]}, ${limits[1]}]`,
      )
    }
  }

  const checkRange = (key, limits, value) => {
    if (value === undefined) return
    assert.ok(Number.isFinite(value), `${node.label}.${key}: 非有限数字 ${value}`)
    assert.ok(
      value >= limits[0] && value <= limits[1],
      `${node.label}.${key}: ${value} 超出 [${limits[0]}, ${limits[1]}]`,
    )
  }

  checkRange('saturation', CLAMPS.saturation, params.saturation)
  checkRange('contrast', CLAMPS.contrast, params.contrast)
  checkRange('pivot', CLAMPS.pivot, params.pivot)
  checkRange('contrastHighRange', CLAMPS.contrastHighRange, params.contrastHighRange)
  checkRange('softClipHigh', CLAMPS.softClip, params.softClipHigh)
  checkRange('softClipLow', [0, 1], params.softClipLow)

  for (const qualifierKey of ['qualifier', 'rgbQualifier', 'lumaQualifier']) {
    const qualifier = params[qualifierKey]
    if (!qualifier) continue
    for (const [field, value] of Object.entries(qualifier)) {
      if (typeof value !== 'number') continue
      assert.ok(Number.isFinite(value), `${node.label}.${qualifierKey}.${field}: 非有限数字`)
      assert.ok(
        value >= 0 && value <= 100,
        `${node.label}.${qualifierKey}.${field}: ${value} 超出 UI 0–100`,
      )
    }
  }

  if (params.matteFinesse) {
    for (const [field, value] of Object.entries(params.matteFinesse)) {
      if (typeof value !== 'number') continue
      assert.ok(Number.isFinite(value), `${node.label}.matteFinesse.${field}: 非有限数字`)
      assert.ok(
        value >= 0 && value <= 100,
        `${node.label}.matteFinesse.${field}: ${value} 超出 UI 0–100`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// 测试数据：与 lib/layers.mjs 的 analyze 输出同构
// ---------------------------------------------------------------------------

function makeLayer(name, extra = {}) {
  return {
    name,
    pixelCount: 1000,
    coverage: 20,
    meanR: 128,
    meanG: 128,
    meanB: 128,
    meanLuma: 0.45,
    lumaPct: { p5: 0.1, p25: 0.3, p50: 0.45, p75: 0.6, p95: 0.9 },
    meanSat: 0.2,
    meanHue: 30,
    meanHuePercent: 8.3,
    confident: true,
    ...extra,
  }
}

/** 默认 fixture：全局偏绿（meanG 比 R/B 高 15%）、肤色可信、背景偏青。 */
function makeAnalysis(overrides = {}) {
  return {
    width: 320,
    height: 180,
    pixels: 320 * 180,
    layers: {
      global: makeLayer('global', {
        coverage: 100,
        meanR: 120,
        meanG: 138,
        meanB: 118,
        meanLuma: 0.42,
        dynamicRange: 0.55,
      }),
      skin: makeLayer('skin', {
        coverage: 12,
        meanR: 190,
        meanG: 140,
        meanB: 115,
        meanLuma: 0.55,
        meanHue: 28,
        meanHuePercent: 7.8,
        meanSat: 0.35,
      }),
      highlight: makeLayer('highlight', { coverage: 3, meanLuma: 0.9 }),
      shadow: makeLayer('shadow', { coverage: 8, meanLuma: 0.08 }),
      background: makeLayer('background', {
        coverage: 22,
        meanR: 90,
        meanG: 120,
        meanB: 160,
        meanHue: 190,
        meanHuePercent: 52.8,
        dominantHueFamily: 'cool',
        dominantHueDeg: 190,
        dominantHuePercent: 52.8,
        dominantSharePct: 70,
      }),
      neutral: makeLayer('neutral', { coverage: 10, meanSat: 0.04, meanHue: null, meanHuePercent: null }),
      ...overrides,
    },
    meta: { analyzeMs: 1 },
  }
}

function kindsOf(result) {
  return result.intents.map((intent) => intent.kind)
}

// ---------------------------------------------------------------------------
// parseVibe
// ---------------------------------------------------------------------------

test('parseVibe 中文：「太绿了」= 整体偏色，不是绿幕溢色', () => {
  const result = parseVibe('我感觉有点太绿了')
  assert.equal(result.intents.length, 1, `期望恰好 1 个 intent，实际 ${JSON.stringify(result.intents)}`)
  const [intent] = result.intents
  assert.equal(intent.kind, 'global-cast', '「太绿了」必须是一级整体偏色')
  assert.equal(intent.axis, 'green')
  assert.ok(intent.amount >= 0.5, `amount 应 ≥0.5，实际 ${intent.amount}`)
  assert.ok(!kindsOf(result).includes('keyed-spill'), '「太绿了」不能误判成 keyed-spill')
  assert.match(result.summary, /整体偏绿/)
  assert.match(result.summary, /一级/)
})

test('parseVibe 中文：「绿幕的绿色溢出」= 键控溢色，不是整体偏色', () => {
  const result = parseVibe('这个绿幕的绿色溢出好明显')
  assert.equal(result.intents.length, 1, `期望恰好 1 个 intent，实际 ${JSON.stringify(result.intents)}`)
  const [intent] = result.intents
  assert.equal(intent.kind, 'keyed-spill', '「绿幕绿色溢出」必须是二级键控溢色')
  assert.equal(intent.axis, 'green')
  assert.ok(!kindsOf(result).includes('global-cast'), '溢色句子不能同时判成整体偏色')
  assert.match(result.summary, /溢色/)
  assert.match(result.summary, /键控/)
})

test('parseVibe 中文：发绿 / 偏绿 / 绿边 的归类', () => {
  for (const text of ['有点发绿', '画面偏绿', '整体发绿']) {
    const result = parseVibe(text)
    assert.equal(result.intents[0]?.kind, 'global-cast', `${text} 应归整体偏色`)
    assert.equal(result.intents[0]?.axis, 'green')
  }
  const fringe = parseVibe('绿边很脏')
  assert.equal(fringe.intents[0]?.kind, 'keyed-spill', '「绿边」应归键控溢色（弱上下文 + 颜色词）')
})

test('parseVibe 中文：肤色太红 / 蜡黄 → 二级肤色键控', () => {
  const red = parseVibe('肤色太红了')
  assert.equal(red.intents[0]?.kind, 'skin-key')
  assert.equal(red.intents[0]?.direction, 'red')
  const yellow = parseVibe('人脸蜡黄，压一下')
  assert.equal(yellow.intents[0]?.kind, 'skin-key')
  assert.equal(yellow.intents[0]?.direction, 'yellow')
  assert.match(yellow.summary, /肤色/)
})

test('parseVibe 中文：天空太青 → 二级背景键控', () => {
  const result = parseVibe('天空太青了，压一下')
  assert.equal(result.intents[0]?.kind, 'background-key')
  assert.equal(result.intents[0]?.target, 'cyan')
  assert.match(result.summary, /背景/)
})

test('parseVibe 中文：高光爆了 / 暗部死黑 → luma 键控两条', () => {
  const result = parseVibe('高光爆了，暗部死黑')
  const luma = result.intents.filter((intent) => intent.kind === 'luma-key')
  assert.equal(luma.length, 2, `期望 2 条 luma-key，实际 ${JSON.stringify(result.intents)}`)
  assert.deepEqual(
    luma.map((intent) => intent.axis).sort(),
    ['highlight', 'shadow'],
  )
  assert.match(result.summary, /高光/)
  assert.match(result.summary, /暗部/)
})

test('parseVibe 中文：偏冷 + 胶片感 → 整体偏冷 + 风格 film', () => {
  const result = parseVibe('偏冷一点，加点胶片感')
  const cast = result.intents.find((intent) => intent.kind === 'global-cast')
  const look = result.intents.find((intent) => intent.kind === 'look')
  assert.equal(cast?.axis, 'cool')
  assert.equal(look?.style, 'film')
})

test('parseVibe 英文：「too green」= 整体偏色，不是溢色', () => {
  const result = parseVibe('the whole shot is too green')
  assert.equal(result.intents[0]?.kind, 'global-cast', JSON.stringify(result.intents))
  assert.equal(result.intents[0]?.axis, 'green')
  assert.ok(!kindsOf(result).includes('keyed-spill'))
})

test('parseVibe 英文：「green spill on the edges」= 键控溢色，不是整体偏色', () => {
  const result = parseVibe('green spill on the edges is obvious')
  assert.equal(result.intents[0]?.kind, 'keyed-spill', JSON.stringify(result.intents))
  assert.equal(result.intents[0]?.axis, 'green')
  assert.ok(!kindsOf(result).includes('global-cast'))
})

test('parseVibe 英文：greenish / green cast 归整体偏色', () => {
  for (const text of ['a bit greenish', 'there is a green cast overall']) {
    const result = parseVibe(text)
    assert.equal(result.intents[0]?.kind, 'global-cast', `${text} → ${JSON.stringify(result.intents)}`)
    assert.equal(result.intents[0]?.axis, 'green')
  }
})

test('parseVibe 英文：skin too red → 肤色键控', () => {
  const result = parseVibe('skin is too red')
  assert.equal(result.intents[0]?.kind, 'skin-key')
  assert.equal(result.intents[0]?.direction, 'red')
})

test('parseVibe 英文：sky too cyan → 背景键控', () => {
  const result = parseVibe('sky is too cyan')
  assert.equal(result.intents[0]?.kind, 'background-key')
  assert.equal(result.intents[0]?.target, 'cyan')
})

test('parseVibe 英文：highlights blown / shadows crushed → luma 键控', () => {
  const result = parseVibe('highlights are blown, shadows crushed')
  const luma = result.intents.filter((intent) => intent.kind === 'luma-key')
  assert.equal(luma.length, 2, JSON.stringify(result.intents))
  assert.deepEqual(luma.map((intent) => intent.axis).sort(), ['highlight', 'shadow'])
})

test('parseVibe 英文：washed out / low contrast → 对比不足', () => {
  const result = parseVibe('it looks washed out with low contrast')
  assert.equal(result.intents[0]?.kind, 'contrast')
  assert.equal(result.intents[0]?.direction, 'up')
})

test('parseVibe 空/无关文本：返回空 intents 且 summary 有提示，不崩不抛', () => {
  for (const text of ['', '   ', '导出成 ProRes', null, undefined]) {
    const result = parseVibe(text)
    assert.deepEqual(result.intents, [], `${String(text)} 不应产生 intent`)
    assert.ok(result.summary.length > 0)
  }
})

test('parseVibe 输出 JSON 安全（无 NaN/Infinity/undefined）', () => {
  const samples = [
    '有点太绿了',
    '绿幕绿色溢出',
    '偏冷，加胶片感',
    '肤色蜡黄',
    'too green',
    'green spill',
  ]
  const all = samples.map((text) => parseVibe(text))
  assertJsonRoundTrip(all, 'parseVibe 全部样本')
})

// ---------------------------------------------------------------------------
// buildTierPlan
// ---------------------------------------------------------------------------

test('buildTierPlan：节点 ≥3、含 01/02/03 标签、tiers 与 nodes 一一对应', () => {
  const plan = buildTierPlan({ analysis: makeAnalysis(), vibe: '太绿了', style: 'none' })
  assert.ok(plan.nodes.length >= 3, `节点数应 ≥3，实际 ${plan.nodes.length}`)
  for (const id of ['01', '02', '03']) {
    assert.ok(findNode(plan, id), `缺少 ${id} 节点；实际节点：${plan.nodes.map((n) => n.label)}`)
  }
  assert.equal(plan.tiers.length, plan.nodes.length, 'tiers 与 nodes 必须一一对应')
  assert.equal(plan.tiers[0].id, '01')
  plan.tiers.forEach((tier, index) => {
    assert.equal(tier.nodeLabel, plan.nodes[index].label)
    assert.ok(typeof tier.basis === 'string' && tier.basis.length > 0, `tier ${tier.id} 缺少依据`)
    assert.ok(Array.isArray(tier.changes) && tier.changes.length > 0, `tier ${tier.id} 缺少改动说明`)
    assert.ok(['primary', 'secondary', 'look'].includes(tier.role), `tier ${tier.id} role 非法`)
  })
  assert.ok(plan.notes.length > 0, 'notes 不能为空')
  assert.equal(plan.style, 'none')
})

test('buildTierPlan：keyed-spill → 04 绿色 qualifier（hueCenter ∈ [25,55]、satHigh ≥70）', () => {
  const plan = buildTierPlan({ analysis: makeAnalysis(), vibe: '绿幕的绿色溢出好明显', style: 'none' })
  const node = findNode(plan, '04')
  assert.ok(node, `缺少 04 绿幕溢色节点；实际：${plan.nodes.map((n) => n.label)}`)
  const qualifier = node.params.qualifier
  assert.ok(qualifier, '04 节点必须是 HSL qualifier 键控节点')
  assert.ok(
    qualifier.hueCenter >= 25 && qualifier.hueCenter <= 55,
    `hueCenter 应落在绿区 [25,55]，实际 ${qualifier.hueCenter}`,
  )
  assert.ok(qualifier.satHigh >= 70, `satHigh 应 ≥70（绿幕是高饱和），实际 ${qualifier.satHigh}`)
  assert.ok(qualifier.satLow > 0 && qualifier.satLow < qualifier.satHigh, 'satLow 必须是中低值')
  assert.ok(qualifier.hueWidth > 0 && qualifier.hueWidth < 100, 'hueWidth 必须有限宽')
  assert.ok(node.params.saturation < 50, '溢色抑制必须降饱和（<50）')
  assert.ok(node.params.gain.master < 1, '溢色抑制要轻微降亮（gain.master <1）')
  assert.ok(node.params.matteFinesse, '键控节点应带 matteFinesse 清 matte')

  // 只说了溢色、没说整体偏绿 → 一级不能自动去绿（保住幕布）
  const balance = findNode(plan, '01')
  assertClose(balance.params.gain.g, 1, 0.015, '只有溢色时 01 不应自动去绿 gain.g')
})

test('buildTierPlan：只有 global-cast → 不生成 04，且 01 去绿', () => {
  const plan = buildTierPlan({ analysis: makeAnalysis(), vibe: '整体有点太绿了', style: 'none' })
  assert.ok(!findNode(plan, '04'), `整体偏色不应生成 04 键控节点；实际：${plan.nodes.map((n) => n.label)}`)
  const balance = findNode(plan, '01')
  assert.ok(balance.params.gain.g < 1, `整体偏绿时 01 必须压 G，实际 ${balance.params.gain.g}`)
  assert.ok(balance.params.gain.r > 1 || balance.params.gain.b > 1, '去绿时 R/B 应轻微上抬')
})

test('buildTierPlan：整体偏绿 + 绿幕溢色同时存在 → 01 去绿 + 04 键控都要有', () => {
  const plan = buildTierPlan({
    analysis: makeAnalysis(),
    vibe: '整体有点绿，绿幕边缘还有溢色',
    style: 'none',
  })
  assert.ok(findNode(plan, '04'), '混合诉求必须同时有 04 键控节点')
  assert.ok(findNode(plan, '01').params.gain.g < 1, '混合诉求下 01 也要去整体绿')
})

test('buildTierPlan：所有节点 JSON 安全、数值都在 CLAMPS 内（全部 style × 3 种诉求）', () => {
  const styles = ['none', 'film', 'punchy', 'clean', 'teal-orange']
  const vibes = ['太绿了', '绿幕绿色溢出', '高光爆了，暗部死黑，肤色太红']
  for (const style of styles) {
    for (const vibe of vibes) {
      const plan = buildTierPlan({ analysis: makeAnalysis(), vibe, style })
      assertJsonSafe(plan, `plan[${style}/${vibe}]`)
      assert.ok(plan.nodes.length >= 3)
      for (const node of plan.nodes) assertNodeRanges(node)
      assert.ok(plan.notes.every((note) => typeof note === 'string'))
    }
  }
})

test('buildTierPlan：空 analysis / 未知名 / 空 vibe 不崩，仍 ≥3 节点且数值合法', () => {
  const cases = [
    {},
    { analysis: null, vibe: null, style: null },
    { analysis: { layers: {} }, vibe: '太绿了', style: '不存在的风格' },
    { analysis: makeAnalysis(), vibe: '偏色', style: undefined },
  ]
  for (const options of cases) {
    const plan = buildTierPlan(options)
    assert.ok(plan.nodes.length >= 3, `节点数应 ≥3，实际 ${plan.nodes.length}`)
    assertJsonSafe(plan, 'edge plan')
    for (const node of plan.nodes) assertNodeRanges(node)
  }
})

test('buildTierPlan：肤色层不可信时不生成 03', () => {
  const analysis = makeAnalysis({ skin: makeLayer('skin', { confident: false, coverage: 0.2 }) })
  const plan = buildTierPlan({ analysis, vibe: '太绿了' })
  assert.ok(!findNode(plan, '03'), `肤色不可信时不应生成 03；实际：${plan.nodes.map((n) => n.label)}`)
  assert.ok(plan.notes.some((note) => note.includes('肤色')), '应说明跳过 03 的原因')
})

test('buildTierPlan：背景意图才会生成 05，且与绿幕溢色冲突时跳过', () => {
  const withIntent = buildTierPlan({ analysis: makeAnalysis(), vibe: '背景太青了，压一下' })
  assert.ok(findNode(withIntent, '05'), '明确背景意图应生成 05')

  const conflict = buildTierPlan({
    analysis: makeAnalysis({
      background: makeLayer('background', {
        coverage: 30,
        meanR: 70,
        meanG: 160,
        meanB: 90,
        meanHue: 120,
        meanHuePercent: 33.3,
        dominantHueFamily: 'green',
        dominantHueDeg: 120,
        dominantHuePercent: 33.3,
        dominantSharePct: 80,
      }),
    }),
    vibe: '绿幕绿色溢出，背景也太绿了',
  })
  assert.ok(findNode(conflict, '04'), '应生成 04 绿幕溢色')
  assert.ok(!findNode(conflict, '05'), '背景与绿幕溢色同处绿区时应跳过 05，避免两个节点同时吃绿色')
})

test('buildTierPlan：teal-orange 风格会生成 05 并推背景向青', () => {
  const plan = buildTierPlan({ analysis: makeAnalysis(), vibe: '青橙风格', style: 'teal-orange' })
  assert.equal(plan.style, 'teal-orange')
  const node = findNode(plan, '05')
  assert.ok(node, '青橙风格应生成 05 背景节点')
  assert.ok(node.params.gain.b > 1, '青橙应把背景往青/蓝推（gain.b >1）')
})

test('buildTierPlan：style 参数优先于口语风格，且写进 notes', () => {
  const plan = buildTierPlan({ analysis: makeAnalysis(), vibe: '加点胶片感', style: 'clean' })
  assert.equal(plan.style, 'clean')
  assert.ok(plan.notes.some((note) => note.includes('clean') || note.includes('胶片')))
})

test('buildTierPlan：vibe 支持字符串 / parseVibe 结果 / intent 数组三种形态', () => {
  const analysis = makeAnalysis()
  const fromString = buildTierPlan({ analysis, vibe: '绿幕溢色' })
  const fromParsed = buildTierPlan({ analysis, vibe: parseVibe('绿幕溢色') })
  const fromArray = buildTierPlan({ analysis, vibe: parseVibe('绿幕溢色').intents })
  assert.deepEqual(
    fromString.nodes.map((node) => node.label),
    fromParsed.nodes.map((node) => node.label),
  )
  assert.deepEqual(
    fromParsed.nodes.map((node) => node.label),
    fromArray.nodes.map((node) => node.label),
  )
})

test('buildTierPlan：luma 键控意图落到 01/02（软肩 + 抬黑位），不新增未知节点', () => {
  const plan = buildTierPlan({ analysis: makeAnalysis(), vibe: '高光爆了，暗部死黑', style: 'none' })
  const contrastNode = findNode(plan, '02')
  assert.ok(contrastNode.params.softClipHigh < 1, '高光爆了应压 softClipHigh')
  assert.ok(contrastNode.params.softClipLow > 0, '暗部死黑应抬 softClipLow')
  // 节点编号只允许 01..06
  for (const node of plan.nodes) {
    assert.match(node.label, /^0[1-6] /, `未知节点编号：${node.label}`)
  }
})

test('buildTierPlan：色温偏好进 01 的 gain（暖 → R 高 B 低）', () => {
  const warm = buildTierPlan({ analysis: makeAnalysis(), vibe: '偏暖一点' })
  const balance = findNode(warm, '01')
  assert.ok(balance.params.gain.r > balance.params.gain.b, `偏暖应 R>B，实际 R=${balance.params.gain.r} B=${balance.params.gain.b}`)
  const cool = buildTierPlan({ analysis: makeAnalysis(), vibe: '偏冷一点' })
  const coolBalance = findNode(cool, '01')
  assert.ok(coolBalance.params.gain.b > coolBalance.params.gain.r, '偏冷应 B>R')
})

// ---------------------------------------------------------------------------
// identifyCast
// ---------------------------------------------------------------------------

test('identifyCast：全局偏绿 fixture 判为 green 高、blue/magenta 低', () => {
  const cast = identifyCast(makeAnalysis())
  assert.ok(cast.green > 0.5, `green 应 >0.5，实际 ${cast.green}`)
  assert.ok(cast.blue < 0.2, `blue 应低，实际 ${cast.blue}`)
  assert.ok(cast.magenta < 0.2, `magenta 应低，实际 ${cast.magenta}`)
  for (const value of Object.values(cast)) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `cast 必须 0..1，实际 ${value}`)
  }
})

test('identifyCast：中性画面三轴都接近 0', () => {
  const neutral = makeAnalysis({
    global: makeLayer('global', {
      coverage: 100,
      meanR: 128,
      meanG: 128,
      meanB: 128,
      meanLuma: 0.45,
      dynamicRange: 0.5,
      meanHue: 10,
      meanHuePercent: 2.8,
    }),
  })
  const cast = identifyCast(neutral)
  assertClose(cast.green, 0, 0.01, 'neutral.green')
  assertClose(cast.blue, 0, 0.01, 'neutral.blue')
  assertClose(cast.magenta, 0, 0.01, 'neutral.magenta')
})

test('identifyCast：偏蓝 fixture 判为 blue 高；缺数据时全 0 不抛', () => {
  const blue = makeAnalysis({
    global: makeLayer('global', {
      coverage: 100,
      meanR: 100,
      meanG: 105,
      meanB: 145,
      meanLuma: 0.4,
      dynamicRange: 0.5,
      meanHue: 235,
      meanHuePercent: 65.3,
    }),
  })
  const cast = identifyCast(blue)
  assert.ok(cast.blue > 0.5, `blue 应 >0.5，实际 ${cast.blue}`)

  for (const input of [null, undefined, {}, { layers: {} }, { layers: { global: { meanR: null } } }]) {
    const empty = identifyCast(input)
    assert.deepEqual(empty, { green: 0, blue: 0, magenta: 0 }, `输入 ${JSON.stringify(input)} 应回全 0`)
  }
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
      `FAIL grade3.test.mjs — ${passed}/${tests.length} 通过，${failures.length} 失败（${elapsed.toFixed(0)}ms）\n`,
    )
    for (const { name, error } of failures) {
      process.stdout.write(`  - ${name}: ${error?.message ?? error}\n`)
    }
    return 1
  }

  // 汇报用的实测输出：两句用户原话 + 一个含溢色的方案摘要
  const analysis = makeAnalysis()
  const greenText = '我感觉有点太绿了'
  const spillText = '这个绿幕的绿色溢出好明显'
  const greenParse = parseVibe(greenText)
  const spillParse = parseVibe(spillText)
  const spillPlan = buildTierPlan({ analysis, vibe: spillParse, style: 'film' })
  const spillNode = findNode(spillPlan, '04')

  process.stdout.write(
    `PASS grade3.test.mjs — ${tests.length}/${tests.length} 项通过（${VERSION}，${elapsed.toFixed(0)}ms）\n`,
  )
  process.stdout.write(`     parseVibe("${greenText}") → ${JSON.stringify(greenParse.intents)}\n`)
  process.stdout.write(`     parseVibe("${spillText}") → ${JSON.stringify(spillParse.intents)}\n`)
  process.stdout.write(`     buildTierPlan(绿幕溢色, style=film) nodes = ${JSON.stringify(spillPlan.nodes.map((n) => n.label))}\n`)
  process.stdout.write(
    `     04 qualifier hueCenter=${spillNode.params.qualifier.hueCenter} satHigh=${spillNode.params.qualifier.satHigh} ` +
      `saturation=${spillNode.params.saturation}\n`,
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
