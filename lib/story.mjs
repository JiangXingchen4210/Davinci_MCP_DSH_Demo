/**
 * 剧情/台词驱动的剪辑规划 —— 解决「人物走到一半就切」「台词前言不搭后语」。
 *
 * 输入（都由上层提供，本模块纯函数、无子进程）：
 *   shots: [{index, clipId, start, end, duration, transcript?, motion?}]
 *     · start/end 是该镜头在源素材里的秒数（与 scenes.scan 的输出对齐）
 *     · transcript: [{start,end,text,speaker?}]，时间轴与 start/end 同一坐标系（源素材秒）
 *     · motion: motion.mjs 的曲线（同一坐标系）
 *   targetDuration / options
 *
 * 规则（全部可解释，写进 reason）：
 *   1. 台词完整性：一句台词绝不从中间切断 → 入点提前 0.3s、出点延后 0.4s，且优先把整句保留。
 *   2. 动作完整性：切点落在运动谷值/静止段（motion.pickSafeCut），没停稳就不切。
 *   3. 台词连贯性：按时间顺序保留说话人轮次，不允许把「回答」放在「提问」前面。
 *   4. 时长控制：优先砍掉「无台词且运动剧烈」的镜头，而不是把台词句砍半。
 */

import { pickSafeCut } from './motion.mjs'

const LEADS = { in: 0.3, out: 0.4 }
const DEFAULT_OPTIONS = Object.freeze({
  targetDuration: 40,
  minShot: 1.0,
  maxShot: 8,
  dialogueWeight: 1.0,
  silentWeight: 0.45,
  sentenceGap: 0.45, // 台词分段之间的静音超过这个值就当作两句
  speakerAlternateGap: 0.7, // 没有 speaker 标签时，静音超过 0.7s 就切换说话人
})

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value, digits = 3) => Number(Number(value).toFixed(digits))

/** 标准化台词段：排序、去空、合并过短碎片、推断说话人。 */
export function normaliseTranscript(segments, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const list = (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      text: String(segment.text ?? '').trim(),
      speaker: segment.speaker ?? null,
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text !== '')
    .sort((a, b) => a.start - b.start)

  const merged = []
  for (const segment of list) {
    const previous = merged[merged.length - 1]
    if (previous && segment.start - previous.end <= 0.15 && (previous.speaker ?? '') === (segment.speaker ?? '')) {
      previous.end = Math.max(previous.end, segment.end)
      previous.text = `${previous.text}${/[\u4e00-\u9fa5]$/.test(previous.text) ? '' : ' '}${segment.text}`
    } else {
      merged.push({ ...segment })
    }
  }

  if (options.inferSpeakers === false) return merged
  // 没有 speaker 标签时：按「静音间隔 + 句子结束」交替推断，标成 S1/S2…
  let speakerIndex = 1
  let lastSpeaker = null
  for (let index = 0; index < merged.length; index += 1) {
    const segment = merged[index]
    if (segment.speaker) {
      lastSpeaker = segment.speaker
      continue
    }
    const previous = merged[index - 1]
    const gap = previous ? segment.start - previous.end : Infinity
    const prevEndsSentence = previous ? /[。！？.!?]$/.test(previous.text) : true
    if (lastSpeaker === null) {
      lastSpeaker = 'S1'
    } else if (prevEndsSentence && gap >= 0.3) {
      // 对话常识：上一句说完、且中间有停顿 → 换人（这才是「一问一答」的样子）
      speakerIndex = speakerIndex === 1 ? 2 : 1
      lastSpeaker = `S${speakerIndex}`
    } else if (gap > opts.speakerAlternateGap) {
      speakerIndex = speakerIndex === 1 ? 2 : 1
      lastSpeaker = `S${speakerIndex}`
    }
    segment.speaker = lastSpeaker
  }
  return merged
}

/** 把各镜头的台词按时间线顺序摊平，全局推断说话人（跨镜头也要能认出「换人」）。 */
function assignSpeakersGlobally(shots, fps = 24) {
  const entries = []
  for (const shot of [...shots].sort((a, b) => a.index - b.index)) {
    const segments = normaliseTranscript(shot.transcript ?? [], { inferSpeakers: false })
    for (const segment of segments) {
      const timelineSec =
        Number.isFinite(shot.recordStart) && fps > 0 ? shot.recordStart / fps + segment.start : segment.start
      entries.push({ shot, segment, timelineSec })
    }
  }
  entries.sort((a, b) => a.timelineSec - b.timelineSec)
  let speakerIndex = 1
  let last = null
  let previous = null
  for (const entry of entries) {
    const segment = entry.segment
    if (segment.speaker) {
      last = segment.speaker
      previous = entry
      continue
    }
    const gap = previous ? entry.timelineSec - previous.timelineSec + (previous.segment.end - previous.segment.start) : Infinity
    const prevEndsSentence = previous ? /[。！？.!?]$/.test(previous.segment.text) : true
    const shotChanged = previous ? previous.shot.index !== entry.shot.index : false
    const endsSentence = prevEndsSentence || shotChanged || gap >= 0.35
    if (last === null) {
      last = 'S1'
    } else if (endsSentence && (gap >= 0.12 || shotChanged)) {
      // 上一句说完（标点/换镜头/明显停顿）→ 按对话轮次换人
      speakerIndex = speakerIndex === 1 ? 2 : 1
      last = `S${speakerIndex}`
    }
    segment.speaker = last
    previous = entry
  }
  // 回填到镜头（shot.transcript 原地更新，后续 buildUnits 直接复用）
  for (const entry of entries) {
    const list = entry.shot.transcript
    if (!Array.isArray(list)) continue
    const target = list.find((item) => Number(item.start) === entry.segment.start && Number(item.end) === entry.segment.end)
    if (target) target.speaker = entry.segment.speaker
  }
  return shots
}

/**
 * 去标点、去空格，用于 n-gram 比对。
 */
function normaliseForMatch(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,。.！!？?；;：:、“”"'（）()【】\[\]…—\-~～]/g, '')
}

/** 生成 n-gram 集合（中文按字，覆盖 2/3/4/6 字）。 */
function ngramsOf(text, sizes = [2, 3, 4, 6]) {
  const flat = normaliseForMatch(text)
  const set = new Set()
  for (const size of sizes) {
    for (let index = 0; index + size <= flat.length; index += 1) {
      set.add(flat.slice(index, index + size))
    }
  }
  return { flat, set }
}

/**
 * 台词衔接图：找出「B 重复了 A 的结尾」这类接戏条。
 *
 * 为什么需要：实拍台词常会多说一部分用来接戏——A 说到“很高兴认识你”，
 * B 从“很高兴认识你”重复起。这既是**顺序依据**（B 必须紧跟 A），
 * 也是**取舍依据**（不能为了控时长把 A 的结尾或 B 的开头切掉）。
 *
 * @returns {{pairs: Array, byShot: Map, chains: Array}}
 */
export function buildContinuationGraph(shots, options = {}) {
  const minOverlapChars = Number(options.minOverlapChars) || 4
  const list = [...shots].sort((a, b) => a.index - b.index)
  const texts = list.map((shot) => ({
    shot,
    ...ngramsOf((shot.transcript ?? []).map((segment) => segment.text).join('')),
  }))
  const pairs = []
  const byShot = new Map()
  const pushPair = (pair) => {
    pairs.push(pair)
    if (!byShot.has(pair.fromShot)) byShot.set(pair.fromShot, [])
    byShot.get(pair.fromShot).push(pair)
  }

  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const a = texts[i]
      const b = texts[j]
      if (a.flat.length < minOverlapChars || b.flat.length < minOverlapChars) continue
      // A 的结尾 vs B 的开头：取最长的公共后缀/前缀重叠
      let overlap = 0
      const maxCheck = Math.min(a.flat.length, b.flat.length, 48)
      for (let size = maxCheck; size >= minOverlapChars; size -= 1) {
        if (a.flat.slice(-size) === b.flat.slice(0, size)) {
          overlap = size
          break
        }
      }
      if (overlap >= minOverlapChars) {
        pushPair({
          kind: overlap >= b.flat.length * 0.85 ? 'duplicate' : 'continuation',
          fromShot: a.shot.index,
          toShot: b.shot.index,
          overlapChars: overlap,
          overlapText: a.flat.slice(-overlap),
          fromTail: a.flat.slice(-Math.max(overlap, 8)),
          toHead: b.flat.slice(0, Math.max(overlap, 8)),
          reason: `第 ${b.shot.index} 条开头重复了第 ${a.shot.index} 条结尾「${a.flat.slice(-overlap)}」→ 接戏条，应紧跟`,
        })
        continue
      }
      // 同一条台词重拍：开头相同且相似度高
      const commonPrefix = (() => {
        const limit = Math.min(a.flat.length, b.flat.length)
        let k = 0
        while (k < limit && a.flat[k] === b.flat[k]) k += 1
        return k
      })()
      if (commonPrefix >= Math.max(6, Math.min(a.flat.length, b.flat.length) * 0.6)) {
        pushPair({
          kind: 'retake',
          fromShot: a.shot.index,
          toShot: b.shot.index,
          overlapChars: commonPrefix,
          overlapText: a.flat.slice(0, commonPrefix),
          reason: `第 ${b.shot.index} 条与第 ${a.shot.index} 条开头高度相似（${commonPrefix} 字）→ 同句重拍，二选一`,
        })
      }
    }
  }
  // 串成链（A→B→C）
  const nextOf = new Map(pairs.filter((pair) => pair.kind === 'continuation').map((pair) => [pair.fromShot, pair.toShot]))
  const chains = []
  const seen = new Set()
  for (const shot of list) {
    if (seen.has(shot.index)) continue
    const chain = [shot.index]
    let cursor = shot.index
    while (nextOf.has(cursor)) {
      const next = nextOf.get(cursor)
      if (seen.has(next) || chain.includes(next)) break
      chain.push(next)
      seen.add(next)
      cursor = next
    }
    seen.add(shot.index)
    if (chain.length > 1) chains.push(chain)
  }
  return { pairs, byShot, chains }
}

/** 按语义去重的台词清单（用于覆盖率检查：哪些台词「必须有」）。 */
export function dialogueInventory(shots, options = {}) {
  const list = [...shots].sort((a, b) => a.index - b.index)
  const inventory = []
  for (const shot of list) {
    const segments = normaliseTranscript(shot.transcript ?? [], { inferSpeakers: false })
    for (const segment of segments) {
      if (isCueLine(segment.text)) continue
      const { flat } = ngramsOf(segment.text)
      if (flat.length < 2) continue
      // 同义判据：完全相同 / 互含 / 关键词覆盖率（“我在西南开大车…” vs “我当年的时候开大车在西南”）
      const flatCoverage = (shorter, longer) => {
        if (!shorter.length) return 0
        const counts = new Map()
        for (const char of longer) counts.set(char, (counts.get(char) ?? 0) + 1)
        let hit = 0
        for (const char of shorter) {
          const left = counts.get(char) ?? 0
          if (left > 0) {
            hit += 1
            counts.set(char, left - 1)
          }
        }
        return hit / shorter.length
      }
      const hasSharedPhrase = (a, b) => {
        const bSet = new Set()
        for (let i = 0; i + 3 <= b.length; i += 1) bSet.add(b.slice(i, i + 3))
        for (let i = 0; i + 3 <= a.length; i += 1) if (bSet.has(a.slice(i, i + 3))) return true
        return false
      }
      const same = inventory.find((entry) => {
        if (entry.flat === flat) return true
        const shorterLength = Math.min(entry.flat.length, flat.length)
        if (shorterLength < 4) return false
        const shorter = entry.flat.length <= flat.length ? entry.flat : flat
        const longer = entry.flat.length <= flat.length ? flat : entry.flat
        // 互含关系（“在西南开大车” vs “我当年在西南开大车”）
        if ((longer.includes(shorter)) && shorterLength / longer.length >= 0.55) return true
        // 关键词重合（共同 3-gram + 短句字符覆盖率高）→ 视为同一句的不同说法
        return hasSharedPhrase(entry.flat, flat) && flatCoverage(shorter, longer) >= 0.6
      })
      if (same) {
        same.occurrences.push({ shotIndex: shot.index, text: segment.text })
      } else {
        inventory.push({ flat, text: segment.text, shotIndex: shot.index, occurrences: [{ shotIndex: shot.index, text: segment.text }] })
      }
    }
  }
  return inventory
}

/**
 * 场记口令 / 现场喊话：不是台词，不能当对白剪进戏里。
 * "Rolling!" / "Action" / "Cut" / "开机" / "保一条" / "NG" —— 按**整句精确匹配**，
 * 不能按前缀（否则“走吧”“开始做吧”这种正常台词会被误杀）。
 */
const CUE_EXACT = new Set([
  'rolling', 'speed', 'action', 'cut', 'slate', 'markit', 'ng', 'ok', 'good', 'again', 'reset', 'quiet',
  'andaction', 'camera', 'sound',
  '开机', '开始', '停', '卡', '过', '过了', '保一条', '再保一条', '再来一条', '准备', '预备',
  '三二一', '一二三', '走', '安静', '录音', '拍板', '场记', '好', '可以',
])

export function isCueLine(text) {
  const flat = String(text ?? '').toLowerCase().replace(/[\s\p{P}]/gu, '')
  if (!flat) return false
  if (CUE_EXACT.has(flat)) return true
  if (/^(scene\d+|take\d+)$/.test(flat)) return true
  return false
}

/** 中文/英文句子切分（保留标点）。 */
export function splitSentences(text) {
  const source = String(text ?? '').trim()
  if (!source) return []
  const parts = source.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [source]
  return parts.map((part) => part.trim()).filter(Boolean)
}

function relativeToShot(segment, shot) {
  const start = clamp(segment.start - shot.start, 0, Math.max(0, shot.duration))
  const end = clamp(segment.end - shot.start, start, Math.max(0, shot.duration))
  return { ...segment, start, end, absStart: segment.start, absEnd: segment.end }
}

/** 把每个镜头的台词整理成「句子单元」，并标出静默段。 */
export function buildUnits(shots, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  assignSpeakersGlobally(shots, Number(options.fps) || 24)
  const units = []
  for (const shot of shots) {
    const transcript = normaliseTranscript(shot.transcript ?? [], { ...opts, inferSpeakers: false })
    const segments = transcript.map((segment) => relativeToShot(segment, shot)).filter((segment) => segment.end > segment.start)
    if (segments.length === 0) {
      units.push({ kind: 'silent', shotIndex: shot.index, start: 0, end: shot.duration, duration: shot.duration, text: null, speaker: null, shot })
      continue
    }
    // 相邻且间隔很小的片段合并成句子单元（场记口令不进入台词单元）
    let cursor = 0
    for (const segment of segments) {
      if (isCueLine(segment.text)) {
        cursor = Math.max(cursor, segment.end)
        continue
      }
      if (segment.start - cursor > opts.sentenceGap) {
        const gapStart = cursor
        const gapEnd = segment.start
        if (gapEnd - gapStart >= opts.minShot) {
          units.push({ kind: 'silent', shotIndex: shot.index, start: gapStart, end: gapEnd, duration: gapEnd - gapStart, text: null, speaker: null, shot })
        }
      }
      units.push({
        kind: 'dialogue',
        shotIndex: shot.index,
        start: segment.start,
        end: segment.end,
        duration: segment.end - segment.start,
        text: segment.text,
        speaker: segment.speaker,
        shot,
      })
      cursor = segment.end
    }
    if (shot.duration - cursor >= opts.minShot) {
      units.push({ kind: 'silent', shotIndex: shot.index, start: cursor, end: shot.duration, duration: shot.duration - cursor, text: null, speaker: null, shot })
    }
  }
  return units
}

/** 完整剧本（按镜头时间顺序）——用于人工/模型核对台词是否连贯。 */
export function buildScript(shots, options = {}) {
  const fps = Number(options.fps) || 24
  assignSpeakersGlobally(shots, fps)
  const lines = []
  const speakers = new Set()
  for (const shot of [...shots].sort((a, b) => a.index - b.index)) {
    const transcript = normaliseTranscript(shot.transcript ?? [], { inferSpeakers: false })
    for (const segment of transcript) {
      speakers.add(segment.speaker ?? 'S?')
      lines.push({
        shotIndex: shot.index,
        clipName: shot.name ?? null,
        start: round(segment.start, 3),
        end: round(segment.end, 3),
        speaker: segment.speaker ?? 'S?',
        text: segment.text,
        isCue: isCueLine(segment.text),
      })
    }
  }
  // 连贯性检查：说话人轮次是否出现「A-B-A-B」以外的异常（同人连续说话其实正常，只报告统计）
  const turns = []
  for (const line of lines) {
    if (turns.length === 0 || turns[turns.length - 1].speaker !== line.speaker) {
      turns.push({ speaker: line.speaker, start: line.start, end: line.end, lines: [line] })
    } else {
      const turn = turns[turns.length - 1]
      turn.end = line.end
      turn.lines.push(line)
    }
  }
  const dialogueLines = lines.filter((line) => !line.isCue)
  return {
    lines,
    cueCount: lines.length - dialogueLines.length,
    dialogueLines,
    speakerCount: speakers.size,
    speakers: [...speakers],
    turns: turns.map((turn) => ({
      speaker: turn.speaker,
      start: turn.start,
      end: turn.end,
      text: turn.lines.map((line) => line.text).join(' '),
      lines: turn.lines.length,
    })),
    duration: lines.reduce((acc, line) => acc + (line.end - line.start), 0),
  }
}

function motionForShot(shot) {
  return shot.motion ?? { samples: [], stillThreshold: 0, stills: [], valleys: [], peaks: [] }
}

/** 给一个单元挑切点：台词单元保护整句，静默单元找静止点。 */
function placeUnit(unit, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const shot = unit.shot
  const curve = motionForShot(shot)
  if (unit.kind === 'dialogue') {
    const inTarget = clamp(unit.start - LEADS.in, 0, Math.max(0, shot.duration - 0.2))
    const pick = pickSafeCut(curve, Math.max(0, inTarget - 0.35), Math.min(shot.duration, inTarget + 0.35))
    const inPoint = curve.samples?.length ? clamp(pick.t, Math.max(0, unit.start - 0.6), unit.start) : inTarget
    const outTarget = clamp(unit.end + LEADS.out, inPoint + 0.2, shot.duration)
    const peaks = Array.isArray(curve.peaks) ? curve.peaks : []
    const avoidPeak = (pick) => {
      if (!peaks.length) return pick
      const near = peaks.find((peak) => Math.abs(peak - pick.t) < 0.25)
      if (!near) return pick
      // 往两侧挪 0.3s 找一个不是峰值的采样点（仍要 ≥ unit.end）
      const candidates = [pick.t - 0.3, pick.t + 0.3, pick.t - 0.6, pick.t + 0.6]
        .filter((time) => time >= unit.end && time <= shot.duration)
        .map((time) => ({ t: Number(time.toFixed(3)), kind: 'valley', energy: null, distance: 0 }))
      const safe = candidates.find((candidate) => !peaks.some((peak) => Math.abs(peak - candidate.t) < 0.25))
      return safe ?? pick
    }
    const outPick = avoidPeak(
      pickSafeCut(curve, Math.max(inPoint + 0.2, outTarget - 0.8), Math.min(shot.duration, outTarget + 0.8)),
    )
    const outPoint = curve.samples?.length ? clamp(outPick.t, unit.end, Math.min(shot.duration, unit.end + 0.8)) : outTarget
    const hasStills = (curve.stills ?? []).length > 0
    const cutQuality = !hasStills || pick.kind === 'best-effort' ? 'forced' : 'settled'
    return {
      in: round(inPoint, 3),
      out: round(Math.max(outPoint, inPoint + opts.minShot), 3),
      cutQuality,
      cutIn: pick,
      cutOut: outPick,
      reason: `台词「${unit.text.slice(0, 24)}${unit.text.length > 24 ? '…' : ''}」整句保留（入点提前 ${LEADS.in}s，出点留 ${LEADS.out}s 余韵）`,
    }
  }
  // 注意：静默段的切点必须严格夹在 [unit.start, unit.end] 内，否则会越界切进相邻台词
  const inPick = pickSafeCut(curve, unit.start, Math.min(unit.end - 0.05, unit.start + 1.6))
  const outPick = pickSafeCut(curve, Math.min(unit.end, Math.max(inPick.t + opts.minShot, unit.end - 1.6)), unit.end)
  const inPoint = clamp(inPick.t, unit.start, Math.max(unit.start, unit.end - opts.minShot))
  const outPoint = clamp(outPick.t, inPoint + opts.minShot, unit.end)
  const hasStills = (curve.stills ?? []).length > 0
  return {
    in: round(inPoint, 3),
    out: round(outPoint, 3),
    cutQuality: !hasStills || inPick.kind === 'best-effort' || outPick.kind === 'best-effort' ? 'forced' : 'settled',
    cutIn: inPick,
    cutOut: outPick,
    reason: inPick.kind === 'best-effort' || outPick.kind === 'best-effort' ? '无台词段，退化为中点切（该段没有明显停稳点）' : '无台词段：切在动作停稳的谷值上',
  }
}

/**
 * 生成剧情剪辑方案。
 * @returns {{edits: object[], script: object, diagnostics: object, notes: string[]}}
 */
export function planStoryEdit({ shots = [], targetDuration = DEFAULT_OPTIONS.targetDuration, options = {} } = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const fps = Number(options.fps) || 24
  const sorted = [...shots].sort((a, b) => a.index - b.index)
  assignSpeakersGlobally(sorted, fps)
  const script = buildScript(sorted, { fps })
  const units = buildUnits(sorted, { ...opts, fps })

  // 台词衔接图与「必须有」的台词清单
  const continuation = buildContinuationGraph(sorted, opts)
  const inventory = dialogueInventory(sorted, opts)

  // 逐单元打分：台词优先；同样台词时优先「动作更稳」的镜头
  const scored = units.map((unit) => {
    const curve = motionForShot(unit.shot)
    const stillBonus = curve.stills?.some((still) => unit.start >= still.start - 1 && unit.start <= still.end + 1) ? 0.15 : 0
    const base = unit.kind === 'dialogue' ? opts.dialogueWeight : opts.silentWeight
    const weight = base + stillBonus
    return { unit, weight, score: round(clamp(weight, 0, 2) / 2, 3) }
  })

  // 选单元：先按「台词完整性」排序保底（每个说话人至少保留一句），再按权重补足时长
  const chosen = []
  let total = 0
  const speakerKept = new Set()
  const dialogueFirst = scored.filter((entry) => entry.unit.kind === 'dialogue')
  for (const entry of dialogueFirst) {
    const speaker = entry.unit.speaker
    if (speakerKept.has(speaker)) continue
    const placed = placeUnit(entry.unit, opts)
    const duration = placed.out - placed.in
    if (total + duration > targetDuration * 1.25) continue
    chosen.push({ entry, placed, duration })
    speakerKept.add(speaker)
    total += duration
  }
  const rest = scored
    .filter((entry) => !chosen.some((item) => item.entry === entry))
    .sort((a, b) => b.weight - a.weight || a.unit.shotIndex - b.unit.shotIndex)
  for (const entry of rest) {
    // 静默单元如果和同一镜头里已选的台词单元重叠，直接跳过（会切进台词）
    if (entry.unit.kind === 'silent') {
      const overlap = chosen.some((item) => {
        if (item.entry.unit.shotIndex !== entry.unit.shotIndex) return false
        if (item.entry.unit.kind !== 'dialogue') return false
        return entry.unit.start < item.entry.unit.end && entry.unit.end > item.entry.unit.start
      })
      if (overlap) continue
    }
    const placed = placeUnit(entry.unit, opts)
    let duration = placed.out - placed.in
    if (duration < opts.minShot) continue
    if (total + duration > targetDuration) {
      // 超时长：允许裁剪静默段（台词段绝不裁剪）
      if (entry.unit.kind === 'dialogue') continue
      duration = clamp(targetDuration - total, 0, duration)
      if (duration < opts.minShot) continue
      const trimmedOut = round(placed.in + duration, 3)
      chosen.push({ entry, placed: { ...placed, out: trimmedOut, reason: `${placed.reason}；为控时长截到 ${round(duration, 1)}s` }, duration })
      total += duration
      continue
    }
    chosen.push({ entry, placed, duration })
    total += duration
    if (total >= targetDuration * 0.98) break
  }

  // —— 覆盖率兜底：独立语义台词不能被漏掉（漏了要显式报告）——
  const flatOf = (text) => String(text ?? '').replace(/[\s\u3000，,。.！!？?；;：:、“”"'（）()【】\[\]…—\-~～]/g, '')
  const covers = (unit, line) => {
    if (!unit || unit.kind !== 'dialogue') return false
    const a = flatOf(unit.text)
    const b = line.flat
    if (!a || !b) return false
    if (a === b) return true
    return (a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.55
  }
  const dialogueChosen = () => chosen.filter((item) => item.entry.unit.kind === 'dialogue')
  for (const line of inventory) {
    if (dialogueChosen().some((item) => covers(item.entry.unit, line))) continue
    // 找最合适的单元：优先同一镜头、其次任何包含这句的镜头
    const candidates = scored.filter((entry) => entry.unit.kind === 'dialogue' && covers(entry.unit, line))
    if (candidates.length === 0) continue
    candidates.sort((a, b) => (a.unit.shotIndex === line.shotIndex ? -1 : 0) - (b.unit.shotIndex === line.shotIndex ? -1 : 0) || b.weight - a.weight)
    const entry = candidates[0]
    const placed = placeUnit(entry.unit, opts)
    const duration = placed.out - placed.in
    // 台词覆盖率优先：宁可超时长也不能漏台词（用户实测发现漏台词比超时长更严重）
    chosen.push({ entry, placed, duration, coverageForced: true, overBudget: total + duration > targetDuration * 1.35 })
    total += duration
  }

  // 按时间顺序输出（保持原时序，避免台词前后颠倒）
  chosen.sort((a, b) => a.entry.unit.shotIndex - b.entry.unit.shotIndex || a.placed.in - b.placed.in)
  const edits = chosen.map(({ entry, placed, duration }, index) => ({
    index: index + 1,
    shotIndex: entry.unit.shotIndex,
    itemId: entry.unit.shot.itemId ?? null,
    clipId: entry.unit.shot.clipId ?? null,
    name: entry.unit.shot.name ?? null,
    // 镜头在源素材里的绝对起止（供 edit.story 换算帧）
    shotStartSec: round(entry.unit.shot.start ?? 0, 3),
    shotEndSec: round(entry.unit.shot.end ?? 0, 3),
    recordStart: entry.unit.shot.recordStart ?? null,
    in: placed.in,
    out: placed.out,
    duration: round(duration, 3),
    kind: entry.unit.kind,
    speaker: entry.unit.speaker ?? null,
    text: entry.unit.text ?? null,
    score: entry.score,
    continuationOf: continuation.pairs.find((pair) => pair.toShot === entry.unit.shotIndex)?.fromShot ?? null,
    chainText: continuation.pairs.find((pair) => pair.toShot === entry.unit.shotIndex)?.overlapText ?? null,
    coverageForced: Boolean(entry.coverageForced),
    reason: placed.reason,
    cutQuality: placed.cutQuality ?? 'settled',
    cutIn: placed.cutIn,
    cutOut: placed.cutOut,
  }))

  const selectedDialogue = edits.filter((edit) => edit.kind === 'dialogue')
  const coveredLines = inventory.filter((line) => selectedDialogue.some((edit) => covers({ kind: 'dialogue', text: edit.text }, line)))
  const droppedDialogue = inventory
    .filter((line) => !coveredLines.includes(line))
    .map((line) => ({
      text: line.text,
      shotIndex: line.shotIndex,
      overlaps: line.occurrences.length,
      reason: '被时长预算挤掉：该句在候选台词里有，但没有进入成片',
    }))
  const coverage = {
    total: inventory.length,
    covered: coveredLines.length,
    ratio: inventory.length === 0 ? 1 : Number((coveredLines.length / inventory.length).toFixed(3)),
  }
  const diagnostics = validatePlan({ edits, shots: sorted, options: opts, continuation })
  const notes = []
  if (edits.length === 0) notes.push('没有任何可用的台词/动作单元：请先跑 story.transcribe 或提供 transcript。')
  if (diagnostics.issues.length > 0) notes.push(`有 ${diagnostics.issues.length} 处切点需要注意（见 diagnostics.issues）`)
  if (droppedDialogue.length > 0) notes.push(`有 ${droppedDialogue.length} 句台词没进成片（见 droppedDialogue）`)
  if (continuation.pairs.length > 0) notes.push(`检出 ${continuation.pairs.length} 处接戏/重拍关系（见 continuation）`)
  return {
    edits,
    script,
    diagnostics,
    notes,
    continuation,
    coverage,
    droppedDialogue,
    totalDuration: round(edits.reduce((acc, edit) => acc + edit.duration, 0), 3),
    options: opts,
  }
}

/** 校验：切点是否碎句、是否切在动作中间、说话人顺序是否被破坏。 */
export function validatePlan({ edits = [], shots = [], options = {}, continuation = null } = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const issues = []
  // 接戏条：A、B 都被选中时，B 应紧挨在 A 后面（中间不该插别的镜头）
  if (continuation?.pairs?.length) {
    const order = edits.map((edit) => edit.shotIndex)
    for (const pair of continuation.pairs.filter((item) => item.kind === 'continuation')) {
      const fromIndex = order.indexOf(pair.fromShot)
      const toIndex = order.indexOf(pair.toShot)
      if (fromIndex === -1 || toIndex === -1) {
        if (toIndex !== -1 || fromIndex !== -1) {
          issues.push({ id: 'chain-split', severity: 'info', detail: `接戏条 ${pair.fromShot}→${pair.toShot} 只保留了其中一条：衔接台词可能缺一半` })
        }
        continue
      }
      if (toIndex !== fromIndex + 1) {
        issues.push({ id: 'chain-gap', severity: 'info', detail: `接戏条 ${pair.fromShot}→${pair.toShot} 之间插了 ${toIndex - fromIndex - 1} 刀，衔接会断` })
      }
    }
  }
  const byIndex = new Map(shots.map((shot) => [shot.index, shot]))
  let lastSpeaker = null
  for (const edit of edits) {
    const shot = byIndex.get(edit.shotIndex)
    if (!shot) continue
    // 兼容两种约定：镜头内相对秒（默认）/ 源素材绝对秒
    const absolute = Number(edit.in) > Number(shot.duration) + 0.01 || Number(edit.out) > Number(shot.duration) + 0.01
    const editIn = absolute ? Number(edit.in) - Number(shot.start) : Number(edit.in)
    const editOut = absolute ? Number(edit.out) - Number(shot.start) : Number(edit.out)
    const curve = motionForShot(shot)
    // 1) 碎句：入点/出点落在某句台词的中间
    const transcript = normaliseTranscript(shot.transcript ?? []).map((segment) => relativeToShot(segment, shot))
    for (const segment of transcript) {
      const cutsInside = (editIn > segment.start + 0.05 && editIn < segment.end - 0.05) || (editOut > segment.start + 0.05 && editOut < segment.end - 0.05)
      if (cutsInside) {
        issues.push({ id: 'sentence-split', shotIndex: edit.shotIndex, editIndex: edit.index, detail: `切点落在台词「${segment.text.slice(0, 20)}」中间` })
      }
    }
    // 2) 动作中间切：入/出点附近有运动峰值
    if (Array.isArray(curve.peaks) && curve.peaks.length > 0) {
      const sampleAt = (point) => (curve.samples ?? []).reduce((best, sample) => (Math.abs(sample.t - point) < Math.abs(best.t - point) ? sample : best), { t: -1, energy: 0 })
      for (const [label, point] of [['in', editIn], ['out', editOut]]) {
        const sample = sampleAt(point)
        const nearPeak = curve.peaks.some((peak) => Math.abs(peak - point) < 0.2)
        const maxEnergy = Math.max(0.001, ...(curve.samples ?? []).map((entry) => entry.energy))
        if (nearPeak && sample.energy > maxEnergy * 0.6) {
          issues.push({
            id: edit.cutQuality === 'forced' ? 'forced-motion' : 'mid-action',
            severity: 'info',
            shotIndex: edit.shotIndex,
            editIndex: edit.index,
            detail: `${label} 点在峰值附近（能量 ${sample.energy}），该镜头没有可用静止点，属「被迫在运动中切」`,
          })
        }
      }
    }
    // 3) 说话人轮次：同一说话人连续出现是正常的；但 A→B→A 中间缺 B 才算异常，这里只记录轮次
    if (edit.speaker) {
      if (lastSpeaker && lastSpeaker === edit.speaker && edit.kind === 'dialogue') {
        issues.push({ id: 'same-speaker-repeat', severity: 'info', shotIndex: edit.shotIndex, editIndex: edit.index, detail: `连续两句都是 ${edit.speaker}（可能是同一段话被切成多条）` })
      }
      lastSpeaker = edit.speaker
    }
  }
  const blocking = issues.filter((issue) => !['same-speaker-repeat', 'forced-motion', 'chain-split', 'chain-gap', 'dropped-dialogue'].includes(issue.id))
  return {
    ok: blocking.length === 0,
    issues,
    blocking,
    summary: `切点 ${edits.length * 2} 个，问题 ${blocking.length} 处`,
    thresholds: { minShot: opts.minShot, sentenceGap: opts.sentenceGap },
  }
}

export { DEFAULT_OPTIONS as STORY_DEFAULTS }
