/** 风格必需效果验收：颗粒/暗角必须标为当前 API 不支持，不能计入成功。 */
import { planStyleEffects, summarizeStyleEffects } from './style_effects.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }

const godfather = {
  key: 'godfather-amber',
  techniques: ['琥珀暖调', '暗角 15%', '颗粒 10'],
  recipe: { contrast: 1.1 },
  grain: 10, mist: null, filmLut: null,
}
const plan = planStyleEffects(godfather)
assert(plan.some((e) => e.name === 'grain' && e.supported === false), '颗粒必须标为 unsupported')
assert(plan.some((e) => e.name === 'vignette' && e.supported === false), '暗角必须标为 unsupported')
assert(plan.some((e) => e.name === 'grade' && e.supported === true), '配方参数应可落地')

// 基础建图成功但颗粒/暗角没做：结果不能 ok
const partial = summarizeStyleEffects(godfather, { grade: true })
assert(partial.ok === true, 'grain/vignette 非 required，不应把 grade 成功判失败')
assert(partial.applied.includes('grade') && !partial.applied.includes('grain'), 'applied 只能包含真正落地的效果')
assert(partial.unsupported.length === 2, `应报告 2 个不支持项，实际 ${JSON.stringify(partial.unsupported)}`)

// 必需效果（Film LUT）挂载失败 → ok:false
const kodak = { key: 'kodak-2383', techniques: ['2383'], recipe: {}, grain: 0, mist: null, filmLut: '/tmp/film.cube' }
const fail = summarizeStyleEffects(kodak, { grade: true, filmLut: false })
assert(fail.ok === false && fail.missing.includes('filmLut'), 'Film LUT 失败必须判为未完成')
const pass = summarizeStyleEffects(kodak, { grade: true, filmLut: true })
assert(pass.ok === true, 'Film LUT 成功应判为完成')

if (failures) { console.error(`FAIL style_effects.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS style_effects.test.mjs — 颗粒/暗角标为不支持；Film LUT 失败不计成功')
