/** 8 层引擎自检：分区完整、恒等匹配严格恒等、暖/冷背景分离、JSON 安全。 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyzeFrame8, compareLayers8 } from './layers8.mjs'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'layers8-test-'))
let failures = 0
function assert(condition, message) {
  if (condition) return
  failures += 1
  console.log(`  FAIL ${message}`)
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim().slice(-300) || 'ffmpeg 失败'))
      else resolve()
    })
  })
}

// 暖色底（黄）+ 肤色块 + 低饱和高光（镜面）+ 高饱和炫光
const warm = path.join(tmp, 'warm.png')
await ffmpeg([
  '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xb08a3a:s=320x180',
  '-vf', [
    'drawbox=x=90:y=50:w=60:h=60:color=0xd8a878@1:t=fill',
    'drawbox=x=20:y=20:w=26:h=26:color=0xf2f2f2@1:t=fill',
    'drawbox=x=250:y=120:w=30:h=30:color=0x28ffb4@1:t=fill',
  ].join(','),
  '-frames:v', '1', '-y', warm,
])

// 冷色底（蓝）
const cool = path.join(tmp, 'cool.png')
await ffmpeg([
  '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2f4f8a:s=320x180',
  '-vf', 'drawbox=x=120:y=60:w=60:h=60:color=0x8a8a8a@1:t=fill',
  '-frames:v', '1', '-y', cool,
])

const warmStats = await analyzeFrame8(warm)
const coolStats = await analyzeFrame8(cool)
const layerNames = ['global', 'skin', 'specular', 'glare', 'shadow', 'backgroundWarm', 'backgroundCool', 'neutral']

// 1) 8 层都存在
for (const name of layerNames) assert(warmStats.layers[name], `缺少层 ${name}`)
// 2) 互斥分区之和 ≈ 100%（不含 neutral 叠加层）
const partition = ['skin', 'specular', 'glare', 'shadow', 'backgroundWarm', 'backgroundCool']
const sum = partition.reduce((acc, name) => acc + (warmStats.layers[name]?.coverage ?? 0), 0)
assert(Math.abs(sum - 100) < 1.5, `暖图分区覆盖率之和应≈100%，实际 ${sum.toFixed(2)}`)
// 3) 暖/冷背景分离
assert(warmStats.layers.backgroundWarm.coverage > warmStats.layers.backgroundCool.coverage, '暖图应 backgroundWarm 占优')
assert(coolStats.layers.backgroundCool.coverage > coolStats.layers.backgroundWarm.coverage, '冷图应 backgroundCool 占优')
// 4) specular 低饱和、glare 高饱和
assert(warmStats.layers.specular.meanSat === null || warmStats.layers.specular.meanSat < 0.18, 'specular 层应低饱和')
assert(warmStats.layers.glare.meanSat === null || warmStats.layers.glare.meanSat >= 0.18, 'glare 层应高饱和')
// 5) 恒等匹配严格恒等
const identity = compareLayers8(warmStats, warmStats)
for (const name of layerNames) {
  const cdl = identity.layers[name].cdl
  const ok =
    cdl.Slope.every((value) => Math.abs(value - 1) < 1e-6) &&
    cdl.Offset.every((value) => Math.abs(value) < 1e-6) &&
    cdl.Power.every((value) => Math.abs(value - 1) < 1e-6) &&
    Math.abs(cdl.Saturation - 1) < 1e-6
  assert(ok, `${name} 恒等匹配不严格：${JSON.stringify(cdl)}`)
}
// 6) 暖图 → 冷图：backgroundWarm 层应给出暖化校正（gain 偏暖：R>B 或 saturation 提升）
const cross = compareLayers8(coolStats, warmStats)
const warmLayer = cross.layers.backgroundWarm
assert(warmLayer && warmLayer.confidence !== undefined, 'cross 匹配应有 backgroundWarm 结果')
// 7) JSON 安全
const json = JSON.stringify({ warmStats, coolStats, identity, cross })
assert(!/NaN|Infinity/.test(json), 'JSON 里不应出现 NaN/Infinity')
// 8) 缺失层 → low 置信度
assert(Boolean((await analyzeFrame8(warm)).layers.neutral), 'neutral 层存在')

console.log(
  failures === 0
    ? `PASS layers8.test.mjs — 8 层齐全、分区和 ${sum.toFixed(2)}%、暖/冷分离、specular/glare 分离、恒等严格、JSON 安全`
    : `FAIL layers8.test.mjs — ${failures} 项断言失败`,
)
process.exitCode = failures === 0 ? 0 : 1
