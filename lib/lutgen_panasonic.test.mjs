/** Panasonic V-Log 官方参考值 + 恒等用途：固定向量、编码/解码、.cube 采样。 */
import { encodeToLog, decodeFromLog, logToRec709, generateLut } from './lutgen.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
const near = (actual, expected, tol, label) => assert(Math.abs(actual - expected) <= tol, `${label}: 期望 ${expected} ±${tol}，实际 ${actual}`)

// 1) 官方公式的固定向量（VARICAM V-Log rev1.0）
//    V = 0.241514*log10(L + 0.00873) + 0.598206 (L >= 0.01)；低段线性靴部
const vectors = [
  { L: 0.0, V: 0.125, label: '黑位 L=0' },          // e*0+f，f=0.125（切点连续解出）
  { L: 0.01, V: 0.181, label: '分段点 L=0.01' },      // 与对数段连续
  { L: 0.18, V: 0.423311, label: '18% 灰' },
  { L: 1.0, V: 0.599118, label: '线性 1.0' },
]
for (const vector of vectors) {
  near(encodeToLog([vector.L, vector.L, vector.L], 'panasonic-vlog')[0], vector.V, 2e-5, `编码 ${vector.label}`)
  near(decodeFromLog([vector.V, vector.V, vector.V], 'panasonic-vlog')[0], vector.L, 2e-4, `解码 ${vector.label}`)
}

// 2) 错误的输入不再出现（旧实现把 18% 编成 0.599946）
assert(Math.abs(encodeToLog([0.18, 0.18, 0.18], 'panasonic-vlog')[0] - 0.599946) > 0.1, '18% 灰不能编成旧的 0.599946')
assert(Math.abs(decodeFromLog([0.423311, 0.423311, 0.423311], 'panasonic-vlog')[0] - 0.032143) > 0.1, '0.423311 解码不能是旧的 0.032143')

// 3) .cube 采样：输入=18% 编码值，输出应接近 logToRec709(0.423311)
const lut = generateLut('panasonic-vlog', { size: 33 })
const lines = lut.content.trim().split('\n')
const body = lines.slice(lines.indexOf('DOMAIN_MAX 1.0 1.0 1.0') + 1)
const size = 33
const at = (r, g, b) => body[(b * size + g) * size + r].trim().split(/\s+/).map(Number)
const lerp = (a, b, t) => a + (b - a) * t
// 三线性采样 .cube（输入 0.423311 不在网格点上）
const sampleCube = (value) => {
  const x = value * (size - 1)
  const i0 = Math.floor(x)
  const i1 = Math.min(i0 + 1, size - 1)
  const t = x - i0
  const corner = (r, g, b) => at(r, g, b)
  const c00 = [0, 1, 2].map((ch) => lerp(corner(i0, i0, i0)[ch], corner(i1, i0, i0)[ch], t))
  const c01 = [0, 1, 2].map((ch) => lerp(corner(i0, i0, i1)[ch], corner(i1, i0, i1)[ch], t))
  const c10 = [0, 1, 2].map((ch) => lerp(corner(i0, i1, i0)[ch], corner(i1, i1, i0)[ch], t))
  const c11 = [0, 1, 2].map((ch) => lerp(corner(i0, i1, i1)[ch], corner(i1, i1, i1)[ch], t))
  return [0, 1, 2].map((ch) => lerp(lerp(c00[ch], c10[ch], t), lerp(c01[ch], c11[ch], t), t))
}
const expected = logToRec709([0.423311, 0.423311, 0.423311], 'panasonic-vlog')
const got = sampleCube(0.423311)
for (let channel = 0; channel < 3; channel += 1) near(got[channel], expected[channel], 3e-3, `cube 采样通道 ${channel}`)

// 4) 恒等：linear-identity 逐通道不变；rec709-identity 是线性→Rec.709 的显示编码（用途明确）
near(logToRec709([0.5, 0.5, 0.5], 'linear-identity')[0], 0.5, 1e-9, 'linear-identity 0.5')
near(logToRec709([0.25, 0.25, 0.25], 'linear-identity')[0], 0.25, 1e-9, 'linear-identity 0.25')
near(logToRec709([0.5, 0.5, 0.5], 'rec709-identity')[0], 0.705515, 2e-5, '线性→Rec.709 OETF 0.5')
const identityCube = generateLut('linear-identity', { size: 17 })
const cubeLines = identityCube.content.trim().split('\n')
const cubeBody = cubeLines.slice(cubeLines.indexOf('DOMAIN_MAX 1.0 1.0 1.0') + 1)
const mid = cubeBody[Math.floor(cubeBody.length / 2)].trim().split(/\s+/).map(Number)
assert(mid.every((value) => Math.abs(value - 0.5) < 1e-6), `linear-identity cube 中点应是 0.5，实际 ${mid}`)

if (failures) { console.error(`FAIL lutgen_panasonic.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS lutgen_panasonic.test.mjs — V-Log 官方向量（黑位/分段点/18%/1.0）编码解码与 cube 采样一致；恒等用途分离')
