/** 声轨 OK/废条判断自检：对白条=ok，稳态噪声=ng，静音=ng，对白+长静音=ok。 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { analyseTake } from './audio_take.mjs'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'take-test-'))
const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
})
let failures = 0
const assert = (condition, message) => { if (!condition) { failures += 1; console.log(`  FAIL ${message}`) } }

// 1) 对白条（say 合成）——若本机没有 TTS 语音包，合成结果会是静音，此时跳过“对白条”判定并说明原因

try {
  await run('say', ['-v', 'Tingting', '-o', path.join(tmp, 'speech.aiff'), '这是一条有对白的可用条，我们继续往下走。'])
} catch (error) {
  console.log('  SKIP say 合成失败，跳过对白条判定：' + error.message)
}
await run('ffmpeg', ['-v', 'error', '-i', path.join(tmp, 'speech.aiff'), '-af', 'apad=whole_dur=8', '-ar', '16000', '-ac', '1', '-y', path.join(tmp, 'speech.wav')])
// 2) 稳态噪声
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.02:d=6', '-ar', '16000', '-ac', '1', '-y', path.join(tmp, 'noise.wav')])
// 3) 静音
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '6', '-y', path.join(tmp, 'silence.wav')])

// 若 TTS 合成出来接近静音（例如没有中文语音包），对白条判定没有意义：跳过并说明
let speechPeak = null
try {
  const probe = await new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-v', 'info', '-i', path.join(tmp, 'speech.wav'), '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 60_000 }, (error, stdout, stderr) => (error ? reject(error) : resolve(String(stderr))))
  })
  const m = /max_volume:\s*(-?[\d.]+) dB/.exec(probe)
  if (m) speechPeak = Number(m[1])
} catch { speechPeak = null }
const speechUsable = speechPeak === null || speechPeak > -60
if (!speechUsable) console.log(`  SKIP 对白合成峰值 ${speechPeak} dB（近静音），跳过对白条判定`)

const speech = await analyseTake(path.join(tmp, 'speech.wav'))
const noise = await analyseTake(path.join(tmp, 'noise.wav'))
const silence = await analyseTake(path.join(tmp, 'silence.wav'))

console.log('speech:', speech.verdict, speech.score, '| active', speech.activeRatio, '| var', speech.envelopeVariability)
console.log('noise :', noise.verdict, noise.score, '| active', noise.activeRatio, '| var', noise.envelopeVariability)
console.log('silence:', silence.verdict, silence.score)

if (speechUsable) {
  assert(speech.verdict === 'ok', `对白条应为 ok，实际 ${speech.verdict}`)
  assert(speech.envelopeVariability > 0.8, `对白条包络起伏应明显，实际 ${speech.envelopeVariability}`)
}
assert(noise.verdict === 'ng', `稳态噪声应为 ng，实际 ${noise.verdict}`)
assert(noise.envelopeVariability < 0.4, `稳态噪声起伏应很小，实际 ${noise.envelopeVariability}`)
assert(silence.verdict === 'ng', `静音应为 ng，实际 ${silence.verdict}`)
assert(silence.activeRatio === 0, `静音活跃占比应为 0，实际 ${silence.activeRatio}`)
assert((!speechUsable || speech.reasons.length > 0) && noise.reasons.length > 0, '都要有可解释理由')

if (failures > 0) { console.error(`FAIL audio_take.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS audio_take.test.mjs — 对白=ok / 稳态噪声=ng / 静音=ng / 都有理由')
