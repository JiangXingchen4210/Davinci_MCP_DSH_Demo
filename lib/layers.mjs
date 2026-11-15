/**
 * 分层图像分析引擎（纯 Node / ESM，无 npm 依赖）。
 *
 * 用途：给「达芬奇控制面板」的深度色调匹配提供**证据层**。
 *   1. analyzeFrame(img)  —— 用 ffmpeg 把一张 PNG/JPG 缩到固定宽度、解成 RGB24 裸像素，
 *      再逐像素分成 6 层（global / skin / highlight / shadow / background / neutral），
 *      每层输出可解释的统计量（均值、luma 分位、饱和度、色相、覆盖率、是否可信）。
 *   2. compareLayers(ref, tgt) —— 把参考帧每一层「像」的统计量翻译成 ASC CDL
 *      （Slope=gain / Offset=lift / Power=gamma / Saturation），供
 *      timeline_item_color.safe_set_cdl 直接落到 Resolve 片段上。
 *
 * 设计约束（很重要）：
 *   - 唯一允许的子进程是 ffmpeg；没有 numpy/PIL/cv2/sharp，全部纯 JS。
 *   - 输出必须可 JSON.stringify：不产生 NaN / Infinity，没有数据的字段用 null。
 *   - compareLayers 的**恒等性**是硬要求：同一张图与自身比较必须得到
 *     Slope=[1,1,1]、Offset=[0,0,0]、Power=[1,1,1]、Saturation=1（容差 1e-3 内）。
 *     实现上所有比值都取自同一套浮点运算，a===b 时除法/减法精确给出 1 或 0。
 *   - 分层互斥：每个像素在 {skin, highlight, shadow, background} 里**恰好属于一层**，
 *     四层覆盖率相加 = 100%。neutral 是**独立叠加层**（低饱和中性面可能是背景，也可能是
 *     高光里的镜面），因此它可以和其它层重叠 —— 这是有意为之，不是重复计数。
 *
 * 分层顺序（先算谁、谁吃掉谁）：
 *   1) 先按 luma 排序，用**排名**切出最暗的 8%（shadow）与最亮的 3%（highlight）。
 *      用排名而不是阈值，是为了让这两层覆盖率稳定在 8% / 3%（平坦画面也一样），
 *      再用动态范围（p95-p5）判断这种分位切分是否可信。
 *   2) 剩下的像素里跑肤色候选（YCbCr 盒 + 色相/饱和度闸门）。
 *   3) 再剩下的全部归 background（背景色相直方图只在这一层统计）。
 *   4) neutral 单独对全部像素判定（sat<0.12 且 luma 0.2–0.85）。
 *
 * 阈值全部集中在 THRESHOLDS 里，插件后续要微调只改这一个对象即可；
 * analyzeFrame 的输出会带上 thresholdsVersion，方便追溯“当时用的哪套阈值”。
 *
 * CLI（stdout 只输出 JSON，stderr 放错误/用法）：
 *   node lib/layers.mjs analyze <img>   [--json] [--width 320] [--ffmpeg <ffmpeg>]
 *   node lib/layers.mjs match  <refImg> <tgtImg> [--json] [--width 320] [--ffmpeg <ffmpeg>]
 *   --json 输出单行紧凑 JSON（便于 child_process 解析）；默认输出 2 空格缩进 JSON。
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const VERSION = '1.0.0'

/** 层名（顺序固定：global 永远存在，其余按“先算谁”排列）。 */
export const LAYER_NAMES = Object.freeze([
  'global',
  'skin',
  'highlight',
  'shadow',
  'background',
  'neutral',
])

const LAYER_LABEL = Object.freeze({
  global: '全局',
  skin: '肤色',
  highlight: '高光',
  shadow: '暗部',
  background: '背景',
  neutral: '中性面',
})

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * 全部可调阈值（集中管理；analyzeFrame 输出会带上这份对象的快照版本号）。
 *
 * 单位说明：
 *   - Y / Cb / Cr 都是 ITU-R BT.601 **全范围**（0–255），即 JPEG/ffmpeg rgb→yuv 常用的那套；
 *     经典肤色盒 Cb 77–127 / Cr 133–173 就出自这套坐标。这里把 Cb 下限收到 85，
 *     因为 0xb8a24a 这类**暖黄色**（Cb≈80.3, Cr≈146.2）会落进 77–127 的宽松盒子里，
 *     收窄后黄背景不再被误判成肤色（同时保留真实肤色的余量：0xc98f72 的 Cb≈103.7）。
 *   - luma = Y / 255（0–1），后面的 p5/p50/p95 都是这个归一化 luma。
 *   - coverage 写进输出时是**百分数**（0–100）。
 */
export const THRESHOLDS = deepFreeze({
  version: VERSION,
  decode: {
    defaultWidth: 320, // 默认分析宽度（单帧 < 1.5 s 的目标尺寸）
    minWidth: 32,
    maxWidth: 1024,
    maxPixels: 4_000_000, // 防御性上限：拒绝异常大的解码结果
    timeoutMs: 20_000,
  },
  ranks: {
    shadowFraction: 0.08, // 最暗 8% → shadow
    highlightFraction: 0.03, // 最亮 3% → highlight
    minDynamicRange: 0.04, // p95-p5 < 0.04 视为“平坦画面”，分位分层不可信
  },
  skin: {
    // BT.601 全范围 YCbCr 盒（Cb 下限 85 是为了排除暖黄色背景）
    cbMin: 85,
    cbMax: 135,
    crMin: 133,
    crMax: 177,
    yMin: 30, // 极暗排除（0–255）
    yMax: 245, // 极亮排除（0–255）
    hueMin: 5, // 色相闸门（度）：真实肤色约 8°–45°
    hueMax: 50,
    satMin: 0.1, // 低饱和灰度不算肤色
    satMax: 0.68, // 高饱和（橙灯/彩纸）不算肤色
    minCoveragePct: 1.5, // 低于此覆盖率 → confident=false
    minPixels: 400,
  },
  highlight: {
    specularSatMax: 0.25, // 高光内再分：低饱和=镜面/玻璃，高饱和=霓虹/炫光
    minCoveragePct: 0.5,
    minDynamicRange: 0.04,
  },
  shadow: {
    minCoveragePct: 1.0,
    minDynamicRange: 0.04,
  },
  background: {
    minCoveragePct: 4,
    minPixels: 1000,
    hueBins: 12, // 30° 一桶，仅作诊断直方图
    achromaticSatMax: 0.06, // 低于此饱和度的背景像素归入“neutral 色相族”，不参与色相均值
  },
  neutral: {
    satMax: 0.12, // 低饱和
    lumaMin: 0.2, // 且亮度居中（排除死黑与高光）
    lumaMax: 0.85,
    minCoveragePct: 1.0,
  },
  stats: {
    // 全局层至少要有这么多像素才敢给统计
    minGlobalPixels: 100,
    // 层平均饱和度低于此值时，meanHue 只是舍入噪声 → 输出 null
    minSatForMeanHue: 0.02,
  },
  compare: {
    // CDL 安全钳制范围（与 spec 一致；超出就失去可应用性）
    clampSlope: [0.5, 2.0],
    clampOffset: [-0.1, 0.1],
    clampPower: [0.6, 1.6],
    clampSat: [0.5, 1.6],
    // 每层参与匹配的最低覆盖率（%）
    minCoveragePct: {
      global: 0,
      skin: 1.5,
      highlight: 0.5,
      shadow: 1.0,
      background: 4,
      neutral: 1.0,
    },
    minAnchorSpan: 0.02, // luma 锚点跨度（p95-p5）太小则退回均值比
    // 通道均值太小（近黑）时通道比不可靠，只保留灰度增益
    minChannelMean: 0.5, // 0–255 尺度
    minLumaForChannelRatio: 0.02, // 归一化 luma 0–1
    // 中位锚点残差超过此值 → 降置信并在 note 说明
    midResidualWarn: 0.08,
    // 参考中位调低于此值时残差没有意义（接近黑）
    minMidForResidual: 0.02,
    // 层平均饱和度低于此值时不做饱和度比（几乎无彩色）
    minMeanSatForRatio: 0.01,
    // note 里“白平衡偏差”的文字显示阈值（只影响文案，不影响 CDL 数值）
    wbNoteAbsoluteTolerance: 0.005,
    wbNoteRelativeTolerance: 0.01,
    // 置信度分档
    confidenceHigh: 0.8,
    confidenceMedium: 0.55,
    // 两层覆盖率都低于 minCoverage × 该倍数时额外降置信
    coveragePenaltyFactor: 2,
    epsilon: 1e-4,
    identityTolerance: 1e-3,
  },
})

// ---------------------------------------------------------------------------
// 小工具：数值、颜色空间、百分位
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

/** 钳制并记录“是否真的被钳过”，用于把“已钳制”如实写进 note / 置信度。 */
function clampTracked(value, min, max, flags) {
  if (!Number.isFinite(value)) {
    flags.clamped = true
    return min
  }
  if (value < min) {
    flags.clamped = true
    return min
  }
  if (value > max) {
    flags.clamped = true
    return max
  }
  return value
}

/** 四舍五入；非有限值返回 null，保证输出永远可 JSON 化。 */
function roundOr(value, digits = 4, fallback = null) {
  if (!Number.isFinite(value)) return fallback
  const factor = 10 ** digits
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

/** 只保留有限数字；否则用 fallback。 */
function finiteOr(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback
}

function toNumber(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** BT.601 全范围 RGB→YCbCr（0–255）。 */
function rgbToYcbcr(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  return [y, cb, cr]
}

/** HSV 色相（度，0–360）；无彩色返回 -1。 */
function hueOf(r, g, b) {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b
  const min = r < g ? (r < b ? r : b) : g < b ? g : b
  const delta = max - min
  if (delta === 0) return -1
  let hue
  if (max === r) hue = (g - b) / delta
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  hue *= 60
  if (hue < 0) hue += 360
  return hue
}

/** HSV 饱和度（0–1）。 */
function saturationOf(r, g, b) {
  const max = Math.max(r, g, b)
  if (max === 0) return 0
  return (max - Math.min(r, g, b)) / max
}

/** 12 桶（30°）色相直方图的桶号。 */
function hueBinIndex(hue, bins) {
  return Math.min(bins - 1, Math.max(0, Math.floor((hue / 360) * bins)))
}

/**
 * 色相族（暖 / 绿 / 冷 / 品红 / 无彩）。
 * 分桶边界：暖 330–360+0–60，绿 60–160，冷 160–260，品红 260–330。
 * 0xb8a24a 的色相约 48° → warm；0xc98f72 约 20° → warm（但会被 Cb 闸门挡在肤色层外）。
 */
function hueFamily(hue) {
  if (hue == null || hue < 0) return 'neutral'
  if (hue < 60 || hue >= 330) return 'warm'
  if (hue < 160) return 'green'
  if (hue < 260) return 'cool'
  return 'magenta'
}

/** 线性插值百分位；sorted 必须已升序。 */
function percentileOf(sorted, p) {
  const n = sorted.length
  if (n === 0) return null
  const pos = (n - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function lumaPercentiles(sorted) {
  return {
    p5: percentileOf(sorted, 0.05),
    p25: percentileOf(sorted, 0.25),
    p50: percentileOf(sorted, 0.5),
    p75: percentileOf(sorted, 0.75),
    p95: percentileOf(sorted, 0.95),
  }
}

function circularMeanDeg(sinSum, cosSum) {
  if (!Number.isFinite(sinSum) || !Number.isFinite(cosSum)) return null
  if (Math.abs(sinSum) < 1e-12 && Math.abs(cosSum) < 1e-12) return null
  let deg = Math.atan2(sinSum, cosSum) * DEG
  if (deg < 0) deg += 360
  return deg
}

// ---------------------------------------------------------------------------
// ffmpeg 解码
// ---------------------------------------------------------------------------

function resolveFfmpegPath(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (typeof process.env.FFMPEG_PATH === 'string' && process.env.FFMPEG_PATH.trim()) {
    return process.env.FFMPEG_PATH.trim()
  }
  const candidates = [
    '/opt/homebrew/bin/ffmpeg', // Apple Silicon Homebrew
    '/usr/local/bin/ffmpeg', // Intel Homebrew
    '/usr/bin/ffmpeg',
    'ffmpeg', // 交给 PATH
  ]
  for (const candidate of candidates) {
    if (candidate === 'ffmpeg') return candidate
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      // 继续找下一个
    }
  }
  return 'ffmpeg'
}

function makeError(message, code = 'LAYERS_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 用 ffmpeg 把图像解码成 RGB24 裸像素。
 *
 * 命令：
 *   ffmpeg -nostdin -v error -i <path> -frames:v 1 -an
 *          -vf scale=<width>:-2 -f rawvideo -pix_fmt rgb24 -
 *
 * - scale 的 `-2` 让高度取整到**偶数**（rawvideo 行对齐更稳），宽度恒为 width。
 * - 高度由收到的字节数反算：height = bytes / (3 * width)，因此不依赖 ffprobe。
 * - 失败时抛带 stderr 尾部的错误（ffmpeg 没装 / 文件不是图片 / 解码中断都能看出来）。
 */
async function decodeRgb24(imagePath, opts = {}) {
  const decodeCfg = THRESHOLDS.decode
  const width = clamp(
    Math.round(Number.isFinite(opts.width) ? opts.width : decodeCfg.defaultWidth),
    decodeCfg.minWidth,
    decodeCfg.maxWidth,
  )
  const timeoutMs = clamp(
    Math.round(Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : decodeCfg.timeoutMs),
    1000,
    120_000,
  )
  const maxBytes = decodeCfg.maxPixels * 3
  const ffmpegPath = resolveFfmpegPath(opts.ffmpegPath)
  const args = [
    '-nostdin',
    '-v',
    'error',
    '-i',
    imagePath,
    '-frames:v',
    '1',
    '-an',
    '-vf',
    `scale=${width}:-2`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]

  const startedAt = performance.now()
  const buffer = await new Promise((resolve, reject) => {
    let settled = false
    let totalBytes = 0
    let stderr = ''
    let timer = null
    const chunks = []

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }

    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 忽略：进程可能已经退出
      }
      finish(
        reject,
        makeError(`ffmpeg 解码超时（${timeoutMs} ms）：${imagePath}`, 'FFMPEG_TIMEOUT'),
      )
    }, timeoutMs)
    timer.unref?.()

    child.stdout.on('data', (chunk) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        try {
          child.kill('SIGKILL')
        } catch {
          // 忽略
        }
        finish(
          reject,
          makeError(
            `ffmpeg 解码结果过大（> ${maxBytes} 字节，约 ${decodeCfg.maxPixels} 像素），已中止：${imagePath}`,
            'DECODE_TOO_LARGE',
          ),
        )
        return
      }
      chunks.push(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      // 只保留尾部，避免异常素材刷屏
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    child.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        finish(
          reject,
          makeError(
            `找不到 ffmpeg（尝试执行 ${ffmpegPath}）。请确认已安装 ffmpeg，或用 --ffmpeg / FFMPEG_PATH 指定绝对路径。`,
            'FFMPEG_MISSING',
          ),
        )
        return
      }
      finish(reject, makeError(`无法启动 ffmpeg：${error?.message ?? error}`, 'FFMPEG_SPAWN_FAILED'))
    })

    child.on('close', (code, signal) => {
      if (settled) return
      if (code === 0) {
        const output = Buffer.concat(chunks)
        if (output.length === 0) {
          finish(
            reject,
            makeError(
              `ffmpeg 没有输出像素数据（0 字节）：${imagePath}${stderrTail(stderr)}`,
              'DECODE_EMPTY',
            ),
          )
          return
        }
        resolve(output)
        return
      }
      finish(
        reject,
        makeError(
          `ffmpeg 解码失败（退出码 ${code}${signal ? `，信号 ${signal}` : ''}）：${imagePath}${stderrTail(stderr)}`,
          'FFMPEG_FAILED',
        ),
      )
    })
  })

  const bytesPerPixel = 3
  const rowBytes = bytesPerPixel * width
  if (buffer.length % rowBytes !== 0) {
    throw makeError(
      `解码尺寸不完整：收到 ${buffer.length} 字节，无法按宽度 ${width} 切成整数行（可能 ffmpeg 输出被截断）`,
      'DECODE_BAD_SIZE',
    )
  }
  const height = buffer.length / rowBytes
  const pixels = width * height
  if (height < 2 || height > 8192 || pixels > THRESHOLDS.decode.maxPixels) {
    throw makeError(
      `解码尺寸异常：${width}x${height}（${pixels} 像素），请检查输入图像或 --width`,
      'DECODE_BAD_SIZE',
    )
  }

  return {
    buffer,
    width,
    height,
    pixels,
    ffmpegPath,
    decodeMs: performance.now() - startedAt,
  }
}

function stderrTail(stderr) {
  const text = String(stderr ?? '').trim()
  if (!text) return ''
  return `\nffmpeg stderr：\n${text}`
}

// ---------------------------------------------------------------------------
// 分层分析
// ---------------------------------------------------------------------------

function createBucket(name, hueBins) {
  return {
    name,
    n: 0,
    sumR: 0,
    sumG: 0,
    sumB: 0,
    sumY: 0,
    sumSat: 0,
    hueSin: 0,
    hueCos: 0,
    hueWeight: 0,
    ys: [],
    // highlight 专用
    specularPx: 0,
    glowPx: 0,
    // background 专用
    familyCounts: { warm: 0, green: 0, cool: 0, magenta: 0, neutral: 0 },
    familySin: { warm: 0, green: 0, cool: 0, magenta: 0 },
    familyCos: { warm: 0, green: 0, cool: 0, magenta: 0 },
    hueBins: new Array(hueBins).fill(0),
  }
}

function accumulate(bucket, r, g, b, y, sat, hue) {
  bucket.n += 1
  bucket.sumR += r
  bucket.sumG += g
  bucket.sumB += b
  bucket.sumY += y
  bucket.sumSat += sat
  bucket.ys.push(y)

  if (hue >= 0) {
    bucket.hueSin += Math.sin(hue * RAD) * sat
    bucket.hueCos += Math.cos(hue * RAD) * sat
    bucket.hueWeight += sat
  }

  if (bucket.name === 'highlight') {
    if (sat <= THRESHOLDS.highlight.specularSatMax) bucket.specularPx += 1
    else bucket.glowPx += 1
  }

  if (bucket.name === 'background') {
    const bgCfg = THRESHOLDS.background
    if (hue >= 0 && sat >= bgCfg.achromaticSatMax) {
      const family = hueFamily(hue)
      bucket.familyCounts[family] += 1
      const rad = hue * RAD
      bucket.familySin[family] += Math.sin(rad) * sat
      bucket.familyCos[family] += Math.cos(rad) * sat
      bucket.hueBins[hueBinIndex(hue, bucket.hueBins.length)] += 1
    } else {
      bucket.familyCounts.neutral += 1
    }
  }
}

/**
 * 把桶里的累加量整理成对外的层统计对象。
 * 单位：meanR/G/B 0–255；meanLuma 0–1；lumaPct 0–1；meanSat 0–1；meanHue 度或 null；
 *       coverage 百分数（0–100）。
 */
function summarizeBucket(bucket, totalPixels) {
  const coverage = totalPixels > 0 ? roundOr((100 * bucket.n) / totalPixels, 2, 0) : 0
  const base = { name: bucket.name, pixelCount: bucket.n, coverage }
  if (bucket.n === 0) {
    return {
      ...base,
      meanR: null,
      meanG: null,
      meanB: null,
      meanLuma: null,
      lumaPct: null,
      meanSat: null,
      meanHue: null,
      confident: false,
      note: '该层未检出（0 像素）',
    }
  }

  const sorted = Float64Array.from(bucket.ys).sort()
  const pct = lumaPercentiles(sorted)
  const meanSatValue = bucket.sumSat / bucket.n
  // 平均饱和度过低时色相只是舍入噪声（例如中性灰），这里给 null 而不是编一个色相
  const meanHue =
    bucket.hueWeight > 1e-9 && meanSatValue >= THRESHOLDS.stats.minSatForMeanHue
      ? circularMeanDeg(bucket.hueSin, bucket.hueCos)
      : null

  const layer = {
    ...base,
    meanR: roundOr(bucket.sumR / bucket.n, 2),
    meanG: roundOr(bucket.sumG / bucket.n, 2),
    meanB: roundOr(bucket.sumB / bucket.n, 2),
    meanLuma: roundOr(bucket.sumY / bucket.n / 255, 4),
    lumaPct: {
      p5: roundOr(pct.p5 / 255, 4),
      p25: roundOr(pct.p25 / 255, 4),
      p50: roundOr(pct.p50 / 255, 4),
      p75: roundOr(pct.p75 / 255, 4),
      p95: roundOr(pct.p95 / 255, 4),
    },
    meanSat: roundOr(meanSatValue, 4),
    meanHue: meanHue == null ? null : roundOr(meanHue, 1),
    // 同一种颜色的“UI 0–100”表示（= 度/3.6）：DRX HSL qualifier 的 hueCenter 用它
    meanHuePercent: meanHue == null ? null : roundOr(meanHue / 3.6, 1),
    confident: false,
  }

  // 动态范围（只有全局层有；其它层可以自己算 p95-p5）
  if (bucket.name === 'global') {
    layer.dynamicRange = roundOr(
      (pct.p95 - pct.p5) / 255,
      4,
    )
  }

  if (bucket.name === 'highlight') {
    const specularShare = bucket.n > 0 ? (100 * bucket.specularPx) / bucket.n : 0
    layer.split = {
      specularPixels: bucket.specularPx,
      glowPixels: bucket.glowPx,
      specularSharePct: roundOr(specularShare, 2),
      glowSharePct: roundOr(100 - specularShare, 2),
      dominantKind:
        bucket.specularPx === 0 && bucket.glowPx === 0
          ? null
          : bucket.specularPx >= bucket.glowPx
            ? 'specular'
            : 'glow',
    }
  }

  if (bucket.name === 'background') {
    const families = ['warm', 'green', 'cool', 'magenta']
    let dominantFamily = 'neutral'
    let dominantCount = bucket.familyCounts.neutral
    for (const family of families) {
      if (bucket.familyCounts[family] > dominantCount) {
        dominantCount = bucket.familyCounts[family]
        dominantFamily = family
      }
    }
    const total = bucket.n
    const dominantHueDeg = families.includes(dominantFamily)
      ? circularMeanDeg(bucket.familySin[dominantFamily], bucket.familyCos[dominantFamily])
      : null
    layer.dominantHueFamily = dominantFamily
    layer.dominantHueDeg = dominantHueDeg == null ? null : roundOr(dominantHueDeg, 1)
    layer.dominantHuePercent =
      dominantHueDeg == null ? null : roundOr(dominantHueDeg / 3.6, 1)
    layer.dominantSharePct = total > 0 ? roundOr((100 * dominantCount) / total, 2) : 0
    layer.achromaticPct = total > 0
      ? roundOr((100 * bucket.familyCounts.neutral) / total, 2)
      : 0
    layer.hueHistogram = bucket.hueBins.map((count) =>
      total > 0 ? roundOr((100 * count) / total, 2) : 0,
    )
  }

  return layer
}

function applyConfidence(layer, cfg) {
  const label = LAYER_LABEL[layer.name] ?? layer.name
  if (layer.pixelCount === 0) {
    layer.confident = false
    layer.note = layer.note ?? `未检出${label}层像素`
    return
  }

  if (layer.name === 'global') {
    layer.confident = layer.pixelCount >= THRESHOLDS.stats.minGlobalPixels
    if (!layer.confident) layer.note = '解码像素过少，全局统计不可信'
    return
  }

  if (layer.name === 'skin') {
    const skinCfg = THRESHOLDS.skin
    layer.confident =
      layer.coverage >= skinCfg.minCoveragePct && layer.pixelCount >= skinCfg.minPixels
    if (!layer.confident) {
      layer.note =
        layer.pixelCount < skinCfg.minPixels
          ? `肤色层像素数 ${layer.pixelCount} < ${skinCfg.minPixels}，不可信`
          : `肤色层覆盖 ${layer.coverage}% < ${skinCfg.minCoveragePct}%，不可信`
    }
    return
  }

  if (layer.name === 'highlight' || layer.name === 'shadow') {
    const layerCfg = layer.name === 'highlight' ? THRESHOLDS.highlight : THRESHOLDS.shadow
    const globalRange = cfg.globalDynamicRange
    const rangeOk = globalRange == null || globalRange >= layerCfg.minDynamicRange
    layer.confident = rangeOk && layer.coverage >= layerCfg.minCoveragePct
    if (!layer.confident) {
      layer.note = !rangeOk
        ? `画面动态范围仅 ${roundOr(globalRange, 4)}（p95-p5），分位分层不可靠`
        : `${LAYER_LABEL[layer.name]}层覆盖 ${layer.coverage}% < ${layerCfg.minCoveragePct}%`
    }
    return
  }

  if (layer.name === 'background') {
    const bgCfg = THRESHOLDS.background
    layer.confident =
      layer.coverage >= bgCfg.minCoveragePct && layer.pixelCount >= bgCfg.minPixels
    if (!layer.confident) {
      layer.note = `背景层覆盖 ${layer.coverage}% < ${bgCfg.minCoveragePct}%，不可信`
    }
    return
  }

  if (layer.name === 'neutral') {
    const neutralCfg = THRESHOLDS.neutral
    layer.confident = layer.coverage >= neutralCfg.minCoveragePct
    if (!layer.confident) {
      layer.note = `中性面覆盖 ${layer.coverage}% < ${neutralCfg.minCoveragePct}%，不可信`
    }
  }
}

/**
 * 对已解码的 RGB24 裸像素做分层统计（不涉及 IO，供 analyzeFrame 与高级用法复用）。
 *
 * @param {Buffer|Uint8Array} buffer RGB24，长度必须 = width*height*3
 * @param {number} width
 * @param {number} height
 * @returns {{width:number,height:number,pixels:number,layers:object,meta:object}}
 */
export function analyzeRgbBuffer(buffer, width, height) {
  const startedAt = performance.now()
  if (!(buffer instanceof Uint8Array) || buffer.length === 0) {
    throw makeError('analyzeRgbBuffer: buffer 必须是非空 Buffer/Uint8Array', 'BAD_BUFFER')
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw makeError(`analyzeRgbBuffer: 非法尺寸 ${width}x${height}`, 'BAD_SIZE')
  }
  const pixels = width * height
  if (buffer.length !== pixels * 3) {
    throw makeError(
      `analyzeRgbBuffer: buffer 长度 ${buffer.length} 与 ${width}x${height}x3=${pixels * 3} 不一致`,
      'BAD_SIZE',
    )
  }

  const skinCfg = THRESHOLDS.skin
  const neutralCfg = THRESHOLDS.neutral
  const rankCfg = THRESHOLDS.ranks

  const yArr = new Float64Array(pixels)
  const satArr = new Float64Array(pixels)
  const hueArr = new Float64Array(pixels) // -1 表示无彩色
  const skinCandidate = new Uint8Array(pixels)
  const neutralCandidate = new Uint8Array(pixels)

  // Pass A：逐像素算 luma / 饱和 / 色相 / 肤色候选 / 中性面候选
  for (let i = 0, offset = 0; i < pixels; i += 1, offset += 3) {
    const r = buffer[offset]
    const g = buffer[offset + 1]
    const b = buffer[offset + 2]
    const [y, cb, cr] = rgbToYcbcr(r, g, b)
    const sat = saturationOf(r, g, b)
    const hue = hueOf(r, g, b)

    yArr[i] = y
    satArr[i] = sat
    hueArr[i] = hue

    // 肤色候选：YCbCr 盒 + 色相/饱和度闸门（极暗/极亮在排名阶段已被排除，这里再兜一层保险）
    if (
      y >= skinCfg.yMin &&
      y <= skinCfg.yMax &&
      sat >= skinCfg.satMin &&
      sat <= skinCfg.satMax &&
      hue >= skinCfg.hueMin &&
      hue <= skinCfg.hueMax &&
      cb >= skinCfg.cbMin &&
      cb <= skinCfg.cbMax &&
      cr >= skinCfg.crMin &&
      cr <= skinCfg.crMax
    ) {
      skinCandidate[i] = 1
    }

    // 中性面候选（独立判定，允许与其它层重叠）
    const luma = y / 255
    if (
      sat < neutralCfg.satMax &&
      luma >= neutralCfg.lumaMin &&
      luma <= neutralCfg.lumaMax
    ) {
      neutralCandidate[i] = 1
    }
  }

  // Pass B：按 luma 排名切出暗部 8% / 高光 3%（排名而非阈值 ⇒ 覆盖率稳定、互斥自然成立）
  const order = new Uint32Array(pixels)
  for (let i = 0; i < pixels; i += 1) order[i] = i
  order.sort((left, right) => yArr[left] - yArr[right])

  const shadowCount = Math.max(1, Math.min(pixels - 1, Math.round(pixels * rankCfg.shadowFraction)))
  const highlightCount = Math.max(
    1,
    Math.min(pixels - shadowCount - 1, Math.round(pixels * rankCfg.highlightFraction)),
  )

  // 0=background, 1=shadow, 2=highlight, 3=skin —— 每个像素只会有一个答案
  const cls = new Uint8Array(pixels)
  for (let rank = 0; rank < shadowCount; rank += 1) cls[order[rank]] = 1
  for (let rank = pixels - highlightCount; rank < pixels; rank += 1) cls[order[rank]] = 2
  for (let i = 0; i < pixels; i += 1) {
    if (cls[i] === 0 && skinCandidate[i]) cls[i] = 3
  }

  // Pass C：按层累加（global 收全部像素；neutral 是叠加层）
  const hueBins = THRESHOLDS.background.hueBins
  const buckets = {
    global: createBucket('global', hueBins),
    skin: createBucket('skin', hueBins),
    highlight: createBucket('highlight', hueBins),
    shadow: createBucket('shadow', hueBins),
    background: createBucket('background', hueBins),
    neutral: createBucket('neutral', hueBins),
  }

  for (let i = 0, offset = 0; i < pixels; i += 1, offset += 3) {
    const r = buffer[offset]
    const g = buffer[offset + 1]
    const b = buffer[offset + 2]
    const y = yArr[i]
    const sat = satArr[i]
    const hue = hueArr[i]

    accumulate(buckets.global, r, g, b, y, sat, hue)
    if (cls[i] === 1) accumulate(buckets.shadow, r, g, b, y, sat, hue)
    else if (cls[i] === 2) accumulate(buckets.highlight, r, g, b, y, sat, hue)
    else if (cls[i] === 3) accumulate(buckets.skin, r, g, b, y, sat, hue)
    else accumulate(buckets.background, r, g, b, y, sat, hue)
    if (neutralCandidate[i]) accumulate(buckets.neutral, r, g, b, y, sat, hue)
  }

  const layers = {}
  for (const name of LAYER_NAMES) {
    layers[name] = summarizeBucket(buckets[name], pixels)
  }

  const cfg = {
    globalDynamicRange:
      layers.global.lumaPct == null
        ? null
        : layers.global.lumaPct.p95 - layers.global.lumaPct.p5,
  }
  for (const name of LAYER_NAMES) applyConfidence(layers[name], cfg)

  return {
    width,
    height,
    pixels,
    layers,
    meta: {
      analyzeMs: roundOr(performance.now() - startedAt, 1),
      thresholdsVersion: THRESHOLDS.version,
      rankCutoffs: {
        shadowPx: shadowCount,
        highlightPx: highlightCount,
      },
    },
  }
}

/**
 * 分析一张图片（PNG/JPG 等 ffmpeg 能解的格式）。
 *
 * @param {string} imagePath 图像绝对/相对路径
 * @param {{width?:number, timeoutMs?:number, ffmpegPath?:string}} [opts]
 * @returns {Promise<{version:string,imagePath:string,width:number,height:number,layers:object,meta:object}>}
 */
export async function analyzeFrame(imagePath, opts = {}) {
  if (typeof imagePath !== 'string' || !imagePath.trim()) {
    throw makeError('analyzeFrame: imagePath 必须是非空字符串', 'BAD_ARGUMENT')
  }
  const absolutePath = path.resolve(imagePath.trim())
  let stats
  try {
    stats = statSync(absolutePath)
  } catch {
    throw makeError(`图像文件不存在或不可读：${absolutePath}`, 'IMAGE_NOT_FOUND')
  }
  if (!stats.isFile()) {
    throw makeError(`不是普通文件：${absolutePath}`, 'IMAGE_NOT_FILE')
  }

  const totalStartedAt = performance.now()
  const decoded = await decodeRgb24(absolutePath, opts)
  const analyzed = analyzeRgbBuffer(decoded.buffer, decoded.width, decoded.height)
  const totalMs = performance.now() - totalStartedAt

  return {
    version: VERSION,
    imagePath: absolutePath,
    width: analyzed.width,
    height: analyzed.height,
    layers: analyzed.layers,
    meta: {
      ...analyzed.meta,
      decodeMs: roundOr(decoded.decodeMs, 1),
      totalMs: roundOr(totalMs, 1),
      ffmpegPath: decoded.ffmpegPath,
      bytesPerFrame: decoded.buffer.length,
    },
  }
}

// ---------------------------------------------------------------------------
// compareLayers：参考层 → 目标层的 CDL 拟合
// ---------------------------------------------------------------------------

/**
 * 从分析结果里取 layers 映射。允许直接传 analyzeFrame 的返回值，
 * 也允许直接传 {layers:{...}} 或一个层的映射（便于测试/进阶调用）。
 */
function normalizeLayerMap(input) {
  if (!input || typeof input !== 'object') return {}
  if (input.layers && typeof input.layers === 'object') return input.layers
  return input
}

function isLayerObject(value) {
  return !!value && typeof value === 'object'
}

function makeEvidence(name, refLayer, tgtLayer) {
  const pick = (layer, key) => (layer && typeof layer === 'object' ? finiteOr(layer[key], null) : null)
  const pickPct = (layer, axis) =>
    layer && layer.lumaPct && typeof layer.lumaPct === 'object'
      ? finiteOr(layer.lumaPct[axis], null)
      : null
  const refP5 = pickPct(refLayer, 'p5')
  const refP95 = pickPct(refLayer, 'p95')
  const tgtP5 = pickPct(tgtLayer, 'p5')
  const tgtP95 = pickPct(tgtLayer, 'p95')
  return {
    refCoverage: pick(refLayer, 'coverage'),
    tgtCoverage: pick(tgtLayer, 'coverage'),
    refP50: pickPct(refLayer, 'p50'),
    tgtP50: pickPct(tgtLayer, 'p50'),
    refDynamicRange: refP5 == null || refP95 == null ? null : roundOr(refP95 - refP5, 4),
    tgtDynamicRange: tgtP5 == null || tgtP95 == null ? null : roundOr(tgtP95 - tgtP5, 4),
    refMeanLuma: pick(refLayer, 'meanLuma'),
    tgtMeanLuma: pick(tgtLayer, 'meanLuma'),
    refMeanSat: pick(refLayer, 'meanSat'),
    tgtMeanSat: pick(tgtLayer, 'meanSat'),
  }
}

function identityCdl() {
  return {
    Slope: [1, 1, 1],
    Offset: [0, 0, 0],
    Power: [1, 1, 1],
    Saturation: 1,
  }
}

function lowConfidenceResult(name, note, evidence) {
  return {
    name,
    label: LAYER_LABEL[name] ?? name,
    cdl: identityCdl(),
    confidence: 'low',
    confidenceScore: 0.1,
    identity: true,
    note,
    evidence,
  }
}

function isApproximatelyIdentity(cdl, tol) {
  return (
    cdl.Slope.every((value) => Math.abs(value - 1) <= tol) &&
    cdl.Offset.every((value) => Math.abs(value) <= tol) &&
    cdl.Power.every((value) => Math.abs(value - 1) <= tol) &&
    Math.abs(cdl.Saturation - 1) <= tol
  )
}

function formatNumber(value, digits = 3) {
  if (!Number.isFinite(value)) return 'n/a'
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits
  return String(rounded)
}

function formatSigned(value, digits = 3) {
  const text = formatNumber(value, digits)
  return value > 0 ? `+${text}` : text
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a'
  return `${(value * 100).toFixed(1)}%`
}

/**
 * 单层 CDL 拟合。
 *
 * 数学（全部在归一化 luma 0–1 上）：
 *   ASC CDL 形式：out = (in * Slope + Offset) ^ Power
 *   三个锚点给出 3 个未知量：
 *     - p95（白点）→ 灰度增益  Slope = refP95 / tgtP95
 *     - p5 （黑点）→ lift      Offset = refP5 - tgtP5 * Slope
 *     - p50（中间调）→ Power   Power = ln(refP50) / ln(tgtP50*Slope + Offset)
 *   → 恒等时：Slope = x/x = 1（精确），Offset = x - x*1 = 0（精确），
 *     Power = ln(x)/ln(x) = 1（精确），所以同一张图比较必然得到严格恒等。
 *
 * 彩色偏移按 spec 走 Slope：对 R/G/B 各自乘一个“色度比”
 *   chromatic = (refCh / refLuma) / (tgtCh / tgtLuma)
 * 这样纯亮度变化只影响整体增益，只有真正的色偏才会改动通道比例（恒等时同样精确为 1）。
 * 饱和度 = refMeanSat / tgtMeanSat。
 *
 * 兜底（绝不伪造）：
 *   - 分位锚点非单调 / p95-p5 跨度过小 / 目标锚点贴近 0 → 退回亮度均值比，
 *     Offset=0、Power=1，confidence 降低并在 note 里说明。
 *   - 中位锚点无法解 gamma（midIn≈1 或 refP50≈0）→ Power=1 并降置信。
 */
function matchLayer(name, refLayer, tgtLayer, evidence) {
  const cfg = THRESHOLDS.compare
  const [slopeMin, slopeMax] = cfg.clampSlope
  const [offsetMin, offsetMax] = cfg.clampOffset
  const [powerMin, powerMax] = cfg.clampPower
  const [satMin, satMax] = cfg.clampSat
  const eps = cfg.epsilon

  const refPct = refLayer.lumaPct
  const tgtPct = tgtLayer.lumaPct
  const anchorsValid =
    refPct &&
    tgtPct &&
    Number.isFinite(refPct.p5) &&
    Number.isFinite(refPct.p50) &&
    Number.isFinite(refPct.p95) &&
    Number.isFinite(tgtPct.p5) &&
    Number.isFinite(tgtPct.p50) &&
    Number.isFinite(tgtPct.p95)
  if (!anchorsValid) {
    return lowConfidenceResult(
      name,
      `「${LAYER_LABEL[name] ?? name}」层缺少 luma 分位锚点（p5/p50/p95），返回恒等 CDL`,
      evidence,
    )
  }

  const refMeanLuma = finiteOr(refLayer.meanLuma, null)
  const tgtMeanLuma = finiteOr(tgtLayer.meanLuma, null)
  if (refMeanLuma == null || tgtMeanLuma == null) {
    return lowConfidenceResult(
      name,
      `「${LAYER_LABEL[name] ?? name}」层缺少亮度均值，返回恒等 CDL`,
      evidence,
    )
  }

  const monotone =
    refPct.p5 <= refPct.p50 + 1e-6 &&
    refPct.p50 <= refPct.p95 + 1e-6 &&
    tgtPct.p5 <= tgtPct.p50 + 1e-6 &&
    tgtPct.p50 <= tgtPct.p95 + 1e-6
  const spanOk =
    refPct.p95 - refPct.p5 >= cfg.minAnchorSpan &&
    tgtPct.p95 - tgtPct.p5 >= cfg.minAnchorSpan

  let graySlope = 1
  let offset = 0
  let power = 1
  let usedFallback = false
  let powerFallback = false
  let fallbackReason = ''
  const clampFlags = { clamped: false }

  if (!monotone) {
    usedFallback = true
    fallbackReason = '分位锚点非单调'
  } else if (!spanOk) {
    usedFallback = true
    fallbackReason = `锚点跨度不足（参考 ${formatNumber(refPct.p95 - refPct.p5)} / 目标 ${formatNumber(tgtPct.p95 - tgtPct.p5)}）`
  } else if (!(tgtPct.p95 > eps)) {
    usedFallback = true
    fallbackReason = '目标高光锚点接近 0'
  }

  if (!usedFallback) {
    // 先定增益（白点），再用“钳制后的增益”锚定 lift（黑点），两者才自洽
    graySlope = clampTracked(refPct.p95 / tgtPct.p95, slopeMin, slopeMax, clampFlags)
    offset = clampTracked(refPct.p5 - tgtPct.p5 * graySlope, offsetMin, offsetMax, clampFlags)

    const midIn = tgtPct.p50 * graySlope + offset
    const logDenominator = midIn > eps ? Math.log(midIn) : Number.NaN
    if (refPct.p50 > eps && Number.isFinite(logDenominator) && Math.abs(logDenominator) > 1e-9) {
      power = clampTracked(
        Math.log(refPct.p50) / logDenominator,
        powerMin,
        powerMax,
        clampFlags,
      )
    } else {
      power = 1
      powerFallback = true
    }
  } else {
    // 兜底：只用亮度均值比（不猜测对比/中间调）
    graySlope = clampTracked(refMeanLuma / tgtMeanLuma, slopeMin, slopeMax, clampFlags)
    offset = 0
    power = 1
  }

  // 每通道 Slope：灰度增益 × 色度比
  const refChannels = [refLayer.meanR, refLayer.meanG, refLayer.meanB].map(toNumber)
  const tgtChannels = [tgtLayer.meanR, tgtLayer.meanG, tgtLayer.meanB].map(toNumber)
  const channelSlopes = refChannels.map((refCh, index) => {
    const tgtCh = tgtChannels[index]
    const refDark = !(refCh > cfg.minChannelMean)
    const tgtDark = !(tgtCh > cfg.minChannelMean)
    const lumaOk =
      refMeanLuma > cfg.minLumaForChannelRatio && tgtMeanLuma > cfg.minLumaForChannelRatio
    if (refDark || tgtDark || !lumaOk) return graySlope // 通道太黑时通道比不可靠，只保留灰度增益
    const chromaticRatio = (refCh * tgtMeanLuma) / (tgtCh * refMeanLuma)
    if (!Number.isFinite(chromaticRatio) || chromaticRatio <= 0) return graySlope
    return clampTracked(graySlope * chromaticRatio, slopeMin, slopeMax, clampFlags)
  })

  // 饱和度
  const refSat = finiteOr(refLayer.meanSat, null)
  const tgtSat = finiteOr(tgtLayer.meanSat, null)
  let saturation = 1
  let satFallback = false
  if (
    refSat != null &&
    tgtSat != null &&
    tgtSat > cfg.minMeanSatForRatio &&
    refSat > cfg.minMeanSatForRatio
  ) {
    saturation = clampTracked(refSat / tgtSat, satMin, satMax, clampFlags)
  } else {
    satFallback = true
  }

  // 锚点残差（预测中间调 vs 参考中间调）→ 置信度与 note 依据
  const predictedMid = Math.pow(tgtPct.p50 * graySlope + offset, power)
  const midResidual = refPct.p50 > cfg.minMidForResidual
    ? Math.abs(predictedMid - refPct.p50) / refPct.p50
    : 0

  // 置信度打分（不伪造：兜底/残差大就降级）
  let score = 1
  if (usedFallback) score -= 0.35
  if (powerFallback) score -= 0.2
  if (satFallback) score -= 0.15
  if (midResidual > cfg.midResidualWarn) score -= Math.min(0.4, 0.15 + midResidual)
  if (clampFlags.clamped) score -= 0.1
  if (Number.isFinite(refLayer.coverage) && Number.isFinite(tgtLayer.coverage)) {
    const minCoverage = cfg.minCoveragePct[name] ?? 0
    if (
      refLayer.coverage < minCoverage * cfg.coveragePenaltyFactor &&
      tgtLayer.coverage < minCoverage * cfg.coveragePenaltyFactor
    ) {
      score -= 0.1
    }
  }
  score = clamp(score, 0.05, 1)
  const confidence =
    score >= cfg.confidenceHigh ? 'high' : score >= cfg.confidenceMedium ? 'medium' : 'low'

  const slopeRgb = channelSlopes.map((value) => roundOr(value, 4, 1))
  const cdl = {
    Slope: slopeRgb,
    Offset: [roundOr(offset, 4, 0), roundOr(offset, 4, 0), roundOr(offset, 4, 0)],
    Power: [roundOr(power, 4, 1), roundOr(power, 4, 1), roundOr(power, 4, 1)],
    Saturation: roundOr(saturation, 4, 1),
  }

  // 人类可读的 note（面板/模型都能直接读）
  const noteParts = []
  if (usedFallback) noteParts.push(`亮度锚点不可用（${fallbackReason}），退回亮度均值比`)
  if (powerFallback) noteParts.push('中位锚点无法解 gamma，Power 固定 1')
  if (satFallback) noteParts.push('目标层几乎无彩色，饱和度保持 1')
  if (midResidual > cfg.midResidualWarn) {
    noteParts.push(`中位锚点残差 ${(midResidual * 100).toFixed(1)}%`)
  }
  if (clampFlags.clamped) {
    noteParts.push(
      `部分参数已钳制到 CDL 安全范围（Slope ${slopeMin}–${slopeMax} / ` +
        `Offset ${offsetMin}–${offsetMax} / Power ${powerMin}–${powerMax}）`,
    )
  }
  const whiteBalance = ['R', 'G', 'B']
    .map((channel, index) => {
      const tolerance = Math.max(
        cfg.wbNoteAbsoluteTolerance,
        graySlope * cfg.wbNoteRelativeTolerance,
      )
      if (Math.abs(channelSlopes[index] - graySlope) <= tolerance) return null
      return `${channel}×${formatNumber(channelSlopes[index])}`
    })
    .filter(Boolean)
  noteParts.push(
    `亮度中位 ${formatPercent(tgtPct.p50)} → ${formatPercent(refPct.p50)}，` +
      `增益 ×${formatNumber(graySlope)}、lift ${formatSigned(offset)}、gamma ×${formatNumber(power)}、` +
      `饱和 ×${formatNumber(saturation)}` +
      (whiteBalance.length ? `，白平衡 ${whiteBalance.join(' / ')}` : ''),
  )
  const note = noteParts.join('；')

  const tolerance = cfg.identityTolerance
  return {
    name,
    label: LAYER_LABEL[name] ?? name,
    cdl,
    confidence,
    confidenceScore: roundOr(score, 3),
    identity: isApproximatelyIdentity(cdl, tolerance),
    note,
    residual: roundOr(midResidual, 4),
    usedFallback,
    clamped: clampFlags.clamped,
    evidence: {
      ...evidence,
      anchoredSlope: roundOr(graySlope, 4),
      anchoredOffset: roundOr(offset, 4),
      anchoredPower: roundOr(power, 4),
      anchorResidual: roundOr(midResidual, 4),
      channelSlopes: slopeRgb,
    },
  }
}

/** 单层匹配入口：先做证据充分性检查，再进入数学拟合。 */
function compareLayer(name, refLayer, tgtLayer) {
  const evidence = makeEvidence(name, refLayer, tgtLayer)
  const label = LAYER_LABEL[name] ?? name
  const missingSides = []
  if (!refLayer || typeof refLayer !== 'object') missingSides.push('参考帧')
  if (!tgtLayer || typeof tgtLayer !== 'object') missingSides.push('目标帧')
  if (missingSides.length > 0) {
    return lowConfidenceResult(
      name,
      `缺少${missingSides.join('与')}的「${label}」层数据，无法匹配，返回恒等 CDL`,
      evidence,
    )
  }

  const minCoverage = THRESHOLDS.compare.minCoveragePct[name] ?? 0
  const problems = []
  if (Number.isFinite(refLayer.coverage) && refLayer.coverage < minCoverage) {
    problems.push(`参考层覆盖 ${refLayer.coverage}% < ${minCoverage}%`)
  }
  if (Number.isFinite(tgtLayer.coverage) && tgtLayer.coverage < minCoverage) {
    problems.push(`目标层覆盖 ${tgtLayer.coverage}% < ${minCoverage}%`)
  }
  if (refLayer.confident === false) {
    problems.push(`参考层不可信${refLayer.note ? `（${refLayer.note}）` : ''}`)
  }
  if (tgtLayer.confident === false) {
    problems.push(`目标层不可信${tgtLayer.note ? `（${tgtLayer.note}）` : ''}`)
  }
  if (problems.length > 0) {
    return lowConfidenceResult(
      name,
      `「${label}」层证据不足：${problems.join('；')}。返回恒等 CDL，不做推测`,
      evidence,
    )
  }

  return matchLayer(name, refLayer, tgtLayer, evidence)
}

/**
 * 比较参考帧与目标帧，输出每层可落地 Resolve 的 ASC CDL。
 *
 * 返回的 cdl 形状与 index.js 的 IDENTITY_CDL 一致（Slope/Offset/Power/Saturation），
 * 宿主只需要补 NodeIndex 就能直接喂给 timeline_item_color.safe_set_cdl。
 *
 * 语义：**把目标（tgt）改造成参考（ref）的样子**。
 * 恒等保证：ref 与 tgt 是同一张图时，所有层都返回严格恒等 CDL（浮点误差 0，
 * 远小于 1e-3 容差）。
 *
 * @param {object} ref analyzeFrame 的返回值（或其 layers 映射）
 * @param {object} tgt analyzeFrame 的返回值（或其 layers 映射）
 */
export function compareLayers(ref, tgt) {
  const refLayers = normalizeLayerMap(ref)
  const tgtLayers = normalizeLayerMap(tgt)

  const layers = {}
  for (const name of LAYER_NAMES) {
    layers[name] = compareLayer(name, refLayers[name], tgtLayers[name])
  }

  const lowConfidence = LAYER_NAMES.filter((name) => layers[name].confidence === 'low')
  const usable = LAYER_NAMES.filter((name) => layers[name].confidence !== 'low')
  const identity = LAYER_NAMES.every((name) => layers[name].identity === true)
  const tolerance = THRESHOLDS.compare.identityTolerance

  return {
    version: VERSION,
    layers,
    global: layers.global,
    summary: {
      identity,
      identityTolerance: tolerance,
      usableLayers: usable,
      lowConfidenceLayers: lowConfidence,
      note: identity
        ? '各层 CDL 都在恒等容差内（参考与目标在该层证据上一致）'
        : `可用层：${usable.map((name) => LAYER_LABEL[name] ?? name).join('、') || '无'}` +
          (lowConfidence.length
            ? `；低置信层（已返回恒等 CDL）：${lowConfidence.map((name) => LAYER_LABEL[name] ?? name).join('、')}`
            : ''),
    },
    thresholdsVersion: THRESHOLDS.version,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function usageText() {
  return [
    '用法：',
    '  node lib/layers.mjs analyze <img>   [--json] [--width 320] [--ffmpeg <path>]',
    '  node lib/layers.mjs match  <refImg> <tgtImg> [--json] [--width 320] [--ffmpeg <path>]',
    '',
    '说明：stdout 只输出 JSON；stderr 输出错误与用法。--json = 单行紧凑 JSON。',
    '示例：',
    '  node lib/layers.mjs analyze frame.png --json',
    '  node lib/layers.mjs match ref.png tgt.png --width 480',
  ].join('\n')
}

function parseArgs(argv) {
  const flags = { json: false, width: undefined, ffmpegPath: undefined, help: false }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json' || arg === '--compact') {
      flags.json = true
    } else if (arg === '--pretty') {
      flags.json = false
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg === '--width') {
      const raw = argv[index + 1]
      index += 1
      const width = Number(raw)
      if (!Number.isInteger(width) || width < THRESHOLDS.decode.minWidth || width > THRESHOLDS.decode.maxWidth) {
        throw new UsageError(
          `--width 需要 ${THRESHOLDS.decode.minWidth}–${THRESHOLDS.decode.maxWidth} 的整数，收到：${raw}`,
        )
      }
      flags.width = width
    } else if (arg.startsWith('--width=')) {
      const raw = arg.slice('--width='.length)
      const width = Number(raw)
      if (!Number.isInteger(width) || width < THRESHOLDS.decode.minWidth || width > THRESHOLDS.decode.maxWidth) {
        throw new UsageError(
          `--width 需要 ${THRESHOLDS.decode.minWidth}–${THRESHOLDS.decode.maxWidth} 的整数，收到：${raw}`,
        )
      }
      flags.width = width
    } else if (arg === '--ffmpeg') {
      flags.ffmpegPath = argv[index + 1]
      index += 1
      if (!flags.ffmpegPath) throw new UsageError('--ffmpeg 需要一个路径')
    } else if (arg.startsWith('--ffmpeg=')) {
      flags.ffmpegPath = arg.slice('--ffmpeg='.length)
    } else if (arg.startsWith('--')) {
      throw new UsageError(`未知参数：${arg}`)
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

function writeJson(payload, compact) {
  const text = compact ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)
  process.stdout.write(`${text}\n`)
}

async function main(argv) {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stderr.write(`${usageText()}\n`)
    return 0
  }

  const { flags, positional } = parseArgs(argv.slice(1))
  if (flags.help) {
    process.stderr.write(`${usageText()}\n`)
    return 0
  }

  const analyzeOptions = {
    width: flags.width,
    ffmpegPath: flags.ffmpegPath,
  }

  if (command === 'analyze') {
    if (positional.length !== 1) {
      throw new UsageError(`analyze 需要 1 个图像路径，收到 ${positional.length} 个`)
    }
    const analysis = await analyzeFrame(positional[0], analyzeOptions)
    writeJson({ ok: true, command: 'analyze', ...analysis }, flags.json)
    return 0
  }

  if (command === 'match') {
    if (positional.length !== 2) {
      throw new UsageError(`match 需要 2 个图像路径（参考、目标），收到 ${positional.length} 个`)
    }
    const [refPath, tgtPath] = positional
    const [refAnalysis, tgtAnalysis] = await Promise.all([
      analyzeFrame(refPath, analyzeOptions),
      analyzeFrame(tgtPath, analyzeOptions),
    ])
    const result = compareLayers(refAnalysis, tgtAnalysis)
    writeJson(
      {
        ok: true,
        command: 'match',
        version: result.version,
        ref: {
          path: refAnalysis.imagePath,
          width: refAnalysis.width,
          height: refAnalysis.height,
        },
        tgt: {
          path: tgtAnalysis.imagePath,
          width: tgtAnalysis.width,
          height: tgtAnalysis.height,
        },
        layers: result.layers,
        global: result.global,
        summary: result.summary,
        thresholdsVersion: result.thresholdsVersion,
      },
      flags.json,
    )
    return 0
  }

  throw new UsageError(`未知命令：${command}`)
}

/** 只有直接 `node lib/layers.mjs ...` 时才跑 CLI；被 import 时安静。 */
function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
}

if (isMainModule()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      if (error instanceof UsageError) {
        process.stderr.write(`参数错误：${error.message}\n\n${usageText()}\n`)
        process.exitCode = 1
        return
      }
      process.stderr.write(`layers 分析失败：${error?.message ?? error}\n`)
      if (process.env.LAYERS_DEBUG && error?.stack) process.stderr.write(`${error.stack}\n`)
      process.exitCode = 1
    })
}

export { UsageError }
