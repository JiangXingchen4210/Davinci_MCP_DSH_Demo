/**
 * 8 层图像分析（v4）：把原 6 层拆成 8 层，回答「人物/背景/玻璃/炫光」更细的分离。
 *
 * 8 层定义（前 7 层互斥，覆盖率之和=100%；neutral 是叠加观察层，与 layers.mjs 的口径一致）：
 *   global          全图
 *   skin            YCbCr 肤色区
 *   specular        高光里的低饱和部分（镜面/玻璃反射）
 *   glare           高光里的高饱和部分（炫光/霓虹）
 *   shadow          暗部
 *   backgroundWarm  剩余像素里的暖色相簇
 *   backgroundCool  剩余像素里的冷色相簇
 *   neutral         低饱和中灰面（玻璃/中性面，叠加层）
 *
 * 数学与 layers.mjs 保持一致：p5/p50/p95 三锚点解 lift/gamma/gain，通道均值比解 Slope，
 * 饱和度均值比解 Saturation；同图自比必须严格恒等。
 */

import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const VERSION = '1.0.0'
const DEFAULT_WIDTH = 320
const THRESHOLDS = Object.freeze({
  // YCbCr 门限之外再加饱和度/色相门：真实肤色饱和度适中、色相偏橙红，
  // 否则高饱和暖色背景（沙滩/黄墙）会被误判成皮肤（实测合成暖底 sat≈0.6 会中招）。
  skin: {
    cbMin: 77, cbMax: 127, crMin: 133, crMax: 173,
    lumaMin: 0.16, lumaMax: 0.94,
    satMax: 0.58, hueMin: 0, hueMax: 52,
  },
  highlightTopPct: 0.04,
  specularSatMax: 0.18,
  shadowBottomPct: 0.08,
  chromaMin: 0.12,
  warmHues: [[0, 70], [290, 360]],
  coolHues: [[160, 290]],
  neutralSatMax: 0.12,
  neutralLumaMin: 0.15,
  neutralLumaMax: 0.9,
  minCoveragePct: 0.5,
  confidentCoveragePct: 1.5,
})
export const LAYER_NAMES = ['global', 'skin', 'specular', 'glare', 'shadow', 'backgroundWarm', 'backgroundCool', 'neutral']

function runFfmpeg(args, timeoutMs = 60_000) {
  // 二进制像素必须 encoding:'buffer'；execFile 默认 utf8 会替换非法字节，长度膨胀且内容损坏
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim().slice(-600) || 'ffmpeg 失败'))
        else resolve({ stdout, stderr: String(stderr ?? '') })
      },
    )
  })
}

export async function decodeFrame(imagePath, width = DEFAULT_WIDTH) {
  const { stdout } = await runFfmpeg([
    '-v', 'error', '-i', imagePath, '-frames:v', '1',
    '-vf', `scale=${width}:-2,format=rgb24`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ])
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
  const rows = Math.floor(buffer.length / (width * 3))
  if (rows < 8) throw new Error(`解码结果太小：${buffer.length} 字节`)
  return { width, height: rows, data: buffer.subarray(0, rows * width * 3) }
}

const clamp01 = (value) => Math.min(1, Math.max(0, value))

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const delta = max - min
  const saturation = max === 0 ? 0 : delta / max
  if (delta === 0) return { hue: null, saturation, luma }
  let hue
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  hue *= 60
  if (hue < 0) hue += 360
  return { hue, saturation, luma }
}

function rgbToYcbcr(r, g, b) {
  const y = 16 + 65.481 * r + 128.553 * g + 24.966 * b
  const cb = 128 - 37.797 * r - 74.203 * g + 112.0 * b
  const cr = 128 + 112.0 * r - 93.786 * g - 18.214 * b
  return { y, cb, cr }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))
  return sorted[index]
}

function summarizePixelSet(name, pixels) {
  if (pixels.length === 0) {
    return {
      name,
      pixelCount: 0,
      coverage: 0,
      confident: false,
      note: '该层未检出像素',
      meanR: null, meanG: null, meanB: null, meanLuma: null,
      lumaPct: { p5: null, p25: null, p50: null, p75: null, p95: null },
      meanSat: null, meanHue: null, meanHuePercent: null,
    }
  }
  let r = 0, g = 0, b = 0, luma = 0, sat = 0
  const lumaValues = []
  const hueValues = []
  for (const pixel of pixels) {
    r += pixel.r; g += pixel.g; b += pixel.b
    luma += pixel.luma; sat += pixel.saturation
    lumaValues.push(pixel.luma)
    if (pixel.hue !== null && pixel.saturation >= THRESHOLDS.chromaMin) hueValues.push(pixel.hue)
  }
  lumaValues.sort((a, b2) => a - b2)
  const count = pixels.length
  const meanLuma = luma / count
  const p5 = percentile(lumaValues, 0.05)
  const p95 = percentile(lumaValues, 0.95)
  const meanHue = hueValues.length ? hueValues.reduce((acc, value) => acc + value, 0) / hueValues.length : null
  const coverage = count > 0 ? Number(((count / pixels.total) * 100).toFixed(2)) : 0
  return {
    name,
    pixelCount: count,
    coverage,
    confident: coverage >= THRESHOLDS.confidentCoveragePct,
    meanR: Number((r / count).toFixed(2)),
    meanG: Number((g / count).toFixed(2)),
    meanB: Number((b / count).toFixed(2)),
    meanLuma: Number(meanLuma.toFixed(4)),
    lumaPct: {
      p5: Number(p5.toFixed(4)),
      p25: Number(percentile(lumaValues, 0.25).toFixed(4)),
      p50: Number(percentile(lumaValues, 0.5).toFixed(4)),
      p75: Number(percentile(lumaValues, 0.75).toFixed(4)),
      p95: Number(p95.toFixed(4)),
    },
    dynamicRange: Number((p95 - p5).toFixed(4)),
    meanSat: Number((sat / count).toFixed(4)),
    meanHue: meanHue === null ? null : Number(meanHue.toFixed(1)),
    meanHuePercent: meanHue === null ? null : Number((meanHue / 3.6).toFixed(2)),
  }
}

function inHueRanges(hue, ranges) {
  if (hue === null) return false
  return ranges.some(([lo, hi]) => (lo <= hi ? hue >= lo && hue <= hi : hue >= lo || hue <= hi))
}

/** 从一帧 RGB 缓冲分 8 层并统计。 */
export function analyzeRgb8(buffer, width, height) {
  const total = width * height
  const buckets = Object.fromEntries(['skin', 'specular', 'glare', 'shadow', 'backgroundWarm', 'backgroundCool', 'neutral'].map((name) => [name, []]))
  const globalPixels = []
  const all = []
  for (let index = 0; index < total; index += 1) {
    const r = buffer[index * 3] / 255
    const g = buffer[index * 3 + 1] / 255
    const b = buffer[index * 3 + 2] / 255
    const { hue, saturation, luma } = rgbToHsl(r, g, b)
    all.push({ r, g, b, hue, saturation, luma })
    globalPixels.push({ r, g, b, hue, saturation, luma })
  }
  // 高光/暗部按亮度排名切
  const byLuma = [...all].sort((a, b2) => a.luma - b2.luma)
  const highlightCount = Math.max(1, Math.round(total * THRESHOLDS.highlightTopPct))
  const shadowCount = Math.max(1, Math.round(total * THRESHOLDS.shadowBottomPct))
  const shadowSet = new Set(byLuma.slice(0, shadowCount))
  const highlightSet = new Set(byLuma.slice(total - highlightCount))

  for (const pixel of all) {
    // 1) 高光拆 specular / glare
    if (highlightSet.has(pixel)) {
      if (pixel.saturation < THRESHOLDS.specularSatMax) buckets.specular.push(pixel)
      else buckets.glare.push(pixel)
      continue
    }
    // 2) 暗部
    if (shadowSet.has(pixel)) {
      buckets.shadow.push(pixel)
      continue
    }
    // 3) 肤色
    const ycbcr = rgbToYcbcr(pixel.r, pixel.g, pixel.b)
    const skin = THRESHOLDS.skin
    const hueInSkin = pixel.hue === null ? true : pixel.hue >= skin.hueMin && pixel.hue <= skin.hueMax
    if (
      ycbcr.cb >= skin.cbMin && ycbcr.cb <= skin.cbMax &&
      ycbcr.cr >= skin.crMin && ycbcr.cr <= skin.crMax &&
      pixel.luma >= skin.lumaMin && pixel.luma <= skin.lumaMax &&
      pixel.saturation <= skin.satMax && hueInSkin
    ) {
      buckets.skin.push(pixel)
      continue
    }
    // 4) 背景冷暖（按色相）
    if (pixel.saturation >= THRESHOLDS.chromaMin && pixel.hue !== null) {
      if (inHueRanges(pixel.hue, THRESHOLDS.warmHues)) {
        buckets.backgroundWarm.push(pixel)
        continue
      }
      if (inHueRanges(pixel.hue, THRESHOLDS.coolHues)) {
        buckets.backgroundCool.push(pixel)
        continue
      }
    }
    // 5) 剩下的低饱和 → neutral（叠加层，不参与分区）
    if (pixel.saturation < THRESHOLDS.neutralSatMax && pixel.luma >= THRESHOLDS.neutralLumaMin && pixel.luma <= THRESHOLDS.neutralLumaMax) {
      buckets.neutral.push(pixel)
    }
  }

  const layers = { global: summarizePixelSet('global', globalPixels) }
  for (const name of ['skin', 'specular', 'glare', 'shadow', 'backgroundWarm', 'backgroundCool']) {
    const bucket = buckets[name]
    bucket.total = total
    layers[name] = summarizePixelSet(name, bucket)
  }
  const neutralBucket = buckets.neutral
  neutralBucket.total = total
  layers.neutral = summarizePixelSet('neutral', neutralBucket)
  layers.global.pixelCount = total
  layers.global.coverage = 100

  return { ok: true, version: VERSION, width, height, layers }
}

export async function analyzeFrame8(imagePath, options = {}) {
  const width = Math.max(64, Math.min(640, Number(options.width) || DEFAULT_WIDTH))
  const decoded = await decodeFrame(imagePath, width)
  const result = analyzeRgb8(decoded.data, decoded.width, decoded.height)
  return { ...result, imagePath }
}

// ---------------------------------------------------------------------------
// 匹配：与 layers.mjs 相同的 CDL 数学
// ---------------------------------------------------------------------------

const CLAMP = { slope: [0.5, 2], offset: [-0.1, 0.1], power: [0.6, 1.6], saturation: [0.5, 1.6] }
const clampRange = (value, [lo, hi]) => Math.min(hi, Math.max(lo, value))

function solveAnchored(refLayer, tgtLayer) {
  const rp5 = refLayer.lumaPct.p5
  const rp50 = refLayer.lumaPct.p50
  const rp95 = refLayer.lumaPct.p95
  const tp5 = tgtLayer.lumaPct.p5
  const tp50 = tgtLayer.lumaPct.p50
  const tp95 = tgtLayer.lumaPct.p95
  if (![rp5, rp50, rp95, tp5, tp50, tp95].every((value) => typeof value === 'number')) return null
  if (tp95 - tp5 < 0.02 || rp95 - rp5 < 0.02) return null
  const slope = (rp95 - rp5) / (tp95 - tp5)
  const offset = rp5 - tp5 * slope
  let power = 1
  if (tp50 > 0.01 && rp50 > 0.01) {
    const linearMid = (tp50 * slope) + offset
    power = Math.log(rp50) / Math.log(Math.max(1e-4, linearMid))
    if (!Number.isFinite(power) || power <= 0) power = 1
    power = clampRange(power, CLAMP.power)
  }
  return { slope, offset, power }
}

export function compareLayers8(ref, tgt) {
  const layers = {}
  for (const name of LAYER_NAMES) {
    const refLayer = ref?.layers?.[name]
    const tgtLayer = tgt?.layers?.[name]
    const identity = { Slope: [1, 1, 1], Offset: [0, 0, 0], Power: [1, 1, 1], Saturation: 1 }
    if (!refLayer || !tgtLayer || !(tgtLayer.coverage > 0) || !(refLayer.coverage > 0)) {
      layers[name] = {
        name,
        cdl: identity,
        confidence: 'low',
        identity: true,
        note: '该层在参考或目标里没有可用像素，返回恒等 CDL（不推测）',
        evidence: { refCoverage: refLayer?.coverage ?? 0, tgtCoverage: tgtLayer?.coverage ?? 0 },
      }
      continue
    }
    const anchor = solveAnchored(refLayer, tgtLayer)
    const slopeBase = anchor ? anchor.slope : refLayer.meanLuma / Math.max(1e-4, tgtLayer.meanLuma)
    const offset = anchor ? clampRange(anchor.offset, CLAMP.offset) : 0
    const power = anchor ? anchor.power : 1
    const channelSlopes = ['meanR', 'meanG', 'meanB'].map((key, channel) => {
      const refChannel = Number(refLayer[key] ?? 0)
      const tgtChannel = Number(tgtLayer[key] ?? 0)
      if (!(refChannel > 1) || !(tgtChannel > 1)) return 1
      const chromaRatio = refChannel / tgtChannel / Math.max(1e-4, refLayer.meanLuma / Math.max(1e-4, tgtLayer.meanLuma))
      return clampRange(slopeBase * chromaRatio, CLAMP.slope)
    })
    // 饱和度比值：两层都接近 0 时（例如纯白镜面）应视为恒等，不能除出 0 再被钳到 0.5
    const refSat = Number(refLayer.meanSat ?? 0)
    const tgtSat = Number(tgtLayer.meanSat ?? 0)
    let saturationRatio
    if (refSat < 0.01 && tgtSat < 0.01) saturationRatio = 1
    else if (tgtSat < 0.01) saturationRatio = CLAMP.saturation[1]
    else if (refSat < 0.01) saturationRatio = CLAMP.saturation[0]
    else saturationRatio = refSat / tgtSat
    const saturation = clampRange(saturationRatio, CLAMP.saturation)
    const lowConfidence = !refLayer.confident || !tgtLayer.confident || !anchor
    layers[name] = {
      name,
      cdl: {
        Slope: channelSlopes.map((value) => Number(value.toFixed(4))),
        Offset: [offset, offset, offset].map((value) => Number(value.toFixed(4))),
        Power: [power, power, power].map((value) => Number(value.toFixed(4))),
        Saturation: Number(saturation.toFixed(4)),
      },
      confidence: lowConfidence ? 'low' : 'high',
      identity:
        Math.abs(slopeBase - 1) < 1e-4 &&
        Math.abs(offset) < 1e-4 &&
        Math.abs(power - 1) < 1e-4 &&
        Math.abs(saturation - 1) < 1e-4,
      note: lowConfidence ? '锚点或覆盖率不足，置信度低' : `锚点解算：gain ${slopeBase.toFixed(3)} / lift ${offset.toFixed(3)} / gamma ${power.toFixed(3)}`,
      evidence: {
        refCoverage: refLayer.coverage,
        tgtCoverage: tgtLayer.coverage,
        refP50: refLayer.lumaPct.p50,
        tgtP50: tgtLayer.lumaPct.p50,
      },
    }
  }
  return { ok: true, version: VERSION, layers }
}

function parseArgs(argv) {
  const args = [...argv]
  const command = args.shift()
  const options = {}
  const positional = []
  while (args.length > 0) {
    const token = args.shift()
    if (token === '--json') options.json = true
    else if (token === '--width') options.width = Number(args.shift())
    else positional.push(token)
  }
  return { command, positional, options }
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2))
  if (command === 'analyze' && positional.length === 1) {
    const result = await analyzeFrame8(positional[0], options)
    process.stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`)
    return
  }
  if (command === 'match' && positional.length === 2) {
    const [refPath, tgtPath] = positional
    const ref = await analyzeFrame8(refPath, options)
    const tgt = await analyzeFrame8(tgtPath, options)
    process.stdout.write(`${JSON.stringify(compareLayers8(ref, tgt), null, options.json ? 0 : 2)}\n`)
    return
  }
  process.stderr.write('用法: node lib/layers8.mjs analyze <img> [--json] [--width 320]\n      node lib/layers8.mjs match <ref> <tgt> [--json]\n')
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
