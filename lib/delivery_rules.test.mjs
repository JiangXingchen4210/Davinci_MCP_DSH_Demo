/** 交付规则：删除结果解析、帧率/宽高比较、规格核对、回滚结论文案。 */
import { parseDeleteResult, valuesEqual, specMatches, summarizeRestore } from './delivery_rules.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }

// 1) delete_job 结果解析：布尔与 {success} 都要认
assert(parseDeleteResult(false).ok === false, '布尔 false 必须判为删除失败')
assert(parseDeleteResult(true).ok === true, '布尔 true 必须判为成功')
assert(parseDeleteResult({ success: false }).ok === false, '{success:false} 必须判为删除失败')
assert(parseDeleteResult({ success: true }).ok === true, '{success:true} 必须判为成功')
assert(parseDeleteResult({}).ok === false, '无法判定的结果按失败处理')

// 2) 帧率比较：24 与 "24.000" 相等；23.976 与 24 不等；空/null 不是有效读回
assert(valuesEqual('timelineFrameRate', '24', '24.000') === true, '24 与 24.000 必须相等')
assert(valuesEqual('fps', 24, '24.000') === true, 'fps 数值比较同样成立')
assert(valuesEqual('timelineFrameRate', '23.976', '24') === false, '23.976 与 24 必须不等')
assert(valuesEqual('timelineFrameRate', null, '24') === false, 'null 不能算有效读回')
assert(valuesEqual('timelineFrameRate', '', '24') === false, '空串不能算有效读回')

// 3) 宽高必须按整数比较
assert(valuesEqual('timelineResolutionWidth', '3840', 3840) === true, '宽 3840 与 "3840" 相等')
assert(valuesEqual('timelineResolutionWidth', '3840.5', 3840) === false, '非整数宽度不能算相等')

// 4) 规格核对：codec 不同必须不等；帧率写法不同不影响
const plan = { width: 1920, height: 1080, fps: 24, format: 'mov', codec: 'H.264' }
assert(specMatches({ width: 1920, height: 1080, fps: '24.000', format: 'mov', codec: 'H264' }, plan) === true, '写法差异不应判为不符')
assert(specMatches({ width: 1920, height: 1080, fps: 24, format: 'mov', codec: 'H.265' }, plan) === false, '编码不同必须判为不符')
assert(specMatches({ width: 1280, height: 720, fps: 24, format: 'mov', codec: 'H.264' }, plan) === false, '尺寸不同必须判为不符')

// 5) 回滚结论：未改动 / 全部恢复 / 部分失败
assert(summarizeRestore(false, []).state === 'unchanged', '未改动项目应报 unchanged')
const restored = summarizeRestore(true, [{ name: 'timelineResolutionWidth', expected: '3840', actual: '3840', ok: true }])
assert(restored.state === 'restored' && restored.restored === true, '全部恢复应报 restored')
const partial = summarizeRestore(true, [
  { name: 'timelineResolutionWidth', expected: '3840', actual: '1920', ok: false },
  { name: 'timelineFrameRate', expected: '30', actual: '30', ok: true },
])
assert(partial.state === 'partial' && partial.restored === false, '部分失败应报 partial')
assert(partial.message.includes('timelineResolutionWidth') && partial.message.includes('3840') && partial.message.includes('1920'), '文案必须包含设置名、原值与读回值')

if (failures) { console.error(`FAIL delivery_rules.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS delivery_rules.test.mjs — 删除结果/帧率/整数/编码/回滚文案规则正确')
