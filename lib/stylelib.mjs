/**
 * 风格库 v2：**还原之后**的风格处理配方（与相机无关、与还原 LUT 无关）。
 *
 * 原则（吸取的教训）：
 *   · 风格不是 LUT：LUT 只是可选手段之一；风格核心是「影调 + 色彩分离 + 局部处理 + 质感」；
 *   · 还原按机型单独走（DaVinci 自带/官方 LUT 或 RCM），风格库不碰还原；
 *   · 每种风格明确记录用了哪些手段：分离色调 / 混色器 / 肤键 / 背景键 / 胶片模拟 LUT / 颗粒 / 黑白柔 / 暗角。
 *   · 每条都有出处（教程/分析文章的链接）。
 */
export const STYLES = Object.freeze([
  {
    key: 'teal-orange',
    label: '青橙（Teal & Orange）',
    sources: ['https://www.2ds.cn/达芬奇调色干货：电影感青橙色调，其实只需要这3步/'],
    techniques: ['S 曲线影调打底', '阴影青蓝 / 高光暖橙的分离色调', 'HSL 肤色保护（15–30°）', '颗粒 8', '轻微暗角'],
    recipe: { exposure: 0.02, contrast: 1.12, lift: -0.01, saturation: 1.0, hue: 2, splitShadow: { r: 0.97, g: 1.01, b: 1.04 }, splitHighlight: { r: 1.04, g: 1.0, b: 0.97 }, skinGain: 1.01, bgCool: 1.03 },
    grain: 8, mist: null, filmLut: null,
  },
  {
    key: 'bleach-bypass',
    label: '漂白旁路（Bleach Bypass）',
    sources: ['https://borisfx.com/blog/bleach-bypass-in-davinci-3-methods/'],
    techniques: ['高对比 S 曲线', '低饱和 55–65%', '抬黑位保留细节', '冷高光', '粗颗粒 12'],
    recipe: { exposure: 0.01, contrast: 1.28, lift: 0.015, saturation: 0.6, hue: 0, splitShadow: { r: 0.985, g: 1.0, b: 1.02 }, splitHighlight: { r: 1.0, g: 1.0, b: 1.02 }, skinGain: 0.99 },
    grain: 12, mist: null, filmLut: null,
  },
  {
    key: 'matrix-green',
    label: '矩阵绿（Matrix Green）',
    sources: ['https://www.bilibili.com/video/BV15pP6zeEHH/'],
    techniques: ['整体绿色偏移（暗部/中间调）', '肤色单独保护', '高对比', '降饱和 12%'],
    recipe: { exposure: 0, contrast: 1.18, lift: -0.005, saturation: 0.88, hue: -4, splitShadow: { r: 0.97, g: 1.03, b: 0.98 }, splitHighlight: { r: 1.0, g: 1.01, b: 0.99 }, skinGain: 1.015 },
    grain: 6, mist: null, filmLut: null,
  },
  {
    key: 'blade-runner',
    label: '银翼杀手 2049',
    sources: ['https://stillslab.com/look/blade-runner-2049'],
    techniques: ['青蓝底色 + 琥珀高光', '雾化白柔 0.3', '低饱和', '高光光晕', '肤色保住'],
    recipe: { exposure: 0.01, contrast: 1.1, lift: 0.008, saturation: 0.85, hue: -2, splitShadow: { r: 0.96, g: 1.0, b: 1.05 }, splitHighlight: { r: 1.06, g: 1.0, b: 0.95 }, skinGain: 1.012 },
    grain: 5, mist: { mode: 'white', strength: 0.3 }, filmLut: null,
  },
  {
    key: 'daredevil-dark',
    label: '夜魔侠暗黑',
    sources: ['https://www.postmagazine.com/publications/2015/august-1-2015/4k-hdr-grading-the-marvel-netflix-series-daredevil/'],
    techniques: ['压暗整体（-0.03 曝光）', '黑位深压', '低饱和冷调', '高光柔化'],
    recipe: { exposure: -0.03, contrast: 1.22, lift: -0.02, saturation: 0.82, hue: -3, splitShadow: { r: 0.95, g: 0.99, b: 1.04 }, splitHighlight: { r: 1.0, g: 1.0, b: 1.03 }, skinGain: 1.0 },
    grain: 7, mist: { mode: 'black', strength: 0.2 }, filmLut: null,
  },
  {
    key: 'wes-pastel',
    label: '韦斯·安德森粉彩',
    sources: ['https://elements.envato.com/learn/wes-anderson-inspired-luts-envato'],
    techniques: ['抬黑位、低对比', '中间调粉彩饱和', '暖冷互补对称', '不用颗粒（干净）'],
    recipe: { exposure: 0.02, contrast: 0.92, lift: 0.03, saturation: 1.05, hue: 1, splitShadow: { r: 1.0, g: 0.995, b: 1.01 }, splitHighlight: { r: 1.035, g: 1.0, b: 0.975 }, skinGain: 1.02 },
    grain: 0, mist: null, filmLut: null,
  },
  {
    key: 'moonlight-blue',
    label: '月光蓝（Moonlight）',
    sources: ['https://stillslab.com/uk/news/moonlight-cinematography-breakdown-three-chapters-three-film-stocks-one-face'],
    techniques: ['阴影偏青蓝', '肤色单独保温', '低饱和', '细颗粒 6'],
    recipe: { exposure: 0, contrast: 1.08, lift: 0.006, saturation: 0.86, hue: -1, splitShadow: { r: 0.96, g: 1.0, b: 1.045 }, splitHighlight: { r: 1.02, g: 1.0, b: 1.0 }, skinGain: 1.015 },
    grain: 6, mist: null, filmLut: null,
  },
  {
    key: 'mad-max-chrome',
    label: '疯狂麦克斯·铬版',
    sources: ['https://www.awn.com/blog/colorful-world-mad-max-fury-road'],
    techniques: ['高对比', '橙青强化', '饱和提升', '高光溢出（halation）'],
    recipe: { exposure: 0.015, contrast: 1.3, lift: -0.01, saturation: 1.15, hue: 3, splitShadow: { r: 0.95, g: 1.0, b: 1.06 }, splitHighlight: { r: 1.08, g: 1.0, b: 0.94 }, skinGain: 1.02 },
    grain: 9, mist: null, filmLut: null,
  },
  {
    key: 'godfather-amber',
    label: '教父琥珀',
    sources: ['https://tv.apple.com/cy/person/gordon-willis/umc.cpc.2rybr3wz0qaomdp0y6qss1kq8', 'https://www.2ds.cn/达芬奇调色干货：电影感青橙色调，其实只需要这3步/'],
    techniques: ['暖琥珀高光', '压暗黑位、保留层次', '低饱和', '颗粒 10', '暗角 15%'],
    recipe: { exposure: -0.01, contrast: 1.15, lift: -0.015, saturation: 0.84, hue: 4, splitShadow: { r: 1.01, g: 0.995, b: 0.985 }, splitHighlight: { r: 1.06, g: 1.0, b: 0.94 }, skinGain: 1.02 },
    grain: 10, mist: null, filmLut: null,
  },
  {
    key: 'kodak-2383',
    label: '柯达 2383 胶片模拟',
    sources: ['https://www.bilibili.com/video/BV17psV6wEwf/', 'https://www.bilibili.com/video/BV15pP6zeEHH/'],
    techniques: ['DaVinci 自带 Film Looks 的 Kodak 2383 LUT', '分离色调微调', '颗粒 8', '高光柔和'],
    recipe: { exposure: 0, contrast: 1.05, lift: 0.005, saturation: 0.95, hue: 0, splitShadow: { r: 1.0, g: 1.0, b: 1.01 }, splitHighlight: { r: 1.02, g: 1.0, b: 0.98 }, skinGain: 1.01 },
    grain: 8, mist: null,
    filmLut: '/Library/Application Support/Blackmagic Design/DaVinci Resolve/LUT/Film Looks/Rec709 Kodak 2383 D65.cube',
  },
])

export function listStyles() {
  return STYLES.map(({ key, label, sources, techniques, recipe, grain, mist, filmLut }) => ({ key, label, sources, techniques, recipe, grain, mist, filmLut }))
}

export function findStyle(key) {
  return STYLES.find((style) => style.key === key) ?? null
}
