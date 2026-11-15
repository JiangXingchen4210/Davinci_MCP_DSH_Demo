#!/usr/bin/env node
/**
 * lib/layers.mjs 自测（无测试框架，`node lib/layers.test.mjs` 直接跑）。
 *
 * 覆盖：
 *   - ffmpeg 合成图生成（黄背景 + 肤色矩形 + 中性灰块 + 暗部块 + 高光点）
 *   - analyzeFrame：尺寸/分层互斥/肤色覆盖/背景主色相/高光暗部/中性面/性能
 *   - 灰色测试图：肤色层缺失且 confident=false；中性面大面积命中
 *   - compareLayers：同一张图恒等（严格 1/0/1/1）、两张独立解码仍恒等、
 *     变暗帧得到增益 > 1、缺失层返回低置信 + 恒等 CDL、锚点跨度不足的兜底
 *   - 纯函数层测试：用伪造的层统计对象验证 lift/gamma/gain 数学
 *   - JSON 安全（无 NaN/Infinity，stringify→parse 往返一致）
 *   - CLI：analyze / match / 错误路径（stdout 只出 JSON、失败退出码非 0）
 *
 * 需求：ffmpeg 可执行（默认 /opt/homebrew/bin/ffmpeg；可用 FFMPEG_PATH 覆盖）。
 * 退出码 0 = 全部通过并打印 PASS 行；1 = 有失败。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  analyzeFrame,
  compareLayers,
  LAYER_NAMES,
  THRESHOLDS,
  VERSION,
} from './layers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LAYERS_MODULE = path.join(HERE, 'layers.mjs')
const FIXTURE_DIR = path.join(HERE, 'fixtures')

const FIXTURE = {
  portrait: path.join(FIXTURE_DIR, 'portrait.png'),
  portraitDark: path.join(FIXTURE_DIR, 'portrait-dark.png'),
  gray: path.join(FIXTURE_DIR, 'gray.png'),
  portraitJpg: path.join(FIXTURE_DIR, 'portrait.jpg'),
}

// ---------------------------------------------------------------------------
// 测试小工具
// ---------------------------------------------------------------------------

const tests = []

/** 注册一个测试（按注册顺序串行执行）。 */
function test(name, fn) {
  tests.push({ name, fn })
}

function fail(message) {
  throw new Error(message)
}

function assertRange(value, min, max, label) {
  assert.ok(
    Number.isFinite(value) && value >= min && value <= max,
    `${label}: 期望落在 [${min}, ${max}]，实际 ${value}`,
  )
}

function assertClose(actual, expected, tolerance, label) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: 期望 ≈ ${expected}（±${tolerance}），实际 ${actual}`,
  )
}

function assertIdentityCdl(cdl, label, tolerance = THRESHOLDS.compare.identityTolerance) {
  assert.ok(cdl && typeof cdl === 'object', `${label}: 缺少 cdl`)
  for (let index = 0; index < 3; index += 1) {
    assertClose(cdl.Slope[index], 1, tolerance, `${label}.Slope[${index}]`)
    assertClose(cdl.Offset[index], 0, tolerance, `${label}.Offset[${index}]`)
    assertClose(cdl.Power[index], 1, tolerance, `${label}.Power[${index}]`)
  }
  assertClose(cdl.Saturation, 1, tolerance, `${label}.Saturation`)
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
  fail(`${trail}: 不可 JSON 化的值（${typeof value}）`)
}

function assertAllLayers(result) {
  for (const name of LAYER_NAMES) {
    assert.ok(result.layers[name], `缺少层：${name}`)
  }
}

function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  if (probe.status === 0) return 'ffmpeg'
  throw new Error(
    '测试需要 ffmpeg：未在 /opt/homebrew/bin/ffmpeg、/usr/local/bin/ffmpeg、/usr/bin/ffmpeg 或 PATH 找到。' +
      '可设置 FFMPEG_PATH 指向可执行文件。',
  )
}

function runFfmpeg(ffmpeg, args) {
  const result = spawnSync(ffmpeg, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  })
  if (result.error) throw new Error(`无法运行 ffmpeg：${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`ffmpeg 失败（退出码 ${result.status}）：\n${result.stderr ?? ''}`)
  }
  return result
}

/**
 * 生成测试图：
 *   portrait.png     384x216，黄背景 0xb8a24a + 肤色矩形 0xc98f72 + 中性灰块 + 暗部块 + 高光块
 *   portrait-dark.png 同一张图的亮度 -0.18（用于验证“非恒等”匹配方向）
 *   gray.png          testsrc2 去饱和（无肤色 → 验证缺失层 confidence=false）
 *
 * 所有图形都用 --pix_fmt rgb24 输出，颜色是逐字节精确的（drawbox 在 rgb24 上直接写 RGB，
 * 不经过 YUV 有损转换），因此 Cb/Cr/色相的阈值测试不会被编码偏移干扰。
 */
function buildFixtures(ffmpeg) {
  mkdirSync(FIXTURE_DIR, { recursive: true })

  const filters = [
    'drawbox=x=0:y=0:w=iw:h=ih:color=0xb8a24a@1:t=fill', // 暖黄背景
    'drawbox=x=20:y=20:w=56:h=36:color=0x8a8a8a@1:t=fill', // 中性灰块（neutral）
    'drawbox=x=200:y=30:w=120:h=130:color=0xc98f72@1:t=fill', // 肤色矩形（skin）
    'drawbox=x=10:y=160:w=80:h=46:color=0x14161a@1:t=fill', // 暗部块（shadow）
    'drawbox=x=330:y=14:w=36:h=32:color=0xf2f2f2@1:t=fill', // 高光块（highlight）
    'format=rgb24',
  ].join(',')

  runFfmpeg(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=384x216:d=1,format=rgb24',
    '-vf',
    filters,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    FIXTURE.portrait,
  ])

  runFfmpeg(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    FIXTURE.portrait,
    '-vf',
    'eq=brightness=-0.18,format=rgb24',
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    FIXTURE.portraitDark,
  ])

  // JPEG（有损）——验证 spec 要求的 jpg 输入路径
  runFfmpeg(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    FIXTURE.portrait,
    '-q:v',
    '3',
    '-frames:v',
    '1',
    FIXTURE.portraitJpg,
  ])

  runFfmpeg(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=384x216:rate=1:duration=1',
    '-vf',
    'hue=s=0,format=rgb24',
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    FIXTURE.gray,
  ])
}

/** 伪造一个层统计对象（用于不依赖图片的纯数学测试）。 */
function fakeLayer({ luma = 0.5, p5, p50, p95, sat = 0.3, coverage = 50, confident = true } = {}) {
  const channel = Math.round(luma * 255)
  return {
    name: 'global',
    pixelCount: 5000,
    coverage,
    meanR: channel,
    meanG: channel,
    meanB: channel,
    meanLuma: luma,
    lumaPct: {
      p5: p5 ?? Math.max(0.02, luma - 0.2),
      p25: luma,
      p50: p50 ?? luma,
      p75: luma,
      p95: p95 ?? Math.min(0.98, luma + 0.2),
    },
    meanSat: sat,
    meanHue: 35,
    confident,
  }
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

test('analyzeFrame: 尺寸与每层结构', async (ctx) => {
  const result = ctx.portrait
  assert.equal(result.width, 320, '默认分析宽度应为 320')
  assert.equal(result.height % 2, 0, `高度应为偶数（实际 ${result.height}）`)
  assertRange(result.height, 150, 220, '从 384x216 缩到 320 宽后的高度')
  assertAllLayers(result)

  for (const name of LAYER_NAMES) {
    const layer = result.layers[name]
    assert.equal(typeof layer.confident, 'boolean', `${name}.confident 必须是布尔值`)
    assertRange(layer.coverage, 0, 100, `${name}.coverage`)
    if (layer.pixelCount > 0) {
      // coverage 是保留 2 位小数的百分数，与像素数换算时允许 0.02 个百分点的舍入误差
      assertClose(
        layer.coverage,
        (100 * layer.pixelCount) / (result.width * result.height),
        0.02,
        `${name}.pixelCount 与 coverage 不自洽`,
      )
      assertRange(layer.meanR, 0, 255, `${name}.meanR`)
      assertRange(layer.meanLuma, 0, 1, `${name}.meanLuma`)
      assert.ok(layer.lumaPct.p5 <= layer.lumaPct.p50, `${name}.lumaPct 必须单调`)
      assert.ok(layer.lumaPct.p50 <= layer.lumaPct.p95, `${name}.lumaPct 必须单调`)
      assertRange(layer.meanSat, 0, 1, `${name}.meanSat`)
    }
  }
  assert.equal(result.layers.global.coverage, 100, 'global 层应覆盖 100% 像素')
})

test('analyzeFrame: 四层互斥，覆盖率相加 = 100%', async (ctx) => {
  const layers = ctx.portrait.layers
  const sum =
    layers.skin.coverage +
    layers.highlight.coverage +
    layers.shadow.coverage +
    layers.background.coverage
  assertClose(sum, 100, 0.6, 'skin+highlight+shadow+background 覆盖率之和')
  // neutral 是叠加层，允许与其它层重叠
  assert.ok(layers.neutral.coverage > 0, '中性面应命中灰色块')
})

test('analyzeFrame: 肤色层覆盖率与统计合理', async (ctx) => {
  const skin = ctx.portrait.layers.skin
  // 合成图里肤色矩形占画面约 18.8%，暗部排名会吃掉一点边缘；给宽区间
  assertRange(skin.coverage, 5, 30, '肤色层覆盖率（%）')
  assert.equal(skin.confident, true, '肤色层应被判定为可信')
  assertRange(skin.meanHue, 10, 40, '肤色层平均色相（度）')
  assertClose(skin.meanHuePercent, skin.meanHue / 3.6, 0.2, '肤色平均色相的 0–100 表示（DRX qualifier 单位）')
  assert.ok(skin.meanR > skin.meanG && skin.meanG > skin.meanB, '肤色应满足 R > G > B')
  assert.ok(skin.pixelCount >= THRESHOLDS.skin.minPixels, '肤色层像素数应超过最小阈值')
})

test('analyzeFrame: 背景主色相为暖色（黄背景）', async (ctx) => {
  const background = ctx.portrait.layers.background
  assertRange(background.coverage, 40, 90, '背景层覆盖率（%）')
  assert.equal(background.confident, true, '背景层应可信')
  assert.equal(background.dominantHueFamily, 'warm', `背景主色相族应为 warm，实际 ${background.dominantHueFamily}`)
  assertRange(background.dominantHueDeg, 30, 70, '背景主导色相（黄 ≈ 48°）')
  // DRX HSL qualifier 用 UI 0–100（encoder ÷100），度/3.6 是两套单位的换算
  assertClose(background.dominantHuePercent, background.dominantHueDeg / 3.6, 0.2, '背景主导色相的 0–100 表示')
  assert.ok(background.dominantSharePct > 50, `暖色应占背景主体（实际 ${background.dominantSharePct}%）`)
  assert.equal(background.hueHistogram.length, THRESHOLDS.background.hueBins, '色相直方图桶数')
})

test('analyzeFrame: 高光层（前 3%）与镜面/炫光拆分', async (ctx) => {
  const layers = ctx.portrait.layers
  const highlight = layers.highlight
  assertRange(highlight.coverage, 2.5, 3.5, '高光层覆盖率（按排名应为 3%）')
  assert.equal(highlight.confident, true, '高光层应可信')
  assert.ok(highlight.meanLuma > layers.global.meanLuma, '高光层 meanLuma 应高于全局')
  assert.ok(highlight.split, '高光层应带 split 拆分')
  assert.ok(highlight.split.specularPixels > 0, '应有低饱和镜面/玻璃像素')
  assert.ok(highlight.split.glowPixels > 0, '应有高饱和霓虹/炫光像素')
  assert.equal(
    highlight.split.specularPixels + highlight.split.glowPixels,
    highlight.pixelCount,
    '高光拆分像素数应等于该层像素数',
  )
})

test('analyzeFrame: 暗部层（后 8%）更暗', async (ctx) => {
  const layers = ctx.portrait.layers
  const shadow = layers.shadow
  assertRange(shadow.coverage, 7, 9, '暗部层覆盖率（按排名应为 8%）')
  assert.equal(shadow.confident, true, '暗部层应可信')
  assert.ok(shadow.meanLuma < layers.global.meanLuma, '暗部层 meanLuma 应低于全局')
})

test('analyzeFrame: 中性面命中灰块', async (ctx) => {
  const neutral = ctx.portrait.layers.neutral
  assertRange(neutral.coverage, 1, 6, '中性面覆盖率（%）')
  assert.equal(neutral.confident, true, '中性面层应可信')
  assertRange(neutral.meanSat, 0, 0.12, '中性面平均饱和度应很低')
  // 灰块 RGB 三通道几乎相等
  assertClose(neutral.meanR, neutral.meanG, 2.5, '中性面 R≈G')
  assertClose(neutral.meanG, neutral.meanB, 2.5, '中性面 G≈B')
})

test('analyzeFrame: 支持 jpg 输入与 opts.width', async (ctx) => {
  const fromJpg = await analyzeFrame(FIXTURE.portraitJpg)
  assert.equal(fromJpg.width, 320, 'jpg 默认分析宽度')
  assert.equal(fromJpg.height % 2, 0, 'jpg 高度应为偶数')
  assert.equal(fromJpg.layers.global.coverage, 100)
  // JPEG 有损，颜色略有偏移，但肤色矩形仍应被检出
  assert.ok(fromJpg.layers.skin.coverage > 2, `jpg 中肤色覆盖率应 > 2%（实际 ${fromJpg.layers.skin.coverage}%）`)
  assert.equal(fromJpg.layers.background.dominantHueFamily, 'warm', 'jpg 背景主色相应仍为暖色')

  const half = await analyzeFrame(FIXTURE.portrait, { width: 160 })
  assert.equal(half.width, 160, 'opts.width 应生效')
  assert.equal(half.height, 90, '缩放后高度应按宽高比取整')
})

test('analyzeFrame: 灰色图 → 肤色层缺失且低置信', async (ctx) => {
  const skin = ctx.gray.layers.skin
  assert.equal(skin.pixelCount, 0, '去饱和图不应检出肤色像素')
  assert.equal(skin.confident, false, '缺失的肤色层必须 confident=false')
  assert.ok(typeof skin.note === 'string' && skin.note.length > 0, '缺失层应说明原因')
  const neutral = ctx.gray.layers.neutral
  assert.ok(neutral.coverage > 40, `灰色图中性面应大面积命中（实际 ${neutral.coverage}%）`)
  assert.equal(neutral.confident, true, '灰色图中性面应可信')
})

test('compareLayers: 同一张图恒等（严格 1/0/1/1）', async (ctx) => {
  const result = compareLayers(ctx.portrait, ctx.portrait)
  assert.equal(result.summary.identity, true, 'summary.identity 应为 true')
  for (const name of LAYER_NAMES) {
    assertIdentityCdl(result.layers[name].cdl, `${name} 层恒等 CDL`)
    assert.equal(result.layers[name].identity, true, `${name} 层 identity 标记`)
  }
  assert.ok(result.global === result.layers.global, '顶层 global 应与 layers.global 一致')
})

test('compareLayers: 两次独立解码同一文件仍精确恒等（浮点确定性）', async () => {
  const first = await analyzeFrame(FIXTURE.portrait)
  const second = await analyzeFrame(FIXTURE.portrait)
  const result = compareLayers(first, second)
  assert.equal(result.summary.identity, true, '独立解码后仍应恒等')
  for (const name of LAYER_NAMES) {
    assertIdentityCdl(result.layers[name].cdl, `${name} 层跨解码恒等 CDL`, 1e-6)
  }
})

test('compareLayers: 目标变暗 → 增益 > 1、非恒等', async (ctx) => {
  const result = compareLayers(ctx.portrait, ctx.portraitDark)
  assert.equal(result.global.identity, false, '变暗帧不应被判成恒等')
  assert.notEqual(result.global.confidence, 'low', '全局层置信度不应为 low')
  assert.ok(result.global.cdl.Slope[1] > 1.05, `目标更暗时增益应 > 1（实际 ${result.global.cdl.Slope[1]}）`)
  assert.ok(result.global.cdl.Slope[1] <= 2.0, 'Slope 必须被钳制在 2.0 以内')
  assert.ok(result.global.cdl.Offset[0] >= -0.1 - 1e-9, 'Offset 必须被钳制在 -0.1 以上')
  assert.ok(result.global.cdl.Offset[0] <= 0.1 + 1e-9, 'Offset 必须被钳制在 0.1 以内')
  assert.ok(result.global.cdl.Saturation > 0.5, 'Saturation 不应到 0')
  assert.ok(result.global.note.includes('亮度中位'), 'note 应说明亮度变化')
})

test('compareLayers: 目标缺失肤色层 → 低置信 + 恒等 CDL + 原因', async (ctx) => {
  const result = compareLayers(ctx.portrait, ctx.gray)
  const skin = result.layers.skin
  assert.equal(skin.confidence, 'low', '缺失层置信度必须为 low')
  assert.equal(skin.identity, true, '缺失层不应伪造 CDL')
  assertIdentityCdl(skin.cdl, '缺失肤色层 CDL')
  assert.ok(skin.note.includes('证据不足'), `note 应说明证据不足（实际：${skin.note}）`)
})

test('compareLayers: 锚点跨度不足时退回均值比并降置信', async () => {
  // 目标层几乎平坦（p95-p5=0.01 < minAnchorSpan），不能解 lift/gamma/gain
  const ref = fakeLayer({ luma: 0.6, p5: 0.58, p50: 0.6, p95: 0.62 })
  const tgt = fakeLayer({ luma: 0.5, p5: 0.5, p50: 0.5, p95: 0.51 })
  const result = compareLayers({ layers: { global: ref } }, { layers: { global: tgt } })
  assert.ok(result.layers.global.note.includes('锚点跨度'), `note 应提到锚点跨度（实际：${result.layers.global.note}）`)
  assert.notEqual(result.layers.global.confidence, 'high', '兜底路径不应给出 high 置信')
  assertClose(result.layers.global.cdl.Slope[1], 0.6 / 0.5, 0.02, '兜底 slope = 亮度均值比')
  assertClose(result.layers.global.cdl.Offset[0], 0, 1e-9, '兜底 offset = 0')
  assertClose(result.layers.global.cdl.Power[0], 1, 1e-9, '兜底 power = 1')
})

test('compareLayers: 伪造正常层验证 lift/gamma/gain 数学', async () => {
  const ref = fakeLayer({ luma: 0.55, p5: 0.2, p50: 0.55, p95: 0.95, sat: 0.3 })
  const tgt = fakeLayer({ luma: 0.45, p5: 0.1, p50: 0.45, p95: 0.8, sat: 0.5, coverage: 60 })
  const result = compareLayers({ layers: { global: ref } }, { layers: { global: tgt } })
  const cdl = result.layers.global.cdl
  // slope = 0.95/0.8 = 1.1875；offset = 0.2 - 0.1*1.1875 = 0.08125
  assertClose(cdl.Slope[1], 1.1875, 0.01, 'Slope（白点命中）')
  assertClose(cdl.Offset[0], 0.08125, 0.01, 'Offset（黑点命中）')
  assert.ok(cdl.Power[1] > 1.0, `中间调需要提亮（实际 Power=${cdl.Power[1]}）`)
  assert.equal(cdl.Saturation, 0.6, 'Saturation = 0.3/0.5')
  assert.equal(result.layers.global.usedFallback, false, '正常锚点不应走兜底')
})

test('JSON 安全：所有输出可 stringify/parse 往返', async (ctx) => {
  const comparison = compareLayers(ctx.portrait, ctx.portraitDark)
  for (const payload of [ctx.portrait, ctx.gray, comparison]) {
    assertJsonSafe(payload)
    const text = JSON.stringify(payload)
    assert.ok(!text.includes('NaN'), '序列化结果不应出现 NaN')
    assert.ok(!text.includes('Infinity'), '序列化结果不应出现 Infinity')
    assert.equal(JSON.stringify(JSON.parse(text)), text, 'JSON 往返必须稳定')
  }
})

test('性能：320 宽单帧 analyze < 1.5s', async () => {
  const startedAt = performance.now()
  const result = await analyzeFrame(FIXTURE.portrait)
  const elapsed = performance.now() - startedAt
  assert.equal(result.width, 320)
  assert.ok(elapsed < 1500, `analyze 耗时 ${elapsed.toFixed(0)}ms，超过 1500ms 目标`)
})

test('CLI analyze --json：stdout 只有一行 JSON', async (ctx) => {
  const run = spawnSync(process.execPath, [LAYERS_MODULE, 'analyze', FIXTURE.portrait, '--json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  assert.equal(run.status, 0, `CLI 退出码应为 0，实际 ${run.status}；stderr：${run.stderr}`)
  assert.equal(run.stderr.trim(), '', `CLI 成功时不应写 stderr（实际：${run.stderr}）`)
  assert.equal(run.stdout.trim().split('\n').length, 1, '--json 应输出单行')
  const payload = JSON.parse(run.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.command, 'analyze')
  assert.equal(payload.width, 320)
  assert.equal(payload.layers.global.coverage, 100)
  assertRange(payload.layers.skin.coverage, 5, 30, 'CLI 输出的肤色覆盖率')
  ctx.cliAnalyze = payload
})

test('CLI match --json：输出恒等 CDL', async () => {
  const run = spawnSync(
    process.execPath,
    [LAYERS_MODULE, 'match', FIXTURE.portrait, FIXTURE.portrait, '--json'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  assert.equal(run.status, 0, `CLI match 退出码应为 0，实际 ${run.status}；stderr：${run.stderr}`)
  const payload = JSON.parse(run.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.command, 'match')
  assert.equal(payload.summary.identity, true)
  assertIdentityCdl(payload.global.cdl, 'CLI 恒等 CDL')
})

test('CLI 错误路径：不存在的文件 → 非 0 退出、stdout 为空、stderr 有说明', async () => {
  const missing = path.join(FIXTURE_DIR, '__not_an_image__.png')
  const run = spawnSync(process.execPath, [LAYERS_MODULE, 'analyze', missing, '--json'], {
    encoding: 'utf8',
  })
  assert.notEqual(run.status, 0, '失败时退出码必须非 0')
  assert.equal(run.stdout.trim(), '', '失败时 stdout 不应输出 JSON')
  assert.ok(run.stderr.trim().length > 0, '失败时 stderr 应有错误说明')
  assert.ok(/不存在|不可读|not found/i.test(run.stderr), `stderr 应说明文件不存在，实际：${run.stderr}`)
})

// ---------------------------------------------------------------------------
// 运行器
// ---------------------------------------------------------------------------

async function main() {
  const ffmpeg = findFfmpeg()
  buildFixtures(ffmpeg)

  // 去掉早期调试用临时图（存在就删；fixtures 目录只保留本测试生成的图）
  const stray = path.join(FIXTURE_DIR, 'probe.png')
  if (existsSync(stray)) rmSync(stray, { force: true })

  const context = {
    ffmpeg,
    portrait: await analyzeFrame(FIXTURE.portrait),
    portraitDark: await analyzeFrame(FIXTURE.portraitDark),
    gray: await analyzeFrame(FIXTURE.gray),
  }

  let passed = 0
  const failures = []
  const startedAt = performance.now()

  for (const { name, fn } of tests) {
    try {
      await fn(context)
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
      `FAIL layers.test.mjs — ${passed}/${tests.length} 通过，${failures.length} 失败（${elapsed.toFixed(0)}ms）\n`,
    )
    for (const { name, error } of failures) {
      process.stdout.write(`  - ${name}: ${error?.message ?? error}\n`)
    }
    return 1
  }

  // 恒等匹配的实测数值（汇报用，也方便回归时肉眼对比）
  const identity = compareLayers(context.portrait, context.portrait)
  const sample = identity.global.cdl
  process.stdout.write(
    `PASS layers.test.mjs — ${tests.length}/${tests.length} 项通过（${VERSION}，${elapsed.toFixed(0)}ms）\n`,
  )
  process.stdout.write(
    `     恒等实测 global: Slope=[${sample.Slope.join(',')}] Offset=[${sample.Offset.join(',')}] ` +
      `Power=[${sample.Power.join(',')}] Saturation=${sample.Saturation}\n`,
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
