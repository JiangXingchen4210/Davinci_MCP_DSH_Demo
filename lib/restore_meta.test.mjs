/** 还原决策：LogC4/LogC3 严格区分、低反差不再提前放行、RCM 接管时跳技术 LUT。 */
import { detectCurveFromMeta, matchCurveLut, rcmManaged } from './restore.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }

// 1) 同品牌两条曲线
assert(detectCurveFromMeta('ARRI ALEXA 35 LogC4 AWG4').curve === 'ARRI LogC4', 'ALEXA 35 LogC4 必须识别为 LogC4')
assert(detectCurveFromMeta('ARRI ALEXA Mini LogC3 AWG3').curve === 'ARRI LogC3', 'ALEXA Mini LogC3 必须识别为 LogC3')
assert(detectCurveFromMeta('ALEXA 35').curve === 'ARRI LogC4', '只写 ALEXA 35 时按机型取 LogC4')

// 2) 库里只有 LogC3 时，LogC4 不能选中它
const c4 = detectCurveFromMeta('ARRI ALEXA 35 LogC4 AWG4')
const onlyC3 = [{ name: 'ARRI_LogC3-to-Rec709.cube' }]
assert(matchCurveLut(onlyC3, c4).candidates.length === 0, 'LogC4 素材不能匹配 LogC3 LUT')
const both = [{ name: 'ARRI_LogC3-to-Rec709.cube' }, { name: 'ARRI_LogC4-to-Rec709.cube' }]
const hit = matchCurveLut(both, c4)
assert(hit.candidates.length === 1 && /logc4/i.test(hit.candidates[0].name), `应只留 LogC4 候选，实际 ${JSON.stringify(hit.candidates.map((c) => c.name))}`)

// 3) RCM 判定
assert(rcmManaged({ colorScienceMode: 'DaVinci YRGB Color Managed' }).managed === true, 'Color Managed 应判为已接管')
assert(rcmManaged({ colorScienceMode: 'DaVinci YRGB' }).managed === false, '非 managed 不应接管')
assert(rcmManaged({ colorScienceMode: 'DaVinci YRGB', colorSpaceInput: 'ARRI LogC4' }).managed === true, '输入空间明确设成 LOG 时应视为已接管')
assert(rcmManaged({ colorScienceMode: 'DaVinci YRGB', colorSpaceInput: 'Rec.709' }).managed === false, '输入空间 Rec.709 不应接管')

if (failures) { console.error(`FAIL restore_meta.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS restore_meta.test.mjs — LogC4/LogC3 严格区分；LogC4 不拿 LogC3 LUT；RCM 接管判定正确')
