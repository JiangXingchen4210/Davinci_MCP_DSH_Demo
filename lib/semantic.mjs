/**
 * 无模型语义选镜：用调色板/构图特征排除「棚拍/黑板/演播室」类镜头。
 * 这不是内容理解，只是可解释的启发式；结果必须带 features 与 reason，不能假装 AI 看懂了画面。
 *
 * 特征（0..1）：
 *   blackBorder  外框 12% 区域的近黑像素比例（棚拍黑边/暗角）
 *   cyan         青/蓝板色占比（黑板、演播室背景）
 *   greenGold    黄绿/金色占比（校园秋日、植物）
 *   skin         肤色占比（人像；只作参考，不单独排除）
 *   colorfulness 平均饱和度
 *   meanLuma     平均亮度
 */

export const THEMES = ['auto', 'natural', 'campus-autumn', 'studio']

function clamp01(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.min(1, Math.max(0, num))
}

export function rgbToHsl(r, g, b) {
  const rr = r / 255; const gg = g / 255; const bb = b / 255
  const max = Math.max(rr, gg, bb); const min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rr) h = ((gg - bb) / d) % 6
  else if (max === gg) h = (bb - rr) / d + 2
  else h = (rr - gg) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/** 从 RGB24 像素缓冲算语义特征；像素宽高必须匹配。 */
export function semanticFeaturesFromRgb(buffer, width, height) {
  const w = Math.max(1, Math.floor(Number(width) || 0))
  const h = Math.max(1, Math.floor(Number(height) || 0))
  if (!buffer || buffer.length < w * h * 3) throw new Error('RGB 缓冲长度与宽高不匹配')
  const borderX = Math.max(1, Math.round(w * 0.12))
  const borderY = Math.max(1, Math.round(h * 0.12))
  let pixels = 0; let blackBorderPixels = 0; let borderPixels = 0
  let cyan = 0; let greenGold = 0; let skin = 0
  let satSum = 0; let lumaSum = 0
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3
      const r = buffer[i]; const g = buffer[i + 1]; const b = buffer[i + 2]
      const { h: hue, s, l } = rgbToHsl(r, g, b)
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
      pixels += 1; satSum += s; lumaSum += luma
      if (hue >= 160 && hue <= 210 && s >= 0.25 && luma > 20) cyan += 1
      if (hue >= 40 && hue <= 150 && s >= 0.15) greenGold += 1
      if (hue >= 10 && hue <= 40 && s >= 0.15 && s <= 0.6) skin += 1
      const inBorder = x < borderX || x >= w - borderX || y < borderY || y >= h - borderY
      if (inBorder) {
        borderPixels += 1
        if (luma < 16) blackBorderPixels += 1
      }
    }
  }
  return {
    blackBorder: clamp01(blackBorderPixels / Math.max(1, borderPixels)),
    cyan: clamp01(cyan / Math.max(1, pixels)),
    greenGold: clamp01(greenGold / Math.max(1, pixels)),
    skin: clamp01(skin / Math.max(1, pixels)),
    colorfulness: clamp01(satSum / Math.max(1, pixels)),
    meanLuma: clamp01(lumaSum / Math.max(1, pixels) / 255),
    pixels,
  }
}

/**
 * 主题语义打分：studio 类镜头在 auto/natural/campus-autumn 下会得负分并被硬排除；
 * studio 主题反过来奖励黑板/棚拍。分数是启发式，不是概率。
 */
export function themeSemanticScore(theme, features) {
  const f = features ?? {}
  const natural = (f.greenGold ?? 0) * 2.2 + (f.colorfulness ?? 0) * 0.6 + (f.skin ?? 0) * 0.2 - (f.cyan ?? 0) * 2.0 - (f.blackBorder ?? 0) * 2.6
  const studio = (f.cyan ?? 0) * 2.4 + (f.blackBorder ?? 0) * 2.2 - (f.greenGold ?? 0) * 1.2
  switch (theme) {
    case 'studio': return studio
    case 'campus-autumn': return natural + (f.greenGold ?? 0) * 1.2 - (f.cyan ?? 0) * 1.0
    case 'natural':
    case 'auto':
    default: return natural
  }
}

/** 主题是否属于「排除棚拍」类（studio 主题除外）。 */
export function excludesStudio(theme) {
  return theme !== 'studio'
}

/** 纯函数：按主题挑选镜头；返回 kept / excluded，reason 可复核。 */
export function selectShotsByTheme(scenes, options = {}) {
  const theme = THEMES.includes(options.theme) ? options.theme : 'auto'
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : -0.15
  const maxStudios = theme === 'studio' ? Infinity : 0
  const kept = []; const excluded = []
  for (const scene of scenes ?? []) {
    const features = scene.semantic ?? null
    if (!features) { kept.push(scene); continue }
    const score = Number(themeSemanticScore(theme, features).toFixed(3))
    const studioLike = excludesStudio(theme) && (features.cyan >= 0.12 && features.blackBorder >= 0.10)
    if (studioLike || score < minScore) {
      excluded.push({
        scene: scene.index,
        clipName: scene.clipName ?? null,
        score,
        reason: studioLike ? 'studio/blackboard palette' : 'theme score below threshold',
        features,
      })
      continue
    }
    kept.push({ ...scene, semanticScore: score })
  }
  return { theme, kept, excluded, minScore }
}
