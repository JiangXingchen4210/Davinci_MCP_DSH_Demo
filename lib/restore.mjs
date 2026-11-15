/**
 * 还原决策（色彩管线）：不猜机型、不按品牌加分，按「事实链」走：
 *   1) 先判断是不是灰片（LOG/未还原）：看动态范围 + 饱和度统计，灰片才需要还原；
 *   2) 若是灰片，看素材元数据里机型/厂商是否明确、LOG 是否开启（transfer/曲线信息或厂商标签）；
 *   3) 由机型 → 该机器使用的 LOG 曲线（查表，表要可扩展、可被官网信息更新）；
 *   4) 在 DaVinci 还原 LUT 库里按「曲线名」匹配（例如 D-Log→Rec709、S-Log3→Rec709）；
 *   5) 库里没有这条曲线的 LUT → 不猜、不硬套别家 LUT；给出厂商官方 LUT 页面，
 *      由用户决定：一键下载安装 / 自己上传 .cube / 先不还原。
 *
 * 设计原则：评分只看「曲线是否匹配」，不因为某台机器（如 Ronin 4D）给额外权重。
 */

/** 机型 → LOG 曲线 + 厂商官方 LUT 页面（真实 URL；新增机型只加表项） */
export const CAMERA_CURVES = Object.freeze([
  { match: /find\s*x9|oppo|hasselblad|o-?log/i, vendor: 'OPPO', model: 'OPPO Find X9 (O-Log)', curve: 'OPPO O-Log', lutKeys: [/o-?log/i], officialPage: 'https://www.oppo.com/cn/log-to-rec709-download/', officialLutUrl: 'https://www.oppo.com/content/dam/oppo_com/cn/mkt/footer/o-log-technical-transform-tools_v0.zip' },
  { match: /ronin\s*4d|zenmuse\s*x9/i, vendor: 'DJI', model: 'Ronin 4D (Zenmuse X9)', curve: 'DJI D-Log', lutKeys: [/d-?log/i, /dlog/i], officialPage: 'https://www.dji.com/lut' },
  { match: /zenmuse\s*x7/i, vendor: 'DJI', model: 'Zenmuse X7', curve: 'DJI D-Log', lutKeys: [/d-?log/i, /dlog/i], officialPage: 'https://www.dji.com/lut' },
  { match: /mavic|air\s*2s|mini\s*3|d-?log\s*m/i, vendor: 'DJI', model: 'DJI (D-Log M)', curve: 'DJI D-Log M', lutKeys: [/d-?log\s*m/i], officialPage: 'https://www.dji.com/lut' },
  { match: /alexa\s*35|logc4|awg4/i, vendor: 'ARRI', model: 'ARRI ALEXA 35 (LogC4)', curve: 'ARRI LogC4', lutKeys: [/logc4/i], officialPage: 'https://www.arri.com/en/learn-help/learn-help-camera-system/tools/lut-generator' },
  { match: /alexa|arri\s*a/i, vendor: 'ARRI', model: 'ARRI ALEXA (LogC3)', curve: 'ARRI LogC3', lutKeys: [/logc3/i], officialPage: 'https://www.arri.com/en/learn-help/learn-help-camera-system/tools/lut-generator' },
  { match: /venice|sony.*fx|ilme|fx3|fx6|fx9|a7s/i, vendor: 'Sony', model: 'Sony (S-Log3)', curve: 'Sony S-Log3', lutKeys: [/s-?log3/i], officialPage: 'https://www.sony.net/Products/di/technology/lut/' },
  { match: /canon|c70|c300|c500|r5c/i, vendor: 'Canon', model: 'Canon (C-Log3)', curve: 'Canon C-Log3', lutKeys: [/c-?log3/i], officialPage: 'https://www.usa.canon.com/support/p/cinema-eos' },
  { match: /panasonic|varicam|gh6|s1h|s5ii/i, vendor: 'Panasonic', model: 'Panasonic (V-Log)', curve: 'Panasonic V-Log', lutKeys: [/v-?log/i], officialPage: 'https://eww.pass.panasonic.co.jp/pro-av/support/content/guide/en/othe001.html' },
  { match: /blackmagic|bmpcc|ursa/i, vendor: 'Blackmagic', model: 'Blackmagic (Film Gen 5)', curve: 'BMD Film Gen 5', lutKeys: [/bmd|blackmagic/i], officialPage: 'https://www.blackmagicdesign.com/support' },
  { match: /red\s*(komodo|raptor|helium)/i, vendor: 'RED', model: 'RED (Log3G10)', curve: 'RED Log3G10', lutKeys: [/log3g10/i], officialPage: 'https://www.red.com/downloads' },
])

/** 灰片判定：动态范围小而两侧被压、饱和度低 → 未还原的 LOG。 */
export function judgeFlat(rawStats) {
  // 兼容两种输入：{p5,p95,saturation} 或 lib/layers.mjs 的 analyze 输出（layers.global.lumaPct/meanSat）
  const global = rawStats?.layers?.global ?? null
  const p5 = Number(global ? global.lumaPct?.p5 : rawStats?.p5)
  const p95 = Number(global ? global.lumaPct?.p95 : rawStats?.p95)
  const saturation = Number(global ? global.meanSat : rawStats?.saturation)
  const stats = { p5, p95, saturation }
  if (!Number.isFinite(p5) || !Number.isFinite(p95)) return { flat: null, reason: '没有画面统计，无法判断是否灰片' }
  const range = p95 - p5
  const flat = range < 0.42 && saturation < 0.22
  return {
    flat,
    range: Number(range.toFixed(3)),
    saturation: Number(Number.isFinite(saturation) ? saturation.toFixed(3) : null),
    reason: flat ? `动态范围 ${range.toFixed(2)}、饱和 ${saturation?.toFixed(2)} → 典型未还原 LOG` : `动态范围 ${range.toFixed(2)}、饱和 ${saturation?.toFixed(2)} → 已是彩色（无需还原）`,
  }
}

/** 由元数据文本识别机型/曲线（先厂商名，再型号）。 */
export function detectCurveFromMeta(text) {
  const haystack = String(text ?? '')
  // 0) SDR / 显示编码声明优先：写了 Rec.709 / S-Cinetone / SDR 就不是 LOG，别再按机型猜
  const hasLogToken = /s-?log3|logc[34]|d-?log|v-?log|c-?log3|log3g10|o-?log/i.test(haystack)
  if (!hasLogToken && /s-?cinetone|rec\.?709|rec709|sdr|bt\.?709/i.test(haystack)) {
    return null
  }
  // 0.5) 明确的 LOG 曲线名（不依赖机型表）
  const explicitLog = [
    { pattern: /logc4|awg4/i, curve: 'ARRI LogC4' },
    { pattern: /logc3|awg3/i, curve: 'ARRI LogC3' },
    { pattern: /s-?log3/i, curve: 'Sony S-Log3' },
    { pattern: /d-?log\s*m|dlogm/i, curve: 'DJI D-Log M' },
    { pattern: /d-?log/i, curve: 'DJI D-Log' },
    { pattern: /v-?log/i, curve: 'Panasonic V-Log' },
    { pattern: /c-?log3/i, curve: 'Canon C-Log3' },
    { pattern: /log3g10/i, curve: 'RED Log3G10' },
    { pattern: /o-?log/i, curve: 'OPPO O-Log' },
  ]
  for (const rule of explicitLog) {
    if (!rule.pattern.test(haystack)) continue
    const entry = CAMERA_CURVES.find((item) => item.curve === rule.curve)
    if (entry) return { vendor: entry.vendor, model: entry.model, curve: entry.curve, lutKeys: entry.lutKeys, officialPage: entry.officialPage, officialLutUrl: entry.officialLutUrl ?? null, matchedBy: 'explicit-curve' }
  }
  // 1) 明确的曲线/色域名先于机型匹配
  for (const entry of CAMERA_CURVES) {
    if (entry.match.test(haystack)) return { vendor: entry.vendor, model: entry.model, curve: entry.curve, lutKeys: entry.lutKeys, officialPage: entry.officialPage, officialLutUrl: entry.officialLutUrl ?? null, matchedBy: 'model-only', needsCurveConfirmation: true }
  }
  return null
}

/** 在 LUT 库清单里按曲线名匹配（只要曲线匹配即可，不给某台机器额外权重）。 */
export function matchCurveLut(luts, curveInfo) {
  if (!curveInfo) return { match: null, candidates: [] }
  const candidates = []
  for (const lut of luts) {
    const name = String(lut.name ?? lut.path ?? '')
    const hit = curveInfo.lutKeys.some((pattern) => pattern.test(name))
    if (!hit) continue
    // 同一品牌不同曲线不能互顶：LogC4 不拿 LogC3、LogC3 不拿 LogC4
    const wantsC4 = /logc4/i.test(curveInfo.curve)
    const hasC4 = /logc4/i.test(name)
    const hasC3 = /logc3/i.test(name)
    if (wantsC4 && !hasC4) continue
    if (!wantsC4 && /logc3/i.test(curveInfo.curve) && hasC4) continue
    // D-Log 与 D-Log M 是两条不同曲线：名字里带 M 的不能拿去还原普通 D-Log，反之亦然
    const wantsM = /d-?log\s*m/i.test(curveInfo.curve)
    const hasM = /d-?log\s*m|dlogm/i.test(name)
    if (wantsM !== hasM) continue
    // 只按「曲线 + 到 Rec.709」匹配；同曲线不同机器不区分权重
    let score = 1
    if (/rec\.?709|to.?rec/i.test(name)) score += 1
    if (new RegExp(curveInfo.curve.replace(/[^a-z0-9]/gi, ''), 'i').test(name.replace(/[^a-z0-9]/gi, ''))) score += 1
    candidates.push({ path: lut.path ?? lut, name, score })
  }
  candidates.sort((a, b) => b.score - a.score)
  return { match: candidates[0] ?? null, candidates }
}

/**
 * 项目色彩管理是否已经接管输入变换（RCM）：是的话不要挂第二次技术 LUT。
 * 只看事实：colorScienceMode 明确是 managed；或输入色彩空间非空且不是 Rec.709/Bypass。
 */
export function rcmManaged(settings) {
  const mode = String(settings?.colorScienceMode ?? '')
  if (/managed|color\s*management/i.test(mode)) return { managed: true, reason: `项目色彩管理已启用（${mode}）` }
  const input = String(settings?.colorSpaceInput ?? settings?.inputColorSpace ?? '')
  if (input && !/rec\.?709|bypass|none/i.test(input)) return { managed: true, reason: `片段/项目输入色彩空间已设为 ${input}` }
  return { managed: false, reason: '项目未接管输入变换（需要技术 LUT）' }
}
