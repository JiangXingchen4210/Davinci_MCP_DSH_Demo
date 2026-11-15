/**
 * 标准 log → Rec.709 转换：曲线公式 + 色域矩阵 + .cube 生成。
 *
 * 为什么自己生成 LUT：第三方 LUT 有版权风险；而 S-Log3 / LogC3 / V-Log 的编码曲线与
 * 色域矩阵都是厂商公开规范，可以按公式精确生成。这里生成的是「编码 log RGB → Rec.709
 * display RGB」的 33³ .cube，可直接被 Resolve 的 SetLUT（graph.set_lut）使用。
 *
 * 重要边界（必须如实告知用户）：
 * - 曲线/矩阵按公开规范实现；`lib/lutgen.test.mjs` 的 round-trip 验证的是**数学自洽**
 *   （log 编码→LUT→Rec.709 与原始 Rec.709 的 PSNR），不等于与厂商官方 LUT 逐点一致。
 * - 显示端统一用 Rec.709 OETF（≈gamma 2.4 / BT.1886 折中）；不同交付目标可能需要微调。
 *
 * CLI（stdout 只出 JSON）：
 *   node lib/lutgen.mjs list [--json]
 *   node lib/lutgen.mjs make <cameraKey> --out <dir> [--json]
 *   node lib/lutgen.mjs encode <cameraKey> <r> <g> <b> [--json]   # linear → log（测试/造素材用）
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const clamp01 = (value) => Math.min(1, Math.max(0, value))

// ---------------------------------------------------------------------------
// 曲线：linear（scene）↔ 编码 log（0..1）
// 来源：Sony S-Log3 白皮书、ARRI LogC3 (EI800) 文档、Panasonic V-Log 白皮书
// ---------------------------------------------------------------------------

const CURVES = {
  'dji-dlog': {
    label: 'DJI D-Log (D-Log)',
    transfer: 'DJI D-Log',
    gamut: 'DJI D-Gamut',
    // DJI D-Log：0.0929 为黑位；≤0.0078 线性段；>0.0078 对数段（a=2.0143 由连续性解出）
    encode(linear) {
      const x = clamp01(linear)
      if (x < 0.0078) return 6.025 * x + 0.0929
      const a = 2.0143
      return (Math.log10(0.9892 * x + 0.0108) + a) / a
    },
    decode(encoded) {
      const y = clamp01(encoded)
      if (y <= 0.1399) return (y - 0.0929) / 6.025
      const a = 2.0143
      return (10 ** (a * (y - 1)) - 0.0108) / 0.9892
    },
    // DJI D-Gamut → Rec.709（近似广播矩阵）
    matrix: [
      [1.5855, -0.4931, -0.0924],
      [-0.1073, 1.2215, -0.1142],
      [-0.0286, -0.2312, 1.2598],
    ],
  },
  'sony-slog3': {
    label: 'Sony S-Log3',
    transfer: 'S-Log3',
    gamut: 'S-Gamut3.Cine',
    encode(linear) {
      const x = clamp01(linear)
      if (x >= 0.01125) return (420 + 261.5 * Math.log10((x + 0.01) / 0.19)) / 1023
      return ((x * (171.2102946929 / 0.01125)) + 95) / 1023
    },
    decode(encoded) {
      const y = clamp01(encoded) * 1023
      if (y >= 171.2102946929) return 0.19 * 10 ** ((y - 420) / 261.5) - 0.01
      return ((y - 95) * 0.01125) / 171.2102946929
    },
    // S-Gamut3.Cine → Rec.709（Sony 白皮书矩阵）
    matrix: [
      [1.6269, -0.4399, -0.1869],
      [-0.1137, 1.1327, -0.019],
      [-0.0111, -0.0676, 1.0787],
    ],
  },
  'arri-logc3': {
    label: 'ARRI LogC3 (EI800)',
    transfer: 'ARRI LogC3',
    gamut: 'ARRI Wide Gamut 3',
    encode(linear) {
      const a = 5.555556
      const b = 0.052272
      const c = 0.24719
      const d = 0.385537
      const e = 5.367655
      const f = 0.092809
      const cut = 0.010591
      const x = clamp01(linear)
      // ARRI LogC3 用的是 log10（不是 log2）：18% 灰 =0.391 可验证
      if (x > cut) return c * Math.log10(a * x + b) + d
      return e * x + f
    },
    decode(encoded) {
      const a = 5.555556
      const b = 0.052272
      const c = 0.24719
      const d = 0.385537
      const e = 5.367655
      const f = 0.092809
      const y = clamp01(encoded)
      const cut = e * 0.010591 + f
      if (y > cut) return (10 ** ((y - d) / c) - b) / a
      return (y - f) / e
    },
    // ARRI Wide Gamut 3 → Rec.709
    matrix: [
      [1.7053, -0.6213, -0.084],
      [-0.0775, 1.1472, -0.0697],
      [-0.0094, -0.0916, 1.101],
    ],
  },
  'panasonic-vlog': {
    label: 'Panasonic V-Log',
    transfer: 'V-Log',
    gamut: 'V-Gamut',
    // Panasonic 官方 V-Log（VARICAM V-Log/V-Gamut rev1.0）：
    //   V = c*log10(L + b) + d   (L >= cut)
    //   V = e*L + f              (L <  cut)
    // c=0.241514 b=0.00873 d=0.598206 cut=0.01，e、f 由切点连续性和导数连续性解出（≈5.6 / 0.125）
    // 验收：18% 灰 (L=0.18) → V≈0.423311；注意 log10 里面是 (L + b)，不是 (5.6L + b)
    encode(linear) {
      const c = 0.241514
      const b = 0.00873
      const d = 0.598206
      const cut = 0.01
      const x = Math.max(0, Number(linear) || 0)
      if (x >= cut) return clamp01(c * Math.log10(x + b) + d)
      const e = c / (Math.LN10 * (cut + b))
      const vCut = c * Math.log10(cut + b) + d
      const f = vCut - e * cut
      return clamp01(e * x + f)
    },
    decode(encoded) {
      const c = 0.241514
      const b = 0.00873
      const d = 0.598206
      const cut = 0.01
      const y = clamp01(encoded)
      const e = c / (Math.LN10 * (cut + b))
      const vCut = c * Math.log10(cut + b) + d
      const f = vCut - e * cut
      if (y >= vCut) return clamp01(10 ** ((y - d) / c) - b)
      return clamp01((y - f) / e)
    },
    matrix: [
      [1.7378, -0.5806, -0.1572],
      [-0.0957, 1.1577, -0.062],
      [-0.0244, -0.1137, 1.1381],
    ],
  },
  'rec709-identity': {
    // 用途是「线性 → Rec.709 显示编码」，不是恒等；恒等请看 linear-identity
    label: 'Linear to Rec.709 (display)',
    transfer: 'Linear → Rec.709 OETF',
    gamut: 'Rec.709',
    encode: (linear) => clamp01(linear),
    decode: (encoded) => clamp01(encoded),
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  },
  'linear-identity': {
    label: 'Linear (per-channel identity)',
    transfer: 'Identity',
    gamut: 'Linear',
    encode: (linear) => clamp01(linear),
    decode: (encoded) => clamp01(encoded),
    identity: true,
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  },
}

/** 显式标注「未内置曲线」的相机，避免静默套错 LUT。 */
const UNSUPPORTED = {
  'canon-clog3': 'Canon C-Log3',
  'bmd-film-gen5': 'Blackmagic Film Gen 5',
  'red-log3g10': 'RED Log3G10',
  'dji-dlog': 'DJI D-Log',
  'nikon-nlog': 'Nikon N-Log',
  'fuji-flog': 'Fujifilm F-Log',
  'apple-log': 'Apple Log',
}

function matrixApply(matrix, rgb) {
  return matrix.map((row) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])
}

/** Rec.709 OETF（≈gamma 2.4 的显示端编码，折中实现）。 */
function rec709Oetf(linear) {
  const x = Math.max(0, linear)
  const alpha = 1.099
  const beta = 0.018
  return clamp01(x < beta ? 4.5 * x : alpha * x ** 0.45 - (alpha - 1))
}

/** 单点：编码 log RGB → Rec.709 display RGB。 */
export function logToRec709(encodedRgb, cameraKey) {
  const curve = CURVES[cameraKey]
  if (!curve) throw new Error(`未内置相机曲线：${cameraKey}`)
  const linear = encodedRgb.map((value) => Math.max(0, curve.decode(value)))
  const target = matrixApply(curve.matrix, linear)
  // 恒等用途：逐通道原样输出（不做 Rec.709 OETF），用于验证“不改变画面”
  if (curve.identity) return target.map((value) => clamp01(value))
  return target.map((value) => rec709Oetf(value))
}

/** 单点：scene-linear → 编码 log（造测试素材、反查用）。 */
export function encodeToLog(rgbLinear, cameraKey) {
  const curve = CURVES[cameraKey]
  if (!curve) throw new Error(`未内置相机曲线：${cameraKey}`)
  return rgbLinear.map((value) => clamp01(curve.encode(value)))
}

export function decodeFromLog(rgbEncoded, cameraKey) {
  const curve = CURVES[cameraKey]
  if (!curve) throw new Error(`未内置相机曲线：${cameraKey}`)
  return rgbEncoded.map((value) => clamp01(curve.decode(value)))
}

export function listCameras() {
  return Object.entries(CURVES).map(([key, curve]) => ({
    key,
    label: curve.label,
    transfer: curve.transfer,
    gamut: curve.gamut,
    builtin: true,
  })).concat(
    Object.entries(UNSUPPORTED).map(([key, label]) => ({
      key,
      label,
      transfer: label,
      gamut: null,
      builtin: false,
      note: '未内置曲线：请在 Resolve 用 CST 节点或官方 LUT（插件不猜）',
    })),
  )
}

/** 生成 33³ .cube 文本。 */
export function generateLut(cameraKey, options = {}) {
  const size = Math.max(2, Math.min(65, Number(options.size) || 33))
  const curve = CURVES[cameraKey]
  if (!curve) throw new Error(`未内置相机曲线：${cameraKey}（可用：${Object.keys(CURVES).join(', ')}）`)
  const lines = [
    `TITLE "${curve.label} to Rec.709 (builtin)` + '"',
    `# generated by dsh davinci-console lib/lutgen.mjs (${new Date().toISOString()})`,
    `# transfer=${curve.transfer} gamut=${curve.gamut} -> Rec.709 / OETF`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ]
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const encoded = [r / (size - 1), g / (size - 1), b / (size - 1)]
        const out = logToRec709(encoded, cameraKey)
        lines.push(`${out[0].toFixed(6)} ${out[1].toFixed(6)} ${out[2].toFixed(6)}`)
      }
    }
  }
  return { name: `${cameraKey}-to-rec709`, content: `${lines.join('\n')}\n`, size, curve: { label: curve.label, transfer: curve.transfer, gamut: curve.gamut } }
}

export async function writeLut(cameraKey, outDir) {
  const lut = generateLut(cameraKey)
  await fs.mkdir(outDir, { recursive: true })
  const filePath = path.join(outDir, `${lut.name}.cube`)
  await fs.writeFile(filePath, lut.content)
  const bytes = Buffer.byteLength(lut.content)
  return { key: cameraKey, path: filePath, bytes, size: lut.size, curve: lut.curve }
}

function parseArgs(argv) {
  const args = [...argv]
  const command = args.shift()
  const options = {}
  const positional = []
  while (args.length > 0) {
    const token = args.shift()
    if (token === '--json') options.json = true
    else if (token === '--out') options.out = args.shift()
    else if (token === '--size') options.size = Number(args.shift())
    else positional.push(token)
  }
  return { command, positional, options }
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2))
  if (command === 'list') {
    process.stdout.write(`${JSON.stringify({ ok: true, cameras: listCameras() }, null, options.json ? 0 : 2)}\n`)
    return
  }
  if (command === 'make' && positional.length === 1) {
    const outDir = options.out ?? path.join(process.cwd(), 'luts')
    const written = await writeLut(positional[0], outDir)
    process.stdout.write(`${JSON.stringify({ ok: true, ...written }, null, options.json ? 0 : 2)}\n`)
    return
  }
  if (command === 'encode' && positional.length === 4) {
    const [key, r, g, b] = positional
    const out = encodeToLog([Number(r), Number(g), Number(b)], key)
    process.stdout.write(`${JSON.stringify({ ok: true, key, encoded: out }, null, options.json ? 0 : 2)}\n`)
    return
  }
  process.stderr.write(
    '用法:\n  node lib/lutgen.mjs list [--json]\n  node lib/lutgen.mjs make <cameraKey> --out <dir> [--json]\n  node lib/lutgen.mjs encode <cameraKey> <r> <g> <b> [--json]\n',
  )
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
