/**
 * lib/scenegroup.mjs — 镜头 → 语义「场」（纯函数、零依赖、无子进程、ESM）。
 *
 * 回答两个用户原话：
 *   1.「一共有几场戏？」→ groupScenes().sceneCount
 *   2.「这是哪场戏？」 → scene.label / describeScenes().perScene
 *
 * 输入取 lib/scenes.mjs 的 scan 结果：
 *   shot = { index, start, end, duration, frames:[路径], metrics:{ lumaMean, lumaMin, lumaMax, saturationMean, greenDominance, … } }
 * 可选 visualByIndex（上层模型看图后填）：
 *   { description, keywords:[…], location, subject, timeOfDay }
 * metrics 里若再带 warmth / meanHuePercent / hueDegrees / sharpness / motion / stability 也一并利用。
 *
 * 分场规则（每条都写进 scene.basis，可解释）：
 *   硬边界：visual.location 变 / visual.timeOfDay 变 / 相邻 lumaMean 差 > 0.18 / dominantTone 变
 *   软边界：无硬边界，但相邻镜头 start 间隔 > 120s（同 location 同色调也切）
 *   其余并入当前场
 * 没有 visual 时只用指标推断，basis 里会明确写「仅指标推断」，不假装有语义证据。
 *
 * 单位：秒（与 lib/scenes.mjs、lib/edit3.mjs 一致）。本模块不猜 fps、不读写文件。
 *
 * 运行自测：node lib/scenegroup.test.mjs
 */

export const VERSION = '1.0.0'

/** 分场阈值（都可在 options 里覆盖）。 */
export const DEFAULTS = Object.freeze({
  lumaJump: 0.18, // 相邻镜头 lumaMean 差超过它 → 硬边界
  softGapSeconds: 120, // 同 location/色调但镜头间隔超过它 → 软边界（<=0 关闭）
  toneStrict: true, // true = 任何可判定的色调差异都切；false = 仅绿/暖/冷强色差才切
  maxActivities: 3, // 每场最多汇总几条活动描述
})

export const TONE_LABEL = Object.freeze({
  warm: '暖色',
  cool: '冷色',
  neutral: '中性',
  green: '绿调',
  dark: '暗调',
})

const GREEN_THRESHOLD = 0.35 // greenDominance ≥ 0.35 → 绿调
const WARM_THRESHOLD = 0.12 // warmth ≥ +0.12 → 暖；≤ -0.12 → 冷
const DARK_LUMA = 0.2 // 亮度 < 0.2 且不饱和 → 暗调

const METRIC_ALIASES = Object.freeze({
  lumaMean: ['lumaMean', 'meanLuma', 'luma'],
  lumaMin: ['lumaMin', 'minLuma'],
  lumaMax: ['lumaMax', 'maxLuma'],
  saturationMean: ['saturationMean', 'meanSat', 'saturation'],
  greenDominance: ['greenDominance', 'green'],
  warmth: ['warmth'],
  meanHuePercent: ['meanHuePercent', 'meanHue', 'huePercent'],
  hueDegrees: ['hueDegrees', 'hueMean'],
  sharpness: ['sharpness', 'sharpnessMean'],
  motion: ['motion', 'motionMean'],
  stability: ['stability'],
})

/** 常见 timeOfDay 归一（中英混写时也能比较出「白天 → 夜晚」）。 */
const TIME_OF_DAY_ALIASES = Object.freeze({
  白天: 'day',
  日: 'day',
  日间: 'day',
  早上: 'morning',
  早晨: 'morning',
  清晨: 'morning',
  日出: 'morning',
  上午: 'morning',
  中午: 'day',
  下午: 'day',
  day: 'day',
  daytime: 'day',
  morning: 'morning',
  dawn: 'morning',
  sunrise: 'morning',
  夜晚: 'night',
  夜: 'night',
  夜里: 'night',
  深夜: 'night',
  晚上: 'night',
  night: 'night',
  nighttime: 'night',
  黄昏: 'dusk',
  傍晚: 'dusk',
  日落: 'dusk',
  dusk: 'dusk',
  sunset: 'dusk',
  黄金时刻: 'golden',
  'golden hour': 'golden',
  golden: 'golden',
})

// ---------------------------------------------------------------------------
// 基础工具（导出给 lib/editscore.mjs 复用，保证两个模块指标口径一致）
// ---------------------------------------------------------------------------

export function finiteOr(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

export function clamp01(value) {
  const num = finiteOr(value, 0)
  return Math.min(1, Math.max(0, num))
}

export function round(value, digits = 3) {
  const num = finiteOr(value, null)
  if (num == null) return null
  const factor = 10 ** digits
  return Math.round(num * factor) / factor
}

/** 镜头序号：显式 index 优先（scenes.scan 是 1 起的），否则用数组下标。 */
export function shotIndexOf(shot, position) {
  const declared = finiteOr(shot?.index, null)
  if (declared != null && Number.isInteger(declared)) return declared
  return position
}

/** 镜头 start（秒）；没有则退回素材 in 点，再没有就 null（不硬猜 0）。 */
export function shotStart(shot) {
  const start = finiteOr(shot?.start, null)
  if (start != null) return start
  const inPoint = finiteOr(shot?.['in'], null)
  if (inPoint != null) return inPoint
  return null
}

/** 镜头 end（秒）：end 优先，其次 start+duration，最后 out 点。 */
export function shotEnd(shot) {
  const end = finiteOr(shot?.end, null)
  if (end != null) return end
  const start = shotStart(shot)
  const duration = shotDurationOf(shot)
  if (start != null && duration != null) return start + duration
  return finiteOr(shot?.['out'], null)
}

/** 镜头时长（秒）：duration 优先，其次 start/end，再次 in/out。 */
export function shotDurationOf(shot) {
  const direct = finiteOr(shot?.duration, null)
  if (direct != null) return Math.max(0, direct)
  const start = finiteOr(shot?.start, null)
  const end = finiteOr(shot?.end, null)
  if (start != null && end != null) return Math.max(0, end - start)
  const inPoint = finiteOr(shot?.['in'], null)
  const outPoint = finiteOr(shot?.['out'], null)
  if (inPoint != null && outPoint != null) return Math.max(0, outPoint - inPoint)
  return null
}

/** 读一个指标（metrics 里优先，也接受顶层同名字段与常见别名），读不到返回 null。 */
export function readMetric(shot, name) {
  const aliases = METRIC_ALIASES[name] ?? [name]
  for (const alias of aliases) {
    const fromMetrics = finiteOr(shot?.metrics?.[alias], null)
    if (fromMetrics != null) return fromMetrics
    const direct = finiteOr(shot?.[alias], null)
    if (direct != null) return direct
  }
  return null
}

// ---------------------------------------------------------------------------
// 色调判定
// ---------------------------------------------------------------------------

function toneFromHueDegrees(hue) {
  const h = ((hue % 360) + 360) % 360
  if (h < 70 || h >= 320) return 'warm'
  if (h < 170) return 'green'
  if (h < 260) return 'cool'
  return null
}

/** edit3 的 0–100 色相刻度：0/100=红、8=橙、17=黄、33=绿、50=青、67=蓝、83=品红。 */
function toneFromHuePercent(huePercent) {
  if (huePercent >= 25 && huePercent <= 42) return 'green'
  if (huePercent >= 48 && huePercent <= 78) return 'cool'
  if (huePercent <= 20 || huePercent >= 88) return 'warm'
  return null
}

/**
 * 单镜头色调 + 证据来源。
 * 只认真正看得到的证据：绿占比 → 暖度 → 色相 → 亮度（暗调）→ 饱和度（中性）。
 * 都没有就返回 source:'none'（调用方据此说「证据不足」而不是硬猜）。
 *
 * @returns {{tone:'warm'|'cool'|'neutral'|'green'|'dark', source:string}}
 */
export function toneDetailOfShot(shot) {
  const green = readMetric(shot, 'greenDominance')
  if (green != null && green >= GREEN_THRESHOLD) return { tone: 'green', source: 'greenDominance' }

  const warmth = readMetric(shot, 'warmth')
  if (warmth != null) {
    if (warmth >= WARM_THRESHOLD) return { tone: 'warm', source: 'warmth' }
    if (warmth <= -WARM_THRESHOLD) return { tone: 'cool', source: 'warmth' }
  }

  const huePercent = readMetric(shot, 'meanHuePercent')
  if (huePercent != null) {
    const tone = toneFromHuePercent(huePercent)
    if (tone) return { tone, source: 'meanHuePercent' }
  }

  const hueDegrees = readMetric(shot, 'hueDegrees')
  if (hueDegrees != null) {
    const tone = toneFromHueDegrees(hueDegrees)
    if (tone) return { tone, source: 'hueDegrees' }
  }

  const luma = readMetric(shot, 'lumaMean')
  const saturation = readMetric(shot, 'saturationMean')
  if (luma != null && luma < DARK_LUMA && (saturation == null || saturation < 0.3)) {
    return { tone: 'dark', source: 'lumaMean' }
  }
  if (luma != null || saturation != null) return { tone: 'neutral', source: 'luma/sat' }
  return { tone: 'neutral', source: 'none' }
}

/** 单镜头色调（字符串简写）。 */
export function toneOfShot(shot) {
  return toneDetailOfShot(shot).tone
}

const STRONG_TONE_SOURCES = new Set(['greenDominance', 'warmth', 'meanHuePercent', 'hueDegrees'])

function hasToneEvidence(detail) {
  return detail.source !== 'none'
}

function isStrongTone(detail) {
  return STRONG_TONE_SOURCES.has(detail.source)
}

// ---------------------------------------------------------------------------
// 视觉标签 / 文本工具
// ---------------------------------------------------------------------------

function isEmptyVisual(visual) {
  if (!visual || typeof visual !== 'object') return true
  return !(
    String(visual.description ?? '').trim() ||
    String(visual.location ?? '').trim() ||
    String(visual.timeOfDay ?? '').trim() ||
    String(visual.subject ?? '').trim() ||
    (Array.isArray(visual.keywords) && visual.keywords.length > 0)
  )
}

function resolveVisual(visualByIndex, index, position, shot) {
  const fromShot = shot?.visual && typeof shot.visual === 'object' ? shot.visual : null
  if (Array.isArray(visualByIndex)) {
    return visualByIndex[index] ?? visualByIndex[position] ?? fromShot
  }
  if (visualByIndex && typeof visualByIndex === 'object') {
    if (visualByIndex[index] != null) return visualByIndex[index]
    if (visualByIndex[String(index)] != null) return visualByIndex[String(index)]
  }
  return fromShot
}

function cleanText(value, max = 40) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const head = text.split(/[，,；;。]/)[0].trim() || text
  return head.length > max ? `${head.slice(0, max)}…` : head
}

function normalizeLocation(value) {
  return String(value ?? '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase()
}

function normalizeTimeOfDay(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return ''
  return TIME_OF_DAY_ALIASES[raw] ?? TIME_OF_DAY_ALIASES[raw.replace(/\s+/g, '')] ?? raw
}

function mostFrequent(values) {
  const counts = new Map()
  let best = ''
  let bestCount = 0
  for (const value of values) {
    if (!value) continue
    const count = (counts.get(value) ?? 0) + 1
    counts.set(value, count)
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

function brightnessLabel(luma) {
  if (luma == null) return ''
  if (luma < 0.15) return '暗场'
  if (luma < 0.32) return '低调'
  if (luma < 0.55) return '中景'
  if (luma < 0.75) return '明亮'
  return '高光'
}

// ---------------------------------------------------------------------------
// groupScenes
// ---------------------------------------------------------------------------

function emptyGroup(note) {
  return {
    shotIndices: [],
    shotObjects: [],
    visuals: [],
    details: [],
    notes: note ? [note] : [],
    merges: 0,
  }
}

function pushGroupShot(group, shot, index, visual, detail) {
  group.shotIndices.push(index)
  group.shotObjects.push(shot)
  group.visuals.push(visual)
  group.details.push(detail)
}

/**
 * 判定当前镜头是否要开新场。返回可解释的原因（写进 scene.basis）。
 *
 * @returns {{split:boolean, notes:string[], boundary:'hard'|'soft'|null, mergeNote:string|null}}
 */
function decideBoundary(prevShot, prevVisual, prevDetail, curShot, curVisual, curDetail, options) {
  const hard = []
  const prevLocation = normalizeLocation(prevVisual?.location)
  const curLocation = normalizeLocation(curVisual?.location)
  let locationNote = ''

  if (prevLocation && curLocation && prevLocation !== curLocation) {
    hard.push(`location 变化：「${cleanText(prevVisual.location)}」→「${cleanText(curVisual.location)}」`)
  } else if (prevLocation && curLocation) {
    locationNote = `location 相同（${cleanText(curVisual.location)}）`
  } else if (!prevLocation && !curLocation) {
    locationNote = 'location 未知'
  } else {
    locationNote = 'location 仅一侧有标签，未据此切分'
  }

  const prevTimeOfDay = normalizeTimeOfDay(prevVisual?.timeOfDay)
  const curTimeOfDay = normalizeTimeOfDay(curVisual?.timeOfDay)
  if (prevTimeOfDay && curTimeOfDay && prevTimeOfDay !== curTimeOfDay) {
    hard.push(
      `timeOfDay 变化：${cleanText(prevVisual.timeOfDay)} → ${cleanText(curVisual.timeOfDay)}`,
    )
  }

  const prevLuma = readMetric(prevShot, 'lumaMean')
  const curLuma = readMetric(curShot, 'lumaMean')
  const lumaJump = finiteOr(options.lumaJump, DEFAULTS.lumaJump)
  let lumaNote
  if (prevLuma != null && curLuma != null) {
    const delta = Math.abs(curLuma - prevLuma)
    if (delta > lumaJump) {
      hard.push(`亮度跳变：${prevLuma.toFixed(2)} → ${curLuma.toFixed(2)}（差 ${delta.toFixed(2)} > ${lumaJump}）`)
      lumaNote = null
    } else {
      lumaNote = `亮度差 ${delta.toFixed(2)} ≤ ${lumaJump}`
    }
  } else {
    lumaNote = '亮度不可比'
  }

  let toneNote = ''
  if (!hasToneEvidence(prevDetail) || !hasToneEvidence(curDetail)) {
    toneNote = '色调证据不足（缺暖度/色相/绿占比），未据此切分'
  } else if (prevDetail.tone !== curDetail.tone) {
    const strict = options.toneStrict !== false
    if (strict || (isStrongTone(prevDetail) && isStrongTone(curDetail))) {
      hard.push(
        `色调变化：${prevDetail.tone} → ${curDetail.tone}（${prevDetail.source} / ${curDetail.source}）`,
      )
      toneNote = null
    } else {
      toneNote = `色调 ${prevDetail.tone} → ${curDetail.tone}，但证据不强，未据此切分`
    }
  } else {
    toneNote = `色调一致（${curDetail.tone}）`
  }

  // 软边界：没有硬边界、同 location、但间隔超过阈值
  const softGap = finiteOr(options.softGapSeconds, DEFAULTS.softGapSeconds)
  const prevStart = shotStart(prevShot)
  const curStart = shotStart(curShot)
  let softNote = null
  if (hard.length === 0 && softGap > 0 && prevStart != null && curStart != null) {
    const gap = curStart - prevStart
    if (gap > softGap) {
      const where =
        prevLocation && curLocation && prevLocation === curLocation
          ? `同 location（${cleanText(curVisual.location)}）`
          : 'location 不可比'
      softNote = `镜头间隔 ${gap.toFixed(0)}s > 软阈值 ${softGap}s（${where}），软边界分场`
    }
  }

  const notes = [...hard]
  if (softNote) notes.push(softNote)
  const mergeNote =
    hard.length > 0 || softNote
      ? null
      : `并入本场：${[locationNote, lumaNote, toneNote].filter(Boolean).join('、')}`

  return {
    split: notes.length > 0,
    notes,
    boundary: hard.length > 0 ? 'hard' : softNote ? 'soft' : null,
    mergeNote,
  }
}

function aggregateMetrics(shotObjects) {
  const keys = [
    'lumaMean',
    'lumaMin',
    'lumaMax',
    'saturationMean',
    'greenDominance',
    'warmth',
    'meanHuePercent',
    'hueDegrees',
    'sharpness',
    'motion',
    'stability',
  ]
  const out = {}
  for (const key of keys) {
    const values = shotObjects.map((shot) => readMetric(shot, key)).filter((value) => value != null)
    if (values.length > 0) out[key] = values.reduce((sum, value) => sum + value, 0) / values.length
  }
  return out
}

function sceneTone(shotObjects, details, metrics) {
  const aggregated = toneDetailOfShot({ metrics })
  if (hasToneEvidence(aggregated)) return aggregated
  // 汇总指标里没有色调证据时，退回各镜头色调的多数票（但仍是「证据不足」口径之外的信息）
  const counts = new Map()
  for (const detail of details) {
    if (!hasToneEvidence(detail)) continue
    counts.set(detail.tone, (counts.get(detail.tone) ?? 0) + 1)
  }
  let bestTone = null
  let bestCount = 0
  for (const [tone, count] of counts) {
    if (count > bestCount) {
      bestTone = tone
      bestCount = count
    }
  }
  if (bestTone) return { tone: bestTone, source: 'per-shot-majority' }
  return aggregated
}

function sceneConfidence({ hasVisual, toneSource, shotObjects, shotCount }) {
  let confidence = 0.5
  if (hasVisual) confidence += 0.2
  if (toneSource && toneSource !== 'none' && toneSource !== 'luma/sat') confidence += 0.1
  if (shotCount >= 2) confidence += 0.1
  if (shotObjects.some((shot) => readMetric(shot, 'lumaMean') == null)) confidence -= 0.15
  if (shotCount === 1) confidence -= 0.05
  return Math.round(Math.min(0.95, Math.max(0.3, confidence)) * 100) / 100
}

function buildSceneLabel({ tone, avgLuma, shotCount, visuals, activities }) {
  const locations = visuals.map((visual) => cleanText(visual?.location, 12)).filter(Boolean)
  const timesOfDay = visuals.map((visual) => cleanText(visual?.timeOfDay, 12)).filter(Boolean)
  const location = mostFrequent(locations)
  const timeOfDay = mostFrequent(timesOfDay)
  const activity = activities[0] ?? ''
  if (location || timeOfDay || activity) {
    const parts = [location, timeOfDay, activity].filter(Boolean)
    if (parts.length > 0) return parts.join(' · ')
  }
  const toneLabel = TONE_LABEL[tone] ?? '中性'
  const head = tone === 'dark' ? toneLabel : `${toneLabel}${brightnessLabel(avgLuma)}`
  return `${head} · ${shotCount} 镜`
}

function finalizeScene(group, position, options) {
  const metrics = aggregateMetrics(group.shotObjects)
  const { tone, source } = sceneTone(group.shotObjects, group.details, metrics)
  const avgLuma = metrics.lumaMean ?? null
  const maxActivities = Math.max(1, Math.floor(finiteOr(options.maxActivities, DEFAULTS.maxActivities)))

  const descriptions = []
  for (const visual of group.visuals) {
    const text = cleanText(visual?.description)
    if (text && !descriptions.includes(text)) descriptions.push(text)
  }
  const activities = descriptions.slice(0, maxActivities)

  const hasVisual = group.visuals.some((visual) => !isEmptyVisual(visual))
  const label = buildSceneLabel({
    tone,
    avgLuma,
    shotCount: group.shotIndices.length,
    visuals: group.visuals,
    activities,
  })

  const startCandidates = group.shotObjects.map((shot) => shotStart(shot)).filter((value) => value != null)
  const endCandidates = group.shotObjects.map((shot) => shotEnd(shot)).filter((value) => value != null)
  const start = startCandidates.length > 0 ? Math.min(...startCandidates) : null
  const end = endCandidates.length > 0 ? Math.max(...endCandidates) : null
  const durations = group.shotObjects.map((shot) => shotDurationOf(shot))
  const duration =
    durations.every((value) => value != null)
      ? durations.reduce((sum, value) => sum + value, 0)
      : start != null && end != null
        ? end - start
        : null

  const basis = [...group.notes]
  if (group.merges > 2) basis.push(`另外 ${group.merges - 2} 个镜头按同样的规则并入本场（原因见上）`)
  if (hasVisual) {
    const location = mostFrequent(group.visuals.map((visual) => cleanText(visual?.location, 12)).filter(Boolean))
    const timeOfDay = mostFrequent(
      group.visuals.map((visual) => cleanText(visual?.timeOfDay, 12)).filter(Boolean),
    )
    const visualBits = [location ? `location=${location}` : '', timeOfDay ? `timeOfDay=${timeOfDay}` : '']
      .filter(Boolean)
      .join('、')
    basis.push(`依据 visual 标签${visualBits ? `（${visualBits}）` : ''} + 指标`)
  } else {
    basis.push('仅指标推断：无 visual 标签，只用 lumaMean/绿占比/饱和度/间隔切场，建议看图确认')
  }
  basis.push(
    `本场 ${group.shotIndices.length} 镜；dominantTone=${tone}（${source}）；平均亮度 ${
      avgLuma == null ? '不可读' : avgLuma.toFixed(2)
    }`,
  )

  return {
    index: position,
    label,
    shots: [...group.shotIndices],
    startShot: group.shotIndices[0] ?? null,
    endShot: group.shotIndices[group.shotIndices.length - 1] ?? null,
    start: round(start),
    end: round(end),
    duration: round(duration),
    dominantTone: tone,
    activities,
    confidence: sceneConfidence({
      hasVisual,
      toneSource: source,
      shotObjects: group.shotObjects,
      shotCount: group.shotIndices.length,
    }),
    basis,
    // 给 UI/上层用的附加信息（不影响规格字段）
    basisKind: hasVisual ? 'visual' : 'metrics',
    shotCount: group.shotIndices.length,
    meanLuma: round(avgLuma),
    greenDominance: round(metrics.greenDominance ?? null),
  }
}

/**
 * 把 scenes.scan 的镜头数组归并成「场」。
 *
 * @param {Array<object>} shots 镜头数组（scenes.scan 的 result.shots）
 * @param {object|Array} [visualByIndex={}] 每镜头的视觉标签，键 = 镜头 index（也接受数组）
 * @param {object} [options] 见 DEFAULTS
 * @returns {{sceneCount:number, scenes:Array<object>, notes:Array<string>}}
 */
export function groupScenes(shots, visualByIndex = {}, options = {}) {
  const list = (Array.isArray(shots) ? shots : []).filter(
    (shot) => shot && typeof shot === 'object',
  )
  const mergedOptions = { ...DEFAULTS, ...(options && typeof options === 'object' ? options : {}) }
  if (list.length === 0) {
    return { sceneCount: 0, scenes: [], notes: ['输入为空（0 个镜头），未分场'] }
  }

  const groups = []
  let current = null

  list.forEach((shot, position) => {
    const index = shotIndexOf(shot, position)
    const visual = resolveVisual(visualByIndex, index, position, shot)
    const detail = toneDetailOfShot(shot)

    if (!current) {
      current = emptyGroup('第 1 个镜头开新场（无前置镜头可比）')
      pushGroupShot(current, shot, index, visual, detail)
      groups.push(current)
      return
    }

    const prevShot = current.shotObjects[current.shotObjects.length - 1]
    const prevVisual = current.visuals[current.visuals.length - 1]
    const prevDetail = current.details[current.details.length - 1]
    const decision = decideBoundary(prevShot, prevVisual, prevDetail, shot, visual, detail, mergedOptions)

    if (decision.split) {
      current = emptyGroup()
      for (const note of decision.notes) current.notes.push(note)
      pushGroupShot(current, shot, index, visual, detail)
      groups.push(current)
    } else {
      pushGroupShot(current, shot, index, visual, detail)
      if (current.merges < 2 && decision.mergeNote) current.notes.push(decision.mergeNote)
      current.merges += 1
    }
  })

  const scenes = groups.map((group, position) => finalizeScene(group, position, mergedOptions))
  const hardBoundaries = scenes.reduce(
    (sum, scene) => sum + scene.basis.filter((line) => line.startsWith('location 变化') || line.startsWith('timeOfDay 变化') || line.startsWith('亮度跳变') || line.startsWith('色调变化')).length,
    0,
  )
  const softBoundaries = scenes.reduce(
    (sum, scene) => sum + scene.basis.filter((line) => line.includes('软边界分场')).length,
    0,
  )

  const notes = [
    `归并 ${scenes.length} 场（共 ${list.length} 个镜头；硬边界 ${hardBoundaries} 处、软边界 ${softBoundaries} 处）`,
  ]
  const metricOnly = scenes.filter((scene) => scene.basisKind === 'metrics').length
  if (metricOnly > 0) {
    notes.push(`${metricOnly} 场没有 visual 标签，仅按指标推断（basis 已注明），语义标签需看图补充`)
  }
  const missingMetrics = scenes.filter((scene) => scene.meanLuma == null).length
  if (missingMetrics > 0) {
    notes.push(`${missingMetrics} 场缺少亮度指标，切分只依赖 visual/色调证据`)
  }

  return { sceneCount: scenes.length, scenes, notes }
}

// ---------------------------------------------------------------------------
// describeScenes / scenesForModel
// ---------------------------------------------------------------------------

function normalizeSceneList(grouped) {
  if (Array.isArray(grouped)) return grouped.filter((scene) => scene && typeof scene === 'object')
  if (grouped && Array.isArray(grouped.scenes)) return grouped.scenes
  return []
}

function formatRange(scene) {
  const start = finiteOr(scene?.start, null)
  const end = finiteOr(scene?.end, null)
  if (start == null && end == null) return '时间未知'
  if (start == null) return `—${Number(end).toFixed(1)}s`
  if (end == null) return `${Number(start).toFixed(1)}s—`
  return `${start.toFixed(1)}–${end.toFixed(1)}s`
}

function sceneBrief(scene) {
  const tone = TONE_LABEL[scene?.dominantTone] ?? scene?.dominantTone ?? '未知'
  const activity = Array.isArray(scene?.activities) && scene.activities.length > 0 ? scene.activities[0] : '未描述活动'
  const source = scene?.basisKind === 'visual' ? '视觉标签' : '仅指标推断'
  const confidence = finiteOr(scene?.confidence, 0.5)
  const shotCount = Array.isArray(scene?.shots) ? scene.shots.length : 0
  return `${shotCount} 镜 · ${formatRange(scene)} · ${tone} · ${activity} · ${source}（置信 ${confidence.toFixed(2)}）`
}

/**
 * 给用户看的自然语言摘要（中文）。直接回答「一共有几场、分别是哪几场」。
 *
 * @param {{sceneCount:number, scenes:Array}} grouped groupScenes 的返回值（也接受 scenes 数组）
 * @returns {{text:string, perScene:Array<{index:number,label:string,brief:string}>}}
 */
export function describeScenes(grouped) {
  const scenes = normalizeSceneList(grouped)
  if (scenes.length === 0) {
    return { text: '未检测到镜头（0 个），无法分场。', perScene: [] }
  }
  const totalShots = scenes.reduce(
    (sum, scene) => sum + (Array.isArray(scene.shots) ? scene.shots.length : 0),
    0,
  )
  const perScene = scenes.map((scene, position) => ({
    index: finiteOr(scene.index, position),
    label: String(scene.label ?? ''),
    brief: sceneBrief(scene),
  }))
  const parts = scenes.map(
    (scene, position) =>
      `第 ${position + 1} 场「${scene.label || '未命名'}」（${(scene.shots ?? []).length} 镜，${formatRange(scene)}）`,
  )
  let text = `共 ${scenes.length} 场（${totalShots} 个镜头）：${parts.join('；')}。`
  if (scenes.every((scene) => scene.basisKind !== 'visual')) {
    text += '（没有 visual 语义标签，分场为指标推断，建议把代表帧发给模型确认。）'
  } else if (scenes.some((scene) => scene.basisKind !== 'visual')) {
    text += '（其中部分场只有指标证据，语义标签可再补充。）'
  }
  return { text, perScene }
}

function resolveFrames(shotFrames, shotIndex) {
  if (shotFrames == null) return []
  if (Array.isArray(shotFrames)) {
    const direct = shotFrames[shotIndex]
    if (Array.isArray(direct)) return direct.filter((frame) => typeof frame === 'string')
    const hit = shotFrames.find((item) => item && typeof item === 'object' && item.index === shotIndex)
    if (hit) {
      if (Array.isArray(hit.frames)) return hit.frames.filter((frame) => typeof frame === 'string')
      return []
    }
    return []
  }
  if (typeof shotFrames === 'object') {
    const hit = shotFrames[shotIndex] ?? shotFrames[String(shotIndex)]
    if (Array.isArray(hit)) return hit.filter((frame) => typeof frame === 'string')
    if (hit && Array.isArray(hit.frames)) return hit.frames.filter((frame) => typeof frame === 'string')
  }
  return []
}

/**
 * 组装「每场 -> 代表帧」的批次，供上层把帧发给模型描述「在干什么」。
 *
 * @param {{sceneCount:number, scenes:Array}} grouped
 * @param {object|Array} [shotFrames={}] 镜头 index -> 代表帧路径数组（或 shots 数组）
 * @returns {Array<{index:number, label:string, shots:Array<{index:number, frames:string[]}>, promptHint:string}>}
 */
export function scenesForModel(grouped, shotFrames = {}) {
  const scenes = normalizeSceneList(grouped)
  return scenes.map((scene, position) => {
    const sceneIndex = finiteOr(scene.index, position)
    const shots = (Array.isArray(scene.shots) ? scene.shots : []).map((shotIndex) => ({
      index: shotIndex,
      frames: resolveFrames(shotFrames, shotIndex),
    }))
    const frameCount = shots.reduce((sum, shot) => sum + shot.frames.length, 0)
    const hint = hasSceneLabel(scene)
      ? `第 ${position + 1} 场「${scene.label}」：请逐个描述这些镜头里"在干什么"（人物 / 动作 / 环境 / 氛围），各一句话；再判断它们是否属于同一场戏。`
      : `第 ${position + 1} 场（指标推断，暂无语义标签）：请逐个描述这些镜头里"在干什么"，各一句话；并给这场一个「地点 · 时段 · 主要活动」的标签。`
    return {
      index: sceneIndex,
      label: String(scene.label ?? ''),
      shots,
      frameCount,
      promptHint: hint,
    }
  })
}

function hasSceneLabel(scene) {
  return scene?.basisKind === 'visual'
}

export { METRIC_ALIASES, TIME_OF_DAY_ALIASES }
