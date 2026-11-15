/**
 * 影像质感（Texture）—— 调色之外的那一半：光晕 / 白柔 / 颗粒。
 *
 * 判断逻辑（这轮实测得到的经验）：
 *   · 高光是「点状硬光」（灯泡、车灯、路灯）→ 光晕（halation）强、半径小、偏红橙；
 *   · 高光是「大面积柔光」（窗户、阴天天空）→ 白柔/辉光（glow）大半径、低强度，不要红边；
 *   · 画面本身噪点低（干净数码）→ 加颗粒才有胶片质感；噪点已高就别再加。
 * 所以先量：高光占比、点状高光数量、高光边缘硬度、噪点水平、反差，再反推参数。
 *
 * 应用方式：用 ffmpeg 滤镜链真正把 halation/glow/grain 烘进画面（可验证），
 * 而不是只给「建议参数」。
 */

import { execFile } from 'node:child_process'

const DEFAULT_WIDTH = 320

function runBinary(args, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().slice(-500) || 'ffmpeg 失败'))
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
    })
  })
}

export async function decodeSmall(imagePath, width = DEFAULT_WIDTH) {
  const buffer = await runBinary(['-v', 'error', '-i', imagePath, '-frames:v', '1', '-vf', `scale=${width}:-2,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  const rows = Math.floor(buffer.length / (width * 3))
  if (rows < 8) throw new Error(`解码结果太小：${buffer.length}`)
  return { width, height: rows, data: buffer.subarray(0, rows * width * 3) }
}

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/** 量高光结构与噪点。 */
export function analyseTextureRgb(buffer, width, height) {
  const luma = new Float32Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    luma[i] = (0.2126 * buffer[i * 3] + 0.7152 * buffer[i * 3 + 1] + 0.0722 * buffer[i * 3 + 2]) / 255
  }
  const total = width * height
  const sorted = Float32Array.from(luma).sort()
  const p = (ratio) => sorted[Math.min(total - 1, Math.max(0, Math.floor(total * ratio)))]
  const p5 = p(0.05)
  const p50 = p(0.5)
  const p95 = p(0.95)
  const highlightThreshold = Math.max(0.75, p95 - 0.02)
  let highlightCount = 0
  let specularCount = 0
  let boundaryGradient = 0
  let boundaryCount = 0
  let interiorGradient = 0
  let interiorCount = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x
      const value = luma[index]
      if (value < highlightThreshold) continue
      highlightCount += 1
      const left = luma[index - 1]
      const right = luma[index + 1]
      const up = luma[index - width]
      const down = luma[index + width]
      const gradient = Math.max(Math.abs(value - left), Math.abs(value - right), Math.abs(value - up), Math.abs(value - down))
      // 局部孤立亮点 = 点状硬光（灯泡/车灯）
      const neighbourMean = (left + right + up + down) / 4
      if (value - neighbourMean > 0.18) specularCount += 1
      if (value > 0.95) {
        boundaryGradient += gradient
        boundaryCount += 1
      } else {
        interiorGradient += gradient
        interiorCount += 1
      }
    }
  }
  // 噪点：中灰平坦区的高频（与 3x3 均值差）标准差
  let highFreq = 0
  let flatCount = 0
  for (let y = 1; y < height - 1; y += 2) {
    for (let x = 1; x < width - 1; x += 2) {
      const index = y * width + x
      const value = luma[index]
      if (value < 0.2 || value > 0.8) continue
      const mean = (luma[index - 1] + luma[index + 1] + luma[index - width] + luma[index + width]) / 4
      highFreq += (value - mean) ** 2
      flatCount += 1
    }
  }
  const noise = flatCount > 0 ? Math.sqrt(highFreq / flatCount) : 0

  // 连通域：高光块的大小分布 → 判断「点状光源（灯泡/车灯）」还是「大面积柔光（窗户/天空）」
  const brightMask = new Uint8Array(total)
  for (let i = 0; i < total; i += 1) brightMask[i] = luma[i] >= 0.85 ? 1 : 0
  const visited = new Uint8Array(total)
  const components = []
  for (let start = 0; start < total; start += 1) {
    if (!brightMask[start] || visited[start]) continue
    let area = 0
    let maxLuma = 0
    const stack = [start]
    visited[start] = 1
    while (stack.length) {
      const index = stack.pop()
      area += 1
      if (luma[index] > maxLuma) maxLuma = luma[index]
      const x = index % width
      const y = Math.floor(index / width)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const nIndex = ny * width + nx
        if (brightMask[nIndex] && !visited[nIndex]) {
          visited[nIndex] = 1
          stack.push(nIndex)
        }
      }
    }
    components.push({ area, maxLuma: Number(maxLuma.toFixed(3)) })
  }
  const smallThreshold = total * 0.004 // 小于画面 0.4% 的高光块算「点状」
  const practicals = components.filter((component) => component.area < smallThreshold)
  const largeSoftAreas = components.filter((component) => component.area >= smallThreshold)
  const practicalPixels = practicals.reduce((acc, component) => acc + component.area, 0)
  const largeSoftPixels = largeSoftAreas.reduce((acc, component) => acc + component.area, 0)

  return {
    width,
    height,
    highlightPct: Number(((highlightCount / total) * 100).toFixed(2)),
    specularPct: Number(((specularCount / total) * 100).toFixed(2)),
    highlightHardness: Number((boundaryCount > 0 ? boundaryGradient / boundaryCount : 0).toFixed(4)),
    interiorSoftness: Number((interiorCount > 0 ? interiorGradient / interiorCount : 0).toFixed(4)),
    noiseEstimate: Number(noise.toFixed(4)),
    highlightComponents: components.length,
    practicalCount: practicals.length,
    practicalPct: Number(((practicalPixels / total) * 100).toFixed(2)),
    largeSoftPct: Number(((largeSoftPixels / total) * 100).toFixed(2)),
    lumaP5: Number(p5.toFixed(3)),
    lumaP50: Number(p50.toFixed(3)),
    lumaP95: Number(p95.toFixed(3)),
    contrast: Number((p95 - p5).toFixed(3)),
  }
}

export async function analyseTexture(imagePath) {
  const decoded = await decodeSmall(imagePath)
  return analyseTextureRgb(decoded.data, decoded.width, decoded.height)
}

/**
 * 从测量结果反推参数（带理由）。
 * style: 'godfather' | 'love-letter' | 'generic'
 */
export function planTexture(stats, style = 'generic') {
  const notes = []
  const specular = stats.specularPct ?? 0
  const highlight = stats.highlightPct ?? 0
  const hardness = stats.highlightHardness ?? 0
  const softness = stats.interiorSoftness ?? 0
  const noisy = (stats.noiseEstimate ?? 0) > 0.012

  // 光晕：点状硬光多 → 强、半径小；大面积柔光 → 弱、半径大
  // 点状光源：小连通域数量多，或点状高光占比不低
  const practicalShare = (stats.practicalPct ?? 0) / 100
  const largeSoftShare = (stats.largeSoftPct ?? 0) / 100
  // 只要「有点状光源且不是大面积柔光主导」就按 halation 走（哪怕只有一个灯泡）
  const practicalHeavy = (stats.practicalCount ?? 0) >= 1 && largeSoftShare < 0.05
  const hardLight = hardness >= 0.25
  let halationStrength = practicalHeavy ? 0.55 : hardLight ? 0.35 : 0.15
  let halationRadius = practicalHeavy ? 9 : 14
  if (style === 'godfather') {
    halationStrength = Math.min(0.85, halationStrength + 0.2)
    halationRadius = Math.round(halationRadius * 1.15)
    notes.push('《教父》的窗光与台灯都偏暖，光晕要更强更红')
  }
  notes.push(
    practicalHeavy
      ? `检出点状光源 ${stats.practicalCount ?? 0} 个（${(practicalShare * 100).toFixed(1)}%）→ 以 halation 为主（半径 ${halationRadius}px），红橙边缘`
      : `高光以面光为主（大面积柔光 ${(stats.largeSoftPct ?? 0).toFixed(1)}%，硬度 ${hardness}）→ 以柔光 glow 为主，别加红边`,
  )

  // 白柔 / glow：总面积大、边缘软 → 大半径低强度
  const largeSoft = highlight >= 1.5 && hardness < 0.2
  let glowStrength = largeSoft ? 0.3 : 0.15
  let glowRadius = largeSoft ? 28 : 16
  if (style === 'love-letter') {
    glowStrength = Math.min(0.5, glowStrength + 0.18)
    glowRadius = Math.round(glowRadius * 1.3)
    notes.push('《情书》是高调柔光：白柔要更大半径、更低强度，避免塑料感')
  }

  // 颗粒：干净画面才加；已有噪点就少加
  let grainAmount = noisy ? 4 : 9
  if (style === 'love-letter') grainAmount = Math.max(4, grainAmount - 2)
  notes.push(noisy ? `画面已有噪点（${stats.noiseEstimate}）→ 颗粒只补 ${grainAmount}` : `画面干净（噪点 ${stats.noiseEstimate}）→ 补 ${grainAmount} 的胶片颗粒`)

  return {
    style,
    halation: { strength: Number(halationStrength.toFixed(2)), radius: halationRadius, tint: [1.0, 0.55, 0.35], threshold: 0.72 },
    glow: { strength: Number(glowStrength.toFixed(2)), radius: glowRadius },
    grain: { amount: grainAmount },
    vingette: style === 'godfather' ? { strength: 0.25 } : { strength: 0.08 },
    notes,
    basis: { specularPct: specular, highlightPct: highlight, highlightHardness: hardness, interiorSoftness: softness, noiseEstimate: stats.noiseEstimate, contrast: stats.contrast },
  }
}

/**
 * 把 halation / glow / grain 烘进画面（ffmpeg 滤镜链）。
 * 输出 H.264 或 ProRes，取决于 outPath 扩展名。
 */
export async function renderTexturePass({ input, output, plan, width = 1920, bitrate = '18M' }) {
  const scale = Math.max(0.5, Number(width) / 320)
  const halation = plan?.halation ?? { strength: 0.3, radius: 10, tint: [1, 0.55, 0.35], threshold: 0.72 }
  const glow = plan?.glow ?? { strength: 0.15, radius: 16 }
  const grain = plan?.grain ?? { amount: 8 }
  const filters = []
  // 1) 高光提取 → 模糊 → 染色 = halation，再 screen 叠回去
  // 必须在 RGB 空间做 screen 混合：在 YUV 上直接 blend 会把色度搞成品红（实测事故）
  filters.push(
    `[0:v]format=gbrp,split=3[base][hsrc][gsrc]`,
    `[hsrc]curves=all='0/0 ${Math.min(0.95, halation.threshold).toFixed(2)}/0 1/1',gblur=sigma=${(halation.radius * scale).toFixed(1)},colorchannelmixer=rr=${halation.tint[0]}:gg=${halation.tint[1]}:bb=${halation.tint[2]}[hal]`,
    `[base][hal]blend=all_mode=screen:all_opacity=${halation.strength}[b1]`,
    // 2) 全图柔化 = glow
    `[gsrc]gblur=sigma=${(glow.radius * scale).toFixed(1)}[glow]`,
    `[b1][glow]blend=all_mode=screen:all_opacity=${glow.strength}[b2]`,
    // 3) 颗粒
    `[b2]noise=alls=${grain.amount}:allf=t+u,format=yuv420p[out]`,
  )
  const args = ['-v', 'error', '-i', input, '-filter_complex', filters.join(';'), '-map', '[out]', '-an']
  if (output.endsWith('.png') || output.endsWith('.jpg')) args.push('-frames:v', '1')
  if (output.endsWith('.mov')) args.push('-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le')
  else args.push('-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-b:v', bitrate)
  args.push('-y', output)
  await runBinary(args)
  return { output, filters: filters.join(';') }
}
