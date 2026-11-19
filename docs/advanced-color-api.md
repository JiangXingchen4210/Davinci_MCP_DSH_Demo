# resolve_advanced MCP 色彩工具 API 契约（深度色调匹配用）

> 目标读者：`resolve-console` 插件的 Host 半边（`index.js`）作者。
> 本文是「写代码可直接照抄」的契约：每个 action 的参数名/类型/必填/范围/单位、精确返回字段、
> 源码 `file:line`，以及**实测验证过**的多层节点图写法与落地/验证链路。
>
> 调研基线（本机实测，2026-11-13）：
> - 高级服务器：`$HOME/Library/Application Support/davinci-resolve-mcp/resolve-advanced/`
>   由 `bin/davinci-resolve-advanced-mcp.mjs` 启动，profile 配置见
>   `~/.dsh/profiles/web/cordis.patch.yml:60-75`（`serverName: resolve_advanced`，`command: node`）。
> - 工具在模型侧的名字：`mcp__resolve_advanced__drx`、`mcp__resolve_advanced__drp` 等。
> - 实时服务器（Python）：`davinci-resolve-mcp/src/server.py`，工具名 `mcp__resolve__*`。
> - 所有色彩计算类 action **完全离线**（不需要 Resolve 运行），产出的是磁盘上的 `.drx`
>   或测量 JSON；**落地到 Resolve 是另一个服务器的事**（`timeline_item_color.safe_apply_drx`）。
>
> ⚠️ 三个会直接决定插件能不能跑通的事实，先看这里：
> 1. **`sharp` 未安装**（`resolve-advanced/node_modules` 里没有）。因此 `scope_read`、
>    `skin_match`、`shot_match`、`white_balance_match`、`contrast_normalize`、`match_to_reference`、
>    `saturation_match`、`black_balance`、`tone_curve_transfer`、`level_clips`、`gamut_legal`、
>    `intent_tags` 全部会抛 `... needs the optional dep 'sharp'`。已用实时 MCP 实测确认
>    （见 §8）。`drx.generate/merge/parse/verify_grade/relayout/lut_apply/grade_transfer/cdl_io/
>    extract_frames` 不需要 sharp，可以正常用。
> 2. **`drx.generate` 只能生成单节点**；多层节点图必须走 `generate` + `merge`（或 `merge` 到已有
>    `.drx`），本文 §4.3 给出实测通过的四层写法，以及两个**必须避开**的 merge 数据损坏坑。
> 3. **`drx.parse` 返回里带 `_raw`（完整 protobuf 树）**，一个单节点 grade 就能到 ~1.8MB。
>    插件绝不能把 parse 原样转发给面板/模型，只挑 `nodes`、`valueFidelity` 等字段（§3.1 有裁字段模板）。

---

## 目录

1. [调用约定](#1-调用约定)
2. [色彩证据读取：scope_read（含 ROI）](#2-色彩证据读取scope_read含-roi)
3. [动作清单与 `drx.parse` 契约](#3-动作清单与-drxparse-契约)
4. [匹配器家族（7 个 + 相关）：输入/输出/是否生成 .drx](#4-匹配器家族7-个--相关输入输出是否生成-drx)
5. [drx.generate 完整 schema 与多层节点图](#5-drxgenerate-完整-schema-与多层节点图)
6. [落地与验证：safe_apply_drx / verify_grade / 视觉复核](#6-落地与验证)
7. [3 条推荐调用序列](#7-3-条推荐调用序列)
8. [实测记录与陷阱清单](#8-实测记录与陷阱清单)
9. [源码索引（file:line）](#9-源码索引fileline)

---

## 1. 调用约定

### 1.1 两个服务器、两种参数形状

| 服务器 | 工具名形态 | 参数形状 | 例子 |
|---|---|---|---|
| Python（live） | `mcp__resolve__<tool>` | 扁平：`{action, ...参数}` | `timeline_item_color {action:'safe_apply_drx', path, source, ...}` |
| Node（offline） | `mcp__resolve_advanced__<tool>` | 嵌套：`{action, args:{...}}` | `drx {action:'generate', args:{gradeParams, outputPath}}` |

`resolve-console/host-base.mjs` 已有 `callTool(ctx, base, args, signal)`（`host-base.mjs:112-149`），
它用 `resolveToolName` 按后缀发现工具并**优先 `mcp__resolve__`**（`host-base.mjs:68-80`）。
（`index.js` 现在是 21 行的薄入口，动态 import `host-impl.mjs`；业务 helper 在 `host-base.mjs`。）
对高级工具没有同名 Python 工具，所以 `callTool(ctx, 'drx', { action, args })` 会落到
`mcp__resolve_advanced__drx`。注意 Python 工具是扁平参数、高级工具是 `{action, args}`，
**同一个 `callTool` 调用时 payload 形状不同**：

```js
// 高级服务器（offline）—— 必须嵌套 args
await callTool(ctx, 'drx', {
  action: 'scope_read',
  args: { png: '/tmp/evidence/shot1.png', rect: { x: 0.35, y: 0.2, w: 0.3, h: 0.4 } },
}, signal)

// Python 服务器（live）—— 参数平铺
await callTool(ctx, 'timeline_item_color', {
  action: 'safe_apply_drx', path: '/tmp/look.drx', source: 'item',
  timeline_item_id: itemId, grade_mode: 0,
}, signal)
```

### 1.2 错误与返回值

- 高级服务器：成功返回普通 JSON；失败时 MCP `isError=true`，文本形如
  `{"error": "..."}`（`resolve-advanced/server/index.mjs:112-115`）。`callTool` 已把它转成
  `Error`。
- Python 服务器：业务失败也可能是**正常返回值** `{error:{message,code,category,...}}`；
  `callTool` 会转异常并保留 `error.mcpValue`（`host-base.mjs:136-147`）。`confirm_token`
  流程就靠这个字段（`host-base.mjs:365-385` 的 `opResetGrade` 是现成范式）。

### 1.3 建议：所有 .drx 落到系统临时目录

Python 的 `safe_apply_drx` 默认 `require_temp_path=true`，**只接受系统临时目录下的路径**
（`src/server.py:22010-22022`：`tempfile.gettempdir()`、`/private/tmp`、`/tmp`）。
所以约定插件统一用 `/tmp/davinci-panel/…`（macOS）作为 `.drx` 与抽帧的根目录：

```
/tmp/davinci-panel/
  evidence/<clipId>.png
  grades/<clipId>_skin.drx
  looks/<name>_v1.drx
  readback/show.drp
```

否则调用方要显式 `require_temp_path:false`。

---

## 2. 色彩证据读取：scope_read（含 ROI）

源码：`resolve-advanced/server/scope-read.mjs`；工具分派 `server/tools/drx.mjs:955-960`。

### 2.1 参数（`scopeReadSchema`，`drx.mjs:206-210`）

| 参数 | 类型 | 必填 | 范围/单位 | 说明 |
|---|---|---|---|---|
| `png` | string | ✅ | 磁盘路径 | **display-referred** PNG（Rec.709/sRGB）。LOG/场景参考帧会得到无意义读数（代码注释 `scope-read.mjs:14-19`） |
| `rect` | {x,y,w,h} | ❌ | **比例 0..1**（不是像素） | 测量区域 ROI；`x,y` 左上角，`w,h` 宽高。会先 crop 再降采样（`scope-read.mjs:86-95`） |
| `satBins` | number | ❌ | 整数，默认 16 | 饱和度直方图桶数 |

**ROI 结论：支持，且是真裁剪。** `readPixels` 用 `sharp().metadata()` 取 W/H，把 `rect`
换算成像素后 `.extract({left,top,width,height})`，再 `resize(maxSide=480, fit:'inside',
kernel:'nearest')`（`scope-read.mjs:81-101`）。ROI 之外的像素完全不参与统计。

### 2.2 返回结构（精确字段，`scope-read.mjs:244-256`）

```jsonc
{
  "channels": {                      // 每通道统计，0..255（8-bit）
    "r": { "mean": 0, "min": 0, "max": 255, "p1": 0, "p50": 0, "p99": 0 },
    "g": { ... }, "b": { ... }        // mean 保留 3 位小数；p1/p50/p99 为 nearest-rank 百分位
  },
  "luma": { "mean": 0, "min": 0, "max": 255, "p1": 0, "p50": 0, "p99": 0 },  // Rec.709 权重 0.2126/0.7152/0.0722
  "parade": {                        // RGB parade 平衡（通道均值差，中性帧≈0）
    "rg": 0, "gb": 0, "rb": 0,       // r.mean-g.mean / g.mean-b.mean / r.mean-b.mean，3 位
    "spread": 0                      // max(channel means) - min(...)，3 位
  },
  "blackBalance": {                  // 黑平衡：p1 阴影点
    "r": 0, "g": 0, "b": 0,          // 各通道 p1（0..255 整数）
    "castSpread": 0                  // max(blacks)-min(blacks)，数值型
  },
  "skinLine": null,                  // 无肤色像素时为 null；否则：
  // { "angleDeg": 0, "distance": 0, "deviationDeg": 0, "skinFrac": 0 }
  //   angleDeg    = atan2(cr, cb) 角度（°），2 位
  //   distance    = hypot(cb, cr)，2 位
  //   deviationDeg= angleDeg - SKIN_LINE_DEG(123°)，2 位
  //   skinFrac    = nSkin/nTotal，4 位
  "satHistogram": [ /* satBins 个计数 */ ],
  "meanSat": 0,                      // HSV S 均值，4 位
  "clipPct": 0,                      // 任一通道 ==255 的像素百分比，3 位
  "crushPct": 0,                     // 任一通道 ==0 的像素百分比，3 位
  "signals": {                       // L1 确定性意图信号（供 intent_tags / UI 提示）
    "lumaMedian": 0,                 // luma.p50
    "contrastRange": 0,              // luma.p99 - luma.p1
    "meanSat": 0,
    "dominantHueDeg": -1,            // 12 桶饱和度加权质心（桶中心，°）；无色偏帧为 -1
    "hueConcentration": 0,           // 主色桶质量占比，3 位
    "chromaticFrac": 0,              // s>0.15 的像素比例，4 位
    "lowKey": false,                 // luma.p50<70 && p75<128
    "monochromatic": false,          // hueConcentration>=0.6 && meanSat>0.08
    "lowSaturation": false,          // meanSat<0.06
    "highContrast": false,           // contrastRange>200
    "lowContrast": false             // contrastRange<60
  },
  "nTotal": 0                        // 参与统计的像素数（降采样后）
}
```

要点：
- 皮肤线常数 `SKIN_LINE_DEG = 123`（`scope-read.mjs:45`），肤色分类器复用 `skin-match.mjs`
  的 `isSkin`（`scope-read.mjs:75`），与 `skin_match` 同一套判定（“什么是肤色”只有一个真源）。
- 百分位是 nearest-rank（`scope-read.mjs:36-40`），确定性、无随机。
- 失败语义：文件读不了返回 `null`，工具层抛
  `scope_read: unreadable frame '<png>' (skip-not-fake)`（`drx.mjs:958`）。

### 2.3 输入帧从哪来

`scope_read` 只要 PNG 路径。两个产出路径：

1. **`drx.extract_frames`（推荐，离线、无 Resolve）**
   - 参数（`drx.mjs:219-225`）：
     `clips: [{id, source, at?, proxy?, displayReferred?}]`、`outDir`、`displayReferred?`
     - `at`: 帧号 number | `'midpoint'`（默认）| `'HH:MM:SS:FF'`（`extract-frames.mjs:111-123`）
     - `proxy`: 显示参考代理/成片路径（优先于 `source`）
   - 返回（`extract-frames.mjs:195`）：`{ frames: { [id]: pngPath }, skipped:[{id,reason,transfer?}], warnings:[] }`
   - **硬拒绝 LOG**：ffprobe 报 log/场景参考 transfer，或 `'log'` 出现在流标签 → 跳过并在
     `skipped[].reason` 说明，不近似（`extract-frames.mjs:87-108`）；transfer 未知时须显式
     `displayReferred:true` 才放行。
   - 依赖 ffmpeg/ffprobe（本机 `/opt/homebrew/bin/ffmpeg` 存在 ✅）。
2. **Python `timeline_frame(action='capture')`**：适合给人/模型看，返回的是图片内容而不是
   文件路径，不能直接喂 `scope_read`（需要路径）。要做数值读数时走路径 1。

### 2.4 相关：`intent_tags`（同一套统计 → 意图标签）

- 参数（`drx.mjs:227-231`）：`png`(必填)、`rect?`、`meta?`（透传：`whiteBalanceK/tint/timeOfDay/gel/iso`）。
- 返回（`drx.mjs:972-978`）：`{ tags, signals(同 scope_read.signals), note }`。
- 用途：在 neutralize/level 之前排除“故意低调/单色/暖调”的镜头（`shot-intent.mjs`）。

---

## 3. 动作清单与 `drx.parse` 契约

`drx` 工具共 25 个 action（分派见 `server/tools/drx.mjs:687-987`）：

| action | 是否需要 sharp | 是否产出 .drx | 说明 |
|---|---|---|---|
| `parse` | ❌ | — | 解码 .drx 节点图/qualifier/curves/window/OFX |
| `generate` | ❌ | ✅ | 单节点 grade → .drx |
| `generate_from_request` | ❌ | ⚠️ 实际不可用（见 §8.4） | 自然语言 → .drx |
| `export_cdl` | ❌ | —（输出 CDL/CCC） | .drx/params → ASC CDL |
| `merge` | ❌ | ✅ | 在已有 .drx 上追加节点（多层图唯一路径） |
| `level_clips` | ✅ | ✅ | 同机位曝光/白平衡漂移对齐（catalog id `exposure_level`） |
| `skin_match` | ✅ | ✅ | 跨机位肤色统一 |
| `shot_match` | ✅ | ✅ | B-roll 统一（neutralize / hero） |
| `white_balance_match` | ✅ | ✅ | 已知中性块白平衡 |
| `contrast_normalize` | ✅ | ✅ | 黑白点仿射匹配 |
| `black_balance` | ✅ | ✅ | 阴影偏色（仅 offset） |
| `match_to_reference` | ✅ | ✅ | 参考帧 affine mean-std 迁移 |
| `saturation_match` | ✅ | ✅ | 饱和度统一 |
| `tone_curve_transfer` | ✅ | ✅ | 亮度 tone-curve（CDF 匹配） |
| `cdl_io` | ❌ | ✅ | 导入 ASC CDL → 每 correction 一个 .drx |
| `grade_transfer` | ❌ | ✅ | 无损 Body 拷贝 → apply-ready .drx |
| `author_look` / `carry_look` | ❌ | ✅ / 计划 | 版本化 look + 跨集携带计划 |
| `relayout` | ❌ | ✅ | 只改节点布局坐标（grade 字节保留） |
| `lut_apply` | ❌ | ✅ | 给节点挂 .cube LUT |
| `scope_read` | ✅ | — | 帧统计/ROI |
| `intent_tags` | ✅ | — | L1 意图标签 |
| `verify_grade` | ❌ | — | 预期 vs 实际 .drx 漂移判定 |
| `extract_frames` | ❌（需 ffmpeg） | — | display-referred 抽帧 |
| `gamut_legal` | ✅ | — | 广播合法/裁切 QC |

### 3.1 `parse`

参数（`drx.mjs:233-238`，`parseSchema`）：`drxPath?` | `content?`（二选一，zod refine）。

返回（`drx.mjs:688-718` + `drx-parser.js:959-1035`）：

```jsonc
{
  "label": "…", "width": 1920, "height": 1080,
  "sourceTimeline": "Timeline 1", "recordTC": "01:00:00:00", "sourceTC": "00:00:00:00",
  "pTrackVerXml": null,              // target:'timeline' 生成时非 null
  "nodes": [{
    "id": 1,                          // F1 NodeId（图内唯一）
    "index": 1,                       // F2 NodeIndex（1..N 顺序号，Resolve 节点序号）
    "xPos": 190, "yPos": 180,         // F4/F5 布局坐标（仅供 relayout/显示）
    "label": "AUTO:skin_match v2 → hero:CU_02 | gain(1.08,1.02,0.97)",
    "color": null,                    // ClipColorXxx 的颜色名（无则 null）
    "enabled": true,
    "keyframed": false,               // true = 动画节点，静态参数只是 frame-0 基准
    "correctors": [{                  // 每个 corrector 块
      "type": 1, "typeName": "Primary", "enabled": true,
      "parameters": [{ "id": 100663325, "value": 1.04, "name": "gain.r" }, ...]
    }],
    "params": {                       // 仅主调色（merge 只会带这部分！见 §5.5）
      "lift": {"r":0,"g":0,"b":0,"master":0},
      "gamma": {"r":0,"g":0,"b":0,"master":0},
      "gain": {"r":0,"g":0,"b":0,"master":0},
      "offset": {"r":0,"g":0,"b":0},
      "saturation": 50, "contrast": 1.0, "pivot": 0.435
    },
    "customCurves": null,             // {y,r,g,b:[{x,y}]} 解码后
    "hslCurves": null,                // {hueVsHue,…} 解码后
    "qualifier": null,                // HSL/RGB/luma qualifier 解码（见 §5.6 的坑）
    "powerWindow": null               // 圆形/线性/渐变窗解码
  }],
  "connections": [{ "from": 1, "to": 2, "sourcePort": 64, "targetPort": 64, "index": 3 }],
  "metadata": { "version": 16, "width": 1920, "height": 1080, "timestamp": 1794506589 },
  "_raw": { /* ⚠️ 完整 protobuf 树，单节点可达 ~1.8MB —— 不要转发 */ },
  "toolBreakdown": { /* ⚠️ 见下方警告，恒为默认值 */ },
  "valueFidelity": { "level": "calibrated-subset-only", "note": "…" }
}
```

**两个必须知道的实现事实（已实测）：**
1. `_raw` 是完整递归 protobuf（`drx-parser.js:1024`），单节点就 1.8MB。插件只取
   `nodes`/`connections`/`label`/`valueFidelity`，例如：
   ```js
   const p = await callTool(ctx, 'drx', { action: 'parse', args: { drxPath } })
   const slim = {
     label: p.label,
     nodes: (p.nodes || []).map(n => ({
       id: n.id, index: n.index, label: n.label, enabled: n.enabled,
       correctorTypes: (n.correctors || []).map(c => c.type),
       qualifier: n.qualifier, powerWindow: n.powerWindow,
       params: n.params, keyframed: n.keyframed,
     })),
     valueFidelity: p.valueFidelity,
   }
   ```
2. `toolBreakdown` 在**当前发布代码里算错了**：`drx.mjs:716` 把 `nodes` **数组**传给
   `extractToolBreakdown(params)`，而该函数期望一个结构化 params 对象（`drx-parser.js:1236`），
   结果恒为默认值（gain 1 / sat 50 / `activeTools:[]`）。实测确认。**不要用 toolBreakdown**，
   要摘要请用 `nodes[].correctors/params`（或直接用 `extractToolBreakdownFromDRX` 的等价逻辑
   自行合并，`drx-parser.js:1355-1420`）。

`valueFidelity`（`drx.mjs:625-678`）：主调色/曲线/HSL 与 RGB/3D qualifier/窗口/ColorSlice/HDR
/节点 Sizing 是「已校准、精确」；OFX/ResolveFX 与长尾 ID 是「raw/unscaled，非真值」；
keyframed 节点会被标记且参数只是基准值。

---

## 4. 匹配器家族（7 个 + 相关）：输入/输出/是否生成 .drx

**共同结论：全部是离线计算，产出「每 clip 一个 .drx + 报告」；没有一个能自己落到 Resolve。**
落地统一由 `timeline_item_color.safe_apply_drx`（§6）完成。所有帧统计类都要求：
- `png` 是 **display-referred**（Rec.709/sRGB），LOG 帧会被守卫拒绝或产生垃圾读数；
- 输入是**磁盘图片路径**；`outDir` 是 `.drx` 输出目录（会被 `mkdir -p`）；
- `clips[]` 里 `id` 是 string|number（会进文件名），`group`/`scene` 是分组键（决定 hero 与报告键）。

> 所有下列 action 都因为缺 `sharp` **当前不可用**（§8.1）。下表的参数是契约，不是现在能跑通的承诺。

### 4.1 一览表

| action | 关键参数 | 产出 .drx 内容 | 是否分层 | 返回顶层字段 |
|---|---|---|---|---|
| `skin_match` | clips[{id,png,group}], outDir, heroId?, clampGain?, minSkinFrac?, metric? | 单节点 Primary per-channel gain（`AUTO:skin_match v2` 标签） | 否 | `groups, warnings, skipped, gradeCount, grades[{id,group,correctionPct,skinFracPct,drxPath}]` |
| `shot_match` | clips[{id,png,scene?}], outDir, mode?, heroId?, clampGain? | 单节点 Primary gain | 否 | `scenes, warnings, skipped, gradeCount, grades[{id,scene,mode,correctionPct,drxPath}]` |
| `white_balance_match` | clips[{id,png,group?,rect?}], outDir, rect?, mode?, heroId?, clampGain? | 单节点 Primary gain | 否 | `groups, warnings, skipped, gradeCount, grades[{id,group,mode,correctionPct,drxPath}]` |
| `contrast_normalize` | clips[{id,png,group}], outDir, heroId?, clampGain?, clampOffset? | 单节点 Primary gain+offset（仿射） | 否 | `groups, warnings, skipped, gradeCount, grades[{id,group,correctionPct,drxPath}]` |
| `black_balance` | clips[{id,png,group?}], outDir, clampOffset? | 单节点 Primary offset-only（gain=1） | 否 | `report, warnings, skipped, gradeCount, grades[{id,castSpreadPct,drxPath}]` |
| `level_clips` | clips[{id,png,group}], outDir, mode?, clampGain? | 单节点 Primary gain | 否 | `groups, warnings, gradeCount, grades[{id,group,correctionPct,drxPath}]` |
| `match_to_reference` | clips[{id,png,reference?}], outDir, reference?, lumaPreserve?, skinGate?, clampGain?, clampOffset? | 单节点 Primary gain+offset（仿射） | 否 | `report, warnings, skipped, gradeCount, grades[{id,correctionPct,skinGated,lumaPreserve,drxPath}]` |
| `saturation_match` | clips[{id,png,group?}], outDir, mode?, heroId?, clampScale? | 单节点 Primary saturation | 否 | `report, warnings, skipped, gradeCount, grades[{id,satScale,correctionPct,drxPath}]` |
| `tone_curve_transfer` | clips[{id,png,reference?}], outDir, reference?, strength?, maxSlope?, intentTags? | 单节点 YRGB `y` 曲线 | 否 | `report, warnings, skipped, gradeCount, grades[{id,maxDeltaPct,points,drxPath}]` |

> 这些 `.drx` 都是**单节点**。要做「肤色节点 + 高光节点 + 背景节点」的分层图，不要把匹配器
> 输出直接当最终图：要么把匹配器算出的数值转成 `generate`/`merge` 的 `params`，要么就用
> `grade_transfer`/`merge` 组合（§5、§7.3）。

### 4.2 skin_match 细节

参数（`skinMatchSchema` `drx.mjs:53-62`；实现 `skin-match.mjs:102-205`）：

| 参数 | 类型 | 必填 | 默认/范围 | 说明 |
|---|---|---|---|---|
| `clips[].id` | string\|number | ✅ | — | 进文件名与报告 |
| `clips[].png` | string | ✅ | display-referred | 肤色门限假设 Rec.709/sRGB |
| `clips[].group` | string | ✅ | — | 每组一个 hero；报告按 group 键 |
| `outDir` | string | ✅ | — | 写入 `<outDir>/<group>_<id>_skin.drx` |
| `heroId` | string\|number | ❌ | 组内第一个 usable clip | 目标肤色参考 |
| `clampGain` | [number,number] | ❌ | `[0.5, 2]` | 每通道 gain 限幅 |
| `minSkinFrac` | number | ❌ | `0.01`（1%） | 低于此值跳过（`skipped`，不伪造） |
| `metric` | `'mean'` \| `'chroma'` | ❌ | `'mean'` | **推荐 `'chroma'`**：保亮度、只匹配肤色色度方向，避开“按白皮肤标定”陷阱（`skin-match.mjs:158-177`） |

返回（`drx.mjs:797-807` 组装）：

```jsonc
{
  "groups": { "<group>": {
      "clips": 3, "hero_id": "CU_02",
      "skin_frac_pct_mean": 12.3, "skin_frac_pct_min": 3.1,
      "max_correction_pct": 8.4
    }, "<group2>": { "error": "no clip cleared the skin-fraction floor", "minSkinFracPct": 1 } },
  "warnings": [ "…skin-gated region sits -22.0° off the vectorscope skin line…", "…max skin correction …" ],
  "skipped": [ { "id": "WIDE_01", "group": "CAM_A", "skinFrac": 0.2, "reason": "insufficient skin pixels" } ],
  "gradeCount": 3,
  "grades": [ { "id": "CU_01", "group": "CAM_A", "correctionPct": 8.4, "skinFracPct": 12.3, "drxPath": "/tmp/…/CAM_A_CU_01_skin.drx" } ]
}
```

行为要点（写 UI 提示时用）：
- 肤色判定是 Kovac RGB 规则（`skin-match.mjs:47-56`，默认 `minR=95,minG=40,minB=20,
  minSpread=15,minRG=15`）。
- 肤色区域色相偏离 123° 线 >12° 会 warn（火光/木头/橙色会被误判成肤色，`skin-match.mjs:127-144`）。
- 组内 `maxCorr > 0.25` 会 warn（跨机位大修正，`skin-match.mjs:192-195`）。
- **全局零肤色直接 throw**（`skin-match.mjs:199-202`）：这是“抽帧抽成 LOG 了”的响亮信号。

### 4.3 shot_match 细节

参数（`drx.mjs:101-109`；实现 `shot-match.mjs:82-146`）：`clips[{id,png,scene?}]`、`outDir`、
`mode: 'neutralize'|'hero'`（默认 neutralize；hero 必须给 `heroId`）、`clampGain`（默认
`[0.5,2]`）。用**每通道中位数**（`maxSide=96`）而不是均值，抗大色块（`shot-match.mjs:15-18,53-74`）。
返回 `scenes` 键（`{mode, clips, hero_id|null, max_correction_pct}`），`grades[]` 含
`{id,scene,mode,correctionPct,drxPath}`。`maxCorr>0.3` warn（单色镜头会被 gray-world 过度校正）。

### 4.4 white_balance_match 细节

参数（`drx.mjs:166-175`；实现 `white-balance-match.mjs:59-121`）：
`clips[{id,png,group?,rect?}]`、`outDir`、`rect?`（默认中性块，**比例 0..1**）、
`mode: neutralize|hero`、`heroId?`、`clampGain?`。
rect 在 `measurePatchMeanRGB` 里先按 metadata 算像素再 `extract` 成 buffer 再 `stats()`
（`white-balance-match.mjs:32-51`；注释解释了为什么不能在同一 pipeline 里 extract+stats）。
返回 `groups`（`{mode,clips,hero_id|null,max_correction_pct}`），`grades[]` 含 `mode`。

### 4.5 contrast_normalize 细节

参数（`drx.mjs:148-156`；实现 `contrast-normalize.mjs:124-179`）：
`clips[{id,png,group}]`、`outDir`、`heroId?`、`clampGain?`（默认 `[0.5,2]`）、
`clampOffset?`（默认 `[-0.5,0.5]`，单位是 **display-normalized**，不是 wire）。
算法：1%/99% 分位点做仿射 `out = scale·in + shift`（`contrast-normalize.mjs:155-166`）。
关键常数：wire offset ±1 ↔ normalized ±0.2（`OFFSET_WIRE_PER_NORM=5`，
`contrast-normalize.mjs:74-78`），超出会 clamp 并 warn。
返回 `groups`（`{clips,hero_id,max_correction_pct}`）。
注意：基准是 `gain.master`（Resolve 的 RGB gain 轮会做亮度归一化，`exposure-level.mjs:47-56`）。

### 4.6 black_balance 细节

参数（`drx.mjs:95-99`；实现 `black-balance.mjs:62-91`）：`clips[{id,png,group?}]`、`outDir`、
`clampOffset?`（默认 `[-0.2,0.2]`）。取 p1 阴影点，对齐到最低通道黑点（只往下拉，不抬黑，
`black-balance.mjs:78-87`）。差距 `<0.004`（≈1/255）视为已中性 → `skipped[{id,reason:'shadows
already neutral',castSpread}]`。返回 `report[id]={castSpreadPct}`，
`grades[{id,offset,castSpreadPct,drxPath}]`。

### 4.7 level_clips（exposure_level）细节

参数（`drx.mjs:44-51`；实现 `exposure-level.mjs:70-128`）：`clips[{id,png,group}]`、`outDir`、
`mode?`（**只支持 `within_camera_mean`，其它值 throw**，`exposure-level.mjs:71-76`）、
`clampGain?`（默认 `[0.5,2]`）。hero = 组内第一个。返回
`groups[group]={clips,hero_id,luma_pct_std,luma_pct_range,max_correction_pct}`；
`maxCorr>0.12` warn（同机位漂移不该这么大）。**仅适用于同一机位、同构图的长记录**。

### 4.8 match_to_reference / saturation_match / tone_curve_transfer（相关，深度匹配很有用）

- `match_to_reference`（`drx.mjs:75-85`；`match-to-reference.mjs:91-172`）：
  clips 可直接带 `reference`，或共享 `opts.reference`；`lumaPreserve` 默认 **ON**；`skinGate`
  默认 **ON**（参考帧有肤色时按肤色区域比）；返回 grades 带 `skinGated`、`lumaPreserve`。
  这是“把某镜头往一张已批准的参考静帧靠”的主力（gain+offset 仿射，不是跨 IDT 校准器）。
  大修正 `corr>0.35` warn。
- `saturation_match`（`drx.mjs:87-93`；`saturation-match.mjs:77-107`）：
  `mode:'overall'|'skin'`（默认 overall），`clampScale` 默认 `[0.5,2]`，
  `minSkinFrac`（skin 模式默认 0.02）。`.drx` 是 Primary saturation：`value = clamp(50*satScale,0,100)`。
- `tone_curve_transfer`（`drx.mjs:64-73`；`tone-curve-transfer.mjs:123-183`）：
  CDF 匹配出 luma tone curve，`strength` 默认 0.8、`maxSlope` 默认 3；
  `intentTags:{clipId:[...]}` 里的 clip 会被跳过；近恒等曲线跳过。写入 `customCurves.y`。
  这是唯一能表达 S 曲线/胶片肩部的匹配器。

---

## 5. drx.generate 完整 schema 与多层节点图

### 5.1 工具层参数（`generateSchema`，`drx.mjs:240-274`）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `gradeParams` | object（passthrough） | ✅ | 见 §5.2；工具默认 `space:'ui'` |
| `metadata` | object（passthrough） | ❌ | `{ label, width, height }`；`label` 会写进节点 F6（provenance 用） |
| `target` | `'clip' \| 'timeline'` | ❌ | 默认 `'clip'`。`'timeline'` 把 grade 写进 `<pTrackVer>`，clip 部分 `HasCorrection=false`（`drx-generator.js:2050-2080`） |
| `resolveVersion` | number \| string | ❌ | 主要数（`21`）或 `'21.0.4'`。**≥21 时圆形/线性窗口用 R21 形式（corrector type 0x10004）**，否则 R21 上会加载但渲染空遮罩（`drx-generator.js:2986-3045`） |
| `outputPath` | string | ❌ | 写了就落盘并返回 `{outputPath,bytes}`；不写就返回 `{content}` |

返回：
- 有 `outputPath` → `{ outputPath, bytes, warnings? }`（`drx.mjs:731-735`）
- 无 → `{ content, warnings? }`

### 5.2 `gradeParams` 完整键表（生成器实际读取的键）

来源：`drx-generator.js` 的 `createNode`（`:550-940`）与各 builder。
**`space:'ui'`（默认）**：所有参数用 Resolve 面板单位；**`space:'drx'`**：raw DRX 内部单位。
统一换算单一入口 `normalizeGradeParams`（`drx.mjs:477-594`），换算表 `UI_TO_DRX`（`drx.mjs:328`）：

| 控制 | UI 空间 | 写入 wire | 备注 |
|---|---|---|---|
| lift | 面板值（≈±0.05） | `UI × 2` | |
| gamma | 面板值 | `UI × 4` | |
| gain | 面板值（0.90–1.10） | `×1`（原样） | 中性 1 |
| offset | 面板 delta | `UI × 0.04` | wire ±1 ↔ normalized ±0.2 |
| saturation | 0–100（50=中性） | `UI / 50` | 和 softClip*Soft 同一轴 |
| lumMixSlider | 0–100 | `/100` | 见下方警告 |
| hueRotate | 0–100（50=中性） | `(UI−50)/50` | |
| contrastHighRange | 默认 0.55 | `1 − UI` | Resolve 原生就这么存 |

#### 主调色（corrector type 1）

| 键 | 形状 | 说明 |
|---|---|---|
| `lift` / `gamma` / `gain` | `{r,g,b,master}` 或 `[r,g,b,master]` 或扁平 `liftR/liftG/liftB/liftMaster` | 三种写法都接受并归一（`drx.mjs:481-505`） |
| `offset` | `{r,g,b}` / `[r,g,b]` / `offsetR..` | 无 master |
| `saturation` | number 0–100 | 50 中性 |
| `contrast` | number（1 中性） | 写 `LOG_CONTRAST` |
| `pivot` | number（0.435 中性） | |
| `temperature` / `tint` / `midtoneDetail` / `colorBoost` / `blackOffset` | number | 原样 |
| `hueRotate` | number 0–100 | 50 中性 |
| `softClipHigh` / `softClipLow` | number（1 / 0 中性） | 三通道同值 |
| `softClipHighSoft` / `softClipLowSoft` | number | encoder ÷50 |
| `contrastHighRange` / `contrastLowRange` | number（0.55 / 0.333 中性） | high 反向存储 |
| `rgbMixer` | `{rr,gr,br,rg,gg,bg,rb,gb,bb}` | 3×3 |
| `colorSlice` | `{density,densityDepth,sat,satBalance,satDepth,hue}` | hue 存储取负（`drx.mjs:540-544`） |
| `customCurves` | `{y:[{x,y}], r, g, b}` | x/y 归一化 0..1；未给的通道写恒等（`drx-generator.js:455-495`） |
| `hslCurves` | `{hueVsHue,hueVsSat,hueVsLum,lumVsSat,satVsSat,satVsLum}: [{x,y}]` | hue 轴曲线必须走 canonicalize；见 §5.7 |
| `hslCurveMeta` | `{curve: int}` | 默认 2（保留 6 的旧默认被 Resolve 忽略） |
| `logShadow` / `logMid` / `logHigh` | `{r,g,b}` | Log 轮 |
| `hdrBlack` / `hdrDark` / `hdrShadow` / `hdrLight` / `hdrHighlight` / `hdrSpecular` / `hdrGlobal` | `{exposure,saturation,colorBalanceX,colorBalanceY}`（旧名 `hueSat`,`hueAngle` 也认） | HDR 分区，全部 zone 合进一个参数（`drx-generator.js:632-676`） |
| `hdrZoneDefinitions` | `[{name,boundary,falloff,defaultBoundary?,defaultFalloff?}]` | name ∈ Black/Dark/Shadow/Light/Highlight/Specular（`drx-generator.js:640-676`） |
| `lumMix` / `satVsSat` / `hue` | `{ [paramId]: value }` | **raw 参数 ID 映射，语义未确认，别用**（`drx-generator.js:1296-1381`） |

#### 次级（第二层，一个节点只能有一个 qualifier）

| 键 | 形状 | 说明 |
|---|---|---|
| `qualifier` | HSL：`{hueCenter,hueWidth,hueSoft,hueSymmetry,satLow,satHigh,satLowSoft,satHighSoft,lumLow,lumHigh,lumLowSoft,lumHighSoft}` | **UI 0–100，wire=÷100**。见 §5.6 |
| `rgbQualifier` | `{rLow,rHigh,rLowSoft,rHighSoft,gLow,…,bHighSoft}` | UI 0–100，mode=2 |
| `lumaQualifier` | `{lumLow,lumHigh,lumLowSoft,lumHighSoft}` | UI 0–100，mode=4 |
| `window` | `{type,pan,tilt,size,aspect,rotate,soft1..soft4,opacity,vertices}` | type：1=Circle, 2=Linear, 3=Polygon, 4=Curve, 5=Gradient。见 §5.7 |
| `matteFinesse` | `{denoise,blackClip,whiteClip,inOutRatio,cleanBlack,cleanWhite,morphRadius,preFilter,postFilter,shadow,midtone,highlight}` | UI 0–100，写 ct9 时 ÷100；**肤色键控强烈建议加** |
| `key` | `{inputGain,inputOffset,outputGain,outputOffset}` | ct9 Key 面板（identity 1/0/1/0） |
| `blur` | `{radius,hvRatio,scaling}` | ct1；radius/hvRatio 中性 0.5（存 `(UI−0.5)×2`），scaling 默认 0.25 |
| `motionEffects` | `{spatialLuma,spatialChroma,spatialBlend,temporalLuma,temporalChroma,temporalBlend,temporalMotion,motionBlur}` | ct15 |
| `ofx` | `{pluginId, params:{…}, options?}` | ResolveFX/OFX；**参数解码值非真值**（`drx-generator.js:4075+`） |
| `colorWarper` | `{pins:[…]}` | R21 wire；R19 不认（CALIBRATION-STATUS: Color Warper 行） |

**Lum Mix 警告（`drx.mjs:506-521`）**：`lumMixSlider` 未设置时，只要 lift/gamma/gain 有 R/G/B
通道移动，encoder 会写 0，于是 RGB 通道是 per-channel。若显式 `lumMixSlider:100` 且 `gain
R=G=B`，Resolve 会把“等量 RGB 移动”对亮度的贡献**完全抵消**（渲染不变）。工具会返回
`warnings[]` 说明（实测见 §8.3）。要调亮度用 `*.master`。

### 5.3 多层节点图：可行路径（重要）

**`drx.generate` 的 `gradeParams` 是单个对象 → 只能建一个节点。** 虽然生成器内部支持
`generateProtobuf(Array.isArray(gradeParams))` 多节点模式（`drx-generator.js:1679-1705`），
但 MCP schema 是 `z.object({}).passthrough()`（`drx.mjs:241-244`），数组会被 zod 拒绝；
`normalizeGradeParams` 也会把数组摊成对象。所以：

> **多层节点图 = 先 `generate` 出一个基线节点，再 `merge` 追加节点（可以一次给多个
> `newNodes`，就会得到一条串联的多层图）。**

`merge` 契约（`drx.mjs:290-304`，schema `mergeSchema`；实现 `drx-merger.js:283-309`）：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `basePath` | string | ⚠️ 与 `baseContent` 二选一 | 已有 .drx 路径 |
| `baseContent` | string | ⚠️ | 已有 .drx XML 内容（可直接接 `generate` 的 `content`） |
| `newNodes` | array | ✅ | 每项 `{ label?, xPos?, yPos?, enabled?, id?, nodeId?, params? , 或把 grade 键放顶层 }` |
| `metadata` | object | ❌ | label/width/height 等 |
| `outputPath` | string | ❌ | 落盘路径；不给则返回 `{content}` |

`newNodes` 元素两种写法等价（`normalizeNewNode`，`drx.mjs:601-611`）：
```jsonc
{ "label": "x", "params": { "qualifier": {…}, "gain": {…} } }
{ "label": "x", "qualifier": {…}, "gain": {…} }            // grade 键放顶层
```
两者都会经过与 `generate` 相同的 `space:'ui'|'drx'` 归一化（`normalizeGradeParams`）。

`merge` 返回：`{ outputPath, bytes, warnings? }` 或 `{ content, warnings? }`（`drx.mjs:768-783`）。

**节点编号**（`drx-generator.js:1769-1900`，`drx-merger.js:108-203`）：
- 新图（base 只有 1 节点）：NodeId `F1` = 1（base，从 parse 保留）+ 2..N；
  NodeIndex `F2` = 1..N 顺序。merge 时新节点的 x 坐标接在已有节点右侧
  （`M:157-176`，每次 +270）；直接调 `generateMultiNodeDRX` 且不给 `xPos` 时才是
  `190 + index*270`（`G:1689-1697`）。y 用 `yPos`（默认 180）。
- 连接是**串联**：1→2→3→…（`drx-generator.js:1836-1846`）。
- `LayerIndex`：**`.drx` 格式里没有 layer 字段**。Resolve 的 Layer 是 live API 概念
  （`item.GetNodeGraph(layer_index)`，`src/server.py:29693-29697`），离线 codec 不写。
  vendor 里有 `createParallelNodes` / `createLayerMixer` / `createOutsideNode`
  （`drx-generator.js:3102/3194/3288`），但**没有接到任何 MCP action**，插件走不到。
  结论：**只支持 NodeId/NodeIndex 的串联图，不支持并行/层混合层**。

### 5.4 实测通过的四层节点图（可直接照抄）

以下 JSON 是本机离线跑通并 parse 回读逐字段核对过的（结果见 §8.2）。

**① 全局 CDL/primary 基线（NodeIndex 1）**

```json
{
  "action": "generate",
  "args": {
    "gradeParams": {
      "space": "ui",
      "lift":   { "r": 0, "g": 0, "b": 0, "master": 0.005 },
      "gamma":  { "r": 0, "g": 0, "b": 0, "master": 0 },
      "gain":   { "r": 1.04, "g": 1.0, "b": 0.97, "master": 1.0 },
      "offset": { "r": 0, "g": 0, "b": 0 },
      "contrast": 1.08,
      "pivot": 0.435
    },
    "metadata": { "label": "AUTO:global_cdl v1", "width": 1920, "height": 1080 },
    "target": "clip",
    "outputPath": "/tmp/davinci-panel/looks/look_base.drx"
  }
}
```

> 基线里**不要放 `saturation`**（原因见 §5.5 的 merge 双重缩放）。饱和度放到某个被 merge
> 的节点里。

**② merge 三层：HSL 肤色 / luma 高光 / hue 背景（NodeIndex 2/3/4）**

```json
{
  "action": "merge",
  "args": {
    "basePath": "/tmp/davinci-panel/looks/look_base.drx",
    "newNodes": [
      {
        "label": "AUTO:skin_hsl v1",
        "enabled": true,
        "yPos": 180,
        "params": {
          "space": "ui",
          "qualifier": {
            "hueCenter": 33, "hueWidth": 22, "hueSoft": 11, "hueSymmetry": 50,
            "satLow": 12, "satHigh": 88, "satLowSoft": 5, "satHighSoft": 5,
            "lumLow": 20, "lumHigh": 80, "lumLowSoft": 5, "lumHighSoft": 5
          },
          "matteFinesse": { "blackClip": 2, "whiteClip": 2, "denoise": 5, "blur": 3 },
          "gain": { "r": 1.03, "g": 1.01, "b": 0.995, "master": 1.0 }
        }
      },
      {
        "label": "AUTO:highlight_luma v1",
        "enabled": true,
        "yPos": 180,
        "params": {
          "space": "ui",
          "lumaQualifier": { "lumLow": 70, "lumHigh": 100, "lumLowSoft": 20, "lumHighSoft": 10 },
          "gain": { "r": 1.0, "g": 1.0, "b": 1.0, "master": 1.06 },
          "softClipHigh": 1.0,
          "blur": { "radius": 0.56, "hvRatio": 0.5, "scaling": 0.25 }
        }
      },
      {
        "label": "AUTO:bg_hue v1",
        "enabled": true,
        "yPos": 180,
        "params": {
          "space": "ui",
          "qualifier": {
            "hueCenter": 62, "hueWidth": 25, "hueSoft": 15,
            "satLow": 10, "satHigh": 100,
            "lumLow": 0, "lumHigh": 60, "lumLowSoft": 5, "lumHighSoft": 10
          },
          "window": { "type": 1, "pan": 50, "tilt": 40, "size": 70, "aspect": 50, "soft1": 30 },
          "gain": { "r": 0.98, "g": 0.99, "b": 1.03, "master": 1.0 },
          "saturation": 46
        }
      }
    ],
    "metadata": { "label": "layered look v1" },
    "outputPath": "/tmp/davinci-panel/looks/look_layers.drx"
  }
}
```

说明：
- **肤色节点**：HSL qualifier（hue 33 / 宽 22 / sat 12–88 / lum 20–80）+ `matteFinesse` 清
  matte；gain 微调肤色。这是“按肤色键控”。
- **高光/炫光节点**：`lumaQualifier`（lumLow 70）做亮度键控 + `gain.master` 提亮 + 一点 blur。
  真正的 Glow 只能用 `ofx`（ResolveFX Glow）表达，且 OFX 参数是 raw/未校准的；`blur` +
  高光键控是离线可控的近似（“炫光”若指 bloom，建议在 Resolve 里用 ResolveFX，或把它做成
  独立 `.drx` 由 `grade_transfer` 保留）。
- **hue 背景节点**：HSL qualifier 选背景色相（62 ≈ 黄绿/橄榄；换 210 ≈ 青蓝），限定
  `lumLow..lumHigh` 排除高光，再叠一个圆形窗限制范围。
- 四层实测 parse 回读：`correctors` 类型分别为 `[1,2] / [1,2,2] / [1,2,2] / [1,2,2,4]`，
  qualifier/window 逐字段复原（§8.2）。

**③ 自检（落地前必做）**

```json
{ "action": "parse", "args": { "drxPath": "/tmp/davinci-panel/looks/look_layers.drx" } }
```
断言：`nodes.length === 4`；`nodes.map(n=>n.index)` 为 `[1,2,3,4]`；
`nodes[1].qualifier.hueCenter≈33`；`nodes[2].qualifier.lumLow≈70`；
`nodes[3].powerWindow.type===1`（若用窗口）。

### 5.5 merge 的两个数据损坏坑（实测，必须绕开）

`drx-merger.js:108-203` 的 `mergeNodes` 对**已有节点**只搬 parse 出来的
`node.params`（只有 lift/gamma/gain/offset/saturation/contrast/pivot，`drx-parser.js:625-640`），
然后用生成器重新编码。因此：

1. **已有节点的次级/曲线/窗口会丢。** 实测：一个带 HSL qualifier 的单节点基线，merge 一个
   无关节点后，基线节点的 qualifier 只剩 `{"mode":0}`（窗口/曲线同理）。
   → **不要 merge 到“已经有次级或曲线”的 .drx 上**（包括从 Resolve 导出的 grade）。
   正确做法：基线只放主调色，所有次级都放在 `newNodes` 里。
2. **已有节点的 `saturation` 会被二次缩放。** 实测：基线 UI 55 → wire 1.1 → parse 回 1.1 →
   merge 再编码 `1.1/50 = 0.022`（应为 1.1）。gain/lift/gamma/offset/contrast/pivot 是原样
   透传，不受影响。
   → **基线不要放 saturation**；把饱和度放在 `newNodes` 的某个节点（新节点走
   `normalizeGradeParams`，是正确的）。

新节点不受这两个坑影响：它们在 `merge` 里经 `normalizeNewNode` → `normalizeGradeParams`
（`drx.mjs:601-611, 772`），`space:'ui'` 与数组/扁平写法都正常。

### 5.6 qualifier（HSL / RGB / luma）支持矩阵

| 类型 | 键 | 校准状态（源码） | 注意 |
|---|---|---|---|
| HSL | `qualifier` | ✅ **live-confirmed**：面板读数 Center 33.1 / Width 22 / Soft 11 / Sat 12–88 / Lum 20–80 精确（CALIBRATION-STATUS.md:67） | 12 个范围全支持；`hueSymmetry` 缺省时若给了 hueCenter 会补 50（`drx-generator.js:2676-2681`） |
| RGB | `rgbQualifier` | ✅ wired + live-confirmed（CALIBRATION-STATUS.md:68） | mode=2；12 个阈值 |
| luma | `lumaQualifier` | ✅ wired（mode varint {F2:4}），round-trip（CALIBRATION-STATUS.md:69） | 只有 4 个参数（lum Low/High/Soft） |
| 3D | 解码 `node.params.qualifier3d` | 只解码，无写 | — |

- **一个节点只能有一个 qualifier**，优先级 HSL > RGB > luma（`drx-generator.js:742-749`）。
- **单位是 UI 0–100**，encoder 一律 `÷100`（`drx-generator.js:2660-2710`）。`hueCenter` 是
  面板 0–100 刻度，**不是 0–360°**（`parameter-ranges.js:264` 写的 0–360° 是过期注释；以
  实测面板回读 Center 33.1 为准）。
- 生成器会给每个 HSL qualifier 额外写 `MODE_FLAG=4` 与 `QUALIFIER_MODE=0`
  （`drx-generator.js:2694-2712`）；RGB 写 `QUALIFIER_MODE=2`；luma 写 `=4`。
- **解码坑**：`parse` 的 `node.qualifier.mode` 对 RGB/luma 会读成 `0`——因为非曲线 grade 会
  多一个 companion 块（type 2，`0x88300001={F2:0}`，`drx-generator.js:702-715`），
  `extractQualifier` 取第一次出现（`extract-qualifier.js:83-89`）。要确认 mode 请看
  `node.correctors` 里 ct2 的 `qualifier.mode` 原始值（会出现两个：0 和真实 mode）。
  另外这个 companion 块会让 `verify_grade` 在每个普通 grade 上都报
  `unverifiableParams:['qualifier.mode']`（实测），不影响 `landed` 判定。

### 5.7 window（Power Window）支持矩阵

`buildWindowParams`（`drx-generator.js:2838-2985`）的 `type` 语义以代码为准：

| `type` | 形状 | 写入块 | 校准状态 |
|---|---|---|---|
| 缺省/0 | 无窗口 | — | — |
| 1 | Circle | ct4 transform（R21：ct `0x10004`） | ✅ live-confirmed（Size 60/Pan 35/Tilt 75/Soft 5 精确） |
| 2 | Linear | ct4 + ct3 软边（UI×16） | ✅ fixed + round-trip |
| 3 | Polygon | ct6 顶点环（需 `vertices:[{x,y}...]`） | ◐ 代码有写路径（2026-07-02 加），CALIBRATION-STATUS 仍标“no write path / decode-only”→ **未 live 验证，风险自担** |
| 4 | Curve | 同 Polygon | ◐ 同上 |
| 5 | Gradient | 全部在 ct65554（`0x08F0xxxx`） | ✅ round-trip == fixture 精确 |

参数（UI 单位，`drx-generator.js:2820-2985`）：
- `pan` / `tilt`：0–100（50=中心），存 `(UI−50)/50 × 4096`（帧像素偏移）
- `size`：0–100（50=默认），存 `1 + (UI−50)×0.08`
- `aspect`：0–100（50=1:1），存 `(50−UI)/50`
- `rotate`：度，存 `−UI/180`
- `soft1`..`soft4`：0–100；Circle 用 soft1（SoftRef，×16）；Linear 用 soft1..4（ct3，×16）；
  Gradient 用 soft1（×100）
- `opacity`：0–100（100=不透明），存 `/100`
- `vertices`：Polygon/Curve 专用，**帧像素坐标、相对画面中心**（例：`{x:-400,y:-300}`）；
  写入时按“首角×2、其余×3、闭合首角×2”的 ring 展开（`drx-generator.js:2874-2920`）。
  实测 4 角输入→parse 得到 13 个点（`params.polygonVertices`），`powerWindow` 仍为 null
  （ct6 不在 `extractPowerWindow` 覆盖内）。
- **Gradient 忽略 `size/aspect/soft2..4`**，只有 pan/tilt/rotate/soft1/opacity
  （`drx-generator.js:2907-2935`）。
- **R21 必须传 `resolveVersion:21`**，否则圆形/线性窗口在 Resolve 21 上“加载但渲染空遮罩，
  并且会盖掉该节点的 grade”（`drx-generator.js:2986-3000`，`generateSchema` 的 `resolveVersion`
  描述里也写了“Not live-verified here; the format comes from justhung69/resolve-mcp”）。
  本机实测 `resolveVersion:21` 时窗口 corrector 类型变成 `65540 (0x10004)` 且参数完整解码；
  **渲染行为需要在装了 Resolve 21 的环境复核**（本次调研未运行 Resolve）。

### 5.8 HSL 曲线的坑（hue 轴）

- `hueVsHue` / `hueVsSat` / `hueVsLum` 在 Resolve 19 上必须写成**规范 bezier 笼形**
  （band anchors + 周期 wrap 副本），naive 点列会被 Resolve 静默忽略（`drx.mjs:330-344`）。
  工具会自动 canonicalize（`drx.mjs:546-593`，`345-474`），但：
  - 中心必须落在 `[1/8,7/8]`、两 bump 间距 ≥1/6、bump 边缘不能压在 band 槽（k/6）上，
    否则**原样透传 → Resolve 渲染为平**，并返回 warning（`drx.mjs:575-582`）。
  - **不要传已经 wrap 过的点列**（x 超出 [0,1]）：默认直接 throw；只有
    `allowWrappedHueCage:true` 才允许原样重编码 Resolve 自己序列化的笼形
    （`drx.mjs:560-573`）——畸形笼形曾导致 Resolve 19.1.3 崩溃。
  - 亮度/饱和度轴曲线（`lumVsSat`/`satVsSat` 等）容忍 polyline，无此限制。
- `hslCurveMeta` 默认写 2（`drx.mjs:587-591`）。

---

## 6. 落地与验证

### 6.1 `.drx` 结构与 ApplyGradeFromDRX 兼容性

生成的 XML 是 `Gallery::GyStill` 包裹（`drx-generator.js:1998-2083`）：
- `<pClipFullVer>`（VerType 0）= clip grade；`target:'timeline'` 时 `HasCorrection=false`。
- `<pTrackVer>`（VerType 1）= timeline grade；只有 `target:'timeline'` 才写。
- 每个节点 `<Body>` 是 `0x81 + zstd(protobuf)`（`drx-generator.js:1977-1996`）。
- 节点图在 protobuf 里：`F1`=版本、`F7`=节点数组、`F9.F1`=connections、`F9/F10`=input/output
  标记（`drx-generator.js:1658-1760`）。

Resolve 的 `ApplyGradeFromDRX(path, grade_mode)` **整体替换**目标节点图，没有 append
（`src/server.py:29938-29944`）。所以“落一个多层 look”= 生成一个完整多层 .drx 再一次性 apply，
不要逐个节点 apply。

`target` 与 apply 源必须匹配：
- `target:'clip'` 的文件 → `source:'item'`（默认）。
- `target:'timeline'` 的文件 → `source:'timeline'`。反了会报
  `DRX_NO_TIMELINE_GRADE`（`src/server.py:29715-29745`）：clip-target 文件没有
  `<pTrackVer>`，当 timeline apply 会“改变不了任何东西，还把现有 timeline 图换成空图”。

### 6.2 `timeline_item_color.safe_apply_drx` 精确参数（`src/server.py:30121-30166`）

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `path` | string | ✅ | — | `.drx` 绝对路径；默认必须在系统 temp 下 |
| `source` | `'item'\|'timeline'\|'color_group_pre'\|'color_group_post'` | ❌ | `'item'` | 目标图 |
| `timeline_item_id` | string | 强烈建议 | — | 稳定句柄（21.1 上 `item_index` 会把转场算进去而漂移，`src/server.py:3401-3415`） |
| `track_type` | string | ❌ | `'video'` | 无 timeline_item_id 时用 |
| `track_index` | number | ❌ | `1` | 1-based |
| `item_index` | number | ❌ | `0` | **0-based**，且 21.1 会把 transitions 算作一项 |
| `group_name` | string | 组源必填 | — | `source` 为 color_group_pre/post 时 |
| `layer_index` | number | ❌ | — | 仅 `source:'item'`，传给 `item.GetNodeGraph(layer_index)` |
| `grade_mode` | number | ❌ | `0` | 0=不带 keyframe，1=源时间码对齐，2=起始帧对齐（`src/server.py:29933` 的 `grade_modes`） |
| `dry_run` | bool | ❌ | false | 返回 `{path,source,grade_mode,would_apply:true}` |
| `require_temp_path` | bool | ❌ | **true** | 路径必须在 temp 根下（`src/server.py:22010-22022`） |
| `confirm_token` | string | 第二次调用必填 | — | 见下 |

**confirm_token 两次调用流程**（`src/utils/confirm_tokens.py:147-183`；`require_confirm_token`
默认开，可用 `setup` 的 `destructive.require_confirm_token` 关）：
1. 第一次（不带 token）→ 返回**错误信封**，但带：
   ```jsonc
   {
     "error": {"message":"This action is destructive. Re-call with confirm_token to proceed.",
               "code":"CONFIRMATION_REQUIRED","category":"pending_user_decision",
               "retryable":false,"remediation":"..."},
     "status": "confirmation_required",
     "confirm_token": "…32hex…",
     "preview": {"operation":"safe_apply_drx","warning":"REPLACES the target graph entirely. There is no append mode.","path":"…","source":"item","grade_mode":0},
     "expires_at_epoch": 0, "ttl_seconds": 300
   }
   ```
   `callTool` 会抛异常，插件从 `error.mcpValue.confirm_token` 取（照抄 `host-base.mjs:365-385`）。
2. 第二次：带 `confirm_token` **且其它参数完全一致**（token 绑定 action+params 指纹，
   参数变了会 `CONFIRM_TOKEN_FINGERPRINT_MISMATCH`）。token 一次性、默认 300s 过期、
   **只在签发它的服务器进程内有效**。

**成功返回**（`src/server.py:29809-29870`）：
```jsonc
{
  "success": true, "path": "…", "source": "item",
  "changed_graphs": ["item"],                    // 节点数/label/LUT 发生变化的图
  "graphs": { "item": {"num_nodes_before":4,"num_nodes_after":5,"changed":true},
              "color_group_pre": {"readable":false}, "timeline": {…} },
  "verification": {"verified": true, "contradiction": false,
                   "method": "node count, labels and LUTs of each graph before and after"},
  "warning": "No graph changed its node count, labels or LUTs…",   // 仅当 native True 但结构没变
  "unreadable_graphs": ["…"]                      // 有不可读的候选图时
}
```
失败语义：
- `DRX_PATH_NOT_TEMP`：路径不在 temp 且没关 `require_temp_path`。
- `DRX_NOT_FOUND` / `APPLY_DRX_UNSUPPORTED` / `DRX_NO_TIMELINE_GRADE`。
- `DRX_APPLIED_TO_OTHER_GRAPH`（`success:false`）：grade 落到了别的图（例如带 color group
  的 clip 落进 group pre-clip）。

**verification 的边界（必须写进 UI 文案）**：readback 只比较**节点数、节点 label、LUT**
（`src/server.py:29750-29770`），**参数值读不回来**。所以：
- 结构没变时会返回 `warning: "No graph changed…"`——这**不代表失败**，同结构 apply 只改参数；
- 真正的参数级证明要靠 `verify_grade` + `.drp` 回读（§6.3）或渲染帧（§6.4）。

### 6.3 参数级验证：`verify_grade`

参数（`drx.mjs:213-217`）：`intended:{drxPath|content}`、`applied:{drxPath|content}`、`tol?`（默认 `1e-3`）。
返回（`verify-grade.mjs:54-112`）：
```jsonc
{
  "verdict": "landed|drifted|missing|unverifiable",
  "nodes": [ { "index":0, "status":"drifted",
               "deltas":[{"param":"gain.r","intended":1.1,"applied":1.2,"delta":0.1}],
               "unverifiableParams":["qualifier.mode"],
               "note":"non-numeric/plugin params present (OFX/qualifier/window) — not judged; use live scopes" } ],
  "counts": {"landed":0,"drifted":1,"missing":0,"unverifiable":0,"extra":0},
  "tol": 0.001,
  "warnings": [],
  "valueFidelity": { … }
}
```
判定规则：逐节点、逐**数值**参数比较（缺失参数用默认值：乘性=1、加性=0），
keyframed 节点判 `unverifiable`；非数值参数（OFX/qualifier/window）不判、只列出。
整体 verdict 取最坏：missing > drifted > landed > unverifiable。

**怎么拿到 applied 侧 .drx（实测可行路线）**：
```
1) live: project_manager { action:'export_project', name:'<项目名>', path:'/tmp/davinci-panel/readback/show.drp' }
2) offline: drp { action:'extract_node_graphs', args:{ drpPath:'/tmp/…/show.drp' } }
   → graphs[]: [{ clipId, trackType, sequence, mediaFilePath, drxContent }]
   目标 clip 的 drxContent 就是可解码的 grade 内容（Resolve_Color_Exchange 包裹，含 <Body>）
3) offline: drx { action:'verify_grade',
                  args:{ intended:{ drxPath:'/tmp/…/look_layers.drx' },
                         applied:{ content: <该 clip 的 drxContent> },
                         tol: 1e-3 } }
```
（`drp.extract_node_graphs` 的实现见 `server/tools/drp.mjs:270-288`，它按 clip 生成
`drxContent`；`grade_transfer`/`verify_grade` 都只依赖 `<Body>`，不挑外层标签。）
组级 look 的更短路线：`.drp` + `drx.grade_transfer {drpPath, group, which:'post', outPath}`
得到组 grade 的 .drx，再 `verify_grade`。

> 注意：`drp.extract_node_graphs` 的 drxContent 来自**导出的 .drp**，反映的是 export 时刻的
> 项目状态；apply 后要重新 export，否则验的是旧数据。

### 6.4 视觉验证（最终裁量）

结构 readback 与参数比较都不能证明“画面真的变了”。建议每次 apply 后：
1. `mcp__resolve__timeline_frame {action:'capture', frame|timecode, quality:'frame', max_width:1280}`
   —— 取的是 Resolve **处理后的**输出（grade/Fusion/标题都算），同机位 before/after 对比。
2. 要全分辨率留档：`mcp__resolve__gallery_stills {action:'grab_and_export', folder_path:'/tmp/…', format:'png'}`。
3. 注意：`timeline_frame` 的 `quality:'thumbnail'` 是 clip 缩略图（不是某一帧），不能用来判帧。

### 6.5 `relayout` 的落地姿势

`relayout`（`drx.mjs:119-134, 849-877`）只重写 Body 里的节点 x/y，grade 内容字节保留，且会
panic-check 节点数不变。参数：`drxPath?|content?`、`outPath?`、`positions?:[[x,y]...]`、
`originX(290)/originY(428)/spacingX(495)/spacingY(178)`、`layout:'topology'|'row'`。
返回 `{outPath|content, nodeCount, positionsBefore, positions, layout}`。

**重要**：Resolve 的 same-structure apply **会保留旧节点布局，忽略 .drx 里的坐标**。
所以 relayout 后要真正看到整齐布局，必须先 `graph.reset_all_grades` 清空再 apply
（`resolve-advanced/README.md:168`；`src/server.py:675-677, 32003-32007` 也记了这条）。

### 6.6 其他“写出去”的 action（落地前可组合）

- `grade_transfer`（`drx.mjs:840-847`；`grade-transfer.mjs:35-66`）：
  参数 `drpPath+group（+which:'post'|'pre'）` 或 `drxPath|content`，`outPath` 必填，
  `label?`。返回 `{outPath,nodeCount,bodyBytes,label,source}`。无损复制裸 `<Body>` 再包成
  `Gallery::GyStill`（`tools/color_trace.mjs:78-116`），0 节点会拒绝（`grade-transfer.mjs:59-60`）。
  **这是把已批准 look 带到别处的首选**（不解码→不丢 OFX/长尾参数）。
- `author_look`（`drx.mjs:898-905`；`season-look.mjs:44-66`）：返回 manifest
  `{name,version,approvedBy,sourceHash,drxPath,nodeCount,bodyBytes,label}`。
- `carry_look`（`drx.mjs:907-910`；`season-look.mjs:74-95`）：返回 `{look,targetCount,plan,gate}`。
  ⚠️ `plan[].args` 用的是 `{drxPath, group, gradeMode}`，**不是** live `safe_apply_drx` 的真实
  参数名。插件要自己映射：`drxPath→path`、`gradeMode→grade_mode`、
  `group→{source:'color_group_pre'|'color_group_post', group_name:group}`。
- `lut_apply`（`drx.mjs:891-896`；`lut-apply.mjs:38-60`）：`drxPath|content` + `lutPath`（必填）
  + `nodeIndex?`(0) + `slotMeta?`(6) + `outPath?`。返回
  `{lutPath,slotMeta,nodeIndex,verified:true,liveConfirm:'pending (live validation)',outPath|bytes}`。
  round-trip 断言保证路径写进去了；**LUT 是否真的参与渲染尚未 live 验证**，`.cube` 必须是
  Resolve 能解析到的（通常在 LUT 目录）。
- `cdl_io`（`drx.mjs:821-826`；`cdl-io.mjs:47-75`）：`cdlPath|content` + `outDir`，
  返回 `{imported, grades:[{id,drxPath,identity}], warnings}`（power→gamma 是模型近似，
  warning 会说明）。可作“DIT CDL 先播种 look”的入口。
- `export_cdl`（`drx.mjs:749-766`）：`drxPath|content|params` + `format:'cdl'|'ccc'`。
  ⚠️ 实测：从生成的 .drx 导出时 **saturation 会被再除以 50**（UI 60→wire 1.2→CDL 0.024），
  slope/offset/power 正常。要 CDL 饱和度请直接传 `params`。

---

## 7. 3 条推荐调用序列

> 以下用 `callTool(ctx, base, payload)` 表示插件现有 helper。高级工具 payload 是
> `{action, args}`，Python 工具是扁平 `{action, ...}`。
> 第 1 步（抽帧）用 `drx.extract_frames`（ffmpeg，不依赖 sharp）；第 2 步起凡是 `scope_read`
> / 匹配器都需要 sharp——**见 §8.1 的阻塞说明**。

### 7.1 序列 A：读一帧色彩证据（ROI + 肤色线 + 黑白平衡）

```js
// A1. 抽 display-referred 帧（LOG 源会被拒绝，改用 proxy/成片）
const ex = await callTool(ctx, 'drx', {
  action: 'extract_frames',
  args: {
    clips: [
      // 每个 id 产出一个 <outDir>/<id>.png；同 id 会互相覆盖，所以一帧一个 id
      { id: 'shot1_mid', source: '/media/reel01.mov', at: 'midpoint' },
      { id: 'shot1_tc',  source: '/media/reel01.mov', at: '00:00:12:06',
        proxy: '/media/proxy/reel01_709.mov' },   // 有 display-referred 代理时优先用它
    ],
    outDir: '/tmp/davinci-panel/evidence',
  },
}, signal)
// ex = { frames: { shot1: '/tmp/…/shot1.png' }, skipped: [...], warnings: [...] }
// skipped[0].reason 里会写 "is LOG/scene-referred — refuse" 之类

// A2. 全帧读数
const full = await callTool(ctx, 'drx', {
  action: 'scope_read',
  args: { png: ex.frames.shot1_mid, satBins: 16 },
}, signal)

// A3. 人脸 ROI 读数（rect 是 0..1 比例，不是像素）
const face = await callTool(ctx, 'drx', {
  action: 'scope_read',
  args: { png: ex.frames.shot1_mid, rect: { x: 0.35, y: 0.18, w: 0.30, h: 0.42 } },
}, signal)

// A4. 派生意图标签（给 UI 提示 / 排除故意风格化镜头）
const tags = await callTool(ctx, 'drx', {
  action: 'intent_tags',
  args: { png: ex.frames.shot1_mid, meta: { timeOfDay: 'night', whiteBalanceK: 3200 } },
}, signal)
```

要点：`full.parade.spread` 判通道平衡；`full.blackBalance.castSpread` 判阴影偏色；
`face.skinLine.deviationDeg` 是肤色相对 123° 线的偏差（>±12° 基本不是人脸）；
`full.clipPct/crushPct` 判裁切；`full.signals.*` 给 UI 文案。
`skinLine` 为 null 时说明 ROI 里没有合格肤色像素——换个 rect 或这张没人物。

### 7.2 序列 B：参考帧 → 目标帧肤色匹配

```js
// B1. 抽参考帧 + 目标帧（同一批 outDir）
const ex = await callTool(ctx, 'drx', {
  action: 'extract_frames',
  args: {
    clips: [
      { id: 'hero',   source: '/media/hero_709.mov',  at: 'midpoint' },
      { id: 'CU_01',  source: '/media/camA_709.mov',  at: 'midpoint' },
      { id: 'WIDE_01', source: '/media/camA_709.mov', at: '00:00:30:00' },
    ],
    outDir: '/tmp/davinci-panel/evidence/skin',
  },
}, signal)

// B2. 跨机位肤色统一（metric:'chroma' 保亮度；heroId 指定参考；minSkinFrac 防噪）
const skin = await callTool(ctx, 'drx', {
  action: 'skin_match',
  args: {
    clips: [
      { id: 'hero',    png: ex.frames.hero,    group: 'CAM_A' },
      { id: 'CU_01',   png: ex.frames.CU_01,   group: 'CAM_A' },
      { id: 'WIDE_01', png: ex.frames.WIDE_01, group: 'CAM_A' },
    ],
    outDir: '/tmp/davinci-panel/grades/skin',
    heroId: 'hero',
    metric: 'chroma',
    minSkinFrac: 0.01,
    clampGain: [0.85, 1.18],
  },
}, signal)
// skin.skipped / skin.warnings 必须展示；skin.grades[].drxPath 是每 clip 的 .drx

// B3. 自检（不想让 UI 卡住就只取骨架字段，见 §3.1）
const check = await callTool(ctx, 'drx', {
  action: 'parse',
  args: { drxPath: skin.grades.find(g => g.id === 'CU_01').drxPath },
}, signal)
// 断言 check.nodes[0].params.gain.r ≈ 目标值、keyframed===false

// B4. 落地到目标 clip（第一次必然返回 confirmation_required）
const target = { action: 'safe_apply_drx', path: skin.grades.find(g => g.id === 'CU_01').drxPath,
                 source: 'item', timeline_item_id: itemId, grade_mode: 0 }
let applied
try {
  applied = await callTool(ctx, 'timeline_item_color', target, signal)
} catch (err) {
  const token = err.mcpValue?.confirm_token
  if (!token) throw err
  applied = await callTool(ctx, 'timeline_item_color',
    { ...target, confirm_token: token }, signal)
}
// applied.verification.verified / applied.changed_graphs 是即时结构证明
```

如果更想“整帧往参考静帧靠”（而不是只对肤色），把 B2 换成
`drx.match_to_reference`：`clips:[{id,png,reference:'/media/hero_ref.png'}]` +
`lumaPreserve:true` + `skinGate:true`。要复刻参考的对比形状（S 曲线）再加
`drx.tone_curve_transfer`（同一个 reference）。

### 7.3 序列 C：分层匹配 → 生成可应用 .drx → 落到 timeline item

```js
const LOOK_DIR = '/tmp/davinci-panel/looks'

// C1. 基线节点（全局 CDL/primary；不要放 saturation，见 §5.5）
const base = await callTool(ctx, 'drx', {
  action: 'generate',
  args: {
    gradeParams: {
      space: 'ui',
      lift:   { r: 0, g: 0, b: 0, master: 0.005 },
      gain:   { r: 1.04, g: 1.0, b: 0.97, master: 1.0 },
      contrast: 1.08,
      pivot: 0.435,
    },
    metadata: { label: 'AUTO:global_cdl v1' },
    outputPath: `${LOOK_DIR}/look_base.drx`,
  },
}, signal)

// C2. 追加三层（HSL 肤色 / luma 高光 / hue 背景）——一次 merge 成多层图
const layers = await callTool(ctx, 'drx', {
  action: 'merge',
  args: {
    basePath: base.outputPath,
    newNodes: [ /* 见 §5.4 的 3 个节点，原样放这里 */ ],
    metadata: { label: 'layered look v1' },
    outputPath: `${LOOK_DIR}/look_layers.drx`,
  },
}, signal)

// C3. 自检节点图（只取骨架字段）
const parsed = await callTool(ctx, 'drx', {
  action: 'parse', args: { drxPath: layers.outputPath },
}, signal)
const expect = ['[1,2]', '[1,2,2]', '[1,2,2]', '[1,2,2,4]'] // base/skin/luma/bg(+window)
// 断言 parsed.nodes.length === 4 且 correctorTypes 符合预期，再继续

// C4.（可选）整理节点布局；注意要真正生效需先 reset 再 apply（§6.5）
const tidy = await callTool(ctx, 'drx', {
  action: 'relayout', args: { drxPath: layers.outputPath, layout: 'topology', outPath: `${LOOK_DIR}/look_final.drx` },
}, signal)

// C5. 落地（整体替换目标图；confirm_token 两段式）
const applyArgs = {
  action: 'safe_apply_drx',
  path: tidy.outPath,
  source: 'item',                 // target:'timeline' 的文件才用 source:'timeline'
  timeline_item_id: itemId,
  grade_mode: 0,
}
let r1
try { r1 = await callTool(ctx, 'timeline_item_color', applyArgs, signal) }
catch (err) {
  const token = err.mcpValue?.confirm_token
  if (!token) throw err
  r1 = await callTool(ctx, 'timeline_item_color', { ...applyArgs, confirm_token: token }, signal)
}

// C6. 结构证明 + 参数级证明
if (r1.warning) { /* 同结构 apply：只改了参数，正常；继续 C7 */ }
// C7. 参数级回读（apply 后重新导出 .drp）
await callTool(ctx, 'project_manager',
  { action: 'export_project', name: projectName, path: '/tmp/davinci-panel/readback/show.drp' }, signal)
const graphs = await callTool(ctx, 'drp',
  { action: 'extract_node_graphs', args: { drpPath: '/tmp/davinci-panel/readback/show.drp' } }, signal)
const appliedDrc = graphs.graphs.find(g => g.clipId === targetClipId)?.drxContent
if (appliedDrc) {
  const verdict = await callTool(ctx, 'drx', {
    action: 'verify_grade',
    args: { intended: { drxPath: tidy.outPath }, applied: { content: appliedDrc }, tol: 1e-3 },
  }, signal)
  // verdict.verdict 应为 landed；unverifiableParams 里出现 qualifier.mode 是 companion 块，正常
}

// C8. 视觉最终裁量：同帧 before/after
await callTool(ctx, 'timeline_frame',
  { action: 'capture', frame: currentFrame, quality: 'frame', max_width: 1280 }, signal)
```

如果要“把参考帧的肤色搬到目标帧、再叠风格层”，C1 的 `gradeParams` 就用
`match_to_reference`/`skin_match` 算出的 `gain/offset` 数值构造（它们返回 `gain`/`offset`
对象），或者直接把匹配器产出的 `.drx` 当 base：`merge { basePath: 匹配器.drx, newNodes:[…] }`
——但注意 base 若来自 Resolve 且带次级，会被 §5.5 的坑清掉。

### 7.4 与插件自带 `lib/layers.mjs` 的对接（绕开 sharp 阻塞）

本仓库已有纯 Node 的帧分析引擎 `lib/layers.mjs`（`analyzeFrame` / `compareLayers`，
只用 ffmpeg，**不依赖 sharp**）。它输出每层 `cdl:{Slope,Offset,Power,Saturation}` +
`confidence`，正好补上 §8.1 的阻塞。两条落地路线：

**A. 全局层 → 单节点 CDL（现成、最快）**

`compareLayers` 的 `global.cdl` 直接喂给面板已有的 CDL 路径：

```js
const cmp = compareLayers(refStats, tgtStats)          // lib/layers.mjs
await callTool(ctx, 'timeline_item_color', {
  action: 'safe_set_cdl',
  cdl: { Slope: cmp.global.cdl.Slope, Offset: cmp.global.cdl.Offset,
         Power: cmp.global.cdl.Power, Saturation: cmp.global.cdl.Saturation },
  timeline_item_id: itemId,
}, signal)
```

注意：`safe_set_cdl` 是**单节点、整体替换 1 号节点的 CDL**（插件 README 已写），不产生分层图。

**B. 分层 → 多层 .drx（“深度色调匹配”的目标形态）**

把每层 CDL 变成对应节点的调色参数，用 §5.4 的 `generate → merge` 构一张多层图。映射建议：
- `Slope` → `gain`（中性都=1，`space:'ui'` 下 gain 是原样）；
- `Offset`（ASC 归一化加性）→ `offset`。`space:'ui'` 的 offset 是面板 delta 且 encoder
  `×0.04`（wire ±1 ↔ normalized ±0.2）；若你手上是 normalized 值 `o`，要 `offset.ui = o×5`。
  更稳的做法是走 `space:'drx'` 并直接给 wire（`o×5`），避免二次换算；
- `Power`（ASC，中性 1）与 Resolve gamma 面板不是线性关系（`cdl_io` 的 warning 明说
  “power→gamma 是模型近似”）。**最省事且语义正确的桥是 `drx.cdl_io`**：把每层 CDL 拼成
  ASC CDL XML（最小结构即可，`cdl-exporter.js:319-377` 只 grep `ColorCorrection/Slope/Offset/Power/Saturation`）：

```js
const cdlXml = `<?xml version="1.0"?>
<ColorCorrectionCollection xmlns="urn:ASC:CDL:v1.01">
  <ColorCorrection id="global">
    <SOPNode>
      <Slope>${s.r} ${s.g} ${s.b}</Slope>
      <Offset>${o.r} ${o.g} ${o.b}</Offset>
      <Power>${p.r} ${p.g} ${p.b}</Power>
    </SOPNode>
    <SatNode><Saturation>${sat}</Saturation></SatNode>
  </ColorCorrection>
</ColorCorrectionCollection>`

const cdl = await callTool(ctx, 'drx', {
  action: 'cdl_io', args: { content: cdlXml, outDir: '/tmp/davinci-panel/grades/cdl' },
}, signal)
// cdl = { imported, grades:[{id:'global', drxPath, identity}], warnings }   // warnings 含 power→gamma 近似说明
```
然后以该 `.drx` 为 base，`merge` 上肤色/高光/背景三个节点（qualifier 范围用
`analyzeFrame` 的层统计来定：肤色的 `meanHue/meanSat` → `hueCenter/hueWidth/satLow/satHigh`；
高光 → `lumaQualifier.lumLow`；背景 → 背景层主色相 → `hueCenter`；覆盖不到的层用低
`confidence` 直接跳过，别硬编），最后 `safe_apply_drx`（§6.2）。

⚠️ 若用 `merge` 把层节点接到 `cdl_io` 的 base 上，注意 §5.5：base 只有主调色，不会丢东西；
但如果 base 带 saturation，会二次缩放，所以层 CDL 的 `Saturation` 请放到某个 `newNodes` 里。

---

## 8. 实测记录与陷阱清单

本节所有结论都是 2026-11-13 在本机用**真实代码路径**跑出来的（离线 codec + 实时 MCP 各一半），
不是读注释推断。

### 8.1 阻塞：`sharp` 缺失（实测）

```
$ node -e "require('sharp')"                       → sharp MISSING
$ ls resolve-advanced/node_modules | grep sharp    → (空)
实时 MCP：mcp__resolve_advanced__drx {action:'scope_read', args:{png:'/tmp/nonexistent-frame.png'}}
→ Error: {"error":"scope-read needs the optional dep 'sharp' (frame stats). Install: npm i sharp"}
```
影响：§3 表里标 ✅ 的 12 个 action 全部不可用。修复只能在
`resolve-advanced/` 里 `npm i sharp`（本次调研按要求未安装）。替代：
- 抽帧用 `drx.extract_frames`（ffmpeg，✅ 本机可用）；
- 数值读数如果需要 sharp 之外的实现，只能插件自己算，或先装 sharp；
- 给人看的画面用 `timeline_frame capture` / `gallery_stills`。

其他依赖：原生 `zlib.zstdCompressSync` 可用（Node 26），所以 `generate` 不依赖 `zstd-codec`；
ffmpeg/ffprobe 在 `/opt/homebrew/bin`（`extract_frames` 可用）。

### 8.2 多层节点图（实测输出摘要）

用 §5.4 的 base + 4 个 newNodes 跑 `generate → merge → parse`：
```
BASE bytes 1559
MERGED bytes 3256
nodes 5
node1 id=1 index=1 label=AUTO:global_cdl   correctorTypes=[1,2]   sat=0.022  ← 被 double-scale（坑）
node2 id=2 index=2 label=AUTO:skin_key     correctorTypes=[1,2,2] qualifier={hueCenter:33.000001,hueWidth:22,hueSymmetry:50,hueSoft:11,satHigh:88,satLow:12,satHighSoft:5,satLowSoft:5,lumHigh:80.000001,lumLow:20,lumHighSoft:5,lumLowSoft:5,modeFlag:4}
node3 id=3 index=3 label=AUTO:highlight    correctorTypes=[1,2,2] qualifier={lumHigh:100,lumLow:69.999999,lumHighSoft:10,lumLowSoft:20}
node4 id=4 index=4 label=AUTO:bg_hue       correctorTypes=[1,2,65554] powerWindow={type:5,pan:80,tilt:40,soft1:30,opacity:70}
node5 id=5 index=5 label=AUTO:skin_win     correctorTypes=[1,2,2,4] qualifier={...} powerWindow={type:1,size:35,aspect:60,pan:55,tilt:45,soft1:25}
connections 1→2→3→4→5
```
结论：qualifier / lumaQualifier / window（含 gradient）确实能写进多层图并逐字段解码；
NodeIndex 顺序 1..N；LayerIndex 不存在。

另测：
- 单节点同时带 HSL qualifier + 圆形窗 → `correctorTypes=[1,2,2,4]`，qualifier/window 都解码正确。
- `rgbQualifier` 写出的 raw 参数为 `qualifier.rgbRLow=0.12` 等（UI 12 → ÷100），mode=2 在
  ct2 参数里可见；`parse.qualifier` 只暴露 `{mode:0}`（§5.6 的解码坑）。
- Polygon window（`type:3` + 4 个 vertices）→ `correctorTypes=[1,2,2,6]`，
  `params.polygonVertices` 解码出 13 点 ring；`powerWindow=null`。
- `resolveVersion:21` + 圆形窗 → corrector type `65540 (0x10004)`，窗口参数完整解码。
- merge 后基线 saturation：base 单独 parse 是 `1.1`（UI 55），merge 后变 `0.022`。
- merge 后基线 qualifier：base 单独有完整 qualifier，merge 后只剩 `{"mode":0}`。
- `lumMixSlider:100` + `gain R=G=B=1.2` → 返回 warning（Resolve 会抵消等量 RGB 的亮度）。

### 8.3 返回/行为坑清单

| # | 坑 | 证据 | 规避 |
|---|---|---|---|
| 1 | `drx.parse` 带 `_raw`，1 节点 1.8MB | 实时 MCP 实测（省略 1,841,303 bytes） | 只取 `nodes`/`valueFidelity`；见 §3.1 模板 |
| 2 | `toolBreakdown` 恒为默认值 | `drx.mjs:716` 传数组给期望对象的函数 | 不用它 |
| 3 | `generate_from_request` 不可用：返回 `{buffer,resolved}`，`outputPath` 被忽略、无 `content` | 实测 `G-F-R with outputPath keys [ 'buffer', 'resolved' ]` | 用 `generate`（或先 `resolvedDrxGenerator` 逻辑自己算） |
| 4 | `export_cdl` 的 saturation 再 ÷50 | 实测 UI60→CDL 0.024 | CDL 只要 slope/offset/power，或传 `params` |
| 5 | merge 丢 base 的次级/曲线 | 实测 qualifier → `{"mode":0}` | base 只放主调色 |
| 6 | merge 双重缩放 base 的 saturation | 实测 1.1→0.022 | base 不放 saturation |
| 7 | `carry_look.plan[].args` 参数名与 live 不符 | `season-look.mjs:79-88` vs `src/server.py:30121+` | 自己映射到 `path/source/group_name/grade_mode` |
| 8 | `verify_grade` 每个普通 grade 都报 `unverifiableParams:['qualifier.mode']` | companion 块（`drx-generator.js:702-715`） | 忽略该项；看 verdict/deltas |
| 9 | `safe_apply_drx` 默认只收 temp 路径 | `src/server.py:22010-22022` | 生成到 `/tmp/...` 或 `require_temp_path:false` |
| 10 | `safe_apply_drx` 参数级证明不了 | readback 只比 node count/label/LUT | 用 §6.3 `.drp` 回读 + `verify_grade` + §6.4 帧对比 |
| 11 | `target:'clip'` 文件 apply 到 timeline → `DRX_NO_TIMELINE_GRADE` | `src/server.py:29715-29745` | target 与 source 配对 |
| 12 | 21.1 上 `item_index` 会把 transitions 算进去 | `src/server.py:3401-3403` | 优先 `timeline_item_id` |
| 13 | relayout 后 same-structure apply 不动布局 | `README.md:168`, `src/server.py:675-677, 32003-32007` | 先 `graph.reset_all_grades` 再 apply |
| 14 | `hue-axis` HSL 曲线非规范笼形渲染为平/可能崩 | `drx.mjs:330-344, 560-582` | 传 naive 点让工具 canonicalize；别手写 wrap |
| 15 | Polygon/Curve 窗口写路径未 live 验证 | `drx-generator.js:2874-2920` vs CALIBRATION-STATUS.md:66 | 优先 Circle/Linear/Gradient |
| 16 | OFX/`colorWarper` 参数非真值 / R19 不认 | CALIBRATION-STATUS.md（Color Warper 行） | 只用 primaries/qualifier/window/curves |
| 17 | `drx.extract_frames` 硬拒绝 LOG 源 | `extract-frames.mjs:87-108` | 传 display-referred proxy/render |

---

## 9. 源码索引（file:line）

根目录缩写：
- `S` = `$HOME/Library/Application Support/davinci-resolve-mcp/resolve-advanced/server`
- `G` = `.../resolve-advanced/vendor/drx-codec/drx-generator.js`
- `P` = `.../resolve-advanced/vendor/drx-codec/drx-parser.js`
- `M` = `.../resolve-advanced/vendor/drx-codec/drx-merger.js`
- `RQ` = `.../resolve-advanced/vendor/drx-parameters`
- `PY` = `$HOME/Library/Application Support/davinci-resolve-mcp/src/server.py`
- `CT` = `.../davinci-resolve-mcp/src/utils/confirm_tokens.py`

| 主题 | 位置 |
|---|---|
| `drx` 工具描述/action 清单 | `S/tools/drx.mjs:683-987` |
| `parseSchema` / `parse` 分派 | `S/tools/drx.mjs:233-238`, `:688-718` |
| `generateSchema` / `generate` 分派 | `S/tools/drx.mjs:240-274`, `:720-736` |
| `generate_from_request` | `S/tools/drx.mjs:276-279`, `:738-747`；`vendor/drx-codec/resolved-drx-generator.js:186-210` |
| `export_cdl` / `merge` / `relayout` schemas | `S/tools/drx.mjs:281-288`, `:290-304`, `:119-134` |
| 匹配器 schemas | `S/tools/drx.mjs:44-109`（level/skin/shot/black）、`:148-175`（contrast/gamut/wb） |
| `scope_read` schema/分派 | `S/tools/drx.mjs:206-210`, `:955-960` |
| `verify_grade` schema/分派 | `S/tools/drx.mjs:213-217`, `:962-965` |
| `extract_frames` schema/分派 | `S/tools/drx.mjs:219-225`, `:967-970` |
| `intent_tags` schema/分派 | `S/tools/drx.mjs:227-231`, `:972-978` |
| `space` 换算 / `UI_TO_DRX` | `S/tools/drx.mjs:314-328`, `:477-594` |
| HSL hue 轴 canonicalize | `S/tools/drx.mjs:330-475`, `:546-593` |
| `normalizeNewNode` | `S/tools/drx.mjs:596-611` |
| `valueFidelity` / keyframe 检测 | `S/tools/drx.mjs:619-681` |
| scope_read 实现/ROI/统计/信号 | `S/scope-read.mjs:81-101`（ROI）、`:109-257`（统计）、`:45`（肤色线 123°） |
| skin_match 实现 | `S/skin-match.mjs:47-56`（肤色判据）、`:102-205`（主流程）、`:199-202`（零肤色 throw） |
| shot_match 实现 | `S/shot-match.mjs:53-74`（median）、`:82-146`（主流程） |
| exposure_level 实现 | `S/exposure-level.mjs:46-63`（asserted gain DRX）、`:70-128`（主流程） |
| white_balance_match | `S/white-balance-match.mjs:32-51`, `:59-121` |
| contrast_normalize | `S/contrast-normalize.mjs:45-72`, `:74-78`（offset 单位）, `:84-117`, `:124-179` |
| black_balance | `S/black-balance.mjs:31-56`, `:62-91` |
| match_to_reference | `S/match-to-reference.mjs:39-85`, `:91-172` |
| saturation_match | `S/saturation-match.mjs:31-59`, `:62-71`, `:77-107` |
| tone_curve_transfer | `S/tone-curve-transfer.mjs:37-100`, `:103-116`, `:123-183` |
| grade_transfer | `S/grade-transfer.mjs:24-28`, `:35-66` |
| drxEnvelope（apply-ready 信封） | `S/tools/color_trace.mjs:78-116` |
| author_look / carry_look | `S/season-look.mjs:44-66`, `:74-95` |
| lut_apply | `S/lut-apply.mjs:38-60` |
| cdl_io | `S/cdl-io.mjs:47-75` |
| verify_grade 实现 | `S/verify-grade.mjs:54-112` |
| extract_frames 实现/色彩空间守卫 | `S/extract-frames.mjs:87-108`, `:111-123`, `:140-195` |
| gamut_legal | `S/gamut-legal.mjs:29-85`, `:93-111` |
| provenance 标签约定 | `S/node-provenance.mjs:21-56` |
| 分类目录（何时用哪个匹配器） | `S/tool-catalog.mjs:38-260` |
| `drx.generate` 入口 | `G:1998-2083` |
| 多节点 protobuf / 串联 | `G:1658-1760`, `G:1769-1900` |
| `createNode`（F1/F2 + corrector 编排） | `G:550-940` |
| qualifier builder（HSL/RGB/luma） | `G:2660-2810` |
| window builder（circle/linear/gradient/polygon） | `G:2838-2985` |
| R21 窗口形式（0x10004） | `G:2986-3045` |
| custom/hsl 曲线 builder | `G:455-538` |
| HDR 分区 builder | `G:2511-2620` |
| primary/contrast/hue/lumMix/satVsSat builder | `G:951-1381` |
| `parseDRXContent` / `extractNodes` / params | `P:959-1035`, `P:608-880` |
| `extractToolBreakdown`（对象入参）/ FromDRX | `P:1236-1353`, `P:1355-1420` |
| mergeNodes / generateMergedDRX | `M:108-203`, `M:213-273` |
| qualifier/window 参数 ID 与量表 | `RQ/parameter-ids.js:423-470`, `RQ/parameter-ranges.js:262-320` |
| 已校准写路径总账 | `RQ/CALIBRATION-STATUS.md:60-120` |
| `safe_apply_drx` | `PY:30121-30166` |
| `apply_grade_from_drx` readback / DRX_NO_TIMELINE_GRADE | `PY:29715-29745`, `PY:29808-29870` |
| item 解析（timeline_item_id / item_index） | `PY:3397-3440` |
| temp 路径守卫 | `PY:22010-22022` |
| confirm token（签发/校验/指纹） | `CT:147-183`, `CT:186-240` |
| profile 服务器配置 | `~/.dsh/profiles/web/cordis.patch.yml:37-75` |
| 插件 callTool / 工具名发现 | `host-base.mjs:68-149`；confirm_token 范式 `host-base.mjs:365-385` |

---

## 附：给插件的落地检查清单

- [ ] 所有步骤都通过 `callTool`，高级工具 payload 用 `{action, args}`。
- [ ] 生成 `.drx` 一律写 `/tmp/davinci-panel/…`（或每次显式 `require_temp_path:false`）。
- [ ] `generate` 的基线只放主调色，**不放 saturation**；次级全部放 `merge.newNodes`。
- [ ] `merge` 后必须 `parse` 自检（节点数、NodeIndex 顺序、qualifier/window 字段），失败就不 apply。
- [ ] apply 用 `timeline_item_id`（稳定），不要用 `item_index`。
- [ ] `safe_apply_drx` 的 `confirmation_required` 要接住 `err.mcpValue.confirm_token`，二次调用参数不变。
- [ ] `warning: "No graph changed…"` 不当失败；参数级证明走 `.drp` 回读 + `verify_grade`。
- [ ] `parse` 结果裁字段后再给 UI/模型（`_raw` 会爆上下文）。
- [ ] `scope_read`/匹配器在 sharp 装好前不要暴露按钮，或做可用性探测并给出明确文案
      （帧证据优先走 `lib/layers.mjs` + `drx.extract_frames`，见 §7.4）。
- [ ] 21.x + 窗口的 `.drx` 必须带 `resolveVersion:21`。
