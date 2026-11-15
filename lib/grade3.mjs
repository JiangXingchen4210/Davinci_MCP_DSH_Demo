#!/usr/bin/env node
/**
 * lib/grade3.mjs — 「三级 + Vibe」调色方案生成器（纯函数、零依赖、ESM）。
 *
 * 这个模块只做两件事：
 *
 *  1. **parseVibe(text)**：把用户的口语描述拆成结构化 intent。
 *     最关键的一条设计约束（模块存在的理由）：
 *       · 「太绿了 / 有点绿 / 发绿 / too green / greenish」 = **整体偏色（global-cast）**
 *         → 一级调色：白平衡 / 去偏色，作用于整帧。
 *       · 「绿幕的绿色溢出 / 绿边 / 溢色 / green spill」 = **键控溢色（keyed-spill）**
 *         → 二级调色：绿色 HSL qualifier 选中溢色像素，局部降饱和 + 轻微降亮。
 *     两者绝不能互相误判：一句「太绿了」不应该生成绿色 qualifier 节点，
 *     一句「绿幕溢色」也不应该整体去绿（那会把画面其它绿色一起杀掉）。
 *
 *  2. **buildTierPlan({analysis, vibe, style})**：把 intent + 分层色彩证据
 *     （lib/layers.mjs 的 analyze 输出）变成一条串联的 drx 节点数组。
 *     节点元素形状固定为 `{ label, params }`，params 里的键名/单位全部来自
 *     docs/advanced-color-api.md §5.2（gradeParams 键表）与 §5.4（实测四层节点图）。
 *
 * 单位约定（照 docs §5.2，**不是** 0–360°）：
 *   - gain 中性 1（≈0.88–1.15 安全区）、lift/offset 中性 0（面板 delta，±0.05 内）、
 *     gamma 中性 0（面板值）
 *   - saturation 0–100，**50 = 中性**
 *   - contrast 中性 1、pivot 中性 0.435、contrastHighRange 中性 0.55
 *   - qualifier / matteFinesse 全部 **UI 0–100**；`hueCenter` 是面板 0–100 刻度，
 *     **不是色相角度**。绿色屏 ≈ 120° → 33.3；肤色 ≈ 25–40° → 7–11。
 *     所以 `lib/layers.mjs` 的 `meanHuePercent` / `dominantHuePercent`（= 度 / 3.6）
 *     可以直接当 hueCenter 用；把 `meanHue` 的度数写进去会让肤色选到绿区。
 *
 * 为什么全部用 `space:'ui'`：调用方（host-impl 的 buildLayeredDrx / drx.merge）
 * 对 newNodes 走 normalizeGradeParams，UI 单位是唯一被 live-confirmed 的刻度
 * （§5.4 的实测 JSON 也是 ui 刻度）。
 *
 * 为什么节点 01 不放 `saturation`：§5.5 实测 merge 会对「已有节点」的 saturation
 * 二次缩放；虽然本模块的节点都是 newNodes（不受影响），但调用方可能把 01 当
 * `generate` 的基线节点用。为两种落地路径都安全，饱和度只放在 02 之后的节点里。
 *
 * 运行自测：node lib/grade3.test.mjs
 */

export const VERSION = '1.0.0'

const STYLES = Object.freeze(['none', 'film', 'punchy', 'clean', 'teal-orange', 'cyberpunk'])

/** UI 刻度的安全钳制范围（越界只会把参数写成噪音，不会更好看）。 */
export const CLAMPS = Object.freeze({
  gain: [0.88, 1.15],
  lift: [-0.05, 0.05],
  offset: [-0.05, 0.05],
  gamma: [-0.1, 0.1],
  saturation: [0, 100],
  contrast: [0.85, 1.32],
  pivot: [0.3, 0.6],
  contrastHighRange: [0.2, 0.9],
  softClip: [0.85, 1.0],
  qualifier: [0, 100],
})

export const AXIS_LABEL = Object.freeze({
  green: '绿',
  blue: '蓝',
  magenta: '品红',
  cyan: '青',
  yellow: '黄',
  red: '红',
  warm: '暖',
  cool: '冷',
  auto: '偏色',
})

// ---------------------------------------------------------------------------
// 小工具：所有对外数值都必须过 clamps + 有限性检查（JSON 里不能出现 NaN）
// ---------------------------------------------------------------------------

function finiteOr(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function clamp(value, min, max, fallback = min) {
  const num = finiteOr(value, fallback)
  return Math.min(max, Math.max(min, num))
}

function clamp01(value) {
  return clamp(value, 0, 1, 0)
}

function clampSigned(value, absMax) {
  return clamp(value, -absMax, absMax, 0)
}

function round(value, digits = 4) {
  const num = finiteOr(value, null)
  if (num == null) return null
  const factor = 10 ** digits
  return Math.round(num * factor) / factor
}

function asLayer(value) {
  return value && typeof value === 'object' ? value : null
}

/** 允许传 analyzeFrame 的返回值、`{layers:{…}}`、或直接一个层映射。 */
function normalizeLayerMap(analysis) {
  if (!analysis || typeof analysis !== 'object') return {}
  if (analysis.layers && typeof analysis.layers === 'object') return analysis.layers
  return analysis
}

function findIntent(intents, kind, predicate = null) {
  if (!Array.isArray(intents)) return null
  for (const intent of intents) {
    if (!intent || intent.kind !== kind) continue
    if (predicate && !predicate(intent)) continue
    return intent
  }
  return null
}

function intentAmount(intent, fallback = 0) {
  if (!intent) return fallback
  return clamp(intent.amount, 0, 1, fallback)
}

// ---------------------------------------------------------------------------
// 词典：颜色轴 / 意图强度 / 上下文
// ---------------------------------------------------------------------------

/**
 * 颜色轴识别。顺序即优先级：「紫红」要先于「红」判成品红；
 * 「青绿」按绿处理（绿幕更常见）；「青」单用按青处理。
 */
const COLOR_RULES = Object.freeze([
  { axis: 'green', re: /绿|greenish|\bgreen\b|green\s+cast/ },
  { axis: 'cyan', re: /青|cyan|\bteal\b|青色/ },
  { axis: 'magenta', re: /品红|洋红|紫红|发紫|偏紫|紫|magenta|purple|pink/ },
  { axis: 'blue', re: /蓝|bluish|\bblue\b|blue\s+cast/ },
  { axis: 'yellow', re: /黄|yellowish|\byellow\b|yellow\s+cast/ },
  { axis: 'red', re: /红|reddish|\bred\b|red\s+cast/ },
  { axis: 'warm', re: /暖|偏暖|warm(?:er)?\b/ },
  { axis: 'cool', re: /冷|偏冷|cool(?:er)?\b/ },
])

/** 强度词：决定 amount（0..1）。 */
const STRONG_RE =
  /太|非常|特别|很|极|严重|明显|厉害|过头|过于|过头|too|very|really|super|way\s+too|extremely|overly|much\s+too|heavily/
const MILD_RE =
  /有点|略微|稍微|稍稍|轻轻|轻微|些微|一点点|一点|略|偏|a\s+bit|a\s+little|slightly|somewhat|kind\s+of|sort\s+of|tinge/

/** 整体性标记：出现它一律按「整体偏色」而不是键控溢色处理。 */
const GLOBAL_MARKER_RE =
  /整体|全局|整个画面|整个|全都|都偏|画面偏|画面整体|通篇|一律|全部|整个片子|overall|globally|whole\s+frame|entire\s+frame|everything|across\s+the\s+frame/

/**
 * 溢色/键控上下文。
 * strong：出现即说明是「幕布/键控」语境，即使没写颜色也按绿幕溢色处理。
 * weak：只有同时出现颜色词才按溢色处理（「边缘」单独出现可能是暗角）。
 * 注意 `幕` 不能单用——「屏幕偏绿」是显示问题而不是溢色。
 */
const STRONG_SPILL_RE =
  /溢色|溢出|键控|抠像|抠图|绿幕|蓝幕|幕布|幕墙|spill|despill|chroma\s*key|green\s*screen|blue\s*screen|keyed|garbage\s*matte/
const WEAK_SPILL_RE = /绿边|蓝边|边缘|边沿|残留|反光|\bedge\b|\bmatte\b|fringe/

const STYLE_RULES = Object.freeze([
  { style: 'cyberpunk', re: /赛博朋克|赛博|cyberpunk|cyber\s*punk|霓虹夜|neon\s+night/ },
  { style: 'teal-orange', re: /青橙|橙青|teal\s*[- ]?\s*orange|orange\s*(?:and|&)\s*teal/ },
  { style: 'film', re: /胶片感|胶片|电影感|电影质感|电影调|filmic|\bfilm\b|film\s+look|柯达|kodak/ },
  { style: 'punchy', re: /浓郁|浓烈|大片|冲击力|punchy|vivid|高反差/ },
  { style: 'clean', re: /清新|干净|通透|自然|\bclean\b|\bnatural\b/ },
])

const SKIN_CONTEXT_RE = /肤色|皮肤|脸部|人脸|脸|肤|skin|complexion|face\b/

const EXPOSURE_UP_RE =
  /太暗|偏暗|暗了|欠曝|曝光不足|提亮|亮一点|亮一些|brighten|too\s+dark|underexpos|lift\s+the\s+exposure/
const EXPOSURE_DOWN_RE =
  /太亮|过亮|偏亮|太曝|过曝|曝光过度|亮爆|overexpos|too\s+bright|too\s+hot|blow\s+out/

const CONTRAST_UP_RE =
  /对比不够|对比不足|对比弱|太平|发灰|灰蒙蒙|灰蒙|不够通透|洗白|washed|flat|low\s+contrast|needs?\s+contrast/
const CONTRAST_DOWN_RE =
  /对比太强|对比过头|太硬|反差太大|too\s+contrasty|too\s+harsh|over.?contrast/

const SAT_UP_RE =
  /太灰|太淡|不够艳|饱和度低|不够饱和|发白|色彩不够|desaturat|too\s+dull|washed\s+out|low\s+saturation|more\s+saturation/
const SAT_DOWN_RE =
  /太艳|饱和太高|太浓|过饱和|色彩太重|over.?saturat|too\s+vivid|too\s+saturated/

/** 分句：标点 + 常见连接词（「而且/还有/另外」把两个意图写在了一句里时也要拆开）。 */
const CLAUSE_SPLIT_RE =
  /[，,。.;；、!！?？\n\r]+|(?:\s+(?:and|but|plus|also)\s+)|而且|同时|另外|还有|并且|以及|顺便|加上/

function splitClauses(text) {
  return String(text ?? '')
    .split(CLAUSE_SPLIT_RE)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

function detectColor(text) {
  for (const rule of COLOR_RULES) {
    if (rule.re.test(text)) return rule.axis
  }
  return null
}

function detectAmount(text) {
  if (STRONG_RE.test(text)) return 0.78
  if (MILD_RE.test(text)) return 0.45
  return 0.6
}

function detectStyle(text) {
  for (const rule of STYLE_RULES) {
    if (rule.re.test(text)) return rule.style
  }
  return null
}

function pushIntent(intents, intent) {
  if (!intent || !intent.kind) return
  const duplicate = intents.some(
    (existing) =>
      existing.kind === intent.kind &&
      existing.axis === intent.axis &&
      existing.direction === intent.direction &&
      existing.style === intent.style,
  )
  if (!duplicate) intents.push(intent)
}

// ---------------------------------------------------------------------------
// parseVibe：中文 / 英文口语 → intents
// ---------------------------------------------------------------------------

/**
 * 解析一句（或一段）口语化的调色诉求。
 *
 * @param {string} text 用户原话
 * @returns {{intents: Array<object>, summary: string}}
 *   intent.kind ∈ 'global-cast'（一级整体偏色）| 'keyed-spill'（二级键控溢色）|
 *     'skin-key' | 'background-key' | 'luma-key' | 'exposure' | 'contrast' |
 *     'saturation' | 'look'
 */
export function parseVibe(text) {
  const raw = typeof text === 'string' ? text : ''
  const intents = []

  for (const clause of splitClauses(raw)) {
    for (const intent of parseClause(clause)) pushIntent(intents, intent)
  }

  return { intents, summary: summarizeIntents(intents) }
}

/** 解析一个分句；一个分句最多归入一类主意图，避免同一句话被重复计数。 */
function parseClause(clause) {
  const text = clause.toLowerCase()
  const out = []

  // 1) 风格词先摘出来（「青橙」里的「青」不能当成背景偏青）
  const style = detectStyle(text)
  if (style) out.push({ kind: 'look', style, amount: 1 })
  const restText = style ? text.replace(STYLE_RULES.find((r) => r.style === style).re, ' ') : text
  if (!restText.trim()) return out

  // 2) 肤色键控：只要语境里有「肤色/皮肤/脸」，就归二级肤色 qualifier
  if (SKIN_CONTEXT_RE.test(restText)) {
    const amount = detectAmount(restText)
    if (/蜡黄|发黄|偏黄|土黄|黄气|sallow|yellow/.test(restText)) {
      out.push({ kind: 'skin-key', axis: 'skin', direction: 'yellow', amount })
    } else if (/太红|发红|偏红|红血丝|泛红|痘|too\s+red|reddish|ruddy/.test(restText)) {
      out.push({ kind: 'skin-key', axis: 'skin', direction: 'red', amount })
    } else if (/太绿|发绿|偏绿|green/.test(restText)) {
      out.push({ kind: 'skin-key', axis: 'skin', direction: 'green', amount })
    } else if (/太白|惨白|苍白|发白|pale|too\s+white|pallid/.test(restText)) {
      out.push({ kind: 'skin-key', axis: 'skin', direction: 'pale', amount })
    } else if (/太暗|发黑|黑|too\s+dark|shadowed/.test(restText)) {
      out.push({ kind: 'skin-key', axis: 'skin', direction: 'dark', amount })
    } else {
      out.push({ kind: 'skin-key', axis: 'skin', direction: 'auto', amount })
    }
    return out
  }

  // 3) luma 键控：高光爆 / 暗部死黑
  const highlightHit = /高光|过曝|高亮|死白|白切|highlights?|blown|clipped/.test(restText)
  const shadowHit = /暗部|死黑|黑死|死区|欠曝|压暗|shadow|crush|underexpos/.test(restText)
  if (highlightHit || shadowHit) {
    const amount = detectAmount(restText)
    if (highlightHit) out.push({ kind: 'luma-key', axis: 'highlight', direction: 'compress', amount })
    if (shadowHit) out.push({ kind: 'luma-key', axis: 'shadow', direction: 'lift', amount })
    return out
  }

  // 4) 键控溢色（必须在「整体偏色」之前判，否则「绿幕的绿色溢出」会被当成整体偏绿）
  const colorAxis = detectColor(restText)
  const strongSpill = STRONG_SPILL_RE.test(restText)
  const weakSpill = WEAK_SPILL_RE.test(restText)
  const globalMarker = GLOBAL_MARKER_RE.test(restText)
  if (!globalMarker && (strongSpill || (weakSpill && colorAxis))) {
    out.push({
      kind: 'keyed-spill',
      axis: colorAxis ?? 'green',
      amount: Math.max(detectAmount(restText), 0.62),
    })
    return out
  }

  // 5) 背景键控：「天空/背景太青」
  if (/天空|背景|远景|\bbg\b|background|sky|wall/.test(restText)) {
    if (colorAxis) {
      out.push({ kind: 'background-key', axis: 'background', target: colorAxis, amount: detectAmount(restText) })
      return out
    }
    if (/太亮|太暗|太杂|抢|too\s+bright|too\s+dark|busy/.test(restText)) {
      out.push({ kind: 'background-key', axis: 'background', target: 'auto', amount: detectAmount(restText) })
      return out
    }
  }

  // 6) 整体偏色：「太绿了 / 发绿 / 偏冷 / too green」
  if (colorAxis) {
    out.push({ kind: 'global-cast', axis: colorAxis, amount: detectAmount(restText) })
    return out
  }
  // 只说「偏色/白平衡不准」时交给 identifyCast 判断方向
  if (/偏色|色偏|白平衡|white\s*balance|\bwb\b|color\s*cast|cast\b/.test(restText)) {
    out.push({ kind: 'global-cast', axis: 'auto', amount: detectAmount(restText) })
    return out
  }

  // 7) 曝光 / 对比 / 饱和（可以叠加）
  if (EXPOSURE_DOWN_RE.test(restText)) {
    out.push({ kind: 'exposure', direction: 'down', amount: detectAmount(restText) })
  } else if (EXPOSURE_UP_RE.test(restText)) {
    out.push({ kind: 'exposure', direction: 'up', amount: detectAmount(restText) })
  }
  if (CONTRAST_DOWN_RE.test(restText)) {
    out.push({ kind: 'contrast', direction: 'down', amount: detectAmount(restText) })
  } else if (CONTRAST_UP_RE.test(restText)) {
    out.push({ kind: 'contrast', direction: 'up', amount: detectAmount(restText) })
  }
  if (SAT_DOWN_RE.test(restText)) {
    out.push({ kind: 'saturation', direction: 'down', amount: detectAmount(restText) })
  } else if (SAT_UP_RE.test(restText)) {
    out.push({ kind: 'saturation', direction: 'up', amount: detectAmount(restText) })
  }

  return out
}

function summarizeIntents(intents) {
  if (!Array.isArray(intents) || intents.length === 0) {
    return '未识别到可执行的调色意图（可描述：整体偏什么色 / 绿幕溢色 / 肤色 / 背景 / 明暗反差 / 风格）'
  }
  return intents.map(describeIntent).join('；')
}

function describeIntent(intent) {
  const axis = AXIS_LABEL[intent.axis] ?? intent.axis ?? ''
  switch (intent.kind) {
    case 'global-cast':
      return `整体偏${intent.axis === 'auto' ? '色' : axis} → 一级白平衡/去偏色`
    case 'keyed-spill':
      return `${axis}幕溢色 → 二级 ${axis}色 HSL 键控（局部降饱和+降亮）`
    case 'skin-key': {
      const map = { red: '偏红', yellow: '蜡黄', green: '偏绿', pale: '惨白', dark: '偏暗', auto: '待定' }
      return `肤色${map[intent.direction] ?? ''} → 二级肤色 qualifier`
    }
    case 'background-key':
      return `背景偏${intent.target === 'auto' ? '色/亮度' : AXIS_LABEL[intent.target] ?? intent.target} → 二级背景 hue qualifier`
    case 'luma-key':
      return intent.axis === 'highlight'
        ? '高光溢出 → 一级软肩压缩（softClipHigh）'
        : '暗部死黑 → 一级提黑位（lift.master）'
    case 'exposure':
      return `曝光${intent.direction === 'up' ? '不足' : '过度'} → 一级曝光`
    case 'contrast':
      return `对比${intent.direction === 'up' ? '不足' : '过强'} → 二级对比`
    case 'saturation':
      return `饱和度${intent.direction === 'up' ? '不足' : '过高'} → 三级饱和度`
    case 'look':
      return `风格 ${intent.style} → 三级 look`
    default:
      return String(intent.kind)
  }
}

// ---------------------------------------------------------------------------
// identifyCast：各颜色轴的偏色程度（0..1）
// ---------------------------------------------------------------------------

const HUE_DEG = Object.freeze({ green: 120, blue: 240, magenta: 300 })

function hueSupport(meanHueDeg, targetDeg) {
  const hue = finiteOr(meanHueDeg, null)
  if (hue == null) return 0
  let diff = Math.abs(hue - targetDeg) % 360
  if (diff > 180) diff = 360 - diff
  // ±60° 之外就不是同一个色相家族了（10° 橙发色 vs 300° 品红差 70°，不能算品红偏色）
  if (diff > 60) return 0
  return (1 - diff / 60) * 0.3
}

/**
 * 从分层统计里估出绿/蓝/品红三个偏色轴的程度（0..1，1 = 明显偏）。
 *
 * 主判据是**全局层通道均值比**（确定性、可解释），hue 均值只作为补充上限
 * （低饱和画面的 meanHue 只是噪声，layers.mjs 已经会给 null）。
 *
 * @param {object} analysis analyzeFrame 的返回值 / {layers} / 层映射
 * @returns {{green:number, blue:number, magenta:number}}
 */
export function identifyCast(analysis) {
  const layers = normalizeLayerMap(analysis)
  const global = asLayer(layers.global)
  const meanR = finiteOr(global?.meanR, null)
  const meanG = finiteOr(global?.meanG, null)
  const meanB = finiteOr(global?.meanB, null)
  if (meanR == null || meanG == null || meanB == null) {
    return { green: 0, blue: 0, magenta: 0 }
  }

  const EPS = 8 // 近黑画面（均值 <8）的通道比不可靠
  const scale = 0.1 // 相对通道差 10% ⇒ 偏色程度 1.0
  const greenRatio = (meanG - (meanR + meanB) / 2) / Math.max(EPS, (meanR + meanB) / 2)
  const blueRatio = (meanB - (meanR + meanG) / 2) / Math.max(EPS, (meanR + meanG) / 2)
  const magentaRatio = ((meanR + meanB) / 2 - meanG) / Math.max(EPS, meanG)

  const meanHue = finiteOr(global?.meanHue, null)
  return {
    green: round(clamp01(Math.max(clamp01(greenRatio / scale), hueSupport(meanHue, HUE_DEG.green)))),
    blue: round(clamp01(Math.max(clamp01(blueRatio / scale), hueSupport(meanHue, HUE_DEG.blue)))),
    magenta: round(clamp01(Math.max(clamp01(magentaRatio / scale), hueSupport(meanHue, HUE_DEG.magenta)))),
  }
}

function dominantCastAxis(cast) {
  const entries = [
    ['green', finiteOr(cast?.green, 0)],
    ['blue', finiteOr(cast?.blue, 0)],
    ['magenta', finiteOr(cast?.magenta, 0)],
  ]
  entries.sort((left, right) => right[1] - left[1])
  return entries[0][1] > 0.05 ? entries[0][0] : 'green'
}

// ---------------------------------------------------------------------------
// buildTierPlan：intent + 分层证据 → drx 节点数组
// ---------------------------------------------------------------------------

const STYLE_PRESET = Object.freeze({
  none: Object.freeze({ saturation: 50, contrast: 0, warmth: 0, lift: 0, pivot: 0.435 }),
  film: Object.freeze({ saturation: 45, contrast: 0.03, warmth: 0.02, lift: 0.006, pivot: 0.45 }),
  punchy: Object.freeze({ saturation: 58, contrast: 0.08, warmth: 0.006, lift: 0, pivot: 0.42 }),
  clean: Object.freeze({ saturation: 48, contrast: 0.02, warmth: -0.004, lift: 0, pivot: 0.435 }),
  'teal-orange': Object.freeze({ saturation: 54, contrast: 0.04, warmth: 0.012, lift: 0.002, pivot: 0.44 }),
  // 赛博朋克（收敛版）：不压黑、轻微高对比、整体微冷；靠 06/07 两个亮度键控做很轻的分离色。
  // 教训：满强度压黑 + 大推蓝在夜戏上会造成黑色断层和整屏发蓝，Vibe 风格只要一点点。
  'cyberpunk': Object.freeze({ saturation: 53, contrast: 0.03, warmth: -0.006, lift: 0, pivot: 0.44 }),
})

const AXIS_HUE_CENTER = Object.freeze({
  green: 34,
  cyan: 50,
  blue: 66,
  magenta: 85,
  yellow: 17,
  red: 0,
  warm: 10,
  cool: 62,
})

function normalizeVibe(vibe) {
  if (vibe == null) return []
  if (typeof vibe === 'string') return parseVibe(vibe).intents
  if (Array.isArray(vibe)) return vibe.filter((intent) => intent && typeof intent === 'object')
  if (Array.isArray(vibe.intents)) return vibe.intents.filter((intent) => intent && typeof intent === 'object')
  return []
}

function resolveStyle(style, intents, notes) {
  const requested = typeof style === 'string' ? style.trim() : null
  if (requested && !STYLES.includes(requested)) {
    notes.push(`未知风格 "${requested}"，按 none 处理（可选：${STYLES.join(' / ')}）`)
  }
  const fromParam = requested && STYLES.includes(requested) ? requested : null
  const lookIntent = intents.find((intent) => intent.kind === 'look' && STYLES.includes(intent.style))
  if (fromParam) {
    if (lookIntent && lookIntent.style !== fromParam) {
      notes.push(`风格参数 ${fromParam} 覆盖了口语里的 ${lookIntent.style}`)
    }
    return { style: fromParam, source: 'param' }
  }
  if (lookIntent) return { style: lookIntent.style, source: 'vibe' }
  return { style: 'none', source: 'default' }
}

function makeQualifier(overrides = {}) {
  const safe = (value, fallback) => round(clamp(value, 0, 100, fallback))
  return {
    hueCenter: safe(overrides.hueCenter, 34),
    hueWidth: safe(overrides.hueWidth, 24),
    hueSoft: safe(overrides.hueSoft, 14),
    hueSymmetry: safe(overrides.hueSymmetry, 50),
    satLow: safe(overrides.satLow, 20),
    satHigh: safe(overrides.satHigh, 90),
    satLowSoft: safe(overrides.satLowSoft, 8),
    satHighSoft: safe(overrides.satHighSoft, 10),
    lumLow: safe(overrides.lumLow, 5),
    lumHigh: safe(overrides.lumHigh, 95),
    lumLowSoft: safe(overrides.lumLowSoft, 8),
    lumHighSoft: safe(overrides.lumHighSoft, 8),
  }
}

/**
 * 从分层证据里取「绿幕溢色」该选哪个 hueCenter。
 * 背景层如果确实是 green 家族就跟随它（真实绿幕 120–140° → 33–39），否则用 34。
 */
function spillHueCenter(layers, axis) {
  if (axis === 'green') {
    const background = asLayer(layers.background)
    const family = background?.dominantHueFamily
    const pct = finiteOr(background?.dominantHuePercent, finiteOr(background?.meanHuePercent, null))
    if (family === 'green' && pct != null) return clamp(pct, 25, 55, 34)
    return 34
  }
  return clamp(AXIS_HUE_CENTER[axis] ?? 34, 0, 100, 34)
}

/**
 * 生成「三级 + Vibe」调色方案。
 *
 * @param {object} [options]
 * @param {object} [options.analysis] lib/layers.mjs analyzeFrame 的返回值
 * @param {object|string|Array} [options.vibe] parseVibe 的返回值 / 原始文本 / intent 数组
 * @param {'none'|'film'|'punchy'|'clean'|'teal-orange'} [options.style]
 * @returns {{tiers:Array, nodes:Array<{label:string,params:object}>, notes:Array<string>,
 *            style:string, cast:{green:number,blue:number,magenta:number}}}
 */
export function buildTierPlan({ analysis, vibe, style } = {}) {
  const layers = normalizeLayerMap(analysis)
  const intents = normalizeVibe(vibe)
  const cast = identifyCast(analysis)
  const notes = []
  const tiers = []
  const nodes = []

  const resolvedStyle = resolveStyle(style, intents, notes)
  const stylePreset = STYLE_PRESET[resolvedStyle.style] ?? STYLE_PRESET.none

  const global = asLayer(layers.global)
  const meanLuma = finiteOr(global?.meanLuma, null)
  const dynamicRange = finiteOr(global?.dynamicRange, null)

  if (intents.length > 0) notes.push(`解析意图：${summarizeIntents(intents)}`)
  notes.push(`风格：${resolvedStyle.style}（来源 ${resolvedStyle.source}）`)
  if (dynamicRange != null) {
    notes.push(`全局动态范围 ${round(dynamicRange, 3)}（luma p95-p5，0..1）`)
  }

  const addTier = (tier, node) => {
    tiers.push({ index: tiers.length + 1, ...tier, nodeLabel: node.label })
    nodes.push(node)
  }

  // =========================================================================
  // 01 一级·平衡：白平衡/去偏色 + 曝光（+ 轻微整体对比）
  // =========================================================================
  {
    const intentGreen = findIntent(intents, 'global-cast', (i) => i.axis === 'green')
    const intentBlue = findIntent(intents, 'global-cast', (i) => i.axis === 'blue' || i.axis === 'cyan')
    const intentRed = findIntent(intents, 'global-cast', (i) => i.axis === 'red')
    const intentMagenta = findIntent(intents, 'global-cast', (i) => i.axis === 'magenta')
    const intentAuto = findIntent(intents, 'global-cast', (i) => i.axis === 'auto')
    const intentWarm = findIntent(intents, 'global-cast', (i) => i.axis === 'warm')
    const intentCool = findIntent(intents, 'global-cast', (i) => i.axis === 'cool')

    // 关键区分：如果用户只说了「绿幕溢色」而没说「整体偏绿」，
    // 那么画面里的绿大概率是**幕布本身**，一级绝不能自动去绿（否则幕布/场景绿一起被杀）。
    // 只有口述了整体偏色（任意轴）或者明确说了该轴偏色时才自动修。
    const spillIntent = findIntent(intents, 'keyed-spill')
    const explicitGlobalCast = intents.some((intent) => intent.kind === 'global-cast')
    const spillSuppressed = (axes) =>
      Boolean(spillIntent) && axes.includes(spillIntent.axis) && !intentAuto && !explicitGlobalCast

    // 有口述时口述优先；没有口述时只自动修正 80% 的实测偏色（不喧宾夺主）
    let greenDrive = intentGreen
      ? clamp01(intentAmount(intentGreen, 0))
      : spillSuppressed(['green'])
        ? 0
        : clamp01(cast.green * 0.8)
    let blueDrive = intentBlue
      ? clamp01(intentAmount(intentBlue, 0))
      : spillSuppressed(['blue', 'cyan'])
        ? 0
        : clamp01(cast.blue * 0.8)
    let redDrive = clamp01(Math.max(intentAmount(intentRed, 0), 0))
    let magentaDrive = intentMagenta
      ? clamp01(intentAmount(intentMagenta, 0))
      : spillSuppressed(['magenta'])
        ? 0
        : clamp01(cast.magenta * 0.8)
    if (spillIntent && !explicitGlobalCast && !intentAuto) {
      notes.push(
        `只识别到 ${spillIntent.axis} 幕溢色、没有「整体偏${AXIS_LABEL[spillIntent.axis] ?? ''}」的口述 → 01 不对该轴做自动去偏色（保留幕布，交给 04 键控局部抑制）`,
      )
    }
    if (intentAuto) {
      const dominant = dominantCastAxis(cast)
      const amount = intentAmount(intentAuto, 0.6)
      if (dominant === 'green') greenDrive = Math.max(greenDrive, amount)
      else if (dominant === 'blue') blueDrive = Math.max(blueDrive, amount)
      else magentaDrive = Math.max(magentaDrive, amount)
    }

    let gainR = 1
    let gainG = 1
    let gainB = 1
    // 去绿：压 G，轻微抬 R/B
    gainG *= 1 - 0.055 * greenDrive
    gainR *= 1 + 0.012 * greenDrive
    gainB *= 1 + 0.012 * greenDrive
    // 去蓝：压 B
    gainB *= 1 - 0.05 * blueDrive
    gainR *= 1 + 0.008 * blueDrive
    gainG *= 1 + 0.008 * blueDrive
    // 去品红：抬 G，压 R/B
    gainG *= 1 + 0.045 * magentaDrive
    gainR *= 1 - 0.022 * magentaDrive
    gainB *= 1 - 0.022 * magentaDrive
    // 去红：压 R
    gainR *= 1 - 0.045 * redDrive
    gainG *= 1 + 0.01 * redDrive
    gainB *= 1 + 0.01 * redDrive
    // 冷暖偏好（用户审美，不是偏色修正）
    if (intentWarm) {
      const amount = intentAmount(intentWarm, 0.6)
      gainR *= 1 + 0.03 * amount
      gainB *= 1 - 0.03 * amount
    }
    if (intentCool) {
      const amount = intentAmount(intentCool, 0.6)
      gainR *= 1 - 0.03 * amount
      gainB *= 1 + 0.03 * amount
    }

    // 曝光：口述方向 + 实测 meanLuma 偏差（目标 0.46）
    const exposureIntent = findIntent(intents, 'exposure')
    const exposureBias = exposureIntent ? (exposureIntent.direction === 'up' ? 0.022 : -0.022) : 0
    const lumaBias = meanLuma == null ? 0 : clamp((0.46 - meanLuma) * 0.18, -0.05, 0.05)
    let gainMaster = 1 + exposureBias + lumaBias * 0.55
    let liftMaster = exposureBias * 0.35 + lumaBias * 0.22

    // luma 键控意图在一级落地：高光爆 → 收一点；暗部死黑 → 抬黑位
    const highlightIntent = findIntent(intents, 'luma-key', (i) => i.axis === 'highlight')
    const shadowIntent = findIntent(intents, 'luma-key', (i) => i.axis === 'shadow')
    if (shadowIntent) {
      const amount = intentAmount(shadowIntent, 0.7)
      liftMaster += 0.008 * amount
      gainMaster += 0.005 * amount
    }
    if (highlightIntent) {
      const amount = intentAmount(highlightIntent, 0.7)
      gainMaster -= 0.01 * amount
    }

    gainR = clamp(gainR, CLAMPS.gain[0], CLAMPS.gain[1], 1)
    gainG = clamp(gainG, CLAMPS.gain[0], CLAMPS.gain[1], 1)
    gainB = clamp(gainB, CLAMPS.gain[0], CLAMPS.gain[1], 1)
    gainMaster = clamp(gainMaster, 0.9, 1.12, 1)
    liftMaster = clamp(liftMaster, -0.02, 0.02, 0)

    // 一级只做「极平画面」的轻微对比，主对比留给 02
    let balanceContrast = 1
    if (dynamicRange != null && dynamicRange < 0.3) balanceContrast = 1 + 0.04
    balanceContrast = clamp(balanceContrast, CLAMPS.contrast[0], CLAMPS.contrast[1], 1)

    const label = '01 一级·平衡'
    const params = {
      space: 'ui',
      gain: { r: round(gainR), g: round(gainG), b: round(gainB), master: round(gainMaster) },
      lift: { r: 0, g: 0, b: 0, master: round(liftMaster) },
      gamma: { r: 0, g: 0, b: 0, master: 0 },
      contrast: round(balanceContrast),
      pivot: 0.435,
    }

    const changes = []
    if (greenDrive > 0.02) changes.push(`去绿：gain.g ×${round(1 - 0.055 * greenDrive, 3)}`)
    if (blueDrive > 0.02) changes.push(`去蓝：gain.b ×${round(1 - 0.05 * blueDrive, 3)}`)
    if (magentaDrive > 0.02) changes.push(`去品红：gain.g ×${round(1 + 0.045 * magentaDrive, 3)}`)
    if (redDrive > 0.02) changes.push(`去红：gain.r ×${round(1 - 0.045 * redDrive, 3)}`)
    if (intentWarm || intentCool) changes.push(`${intentWarm ? '偏暖' : '偏冷'}微调`)
    changes.push(`曝光：lift.master ${round(liftMaster, 4)} / gain.master ${round(gainMaster, 3)}`)
    if (shadowIntent) changes.push('暗部抬黑位')
    if (highlightIntent) changes.push('高光压一点总量')
    if (balanceContrast !== 1) changes.push('极平画面补 0.04 对比')

    addTier(
      {
        id: '01',
        title: '一级·平衡',
        role: 'primary',
        basis:
          `identifyCast green=${cast.green} blue=${cast.blue} magenta=${cast.magenta}` +
          (meanLuma == null ? '' : `；全局 meanLuma ${round(meanLuma, 3)}`),
        changes,
      },
      { label, params },
    )
  }

  // =========================================================================
  // 02 一级·对比：contrast / pivot / 高光软肩（能用参数就不用曲线）
  // =========================================================================
  {
    let contrast = 1
    if (dynamicRange != null) {
      if (dynamicRange < 0.32) contrast += 0.1
      else if (dynamicRange < 0.5) contrast += 0.05
      else if (dynamicRange > 0.82) contrast -= 0.02
    }
    const contrastIntent = findIntent(intents, 'contrast')
    if (contrastIntent) contrast += contrastIntent.direction === 'up' ? 0.07 : -0.07
    contrast += stylePreset.contrast
    contrast = clamp(contrast, CLAMPS.contrast[0], CLAMPS.contrast[1], 1)

    const pivot = clamp(
      0.435 + (meanLuma == null ? 0 : clamp((meanLuma - 0.45) * 0.12, -0.02, 0.02)),
      CLAMPS.pivot[0],
      CLAMPS.pivot[1],
      0.435,
    )

    // contrastHighRange 中性 0.55；film 抬高（高光过渡更软），punchy 压低
    let highRange = 0.55
    if (resolvedStyle.style === 'film') highRange = 0.6
    if (resolvedStyle.style === 'punchy') highRange = 0.5

    const highlightIntent = findIntent(intents, 'luma-key', (i) => i.axis === 'highlight')
    const shadowIntent = findIntent(intents, 'luma-key', (i) => i.axis === 'shadow')
    let softClipHigh = 1
    if (highlightIntent) softClipHigh = clamp(1 - 0.06 * intentAmount(highlightIntent, 0.7), 0.9, 1, 1)
    else if (resolvedStyle.style === 'film') softClipHigh = 0.97
    let softClipLow = 0
    if (shadowIntent) softClipLow = clamp(0.015 + 0.02 * intentAmount(shadowIntent, 0.7), 0, 0.04, 0)
    else if (resolvedStyle.style === 'film') softClipLow = 0.02

    const params = {
      space: 'ui',
      contrast: round(contrast),
      pivot: round(pivot),
      contrastHighRange: round(highRange),
    }
    if (softClipHigh < 1) params.softClipHigh = round(softClipHigh)
    if (softClipLow > 0) params.softClipLow = round(softClipLow)

    const changes = [`contrast ${round(contrast, 3)} / pivot ${round(pivot, 3)}`]
    if (softClipHigh < 1) changes.push(`softClipHigh ${round(softClipHigh, 3)}（高光软肩）`)
    if (softClipLow > 0) changes.push(`softClipLow ${round(softClipLow, 3)}（黑位软化）`)

    addTier(
      {
        id: '02',
        title: '一级·对比',
        role: 'primary',
        basis:
          (dynamicRange == null ? '无全局动态范围证据' : `动态范围 ${round(dynamicRange, 3)}`) +
          (contrastIntent ? `；口述对比${contrastIntent.direction === 'up' ? '不足' : '过强'}` : '') +
          `；风格 ${resolvedStyle.style}`,
        changes,
      },
      { label: '02 一级·对比', params },
    )
  }

  // =========================================================================
  // 03 二级·肤色 qualifier（只有肤色层可信 + 覆盖率合理时才加）
  // =========================================================================
  {
    const skin = asLayer(layers.skin)
    const coverage = finiteOr(skin?.coverage, 0)
    const usable = Boolean(skin) && skin.confident === true && coverage >= 1.2 && coverage <= 45
    if (!usable) {
      notes.push(
        `跳过 03 肤色：肤色层不可信或覆盖异常（confident=${skin ? skin.confident : 'n/a'}, coverage=${round(coverage, 2)}%）`,
      )
    } else {
      const skinIntent = findIntent(intents, 'skin-key')
      const direction = skinIntent?.direction ?? 'auto'
      const amount = intentAmount(skinIntent, 0.5)
      const hueCenter = clamp(finiteOr(skin.meanHuePercent, 8), 3, 15, 8)

      // 默认给一点点血色校正；有口述时按方向偏移
      let gainR = 1.004
      let gainG = 1
      let gainB = 0.998
      if (direction === 'red') {
        gainR -= 0.012 * amount
        gainB += 0.008 * amount
      } else if (direction === 'yellow') {
        gainB += 0.012 * amount
        gainR -= 0.004 * amount
      } else if (direction === 'green') {
        gainR += 0.01 * amount
        gainG -= 0.004 * amount
      } else if (direction === 'pale') {
        gainR += 0.008 * amount
        gainG += 0.006 * amount
      } else if (direction === 'dark') {
        gainG += 0.006 * amount
        gainB += 0.006 * amount
      }

      const params = {
        space: 'ui',
        qualifier: makeQualifier({
          hueCenter,
          hueWidth: 22,
          hueSoft: 11,
          hueSymmetry: 50,
          satLow: 12,
          satHigh: 88,
          satLowSoft: 5,
          satHighSoft: 5,
          lumLow: 20,
          lumHigh: 82,
          lumLowSoft: 5,
          lumHighSoft: 5,
        }),
        // 肤色键控强烈建议加 matteFinesse（docs §5.2），否则 matte 边缘会跳
        matteFinesse: { blackClip: 2, whiteClip: 2, denoise: 5, blur: 3 },
        gain: {
          r: round(clamp(gainR, CLAMPS.gain[0], CLAMPS.gain[1], 1)),
          g: round(clamp(gainG, CLAMPS.gain[0], CLAMPS.gain[1], 1)),
          b: round(clamp(gainB, CLAMPS.gain[0], CLAMPS.gain[1], 1)),
          master: 1,
        },
      }

      addTier(
        {
          id: '03',
          title: '二级·肤色',
          role: 'secondary',
          basis: `肤色层 coverage ${round(coverage, 2)}%；meanHuePercent ${round(skin.meanHuePercent, 1)}（UI 0–100）`,
          changes: [
            `hueCenter ${round(hueCenter, 1)}（≈${round(hueCenter * 3.6, 0)}°，肤色区）`,
            direction === 'auto' ? '默认轻微血色校正' : `按口述「${direction}」偏移 R/B`,
            'matteFinesse 清 matte',
          ],
        },
        { label: '03 二级·肤色', params },
      )
    }
  }

  // =========================================================================
  // 04 二级·绿幕溢色（只有 keyed-spill 意图才加；这就是与整体偏色的分界线）
  // =========================================================================
  {
    const spillIntent = findIntent(intents, 'keyed-spill')
    if (!spillIntent) {
      notes.push('没有 keyed-spill 意图 → 不生成绿色键控节点（整体偏绿走 01 白平衡，不做局部键控）')
    } else {
      const axis = spillIntent.axis ?? 'green'
      const amount = intentAmount(spillIntent, 0.7)
      const hueCenter = spillHueCenter(layers, axis)
      const satHigh = clamp(90 + 6 * amount, 70, 100, 92)
      // 溢色抑制 = 键控 + 降饱和 + 轻微降亮；饱和度低于 50 即「降」
      const saturation = clamp(50 - 30 * amount, 18, 44, 30)
      const gainMaster = clamp(1 - 0.02 * amount, 0.95, 1, 0.985)

      const params = {
        space: 'ui',
        qualifier: makeQualifier({
          hueCenter,
          hueWidth: 24,
          hueSoft: 14,
          hueSymmetry: 40,
          satLow: 22,
          satHigh,
          satLowSoft: 8,
          satHighSoft: 10,
          lumLow: 5,
          lumHigh: 96,
          lumLowSoft: 8,
          lumHighSoft: 6,
        }),
        matteFinesse: { blackClip: 3, whiteClip: 3, denoise: 6, blur: 2 },
        saturation: round(saturation),
        gain: { r: 1, g: round(clamp(1 - 0.01 * amount, 0.95, 1, 0.99)), b: 1, master: round(gainMaster) },
        gamma: { r: 0, g: 0, b: 0, master: round(-0.02 * amount) },
      }

      addTier(
        {
          id: '04',
          title: '二级·绿幕溢色',
          role: 'secondary',
          basis: `keyed-spill axis=${axis} amount=${round(amount, 2)}；hueCenter ${round(hueCenter, 1)}（UI 0–100 ≈ ${round(hueCenter * 3.6, 0)}°）`,
          changes: [
            `HSL 绿色 qualifier：hueCenter ${round(hueCenter, 1)} / satHigh ${round(satHigh, 0)}`,
            `局部降饱和到 ${round(saturation, 0)}（50=中性）`,
            `轻微降亮 gain.master ${round(gainMaster, 3)} + gamma.master ${round(-0.02 * amount, 3)}`,
            '只作用于键控选中的溢色像素，不动整帧白平衡',
          ],
        },
        { label: '04 二级·绿幕溢色', params },
      )
    }
  }

  // =========================================================================
  // 05 二级·背景（可选）
  // =========================================================================
  {
    const background = asLayer(layers.background)
    const bgIntent = findIntent(intents, 'background-key')
    const coverage = finiteOr(background?.coverage, 0)
    const bgFamily = background?.dominantHueFamily ?? null
    const bgHue = finiteOr(
      background?.dominantHuePercent,
      finiteOr(background?.meanHuePercent, null),
    )
    const spillIntent = findIntent(intents, 'keyed-spill')
    // 背景本身是绿色而 04 已经键控绿幕时，别再开一个绿色节点（会重复、且会杀掉背景绿）。
    // 注意用「绿区」而不是 §5.6 的安全钳制区间 [25,55]：UI 52 是青（≈187°），不是绿。
    const greenConflict =
      Boolean(spillIntent) &&
      spillIntent.axis === 'green' &&
      (bgFamily === 'green' || (bgHue != null && bgHue >= 25 && bgHue <= 42))

    // 保守策略：背景节点只在「用户明确说背景」或「风格就是青橙」时出现。
    // 只因为背景层覆盖大就自动去改背景色，属于用户没要求的改动。
    const wanted = Boolean(bgIntent) || resolvedStyle.style === 'teal-orange' || resolvedStyle.style === 'cyberpunk'

    if (!wanted || greenConflict) {
      notes.push(
        greenConflict
          ? '跳过 05 背景：与 04 绿幕溢色节点选中的绿色区冲突（避免两个节点同时吃绿色）'
          : '跳过 05 背景：没有背景意图 / 风格不是青橙（不自动改背景色）',
      )
    } else {
      const hueCenter = clamp(
        finiteOr(bgHue, finiteOr(AXIS_HUE_CENTER[bgIntent?.target], 50)),
        0,
        100,
        50,
      )
      const target = bgIntent?.target && bgIntent.target !== 'auto' ? bgIntent.target : null
      let gainR = 1
      let gainG = 1
      let gainB = 1
      if (resolvedStyle.style === 'teal-orange') {
        gainB *= 1.03
        gainR *= 0.985
      } else if (target === 'cyan' || target === 'blue' || target === 'cool') {
        gainB *= 1.025
        gainR *= 0.99
      } else if (target === 'warm' || target === 'yellow' || target === 'red') {
        gainR *= 1.025
        gainB *= 0.988
      } else if (target === 'green') {
        gainG *= 1.02
        gainR *= 0.992
        gainB *= 0.992
      }

      const params = {
        space: 'ui',
        qualifier: makeQualifier({
          hueCenter,
          hueWidth: 26,
          hueSoft: 15,
          hueSymmetry: 50,
          satLow: 10,
          satHigh: 100,
          satLowSoft: 5,
          satHighSoft: 8,
          lumLow: 0,
          lumHigh: 88,
          lumLowSoft: 5,
          lumHighSoft: 10,
        }),
        gain: {
          r: round(clamp(gainR, CLAMPS.gain[0], CLAMPS.gain[1], 1)),
          g: round(clamp(gainG, CLAMPS.gain[0], CLAMPS.gain[1], 1)),
          b: round(clamp(gainB, CLAMPS.gain[0], CLAMPS.gain[1], 1)),
          master: 1,
        },
        saturation: round(clamp(50 + (resolvedStyle.style === 'teal-orange' ? 2 : 0), 0, 100, 50)),
      }

      addTier(
        {
          id: '05',
          title: '二级·背景',
          role: 'secondary',
          basis:
            `${bgIntent ? `背景意图 target=${bgIntent.target}` : '背景层证据'}；` +
            `dominantHueFamily ${bgFamily ?? 'n/a'} / coverage ${round(coverage, 2)}%`,
          changes: [
            `背景 hue qualifier hueCenter ${round(hueCenter, 1)}（≈${round(hueCenter * 3.6, 0)}°）`,
            '仅用 hue qualifier 限定（不写 window，见 notes）',
          ],
        },
        { label: '05 二级·背景', params },
      )
    }
  }

  // =========================================================================
  // 06/07 二级·赛博朋克双色分离（仅 cyberpunk 风格）
  // 暗部推青蓝、高光推品红 —— 这是赛博朋克最标志性的「neon split-tone」。
  // 用亮度键控而不是全局偏色：全局推品红/青只会互相抵消，画面变脏。
  // =========================================================================
  if (resolvedStyle.style === 'cyberpunk') {
    {
      const params = {
        space: 'ui',
        qualifier: makeQualifier({
          hueCenter: 50,
          hueWidth: 100,
          hueSoft: 20,
          hueSymmetry: 50,
          satLow: 0,
          satHigh: 100,
          satLowSoft: 4,
          satHighSoft: 4,
          lumLow: 0,
          lumHigh: 42,
          lumLowSoft: 4,
          lumHighSoft: 14,
        }),
        gain: { r: round(clamp(0.985, CLAMPS.gain[0], CLAMPS.gain[1], 1)), g: round(clamp(1.004, CLAMPS.gain[0], CLAMPS.gain[1], 1)), b: round(clamp(1.025, CLAMPS.gain[0], CLAMPS.gain[1], 1)), master: 1 },
        lift: { r: 0, g: 0, b: round(clamp(0.004, CLAMPS.lift[0], CLAMPS.lift[1], 0)), master: 0 },
        saturation: round(clamp(51, CLAMPS.saturation[0], CLAMPS.saturation[1], 50)),
      }
      addTier(
        {
          id: '06',
          title: '二级·青蓝暗部',
          role: 'secondary',
          basis: '风格 cyberpunk：暗部（亮度 ≤42，软过渡到 56）推青蓝',
          changes: ['亮度键控 lumHigh 42（soft 14）', 'gain R 0.985 / G 1.004 / B 1.025（收敛版）', 'lift B +0.014（暗部染青）', '只作用于暗部，不动高光'],
        },
        { label: '06 二级·青蓝暗部', params },
      )
    }
    {
      const params = {
        space: 'ui',
        qualifier: makeQualifier({
          hueCenter: 50,
          hueWidth: 100,
          hueSoft: 20,
          hueSymmetry: 50,
          satLow: 0,
          satHigh: 100,
          satLowSoft: 4,
          satHighSoft: 4,
          lumLow: 58,
          lumHigh: 100,
          lumLowSoft: 16,
          lumHighSoft: 4,
        }),
        gain: { r: round(clamp(1.022, CLAMPS.gain[0], CLAMPS.gain[1], 1)), g: round(clamp(0.994, CLAMPS.gain[0], CLAMPS.gain[1], 1)), b: round(clamp(1.016, CLAMPS.gain[0], CLAMPS.gain[1], 1)), master: 1 },
        saturation: round(clamp(53, CLAMPS.saturation[0], CLAMPS.saturation[1], 50)),
      }
      addTier(
        {
          id: '07',
          title: '二级·品红高光',
          role: 'secondary',
          basis: '风格 cyberpunk：高光（亮度 ≥58，软过渡到 42）推品红',
          changes: ['亮度键控 lumLow 58（soft 16）', 'gain R 1.022 / G 0.994 / B 1.016（收敛版）', '高光饱和度 58（霓虹感）', '只作用于高光，不动暗部'],
        },
        { label: '07 二级·品红高光', params },
      )
    }
  }

  // =========================================================================
  // 06 三级·look（永远存在 → 保证节点数 ≥3）
  // =========================================================================
  {
    let saturation = stylePreset.saturation
    const satIntent = findIntent(intents, 'saturation')
    if (satIntent) saturation += satIntent.direction === 'up' ? 8 : -8
    saturation = clamp(saturation, CLAMPS.saturation[0], CLAMPS.saturation[1], 50)

    let contrast = 1 + stylePreset.contrast * 0.5
    contrast = clamp(contrast, CLAMPS.contrast[0], CLAMPS.contrast[1], 1)

    const warmth = stylePreset.warmth
    const params = {
      space: 'ui',
      saturation: round(saturation),
      contrast: round(contrast),
      pivot: round(stylePreset.pivot),
      gain: {
        r: round(clamp(1 + warmth, CLAMPS.gain[0], CLAMPS.gain[1], 1)),
        g: 1,
        b: round(clamp(1 - warmth, CLAMPS.gain[0], CLAMPS.gain[1], 1)),
        master: 1,
      },
      lift: { r: 0, g: 0, b: 0, master: round(stylePreset.lift) },
    }

    addTier(
      {
        id: '06',
        title: '三级·look',
        role: 'look',
        basis: `风格 ${resolvedStyle.style}${satIntent ? `；口述饱和度${satIntent.direction === 'up' ? '不足' : '过高'}` : ''}`,
        changes: [
          `saturation ${round(saturation, 0)}（50=中性）`,
          `contrast ${round(contrast, 3)} / pivot ${round(stylePreset.pivot, 3)}`,
          warmth === 0 ? '无冷暖偏移' : `${warmth > 0 ? '偏暖' : '偏冷'} gain ${round(1 + warmth, 3)}/${round(1 - warmth, 3)}`,
        ],
      },
      { label: resolvedStyle.style === 'cyberpunk' ? '08 三级·look' : '06 三级·look', params },
    )
  }

  // 落地风险说明（不是免责声明，是给 UI 的可解释依据）
  notes.push(
    '05 背景节点没有写 window：docs §5.7 实测 R21 上圆形/线性窗口必须同时传 resolveVersion:21，' +
      '否则「加载但渲染空遮罩并盖掉该节点 grade」，本模块的节点只带 params（拿不到工具层参数），所以只用 hue qualifier 限定。',
  )
  notes.push(
    '节点单位全部 space:"ui"（与 docs §5.4 实测 JSON 一致）；01 不含 saturation（§5.5：merge 会二次缩放基线节点的饱和度）。',
  )

  return { tiers, nodes, notes, style: resolvedStyle.style, cast }
}
