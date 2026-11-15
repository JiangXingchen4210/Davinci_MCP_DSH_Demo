/**
 * 场景 / 镜头检测（ffmpeg）。
 *
 * 用途：不移动播放头，直接从源文件找出「有几个镜头、每个镜头多长、代表帧在哪、客观指标如何」，
 * 上层（模型或面板）据此描述“这场戏在干什么”、挑可用镜头、做自动剪辑。
 *
 * CLI（stdout 只出 JSON）：
 *   node lib/scenes.mjs scan <video> [--threshold 0.3] [--outdir DIR] [--json] [--max-shots 200]
 * 失败走 stderr + 退出码 1。
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_THRESHOLD = 0.3
const FRAME_WIDTH = 640
const METRIC_SAMPLES = 4
const METRIC_WIDTH = 96

export function run(command, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message || '').trim().slice(-800) || `${command} 失败`))
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function runBinary(command, args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim().slice(-600) || `${command} 失败`))
        else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      },
    )
  })
}

export async function probe(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate,duration',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    filePath,
  ])
  const parsed = JSON.parse(stdout)
  const stream = parsed?.streams?.[0] ?? {}
  const [num, den] = String(stream.r_frame_rate ?? '24/1').split('/').map(Number)
  const fps = den ? num / den : 24
  const duration = Number(stream.duration ?? parsed?.format?.duration ?? 0)
  return { width: Number(stream.width ?? 0), height: Number(stream.height ?? 0), fps, duration }
}

/** 用 select+showinfo 找镜头切点（秒）。 */
export async function detectCuts(filePath, threshold = DEFAULT_THRESHOLD) {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-vf',
    `select='gt(scene,${threshold})',showinfo`,
    '-an',
    '-f',
    'null',
    '-',
  ])
  const cuts = new Set()
  const pattern = /pts_time:([0-9.]+)/g
  let match
  while ((match = pattern.exec(stderr)) !== null) {
    const time = Number(match[1])
    // showinfo 打印的是「被选中的帧」，即切点所在帧
    if (Number.isFinite(time) && time > 0) cuts.add(Number(time.toFixed(3)))
  }
  return [...cuts].sort((a, b) => a - b)
}

async function extractFrame(filePath, time, outPath) {
  await run('ffmpeg', [
    '-v',
    'error',
    '-ss',
    String(Math.max(0, time).toFixed(3)),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${FRAME_WIDTH}:-2`,
    '-q:v',
    '4',
    '-y',
    outPath,
  ])
  return outPath
}

/** 每镜头抽 METRIC_SAMPLES 帧、每帧解 96 宽 RGB 做统计（只起两次 ffmpeg/帧以内）。 */
async function sampleMetrics(filePath, start, end) {
  const span = Math.max(0.05, end - start)
  const frames = []
  for (let index = 0; index < METRIC_SAMPLES; index += 1) {
    const time = start + (span * (index + 0.5)) / METRIC_SAMPLES
    try {
      const buffer = await runBinary('ffmpeg', [
        '-v',
        'error',
        '-ss',
        String(time.toFixed(3)),
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${METRIC_WIDTH}:-2,format=rgb24`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ])
      if (buffer.length > 0) frames.push(buffer)
    } catch {
      /* 单帧失败不致命 */
    }
  }
  if (frames.length === 0) return null

  let lumaSum = 0
  let satSum = 0
  let greenSum = 0
  let count = 0
  let minLuma = 255
  let maxLuma = 0
  for (const frame of frames) {
    for (let offset = 0; offset + 2 < frame.length; offset += 3) {
      const r = frame[offset] / 255
      const g = frame[offset + 1] / 255
      const b = frame[offset + 2] / 255
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const saturation = max === 0 ? 0 : (max - min) / max
      const hue = hueDegrees(r, g, b, max, min)
      lumaSum += luma
      satSum += saturation
      if (hue >= 80 && hue <= 160 && saturation > 0.25) greenSum += 1
      if (luma < minLuma) minLuma = luma
      if (luma > maxLuma) maxLuma = luma
      count += 1
    }
  }
  if (count === 0) return null
  return {
    lumaMean: Number((lumaSum / count).toFixed(4)),
    lumaMin: Number(minLuma.toFixed(4)),
    lumaMax: Number(maxLuma.toFixed(4)),
    saturationMean: Number((satSum / count).toFixed(4)),
    greenDominance: Number((greenSum / count).toFixed(4)),
  }
}

function hueDegrees(r, g, b, max, min) {
  const delta = max - min
  if (delta === 0) return 0
  let hue = 0
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  hue *= 60
  if (hue < 0) hue += 360
  return hue
}

/** 主入口：扫描一个视频文件。 */
export async function scanFile(filePath, options = {}) {
  const info = await probe(filePath)
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD
  const maxShots = Number.isFinite(options.maxShots) ? options.maxShots : 200
  const cuts = await detectCuts(filePath, threshold)
  const bounds = [0, ...cuts.filter((time) => time > 0.1 && time < info.duration - 0.05), info.duration]
  const outDir = options.outDir ?? path.join(path.dirname(filePath), '.scenes', path.basename(filePath).replace(/\.[^.]+$/, ''))
  await fs.mkdir(outDir, { recursive: true })

  const shots = []
  for (let index = 0; index < bounds.length - 1 && shots.length < maxShots; index += 1) {
    const start = bounds[index]
    const end = bounds[index + 1]
    if (!(end > start)) continue
    const mid = start + (end - start) / 2
    const frames = []
    const frameTimes = []
    for (const [position, time] of [
      [0, start + (end - start) * 0.15],
      [1, mid],
      [2, start + (end - start) * 0.85],
    ]) {
      const outPath = path.join(outDir, `shot-${String(index + 1).padStart(3, '0')}-${position}.jpg`)
      try {
        await extractFrame(filePath, time, outPath)
        frames.push(outPath)
        frameTimes.push(Number(time.toFixed(3)))
      } catch {
        /* 单帧失败不影响镜头本身 */
      }
    }
    const metrics = await sampleMetrics(filePath, start, end)
    shots.push({
      index: shots.length + 1,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      duration: Number((end - start).toFixed(3)),
      frames,
      frameTimes,
      metrics,
    })
  }

  return {
    ok: true,
    command: 'scan',
    file: filePath,
    duration: Number(info.duration.toFixed(3)),
    fps: Number(info.fps.toFixed(3)),
    width: info.width,
    height: info.height,
    threshold,
    shotCount: shots.length,
    shots,
    meta: { outDir, cuts },
  }
}

function parseArgs(argv) {
  const args = [...argv]
  const command = args.shift()
  const options = {}
  const positional = []
  while (args.length > 0) {
    const token = args.shift()
    if (token === '--json') options.json = true
    else if (token === '--threshold') options.threshold = Number(args.shift())
    else if (token === '--outdir') options.outDir = args.shift()
    else if (token === '--max-shots') options.maxShots = Number(args.shift())
    else positional.push(token)
  }
  return { command, positional, options }
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2))
  if (command === 'metrics' && positional.length === 3) {
    const [file, start, end] = positional
    const info = await readMediaInfo(file)
    const from = Math.max(0, Math.min(Number(start), info.duration))
    const to = Math.max(from + 0.001, Math.min(Number(end), info.duration))
    const metrics = await sampleMetrics(file, from, to)
    process.stdout.write(`${JSON.stringify({ ok: true, command: 'metrics', file, start: from, end: to, metrics }, null, options.json ? 0 : 2)}\n`)
    return
  }
  if (command !== 'scan' || positional.length !== 1) {
    process.stderr.write('用法: node lib/scenes.mjs scan <video> [--threshold 0.3] [--outdir DIR] [--json]\n       node lib/scenes.mjs metrics <video> <startSec> <endSec> [--json]\n')
    process.exitCode = 1
    return
  }
  const result = await scanFile(positional[0], options)
  process.stdout.write(`${JSON.stringify(result, null, options.json ? 0 : 2)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
