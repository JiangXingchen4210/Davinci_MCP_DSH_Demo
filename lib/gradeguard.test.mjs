/**
 * 调色护栏自检：用合成帧证明「激进调色会被拒绝、收敛调色会通过」。
 * 这一批断言直接对应实测事故：满强度赛博朋克把 blackPct 从 0.6% 压到 5.7%（黑色断层）、色相偏移 89°（整屏发蓝）。
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { measureFrame, evaluate, pickStrength, measureRgb } from './gradeguard.mjs'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gradeguard-test-'))
let failures = 0
const assert = (condition, message) => {
  if (!condition) {
    failures += 1
    console.log(`  FAIL ${message}`)
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim().slice(-300) || 'ffmpeg 失败'))
      else resolve()
    })
  })
}

// 造一张「夜戏」测试图：暗部占一半、有暖色高光
const base = path.join(tmp, 'night.png')
await runFfmpeg([
  '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x101820:s=320x180',
  '-vf', [
    'drawbox=x=0:y=0:w=320:h=90:color=0x0a0c10@1:t=fill',
    'drawbox=x=240:y=30:w=50:h=50:color=0xffb066@1:t=fill',
    'drawbox=x=20:y=120:w=80:h=40:color=0x2a3440@1:t=fill',
  ].join(','),
  '-frames:v', '1', '-y', base,
])
const before = await measureFrame(base)
assert(before.blackPct < 60, '参考帧应该有可见暗部但不是全黑')

// 1) 模拟「旧版激进调色」：硬压黑 + 大推蓝（直接改像素，不依赖 LUT 文件）
const { execFile: execFileSync } = await import('node:child_process')
const decoded = await new Promise((resolve, reject) => {
  const child = execFileSync('ffmpeg', [
    '-v', 'error', '-i', base, '-frames:v', '1', '-vf', 'scale=320:-2,format=rgb24', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  child.stdin?.end()
})
const aggressive = Buffer.from(decoded)
for (let i = 0; i < aggressive.length; i += 3) {
  // 复刻事故现场：整体压暗（黑位压死）+ 暗部塞蓝
  aggressive[i] = Math.round(aggressive[i] * 0.25)
  aggressive[i + 1] = Math.round(aggressive[i + 1] * 0.3)
  aggressive[i + 2] = Math.min(255, Math.round(aggressive[i + 2] * 0.35 + 10))
}
const aggressivePath = path.join(tmp, 'aggressive.png')
const child = execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${before.width}x${before.height}`, '-i', '-', '-frames:v', '1', '-y', aggressivePath])
child.stdin.end(aggressive)
await new Promise((resolve, reject) => child.on('error', reject).on('close', (code) => (code === 0 ? resolve() : reject(new Error('编码失败')))))
const afterAggressive = await measureFrame(aggressivePath)
const evalAggressive = evaluate(before, afterAggressive)
assert(!evalAggressive.ok, '激进调色必须被判为不通过')
assert(evalAggressive.violations.some((violation) => violation.id === 'black-clip' || violation.id === 'near-black-clip'), '激进调色应命中黑色断层类违规')
assert(evalAggressive.recommendedStrength < 0.6, `激进调色应给出更低的建议强度，实际 ${evalAggressive.recommendedStrength}`)
const picked = pickStrength(0.35, evalAggressive)
assert(picked.strength <= 0.35, '选择强度不应高于请求值')

// 2) 温和调色（±5% 亮度、轻微偏色）应当通过
const mild = Buffer.from(decoded)
for (let i = 0; i < mild.length; i += 3) {
  mild[i] = Math.min(255, Math.round(mild[i] * 1.02 + 2))
  mild[i + 1] = Math.min(255, Math.round(mild[i + 1] * 1.01 + 1))
  mild[i + 2] = Math.min(255, Math.round(mild[i + 2] * 1.03 + 3))
}
const mildPath = path.join(tmp, 'mild.png')
const child2 = execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${before.width}x${before.height}`, '-i', '-', '-frames:v', '1', '-y', mildPath])
child2.stdin.end(mild)
await new Promise((resolve, reject) => child2.on('error', reject).on('close', (code) => (code === 0 ? resolve() : reject(new Error('编码失败')))))
const afterMild = await measureFrame(mildPath)
const evalMild = evaluate(before, afterMild)
assert(evalMild.ok, `温和调色应当通过，实际违规：${evalMild.violations.map((violation) => violation.id).join(',')}`)
assert(pickStrength(0.35, evalMild).strength === 0.35, '通过时不应降强度')

// 3) measureRgb 的直接断言（黑色占比 / 暗部蓝偏）
const pureBlack = Buffer.alloc(320 * 180 * 3, 0)
const blackStats = measureRgb(pureBlack, 320, 180)
assert(blackStats.blackPct === 100, `全黑图 blackPct 应为 100，实际 ${blackStats.blackPct}`)
// 低饱和暗蓝（黑平衡检查的标准样本）；纯色蓝属于「高饱和色块」，按设计不计入暗部
const darkBlue = Buffer.alloc(320 * 180 * 3, 0)
for (let i = 0; i < darkBlue.length; i += 3) {
  darkBlue[i] = 14
  darkBlue[i + 1] = 17
  darkBlue[i + 2] = 30
}
const blueStats = measureRgb(darkBlue, 320, 180)
assert(blueStats.shadowBlueCast > 8, `低饱和暗蓝的 shadowBlueCast 应为正，实际 ${blueStats.shadowBlueCast}`)
assert(blueStats.shadowPct > 90, `暗部占比应统计出来，实际 ${blueStats.shadowPct}`)

if (failures > 0) {
  console.error(`FAIL gradeguard.test.mjs — ${failures} 项断言失败`)
  process.exitCode = 1
} else {
  console.log(
    `PASS gradeguard.test.mjs — 激进调色被拒绝（violations=${evalAggressive.violations.map((v) => v.id).join('/')}，建议强度 ${evalAggressive.recommendedStrength}）、` +
      `温和调色通过、全黑/纯蓝统计正确`,
  )
}
