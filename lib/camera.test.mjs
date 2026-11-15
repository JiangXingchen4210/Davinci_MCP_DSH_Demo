/** 相机/传输识别自检：8 种典型输入必须有正确结论（尤其“非 LOG 不要套 LUT”）。 */

import { detectCamera } from './camera.mjs'

const results = []
let failures = 0

function check(name, input, expect) {
  const result = detectCamera(input)
  const problems = []
  for (const [key, value] of Object.entries(expect)) {
    const actual = result[key]
    if (value === 'not-null') {
      if (actual === null || actual === undefined) problems.push(`${key} 应非空，实际 ${actual}`)
    } else if (JSON.stringify(actual) !== JSON.stringify(value)) {
      problems.push(`${key} 期望 ${JSON.stringify(value)} 实际 ${JSON.stringify(actual)}`)
    }
  }
  if (problems.length > 0) {
    failures += 1
    console.log(`  FAIL ${name}: ${problems.join('; ')}`)
  } else {
    results.push(name)
    console.log(`  pass ${name} → camera=${result.camera} transfer=${result.transfer} isLog=${result.isLog} needsLut=${result.needsLut} conf=${result.confidence}`)
  }
}

// 统计夹具：LOG（黑位抬起、动态范围小、饱和低）
const logStats = {
  layers: { global: { lumaPct: { p5: 0.16, p95: 0.52 }, dynamicRange: 0.36, meanSat: 0.22 } },
}
// 统计夹具：已 709（黑位低、动态范围大、饱和正常）
const gradedStats = {
  layers: { global: { lumaPct: { p5: 0.02, p95: 0.94 }, dynamicRange: 0.92, meanSat: 0.46 } },
}
const flatStats = { layers: { global: { lumaPct: { p5: 0.3, p95: 0.6 }, dynamicRange: 0.3, meanSat: 0.3 } } }

check(
  'Sony A7S III S-Log3（元数据 color_transfer=log100）',
  {
    ffprobe: { streams: [{ codec_name: 'hevc', color_transfer: 'log100', tags: { make: 'SONY', model: 'ILCE-7SM3' } }], format: { format_name: 'mov,mp4' } },
    stats: logStats,
    filePath: '/media/A7SIII_C001.mp4',
  },
  { camera: 'sony', isLog: true, needsLut: true },
)

check(
  'ARRI ALEXA LogC（.ari + color_transfer）',
  {
    ffprobe: { streams: [{ codec_name: 'prores', color_transfer: 'log316', tags: { make: 'ARRI', model: 'ALEXA Mini' } }], format: { format_name: 'mov' } },
    stats: logStats,
    filePath: '/media/A001C001_001.ari',
  },
  { camera: 'arri', isLog: true, needsLut: true },
)

check(
  'Blackmagic RAW（.braw 扩展名，ffmpeg 不可探）',
  { ffprobe: null, clipProperties: { 'Camera Type': 'Blackmagic Pocket Cinema Camera 6K' }, stats: null, filePath: '/media/A001_0001.braw' },
  { camera: 'blackmagic', isLog: true, needsLut: false, lutKey: undefined },
)

check('RED R3D', { ffprobe: null, stats: null, filePath: '/media/A001_C002.r3d' }, { camera: 'red', needsLut: false })

check(
  'iPhone HEVC 已是 709（高对比统计）',
  {
    ffprobe: { streams: [{ codec_name: 'hevc', color_transfer: 'bt709', tags: { make: 'Apple', model: 'iPhone 15 Pro' } }], format: { format_name: 'mov' } },
    stats: gradedStats,
    filePath: '/media/IMG_1024.mov',
  },
  { camera: 'apple', isLog: false, needsLut: false },
)

check(
  '已调好的 Rec.709 高对比素材（无元数据）→ 绝不能套 LUT',
  { ffprobe: { streams: [{ codec_name: 'h264' }] }, stats: gradedStats, filePath: '/media/graded.mp4' },
  { isLog: false, needsLut: false },
)

check(
  '模糊未知（画面平淡、无元数据）→ 不猜、不套',
  { ffprobe: { streams: [{ codec_name: 'h264' }] }, stats: flatStats, filePath: '/media/unknown.mp4' },
  { needsLut: false },
)

check(
  '矛盾输入：元数据说 LOG，画面却是高对比 → 以画面为准但降置信度',
  { ffprobe: { streams: [{ codec_name: 'h264', color_transfer: 'log100' }] }, stats: gradedStats, filePath: '/media/x.mp4' },
  { isLog: true, confidence: 0.9 },
)

check(
  'Panasonic S5 V-Log',
  {
    ffprobe: { streams: [{ codec_name: 'h264', color_transfer: 'unknown', tags: { make: 'Panasonic', model: 'DC-S5M2' } }], format: { format_name: 'mov' } },
    stats: logStats,
    filePath: '/media/P1000123.mov',
  },
  { camera: 'panasonic', needsLut: true },
)

if (failures > 0) {
  console.error(`FAIL camera.test.mjs — ${failures} 项不符合预期`)
  process.exitCode = 1
} else {
  console.log(`PASS camera.test.mjs — ${results.length} 种输入全部符合预期（含「已 709 不套 LUT」与未知不猜）`)
}
