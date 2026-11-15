/** 人脸检测/跟踪自检：检测到人脸、跨帧轨迹连贯、窗口建议随移动变化。 */
import { detectFaces, trackFaces, planFaceGrade } from './face.mjs'
import { visionProbe } from './vision_probe.mjs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(LIB_DIR, 'fixtures', 'face', 'day-closeup.png')
let failures = 0
const assert = (condition, message) => { if (!condition) { failures += 1; console.log(`  FAIL ${message}`) } }

const vision = await visionProbe()
if (!vision.ok) {
  console.log(`SKIP Vision 不可用（${vision.error}）；人脸测试跳过，不伪装 PASS`)
  process.exit(0)
}
const detected = await detectFaces(fixture)
console.log('detect:', detected.faceCount, 'faces,', detected.bodyCount, 'bodies | first:', JSON.stringify(detected.faces[0] ?? null))
assert(detected.ok, 'detect-face 应成功')
assert(detected.faceCount >= 1, `应至少检出 1 张人脸，实际 ${detected.faceCount}`)
const face = detected.faces[0]
assert(face.w > 10 && face.h > 10, '人脸框应有合理尺寸')
assert(face.x >= 0 && face.y >= 0 && face.x + face.w <= detected.width + 1, '人脸框应在画面内')

// 同一张图重复 4 次 → 应合成一条稳定轨迹（模拟静止镜头）
const frames = Array.from({ length: 4 }, (_, index) => ({ t: index * 0.5, path: fixture }))
const track = await trackFaces(frames)
console.log('track: tracks', track.trackCount, '| primary frames', track.primary?.frameCount, '| drift', track.primary?.driftPx, 'px')
assert(track.trackCount >= 1, '应至少有一条轨迹')
assert(track.primary.frameCount === 4, `静止镜头应 4 帧都在同一条轨迹，实际 ${track.primary?.frameCount}`)
assert(track.primary.driftPx < 1, `静止镜头漂移应为 0，实际 ${track.primary.driftPx}`)
const plan = planFaceGrade(track.primary)
assert(plan.ok, 'planFaceGrade 应成功')
assert(plan.mode === 'static-window', `静止镜头应是静态窗口，实际 ${plan.mode}`)
assert(plan.windowRect.w > track.primary.medianBox.w, '窗口应比人脸框更大（含羽化边）')
assert(plan.keyframeTimes.length === 4, '应输出 4 个关键帧点')
assert(plan.notes.length >= 1, '应给出理由')

if (failures > 0) { console.error(`FAIL face.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log(`PASS face.test.mjs — 检出 ${detected.faceCount} 张脸、静止镜头 4 帧归一轨迹、漂移 ${track.primary.driftPx}px、窗口建议合理`)
