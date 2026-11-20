import { buildVisionUserPrompt, extractJsonArray, parseVisionLabels, judgeVisionLabel, selectShotsByVision } from './vision_semantic.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
const arrayText = `好的，结果如下：
[
 {"index":1,"description":"校园台阶和银杏","subjects":["台阶","树"],"setting":"outdoor-campus","themeFit":0.92,"usable":true,"confidence":0.9},
 {"index":2,"description":"黑板前老师","subjects":["老师","黑板"],"setting":"indoor-studio","themeFit":0.1,"usable":true,"confidence":0.95},
 {"index":3,"description":"失焦叶片","subjects":["叶子"],"setting":"nature","themeFit":0.7,"usable":false,"confidence":0.8}
]
后略。`
const arr = extractJsonArray(arrayText)
assert(Array.isArray(arr) && arr.length === 3, '应从说明文字中提取 JSON 数组')
const parsed = parseVisionLabels(arrayText, 3)
assert(parsed.ok && parsed.labels.length === 3, '应解析 3 个 label')
assert(parsed.labels[1].setting === 'indoor-studio', 'setting 应保留')
const scenes = [{ index: 1, clipName: 'A' }, { index: 2, clipName: 'teacher' }, { index: 3, clipName: 'soft' }]
const selected = selectShotsByVision(scenes, parsed.labels, { theme: 'auto' })
assert(selected.kept.length === 1 && selected.kept[0].clipName === 'A', 'auto 应只保留校园镜头')
assert(selected.excluded.length === 2, '应排除棚拍和不可用镜头')
assert(selected.excluded[0].reason.includes('studio'), '排除原因应可复核')
const studio = selectShotsByVision(scenes, parsed.labels, { theme: 'studio' })
assert(studio.kept.some((scene) => scene.clipName === 'teacher'), 'studio 主题应保留教室镜头')
assert(judgeVisionLabel({ usable: false, setting: 'nature', themeFit: 0.9, confidence: 0.9 }, 'auto').keep === false, 'usable=false 必须排除')
assert(judgeVisionLabel({ usable: true, setting: 'outdoor-campus', themeFit: 0.5, confidence: 0.8 }, 'auto').keep === true, '有效户外镜头应保留')
assert(parseVisionLabels('not json', 3).ok === false, '非 JSON 应报错')
assert(buildVisionUserPrompt({ theme: 'campus-autumn', count: 3 }).includes('3 张图'), '提示词应包含图片数')

if (failures) { console.error(`FAIL vision_semantic.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS vision_semantic.test.mjs — 视觉提示词/JSON 提取/标签合并/主题判定')
