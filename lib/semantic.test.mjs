import { rgbToHsl, semanticFeaturesFromRgb, themeSemanticScore, selectShotsByTheme } from './semantic.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
function solid(w, h, r, g, b) {
  const buf = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i += 1) { buf[i * 3] = r; buf[i * 3 + 1] = g; buf[i * 3 + 2] = b }
  return buf
}
function border(w, h, inner, outer) {
  const buf = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const edge = x < w * 0.12 || x >= w * 0.88 || y < h * 0.12 || y >= h * 0.88
    const c = edge ? outer : inner
    const i = (y * w + x) * 3; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]
  }
  return buf
}
const greenGold = semanticFeaturesFromRgb(border(64, 36, [170, 160, 60], [120, 120, 60]), 64, 36)
assert(greenGold.greenGold > 0.5, `黄绿占比应高，实际 ${greenGold.greenGold}`)
const studio = semanticFeaturesFromRgb(border(64, 36, [40, 170, 200], [4, 4, 4]), 64, 36)
assert(studio.cyan > 0.5, `青色黑板占比应高，实际 ${studio.cyan}`)
assert(studio.blackBorder > 0.8, `黑边占比应高，实际 ${studio.blackBorder}`)
assert(themeSemanticScore('auto', greenGold) > themeSemanticScore('auto', studio), '自然镜头分数应高于棚拍')
assert(themeSemanticScore('studio', studio) > themeSemanticScore('studio', greenGold), 'studio 主题反之')
const { kept, excluded } = selectShotsByTheme([
  { index: 1, clipName: 'green', semantic: greenGold },
  { index: 2, clipName: 'teacher', semantic: studio },
], { theme: 'auto' })
assert(kept.length === 1 && kept[0].clipName === 'green', 'auto 应保留自然镜头')
assert(excluded.length === 1 && excluded[0].clipName === 'teacher', 'auto 应排除棚拍镜头并给 reason')
assert(excluded[0].reason.includes('studio'), '排除原因应可复核')
const studioTheme = selectShotsByTheme([{ index: 2, clipName: 'teacher', semantic: studio }], { theme: 'studio' })
assert(studioTheme.kept.length === 1, 'studio 主题应保留棚拍镜头')
assert(rgbToHsl(0, 0, 0).s === 0, '黑色饱和度 0')

if (failures) { console.error(`FAIL semantic.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS semantic.test.mjs — 调色板特征、主题打分、棚拍排除规则')
