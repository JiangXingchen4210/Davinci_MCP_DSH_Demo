/**
 * 三层、10+ 节点调色图（一个节点只放一个工具）。
 *
 * 为什么这么搭：
 *   1) 一个节点里塞多个工具时，效果是「混合」的，没法单独判断每个工具贡献了什么；
 *   2) 拆成一层层的单工具节点后，每一层都能单独开关/单独验证（先还原、再调色、最后风格与特效）；
 *   3) 渲染顺序 = 串联（Color 页面上是绿色箭头链）；qualifier 内部走的是键（蓝色键路），
 *      但脚本只能写串联图，并行/图层/键混合器属于 Fusion 节点（见 README 说明）。
 *
 * 三层定义（对应 Resolve 的校正器串联）：
 *   L1 校正/还原/统一：输入归一、白平衡、曝光、对比
 *   L2 调色/偏移：曲线、色相、饱和、分离色调（暗部/高光）
 *   L3 动态遮罩/风格/特效：肤色键、背景键、风格 LUT（挂在独立节点）、颗粒/光晕（OFX 或后处理）
 *
 * 每个节点对象形如：
 *   { id, layer, label, tool, params }  // params 只包含一个工具的参数族
 */

const clamp = (value, min, max, fallback = min) => {
  const num = Number(value)
  return Number.isFinite(num) ? Math.min(max, Math.max(min, num)) : fallback
}

const round = (value, digits = 4) => Number(Number(value).toFixed(digits))

/**
 * 节点图布局常量（实测校准）：
 *   横向间距 250 时节点会互相叠住（Resolve 节点宽约 300+ 单位），改用 MCP 原生 Cleanup 的 495；
 *   行距 200 时上下两行会压在一起，改用 320。
 */
export const LAYOUT = Object.freeze({
  ROW_Y: Object.freeze({ L1: 120, L2: 440, L3: 760 }),
  ROW_X: Object.freeze({ L1: 290, L2: 330, L3: 370 }),
  SPACING_X: 495,
})

export const LAYERS = Object.freeze([
  { id: 'L1', name: '校正 / 还原 / 统一', purpose: '把不同素材拉回同一基准：输入空间、白平衡、曝光、对比。' },
  { id: 'L2', name: '调色 / 偏移', purpose: '在统一基准上做创作：曲线、色相偏移、饱和度、分离色调。' },
  { id: 'L3', name: '动态遮罩 / 风格 / 特效', purpose: '局部与风格：肤色/背景键控、风格 LUT、颗粒与光晕。' },
])

const TOOL_OF_NODE = Object.freeze({
  input: 'input',
  balance: 'balance',
  exposure: 'exposure',
  contrast: 'contrast',
  curve: 'curve',
  hue: 'hue',
  saturation: 'saturation',
  splitTone: 'splitTone',
  skinKey: 'skinKey',
  bgKey: 'bgKey',
  lookLut: 'lookLut',
  texture: 'texture',
})

/**
 * 生成三层节点图。
 * @param {object} options
 * @param {object} [options.consistency] {gain, lift, gamma, warmth, saturation} —— L1 统一用（来自 consistency.mjs）
 * @param {object} [options.look] {preset, strength} —— L3 风格 LUT（挂独立节点，后续用 graph.set_lut 写）
 * @param {object} [options.shot] 分层统计（layers.mjs 输出）用于肤色/背景键控范围
 * @param {object} [options.texture] {halation, glow, grain} 质感计划（记录意图，节点上留注释参数）
 */
export function buildThreeLayerGraph(options = {}) {
  const nodes = []
  const push = (node) => {
    nodes.push({ id: nodes.length + 1, ...node })
    return node
  }

  // ---------------------------------------------------------------- L1
  // 01 输入：不做变换，只作为「还原起点」占位（若素材是 LOG/需要 CST，这里挂 LUT/CST）
  push({
    layer: 'L1',
    label: '01 输入/还原起点',
    tool: TOOL_OF_NODE.input,
    params: { space: 'ui' }, // 无变换：真正还原靠 04 统一 + 上游 look LUT
    note: '占位节点：若素材是 LOG，这里由 raw.apply 的 LUT 接管；若已是 709 则保持恒等',
  })
  // 02 白平衡
  const c = options.consistency ?? {}
  const warmth = clamp(c.warmth ?? 0, -0.06, 0.06, 0)
  push({
    layer: 'L1',
    label: '02 白平衡',
    note: '用 Gain 把偏色拉回中性：不同机型/色温素材先统一白平衡，后面的风格才有共同基准',
    tool: TOOL_OF_NODE.balance,
    params: {
      space: 'ui',
      gain: { r: round(1 + warmth), g: 1, b: round(1 - warmth), master: 1 },
    },
  })
  // 03 曝光（只用 master，避免 per-channel 混淆）
  push({
    layer: 'L1',
    label: '03 曝光',
    note: '用 Offset 统一曝光基准；LOG 素材要先还原再谈曝光，节点顺序保证在还原之后',
    tool: TOOL_OF_NODE.exposure,
    params: {
      space: 'ui',
      gain: { r: 1, g: 1, b: 1, master: round(clamp(c.gain ?? 1, 0.75, 1.3, 1)) },
    },
  })
  // 04 对比 + 黑位统一
  push({
    layer: 'L1',
    label: '04 对比/黑位统一',
    tool: TOOL_OF_NODE.contrast,
    params: {
      space: 'ui',
      lift: { r: 0, g: 0, b: 0, master: round(clamp(c.lift ?? 0, -0.08, 0.08, 0)) },
      gamma: { r: 0, g: 0, b: 0, master: round((clamp(c.gamma ?? 1, 0.7, 1.4, 1) - 1) * 0.5, 4) },
      contrast: round(clamp(1 + 0.06 * (options.styleStrength ?? 0.8), 0.9, 1.2, 1)),
      pivot: 0.44,
      softClipHigh: 1,
    },
    note: '白平衡/曝光/对比各占一个节点：出问题能单独定位是哪一步',
  })

  // ---------------------------------------------------------------- L2
  push({
    layer: 'L2',
    label: '05 曲线',
    note: '自定义曲线做影调塑形（抬黑位/压高光），风格的主影调在这一步定型',
    tool: TOOL_OF_NODE.curve,
    params: {
      space: 'ui',
      customCurves: {
        luminance: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.24 },
          { x: 0.5, y: 0.5 },
          { x: 0.75, y: 0.77 },
          { x: 1, y: 1 },
        ],
      },
    },
  })
  push({
    layer: 'L2',
    label: '06 色相偏移',
    tool: TOOL_OF_NODE.hue,
    params: {
      space: 'ui',
      hueShift: round(clamp(options.hueShift ?? 0, -10, 10, 0)),
    },
    note: '整体色相只做小幅度偏移；局部色相用 qualifier 节点（L3）',
  })
  push({
    layer: 'L2',
    label: '07 饱和度',
    note: '整体饱和度控制，风格配方在这里决定降饱和/提饱和（如漂白旁路降到 60%）',
    tool: TOOL_OF_NODE.saturation,
    params: {
      space: 'ui',
      saturation: round(clamp(50 + 6 * (options.styleStrength ?? 0.8), 0, 100, 50)),
    },
  })
  push({
    layer: 'L2',
    label: '08 分离色调·暗部',
    note: '暗部用亮度限定器分离后加冷/暖色，不污染中间调与高光',
    tool: TOOL_OF_NODE.splitTone,
    params: {
      space: 'ui',
      lumaQualifier: { lumLow: 0, lumHigh: 38, lumLowSoft: 6, lumHighSoft: 12 },
      gain: { r: round(1 - 0.01), g: round(1 + 0.005), b: round(1 + 0.02), master: 1 },
      saturation: round(clamp(51, 0, 100, 50)),
    },
  })
  push({
    layer: 'L2',
    label: '09 分离色调·高光',
    note: '高光用亮度限定器分离后加暖/冷色（青橙里的暖高光就在这一节点）',
    tool: TOOL_OF_NODE.splitTone,
    params: {
      space: 'ui',
      lumaQualifier: { lumLow: 62, lumHigh: 100, lumLowSoft: 14, lumHighSoft: 4 },
      gain: { r: round(1 + 0.015), g: round(1 - 0.005), b: round(1 + 0.005), master: 1 },
      saturation: round(clamp(53, 0, 100, 50)),
    },
    note: '分离色调拆成两个节点（暗部/高光各一个）：单节点混在一起无法判断是谁在起作用',
  })

  // ---------------------------------------------------------------- L3
  const skin = options.shot?.layers?.skin ?? null
  const bg = options.shot?.layers?.background ?? null
  // 肤色选区只算一次：保护（#10）与提亮（#12）必须用同一份色相窗口
  const skinHue = round(clamp(skin?.meanHuePercent ?? 6, 0, 100, 6))
  const skinKnown = Number.isFinite(Number(skin?.meanHuePercent))
  const skinQualifier = {
    hueCenter: skinHue,
    hueWidth: 20,
    hueSoft: 10,
    hueSymmetry: 50,
    satLow: 12,
    satHigh: 85,
    satLowSoft: 6,
    satHighSoft: 8,
    lumLow: 18,
    lumHigh: 88,
    lumLowSoft: 8,
    lumHighSoft: 8,
  }
  push({
    layer: 'L3',
    label: '10 肤色键·保护',
    tool: TOOL_OF_NODE.skinKey,
    params: {
      space: 'ui',
      qualifier: { ...skinQualifier },
      saturation: round(clamp(49, 0, 100, 50)),
      gain: { r: 1, g: 1, b: 1, master: round(1.005) },
    },
    note: '肤色保护单独一节，避免后面的风格化把肤色带跑',
  })
  push({
    layer: 'L3',
    label: '11 背景键·分离',
    tool: TOOL_OF_NODE.bgKey,
    params: {
      space: 'ui',
      qualifier: {
        hueCenter: round(clamp(bg?.meanHuePercent ?? 60, 0, 100, 60)),
        hueWidth: 30,
        hueSoft: 16,
        hueSymmetry: 50,
        satLow: 8,
        satHigh: 100,
        satLowSoft: 4,
        satHighSoft: 8,
        lumLow: 0,
        lumHigh: 92,
        lumLowSoft: 6,
        lumHighSoft: 10,
      },
      gain: { r: round(1 - 0.006), g: 1, b: round(1 + 0.008), master: 1 },
      saturation: round(clamp(48, 0, 100, 50)),
    },
    note: '背景单独键控调节，而不是和暗部/高光混在一个节点里',
  })
  // 14/15：肤色提亮、背景冷色偏移——把「键」和「调」拆开，避免一个节点混用途
  push({
    layer: 'L3',
    label: '12 肤色提亮',
    tool: TOOL_OF_NODE.skinKey,
    params: {
      space: 'ui',
      // 与 #10 共用同一份选区（同色相窗口）；没有可靠肤色样本时保持中性，不做局部提亮
      gain: skinKnown ? { r: 1.02, g: 1.015, b: 1.0 } : { r: 1, g: 1, b: 1, master: 1 },
      qualifier: { ...skinQualifier, hueWidth: 24, hueSoft: 12, satLow: 14, satHigh: 90 },
      matteFinesse: { denoise: 4, blackClip: 3, whiteClip: 3, blur: 3 },
    },
    note: skinKnown ? '只提亮肤色（与 #10 同色相窗口），不动整体曝光' : '没有可靠肤色样本：跳过局部提亮（保持中性，避免误选暖色区域）',
  })
  push({
    layer: 'L3',
    label: '13 背景冷色偏移',
    tool: TOOL_OF_NODE.bgKey,
    params: {
      space: 'ui',
      gain: { r: 0.995, g: 1.0, b: 1.015 },
      qualifier: { hueCenter: 55, hueWidth: 28, hueSoft: 12, hueSymmetry: 50, satLow: 10, satHigh: 85, lumLow: 8, lumHigh: 70 },
      matteFinesse: { denoise: 4, blackClip: 3, whiteClip: 3, blur: 4 },
    },
    note: '背景/阴影往冷色推（键控），和肤色节点分开，便于单独开关对比',
  })
  const look = options.look ?? null
  push({
    layer: 'L3',
    label: '14 风格 LUT',
    tool: TOOL_OF_NODE.lookLut,
    params: { space: 'ui' },
    note: look
      ? `独立节点挂「${look.preset}」LUT（强度 ${look.strength ?? 0.32}）：LUT 单独一节，方便整体开关对比`
      : '风格 LUT 独立节点（未指定 look 时留空，便于后续用 style.apply 写 LUT）',
  })
  const texture = options.texture ?? null
  push({
    layer: 'L3',
    label: '15 质感（颗粒/光晕）',
    tool: TOOL_OF_NODE.texture,
    params: { space: 'ui' },
    note: texture
      ? `质感计划：halation ${texture.halation?.strength ?? '-'}、glow ${texture.glow?.strength ?? '-'}、grain ${texture.grain?.amount ?? '-'}（本机通过渲染后处理实现，Color 页无对应 OFX 节点）`
      : '质感节点：颗粒/光晕在本机由渲染后处理实现（Resolve 脚本 API 无 OFX 写入口）',
  })

  // 15 个节点全部参与渲染：不再插入空的「分隔节点」
  const recipe = options.recipe ?? null
  if (recipe) {
    // 逐组参数写入：只改对应工具节点上真实存在的字段，保持其它字段（含 master/qualifier）不动。
    const byTool = (tool, index = 0) => nodes.filter((node) => node.tool === tool)[index]
    const patch = (node, changes) => { if (node) node.params = { ...node.params, ...changes } }
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

    // ① 白平衡：gain 每通道（保留 master）
    if (recipe.warmth != null) {
      const node = byTool('balance')
      const w = num(recipe.warmth, 0)
      patch(node, { gain: { ...(node?.params?.gain ?? {}), r: 1 + w, g: 1, b: 1 - w * 0.5, master: 1 } })
    }
    // ② 曝光：exposure 节点是 gain 型（1 = 不变），不是 offset
    if (recipe.exposure != null) {
      const node = byTool('exposure')
      const e = 1 + num(recipe.exposure, 0)
      patch(node, { gain: { r: e, g: e, b: e, master: e } })
    }
    // ③ 对比/黑位：contrast 节点字段是 contrast / lift{r,g,b,master} / pivot
    const contrastNode = byTool('contrast')
    const contrastChanges = {}
    if (recipe.contrast != null) contrastChanges.contrast = num(recipe.contrast, 1)
    if (recipe.lift != null) {
      const l = num(recipe.lift, 0)
      contrastChanges.lift = { r: l, g: l, b: l, master: l }
    }
    patch(contrastNode, contrastChanges)
    // ④ 曲线：只有显式给了点集才动（前面就是这里用错结构把画面洗灰的）
    if (Array.isArray(recipe.curvePoints) && recipe.curvePoints.length >= 2) {
      patch(byTool('curve'), { customCurves: { luminance: recipe.curvePoints } })
    }
    // ⑤ 色相：number
    if (recipe.hue != null) patch(byTool('hue'), { hueShift: num(recipe.hue, 0) })
    // ⑥ 饱和度：number（0–100），不是 {r,g,b}
    if (recipe.saturation != null) patch(byTool('saturation'), { saturation: 50 * num(recipe.saturation, 1) })
    // ⑦ 分离色调：gain{r,g,b,master}（暗部/高光各一个节点）
    const splits = nodes.filter((node) => node.tool === 'splitTone')
    if (recipe.splitShadow) patch(splits[0], { gain: { ...recipe.splitShadow, master: 1 } })
    if (recipe.splitHighlight) patch(splits[1], { gain: { ...recipe.splitHighlight, master: 1 } })
    // ⑧ 肤色提亮 / 背景偏移：gain 型（键控由节点内限定器产生）
    const skins = nodes.filter((node) => node.tool === 'skinKey')
    if (recipe.skinGain != null && skinKnown) {
      const g = num(recipe.skinGain, 1)
      patch(skins[1], { gain: { r: g, g: g, b: g, master: g } })
    }
    const bgs = nodes.filter((node) => node.tool === 'bgKey')
    if (recipe.bgCool != null) {
      const c = num(recipe.bgCool, 1)
      patch(bgs[1], { gain: { r: 1, g: 1, b: c, master: 1 } })
    }
  }
  const finalNodes = nodes
  const layers = LAYERS.map((layer) => ({
    ...layer,
    nodes: finalNodes.filter((node) => node.layer === layer.id && node.tool !== 'separator').map((node) => ({ id: node.id, label: node.label, tool: node.tool })),
    separators: [],
  }))
  return {
    ok: true,
    nodeCount: finalNodes.length,
    layerCount: layers.length,
    nodes: finalNodes,
    layers,
    routing: {
      type: 'serial',
      arrows: 'Color 页节点之间是绿色箭头（RGB 图像串联）；键信号（蓝）在 qualifier 节点内部产生，脚本无法另画',
      note: '并行混合器/图层混合器/键混合器/分离器/结合器属于 Fusion 节点，Resolve 脚本 API 只能建串联 Color 节点（见 docs/advanced-color-api.md §5.3）',
    },
  }
}

/** 转成 drx.generate/merge 需要的节点数组（第一个作为 base，其余 newNodes）。 */
export function toDrxNodes(graph) {
  const nodes = graph.nodes
  const base = nodes[0]
  // 三层分行排布（LAYOUT 常量，实测校准：横向 495 才不会叠住，行距 320）
  const rowCounter = { L1: 0, L2: 0, L3: 0 }
  const positionOf = (node) => {
    const row = node.layer ?? 'L1'
    const index = rowCounter[row] ?? 0
    rowCounter[row] = index + 1
    return { xPos: LAYOUT.ROW_X[row] + index * LAYOUT.SPACING_X, yPos: LAYOUT.ROW_Y[row] }
  }
  return {
    base: { label: `L1 · ${base.label}`, params: base.params, ...positionOf(base) },
    newNodes: nodes.slice(1).map((node) => ({
      label: node.tool === 'separator' ? node.label : `${node.layer} · ${node.label}`,
      params: node.params,
      enabled: node.enabled !== false,
      ...positionOf(node),
    })),
    lookNodeIndex: nodes.findIndex((node) => node.tool === 'lookLut') + 1,
    textureNodeIndex: nodes.findIndex((node) => node.tool === 'texture') + 1,
  }
}
