/**
 * Resolve 控制台 — Host 实现（v2）。
 *
 * 由 index.js 以带缓存破坏参数的动态 import 载入，所以这一个文件可以在不重启 Harness、
 * 不改包名的情况下热更新（插件行 disable/enable 一次即可）。
 *
 * 三层能力：
 *  1. 基础调色/效果（v1）：CDL、look 预设、版本、复制调色、变换/裁剪/不透明度、Fusion 模糊。
 *  2. 深度色调匹配：抓参考帧与目标帧 → 分层统计（lib/layers.mjs）→ 计算分层校正 →
 *     生成多层 .drx（全局 / 肤色 qualifier / 高光 luma / 背景 hue）→ 落地 Resolve →
 *     重新抓帧做残差复核。
 *  3. 色彩管线体检：读平台 + 版本 + 项目色彩管理设置 → 诊断（含 Mac 709-A 类问题）→ 自动修复。
 */

import { execFile, spawn } from 'node:child_process'
import { promises as fs, createReadStream } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  OPS as BASE_OPS,
  callTool,
  settle,
  scopeOf,
  messageOf,
  sendJson,
  readBody,
  isLoopback,
} from './host-base.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PREBUILT_BIN = path.join(HERE, 'bin')
const pickBin = (name) => {
  for (const candidate of [path.join(PREBUILT_BIN, name), path.join(HERE, 'lib', '.build', name)]) {
    try { if (fs.existsSync(candidate)) return candidate } catch { /* ignore */ }
  }
  return path.join(HERE, 'lib', '.build', name)
}
const ROUTE_PATH = '/davinci-panel/action'
const previewState = { renderInProgress: false, lastStageByItem: new Map() }
const MEDIA_PATH = '/davinci-panel/media'
const MAX_BODY_BYTES = 32 * 1024 * 1024
const CALL_TIMEOUT_MS = 300_000
// 允许测试/便携安装覆盖数据目录（默认仍是 ~/Documents/resolve-console）
const DATA_ROOT = process.env.DAVINCI_CONSOLE_DATA_DIR?.trim() || path.join(os.homedir(), 'Documents', 'resolve-console')
const DATA_DIR = DATA_ROOT
/** 调试日志：插件界面和对话里都能看到「现在在干什么、用了什么工具、目的是什么」。 */
const BUNDLED_LUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'luts', 'official')

const DEBUG_LOG = []
let DEBUG_SEQ = 0
function debugPush(entry) {
  DEBUG_SEQ += 1
  DEBUG_LOG.push({ seq: DEBUG_SEQ, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }), ...entry })
  if (DEBUG_LOG.length > 800) DEBUG_LOG.shift()
  return DEBUG_SEQ
}
const LAYERS_CLI = path.join(HERE, 'lib', 'layers.mjs')

// ---------------------------------------------------------------------------
// 进程内工具
// ---------------------------------------------------------------------------

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message || '').trim()
        reject(new Error(detail || `${command} 执行失败`))
        return
      }
      resolve(String(stdout || ''))
    })
  })
}

async function ensureDataDir(sub) {
  const dir = sub ? path.join(DATA_DIR, sub) : DATA_DIR
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** .drx 等必须落在系统 temp 下的中间产物。 */
async function ensureTempDir(sub) {
  const dir = path.join(os.tmpdir(), 'davinci-console', sub)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 把 PNG/JPEG 缩成小 JPEG 并转成 data URL，供面板 <img> 直接显示。 */
async function thumbnail(filePath) {
  const dir = await ensureDataDir('thumbs')
  const out = path.join(dir, `${path.basename(filePath, path.extname(filePath))}-${Date.now()}.jpg`)
  try {
    await run('sips', ['-Z', '900', '-s', 'format', 'jpeg', filePath, '--out', out], { timeoutMs: 30_000 })
    const bytes = await fs.readFile(out)
    return `data:image/jpeg;base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/** 调 lib/layers.mjs 的 CLI，stdout 必须是纯 JSON。 */
async function layersCli(args) {
  const stdout = await run(process.execPath, [LAYERS_CLI, ...args, '--json'], { timeoutMs: 90_000 })
  const text = stdout.trim()
  if (!text) throw new Error('分层分析没有输出')
  try {
    return JSON.parse(text)
  } catch {
    // CLI 约定 stdout 只出 JSON；这里兜底抓最后一段对象。
    const start = text.indexOf('{')
    if (start >= 0) return JSON.parse(text.slice(start))
    throw new Error(`分层分析输出不是 JSON：${text.slice(0, 200)}`)
  }
}

// ---------------------------------------------------------------------------
// 时间线定位（播放头 → 指定片段），自动化多场戏要用
// ---------------------------------------------------------------------------

async function projectFps(ctx, signal) {
  const outcome = await settle(
    callTool(ctx, 'project_settings', { action: 'get_setting', params: { name: 'timelineFrameRate' } }, signal),
  )
  const raw = outcome.ok ? outcome.value?.settings : null
  const fps = Number.parseFloat(String(raw ?? ''))
  return Number.isFinite(fps) && fps > 0 ? fps : 24
}

function framesToTimecode(frames, fps) {
  const total = Math.max(0, Math.round(frames))
  const rate = Math.max(1, Math.round(fps))
  const p = (n) => String(n).padStart(2, '0')
  const f = total % rate
  const seconds = Math.floor(total / rate)
  return `${p(Math.floor(seconds / 3600))}:${p(Math.floor((seconds % 3600) / 60))}:${p(seconds % 60)}:${p(f)}`
}

async function listVideoItems(ctx, signal, trackIndex = 1) {
  const outcome = await settle(
    callTool(ctx, 'timeline', { action: 'get_items', track_type: 'video', track_index: trackIndex }, signal),
  )
  const items = outcome.ok && Array.isArray(outcome.value?.items) ? outcome.value.items : []
  return items.filter((entry) => entry && entry.kind === 'clip')
}

/** 读视频轨数量：失败时保留错误，不把失败伪装成 1 条轨。 */
async function videoTrackCount(ctx, signal) {
  const r = await settle(callTool(ctx, 'timeline', { action: 'get_track_count', track_type: 'video' }, signal))
  if (!r.ok) return { ok: false, error: `读取视频轨数量失败：${messageOf(r.error)}` }
  const count = Number(r.value?.count ?? r.value)
  if (!Number.isFinite(count) || count < 0) return { ok: false, error: '视频轨数量不可用' }
  return { ok: true, count }
}

/** 读一条视频轨的片段：失败时保留错误（不转换成空列表）。 */
async function listVideoItemsSafe(ctx, signal, trackIndex) {
  const r = await settle(callTool(ctx, 'timeline', { action: 'get_items', track_type: 'video', track_index: trackIndex }, signal))
  if (!r.ok) return { ok: false, error: `读取 V${trackIndex} 失败：${messageOf(r.error)}` }
  const items = r.value?.items
  if (!Array.isArray(items)) return { ok: false, error: `V${trackIndex} 的返回里没有 items 数组` }
  return { ok: true, items: items.filter((entry) => entry && entry.kind === 'clip') }
}

/** 在**全部**视频轨上查片段：轨数/轨内容读取失败都要报错，只有完整扫描后确实不存在才报“找不到”。 */
async function findItemAcrossTracks(ctx, signal, itemId) {
  const { findVideoTrackForItem, notFoundError } = await importFresh('lib/timeline_lookup.mjs')
  const countResult = await videoTrackCount(ctx, signal)
  if (!countResult.ok) return { ok: false, hit: null, count: null, error: countResult.error }
  const count = Math.max(countResult.count, 1)
  const tracks = []
  for (let trackIndex = 1; trackIndex <= count; trackIndex += 1) {
    const safe = await listVideoItemsSafe(ctx, signal, trackIndex)
    if (!safe.ok) return { ok: false, hit: null, count, error: safe.error }
    tracks.push({ trackIndex, items: safe.items })
  }
  const hit = findVideoTrackForItem(tracks, itemId)
  if (!hit) return { ok: false, hit: null, count, notFound: true, error: notFoundError(itemId, count) }
  return { ok: true, hit, count, error: null }
}

/** 把播放头移到某个片段起点（按实际视频轨查找），返回该片段。 */
async function seekToItem(ctx, signal, itemId) {
  let found = null
  if (itemId) {
    const foundResult = await findItemAcrossTracks(ctx, signal, itemId)
    if (!foundResult.hit) return { ok: false, error: foundResult.error }
    found = { item: foundResult.hit.item, trackIndex: foundResult.hit.trackIndex }
  } else {
    const items = await listVideoItems(ctx, signal, 1)
    if (items[0]) found = { item: items[0], trackIndex: 1 }
  }
  if (!found) return { ok: false, error: `时间线上找不到片段 ${itemId ?? '(未指定)'}` }

  const current = await settle(callTool(ctx, 'timeline', { action: 'get_current' }, signal))
  const startFrame = Number(current.ok ? current.value?.start_frame : 0) || 0
  const fps = await projectFps(ctx, signal)
  const timecode = framesToTimecode(Number(found.item.start) - startFrame, fps)
  const seek = await settle(
    callTool(ctx, 'timeline_markers', { action: 'set_current_timecode', params: { timecode } }, signal),
  )
  return { ok: seek.ok && seek.value?.success !== false, timecode, trackIndex: found.trackIndex, item: found.item, fps }
}

// ---------------------------------------------------------------------------
// 抓帧
// ---------------------------------------------------------------------------

let frameSequence = 0
let previewSequence = 0

/** 用 Project.ExportCurrentFrameAsStill 把当前播放头画面写成 PNG（带当前调色）。 */
async function captureRenderedFrame(ctx, signal, label = 'frame') {
  const dir = await ensureDataDir('frames')
  // 序号必须带：同一秒内 before/after 两次抓帧若同名会互相覆盖，渲染增量就会永远是 0
  const filePath = path.join(dir, `${label}-${stamp()}-${++frameSequence}.png`)
  const value = await callTool(
    ctx,
    'project_settings',
    { action: 'export_frame_as_still', path: filePath },
    signal,
  )
  if (!value?.success) throw new Error('导出当前帧失败（Resolve 返回 False）')
  const stat = await fs.stat(filePath)
  return { path: filePath, bytes: stat.size }
}

/**
 * 抓当前片段的「源」帧（不含调色），用于从零建立 look。
 * 需要 media pool item + 片段内的源时间；任何一步拿不到就返回 null，由调用方降级。
 */
async function captureSourceFrame(ctx, signal, itemId) {
  const scope = scopeOf(itemId)
  const [mediaItem, sourceStart, itemStart, settings] = await Promise.all([
    settle(callTool(ctx, 'timeline_item', { action: 'get_media_pool_item', ...scope }, signal)),
    settle(callTool(ctx, 'timeline_item', { action: 'get_source_start_frame', ...scope }, signal)),
    settle(callTool(ctx, 'timeline_item', { action: 'get_start', ...scope }, signal)),
    settle(callTool(ctx, 'project_settings', { action: 'get_setting', name: 'timelineFrameRate' }, signal)),
  ])
  return { mediaItem, sourceStart, itemStart, settings }
}

async function exportSourceFrame(ctx, signal, itemId) {
  const probe = await captureSourceFrame(ctx, signal, itemId)
  const mediaPoolId = probe.mediaItem?.value?.id
  const sourceStartFrame = Number(probe.sourceStart?.value?.frame)
  if (!mediaPoolId || !Number.isFinite(sourceStartFrame)) return null

  const playhead = await callTool(ctx, 'timeline_markers', { action: 'get_current_timecode' }, signal)
  const recordFrames = await callTool(ctx, 'timeline', { action: 'get_current' }, signal)
  const fps = Number.parseFloat(String(probe.settings?.value?.settings ?? '') || '24') || 24

  const timecodeToFrames = (tc) => {
    const parts = String(tc || '').split(':').map((part) => Number.parseInt(part, 10))
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
    return ((parts[0] * 3600 + parts[1] * 60 + parts[2]) * fps) + parts[3]
  }
  const itemStartFrame = Number(probe.itemStart?.value?.start ?? probe.itemStart?.value)
  const playheadFrame = timecodeToFrames(playhead?.timecode)
  const timelineStartFrame = Number(recordFrames?.start_frame ?? 0)
  if (!Number.isFinite(playheadFrame) || !Number.isFinite(timelineStartFrame)) return null

  const offset = playheadFrame - timelineStartFrame - (Number.isFinite(itemStartFrame) ? itemStartFrame : 0)
  const sourceFrame = sourceStartFrame + Math.max(0, offset)
  const seconds = sourceFrame / fps

  const dir = await ensureDataDir('frames')
  const value = await callTool(
    ctx,
    'media_pool_item',
    { action: 'extract_frames', clip_id: mediaPoolId, timestamps: [Number(seconds.toFixed(4))], output_dir: dir },
    signal,
  )
  const framePath = Array.isArray(value?.frame_paths) ? value.frame_paths[0] : null
  if (!framePath) return null
  return { path: framePath, sourceSeconds: seconds, sourceFrame }
}

// ---------------------------------------------------------------------------
// 分层 → .drx 节点
// ---------------------------------------------------------------------------

/**
 * 层名 → drx qualifier 范围。
 *
 * 单位：drx 生成器把 qualifier 的每个值 ÷100 写进线，所以这里全部是 **UI 0–100**
 * 刻度；色相不是 0–360°，必须用 layers 引擎给的 `*HuePercent`（= 度/3.6）。
 * 直接把 meanHue 的度数写进来会让肤色选到绿区，这是踩过的坑。
 */
function qualifierFor(layer, stats) {
  const huePercent = (value, fallback) => {
    const candidate = typeof value === 'number' ? value : fallback
    return Math.min(100, Math.max(0, Number.isFinite(candidate) ? candidate : fallback))
  }
  if (layer === 'skin') {
    return {
      qualifier: {
        hueCenter: huePercent(stats?.meanHuePercent, 6),
        hueWidth: 22,
        hueSymmetry: 50,
        hueSoft: 11,
        satLow: 12,
        satHigh: 88,
        satLowSoft: 5,
        satHighSoft: 5,
        lumLow: 20,
        lumHigh: 80,
        lumLowSoft: 5,
        lumHighSoft: 5,
      },
      matteFinesse: { blackClip: 2, whiteClip: 2, denoise: 5, blur: 3 },
    }
  }
  if (layer === 'highlight') {
    return { lumaQualifier: { lumLow: 82, lumLowSoft: 12, lumHigh: 100, lumHighSoft: 8 } }
  }
  if (layer === 'shadow') {
    return { lumaQualifier: { lumLow: 0, lumLowSoft: 6, lumHigh: 18, lumHighSoft: 12 } }
  }
  if (layer === 'background') {
    return {
      qualifier: {
        hueCenter: huePercent(stats?.dominantHuePercent ?? stats?.meanHuePercent, 13),
        hueWidth: 28,
        hueSoft: 15,
        satLow: 10,
        satHigh: 100,
        lumLow: 0,
        lumHigh: 92,
        lumLowSoft: 5,
        lumHighSoft: 8,
      },
    }
  }
  if (layer === 'neutral') {
    return {
      qualifier: { satLow: 0, satHigh: 14, satHighSoft: 6, lumLow: 15, lumHigh: 90, lumLowSoft: 5, lumHighSoft: 5 },
    }
  }
  return null
}

/**
 * CDL（Slope/Offset/Power/Saturation；中性 1/0/1/1）→ 单个 DRX 节点参数。
 *
 * 单位：`space:'drx'` 下理线器不做 UI→DRX 缩放，只把 saturation ×50 抵消编码器的 ÷50，
 * 所以 saturation 直接给「倍数」，gain 给乘法系数、offset 给加性偏移、gamma 给 1=中性的倍数。
 * master 一律不写，交给生成器默认值。
 */
function cdlNode(label, cdl, extraParams = null, options = {}) {
  const slope = cdl?.Slope ?? [1, 1, 1]
  const offset = cdl?.Offset ?? [0, 0, 0]
  const power = cdl?.Power ?? [1, 1, 1]
  const params = {
    space: 'drx',
    gain: { r: slope[0], g: slope[1], b: slope[2] },
    offset: { r: offset[0], g: offset[1], b: offset[2] },
    gamma: { r: power[0], g: power[1], b: power[2] },
    lift: { r: 0, g: 0, b: 0 },
  }
  if (options.withSaturation !== false) {
    params.saturation = typeof cdl?.Saturation === 'number' ? cdl.Saturation : 1
  }
  if (extraParams && typeof extraParams === 'object') Object.assign(params, extraParams)
  return { label, params }
}

/**
 * 用 resolve_advanced 的 drx 工具造一份多层 grading：
 *   1) generate 一个只含 gain/offset/gamma 的「全局」基线（**不放饱和度**：
 *      merge 会对已有节点的 saturation 二次缩放，这是实测过的数据损坏坑）
 *   2) merge 把「全局饱和度 + 各层键控节点」串上去
 * 节点顺序：01 全局 → 02 饱和度（若有）→ 03 肤色 → 04 高光 → 05 背景 → 06 暗部 → 07 中性面
 */
async function buildLayeredDrx(ctx, signal, plan, labelPrefix, targetStats) {
  // safe_apply_drx 默认要求 .drx 位于系统临时目录下（require_temp_path=true），
  // 所以中间产物不写 ~/Documents，而是写 os.tmpdir()。
  const dir = await ensureTempDir('drx')
  const basePath = path.join(dir, `${labelPrefix}-base.drx`)
  const outPath = path.join(dir, `${labelPrefix}-layered.drx`)
  const layers = plan?.layers ?? {}
  const identity = { Slope: [1, 1, 1], Offset: [0, 0, 0], Power: [1, 1, 1], Saturation: 1 }
  const globalCdl = layers.global?.cdl ?? identity

  const baseNode = cdlNode(`${labelPrefix} 01 全局`, globalCdl, null, { withSaturation: false })
  await callTool(
    ctx,
    'drx',
    {
      action: 'generate',
      gradeParams: baseNode.params,
      metadata: { label: baseNode.label },
      target: 'clip',
      outputPath: basePath,
    },
    signal,
  )

  const newNodes = []
  const saturation = Number(globalCdl.Saturation ?? 1)
  if (Number.isFinite(saturation) && Math.abs(saturation - 1) > 0.01) {
    newNodes.push(
      cdlNode(`${labelPrefix} 02 全局饱和度`, { Slope: [1, 1, 1], Offset: [0, 0, 0], Power: [1, 1, 1], Saturation: saturation }),
    )
  }

  const target = targetStats?.layers ?? {}
  const push = (layer, entry) => {
    const parts = qualifierFor(layer, target[layer] ?? null)
    if (!parts) return
    newNodes.push(cdlNode(`${labelPrefix} 0${newNodes.length + 2} ${entry.label ?? layer}`, entry.cdl, parts))
  }

  const usable = (entry) => entry && entry.identity !== true && entry.confidence !== 'low'
  const skinCoverage = Number(target.skin?.coverage ?? 0)
  if (usable(layers.skin) && skinCoverage >= 2 && skinCoverage <= 40) push('skin', layers.skin)
  if (usable(layers.highlight)) push('highlight', layers.highlight)
  if (usable(layers.background)) push('background', layers.background)
  const dynamicRange = Number(target.global?.dynamicRange ?? 0)
  if (usable(layers.shadow) && dynamicRange > 0.15) push('shadow', layers.shadow)
  if (usable(layers.neutral)) push('neutral', layers.neutral)

  if (newNodes.length === 0) return { path: basePath, nodes: 1 }

  await callTool(ctx, 'drx', { action: 'merge', basePath, newNodes, outputPath: outPath }, signal)
  return { path: outPath, nodes: newNodes.length + 1, basePath }
}

// ---------------------------------------------------------------------------
// 色彩管线体检
//
// 全部键名来自 docs/color-pipeline-notes.md（本机 Studio 21.0.0b.20 实测 + 源码复核）：
// 项目级用 colorScienceMode / colorSpaceTimeline / colorSpaceOutput / colorSpace*Gamma /
// separateColorSpaceAndGamma；时间线还有一层覆盖（Timeline.GetSetting 逐键读）。
// 不存在的键（timelineColorSpace / outputColorSpace / timelineGamma…）不要再猜。
// ---------------------------------------------------------------------------

const PROJECT_PREFS_PATH = path.join(
  os.homedir(),
  'Library',
  'Preferences',
  'Blackmagic Design',
  'DaVinci Resolve',
  '.config.data',
)

const PIPE_KEYS = {
  science: 'colorScienceMode',
  separate: 'separateColorSpaceAndGamma',
  timelineSpace: 'colorSpaceTimeline',
  timelineGamma: 'colorSpaceTimelineGamma',
  outputSpace: 'colorSpaceOutput',
  outputGamma: 'colorSpaceOutputGamma',
  inputSpace: 'colorSpaceInput',
  hdrMastering: 'hdrMasteringOn',
  hdrPeak: 'hdrMasteringLuminanceMax',
  toneMapping: 'colorSpaceOutputToneMapping',
  gamutMapping: 'colorSpaceOutputGamutMapping',
  dataLevels: 'videoDataLevels',
  workingLuminanceMode: 'timelineWorkingLuminanceMode',
  acesIdt: 'colorAcesIDT',
  acesOdt: 'colorAcesODT',
}

const TIMELINE_OVERRIDE_KEYS = ['useCustomSettings', 'colorSpaceTimeline', 'colorSpaceOutput', 'colorSpaceTimelineGamma']

/** 只读取 macOS 上 Resolve 的偏好落盘值；永远不写这个文件。 */
async function readMacPrefs() {
  if (process.platform !== 'darwin') return { ok: false, supported: false }
  try {
    const text = await fs.readFile(PROJECT_PREFS_PATH, 'utf8')
    const read = (key) => {
      const hit = new RegExp(`^${key}\\s*=\\s*(-?\\d+)\\s*$`, 'm').exec(text)
      return hit ? hit[1] === '1' : null
    }
    return {
      ok: true,
      path: PROJECT_PREFS_PATH,
      enableDisplayColorProfile: read('EnableDisplayColorProfile'),
      tag709ClipsAs709A: read('Tag709ClipsAs709A'),
    }
  } catch (error) {
    return { ok: false, path: PROJECT_PREFS_PATH, error: messageOf(error) }
  }
}

/** gamma 家族：合并串里可能带 "Gamma 2.4"，也可能只有 "(Scene)"；709-A 必须单独识别。 */
function gammaFamily(value) {
  const text = String(value ?? '').toLowerCase()
  if (!text) return null
  if (/709[\s-]*a/.test(text)) return '709a'
  if (/1\.96/.test(text)) return '1.96'
  if (/2\.4/.test(text)) return '2.4'
  if (/2\.2/.test(text)) return '2.2'
  if (/srgb/.test(text)) return 'srgb'
  if (/st\s*2084|\bpq\b/.test(text)) return 'pq'
  if (/hlg/.test(text)) return 'hlg'
  if (/scene/.test(text)) return '709scene'
  return 'other'
}

function effectiveGamma(separate, space, gamma) {
  if (String(separate) === '1' && gamma) return gammaFamily(gamma)
  return gammaFamily(space)
}

function readColorSettings(settings) {
  const value = (key) => {
    if (!settings || typeof settings !== 'object') return null
    const raw = settings[key]
    return raw === undefined || raw === null || raw === '' ? null : String(raw)
  }
  const separate = value(PIPE_KEYS.separate)
  return {
    science: value(PIPE_KEYS.science),
    separate,
    timelineSpace: value(PIPE_KEYS.timelineSpace),
    timelineGamma: value(PIPE_KEYS.timelineGamma),
    outputSpace: value(PIPE_KEYS.outputSpace),
    outputGamma: value(PIPE_KEYS.outputGamma),
    inputSpace: value(PIPE_KEYS.inputSpace),
    hdrMastering: value(PIPE_KEYS.hdrMastering),
    hdrPeak: value(PIPE_KEYS.hdrPeak),
    toneMapping: value(PIPE_KEYS.toneMapping),
    gamutMapping: value(PIPE_KEYS.gamutMapping),
    dataLevels: value(PIPE_KEYS.dataLevels),
    workingLuminanceMode: value(PIPE_KEYS.workingLuminanceMode),
    acesIdt: value(PIPE_KEYS.acesIdt),
    acesOdt: value(PIPE_KEYS.acesOdt),
    timelineGammaFamily: effectiveGamma(separate, value(PIPE_KEYS.timelineSpace), value(PIPE_KEYS.timelineGamma)),
    outputGammaFamily: effectiveGamma(separate, value(PIPE_KEYS.outputSpace), value(PIPE_KEYS.outputGamma)),
  }
}

function finding(id, severity, title, detail, extra = {}) {
  return {
    id,
    severity,
    title,
    detail,
    current: extra.current ?? null,
    recommended: extra.recommended ?? null,
    target: extra.target ?? 'project',
    autoFix: Boolean(extra.recommended) && (extra.risk ?? 'medium') !== 'high',
    risk: extra.risk ?? 'medium',
    manual: extra.manual ?? null,
  }
}

/** 规则表见 docs/color-pipeline-notes.md §5.2；「读不到即未知」，不把失败当空值。 */
function diagnosePipeline(snapshot) {
  const findings = []
  const runtime = snapshot?.runtime
  const settingsOk = snapshot?.settings?.ok === true
  const settings = settingsOk ? snapshot.settings.value?.settings ?? snapshot.settings.value ?? {} : null
  const color = readColorSettings(settings)
  const timeline = snapshot?.timelineScope
  const prefs = snapshot?.prefs

  const runtimeSaysDown = runtime && runtime.running === false
  if (runtimeSaysDown && !snapshot?.project) {
    findings.push(
      finding('dl_resolve_not_running', 'error', 'Resolve 未运行', '体检需要连接 Resolve。先点“连接 / 刷新”让 MCP 拉起它，再回来体检。', {
        current: '未运行',
        manual: '点“连接 / 刷新”。',
      }),
    )
  }
  if (!snapshot?.project) {
    findings.push(
      finding('dl_no_project', 'error', '没有打开的项目', '请先在 Resolve 里打开一个项目，体检才有对象。', { manual: '打开一个项目后重试。' }),
    )
  }
  if (!settingsOk) {
    findings.push(
      finding('dl_settings_unreadable', 'error', '读不到项目色彩设置', `项目设置快照读取失败：${snapshot?.settings?.error ?? '未知原因'}`, {
        manual: '确认 Resolve 未卡在模态对话框，然后重试。',
      }),
    )
    return { findings, color, timeline, prefs }
  }

  const scienceText = String(color.science ?? '')
  // 注意：davinciYRGBColorManagedv2 也含 "davinciYRGB"，必须先判 managed，
  // 否则修好之后还会一直报「非色彩管理管线」（实测踩过）。
  const managed = /colormanaged|rcm/i.test(scienceText)
  const aces = /aces/i.test(scienceText)
  const unmanaged = /davinciyrgb/i.test(scienceText) && !managed

  // 非色彩管理管线
  if (unmanaged) {
    findings.push(
      finding('dl_unmanaged_pipeline', 'warn', '项目使用非色彩管理管线（DaVinci YRGB）', '普通 YRGB 下时间线/输出色彩空间只影响预览标签，素材输入空间要手工标注；Log/宽色域素材混用时很难自洽。切换为 RCM 会改变已调画面的解释。', {
        current: color.science ?? 'davinciYRGB',
        recommended: { name: PIPE_KEYS.science, value: 'davinciYRGBColorManagedv2' },
        risk: 'high',
      }),
    )
  }

  // 时间线色彩空间
  if (!color.timelineSpace) {
    findings.push(
      finding('dl_timeline_space_unset', 'error', '时间线色彩空间未设置', '时间线色彩空间为空会让预览 gamma 与输出 tag 依赖默认值。', {
        current: '（空）',
        recommended: { name: PIPE_KEYS.timelineSpace, value: 'Rec.709' },
        risk: 'medium',
      }),
    )
  }

  // 时间线覆盖
  if (timeline?.ok) {
    if (String(timeline.useCustomSettings) === '1' && timeline.colorSpaceTimeline && timeline.colorSpaceTimeline !== color.timelineSpace) {
      findings.push(
        finding('dl_timeline_space_mismatch', 'warn', '这条时间线覆盖了项目的色彩空间', `项目是 ${color.timelineSpace ?? '未设置'}，时间线是 ${timeline.colorSpaceTimeline}。如果这不是有意的，偏色只发生在这一条时间线上。`, {
          current: timeline.colorSpaceTimeline,
          recommended: { name: 'colorSpaceTimeline', value: color.timelineSpace ?? 'Rec.709' },
          target: 'timeline',
          risk: 'medium',
        }),
      )
    }
  }

  // 交付基准：Rec.709 / Gamma 2.4（文章结论：达芬奇与 macOS 一致性靠基准色空间 + 正确 gamma tag）
  if (!/rec\.?709/i.test(String(color.outputSpace ?? '')) || !/2\.4/.test(String(color.outputGamma ?? ''))) {
    findings.push(
      finding('dl_output_rec709_gamma24', 'warn', '输出不是 Rec.709 / Gamma 2.4（SDR 交付基准）', `当前输出 ${color.outputSpace ?? '未设置'} / ${color.outputGamma ?? '未设置'}。SDR 交付建议 Rec.709 + Gamma 2.4；否则 QuickTime/播放器按 2.2 解释时会偏亮。`, {
        current: `${color.outputSpace ?? '—'} / ${color.outputGamma ?? '—'}`,
        recommended: { name: PIPE_KEYS.outputSpace, value: 'Rec.709' },
        recommended2: { name: PIPE_KEYS.outputGamma, value: 'Gamma 2.4' },
        risk: 'medium',
      }),
    )
  }

  // gamma 家族不一致
  if (color.timelineGammaFamily && color.outputGammaFamily && color.timelineGammaFamily !== color.outputGammaFamily) {
    findings.push(
      finding('dl_gamma_family_mismatch', 'error', '时间线 gamma 与输出 gamma 不一致', `时间线是 ${color.timelineSpace ?? ''}（${color.timelineGammaFamily}），输出是 ${color.outputSpace ?? ''}（${color.outputGammaFamily}）。预览与成片会对不上。`, {
        current: `${color.timelineGammaFamily} → ${color.outputGammaFamily}`,
        recommended:
          String(color.separate) === '1'
            ? { name: PIPE_KEYS.outputGamma, value: color.timelineGammaFamily === '709a' ? 'Rec.709-A' : 'Gamma 2.4' }
            : { name: PIPE_KEYS.separate, value: '1' },
        risk: 'medium',
      }),
    )
  }

  // 查看器色彩配置：macOS 与 Windows 的开关不同，分成两条独立 finding
  if (process.platform !== 'darwin') {
    findings.push(
      finding('dl_win_viewer_profile', 'info', 'Windows 查看器色彩配置（独立项）',
        'Windows 版 Resolve 没有与 macOS 同名的「Use Mac Display Color Profiles」开关；显示器颜色由系统 ICC/驱动管理，脚本 API 读不到。这一项与 macOS 的那项分开判断，不要混用。', {
          current: 'N/A（平台不同）',
          manual: 'Windows：显示设置 → 高级显示 → 色彩配置文件；Resolve 内无可写的同名项。',
        }),
    )
  }
  if (process.platform === 'darwin') {
    const profileState =
      prefs?.ok === true ? (prefs.enableDisplayColorProfile === null ? '未知' : prefs.enableDisplayColorProfile ? '开' : '关') : '未知'
    findings.push(
      finding(
        'dl_mac_viewer_profile',
        prefs?.ok === true && prefs.enableDisplayColorProfile === true ? 'warn' : 'info',
        'macOS 查看器可能套用显示器色彩配置文件',
        `“Use Mac Display Color Profiles for Viewers” 是偏好设置项，脚本 API 读写不到；落盘值当前为「${profileState}」。开着时查看器会按系统 ICC（常见 Display P3）解释，预览可能与交付不一致。`,
        {
          current: `EnableDisplayColorProfile=${profileState}`,
          fix: { kind: 'gui', command: 'python3 lib/gui_prefs.py' },
          manual: 'GUI 自动化可改（lib/gui_prefs.py，状态感知）；改完需重启 Resolve。',
        },
      ),
    )
    if (prefs?.ok === true && prefs.tag709ClipsAs709A === false) {
      findings.push(
        finding('dl_mac_709a_tag_off', 'info', '未自动把 Rec.709 素材标记为 709-A', '“Automatically tag Rec.709 clips as Rec.709-A” 当前关闭。若你的工作流依赖 QuickTime/Apple 链路一致，这个开关会影响素材 tag。', {
          current: 'Tag709ClipsAs709A=0',
          manual: '同样是偏好设置项，只能人工勾选。',
        }),
      )
    }
    if (color.outputGammaFamily === '709a' || color.timelineGammaFamily === '709a') {
      findings.push(
        finding('dl_mac_709a_in_use', 'info', '管线里用了 Rec.709-A（Apple 显示 gamma 变体）', '709-A 把 Apple 显示 gamma 烘进信号：在 Mac 上看着正常，交付到标准 709 监看/其他平台会整体偏灰。若目标是标准 SDR 交付，应改成 Gamma 2.4。', {
          current: color.outputGamma ?? color.outputSpace ?? '',
          recommended: { name: String(color.separate) === '1' ? PIPE_KEYS.outputGamma : PIPE_KEYS.outputSpace, value: 'Gamma 2.4' },
          risk: 'medium',
        }),
      )
    }
  }

  // HDR 输出到 SDR 没有 tone mapping
  if (color.hdrMastering === '1' && color.outputGammaFamily !== 'pq' && color.outputGammaFamily !== 'hlg' && (color.toneMapping ?? 'None') === 'None') {
    findings.push(
      finding('dl_hdr_to_sdr', 'error', 'HDR 项目直接输出 SDR（无 tone mapping）', `HDR 母版开着（峰值 ${color.hdrPeak ?? '未知'} nits），输出是 SDR 且 tone mapping = None，高光会溢出或整体发灰。`, {
        current: `toneMapping=${color.toneMapping ?? 'None'}`,
        recommended: { name: PIPE_KEYS.toneMapping, value: 'DaVinci' },
        risk: 'high',
      }),
    )
  }

  if (/aces/i.test(String(color.science ?? '')) && /no input transform/i.test(String(color.acesIdt ?? 'no input transform')) && /no output transform/i.test(String(color.acesOdt ?? 'no output transform'))) {
    findings.push(
      finding('dl_aces_transforms_unset', 'warn', 'ACES 管线未选择 IDT / ODT', 'ACES 下 IDT/ODT 都是 No Transform 时基本等于没走 ACES。注意：部分取值会被 Resolve 静默拒绝，插件不自动写。', {
        current: 'IDT/ODT = No Transform',
        manual: '项目设置 → 色彩管理 → ACES Input/Output Transform 里手动选择；改完再体检一次。',
      }),
    )
  }

  if (unmanaged && /^HDR/i.test(String(color.workingLuminanceMode ?? ''))) {
    findings.push(
      finding('dl_hdr_working_sdr', 'warn', '非色彩管理管线却用了 HDR 工作时间线亮度', `色彩科学是 ${color.science}（非管理），工作时间线亮度却是 ${color.workingLuminanceMode}。这套组合会让 HDR 工具的响应与 SDR 素材不一致。`, {
        current: color.workingLuminanceMode,
        recommended: { name: PIPE_KEYS.workingLuminanceMode, value: 'SDR' },
        risk: 'high',
      }),
    )
  }

  if (color.dataLevels === 'Full') {
    findings.push(
      finding('dl_data_levels_full', 'warn', '项目数据电平为 Full', 'Full 电平项目按视频电平监听/交付时会黑位白位对不上。标准视频交付通常是 Video 电平。', {
        current: 'Full',
        recommended: { name: PIPE_KEYS.dataLevels, value: 'Video' },
        risk: 'high',
      }),
    )
  }

  if (findings.every((item) => item.severity === 'info')) {
    findings.push(
      finding('dl_all_good', 'ok', '没有发现会直接导致预览错误的设置冲突', `平台 ${snapshot.platform} · ${snapshot.version?.version_string ?? 'Resolve 版本未知'} · 色彩科学 ${color.science ?? '未知'} · 时间线 ${color.timelineSpace ?? '未设置'} · 输出 ${color.outputSpace ?? '未设置'}`, {
        current: color.timelineSpace ?? '',
      }),
    )
  }

  return { findings, color, timeline, prefs }
}

async function opPipelineSnapshot(ctx, args, signal) {
  const [version, runtime, settings, project, timeline] = await Promise.all([
    settle(callTool(ctx, 'resolve_control', { action: 'get_version' }, signal)),
    settle(callTool(ctx, 'resolve_control', { action: 'runtime_mode' }, signal)),
    settle(callTool(ctx, 'project_settings', { action: 'get_setting', params: { name: '' } }, signal)),
    settle(callTool(ctx, 'project_manager', { action: 'get_current' }, signal)),
    settle(callTool(ctx, 'timeline', { action: 'get_current' }, signal)),
  ])

  let timelineScope = null
  if (timeline.ok) {
    const pairs = await Promise.all(
      TIMELINE_OVERRIDE_KEYS.map(async (name) => {
        const result = await settle(callTool(ctx, 'timeline', { action: 'get_setting', params: { name } }, signal))
        return [name, result.ok ? (result.value?.settings ?? null) : null]
      }),
    )
    timelineScope = { ok: true, ...Object.fromEntries(pairs) }
  } else {
    timelineScope = { ok: false, error: timeline.error }
  }

  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.versions.node,
    version: version.ok ? version.value : null,
    versionError: version.ok ? null : version.error,
    runtime: runtime.ok ? runtime.value : null,
    project: project.ok ? project.value : null,
    settings: settings.ok ? { ok: true, value: settings.value } : { ok: false, error: settings.error },
    timeline: timeline.ok ? timeline.value : null,
    timelineScope,
    prefs: await readMacPrefs(),
  }
}

async function opPipelineDiagnose(ctx, args, signal) {
  const snapshot = await opPipelineSnapshot(ctx, args, signal)
  return { snapshot, ...diagnosePipeline(snapshot) }
}

/** 写一个色彩键并单键读回校验；色彩键写失败只回裸 {success:false}，没有原因。 */
async function writeSetting(ctx, signal, target, setting) {
  const tool = target === 'timeline' ? 'timeline' : 'project_settings'
  const written = await settle(callTool(ctx, tool, { action: 'set_setting', params: { ...setting } }, signal))
  if (!written.ok) return { written: false, error: written.error, setting }
  if (written.value?.success !== true) {
    return { written: false, error: 'Resolve 拒绝写入（该版本可能不支持这个取值）', setting, knownLimitation: written.value?.known_limitation ?? null }
  }
  const readback = await settle(callTool(ctx, tool, { action: 'get_setting', params: { name: setting.name } }, signal))
  const actual = readback.ok ? readback.value?.settings ?? null : null
  const expected = setting.value
  const same = String(actual ?? '').trim() === String(expected ?? '').trim()
  return { written: true, verified: same, setting, readback: actual, error: same ? null : `写入后读回不一致（读到 ${String(actual)}）` }
}

async function opPipelineFix(ctx, args, signal) {
  const snapshot = await opPipelineSnapshot(ctx, args, signal)
  const diagnosis = diagnosePipeline(snapshot)
  const wanted = Array.isArray(args.ids) && args.ids.length > 0 ? new Set(args.ids) : null
  const includeRisky = args.includeRisky === true
  const results = []

  for (const item of diagnosis.findings) {
    if (wanted && !wanted.has(item.id)) continue
    // 项目级色彩设置：即使是「需人工处理」的警告，只要能写就自动写（不再丢给用户）
    const AUTO_SAFE_KEYS = new Set(['colorScience', 'colorScienceMode', 'timelineLuminance', 'timelineWorkingLuminanceMode', 'colorSpaceTimeline', 'timelineColorSpace', 'outputColorSpace', 'colorSpaceOutput', 'colorSpaceOutputGamma', 'hdrTimeline'])
    const autoKey = item.recommended ? (Array.isArray(item.recommended) ? item.recommended[0]?.key ?? item.recommended[0]?.name : item.recommended.key ?? item.recommended.name) : null
    const canAutoWrite = Boolean(autoKey && AUTO_SAFE_KEYS.has(autoKey) && item.recommended)
    if (!wanted && (!item.autoFix || !includeRisky) && !canAutoWrite) {
      if (item.recommended && !item.autoFix) {
        results.push({ id: item.id, applied: false, skipped: true, reason: '只能在 Resolve 偏好设置里手动改（脚本 API 没有写入口）', setting: item.recommended })
      }
      continue
    }
    if (!item.recommended) {
      results.push({ id: item.id, applied: false, reason: item.manual ?? '没有可自动写入的设置' })
      continue
    }
    if (args.dryRun) {
      results.push({ id: item.id, applied: false, dryRun: true, wouldWrite: item.recommended, target: item.target })
      continue
    }
    const outcome = await writeSetting(ctx, signal, item.target, item.recommended)
    const extra = []
    if (item.recommended2) extra.push(await writeSetting(ctx, signal, item.target, item.recommended2))
    results.push({ id: item.id, target: item.target, ...outcome, extra })
  }

  const after = await opPipelineSnapshot(ctx, args, signal)
  return { results, remaining: diagnosePipeline(after).findings, snapshotAfter: after }
}

async function opRefImport(ctx, args, signal) {
  const dataUrl = typeof args.dataUrl === 'string' ? args.dataUrl : ''
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i.exec(dataUrl)
  if (!match) throw new Error('参考静帧必须是 PNG/JPEG/WebP 的 data URL')
  const ext = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg'
  const dir = await ensureDataDir('refs')
  const name = (typeof args.name === 'string' && args.name.trim()) || `ref-${stamp()}`
  const safeName = name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').slice(0, 60)
  const filePath = path.join(dir, `${safeName}-${stamp()}.${ext}`)
  await fs.writeFile(filePath, Buffer.from(match[2], 'base64'))
  const stats = await layersCli(['analyze', filePath])
  return { path: filePath, name: safeName, thumb: await thumbnail(filePath), stats }
}

async function opRefList(ctx, args, signal) {
  const dir = await ensureDataDir('refs')
  const names = await fs.readdir(dir)
  const refs = []
  for (const name of names.filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).slice(-30)) {
    const filePath = path.join(dir, name)
    refs.push({ name, path: filePath, thumb: await thumbnail(filePath) })
  }
  return { refs }
}

async function opLookCapture(ctx, args, signal) {
  const mode = args.mode === 'source' ? 'source' : 'rendered'
  let seek = null
  if (args.itemId && args.seek !== false) {
    const moved = await seekToItem(ctx, signal, args.itemId)
    seek = moved
    if (!moved.ok) throw new Error(`无法把播放头定位到该片段：${moved.error ?? '未知原因'}`)
  }
  let captured = null
  let fallback = null
  if (mode === 'source') {
    try {
      captured = await exportSourceFrame(ctx, signal, args.itemId)
    } catch (error) {
      fallback = messageOf(error)
    }
  }
  if (!captured) {
    captured = await captureRenderedFrame(ctx, signal, mode === 'source' ? 'src-fallback' : 'frame')
    if (mode === 'source' && !fallback) fallback = '源帧导出不可用，改用当前渲染帧'
  }
  const stats = await layersCli(['analyze', captured.path])
  return { mode, ...captured, seek, fallback, thumb: await thumbnail(captured.path), stats }
}

async function opLookMeasure(ctx, args, signal) {
  const filePath = args.path
  if (!filePath) throw new Error('look.measure 需要 path')
  return { path: filePath, stats: await layersCli(['analyze', filePath]) }
}

async function opLookPlan(ctx, args, signal) {
  if (!args.referencePath || !args.targetPath) throw new Error('look.plan 需要 referencePath 与 targetPath')
  const plan = await layersCli(['match', args.referencePath, args.targetPath])
  return plan
}

/**
 * 把两帧的全局统计做差，用来判断「.drx 到底有没有渲染出来」。
 * 只比较亮度和饱和度：它们对任何调色都会动，且不受局部区域抽样影响。
 */
function frameDelta(before, after) {
  const a = before?.layers?.global
  const b = after?.layers?.global
  if (!a || !b) return null
  return {
    luma: b.meanLuma - a.meanLuma,
    saturation: b.meanSat - a.meanSat,
    red: b.meanR - a.meanR,
    green: b.meanG - a.meanG,
    blue: b.meanB - a.meanB,
  }
}

function isNegligible(delta) {
  if (!delta) return true
  return Math.abs(delta.luma) < 0.008 && Math.abs(delta.saturation) < 0.012
}

/**
 * safe_apply_drx 是破坏性动作：第一次调用只返回 confirm_token，第二次带同一个 token 且参数
 * 完全一致才会落地（token 绑定 action+params 指纹、一次性、300 秒过期）。
 */
/**
 * reset_all_grades 也是破坏性动作：第一次返回 {status:'confirmation_required', confirm_token}，
 * 必须带 token 再调一次才真的清空。少了这一步，后面的「重试 .drx」是在旧图上做的，
 * 同结构 apply 会被 Resolve 忽略（实测：多段匹配里 3 节点→3 节点时画面不动）。
 */
async function resetGradeConfirmed(ctx, signal, itemId) {
  const call = (confirmToken) =>
    settle(
      callTool(
        ctx,
        'graph',
        {
          action: 'reset_all_grades',
          source: 'item',
          ...scopeOf(itemId),
          ...(confirmToken ? { confirm_token: confirmToken } : {}),
        },
        signal,
      ),
    )
  const first = await call(null)
  const token = first.ok ? first.value?.confirm_token : null
  if (!token) return { ...first, confirmed: false }
  const second = await call(token)
  return { ...second, confirmed: true }
}

async function applyDrxConfirmed(ctx, signal, params) {
  const first = await settle(
    callTool(ctx, 'timeline_item_color', { action: 'safe_apply_drx', params }, signal),
  )
  if (first.ok) return { applied: first, confirmStep: null }
  const token = first.value?.confirm_token
  if (!token) return { applied: first, confirmStep: null }
  const second = await settle(
    callTool(
      ctx,
      'timeline_item_color',
      { action: 'safe_apply_drx', params: { ...params, confirm_token: token } },
      signal,
    ),
  )
  return { applied: second, confirmStep: { ok: true, value: { tokenTtlSeconds: first.value?.ttl_seconds ?? null } } }
}

async function opLookApply(ctx, args, signal) {
  const itemId = args.itemId
  const plan = args.plan
  if (!itemId) throw new Error('look.apply 需要 itemId')
  if (!plan || !plan.layers) throw new Error('look.apply 需要 look.plan 的结果')

  const steps = []
  const saveVersion = args.saveVersion !== false
  let versionName = null
  if (saveVersion) {
    versionName = `AI 匹配 ${stamp()}`
    const saved = await settle(
      callTool(ctx, 'timeline_item_color', { action: 'add_version', name: versionName, ...scopeOf(itemId) }, signal),
    )
    steps.push({ step: '保存旧调色为版本', ok: saved.ok, value: saved.value, error: saved.error })
    if (!saved.ok) versionName = null
  }

  if (args.resetFirst) {
    const reset = await resetGradeConfirmed(ctx, signal, itemId)
    steps.push({ step: '清空旧调色', ok: reset.ok, value: reset.value, error: reset.error })
    if (!reset.ok) return { ok: false, steps, versionName, reason: '清空旧调色失败，已中止（旧调色仍完整）' }
  }

  // 应用前抓一帧，用于判断 .drx 是否真的渲染出来
  let beforeStats = null
  let beforePath = null
  try {
    const before = await captureRenderedFrame(ctx, signal, 'before')
    beforePath = before.path
    beforeStats = await layersCli(['analyze', before.path])
  } catch (error) {
    steps.push({ step: '应用前抓帧', ok: false, error: messageOf(error) })
  }

  const globalCdl = plan.layers.global?.cdl ?? null
  const built = await buildLayeredDrx(ctx, signal, plan, `look-${stamp()}`, args.targetStats ?? null)
  steps.push({ step: '生成多层 .drx', ok: true, value: built })

  const applyParams = { path: built.path, source: 'item', require_temp_path: true, ...scopeOf(itemId) }
  const firstTry = await applyDrxConfirmed(ctx, signal, applyParams)
  let applied = firstTry.applied
  if (firstTry.confirmStep) steps.push({ step: '拿到 confirm_token，执行确认', ...firstTry.confirmStep })
  steps.push({ step: '应用多层调色', ok: applied.ok, value: applied.value, error: applied.error })

  const nodes = await settle(
    callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scopeOf(itemId) }, signal),
  )
  const version = await settle(
    callTool(ctx, 'timeline_item_color', { action: 'get_current_version', ...scopeOf(itemId) }, signal),
  )

  // 渲染帧复核：结构变了但画面没动 = 这台 Resolve 不认生成式 .drx（实测 21.0.0b 的 wire format 不同）
  let mode = applied.ok ? 'drx-layered' : 'failed'
  let warning = null
  let afterStats = null
  let afterPath = null
  let delta = null
  if (applied.ok && beforeStats) {
    try {
      const after = await captureRenderedFrame(ctx, signal, 'after-drx')
      afterPath = after.path
      afterStats = await layersCli(['analyze', after.path])
      delta = frameDelta(beforeStats, afterStats)
      if (isNegligible(delta) || (nodes.ok && Number(nodes.value?.num_nodes ?? 0) === 0)) {
        mode = 'drx-ineffective'
      }
    } catch (error) {
      steps.push({ step: '应用后抓帧', ok: false, error: messageOf(error) })
    }
  }

  // Resolve 对「同结构 apply」有已知怪癖：先 reset_all_grades 再 apply 才会真的换掉参数。
  // 这里在检测到画面没动时按这个配方重试一次，仍无效才降级。
  if (mode === 'drx-ineffective') {
    const reset = await resetGradeConfirmed(ctx, signal, itemId)
    steps.push({ step: '画面未变化 → 清空后重试 .drx', ok: reset.ok, value: reset.value, error: reset.error })
    if (reset.ok) {
      const retry = await applyDrxConfirmed(ctx, signal, { path: built.path, source: 'item', require_temp_path: true, ...scopeOf(itemId) })
      steps.push({ step: '重试应用 .drx', ok: retry.applied.ok, value: retry.applied.value, error: retry.applied.error })
      if (retry.applied.ok && beforeStats) {
        try {
          const after = await captureRenderedFrame(ctx, signal, 'after-retry')
          const retryStats = await layersCli(['analyze', after.path])
          const retryDelta = frameDelta(beforeStats, retryStats)
          steps.push({ step: '重试后比对画面', ok: true, value: retryDelta })
          if (!isNegligible(retryDelta)) {
            mode = 'drx-layered'
            afterStats = retryStats
            afterPath = after.path
            delta = retryDelta
          }
        } catch (error) {
          steps.push({ step: '重试后抓帧', ok: false, error: messageOf(error) })
        }
      }
    }
  }

  // 降级路径：本机不认生成式 .drx 时，至少把「全局」校正用 SetCDL 落进去（这条通路实测会渲染）
  if (mode === 'drx-ineffective' && globalCdl) {
    steps.push({
      step: '检测到 .drx 在本机未渲染，降级为全局 CDL',
      ok: true,
      value: {
        reason: `生成的 .drx 结构能落地（节点数 ${nodes.ok ? nodes.value?.num_nodes : '?'}），但渲染帧没有变化：本机 Resolve 的 .drx 线格式与生成器不一致`,
        renderedDelta: delta,
      },
    })
    const fallback = await settle(
      callTool(
        ctx,
        'timeline_item_color',
        { action: 'safe_set_cdl', cdl: { NodeIndex: 1, ...globalCdl }, ...scopeOf(itemId) },
        signal,
      ),
    )
    steps.push({ step: '写入全局 CDL（SetCDL）', ok: fallback.ok, value: fallback.value, error: fallback.error })
    if (fallback.ok) {
      mode = 'cdl-fallback'
      warning =
        '本机 Resolve 版本不渲染生成的多层 .drx（结构能落地、画面不变）：已自动降级为「全局 CDL」应用，' +
        '分层方案仍保留在返回的 plan 里。要在本机得到真正的分层调色，需要 Resolve 版本支持该 .drx 线格式，' +
        '或按 plan 里各层的 qualifier 建议在 Resolve 里手工建节点。'
      try {
        const afterCdl = await captureRenderedFrame(ctx, signal, 'after-cdl')
        afterPath = afterCdl.path
        afterStats = await layersCli(['analyze', afterCdl.path])
        delta = frameDelta(beforeStats, afterStats)
      } catch {
        /* 抓帧失败不影响结论 */
      }
    }
  }

  let residual = null
  if (args.verify !== false && afterStats) {
    try {
      let compare = null
      let referenceStats = args.referenceStats ?? null
      if (args.referencePath) {
        if (!referenceStats) referenceStats = await layersCli(['analyze', args.referencePath])
        compare = await layersCli(['match', args.referencePath, afterPath])
      }
      residual = {
        beforePath,
        afterPath,
        beforeStats,
        afterStats,
        delta,
        compare,
        referenceStats,
        afterThumb: await thumbnail(afterPath),
      }
    } catch (error) {
      residual = { error: messageOf(error) }
    }
  }

  return {
    ok: mode === 'drx-layered' || mode === 'cdl-fallback',
    mode,
    warning,
    versionName,
    drxPath: built.path,
    expectedNodes: built.nodes,
    nodeGraph: nodes.ok ? nodes.value : null,
    version: version.ok ? version.value : null,
    applyVerification: applied.value?.verification ?? null,
    applyWarning: applied.value?.warning ?? null,
    layersApplied: built.nodes,
    steps,
    residual,
  }
}

/**
 * 整条轨道的多场戏匹配：对每个片段抓帧 → 与同一张参考帧比较 → 应用。
 * 参考帧固定，所以各镜头的目标一致；返回每段的落方式与分层校正，便于看镜头间离散度。
 */
async function opLookAuto(ctx, args, signal) {
  const referencePath = args.referencePath
  if (!referencePath) throw new Error('look.auto 需要 referencePath（先导入参考静帧）')
  const trackIndex = Math.max(1, Number(args.trackIndex) || 1)
  const items = await listVideoItems(ctx, signal, trackIndex)
  if (items.length === 0) throw new Error(`V${trackIndex} 上没有片段`)
  const limit = Math.min(items.length, Math.max(1, Number(args.limit) || 12))
  const resetFirst = args.resetFirst === true

  const results = []
  for (const item of items.slice(0, limit)) {
    const entry = { id: item.id, name: item.name, start: item.start }
    try {
      const seek = await seekToItem(ctx, signal, item.id)
      if (!seek.ok) {
        results.push({ ...entry, ok: false, error: `无法定位：${seek.error}` })
        continue
      }
      const captured = await captureRenderedFrame(ctx, signal, 'auto')
      const targetStats = await layersCli(['analyze', captured.path])
      const plan = await layersCli(['match', referencePath, captured.path])
      const applied = await opLookApply(
        ctx,
        {
          itemId: item.id,
          plan,
          referencePath,
          targetStats,
          saveVersion: true,
          verify: false,
          resetFirst,
        },
        signal,
      )
      results.push({
        ...entry,
        ok: applied.ok !== false,
        mode: applied.mode,
        nodes: applied.layersApplied,
        globalCdl: plan?.layers?.global?.cdl ?? null,
        layers: Object.fromEntries(
          Object.entries(plan?.layers ?? {}).map(([key, layer]) => [key, layer?.confidence ?? null]),
        ),
        versionName: applied.versionName,
        warning: applied.warning ?? null,
      })
    } catch (error) {
      results.push({ ...entry, ok: false, error: messageOf(error) })
    }
  }

  const applied = results.filter((entry) => entry.ok)
  const modes = applied.reduce((acc, entry) => {
    acc[entry.mode ?? 'unknown'] = (acc[entry.mode ?? 'unknown'] ?? 0) + 1
    return acc
  }, {})
  const lumaTargets = applied
    .map((entry) => (entry.globalCdl?.Slope ? entry.globalCdl.Slope.reduce((a, b) => a + b, 0) / 3 : null))
    .filter((value) => typeof value === 'number')

  return {
    trackIndex,
    requested: limit,
    matched: applied.length,
    failed: results.length - applied.length,
    modes,
    globalGainSpread: lumaTargets.length > 1 ? Math.max(...lumaTargets) - Math.min(...lumaTargets) : null,
    results,
  }
}

// ---------------------------------------------------------------------------
// v3：场景识别 / 三级调色 / 自动剪辑 / 抠图
// ---------------------------------------------------------------------------

/** 带缓存破坏参数的动态 import，配合 bundle 重启即可热更新 lib 里的纯函数模块。 */
async function importFresh(relPath) {
  const url = new URL(`./${relPath}?rev=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, import.meta.url)
  return import(url.href)
}

async function clipSourceInfo(ctx, signal, item) {
  const media = await settle(
    callTool(ctx, 'timeline_item', { action: 'get_media_pool_item', ...scopeOf(item.id) }, signal),
  )
  const clipId = media.ok ? (media.value?.id ?? null) : null
  let filePath = null
  if (clipId) {
    const prop = await settle(
      callTool(ctx, 'media_pool_item', { action: 'get_clip_property', params: { clip_id: clipId, key: 'File Path' } }, signal),
    )
    const value = prop.ok ? prop.value?.properties : null
    filePath = typeof value === 'string' && value ? value : null
  }
  const srcStart = await settle(
    callTool(ctx, 'timeline_item', { action: 'get_source_start_frame', ...scopeOf(item.id) }, signal),
  )
  const srcEnd = await settle(
    callTool(ctx, 'timeline_item', { action: 'get_source_end_frame', ...scopeOf(item.id) }, signal),
  )
  return {
    itemId: item.id,
    name: item.name,
    recordStart: Number(item.start),
    recordEnd: Number(item.end),
    duration: Number(item.duration),
    clipId,
    filePath,
    sourceStartFrame: srcStart.ok ? Number(srcStart.value?.frame) : null,
    sourceEndFrame: srcEnd.ok ? Number(srcEnd.value?.frame) : null,
  }
}

/**
 * 扫描时间线：不需要移动播放头。
 * 用时间线项 → 媒体池→源文件路径，直接上 ffmpeg 检测镜头（比渲染分析快一个量级），
 * 再把镜头时间映射回记录帧。返回每个镜头的代表帧路径与客观指标，供上层看图描述。
 */
async function opScenesScan(ctx, args, signal) {
  const timeline = await settle(callTool(ctx, 'timeline', { action: 'get_current' }, signal))
  if (!timeline.ok) throw new Error(`读不到当前时间线：${timeline.error ?? '未知'}`)
  const fps = await projectFps(ctx, signal)
  const trackIndex = Math.max(1, Number(args.trackIndex) || 1)
  const items = await listVideoItems(ctx, signal, trackIndex)
  if (items.length === 0) throw new Error(`V${trackIndex} 上没有片段`)
  const limit = Math.min(items.length, Math.max(1, Number(args.limit) || 20))

  const clips = []
  const scenes = []
  let sceneIndex = 1
  for (const item of items.slice(0, limit)) {
    const info = await clipSourceInfo(ctx, signal, item)
    clips.push(info)
    if (!info.filePath) continue
    let scan = null
    try {
      scan = await (async () => {
        const stdout = await run(
          process.execPath,
          [path.join(HERE, 'lib', 'scenes.mjs'), 'scan', info.filePath, '--json', '--threshold', String(args.threshold ?? 0.3)],
          { timeoutMs: 180_000 },
        )
        return JSON.parse(stdout)
      })()
    } catch (error) {
      clips[clips.length - 1].scanError = messageOf(error)
      continue
    }
    const { intersectShotWithSource } = await importFresh('lib/source_range.mjs')
    const sourceStart = Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0
    const sourceEnd = Number.isFinite(info.sourceEndFrame) ? info.sourceEndFrame : sourceStart + Math.max(1, Math.round((Number(info.durationFrames) || 0)))
    for (const shot of scan.shots ?? []) {
      // 交给纯函数做交集：镜头按整段源素材扫描，但只能用时间线片段实际可用的源区间
      const range = intersectShotWithSource({
        shotStartSec: shot.start,
        shotEndSec: shot.end,
        fps,
        sourceStartFrame: sourceStart,
        sourceEndFrame: sourceEnd,
        recordStart: info.recordStart,
      })
      if (!range.ok) continue
      scenes.push({
        index: sceneIndex++,
        itemId: info.itemId,
        clipId: info.clipId,
        clipName: info.name,
        fileName: path.basename(info.filePath),
        recordStart: range.recordStart,
        recordEnd: range.recordEnd,
        durationFrames: range.durationFrames,
        sourceStartFrame: range.inFrame,
        sourceEndFrame: range.outFrame,
        startSeconds: range.inFrame / fps,
        endSeconds: range.outFrame / fps,
        clippedHeadFrames: range.clippedHeadFrames,
        clippedTailFrames: range.clippedTailFrames,
        frames: (shot.frames ?? []).filter((frame) => {
          const frameNo = Math.round(Number(frame) * fps)
          return Number.isFinite(frameNo) ? frameNo >= range.inFrame && frameNo < range.outFrame : true
        }),
        metrics: shot.metrics ?? null,
      })
    }
  }

  const withThumbs = []
  for (const scene of scenes.slice(0, Math.max(1, Number(args.thumbLimit) || 8))) {
    withThumbs.push({ index: scene.index, frame: scene.frames?.[0] ?? null, thumb: scene.frames?.[0] ? await thumbnail(scene.frames[0]) : null })
  }

  return {
    timeline: timeline.value?.name ?? null,
    fps,
    trackIndex,
    scannedClips: clips.length,
    sceneCount: scenes.length,
    scenes,
    thumbs: withThumbs,
    note:
      '镜头时间由 ffmpeg 场景检测得出；代表帧在 ' +
      path.join(DATA_DIR, 'frames') +
      ' 同级的 .scenes 目录。要描述「每场在干什么」，直接读 frames 里的图。',
  }
}

/**
 * 三级调色 + Vibe 意图：01 一级平衡 / 02 一级对比 / 03+ 二级键控 / 最后 三级 look。
 * 节点由 lib/grade3.mjs 生成（纯函数），这里负责生成 .drx、应用与复核。
 */
async function opGradeTiers(ctx, args, signal) {
  const { parseVibe, buildTierPlan } = await importFresh('lib/grade3.mjs')
  const vibeText = String(args.vibeText ?? '')
  const vibe = parseVibe(vibeText)

  let analysis = args.analysis ?? null
  let itemId = args.itemId ?? null
  if (!analysis) {
    if (!itemId) {
      const current = await callTool(ctx, 'timeline_markers', { action: 'get_current_video_item' }, signal)
      itemId = current?.id ?? null
      if (!itemId) {
        const items = await listVideoItems(ctx, signal, 1)
        itemId = items[0]?.id ?? null
      }
    }
    if (!itemId) throw new Error('没有目标片段：把播放头停在片段上或传 itemId')
    await seekToItem(ctx, signal, itemId)
    const captured = await captureRenderedFrame(ctx, signal, 'tiers')
    analysis = await layersCli(['analyze', captured.path])
    args = { ...args, targetPath: captured.path }
  }
  if (!itemId) throw new Error('grade.tiers 需要 itemId')

  const built = buildTierPlan({ analysis, vibe, style: args.style ?? 'none' })
  if (!Array.isArray(built.nodes) || built.nodes.length < 2) throw new Error('三级方案节点不足，无法落地')

  const dir = await ensureTempDir('drx')
  const basePath = path.join(dir, `tiers-${stamp()}-base.drx`)
  const outPath = path.join(dir, `tiers-${stamp()}-layered.drx`)
  await callTool(
    ctx,
    'drx',
    {
      action: 'generate',
      gradeParams: built.nodes[0].params,
      metadata: { label: built.nodes[0].label },
      target: 'clip',
      outputPath: basePath,
    },
    signal,
  )
  await callTool(
    ctx,
    'drx',
    { action: 'merge', basePath, newNodes: built.nodes.slice(1), outputPath: outPath },
    signal,
  )

  const versionName = `AI 三级 ${stamp()}`
  const saved = await settle(
    callTool(ctx, 'timeline_item_color', { action: 'add_version', name: versionName, ...scopeOf(itemId) }, signal),
  )
  if (args.resetFirst) await resetGradeConfirmed(ctx, signal, itemId)
  const applied = await applyDrxConfirmed(ctx, signal, {
    path: outPath,
    source: 'item',
    require_temp_path: true,
    ...scopeOf(itemId),
  })
  const nodes = await settle(
    callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scopeOf(itemId) }, signal),
  )
  return {
    ok: applied.applied.ok,
    versionName: saved.ok ? versionName : null,
    drxPath: outPath,
    expectedNodes: built.nodes.length,
    nodeGraph: nodes.ok ? nodes.value : null,
    vibe,
    tiers: built.tiers,
    notes: built.notes,
    nodeLabels: built.nodes.map((node) => node.label),
    applied: applied.applied.value ?? null,
    error: applied.applied.ok ? null : applied.applied.error,
  }
}

/**
 * 自动剪辑：基于场景扫描与 lib/edit3.mjs 的可解释决策，直接建一条新时间线（不改原时间线）。
 */
async function opEditAuto(ctx, args, signal) {
  let decide = null
  let decisionKind = 'edit3'
  try {
    const editscore = await importFresh('lib/editscore.mjs')
    const scan = await opScenesScan(ctx, { ...args, thumbLimit: 0 }, signal)
    const fps = scan.fps ?? 24
    const shots = scan.scenes.map((scene) => ({
      index: scene.index,
      itemId: scene.itemId,
      clipId: scene.clipId,
      duration: scene.durationFrames / fps,
      metrics: scene.metrics,
      start: scene.sourceStartFrame / fps,
      end: scene.sourceEndFrame / fps,
      sourceStartFrame: scene.sourceStartFrame,
      sourceEndFrame: scene.sourceEndFrame,
      recordStart: scene.recordStart,
    }))
    const scores = editscore.scoreShots(shots, { preferSharp: args.preferSharp !== false })
    const rhythm = editscore.planRhythm({
      shots,
      scores,
      targetDuration: args.targetDuration,
      beatSeconds: args.beatSeconds,
      bpm: args.bpm,
      minShot: args.minShotDuration,
      maxShot: args.maxShotDuration,
    })
    decisionKind = 'editscore'
    decide = {
      decision: {
        edits: rhythm.edits,
        totalDuration: rhythm.totalDuration,
        dropped: rhythm.dropped,
        pacing: rhythm.pacing,
        scores,
        narrative: editscore.narrativeSummary({ edits: rhythm.edits, scenes: scan.scenes }),
      },
      scan,
    }
  } catch (error) {
    const { planSelects } = await importFresh('lib/edit3.mjs')
    const scan = await opScenesScan(ctx, { ...args, thumbLimit: 0 }, signal)
    const fps = scan.fps ?? 24
    const shots = scan.scenes.map((scene) => ({
      index: scene.index,
      itemId: scene.itemId,
      clipId: scene.clipId,
      duration: scene.durationFrames / fps,
      metrics: scene.metrics,
      sourceStartFrame: Math.round(scene.startSeconds * fps),
      sourceEndFrame: Math.round(scene.endSeconds * fps),
      recordStart: scene.recordStart,
    }))
    const decision = planSelects({
      shots,
      targetDuration: args.targetDuration,
      minShotDuration: args.minShotDuration,
      maxShotDuration: args.maxShotDuration,
      preferSharp: args.preferSharp !== false,
    })
    decide = { decision, scan, fallbackReason: messageOf(error) }
  }

  const { decision, scan } = decide
  if (!decision.edits || decision.edits.length === 0) return { ok: false, decision, reason: '没有可用镜头', decisionKind }

  const timelineName = String(args.name ?? `AI 剪辑 ${stamp()}`)
  const fps = scan.fps ?? 24
  // 顺序放置：record_frame 必须累计（逐段相接），不能都用 index（会全部叠在开头）
  let cursor = 0
  const { clampEditToSource } = await importFresh('lib/source_range.mjs')
  const clipInfos = decision.edits
    .map((edit) => {
      const shot = scan.scenes.find((entry) => entry.index === edit.shotIndex)
      if (!shot?.clipId) return null
      const clamped = clampEditToSource({
        inSec: edit.in,
        outSec: edit.out,
        fallbackInSec: shot.sourceStartFrame / fps,
        fallbackOutSec: shot.sourceEndFrame / fps,
        sourceStartFrame: shot.sourceStartFrame,
        sourceEndFrame: shot.sourceEndFrame,
        fps,
      })
      if (!clamped.ok) return null
      const info = {
        clip_id: shot.clipId,
        start_frame: clamped.inFrame,
        end_frame: clamped.outFrame,
        record_frame: cursor,
        track_index: 1,
      }
      cursor += clamped.durationFrames
      return info
    })
    .filter(Boolean)

  const created = await callTool(
    ctx,
    'media_pool',
    { action: 'create_timeline_from_clips', params: { name: timelineName, clip_infos: clipInfos } },
    signal,
  )
  return {
    ok: created?.success !== false,
    timelineName,
    decisionKind,
    narrative: decision.narrative ?? null,
    pacing: decision.pacing ?? null,
    decision,
    clipInfos,
    sequenceFrames: cursor,
    created,
    originalTimeline: scan.timeline,
    fallbackReason: decide.fallbackReason ?? null,
  }
}

/**
 * 抠图：把上传图落到数据目录，再用 macOS Vision 抠出带 alpha 的 PNG。
 * 返回路径与缩略图；失败时给出可读原因（比如系统拒绝 Vision 请求）。
 */
async function opMaskCutout(ctx, args, signal) {
  const dir = await ensureDataDir('overlays')
  let inputPath = typeof args.path === 'string' ? args.path : ''
  if (!inputPath && typeof args.dataUrl === 'string') {
    const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i.exec(args.dataUrl)
    if (!match) throw new Error('图片必须是 PNG/JPEG/WebP data URL')
    const ext = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg'
    inputPath = path.join(dir, `upload-${stamp()}.${ext}`)
    await fs.writeFile(inputPath, Buffer.from(match[2], 'base64'))
  }
  if (!inputPath) throw new Error('mask.cutout 需要 dataUrl 或 path')
  const outputPath = path.join(dir, `cutout-${stamp()}.png`)
  const { cutoutImage } = await importFresh('lib/cutout.mjs')
  const result = await cutoutImage(inputPath, outputPath)
  return { inputPath, outputPath, ...result, thumb: await thumbnail(outputPath) }
}

// ---------------------------------------------------------------------------
// v3：擦除（钢丝/威亚/细异物）
// ---------------------------------------------------------------------------

async function probeMediaSize(filePath) {
  try {
    const stdout = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath],
      { timeoutMs: 30_000 },
    )
    const parsed = JSON.parse(stdout)
    const stream = parsed?.streams?.[0]
    if (stream?.width && stream?.height) return { width: Number(stream.width), height: Number(stream.height) }
  } catch {
    /* 退回下面用帧尺寸 */
  }
  return null
}

/** 从片段源文件按比例抽 N 帧（不碰播放头），用于细线检测与目检。 */
async function extractProbeFrames(ctx, signal, info, fps, count = 6, rangeStartSec = null, rangeEndSec = null) {
  if (!info.filePath) throw new Error('片段没有可读的源文件路径')
  const baseStart = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps
  const startSec = Number.isFinite(rangeStartSec) ? baseStart + Number(rangeStartSec) : baseStart
  const durationSec = Number.isFinite(rangeEndSec)
    ? Math.max(0.1, Number(rangeEndSec) - (Number.isFinite(rangeStartSec) ? Number(rangeStartSec) : 0))
    : Math.max(0.1, info.duration / fps)
  const dir = await ensureDataDir(path.join('frames', `probe-${stamp()}`))
  const frames = []
  for (let index = 0; index < count; index += 1) {
    const t = startSec + (durationSec * (index + 0.5)) / count
    const outPath = path.join(dir, `probe-${index}.jpg`)
    await run('ffmpeg', ['-v', 'error', '-ss', String(t.toFixed(3)), '-i', info.filePath, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', '-y', outPath], {
      timeoutMs: 60_000,
    })
    frames.push(outPath)
  }
  return { frames, startSec, durationSec }
}

/** 确保时间线有第 N 条视频轨（贴图/擦除要叠到 V2，新建时间线默认只有 V1）。 */
async function ensureVideoTrack(ctx, signal, index) {
  const current = await settle(callTool(ctx, 'timeline', { action: 'get_track_count', params: { track_type: 'video' } }, signal))
  const count = Number(current.ok ? current.value?.count : 1) || 1
  for (let next = count + 1; next <= index; next += 1) {
    const added = await settle(callTool(ctx, 'timeline', { action: 'add_track', params: { track_type: 'video', options: { index: next } } }, signal))
    if (!added.ok) return { ok: false, error: added.error, count }
  }
  return { ok: true, count: Math.max(count, index) }
}

async function opEraseDetect(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  let info = null
  if (args.itemId) {
    const items = []
    for (const trackIndex of [1, 2, 3]) {
      items.push(...(await listVideoItems(ctx, signal, trackIndex)).map((item) => ({ item, trackIndex })))
    }
    const hit = items.find((entry) => entry.item.id === args.itemId)
    if (!hit) throw new Error(`找不到时间线片段 ${args.itemId}`)
    info = await clipSourceInfo(ctx, signal, hit.item)
  } else {
    const current = await callTool(ctx, 'timeline_markers', { action: 'get_current_video_item' }, signal)
    let itemId = current?.id ?? null
    if (!itemId) {
      const items = await listVideoItems(ctx, signal, 1)
      itemId = items[0]?.id ?? null
    }
    if (!itemId) throw new Error('没有片段：先选中或传 itemId')
    const items = await listVideoItems(ctx, signal, 1)
    const item = items.find((entry) => entry.id === itemId) ?? items[0]
    info = await clipSourceInfo(ctx, signal, item)
  }
  const probe = await extractProbeFrames(ctx, signal, info, fps, Math.max(2, Number(args.frames) || 6), args.rangeStartSec, args.rangeEndSec)
  const size = await probeMediaSize(info.filePath)
  const stdout = await run(
    process.execPath,
    [
      path.join(HERE, 'lib', 'erase.mjs'),
      'detect',
      ...probe.frames,
      '--json',
      ...(size ? ['--source-width', String(size.width), '--source-height', String(size.height)] : []),
      ...(Number.isFinite(args.minFramesRatio) ? ['--min-frames-ratio', String(args.minFramesRatio)] : []),
    ],
    { timeoutMs: 120_000 },
  )
  const detected = JSON.parse(stdout)
  const { toDelogoBoxes } = await importFresh('lib/erase.mjs')
  const boxes = toDelogoBoxes(detected.candidates ?? [], size ?? detected.sourceSize)
  const thumbs = []
  for (const frame of probe.frames.slice(0, 3)) thumbs.push(await thumbnail(frame))
  return {
    itemId: info.itemId,
    itemName: info.name,
    filePath: info.filePath,
    mediaSize: size,
    frames: probe.frames,
    thumbs,
    candidates: detected.candidates ?? [],
    delogoBoxes: boxes,
    note: 'candidates 是「细且位置稳定」的异常线；delogoBoxes 已换算成源分辨率并做偶数对齐，可直接喂 erase.render',
  }
}

/**
 * 用 ffmpeg delogo 把指定矩形从源里「擦掉」（按四周像素插值），生成一条干净片段，
 * 导入媒体池并叠到 V2 原位置；原片段不动，便于对比与回退。
 */
async function opEraseRender(ctx, args, signal) {
  const boxes = Array.isArray(args.boxes) ? args.boxes : []
  if (boxes.length === 0) throw new Error('erase.render 需要 boxes：[{x,y,w,h}]（可先用 erase.detect 拿候选）')
  const fps = await projectFps(ctx, signal)
  let item = null
  if (args.itemId) {
    const items = await listVideoItems(ctx, signal, 1)
    item = items.find((entry) => entry.id === args.itemId) ?? null
  }
  if (!item) {
    const items = await listVideoItems(ctx, signal, 1)
    item = items[0] ?? null
  }
  if (!item) throw new Error('V1 上没有片段')
  const info = await clipSourceInfo(ctx, signal, item)
  if (!info.filePath) throw new Error('片段没有可读源文件，无法离线擦除')

  const dir = await ensureDataDir('clean')
  const outPath = path.join(dir, `clean-${stamp()}.mp4`)
  const baseStartSec = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps
  const rangeStart = Number.isFinite(args.rangeStartSec) ? Number(args.rangeStartSec) : 0
  const rangeEnd = Number.isFinite(args.rangeEndSec) ? Number(args.rangeEndSec) : info.duration / fps
  const startSec = baseStartSec + rangeStart
  const durationSec = Math.max(0.1, Math.min(info.duration / fps, rangeEnd) - rangeStart)
  const filter = boxes
    .map((box) => `delogo=x=${Math.max(0, Math.round(box.x))}:y=${Math.max(0, Math.round(box.y))}:w=${Math.max(8, Math.round(box.w))}:h=${Math.max(8, Math.round(box.h))}`)
    .join(',')
  await run(
    'ffmpeg',
    ['-v', 'error', '-i', info.filePath, '-ss', String(startSec.toFixed(3)), '-t', String(durationSec.toFixed(3)), '-vf', filter, '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', '-y', outPath],
    { timeoutMs: 600_000 },
  )

  const cleanFrames = await extractFramesFromFile(outPath, 3)
  const imported = await callTool(ctx, 'media_pool', { action: 'safe_import_media', params: { paths: [outPath] } }, signal)
  const clipId = imported?.clips?.[0]?.id ?? null
  const track = await ensureVideoTrack(ctx, signal, 2)
  const cleanFrameCount = Math.max(1, Math.round(durationSec * fps))
  let placed = null
  if (clipId) {
    // 刚导入的素材偶尔还没在 Resolve 里就绪（AppendToTimeline 返回没有 id 的项），等一拍再挂
    await new Promise((resolve) => setTimeout(resolve, 400))
    placed = await settle(
      callTool(
        ctx,
        'media_pool',
        {
          action: 'append_to_timeline',
          params: {
            clip_infos: [
              {
                clip_id: clipId,
                start_frame: 0,
                end_frame: cleanFrameCount,
                record_frame: info.recordStart + Math.round(rangeStart * fps),
                record_frame_mode: 'absolute',
                track_index: 2,
              },
            ],
          },
        },
        signal,
      ),
    )
  }
  return {
    ok: Boolean(clipId),
    outputPath: outPath,
    boxes,
    filter,
    importedClipId: clipId,
    placed: placed?.ok ?? null,
    placedValue: placed?.value ?? placed?.error ?? null,
    track,
    cleanFrameCount,
    thumbs: await Promise.all(cleanFrames.map((frame) => thumbnail(frame))),
    note: '干净片段已导入并叠到 V2 的同一位置；确认满意后可手动替换 V1 原片段（或关掉 V2 原片段）。',
  }
}

async function extractFramesFromFile(filePath, count) {
  const dir = await ensureDataDir(path.join('frames', `out-${stamp()}`))
  const frames = []
  for (let index = 0; index < count; index += 1) {
    const out = path.join(dir, `f-${index}.jpg`)
    try {
      await run(
        'ffmpeg',
        ['-v', 'error', '-ss', String(0.2 + index * 0.7), '-i', filePath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', out],
        { timeoutMs: 60_000 },
      )
      frames.push(out)
    } catch {
      break
    }
  }
  return frames
}

// ---------------------------------------------------------------------------
// v3：贴图跟随（抠图 → 逐帧跟踪 → 合成带 alpha 的 ProRes → 叠到 V2）
// ---------------------------------------------------------------------------

async function extractFramesAt(filePath, times, outDir, width = 1280) {
  const frames = []
  for (let index = 0; index < times.length; index += 1) {
    const out = path.join(outDir, `f-${String(index).padStart(4, '0')}.jpg`)
    await run(
      'ffmpeg',
      ['-v', 'error', '-ss', String(Math.max(0, times[index]).toFixed(3)), '-i', filePath, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '2', '-y', out],
      { timeoutMs: 60_000 },
    )
    frames.push(out)
  }
  return frames
}

async function timelineResolution(ctx, signal) {
  const width = await settle(callTool(ctx, 'project_settings', { action: 'get_setting', params: { name: 'timelineResolutionWidth' } }, signal))
  const height = await settle(callTool(ctx, 'project_settings', { action: 'get_setting', params: { name: 'timelineResolutionHeight' } }, signal))
  const parse = (outcome, fallback) => {
    const raw = outcome.ok ? outcome.value?.settings : null
    const value = Number.parseInt(String(raw ?? ''), 10)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return { width: parse(width, 1920), height: parse(height, 1080) }
}

/**
 * 贴图跟随方案：抽帧 → (可选 Vision 自动给初始框) → 逐帧跟踪矩形 → 得到每帧目标框。
 * 不动播放头，直接从源文件抽帧。
 */
async function opOverlayPlan(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const items = await listVideoItems(ctx, signal, 1)
  const item = (args.itemId ? items.find((entry) => entry.id === args.itemId) : items[0]) ?? null
  if (!item) throw new Error('V1 上没有片段')
  const info = await clipSourceInfo(ctx, signal, item)
  if (!info.filePath) throw new Error('片段没有可读源文件')

  const sampleFps = Math.max(1, Math.min(24, Number(args.sampleFps) || 6))
  const baseStartSec = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps
  const rangeStart = Number.isFinite(args.rangeStartSec) ? Number(args.rangeStartSec) : 0
  const rangeEnd = Number.isFinite(args.rangeEndSec) ? Number(args.rangeEndSec) : info.duration / fps
  const durationSec = Math.max(0.2, Math.min(info.duration / fps, rangeEnd) - rangeStart)
  const startSec = baseStartSec + rangeStart
  const sampleCount = Math.max(2, Math.min(Number(args.maxFrames) || 40, Math.round(durationSec * sampleFps)))
  const times = Array.from({ length: sampleCount }, (_, index) => startSec + (durationSec * (index + 0.5)) / sampleCount)
  const dir = await ensureDataDir(path.join('frames', `track-${stamp()}`))
  const frames = await extractFramesAt(info.filePath, times, dir, 1280)

  const { trackBox, salientBox } = await importFresh('lib/cutout.mjs')
  let box = args.box ?? null
  let boxSource = 'user'
  if (!box) {
    const salient = await salientBox(frames[0])
    if (!salient?.box) throw new Error('无法自动定位目标：请传 box {x,y,w,h}（相对 1280 宽抽帧的像素坐标）')
    box = salient.box
    boxSource = 'salient'
  }
  const normalized = Array.isArray(box)
    ? { x: Number(box[0]), y: Number(box[1]), w: Number(box[2]), h: Number(box[3]) }
    : { x: Number(box.x), y: Number(box.y), w: Number(box.w), h: Number(box.h) }
  if (![normalized.x, normalized.y, normalized.w, normalized.h].every((value) => Number.isFinite(value))) {
    throw new Error('box 需要 {x,y,w,h} 四个数字')
  }

  const tracked = await trackBox(frames[0], normalized, frames.slice(1))
  const trackedFrames = [{ path: frames[0], ...normalized, confidence: 1 }, ...(tracked.frames ?? [])]
  if (!trackedFrames.length) throw new Error('跟踪没有返回任何帧')

  return {
    ok: true,
    itemId: item.id,
    itemName: info.name,
    filePath: info.filePath,
    recordStart: info.recordStart,
    durationFrames: info.duration,
    timelineFps: fps,
    sampleFps,
    frameWidth: 1280,
    boxSource,
    lostAt: tracked.lostAt ?? null,
    frames: trackedFrames.map((frame, index) => ({
      index,
      time: times[index] ?? times[times.length - 1],
      x: frame.x,
      y: frame.y,
      w: frame.w,
      h: frame.h,
      confidence: frame.confidence ?? null,
    })),
    firstThumb: await thumbnail(frames[0]),
  }
}

/**
 * 贴图渲染：按跟踪框把带 alpha 的贴图贴到每个时间线帧上（线性插值补齐采样间隔），
 * 编码成带 alpha 的 ProRes 4444，导入媒体池并叠到 V2 原位置。
 */
async function opOverlayRender(ctx, args, signal) {
  const overlayPath = args.overlayPath
  const plan = args.plan
  if (!overlayPath) throw new Error('overlay.render 需要 overlayPath（mask.cutout 的输出）')
  if (!plan?.frames?.length) throw new Error('overlay.render 需要 overlay.plan 的结果')
  const { composeOverlayMovie } = await importFresh('lib/overlay.mjs')
  const resolution = await timelineResolution(ctx, signal)
  const fps = Number(plan.timelineFps) || (await projectFps(ctx, signal))
  const requestedFrames = Number.isFinite(args.maxFrames) ? Math.max(1, Math.min(Number(plan.durationFrames) || plan.frames.length, Number(args.maxFrames))) : null
  const durationFrames = requestedFrames ?? Math.max(1, Number(plan.durationFrames) || plan.frames.length)

  // 采样框 → 每个时间线帧的框（线性插值；坐标系是 1280 宽抽帧，按比例放大到时间线分辨率）
  const scale = resolution.width / (Number(plan.frameWidth) || 1280)
  const samples = plan.frames
  const byFrame = []
  for (let index = 0; index < durationFrames; index += 1) {
    const progress = durationFrames <= 1 ? 0 : (index / (durationFrames - 1)) * (samples.length - 1)
    const low = Math.floor(progress)
    const high = Math.min(samples.length - 1, low + 1)
    const t = progress - low
    const a = samples[low]
    const b = samples[high]
    byFrame.push({
      x: (a.x + (b.x - a.x) * t) * scale,
      y: (a.y + (b.y - a.y) * t) * scale,
      w: Math.max(2, (a.w + (b.w - a.w) * t) * scale),
      h: Math.max(2, (a.h + (b.h - a.h) * t) * scale),
    })
  }

  const dir = await ensureDataDir('overlays')
  const outPath = path.join(dir, `overlay-${stamp()}.mov`)
  const composed = await composeOverlayMovie({
    overlayPath,
    frames: byFrame,
    width: resolution.width,
    height: resolution.height,
    fps,
    outPath,
  })

  const imported = await callTool(ctx, 'media_pool', { action: 'safe_import_media', params: { paths: [outPath] } }, signal)
  const clipId = imported?.clips?.[0]?.id ?? null
  const track = await ensureVideoTrack(ctx, signal, 2)
  let placed = null
  if (clipId) {
    placed = await settle(
      callTool(
        ctx,
        'media_pool',
        {
          action: 'append_to_timeline',
          params: {
            clip_infos: [
              {
                clip_id: clipId,
                start_frame: 0,
                end_frame: durationFrames,
                record_frame: Number(plan.recordStart) || 0,
                record_frame_mode: 'absolute',
                track_index: 2,
              },
            ],
          },
        },
        signal,
      ),
    )
  }
  return {
    ok: Boolean(clipId),
    outPath,
    composed,
    resolution,
    durationFrames,
    importedClipId: clipId,
    placed: placed?.ok ?? null,
    placedValue: placed?.value ?? placed?.error ?? null,
    track,
    note: '带 alpha 的 ProRes 4444 已导入并叠到 V2；跟丢的帧会沿用最后一个框（可用 plan.lostAt 判断）。',
  }
}

// ---------------------------------------------------------------------------
// v4：Camera Raw 流程（相机识别 → 科学套用 LUT / 色彩管理）
// ---------------------------------------------------------------------------

async function ffprobeJson(filePath) {
  const stdout = await run(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
    { timeoutMs: 45_000 },
  )
  return JSON.parse(stdout)
}

async function resolveItemContext(ctx, signal, itemId) {
  let item = null
  let trackIndex = 1
  if (itemId) {
    const foundResult = await findItemAcrossTracks(ctx, signal, itemId)
    if (!foundResult.hit) throw new Error(foundResult.error)
    item = foundResult.hit.item
    trackIndex = foundResult.hit.trackIndex
  } else {
    const items = await listVideoItems(ctx, signal, 1)
    item = items[0] ?? null
    if (!item) throw new Error('V1 上没有片段（未指定 itemId 时默认取 V1 第一条；可用 itemId 指定其它轨）')
  }
  const info = await clipSourceInfo(ctx, signal, item)
  let clipProperties = null
  if (info.clipId) {
    const props = await settle(
      callTool(ctx, 'media_pool_item', { action: 'get_clip_property', params: { clip_id: info.clipId } }, signal),
    )
    clipProperties = props.ok ? (props.value?.properties ?? null) : null
  }
  return { item, info, clipProperties, trackIndex }
}

async function sampleSourceStats(ctx, signal, info, fps) {
  try {
    const probe = await extractProbeFrames(ctx, signal, info, fps, 1)
    return await layersCli(['analyze', probe.frames[0]])
  } catch {
    return null
  }
}

/** 识别当前片段/指定片段的相机、传输函数，以及“要不要套 LUT”。 */
/** 相机 LOG 自动还原：识别机型 → 生成/安装对应 LUT → 套到片段节点上（考试/日常都用这个）。 */
async function opCameraFix(ctx, args, signal) {
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  const { detectCamera } = await importFresh('lib/camera.mjs')
  // 必须用**源素材**判 LOG（渲染帧已经带调色，会把 Log 判成已调色）
  const sourceFrame = await exportSourceFrame(ctx, signal, item.id)
  if (!sourceFrame?.path) throw new Error('抓不到源素材帧，无法判断是否 LOG')
  const stats = await layersCli(['analyze', sourceFrame.path])
  const tagsText = await mediaTagsText(info.filePath)
  const detection = detectCamera({ filePath: info.filePath, name: `${info.name} ${tagsText}`, stats })
  // 文件名里没有机型时（如 A007C####），允许调用方指定机型/Log，避免"识别不到就干不了"
  const forced = typeof args.cameraKey === 'string' && args.cameraKey.trim() ? args.cameraKey.trim() : null
  const lutKey = forced ? (forced.endsWith('-to-rec709') ? forced : `${forced}-to-rec709`.replace('-to-rec709-to-rec709', '-to-rec709')) : detection.suggested.lutKey
  if (!forced && !detection.needsLut) return { ok: true, applied: false, detection, reason: detection.reason, hint: '文件名无机型信息时，传 cameraKey（如 dji-dlog / sony-slog3 / arri-logc3）指定 LOG' }
  const resolvedLut = await opLutEnsure(ctx, { name: (lutKey ?? '').replace('-to-rec709', '') || forced }, signal)
  if (!resolvedLut.ok) return { ok: false, detection, error: 'LUT 生成/下载失败', detail: resolvedLut }
  const ensured = resolvedLut
  const staged = await settle(callTool(ctx, 'lut', { action: 'install', name: `${lutKey}-to-rec709`, source_path: ensured.path, overwrite: true }, signal))
  const setLut = await settle(callTool(ctx, 'graph', { action: 'set_lut', node_index: Number(args.nodeIndex) || 1, lut_path: staged.ok ? staged.value?.set_lut_path : ensured.path, source: 'item', ...scopeOf(item.id) }, signal))
  return {
    ok: setLut.ok,
    applied: true,
    detection,
    lut: { key: lutKey, path: ensured.path, staged: staged.ok ? staged.value?.set_lut_path : null },
    nodeIndex: Number(args.nodeIndex) || 1,
    note: 'LOG→709 转换套在节点 1（输入/还原层），后续风格 LUT 在第三层',
  }
}

/** 读容器标签（handler_name / encoder / 相机模型等），相机识别不只看文件名。 */
async function mediaTagsText(filePath) {
  if (!filePath) return ''
  try {
    const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream_tags', '-of', 'json', filePath], { timeoutMs: 60_000 })
    const json = JSON.parse(out)
    const parts = []
    for (const stream of json.streams ?? []) {
      for (const [key, value] of Object.entries(stream.tags ?? {})) parts.push(`${key}=${value}`)
    }
    for (const [key, value] of Object.entries(json.format?.tags ?? {})) parts.push(`${key}=${value}`)
    return parts.join(' ')
  } catch {
    return ''
  }
}

async function opCameraDetect(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info, clipProperties } = await resolveItemContext(ctx, signal, args.itemId)
  let ffprobe = null
  let ffprobeError = null
  if (info.filePath) {
    try {
      ffprobe = await ffprobeJson(info.filePath)
    } catch (error) {
      ffprobeError = messageOf(error)
    }
  }
  const stats = args.skipStats ? null : await sampleSourceStats(ctx, signal, info, fps)
  const { detectCamera } = await importFresh('lib/camera.mjs')
  const detection = detectCamera({ ffprobe, clipProperties, stats, filePath: info.filePath ?? info.name })
  const project = await settle(callTool(ctx, 'project_settings', { action: 'get_setting', name: '' }, signal))
  const settings = project.ok ? (project.value?.settings ?? null) : null
  const science = settings?.colorScienceMode ?? null
  const managed = /colormanaged/i.test(String(science ?? ''))
  return {
    itemId: item.id,
    itemName: info.name,
    filePath: info.filePath,
    ffprobeError,
    mediaSize: info.filePath ? await probeMediaSize(info.filePath) : null,
    projectScience: science,
    projectManaged: managed,
    detection,
    statsSummary: stats?.layers
      ? Object.fromEntries(Object.entries(stats.layers).map(([key, layer]) => [key, layer?.coverage ?? null]))
      : null,
    recommendedPath: detection.needsLut ? (managed ? 'rcm' : 'lut') : 'none',
  }
}

/**
 * 按科学流程落地：识别 → 决定路径 → 套用 → 读回验证。
 * - `rcm` 路径：把素材的 Input Color Space 标对，让 Resolve 自己做变换（只在色彩管理项目里合理）
 * - `lut` 路径：写内置 .cube，用 graph.set_lut 挂到 1 号节点（非管理项目的正确做法）
 * 关键护栏：识别为「非 LOG」时**拒绝** LUT（绝不把非灰片当灰片处理）。
 */
async function opRawApply(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info, clipProperties } = await resolveItemContext(ctx, signal, args.itemId)
  let ffprobe = null
  if (info.filePath) {
    try {
      ffprobe = await ffprobeJson(info.filePath)
    } catch {
      ffprobe = null
    }
  }
  const stats = await sampleSourceStats(ctx, signal, info, fps)
  const { detectCamera } = await importFresh('lib/camera.mjs')
  const detection = detectCamera({ ffprobe, clipProperties, stats, filePath: info.filePath ?? info.name })
  const cameraKey = args.cameraKey || detection.suggested?.lutKey || null
  const restoreLut = cameraKey ? await findBuiltinRestoreLut(String(cameraKey).replace(/-(to-rec709|look).*$/, '').split('-')[0].toLowerCase()) : null

  const project = await settle(callTool(ctx, 'project_settings', { action: 'get_setting', name: '' }, signal))
  const science = project.ok ? project.value?.settings?.colorScienceMode : null
  const managed = /colormanaged/i.test(String(science ?? ''))
  const mode = args.mode && args.mode !== 'auto' ? args.mode : 'rcm'

  if (args.dryRun) {
    return { ok: true, dryRun: true, mode, cameraKey, detection, projectScience: science, note: 'dryRun：没有写任何东西' }
  }

  // 护栏 1：不是 LOG 且不是显式强制 → 不套
  if (detection.isLog !== true && !args.force) {
    return {
      ok: false,
      refused: true,
      mode: 'none',
      detection,
      reason: detection.reason || '未能确认素材是 LOG；为避免把非灰片当灰片，本操作已拒绝。需要强制时传 force:true',
    }
  }
  // 护栏 2：选 lut 但机型曲线未内置 → 不猜
  if (mode === 'lut' && !cameraKey) {
    return {
      ok: false,
      refused: true,
      mode,
      detection,
      reason: detection.reason || '该机型没有内置 LOG→709 曲线：请在 Resolve 用 Color Space Transform 节点或官方 LUT',
    }
  }

  if (mode === 'rcm') {
    const target = args.inputColorSpace || detection.suggested?.inputColorSpace
    if (!target) return { ok: false, refused: true, mode, detection, reason: '没有可用的 Input Color Space 映射' }
    let projectSwitch = null
    if (!managed) {
      projectSwitch = await settle(
        callTool(ctx, 'project_settings', { action: 'set_setting', name: 'colorScienceMode', value: 'davinciYRGBColorManagedv2' }, signal),
      )
    }
    const written = await settle(
      callTool(
        ctx,
        'media_pool_item',
        { action: 'set_clip_property', params: { clip_id: info.clipId, key: 'Input Color Space', value: target } },
        signal,
      ),
    )
    const readback = await settle(
      callTool(
        ctx,
        'media_pool_item',
        { action: 'get_clip_property', params: { clip_id: info.clipId, key: 'Input Color Space' } },
        signal,
      ),
    )
    const actual = readback.ok ? readback.value?.properties ?? null : null
    const verified = String(actual ?? '').trim() === String(target).trim()
    return {
      ok: Boolean(written.ok && written.value?.success !== false),
      mode,
      cameraKey,
      detection,
      target,
      projectSwitch: projectSwitch ? Boolean(projectSwitch.ok) : null,
      written: written.value ?? null,
      readback: actual,
      verified,
      note: verified
        ? 'Input Color Space 已写入并读回一致：Resolve 在色彩管理项目里会用它做输入变换'
        : '写入后读回不一致或写入失败：该项目/版本可能不允许改素材色彩属性，请手动在 Clip Attributes 里设置',
    }
  }

  // lut 路径：只允许 DaVinci 自带 LUT（或已安装的官方 LUT），绝不手搓生成
  if (!restoreLut) {
    return {
      ok: false,
      refused: true,
      mode,
      cameraKey,
      detection,
      needsLut: true,
      reason: 'DaVinci 自带库里没有该机型 LOG→Rec709 的还原 LUT',
      hint: '请提供相机官网下载的 .cube（lut.acquire 传 path/dataUrl），或改用 RCM 的 Input Color Space；插件不会自制还原 LUT',
    }
  }
  const written = { path: restoreLut.path, name: restoreLut.name }
  debugPush({ stage: '还原', message: `素材判定为 ${detection.label} ${detection.isLog ? '(LOG)' : ''} → 使用 DaVinci 自带/官方 LUT：${path.basename(String(written.path))}，挂到 1 号节点（还原先于一切调色）` })
  const set = await settle(
    callTool(ctx, 'graph', { action: 'set_lut', node_index: 1, lut_path: written.path, source: 'item', ...scopeOf(item.id) }, signal),
  )
  const readback = await settle(
    callTool(ctx, 'graph', { action: 'get_lut', node_index: 1, source: 'item', ...scopeOf(item.id) }, signal),
  )
  return {
    ok: Boolean(set.ok && set.value?.success !== false),
    mode,
    cameraKey,
    cameraLabel: detection.label,
    lutPath: written.path,
    lutBytes: written.bytes,
    setResult: set.value ?? null,
    setError: set.ok ? null : set.error,
    lutReadback: readback.ok ? readback.value : null,
    detection,
    verified: Boolean(readback.ok && JSON.stringify(readback.value ?? '').toLowerCase().includes(cameraKey.split('-')[0])),
    note: '内置曲线按公开规范实现；应用后请用 time 线上一帧确认对比与饱和度是否回到正常范围',
  }
}

// ---------------------------------------------------------------------------
// v4：自然语言入口（理解模糊需求 → 路由到已有 ops）
// ---------------------------------------------------------------------------

const ROUTE_RULES = [
  {
    id: 'camera',
    match: /相机|机型|机器|camera|raw|灰片|log|lut|套 lut|套lut|色彩空间转换|cst/i,
    ops: ['camera.detect'],
    say: '先识别素材来源与是否 LOG，再决定套不套 LUT。',
  },
  {
    id: 'pipeline',
    match: /709|gamma|管线|预览不对|发灰|偏色严重|色彩空间设置|mac\s*颜色|显示器/i,
    ops: ['pipeline.diagnose'],
    say: '先体检色彩管线（含 macOS 709-A / 查看器 ICC）。',
  },
  {
    id: 'scenes',
    match: /几场|哪场|分场|场景|场戏|剧情|讲什么|在干什么/i,
    ops: ['scenes.scan'],
    say: '先扫时间线切点与代表帧，再按语义分场。',
  },
  {
    id: 'edit',
    match: /剪辑|剪一版|挑镜头|节奏|卡点|成片|selects|粗剪/i,
    ops: ['edit.auto'],
    say: '按场景与节奏评分挑镜头，生成 selects 时间线。',
  },
  {
    id: 'match',
    match: /参考|静帧|匹配|还原|像这张|统一|一场戏.*颜色|色调统一/i,
    ops: ['look.capture'],
    say: '需要一张参考静帧；先抓目标帧，再做分层匹配。',
  },
  {
    id: 'spill',
    match: /绿色溢出|溢色|spill|绿边/i,
    ops: ['grade.tiers'],
    say: '绿幕溢色走二级绿色 qualifier 键控（不是整体去绿）。',
  },
  {
    id: 'cast',
    match: /太绿|偏绿|发绿|太黄|太蓝|偏冷|偏暖|太红/i,
    ops: ['grade.tiers'],
    say: '整体偏色走一级白平衡/去偏色。',
  },
  {
    id: 'vibe',
    match: /肤色|对比|饱和|胶片|质感|高光|暗部|干净|通透/i,
    ops: ['grade.tiers'],
    say: '按风格意图生成三级节点。',
  },
  {
    id: 'overlay',
    match: /贴图|抠图|鱼|logo|跟随|车窗|海报/i,
    ops: ['mask.cutout'],
    say: '先抠图（PNG/JPG 都行），再跟踪目标区域合成带 alpha 的贴图。',
  },
  {
    id: 'erase',
    match: /擦|钢丝|威亚|穿帮|灯架|线缆|移除/i,
    ops: ['erase.detect'],
    say: '先检测细且位置稳定的异物线，再决定擦除范围。',
  },
]

/**
 * 自然语言 → 执行计划。默认只出计划（plan-only），execute:true 才真正调用（只调用非破坏性/自带版本保护的动作）。
 */
async function opVibeRun(ctx, args, signal) {
  const text = String(args.text ?? '').trim()
  if (!text) throw new Error('vibe.run 需要 text（用户的一句话）')
  const { parseVibe } = await importFresh('lib/grade3.mjs')
  const vibe = parseVibe(text)
  const matched = ROUTE_RULES.filter((rule) => rule.match.test(text))
  let item = null
  let info = null
  let itemError = null
  try {
    const resolved = await resolveItemContext(ctx, signal, args.itemId)
    item = resolved.item
    info = resolved.info
  } catch (error) {
    itemError = messageOf(error)
  }
  const itemIdOrNull = item?.id ?? null

  const actions = []
  const seenOps = new Set()
  for (const rule of matched) {
    for (const op of rule.ops) {
      if (seenOps.has(op)) continue
      seenOps.add(op)
      actions.push({ op, args: itemIdOrNull ? { itemId: itemIdOrNull } : {}, why: rule.say })
    }
  }
  // 颜色类意图 → 带上原话给 grade.tiers
  for (const action of actions) {
    if (action.op === 'grade.tiers') {
      action.args = { ...(itemIdOrNull ? { itemId: itemIdOrNull } : {}), vibeText: text, style: args.style ?? 'none' }
    }
  }
  // 匹配类需要参考帧：告诉用户还缺什么
  const needs = []
  if (!itemIdOrNull) needs.push(`先在时间线上停在一个片段上（当前读不到任何片段${itemError ? `：${itemError}` : ''}）`)
  if (matched.some((rule) => rule.id === 'match') && !args.referencePath) {
    needs.push('一张参考静帧（在「深度匹配」页导入，或把图片发给我）')
  }
  if (matched.some((rule) => rule.id === 'overlay') && !args.overlayPath) {
    needs.push('要贴的图片（PNG/JPG 均可，会先自动抠图）与目标区域（车窗/玻璃）的框')
  }

  const executed = []
  if (args.execute === true) {
    const allowed = new Set(['camera.detect', 'pipeline.diagnose', 'scenes.scan', 'edit.auto', 'grade.tiers', 'erase.detect', 'mask.cutout'])
    for (const action of actions) {
      if (!allowed.has(action.op)) continue
      if (action.op === 'mask.cutout' && !args.imageDataUrl) continue
      try {
        const handler = OPS[action.op]
        const value = await handler(ctx, { ...action.args, ...(action.op === 'mask.cutout' ? { dataUrl: args.imageDataUrl } : {}) }, signal)
        executed.push({ op: action.op, ok: true, value })
      } catch (error) {
        executed.push({ op: action.op, ok: false, error: messageOf(error) })
      }
      if (executed.length >= 2) break
    }
  }

  return {
    ok: true,
    text,
    item: itemIdOrNull ? { id: item.id, name: info?.name ?? null } : null,
    intents: vibe.intents ?? [],
    vibeSummary: vibe.summary ?? null,
    plan: actions.map((action) => ({ op: action.op, why: action.why, args: action.args })),
    needs,
    executed,
    note:
      args.execute === true
        ? '已按计划执行（只执行非破坏性动作，最多 2 步）；破坏性动作仍需要单独确认。'
        : '这是执行计划（未写入任何东西）。传 execute:true 才会执行。',
  }
}

async function opCameraList(ctx, args, signal) {
  const camera = await importFresh('lib/camera.mjs')
  const lutgen = await importFresh('lib/lutgen.mjs')
  return { cameras: camera.listCameraRules(), luts: lutgen.listCameras() }
}

// ---------------------------------------------------------------------------
// v4：8 层匹配 + 一键场景统一 + 透视贴图
// ---------------------------------------------------------------------------

/** 8 层 CDL → drx 节点（qualifier 按层语义给键控范围）。 */
function qualifierFor8(layerName, stats) {
  const huePercent = (value, fallback) => {
    const candidate = typeof value === 'number' ? value : fallback
    return Math.min(100, Math.max(0, Number.isFinite(candidate) ? candidate : fallback))
  }
  if (layerName === 'skin') {
    return {
      qualifier: {
        hueCenter: huePercent(stats?.meanHuePercent, 6),
        hueWidth: 22,
        hueSymmetry: 50,
        hueSoft: 11,
        satLow: 12,
        satHigh: 88,
        satLowSoft: 5,
        satHighSoft: 5,
        lumLow: 20,
        lumHigh: 80,
        lumLowSoft: 5,
        lumHighSoft: 5,
      },
      matteFinesse: { blackClip: 2, whiteClip: 2, denoise: 5, blur: 3 },
    }
  }
  if (layerName === 'specular') {
    return { lumaQualifier: { lumLow: 88, lumLowSoft: 8, lumHigh: 100, lumHighSoft: 4 } }
  }
  if (layerName === 'glare') {
    return {
      qualifier: { satLow: 20, satHigh: 100, satLowSoft: 8, lumLow: 75, lumHigh: 100, lumLowSoft: 10 },
    }
  }
  if (layerName === 'shadow') {
    return { lumaQualifier: { lumLow: 0, lumLowSoft: 6, lumHigh: 18, lumHighSoft: 12 } }
  }
  if (layerName === 'backgroundWarm') {
    return {
      qualifier: { hueCenter: huePercent(stats?.meanHuePercent ?? 13, 13), hueWidth: 28, hueSoft: 15, satLow: 10, lumLow: 0, lumHigh: 92 },
    }
  }
  if (layerName === 'backgroundCool') {
    return {
      qualifier: { hueCenter: huePercent(stats?.meanHuePercent ?? 63, 63), hueWidth: 30, hueSoft: 15, satLow: 10, lumLow: 0, lumHigh: 92 },
    }
  }
  if (layerName === 'neutral') {
    return { qualifier: { satLow: 0, satHigh: 14, satHighSoft: 6, lumLow: 15, lumHigh: 90 } }
  }
  return null
}

async function buildLayeredDrx8(ctx, signal, plan, labelPrefix, targetStats) {
  const dir = await ensureTempDir('drx')
  const basePath = path.join(dir, `${labelPrefix}-base.drx`)
  const outPath = path.join(dir, `${labelPrefix}-layered8.drx`)
  const identity = { Slope: [1, 1, 1], Offset: [0, 0, 0], Power: [1, 1, 1], Saturation: 1 }
  const globalCdl = plan?.layers?.global?.cdl ?? identity
  const baseNode = cdlNode(`${labelPrefix} 01 一级·平衡`, globalCdl, null, { withSaturation: false })
  await callTool(ctx, 'drx', { action: 'generate', gradeParams: baseNode.params, metadata: { label: baseNode.label }, target: 'clip', outputPath: basePath }, signal)

  const newNodes = []
  const saturation = Number(globalCdl.Saturation ?? 1)
  if (Number.isFinite(saturation) && Math.abs(saturation - 1) > 0.01) {
    newNodes.push(cdlNode(`${labelPrefix} 02 一级·饱和`, { ...identity, Saturation: saturation }))
  }
  const order = ['skin', 'specular', 'glare', 'backgroundWarm', 'backgroundCool', 'shadow', 'neutral']
  for (const layerName of order) {
    const entry = plan?.layers?.[layerName]
    if (!entry || entry.identity === true || entry.confidence === 'low') continue
    const qualifier = qualifierFor8(layerName, targetStats?.layers?.[layerName] ?? null)
    if (!qualifier) continue
    const label = { skin: '肤色', specular: '镜面/玻璃', glare: '炫光', backgroundWarm: '背景·暖', backgroundCool: '背景·冷', shadow: '暗部', neutral: '中性面' }[layerName]
    newNodes.push(cdlNode(`${labelPrefix} ${String(newNodes.length + 3).padStart(2, '0')} 二级·${label}`, entry.cdl, qualifier))
  }
  if (newNodes.length === 0) return { path: basePath, nodes: 1 }
  await callTool(ctx, 'drx', { action: 'merge', basePath, newNodes, outputPath: outPath }, signal)
  return { path: outPath, nodes: newNodes.length + 1, basePath }
}

/** 8 层匹配方案（不落地或落地，取决于 apply）。 */
async function opLookPlan8(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  const layers8 = await importFresh('lib/layers8.mjs')
  let referenceStats = null
  let referencePath = args.referencePath ?? null
  if (referencePath) {
    referenceStats = await layers8.analyzeFrame8(referencePath)
  } else {
    // 没有参考帧时，用「同一条时间线的第一个镜头」当基准（场景内自我统一）
    const items = await listVideoItems(ctx, signal, 1)
    const base = items[0] ?? item
    const seek = await seekToItem(ctx, signal, base.id)
    if (!seek.ok) throw new Error(`无法定位基准片段：${seek.error}`)
    const captured = await captureRenderedFrame(ctx, signal, 'ref8')
    referencePath = captured.path
    referenceStats = await layers8.analyzeFrame8(referencePath)
  }
  const seek = await seekToItem(ctx, signal, item.id)
  if (!seek.ok) throw new Error(`无法定位目标片段：${seek.error}`)
  const captured = await captureRenderedFrame(ctx, signal, 'target8')
  const targetStats = await layers8.analyzeFrame8(captured.path)
  const plan = layers8.compareLayers8(referenceStats, targetStats)
  return { ok: true, itemId: item.id, itemName: info.name, referencePath, targetPath: captured.path, plan, targetStats, fps }
}

async function opLookApply8(ctx, args, signal) {
  const plan = args.plan
  if (!plan?.layers) throw new Error('look.apply8 需要 look.plan8 的 plan')
  const itemId = args.itemId
  if (!itemId) throw new Error('look.apply8 需要 itemId')
  const versionName = `AI 8层 ${stamp()}`
  const saved = await settle(callTool(ctx, 'timeline_item_color', { action: 'add_version', name: versionName, ...scopeOf(itemId) }, signal))
  if (args.resetFirst) await resetGradeConfirmed(ctx, signal, itemId)
  const built = await buildLayeredDrx8(ctx, signal, plan, `look8-${stamp()}`, args.targetStats ?? null)
  const applied = await applyDrxConfirmed(ctx, signal, { path: built.path, source: 'item', require_temp_path: true, ...scopeOf(itemId) })
  const nodes = await settle(callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scopeOf(itemId) }, signal))
  return {
    ok: applied.applied.ok,
    mode: applied.applied.ok ? 'drx-layered' : 'failed',
    versionName: saved.ok ? versionName : null,
    drxPath: built.path,
    expectedNodes: built.nodes,
    nodeGraph: nodes.ok ? nodes.value : null,
    applied: applied.applied.value ?? null,
    error: applied.applied.ok ? null : applied.applied.error,
  }
}

/** 一键场景统一：对一条轨道上的多个镜头，以基准帧为准做 8 层匹配并落地。 */
async function opScenesUnify(ctx, args, signal) {
  const layers8 = await importFresh('lib/layers8.mjs')
  const fps = await projectFps(ctx, signal)
  const trackIndex = Math.max(1, Number(args.trackIndex) || 1)
  const items = await listVideoItems(ctx, signal, trackIndex)
  if (items.length === 0) throw new Error(`V${trackIndex} 上没有片段`)
  const limit = Math.min(items.length, Math.max(1, Number(args.limit) || 6))

  // 基准：用户给参考图，否则用第一个片段抓的渲染帧
  let referencePath = args.referencePath ?? null
  if (!referencePath) {
    const seekBase = await seekToItem(ctx, signal, items[0].id)
    if (!seekBase.ok) throw new Error('无法定位基准片段')
    const captured = await captureRenderedFrame(ctx, signal, 'unify-ref')
    referencePath = captured.path
  }
  const referenceStats = await layers8.analyzeFrame8(referencePath)

  const results = []
  for (const item of items.slice(0, limit)) {
    try {
      const seek = await seekToItem(ctx, signal, item.id)
      if (!seek.ok) {
        results.push({ itemId: item.id, name: item.name, ok: false, error: `无法定位：${seek.error}` })
        continue
      }
      const captured = await captureRenderedFrame(ctx, signal, 'unify-target')
      const targetStats = await layers8.analyzeFrame8(captured.path)
      const plan = layers8.compareLayers8(referenceStats, targetStats)
      const versionName = `AI 场景统一 ${stamp()}`
      const saved = await settle(callTool(ctx, 'timeline_item_color', { action: 'add_version', name: versionName, ...scopeOf(item.id) }, signal))
      const built = await buildLayeredDrx8(ctx, signal, plan, `unify-${stamp()}`, targetStats)
      const applied = await applyDrxConfirmed(ctx, signal, { path: built.path, source: 'item', require_temp_path: true, ...scopeOf(item.id) })
      const nodes = await settle(callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scopeOf(item.id) }, signal))
      results.push({
        itemId: item.id,
        name: item.name,
        ok: applied.applied.ok,
        versionName: saved.ok ? versionName : null,
        nodes: nodes.ok ? nodes.value?.num_nodes ?? null : null,
        expectedNodes: built.nodes,
        globalCdl: plan?.layers?.global?.cdl ?? null,
        error: applied.applied.ok ? null : applied.applied.error,
      })
    } catch (error) {
      results.push({ itemId: item.id, name: item.name, ok: false, error: messageOf(error) })
    }
  }
  const okCount = results.filter((entry) => entry.ok).length
  return { ok: okCount > 0, referencePath, trackIndex, requested: limit, applied: okCount, results }
}

/**
 * 透视贴图：逐帧检测矩形（车窗/屏幕），用单应把贴图贴上去。
 * 比矩形跟踪更适合“倾斜/透视变化的玻璃”。
 */
async function opOverlayPerspective(ctx, args, signal) {
  const overlayPath = args.overlayPath
  if (!overlayPath) throw new Error('overlay.perspective 需要 overlayPath（mask.cutout 的输出）')
  const fps = await projectFps(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  if (!info.filePath) throw new Error('片段没有可读源文件')
  const resolution = await timelineResolution(ctx, signal)
  const rangeStart = Number.isFinite(args.rangeStartSec) ? Number(args.rangeStartSec) : 0
  const rangeEnd = Number.isFinite(args.rangeEndSec) ? Number(args.rangeEndSec) : info.duration / fps
  const sampleFps = Math.max(1, Math.min(12, Number(args.sampleFps) || 4))
  const durationSec = Math.max(0.2, Math.min(info.duration / fps, rangeEnd) - rangeStart)
  const sampleCount = Math.max(2, Math.min(16, Math.round(durationSec * sampleFps)))
  const baseStart = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps
  const times = Array.from({ length: sampleCount }, (_, index) => baseStart + rangeStart + (durationSec * (index + 0.5)) / sampleCount)
  const dir = await ensureDataDir(path.join('frames', `persp-${stamp()}`))
  const frames = await extractFramesAt(info.filePath, times, dir, 1280)

  const { detectRectangles } = await importFresh('lib/cutout.mjs')
  const { quadsFromRects, composeOverlayMovieHomography } = await importFresh('lib/overlay.mjs')
  const quads = []
  const detections = []
  for (const frame of frames) {
    const detected = await detectRectangles(frame)
    detections.push({ frame, rects: detected.rects?.length ?? 0, best: detected.best?.confidence ?? null })
    if (!detected.ok || !detected.rects?.length) continue
    const rectIndex = Number(args.rectIndex) || 0
    let corners = null
    try {
      corners = quadsFromRects(detected, 1280, 720, { index: rectIndex })
    } catch {
      corners = detected.rects[rectIndex]?.corners ?? detected.rects[0]?.corners ?? null
    }
    if (!Array.isArray(corners) || corners.length !== 4) continue
    const scale = resolution.width / 1280
    quads.push({ corners: corners.map((point) => ({ x: point.x * scale, y: point.y * scale })) })
  }
  if (quads.length === 0) {
    return { ok: false, reason: '所有采样帧都没有检测到矩形；请改用 overlay.plan（矩形跟踪）或手动给框', detections }
  }
  // 补齐长度：检测失败的帧沿用上一帧四边形
  while (quads.length < sampleCount) quads.push(quads[quads.length - 1])

  const durationFrames = Math.max(1, Math.round(durationSec * fps))
  const framesPerQuad = Math.max(1, Math.floor(durationFrames / quads.length))
  const perFrame = []
  for (let index = 0; index < durationFrames; index += 1) {
    const quadIndex = Math.min(quads.length - 1, Math.floor(index / framesPerQuad))
    perFrame.push(quads[quadIndex])
  }
  const outPath = path.join(await ensureDataDir('overlays'), `persp-${stamp()}.mov`)
  const composed = await composeOverlayMovieHomography({
    overlayPath,
    quads: perFrame,
    width: resolution.width,
    height: resolution.height,
    fps,
    outPath,
  })
  const imported = await callTool(ctx, 'media_pool', { action: 'safe_import_media', params: { paths: [outPath] } }, signal)
  const clipId = imported?.clips?.[0]?.id ?? null
  const track = await ensureVideoTrack(ctx, signal, 2)
  let placed = null
  if (clipId) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    placed = await settle(
      callTool(
        ctx,
        'media_pool',
        {
          action: 'append_to_timeline',
          params: {
            clip_infos: [
              {
                clip_id: clipId,
                start_frame: 0,
                end_frame: durationFrames,
                record_frame: info.recordStart + Math.round(rangeStart * fps),
                record_frame_mode: 'absolute',
                track_index: 2,
              },
            ],
          },
        },
        signal,
      ),
    )
  }
  return {
    ok: Boolean(clipId),
    outPath,
    composed,
    resolution,
    durationFrames,
    detectedQuads: quads.length,
    sampleCount,
    detections,
    importedClipId: clipId,
    placed: placed?.ok ?? null,
    track,
    note: '逐帧矩形检测 + 单应变形贴图：适合车窗/屏幕这类四边形；检测失败帧沿用上一帧四边形。',
  }
}

// ---------------------------------------------------------------------------
// v4 深化：语义分场 / clean plate 擦除
// ---------------------------------------------------------------------------

/** 镜头 → 语义场：scenes.scan 之后按语义/指标归并，输出“几场戏、每场在干什么”。 */
async function opScenesGroup(ctx, args, signal) {
  const scan = await opScenesScan(ctx, { ...args, thumbLimit: args.thumbLimit ?? 4 }, signal)
  const { groupScenes, describeScenes, scenesForModel } = await importFresh('lib/scenegroup.mjs')
  const visual = args.visual && typeof args.visual === 'object' ? args.visual : {}
  const grouped = groupScenes(scan.scenes ?? [], visual, args.options ?? {})
  const described = describeScenes(grouped)
  const orderedFrames = (scan.scenes ?? []).map((scene) => scene.frames ?? [])
  const modelPayload = scenesForModel(grouped, orderedFrames)
  return {
    ok: true,
    timeline: scan.timeline,
    fps: scan.fps,
    shotCount: scan.sceneCount,
    ...grouped,
    text: described.text,
    perScene: described.perScene,
    modelPayload,
    thumbs: scan.thumbs,
    note: '分组依据写在每个 scene 的 basis 里；有 visual 标签（location/timeOfDay/description）时优先用语义边界，否则只按指标推断。',
  }
}

/**
 * clean plate 擦除：从多帧取逐像素时间中位数做干净底板，再把指定矩形区域替换成底板内容，
 * 输出干净片段并叠到 V2（静态机位）。
 */
async function opEraseClean(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  if (!info.filePath) throw new Error('片段没有可读源文件')
  const resolution = (await timelineResolution(ctx, signal))
  const rangeStart = Number.isFinite(args.rangeStartSec) ? Number(args.rangeStartSec) : 0
  const rangeEnd = Number.isFinite(args.rangeEndSec) ? Number(args.rangeEndSec) : info.duration / fps
  const durationSec = Math.max(0.2, Math.min(info.duration / fps, rangeEnd) - rangeStart)
  const sampleFps = Math.max(1, Math.min(12, Number(args.sampleFps) || 4))
  const sampleCount = Math.max(3, Math.min(20, Math.round(durationSec * sampleFps)))
  const baseStart = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps
  const dir = await ensureDataDir(path.join('frames', `clean-${stamp()}`))
  const times = Array.from({ length: sampleCount }, (_, index) => baseStart + rangeStart + (durationSec * (index + 0.5)) / sampleCount)
  const frames = await extractFramesAt(info.filePath, times, dir, resolution.width)

  const { buildCleanPlate, patchFramesWithPlate } = await importFresh('lib/erase.mjs')
  const plate = await buildCleanPlate(frames, { width: Math.min(640, resolution.width) })
  const boxes = Array.isArray(args.boxes) && args.boxes.length ? args.boxes : null
  const patchDir = await ensureDataDir(path.join('clean', `patch-${stamp()}`))
  const patched = boxes
    ? await patchFramesWithPlate({ frames, plate, boxes, outDir: patchDir })
    : null

  // 有 boxes → 用打完补丁的帧重编码；否则用底板本身生成一段静态“参考帧”（供人工确认）
  const outPath = path.join(await ensureDataDir('clean'), `cleanplate-${stamp()}.mp4`)
  if (patched && Array.isArray(patched) && patched.length > 0) {
    const listPath = path.join(patchDir, 'frames.txt')
    await fs.writeFile(listPath, patched.map((entry) => `file '${entry.path ?? entry}'`).join('\n'))
    await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-r', String(fps), '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', '-y', outPath], { timeoutMs: 600_000 })
  }
  return {
    ok: true,
    mode: 'clean-plate',
    itemId: item.id,
    itemName: info.name,
    sampleCount,
    plate: { width: plate.width, height: plate.height, bytes: plate.data?.length ?? null },
    patchedFrames: patched?.length ?? 0,
    outPath: patched ? outPath : null,
    boxes,
    note: boxes
      ? '已用时间中位数底板替换指定区域并重编码；静态机位效果最好，运动镜头请配合 erase.detect/render 的 delogo 方案'
      : '未给 boxes：只生成了 clean plate（用于确认/后续手动补帧）；给 boxes 才会输出干净片段',
  }
}

// ---------------------------------------------------------------------------
// v4.2：风格 LUT（强颜色设计走 LUT，节点只做常规校正）
// ---------------------------------------------------------------------------

/**
 * 调色护栏：对比「源素材帧（未调色）」与「当前渲染帧（已调色）」的统计，
 * 超限就给出违规项和建议强度。用在 grade.tiers / style.apply 之后自动跑。
 */
async function measureGradeGuard(ctx, signal, item, info, fps) {
  try {
    const { measureFrame, evaluate } = await importFresh('lib/gradeguard.mjs')
    const after = await captureRenderedFrame(ctx, signal, 'guard-after')
    const afterPath = after.path
    const startSec = ((Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps) + 0.3
    const beforePath = await extractFrameTo(info.filePath, startSec, 'guard-before')
    const beforeStats = await measureFrame(beforePath)
    const afterStats = await measureFrame(afterPath)
    return { ...evaluate(beforeStats, afterStats), afterPath, beforePath }
  } catch (error) {
    return { ok: null, error: messageOf(error), skipped: true }
  }
}

async function frameTempPath(prefix) {
  const dir = await ensureDataDir('frames')
  return path.join(dir, `${prefix}-${stamp()}.png`)
}

async function extractFrameTo(filePath, timeSec, prefix) {
  const outPath = await frameTempPath(prefix)
  await run('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, timeSec).toFixed(3)), '-i', filePath, '-frames:v', '1', '-y', outPath], { timeoutMs: 60_000 })
  return outPath
}

async function opGradeVerify(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  if (!info.filePath) throw new Error('片段没有可读源文件，无法对比源帧')
  const seek = await seekToItem(ctx, signal, item.id)
  if (!seek.ok) throw new Error(`无法定位片段：${seek.error}`)
  const guard = await measureGradeGuard(ctx, signal, item, info, fps)
  return {
    ok: guard.ok !== false,
    itemId: item.id,
    itemName: info.name,
    guard,
    limits: (await importFresh('lib/gradeguard.mjs')).GRADE_GUARD_LIMITS,
    note: guard.ok === false ? '当前调色越过护栏（黑位/色偏），建议降低强度' : '当前调色在护栏内',
  }
}

/** 生成风格 LUT 并套用，支持 strength（默认 0.32，Vibe 只要一点点）+ 自动护栏。 */
async function opStyleList(ctx, args, signal) {
  const { listLooks } = await importFresh('lib/lookgen.mjs')
  return { looks: listLooks() }
}

/**
 * 把内置风格 LUT 挂到时间线的 1 号节点（整条时间线统一 look）或某个片段。
 * 为什么用 LUT：本机 Resolve beta 的 drx 节点有「结构在、画面不一定变」的问题，SetLUT 实测可靠。
 */
async function opStyleApply(ctx, args, signal) {
  const preset = String(args.preset ?? '').trim()
  if (!preset) throw new Error('style.apply 需要 preset（cyberpunk / teal-orange / bleach）')
  const scope = args.scope === 'item' ? 'item' : 'timeline'
  const strength = Math.min(1, Math.max(0.05, Number.isFinite(Number(args.strength)) ? Number(args.strength) : 0.32))
  const { writeLookLut } = await importFresh('lib/lookgen.mjs')
  const dir = await ensureDataDir('luts')
  const written = await writeLookLut(preset, dir, { strength })
  const nodeIndex = Math.max(1, Number(args.nodeIndex) || 1)
  const targetParams = scope === 'item'
    ? { source: 'item', ...(args.itemId ? scopeOf(args.itemId) : {}) }
    : { source: 'timeline' }
  const set = await settle(
    callTool(ctx, 'graph', { action: 'set_lut', node_index: nodeIndex, lut_path: written.path, ...targetParams }, signal),
  )
  const readback = await settle(
    callTool(ctx, 'graph', { action: 'get_lut', node_index: nodeIndex, ...targetParams }, signal),
  )
  const applied = Boolean(set.ok && set.value?.success !== false)
  return {
    ok: applied,
    preset,
    scope,
    nodeIndex,
    lutPath: written.path,
    lutBytes: written.bytes,
    setResult: set.value ?? null,
    setError: set.ok ? null : set.error,
    lutReadback: readback.ok ? readback.value?.lut ?? readback.value : null,
    verified: Boolean(readback.ok),
    strength,
    lutName: written.name ?? null,
    note: applied
      ? `${scope === 'timeline' ? '时间线' : '片段'} ${nodeIndex} 号节点已挂上 ${preset} LUT（强度 ${strength}）；用 look.capture 看画面确认`
      : 'SetLUT 失败：检查 LUT 目录权限与该节点是否可用',
  }
}

// ---------------------------------------------------------------------------
// v5：环境自检/一键安装 + 剧情转录/剪辑 + 画幅检查 + 内嵌预览
// ---------------------------------------------------------------------------

async function opEnvStatus(ctx, args, signal) {
  const { checkEnvironment } = await importFresh('lib/envcheck.mjs')
  return await checkEnvironment()
}

async function opEnvInstall(ctx, args, signal) {
  const { installEnvironment } = await importFresh('lib/envcheck.mjs')
  const progressPath = path.join(await ensureDataDir('env'), 'install-progress.json')
  const write = async (entry) => {
    try {
      await fs.writeFile(progressPath, JSON.stringify({ at: new Date().toISOString(), entry }, null, 2))
    } catch {}
  }
  await write({ phase: 'start', items: args.items ?? null })
  const result = await installEnvironment(args.items, {
    onProgress: (entry) => {
      void write(entry)
    },
  })
  await write({ phase: 'done', ok: result.ok })
  return { ...result, progressPath }
}

/** 用一句合成语音自检 ASR 链路（不需要 Resolve）。 */
async function opEnvSelfTest(ctx, args, signal) {
  const { locateAsr, transcribeFile } = await importFresh('lib/asr.mjs')
  const located = locateAsr()
  if (!located.ok) return { ok: false, stage: 'locate', problems: located.problems, installHint: located.installHint }
  const dir = await ensureDataDir('env')
  const wavPath = path.join(dir, 'selftest.wav')
  // 用 macOS say 生成一句普通话（无声时直接失败，不伪造）
  try {
    await run('say', ['-v', 'Tingting', '-o', wavPath, '--data-format=LEI16@16000', '这是一次语音识别自检。'])
  } catch (error) {
    return { ok: false, stage: 'say', error: messageOf(error), note: '没有 Tingting 语音包，可跳过自检' }
  }
  const result = await transcribeFile(wavPath, {})
  const mentioned = String(result.text ?? '').includes('语音识别') || String(result.text ?? '').includes('自检')
  return {
    ok: Boolean(result.ok && mentioned),
    stage: 'transcribe',
    asr: { ok: result.ok, text: result.text, segments: result.segments, tookMs: result.tookMs },
    checked: mentioned,
    note: mentioned ? '合成语音被正确转写，ASR 链路可用' : '能转写但与原文差异较大（小模型正常范围），仅确认链路可用',
  }
}

// ---------------------------------------------------------------------------
// 剧情：转录 + 运动分析 + 剧情剪辑
// ---------------------------------------------------------------------------

function storyCachePath(timelineName) {
  return path.join(DATA_DIR, 'story', `${String(timelineName ?? 'timeline').replace(/[\/\\:*?"<>|\s]+/g, '_')}.json`)
}

async function loadStoryCache(timelineName) {
  try {
    return JSON.parse(await fs.readFile(storyCachePath(timelineName), 'utf8'))
  } catch {
    return { clips: {} }
  }
}

async function saveStoryCache(timelineName, cache) {
  const filePath = storyCachePath(timelineName)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(cache, null, 2))
  return filePath
}

/**
 * 逐片段转写台词（Vosk，离线）并缓存。把音频按「片段在源素材里的区间」抽出来转，
 * 避免整条时间线重复转写。
 */
async function opStoryTranscribe(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const trackIndex = Math.max(1, Number(args.trackIndex) || 1)
  const items = await listVideoItems(ctx, signal, trackIndex)
  if (items.length === 0) throw new Error(`V${trackIndex} 上没有片段`)
  const limit = Math.min(items.length, Math.max(1, Number(args.limit) || items.length))
  const { locateAsr, transcribeFile } = await importFresh('lib/asr.mjs')
  const located = locateAsr()
  if (!located.ok) return { ok: false, needsInstall: true, problems: located.problems, installHint: located.installHint }

  const timelineName = args.timelineName ?? (await currentTimelineName(ctx, signal))
  const cache = await loadStoryCache(timelineName)
  const results = []
  const startedAt = Date.now()
  for (const item of items.slice(0, limit)) {
    try {
      const info = await clipSourceInfo(ctx, signal, item)
      if (!info.filePath) {
        results.push({ itemId: item.id, name: item.name, ok: false, error: '没有可读源文件' })
        continue
      }
      const cacheKey = info.clipId ? `clip:${info.clipId}` : `item:${item.id}`
      const startSec = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps
      const durationSec = Math.max(0.2, info.duration / fps)
      if (cache.clips[cacheKey] && !args.force) {
        results.push({ itemId: item.id, name: item.name, ok: true, cached: true, segments: cache.clips[cacheKey].segments?.length ?? 0 })
        continue
      }
      const transcribed = await transcribeFile(info.filePath, { startSec, durationSec })
      if (!transcribed.ok) {
        results.push({ itemId: item.id, name: item.name, ok: false, error: transcribed.needsInstall ? 'ASR 未就绪' : '转写失败' })
        continue
      }
      cache.clips[cacheKey] = {
        itemId: item.id,
        clipId: info.clipId ?? null,
        name: info.name,
        startSec,
        durationSec,
        segments: transcribed.segments,
        text: transcribed.text,
        engine: transcribed.engine,
        tookMs: transcribed.tookMs,
        at: new Date().toISOString(),
      }
      results.push({ itemId: item.id, name: item.name, ok: true, segments: transcribed.segments.length, text: transcribed.text.slice(0, 60), tookMs: transcribed.tookMs })
    } catch (error) {
      results.push({ itemId: item.id, name: item.name, ok: false, error: messageOf(error) })
    }
  }
  const cachePath = await saveStoryCache(timelineName, cache)
  const totalSegments = Object.values(cache.clips).reduce((acc, clip) => acc + (clip.segments?.length ?? 0), 0)
  return {
    ok: results.some((result) => result.ok),
    timelineName,
    cachePath,
    transcribed: results.filter((result) => result.ok && !result.cached).length,
    cached: results.filter((result) => result.cached).length,
    totalSegments,
    elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
    results,
  }
}

async function currentTimelineName(ctx, signal) {
  const current = await settle(callTool(ctx, 'timeline', { action: 'get_current' }, signal))
  return current.ok ? current.value?.name ?? null : null
}

/**
 * 剧情剪辑：镜头扫描 + 运动曲线 + 台词 → 按「整句台词 + 动作停稳点」出方案。
 * 不落地（dry run），只返回可解释计划；edit.story 才建时间线。
 */
async function opStoryPlan(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const trackIndex = Math.max(1, Number(args.trackIndex) || 1)
  const scan = await opScenesScan(ctx, { ...args, trackIndex, thumbLimit: 0 }, signal)
  const timelineName = args.timelineName ?? scan.timeline ?? (await currentTimelineName(ctx, signal))
  const cache = await loadStoryCache(timelineName)
  const { analyseClipMotion } = await importFresh('lib/motion.mjs')
  const story = await importFresh('lib/story.mjs')
  const items = await listVideoItems(ctx, signal, trackIndex)
  const itemsById = new Map(items.map((item) => [item.id, item]))

  const motionByClip = {}
  const transcriptsByClip = {}
  const motionStats = []
  for (const item of items) {
    const info = await clipSourceInfo(ctx, signal, item)
    if (!info.filePath) continue
    const cacheKey = info.clipId ? `clip:${info.clipId}` : `item:${item.id}`
    const startSec = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps
    const durationSec = Math.max(0.2, info.duration / fps)
    if (args.withMotion !== false) {
      try {
        const curve = await analyseClipMotion(info.filePath, { startSec, durationSec, fps: args.motionFps ?? 6 })
        // 曲线时间加回区间偏移（与台词同一坐标系：源素材秒）
        const offset = startSec
        motionByClip[cacheKey] = {
          ...curve,
          samples: curve.samples.map((sample) => ({ t: Number((sample.t + offset).toFixed(3)), energy: sample.energy })),
          valleys: curve.valleys.map((time) => Number((time + offset).toFixed(3))),
          peaks: curve.peaks.map((time) => Number((time + offset).toFixed(3))),
          stills: curve.stills.map((still) => ({ start: Number((still.start + offset).toFixed(3)), end: Number((still.end + offset).toFixed(3)), duration: still.duration })),
        }
        motionStats.push({ name: info.name, stills: curve.stills.length, samples: curve.samples.length, meanEnergy: curve.mean })
      } catch (error) {
        motionStats.push({ name: info.name, error: messageOf(error) })
      }
    }
    const cached = cache.clips[cacheKey] ?? cache.clips[`${item.id}:${info.clipId ?? ''}`]
    if (cached) transcriptsByClip[cacheKey] = cached.segments ?? []
  }

  const shots = scan.scenes.map((scene) => {
    const itemId = scene.itemId
    const item = itemsById.get(itemId)
    const cacheKey = scene.clipId ? `clip:${scene.clipId}` : item ? `item:${item.id}` : null
    const shotStart = scene.startSeconds
    const shotEnd = scene.endSeconds
    const transcript = (cacheKey && transcriptsByClip[cacheKey]) || []
    const motion = cacheKey ? motionByClip[cacheKey] : null
    return {
      index: scene.index,
      itemId,
      clipId: scene.clipId,
      name: scene.clipName,
      start: shotStart,
      end: shotEnd,
      duration: shotEnd - shotStart,
      recordStart: scene.recordStart,
      transcript,
      motion,
    }
  })

  const plan = story.planStoryEdit({
    shots,
    targetDuration: Number(args.targetDuration) || 40,
    options: {
      minShot: Number(args.minShot) || 1.0,
      maxShot: Number(args.maxShot) || 8,
      sentenceGap: Number(args.sentenceGap) || 0.45,
      fps,
    },
  })
  return {
    ok: true,
    dryRun: true,
    timelineName,
    trackIndex,
    shotCount: shots.length,
    transcriptSource: Object.values(cache.clips).length ? 'cache' : 'none',
    script: plan.script,
    scriptLines: plan.script.lines.length,
    edits: plan.edits,
    totalDuration: plan.totalDuration,
    diagnostics: plan.diagnostics,
    notes: plan.notes,
    motionStats,
    fps,
  }
}

/** 落地剧情剪辑：建一条新时间线（不动原时间线）。 */
async function opEditStory(ctx, args, signal) {
  const plan = args.plan
  if (!plan?.edits?.length) throw new Error('edit.story 需要 story.plan 的结果（plan.edits 不能为空）')
  const fps = Number(args.fps) || (await projectFps(ctx, signal))
  const name = String(args.name ?? `剧情剪辑 ${stamp()}`)

  // plan.edits 带 shotStartSec（该镜头在源素材的绝对起点）+ in/out（镜头内相对秒）
  let cursor = 0
  const clipInfos = []
  const mapped = []
  for (const edit of plan.edits) {
    if (!edit.clipId || !Number.isFinite(Number(edit.shotStartSec))) {
      mapped.push({ index: edit.index, skipped: true, reason: '缺少 clipId 或 shotStartSec' })
      continue
    }
    const startSec = Number(edit.shotStartSec) + Number(edit.in)
    const endSec = Number(edit.shotStartSec) + Number(edit.out)
    const startFrame = Math.max(0, Math.round(startSec * fps))
    const endFrame = Math.max(startFrame + 1, Math.round(endSec * fps))
    const durationFrames = endFrame - startFrame
    clipInfos.push({
      clip_id: edit.clipId,
      start_frame: startFrame,
      end_frame: endFrame,
      record_frame: cursor,
      track_index: 1,
    })
    mapped.push({ index: edit.index, kind: edit.kind, startFrame, endFrame, durationFrames, reason: edit.reason })
    cursor += durationFrames
  }
  if (clipInfos.length === 0) {
    return { ok: false, reason: '没有任何 edit 能换算成片段（story.plan 需要带 clipId / shotStartSec）', mapped }
  }
  const created = await callTool(ctx, 'media_pool', { action: 'create_timeline_from_clips', params: { name, clip_infos: clipInfos } }, signal)
  const createdName = created?.name ?? name
  const validate = await settle(callTool(ctx, 'timeline', { action: 'probe_timeline_structure', params: { track_types: ['video'] } }, signal))
  return {
    ok: created?.success !== false,
    timelineName: createdName,
    timelineId: created?.id ?? null,
    clipCount: clipInfos.length,
    sequenceFrames: cursor,
    durationSec: Number((cursor / fps).toFixed(2)),
    mapped,
    itemCount: validate.ok ? validate.value?.item_count ?? null : null,
    created,
  }
}

/**
 * 导出前检查：画幅是否有黑边、媒体与时间线的宽高比是否一致，并把选择权交给用户。
 */
async function opExportCheck(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const items = await listVideoItems(ctx, signal, Number(args.trackIndex) || 1)
  const resolution = await timelineResolution(ctx, signal)
  const timelineAspect = resolution.width / resolution.height
  const media = []
  for (const item of items.slice(0, Math.max(1, Number(args.limit) || items.length))) {
    const info = await clipSourceInfo(ctx, signal, item)
    if (!info.filePath) continue
    const size = await probeMediaSize(info.filePath)
    if (!size) continue
    const aspect = size.width / size.height
    media.push({
      name: info.name,
      width: size.width,
      height: size.height,
      aspect: Number(aspect.toFixed(4)),
      // 素材比时间线宽（如 1.90:1 放进 16:9）→ 上下黑边；比时间线窄 → 左右黑边
      barsPx: aspect > timelineAspect ? Math.round((resolution.height - resolution.width / aspect) / 2) : 0,
      pillarboxPx: aspect < timelineAspect ? Math.round((resolution.width - resolution.height * aspect) / 2) : 0,
    })
  }
  const withBars = media.filter((entry) => entry.barsPx > 2 || entry.pillarboxPx > 2)
  const options = [
    { id: 'keep-bars', label: '保留上下黑边（原始画幅，letterbox）' },
    { id: 'crop-fill', label: '裁掉黑边填满时间线（会略微裁掉左右/上下画面）' },
    { id: 'mask-239', label: '做 2.39:1 宽银幕遮幅（加更宽的黑边，更电影感）' },
  ]
  return {
    ok: true,
    resolution,
    timelineAspect: Number(timelineAspect.toFixed(4)),
    mediaInconsistency: withBars,
    hasBars: withBars.length > 0,
    question: withBars.length > 0
      ? {
          id: 'aspect',
          text: `素材宽高比 ${withBars[0].aspect} 与时间线 ${timelineAspect.toFixed(2)} 不一致，导出会有${withBars[0].barsPx ? '上下' : '左右'}黑边，请选择处理方式。`,
          options,
        }
      : null,
    note: withBars.length > 0 ? '导出前必须确认画幅处理方式，不要默默带着黑边导出。' : '画幅一致，无需处理。',
  }
}

/** 生成低码率预览片（H.264 mp4），返回可在面板内播放的 URL。 */
async function opPreviewRender(ctx, args, signal) {
  const name = String(args.name ?? `preview-${stamp()}`).replace(/[\/\\:*?"<>|]+/g, '_')
  const dir = await ensureDataDir('previews')
  const outPath = path.join(dir, `${name}.mp4`)
  const width = Math.max(320, Math.min(1920, Number(args.width) || 960))
  const height = Math.round((width * 9) / 16 / 2) * 2
  let previewPath = outPath
  previewState.renderInProgress = true
  let jobId = null
  let started = null
  let status = null
  try {
  const prepared = await settle(
    callTool(
      ctx,
      'render',
      {
        action: 'prepare_render_job',
        params: {
          target_dir: dir,
          custom_name: name,
          format: 'mp4',
          codec: 'H264',
          require_temp_target: false,
          settings: { ExportVideo: true, ExportAudio: true, ...(args.settings ?? {}) },
        },
      },
      signal,
    ),
  )
  jobId = prepared.ok ? prepared.value?.job_id ?? null : null
  if (!jobId) return { ok: false, error: prepared.ok ? '没有拿到 job_id' : messageOf(prepared.error), prepared: prepared.value ?? null }
  started = await settle(callTool(ctx, 'render', { action: 'start', params: { job_ids: [jobId] } }, signal))
  // 轮询（最多 args.waitSec 秒；预览片很短）
  const deadline = Date.now() + Math.min(600, Math.max(20, Number(args.waitSec) || 120)) * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const polled = await settle(callTool(ctx, 'render', { action: 'get_job_status', params: { job_id: jobId } }, signal))
    status = polled.ok ? polled.value : null
    if (status && /完成|Complete/i.test(String(status.JobStatus ?? ''))) break
  }
  // 渲染出的是项目分辨率；按请求宽度再缩一份小预览（否则面板里放 1080p 文件又慢又大）
  const renderedStat = await fs.stat(outPath).catch(() => null)
  if (renderedStat && renderedStat.size > 10240) {
    const scaledPath = path.join(dir, `${name}-${width}w.mp4`)
    try {
      await run('ffmpeg', ['-v', 'error', '-i', outPath, '-vf', `scale=${width}:-2`, '-c:v', 'libx264', '-crf', '24', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '96k', '-y', scaledPath], { timeoutMs: 300_000 })
      previewPath = scaledPath
    } catch {
      previewPath = outPath
    }
  }
  } finally {
    previewState.renderInProgress = false
  }
  const exists = await fs.stat(previewPath).catch(() => null)
  return {
    ok: Boolean(exists && exists.size > 10240),
    jobId,
    startResult: started.ok ? started.value : null,
    status,
    outPath: previewPath,
    fullPath: outPath,
    bytes: exists?.size ?? 0,
    url: `/davinci-panel/media?path=${encodeURIComponent(previewPath)}`,
    note: exists ? '预览片已生成，可在面板「预览」页直接播放' : '渲染未完成或文件过小，请稍后重试',
  }
}

// ---------------------------------------------------------------------------
// v6：声轨选条 + 人脸跟踪（面向对象调色）
// ---------------------------------------------------------------------------

/** 批量声轨体检：OK 条 / 废条（对白、底噪、削波、包络起伏）。 */
async function opAudioTakes(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const trackIndex = Math.max(1, Number(args.trackIndex) || 1)
  const items = await listVideoItems(ctx, signal, trackIndex)
  if (items.length === 0) throw new Error(`V${trackIndex} 上没有片段`)
  const limit = Math.min(items.length, Math.max(1, Number(args.limit) || items.length))
  const { analyseTake } = await importFresh('lib/audio_take.mjs')
  const results = []
  for (const item of items.slice(0, limit)) {
    const info = await clipSourceInfo(ctx, signal, item)
    if (!info.filePath) {
      results.push({ itemId: item.id, name: item.name, ok: false, error: '没有可读源文件' })
      continue
    }
    try {
      const analysis = await analyseTake(info.filePath, {
        startSec: (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps,
        durationSec: Math.max(0.2, info.duration / fps),
      })
      results.push({ itemId: item.id, name: item.name, verdict: analysis.verdict, score: analysis.score, reasons: analysis.reasons, speechRatio: analysis.speechRatio, activeRatio: analysis.activeRatio, variability: analysis.envelopeVariability, noiseFloorDb: analysis.noiseFloorDb, lufs: analysis.loudness?.lufs, truePeakDb: analysis.loudness?.truePeakDb, clippingRatio: analysis.clippingRatio })
    } catch (error) {
      results.push({ itemId: item.id, name: item.name, ok: false, error: messageOf(error) })
    }
  }
  const counts = results.reduce((acc, entry) => { const key = entry.verdict ?? 'error'; acc[key] = (acc[key] ?? 0) + 1; return acc }, {})
  return { ok: true, trackIndex, scanned: results.length, counts, results }
}

/**
 * 人脸/人体跟踪：抽帧 → Vision 检测 → 跨帧 IoU 跟踪 → 输出窗口建议。
 * 仅做「检测+跟踪+计划」；把窗口写进 Resolve 需要逐帧关键帧（API 无 AddNode/跟踪器），
 * 这一步留给面板/Fusion 消费。
 */
async function opFaceTrack(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  if (!info.filePath) throw new Error('片段没有可读源文件')
  const frameCount = Math.max(2, Math.min(16, Number(args.frames) || 6))
  const rangeStart = Number.isFinite(args.rangeStartSec) ? Number(args.rangeStartSec) : 0
  const rangeDuration = Number.isFinite(args.rangeEndSec)
    ? Math.max(0.2, Number(args.rangeEndSec) - rangeStart)
    : Math.max(0.2, info.duration / fps - rangeStart)
  const baseStart = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps + rangeStart
  const times = Array.from({ length: frameCount }, (_, index) => baseStart + (rangeDuration * (index + 0.5)) / frameCount)
  const dir = await ensureDataDir(path.join('frames', `face-${stamp()}`))
  const paths = await extractFramesAt(info.filePath, times, dir, 960)
  const { trackFaces, planFaceGrade } = await importFresh('lib/face.mjs')
  const frames = paths.map((framePath, index) => ({ t: times[index] ?? index, path: framePath }))
  const tracked = await trackFaces(frames)
  const plans = tracked.tracks.map((track) => ({ trackId: track.id, ...planFaceGrade(track) }))
  return {
    ok: true,
    itemId: item.id,
    itemName: info.name,
    frameCount,
    rangeStartSec: Number(rangeStart.toFixed(2)),
    rangeDurationSec: Number(rangeDuration.toFixed(2)),
    trackCount: tracked.trackCount,
    primary: tracked.primary,
    plans,
    frames: frames.map((frame) => ({ t: Number(frame.t.toFixed(2)), path: frame.path })),
    note: '检测+跟踪+窗口计划已完成；逐帧关键帧写入需要面板/Fusion（Resolve 脚本 API 没有 AddNode/跟踪器）',
  }
}

// ---------------------------------------------------------------------------
// v7：制作文档导入（剧本/分镜表/场记单）+ 跨镜头一致性 + 人脸窗口调色
// ---------------------------------------------------------------------------

function docsIndexPath() {
  return path.join(DATA_DIR, 'docs', 'index.json')
}

async function readDocsIndex() {
  try {
    const raw = JSON.parse(await fs.readFile(docsIndexPath(), 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/** 导入剧本 / 分镜表 / 场记单（纯文本、图片 OCR、xlsx、csv）。 */
async function opDocsImport(ctx, args, signal) {
  const kind = ['script', 'shotlist', 'continuity'].includes(args.kind) ? args.kind : 'script'
  const { readDocument } = await importFresh('lib/docs.mjs')
  let filePath = args.path ?? null
  if (!filePath && args.dataUrl) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(String(args.dataUrl))
    if (!match) throw new Error('dataUrl 格式不对（需要 data:<mime>;base64,<payload>）')
    const ext = (match[1].split('/')[1] ?? 'bin').replace('jpeg', 'jpg').replace('vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx')
    const dir = await ensureDataDir(path.join('docs', 'uploads'))
    filePath = path.join(dir, `${kind}-${stamp()}.${ext}`)
    await fs.writeFile(filePath, Buffer.from(match[2], 'base64'))
  }
  const parsed = await readDocument({ kind, path: filePath, text: args.text ?? null })
  const id = `${kind}-${stamp()}`
  const docDir = await ensureDataDir(path.join('docs', id))
  const docPath = path.join(docDir, 'parsed.json')
  await fs.writeFile(docPath, JSON.stringify(parsed, null, 2))
  const index = await readDocsIndex()
  const summary = {
    script: parsed.sceneCount != null ? `${parsed.sceneCount} 场 / ${parsed.dialogueCount} 句台词` : null,
    shotlist: parsed.shots ? `${parsed.shots.length} 个分镜` : null,
    continuity: parsed.entries ? `${parsed.entries.length} 条场记（OK ${parsed.okCount} / NG ${parsed.ngCount}）` : null,
  }[kind]
  const entry = {
    id,
    kind,
    at: new Date().toISOString(),
    sourceKind: parsed.sourceKind ?? null,
    sourcePath: parsed.sourcePath ?? null,
    summary,
    docPath,
    counts: { scenes: parsed.sceneCount ?? null, dialogue: parsed.dialogueCount ?? null, shots: parsed.shots?.length ?? null, entries: parsed.entries?.length ?? null },
  }
  index.unshift(entry)
  const indexPath = docsIndexPath()
  await fs.mkdir(path.dirname(indexPath), { recursive: true })
  await fs.writeFile(indexPath, JSON.stringify(index.slice(0, 50), null, 2))
  return { ok: true, entry, summary, preview: buildDocPreview(kind, parsed), parsed: args.returnParsed === false ? undefined : parsed }
}

function buildDocPreview(kind, parsed) {
  if (kind === 'script') {
    return (parsed.scenes ?? []).slice(0, 6).map((scene) => ({
      heading: scene.heading,
      dialogue: (scene.dialogue ?? []).slice(0, 4).map((line) => `${line.speaker}：${line.text}`),
    }))
  }
  if (kind === 'shotlist') return (parsed.shots ?? []).slice(0, 10)
  return (parsed.entries ?? []).slice(0, 10)
}

async function opDocsList(ctx, args, signal) {
  return { items: await readDocsIndex() }
}

async function opDocsGet(ctx, args, signal) {
  const index = await readDocsIndex()
  const entry = args.id ? index.find((item) => item.id === args.id) : index[0]
  if (!entry) throw new Error('没有找到文档')
  const parsed = JSON.parse(await fs.readFile(entry.docPath, 'utf8'))
  return { entry, parsed }
}

/** 跨镜头一致性：以 hero 镜头为基准，先归一再套风格，最后量化残差。 */
async function opGradeUnify(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const trackIndex = Math.max(1, Number(args.trackIndex) || 1)
  const items = await listVideoItems(ctx, signal, trackIndex)
  if (items.length === 0) throw new Error(`V${trackIndex} 上没有片段`)
  const limit = Math.min(items.length, Math.max(1, Number(args.limit) || items.length))
  const { statsFromAnalysis, buildConsistencyPlan, measureInconsistency } = await importFresh('lib/consistency.mjs')

  // 基准口径：默认用「渲染后的画面」（观众看到的、含已有 look）来量一致性；
  // 用源帧会让 look 前后不可比（实测 after 反而更差就是这个原因）。
  const basis = args.basis === 'source' ? 'source' : 'render'
  const samples = []
  for (const item of items.slice(0, limit)) {
    const seek = await seekToItem(ctx, signal, item.id)
    if (!seek.ok) continue
    let framePath = null
    try {
      if (basis === 'source') {
        const source = await exportSourceFrame(ctx, signal, item.id)
        framePath = source?.path ?? null
      } else {
        const captured = await captureRenderedFrame(ctx, signal, 'unify-before')
        framePath = captured.path
      }
    } catch {
      framePath = null
    }
    if (!framePath) continue
    let analysis = null
    try {
      analysis = await layersCli(['analyze', framePath])
    } catch {
      analysis = null
    }
    const stats = analysis ? statsFromAnalysis(analysis) : null
    samples.push({ item, framePath, stats })
  }
  if (samples.length < 2) throw new Error('可分析的镜头不足 2 个')
  const usable = samples.filter((sample) => sample.stats)
  const heroItemId = args.heroItemId ?? usable[0]?.item?.id ?? samples[0].item.id
  const hero = samples.find((sample) => sample.item.id === heroItemId) ?? samples[0]
  const before = measureInconsistency(usable.map((sample) => ({ id: sample.item.id, stats: sample.stats })))
  const plan = buildConsistencyPlan({ id: hero.item.id, stats: hero.stats }, usable.map((sample) => ({ id: sample.item.id, stats: sample.stats })))

  const applied = []
  for (const entry of plan.entries.filter((item) => item.ok)) {
    if (entry.id === hero.item.id) continue
    const sample = samples.find((item) => item.item.id === entry.id)
    if (!sample) continue
    const { gain, lift, gamma, warmth, saturation } = entry.corrections
    const cdl = {
      Slope: [gain * Math.exp(warmth), gain, gain * Math.exp(-warmth)],
      Offset: [lift, lift, lift],
      Power: [gamma, gamma, gamma],
      Saturation: saturation,
    }
    const node = cdlNode(`01 一致性 ${entry.id.slice(0, 6)}`, cdl, null, { withSaturation: false })
    node.params.saturation = Number((saturation * 50).toFixed(1))
    const dir = await ensureTempDir('drx')
    const drxPath = path.join(dir, `unify-${entry.id.slice(0, 8)}-${stamp()}.drx`)
    try {
      await callTool(ctx, 'drx', { action: 'generate', gradeParams: node.params, metadata: { label: node.label }, target: 'clip', outputPath: drxPath }, signal)
      const result = await applyDrxConfirmed(ctx, signal, { path: drxPath, source: 'item', require_temp_path: true, ...scopeOf(entry.id) })
      applied.push({ itemId: entry.id, ok: Boolean(result.applied.ok), corrections: entry.corrections, drxPath })
    } catch (error) {
      applied.push({ itemId: entry.id, ok: false, error: messageOf(error), corrections: entry.corrections })
    }
  }

  // 复查：再抽一次（这次是渲染后的帧）量残差
  const afterSamples = []
  for (const item of items.slice(0, limit)) {
    const seek = await seekToItem(ctx, signal, item.id)
    if (!seek.ok) continue
    try {
      const captured = await captureRenderedFrame(ctx, signal, 'unify-after')
      const analysis = await layersCli(['analyze', captured.path])
      const stats = statsFromAnalysis(analysis)
      if (stats) afterSamples.push({ id: item.id, stats })
    } catch {
      /* 单条失败不影响整体 */
    }
  }
  const after = afterSamples.length >= 2 ? measureInconsistency(afterSamples) : null
  return {
    ok: applied.some((item) => item.ok),
    heroItemId: hero.item.id,
    shots: samples.length,
    applied,
    basis,
    before,
    after,
    improved: Boolean(after && before && after.score < before.score),
    plan,
    note: '先按 hero 镜头归一曝光/黑位/白平衡，再统一套风格；after 是渲染后复查的残差',
  }
}

/** 由人脸框计算 Resolve 圆形窗口参数（UI 单位）。 */
function windowFromBox(box, frameWidth, frameHeight, options = {}) {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const pan = Math.min(100, Math.max(0, (cx / frameWidth) * 100))
  const tilt = Math.min(100, Math.max(0, 100 - (cy / frameHeight) * 100))
  // size：窗口边长相对画面的比例，映射到 0–100（50 ≈ 画面 40%）
  const ratio = Math.max(box.w / frameWidth, box.h / frameHeight)
  const size = Math.min(96, Math.max(4, (ratio / 0.4) * 50))
  const aspect = Math.min(100, Math.max(0, 50 + ((box.w / Math.max(1, box.h)) - 1) * 25))
  return {
    type: 1,
    pan: Number(pan.toFixed(1)),
    tilt: Number(tilt.toFixed(1)),
    size: Number(size.toFixed(1)),
    aspect: Number(aspect.toFixed(1)),
    soft1: Number((options.feather ?? 30).toFixed(1)),
    opacity: 100,
  }
}

/**
 * 人脸窗口调色：检测→跟踪→窗口→调色→验证。
 * 轨迹漂移过大时**拒绝**静默套静态窗口，改为输出逐帧关键帧文件（需要面板/Fusion 消费）。
 */
async function opFaceGrade(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  if (!info.filePath) throw new Error('片段没有可读源文件')
  const size = await probeMediaSize(info.filePath)
  if (!size) throw new Error('读不到素材尺寸')
  const frameCount = Math.max(2, Math.min(16, Number(args.frames) || 6))
  const rangeStart = Number.isFinite(args.rangeStartSec) ? Number(args.rangeStartSec) : 0
  const rangeDuration = Number.isFinite(args.rangeEndSec)
    ? Math.max(0.2, Number(args.rangeEndSec) - rangeStart)
    : Math.max(0.2, info.duration / fps - rangeStart)
  const baseStart = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps + rangeStart
  const times = Array.from({ length: frameCount }, (_, index) => baseStart + (rangeDuration * (index + 0.5)) / frameCount)
  const dir = await ensureDataDir(path.join('frames', `facegrade-${stamp()}`))
  const paths = await extractFramesAt(info.filePath, times, dir, 960)
  const { trackFaces, planFaceGrade } = await importFresh('lib/face.mjs')
  const tracked = await trackFaces(paths.map((framePath, index) => ({ t: times[index] ?? index, path: framePath })))
  if (!tracked.primary) return { ok: false, refused: true, reason: '没有检测到人脸', tracks: tracked.trackCount }
  const plan = planFaceGrade(tracked.primary)
  const frameWidth = 960
  const frameHeight = Math.round((960 * size.height) / size.width)
  // 960 宽抽帧与真实画面的比例（人脸框是抽帧像素）
  const scale = size.width / frameWidth
  const boxOnFrame = { x: tracked.primary.medianBox.x, y: tracked.primary.medianBox.y, w: tracked.primary.medianBox.w, h: tracked.primary.medianBox.h }
  const box = { x: boxOnFrame.x * scale, y: boxOnFrame.y * scale, w: boxOnFrame.w * scale, h: boxOnFrame.h * scale }
  const maxDrift = Number(args.maxDriftPx) || Math.max(20, size.width * 0.03)
  const driftScaled = (tracked.primary.driftPx ?? 0) * scale
  if (plan.mode === 'tracked-window' && driftScaled > maxDrift && !args.allowStatic) {
    // 拒绝静默降级：写出逐帧关键帧供面板/Fusion 消费
    const keyframeDir = await ensureDataDir(path.join('faces'))
    const keyframePath = path.join(keyframeDir, `face-${stamp()}.json`)
    const keyframes = tracked.primary.frames.map((frame) => ({
      t: Number(frame.t.toFixed(3)),
      pan: Number(((frame.smoothed.x + frame.smoothed.w / 2) / frameWidth * 100).toFixed(1)),
      tilt: Number((100 - ((frame.smoothed.y + frame.smoothed.h / 2) / frameHeight) * 100).toFixed(1)),
      size: Number((((Math.max(frame.smoothed.w / frameWidth, frame.smoothed.h / frameHeight)) / 0.4) * 50).toFixed(1)),
    }))
    await fs.writeFile(keyframePath, JSON.stringify({ itemId: item.id, itemName: info.name, driftPx: driftScaled, keyframes }, null, 2))
    return {
      ok: false,
      refused: true,
      reason: `人脸在 ${tracked.primary.frameCount} 帧里移动了 ${driftScaled.toFixed(0)}px（> ${maxDrift.toFixed(0)}px）：静态窗口会明显漏边，已拒绝。`,
      keyframePath,
      keyframes,
      plan,
      note: '逐帧关键帧已写出；Resolve 脚本 API 没有跟踪器，需面板/Fusion 消费。传 allowStatic:true 可强制静态窗口。',
    }
  }
  const windowParams = windowFromBox(box, size.width, size.height, { feather: args.feather ?? 35 })
  const strength = Number.isFinite(args.strength) ? Number(args.strength) : 1
  const gainMaster = 1 + 0.02 * strength
  const saturation = 50 + 4 * strength
  const node = cdlNode('01 人脸窗口', { Slope: [1, 1, 1], Offset: [0.004 * strength, 0.004 * strength, 0.004 * strength], Power: [1, 1, 1], Saturation: 1 }, { window: windowParams })
  node.params.saturation = Number(saturation.toFixed(1))
  node.params.gain = { r: 1, g: 1, b: 1, master: Number(gainMaster.toFixed(3)) }

  // 应用前后各抓一帧，用「肤色层」统计验证是否真的作用在脸上
  const beforeCapture = await captureRenderedFrame(ctx, signal, 'face-before')
  const dirDrx = await ensureTempDir('drx')
  const drxPath = path.join(dirDrx, `face-window-${stamp()}.drx`)
  // 注意：1→1 节点的同结构 apply 会被 Resolve 静默忽略，所以先建 base 再 merge，
  // 保证节点数发生变化（实测 1→2 才会真的落地）。
  const basePath = path.join(dirDrx, `face-window-base-${stamp()}.drx`)
  await callTool(ctx, 'drx', { action: 'generate', gradeParams: { space: 'ui' }, metadata: { label: '00 恒等' }, target: 'clip', outputPath: basePath }, signal)
  await callTool(ctx, 'drx', { action: 'merge', basePath, newNodes: [{ label: node.label, params: node.params }], outputPath: drxPath }, signal)
  const applied = await applyDrxConfirmed(ctx, signal, { path: drxPath, source: 'item', require_temp_path: true, ...scopeOf(item.id) })
  const afterCapture = await captureRenderedFrame(ctx, signal, 'face-after')
  const analyzeSkin = async (framePath) => {
    try {
      const analysis = await layersCli(['analyze', framePath])
      const skin = analysis?.layers?.skin ?? null
      return skin ? { coverage: skin.coverage, luma: skin.meanLuma, sat: skin.meanSat, huePercent: skin.meanHuePercent ?? null, hue: skin.meanHue ?? null } : null
    } catch {
      return null
    }
  }
  const skinBefore = await analyzeSkin(beforeCapture.path)
  let skinAfter = await analyzeSkin(afterCapture.path)
  // 窗口节点在本机可能「写入成功但不渲染」（实测 delta≈0）；一旦测到没渲染，就走
  // 「肤色 qualifier」回退——qualifier 是实测能渲染的键控路径，不需要窗口。
  let rendered = skinBefore && skinAfter ? Math.abs(skinAfter.luma - skinBefore.luma) > 0.002 || Math.abs(skinAfter.coverage - skinBefore.coverage) > 0.05 : null
  let fallback = null
  if (rendered === false && args.allowSkinFallback !== false) {
    const skinHue = skinBefore && Number.isFinite(skinBefore.huePercent) ? skinBefore.huePercent : null
    const fallbackNode = cdlNode('01 人脸·肤色键回退', { Slope: [1, 1, 1], Offset: [0.004 * strength, 0.004 * strength, 0.004 * strength], Power: [1, 1, 1], Saturation: 1 }, {
      qualifier: {
        hueCenter: Math.min(100, Math.max(0, skinHue ?? 6)),
        hueWidth: 22,
        hueSoft: 11,
        hueSymmetry: 50,
        satLow: 12,
        satHigh: 88,
        satLowSoft: 6,
        satHighSoft: 8,
        lumLow: 18,
        lumHigh: 88,
        lumLowSoft: 8,
        lumHighSoft: 8,
      },
      matteFinesse: { denoise: 5, blackClip: 3, whiteClip: 3, blur: 3 },
    })
    fallbackNode.params.saturation = Number((50 + 4 * strength).toFixed(1))
    const fbPath = path.join(dirDrx, `face-skin-fallback-${stamp()}.drx`)
    const fbBase = path.join(dirDrx, `face-skin-base-${stamp()}.drx`)
    try {
      await callTool(ctx, 'drx', { action: 'generate', gradeParams: { space: 'ui' }, metadata: { label: '00 恒等' }, target: 'clip', outputPath: fbBase }, signal)
      await callTool(ctx, 'drx', { action: 'merge', fbBase, newNodes: [{ label: fallbackNode.label, params: fallbackNode.params }], outputPath: fbPath }, signal)
      const fbApply = await applyDrxConfirmed(ctx, signal, { path: fbPath, source: 'item', require_temp_path: true, ...scopeOf(item.id) })
      const fbCapture = await captureRenderedFrame(ctx, signal, 'face-fallback-after')
      const fbSkin = await analyzeSkin(fbCapture.path)
      fallback = {
        applied: Boolean(fbApply.applied.ok),
        drxPath: fbPath,
        skinBefore,
        skinAfter: fbSkin,
        skinLumaDelta: fbSkin && skinBefore ? Number((fbSkin.luma - skinBefore.luma).toFixed(4)) : null,
        rendered: fbSkin && skinBefore ? Math.abs(fbSkin.luma - skinBefore.luma) > 0.002 : null,
      }
      if (fbSkin) skinAfter = fbSkin
      if (fallback.rendered) rendered = true
    } catch (error) {
      fallback = { applied: false, error: messageOf(error) }
    }
  }
  const nodes = await settle(callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scopeOf(item.id) }, signal))
  return {
    ok: Boolean(applied.applied.ok),
    itemId: item.id,
    itemName: info.name,
    mode: plan.mode,
    window: windowParams,
    driftPx: Number(driftScaled.toFixed(1)),
    applied: applied.applied.value ?? null,
    error: applied.applied.ok ? null : applied.applied.error,
    nodeCount: nodes.ok ? nodes.value?.num_nodes ?? null : null,
    rendered,
    fallback,
    verification: {
      skinBefore,
      skinAfter,
      skinLumaDelta: skinBefore && skinAfter ? Number((skinAfter.luma - skinBefore.luma).toFixed(4)) : null,
      note: rendered
        ? '窗口/肤色键作用已由肤色层统计变化确认'
        : '窗口节点写入成功但画面没变化（本机 beta 已知问题）；已尝试肤色 qualifier 回退，仍无变化则说明该节点不渲染',
    },
    plan,
  }
}

// ---------------------------------------------------------------------------
// v8：三层 10+ 节点调色图（一个节点一个工具）
// ---------------------------------------------------------------------------

/**
 * 建三层节点图并落地：
 *   L1 校正/还原/统一 → L2 调色/偏移 → L3 动态遮罩/风格/特效（风格 LUT 挂独立节点）
 * 每个节点只放一个工具（参数族不混），出问题能单独定位到哪一层哪一步。
 */
/**
 * 用户每次提出新想法 → 重建**整条时间线**的调色图（含 LOG→709 输入还原），
 * 不做增量修改，避免旧节点残留导致画面错。
 */
/** 工程预检：项目设置 + 色彩管线 + 丢失素材 + 渲染就绪度（每次接活先跑）。 */
/** 调色图报告：逐个节点说明「它到底做了什么」，并给出实测依据/无效标记，不编造。 */
async function opGradeNodeReport(ctx, args, signal) {
  const { buildThreeLayerGraph } = await importFresh('lib/nodegraph.mjs')
  const graph = buildThreeLayerGraph({
    consistency: { gain: 1.02, lift: 0.01, gamma: 1.03, warmth: 1.02, saturation: 1.02 },
    look: { preset: String(args.lookPreset ?? 'love-letter'), strength: Number(args.lookStrength) || 0.5 },
    shot: {},
    texture: { halation: { strength: 0.2 }, glow: { strength: 0.1 }, grain: { amount: 8 } },
  })
  const probe = await settle(callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scopeOf(args.itemId) }, signal))
  const liveNodes = (probe.ok ? probe.value?.nodes : []) ?? []
  const rows = graph.nodes.map((spec, index) => {
    const live = liveNodes[index] ?? null
    const tools = live?.tools ?? []
    const label = live?.label ?? spec.label
    const lut = live?.lut ?? null
    return {
      index: index + 1,
      layer: spec.layer,
      label,
      purpose: spec.note,
      tool: spec.tool,
      liveTool: tools.length ? tools.join('+') : null,
      lut,
      readsBack: Boolean(live),
      note: spec.tool === 'input' ? '输入节点（还原起点）；LOG 还原由外部 LUT/RCM 提供，本节点自身不做变换'
        : spec.tool === 'lookLut' ? (lut ? `风格 LUT 已挂 ${lut}` : '风格 LUT 节点（未挂 LUT 时无作用——请在报告里视为无效）')
        : '按 spec 参数生效',
    }
  })
  const effective = rows.filter((row) => row.tool !== 'input' && row.tool !== 'lookLut')
  const styleRow = rows.find((row) => row.tool === 'lookLut')
  return {
    ok: true,
    itemId: args.itemId,
    nodeCount: graph.nodeCount,
    liveNodeCount: liveNodes.length,
    consistent: liveNodes.length === graph.nodeCount,
    rows,
    effectiveCount: effective.length + (styleRow?.lut ? 1 : 0),
    markdown: [
      '| # | 层 | 节点 | 工具 | 实际作用 |',
      '|---|---|---|---|---|',
      ...rows.map((row) => `| ${row.index} | ${row.layer} | ${row.label} | ${row.tool} | ${row.note} |`),
    ].join('\n'),
    caveat: '本报告的作用来自 spec 与 Resolve 节点读回（工具/标签/LUT）；逐节点开关的渲染差分未在默认模式下测（deep:true 可逐节点测，成本高）。',
  }
}

/** 依赖自检：Resolve MCP / ffmpeg / Resolve 应用是否就绪（首次打开面板就提示）。 */
async function opDepsCheck(ctx, args, signal) {
  const which = (bin) => new Promise((resolve) => {
    execFile('/usr/bin/env', ['which', bin], { timeout: 5000 }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null))
  })
  const [ffmpeg, ffprobe] = await Promise.all([which('ffmpeg'), which('ffprobe')])
  let mcp = { ok: false, error: null }
  try {
    const version = await settle(callTool(ctx, 'resolve_control', { action: 'get_version' }, signal))
    mcp = version.ok ? { ok: true, version: version.value?.version_string ?? null } : { ok: false, error: messageOf(version.error) }
  } catch (error) { mcp = { ok: false, error: messageOf(error) } }
  const appCandidates = ['/Applications/DaVinci Resolve/DaVinci Resolve.app', '/Applications/DaVinci Resolve.app']
  const resolveApp = appCandidates.find((candidate) => { try { return existsSync(candidate) } catch { return false } }) ?? null
  return {
    ok: Boolean(mcp.ok && ffmpeg && resolveApp),
    platform: process.platform,
    mcp,
    resolveApp,
    binaries: { ffmpeg, ffprobe },
    hints: [
      ...(mcp.ok ? [] : ['未连上 Resolve MCP：先在 DSH 里启用 davinci-resolve MCP，并确保 DaVinci Resolve 正在运行']),
      ...(ffmpeg ? [] : ['缺少 ffmpeg：brew install ffmpeg（分析/抽帧/导出会用到）']),
      ...(resolveApp ? [] : ['未找到 DaVinci Resolve.app：请安装 DaVinci Resolve Studio']),
      ...(process.platform === 'darwin' ? [] : ['当前平台非 macOS：本 DEMO 仅支持 macOS']),
    ],
  }
}

async function opPreflightCheck(ctx, args, signal) {
  const snapshot = await opPipelineSnapshot(ctx, {}, signal)
  const diagnosis = diagnosePipeline(snapshot)
  const structure = await settle(callTool(ctx, 'timeline', { action: 'probe_timeline_structure', track_types: ['video', 'audio'] }, signal))
  const missing = []
  let itemCount = 0
  const timelineReadable = Boolean(structure.ok && structure.value)
  // 音视频轨都检查：独立音轨上的离线素材同样会导致渲染失败
  for (const type of ['video', 'audio']) {
    const tracks = structure.ok ? structure.value?.tracks?.[type]?.tracks ?? [] : []
    for (const track of tracks) {
      for (const item of track.items ?? []) {
        itemCount += 1
        if (item.file_exists === false || item.media_status === 'Offline') {
          missing.push({ trackType: type, name: item.name, path: item.file_path ?? null, status: item.media_status ?? 'Offline' })
        }
      }
    }
  }
  const blockedReasons = []
  if (!timelineReadable) blockedReasons.push('读不到时间线结构（没有打开时间线，或 MCP 调用失败）')
  if (timelineReadable && itemCount === 0) blockedReasons.push('时间线上没有可渲染的片段')
  if (missing.length) blockedReasons.push(`${missing.length} 条素材离线/丢失`)
  const ok = timelineReadable && itemCount > 0 && missing.length === 0
  const settings = snapshot.settings?.value?.settings ?? snapshot.settings?.value ?? {}
  return {
    ok,
    blocked: !ok,
    blockedReasons,
    timelineReadable,
    project: { name: snapshot.project?.name ?? null, science: settings.colorScienceMode ?? null, timeline: settings.colorSpaceTimeline ?? null, output: settings.colorSpaceOutput ?? null, resolution: settings.timelineResolutionWidth ? `${settings.timelineResolutionWidth}x${settings.timelineResolutionHeight}` : null, fps: settings.timelineFrameRate ?? null },
    pipeline: { ok: (diagnosis.findings ?? []).length === 0, findings: (diagnosis.findings ?? []).map((item) => ({ id: item.id, title: item.title, fixable: Boolean(item.recommended) })) },
    timeline: { name: structure.ok ? structure.value?.name ?? null : null, items: itemCount, readable: timelineReadable },
    missingMedia: missing,
    renderReady: ok,
    note: blockedReasons.length ? `预检未通过：${blockedReasons.join('；')}` : '素材在线，可以进入调色/渲染',
  }
}

/** 一键应用风格（大师风格库）：ARRI/LOG 还原 + 三层图 + 风格 LUT + 黑白柔。 */
async function opStyleOneClick(ctx, args, signal) {
  if (args.ignorePreflight !== true) {
    const preflight = await opPreflightCheck(ctx, {}, signal)
    if (!preflight.ok) return { ok: false, blocked: true, preflight, error: `预检未通过：${preflight.missingMedia.length} 条素材离线，先重链` }
  }
  const { findStyle } = await importFresh('lib/stylelib.mjs')
  const style = findStyle(String(args.preset ?? ''))
  if (!style) throw new Error('未知风格；先调 style.catalog 看列表')
  const structure = await settle(callTool(ctx, 'timeline', { action: 'probe_timeline_structure', track_types: ['video'] }, signal))
  const items = []
  for (const track of structure.ok ? structure.value?.tracks?.video?.tracks ?? [] : []) for (const item of track.items ?? []) items.push(item.timeline_item_id)
  if (!items.length) throw new Error('当前时间线没有视频片段')
  debugPush({ stage: '风格', message: `一键风格「${style.label}」开始：${style.techniques.join(' / ')}（出处：${style.sources.join(' , ')}）` })
  const results = []
  for (const itemId of items) {
    // ① 还原：走 restore.resolve（灰片→机型/曲线→官方 LUT），不按品牌猜
    let restore = null
    try {
      const resolved = args.lutPath
        ? { needsRestore: true, lut: { path: String(args.lutPath) } }
        : await opRestoreResolve(ctx, { itemId }, signal)
      if (resolved.needsRestore === false) restore = { ok: true, note: '素材已是彩色，无需还原' }
      else if (resolved.needsChoice) return { ok: false, needsChoice: true, restore: resolved, message: '库里同曲线有多条 LUT，请先在「还原」卡片里选一条再应用风格' }
      else if (resolved.needsLut) return { ok: false, needsLut: true, restore: resolved, message: resolved.message }
      else if (resolved.lut?.path) {
        const applied = await opRestoreApply(ctx, { itemId, lutPath: resolved.lut.path }, signal)
        restore = { ok: Boolean(applied.ok), lutPath: resolved.lut.path, lutName: resolved.lut.name ?? path.basename(String(resolved.lut.path)) }
      }
    } catch (error) { restore = { ok: false, error: messageOf(error) } }
    // ② 风格：三层 15 节点，按配方改参数（不是套 LUT）
    const built = await opGradeBuild3(ctx, { itemId, lookPreset: style.key, lookStrength: 0, styleStrength: 0.95, recipe: style.recipe, skipStyleLut: true }, signal).catch((error) => ({ ok: false, error: messageOf(error) }))
    // build3 重建会清掉节点上的 LUT：用**同一份** lutPath 在 build 之后补挂，失败就标失败（不再假装成功）
    if (restore?.lutPath) {
      try {
        const reapplied = await opRestoreApply(ctx, { itemId, lutPath: restore.lutPath }, signal)
        restore = { ...restore, ok: Boolean(reapplied.ok), reapplied: Boolean(reapplied.ok) }
      } catch (error) {
        restore = { ...restore, ok: false, error: messageOf(error) }
      }
    }
    // ③ 可选：胶片模拟 LUT（仅当风格明确指定，且用 DaVinci 自带 Film Looks）
    let filmLut = null
    if (style.filmLut) {
      const staged = await settle(callTool(ctx, 'lut', { action: 'install', name: `style-${style.key}`, source_path: style.filmLut, overwrite: true }, signal))
      if (staged.ok) {
        filmLut = await settle(callTool(ctx, 'graph', { action: 'set_lut', node_index: built?.drxNodes?.lookNodeIndex ?? 14, lut_path: staged.value?.set_lut_path ?? style.filmLut, source: 'item', ...scopeOf(itemId) }, signal))
      }
    }
    // ④ 可选：柔光（只有风格需要才加）
    const mist = style.mist ? await opTextureMist(ctx, { itemId, mode: style.mist.mode, strength: style.mist.strength }, signal).catch(() => ({ ok: false })) : null
    results.push({ itemId, restore: Boolean(restore?.ok), restoreLut: restore?.lutPath ? path.basename(String(restore.lutPath)) : null, restoreError: restore?.error ?? null, grade: Boolean(built?.ok), nodes: built?.nodeGraph?.num_nodes ?? null, filmLut: Boolean(filmLut?.ok), mist: mist ? Boolean(mist.ok) : null })
  }
  debugPush({ stage: '风格', message: `风格「${style.label}」完成：${results.filter((item) => item.grade).length}/${results.length} 条（还原：${results.filter((i) => i.restore).length} 条；风格 LUT：${style.filmLut ? '用' : '不用'}；柔光：${style.mist ? style.mist.mode : '不用'}）` })
  const succeeded = results.filter((item) => item.grade && item.restore)
  return {
    ok: results.length > 0 && succeeded.length === results.length,
    style: { key: style.key, label: style.label, sources: style.sources, techniques: style.techniques },
    applied: succeeded.length,
    failed: results.filter((item) => !(item.grade && item.restore)).map((item) => ({ itemId: item.itemId, grade: item.grade, restore: item.restore, restoreError: item.restoreError })),
    total: results.length,
    results,
    note: '风格 = 影调+色彩分离+局部+质感；LUT/柔光只在风格配方要求时使用；还原按机型单独处理',
  }
}

/** 交付：两段式——先生成方案；确认时校验项目/时间线、规格落地、令牌一次性。 */
const DELIVERY_PLANS = new Map()

async function currentProjectTimeline(ctx, signal) {
  const [project, timeline] = await Promise.all([
    settle(callTool(ctx, 'project_manager', { action: 'get_current' }, signal)),
    settle(callTool(ctx, 'timeline', { action: 'get_current' }, signal)),
  ])
  return {
    project: project.ok ? (project.value?.name ?? null) : null,
    timeline: timeline.ok ? (timeline.value?.name ?? null) : null,
    timelineId: timeline.ok ? (timeline.value?.id ?? null) : null,
  }
}

/** 容器/编码映射：容器按用户选择走（mov/mp4 都支持），编码默认 H.264，H.265/ProRes 显式选择。 */
function resolveDeliveryFormat(container, codecArg) {
  const fmt = ['mov', 'mp4'].includes(String(container).toLowerCase()) ? String(container).toLowerCase() : 'mp4'
  const key = String(codecArg ?? '').toLowerCase()
  if (key.includes('prores')) return { format: 'mov', codec: 'ProRes 422 HQ' }
  if (key.includes('265') || key.includes('hevc')) return { format: fmt, codec: 'H.265' }
  return { format: fmt, codec: 'H.264' }
}

async function opRenderDeliver(ctx, args, signal) {
  const width = Math.max(320, Math.min(8192, Number(args.width) || 1920))
  const height = Math.max(180, Math.min(4320, Number(args.height) || 1080))
  const fps = Math.max(1, Math.min(120, Number(args.fps) || 24))
  const bitrateMbps = Math.max(1, Math.min(500, Number(args.bitrateMbps) || 20))
  const container = String(args.container ?? 'mp4').toLowerCase()
  const mapped = resolveDeliveryFormat(container, args.codec)
  const targetDir = String(args.targetDir ?? path.join(os.homedir(), 'Desktop', '交付'))

  // ---------- 第一段：生成方案（不渲染，不写项目设置） ----------
  if (!args.confirmToken) {
    const preflight = await opPreflightCheck(ctx, {}, signal)
    if (!preflight.ok) {
      return { ok: false, blocked: true, preflight, error: `预检未通过，不能进入交付：${(preflight.blockedReasons ?? []).join('；') || '时间线不可用'}` }
    }
    const scope = await currentProjectTimeline(ctx, signal)
    const token = `deliver-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    DELIVERY_PLANS.set(token, {
      width, height, fps, bitrateMbps, container: mapped.format, format: mapped.format, codec: mapped.codec,
      targetDir, scope, at: Date.now(),
    })
    return {
      ok: true,
      approvalRequired: true,
      confirmToken: token,
      plan: { width, height, fps, bitrateMbps, container, codec: mapped.codec, format: mapped.format, targetDir, project: scope.project, timeline: scope.timeline },
      message: `交付方案：${width}x${height} / ${fps}fps / ${bitrateMbps}Mbps / ${mapped.format.toUpperCase()} ${mapped.codec} → ${targetDir}；确认后才会渲染`,
    }
  }

  // ---------- 第二段：确认并渲染（令牌一次性 + 绑定项目/时间线） ----------
  const token = String(args.confirmToken)
  const plan = DELIVERY_PLANS.get(token)
  if (!plan) return { ok: false, error: '确认令牌无效或已使用/过期：请重新生成交付方案' }
  DELIVERY_PLANS.delete(token) // 一次性：先消费，后续任何失败都不允许重放

  const nowScope = await currentProjectTimeline(ctx, signal)
  if (!plan.scope?.project || !nowScope.project || plan.scope.project !== nowScope.project) {
    return { ok: false, error: `确认令牌与当前项目不匹配（方案项目：${plan.scope?.project ?? '未知'}，当前：${nowScope.project ?? '未知'}）；请重新生成方案`, plan }
  }
  // 时间线按 id 比较（名称相同的两条时间线不能串用令牌），没有 id 时才回退到名称
  const timelineSame = plan.scope?.timelineId && nowScope.timelineId
    ? plan.scope.timelineId === nowScope.timelineId
    : plan.scope?.timeline && nowScope.timeline && plan.scope.timeline === nowScope.timeline
  if (!timelineSame) {
    return { ok: false, error: `确认令牌与当前时间线不匹配（方案：${plan.scope?.timeline ?? '未知'}#${plan.scope?.timelineId ?? '-'}，当前：${nowScope.timeline ?? '未知'}#${nowScope.timelineId ?? '-'}）；请重新生成方案`, plan }
  }
  const preflight = await opPreflightCheck(ctx, {}, signal)
  if (!preflight.ok) {
    return { ok: false, blocked: true, preflight, plan, error: `确认时预检未通过：${(preflight.blockedReasons ?? []).join('；')}` }
  }
  await fs.mkdir(plan.targetDir, { recursive: true }).catch(() => null)

  const requested = { width: plan.width, height: plan.height, fps: plan.fps, format: plan.format, codec: plan.codec, bitrateMbps: plan.bitrateMbps }
  const settings = { ExportVideo: true, ExportAudio: true, ...(plan.bitrateMbps ? { VideoQuality: plan.bitrateMbps } : {}) }

  const prepareJob = async () => {
    const prepared = await settle(callTool(ctx, 'render', {
      action: 'prepare_render_job',
      target_dir: plan.targetDir,
      format: plan.format,
      codec: plan.codec,
      custom_name: `交付_${plan.width}x${plan.height}_${plan.fps}fps_${plan.bitrateMbps}Mbps`,
      settings,
      require_temp_target: false,
    }, signal))
    return { prepared, jobId: prepared.ok ? (prepared.value?.job_id ?? null) : null }
  }
  const readJob = async (jobId) => {
    const listed = await settle(callTool(ctx, 'render', { action: 'list_jobs' }, signal))
    const jobs = listed.ok ? (listed.value?.jobs ?? []) : []
    return jobs.find((job) => job.JobId === jobId) ?? null
  }
  const jobSpecOf = (job) => job ? ({
    format: job.VideoFormat ?? null,
    codec: job.VideoCodec ?? null,
    width: Number(job.FormatWidth) || null,
    height: Number(job.FormatHeight) || null,
    fps: job.FrameRate != null ? String(job.FrameRate) : null,
  }) : null
  const { parseDeleteResult, valuesEqual, specMatches, summarizeRestore } = await importFresh('lib/delivery_rules.mjs')
  const specOk = (spec) => specMatches(spec, plan)
  const deleteJob = async (jobId) => {
    if (!jobId) return { ok: false, skipped: true, error: '没有 job_id' }
    const r = await settle(callTool(ctx, 'render', { action: 'delete_job', job_id: jobId }, signal))
    const parsed = parseDeleteResult(r.ok ? r.value : null)
    const del = { ok: Boolean(r.ok && parsed.ok), raw: parsed.raw, error: r.ok ? (parsed.reason ?? null) : messageOf(r.error) }
    if (!del.ok) debugPush({ stage: '交付', message: `删除渲染任务失败（job ${jobId}）：${del.error ?? '返回未确认成功'}` })
    return del
  }

  // ① 先按渲染任务建一次，看任务读回是否已符合方案（能不动项目就不动项目）
  let { prepared, jobId } = await prepareJob()
  if (!prepared.ok) return { ok: false, plan, requested, error: `创建渲染任务失败：${messageOf(prepared.error)}` }
  if (!jobId) return { ok: false, plan, requested, error: '创建渲染任务没有返回 job_id，已中止（未调用启动）' }
  let job = await readJob(jobId)
  let spec = jobSpecOf(job)
  let writes = []
  let projectChanged = false
  const oldValues = {}
  const readSetting = async (name) => {
    const r = await settle(callTool(ctx, 'project_settings', { action: 'get_setting', name }, signal))
    return r.ok ? r.value?.settings ?? null : null
  }
  const restoreProject = async () => {
    const changedBefore = projectChanged
    if (!changedBefore) return { ...summarizeRestore(false, []), details: [] }
    const details = []
    for (const [name, value] of Object.entries(oldValues)) {
      if (value == null) { details.push({ name, expected: null, actual: await readSetting(name), ok: false }); continue }
      const r = await settle(callTool(ctx, 'project_settings', { action: 'set_setting', name, value }, signal))
      const actual = await readSetting(name)
      details.push({ name, expected: value, actual, ok: Boolean(r.ok && r.value?.success !== false && valuesEqual(name, value, actual)) })
    }
    projectChanged = false
    const summary = summarizeRestore(changedBefore, details)
    if (summary.state === 'partial') debugPush({ stage: '交付', message: summary.message })
    return summary
  }

  // ② 任务规格不符 → 保存旧项目值、改项目、重新建任务再核对；任何一步失败都恢复旧值且不启动
  if (!specOk(spec)) {
    for (const name of ['timelineResolutionWidth', 'timelineResolutionHeight', 'timelineFrameRate']) oldValues[name] = await readSetting(name)
    const unknown = Object.entries(oldValues).filter(([, value]) => value == null).map(([name]) => name)
    if (unknown.length) {
      const del = await deleteJob(jobId)
      return { ok: false, plan, requested, spec, jobId, deleteJob: del, error: `读不到原项目设置（${unknown.join('、')}），为避免改坏工程已中止；${del.ok ? '任务已删除' : '任务删除失败，仍留在队列（job ' + jobId + '），请手动检查'}` }
    }
    // 首个任务删除未确认成功 → 立即停止交付（不改项目、不再建任务、不启动）
    const delFirst = await deleteJob(jobId)
    if (!delFirst.ok) {
      return { ok: false, plan, requested, spec, jobId, deleteJob: delFirst, error: `首个渲染任务规格不符，且删除未确认成功（job ${jobId} 可能仍在队列），已停止交付；未修改项目设置、未创建新任务、未启动渲染` }
    }
    const applied = []
    for (const [name, value] of [['timelineResolutionWidth', String(plan.width)], ['timelineResolutionHeight', String(plan.height)], ['timelineFrameRate', String(plan.fps)]]) {
      projectChanged = true
      const r = await settle(callTool(ctx, 'project_settings', { action: 'set_setting', name, value }, signal))
      const actual = await readSetting(name)
      applied.push({ name, expected: value, actual, ok: Boolean(r.ok && r.value?.success !== false && valuesEqual(name, value, actual)) })
      if (!applied[applied.length - 1].ok) {
        const restore = await restoreProject()
        return { ok: false, plan, requested, writes: applied, spec, restore, error: `项目设置未能按方案落地（${name}: ${actual ?? '写入失败'}），已中止；${restore.message}` }
      }
    }
    writes = applied
    const second = await prepareJob()
    if (!second.prepared.ok) {
      const restore = await restoreProject()
      return { ok: false, plan, requested, writes, spec, restore, error: `改用项目设置后重建渲染任务失败：${messageOf(second.prepared.error)}；${restore.message}` }
    }
    if (!second.jobId) {
      const restore = await restoreProject()
      return { ok: false, plan, requested, writes, restore, error: `重建渲染任务没有返回 job_id，已中止；${restore.message}` }
    }
    jobId = second.jobId
    job = await readJob(jobId)
    spec = jobSpecOf(job)
  }

  const specMismatch = !specOk(spec)
  if (specMismatch) {
    const del = await deleteJob(jobId)
    const restore = await restoreProject()
    return { ok: false, plan, requested, writes, spec, specMismatch: true, restore, deleteJob: del, error: `渲染任务规格与方案不一致（任务：${JSON.stringify(spec)}），未启动渲染；${del.ok ? '任务已删除' : '任务删除失败，仍留在队列（job ' + jobId + '）'}；${restore.message}` }
  }

  // ③ 只有「拿到 job_id + 规格核对通过」才允许启动
  const started = await settle(callTool(ctx, 'render', { action: 'start', job_ids: [jobId] }, signal))
  const startValue = started.ok ? started.value : null
  const startedOk = Boolean(
    started.ok && (
      startValue === true ||
      (startValue && typeof startValue === 'object' && startValue.success === true)
    ),
  )
  if (!startedOk) {
    const del = await deleteJob(jobId)
    const restore = await restoreProject()
    const reason = startValue === false ? '渲染后端明确返回 false' : (messageOf(started.error) || `启动结果异常：${JSON.stringify(startValue)}`)
    return { ok: false, plan, requested, writes, spec, jobId, deleteJob: del, restore, error: `渲染任务启动失败（${reason}）；${del.ok ? '任务已删除' : '任务删除失败，仍留在队列（job ' + jobId + '）'}；${restore.message}` }
  }
  debugPush({ stage: '交付', message: `已按方案创建、核对并启动渲染任务：${jobId}（${plan.format} ${plan.codec} ${plan.width}x${plan.height} ${plan.fps}fps ${plan.bitrateMbps}Mbps）` })
  return {
    ok: true,
    plan,
    requested,
    writes,
    jobId,
    spec,
    specMismatch: false,
    started: started.value ?? null,
    note: projectChanged ? '规格通过项目设置落地；任务读回与方案一致后才启动' : '任务读回与方案一致，未改动项目设置',
  }
}

/** Resolve 后台运行：把窗口隐藏，不占用前台（脚本仍可用）。 */
async function opResolveBackground(ctx, args, signal) {
  const outcome = await new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "System Events" to set visible of (first process whose name contains "Resolve") to false'], { timeout: 20000 }, (error, stdout, stderr) => resolve({ ok: !error, error: error ? String(stderr || error) : null }))
  })
  return { ...outcome, note: 'Resolve 窗口已隐藏；MCP 脚本调用不受影响' }
}

async function opGradeRebuildAll(ctx, args, signal) {
  const items = await new Promise((resolve) => resolve(null))
  const timeline = await settle(callTool(ctx, 'timeline', { action: 'probe_timeline_structure', track_types: ['video'] }, signal))
  const list = []
  for (const track of timeline.ok ? timeline.value?.tracks?.video?.tracks ?? [] : []) {
    for (const item of track.items ?? []) list.push({ id: item.timeline_item_id, name: item.name })
  }
  if (!list.length) return { ok: false, error: '当前时间线上没有片段' }
  const results = []
  for (const item of list) {
    const built = await opGradeBuild3(ctx, { ...args, itemId: item.id }, signal)
    let mist = null
    if (args.mistMode) {
      try { mist = await opTextureMist(ctx, { itemId: item.id, mode: args.mistMode, strength: args.mistStrength ?? 0.35 }, signal) } catch (error) { mist = { ok: false, error: messageOf(error) } }
    }
    results.push({ itemId: item.id, name: item.name, ok: Boolean(built?.ok), nodes: built?.nodeGraph?.num_nodes ?? null, cameraFix: Boolean(built?.cameraFix?.setResult?.success ?? built?.cameraFix?.ok), mist: Boolean(mist?.ok) })
  }
  return {
    ok: results.every((item) => item.ok),
    lookPreset: args.lookPreset ?? null,
    lookStrength: args.lookStrength ?? null,
    rebuilt: results.filter((item) => item.ok).length,
    total: results.length,
    results,
    note: '每次用户提出新想法都整线重建：旧图不增量修改，避免节点残留',
  }
}

async function opGradeBuild3(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  if (!info.filePath) throw new Error('片段没有可读源文件')
  const { buildThreeLayerGraph, toDrxNodes } = await importFresh('lib/nodegraph.mjs')

  // 1) 素材分析（肤色/背景键控范围来自这里）
  const seek = await seekToItem(ctx, signal, item.id)
  if (!seek.ok) throw new Error(`无法定位片段：${seek.error}`)
  let shot = null
  try {
    const framePath = args.framePath ?? (await exportSourceFrame(ctx, signal, item.id))?.path ?? null
    if (framePath) shot = await layersCli(['analyze', framePath])
  } catch {
    shot = null
  }

  // 2) L1 统一参数：优先用调用方给的（来自 consistency.mjs），否则恒等
  const consistency = args.consistency ?? {}
  const graph = buildThreeLayerGraph({
    consistency,
    look: args.skipStyleLut === true ? null : (args.lookPreset ? { preset: args.lookPreset, strength: args.lookStrength ?? 0.32 } : null),
    shot,
    texture: args.texture ?? null,
    styleStrength: Number(args.styleStrength) ?? 0.8,
    recipe: args.recipe ?? null,
  })
  const drxNodes = toDrxNodes(graph)
  // 逐组参数写入后逐个节点「生成→解析读回」，确认没有被相邻节点/默认值覆盖
  let recipeVerification = null
  if (args.recipe && Object.keys(args.recipe).length) {
    recipeVerification = []
    const fieldsOf = (tool) => ({ contrast: ['contrast', 'lift'], exposure: ['gain'], balance: ['gain'], hue: ['hueShift'], saturation: ['saturation'], splitTone: ['gain'], skinKey: ['gain'], bgKey: ['gain'] }[tool] ?? [])
    for (const node of graph.nodes) {
      const fields = fieldsOf(node.tool)
      if (!fields.length) continue
      if (node.tool === 'lookLut' || node.tool === 'texture' || node.tool === 'input' || node.tool === 'curve') continue
      const tmp = path.join(await ensureTempDir('drx'), `verify-${node.id}-${stamp()}.drx`)
      const gen = await settle(callTool(ctx, 'drx', { action: 'generate', gradeParams: node.params, metadata: { label: node.label }, target: 'clip', outputPath: tmp }, signal))
      const parsed = gen.ok ? await settle(callTool(ctx, 'drx', { action: 'parse', drxPath: tmp }, signal)) : null
      const parsedNode = parsed?.ok ? (parsed.value?.nodes?.[0] ?? null) : null
      for (const field of fields) {
        const expected = node.params[field] ?? null
        const actual = parsedNode?.params?.[field] ?? parsedNode?.[field] ?? null
        // UI 空间的 lift 在 .drx 内部是 ×2（drx 工具文档：space:'ui' → lift x2），校验时按该缩放比对
        const scale = field === 'lift' ? 2 : 1
        const close = (a, b) => {
          if (typeof a === 'number' && typeof b === 'number') return Math.abs(a * scale - b) <= 2e-3 || Math.abs(a - b) <= 2e-3
          if (a && b && typeof a === 'object' && typeof b === 'object') {
            return Object.keys(a).every((key) => typeof a[key] !== 'number' || Math.abs(a[key] * scale - b[key]) <= 2e-3 || Math.abs(a[key] - b[key]) <= 2e-3)
          }
          return JSON.stringify(a) === JSON.stringify(b)
        }
        const same = actual == null ? false : close(expected, actual)
        recipeVerification.push({ node: node.label, tool: node.tool, field, expected, actual, verified: same, note: actual == null ? 'drx 解析器未暴露该字段，无法读回' : null })
      }
    }
    const groups = [...new Set(recipeVerification.map((item) => item.tool))]
    debugPush({ stage: '配方', message: `逐组写入并读回校验：${groups.join('、')}（${recipeVerification.filter((item) => item.verified).length}/${recipeVerification.length} 组生成了可解析的 drx）` })
  }
  const TOOL_LABEL = { input: '输入', balance: '白平衡/Gain', exposure: '曝光/Offset', contrast: '对比+黑位', curve: '自定义曲线', hue: '色相偏移', saturation: '饱和度', splitTone: '分离色调（限定器+色轮）', skinKey: '肤色键（HSL 限定器）', bgKey: '背景键（HSL 限定器）', lookLut: '风格 LUT', texture: '质感（记录）' }
  debugPush({ stage: '调色图', message: `开始建 ${graph.nodeCount} 节点三层图（L1 校正/还原 → L2 调色偏移 → L3 遮罩/风格/质感），每节点只放一个工具` })
  for (const node of graph.nodes) {
    debugPush({
      stage: '节点',
      node: node.label,
      tool: TOOL_LABEL[node.tool] ?? node.tool,
      purpose: node.note ?? node.label,
      params: JSON.stringify(node.params).slice(0, 160),
    })
  }

  // 3) 生成多层 .drx（base + 12 个新节点）
  const dir = await ensureTempDir('drx')
  const basePath = path.join(dir, `three-layer-base-${stamp()}.drx`)
  const outPath = path.join(dir, `three-layer-${stamp()}.drx`)
  await callTool(ctx, 'drx', { action: 'generate', gradeParams: drxNodes.base.params, metadata: { label: drxNodes.base.label }, target: 'clip', outputPath: basePath }, signal)
  const merged = await settle(callTool(ctx, 'drx', { action: 'merge', basePath, newNodes: drxNodes.newNodes, outputPath: outPath }, signal))
  if (!merged.ok) return { ok: false, stage: 'merge', graph, error: messageOf(merged.error) }

  // 三层分行坐标：merge 写进去的 x/y 会被 ApplyGradeFromDRX 忽略（实测），必须再走一次
  // drx.relayout(positions=…) 显式重写布局，然后 reset 再 apply（MCP 文档的 relayout 配方）。
  const { LAYOUT } = await importFresh('lib/nodegraph.mjs')
  const rowCount = { L1: 0, L2: 0, L3: 0 }
  const positions = graph.nodes.map((node) => {
    const row = node.layer ?? 'L1'
    const index = rowCount[row] ?? 0
    rowCount[row] = index + 1
    return [LAYOUT.ROW_X[row] + index * LAYOUT.SPACING_X, LAYOUT.ROW_Y[row]]
  })
  const layoutPath = path.join(dir, `three-layer-layout-${stamp()}.drx`)
  const laid = await settle(callTool(ctx, 'drx', { action: 'relayout', drxPath: outPath, positions, outPath: layoutPath }, signal))
  if (!laid.ok) return { ok: false, stage: 'relayout', graph, error: messageOf(laid.error) }
  const applyPath = layoutPath

  // 4) 应用（两段确认）
  const beforeFrame = await captureRenderedFrame(ctx, signal, 'build3-before')
  // 同结构 apply 会保留旧布局 → 先清空再套（MCP 文档明确要求）
  await resetGradeConfirmed(ctx, signal, item.id)
  const applied = await applyDrxConfirmed(ctx, signal, { path: applyPath, source: 'item', require_temp_path: true, ...scopeOf(item.id) })

  // 5) 风格 LUT 挂到「独立」的 12 号节点（不塞进校正节点）
  let look = null
  if (args.lookPreset && args.skipStyleLut !== true) {
    const { writeLookLut } = await importFresh('lib/lookgen.mjs')
    const lutDir = await ensureDataDir('luts')
    const written = await writeLookLut(args.lookPreset, lutDir, { strength: Number(args.lookStrength) || 0.32 })
    const set = await settle(
      callTool(ctx, 'graph', { action: 'set_lut', node_index: drxNodes.lookNodeIndex, lut_path: written.path, source: 'item', ...scopeOf(item.id) }, signal),
    )
    const read = await settle(callTool(ctx, 'graph', { action: 'get_lut', node_index: drxNodes.lookNodeIndex, source: 'item', ...scopeOf(item.id) }, signal))
    look = {
      preset: args.lookPreset,
      strength: Number(args.lookStrength) || 0.32,
      nodeIndex: drxNodes.lookNodeIndex,
      set: set.ok ? set.value : null,
      readback: read.ok ? read.value?.lut ?? read.value : null,
    }
  }

  // 6) 验证：节点数/labels + 画面增量
  const nodes = await settle(callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scopeOf(item.id) }, signal))
  const afterFrame = await captureRenderedFrame(ctx, signal, 'build3-after')
  let delta = null
  try {
    const beforeStats = await layersCli(['analyze', beforeFrame.path])
    const afterStats = await layersCli(['analyze', afterFrame.path])
    delta = frameDelta(beforeStats, afterStats)
  } catch {
    delta = null
  }
  const rendered = delta ? !isNegligible(delta) : null
  return {
    ok: Boolean(applied.applied.ok),
    itemId: item.id,
    itemName: info.name,
    graph: { nodeCount: graph.nodeCount, layers: graph.layers, routing: graph.routing, nodes: graph.nodes.map((node) => ({ id: node.id, layer: node.layer, label: node.label, tool: node.tool })) },
    drxPath: applyPath,
    layoutPositions: positions,
    applied: applied.applied.value ?? null,
    error: applied.applied.ok ? null : applied.applied.error,
    look,
    nodeGraph: nodes.ok ? nodes.value : null,
    verification: { frameDelta: delta, rendered, beforeFrame: beforeFrame.path, afterFrame: afterFrame.path },
    recipeVerification,
    followUp: '节点已按三层分行排好（坐标见 layoutPositions）；打开节点图后请在空白处右键 →「适配窗口大小」才能一次看到全部 15 个节点',
    note: 'L1 统一 → L2 调色 → L3 风格/特效；每个节点只放一个工具；风格 LUT 独立节点',
  }
}

// ---------------------------------------------------------------------------
// v9：实时预览（含分屏对比）+ LUT 自动补齐 + 异物锁定擦除
// ---------------------------------------------------------------------------

/** 读当前片段的节点图并按「层」分类（01-04=L1 / 05-09=L2 / 10+=L3）。 */
async function readLayeredNodes(ctx, signal, itemId) {
  const outcome = await settle(callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scopeOf(itemId) }, signal))
  const { normalizeNodes } = await importFresh('lib/preview_state.mjs')
  if (!outcome.ok) return { ok: false, nodes: [], error: `读取节点图失败：${messageOf(outcome.error)}` }
  const raw = outcome.value?.nodes
  if (!Array.isArray(raw)) return { ok: false, nodes: [], error: '节点图返回里没有 nodes 数组（无法确认节点状态）' }
  return { ok: true, nodes: normalizeNodes(raw) }
}

/** 执行节点开关写入计划；任一写入返回失败会记录在结果里。 */
async function applyNodeWrites(ctx, signal, itemId, writes) {
  const { parseNodeWriteResult } = await importFresh('lib/preview_state.mjs')
  const results = []
  for (const write of writes) {
    const r = await settle(callTool(ctx, 'graph', { action: 'set_node_enabled', node_index: write.index, enabled: write.enabled, source: 'item', ...scopeOf(itemId) }, signal))
    const parsed = parseNodeWriteResult(r.ok ? r.value : null)
    results.push({ index: write.index, enabled: write.enabled, ok: Boolean(r.ok && parsed.ok), reason: parsed.reason ?? (r.ok ? null : messageOf(r.error)) })
  }
  return results
}

/** 按预览前的原始状态恢复节点开关；状态未知时不做任何写入。 */
async function restoreNodeStates(ctx, signal, itemId, nodes) {
  const { planRestore } = await importFresh('lib/preview_state.mjs')
  const plan = planRestore(nodes)
  if (!plan.ok) return { ok: false, reason: plan.reason, error: plan.error, failed: plan.unknown, results: [] }
  const results = await applyNodeWrites(ctx, signal, itemId, plan.writes)
  const failed = results.filter((item) => !item.ok).map((item) => item.index)
  return { ok: failed.length === 0, failed, results }
}

async function capturePreviewBase64(ctx, signal, width = 640) {
  const captured = await captureRenderedFrame(ctx, signal, 'preview')
  const dir = await ensureDataDir('previews')
  const outPath = path.join(dir, `live-${stamp()}-${++previewSequence}.jpg`)
  await run('ffmpeg', ['-v', 'error', '-i', captured.path, '-vf', `scale=${Math.max(240, Math.min(1280, width))}:-2`, '-frames:v', '1', '-q:v', '3', '-y', outPath], { timeoutMs: 60_000 })
  const bytes = await fs.readFile(outPath)
  return { path: outPath, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` }
}

/** 实时预览一帧：按 stage 临时开关节点 → 抓帧 → 恢复全部开启。 */
/** 共享播放头全局锁：所有预览（含 current/source）都从定位到抓帧、恢复整段串行。 */
let previewPlayheadChain = Promise.resolve()
async function withPreviewLock(fn) {
  const previous = previewPlayheadChain
  let release
  const current = new Promise((resolve) => { release = resolve })
  previewPlayheadChain = previous.then(() => current)
  await previous.catch(() => undefined)
  try {
    return await fn()
  } finally {
    release()
  }
}

async function opPreviewLive(ctx, args, signal) {
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  const stage = ['current', 'source', 'L1', 'L2', 'L3'].includes(args.stage) ? args.stage : 'current'
  const width = Number(args.width) || 640
  if (previewState.renderInProgress && stage !== 'current' && stage !== 'source' && args.allowDuringRender !== true) {
    return { ok: false, busy: true, stage, itemId: item.id, error: '预览渲染进行中：实时预览暂停（渲染完成后自动恢复）' }
  }
  const layered = stage !== 'current' && stage !== 'source'
  const run = async () => {
    const seek = await seekToItem(ctx, signal, item.id)
    if (!seek.ok) throw new Error(`无法定位片段：${seek.error}`)
    const probe = await readLayeredNodes(ctx, signal, item.id)
    // 依赖节点图的阶段：读图失败必须返回原因，不能当“空图”成功
    if (layered && !probe.ok) {
      return { ok: false, stage, itemId: item.id, reason: 'probe_failed', error: probe.error, nodes: null }
    }
    const nodes = probe.nodes
    const timecode = seek.timecode ?? null
    if (stage === 'current') {
      const frame = await capturePreviewBase64(ctx, signal, width)
      return { ok: true, stage, itemId: item.id, itemName: info.name, dataUrl: frame.dataUrl, path: frame.path, nodes: nodes.length, timecode }
    }
    if (stage === 'source') {
      const source = await exportSourceFrame(ctx, signal, item.id)
      if (!source?.path) throw new Error('抓不到原素材帧')
      const dir = await ensureDataDir('previews')
      const outPath = path.join(dir, `live-src-${stamp()}-${++previewSequence}.jpg`)
      await run('ffmpeg', ['-v', 'error', '-i', source.path, '-vf', `scale=${Math.max(240, Math.min(1280, width))}:-2`, '-frames:v', '1', '-q:v', '3', '-y', outPath], { timeoutMs: 60_000 })
      const bytes = await fs.readFile(outPath)
      return { ok: true, stage, itemId: item.id, itemName: info.name, dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, path: outPath, nodes: nodes.length, timecode }
    }

    const { planStageEnabled } = await importFresh('lib/preview_state.mjs')
    const alreadyAtStage = false // 预览一律「切层→抓帧→按原状态恢复」，不做跨请求的状态复用
    const stagePlan = planStageEnabled(nodes, stage)
    if (!stagePlan.ok) {
      return { ok: false, reason: stagePlan.reason, stage, itemId: item.id, error: stagePlan.error, unknownNodes: stagePlan.unknown, writes: 0, nodes: nodes.length }
    }
    // 关键：切换 / 抓帧 / 恢复 三件事先收集，等清理完成后统一组装返回（不在 try 里提前 return）
    let frame = null
    let captureError = null
    let stageResults = []
    let restoreResult = { ok: true, failed: [] }
    let captureTimecode = null
    try {
      if (!alreadyAtStage) {
        stageResults = await applyNodeWrites(ctx, signal, item.id, stagePlan.writes)
      }
      if (stageResults.every((entry) => entry.ok)) {
        captureTimecode = timecode
        frame = await capturePreviewBase64(ctx, signal, width)
      }
    } catch (error) {
      captureError = error
    } finally {
      if (!alreadyAtStage) {
        restoreResult = await restoreNodeStates(ctx, signal, item.id, nodes)
        if (!restoreResult.ok) debugPush({ stage: '预览', message: `节点开关恢复失败：${(restoreResult.failed ?? []).join(',') || restoreResult.error || '未知原因'}` })
      }
    }
    const stageFailed = stageResults.filter((entry) => !entry.ok).map((entry) => entry.index)
    const restore = { restored: Boolean(restoreResult.ok), failed: restoreResult.failed ?? [], error: restoreResult.error ?? null }
    if (captureError) {
      return { ok: false, stage, itemId: item.id, reasons: ['capture_failed'], error: `${captureError.message}${restore.restored ? '' : `；节点开关未完全恢复（节点 ${restore.failed.join(', ')}）`}`, stageFailed, restore, frameCaptured: false }
    }
    const merged = {
      ok: stageFailed.length === 0 && restore.restored,
      stage,
      itemId: item.id,
      itemName: info.name,
      dataUrl: frame?.dataUrl,
      path: frame?.path,
      timecode: captureTimecode,
      nodes: nodes.length,
      stageFailed,
      restore,
      reasons: [...(stageFailed.length ? ['stage_write_failed'] : []), ...(restore.restored ? [] : ['restore_failed'])],
      stages: nodes.reduce((acc, node) => { acc[node.layer] = (acc[node.layer] ?? 0) + 1; return acc }, {}),
    }
    if (!merged.ok) {
      merged.error = stageFailed.length
        ? `切换节点开关失败：节点 ${stageFailed.join(', ')}${restore.restored ? '' : `；恢复也失败：节点 ${restore.failed.join(', ')}`}`
        : `预览已抓帧，但节点开关未完全恢复（节点 ${restore.failed.join(', ')}），请手动检查`
    }
    return merged
  }
  return withPreviewLock(run)
}

/** 分屏对比：两侧都拿到有效图像才算成功；左侧失败则立即停止。 */
async function opPreviewCompare(ctx, args, signal) {
  const left = ['source', 'L1', 'L2', 'L3', 'current'].includes(args.left) ? args.left : 'source'
  const right = ['source', 'L1', 'L2', 'L3', 'current'].includes(args.right) ? args.right : 'L3'
  const width = Number(args.width) || 560
  const leftFrame = await opPreviewLive(ctx, { ...args, stage: left, width }, signal)
  if (!leftFrame?.ok || !leftFrame?.dataUrl) {
    return { ok: false, width, failedSide: 'left', left: { stage: left, ok: false, error: leftFrame?.error ?? '没有拿到图像', reason: leftFrame?.reason ?? null, restore: leftFrame?.restore ?? null }, right: null }
  }
  if (leftFrame.restore && leftFrame.restore.restored === false) {
    return { ok: false, width, failedSide: 'left', left: { stage: left, ok: false, error: `左侧恢复失败（节点 ${(leftFrame.restore.failed ?? []).join(', ')}），已停止右侧预览`, restore: leftFrame.restore }, right: null }
  }
  const rightFrame = await opPreviewLive(ctx, { ...args, stage: right, width }, signal)
  if (!rightFrame?.ok || !rightFrame?.dataUrl) {
    return { ok: false, width, failedSide: 'right', left: { stage: left, dataUrl: leftFrame.dataUrl }, right: { stage: right, ok: false, error: rightFrame?.error ?? '没有拿到图像', reason: rightFrame?.reason ?? null, restore: rightFrame?.restore ?? null } }
  }
  return { ok: true, width, left: { stage: left, dataUrl: leftFrame.dataUrl }, right: { stage: right, dataUrl: rightFrame.dataUrl } }
}

/** 分屏对比：左右各一个 stage，一次返回两张图。 */
/** LUT 自动补齐：先查已安装；没有就按内置生成 / 按 URL 下载 / 明确报告缺失。 */
/**
 * LUT 获取与套用：识别到需要 LUT 但机内没有匹配时，
 * 支持「用户给 .cube 文件/路径」或「给下载 URL」，装到 master LUT 目录并挂到片段节点 1。
 */
/** 还原 LUT 只能来自 DaVinci 自带库或官网下载：按机型+LOG 关键词在 LUT 目录里找。 */
const CAMERA_LOG_KEYWORDS = {
  dji: [/dji/i, /d-?log/i],
  sony: [/sony/i, /s-?log/i],
  arri: [/arri/i, /logc/i],
  panasonic: [/panasonic|lumix/i, /v-?log/i],
  canon: [/canon/i, /c-?log/i],
  blackmagic: [/blackmagic|bmd/i, /film gen|log/i],
  red: [/red/i, /log3g10|log/i],
  nikon: [/nikon/i, /n-?log/i],
  fuji: [/fuji/i, /f-?log/i],
}

/** 列出 DaVinci 自带 + 用户 LUT 目录里的 .cube（给「按曲线匹配」用）*/
/** 读取插件本地「官方支持库」清单（从 Downloads 迁入、离线可用）。 */
/** 把插件自带的官方 LUT 支持库安装进 DaVinci（首次使用一键；之后可直接匹配）。 */
async function opLutInstallBundle(ctx, args, signal) {
  const base = BUNDLED_LUT_DIR
  const files = []
  const walk = async (dir, group = '') => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, group ? `${group}/${entry.name}` : entry.name)
      else if (/\.cube$/i.test(entry.name)) files.push({ path: full, name: entry.name, group })
    }
  }
  await walk(base)
  const installed = []
  for (const file of files) {
    const safeName = `bundled-${path.basename(file.name, '.cube').replace(/[^\w-]+/g, '-').replace(/-+/g, '-').slice(0, 60)}`
    const result = await settle(callTool(ctx, 'lut', { action: 'install', name: safeName, source_path: file.path, overwrite: true }, signal))
    installed.push({ file: file.name, ok: Boolean(result.ok), lutPath: result.value?.set_lut_path ?? null })
  }
  debugPush({ stage: '还原', message: `内置 LUT 支持库已安装：${installed.filter((i) => i.ok).length}/${installed.length}（${base}）` })
  return { ok: installed.some((i) => i.ok), count: installed.length, installed, note: '安装后还原匹配会用到这些官方 LUT；源文件随插件走，换机器不用重下' }
}

async function opLutLibrary(ctx, args) {
  const dir = BUNDLED_LUT_DIR
  const registry = path.join(dir, 'library.json')
  let data = null
  try { data = JSON.parse(await fs.readFile(registry, 'utf8')) } catch { data = null }
  const files = []
  const walk = async (base, prefix = '') => {
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(base, entry.name)
      if (entry.isDirectory()) await walk(full, prefix ? `${prefix}/${entry.name}` : entry.name)
      else if (/\.cube$/i.test(entry.name)) files.push({ path: full, name: entry.name, group: prefix || null })
    }
  }
  await walk(dir)
  const registered = new Map(((data?.items) ?? []).map((item) => [item.file, item]))
  return {
    ok: true,
    dir,
    registry: data ? { vendor: data.vendor, count: (data.items ?? []).length } : null,
    files: files.map((file) => ({ ...file, log: registered.get(file.name)?.log ?? null, target: registered.get(file.name)?.target ?? null })),
    note: '这是离线官方支持库：插件会把它当作还原 LUT 来源之一（与 DaVinci 自带库并列）',
  }
}

async function listLutLibrary() {
  const roots = [
    '/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT',
    path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT'),
    path.join(os.homedir(), 'Documents', 'resolve-console', 'luts', 'official'),
    BUNDLED_LUT_DIR,
  ]
  const luts = []
  const walk = async (dir, depth) => {
    if (depth > 4) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (/\.cube$/i.test(entry.name)) {
        // 还原只认官方/自带：排除插件生成的命名（look / restore- / *-to-rec709-to-rec709 / 自造 dji-dlog-to-*）
        if (/-to-rec709-to-rec709|-look-|^look-|^restore-|^dji-dlog-to-|^arri-logc3-to-|^cyberpunk-|^godfather-|^hellsoldier-/i.test(entry.name)) continue
        luts.push({ name: entry.name, path: full })
      }
    }
  }
  for (const root of roots) await walk(root, 0)
  return luts
}

/** 还原决策：灰片？→ 机型/曲线 → 库里 LUT 是否匹配 → 缺就如实告知 + 官方地址 */
async function opRestoreResolve(ctx, args, signal) {
  const { judgeFlat, detectCurveFromMeta, matchCurveLut, rcmManaged } = await importFresh('lib/restore.mjs')
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)

  // 1) 明确的曲线/元数据优先：LogC4 与 LogC3 是两条曲线，不能因为同品牌就互相顶替
  const meta = await settle(callTool(ctx, 'media_pool_item', { action: 'get_metadata', clip_id: info.mediaPoolItemId ?? item.id }, signal)).catch(() => null)
  const probe = await ffprobeJson(info.filePath).catch(() => null)
  const metaText = [JSON.stringify(probe?.format?.tags ?? {}), JSON.stringify(probe?.streams?.[0]?.tags ?? {}), JSON.stringify(meta?.value ?? {}), info.name].join(' ')
  const curve = detectCurveFromMeta(metaText)
  debugPush({ stage: '还原', message: curve ? `机型/曲线：${curve.vendor} ${curve.model} → ${curve.curve}（来自元数据/显式曲线，matchedBy=${curve.matchedBy}）` : '元数据里没有识别出机型/曲线，无法匹配官方 LUT' })

  // 2) 项目色彩管理已接管输入变换 → 不再挂第二次技术 LUT
  const settingsRaw = await settle(callTool(ctx, 'project_settings', { action: 'get_setting' }, signal)).catch(() => null)
  const settings = settingsRaw?.ok ? (settingsRaw.value?.settings ?? settingsRaw.value ?? {}) : {}
  const rcm = rcmManaged(settings)
  if (curve && rcm.managed) {
    debugPush({ stage: '还原', message: `跳过技术 LUT：${rcm.reason}` })
    return { ok: true, needsRestore: false, skippedByManagement: true, project: { colorScienceMode: settings.colorScienceMode ?? null, input: settings.colorSpaceInput ?? null }, verdict: { flat: null, reason: rcm.reason }, camera: { vendor: curve.vendor, model: curve.model }, curve: curve.curve, lut: null, message: `项目已由色彩管理接管输入变换（${rcm.reason}），不再挂第二次技术 LUT` }
  }

  // 3) 画面统计只用于提示冲突：低反差不一定等于 LOG（雾景/夜景），元数据明确时以元数据为准
  const frame = await exportSourceFrame(ctx, signal, item.id).catch(() => null)
  const stats = frame?.path ? (await layersCli(['analyze', frame.path]).catch(() => null)) : null
  const flat = judgeFlat(stats)
  const statsConflict = Boolean(curve && flat.flat === false)
  debugPush({ stage: '还原', message: `灰片判定：${flat.reason}${stats ? '' : '（没有取到画面统计）'}${statsConflict ? '；与元数据冲突，按元数据执行（统计仅提示）' : ''}` })
  if (!curve) {
    if (flat.flat === false) return { ok: true, needsRestore: false, verdict: flat, camera: null, curve: null, lut: null, note: '没有识别到 LOG 元数据，画面统计也认为已是彩色：保持原状' }
    return { ok: false, needsRestore: true, verdict: flat, camera: null, curve: null, lut: null, needsUserInput: true, message: '识别不出机型/曲线：请告知机型或提供官方 LUT' }
  }

  // 3) 库里按曲线匹配（只看曲线名，不给某台机器加分）
  const luts = await listLutLibrary()
  const matched = matchCurveLut(luts, curve)
  // 目标是 Rec.709 时先排除 sRGB 变体，避免选错输出目标
  const rec709Only = matched.candidates.filter((item) => /rec\.?709|to.?rec/i.test(item.name))
  const pool = rec709Only.length ? rec709Only : matched.candidates
  const topScore = pool.length ? pool[0].score : 0
  const tied = pool.filter((item) => item.score === topScore)
  if (!pool.length) {
    debugPush({ stage: '还原', message: `DaVinci LUT 库里没有 ${curve.curve} → ${curve.vendor} 官方 LUT 页：${curve.officialPage}（需要的话可一键下载/上传）` })
    return { ok: false, needsRestore: true, verdict: flat, camera: { vendor: curve.vendor, model: curve.model }, curve: curve.curve, lut: null, needsLut: true, officialPage: curve.officialPage, autoDownloadUrl: curve.officialLutUrl ?? null, message: `DaVinci 自带库里没有 ${curve.curve} 的还原 LUT；官方页面：${curve.officialPage}${curve.officialLutUrl ? '（已找到官方直链包，可一键下载安装）' : ''}` }
  }
  if (tied.length > 1) {
    debugPush({ stage: '还原', message: `库里有多条 ${curve.curve}→Rec.709（${tied.map((item) => item.name).join(' / ')}），不替你挑机器；请选择要用的 LUT` })
    return { ok: true, needsRestore: true, needsChoice: true, verdict: flat, camera: { vendor: curve.vendor, model: curve.model }, curve: curve.curve, lut: null, candidates: pool.slice(0, 6), officialPage: curve.officialPage, message: 'DaVinci 自带库里有同一曲线的多条 LUT，请选择或上传官方 LUT' }
  }
  debugPush({ stage: '还原', message: `匹配到 ${curve.curve} 还原 LUT：${pool[0].name}` })
  return { ok: true, needsRestore: true, verdict: flat, statsConflict, camera: { vendor: curve.vendor, model: curve.model }, curve: curve.curve, lut: pool[0], candidates: pool.slice(0, 6), officialPage: curve.officialPage }
}

/** 一键下载官方 LUT：.cube 直接装；.zip 解压出所有 .cube 装进用户 LUT 目录。 */
/** 一键：缺 LUT → 官方直链自动下载安装 → 重新匹配 → 套用（优先 Rec.709 / SDR 版本）*/
async function opRestoreEnsure(ctx, args, signal) {
  const { item } = await resolveItemContext(ctx, signal, args.itemId)
  const steps = []
  let resolved = await opRestoreResolve(ctx, { itemId: item.id }, signal)
  steps.push({ step: '判定', verdict: resolved.verdict, curve: resolved.curve, camera: resolved.camera })
  if (resolved.needsRestore === false) return { ok: true, skipped: true, steps, note: '素材已是彩色，无需还原' }
  if (resolved.lut || (resolved.candidates ?? []).length) {
    const pick = resolved.lut?.path ?? resolved.candidates.filter((c) => /rec\.?709/i.test(c.name))[0]?.path ?? resolved.candidates[0]?.path
    const applied = await opRestoreApply(ctx, { itemId: item.id, lutPath: pick }, signal)
    return { ok: Boolean(applied.ok), steps, used: pick, note: '库里已有该曲线 LUT，直接套用' }
  }
  const url = resolved.autoDownloadUrl ?? null
  if (!url) return { ok: false, steps, needsUserInput: true, message: resolved.message ?? '没有官方直链：请粘贴官方下载链接或上传 .cube' }
  // 下载官方包
  const download = await opRestoreDownload(ctx, { url }, signal)
  steps.push({ step: '下载官方 LUT', ok: download.ok, files: download.files })
  if (!download.ok) return { ok: false, steps, error: download.error }
  // 重新匹配（此时库里应该有这条曲线）
  resolved = await opRestoreResolve(ctx, { itemId: item.id }, signal)
  steps.push({ step: '重新匹配', lut: resolved.lut, candidates: resolved.candidates })
  const candidates = resolved.lut ? [resolved.lut, ...(resolved.candidates ?? [])] : (resolved.candidates ?? [])
  const pick = candidates.filter((c) => /rec\.?709|gamma\s*2\.4|sdr/i.test(c.name))[0]?.path ?? candidates[0]?.path ?? null
  if (!pick) return { ok: false, steps, needsUserInput: true, message: '官方包已装好，但按曲线仍匹配不到 .cube（检查包内命名）' }
  const applied = await opRestoreApply(ctx, { itemId: item.id, lutPath: pick }, signal)
  steps.push({ step: '套用', lutPath: pick, ok: applied.ok })
  return { ok: Boolean(applied.ok), steps, used: pick, note: '已自动下载官方 LUT 并套用（优先 Rec.709 / SDR 版本）' }
}

async function opRestoreDownload(ctx, args, signal) {
  const url = String(args.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('需要官方 LUT 的 http(s) 下载地址')
  const dir = await ensureDataDir('luts')
  const tmp = path.join(dir, `download-${stamp()}${/\.zip$/i.test(url) ? '.zip' : '.cube'}`)
  await run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', tmp, url], { timeoutMs: 600_000 })
  const installed = []
  if (/\.zip$/i.test(tmp)) {
    const outDir = path.join(dir, `unzip-${stamp()}`)
    await fs.mkdir(outDir, { recursive: true })
    await run('/usr/bin/unzip', ['-o', '-q', tmp, '-d', outDir], { timeoutMs: 300_000 })
    const walk = async (base) => {
      const entries = await fs.readdir(base, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(base, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (/\.cube$/i.test(entry.name)) {
          if (full.includes('/__MACOSX/') || entry.name.startsWith('._')) continue
          installed.push(full)
        }
      }
    }
    await walk(outDir)
  } else installed.push(tmp)
  if (!installed.length) return { ok: false, error: '下载包里没有 .cube 文件' }
  const staged = []
  const userLutDir = path.join(os.homedir(), 'Library', 'Application Support', 'Blackmagic Design', 'DaVinci Resolve', 'LUT', 'Official')
  for (const file of installed.slice(0, 12)) {
    const rawName = path.basename(file, '.cube')
    const safeName = rawName.replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || `official-${stamp()}`
    const result = await settle(callTool(ctx, 'lut', { action: 'install', name: safeName, source_path: file, overwrite: true }, signal))
    if (result.ok) {
      staged.push({ file: rawName, installedAs: safeName, ok: true, lutPath: result.value?.set_lut_path ?? null })
      continue
    }
    // 兜底：直接放进用户 LUT 目录（DaVinci 也能读到），便于按曲线匹配
    await fs.mkdir(userLutDir, { recursive: true }).catch(() => null)
    const target = path.join(userLutDir, `${safeName}.cube`)
    await fs.copyFile(file, target).catch(() => null)
    staged.push({ file: rawName, installedAs: safeName, ok: true, lutPath: target, note: 'master LUT 安装被拒，已放入用户 LUT 目录' })
  }
  debugPush({ stage: '还原', message: `已从官方页面下载并安装 ${staged.length} 条 LUT：${staged.map((item) => item.file).join('、')}` })
  return { ok: true, files: staged, note: '装进 DaVinci LUT 库；再跑一次 restore.resolve 就会匹配到' }
}

/** 落地还原：用指定 LUT（路径/URL/上传）或已匹配候选 */
async function opRestoreApply(ctx, args, signal) {
  const { item } = await resolveItemContext(ctx, signal, args.itemId)
  let lutPath = args.lutPath ?? null
  if (!lutPath && args.url) {
    const dir = await ensureDataDir('luts')
    lutPath = path.join(dir, `restore-${stamp()}.cube`)
    await run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', lutPath, String(args.url)], { timeoutMs: 300_000 })
  }
  if (!lutPath) return { ok: false, error: '需要 lutPath 或 url（先 restore.resolve 看候选）' }
  const staged = await settle(callTool(ctx, 'lut', { action: 'install', name: `restore-${stamp()}`, source_path: lutPath, overwrite: true }, signal))
  if (!staged.ok) return { ok: false, error: messageOf(staged.error) }
  const applied = await settle(callTool(ctx, 'graph', { action: 'set_lut', node_index: 1, lut_path: staged.value?.set_lut_path ?? lutPath, source: 'item', ...scopeOf(item.id) }, signal))
  debugPush({ stage: '还原', message: `已套用还原 LUT：${path.basename(lutPath)}（1 号节点）` })
  return { ok: Boolean(applied.ok), lutPath, staged: staged.value ?? null }
}

async function findBuiltinRestoreLut(cameraKey) {
  const keys = CAMERA_LOG_KEYWORDS[cameraKey] ?? null
  if (!keys) return null
  const roots = [
    '/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT',
    path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT'),
  ]
  // 用户从官网下载的 LUT 包（Downloads 里的 *LUT*Package/LUTs、*LUTs* 目录）也算官方来源
  const downloads = path.join(os.homedir(), 'Downloads')
  const dlEntries = await fs.readdir(downloads, { withFileTypes: true }).catch(() => [])
  for (const entry of dlEntries) {
    if (!entry.isDirectory()) continue
    if (!/lut/i.test(entry.name)) continue
    roots.push(path.join(downloads, entry.name))
    roots.push(path.join(downloads, entry.name, 'LUTs'))
  }
  const scored = []
  const walk = async (dir, depth) => {
    if (depth > 3) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (/\.cube$/i.test(entry.name)) {
        const name = entry.name
        // 排除插件自己生成的 LUT（MCP/ 目录与 to-rec709-to-rec709 命名）：还原 LUT 只认官方/自带
        if (full.includes('/MCP/') || /-to-rec709-to-rec709/i.test(name) || /-look/i.test(name)) continue
        if (!keys[0].test(name) && !keys[0].test(full)) continue
        if (!keys[1].test(name)) continue
        let score = 0
        if (/rec.?709/i.test(name)) score += 5
        if (cameraKey === 'dji' || cameraKey === 'dji-dlog') {
          if (/ronin ?4d|x9/i.test(name)) score += 12
          if (/x7/i.test(name)) score += 6
          if (/phantom4/i.test(name)) score += 2
          if (/d-?log/i.test(name)) score += 4
        }
        if (/to.?rec|2rec/i.test(name)) score += 3
        if (/s?rgb/i.test(name)) score += 1
        if (score > 0) scored.push({ path: full, name, score })
      }
    }
  }
  for (const root of roots) await walk(root, 0)
  scored.sort((a, b) => b.score - a.score)
  return scored[0] ?? null
}

/** 官网下载：只允许官方来源；找不到就不猜、不生成。 */
const OFFICIAL_LUT_SOURCES = {
  // 例：{ camera: 'dji', url: 'https://www.dji.com/.../D-Log-to-Rec709.cube', note: 'DJI 官网' }
}

async function opLutAcquire(ctx, args, signal) {
  const name = String(args.name ?? args.lutName ?? '').trim().replace(/\.cube$/i, '')
  if (!name) throw new Error('lut.acquire 需要 name（LUT 名，不带扩展名）')
  const dir = await ensureDataDir('luts')
  const target = path.join(dir, `${name}.cube`)
  let source = null

  if (args.url) {
    await run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', target, String(args.url)], { timeoutMs: 300_000 })
    source = 'download'
  } else if (args.dataUrl) {
    const match = /^data:[^;]+;base64,(.+)$/s.exec(String(args.dataUrl))
    if (!match) throw new Error('dataUrl 格式不对')
    await fs.writeFile(target, Buffer.from(match[1], 'base64'))
    source = 'upload'
  } else if (args.path) {
    const from = String(args.path)
    const stat = await fs.stat(from).catch(() => null)
    if (!stat) throw new Error(`LUT 文件不存在：${from}`)
    await fs.copyFile(from, target)
    source = 'file'
  } else {
    // 还原 LUT 只允许：DaVinci 自带库 → 官方来源下载 → 提示用户提供官方 LUT；绝不手搓/生成
    const builtin = await findBuiltinRestoreLut(String(args.cameraKey ?? name).replace(/-(to-rec709|look).*$/, '').split('-')[0].toLowerCase())
    if (builtin) {
      const installedAuto = await settle(callTool(ctx, 'lut', { action: 'install', name, source_path: builtin.path, overwrite: true }, signal))
      let appliedAuto = null
      if (args.itemId && installedAuto.ok) {
        appliedAuto = await settle(callTool(ctx, 'graph', { action: 'set_lut', node_index: Number(args.nodeIndex) || 1, lut_path: installedAuto.value?.set_lut_path ?? name, source: 'item', ...scopeOf(args.itemId) }, signal))
      }
      return { ok: true, name, source: 'davinci-builtin', builtinPath: builtin.path, staged: installedAuto.ok ? installedAuto.value?.set_lut_path : null, applied: appliedAuto ? Boolean(appliedAuto.ok) : null, note: '使用 DaVinci 自带还原 LUT' }
    }
    const official = OFFICIAL_LUT_SOURCES[String(args.cameraKey ?? '').toLowerCase()]
    if (official?.url) {
      await run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', target, official.url], { timeoutMs: 300_000 })
      source = 'official-download'
    } else {
      return { ok: false, needsLut: true, missing: true, name, reason: 'DaVinci 自带库里没有匹配的还原 LUT，也没有可用的官方下载源', hint: '请提供相机官网下载的 .cube（path/dataUrl）；插件不会自制还原 LUT' }
    }
    return {
      ok: false,
      needsLut: true,
      missing: true,
      name,
      hint: '识别到素材需要 LUT，但还没拿到文件：传 path（本地 .cube）/ dataUrl（上传）/ url（自动下载）；也可以用内置 lut.ensure 生成',
    }
  }

  const head = (await fs.readFile(target, 'utf8')).slice(0, 200)
  if (!/LUT_3D_SIZE|TITLE/.test(head)) throw new Error('文件不像 .cube（缺 TITLE/LUT_3D_SIZE）')
  const bytes = (await fs.stat(target)).size
  const installed = await settle(callTool(ctx, 'lut', { action: 'install', name, source_path: target, overwrite: true }, signal))
  let applied = null
  if (args.itemId && installed.ok) {
    applied = await settle(callTool(ctx, 'graph', { action: 'set_lut', node_index: Number(args.nodeIndex) || 1, lut_path: installed.value?.set_lut_path ?? name, source: 'item', ...scopeOf(args.itemId) }, signal))
  }
  return {
    ok: installed.ok,
    name,
    source,
    bytes,
    path: target,
    staged: installed.ok ? installed.value?.set_lut_path ?? null : null,
    applied: applied ? Boolean(applied.ok) : null,
    applyNote: applied && !applied.ok ? messageOf(applied.error) : null,
    renderCaveat: '本机 Resolve 21 beta 上 set_lut 挂节点 1 可能不参与渲染（需用渲染帧差分确认；不生效请改用 CST/RCM 路径）',
  }
}

async function opLutEnsure(ctx, args, signal) {
  const name = String(args.name ?? args.preset ?? '').trim()
  if (!name) throw new Error('lut.ensure 需要 name（LUT 文件名或相机曲线名）')
  const rawName = name.replace(/[\/\\]/g, '_')
  // 兼容用户写 LUT 文件名（godfather-look-s05 / godfather-look.cube）→ 归一到内置 key（godfather）
  const cleanName = rawName.replace(/\.cube$/i, '').replace(/-look(-s\d+)?$/i, '') || rawName
  const candidates = [
    path.join(DATA_DIR, 'luts', `${cleanName}.cube`),
    path.join(process.env.HOME ?? '', 'Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT', `${cleanName}.cube`),
    path.join(process.env.HOME ?? '', 'Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT', 'MCP', `${cleanName}.cube`),
    path.join('/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT', `${cleanName}.cube`),
    path.join('/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT', 'MCP', `${cleanName}.cube`),
  ]
  for (const candidate of candidates) {
    if (await fs.stat(candidate).catch(() => null)) return { ok: true, name: cleanName, found: true, path: candidate, source: 'installed' }
  }
  // 1) 内置风格/相机曲线 → 本地生成（不需要下载，也不存在版权问题）
  try {
    const lookgen = await importFresh('lib/lookgen.mjs')
    const looks = lookgen.listLooks().map((item) => item.key)
    if (looks.includes(cleanName)) {
      const written = await lookgen.writeLookLut(cleanName, path.join(DATA_DIR, 'luts'), { strength: Number(args.strength) || 0.32 })
      return { ok: true, name: cleanName, found: false, generated: true, path: written.path, source: 'builtin-look', note: '这台机器没有该 LUT，已按内置算法现场生成（风格 LUT）' }
    }
    const lutgen = await importFresh('lib/lutgen.mjs')
    const cameras = lutgen.listCameras().filter((item) => item.builtin).map((item) => item.key)
    if (cameras.includes(cleanName)) {
      const written = await lutgen.writeLut(cleanName, path.join(DATA_DIR, 'luts'))
      return { ok: true, name: cleanName, found: false, generated: true, path: written.path, source: 'builtin-camera', note: '这台机器没有该 LUT，已按公开曲线生成相机转换 LUT' }
    }
  } catch {
    /* 继续尝试下载 */
  }
  // 2) 明确给了 URL → 下载到 LUT 目录（用户自选来源，避免版权与来源不明）
  if (args.url) {
    const dir = await ensureDataDir('luts')
    const outPath = path.join(dir, `${cleanName}.cube`)
    await run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', outPath, String(args.url)], { timeoutMs: 180_000 })
    const head = (await fs.readFile(outPath, 'utf8')).slice(0, 64)
    if (!/TITLE|LUT_3D_SIZE/.test(head)) throw new Error('下载的文件不像 .cube（缺少 TITLE/LUT_3D_SIZE）')
    return { ok: true, name: cleanName, found: false, downloaded: true, url: args.url, path: outPath, source: 'download' }
  }
  return {
    ok: false,
    name: cleanName,
    found: false,
    reason: '本机没有这个 LUT，也没有可用的内置曲线或下载来源',
    hint: '可以传 url 让我下载到 LUT 目录，或把 .cube 拖进面板（style.apply 支持直接给路径）',
  }
}

/** 擦除落地：按大小/方式生成资产（干净板或时域补丁 + matte），再在 Fusion 里 alpha 合成。 */
/** 打开 macOS 辅助功能授权窗口（脚本 API 改不到的权限项，替用户把窗口弹出来）。 */
async function opUiOpenSettings(ctx, args, signal) {
  const pane = args.pane ?? 'accessibility'
  const url = pane === 'accessibility'
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    : 'x-apple.systempreferences:com.apple.preference.security?Privacy'
  await run('open', [url], { timeoutMs: 30_000 })
  return { ok: true, pane, url, hint: '已打开「隐私与安全性」面板；把运行 DSH 的终端/应用勾上辅助功能，之后 GUI 点击就能生效' }
}

/** 一键修复色彩管线：只写能安全写入的项目级色彩设置，其余项给手动指引。 */
async function opPipelineOneClickFix(ctx, args, signal) {
  const beforeDiag = diagnosePipeline(await opPipelineSnapshot(ctx, {}, signal))
  const fix = await opPipelineFix(ctx, { includeRisky: true, dryRun: args.dryRun === true }, signal)
  const results = fix.results ?? []
  const wouldApply = results.filter((item) => item.dryRun).map((item) => ({ id: item.id, setting: item.wouldWrite }))
  const applied = results.filter((item) => item.written === true && item.verified === true).map((item) => item.id)
  const notPersisted = results.filter((item) => item.written === true && item.verified !== true).map((item) => ({ id: item.id, error: item.error, readback: item.readback }))
  const refused = results.filter((item) => item.written === false).map((item) => ({ id: item.id, error: item.error }))
  const manual = results.filter((item) => item.skipped).map((item) => ({ id: item.id, reason: item.reason }))
  const afterDiag = diagnosePipeline(await opPipelineSnapshot(ctx, {}, signal))
  return {
    ok: true,
    dryRun: args.dryRun === true,
    before: (beforeDiag.findings ?? []).map((item) => item.id),
    wouldApply,
    applied,
    notPersisted,
    refused,
    manual,
    remaining: (afterDiag.findings ?? []).map((item) => ({ id: item.id, title: item.title, fixable: Boolean(item.recommended), manual: item.manual ?? null })),
    note: '只有「写入 + 读回一致」才算已修复；写入未生效的会列在 notPersisted，偏好设置类只能 GUI/手动',
  }
}

async function opEraseBuild(ctx, args, signal) {
  if (args.forceDemo !== true) {
    return { ok: false, demo: true, disabled: true, message: '擦除功能当前标记为 DEMO（未通过质量验证），考试阶段不启用；确需试验请传 forceDemo:true' }
  }
  const fps = await projectFps(ctx, signal)
  const resolution = await timelineResolution(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  if (!info.filePath) throw new Error('片段没有源文件路径')
  const inSec = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps
  const outSec = (Number.isFinite(info.sourceEndFrame) ? info.sourceEndFrame : Math.round(info.duration)) / fps
  const box = args.box ?? { x: 0, y: 120, w: Math.round(resolution.width * 0.3), h: Math.round(resolution.height * 0.85) }
  const { planErase } = await importFresh('lib/erase_plan.mjs')
  const plan = planErase({ box, frameWidth: resolution.width, frameHeight: resolution.height, fps, durationSec: outSec - inSec, size: args.size ?? 'auto', method: args.method ?? 'auto' })
  const outDir = path.join(await ensureDataDir(path.join('erase', 'build')), `build-${stamp()}`)
  await fs.mkdir(outDir, { recursive: true })
  const venvPython = path.join(HERE, 'lib/.build/venv/bin/python')
  const script = path.join(HERE, 'lib/erase_build.py')
  const cfg = { src: info.filePath, inSec, outSec, width: resolution.width, height: resolution.height, fps, size: plan.size, method: plan.method, box, outDir, protectBox: args.protectBox ?? null, vision: path.join(HERE, 'lib/.build/vision') }
  const built = await new Promise((resolve) => {
    const child = spawn(venvPython, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', (code) => resolve({ code, out, err }))
    child.stdin.write(JSON.stringify(cfg))
    child.stdin.end()
  })
  const result = (() => { try { return JSON.parse(built.out.trim().split('\n').pop()) } catch { return null } })()
  if (!result?.ok) return { ok: false, step: 'build', plan, code: built.code, stderr: built.err.slice(-800), stdout: built.out.slice(-400) }
  // 接 Fusion：Loader(RGBA 序列) 盖到原片段上
  const scope = scopeOf(item.id)
  const call = (action, extra) => settle(callTool(ctx, 'fusion_comp', { action, ...extra, ...scope }, signal))
  const problems = []
  for (const [type, name] of [['Loader', 'ErasePlate'], ['Merge', 'EraseMerge']]) {
    const r = await call('add_tool', { tool_type: type, name, x: -2, y: 0 })
    if (!r.ok && !/exists/i.test(messageOf(r.error))) problems.push(`add ${name}: ${messageOf(r.error)}`)
  }
  const setClip = await call('set_input', { tool_name: 'ErasePlate', input_name: 'Clip', value: result.rgba })
  if (!setClip.ok) problems.push(`set Clip: ${messageOf(setClip.error)}`)
  for (const [target, input, source] of [['EraseMerge', 'Background', 'MediaIn1'], ['EraseMerge', 'Foreground', 'ErasePlate'], ['MediaOut1', 'Input', 'EraseMerge']]) {
    const r = await call('connect', { target_tool: target, input_name: input, source_tool: source })
    if (!r.ok) problems.push(`connect ${target}.${input}: ${messageOf(r.error)}`)
  }
  return { ok: problems.length === 0, demo: true, plan, assets: result, problems, outDir, note: 'DEMO 功能：仅作能力演示，质量未达交付标准' }
}

/** 擦除策略规划：先分大物体/小物体，再让用户选干净板 or 遮罩跟随。 */
async function opErasePlan(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const resolution = await timelineResolution(ctx, signal)
  const { planErase, classifyEraseTarget } = await importFresh('lib/erase_plan.mjs')
  const box = args.box ?? { x: 0, y: 0, w: Math.round(resolution.width * 0.27), h: Math.round(resolution.height * 0.77) }
  const classification = classifyEraseTarget({ box, frameWidth: resolution.width, frameHeight: resolution.height })
  const plan = planErase({
    box,
    frameWidth: resolution.width,
    frameHeight: resolution.height,
    fps,
    durationSec: Number(args.durationSec) || 6,
    size: args.size ?? 'auto',
    method: args.method ?? 'auto',
    protectBox: args.protectBox ?? null,
  })
  return { ok: true, demo: true, fps, resolution, box, classification, plan }
}

/** 异物锁定：用户在某一帧选一个框/点 → 逐帧跟踪 → 判断静态还是动态。 */
/** 取一张静帧给用户框选（用户先在 Resolve 里把播放头停到那帧）。 */
/**
 * 遮罩验证：把某个节点临时关掉再打开，两帧差分 = 该节点「实际影响到的区域」（= 遮罩）。
 * 这是脚本层面唯一能证明「遮罩真的存在且选到了正确区域」的方式（没有 mask 回读接口）。
 */
/**
 * 原生做法：在片段的 Fusion 合成里加「贴图 Loader + Transform 关键帧 + Merge(alpha)」，
 * 把图案按逐帧跟踪坐标贴在衣服上（不是生成新视频替换原片）。
 */
/** 合规擦除：Fusion 里用「干净板 + 人物 matte」alpha 合成，原素材不动、不重编码。 */
async function opEraseFusion(ctx, args, signal) {
  const { item } = await resolveItemContext(ctx, signal, args.itemId)
  const plate = String(args.platePng ?? '')
  const matte = String(args.matteSeq ?? '')
  if (!plate || !matte) throw new Error('erase.fusion 需要 platePng 与 matteSeq')
  const scope = scopeOf(item.id)
  const call = (action, extra) => settle(callTool(ctx, 'fusion_comp', { action, ...extra, ...scope }, signal))
  const problems = []
  for (const [type, name] of [['Loader', 'CleanPlate'], ['Loader', 'EraseMatte'], ['Merge', 'EraseMerge']]) {
    const r = await call('add_tool', { tool_type: type, name, x: -2, y: 0 })
    if (!r.ok) problems.push(`add ${name}: ${messageOf(r.error)}`)
  }
  const setIn = async (tool, input, value) => { const r = await call('set_input', { tool_name: tool, input_name: input, value }); if (!r.ok) problems.push(`set ${tool}.${input}: ${messageOf(r.error)}`) }
  await setIn('CleanPlate', 'Clip', plate)
  await setIn('EraseMatte', 'Clip', matte)
  const connect = async (target, input, source) => { const r = await call('connect', { target_tool: target, input_name: input, source_tool: source }); if (!r.ok) problems.push(`connect ${target}.${input}←${source}: ${messageOf(r.error)}`) }
  await connect('EraseMerge', 'Background', 'MediaIn1')
  await connect('EraseMerge', 'Foreground', 'CleanPlate')
  await connect('EraseMerge', 'EffectMask', 'EraseMatte')
  await connect('MediaOut1', 'Input', 'EraseMerge')
  return {
    ok: problems.length === 0,
    problems,
    comp: 'MediaIn1 → EraseMerge(Background)；CleanPlate(Loader) → EraseMerge.Foreground；EraseMatte(Loader 序列) → EraseMerge.EffectMask → MediaOut1',
    note: '原素材未改动：Fusion 内部 alpha 合成干净板，时间线仍是原 C51 片段',
    assets: { plate, matte },
  }
}

/**
 * 黑柔/白柔（Pro-Mist 类扩散）：Color 页节点做不了空间模糊，所以走 Fusion 的 Glow 节点。
 * - white-mist：高光溢散大、整体轻提亮（白柔/雾化）
 * - black-mist：只让高光溢出、暗部保留（黑柔）
 */
async function opTextureMist(ctx, args, signal) {
  const { item } = await resolveItemContext(ctx, signal, args.itemId)
  const mode = args.mode === 'black' ? 'black' : 'white'
  const strength = Math.min(1, Math.max(0.05, Number(args.strength) || 0.35))
  const comps = await settle(callTool(ctx, 'timeline_item_fusion', { action: 'get_comp_names', ...scopeOf(item.id) }, signal))
  let compNames = comps.ok ? (comps.value?.names ?? []) : []
  if (compNames.length === 0) {
    const added = await settle(callTool(ctx, 'timeline_item_fusion', { action: 'add_comp', ...scopeOf(item.id) }, signal))
    if (!added.ok) return { ok: false, step: 'add_comp', error: messageOf(added.error) }
    const again = await settle(callTool(ctx, 'timeline_item_fusion', { action: 'get_comp_names', ...scopeOf(item.id) }, signal))
    compNames = again.ok ? (again.value?.names ?? []) : []
  }
  if (compNames.length === 0) return { ok: false, step: 'no_comp', error: '该片段仍然没有 Fusion 合成（add_comp 返回成功但读不到）' }
  const call = (action, extra) => settle(callTool(ctx, 'fusion_comp', { action, ...extra, ...scopeOf(item.id) }, signal))
  let add = await call('add_tool', { tool_type: 'Glow', name: 'MistGlow', x: -1, y: 1 })
  if (!add.ok) {
    await settle(callTool(ctx, 'timeline_item_fusion', { action: 'add_comp', ...scopeOf(item.id) }, signal))
    add = await call('add_tool', { tool_type: 'Glow', name: 'MistGlow2', x: -1, y: 1 })
  }
  if (!add.ok) {
    const tools = await call('get_tool_list', {})
    return { ok: false, step: 'add_glow', error: messageOf(add.error), tools: tools.ok ? tools.value?.count ?? null : null }
  }
  // Fusion Glow：Threshold/Gain/Size 是最常改的三个；黑白柔差异在这里
  const inputs = mode === 'black'
    ? { Threshold: 0.55, Gain: strength, Size: 2.5 }
    : { Threshold: 0.35, Gain: strength * 1.2, Size: 9.0 }
  const toolName = add.ok ? (add.value?.tool_name ?? 'MistGlow') : 'MistGlow'
  const applied = {}
  for (const [key, value] of Object.entries(inputs)) {
    const r = await call('set_input', { tool_name: toolName, input_name: key, value })
    applied[key] = r.ok ? value : messageOf(r.error)
  }
  const links = [
    [toolName, 'Input', 'MediaIn1'],
    ['MediaOut1', 'Input', toolName],
  ]
  const problems = []
  for (const [target, input, source] of links) {
    const r = await call('connect', { target_tool: target, input_name: input, source_tool: source })
    if (!r.ok) problems.push(`connect ${target}.${input}←${source}: ${messageOf(r.error)}`)
  }
  debugPush({ stage: '质感', message: `${mode === 'black' ? '黑柔' : '白柔'}（强度 ${strength}）：Fusion Glow 节点，高光溢散${mode === 'black' ? '、暗部保留' : ' + 轻微雾化'}` })
  return {
    ok: problems.length === 0,
    mode,
    strength,
    applied,
    problems,
    comp: 'MediaIn1 → MistGlow(Glow) → MediaOut1（原素材不动，Resolve 原生渲染）',
    note: mode === 'black' ? '黑柔：高光溢散、暗部保留' : '白柔：高光溢散 + 轻微雾化',
  }
}

async function opOverlayFusion(ctx, args, signal) {
  const { item } = await resolveItemContext(ctx, signal, args.itemId)
  const png = String(args.pngPath ?? '')
  if (!png) throw new Error('overlay.fusion 需要 pngPath（透明底贴图）')
  const frames = Array.isArray(args.frames) ? args.frames : []
  if (frames.length < 2) throw new Error('overlay.fusion 需要 frames: [{t, x, y, w, h}]（逐帧跟踪框）')
  if (args.rebuild) {
    const names = await settle(callTool(ctx, 'timeline_item_fusion', { action: 'get_comp_names', ...scopeOf(item.id) }, signal))
    for (const name of (names.ok ? names.value?.names ?? [] : [])) {
      await settle(callTool(ctx, 'timeline_item_fusion', { action: 'delete_comp', name, ...scopeOf(item.id) }, signal))
    }
  }
  const comp = await settle(callTool(ctx, 'timeline_item_fusion', { action: 'add_comp', ...scopeOf(item.id) }, signal))
  if (!comp.ok) return { ok: false, step: 'add_comp', error: messageOf(comp.error) }
  const exists = frames[0]
  const mediaIn = 'MediaIn1'
  const mediaOut = 'MediaOut1'
  const newTool = async (type, name, x, y) => {
    const r = await settle(callTool(ctx, 'fusion_comp', { action: 'add_tool', tool_type: type, name, x, y, ...scopeOf(item.id) }, signal))
    return r
  }
  const merged = await settle(callTool(ctx, 'fusion_comp', { action: 'add_tool', tool_type: 'Merge', name: 'Merge1', x: 0, y: 0, ...scopeOf(item.id) }, signal))
  if (args.sequencePng) {
    const ldSeq = await settle(callTool(ctx, 'fusion_comp', { action: 'add_tool', tool_type: 'Loader', name: 'FishSeq', x: -2, y: 0, ...scopeOf(item.id) }, signal))
    if (!ldSeq.ok) return { ok: false, step: 'add_loader', error: messageOf(ldSeq.error) }
    await settle(callTool(ctx, 'fusion_comp', { action: 'set_input', tool_name: 'FishSeq', input_name: 'Clip', value: String(args.sequencePng), ...scopeOf(item.id) }, signal))
    await settle(callTool(ctx, 'fusion_comp', { action: 'connect', target_tool: 'Merge1', input_name: 'Background', source_tool: 'MediaIn1', ...scopeOf(item.id) }, signal))
    await settle(callTool(ctx, 'fusion_comp', { action: 'connect', target_tool: 'Merge1', input_name: 'Foreground', source_tool: 'FishSeq', ...scopeOf(item.id) }, signal))
    await settle(callTool(ctx, 'fusion_comp', { action: 'connect', target_tool: 'MediaOut1', input_name: 'Input', source_tool: 'Merge1', ...scopeOf(item.id) }, signal))
    return { ok: true, mode: 'sequence-loader', comp: 'MediaIn1 → Merge(背景) / FishSeq(逐帧透明 PNG 序列 Loader) → Merge(前景) → MediaOut1', note: '位置/大小已在序列里烘焙好，Fusion 只做 alpha 合成，不替换原视频' }
  }
  const tr = await settle(callTool(ctx, 'fusion_comp', { action: 'add_tool', tool_type: 'Transform', name: 'Xf1', x: -1, y: 0, ...scopeOf(item.id) }, signal))
  const ld = await settle(callTool(ctx, 'fusion_comp', { action: 'add_tool', tool_type: 'Loader', name: 'Fish', x: -2, y: 0, ...scopeOf(item.id) }, signal))
  const problems = []
  for (const r of [merged, tr, ld]) if (!r.ok) problems.push(messageOf(r.error))
  if (problems.length) return { ok: false, step: 'add_tool', errors: problems }
  const setInputs = async (tool, inputs) => {
    for (const [key, value] of Object.entries(inputs)) {
      await settle(callTool(ctx, 'fusion_comp', { action: 'set_input', tool_name: tool, input_name: key, value, ...scopeOf(item.id) }, signal))
    }
  }
  await setInputs('Fish', { Clip: png })
  const link = async (target, input, source) => {
    const r = await settle(callTool(ctx, 'fusion_comp', { action: 'connect', target_tool: target, input_name: input, source_tool: source, ...scopeOf(item.id) }, signal))
    if (!r.ok) problems.push(`connect ${target}.${input}: ${messageOf(r.error)}`)
  }
  await link('Merge1', 'Background', mediaIn)
  await link('Xf1', 'Input', 'Fish')
  await link('Merge1', 'Foreground', 'Xf1')
  await link('MediaOut1', 'Input', 'Merge1')
  // 关键帧：Transform Center 用归一化坐标（Y 轴向上），Size 用贴图相对缩放
  const keyTimes = frames.map((frame) => Number(frame.t))
  const fps = args.fps ?? 24
  const keyframes = frames.map((frame) => {
    // 实测：Fusion Transform 的 Center Y 是「向下」的（不是 Fusion 常见的 Y 向上）
    const scale = ((Number(frame.w) * (args.fishRatio ?? 0.62)) / (args.pngWidth ?? 1200)) * (args.sizeCalibration ?? 1)
    return {
      t: Number(frame.t),
      center: [(Number(frame.x) + Number(frame.w) / 2) / (args.frameWidth ?? 1920), (Number(frame.y) + Number(frame.h) * 0.42) / (args.frameHeight ?? 1012)],
      size: Number(scale.toFixed(4)),
    }
  })
  for (const frame of keyframes) {
    const time = Number((frame.t * fps).toFixed(0))
    await settle(callTool(ctx, 'fusion_comp', { action: 'add_keyframe', tool_name: 'Xf1', input_name: 'Center', time, value: frame.center, ...scopeOf(item.id) }, signal))
    await settle(callTool(ctx, 'fusion_comp', { action: 'add_keyframe', tool_name: 'Xf1', input_name: 'Size', time, value: frame.size, ...scopeOf(item.id) }, signal))
  }
  // Center/Size 已被关键帧驱动，不要再用静态值覆盖
  return {
    ok: problems.length === 0,
    problems,
    comp: 'Fusion 合成：MediaIn → Merge(背景) / Fish(Loader) → Xf1(Transform 关键帧) → Merge(前景) → MediaOut',
    keyframeCount: keyframes.length,
    note: '原生 Fusion 贴图：图案走 alpha 合到原片段上，不改原素材、不生成替换视频',
  }
}

async function opMaskVerify(ctx, args, signal) {
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  const seek = await seekToItem(ctx, signal, item.id)
  if (!seek.ok) throw new Error(`无法定位片段：${seek.error}`)
  const nodesOutcome = await settle(callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scopeOf(item.id) }, signal))
  const nodes = (nodesOutcome.ok ? nodesOutcome.value?.nodes : []) ?? []
  if (nodes.length === 0) return { ok: false, reason: '该片段没有节点图' }
  let target = null
  if (Number.isFinite(args.nodeIndex)) target = nodes.find((node) => Number(node.node_index) === Number(args.nodeIndex))
  if (!target) {
    target = nodes.find((node) => (node.tools ?? []).some((tool) => /限定器|qualifier|HSL/i.test(String(tool))))
  }
  if (!target) return { ok: false, reason: '没有找到带限定器（遮罩）的节点；可传 nodeIndex 指定', nodes: nodes.map((node) => ({ index: node.node_index, label: node.label, tools: node.tools })) }
  const nodeIndex = Number(target.node_index)

  const before = await captureRenderedFrame(ctx, signal, 'mask-before')
  await settle(callTool(ctx, 'graph', { action: 'set_node_enabled', node_index: nodeIndex, enabled: false, source: 'item', ...scopeOf(item.id) }, signal))
  const offFrame = await captureRenderedFrame(ctx, signal, 'mask-off')
  await settle(callTool(ctx, 'graph', { action: 'set_node_enabled', node_index: nodeIndex, enabled: true, source: 'item', ...scopeOf(item.id) }, signal))

  const dir = await ensureDataDir(path.join('frames', 'mask'))
  const diffPath = path.join(dir, `mask-diff-${stamp()}.png`)
  // 差分热图：差异 > ~2% 显示为白，便于肉眼确认遮罩形状
  await run('ffmpeg', [
    '-v', 'error', '-i', before.path, '-i', offFrame.path,
    '-filter_complex', "[0][1]blend=all_mode=difference,format=gray,curves=all='0/0 0.02/0 0.10/1 1/1'[d]",
    '-map', '[d]', '-frames:v', '1', '-y', diffPath,
  ], { timeoutMs: 120_000 })
  const decoded = await (async () => {
    try {
      const { decodeSmall } = await importFresh('lib/gradeguard.mjs')
      return await decodeSmall(diffPath, 320)
    } catch {
      return null
    }
  })()
  let coveragePct = null
  let bbox = null
  if (decoded) {
    const { width, height, data } = decoded
    let hit = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const value = data[(y * width + x) * 3]
        if (value > 24) {
          hit += 1
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }
    coveragePct = Number(((hit / (width * height)) * 100).toFixed(2))
    if (hit > 0) bbox = { x: minX / width, y: minY / height, w: (maxX - minX) / width, h: (maxY - minY) / height }
  }
  return {
    ok: true,
    itemId: item.id,
    itemName: info.name,
    nodeIndex,
    nodeLabel: target.label,
    tools: target.tools ?? [],
    coveragePct,
    bbox,
    diffPath,
    frames: { before: before.path, off: offFrame.path },
    note: coveragePct == null
      ? '生成了差分图，但解码失败'
      : coveragePct < 0.01
        ? '开关该节点画面没有差异：这个遮罩实际上没有生效（或作用区域为 0）'
        : '差分区域就是该节点遮罩实际作用的范围（已恢复节点开关）',
  }
}

async function opEraseStill(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  const size = info.filePath ? await probeMediaSize(info.filePath) : null
  const fullWidth = size?.width ?? (await timelineResolution(ctx, signal)).width
  const fullHeight = size?.height ?? (await timelineResolution(ctx, signal)).height
  const playhead = await settle(callTool(ctx, 'timeline_markers', { action: 'get_current_timecode' }, signal))
  const current = await settle(callTool(ctx, 'timeline', { action: 'get_current' }, signal))
  const timecode = playhead.ok ? playhead.value?.timecode ?? null : null
  const parseFrames = (tc) => {
    const parts = String(tc ?? '').split(':').map((value) => Number.parseInt(value, 10))
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
    return ((parts[0] * 3600 + parts[1] * 60 + parts[2]) * fps) + parts[3]
  }
  const playheadFrame = parseFrames(timecode)
  const timelineStart = Number(current.ok ? current.value?.start_frame ?? 0 : 0) || 0
  const itemStart = Number(info.recordStart ?? 0) || 0
  const offsetSec = playheadFrame != null ? Math.max(0, (playheadFrame - timelineStart - (itemStart - timelineStart)) / fps) : 0
  const captured = await captureRenderedFrame(ctx, signal, 'erase-still')
  const width = Math.max(480, Math.min(1280, Number(args.width) || 960))
  const dir = await ensureDataDir(path.join('frames', 'erase-still'))
  const outPath = path.join(dir, `still-${stamp()}.jpg`)
  await run('ffmpeg', ['-v', 'error', '-i', captured.path, '-vf', `scale=${width}:-2`, '-frames:v', '1', '-q:v', '3', '-y', outPath], { timeoutMs: 60_000 })
  const bytes = await fs.readFile(outPath)
  return {
    ok: true,
    dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`,
    width,
    height: Math.round((width * fullHeight) / fullWidth),
    fullWidth,
    fullHeight,
    scale: Number((fullWidth / width).toFixed(4)),
    itemId: item.id,
    itemName: info.name,
    timecode,
    offsetSec: Number(offsetSec.toFixed(3)),
    sourceSeconds: Number((((Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps) + offsetSec).toFixed(3)),
    path: outPath,
    hint: '在图上拖拽框选异物；框坐标会自动换算回原始分辨率',
  }
}

async function opEraseLock(ctx, args, signal) {
  const fps = await projectFps(ctx, signal)
  const { item, info } = await resolveItemContext(ctx, signal, args.itemId)
  if (!info.filePath) throw new Error('片段没有可读源文件')
  const resolution = await timelineResolution(ctx, signal)
  const frameCount = Math.max(3, Math.min(16, Number(args.frames) || 8))
  const rangeStart = Number.isFinite(args.rangeStartSec) ? Number(args.rangeStartSec) : 0
  const rangeDuration = Number.isFinite(args.rangeEndSec) ? Math.max(0.3, Number(args.rangeEndSec) - rangeStart) : Math.max(0.3, info.duration / fps - rangeStart)
  const baseStart = (Number.isFinite(info.sourceStartFrame) ? info.sourceStartFrame : 0) / fps + rangeStart
  const dir = await ensureDataDir(path.join('frames', `erase-lock-${stamp()}`))
  const times = Array.from({ length: frameCount }, (_, index) => baseStart + (rangeDuration * (index + 0.5)) / frameCount)
  const paths = await extractFramesAt(info.filePath, times, dir, resolution.width)
  // 初始框：用户给的 box（按时间线像素）/ 或点 → 以点为中心取 80×80（按 1920 宽折算）
  let box = null
  if (args.box) box = { x: Number(args.box.x), y: Number(args.box.y), w: Number(args.box.w), h: Number(args.box.h) }
  else if (args.point) {
    const w = Math.max(24, Number(args.size) || 90)
    box = { x: Math.max(0, Number(args.point.x) - w / 2), y: Math.max(0, Number(args.point.y) - w / 2), w, h: w }
  }
  if (!box) throw new Error('erase.lock 需要 box 或 point（用户在预览帧上点选的位置）')
  // 抽帧宽度是 resolution.width，用户坐标按时间线像素给 → 同比缩放
  const frameWidth = resolution.width
  const scale = 1
  const scaledBox = { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale }
  const { trackBox } = await importFresh('lib/cutout.mjs')
  const tracked = await trackBox(paths[0], scaledBox, paths.slice(1))
  const trackedFrames = [{ path: paths[0], ...scaledBox, confidence: 1 }, ...(tracked.frames ?? [])]
  const centers = trackedFrames.map((frame) => ({ x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }))
  const drift = centers.length > 1
    ? Math.max(...centers.map((center) => Math.hypot(center.x - centers[0].x, center.y - centers[0].y)))
    : 0
  const staticMode = drift < Math.max(6, scaledBox.w * 0.15)
  return {
    ok: true,
    itemId: item.id,
    itemName: info.name,
    mode: staticMode ? 'static' : 'dynamic',
    driftPx: Number(drift.toFixed(1)),
    frames: trackedFrames.map((frame, index) => ({ t: Number((times[index] ?? 0).toFixed(2)), x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.w), h: Math.round(frame.h), confidence: frame.confidence ?? null })),
    recommendation: staticMode
      ? '物体基本不动：用 clean plate（时间中位数）或固定 delogo 框'
      : '物体在动：用逐帧跟踪框 + 分段 delogo（或后续接 Fusion 的跟踪擦除）',
    note: '锁定结果供 erase.apply 使用；动态物体不要用固定框，会把背景一起擦掉',
  }
}

/** 素材交接：把本地文件/文件夹导入 Resolve 素材池（剪辑入口的第一步）。 */
async function opMediaImport(ctx, args, signal) {
  const raw = Array.isArray(args.paths) ? args.paths : [args.path].filter(Boolean)
  const paths = raw.map((item) => String(item).trim()).filter(Boolean)
  if (!paths.length) throw new Error('media.import 需要 paths（文件或文件夹路径）')
  const existing = []
  const missing = []
  for (const candidate of paths) {
    if (await fs.stat(candidate).catch(() => null)) existing.push(candidate)
    else missing.push(candidate)
  }
  if (!existing.length) return { ok: false, imported: 0, missing, error: '路径都不存在' }
  const imported = []
  const errors = []
  // 分批导入（大批量一次会超时，实测 10 个/批）
  for (let index = 0; index < existing.length; index += 10) {
    const batch = existing.slice(index, index + 10)
    const result = await settle(callTool(ctx, 'media_pool', { action: 'safe_import_media', paths: batch }, signal))
    if (result.ok) {
      for (const clip of result.value?.clips ?? []) imported.push({ name: clip.name, id: clip.id, duration: clip.duration })
    } else {
      errors.push(messageOf(result.error))
    }
  }
  const folder = await settle(callTool(ctx, 'media_pool', { action: 'probe_media_pool', depth: 1 }, signal))
  // 素材提交后自动体检色彩管线（读项目设置 + Resolve 偏好），有问题的项直接告诉用户能不能一键修
  let pipeline = null
  try {
    const snapshot = await opPipelineSnapshot(ctx, {}, signal)
    const diagnosis = diagnosePipeline(snapshot)
    pipeline = {
      ok: (diagnosis.findings ?? []).length === 0,
      science: snapshot?.settings?.value?.settings?.colorScienceMode ?? null,
      findings: (diagnosis.findings ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        severity: item.severity,
        fixable: Boolean(item.recommended && (item.autoFix || (item.recommended.key && ['colorScience','colorScienceMode','timelineLuminance','timelineWorkingLuminanceMode','colorSpaceTimeline','timelineColorSpace','outputColorSpace','colorSpaceOutput','colorSpaceOutputGamma','hdrTimeline'].includes(item.recommended.key ?? item.recommended.name)))),
        recommend: item.recommended?.value ?? item.manual ?? null,
      })),
      fixableCount: (diagnosis.findings ?? []).filter((item) => item.recommended).length,
    }
  } catch (error) {
    pipeline = { ok: null, error: messageOf(error) }
  }
  return {
    pipeline,
    ok: imported.length > 0,
    importedCount: imported.length,
    clips: imported.slice(0, 20),
    missing,
    errors,
    mediaPool: folder.ok ? { clips: folder.value?.clipCount ?? null } : null,
    next: '素材已进素材池；接着可以用 story.transcribe/story.plan 出剪辑方案',
  }
}

/** 生成可直接提交的问题反馈（环境 + 最近调试日志），返回 GitHub Issue 预填链接。 */
async function opFeedbackIssue(ctx, args, signal) {
  const deps = await opDepsCheck(ctx, {}, signal).catch(() => null)
  const since = Number(args?.since) || 0
  const entries = DEBUG_LOG.filter((entry) => entry.seq > since).slice(-80)
  const logText = entries.map((entry) => `- [${entry.stage}] ${entry.node ? entry.node + ' · ' : ''}${entry.tool ? entry.tool + ' · ' : ''}${entry.message ?? ''}${entry.purpose ? '（目的：' + entry.purpose + '）' : ''}`).join('\n')
  const title = `[Bug] ${String(args?.summary ?? '使用反馈').slice(0, 80)}`
  const body = [
    '### 发生了什么',
    String(args?.detail ?? '').slice(0, 4000) || '（请补充：哪个按钮、什么现象、期望结果）',
    '',
    '### 复现步骤',
    '1. ',
    '2. ',
    '',
    '### 环境',
    '```json',
    JSON.stringify({ platform: deps?.platform ?? process.platform, mcp: deps?.mcp, resolveApp: deps?.resolveApp, binaries: deps?.binaries, pluginVersion: '0.11.0' }, null, 2),
    '```',
    '',
    '### 调试日志（最近）',
    '```',
    logText || '（无）',
    '```',
  ].join('\n')
  const url = `https://github.com/JiangXingchen4210/Davinci_MCP_DSH_Demo/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body.slice(0, 7000))}`
  const dir = await ensureDataDir('feedback')
  const file = path.join(dir, `feedback-${stamp()}.md`)
  await fs.writeFile(file, `# ${title}\n\n${body}\n`, 'utf8').catch(() => null)
  debugPush({ stage: '反馈', message: `已生成反馈草稿：${file}` })
  return { ok: true, url, file, markdown: `# ${title}\n\n${body}` }
}

function opDebugLog(ctx, args) {
  const since = Number(args?.since) || 0
  const entries = DEBUG_LOG.filter((entry) => entry.seq > since)
  return { entries, lastSeq: DEBUG_LOG.length ? DEBUG_LOG[DEBUG_LOG.length - 1].seq : 0, total: DEBUG_LOG.length }
}
function opDebugClear() {
  DEBUG_LOG.length = 0
  return { ok: true }
}

async function opOpsList(ctx, args, signal) {
  return { ops: Object.keys(OPS).sort() }
}

// ---------------------------------------------------------------------------
// 动作分派
// ---------------------------------------------------------------------------

const OPS = {
  ...BASE_OPS,
  'pipeline.snapshot': opPipelineSnapshot,
  'pipeline.diagnose': opPipelineDiagnose,
  'pipeline.fix': opPipelineFix,
  'ref.import': opRefImport,
  'ref.list': opRefList,
  'look.capture': opLookCapture,
  'look.measure': opLookMeasure,
  'look.plan': opLookPlan,
  'look.apply': opLookApply,
  'look.auto': opLookAuto,
  'scenes.scan': opScenesScan,
  'grade.tiers': opGradeTiers,
  'edit.auto': opEditAuto,
  'mask.cutout': opMaskCutout,
  'erase.detect': opEraseDetect,
  'erase.render': opEraseRender,
  'env.status': opEnvStatus,
  'env.install': opEnvInstall,
  'env.selftest': opEnvSelfTest,
  'story.transcribe': opStoryTranscribe,
  'story.plan': opStoryPlan,
  'edit.story': opEditStory,
  'export.check': opExportCheck,
  'media.import': opMediaImport,
  'preview.render': opPreviewRender,
  'preview.live': opPreviewLive,
  'preview.compare': opPreviewCompare,
  'lut.library': opLutLibrary,
  'lut.installBundle': opLutInstallBundle,
  'lut.ensure': opLutEnsure,
  'lut.acquire': opLutAcquire,
  'texture.mist': opTextureMist,
  'overlay.fusion': opOverlayFusion,
  'erase.fusion': opEraseFusion,
  'mask.verify': opMaskVerify,
  'erase.still': opEraseStill,
  'erase.build': opEraseBuild,
  'ui.openSettings': opUiOpenSettings,
  'erase.plan': opErasePlan,
  'erase.lock': opEraseLock,
  'docs.import': opDocsImport,
  'docs.list': opDocsList,
  'docs.get': opDocsGet,
  'grade.unify': opGradeUnify,
  'grade.build3': opGradeBuild3,
  'grade.rebuildAll': opGradeRebuildAll,
  'preflight.check': opPreflightCheck,
  'restore.resolve': opRestoreResolve,
  'restore.apply': opRestoreApply,
  'restore.download': opRestoreDownload,
  'restore.ensure': opRestoreEnsure,
  'grade.nodeReport': opGradeNodeReport,
  'style.oneClick': opStyleOneClick,
  'style.catalog': async (ctx, args, signal) => { const { listStyles } = await importFresh('lib/stylelib.mjs'); return { ok: true, styles: listStyles() } },
  'render.deliver': opRenderDeliver,
  'resolve.background': opResolveBackground,
  'pipeline.oneClickFix': opPipelineOneClickFix,
  'face.grade': opFaceGrade,
  'audio.takes': opAudioTakes,
  'face.track': opFaceTrack,
  'grade.verify': opGradeVerify,
  'style.list': opStyleList,
  'style.apply': opStyleApply,
  'look.plan8': opLookPlan8,
  'look.apply8': opLookApply8,
  'scenes.unify': opScenesUnify,
  'scenes.group': opScenesGroup,
  'erase.clean': opEraseClean,
  'overlay.perspective': opOverlayPerspective,
  'camera.detect': opCameraDetect,
  'camera.fix': opCameraFix,
  'camera.list': opCameraList,
  'raw.apply': opRawApply,
  'vibe.run': opVibeRun,
  'overlay.plan': opOverlayPlan,
  'overlay.render': opOverlayRender,
  'deps.check': opDepsCheck,
  'feedback.issue': opFeedbackIssue,
  'debug.log': opDebugLog,
  'debug.clear': opDebugClear,
  'ops.list': opOpsList,
}

async function runOp(ctx, op, args, signal) {
  const handler = OPS[op]
  if (typeof handler !== 'function') throw new Error(`未知动作：${String(op)}`)
  return handler(ctx, args ?? {}, signal)
}

function createRoute(ctx) {
  return async (request, response) => {
    if (!isLoopback(request)) {
      sendJson(response, 403, { ok: false, error: { message: '只接受本机请求' } })
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (request.headers['x-davinci-panel'] !== '1') {
      sendJson(response, 403, { ok: false, error: { message: '缺少面板请求头' } })
      return
    }
    let body
    try {
      const text = await readBody(request, MAX_BODY_BYTES)
      body = text ? JSON.parse(text) : {}
    } catch (error) {
      sendJson(response, 400, { ok: false, error: { message: `请求解析失败：${messageOf(error)}` } })
      return
    }
    const op = typeof body?.op === 'string' ? body.op : ''
    const args = body?.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {}
    if (!Object.hasOwn(OPS, op)) {
      sendJson(response, 400, { ok: false, error: { message: `未知动作：${op}` } })
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('调用超时')), CALL_TIMEOUT_MS)
    try {
      const value = await runOp(ctx, op, args, controller.signal)
      sendJson(response, 200, { ok: true, op, value })
    } catch (error) {
      sendJson(response, 200, { ok: false, op, error: { message: messageOf(error) } })
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 内嵌预览的媒体路由：GET /davinci-panel/media?path=…
 * 只允许 DATA_DIR 下几个子目录（防止任意文件读取），支持 Range（<video> 拖动进度条要用）。
 */
function createMediaRoute() {
  const allowedRoots = ['previews', 'frames', 'overlays', 'clean', 'thumbs'].map((sub) => path.join(DATA_DIR, sub))
  return async (request, response) => {
    if (!isLoopback(request)) {
      sendJson(response, 403, { ok: false, error: { message: '只接受本机请求' } })
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const rawPath = url.searchParams.get('path') ?? ''
    if (!rawPath) {
      sendJson(response, 400, { ok: false, error: { message: '缺少 path' } })
      return
    }
    const target = path.resolve(rawPath)
    const allowed = allowedRoots.some((root) => target === root || target.startsWith(root + path.sep))
    if (!allowed) {
      sendJson(response, 403, { ok: false, error: { message: '只允许预览/帧/贴图目录下的文件' } })
      return
    }
    let stat
    try {
      stat = await fs.stat(target)
    } catch {
      sendJson(response, 404, { ok: false, error: { message: '文件不存在' } })
      return
    }
    if (!stat.isFile()) {
      sendJson(response, 400, { ok: false, error: { message: '不是文件' } })
      return
    }
    const ext = path.extname(target).toLowerCase()
    const type =
      ext === '.mp4' ? 'video/mp4' :
      ext === '.mov' ? 'video/quicktime' :
      ext === '.webm' ? 'video/webm' :
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      'application/octet-stream'
    const range = request.headers.range
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(String(range))
      const start = match && match[1] ? Number(match[1]) : 0
      const end = match && match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1
      if (start >= stat.size || start > end) {
        response.writeHead(416, { 'content-range': `bytes */${stat.size}` })
        response.end()
        return
      }
      response.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      })
      createReadStream(target, { start, end }).pipe(response)
      return
    }
    response.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    })
    createReadStream(target).pipe(response)
  }
}

function panelTool(ctx) {
  return {
    name: 'davinci_panel',
    description:
      '操作 DaVinci 控制台（与 Web 面板同一套动作，全部经已配置的 Resolve MCP）：' +
      '基础调色/效果（CDL、look、版本、复制、变换/裁剪/不透明度、Fusion 模糊）、' +
      '深度色调匹配（抓帧、分层统计、参考帧匹配、生成并应用多层 .drx）、' +
      '色彩管线体检与修复（含 macOS 709-A）。op 见参数枚举。',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', description: '动作名。', enum: Object.keys(OPS) },
        args: { type: 'object', description: '动作参数，见各动作说明。', additionalProperties: true },
      },
      required: ['op'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const op = typeof args?.op === 'string' ? args.op : ''
      const opArgs = args?.args && typeof args.args === 'object' ? args.args : {}
      return runOp(ctx, op, opArgs, exec.signal)
    },
  }
}

/**
 * 注册路由与工具，并把数据目录准备好。
 * @param ctx - 已注入 webServer 与 tools 的 Host Context。
 */
export function apply(ctx) {
  ctx.effect(
    () => {
      void ensureDataDir('').catch(() => undefined)
      return ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: createRoute(ctx) })
    },
    'resolve-console: action route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: MEDIA_PATH, handler: createMediaRoute() }),
    'resolve-console: media route',
  )
  ctx.effect(() => ctx.tools.register(panelTool(ctx)), 'resolve-console: panel tool')
}
