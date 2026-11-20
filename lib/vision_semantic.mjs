/**
 * 视觉模型语义选镜：把每个镜头的代表帧交给带 image 输入的 LLM，要求返回严格 JSON。
 * 这里只做「提示词构造 / 解析 / 与镜头合并」的纯逻辑；真正的调用在 host 里（ctx.llm + ctx.attachments）。
 */

export const VISION_SCHEMA_VERSION = 1

export const VISION_SYSTEM_PROMPT = [
  '你是影视剪辑的选镜助理。你会看到按顺序编号的镜头代表帧。',
  '只描述你确实看到的内容，不要猜测镜头之外的信息。',
  '对每一帧输出一个对象，字段：',
  '{"index":序号(从1开始),"description":"一句话画面描述","subjects":["主体"],"setting":"indoor-studio|outdoor-campus|nature|city|other","themeFit":0到1,"usable":true/false,"confidence":0到1}',
  'themeFit 表示与用户指定主题的相关程度；usable 表示画面是否适合作为成片镜头（严重失焦、全黑、纯测试卡为 false）。',
  '只输出 JSON 数组，不要 markdown、不要解释、不要代码块。',
].join('\n')

export function buildVisionUserPrompt({ theme = 'auto', count = 0 } = {}) {
  const themeText = {
    'campus-autumn': '校园秋日短片（户外校园、秋叶、学生日常，不要棚拍/黑板/演播室）',
    natural: '自然/户外题材',
    studio: '棚拍/教室/讲解类题材（黑板、演播室、人物讲解可接受）',
    auto: '通用校园/自然题材（默认排除棚拍/黑板/演播室）',
  }[theme] ?? theme
  return `主题：${themeText}\n共 ${count} 张图，按给定顺序编号 1..${count}。请输出长度 ${count} 的 JSON 数组。`
}

export function extractJsonArray(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : raw
  const start = candidate.search(/\[/)
  if (start < 0) return null
  // 从第一个 [ 开始做括号配对，避免模型在数组后附带说明
  let depth = 0; let inString = false; let escape = false
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(candidate.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

function clamp01(value, fallback = 0) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(1, Math.max(0, num))
}

/** 把模型输出规范化为按 index 对齐的 labels；跳过无效项。 */
export function parseVisionLabels(text, expectedCount = 0) {
  const arr = extractJsonArray(text)
  if (!Array.isArray(arr)) return { ok: false, error: '模型输出不是 JSON 数组', labels: [] }
  const settings = new Set(['indoor-studio', 'outdoor-campus', 'nature', 'city', 'other'])
  const labels = []
  for (let i = 0; i < arr.length; i += 1) {
    const item = arr[i]
    if (!item || typeof item !== 'object') continue
    const index = Number(item.index)
    if (!Number.isFinite(index) || index < 1) continue
    labels.push({
      index,
      description: String(item.description ?? '').slice(0, 300),
      subjects: Array.isArray(item.subjects) ? item.subjects.map((subject) => String(subject)).slice(0, 8) : [],
      setting: settings.has(item.setting) ? item.setting : 'other',
      themeFit: clamp01(item.themeFit, 0.5),
      usable: item.usable !== false,
      confidence: clamp01(item.confidence, 0.5),
    })
  }
  if (!labels.length) return { ok: false, error: '没有可用的 label 对象', labels: [] }
  if (expectedCount && labels.length !== expectedCount) {
    return { ok: true, partial: true, labels, error: `期望 ${expectedCount} 个 label，实际 ${labels.length}` }
  }
  return { ok: true, labels }
}

/** 视觉标签是否允许该镜头进入主题剪辑。 */
export function judgeVisionLabel(label, theme = 'auto') {
  if (!label) return { keep: false, reason: 'no label' }
  if (label.usable === false) return { keep: false, reason: 'model marked unusable' }
  if (theme !== 'studio' && label.setting === 'indoor-studio') return { keep: false, reason: 'indoor studio/blackboard' }
  const floor = theme === 'studio' ? 0 : 0.35
  if (label.themeFit < floor) return { keep: false, reason: `themeFit ${label.themeFit.toFixed(2)} < ${floor}` }
  if (label.confidence < 0.25) return { keep: false, reason: `confidence ${label.confidence.toFixed(2)} too low` }
  return { keep: true, reason: 'vision accepted' }
}

/** 把 labels 与扫描镜头合并；无 label 的镜头保留（不因单帧缺失而丢掉整条素材）。 */
export function selectShotsByVision(scenes, labels, { theme = 'auto' } = {}) {
  const byIndex = new Map((labels ?? []).map((label) => [label.index, label]))
  const kept = []; const excluded = []
  for (const scene of scenes ?? []) {
    const label = byIndex.get(scene.index) ?? null
    if (!label) { kept.push({ ...scene, visionLabel: null }); continue }
    const verdict = judgeVisionLabel(label, theme)
    if (!verdict.keep) {
      excluded.push({ scene: scene.index, clipName: scene.clipName ?? null, reason: verdict.reason, label })
      continue
    }
    kept.push({ ...scene, visionLabel: label })
  }
  return { kept, excluded, theme, labeled: labels?.length ?? 0 }
}
