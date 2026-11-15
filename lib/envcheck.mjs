/**
 * 环境自检 + 一键安装 —— 插件启用后就能知道「缺什么、怎么补」，并真正把工具装好。
 *
 * 依赖都装在插件目录内（lib/.build），不污染系统：
 *   · ffmpeg / ffprobe       系统或 Homebrew
 *   · swiftc                 系统 Xcode Command Line Tools
 *   · lib/.build/vision      macOS Vision 工具（抠图/跟踪/矩形检测）
 *   · lib/.build/venv        vosk（离线语音识别）
 *   · lib/.build/asr-model   vosk-model-small-cn-0.22（中文模型，约 42MB 下载/65MB 解压）
 *
 * 安装动作是幂等的：已就绪的项直接跳过；每步都写进进度回调，面板能逐条显示。
 */

import { execFile, spawn } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const BUILD_DIR = path.join(LIB_DIR, '.build')
const ASR_MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip'
const ASR_MODEL_DIR = path.join(BUILD_DIR, 'asr-model', 'vosk-model-small-cn-0.22')
const VENV_PYTHON = path.join(BUILD_DIR, 'venv', 'bin', 'python')

import { execFileSync } from 'node:child_process'

function which(command) {
  try {
    const out = execFileSync('/usr/bin/which', [command], { encoding: 'utf8', timeout: 20_000 })
    return out.trim() || null
  } catch {
    return null
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: options.timeoutMs ?? 900_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(-1200) || `${command} 失败`))
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
    if (options.onData) {
      child.stdout?.on('data', (chunk) => options.onData(String(chunk)))
      child.stderr?.on('data', (chunk) => options.onData(String(chunk)))
    }
  })
}

async function download(url, destination, onProgress) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  return new Promise((resolve, reject) => {
    const curl = spawn('curl', ['-L', '--fail', '--silent', '--show-error', '-o', destination, url], { stdio: ['ignore', 'ignore', 'pipe'] })
    let lastBytes = 0
    curl.stderr.on('data', (chunk) => {
      const text = String(chunk)
      const match = /(\d+\.\d)%/.exec(text)
      if (match && onProgress) onProgress(Number(match[1]))
    })
    curl.on('error', reject)
    curl.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`下载失败（curl exit ${code}）：${url}`))))
  })
}

/** 返回环境清单：{items, summary}。不修改任何东西。 */
async function resolveVersionOf(appPath) {
  try {
    const plist = path.join(appPath, 'Contents/Info.plist')
    const raw = execFileSync('defaults', ['read', plist, 'CFBundleShortVersionString']).toString().trim()
    return raw ? `（${raw}）` : ''
  } catch {
    return ''
  }
}

export async function checkEnvironment() {
  const items = []
  const homeDir = process.env.HOME ?? ''
  const mcpRoot = path.join(homeDir, 'Library/Application Support/davinci-resolve-mcp')
  const profilePatch = path.join(homeDir, '.dsh/profiles/web/cordis.patch.yml')
  const resolveAppCandidates = [
    '/Applications/DaVinci Resolve.app',
    '/Applications/DaVinci Resolve/DaVinci Resolve.app',
    path.join(homeDir, 'Applications/DaVinci Resolve.app'),
    path.join(homeDir, 'Applications/DaVinci Resolve (patched).app'),
    path.join(homeDir, 'Applications/DaVinci Resolve/DaVinci Resolve.app'),
    '/Applications/DaVinci Resolve',
  ]
  let resolveApp = resolveAppCandidates[0]
  const ffmpeg = which('ffmpeg')
  items.push({ id: 'ffmpeg', label: 'ffmpeg / ffprobe', status: ffmpeg ? 'ok' : 'missing', detail: ffmpeg ?? '未找到', fix: ffmpeg ? null : { kind: 'brew', target: 'ffmpeg', command: 'brew install ffmpeg' } })
  const brew = which('brew')
  items.push({ id: 'brew', label: 'Homebrew', status: brew ? 'ok' : 'missing', detail: brew ?? '未找到（安装 ffmpeg 需要）', fix: brew ? null : { kind: 'manual', command: '安装 Homebrew: https://brew.sh' } })
  const swiftc = which('swiftc')
  items.push({ id: 'swiftc', label: 'swiftc（Xcode CLT）', status: swiftc ? 'ok' : 'missing', detail: swiftc ?? '未找到', fix: swiftc ? null : { kind: 'manual', command: 'xcode-select --install' } })

  const visionBinary = path.join(BUILD_DIR, 'vision')
  items.push({
    id: 'vision',
    label: 'Vision 工具（抠图/跟踪/矩形检测）',
    status: existsSync(visionBinary) ? 'ok' : 'needs-build',
    detail: existsSync(visionBinary) ? visionBinary : '需要编译 lib/vision.swift',
    fix: existsSync(visionBinary) ? null : { kind: 'build', target: 'vision' },
  })

  const asrSwift = path.join(BUILD_DIR, 'asr')
  items.push({
    id: 'asr-swift',
    label: 'Apple Speech 工具（可选/实验）',
    status: existsSync(asrSwift) ? 'ok' : 'optional',
    detail: existsSync(asrSwift) ? asrSwift : '未编译（本机 CLI 授权受限时不可用，主力用 Vosk）',
    fix: null,
  })

  const python = existsSync(VENV_PYTHON) ? VENV_PYTHON : null
  let voskOk = false
  if (python) {
    try {
      execFileSync(python, ['-c', 'import vosk'], { timeout: 20_000 })
      voskOk = true
    } catch {
      voskOk = false
    }
  }
  items.push({
    id: 'vosk',
    label: 'vosk（离线语音识别）',
    status: voskOk ? 'ok' : python ? 'needs-install' : 'needs-create',
    detail: voskOk ? `${VENV_PYTHON}` : python ? 'venv 已存在但没有 vosk' : '需要创建 venv 并安装 vosk',
    fix: voskOk ? null : { kind: 'pip', target: 'vosk' },
  })

  items.push({
    id: 'asr-model',
    label: '中文语音模型（65MB）',
    status: existsSync(ASR_MODEL_DIR) ? 'ok' : 'needs-download',
    detail: existsSync(ASR_MODEL_DIR) ? ASR_MODEL_DIR : `未下载（${ASR_MODEL_URL}）`,
    fix: existsSync(ASR_MODEL_DIR) ? null : { kind: 'download', target: 'asr-model' },
  })

  // 达芬奇本体 + Resolve MCP 安装 + DSH 里的 MCP 配置（没有这些，插件所有能力都跑不了）
  const exists = async (target) => { try { await fs.access(target); return true } catch { return false } }
  for (const candidate of resolveAppCandidates) { if (await exists(candidate)) { resolveApp = candidate; break } }
  // ~/Applications 下的自定义命名（如 "DaVinci Resolve (patched).app"）也认
  if (!(await exists(resolveApp))) {
    const scope = path.join(homeDir, 'Applications')
    const entries = await fs.readdir(scope).catch(() => [])
    const hit = entries.find((name) => /^DaVinci Resolve.*\.app$/i.test(name))
    if (hit) resolveApp = path.join(scope, hit)
  }
  const resolveAppOk = await exists(resolveApp)
  items.push({
    id: 'resolve-app',
    label: 'DaVinci Resolve 本体',
    status: resolveAppOk ? 'ok' : 'missing',
    detail: resolveAppOk ? `${resolveApp}${await resolveVersionOf(resolveApp)}` : resolveApp,
    fix: resolveAppOk ? null : { kind: 'manual', command: '安装 DaVinci Resolve（外部脚本 API 需 Studio；免费版走 in-app bridge）' },
  })
  const mcpServerJs = path.join(mcpRoot, 'src/server.py')
  const mcpVenv = path.join(mcpRoot, 'venv/bin/python')
  const resolveMcpOk = (await exists(mcpServerJs)) && (await exists(mcpVenv))
  items.push({
    id: 'resolve-mcp',
    label: '达芬奇 MCP 服务（davinci-resolve-mcp）',
    status: resolveMcpOk ? 'ok' : 'missing',
    detail: mcpRoot,
    fix: resolveMcpOk ? null : { kind: 'manual', command: '运行 davinci-resolve-mcp/install.py 安装 venv 与服务' },
  })
  const patchText = await fs.readFile(profilePatch, 'utf8').catch(() => '')
  const configOk = /mcp-davinci-resolve\b/.test(patchText) && /mcp-davinci-resolve-advanced/.test(patchText)
  items.push({
    id: 'mcp-config',
    label: 'DSH 里的 Resolve MCP 配置（两个 server）',
    status: configOk ? 'ok' : 'missing',
    detail: profilePatch,
    fix: configOk ? null : { kind: 'manual', command: `在 ${profilePatch} 添加 mcp-davinci-resolve 与 mcp-davinci-resolve-advanced 两个 @deepseek-ai/dsh-mcp-client 条目` },
  })

  const missing = items.filter((item) => !['ok', 'optional'].includes(item.status)).map((item) => item.id)
  return {
    ok: missing.length === 0,
    buildDir: BUILD_DIR,
    items,
    summary: { okCount: items.filter((item) => item.status === 'ok').length, total: items.length, missing },
    installable: ['vision', 'vosk', 'asr-model', 'ffmpeg'],
  }
}

/** 安装/修复指定项（缺省=全部可安装项）。幂等。 */
export async function installEnvironment(ids, options = {}) {
  const onProgress = options.onProgress ?? (() => {})
  const requested = Array.isArray(ids) && ids.length > 0 ? ids : ['vision', 'vosk', 'asr-model']
  const results = []
  for (const id of requested) {
    const startedAt = Date.now()
    try {
      if (id === 'vision') {
        onProgress({ id, phase: 'start', message: '编译 Vision 工具…' })
        await fs.mkdir(BUILD_DIR, { recursive: true })
        await run('swiftc', ['-O', path.join(LIB_DIR, 'vision.swift'), '-o', path.join(BUILD_DIR, 'vision')], { timeoutMs: 600_000, onData: (chunk) => onProgress({ id, phase: 'log', message: chunk.trim().slice(0, 200) }) })
        results.push({ id, ok: true, path: path.join(BUILD_DIR, 'vision'), tookMs: Date.now() - startedAt })
      } else if (id === 'vosk') {
        if (!existsSync(VENV_PYTHON)) {
          onProgress({ id, phase: 'start', message: '创建 Python venv…' })
          await fs.mkdir(BUILD_DIR, { recursive: true })
          await run('python3', ['-m', 'venv', path.join(BUILD_DIR, 'venv')], { timeoutMs: 300_000 })
        }
        onProgress({ id, phase: 'start', message: '安装 vosk…' })
        await run(VENV_PYTHON, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'vosk'], { timeoutMs: 900_000, onData: (chunk) => onProgress({ id, phase: 'log', message: chunk.trim().slice(0, 200) }) })
        results.push({ id, ok: true, python: VENV_PYTHON, tookMs: Date.now() - startedAt })
      } else if (id === 'asr-model') {
        if (existsSync(ASR_MODEL_DIR)) {
          results.push({ id, ok: true, skipped: true, path: ASR_MODEL_DIR })
          continue
        }
        const zipPath = path.join(BUILD_DIR, 'asr-model', 'vosk-model-small-cn-0.22.zip')
        onProgress({ id, phase: 'start', message: '下载中文语音模型（约 42MB）…' })
        await download(ASR_MODEL_URL, zipPath, (percent) => onProgress({ id, phase: 'progress', percent }))
        onProgress({ id, phase: 'start', message: '解压模型…' })
        await run('unzip', ['-q', '-o', zipPath, '-d', path.join(BUILD_DIR, 'asr-model')], { timeoutMs: 300_000 })
        results.push({ id, ok: existsSync(ASR_MODEL_DIR), path: ASR_MODEL_DIR, tookMs: Date.now() - startedAt })
      } else if (id === 'ffmpeg') {
        if (which('ffmpeg')) {
          results.push({ id, ok: true, skipped: true })
          continue
        }
        onProgress({ id, phase: 'start', message: 'brew install ffmpeg（可能几分钟）…' })
        await run('brew', ['install', 'ffmpeg'], { timeoutMs: 1_800_000, onData: (chunk) => onProgress({ id, phase: 'log', message: chunk.trim().slice(-200) }) })
        results.push({ id, ok: Boolean(which('ffmpeg')), tookMs: Date.now() - startedAt })
      } else if (id === 'asr-swift') {
        await run('swiftc', ['-O', path.join(LIB_DIR, 'asr.swift'), '-o', path.join(BUILD_DIR, 'asr')], { timeoutMs: 600_000 })
        results.push({ id, ok: existsSync(path.join(BUILD_DIR, 'asr')) })
      } else {
        results.push({ id, ok: false, error: `未知环境项：${id}` })
      }
    } catch (error) {
      results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error), tookMs: Date.now() - startedAt })
    }
  }
  const environment = await checkEnvironment()
  return { ok: results.every((result) => result.ok), results, environment }
}
