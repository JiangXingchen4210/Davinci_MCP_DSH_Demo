# 04 — merge / parse 的数据边界与坑（摘录）

## 1. `mergeNodes` 只搬 parser 的 `node.params`（`M:108-203`）

```js
function mergeNodes(existingNodes, newNodes, options = {}) {
  const combinedNodes = [];
  for (const existingNode of existingNodes) {
    const node = {
      id: originalId,                         // 保留原 NodeId
      label,
      xPos: existingNode.xPos || currentX,
      yPos: existingNode.yPos || baseY,
      enabled: existingNode.enabled !== false,
      params: existingNode.params || buildDefaultNodeParams(),   // ⚠️ 只有主调色
    };
    combinedNodes.push(node);
  }
  // 新节点 id 从 maxId+1 递增
  for (const newNode of newNodes) {
    combinedNodes.push({ id: nextId++, label, xPos: currentX, yPos,
                         enabled: newNode.enabled !== false, params: newNode.params });
  }
  combinedNodes.sort((a, b) => a.id - b.id);
  // 串联连接
  for (let i = 0; i < nodeIds.length - 1; i++)
    connections.push({ from: nodeIds[i], to: nodeIds[i + 1] });
  return { nodes: combinedNodes, connections, firstNodeId, lastNodeId, baseNodeId };
}
```

而 parser 给出的 `node.params` 只有主调色（`P:625-640`）：

```js
params: {
  lift: { r: 0, g: 0, b: 0, master: 0 },
  gamma: { r: 0, g: 0, b: 0, master: 0 },
  gain: { r: 1, g: 1, b: 1, master: 1 },
  offset: { r: 0, g: 0, b: 0 },
  saturation: 50,          // Resolve Primaries: 0-100, unity=50 ← 注意这里语义混杂
  contrast: 1.0,
  pivot: 0.435,
}
```

`generateMergedDRX` 再把这些值交给 `generateMultiNodeDRX` 重新编码
（`M:213-273`，`G:1769-1900`），于是：

| 已有节点里的内容 | merge 后 | 实测证据 |
|---|---|---|
| lift/gamma/gain/offset/contrast/pivot | ✅ 保留（原样透传） | `base gain after merge` 与 base 一致 |
| **saturation** | ❌ **被 ÷50 二次缩放** | base UI 55 → parse 1.1 → merge 后 0.022 |
| **HSL/RGB/luma qualifier** | ❌ **丢失**（只剩 companion 的 mode:0） | base qualifier → `{"mode":0}` |
| **powerWindow / 曲线 / HDR / matte / blur / OFX** | ❌ **丢失** | 同因：不在 node.params |

新节点不受影响：`normalizeNewNode` + `normalizeGradeParams` 走与 `generate` 相同的空间换算
（`S/tools/drx.mjs:596-611`、`:477-594`）。

## 2. `parse` 的 `_raw` 体积（`P:959-1035`）

```js
const result = {
  label, width, height, sourceTimeline, recordTC, sourceTC,
  pTrackVerXml,
  nodes,
  connections,
  metadata,
  _raw: parsed,          // ⚠️ 完整递归 protobuf
};
```

实时 MCP 实测：一个单节点 grade 的 `parse` 结果被截断提示
`(Omitted 1841303 bytes)` —— **1.8MB**。插件要裁字段（正文 §3.1 有模板）。

## 3. `toolBreakdown` 计算错误（`S/tools/drx.mjs:716` vs `P:1236/1355`）

```js
// 工具层（错误调用）：
const toolBreakdown = drxParser().extractToolBreakdown
  ? drxParser().extractToolBreakdown(result.nodes)   // ← 传的是数组
  : undefined;

// 期望入参（P:1236）：
function extractToolBreakdown(params) {
  if (!params) return { /* defaults */ };
  const breakdown = { gain: { r: params.gain?.r ?? 1, ... }, ... };
}

// 正确的封装（P:1355，但未被工具层使用）：
function extractToolBreakdownFromDRX(parsedDRX) { /* 合并所有 node.params 后再 extractToolBreakdown */ }
```

实测：`toolBreakdown` 恒为
`{gain:{1,1,1,1}, saturation:50, activeTools:[], summary:""}`，即使 grade 明显有 gain/contrast。
→ 不要用；自己读 `nodes[].correctors[].parameters` / `nodes[].params`。

## 4. 节点图 / 连接 / 标记结构（`G:1658-1760`、`P:608-880`）

- `generateProtobuf`：`F1`=版本（=lastNodeId）、`F2`=1、`F3`=resolution、`F7[]`=节点、
  `F9.F1[]`=connections、input/output 标记、`F11=1`、`F12`=timestamp。
- 根级 `F3` 是节点图视图元数据（F4/F5 位置、F8=84）。
- 多节点：连接 `createConnection(i, i+1, i)`（`G:1836-1846`），纯串联。
- parse 出的 connection：`{from,to,sourcePort:64,targetPort:64,index:3}`。
- 节点字段：`F1`=NodeId、`F2`=NodeIndex、`F4/F5`=x/y、`F6`=label、`F7`=enabled、
  `F15`=ClipColor（parse 出 `color`）。
- **没有 Layer 字段**；Layer 只是 live API 的 `GetNodeGraph(layer_index)` 概念
  （`PY:29693-29697`）。vendor 里的 `createParallelNodes`（`G:3102`）/
  `createLayerMixer`（`G:3194`）/`createOutsideNode`（`G:3288`）**没有任何 MCP action 可达**。

## 5. `extractQualifier` 的 companion-block 干扰（`V/drx-codec/extract-qualifier.js:66-94`）

```js
for (const param of parameters) {
  if (PARAM_TO_KEY.has(param.id)) { if (out[key] === undefined) out[key] = drxToUi(param.value); ... }
  else if (param.id === HSL_QUALIFIER.MODE_FLAG)      out.modeFlag = varintToNumber(param.value);
  else if (param.id === HSL_QUALIFIER.QUALIFIER_MODE) out.mode     = varintToNumber(param.value);
}
```

因为 `node.correctors` 展开后参数顺序是「主调色 → companion(ct2, mode=0) → qualifier(ct2, mode=真实)」，
`out.mode` 取到第一个 0。实测 RGB/luma qualifier 的 `parse.qualifier.mode` 都是 0，
但原始 `correctors[].parameters` 里能看到两个 `qualifier.mode`（0 与 2/4）。

另外 companion 块让 `verify_grade` 在普通 grade 上报
`unverifiableParams: ["qualifier.mode"]`（实测），不影响 verdict。
