/**
 * 贴图跟随合成：把一张带 alpha 的 PNG 按「逐帧矩形」缩放贴到画面上，
 * 输出一条带 alpha 的 ProRes 4444 片段（可导入 Resolve 叠在 V2 上跟随遮罩）。
 *
 * 只做 2D 平移 + 等比缩放（矩形中心 = 对齐点，宽比 = 缩放），不做旋转——
 * macOS Vision 的矩形跟踪给的就是这个信息，旋转属于下一阶段。
 *
 * 纯 Node（无依赖），ffmpeg 只负责「PNG → raw RGBA 解码」和「raw RGBA → ProRes 4444 编码」，
 * 逐帧合成在 JS 里做（bilinear），因此帧数与分辨率都可控。
 */

import { spawn } from 'node:child_process'

/** 用 ffmpeg 把图片解成 {width,height,data(RGBA)}。 */
export function decodeImage(filePath, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', filePath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
    const chunks = []
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`解码 ${filePath} 超时`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`解码 ${filePath} 失败：${stderr.trim().slice(-400)}`))
        return
      }
      const data = Buffer.concat(chunks)
      if (data.length === 0) {
        reject(new Error(`${filePath} 解码为空`))
        return
      }
      // 尺寸由调用方通过 probe 给出；这里用 ffprobe 再取一次会多一次进程，交给调用方传 size
      resolve({ data })
    })
  })
}

/** 用 ffprobe 取图片尺寸。 */
export function probeImageSize(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      filePath,
    ])
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe 失败：${filePath}`))
        return
      }
      try {
        const parsed = JSON.parse(out)
        const stream = parsed?.streams?.[0]
        resolve({ width: Number(stream?.width ?? 0), height: Number(stream?.height ?? 0) })
      } catch (error) {
        reject(new Error(`ffprobe 输出无法解析：${String(error)}`))
      }
    })
  })
}

/**
 * 双线性缩放并混合到画布（premultiply 由调用方保证：PNG 是直通 alpha）。
 * @returns {void}
 */
export function blitScaled(canvas, canvasWidth, canvasHeight, source, sourceWidth, sourceHeight, dest) {
  const { x, y, w, h } = dest
  if (!(w > 0 && h > 0)) return
  const startX = Math.max(0, Math.floor(x))
  const startY = Math.max(0, Math.floor(y))
  const endX = Math.min(canvasWidth, Math.ceil(x + w))
  const endY = Math.min(canvasHeight, Math.ceil(y + h))
  for (let cy = startY; cy < endY; cy += 1) {
    // 目标像素 → 源坐标（中心对齐）
    const sy = ((cy + 0.5 - y) / h) * sourceHeight - 0.5
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(sourceHeight - 1, y0 + 1)
    const wy = Math.min(1, Math.max(0, sy - y0))
    for (let cx = startX; cx < endX; cx += 1) {
      const sx = ((cx + 0.5 - x) / w) * sourceWidth - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(sourceWidth - 1, x0 + 1)
      const wx = Math.min(1, Math.max(0, sx - x0))
      const p00 = ((y0 * sourceWidth) + x0) * 4
      const p10 = ((y0 * sourceWidth) + x1) * 4
      const p01 = ((y1 * sourceWidth) + x0) * 4
      const p11 = ((y1 * sourceWidth) + x1) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const top = source[p00 + channel] * (1 - wx) + source[p10 + channel] * wx
        const bottom = source[p01 + channel] * (1 - wx) + source[p11 + channel] * wx
        const value = top * (1 - wy) + bottom * wy
        const at = ((cy * canvasWidth) + cx) * 4
        const alphaIn = value / 255
        if (alphaIn <= 0) continue
        // over 合成（直通 alpha）
        const alphaOut = alphaIn + (canvas[at + 3] / 255) * (1 - alphaIn)
        if (alphaOut <= 0) continue
        for (let c = 0; c < 3; c += 1) {
          const dst = canvas[at + c] / 255
          const src = source[p00 + c] / 255
          const out = src * alphaIn + dst * (1 - alphaIn)
          canvas[at + c] = Math.round(out * 255)
        }
        canvas[at + 3] = Math.round(alphaOut * 255)
      }
    }
  }
}

/**
 * 合成并编码成 ProRes 4444（带 alpha）。
 * @param {object} options
 * @param {string} options.overlayPath - 带 alpha 的 PNG
 * @param {Array} options.frames - [{x,y,w,h}] 目标矩形（画布像素，左上原点）
 * @param {number} options.width - 画布宽
 * @param {number} options.height - 画布高
 * @param {number} options.fps - 采样帧率
 * @param {string} options.outPath - 输出 .mov
 * @returns {Promise<{outPath: string, frameCount: number, bytes: number}>}
 */
export async function composeOverlayMovie(options) {
  const { overlayPath, frames, width, height, fps, outPath } = options
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('composeOverlayMovie 需要 frames')
  const overlaySize = await probeImageSize(overlayPath)
  if (!(overlaySize.width > 0 && overlaySize.height > 0)) throw new Error('读不到贴图尺寸')
  const { data: source } = await decodeImage(overlayPath)
  const expectedBytes = overlaySize.width * overlaySize.height * 4
  if (source.length !== expectedBytes) {
    throw new Error(`贴图 RGBA 字节数不符：${source.length} ≠ ${expectedBytes}`)
  }

  const args = [
    '-v',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    String(fps),
    '-i',
    '-',
    '-c:v',
    'prores_ks',
    '-profile:v',
    '4444',
    '-pix_fmt',
    'yuva444p10le',
    '-y',
    outPath,
  ]
  const encoder = spawn('ffmpeg', args)
  let stderr = ''
  encoder.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const closed = new Promise((resolve, reject) => {
    encoder.on('error', reject)
    encoder.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ProRes 编码失败：${stderr.trim().slice(-600)}`))
    })
  })

  const canvas = new Uint8Array(width * height * 4)
  for (const frame of frames) {
    canvas.fill(0)
    blitScaled(canvas, width, height, source, overlaySize.width, overlaySize.height, frame)
    const ok = encoder.stdin.write(Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength))
    if (!ok) {
      await new Promise((resolve) => encoder.stdin.once('drain', resolve))
    }
  }
  encoder.stdin.end()
  await closed
  return { outPath, frameCount: frames.length, bytes: Buffer.byteLength(canvas) * frames.length }
}

// ---------------------------------------------------------------------------
// 旋转 / 透视跟随（B2）
//
// 现有 composeOverlayMovie 只做平移 + 缩放；真实拍摄里车窗 / 屏幕 / 海报是倾斜的，
// 矩形跟踪给的是 4 个角点。这里用单应（homography）把贴图的 4 个角映射到目标
// 四边形，逐帧逐像素 inverse-map + bilinear 采样，再 alpha over 到透明画布上。
//
// 坐标约定：全部是像素、左上原点、y 向下；quad 的 4 个角点顺序固定顺时针
// 左上 → 右上 → 右下 → 左下（与 vision.swift detect-rect 的输出一致）。
// ---------------------------------------------------------------------------

/** 把 {x,y} / [x,y] 统一成 {x,y} 并校验有限数值。 */
function toPoint(value, label) {
  const x = Array.isArray(value) ? value[0] : value?.x
  const y = Array.isArray(value) ? value[1] : value?.y
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw new TypeError(`${label} 不是有效角点（需要 {x,y} 或 [x,y]）：${JSON.stringify(value)}`)
  }
  return { x: Number(x), y: Number(y) }
}

/** 校验并规范化 4 个角点（顺序保持原样）。 */
function toQuad(quad, label) {
  const corners = Array.isArray(quad) ? quad : quad?.corners
  if (!Array.isArray(corners) || corners.length !== 4) {
    throw new TypeError(`${label} 必须是 4 个角点（数组或 {corners:[…]}）`)
  }
  return corners.map((corner, index) => toPoint(corner, `${label}[${index}]`))
}

/**
 * 把 detectRectangles() 的矩形换算成目标画布分辨率下的 4 个角点。
 *
 * 允许两种输入形态：
 *   · rects = [{corners:[…]}, …]（可带 rect.imageWidth / rect.imageHeight）
 *   · rects = detectRectangles() 的整个返回值 {width,height,rects:[…]}
 * 检测分辨率优先取 rect.imageWidth/imageHeight，其次取整个返回值的 width/height；
 * 缺省时视为已经是目标画布分辨率（scale = 1）。
 *
 * @param {Array|object} rects
 * @param {number} [frameWidth]  目标画布宽（像素）
 * @param {number} [frameHeight] 目标画布高（像素）
 * @param {{index?: number, sourceWidth?: number, sourceHeight?: number}} [options]
 * @returns {{x:number,y:number}[]} 4 个角点，顺时针 左上→右上→右下→左下
 */
export function quadsFromRects(rects, frameWidth, frameHeight, options = {}) {
  const { index = 0 } = options
  const wrapper = !Array.isArray(rects) && rects && Array.isArray(rects.rects) ? rects : null
  const list = wrapper ? wrapper.rects : rects
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError('quadsFromRects 需要至少一个 rect（或 detectRectangles 的返回值）')
  }
  const rect = list[index]
  if (!rect) throw new RangeError(`quadsFromRects: 没有 index=${index} 的 rect（共 ${list.length} 个）`)

  const sourceWidth = Number(options.sourceWidth ?? rect.imageWidth ?? rect.sourceWidth ?? wrapper?.width)
  const sourceHeight = Number(options.sourceHeight ?? rect.imageHeight ?? rect.sourceHeight ?? wrapper?.height)
  const sx = Number.isFinite(frameWidth) && sourceWidth > 0 ? frameWidth / sourceWidth : 1
  const sy = Number.isFinite(frameHeight) && sourceHeight > 0 ? frameHeight / sourceHeight : 1
  return toQuad(rect, `rects[${index}]`).map(({ x, y }) => ({ x: x * sx, y: y * sy }))
}

/**
 * 用 3×3 矩阵把点 (x, y, 1) 映射到 (X/W, Y/W)。矩阵是行优先的 3×3 数组。
 * @param {number[][]} matrix
 * @param {{x:number,y:number}|number[]} point
 * @returns {{x:number,y:number,w:number}}
 */
export function applyHomography(matrix, point) {
  if (!Array.isArray(matrix) || matrix.length !== 3 || matrix.some((row) => !Array.isArray(row) || row.length !== 3)) {
    throw new TypeError('homography 必须是 3×3 数组')
  }
  const p = toPoint(point, 'point')
  const X = matrix[0][0] * p.x + matrix[0][1] * p.y + matrix[0][2]
  const Y = matrix[1][0] * p.x + matrix[1][1] * p.y + matrix[1][2]
  const W = matrix[2][0] * p.x + matrix[2][1] * p.y + matrix[2][2]
  if (Math.abs(W) < 1e-12) throw new Error('homography 映射到无穷远（W≈0），四边形退化')
  return { x: X / W, y: Y / W, w: W }
}

/** 解 8×8 线性方程组（高斯消元 + 部分主元）。原地破坏 a / b。 */
function solveLinearSystem(a, b) {
  const n = b.length
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('单应矩阵求解失败：四边形退化（共线 / 重合点）')
    if (pivot !== col) {
      ;[a[pivot], a[col]] = [a[col], a[pivot]]
      ;[b[pivot], b[col]] = [b[col], b[pivot]]
    }
    const diag = a[col][col]
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row][col] / diag
      if (factor === 0) continue
      for (let k = col; k < n; k += 1) a[row][k] -= factor * a[col][k]
      b[row] -= factor * b[col]
    }
  }
  const x = new Array(n).fill(0)
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row]
    for (let k = row + 1; k < n; k += 1) sum -= a[row][k] * x[k]
    x[row] = sum / a[row][row]
  }
  return x
}

/**
 * 单应用 DLT（8 参数，4 对点）求单应矩阵：把 srcQuad 的角点映射到 dstQuad 的角点。
 * 解 h = [h11,h12,h13,h21,h22,h23,h31,h32]，h33 = 1。
 *
 * @param {Array} srcQuad 源四边形（贴图坐标，4 个角点）
 * @param {Array} dstQuad 目标四边形（画布像素，4 个角点）
 * @returns {number[][]} 3×3 行优先矩阵
 */
export function homographyFromQuad(srcQuad, dstQuad) {
  const src = toQuad(srcQuad, 'srcQuad')
  const dst = toQuad(dstQuad, 'dstQuad')
  const a = Array.from({ length: 8 }, () => new Array(8).fill(0))
  const b = new Array(8).fill(0)
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = src[i]
    const { x: X, y: Y } = dst[i]
    const r0 = i * 2
    const r1 = r0 + 1
    a[r0][0] = x; a[r0][1] = y; a[r0][2] = 1
    a[r0][6] = -X * x; a[r0][7] = -X * y
    b[r0] = X
    a[r1][3] = x; a[r1][4] = y; a[r1][5] = 1
    a[r1][6] = -Y * x; a[r1][7] = -Y * y
    b[r1] = Y
  }
  const [h11, h12, h13, h21, h22, h23, h31, h32] = solveLinearSystem(a, b)
  return [
    [h11, h12, h13],
    [h21, h22, h23],
    [h31, h32, 1],
  ]
}

/** 3×3 矩阵求逆（解析伴随矩阵法）；退化时 throw。 */
function invertHomography(matrix) {
  const [[a, b, c], [d, e, f], [g, h, i]] = matrix
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) throw new Error('单应矩阵不可逆：目标四边形退化（面积≈0 / 共线）')
  const inv = [
    [A, -(b * i - c * h), b * f - c * e],
    [B, a * i - c * g, -(a * f - c * d)],
    [C, -(a * h - b * g), a * e - b * d],
  ]
  return inv.map((row) => row.map((value) => value / det))
}

/**
 * 单帧：逐像素把画布坐标 inverse-map 到贴图坐标，bilinear 采样后 alpha over 合成。
 * 画布初始必须是全透明；越界像素跳过（四边形外 alpha 保持 0）。
 */
function composeHomographyFrame(canvas, width, height, source, sourceWidth, sourceHeight, inverse) {
  const [[i00, i01, i02], [i10, i11, i12], [i20, i21, i22]] = inverse
  for (let cy = 0; cy < height; cy += 1) {
    const Y = cy + 0.5
    for (let cx = 0; cx < width; cx += 1) {
      const X = cx + 0.5
      const w = i20 * X + i21 * Y + i22
      if (Math.abs(w) < 1e-12) continue
      const sx = (i00 * X + i01 * Y + i02) / w
      const sy = (i10 * X + i11 * Y + i12) / w
      // 目标像素中心 → 贴图素中心坐标（0 基、像素中心在 +0.5）
      const px = sx - 0.5
      const py = sy - 0.5
      if (px < -0.5 || py < -0.5 || px > sourceWidth - 0.5 || py > sourceHeight - 0.5) continue

      const x0 = Math.min(Math.max(Math.floor(px), 0), sourceWidth - 1)
      const y0 = Math.min(Math.max(Math.floor(py), 0), sourceHeight - 1)
      const x1 = Math.min(x0 + 1, sourceWidth - 1)
      const y1 = Math.min(y0 + 1, sourceHeight - 1)
      const wx = Math.min(1, Math.max(0, px - x0))
      const wy = Math.min(1, Math.max(0, py - y0))

      const p00 = (y0 * sourceWidth + x0) * 4
      const p10 = (y0 * sourceWidth + x1) * 4
      const p01 = (y1 * sourceWidth + x0) * 4
      const p11 = (y1 * sourceWidth + x1) * 4
      const sample = (offset) => {
        const top = source[p00 + offset] * (1 - wx) + source[p10 + offset] * wx
        const bottom = source[p01 + offset] * (1 - wx) + source[p11 + offset] * wx
        return top * (1 - wy) + bottom * wy
      }
      const alphaIn = sample(3) / 255
      if (alphaIn <= 0) continue

      const at = (cy * width + cx) * 4
      const alphaDst = canvas[at + 3] / 255
      const alphaOut = alphaIn + alphaDst * (1 - alphaIn)
      if (alphaOut <= 0) continue
      for (let channel = 0; channel < 3; channel += 1) {
        const src = sample(channel) / 255
        const dst = canvas[at + channel] / 255
        const out = (src * alphaIn + dst * alphaDst * (1 - alphaIn)) / alphaOut
        canvas[at + channel] = Math.round(Math.min(1, Math.max(0, out)) * 255)
      }
      canvas[at + 3] = Math.round(Math.min(1, alphaOut) * 255)
    }
  }
}

/**
 * 旋转 / 透视跟随合成：逐帧把贴图的 4 个角用单应映射到目标四边形，输出 ProRes 4444。
 * 编码参数与 composeOverlayMovie 完全一致（prores_ks / profile 4444 / yuva444p10le）。
 *
 * @param {object} options
 * @param {string} options.overlayPath - 带 alpha 的 PNG（贴图）
 * @param {Array<{corners:Array}|Array>} options.quads - 每帧一个目标四边形；
 *        4 个角点顺序固定顺时针 左上→右上→右下→左下（像素、左上原点）
 * @param {number} options.width - 画布宽
 * @param {number} options.height - 画布高
 * @param {number} options.fps - 采样帧率
 * @param {string} options.outPath - 输出 .mov
 * @returns {Promise<{outPath:string, frameCount:number, width:number, height:number}>}
 */
export async function composeOverlayMovieHomography(options) {
  const { overlayPath, quads, width, height, fps, outPath } = options
  if (!Array.isArray(quads) || quads.length === 0) {
    throw new Error('composeOverlayMovieHomography 需要 quads（每帧一个四边形）')
  }
  if (!(width > 0 && height > 0)) throw new Error('composeOverlayMovieHomography 需要正的 width/height')
  const normalizedQuads = quads.map((quad, index) => toQuad(quad, `quads[${index}]`))
  const overlaySize = await probeImageSize(overlayPath)
  if (!(overlaySize.width > 0 && overlaySize.height > 0)) throw new Error('读不到贴图尺寸')
  const { data: source } = await decodeImage(overlayPath)
  const expectedBytes = overlaySize.width * overlaySize.height * 4
  if (source.length !== expectedBytes) {
    throw new Error(`贴图 RGBA 字节数不符：${source.length} ≠ ${expectedBytes}`)
  }

  const sourceQuad = [
    { x: 0, y: 0 },
    { x: overlaySize.width, y: 0 },
    { x: overlaySize.width, y: overlaySize.height },
    { x: 0, y: overlaySize.height },
  ]

  const args = [
    '-v', 'error',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', '-',
    '-c:v', 'prores_ks',
    '-profile:v', '4444',
    '-pix_fmt', 'yuva444p10le',
    '-y', outPath,
  ]
  const encoder = spawn('ffmpeg', args)
  let stderr = ''
  encoder.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const closed = new Promise((resolve, reject) => {
    encoder.on('error', reject)
    encoder.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ProRes 编码失败：${stderr.trim().slice(-600)}`))
    })
  })

  const canvas = new Uint8Array(width * height * 4)
  for (const corners of normalizedQuads) {
    const forward = homographyFromQuad(sourceQuad, corners)
    const inverse = invertHomography(forward)
    canvas.fill(0)
    composeHomographyFrame(canvas, width, height, source, overlaySize.width, overlaySize.height, inverse)
    const ok = encoder.stdin.write(Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength))
    if (!ok) {
      await new Promise((resolve) => encoder.stdin.once('drain', resolve))
    }
  }
  encoder.stdin.end()
  await closed
  return { outPath, frameCount: normalizedQuads.length, width, height }
}
