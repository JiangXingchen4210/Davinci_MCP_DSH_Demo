import { generateLookLut, listLooks, generateLookLut as gen } from './lookgen.mjs'
const luts = listLooks().map(l => l.key)
console.log('looks:', luts)
// 采样：阴影灰(0.2) 高光灰(0.8) 中间灰(0.5)
function sample(lut, value) {
  const lines = lut.content.split('\n').filter(l => /^\d/.test(l))
  const size = lut.size
  const idx = Math.round(value * (size - 1))
  const offset = (idx * size * size) + (idx * size) + idx
  return lines[offset].split(' ').map(Number)
}
const cp = gen('cyberpunk')
const shadow = sample(cp, 0.18), mid = sample(cp, 0.5), high = sample(cp, 0.82)
console.log('shadow(0.18) RGB:', shadow, '→ hue', Math.round(Math.atan2(Math.sqrt(3)*(shadow[1]-shadow[2]), 2*shadow[0]-shadow[1]-shadow[2])*180/Math.PI+360)%360)
console.log('mid(0.50)   RGB:', mid)
console.log('high(0.82)  RGB:', high, '→ 暖/品红(R+B>2G):', (high[0]+high[2]) > 2*high[1])
const okShadowCyan = shadow[2] > shadow[0] && shadow[1] > shadow[0]   // 蓝>红 且 绿>红 → 青蓝
const okHighMagenta = (high[0] > high[1]) && (high[2] >= high[1]*0.95) // 红/蓝 > 绿 → 品红倾向
const okSize = cp.content.split('\n').filter(l => /^\d/.test(l)).length === 33*33*33
console.log(okShadowCyan ? 'PASS 暗部偏青蓝' : 'FAIL 暗部不成青蓝')
console.log(okHighMagenta ? 'PASS 高光偏品红/暖' : 'FAIL 高光不成品红')
console.log(okSize ? 'PASS 33³ 行数正确' : 'FAIL 行数不对')
if (!(okShadowCyan && okHighMagenta && okSize)) process.exitCode = 1
else console.log('PASS lookgen.test.mjs — cyberpunk LUT 暗部青蓝/高光品红/33³ 正确')
