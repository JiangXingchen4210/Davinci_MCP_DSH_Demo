# 03 — 生成器：节点编排 / qualifier / window / 曲线（摘录）

源码：`V/drx-codec/drx-generator.js`（行号为原始行号）。

## 1. `createNode` 的 corrector 编排（`G:550-940`，节选）

```js
function createNode(nodeId, xPos, yPos, colorParams = null, options = {}) {
  const { label = '', enabled = true, nodeIndex = nodeId, resolveVersion } = options;

  const parts = [
    protoVarint(1, nodeId),       // F1: NodeId（唯一）
    protoVarint(2, nodeIndex),    // F2: NodeIndex（1..N 顺序号）
    protoVarint(4, xPos),         // F4
    protoVarint(5, yPos),         // F5
  ];
  if (label) parts.push(protoBytes(6, Buffer.from(label, 'utf-8')));   // F6 标签（provenance）
  parts.push(protoVarint(7, enabled ? 1 : 0));                          // F7 启用
  parts.push(protoVarint(8, 44));                                       // F8

  // … Type 1 Primary(lift/gamma/gain/offset/sat/contrast/curves/HDR) …
  // … Type 2 Contrast（总有一个 F1 块）…
  // … 非曲线 grade 的 companion 块：ct2 + 0x88300001={F2:0}（:702-715）…
  // … Type 3 satVsSat / Type 4 hue / Type 5 lumMix …

  // 次级：一个节点只有一个 qualifier，优先级 HSL > RGB > luma（:742-749）
  let qualParams = buildQualifierParams(colorParams.qualifier);
  if (qualParams.length === 0) qualParams = buildRGBQualifierParams(colorParams.rgbQualifier);
  if (qualParams.length === 0) qualParams = buildLumaQualifierParams(colorParams.lumaQualifier);
  if (qualParams.length > 0) correctorBlocks.push(buildCorrectorBlock(CORRECTOR_TYPES.QUALIFIER, qualParams));

  // 窗口（:752-772）
  const win = buildWindowParams(colorParams.window, { resolveVersion });
  if (win.transform.length > 0) {
    correctorBlocks.push(buildCorrectorBlock(win.transformType, win.transform));
    if (win.transformType !== CORRECTOR_TYPES.POWER_WINDOW && presenceTypes.length > 0)
      presenceTypes.push(win.transformType);
  }
  if (win.softMask.length > 0)  correctorBlocks.push(buildCorrectorBlock(CORRECTOR_TYPES.WINDOW_SOFTNESS, win.softMask)); // ct3
  if (win.gradient.length > 0)  correctorBlocks.push(buildCorrectorBlock(CORRECTOR_TYPES.GRADIENT_WINDOW, win.gradient)); // ct65554
  if (win.shape.length > 0)     correctorBlocks.push(buildCorrectorBlock(6, win.shape));                                   // ct6
  // … matteFinesse/key(ct9) / blur(ct1) / motionEffects(ct15) / ofx(F10) …
```

**窗口形状=哪些 corrector 块存在**（`G:2853-2866` 注释）：circle=ct4；linear=ct4+ct3；
gradient=ct65554；polygon/curve=ct6 顶点环。`0x88500008` 只是常量 `{F2:2}`，不区分形状。

## 2. HSL qualifier builder（`G:2660-2712`）

```js
function buildQualifierParams(qualifierParams) {
  const paramEntries = [];
  const { HSL_QUALIFIER } = drxParams;
  if (!qualifierParams) return paramEntries;
  const q = qualifierParams;
  const add = (id, val) => { if (val !== undefined) paramEntries.push(createParameterEntry(id, val / 100)); };
  // Hue
  add(HSL_QUALIFIER.HUE_CENTER, q.hueCenter);
  add(HSL_QUALIFIER.HUE_WIDTH,  q.hueWidth);
  add(HSL_QUALIFIER.HUE_SYM,    q.hueSymmetry !== undefined ? q.hueSymmetry
                                    : (q.hueCenter !== undefined ? 50 : undefined));
  add(HSL_QUALIFIER.HUE_SOFT,   q.hueSoft);
  // Saturation
  add(HSL_QUALIFIER.SAT_HIGH, q.satHigh); add(HSL_QUALIFIER.SAT_LOW, q.satLow);
  add(HSL_QUALIFIER.SAT_HIGH_SOFT, q.satHighSoft); add(HSL_QUALIFIER.SAT_LOW_SOFT, q.satLowSoft);
  // Luminance
  add(HSL_QUALIFIER.LUM_HIGH, q.lumHigh); add(HSL_QUALIFIER.LUM_LOW, q.lumLow);
  add(HSL_QUALIFIER.LUM_HIGH_SOFT, q.lumHighSoft); add(HSL_QUALIFIER.LUM_LOW_SOFT, q.lumLowSoft);
  // 重复 hue 参数（Resolve 自己也存）
  if (q.hueWidth !== undefined) add(HSL_QUALIFIER.HUE_WIDTH_DUP, q.hueWidth);
  if (q.hueSoft  !== undefined) add(HSL_QUALIFIER.HUE_SOFT_DUP,  q.hueSoft);
  // 模式 flag：两个都是 varint envelope
  if (paramEntries.length > 0) {
    paramEntries.push(createVarintParameterEntry(HSL_QUALIFIER.MODE_FLAG, 4));
    paramEntries.push(createVarintParameterEntry(HSL_QUALIFIER.QUALIFIER_MODE, 0)); // HSL
  }
  return paramEntries;
}
```

→ **所有值 ÷100**：输入是 UI 0–100。live 校准回读 “Center 33.1/Width 22/Soft 11/Sat 12–88/
Lum 20–80 exact”（`V/drx-parameters/CALIBRATION-STATUS.md:67`）。

RGB（`G:2729-2781`）：12 个 `RGB_*` 阈值，`QUALIFIER_MODE=2`。
luma（`G:2783-2818`）：`LUM_*` 4 个，`QUALIFIER_MODE=4`。

## 3. 圆形/线性/gradient 窗口（`G:2838-2985`，节选）

```js
function buildWindowParams(windowParams, { resolveVersion } = {}) {
  const groups = { transform: [], transformType: CORRECTOR_TYPES.POWER_WINDOW,
                   softMask: [], gradient: [], shape: [] };
  const { POWER_WINDOWS } = drxParams;
  if (!windowParams || windowParams.type === 0) return groups;
  const w = windowParams;

  // 形状不由 0x88500008 决定（它恒为 {F2:2}）
  if (w.type !== undefined && w.type !== 5 && !(w.type === 3 || w.type === 4))
    groups.transform.push(createVarintParameterEntry(POWER_WINDOWS.WINDOW_TYPE, 2));

  const isGradient = w.type === 5;
  const isLinear = w.type === 2;
  const isVertexShape = (w.type === 3 || w.type === 4) && Array.isArray(w.vertices) && w.vertices.length >= 3;

  if (isVertexShape) { /* ct6 顶点环：首角×2、其余×3、闭合首角×2；坐标=帧像素、相对中心 */ }

  if (isGradient) {
    // gradient 全部在 ct65554；只有 ROTATION / HANDLE_1_POS / HANDLE_2_POS / SOFTNESS / OPACITY
    g.push(createVarintParameterEntry(GW.TYPE, 2));
    if (w.rotate) g.push(createParameterEntry(GW.ROTATION, -w.rotate / 180));
    if (w.pan !== 50)  g.push(createParameterEntry(GW.HANDLE_1_POS, ((w.pan - 50) / 50) * 4096));
    if (w.tilt !== 50) g.push(createParameterEntry(GW.HANDLE_2_POS, ((w.tilt - 50) / 50) * 4096));
    if (w.soft1) g.push(createParameterEntry(GW.SOFTNESS, w.soft1 * 100));
    if (w.opacity !== 100) g.push(createParameterEntry(GW.OPACITY, w.opacity / 100));
    return groups;
  }

  // 真实换算（live 多点拟合）：
  // rotate = −UI/180 · size = 1+(UI−50)×0.08 · aspect = (50−UI)/50
  // pan/tilt = (UI−50)/50 × 4096（帧像素）· soft = UI×16（gradient soft=UI×100）
  if (w.rotate) paramEntries.push(createParameterEntry(POWER_WINDOWS.ROTATE, -w.rotate / 180));
  if (w.size !== 50) paramEntries.push(createParameterEntry(POWER_WINDOWS.SIZE, 1 + (w.size - 50) * 0.08));
  if (w.aspect !== 50) paramEntries.push(createParameterEntry(POWER_WINDOWS.ASPECT, (50 - w.aspect) / 50));
  if (w.pan !== 50) paramEntries.push(createParameterEntry(POWER_WINDOWS.PAN, ((w.pan - 50) / 50) * 4096));
  if (w.tilt !== 50) paramEntries.push(createParameterEntry(POWER_WINDOWS.TILT, ((w.tilt - 50) / 50) * 4096));
  if (w.opacity !== 100) paramEntries.push(createParameterEntry(POWER_WINDOWS.OPACITY, w.opacity / 100));

  if (isLinear) { /* Soft1..4 → ct3 软边，UI×16 */ }
  else if (w.soft1) paramEntries.push(createParameterEntry(POWER_WINDOWS.SOFT_REF, w.soft1 * 16));

  if (isResolve21(resolveVersion) && !isVertexShape && paramEntries.length > 0) {
    groups.transform = toResolve21WindowTransform(paramEntries);   // 0x10004 形式
    groups.transformType = CORRECTOR_TYPE_WINDOW_R21;
  }
  return groups;
}
```

R21 说明（`G:2986-3000`）：Resolve 21 把 circle/linear 窗口存成 corrector type `0x10004` +
完整参数集；旧的 type 4 形式在 R21 上“加载但渲染空遮罩，并遮掉该节点的 grade”。所以 21.x
必须传 `resolveVersion:21+`。

## 4. 自定义曲线 / HSL 曲线输入（`G:455-538`）

```js
// customCurves = { y:[{x,y}], r, g, b }；未给的通道写恒等（Resolve 总是写 4 条）
// x/y 归一化 0..1（内部缩到 0..1023）
// hslCurves = { hueVsHue,hueVsSat,hueVsLum,lumVsSat,satVsSat,satVsLum: [{x,y}] }
// HSL 用 raw float 空间：X=hue 比例(0..1, wrap)，Y=值(0.5=中性)
// hslCurveMeta 可逐曲线覆盖 meta（live fixture: hueVsHue 0, hueVsSat 2, satVsSat 2）
```

hue 轴曲线必须规范笼形，否则 Resolve 静默忽略（见正文 §5.8；canonicalizer 在
`S/tools/drx.mjs:345-474`）。

## 5. `space` 换算常数（`S/tools/drx.mjs:314-328`）

```js
const WHEEL_MASTER_DEFAULT = { lift: 0, gamma: 0, offset: 0, gain: 1 };
const UI_TO_DRX = { lift: 2, gamma: 4, gain: 1, offset: 0.04 };
// 另有：saturation、softClip*Soft 在 drx 空间 ×50（抵消 encoder 的 ÷50）；
// hueRotate: UI = 50 + 50×raw；contrastHighRange: UI = 1 − raw；colorSlice.hue 取负。
```

## 6. 面板单位 vs 参数范围表（`V/drx-parameters/parameter-ranges.js:262-320`）

```js
qualifier: {
  hueCenter: { min: 0, max: 360, default: 0, unit: '°' },   // ⚠️ 过期：encoder 是 ÷100，见正文 §5.6
  hueWidth:  { min: 0, max: 180, default: 30, unit: '°' },  // ⚠️ 同上
  hueSoft:   { min: 0, max: 100, default: 10 },
  satLow:    { min: 0, max: 100, default: 0 },
  satHigh:   { min: 0, max: 100, default: 100 },
  satLowSoft:{ min: 0, max: 100, default: 0 },
  satHighSoft:{min: 0, max: 100, default: 0 },
  lumLow:    { min: 0, max: 100, default: 0 },
  lumHigh:   { min: 0, max: 100, default: 100 },
  lumLowSoft:{ min: 0, max: 100, default: 0 },
  lumHighSoft:{min: 0, max: 100, default: 0 },
  hueSymmetry:{ min: 0.0, max: 1.0, default: 0.5, note: 'DRX = UI/100' },
},
```
