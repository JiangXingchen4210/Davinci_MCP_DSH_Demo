import { normalizeSubjectBox, isDerivedAlphaName, overlapsRange, pixFmtHasAlpha } from './video_alpha.mjs'
let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
const box = normalizeSubjectBox({ x: 0.2, y: 0.1, w: 0.5, h: 0.7 }, 1920, 1080)
assert(box && box.x === 384 && Math.abs(box.y - 108) < 1e-9, '归一化框应换算到像素')
const pixel = normalizeSubjectBox({ x: 100, y: 50, w: 300, h: 200 }, 1920, 1080)
assert(pixel && pixel.x === 100 && pixel.w === 300, '像素框不应再次缩放')
const clamped = normalizeSubjectBox({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, 1920, 1080)
assert(clamped && clamped.x + clamped.w <= 1920 && clamped.y + clamped.h <= 1080, '框必须落在画幅内')
assert(normalizeSubjectBox({ x: 0, y: 0, w: 0, h: 10 }, 1920, 1080) === null, '零宽框应拒绝')
assert(isDerivedAlphaName('alpha.mov') && isDerivedAlphaName('alpha-normalized.mov'), '识别插件 alpha 片段')
assert(isDerivedAlphaName('upload-20261121-154025.mov'), '识别插件上传片段')
assert(!isDerivedAlphaName('my-alpha.mov') && !isDerivedAlphaName('alpha.mov.bak'), '不能误伤用户片段')
assert(overlapsRange({ start: 86400, end: 86448 }, 86400, 86424), '同起点应重叠')
assert(!overlapsRange({ start: 86400, end: 86448 }, 86448, 86472), '紧邻不应重叠')
assert(pixFmtHasAlpha('yuva444p12le') && pixFmtHasAlpha('rgba64be') && pixFmtHasAlpha('bgra'), '真实 alpha pix_fmt 应识别')
assert(!pixFmtHasAlpha('gray16le') && !pixFmtHasAlpha('yuv420p') && !pixFmtHasAlpha('gbrp16le'), 'gray/yuv 不带 alpha 不能误判')
if (failures) { console.error(`FAIL video_alpha.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS video_alpha.test.mjs — 框归一化/片段命名/重叠')
