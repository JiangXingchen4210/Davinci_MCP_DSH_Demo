/**
 * 声轨级「OK 条 / 废条」判断。
 *
 * 光看台词不够：一条 take 可能是纯废条（没台词、喷麦、底噪大、全程环境声），
 * 也可能是可用条（有对白、电平正常、底噪低）。这里用可测量的音频指标打分：
 *   · 语音占比（silencedetect 之外的「有声」比例）—— 没台词基本=废条
 *   · 底噪（安静段 RMS）—— 底噪高说明话筒/环境不行
 *   · 削波（true peak）—— 爆音不可用
 *   · 响度（EBU R128 integrated LUFS）—— 太低/太高都难用
 *   · 动态范围（LRA）—— 过窄可能是贴上去的静音/环境
 * 输出 ok/ng + score + reasons，供挑选镜头与剧情剪辑使用。
 */

import { execFile } from 'node:child_process'

const THRESHOLDS = Object.freeze({
  speechRatioOk: 0.12, // 有对白的最低占比
  speechRatioGood: 0.25,
  noiseFloorOkDb: -45,
  noiseFloorGoodDb: -55,
  truePeakMaxDb: -0.8,
  lufsMin: -34,
  lufsMax: -10,
  lraMin: 1.0,
})

function run(command, args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stderr) reject(new Error(error.message))
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function runBinary(command, args, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(-500) || `${command} 失败`))
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
    })
  })
}

function parseEbur128(stderr) {
  const summary = /Integrated loudness:[\s\S]*?I:\s*(-?[\d.]+)\s*LUFS[\s\S]*?LRA:\s*(-?[\d.]+)\s*LU/.exec(stderr)
  const peak = /True peak:[\s\S]*?Peak:\s*(-?[\d.]+)\s*dBFS/.exec(stderr)
  return {
    lufs: summary ? Number(summary[1]) : null,
    lra: summary ? Number(summary[2]) : null,
    truePeakDb: peak ? Number(peak[1]) : null,
  }
}

function parseSilences(stderr) {
  const silences = []
  const pattern = /silence_(start|end):\s*(-?[\d.]+)/g
  let match
  let pending = null
  while ((match = pattern.exec(stderr)) !== null) {
    const time = Number(match[2])
    if (match[1] === 'start') pending = time
    else if (pending !== null) {
      silences.push({ start: pending, end: time, duration: Number((time - pending).toFixed(3)) })
      pending = null
    }
  }
  return silences
}

/** 分析一段音频（默认整条）。 */
export async function analyseAudio(filePath, options = {}) {
  const args = ['-v', 'info', '-nostats']
  if (Number.isFinite(options.startSec)) args.push('-ss', String(Math.max(0, Number(options.startSec)).toFixed(3)))
  args.push('-i', filePath)
  if (Number.isFinite(options.durationSec)) args.push('-t', String(Math.max(0.2, Number(options.durationSec)).toFixed(3)))
  args.push('-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-')
  const ebur = await run('ffmpeg', args)
  const loudness = parseEbur128(ebur.stderr)

  const silenceArgs = ['-v', 'info', '-nostats']
  if (Number.isFinite(options.startSec)) silenceArgs.push('-ss', String(Math.max(0, Number(options.startSec)).toFixed(3)))
  silenceArgs.push('-i', filePath)
  if (Number.isFinite(options.durationSec)) silenceArgs.push('-t', String(Math.max(0.2, Number(options.durationSec)).toFixed(3)))
  silenceArgs.push('-vn', '-af', 'silencedetect=noise=-38dB:d=0.45', '-f', 'null', '-')
  const silenceRun = await run('ffmpeg', silenceArgs)
  const silences = parseSilences(silenceRun.stderr)
  const total = Number.isFinite(options.durationSec) ? Number(options.durationSec) : await probeDuration(filePath)
  const silenceTotal = silences.reduce((acc, entry) => acc + entry.duration, 0)
  const speechDuration = Math.max(0, total - silenceTotal)
  const speechRatio = total > 0 ? speechDuration / total : 0

  // 逐窗口 RMS：直接解码 8k 单声道 s16le，在 Node 里算（不依赖 ffmpeg 文本输出）
  const pcm = await runBinary('ffmpeg', [
    '-v', 'error',
    ...(Number.isFinite(options.startSec) ? ['-ss', String(Math.max(0, Number(options.startSec)).toFixed(3))] : []),
    '-i', filePath,
    ...(Number.isFinite(options.durationSec) ? ['-t', String(Math.max(0.2, Number(options.durationSec)).toFixed(3))] : []),
    '-vn', '-ar', '8000', '-ac', '1', '-f', 's16le', '-',
  ])
  const sampleCount = Math.floor(pcm.length / 2)
  const windowSize = 400 // 50ms @ 8kHz
  const rmsDb = []
  let clipped = 0
  for (let offset = 0; offset + windowSize <= sampleCount; offset += windowSize) {
    let sum = 0
    for (let index = 0; index < windowSize; index += 1) {
      const sample = pcm.readInt16LE((offset + index) * 2)
      if (Math.abs(sample) >= 32700) clipped += 1
      sum += sample * sample
    }
    const rms = Math.sqrt(sum / windowSize) / 32768
    rmsDb.push(rms > 1e-6 ? 20 * Math.log10(rms) : -100)
  }
  const sorted = [...rmsDb].sort((a, b) => a - b)
  const percentile = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))] : null)
  const p10 = percentile(0.1)
  const p90 = percentile(0.9)
  const activeThreshold = (p10 ?? -60) + 6
  const activeRatio = rmsDb.length ? rmsDb.filter((value) => value > activeThreshold).length / rmsDb.length : 0
  const meanDb = rmsDb.length ? rmsDb.reduce((acc, value) => acc + value, 0) / rmsDb.length : 0
  const stdDb = rmsDb.length ? Math.sqrt(rmsDb.reduce((acc, value) => acc + (value - meanDb) ** 2, 0) / rmsDb.length) : 0
  const envelopeVariability = Number((stdDb / 9).toFixed(2))
  const noiseFloorDb = p10
  const clippingRatio = sampleCount > 0 ? Number((clipped / sampleCount).toFixed(5)) : 0

  return {
    ok: true,
    file: filePath,
    durationSec: Number(total.toFixed(2)),
    loudness,
    silences,
    silenceRatio: Number((silenceTotal / Math.max(0.01, total)).toFixed(3)),
    speechRatio: Number(speechRatio.toFixed(3)),
    activeRatio: Number(activeRatio.toFixed(3)),
    envelopeVariability,
    rmsP10Db: noiseFloorDb === null ? null : Number(noiseFloorDb.toFixed(1)),
    rmsP90Db: p90 === null ? null : Number(p90.toFixed(1)),
    noiseFloorDb: noiseFloorDb === null ? null : Number(noiseFloorDb.toFixed(1)),
    rmsWindows: rmsDb.length,
    clippingRatio,
  }
}

async function probeDuration(filePath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath])
  const value = Number(String(stdout).trim())
  return Number.isFinite(value) ? value : 0
}

/** 打分：ok/ng + reasons。 */
export function scoreTake(analysis) {
  const reasons = []
  let score = 0.5
  const { speechRatio, loudness, noiseFloorDb } = analysis
  const activeRatio = analysis.activeRatio ?? speechRatio
  const variability = analysis.envelopeVariability ?? 0
  // 稳态噪声（底噪整体均匀、没有对白的起伏）→ 废条
  const steadyNoise = activeRatio > 0.75 && variability < 0.25
  if (steadyNoise) {
    score -= 0.45
    reasons.push(`声轨是稳态噪声/环境声（活跃占比 ${(activeRatio * 100).toFixed(0)}%、起伏 ${variability}）→ 大概率废条`)
  } else if (activeRatio >= THRESHOLDS.speechRatioGood) {
    score += 0.3
    reasons.push(`有对白（活跃占比 ${(activeRatio * 100).toFixed(0)}%，起伏 ${variability}）`)
  } else if (activeRatio >= THRESHOLDS.speechRatioOk) {
    score += 0.12
    reasons.push(`台词偏少（活跃占比 ${(activeRatio * 100).toFixed(0)}%）`)
  } else {
    score -= 0.35
    reasons.push(`几乎没有台词（活跃占比 ${(activeRatio * 100).toFixed(0)}%）→ 可能纯废条/纯环境`)
  }
  // 底噪只有在「确实存在静音段」时才可信（纯对白文件没有静音段，p10 只是词间停顿）
  const noiseReliable = (analysis.silenceRatio ?? 0) >= 0.08 && noiseFloorDb !== null
  if (noiseReliable) {
    if (noiseFloorDb <= THRESHOLDS.noiseFloorGoodDb) {
      score += 0.2
      reasons.push(`底噪低（${noiseFloorDb} dB）`)
    } else if (noiseFloorDb <= THRESHOLDS.noiseFloorOkDb) {
      score += 0.05
      reasons.push(`底噪一般（${noiseFloorDb} dB）`)
    } else {
      score -= 0.2
      reasons.push(`底噪高（${noiseFloorDb} dB）→ 话筒/环境有问题`)
    }
  }
  if ((analysis.clippingRatio ?? 0) > 0.0005) {
    score -= 0.25
    reasons.push(`存在削波样本（${(analysis.clippingRatio * 100).toFixed(3)}%）`)
  }
  if (loudness?.truePeakDb != null) {
    if (loudness.truePeakDb > THRESHOLDS.truePeakMaxDb) {
      score -= 0.25
      reasons.push(`峰值接近削波（${loudness.truePeakDb} dBFS）`)
    }
  }
  if (loudness?.lufs != null) {
    if (loudness.lufs < THRESHOLDS.lufsMin) {
      score -= 0.15
      reasons.push(`电平过低（${loudness.lufs} LUFS）`)
    } else if (loudness.lufs > THRESHOLDS.lufsMax) {
      score -= 0.1
      reasons.push(`电平过高（${loudness.lufs} LUFS）`)
    } else {
      score += 0.1
      reasons.push(`电平正常（${loudness.lufs} LUFS）`)
    }
  }
  if (loudness?.lra != null && loudness.lra < THRESHOLDS.lraMin) {
    reasons.push(`动态范围极窄（LRA ${loudness.lra}）→ 可能是静音/贴片`)
  }
  score = Math.max(0, Math.min(1, score))
  return {
    score: Number(score.toFixed(2)),
    verdict: score >= 0.55 ? 'ok' : score <= 0.3 ? 'ng' : 'review',
    reasons,
    thresholds: THRESHOLDS,
  }
}

export async function analyseTake(filePath, options = {}) {
  const analysis = await analyseAudio(filePath, options)
  return { ...analysis, ...scoreTake(analysis) }
}
