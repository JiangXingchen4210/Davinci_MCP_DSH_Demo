import { parseBlackdetect, qcVerdict } from './export_qc.mjs'
let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
const sample = `[blackdetect @ 0x1] black_start:1.958333 black_end:2.458333 black_duration:0.5
[blackdetect @ 0x1] black_start:3.541667 black_end:5.25 black_duration:1.708333`
const parsed = parseBlackdetect(sample)
assert(parsed.intervals.length === 2, '应解析 2 段黑场')
assert(Math.abs(parsed.blackSeconds - 2.208) < 1e-3, `黑场总时长，实际 ${parsed.blackSeconds}`)
assert(parseBlackdetect('').intervals.length === 0, '无黑场文本应返回空')
assert(qcVerdict({ duration: 20, blackSeconds: 0 }).pass === true, '无黑场 PASS')
assert(qcVerdict({ duration: 20, blackSeconds: 2.2 }).pass === false, '有黑场 FAIL')
assert(qcVerdict({ duration: 0, blackSeconds: 0 }).pass === false, '时长为 0 FAIL')
if (failures) { console.error(`FAIL export_qc.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS export_qc.test.mjs — blackdetect 解析与判定')
