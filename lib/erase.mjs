/**
 * 细线与细异物检测（擦钢丝/威亚的候选定位）。
 *
 * 思路：不做通用 CV，只做「细、直、在整段里位置稳定」的异常线检测——
 * 钢丝/威亚/灯架拉线正好符合这个特征，而且这类东西在画面里通常只有几像素宽。
 *
 * 1) 把帧用 ffmpeg 解成 256 宽灰度图；
 * 2) 对每一行 y 计算「亮度局部极值强度」：|L(y) − (L(y−k)+L(y+k))/2|，取 x 方向均值；
 *    列方向同理；
 * 3) 局部极大值 + 超过均值 2.5 个标准差 → 候选线；连续行/列合并成一条；
 * 4) 只保留在 ≥60% 帧里、位置漂移 ±3px 以内的候选（稳定的细线，而不是偶发高光）。
 *
 * CLI（stdout 只出 JSON）：
 *   node lib/erase.mjs detect <frame1> <frame2> … [--json] [--width 256] [--min-frames-ratio 0.6]
 *   node lib/erase.mjs plate <frame1> … --out <png> [--width 640]
 *   node lib/erase.mjs patch <frame1> … --plate <png> --boxes "x,y,w,h;…" --outdir DIR [--feather 4]
 * 失败走 stderr + 退出码 1。
 *
 * 擦除升级（B3，静态机位 clean plate + 补帧）：
 *   buildCleanPlate(framePaths, {width, height})
 *       逐帧解码成 RGB 小图，逐像素取**时间中位数**——偶发遮挡（细线 / 走过的人）
 *       在多数帧里不存在，中位数会还原背景。
 *   patchFramesWithPlate({frames, plate, boxes, outDir, feather=4})
 *       用 plate 的像素替换 boxes 区域（feather 4px 羽化过渡），输出 png/jpg 序列。
 */

import { execFile, spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_WIDTH = 256
const LINE_RADIUS = 3 // 判定局部极值时参照的邻域半径（像素）
const SIGMA_FACTOR = 2.5
const STABLE_DRIFT_PX = 3
const MIN_FRAMES_RATIO = 0.6

function runFfmpeg(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(-800) || 'ffmpeg 失败'))
      else resolve(stdout)
    })
  })
}

/** 解码成灰度像素（Buffer，width × height）。 */
async function decodeGray(filePath, width) {
  // 二进制像素必须走 runFfmpegBinary（encoding:'buffer'），否则 utf8 解码会毁掉数据
  const out = await runFfmpegBinary([
    '-v',
    'error',
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${width}:-2,format=gray`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-',
  ])
  const buffer = Buffer.isBuffer(out) ? out : Buffer.from(out)
  if (buffer.length === 0) throw new Error('灰度解码结果为空')
  // 容错：截断的最后一帧/最后一行直接丢掉，只要求够 8 行可分析
  const rows = Math.floor(buffer.length / width)
  if (rows < 8) throw new Error(`灰度解码结果太小：${buffer.length} 字节`)
  return { width, height: rows, data: buffer.subarray(0, rows * width) }
}

function mean(values) {
  let sum = 0
  for (const value of values) sum += value
  return sum / Math.max(1, values.length)
}

function stdDev(values, avg = mean(values)) {
  let sum = 0
  for (const value of values) sum += (value - avg) ** 2
  return Math.sqrt(sum / Math.max(1, values.length))
}

/** 单帧：返回候选线 [{axis:'horizontal'|'vertical', position, score, width}] */
export function detectLinesInFrame(frame, options = {}) {
  const { width, height, data } = frame
  const frameIndex = options.frameIndex ?? 0
  const radius = options.radius ?? LINE_RADIUS
  const sigmaFactor = options.sigmaFactor ?? SIGMA_FACTOR
  const lines = []

  const scanAxis = (axis) => {
    const count = axis === 'horizontal' ? height : width
    const span = axis === 'horizontal' ? width : height
    if (count <= radius * 2 + 1) return
    const scores = new Float64Array(count)
    for (let position = 0; position < count; position += 1) {
      let total = 0
      for (let offset = 0; offset < span; offset += 1) {
        const at = (pos, off) => (axis === 'horizontal' ? data[pos * width + off] : data[off * width + pos])
        const center = at(position, offset)
        const before = position - radius >= 0 ? at(position - radius, offset) : center
        const after = position + radius < count ? at(position + radius, offset) : center
        total += Math.abs(center - (before + after) / 2)
      }
      scores[position] = total / span
    }
    const avg = mean(scores)
    const deviation = stdDev(scores, avg)
    const threshold = avg + sigmaFactor * deviation
    for (let position = radius; position < count - radius; position += 1) {
      const score = scores[position]
      if (score < threshold || score <= 0) continue
      const neighbors = [scores[position - 1], scores[position + 1]]
      if (neighbors.some((value) => value > score)) continue
      lines.push({
        axis,
        position,
        frameIndex,
        score: Number(score.toFixed(2)),
        threshold: Number(threshold.toFixed(2)),
      })
    }
  }

  scanAxis('horizontal')
  scanAxis('vertical')
  return lines
}

/**
 * 跨帧找出稳定的细线，并把坐标换算回原始分辨率。
 * @returns {{candidates: Array, framesAnalyzed: number, sourceSize: {width:number,height:number}}}
 */
export async function detectStableLines(framePaths, options = {}) {
  const width = options.width ?? DEFAULT_WIDTH
  const framesRatio = options.minFramesRatio ?? MIN_FRAMES_RATIO
  const driftTolerance = options.stableDriftPx ?? STABLE_DRIFT_PX
  if (!Array.isArray(framePaths) || framePaths.length === 0) throw new Error('detect 需要至少一帧')

  const perFrame = []
  let decodedSize = null
  for (const framePath of framePaths) {
    const gray = await decodeGray(framePath, width)
    decodedSize = { width: gray.width, height: gray.height }
    perFrame.push(detectLinesInFrame(gray, { ...options, frameIndex: perFrame.length }))
  }

  // 原始分辨率：用视频帧的实际尺寸（由调用方注入，缺省时按 16:9 推断）
  const sourceSize = options.sourceSize ?? { width: width * 7.5, height: decodedSize.height * 7.5 }
  const scaleX = sourceSize.width / decodedSize.width
  const scaleY = sourceSize.height / decodedSize.height

  const byAxis = { horizontal: [], vertical: [] }
  for (const lines of perFrame) {
    for (const line of lines) byAxis[line.axis].push(line)
  }

  const candidates = []
  for (const axis of ['horizontal', 'vertical']) {
    const all = byAxis[axis]
    if (all.length === 0) continue
    // 按 position 聚类（±drift）
    const sorted = [...all].sort((a, b) => a.position - b.position)
    const clusters = []
    for (const item of sorted) {
      const cluster = clusters[clusters.length - 1]
      if (cluster && Math.abs(item.position - cluster.center) <= driftTolerance) {
        cluster.items.push(item)
        cluster.center = mean(cluster.items.map((entry) => entry.position))
      } else {
        clusters.push({ center: item.position, items: [item] })
      }
    }
    for (const cluster of clusters) {
      const hitFrameIds = new Set(cluster.items.map((entry) => entry.frameIndex))
      const hitFrames = hitFrameIds.size
      if (hitFrames / framePaths.length < framesRatio) continue
      const position = Math.round(cluster.center)
      const thickness = Math.max(2, Math.round(2 * (options.thicknessGuess ?? 3)))
      candidates.push({
        axis,
        position,
        thickness,
        score: Number(mean(cluster.items.map((entry) => entry.score)).toFixed(2)),
        observedFrames: hitFrames,
        frameRatio: Number((hitFrames / framePaths.length).toFixed(2)),
        box:
          axis === 'horizontal'
            ? {
                x: 0,
                y: Math.max(0, Math.round(position * scaleY - thickness)),
                w: Math.round(sourceSize.width),
                h: Math.max(6, Math.round(thickness * 2 * scaleY)),
              }
            : {
                x: Math.max(0, Math.round(position * scaleX - thickness)),
                y: 0,
                w: Math.max(6, Math.round(thickness * 2 * scaleX)),
                h: Math.round(sourceSize.height),
              },
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  return { candidates, framesAnalyzed: framePaths.length, decodedSize, sourceSize }
}

/** 把候选线转成 ffmpeg delogo 可用、且不会越界的整数矩形。 */
export function toDelogoBoxes(candidates, sourceSize, options = {}) {
  const pad = options.pad ?? 4
  const boxes = []
  // 同一条线常被切成相邻两个局部极大值：按轴+位置接近去重，保留分数高的
  const kept = []
  for (const candidate of [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const close = kept.some(
      (other) =>
        other.axis === candidate.axis &&
        Math.abs((other.position ?? 0) - (candidate.position ?? 0)) <= Math.max(6, (candidate.thickness ?? 3) * 2),
    )
    if (!close) kept.push(candidate)
  }
  for (const candidate of kept) {
    const box = candidate.box
    if (!box) continue
    let x = Math.max(0, Math.round(box.x) - pad)
    let y = Math.max(0, Math.round(box.y) - pad)
    let w = Math.round(box.w) + pad * 2
    let h = Math.round(box.h) + pad * 2
    if (sourceSize) {
      if (x + w > sourceSize.width) w = sourceSize.width - x - 2
      if (y + h > sourceSize.height) h = sourceSize.height - y - 2
    }
    // delogo 的硬约束：不能贴边（x,y ≥ 2）、宽高必须偶数且 ≥ 8、不能超出画面
    const limitW = sourceSize ? sourceSize.width : Number.POSITIVE_INFINITY
    const limitH = sourceSize ? sourceSize.height : Number.POSITIVE_INFINITY
    x = Math.max(2, x)
    y = Math.max(2, y)
    w = Math.min(w, limitW - x - 2)
    h = Math.min(h, limitH - y - 2)
    w -= w % 2
    h -= h % 2
    if (w < 8 || h < 8) continue
    boxes.push({ x, y, w, h })
  }
  return boxes
}

// ---------------------------------------------------------------------------
// 擦除升级：clean plate（时间中位数）+ 补帧（静态机位）
// ---------------------------------------------------------------------------

const DEFAULT_PLATE_WIDTH = 640
const DEFAULT_FEATHER = 4

/** execFile 的 encoding 默认是 utf8，会把二进制像素当成文本解码（多字节替换 → 数据膨胀）。
 *  clean plate / 补帧必须拿原始字节，单独的二进制版本。 */
function runFfmpegBinary(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim().slice(-800) || 'ffmpeg 失败'))
        else resolve(stdout)
      },
    )
  })
}

/** 解码成 RGB 像素（Buffer，width × height × 3）。width/height 都给了就精确缩放到该尺寸。 */
async function decodeRGB(filePath, width, height) {
  const scale = Number.isFinite(height) ? `scale=${width}:${height}` : `scale=${width}:-2`
  const out = await runFfmpegBinary([
    '-v',
    'error',
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    `${scale},format=rgb24`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-',
  ])
  const buffer = Buffer.isBuffer(out) ? out : Buffer.from(out)
  if (buffer.length === 0) throw new Error('RGB 解码结果为空')
  const pixelCount = buffer.length / 3
  const actualHeight = Number.isFinite(height) ? height : Math.round(pixelCount / width)
  if (!Number.isFinite(actualHeight) || actualHeight < 1 || actualHeight * width * 3 !== buffer.length) {
    throw new Error(`RGB 解码尺寸不符：${buffer.length} 字节 / ${width} 宽`)
  }
  return { width, height: actualHeight, data: buffer.subarray(0, actualHeight * width * 3) }
}

/** 用 ffprobe 读图片/视频尺寸。 */
function probeSize(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message).trim().slice(-400) || 'ffprobe 失败'))
          return
        }
        try {
          const stream = JSON.parse(String(stdout))?.streams?.[0]
          resolve({ width: Number(stream?.width ?? 0), height: Number(stream?.height ?? 0) })
        } catch (parseError) {
          reject(new Error(`ffprobe 输出无法解析：${String(parseError)}`))
        }
      },
    )
  })
}

/** 把 RGB 原始像素编码成图片（png/jpg，按扩展名由 ffmpeg 决定）。 */
function encodeRGB(data, width, height, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-r', '1',
      '-i', '-',
      '-frames:v', '1',
      outPath,
    ], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(outPath)
      else reject(new Error(`图片编码失败（${outPath}）：${stderr.trim().slice(-600)}`))
    })
    child.stdin.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  })
}

/** 取出偶数/奇数个数数组的中位数（偶数取中间两数均值，四舍五入）。 */
function medianValue(values) {
  values.sort((a, b) => a - b)
  const mid = values.length >> 1
  if (values.length % 2 === 1) return values[mid]
  return Math.round((values[mid - 1] + values[mid]) / 2)
}

/**
 * 构建 clean plate：逐帧解码成 RGB 小图，逐像素取**时间中位数**。
 * 偶发遮挡（细线 / 走过的人 / 第 2 帧才出现的黑条）在多数帧里不存在，
 * 中位数会把这些像素恢复成背景值。
 *
 * @param {string[]} framePaths
 * @param {{width?: number, height?: number}} [options]
 * @returns {Promise<{width:number, height:number, data:Buffer, frameCount:number}>}
 */
export async function buildCleanPlate(framePaths, options = {}) {
  if (!Array.isArray(framePaths) || framePaths.length === 0) {
    throw new Error('buildCleanPlate 需要至少一帧')
  }
  const width = Math.max(1, Math.round(options.width ?? DEFAULT_PLATE_WIDTH))
  const height = Number.isFinite(options.height) ? Math.max(1, Math.round(options.height)) : undefined

  const frames = []
  for (const framePath of framePaths) {
    frames.push(await decodeRGB(framePath, width, height))
  }
  const frameHeight = frames[0].height
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== frameHeight) {
      throw new Error(`帧尺寸不一致：期望 ${width}x${frameHeight}，实际 ${frame.width}x${frame.height}`)
    }
  }

  const pixels = width * frameHeight
  const data = Buffer.alloc(pixels * 3)
  const samples = new Array(frames.length)
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const base = pixel * 3
    for (let channel = 0; channel < 3; channel += 1) {
      for (let f = 0; f < frames.length; f += 1) {
        samples[f] = frames[f].data[base + channel]
      }
      data[base + channel] = medianValue(samples)
    }
  }
  return { width, height: frameHeight, data, frameCount: frames.length }
}

/** 把 boxes 统一成整数矩形并夹到画面内。 */
function normalizePatchBoxes(boxes, width, height) {
  if (!Array.isArray(boxes) || boxes.length === 0) {
    throw new Error('patchFramesWithPlate 需要 boxes（[{x,y,w,h}]）')
  }
  const out = []
  for (const box of boxes) {
    const values = Array.isArray(box) ? box : [box?.x, box?.y, box?.w ?? box?.width, box?.h ?? box?.height]
    const [rawX, rawY, rawW, rawH] = values.map(Number)
    if (![rawX, rawY, rawW, rawH].every(Number.isFinite) || rawW <= 0 || rawH <= 0) {
      throw new TypeError(`box 数值无效: ${JSON.stringify(box)}`)
    }
    const x0 = Math.max(0, Math.floor(rawX))
    const y0 = Math.max(0, Math.floor(rawY))
    const x1 = Math.min(width, Math.ceil(rawX + rawW))
    const y1 = Math.min(height, Math.ceil(rawY + rawH))
    if (x1 <= x0 || y1 <= y0) continue
    out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
  }
  return out
}

/** 羽化权重：矩形边界为 0，向内 feather 像素线性升到 1。 */
function featherWeight(offset, size, feather) {
  if (feather <= 0) return 1
  const distance = Math.min(offset, size - offset)
  return Math.min(1, Math.max(0, distance / feather))
}

/**
 * 用 clean plate 补帧：把 boxes 区域内替换成 plate 对应像素，边界 feather 像素羽化过渡。
 * 输出文件写到 outDir（png 默认，format='jpg' 时 jpg），返回 [{path, index}]。
 *
 * @param {object} options
 * @param {string[]} options.frames 待修补帧
 * @param {{width:number,height:number,data:Buffer}} options.plate buildCleanPlate 的产物
 * @param {Array<{x:number,y:number,w:number,h:number}|number[]>} options.boxes 修补区域
 * @param {string} options.outDir 输出目录
 * @param {number} [options.feather=4] 羽化像素
 * @param {'png'|'jpg'} [options.format='png']
 * @returns {Promise<Array<{path:string, index:number, sourcePath:string}>>}
 */
export async function patchFramesWithPlate(options) {
  const { frames, plate, boxes, outDir, feather = DEFAULT_FEATHER, format = 'png' } = options ?? {}
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('patchFramesWithPlate 需要 frames')
  if (!plate || !Number.isFinite(plate.width) || !Number.isFinite(plate.height) || !plate.data) {
    throw new Error('patchFramesWithPlate 需要 {width,height,data} 形态的 plate')
  }
  const expectedBytes = plate.width * plate.height * 3
  if (plate.data.length !== expectedBytes) {
    throw new Error(`plate 数据字节数不符：${plate.data.length} ≠ ${expectedBytes}`)
  }
  if (!outDir) throw new Error('patchFramesWithPlate 需要 outDir')
  const normalizedBoxes = normalizePatchBoxes(boxes, plate.width, plate.height)
  if (normalizedBoxes.length === 0) throw new Error('patchFramesWithPlate 的 boxes 全部落在画面外')
  const ext = format === 'jpg' || format === 'jpeg' ? 'jpg' : 'png'
  const featherPx = Math.max(0, Math.round(feather))
  await fsp.mkdir(outDir, { recursive: true })

  const outputs = []
  for (const [index, framePath] of frames.entries()) {
    const frame = await decodeRGB(framePath, plate.width, plate.height)
    const data = Buffer.from(frame.data)
    for (const box of normalizedBoxes) {
      for (let y = 0; y < box.h; y += 1) {
        const wy = featherWeight(y + 0.5, box.h, featherPx)
        if (wy <= 0) continue
        for (let x = 0; x < box.w; x += 1) {
          const wx = featherWeight(x + 0.5, box.w, featherPx)
          const weight = wx * wy
          if (weight <= 0) continue
          const at = ((box.y + y) * plate.width + (box.x + x)) * 3
          if (weight >= 1) {
            data[at] = plate.data[at]
            data[at + 1] = plate.data[at + 1]
            data[at + 2] = plate.data[at + 2]
            continue
          }
          const inv = 1 - weight
          data[at] = Math.round(data[at] * inv + plate.data[at] * weight)
          data[at + 1] = Math.round(data[at + 1] * inv + plate.data[at + 1] * weight)
          data[at + 2] = Math.round(data[at + 2] * inv + plate.data[at + 2] * weight)
        }
      }
    }
    const outPath = path.join(outDir, `patch-${String(index + 1).padStart(4, '0')}.${ext}`)
    await encodeRGB(data, plate.width, plate.height, outPath)
    outputs.push({ path: outPath, index, sourcePath: framePath })
  }
  return outputs
}

/** 解析 "x,y,w,h;x,y,w,h" 形式的 boxes 参数。 */
function parseBoxesArgument(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--boxes 形如 "x,y,w,h;x,y,w,h"')
  }
  return value.split(';').map((chunk, index) => {
    const parts = chunk.split(',').map((part) => Number(part.trim()))
    if (parts.length !== 4 || !parts.every(Number.isFinite)) {
      throw new Error(`--boxes 第 ${index + 1} 段无效: "${chunk}"（需要 x,y,w,h）`)
    }
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
  })
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
    else if (token === '--min-frames-ratio') options.minFramesRatio = Number(args.shift())
    else if (token === '--source-width') options.sourceWidth = Number(args.shift())
    else if (token === '--source-height') options.sourceHeight = Number(args.shift())
    else if (token === '--out') options.out = args.shift()
    else if (token === '--plate') options.plate = args.shift()
    else if (token === '--boxes') options.boxes = args.shift()
    else if (token === '--outdir') options.outdir = args.shift()
    else if (token === '--feather') options.feather = Number(args.shift())
    else positional.push(token)
  }
  return { command, positional, options }
}

async function runPlateCli(positional, options) {
  if (!options.out) throw new Error('plate 需要 --out <png>')
  const plate = await buildCleanPlate(positional, { width: options.width })
  await fsp.mkdir(path.dirname(path.resolve(options.out)), { recursive: true })
  await encodeRGB(plate.data, plate.width, plate.height, options.out)
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: 'plate',
    path: path.resolve(options.out),
    width: plate.width,
    height: plate.height,
    frames: plate.frameCount,
  })}\n`)
}

async function runPatchCli(positional, options) {
  if (!options.plate) throw new Error('patch 需要 --plate <png>')
  if (!options.boxes) throw new Error('patch 需要 --boxes "x,y,w,h;…"')
  if (!options.outdir) throw new Error('patch 需要 --outdir DIR')
  const size = await probeSize(options.plate)
  if (!(size.width > 0 && size.height > 0)) throw new Error(`读不到 clean plate 尺寸：${options.plate}`)
  const decoded = await decodeRGB(options.plate, size.width, size.height)
  const plate = { width: decoded.width, height: decoded.height, data: decoded.data }
  const boxes = parseBoxesArgument(options.boxes)
  const files = await patchFramesWithPlate({
    frames: positional,
    plate,
    boxes,
    outDir: options.outdir,
    feather: Number.isFinite(options.feather) ? options.feather : DEFAULT_FEATHER,
  })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: 'patch',
    plate: path.resolve(options.plate),
    outdir: path.resolve(options.outdir),
    boxes,
    feather: Number.isFinite(options.feather) ? options.feather : DEFAULT_FEATHER,
    files: files.map((file) => file.path),
  })}\n`)
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2))
  if (command === 'detect') {
    if (Number.isFinite(options.sourceWidth) && Number.isFinite(options.sourceHeight)) {
      options.sourceSize = { width: options.sourceWidth, height: options.sourceHeight }
    }
    const result = await detectStableLines(positional, options)
    process.stdout.write(`${JSON.stringify({ ok: true, command: 'detect', ...result }, null, options.json ? 0 : 2)}\n`)
    return
  }
  if (command === 'plate') {
    await runPlateCli(positional, options)
    return
  }
  if (command === 'patch') {
    await runPatchCli(positional, options)
    return
  }
  process.stderr.write('用法: node lib/erase.mjs <detect|plate|patch> …（详见文件头注释）\n')
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
