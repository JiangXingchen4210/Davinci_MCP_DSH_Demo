/**
 * 逐秒视觉理解：把一段镜头的 1fps 序列帧交给视觉模型，得到带时间戳的
 * {action, energy, quality, themeFit, occlusion, description}，再从中选最佳窗口。
 * 压缩尺度实验用 agreement() 比较不同分辨率下同一批秒的理解是否保留。
 */

export const TEMPORAL_SYSTEM_PROMPT = [
  '你是剪辑助理，需要对一段镜头的逐秒画面做连续理解。',
  '每张图都带时间戳。请对每一张输出一个对象：',
  '{"t":秒,"description":"这一秒发生了什么","action":"人物/主体的具体动作","energy":0到1,"quality":0到1,"themeFit":0到1,"occlusion":true/false}',
  'energy=画面内动作幅度/事件强度；quality=清晰度、曝光、构图可用性；themeFit=与给定主题的相关度；occlusion=主体被遮挡或切出画外。',
  '只输出 JSON 数组，长度与图片数一致，不要解释、不要 markdown。',
].join('\n')

export function buildTemporalPrompt({ theme = 'auto', times = [], width = 384 } = {}) {
  const themeText = {
    'campus-autumn': '校园秋日短片',
    natural: '自然/户外题材',
    studio: '棚拍/教室讲解题材',
    auto: '通用校园/自然题材',
  }[theme] ?? theme
  const stamp = (times ?? []).map((t) => `${Number(t).toFixed(2)}s`).join(', ')
  return `主题：${themeText}\n图片按时间顺序排列，时间戳：${stamp}\n每张图约 ${width}px 宽。请输出等长 JSON 数组。`
}

function clamp01(value, fallback = 0) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(1, Math.max(0, num))
}

/** 从模型输出提取 JSON 数组；复用 vision_semantic 的括号配对解析。 */
export async function parseTemporalLabels(text, times, parseArray) {
  const arr = parseArray(text)
  if (!Array.isArray(arr)) return { ok: false, error: '模型输出不是 JSON 数组', labels: [] }
  const labels = []
  for (let i = 0; i < arr.length; i += 1) {
    const item = arr[i]
    if (!item || typeof item !== 'object') continue
    const t = Number(item.t)
    const fallbackT = Number(times?.[i])
    const time = Number.isFinite(t) ? t : (Number.isFinite(fallbackT) ? fallbackT : null)
    if (time === null) continue
    labels.push({
      t: Number(time.toFixed(3)),
      description: String(item.description ?? '').slice(0, 260),
      action: String(item.action ?? '').slice(0, 160),
      energy: clamp01(item.energy, 0.5),
      quality: clamp01(item.quality, 0.5),
      themeFit: clamp01(item.themeFit, 0.5),
      occlusion: item.occlusion === true,
    })
  }
  return labels.length
    ? { ok: true, labels, partial: labels.length !== times?.length }
    : { ok: false, error: '没有可用的逐秒标签', labels: [] }
}

/** 逐秒标签 → 每个候选窗口的平均分。排除遮挡秒和画质低于阈值的秒。 */
export function scoreTemporalWindow(labels, { startSec = 0, endSec = 0, durationSec = 1, stepSec = 0.25, theme = 'auto' } = {}) {
  if (!(labels ?? []).length || !(durationSec > 0)) return { ok: false, error: '没有可用逐秒标签或时长无效', windows: [] }
  const clean = (labels ?? []).filter((label) => !label.occlusion && label.quality >= 0.25)
  // 遮挡/低质秒不直接丢弃整段：全部被遮挡时允许使用，但在分数里惩罚遮挡比例
  const usable = clean.length ? clean : (labels ?? []).filter((label) => label.quality >= 0.2)
  if (!usable.length) return { ok: false, error: '没有可用逐秒标签或时长无效', windows: [] }
  const weights = theme === 'studio' ? { theme: 0.2, quality: 0.5, energy: 0.3 } : { theme: 0.5, quality: 0.3, energy: 0.2 }
  const windows = []
  const latestStart = Math.max(startSec, endSec - durationSec)
  for (let start = startSec; start <= latestStart + 1e-6; start += Math.max(0.1, stepSec)) {
    const end = start + durationSec
    const inside = usable.filter((label) => label.t >= start - 1e-6 && label.t < end - 1e-6)
    if (inside.length < Math.max(1, Math.floor(durationSec / 2))) continue
    const avg = (key) => inside.reduce((sum, label) => sum + label[key], 0) / inside.length
    const themeFit = avg('themeFit'); const quality = avg('quality'); const energy = avg('energy')
    const occluded = inside.filter((label) => label.occlusion).length / inside.length
    const score = themeFit * weights.theme + quality * weights.quality + energy * weights.energy - occluded * 0.15
    windows.push({ start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), score: Number(score.toFixed(4)), seconds: inside.length, themeFit: Number(themeFit.toFixed(3)), quality: Number(quality.toFixed(3)), energy: Number(energy.toFixed(3)), occluded: Number(occluded.toFixed(3)) })
  }
  windows.sort((a, b) => b.score - a.score)
  return windows.length ? { ok: true, best: windows[0], windows } : { ok: false, error: '没有覆盖足够逐秒标签的窗口', windows: [] }
}

/** 压缩尺度一致性：setting/动作词/关键描述与主题分的保留程度。 */
export function agreement(reference, candidate) {
  const ref = reference ?? []; const cand = candidate ?? []
  const n = Math.min(ref.length, cand.length)
  if (!n) return { frames: 0, timeMatch: 0, descriptionJaccard: 0, themeMae: null, qualityMae: null }
  let timeMatch = 0; let themeDiff = 0; let qualityDiff = 0
  for (let i = 0; i < n; i += 1) {
    if (Math.abs((ref[i].t ?? 0) - (cand[i].t ?? 0)) < 0.6) timeMatch += 1
    themeDiff += Math.abs(ref[i].themeFit - cand[i].themeFit)
    qualityDiff += Math.abs(ref[i].quality - cand[i].quality)
  }
  // 中文没有空格：用字符 bigram 的 Jaccard，避免整段中文被当成一个 token
  const bigrams = (text) => {
    const clean = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    const set = new Set()
    for (let i = 0; i + 1 < clean.length; i += 1) set.add(clean.slice(i, i + 2))
    return set
  }
  let jaccardSum = 0
  for (let i = 0; i < n; i += 1) {
    const a = bigrams(ref[i].description); const b = bigrams(cand[i].description)
    const union = new Set([...a, ...b]); let inter = 0
    for (const token of a) if (b.has(token)) inter += 1
    jaccardSum += union.size ? inter / union.size : 0
  }
  return {
    frames: n,
    timeMatch: Number((timeMatch / n).toFixed(3)),
    descriptionJaccard: Number((jaccardSum / n).toFixed(3)),
    themeMae: Number((themeDiff / n).toFixed(3)),
    qualityMae: Number((qualityDiff / n).toFixed(3)),
  }
}
