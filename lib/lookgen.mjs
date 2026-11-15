/**
 * 风格 LUT 生成器（Look LUT）—— 在 Rec.709 显示空间做「风格化」而不是「色彩管理转换」。
 *
 * 为什么用 LUT 而不是节点：Resolve 的节点式 drx 在本机 beta 版上有「结构能落地、画面不一定变」
 * 的问题；而 `Graph.SetLUT` 是实测可靠的通路（set_lut → get_lut 读回一致、画面确实变化）。
 * 所以强风格的「颜色设计」用 LUT 落地，节点负责一级平衡/对比这类常规校正。
 *
 * 内置风格：
 *   cyberpunk —— 压黑 + S 曲线 + 暗部青蓝/高光品红的霓虹分离色（赛博朋克）
 *   teal-orange —— 青橙商业片色调
 *   bleach —— 漂白旁路（低饱和高对比）
 *
 * CLI（stdout 只出 JSON）：
 *   node lib/lookgen.mjs list [--json]
 *   node lib/lookgen.mjs make <preset> --out <dir> [--json] [--size 33]
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/** Rec.709 显示空间里的一条 S 曲线（围绕 pivot 提高对比）。 */
function contrastCurve(value, pivot = 0.42, strength = 1.0) {
  const x = clamp01(value)
  if (x <= pivot) return clamp01(pivot * (x / pivot) ** (1 + 0.35 * strength))
  return clamp01(pivot + (1 - pivot) * (1 - ((1 - x) / (1 - pivot)) ** (1 + 0.35 * strength)))
}

function lumaOf(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function saturationOf(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max <= 0 ? 0 : (max - min) / max
}

function applySaturation(r, g, b, factor) {
  const luma = lumaOf(r, g, b)
  return [luma + (r - luma) * factor, luma + (g - luma) * factor, luma + (b - luma) * factor].map(clamp01)
}

/**
 * 赛博朋克（收敛版）。
 * 教训：上一版强压黑 + 大幅推蓝，在夜戏上直接造成黑色断层和「整屏蓝」。
 * 现在只做「一点点」：不压黑（保留原黑位）、S 曲线很轻、分离色权重减半、饱和只提一点。
 */
function cyberpunk(rgb) {
  const [r0, g0, b0] = rgb.map(clamp01)
  let [r, g, b] = [r0, g0, b0]
  // 1) 很轻的 S 曲线（不压黑，只把中间调对比拉开一点）
  r = contrastCurve(r, 0.44, 0.35)
  g = contrastCurve(g, 0.44, 0.35)
  b = contrastCurve(b, 0.44, 0.35)
  // 2) 分离色：暗部一点点青（G+B），高光一点点品红（R+B）—— 权重很小
  const luma = lumaOf(r, g, b)
  const shadowWeight = (1 - Math.min(1, luma / 0.4)) ** 1.8
  const highlightWeight = (Math.max(0, (luma - 0.55) / 0.45)) ** 1.6
  r += -0.006 * shadowWeight + 0.055 * highlightWeight
  g += 0.035 * shadowWeight - 0.014 * highlightWeight
  b += 0.075 * shadowWeight + 0.038 * highlightWeight
  // 3) 饱和度只提 6%
  ;[r, g, b] = applySaturation(clamp01(r), clamp01(g), clamp01(b), 1.06)
  return [r, g, b].map(clamp01)
}

/** 青橙：暗部偏青、高光偏橙。 */
function tealOrange(rgb) {
  let [r, g, b] = rgb.map(clamp01)
  const luma = lumaOf(r, g, b)
  const shadowWeight = (1 - Math.min(1, luma / 0.4)) ** 1.4
  const highlightWeight = Math.max(0, (luma - 0.45) / 0.55) ** 1.2
  r += highlightWeight * 0.10 - shadowWeight * 0.05
  g += shadowWeight * 0.04
  b += shadowWeight * 0.14 - highlightWeight * 0.06
  ;[r, g, b] = applySaturation(clamp01(r), clamp01(g), clamp01(b), 1.12)
  return [r, g, b].map((value) => contrastCurve(clamp01(value), 0.44, 0.7))
}

/** 漂白旁路：去饱和 + 拉对比。 */
function bleach(rgb) {
  let [r, g, b] = rgb.map(clamp01)
  const luma = lumaOf(r, g, b)
  const desat = saturationOf(r, g, b)
  const amount = 0.55 * desat
  r = r * (1 - amount) + luma * amount
  g = g * (1 - amount) + luma * amount
  b = b * (1 - amount) + luma * amount
  return [contrastCurve(r, 0.38, 1.6), contrastCurve(g, 0.38, 1.6), contrastCurve(b, 0.38, 1.6)]
}

/** 《教父》(1972, Gordon Willis)：暖琥珀高光 + 浓密暖黑 + 低饱和 + 柔和肩部。 */
function godfather(rgb) {
  let [r, g, b] = rgb.map(clamp01)
  const luma = lumaOf(r, g, b)
  // 1) 暗部压深并染暖（棕黑），但保留细节：用平滑幂函数而不是硬截断
  const shadow = 1 - Math.min(1, luma / 0.42)
  r *= 1 - 0.18 * shadow
  g *= 1 - 0.24 * shadow
  b *= 1 - 0.34 * shadow
  r += 0.030 * shadow
  g += 0.016 * shadow
  b += 0.004 * shadow
  // 2) 高光染暖琥珀（Gordon Willis 的窗光/台灯）
  const highlight = Math.max(0, (luma - 0.5) / 0.5) ** 1.3
  r += 0.075 * highlight
  g += 0.040 * highlight
  b += 0.004 * highlight
  // 3) 低饱和 + 柔和 S 曲线
  ;[r, g, b] = applySaturation(clamp01(r), clamp01(g), clamp01(b), 0.82)
  r = contrastCurve(r, 0.40, 0.55)
  g = contrastCurve(g, 0.40, 0.55)
  b = contrastCurve(b, 0.40, 0.55)
  return [r, g, b].map(clamp01)
}

/** 《情书》(1995, 岩井俊二)：高调、低反差、奶白暗部、微微偏冷 + 高光轻粉。 */
function loveLetter(rgb) {
  let [r, g, b] = rgb.map(clamp01)
  const luma = lumaOf(r, g, b)
  // 1) 抬黑（奶白暗部）——这是 Love Letter 最标志性的「灰色不发死」
  r = 0.045 + r * 0.955
  g = 0.050 + g * 0.950
  b = 0.058 + b * 0.942
  // 2) 降反差（肩部拉开、亮部柔）
  r = contrastCurve(r, 0.5, -0.8)
  g = contrastCurve(g, 0.5, -0.8)
  b = contrastCurve(b, 0.5, -0.8)
  // 3) 高光轻粉、暗部微冷
  const highlight = Math.max(0, (luma - 0.62) / 0.38) ** 1.2
  const shadow = 1 - Math.min(1, luma / 0.3)
  r += 0.020 * highlight - 0.004 * shadow
  g += 0.006 * highlight + 0.002 * shadow
  b += 0.010 * highlight + 0.014 * shadow
  // 4) 低饱和（粉彩感）
  ;[r, g, b] = applySaturation(clamp01(r), clamp01(g), clamp01(b), 0.88)
  return [r, g, b].map(clamp01)
}

/**
 * 《地狱尖兵》(Лучшие в аду / Best in Hell, 2023)：俄式战争片质感——
 *   · 低饱和钢铁灰、脏污的冷高光、压暗的暖尘暗部
 *   · 高反差 + 轻微黄绿中灰（战场脏感），几乎不保留鲜艳色
 */
function hellsoldier(rgb) {
  const [r0, g0, b0] = rgb.map(clamp01)
  let [r, g, b] = [r0, g0, b0]
  const luma = lumaOf(r, g, b)
  // 1) 强对比 S 曲线（战争片硬调）
  r = contrastCurve(r, 0.42, 1.35)
  g = contrastCurve(g, 0.42, 1.35)
  b = contrastCurve(b, 0.42, 1.35)
  // 2) 压暗部 + 暖尘（棕灰，不是纯黑）
  const shadow = (1 - Math.min(1, luma / 0.4)) ** 1.4
  r += -0.012 * shadow + 0.020 * shadow
  g += -0.014 * shadow + 0.014 * shadow
  b += -0.020 * shadow + 0.006 * shadow
  // 3) 高光去暖、发脏（冷钢铁高光）
  const highlight = (Math.max(0, (luma - 0.55) / 0.45)) ** 1.3
  r += -0.020 * highlight
  g += -0.008 * highlight
  b += 0.012 * highlight
  // 4) 大幅降饱和（保留 62%），并把中灰往黄绿推一点（战场脏）
  ;[r, g, b] = applySaturation(clamp01(r), clamp01(g), clamp01(b), 0.62)
  const midWeight = Math.max(0, 1 - Math.abs(luma - 0.45) / 0.35)
  r += 0.006 * midWeight
  g += 0.010 * midWeight
  b += -0.004 * midWeight
  return [r, g, b].map(clamp01)
}

const LOOKS = {
  hellsoldier: {
    label: '《地狱尖兵》质感（钢铁灰 / 低饱和 / 硬对比 / 脏暖暗部）',
    fn: hellsoldier,
    guardOverrides: { blackPctDelta: 6, nearBlackPctDelta: 9, shadowBlueCastDeltaMax: 6, hueShiftMaxDeg: 20, satDeltaMax: 0.3 },
  },
  cyberpunk: { label: '赛博朋克（压黑 / 青蓝暗部 / 品红高光）', fn: cyberpunk },
  'teal-orange': { label: '青橙商业色调', fn: tealOrange },
  bleach: { label: '漂白旁路', fn: bleach },
  godfather: {
    label: '《教父》质感（暖琥珀高光 / 浓密暖黑 / 低饱和）',
    fn: godfather,
    // 风格本身就要压黑染暖：护栏按「意图例外」放宽，但仍会报告实际数值
    guardOverrides: { blackPctDelta: 8, nearBlackPctDelta: 12, shadowBlueCastDeltaMax: -6, hueShiftMaxDeg: 22, satDeltaMax: 0.2 },
  },
  'love-letter': {
    label: '《情书》质感（高调 / 低反差 / 奶白暗部 / 粉彩低饱和）',
    fn: loveLetter,
    guardOverrides: { blackPctDelta: 2, nearBlackPctDelta: 3, shadowBlueCastDeltaMax: 10, hueShiftMaxDeg: 18, satDeltaMax: 0.16 },
  },
}

export function listLooks() {
  return Object.entries(LOOKS).map(([key, look]) => ({
    key,
    label: look.label,
    guardOverrides: look.guardOverrides ?? null,
  }))
}

export function getLookGuardOverrides(preset) {
  return LOOKS[preset]?.guardOverrides ?? null
}

/** 生成 33³ .cube（Rec.709 in → Rec.709 out）。strength=1 满强度，0.3~0.4 是 Vibe 的「一点点」。 */
export function generateLookLut(preset, options = {}) {
  const look = LOOKS[preset]
  if (!look) throw new Error(`未知风格：${preset}（可用：${Object.keys(LOOKS).join(', ')}）`)
  const size = Math.max(2, Math.min(65, Number(options.size) || 33))
  const strength = Math.min(1, Math.max(0, Number.isFinite(Number(options.strength)) ? Number(options.strength) : 0.35))
  const lines = [
    `TITLE "${preset} look (builtin)"`,
    `# generated by dsh davinci-console lib/lookgen.mjs`,
    `# Rec.709 display in -> stylised Rec.709 display out`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ]
  for (let bIndex = 0; bIndex < size; bIndex += 1) {
    for (let gIndex = 0; gIndex < size; gIndex += 1) {
      for (let rIndex = 0; rIndex < size; rIndex += 1) {
        const input = [rIndex / (size - 1), gIndex / (size - 1), bIndex / (size - 1)]
        const stylised = look.fn(input)
        // 向恒等混合：保证「只有一点点」，不会把黑位/肤色带跑
        const out = stylised.map((value, channel) => input[channel] + (value - input[channel]) * strength)
        lines.push(`${out[0].toFixed(6)} ${out[1].toFixed(6)} ${out[2].toFixed(6)}`)
      }
    }
  }
  return { name: `${preset}-look-s${String(strength).replace('.', '')}`, content: `${lines.join('\n')}\n`, size, preset, strength }
}

export async function writeLookLut(preset, outDir, options = {}) {
  const lut = generateLookLut(preset, options)
  await fs.mkdir(outDir, { recursive: true })
  const filePath = path.join(outDir, `${lut.name}.cube`)
  await fs.writeFile(filePath, lut.content)
  return { preset, path: filePath, bytes: Buffer.byteLength(lut.content), size: lut.size }
}

function parseArgs(argv) {
  const args = [...argv]
  const command = args.shift()
  const options = {}
  const positional = []
  while (args.length > 0) {
    const token = args.shift()
    if (token === '--json') options.json = true
    else if (token === '--out') options.out = args.shift()
    else if (token === '--size') options.size = Number(args.shift())
    else positional.push(token)
  }
  return { command, positional, options }
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2))
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify({ ok: true, looks: listLooks() }, null, options.json ? 0 : 2)}\n`)
    return
  }
  if (command === 'make' && positional.length === 1) {
    const written = await writeLookLut(positional[0], options.out ?? path.join(process.cwd(), 'luts'))
    process.stdout.write(`${JSON.stringify({ ok: true, ...written }, null, options.json ? 0 : 2)}\n`)
    return
  }
  process.stderr.write('用法:\n  node lib/lookgen.mjs list [--json]\n  node lib/lookgen.mjs make <preset> --out <dir> [--json]\n')
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
