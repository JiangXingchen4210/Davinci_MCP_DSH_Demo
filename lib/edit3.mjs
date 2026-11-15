#!/usr/bin/env node
/**
 * lib/edit3.mjs — 自动剪辑规划（纯函数、零依赖、ESM）。
 *
 * 两块能力：
 *   1. planSelects：从一批镜头里选出可用镜头（剔除黑场/极糊/过短/无效），
 *      按目标时长截断，可选按清晰度重排；**每一步都带可解释的 reason**。
 *   2. planScenes：把镜头归并成「场」。
 *
 * 单位约定：**全部是秒**（duration / in / out / targetDuration / minShotDuration /
 * maxShotDuration）。真实剪辑落地时由调用方按 fps 换算成帧；模块本身不猜 fps，
 * 也不把「秒」和「帧」混在一起算（混算过的 bug 比阈值算错更隐蔽）。
 *
 * 镜头（shot）对象支持的字段（都给 `metrics` 内或对象顶层都行）：
 *   - index?: number            外部镜头序号（缺省用数组下标）
 *   - duration?: number         秒；没有则用 start/end 或 in/out 推
 *   - start? / end?: number     秒（时间线位置）
 *   - in? / out?: number        秒（素材自身 in/out 点，编译期用 shot['in']）
 *   - black?: boolean           人工标记黑场
 *   - blurry?: boolean          人工标记糊（false 可显式压过 metrics 判定）
 *   - metrics?: { meanLuma, sharpness, motion, greenDominance, warmth,
 *                 meanHuePercent, meanSat }
 *
 * 判定规则（阈值都可在参数里覆盖）：
 *   - 黑场：meanLuma < blackThreshold（默认 0.05）或 black === true
 *   - 极糊：sharpness < blurThreshold（默认 0.18）且 shot.blurry !== false
 *   - 过短：duration < minShotDuration（默认 0.5s）
 *
 * 运行自测：node lib/edit3.test.mjs
 */

export const VERSION = '1.0.0'

export const DEFAULTS = Object.freeze({
  targetDuration: null, // null = 不按目标时长截断
  minShotDuration: 0.5, // 秒
  maxShotDuration: null, // null = 不限单镜时长
  preferSharp: false,
  blackThreshold: 0.05,
  blurThreshold: 0.18,
})

function finiteOr(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function round(value, digits = 3) {
  const num = finiteOr(value, null)
  if (num == null) return null
  const factor = 10 ** digits
  return Math.round(num * factor) / factor
}

function clamp01(value) {
  const num = finiteOr(value, 0)
  return Math.min(1, Math.max(0, num))
}

/** 格式化秒数，给 reason 用（避免出现 2.0000000000000004 这种噪音）。 */
function fmtSeconds(value) {
  const num = finiteOr(value, null)
  if (num == null) return 'n/a'
  return `${Math.round(num * 100) / 100}s`
}

function metric(shot, key) {
  const fromMetrics = shot?.metrics?.[key]
  const value = fromMetrics !== undefined ? fromMetrics : shot?.[key]
  return finiteOr(value, null)
}

/** 取镜头时长（秒）。duration 优先，其次 start/end，再次 in/out。 */
function shotDuration(shot) {
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

/** 取素材 in 点（秒）：优先 shot.in，其次 shot.start，最后 0。 */
function shotInPoint(shot) {
  const inPoint = finiteOr(shot?.['in'], null)
  if (inPoint != null) return inPoint
  const start = finiteOr(shot?.start, null)
  if (start != null) return start
  return 0
}

/** 镜头序号：显式 index 优先（保留调用方编号），否则数组下标。 */
function shotIndex(shot, position) {
  const declared = finiteOr(shot?.index, null)
  if (declared != null && Number.isInteger(declared)) return declared
  return position
}

// ---------------------------------------------------------------------------
// planSelects
// ---------------------------------------------------------------------------

/**
 * 自动选镜规划。
 *
 * @param {object} options
 * @param {Array<object>} options.shots 镜头列表
 * @param {number|null} [options.targetDuration] 目标总时长（秒）
 * @param {number} [options.minShotDuration=0.5] 单镜最短（秒）
 * @param {number|null} [options.maxShotDuration] 单镜最长（秒），超出截断
 * @param {boolean} [options.preferSharp=false] true = 按清晰度从高到低重排；false = 保留原时序
 * @param {number} [options.blackThreshold=0.05] 黑场亮度阈值
 * @param {number} [options.blurThreshold=0.18] 极糊清晰度阈值
 * @returns {{edits:Array<{shotIndex:number,in:number,out:number,duration:number,reason:string}>,
 *            totalDuration:number, dropped:Array<{shotIndex:number,reason:string,stage:string}>,
 *            targetDuration:number|null, notes:Array<string>}}
 */
export function planSelects({
  shots = [],
  targetDuration = null,
  minShotDuration = DEFAULTS.minShotDuration,
  maxShotDuration = DEFAULTS.maxShotDuration,
  preferSharp = DEFAULTS.preferSharp,
  blackThreshold = DEFAULTS.blackThreshold,
  blurThreshold = DEFAULTS.blurThreshold,
} = {}) {
  const list = Array.isArray(shots) ? shots : []
  const notes = []
  const dropped = []
  const candidates = []

  const minDuration = Math.max(0, finiteOr(minShotDuration, DEFAULTS.minShotDuration))
  const maxDuration = finiteOr(maxShotDuration, null)
  const blackCut = clamp01(finiteOr(blackThreshold, DEFAULTS.blackThreshold))
  const blurCut = clamp01(finiteOr(blurThreshold, DEFAULTS.blurThreshold))
  const target = finiteOr(targetDuration, null)

  // ---- 阶段 1：剔除不可用镜头（黑场 / 极糊 / 过短 / 无效）
  list.forEach((shot, position) => {
    const index = shotIndex(shot, position)
    const duration = shotDuration(shot)
    const meanLuma = metric(shot, 'meanLuma')
    const sharpness = metric(shot, 'sharpness')

    if (duration == null || duration <= 0) {
      dropped.push({
        shotIndex: index,
        stage: 'invalid',
        reason: '无效镜头：时长不可读或为 0（需要 duration 或 start/end 或 in/out）',
      })
      return
    }
    if (shot?.black === true || (meanLuma != null && meanLuma < blackCut)) {
      dropped.push({
        shotIndex: index,
        stage: 'black',
        reason: `黑场剔除：平均亮度 ${meanLuma == null ? '标记为黑场' : meanLuma.toFixed(3)} < ${blackCut}`,
      })
      return
    }
    if (shot?.blurry !== false && sharpness != null && sharpness < blurCut) {
      dropped.push({
        shotIndex: index,
        stage: 'blurry',
        reason: `极糊剔除：清晰度 ${sharpness.toFixed(3)} < ${blurCut}`,
      })
      return
    }
    if (duration < minDuration) {
      dropped.push({
        shotIndex: index,
        stage: 'too-short',
        reason: `过短剔除：${fmtSeconds(duration)} < 最短 ${fmtSeconds(minDuration)}`,
      })
      return
    }

    candidates.push({ shot, index, position, duration, meanLuma, sharpness })
  })

  // ---- 阶段 2：排序（默认保留原时序；preferSharp 时清晰度优先，同分仍按原序稳定）
  let ordered = candidates
  if (preferSharp) {
    ordered = candidates.slice().sort((left, right) => {
      if (left.sharpness == null && right.sharpness == null) return left.position - right.position
      if (left.sharpness == null) return 1
      if (right.sharpness == null) return -1
      if (right.sharpness !== left.sharpness) return right.sharpness - left.sharpness
      return left.position - right.position
    })
    notes.push(`preferSharp=true：按清晰度从高到低重排 ${ordered.length} 个候选（同分保留原时序）`)
  } else {
    notes.push('保留原时序（preferSharp=false）')
  }

  // ---- 阶段 3：单镜上限 + 目标时长截断，生成 edits
  const edits = []
  let total = 0
  ordered.forEach((candidate) => {
    let duration = candidate.duration
    const reasons = []
    if (!preferSharp) reasons.push('保留原时序')
    reasons.push(`时长 ${fmtSeconds(candidate.duration)}`)
    if (candidate.sharpness != null) reasons.push(`清晰度 ${candidate.sharpness.toFixed(2)}`)

    if (maxDuration != null && duration > maxDuration) {
      duration = maxDuration
      reasons.push(`超过单镜上限 ${fmtSeconds(maxDuration)}，截断`)
    }

    if (target != null) {
      const remaining = target - total
      if (remaining <= 1e-9) {
        dropped.push({
          shotIndex: candidate.index,
          stage: 'target',
          reason: `超出目标时长 ${fmtSeconds(target)}（已排满 ${fmtSeconds(total)}），整镜略过`,
        })
        return
      }
      if (duration > remaining + 1e-9) {
        if (remaining < minDuration - 1e-9) {
          dropped.push({
            shotIndex: candidate.index,
            stage: 'target',
            reason: `剩余 ${fmtSeconds(remaining)} 不足最短镜头 ${fmtSeconds(minDuration)}，略过`,
          })
          return
        }
        duration = remaining
        reasons.push(`按目标时长 ${fmtSeconds(target)} 截断到 ${fmtSeconds(duration)}`)
      }
    }

    const inPoint = shotInPoint(candidate.shot)
    edits.push({
      shotIndex: candidate.index,
      in: round(inPoint),
      out: round(inPoint + duration),
      duration: round(duration),
      reason: reasons.join('，'),
    })
    total += duration
  })

  const result = {
    edits,
    totalDuration: round(total),
    dropped,
    targetDuration: target == null ? null : round(target),
    notes,
  }
  if (target != null) {
    const delta = Math.abs(total - target)
    notes.push(
      delta <= 1e-6
        ? `总时长命中目标 ${fmtSeconds(target)}`
        : `总时长 ${fmtSeconds(total)}，与目标 ${fmtSeconds(target)} 差 ${fmtSeconds(delta)}` +
            (delta > 0 ? '（可用素材不足或截断粒度所限）' : ''),
    )
  }
  return result
}

// ---------------------------------------------------------------------------
// planScenes
// ---------------------------------------------------------------------------

const TONE_LABEL = Object.freeze({
  green: '绿调',
  warm: '暖调',
  cool: '冷调',
  magenta: '品红调',
  dark: '暗调',
  neutral: '中性',
  unknown: '未知',
})

/** 由色相（UI 0–100 刻度）判断色调：0/100=红、8=橙、17=黄、33=绿、50=青、67=蓝、83=品红。 */
function toneFromHue(huePercent) {
  const hue = finiteOr(huePercent, null)
  if (hue == null) return null
  if (hue >= 25 && hue <= 42) return 'green'
  if (hue >= 48 && hue <= 78) return 'cool'
  if (hue > 78 && hue < 88) return 'magenta'
  if (hue <= 20 || hue >= 88) return 'warm'
  return null
}

/**
 * 场色调：优先 greenDominance（最直接），其次 warmth，再其次 meanHuePercent，
 * 最后才用亮度判暗调。没有证据就返回 'unknown'，不硬猜。
 */
function dominantToneOf(stats) {
  if (stats.greenDominance != null && stats.greenDominance >= 0.5) return 'green'
  if (stats.warmth != null) {
    if (stats.warmth >= 0.15) return 'warm'
    if (stats.warmth <= -0.15) return 'cool'
  }
  const fromHue = toneFromHue(stats.meanHuePercent)
  if (fromHue) return fromHue
  if (stats.meanLuma != null && stats.meanLuma < 0.25) return 'dark'
  return 'unknown'
}

function activityOf(stats) {
  if (stats.motion == null) return { activity: 'unknown', activityScore: null }
  const score = round(clamp01(stats.motion), 3)
  if (score < 0.33) return { activity: 'low', activityScore: score }
  if (score < 0.66) return { activity: 'medium', activityScore: score }
  return { activity: 'high', activityScore: score }
}

function averageOf(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (finite.length === 0) return null
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function aggregateStats(shots) {
  const read = (key) => shots.map((shot) => metric(shot, key))
  const meanLuma = averageOf(read('meanLuma'))
  const greenDominance = averageOf(read('greenDominance'))
  const warmth = averageOf(read('warmth'))
  const meanHuePercent = averageOf(read('meanHuePercent'))
  const motion = averageOf(read('motion'))
  return { meanLuma, greenDominance, warmth, meanHuePercent, motion }
}

/**
 * 把镜头归并成场。
 *
 * 归并规则**只认输入里的 `sceneBoundary`**（或 `hardCut` / `newScene` 别名）：
 * 该镜头标记为场景起点 → 从这里开新场；没有标记 → 并入当前场。
 * 不根据 greenDominance/luma 相似度去「猜」切点（本模块的原则：决策必须可解释，
 * 猜出来的切点无法解释，就宁可不切）。`greenDominance`/`luma` 只用于给每场
 * 生成 dominantTone 摘要。
 *
 * @param {Array<object>} scenes 镜头列表（每项可带 sceneBoundary）或场景列表（每项带 shots）
 * @returns {{sceneCount:number, scenes:Array, notes:Array<string>}}
 */
export function planScenes(scenes = []) {
  const list = Array.isArray(scenes) ? scenes : []
  if (list.length === 0) {
    return { sceneCount: 0, scenes: [], notes: ['输入为空，未生成场'] }
  }
  // 形态 A：已经是「场」的数组（每项带 shots）→ 只做汇总，不重新切分
  const looksLikeSceneList = list.every((item) => item && Array.isArray(item.shots))
  if (looksLikeSceneList) return planScenesFromSceneList(list)
  return planScenesFromShots(list)
}

function planScenesFromShots(shots) {
  const groups = []
  let current = null

  shots.forEach((shot, position) => {
    const index = shotIndex(shot, position)
    const isBoundary =
      shot?.sceneBoundary === true || shot?.hardCut === true || shot?.newScene === true
    // 第一个镜头永远开新场（边界标记在首个镜头上没有意义）
    if (!current || (isBoundary && current.shotObjects.length > 0)) {
      current = { index: groups.length, shots: [], shotObjects: [] }
      groups.push(current)
    }
    current.shots.push(index)
    current.shotObjects.push(shot)
  })

  const boundaryCount = shots.filter(
    (shot, position) =>
      position > 0 && (shot?.sceneBoundary === true || shot?.hardCut === true || shot?.newScene === true),
  ).length

  const scenesOut = groups.map((group, position) => {
    const stats = aggregateStats(group.shotObjects)
    const tone = dominantToneOf(stats)
    const { activity, activityScore } = activityOf(stats)
    const duration = group.shotObjects.reduce((sum, shot) => sum + (shotDuration(shot) ?? 0), 0)
    return {
      index: position,
      shots: group.shots,
      shotCount: group.shots.length,
      duration: round(duration),
      dominantTone: tone,
      activity,
      activityScore,
      meanLuma: round(stats.meanLuma),
      greenDominance: round(stats.greenDominance),
    }
  })

  const notes = [
    `按输入 sceneBoundary 归并 ${scenesOut.length} 场（共 ${shots.length} 个镜头，${boundaryCount} 处硬切）；未用色调相似度猜测切点`,
  ]
  const unknownTone = scenesOut.filter((scene) => scene.dominantTone === 'unknown').length
  if (unknownTone > 0) {
    notes.push(`${unknownTone} 场缺少色调证据（greenDominance/warmth/meanHuePercent 都不可用），dominantTone 记为 unknown`)
  }

  return { sceneCount: scenesOut.length, scenes: scenesOut, notes }
}

/** 形态 A：输入已经是场数组，只做汇总（shots 里可以是对象，也可以是镜头序号）。 */
function planScenesFromSceneList(sceneList) {
  const scenesOut = sceneList.map((scene, position) => {
    const shotRefs = scene.shots
    const shotObjects = shotRefs.filter((ref) => ref && typeof ref === 'object')
    const indices = shotRefs.map((ref, index) => {
      if (typeof ref === 'number' && Number.isInteger(ref)) return ref
      return shotIndex(ref, index)
    })
    const stats = aggregateStats(shotObjects)
    const tone = dominantToneOf(stats)
    const { activity, activityScore } = activityOf(stats)
    const duration = shotObjects.length > 0
      ? shotObjects.reduce((sum, shot) => sum + (shotDuration(shot) ?? 0), 0)
      : finiteOr(scene.duration, 0)
    return {
      index: position,
      shots: indices,
      shotCount: indices.length,
      duration: round(duration),
      dominantTone: tone,
      activity,
      activityScore,
      meanLuma: round(stats.meanLuma),
      greenDominance: round(stats.greenDominance),
    }
  })

  return {
    sceneCount: scenesOut.length,
    scenes: scenesOut,
    notes: ['输入已是场景数组（每项带 shots），按原切分汇总，不再归并'],
  }
}

export { TONE_LABEL }
