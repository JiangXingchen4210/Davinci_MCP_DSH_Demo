/**
 * 风格「必需效果」清单：把风格承诺拆成
 *   - supported：本插件能通过 Resolve API 实际落地（配方参数 / 还原 LUT / Film LUT / 柔光）
 *   - unsupported：当前 Color API 无法落地的（颗粒、暗角），必须如实标注，不能计入成功
 * 这样一键风格不会因为"基础建图成功"就把没做的效果算成完成。
 */

const TEXT_RULES = [
  { name: 'grain', pattern: /颗粒|grain/i, method: '需要 Fusion FilmGrain 或渲染后处理；Color 页 API 无颗粒节点' },
  { name: 'vignette', pattern: /暗角|vignette/i, method: '需要 Fusion/OFX 暗角；Color 页 API 无对应节点' },
]

export function planStyleEffects(style) {
  if (!style) return []
  const effects = []
  // 影调/色彩分离/肤键/背景键：都是配方参数，能落地
  effects.push({ name: 'grade', supported: true, required: true, method: '三层节点参数（曝光/对比/分离色调/肤键/背景键）' })
  if (style.filmLut) effects.push({ name: 'filmLut', supported: true, required: true, method: 'DaVinci Film Looks LUT（set_lut）' })
  if (style.mist) effects.push({ name: 'mist', supported: true, required: true, method: `Fusion Glow（${style.mist.mode ?? 'white'} ${style.mist.strength ?? ''}）` })
  const grain = Number(style.grain) || 0
  if (grain > 0) effects.push({ name: 'grain', supported: false, required: false, declared: grain, method: TEXT_RULES[0].method })
  const techniques = (style.techniques ?? []).join(' ')
  if (/暗角|vignette/i.test(techniques)) effects.push({ name: 'vignette', supported: false, required: false, method: TEXT_RULES[1].method })
  return effects
}

/** 汇总一次应用后的效果状态：只有 supported + required 都成功才算 ok。 */
export function summarizeStyleEffects(style, applied = {}) {
  const plan = planStyleEffects(style)
  const results = plan.map((effect) => ({
    ...effect,
    applied: effect.supported ? applied[effect.name] === true : false,
  }))
  const required = results.filter((effect) => effect.required && effect.supported)
  const missing = required.filter((effect) => !effect.applied).map((effect) => effect.name)
  const unsupported = results.filter((effect) => !effect.supported).map((effect) => ({ name: effect.name, declared: effect.declared ?? null, method: effect.method }))
  return {
    ok: required.every((effect) => effect.applied),
    required: required.map((effect) => effect.name),
    applied: results.filter((effect) => effect.applied).map((effect) => effect.name),
    missing,
    unsupported,
    results,
  }
}
