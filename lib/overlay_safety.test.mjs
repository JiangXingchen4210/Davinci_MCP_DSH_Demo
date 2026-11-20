import { planOverlayCompAction, OVERLAY_COMP_NAME } from './overlay_safety.mjs'
let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
assert(planOverlayCompAction([]).action === 'create', '空片段应创建')
const replace = planOverlayCompAction(['AutoOverlay'])
assert(replace.action === 'replace' && replace.deleteNames.length === 1, '只有插件的 comp 时应替换')
const mixed = planOverlayCompAction(['MyGradeComp', OVERLAY_COMP_NAME, 'VFXComp'])
assert(mixed.action === 'replace', '插件 comp + 用户 comp 时应只替换插件 comp')
assert(mixed.deleteNames.length === 1 && mixed.deleteNames[0] === OVERLAY_COMP_NAME, '只能删除插件自己的 comp')
assert(mixed.keep.length === 2, '用户 comp 必须保留')
const refuse = planOverlayCompAction(['MyGradeComp', 'VFXComp'])
assert(refuse.action === 'refuse' && refuse.deleteNames.length === 0, '存在用户 comp 且无插件 comp 必须拒绝')
assert(refuse.reason.includes('非插件'), '拒绝原因应可读')
assert(planOverlayCompAction(['AutoOverlay', 'AutoOverlay_old']).keep.includes('AutoOverlay_old'), '只认精确名字')
if (failures) { console.error(`FAIL overlay_safety.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS overlay_safety.test.mjs — 只替换插件 comp / 用户 comp 不删')
