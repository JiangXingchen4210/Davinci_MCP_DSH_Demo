/** DJI D-Log / Sony S-Log3 官方参考值 + 全曲线单调性（独立于插件自身编码器）。 */
import { encodeToLog, decodeFromLog, generateLut, logToRec709 } from './lutgen.mjs'

let failures = 0
const near = (actual, expected, tol, label) => { if (Math.abs(actual - expected) > tol) { failures += 1; console.log(`  FAIL ${label}: 期望 ${expected}，实际 ${actual}`) } }

// DJI D-Log（白皮书 / colour-science）
near(encodeToLog([0, 0, 0], 'dji-dlog')[0], 0.0929, 2e-5, 'DJI 黑位')
near(encodeToLog([0.18, 0.18, 0.18], 'dji-dlog')[0], 0.398765, 2e-5, 'DJI 18% 灰')
near(decodeFromLog([0.398765, 0.398765, 0.398765], 'dji-dlog')[0], 0.18, 2e-4, 'DJI 解码 18%')
near(encodeToLog([1, 1, 1], 'dji-dlog')[0], 0.256663 * Math.log10(1.0) + 0.584555, 2e-6, 'DJI 高光')

// Sony S-Log3（SMPTE ST 2115 对数段；暗部与切点连续）
near(encodeToLog([0, 0, 0], 'sony-slog3')[0], 95 / 1023, 2e-5, 'Sony 黑位')
near(encodeToLog([0.18, 0.18, 0.18], 'sony-slog3')[0], (420 + 261.5 * Math.log10(0.19 / 0.19)) / 1023, 2e-5, 'Sony 18% 灰')
const left = encodeToLog([0.011249, 0.011249, 0.011249], 'sony-slog3')[0]
const right = encodeToLog([0.01125, 0.01125, 0.01125], 'sony-slog3')[0]
if (Math.abs(left - right) > 2e-4) { failures += 1; console.log(`  FAIL Sony 分段点跳变：${left} → ${right}`) }
if (!(right > left)) { failures += 1; console.log('  FAIL Sony 分段点应单调递增') }

// 全曲线单调性（0..1，2001 点）
for (const key of ['dji-dlog', 'sony-slog3', 'panasonic-vlog']) {
  let prev = -1
  for (let i = 0; i <= 2000; i += 1) {
    const value = encodeToLog([i / 2000, i / 2000, i / 2000], key)[0]
    if (value + 1e-9 < prev) { failures += 1; console.log(`  FAIL ${key} 在 x=${(i / 2000).toFixed(3)} 不单调：${prev} → ${value}`); break }
    if (!Number.isFinite(value)) { failures += 1; console.log(`  FAIL ${key} 在 x=${i / 2000} 输出非有限值`); break }
    prev = value
  }
}

// .cube 采样：18% 灰经过 LUT 后与直接计算一致（DJI）
const lut = generateLut('dji-dlog', { size: 33 })
const lines = lut.content.trim().split('\n')
const body = lines.slice(lines.indexOf('DOMAIN_MAX 1.0 1.0 1.0') + 1)
const size = 33
const at = (r, g, b) => body[(b * size + g) * size + r].trim().split(/\s+/).map(Number)
const input = encodeToLog([0.18, 0.18, 0.18], 'dji-dlog')[0]
const x = input * (size - 1)
const i0 = Math.floor(x), i1 = Math.min(i0 + 1, size - 1), t = x - i0
const expected = logToRec709([input, input, input], 'dji-dlog')[0]
const sample = at(i0, i0, i0)[0] + (at(i1, i1, i1)[0] - at(i0, i0, i0)[0]) * t
near(sample, expected, 5e-3, 'DJI cube 18% 采样')

if (failures) { console.error(`FAIL lutgen_dji_sony.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS lutgen_dji_sony.test.mjs — DJI 18%=0.398765、Sony 分段连续、三条曲线全区间单调、cube 采样一致')
