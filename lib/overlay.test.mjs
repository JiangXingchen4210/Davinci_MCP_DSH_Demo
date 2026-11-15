#!/usr/bin/env node
// overlay.test.mjs — 贴图「旋转 / 透视跟随」测试（无测试框架，node lib/overlay.test.mjs 直接跑）
//
// 覆盖 B2：
//   1) 编译路径：vision.swift 源文件更新（mtime 变新）→ ensureBinary() 必须重编，
//      打印编译耗时；重编后 mtime 还原 → 再调用走缓存（compiled=false）。
//   2) detect-rect：合成「白底 + 深色矩形」图，VNDetectRectanglesRequest 输出的
//      角点必须是像素坐标、左上原点、顺时针 左上→右上→右下→左下，且落在真值附近。
//   3) quadsFromRects：把检测图坐标换算到目标画布分辨率。
//   4) homographyFromQuad：正方形 / 梯形 / 旋转 15° 三种目标四边形，用矩阵把源图
//      角点乘回去，落点误差 < 3px（DLT 8 参数解的正确性）。
//   5) composeOverlayMovieHomography：3 帧 ProRes 4444 输出；解码后断言目标四边形内
//      alpha>0、四边形外 alpha=0；ffprobe 确认 prores / 4444 / 带 alpha 的 pixel format。
//
// 失败以 1 退出；failures 用 ASSERT FAILED 明示。Vision 不可用时打印 SKIP 而不是伪装 PASS。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  detectRectangles,
  ensureBinary,
  getCompileInfo,
  BINARY_PATH,
  SWIFT_SOURCE,
} from './cutout.mjs'
import {
  quadsFromRects,
  homographyFromQuad,
  applyHomography,
  composeOverlayMovieHomography,
} from './overlay.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'vision')

const RECT_W = 640, RECT_H = 480
// 白底 + 深色矩形：drawbox x=120,y=90,w=360,h=240 → 角点真值（像素、左上原点）
const BOX = { x: 120, y: 90, w: 360, h: 240 }
const EXPECTED_RECT_CORNERS = [
  { x: BOX.x, y: BOX.y },
  { x: BOX.x + BOX.w, y: BOX.y },
  { x: BOX.x + BOX.w, y: BOX.y + BOX.h },
  { x: BOX.x, y: BOX.y + BOX.h },
]

const OVERLAY_W = 400, OVERLAY_H = 300       // 贴图（棋盘）尺寸
const CANVAS_W = 800, CANVAS_H = 600         // 输出画布
const FPS = 24

let checks = 0
const failures = []

function check(condition, message) {
  checks += 1
  if (!condition) {
    failures.push(message)
    throw new Error(`ASSERT FAILED: ${message}`)
  }
}

function report(label, detail) {
  console.log(`${label} ${detail}`)
}

function log(...args) {
  console.log(...args)
}

function runCapture(command, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    const outChunks = []
    const errChunks = []
    let settled = false
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({
        code: null,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString() + `\n[timeout] ${command} exceeded ${timeoutMs}ms`,
      })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => outChunks.push(chunk))
    child.stderr.on('data', (chunk) => errChunks.push(chunk))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout: Buffer.concat(outChunks), stderr: String(err) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(outChunks), stderr: Buffer.concat(errChunks).toString() })
    })
  })
}

async function resolveTool(name) {
  const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  const probe = await runCapture(name, ['-version'], { timeoutMs: 10_000 })
  return probe.code === 0 ? name : null
}

/** 生成 detect-rect 用的图：白底 + 深色矩形（ffmpeg 现场合成）。 */
async function generateRectFixture(ffmpeg) {
  await fsp.mkdir(FIXTURES_DIR, { recursive: true })
  const out = path.join(FIXTURES_DIR, 'vision-rect.png')
  const result = await runCapture(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi',
    '-i', `color=c=white:s=${RECT_W}x${RECT_H}:d=1`,
    '-vf', `drawbox=x=${BOX.x}:y=${BOX.y}:w=${BOX.w}:h=${BOX.h}:color=0x203040@1:t=fill,format=rgb24`,
    '-frames:v', '1', out,
  ])
  if (result.code !== 0) throw new Error(`ffmpeg 生成 detect-rect 素材失败: ${result.stderr}`)
  return out
}

/** 生成贴图：400×300 棋盘（RGB 有明显块状纹理，便于肉眼/后续检查），alpha 全不透明。 */
async function generateChessboard(ffmpeg) {
  await fsp.mkdir(FIXTURES_DIR, { recursive: true })
  const out = path.join(FIXTURES_DIR, 'overlay-chessboard.png')
  const cell = 50
  const isDark = `mod(floor(X/${cell})+floor(Y/${cell})\\,2)`
  const filter = `geq=r='if(${isDark},20,240)':g='if(${isDark},20,240)':b='if(${isDark},80,200)',format=rgba`
  const result = await runCapture(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi',
    '-i', `color=c=white:s=${OVERLAY_W}x${OVERLAY_H}:d=1`,
    '-vf', filter,
    '-frames:v', '1', out,
  ])
  if (result.code !== 0) throw new Error(`ffmpeg 生成棋盘贴图失败: ${result.stderr}`)
  return out
}

/** 旋转正方形四角（绕中心），角度用弧度。返回顺时针 左上→右上→右下→左下。 */
function rotatedSquareQuad(cx, cy, half, degrees) {
  const theta = (degrees * Math.PI) / 180
  const base = [
    { x: cx - half, y: cy - half },
    { x: cx + half, y: cy - half },
    { x: cx + half, y: cy + half },
    { x: cx - half, y: cy + half },
  ]
  return base.map(({ x, y }) => {
    const dx = x - cx
    const dy = y - cy
    return {
      x: cx + dx * Math.cos(theta) - dy * Math.sin(theta),
      y: cy + dx * Math.sin(theta) + dy * Math.cos(theta),
    }
  })
}

/** 把 MOV 解成逐帧 RGBA8（画布尺寸已知）。 */
async function decodeMovFrames(ffmpeg, moviePath, width, height, frameCount) {
  const result = await runCapture(ffmpeg, [
    '-v', 'error', '-i', moviePath,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
  ])
  if (result.code !== 0) throw new Error(`解码 MOV 失败: ${result.stderr}`)
  const expected = width * height * 4 * frameCount
  check(result.stdout.length === expected, `MOV 解码字节数 ${result.stdout.length} == ${expected}`)
  return result.stdout
}

async function main() {
  log('== overlay.test.mjs — 贴图旋转/透视跟随（homography）测试 ==')

  if (process.platform !== 'darwin') {
    console.log(`SKIP 非 macOS 平台（process.platform=${process.platform}），Vision 不可用`)
    return
  }
  const ffmpeg = await resolveTool('ffmpeg')
  if (!ffmpeg) {
    console.log('SKIP 未找到 ffmpeg（/opt/homebrew/bin、/usr/local/bin、PATH 均无）')
    return
  }
  const ffprobe = await resolveTool('ffprobe')
  log(`ffmpeg: ${ffmpeg}`)

  // ---------- 1) 编译路径：首次可用 + 源文件更新 → 重编（打印耗时） ----------
  const initial = await ensureBinary()
  if (initial.compiled) {
    report('INFO compile', `vision.swift 首次编译 ${initial.ms}ms`)
  } else {
    report('INFO compile', 'vision 二进制已是最新（缓存命中，compiled=false）')
  }
  check(existsSync(BINARY_PATH), `编译产物应存在: ${BINARY_PATH}`)

  // 记录源文件时间戳，故意把 mtime 推后模拟「源文件更新」，走 needsRebuild 路径
  const sourceStat = await fsp.stat(SWIFT_SOURCE)
  await fsp.utimes(SWIFT_SOURCE, new Date(), new Date(Date.now() + 2000))
  const recompileStart = Date.now()
  const rebuilt = await ensureBinary()
  const recompileWall = Date.now() - recompileStart
  check(rebuilt.compiled === true, 'vision.swift mtime 变新后 ensureBinary() 必须重编（compiled=true）')
  check(rebuilt.ms > 0, `重编应报告正耗时（实际 ${rebuilt.ms}ms）`)
  check(getCompileInfo().compileMs === rebuilt.ms, 'getCompileInfo().compileMs 应记录最近一次编译耗时')
  report('PASS recompile', `源文件更新 → swiftc -O 重编 ${rebuilt.ms}ms（ensureBinary 墙钟 ${recompileWall}ms）`)
  // 还原源文件 mtime，避免后续调用每次都重编
  await fsp.utimes(SWIFT_SOURCE, sourceStat.atime, sourceStat.mtime)
  const cached = await ensureBinary()
  check(cached.compiled === false, 'mtime 还原后应命中缓存（compiled=false）')
  report('PASS cache', `重编后缓存生效（compiled=${cached.compiled}）`)

  // ---------- 2) 现场生成素材 ----------
  const rectImage = await generateRectFixture(ffmpeg)
  const chessboard = await generateChessboard(ffmpeg)
  log(`FIXTURES ok rect=${path.relative(path.join(__dirname, '..'), rectImage)} overlay=${path.relative(path.join(__dirname, '..'), chessboard)}`)

  // ---------- 3) detect-rect ----------
  const detection = await detectRectangles(rectImage)
  log(`DETECT-RECT ${JSON.stringify(detection)}`)
  check(detection.ok === true, 'detectRectangles ok=true')
  check(detection.width === RECT_W && detection.height === RECT_H, `detectRectangles 尺寸 ${detection.width}x${detection.height}`)
  check(Array.isArray(detection.rects) && detection.rects.length >= 1, `detect-rect 至少检出 1 个矩形（实际 ${detection.rects.length}）`)
  check(detection.best === detection.rects[0], 'best 应是置信度最高的 rect（= rects[0]）')
  for (const [index, rect] of detection.rects.entries()) {
    check(Array.isArray(rect.corners) && rect.corners.length === 4, `rects[${index}].corners 有 4 个角点`)
    check(Number.isFinite(rect.confidence) && rect.confidence > 0.5, `rects[${index}] confidence=${rect.confidence} 应 > 0.5`)
    check(Number.isFinite(rect.aspectRatio) && rect.aspectRatio > 0.2, `rects[${index}] aspectRatio=${rect.aspectRatio} 应 > 0.2`)
    for (const corner of rect.corners) {
      check(corner.x >= -1 && corner.x <= RECT_W + 1 && corner.y >= -1 && corner.y <= RECT_H + 1,
        `rects[${index}] 角点落在图像内（${JSON.stringify(corner)}）`)
    }
    // 顺时针：图像坐标 y 向下时，相邻边叉积为正
    for (let k = 0; k < 4; k += 1) {
      const a = rect.corners[k]
      const b = rect.corners[(k + 1) % 4]
      const c = rect.corners[(k + 2) % 4]
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
      check(cross > 0, `rects[${index}] 角点顺序应为顺时针（第 ${k} 段叉积 ${cross.toFixed(1)} > 0）`)
    }
  }
  const bestRect = detection.best
  check(bestRect.corners.length === 4, 'best.corners 有 4 个角点')
  // 大矩形：左上角离图像原点近，右下角最远（左上原点约定）
  const cornerErrors = bestRect.corners.map((corner, index) => {
    const expected = EXPECTED_RECT_CORNERS[index]
    return Math.hypot(corner.x - expected.x, corner.y - expected.y)
  })
  const maxCornerError = Math.max(...cornerErrors)
  check(maxCornerError < 15, `detect-rect 角点与真值最大误差 ${maxCornerError.toFixed(2)}px 应 < 15px`)
  check(Math.abs(bestRect.aspectRatio - BOX.w / BOX.h) < 0.2,
    `detect-rect aspectRatio=${bestRect.aspectRatio} 应 ≈ ${(BOX.w / BOX.h).toFixed(3)}`)
  const cornerLXX = bestRect.corners[0]
  check(cornerLXX.x < bestRect.corners[2].x && cornerLXX.y < bestRect.corners[2].y,
    `corners[0] 应是最左上角（${JSON.stringify(cornerLXX)}），说明 Vision 左下原点已换算成左上原点`)
  report('PASS detect-rect',
    `rects=${detection.rects.length} best.confidence=${bestRect.confidence} aspectRatio=${bestRect.aspectRatio} 角点最大误差=${maxCornerError.toFixed(2)}px`)

  // ---------- 4) quadsFromRects：检测分辨率 → 目标画布 ----------
  const doubled = quadsFromRects(detection, RECT_W * 2, RECT_H * 2)
  check(doubled.length === 4, 'quadsFromRects 返回 4 个角点')
  for (let i = 0; i < 4; i += 1) {
    const expected = { x: bestRect.corners[i].x * 2, y: bestRect.corners[i].y * 2 }
    const err = Math.hypot(doubled[i].x - expected.x, doubled[i].y - expected.y)
    check(err < 0.01, `quadsFromRects 放大 2× 角点[${i}] 误差 ${err} < 0.01px`)
  }
  const sameScale = quadsFromRects(detection, RECT_W, RECT_H)
  check(Math.abs(sameScale[0].x - bestRect.corners[0].x) < 1e-6, '同分辨率下 quadsFromRects 不缩放')
  // 取第 index 个 rect；越界 index 必须报错
  let indexRejected = false
  try {
    quadsFromRects(detection, RECT_W, RECT_H, { index: detection.rects.length })
  } catch {
    indexRejected = true
  }
  check(indexRejected, 'quadsFromRects 越界 index 应 throw')
  report('PASS quadsFromRects', `2× 放大角点误差 < 0.01px；同分辨率恒等；越界 index 被拒绝`)

  // ---------- 5) homographyFromQuad：三种目标四边形，角点落点误差 < 3px ----------
  const srcQuad = [
    { x: 0, y: 0 },
    { x: OVERLAY_W, y: 0 },
    { x: OVERLAY_W, y: OVERLAY_H },
    { x: 0, y: OVERLAY_H },
  ]
  const targetQuads = [
    {
      name: 'square',
      quad: [
        { x: 200, y: 150 }, { x: 500, y: 150 }, { x: 500, y: 450 }, { x: 200, y: 450 },
      ],
    },
    {
      name: 'trapezoid',
      quad: [
        { x: 250, y: 400 }, { x: 550, y: 400 }, { x: 650, y: 200 }, { x: 150, y: 200 },
      ],
    },
    {
      name: 'rotated15',
      quad: rotatedSquareQuad(400, 300, 150, 15),
    },
  ]
  let trapezoidError = 0
  for (const { name, quad } of targetQuads) {
    const matrix = homographyFromQuad(srcQuad, quad)
    check(Array.isArray(matrix) && matrix.length === 3 && matrix.every((row) => row.length === 3),
      `${name}: homographyFromQuad 返回 3×3 矩阵`)
    check(Math.abs(matrix[2][2] - 1) < 1e-9, `${name}: h33 归一化为 1`)
    const errors = srcQuad.map((point, index) => {
      const mapped = applyHomography(matrix, point)
      return Math.hypot(mapped.x - quad[index].x, mapped.y - quad[index].y)
    })
    const maxError = Math.max(...errors)
    if (name === 'trapezoid') trapezoidError = maxError
    check(maxError < 3, `${name}: 角点落点最大误差 ${maxError.toFixed(4)}px 应 < 3px（σ=${errors.map((e) => e.toFixed(3)).join(',')}）`)
    report('PASS homography', `${name}: 4 角点落点误差 ${errors.map((e) => e.toFixed(3)).join('/')} px（<3px）`)
  }
  // 退化四边形（4 点共线）必须拒绝，而不是给出垃圾矩阵
  let degenerateRejected = false
  try {
    homographyFromQuad(srcQuad, [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 },
    ])
  } catch {
    degenerateRejected = true
  }
  check(degenerateRejected, '共线四边形应被 homographyFromQuad 拒绝（退化）')

  // ---------- 6) composeOverlayMovieHomography：3 帧 ProRes 4444 ----------
  const moviePath = path.join(FIXTURES_DIR, 'out-overlay-homography.mov')
  const composed = await composeOverlayMovieHomography({
    overlayPath: chessboard,
    quads: targetQuads.map(({ quad }) => ({ corners: quad })),
    width: CANVAS_W,
    height: CANVAS_H,
    fps: FPS,
    outPath: moviePath,
  })
  check(composed.frameCount === 3, `合成 3 帧（实际 ${composed.frameCount}）`)
  check(composed.outPath === moviePath, 'composeOverlayMovieHomography 返回 outPath')
  check(existsSync(moviePath), '输出 MOV 存在')

  if (ffprobe) {
    const probe = await runCapture(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,profile,width,height,pix_fmt,nb_frames',
      '-of', 'json', moviePath,
    ])
    check(probe.code === 0, `ffprobe 读取 MOV 失败: ${probe.stderr}`)
    const stream = JSON.parse(probe.stdout.toString())?.streams?.[0] ?? {}
    check(stream.codec_name === 'prores', `MOV 编码应为 prores（实际 ${stream.codec_name}）`)
    check(String(stream.profile).toLowerCase().includes('4444'), `MOV profile 应为 4444（实际 ${stream.profile}）`)
    check(stream.width === CANVAS_W && stream.height === CANVAS_H, `MOV 尺寸 ${stream.width}x${stream.height}`)
    check(stream.nb_frames === '3', `MOV 帧数应为 3（实际 ${stream.nb_frames}）`)
    // 期望 10-bit alpha；本机 ffmpeg 7.1.1 的 prores_ks 对 4444 固定写 12-bit（参数与
    // composeOverlayMovie 完全一致也是 12le），因此两者都接受，但打印实际值。
    check(/^yuva444p(10|12)le$/.test(String(stream.pix_fmt)),
      `MOV 应带 alpha（期望 yuva444p10le / 本机可能 yuva444p12le，实际 ${stream.pix_fmt}）`)
    report('PASS ffprobe', `codec=${stream.codec_name} profile=${stream.profile} ${stream.width}x${stream.height} ${stream.nb_frames}f pix_fmt=${stream.pix_fmt}`)
  }

  // ---------- 7) 解码逐帧像素：四边形内 alpha>0、四边形外 alpha=0 ----------
  const decoded = await decodeMovFrames(ffmpeg, moviePath, CANVAS_W, CANVAS_H, 3)
  const alpha = (frameIndex, x, y) => decoded[frameIndex * CANVAS_W * CANVAS_H * 4 + (y * CANVAS_W + x) * 4 + 3]
  const outsidePoints = [
    { x: 2, y: 2 }, { x: CANVAS_W - 3, y: 2 },
    { x: 2, y: CANVAS_H - 3 }, { x: CANVAS_W - 3, y: CANVAS_H - 3 },
    { x: 50, y: 300 },
  ]
  for (const [frameIndex, { name, quad }] of targetQuads.entries()) {
    const cx = quad.reduce((sum, point) => sum + point.x, 0) / 4
    const cy = quad.reduce((sum, point) => sum + point.y, 0) / 4
    const centerAlpha = alpha(frameIndex, Math.round(cx), Math.round(cy))
    check(centerAlpha > 200, `${name}: 四边形中心 alpha=${centerAlpha} 应 > 200（贴图不透明）`)
    // 四边形是凸的：中心与各顶点的 0.65/0.35 内分点一定在内部
    for (const corner of quad) {
      const px = Math.round(cx * 0.65 + corner.x * 0.35)
      const py = Math.round(cy * 0.65 + corner.y * 0.35)
      const insideAlpha = alpha(frameIndex, px, py)
      check(insideAlpha > 100, `${name}: 四边形内点 (${px},${py}) alpha=${insideAlpha} 应 > 100`)
    }
    for (const point of outsidePoints) {
      const outsideAlpha = alpha(frameIndex, point.x, point.y)
      check(outsideAlpha === 0, `${name}: 四边形外点 (${point.x},${point.y}) alpha=${outsideAlpha} 应为 0`)
    }
    report('PASS alpha', `${name}: 中心 alpha=${centerAlpha}；内点 alpha>100；外点 alpha=0`)
  }

  // ---------- 汇总 ----------
  check(failures.length === 0, `不应有失败断言（${failures.join('; ')}）`)
  log(`\nPASS overlay.test.mjs — ${checks} 项断言全部通过`)
  log(`   重编 ${rebuilt.ms}ms；detect-rect ${detection.rects.length} 个矩形（角点最大误差 ${maxCornerError.toFixed(2)}px）；` +
    `homography 梯形角点误差 ${trapezoidError.toFixed(4)}px；3 帧 ProRes 4444 四边形内外 alpha 断言通过`)
}

main().catch((err) => {
  console.error('\nFAIL overlay.test.mjs')
  console.error(err?.stack || String(err))
  process.exitCode = 1
})
