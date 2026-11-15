/**
 * lib/editscore.mjs — 自动剪辑的叙事 / 节奏评分（纯函数、零依赖、无子进程、ESM）。
 *
 * 替代 lib/edit3.mjs 里「只看时长 / 黑场 / 锐度」的启发式：
 *   1. scoreShots：给每个镜头打 0–1 分，分项可解释（清晰度 / 曝光 / 稳定度 / 运动量 /
 *      与相邻镜头的色调一致性 / 时长），缺指标就给中性 0.5 并写进 reasons。
 *   2. planRhythm：按分数挑镜头（输出仍按原时序），用「开头两刀短、中段铺陈、结尾收束」的
 *      节奏曲线分配时长，可把每个切点对齐到节拍（bpm/beatSeconds），每一刀都带 reason。
 *   3. narrativeSummary：一句话中文剪辑说明。
 *
 * 单位：全部秒（duration / in / out / targetDuration / minShot / maxShot / beatSeconds）。
 * 模块不猜 fps、不读写文件、不调 MCP。
 *
 * 指标口径与 lib/scenegroup.mjs 共用（readMetric / toneDetailOfShot），
 * 因此 scenes.scan 的真实字段（lumaMean / lumaMin / lumaMax / saturationMean /
 * greenDominance）与 edit3 时代的 meanLuma / sharpness / motion 都能吃。
 *
 * 运行自测：node lib/editscore.test.mjs
 */

import {
  clamp01,
  finiteOr,
  readMetric,
  round,
  shotDurationOf,
  shotIndexOf,
  shotStart,
  toneDetailOfShot,
} from './scenegroup.mjs'

export const VERSION = '1.0.0'

/** 打分默认参数（都可在 options 里覆盖）。 */
export const DEFAULTS = Object.freeze({
  blackThreshold: 0.05, // 亮度低于它视为黑场
  idealLuma: 0.5, // 曝光目标
  idealMotion: 0.4, // 运动量理想值（完全静止和大幅晃动都扣分）
  idealMinDuration: 1.5, // 理想单镜时长下限（秒）
  idealMaxDuration: 6.0, // 理想单镜时长上限（秒）
  motionIsStability: false, // true = 把 metrics.motion 当成稳定度（越大越稳）
  weights: Object.freeze({
    sharpness: 0.26,
    exposure: 0.2,
    stability: 0.18,
    motion: 0.12,
    toneConsistency: 0.12,
    duration: 0.12,
  }),
})

const COMPONENT_KEYS = Object.freeze([
  'sharpness',
  'exposure',
  'stability',
  'motion',
  'toneConsistency',
  'duration',
])

/** 节奏规划默认参数。 */
export const PLAN_DEFAULTS = Object.freeze({
  minShot: 1.0, // 秒
  maxShot: 6.0, // 秒
  minScore: 0.35, // 低于此分数的镜头直接 dropped
  avgShotLength: null, // 决定镜头数 K 的理想平均镜长；null = (minShot+maxShot)/2
})

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clamp(value, lower, upper) {
  const num = finiteOr(value, lower)
  return Math.min(upper, Math.max(lower, num))
}

function formatSeconds(value) {
  const num = finiteOr(value, null)
  if (num == null) return 'n/a'
  return `${num.toFixed(1)}s`
}

function fmtScore(value) {
  const num = finiteOr(value, 0)
  return num.toFixed(2)
}

function averageOf(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (finite.length === 0) return null
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function normalizeWeights(weights) {
  const source = weights && typeof weights === 'object' ? weights : {}
  const merged = { ...DEFAULTS.weights, ...source }
  const total = COMPONENT_KEYS.reduce((sum, key) => sum + Math.max(0, finiteOr(merged[key], 0)), 0)
  if (!(total > 0)) return { ...DEFAULTS.weights }
  const out = {}
  for (const key of COMPONENT_KEYS) out[key] = Math.max(0, finiteOr(merged[key], 0)) / total
  return out
}

function normalizeScoreOptions(options) {
  const source = options && typeof options === 'object' ? options : {}
  const minDuration = Math.max(0.05, finiteOr(source.idealMinDuration, DEFAULTS.idealMinDuration))
  const maxDuration = Math.max(minDuration, finiteOr(source.idealMaxDuration, DEFAULTS.idealMaxDuration))
  return {
    blackThreshold: Math.max(0, finiteOr(source.blackThreshold, DEFAULTS.blackThreshold)),
    idealLuma: clamp(finiteOr(source.idealLuma, DEFAULTS.idealLuma), 0.05, 0.95),
    idealMotion: clamp(finiteOr(source.idealMotion, DEFAULTS.idealMotion), 0, 1),
    idealMinDuration: minDuration,
    idealMaxDuration: maxDuration,
    motionIsStability: source.motionIsStability === true,
    weights: normalizeWeights(source.weights),
  }
}

function resolveBeat(bpm, beatSeconds) {
  const explicit = finiteOr(beatSeconds, null)
  if (explicit != null && explicit > 0) return explicit
  const beatsPerMinute = finiteOr(bpm, 0)
  if (beatsPerMinute > 0) return round(60 / beatsPerMinute, 4)
  return null
}

function isBeatMultiple(duration, beat) {
  if (!(beat > 0)) return false
  return Math.abs(duration / beat - Math.round(duration / beat)) < 1e-6
}

// ---------------------------------------------------------------------------
// scoreShots
// ---------------------------------------------------------------------------

function toneSimilarity(leftDetail, leftLuma, rightDetail, rightLuma) {
  const comparable = leftDetail.source !== 'none' && rightDetail.source !== 'none'
  const parts = []
  if (comparable) parts.push(leftDetail.tone === rightDetail.tone ? 1 : 0.25)
  if (leftLuma != null && rightLuma != null) {
    parts.push(clamp01(1 - Math.abs(leftLuma - rightLuma) / 0.4))
  }
  if (parts.length === 0) return { score: 0.5, toneMismatch: false, comparable }
  return {
    score: parts.reduce((sum, value) => sum + value, 0) / parts.length,
    toneMismatch: comparable && leftDetail.tone !== rightDetail.tone,
    comparable,
  }
}

/**
 * 给每个镜头打「可用性 / 叙事价值」分（0–1，越大越好剪）。
 *
 * @param {Array<object>} shots 镜头数组（scenes.scan 的 shots）
 * @param {object} [options] 见 DEFAULTS（weights 可只给部分键）
 * @returns {Array<{shotIndex:number, score:number,
 *   breakdown:{sharpness:number,exposure:number,stability:number,motion:number,toneConsistency:number,duration:number},
 *   reasons:Array<string>}>}
 */
export function scoreShots(shots, options = {}) {
  const list = (Array.isArray(shots) ? shots : []).filter(
    (shot) => shot && typeof shot === 'object',
  )
  if (list.length === 0) return []
  const o = normalizeScoreOptions(options)
  const details = list.map((shot) => toneDetailOfShot(shot))
  const lumas = list.map((shot) => readMetric(shot, 'lumaMean'))

  return list.map((shot, position) => {
    const index = shotIndexOf(shot, position)
    const reasons = []
    const luma = lumas[position]
    const lumaMin = readMetric(shot, 'lumaMin')
    const lumaMax = readMetric(shot, 'lumaMax')
    const motion = readMetric(shot, 'motion')
    const stabilityMetric = readMetric(shot, 'stability')
    const duration = shotDurationOf(shot)

    // ---- 清晰度
    const sharpnessRaw = readMetric(shot, 'sharpness')
    const sharpness = sharpnessRaw == null ? 0.5 : clamp01(sharpnessRaw)
    if (sharpnessRaw == null) reasons.push('清晰度：无 sharpness 指标 → 中性 0.50')
    else reasons.push(`清晰度 ${fmtScore(sharpness)}`)

    // ---- 曝光（离目标亮度越近越好，切顶 / 压死再扣）
    let exposure
    if (luma == null) {
      exposure = 0.5
      reasons.push('曝光：无 lumaMean 指标 → 中性 0.50')
    } else {
      exposure = clamp01(1 - Math.abs(luma - o.idealLuma) / 0.5)
      const clipping = []
      if (lumaMax != null && lumaMax > 0.985) clipping.push('高光切顶')
      if (lumaMin != null && lumaMin < 0.015) clipping.push('暗部压死')
      if (clipping.length > 0) {
        exposure = clamp01(exposure - 0.15)
        reasons.push(
          `曝光：亮度 ${luma.toFixed(2)} 偏离目标 ${o.idealLuma}（${clipping.join('、')}，扣分）`,
        )
      } else {
        reasons.push(`曝光：亮度 ${luma.toFixed(2)}，接近目标 ${o.idealLuma}（得分 ${fmtScore(exposure)}）`)
      }
    }

    // ---- 稳定度（motion 默认视为「越大越不稳」）
    let stability
    if (stabilityMetric != null) {
      stability = clamp01(stabilityMetric)
      reasons.push(`稳定度 ${fmtScore(stability)}（stability 指标）`)
    } else if (motion != null) {
      stability = o.motionIsStability ? clamp01(motion) : clamp01(1 - motion)
      reasons.push(
        o.motionIsStability
          ? `稳定度 ${fmtScore(stability)}（motion 视为稳定度）`
          : `稳定度 ${fmtScore(stability)}（motion ${motion.toFixed(2)} 取反）`,
      )
    } else {
      stability = 0.5
      reasons.push('稳定度：无 motion/stability 指标 → 中性 0.50')
    }

    // ---- 运动量（理想值附近最好：全静止和大幅晃动都扣）
    let motionScore
    if (motion == null) {
      motionScore = 0.5
      reasons.push('运动量：无 motion 指标 → 中性 0.50')
    } else {
      motionScore = clamp01(1 - Math.abs(clamp01(motion) - o.idealMotion) / 0.6)
      reasons.push(`运动量 ${motion.toFixed(2)}（理想 ${o.idealMotion}，得分 ${fmtScore(motionScore)}）`)
    }

    // ---- 与相邻镜头的色调一致性
    const neighborScores = []
    let toneMismatchNote = ''
    for (const neighborPosition of [position - 1, position + 1]) {
      if (neighborPosition < 0 || neighborPosition >= list.length) continue
      const similarity = toneSimilarity(
        details[position],
        luma,
        details[neighborPosition],
        lumas[neighborPosition],
      )
      neighborScores.push(similarity.score)
      if (similarity.toneMismatch) {
        toneMismatchNote = `（${details[position].tone} vs ${details[neighborPosition].tone}）`
      }
    }
    const toneConsistency = neighborScores.length > 0 ? averageOf(neighborScores) : 0.5
    if (neighborScores.length === 0) {
      reasons.push('色调一致性：单镜无相邻镜头 → 中性 0.50')
    } else {
      reasons.push(
        `与相邻 ${neighborScores.length} 镜一致性 ${fmtScore(toneConsistency)}${toneMismatchNote}`,
      )
    }

    // ---- 时长是否落在理想区间
    let durationScore
    if (duration == null) {
      durationScore = 0.5
      reasons.push('时长：不可读（无 duration/start/end）→ 中性 0.50')
    } else if (duration < o.idealMinDuration) {
      durationScore = clamp01(duration / o.idealMinDuration)
      reasons.push(
        `时长 ${formatSeconds(duration)} 短于理想下限 ${formatSeconds(o.idealMinDuration)}（得分 ${fmtScore(durationScore)}）`,
      )
    } else if (duration > o.idealMaxDuration) {
      durationScore = clamp01(o.idealMaxDuration / duration)
      reasons.push(
        `时长 ${formatSeconds(duration)} 超过理想上限 ${formatSeconds(o.idealMaxDuration)}（得分 ${fmtScore(durationScore)}）`,
      )
    } else {
      durationScore = 1
      reasons.push(
        `时长 ${formatSeconds(duration)} 落在理想区间 ${formatSeconds(o.idealMinDuration)}–${formatSeconds(o.idealMaxDuration)}`,
      )
    }

    const components = {
      sharpness,
      exposure,
      stability,
      motion: motionScore,
      toneConsistency,
      duration: durationScore,
    }
    let score = COMPONENT_KEYS.reduce((sum, key) => sum + o.weights[key] * components[key], 0)

    const isBlack =
      shot?.black === true ||
      (luma != null && (luma < o.blackThreshold || (lumaMax != null && lumaMax < o.blackThreshold)))
    if (isBlack) {
      score = clamp01(score) * 0.2
      reasons.unshift(
        `黑场：${
          luma == null ? '镜头标记为黑场' : `平均亮度 ${luma.toFixed(3)} < ${o.blackThreshold}`
        }，分数 ×0.2`,
      )
    }

    return {
      shotIndex: index,
      score: round(clamp01(score), 3),
      breakdown: {
        sharpness: round(sharpness, 3),
        exposure: round(exposure, 3),
        stability: round(stability, 3),
        motion: round(motionScore, 3),
        toneConsistency: round(toneConsistency, 3),
        duration: round(durationScore, 3),
      },
      reasons,
    }
  })
}

// ---------------------------------------------------------------------------
// planRhythm
// ---------------------------------------------------------------------------

function rhythmFactor(position, count) {
  if (count <= 1) return 1
  if (position === 0) return 0.7 // 开场第一刀偏短
  if (position === 1 && count > 2) return 0.8 // 第二刀提速
  if (position === count - 1) return 0.9 // 结尾收束
  return 1.15 // 中段可以铺陈
}

function rhythmLabel(position, count) {
  if (count <= 1) return '单镜成片'
  if (position === 0) return '开场快切'
  if (position === 1 && count > 2) return '第二刀提速'
  if (position === count - 1) return '结尾收束'
  return '中段铺陈'
}

/**
 * 把时长拟合到目标：在 [lower, upper] 内按节拍（或连续）微调，差多少补多少。
 * 余量分配给「还有空间」的镜头（从余量最大的轮转），避免全部压在一镜上。
 */
function fitToTarget(desired, lowers, uppers, target, beat) {
  const count = desired.length
  const step = beat != null && beat > 0 ? beat : null
  const lo = []
  const hi = []
  for (let i = 0; i < count; i += 1) {
    let lower = lowers[i]
    let upper = Math.max(lower, uppers[i])
    if (step) {
      const snappedLower = Math.ceil(lower / step - 1e-9) * step
      const snappedUpper = Math.floor(upper / step + 1e-9) * step
      if (snappedLower <= snappedUpper + 1e-9) {
        lower = snappedLower
        upper = snappedUpper
      }
    }
    lo.push(lower)
    hi.push(upper)
  }
  const clampTo = (value, index) => Math.min(hi[index], Math.max(lo[index], value))
  const values = desired.map((value, index) => {
    const seeded = clampTo(value, index)
    return step ? clampTo(Math.round(seeded / step) * step, index) : seeded
  })

  let total = values.reduce((sum, value) => sum + value, 0)
  const tolerance = step ? step * 0.51 : 1e-6
  let guard = 0
  while (Math.abs(target - total) > tolerance && guard < 20000) {
    guard += 1
    const need = target - total
    const direction = need > 0 ? 1 : -1
    const rooms = values.map((value, index) =>
      direction > 0 ? hi[index] - value : value - lo[index],
    )
    const totalRoom = rooms.reduce((sum, room) => sum + Math.max(0, room), 0)
    if (totalRoom <= 1e-9) break
    if (step) {
      // 每轮只走一个节拍，且每次选余量最大的镜头 → 余量相同时自动轮转，避免全压在一镜
      let bestIndex = -1
      let bestRoom = 0
      for (let i = 0; i < count; i += 1) {
        if (rooms[i] > bestRoom + 1e-9) {
          bestRoom = rooms[i]
          bestIndex = i
        }
      }
      if (bestIndex < 0) break
      const roomSteps = Math.floor(bestRoom / step + 1e-9)
      if (roomSteps < 1) break
      values[bestIndex] = clampTo(values[bestIndex] + direction * step, bestIndex)
    } else {
      // 连续模式：按余量比例一轮分配（可能因夹紧需要第二轮）
      const scale = Math.min(1, Math.abs(need) / totalRoom)
      for (let i = 0; i < count; i += 1) {
        if (rooms[i] <= 1e-9) continue
        values[i] = clampTo(values[i] + direction * rooms[i] * scale, i)
      }
    }
    total = values.reduce((sum, value) => sum + value, 0)
  }
  return values
}

function resolveScores(list, scores, scoreOptions = {}) {
  const computed = scoreShots(list, scoreOptions)
  if (scores == null) return computed
  const provided = new Map()
  if (Array.isArray(scores)) {
    scores.forEach((entry, position) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        const index = shotIndexOf(list[position], position)
        provided.set(index, clamp01(entry))
        return
      }
      if (entry && typeof entry === 'object') {
        const rawIndex = finiteOr(entry.shotIndex ?? entry.index, null)
        if (rawIndex == null) return
        const rawScore = finiteOr(entry.score, null)
        if (rawScore == null) return
        provided.set(rawIndex, clamp01(rawScore))
      }
    })
  } else if (typeof scores === 'object') {
    for (const [key, value] of Object.entries(scores)) {
      const rawIndex = Number(key)
      if (!Number.isFinite(rawIndex)) continue
      const rawScore =
        value && typeof value === 'object' ? finiteOr(value.score, null) : finiteOr(value, null)
      if (rawScore == null) continue
      provided.set(rawIndex, clamp01(rawScore))
    }
  }
  return computed.map((entry) => ({
    ...entry,
    score: provided.has(entry.shotIndex) ? provided.get(entry.shotIndex) : entry.score,
  }))
}

function emptyPlan(reason) {
  return {
    edits: [],
    totalDuration: 0,
    pacing: { cutsPerMinute: 0, avgShotLength: 0, energyCurve: [], beatSeconds: null },
    dropped: [],
    notes: [reason],
  }
}

/**
 * 叙事 / 节奏剪辑规划。
 *
 * 按分数从高到低挑镜头（输出永远按原时序），用「开场两刀短 → 中段铺陈 → 结尾收束」的
 * 节奏曲线分配时长；给了 bpm/beatSeconds 时把每个 duration 微调到节拍整数倍。
 *
 * @param {object} params
 * @param {Array<object>} params.shots
 * @param {Array<{shotIndex:number,score:number}>|object|null} [params.scores]
 *   不给就用 scoreShots 现算（可用 params.scoreOptions 透传）
 * @param {number|null} [params.targetDuration] 目标总时长（秒）
 * @param {number} [params.bpm=0] 每分钟节拍数（120 → beatSeconds 0.5）
 * @param {number|null} [params.beatSeconds] 直接给节拍长度（优先级高于 bpm）
 * @param {number} [params.minShot=1] 单镜最短（秒）
 * @param {number} [params.maxShot=6] 单镜最长（秒）
 * @returns {{edits:Array<{shotIndex:number,in:number,out:number,duration:number,reason:string,score:number}>,
 *   totalDuration:number,
 *   pacing:{cutsPerMinute:number,avgShotLength:number,energyCurve:number[],beatSeconds:number|null},
 *   dropped:Array<{shotIndex:number,stage:string,reason:string}>, notes:Array<string>}}
 */
export function planRhythm({
  shots = [],
  scores = null,
  targetDuration = null,
  bpm = 0,
  beatSeconds = null,
  minShot = PLAN_DEFAULTS.minShot,
  maxShot = PLAN_DEFAULTS.maxShot,
  ...options
} = {}) {
  const list = (Array.isArray(shots) ? shots : []).filter(
    (shot) => shot && typeof shot === 'object',
  )
  if (list.length === 0) return emptyPlan('输入为空（0 个镜头），未生成剪辑')

  const minSelectedDuration = Math.max(0.1, finiteOr(minShot, PLAN_DEFAULTS.minShot))
  const maxSelectedDuration = Math.max(
    minSelectedDuration,
    finiteOr(maxShot, PLAN_DEFAULTS.maxShot),
  )
  const target = finiteOr(targetDuration, null)
  const beat = resolveBeat(bpm, beatSeconds)
  const minScore = clamp01(finiteOr(options.minScore, PLAN_DEFAULTS.minScore))
  // 目标比最短镜头还短时，允许把下限压到目标值（极小成片），否则无法出片
  const targetFloor =
    target != null && target > 0 && target < minSelectedDuration
      ? Math.max(0.2, Math.min(target, minSelectedDuration))
      : minSelectedDuration

  const notes = []
  const dropped = []
  const scoreEntries = resolveScores(list, scores, options.scoreOptions ?? {})
  const scoreByIndex = new Map()
  for (const entry of scoreEntries) {
    if (!scoreByIndex.has(entry.shotIndex)) scoreByIndex.set(entry.shotIndex, entry.score)
  }

  // ---- 阶段 1：资格过滤（无效 / 过短 / 低分）
  const candidates = []
  list.forEach((shot, position) => {
    const index = shotIndexOf(shot, position)
    const duration = shotDurationOf(shot)
    const score = scoreByIndex.get(index) ?? 0.5
    if (duration == null || duration <= 0) {
      dropped.push({
        shotIndex: index,
        stage: 'invalid',
        reason: '时长不可读（需要 duration 或 start/end），无法编排',
      })
      return
    }
    if (duration < targetFloor - 1e-9) {
      dropped.push({
        shotIndex: index,
        stage: 'too-short',
        reason: `时长 ${formatSeconds(duration)} < 最短 ${formatSeconds(targetFloor)}，无法使用`,
      })
      return
    }
    if (score < minScore - 1e-9) {
      dropped.push({
        shotIndex: index,
        stage: 'low-score',
        reason: `分数 ${fmtScore(score)} < 入选阈值 ${fmtScore(minScore)}，低分不入选`,
      })
      return
    }
    candidates.push({
      shot,
      position,
      index,
      sourceDuration: duration,
      score,
      lower: targetFloor,
      upper: Math.min(duration, maxSelectedDuration),
    })
  })

  if (candidates.length === 0) {
    return {
      edits: [],
      totalDuration: 0,
      pacing: { cutsPerMinute: 0, avgShotLength: 0, energyCurve: [], beatSeconds: beat },
      dropped,
      notes: [...notes, '没有满足条件的镜头（无效/过短/低分已全部剔除）'],
    }
  }

  // ---- 阶段 2：按分数排序，确定能装进目标时长的镜头数 K（再按原时序排回去）
  const ranked = candidates
    .slice()
    .sort((left, right) => right.score - left.score || left.position - right.position)
  let poolSize = candidates.length
  if (target != null && target > 0) {
    const idealAverage = clamp(
      finiteOr(options.avgShotLength, (minSelectedDuration + maxSelectedDuration) / 2),
      minSelectedDuration,
      maxSelectedDuration,
    )
    let estimate = Math.round(target / Math.max(0.1, idealAverage))
    estimate = Math.max(1, Math.min(estimate, candidates.length))
    poolSize = estimate
    const sumLower = (count2) => ranked.slice(0, count2).reduce((sum, item) => sum + item.lower, 0)
    const sumUpper = (count2) => ranked.slice(0, count2).reduce((sum, item) => sum + item.upper, 0)
    while (poolSize > 1 && sumLower(poolSize) > target + 1e-9) poolSize -= 1
    while (poolSize < candidates.length && sumUpper(poolSize) < target - 1e-9) poolSize += 1
  } else {
    notes.push('未给 targetDuration：每个入选镜头按可用长度上限使用')
  }

  const pool = ranked.slice(0, poolSize).sort((left, right) => left.position - right.position)
  const count = pool.length

  // ---- 阶段 3：节奏曲线分配时长 + 拟合目标 + 节拍对齐
  let durations
  if (target != null && target > 0) {
    const average = target / count
    const desired = pool.map((candidate, position) =>
      clamp(average * rhythmFactor(position, count), candidate.lower, candidate.upper),
    )
    const useBeat = beat != null && beat > 0 && target >= beat - 1e-9
    durations = fitToTarget(
      desired,
      pool.map((candidate) => candidate.lower),
      pool.map((candidate) => candidate.upper),
      target,
      useBeat ? beat : null,
    )
    if (useBeat) notes.push(`切点按 ${formatSeconds(beat)} 节拍对齐（≈${Math.round(60 / beat)} BPM）`)
    else if (beat != null) notes.push(`节拍 ${formatSeconds(beat)} 长于目标 ${formatSeconds(target)}，未做节拍对齐`)
  } else {
    durations = pool.map((candidate) => candidate.upper)
  }

  // ---- 阶段 4：生成 edits（按原时序）与 pacing
  const edits = pool.map((candidate, position) => {
    const duration = round(Math.max(0.05, durations[position]), 3)
    const inPoint = shotStart(candidate.shot) ?? 0
    const parts = [`高分 ${fmtScore(candidate.score)}`, formatSeconds(duration)]
    if (beat != null && beat > 0 && isBeatMultiple(duration, beat)) {
      parts.push(`对齐 ${formatSeconds(beat)} 节拍`)
    }
    parts.push(rhythmLabel(position, count))
    if (candidate.sourceDuration > maxSelectedDuration + 1e-9) {
      parts.push(`超过单镜上限 ${formatSeconds(maxSelectedDuration)}，截断`)
    }
    return {
      shotIndex: candidate.index,
      in: round(inPoint, 3),
      out: round(inPoint + duration, 3),
      duration,
      reason: parts.join(' · '),
      score: round(candidate.score, 3),
    }
  })

  const pickedPositions = new Set(pool.map((candidate) => candidate.position))
  const pickedScores = pool.map((candidate) => candidate.score)
  const admissionLine = pickedScores.length > 0 ? Math.min(...pickedScores) : null
  for (const candidate of candidates) {
    if (pickedPositions.has(candidate.position)) continue
    dropped.push({
      shotIndex: candidate.index,
      stage: 'target',
      reason: `未入选：按分数从高到低排到目标时长已满（分数 ${fmtScore(candidate.score)}${
        admissionLine != null ? ` < 入选线 ${fmtScore(admissionLine)}` : ''
      }）`,
    })
  }

  const totalDuration = round(
    edits.reduce((sum, edit) => sum + edit.duration, 0),
    3,
  )
  const cutsPerMinute = totalDuration > 0 ? round((edits.length / totalDuration) * 60, 2) : 0
  const avgShotLength = edits.length > 0 ? round(totalDuration / edits.length, 3) : 0
  const inverseDurations = edits.map((edit) => (edit.duration > 0 ? 1 / edit.duration : 0))
  const maxInverse = inverseDurations.length > 0 ? Math.max(...inverseDurations) : 0
  const energyCurve = inverseDurations.map((value) =>
    maxInverse > 0 ? round(value / maxInverse, 3) : 0,
  )

  if (target != null && target > 0) {
    const delta = target - totalDuration
    const tolerance = Math.max(0.05, target * 0.02)
    notes.push(
      Math.abs(delta) <= tolerance
        ? `总时长 ${formatSeconds(totalDuration)}，命中目标 ${formatSeconds(target)}`
        : `总时长 ${formatSeconds(totalDuration)}，与目标 ${formatSeconds(target)} 差 ${formatSeconds(
            delta,
          )}（受可用镜头/节拍粒度限制）`,
    )
  }

  return {
    edits,
    totalDuration,
    pacing: {
      cutsPerMinute,
      avgShotLength,
      energyCurve,
      beatSeconds: beat == null ? null : round(beat, 4),
    },
    dropped,
    notes,
  }
}

// ---------------------------------------------------------------------------
// narrativeSummary
// ---------------------------------------------------------------------------

function normalizeScenes(scenes) {
  if (Array.isArray(scenes)) return scenes.filter((scene) => scene && typeof scene === 'object')
  if (scenes && Array.isArray(scenes.scenes)) return scenes.scenes
  return []
}

/**
 * 一句话中文剪辑说明（给用户看）。
 *
 * @param {{edits:Array<object>, scenes?:object|Array}} params
 * @returns {string}
 */
export function narrativeSummary({ edits = [], scenes = null } = {}) {
  const list = (Array.isArray(edits) ? edits : []).filter(
    (edit) => edit && typeof edit === 'object',
  )
  if (list.length === 0) return '没有可用镜头，未生成剪辑方案。'

  const total = list.reduce((sum, edit) => sum + (finiteOr(edit.duration, 0) ?? 0), 0)
  const sceneList = normalizeScenes(scenes)
  if (!(total > 0)) {
    const scenePart = sceneList.length > 0 ? `，覆盖 ${sceneList.length} 场戏` : ''
    return `共 ${list.length} 刀（时长不可读）${scenePart}。`
  }

  const cutsPerMinute = (list.length / total) * 60
  const average = total / list.length
  const paceWord =
    cutsPerMinute >= 18 ? '节奏偏快、信息密度高' : cutsPerMinute <= 6 ? '节奏偏慢、偏铺陈' : '节奏平稳'
  const scenePart = sceneList.length > 0 ? `，覆盖 ${sceneList.length} 场戏` : ''
  const openLabel = sceneList[0]?.label ? `，开场「${sceneList[0].label}」` : ''
  const lastScene = sceneList.length > 1 ? sceneList[sceneList.length - 1] : null
  const closeLabel = lastScene?.label ? `，收在「${lastScene.label}」` : ''

  return `共 ${list.length} 刀 / ${total.toFixed(1)}s（平均 ${average.toFixed(
    1,
  )}s 一镜、${cutsPerMinute.toFixed(0)} 刀/分钟）${scenePart}：${paceWord}${openLabel}${closeLabel}。`
}

export { COMPONENT_KEYS }
