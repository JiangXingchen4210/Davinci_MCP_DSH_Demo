/** 质感引擎自检：点状光源 → halation 主导；大面积柔光 → glow 主导；渲染后光晕扩散、颗粒增加。 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyseTexture, planTexture, renderTexturePass, decodeSmall } from './texture.mjs'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'texture-test-'))
const run = (args, input) => new Promise((resolve, reject) => {
  const child = execFile('ffmpeg', args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  if (input) child.stdin.end(input); else child.stdin.end()
})
let failures = 0
const assert = (condition, message) => { if (!condition) { failures += 1; console.log(`  FAIL ${message}`) } }

// 1) 点状光源图（一个小灯泡）
const spots = path.join(tmp, 'spots.png')
await run(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x0e0e12:s=640x360', '-vf', 'drawbox=x=300:y=150:w=16:h=16:color=0xfff4d6@1:t=fill', '-frames:v', '1', '-y', spots])
// 2) 大面积柔光图（窗户）
const windowPath = path.join(tmp, 'window.png')
await run(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xa8b0ba:s=640x360', '-vf', 'drawbox=x=0:y=0:w=640:h=150:color=0xf2f6fa@1:t=fill', '-frames:v', '1', '-y', windowPath])

const spotStats = await analyseTexture(spots)
const windowStats = await analyseTexture(windowPath)
console.log('spots:', 'components', spotStats.highlightComponents, '| practicals', spotStats.practicalCount, '| largeSoft', spotStats.largeSoftPct, '%')
console.log('window:', 'components', windowStats.highlightComponents, '| practicals', windowStats.practicalCount, '| largeSoft', windowStats.largeSoftPct, '%')
assert(spotStats.practicalCount >= 1, '点状光源图应检出至少 1 个点状高光连通域')
assert(windowStats.largeSoftPct > 10, `窗户图应检出大面积柔光，实际 ${windowStats.largeSoftPct}%`)

const spotPlan = planTexture(spotStats, 'godfather')
const windowPlan = planTexture(windowStats, 'love-letter')
console.log('spotPlan halation:', spotPlan.halation.strength, 'r', spotPlan.halation.radius, '| glow', spotPlan.glow.strength)
console.log('windowPlan halation:', windowPlan.halation.strength, '| glow:', windowPlan.glow.strength, 'r', windowPlan.glow.radius)
assert(spotPlan.halation.strength > windowPlan.halation.strength, '点状光源的 halation 应强于柔光图')
assert(windowPlan.glow.radius >= spotPlan.glow.radius, '柔光图的 glow 半径应不小于点状图')
assert(spotPlan.notes.length >= 2 && windowPlan.notes.length >= 2, '都要给出可解释理由')

// 3) 渲染验证：光晕让高光扩散（中高亮像素变多），颗粒让平坦区噪声增加
const outSpot = path.join(tmp, 'spots-out.png')
await renderTexturePass({ input: spots, output: outSpot, plan: spotPlan })

// 只在光源周围区域量（全画面里 0.09% 的小灯对 p90 几乎没有影响）
const cropP90 = async (filePath) => {
  const buf = await new Promise((resolve, reject) => {
    const child = execFile('ffmpeg', ['-v', 'error', '-i', filePath, '-vf', 'crop=200:160:210:80,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    child.stdin.end()
  })
  const values = [...buf].sort((a, b) => a - b)
  return values[Math.floor(values.length * 0.9)] / 255
}
const beforeP90 = await cropP90(spots)
const afterP90 = await cropP90(outSpot)
console.log('halation: 光源周围 p90', beforeP90.toFixed(3), '→', afterP90.toFixed(3))
assert(afterP90 > beforeP90 + 0.01, `光晕应抬高光源周围亮度，实际 ${beforeP90.toFixed(3)} → ${afterP90.toFixed(3)}`)

const outWindow = path.join(tmp, 'window-out.png')
await renderTexturePass({ input: windowPath, output: outWindow, plan: windowPlan })
// 颗粒在平坦中灰块上量：标准差应上升（PNG 无损，避免编码器抹掉颗粒）
const flatPatchStd = async (filePath) => {
  const buf = await new Promise((resolve, reject) => {
    const child = execFile('ffmpeg', ['-v', 'error', '-i', filePath, '-vf', 'crop=120:80:200:230,format=gray', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
    child.stdin.end()
  })
  const values = [...buf]
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length
  return Math.sqrt(values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length)
}
const flatWindow = path.join(tmp, 'window-flat.png')
await run(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=640x360', '-frames:v', '1', '-y', flatWindow])
const flatPlan = { halation: { strength: 0.05, radius: 4, tint: [1, 1, 1], threshold: 0.95 }, glow: { strength: 0.02, radius: 8 }, grain: { amount: 22 } }
const flatOut = path.join(tmp, 'window-flat-out.png')
await renderTexturePass({ input: flatWindow, output: flatOut, plan: flatPlan, width: 640 })
const stdBefore = await flatPatchStd(flatWindow)
const stdAfter = await flatPatchStd(flatOut)
console.log('grain: 平坦区标准差', stdBefore.toFixed(3), '→', stdAfter.toFixed(3))
assert(stdAfter > stdBefore + 0.5, `颗粒应让平坦区噪声增加，实际 ${stdBefore.toFixed(2)} → ${stdAfter.toFixed(2)}`)

if (failures > 0) { console.error(`FAIL texture.test.mjs — ${failures} 项断言失败`); process.exitCode = 1 }
else console.log('PASS texture.test.mjs — 点状/柔光分类正确、halation 扩散、glow 半径、颗粒可测')
