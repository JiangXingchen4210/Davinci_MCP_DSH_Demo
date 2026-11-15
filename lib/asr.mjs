/**
 * ASR 转录（Vosk 离线中文/英文）。
 *
 * 为什么是 Vosk：本机没有 torch/whisper，HuggingFace 不可达；Vosk 小模型 65MB、离线、
 * 中文可用、词级时间戳足够做「整句保护」的剪辑。实测 5.6s 语音 0.9s 转完。
 *
 * 依赖放在插件目录内（lib/.build），不污染系统：
 *   lib/.build/venv/bin/python     ← vosk 包
 *   lib/.build/asr-model/vosk-model-small-cn-0.22
 * 缺依赖时返回明确错误 + 一键安装入口（lib/envcheck.mjs）。
 */

import { execFile, execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUILD_DIR = path.join(LIB_DIR, '.build')
const VENV_PYTHON = path.join(BUILD_DIR, 'venv', 'bin', 'python')
const VOSK_MODEL = path.join(BUILD_DIR, 'asr-model', 'vosk-model-small-cn-0.22')
export const ASR_PATHS = { BUILD_DIR, VENV_PYTHON, VOSK_MODEL, SCRIPT: path.join(LIB_DIR, 'asr_transcribe.py') }

/** 检查 ASR 依赖是否就绪（不下载、不安装）。 */
export function locateAsr() {
  const problems = []
  if (!existsSync(VENV_PYTHON)) problems.push({ id: 'venv', detail: `缺少 ${VENV_PYTHON}` })
  else {
    try {
      execFileSync(VENV_PYTHON, ['-c', 'import vosk'], { timeout: 20_000 })
    } catch {
      problems.push({ id: 'vosk', detail: 'venv 里没有 vosk 包' })
    }
  }
  if (!existsSync(VOSK_MODEL)) problems.push({ id: 'model', detail: `缺少模型 ${VOSK_MODEL}` })
  return {
    ok: problems.length === 0,
    python: VENV_PYTHON,
    model: VOSK_MODEL,
    script: ASR_PATHS.SCRIPT,
    problems,
    installHint: 'env.install({items:["asr"]}) 或面板「环境」卡片一键安装',
  }
}

function run(command, args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(-800) || `${command} 失败`))
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** 把任意音视频的某一段抽成 16k/16bit/mono wav。 */
export async function extractAudio(filePath, options = {}) {
  const outPath = path.join(os.tmpdir(), `asr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
  const args = ['-v', 'error']
  if (Number.isFinite(options.startSec)) args.push('-ss', String(Math.max(0, Number(options.startSec)).toFixed(3)))
  args.push('-i', filePath)
  if (Number.isFinite(options.durationSec)) args.push('-t', String(Math.max(0.1, Number(options.durationSec)).toFixed(3)))
  args.push('-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', outPath)
  await run('ffmpeg', args)
  return outPath
}

/**
 * 转写一个媒体文件（可限定区间）。
 * @returns {{ok, text, segments:[{start,end,text,conf}], words, tookMs, audioPath}}
 */
export async function transcribeFile(filePath, options = {}) {
  const located = locateAsr()
  if (!located.ok) {
    return { ok: false, needsInstall: true, problems: located.problems, installHint: located.installHint, segments: [], words: [], text: '' }
  }
  const startedAt = Date.now()
  const audioPath = await extractAudio(filePath, options)
  try {
    const { stdout } = await run(located.python, [located.script, '--in', audioPath, '--model', located.model], 900_000)
    const trimmed = stdout.trim()
    if (!trimmed) throw new Error('ASR 没有输出')
    const payload = JSON.parse(trimmed)
    if (!payload.ok) throw new Error(payload.error ?? 'ASR 失败')
    // 区间转写：段/词时间要加回偏移
    const offset = Number.isFinite(options.startSec) ? Math.max(0, Number(options.startSec)) : 0
    const shift = (list) => list.map((entry) => ({ ...entry, start: Number((entry.start + offset).toFixed(3)), end: Number((entry.end + offset).toFixed(3)) }))
    return {
      ok: true,
      engine: payload.engine ?? 'vosk',
      text: payload.text ?? '',
      segments: shift(payload.segments ?? []),
      words: shift(payload.words ?? []),
      tookMs: Date.now() - startedAt,
      audioPath,
    }
  } finally {
    await fs.rm(audioPath, { force: true }).catch(() => {})
  }
}
