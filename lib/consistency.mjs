/**
 * 跨镜头调色一致性（consistency）：先把「同一场戏里不同素材」拉到同一基准，再套风格。
 *
 * 问题来源：日戏里同一件黑衣服在几条素材里看起来完全不一样——因为逐条按各自画面分析、
 * 套同一个 LUT 并不能消除源素材之间的曝光/黑位/白平衡差异。
 *
 * 做法（三个自由度，不动局部）：
 *   1) 曝光/对比：用 p5/p50/p95 三锚点把目标镜头映射到 hero 镜头
 *   2) 黑位：把源 p5 抬/压到 hero 的 p5（黑衣服就是这一项）
 *   3) 白平衡：用 R/B 均值比校正冷暖
 *   饱和度单独轻调。输出每个镜头的修正量 + 残差，可测量、可拒绝。
 */

const CLAMP = Object.freeze({
  gain: [0.75, 1.3],
  lift: [-0.08, 0.08],
  warmth: [-0.06, 0.06],
  saturation: [0.85, 1.2],
  gamma: [0.7, 1.4],
})

const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value))
const round = (value, digits = 4) => Number(Number(value).toFixed(digits))

/** 从 layers.mjs 的分析结果里取一致性判断需要的统计量。 */
export function statsFromAnalysis(analysis) {
  const global = analysis?.layers?.global ?? analysis?.global ?? null
  const shadow = analysis?.layers?.shadow ?? null
  if (!global || !global.lumaPct) return null
  return {
    p5: Number(global.lumaPct.p5 ?? 0),
    p50: Number(global.lumaPct.p50 ?? 0),
    p95: Number(global.lumaPct.p95 ?? 1),
    sat: Number(global.meanSat ?? 0),
    r: Number(global.meanR ?? 0),
    g: Number(global.meanG ?? 0),
    b: Number(global.meanB ?? 0),
    shadowLuma: Number(shadow?.meanLuma ?? global.lumaPct.p5 ?? 0),
    shadowR: Number(shadow?.meanR ?? 0),
    shadowB: Number(shadow?.meanB ?? 0),
    coverage: Number(global.coverage ?? 100),
  }
}

/**
 * hero 镜头为基准，算每个镜头的修正量。
 * @param {{id:string, stats:object}} hero
 * @param {Array<{id:string, stats:object}>} shots
 */
export function buildConsistencyPlan(hero, shots, options = {}) {
  if (!hero?.stats) return { ok: false, reason: '缺少 hero 镜头的分析结果' }
  const bounds = { ...CLAMP, ...(options.bounds ?? {}) }
  const entries = []
  for (const shot of shots) {
    if (!shot?.stats) {
      entries.push({ id: shot?.id ?? null, ok: false, reason: '该镜头没有可用分析（可能是纯黑/纯色）' })
      continue
    }
    const s = shot.stats
    const h = hero.stats
    // 1) 曝光/对比：三锚点线性映射
    const sourceRange = Math.max(0.02, s.p95 - s.p5)
    const heroRange = Math.max(0.02, h.p95 - h.p5)
    const gainRaw = heroRange / sourceRange
    const gain = clamp(gainRaw, bounds.gain)
    // 2) 黑位：把源 p5 映射到 hero p5
    const liftRaw = h.p5 - s.p5 * gain
    const lift = clamp(liftRaw, bounds.lift)
    // 2b) 中间调 gamma：gain+lift 是线性的，三锚点要靠 gamma 才能同时对上
    const midAfterLinear = s.p50 * gain + lift
    let gamma = 1
    if (midAfterLinear > 0.01 && midAfterLinear < 0.99 && h.p50 > 0.01) {
      const gammaRaw = Math.log(h.p50) / Math.log(midAfterLinear)
      gamma = clamp(Number.isFinite(gammaRaw) ? gammaRaw : 1, bounds.gamma)
    }

    // 3) 白平衡：用 R/B 比值的几何平均把两边「对半」拉平（不会把画面推成偏色）
    const heroRatio = h.r / Math.max(1e-4, h.b)
    const shotRatio = s.r / Math.max(1e-4, s.b)
    const warmthRaw = 0.5 * Math.log(Math.max(1e-4, heroRatio / shotRatio))
    const warmth = clamp(warmthRaw, bounds.warmth)
    // 4) 饱和度
    const satRaw = s.sat > 0.01 ? h.sat / s.sat : 1
    const saturation = clamp(satRaw, bounds.saturation)

    // 模拟「套用修正后」的统计（线性近似），用于估算残差
    const applyGamma = (value) => value <= 0 ? value : Math.pow(value, gamma)
    const after = {
      p5: applyGamma(s.p5 * gain + lift),
      p50: applyGamma(s.p50 * gain + lift),
      p95: applyGamma(s.p95 * gain + lift),
      sat: s.sat * saturation,
      r: s.r * Math.exp(warmth),
      b: s.b * Math.exp(-warmth),
    }
    entries.push({
      id: shot.id,
      ok: true,
      corrections: {
        gain: round(gain),
        lift: round(lift),
        gamma: round(gamma),
        warmth: round(warmth),
        saturation: round(saturation),
      },
      clamped: {
        gain: gain !== round(gainRaw),
        lift: lift !== round(liftRaw),
        gamma: gamma !== 1,
        warmth: warmth !== round(warmthRaw),
        saturation: saturation !== round(satRaw),
      },
      residual: {
        blackDelta: round(after.p5 - h.p5),
        midDelta: round(after.p50 - h.p50),
        whiteDelta: round(after.p95 - h.p95),
        satDelta: round(after.sat - h.sat),
      },
      before: {
        blackDelta: round(s.p5 - h.p5),
        midDelta: round(s.p50 - h.p50),
        whiteDelta: round(s.p95 - h.p95),
      },
      confidence: Number((shot.stats.coverage >= 20 ? 0.9 : 0.55).toFixed(2)),
    })
  }
  return { ok: true, hero: { id: hero.id, stats: hero.stats }, entries }
}

/** 不一致度：黑衣服（暗部）、肤色、白平衡的离散程度。越小越一致。 */
export function measureInconsistency(statsList) {
  const usable = statsList.filter((entry) => entry?.stats)
  if (usable.length < 2) return { ok: false, reason: '至少需要两个镜头的统计' }
  const spread = (values) => {
    const min = Math.min(...values)
    const max = Math.max(...values)
    return Number((max - min).toFixed(4))
  }
  const blackSpread = spread(usable.map((entry) => entry.stats.shadowLuma))
  const midSpread = spread(usable.map((entry) => entry.stats.p50))
  const whiteSpread = spread(usable.map((entry) => entry.stats.p95))
  const wbSpread = spread(usable.map((entry) => Math.log(Math.max(1e-4, entry.stats.r / Math.max(1e-4, entry.stats.b)))))
  const satSpread = spread(usable.map((entry) => entry.stats.sat))
  // 黑衣服一致性是重点：暗部亮度差 >0.03 就肉眼可见
  const score = Number((blackSpread * 8 + midSpread * 3 + wbSpread * 4 + satSpread * 2).toFixed(3))
  return {
    ok: true,
    blackSpread,
    midSpread,
    whiteSpread,
    wbSpread,
    satSpread,
    score,
    verdict: score <= 0.12 ? 'consistent' : score <= 0.25 ? 'slightly-varied' : 'inconsistent',
    worstBlack: usable
      .map((entry) => ({ id: entry.id, shadowLuma: entry.stats.shadowLuma }))
      .sort((a, b) => a.shadowLuma - b.shadowLuma),
  }
}
