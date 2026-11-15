# 色彩管线体检 / 自动修复 — 契约文档（v1）

> 目标读者：实现 `host-impl.mjs` 中 `pipeline.snapshot / pipeline.diagnose / pipeline.fix` 的人。
> 本文件里每条事实都标了来源：**[实测]** = 本机 Resolve 21.0.0b.20 上只读探针结果；**[源码]** = davinci-resolve-mcp 源码位置；**[API 文档]** = Resolve 脚本 API 文档；**[文档]** = BMD/公开资料；**[推断]** = 由前述事实推导。原始证据见 `docs/color-pipeline-notes-src/`。
>
> 调研环境：macOS darwin/arm64 · DaVinci Resolve **Studio 21.0.0b.20**（GUI，Disk DB）· davinci-resolve-mcp **4.19.3** · 当前项目时间线「录屏」。

---

## 0. 一句话结论

1. **色彩管线状态是「可读」的**：`Project.GetSetting('')` 一次返回约 160 个键（键数随版本变动），色彩/HDR/监看/电平全在里面；时间线还有一层覆盖（`Timeline.GetSetting`）；每个素材的 `Input Color Space / Input Gamma` 也能读。**[实测]**
2. **能写，而且 `SetSetting` 对色彩键没有「不可写」记录**——但「能写」≠「该自动写」：改 `colorScienceMode` / `colorSpaceTimeline` / `colorSpaceOutput` 会**直接改变已调画面的解释**，必须人工确认。**[实测+源码]**
3. **渲染层色彩标签（`ColorSpaceTag` / `GammaTag`）写得进、读不回**：本机 `Project.GetRenderSettings` 不存在，`render.get_settings` 直接报错。**[实测]**
4. **macOS 的 `Use Mac Display Color Profiles for Viewers` 和 `Tag Rec.709 clips as Rec.709-A` 不在任何脚本 API 里**，只能提示人工改；不过它们的落盘值能在 `~/Library/Preferences/Blackmagic Design/DaVinci Resolve/.config.data` 里**只读**看到（`EnableDisplayColorProfile` / `Tag709ClipsAs709A`）。**[实测]**
5. **最常见的「Mac 上偏亮/偏灰」不是 Resolve 坏了，是 gamma 2.4 ↔ 1.96 的显示解释差**（见 §4 与 `src/06`），所以修复方向取决于交付目标，**不存在唯一正确值**。
6. ⚠️ **实现前必读 §2**：MCP 工具参数必须放 `params` 里。当前 host 的扁平写法会让 `set_setting` 直接失败（`set_setting requires name`），已实测复现。

---

## 1. 现状盘点：`diagnosePipeline` 里用错的键名

现在 `host-impl.mjs` 的 `PIPE_KEYS` 是猜的键名，与真实键对不上，会导致「读不到 → 误报未设置」。**[实测]** 下的对照：

| 现在代码里用的键 | 真实情况 | 应改成 |
|---|---|---|
| `colorScienceMode` / `colorScience` | ✅ `colorScienceMode` 存在（值 `"davinciYRGB"`） | `colorScienceMode`（`colorScience` 不存在，删掉） |
| `timelineColorSpace` / `timelineColorSpaceMode` | ❌ 项目级不存在；项目键是 `colorSpaceTimeline` | `colorSpaceTimeline` |
| `timelineGamma` / `timelineGammaMode` | ❌ 不存在 | `colorSpaceTimelineGamma`（分离模式）+ 非分离时 gamma 在 `colorSpaceTimeline` 合并串里 |
| `outputColorSpace` / `timelineOutputColorSpace` / `displayColorSpace` | ❌ 都不存在 | `colorSpaceOutput` |
| `outputGamma` / `displayGamma` | ❌ 不存在 | `colorSpaceOutputGamma`（分离模式）+ 合并串 `colorSpaceOutput` |
| `separateColorSpaceAndGamma` | ✅ 存在（`"0"`/`"1"`） | 保留 |
| 时间线覆盖 | ❌ 现在完全没读 | 加读 `Timeline.GetSetting('useCustomSettings'\|'colorSpaceTimeline'\|'colorSpaceOutput'\|'colorSpaceTimelineGamma')` |

另外 `pickSetting()` 会跳过空字符串——这对 gamma 键恰好是**对的**（分离模式关闭时 `colorSpaceOutputGamma` 就是 `""`），但必须配合「合并串解析」兜底，否则会得出「gamma 未设置」的误报。

---

## 2. 调用约定（先修这个，否则修复功能不工作）

MCP 工具签名是 `tool(action: str, params: dict|None)`；FastMCP 用 pydantic 模型校验参数，**schema 外的顶层键会被静默丢弃**。**[源码]** `src/server.py:266`（`ErrorFlaggingFastMCP`，只给结果打 `isError`）、`venv/.../mcp/server/fastmcp/utilities/func_metadata.py`（`ArgModelBase.model_config = ConfigDict(...)` → pydantic 默认 `extra="ignore"`；`fn(**model_dump_one_level())`）。

```js
// ❌ 现在的写法：name/value 被丢掉
callTool(ctx, 'project_settings', { action: 'set_setting', ...finding.recommended })
// → {"error":{"message":"set_setting requires name", ...}}      [实测]

// ✅ 必须这样
callTool(ctx, 'project_settings', { action: 'set_setting', params: { ...finding.recommended } })
// finding.recommended = { name: 'colorSpaceOutput', value: 'Rec.709-A' }
```

**为什么之前没暴露**：`get_setting` 不传 name 的默认行为就是「返回全量快照」，所以 `opPipelineSnapshot` 里 `{action:'get_setting', name:''}` 即使把 `name` 丢了也**碰巧**返回同样的东西。`set_setting` 没有这种默认值，所以一写就报。细节与源码行号见 `docs/color-pipeline-notes-src/05-mcp-arg-convention.md`。

**副作用提醒**：修完 `pipeline.fix` 后，`host-base.mjs` 里其它 `action + 扁平参数` 的调用（CDL / transform / crop / save_version …）同样是丢参数的，只是还没被点过；建议统一改成 `{action, params}`。

---

## 3. 色彩管理键清单

### 3.1 项目级（`Project.GetSetting('')` / `project_settings get_setting`）**[实测]**

以下全部来自本机真实项目的一次快照（完整 JSON 见 `src/01-project-settings-snapshot.json`）。

| 键 | 实测值 | 类型/取值 | 含义 | 可写 | 自动修复安全度 |
|---|---|---|---|---|---|
| `colorScienceMode` | `"davinciYRGB"` | 枚举字符串：`davinciYRGB` / `davinciYRGBColorManagedv2` / `acescct`（兼容 `acescc`）**[源码+dvr]** | 色彩科学：非管理 / RCM / ACEScct | ✅（`probe_catalogue.py:186` 就用字符串写过；dvr 实测 RCM 键族可端到端设） | 🔴 **绝不自动改**：切换会改变已调画面 |
| `rcmPresetMode` | `"Custom"` | RCM 预设名 | RCM 预设（Custom/HDR PQ/…） | ✅（未逐一验证） | 🟡 只读展示 |
| `isAutoColorManage` | `"0"` | `"0"`/`"1"` | 自动色彩管理 | ✅（dvr 实测） | 🔴 不动 |
| `separateColorSpaceAndGamma` | `"0"` | `"0"`/`"1"` | **分离色彩空间与 gamma 下拉**；=1 时 gamma 走独立键 | ✅（dvr 实测） | 🟡 只在用户明确要分离时改 |
| `colorSpaceInput` | `"Rec.709 Gamma 2.4"` | 合并串（空间+gamma） | RCM 输入（项目默认）；非管理模式下不参与运算，但键仍在 | ✅ | 🟡 |
| `colorSpaceInputGamma` | `""` | 串 | 分离模式下的输入 gamma | ✅ | 🟡 |
| `colorSpaceTimeline` | `"Rec.709 (Scene)"` | 串：`Rec.709 (Scene)` / `Rec.709` / `Rec.2020` / `P3-D65` / `DaVinci WG` … | 时间线色彩空间 | ✅ | 🔴 改它=改解释 |
| `colorSpaceTimelineGamma` | `""` | 串 | 分离模式下的时间线 gamma | ✅ | 🔴 |
| `colorSpaceOutput` | `"Rec.709 (Scene)"` | 同上 | 输出色彩空间 | ✅ | 🟠 改它会改变渲染与查看器观感（可逆，但需确认） |
| `colorSpaceOutputGamma` | `""` | 串：`Gamma 2.4` / `Gamma 2.2` / `sRGB` / `Rec.709-A` / `ST2084` …（枚举未逐一实测） | 分离模式下的输出 gamma | ✅ | 🟠 同上；`Rec.709-A` 是 Mac 兼容选项 |
| `colorSpaceOutputToneMapping` | `"None"` | `None`/`DaVinci`/… | SDR 输出 tone mapping | ✅ | 🟠 HDR→SDR 关键 |
| `colorSpaceOutputToneLuminanceMax` | `"100"` | 数字串（nits） | tone mapping 目标亮度 | ✅ | 🟡 |
| `colorSpaceOutputGamutMapping` | `"None"` | `None`/… | 色域映射 | ✅ | 🟡 |
| `colorSpaceOutputGamutSaturationKnee` / `…Max` | `"0.9"` / `"1"` | 0..1 | 色域压缩参数 | ✅ | 🟡 |
| `colorAcesIDT` | `"No Input Transform"` | 串 | ACES 输入变换 | ⚠️ 可写但**部分值被静默拒绝** **[dvr]**；21.1 changelog 记过 `colorAcesODT` 某些值不生效 | 🔴 不自动写（写了也不可信） |
| `colorAcesODT` | `"No Output Transform"` | 串 | ACES 输出变换 | 同上 | 🔴 |
| `colorAcesNodeLUTProcessingSpace` | `"acesccAp1"` | 串 | ACES 节点处理空间 | ✅ | 🟡 |
| `colorAcesGamutCompressType` | `"None"` | 串 | ACES 色域压缩 | ✅ | 🟡 |
| `inputDRT` / `outputDRT` | `"None"` | 串 | DRT | ✅ | 🟡 |
| `inputDRTSatRolloffStart/Limit`、`outputDRTSatRolloffStart/Limit` | `"100"/"10000"` | 数字串 | DRT 饱和滚降 | ✅ | 🟡 |
| `useInverseDRT` | `"0"` | `"0"`/`"1"` | 反向 DRT | ✅ | 🔴 |
| `useCATransform` | `"1"` | `"0"`/`"1"` | 色适应变换 | ✅ | 🟡 |
| `useColorSpaceAwareGradingTools` | `"0"` | `"0"`/`"1"` | 色彩空间感知调色工具（Resolve 19+） | ✅ | 🟠 开启会改变工具行为 |
| `colorUseLegacyLogGrades` | `"2"` | 整数串 | 旧版 Log 调色兼容 | ✅ | 🟡 |
| `timelineWorkingLuminance` / `…Mode` | `"1000"` / `"HDR 1000"` | 数字 / `HDR 1000`/`HDR 4000` | 工作时间线亮度 | ✅（dvr 实测 `HDR 4000` 等） | 🟠 |
| `hdrMasteringOn` | `"0"` | `"0"`/`"1"` | HDR 母版开关 | ✅（dvr 实测） | 🟠 |
| `hdrMasteringLuminanceMax` | `"1000"` | 数字串 | HDR 母版峰值 | ✅ | 🟠 |
| `hdrDolbyControlsOn` / `hdr10PlusControlsOn` / `hdrDolbyVersion` / `hdrDolbyMasterDisplay` / `hdrDolbyAnalysisTuning` | `"0"`/`"0"`/`"4.0"`/`""`/`"Balanced"` | — | Dolby Vision / HDR10+ 控制 | ✅ | 🟡 只读展示 |
| `videoDataLevels` | `"Video"` | `Video`/`Full` | 项目数据电平 | ✅（值枚举由实测确认） | 🟠 改它影响全项目解码 |
| `videoDataLevelsRetainSubblockAndSuperWhiteData` | `"0"` | `"0"`/`"1"` | 保留 superwhite | ✅ | 🟡 |
| `videoMonitorFormat` / `videoMonitorBitDepth` / `videoMonitorUseHDROverHDMI` / `videoMonitorScaling` / `graphicsWhiteLevel` | `"HD 1080p 24"`/`"10"`/`"0"`/`"bilinear"`/`"100"` | — | 监看输出配置（SDI/HDMI） | ✅ | 🟡 只读展示 |
| `limitBroadcastSafeOn` / `limitBroadcastSafeLevels` | `"0"` / `"20_120"` | — | 广播安全 | ✅ | 🟡 |
| `colorVersion1Name` … `colorVersion10Name` | `""` ×10 | 串 | 颜色版本名 | ✅ | 🟡 |
| `nodeStackLayers` | `"1"` | 数字串 | 节点层数 | — | — |

**不存在、不要再猜的键**（实测约 160 键里没有）：`timelineColorSpace`、`outputColorSpace`、`displayColorSpace`、`timelineGamma`、`outputGamma`、`displayGamma`、`colorVersion`、`colorScience`。

> 注：`src/utils/project_properties.py` 里那张 `PROJECT_PROPERTY_TYPES` 表（含 `timelineColorSpace`/`timelineGamma` 和 `colorScienceMode: int`）是**旧/通用猜法**，与 21.0.0 实测不符（`colorScienceMode` 实际是字符串，不是 0/1/2）。**不要照抄那张表**；`src/utils/project_lint.py:48` 的注释「Resolve reports `davinciYRGB` when managed off」才与实测一致。

### 3.2 时间线级覆盖（`Timeline.GetSetting`）**[实测]**

Resolve 21 的时间线可以覆盖项目色彩设置。本机当前时间线「录屏」：

| 键 | 实测值 | 说明 |
|---|---|---|
| `useCustomSettings` | `"0"` | `1` = 该时间线使用自己的色彩设置（**这是「项目设置对、这条时间线不对」的唯一解释**） |
| `colorSpaceTimeline` | `"Rec.709 (Scene)"` | 时间线色彩空间 |
| `colorSpaceOutput` | `"Rec.709 (Scene)"` | 时间线输出色彩空间 |
| `colorSpaceTimelineGamma` | `""` | 分离模式下的 gamma |

- 坑：`Timeline.GetSetting('')`（不传键）返回的是**项目级全量快照**，不是时间线专属键集合。要读覆盖必须**逐键**读。**[实测]**
- 可写：`Timeline.SetSetting` 存在，`src/granular/timeline.py:1105-1118` 明确把 `useCustomSettings`、`colorSpaceTimeline`、`colorSpaceOutput` 列为可写 timeline setting。**[源码]**

### 3.3 素材级（`MediaPoolItem.GetClipProperty`）**[实测]**

对一个真实 H.264 素材读到的色彩相关字段：

| clip 属性键 | 实测值 | 说明 |
|---|---|---|
| `Input Color Space` | `"Rec.709 (Scene)"` | 素材输入色彩空间（Clip Attributes） |
| `Input Gamma` | `"Rec.709"` | 素材输入 gamma |
| `Input LUT` | `""` | 输入 LUT |
| `IDT` | `""` | ACES IDT 标注 |
| `Mon Color Space` / `Monitor LUT` | `""` | 监看覆盖 |
| `Color Space Notes` / `Gamma Notes` | `""` | 备注字段（可当人工标注位） |
| `Data Level` | `"Auto"` | 素材数据电平 |
| `Format` / `Video Codec` / `Resolution` / `Bit Depth` / `FPS` | `QuickTime` / `H.264 High L4.0` / `1920x1080` / `8` / `24.0` | 辅助判断是否 Log/宽色域 |

- **读：已验证**（一次 `get_clip_property` 就全给了）。
- **写：未验证**。`MediaPoolItem.SetClipProperty('Input Color Space', …)` 在文档语义上应该可以（官方说这些键对应 Clip Attributes 对话框），但本机**没有实测**（不想拿用户项目做写实验）。实现里若要做，必须「写 → 单键读回 → 不一致就判失败并给 UI 指引」。
- **降级**：无法读取素材（离线/未选中）时不要猜；输出 `unknown` 而不是「未标注」。

### 3.4 渲染/输出级（`render set_settings` 的 `ColorSpaceTag` / `GammaTag`）

- 这两个键在服务端白名单里：`src/server.py:21976`（`_RENDER_SETTING_KEYS` 含 `"ColorSpaceTag"`、`"GammaTag"`）。**[源码]**
- **没有读回**：本机 `render get_settings` 报
  `GetRenderSettings requires DaVinci Resolve unknown+` → `Project.GetRenderSettings` 在 21.0.0 上不存在。**[实测]**
- `AddRenderJob` 的 job 读回字段只有 TargetDir / OutputFilename / MarkIn / MarkOut / VideoFormat / VideoCodec / RenderMode / PresetName，**不含色彩标签**。**[API 事实：api_truth · Project.AddRenderJob]**
- `SetRenderSettings` 是在 Deliver 页当前 preset **之上叠加**，且基线不可读。**[API 事实：api_truth · Project.SetRenderSettings (inherits the loaded preset)]**
- **结论**：`GammaTag` 只能「写 + 事后 ffprobe 产物」；且 §7 会说明 ffprobe 看不到 display gamma，所以**「已设为 Rec.709-A」这句话不可验证**，UI 文案必须写清。

### 3.5 不可写 / 不可读 / 只能提示的项（逐条引用 api_truth）

| 项 | 结论 | 引用（`resolve_control api_truth query=…`） |
|---|---|---|
| 打开「项目设置」对话框 | 不存在此 API | `Resolve.GetUIManager / UIManager.OpenProjectSettings / OpenPreferences (do not exist)` |
| 打开「偏好设置」对话框 | 不存在此 API | 同上 |
| `Project.SetSetting('timelinePlaybackFrameRate')` | 任何值都返回 False（唯一被逐键记录为不可写的项目键） | `Project.SetSetting('timelinePlaybackFrameRate')` |
| 色彩键写失败的原因 | 服务端只会回裸 `{success:false}`（`known_limitation` 只对上面那种精确命中的条目出现） | **[源码]** `server.py:21724 _setting_limitation()` |
| 渲染设置基线（含色彩标签） | 不可读 | `Project.SetRenderSettings (inherits the loaded preset)` / `Project.AddRenderJob (the only readback for render settings)` |
| 读 render mode 会切页 | 体检不要调 `render probe_render_settings` | `Project.GetCurrentRenderMode (switches to the Deliver page)` |
| 播放中切页会卡死 Resolve | 抓帧/切 Color 页前先检测播放 | `Resolve.OpenPage (during playback)` |
| ACES IDT/ODT | 部分值被静默拒绝；21.1 修复过 `colorAcesODT` 某些值 | **[文档]** `docs/reference/resolve_scripting_changelog_21.1.md`（20.2.1 Addressed）；**[dvr]** `spec.py` COLOR_PRESETS 上方注释 |

### 3.6 Preferences 层（macOS 专属，**只能提示人工改**）**[实测]**

| UI 项 | 落盘键（`~/Library/Preferences/Blackmagic Design/DaVinci Resolve/.config.data`） | 本机值 | API 可达？ |
|---|---|---|---|
| Use Mac Display Color Profiles for Viewers | `EnableDisplayColorProfile` | `1`（开） | ❌ 无读写 API；只能只读文件做提示 |
| Automatically tag Rec.709 clips as Rec.709-A | `Tag709ClipsAs709A` | `0`（关） | ❌ 同上 |
| （Resolve 21 新增）Viewers match QuickTime player when using Rec.709 (Scene) | 落盘键**未定位**（本机 `.config.data` 里没有） | 未知 | ❌ 只能让用户看 UI |

- 21.0.0 上连「用户偏好预设」都没有：`Resolve.GetUserPreferencesPresetList / Save / Load / Export / Import…` 全在 `get_version.build.unavailable_on_this_build`（21.0.4+ 才有）。**[实测]**
- **不要写这个文件**：Resolve 持有并会重写它，格式脆弱、改了要重启才生效，写坏会丢偏好。
- 读它也要容错：文件可能不存在（首次启动）、可能是 `.config.data.bak`、未来版本可能搬家。读不到就返回 `unknown`，不要返回 `false`。

---

## 4. macOS 709-A / gamma shift（速查；完整推导见 `src/06-709a-and-gamma-shift.md`）

### 4.1 术语一句话版

- **Rec.709 2.4**：Rec.709 色度 + 显示 gamma 2.4 —— 广播/院线的标准，「正确」的前提是接收端也按 2.4 显示。
- **Rec.709-A**：BMD 为 **QuickTime/Apple 兼容**加的 gamma 选项（16.2.2 起）。当渲染 **Gamma Tag** 用时 = 传输函数标记留空，交给 Apple 色彩管理映射；当**输出色彩空间**用时 = 把 Apple 显示 gamma（常见说法 **1.96**，部分资料写 1.9）烘进信号。
- **Rec.709 (Scene)**：Resolve 18+ 的「场景参考 Rec.709」，与偏好「Viewers match QuickTime player when using Rec.709 (Scene)」配套时查看器按 Apple gamma 显示。**本机项目当前就是这个值**。
- **ColorSync / ICC**：macOS 显示链路。Resolve 默认**不参与**，所以查看器与 QuickTime/Safari 天然可能不一致；`Use Mac Display Color Profiles for Viewers` 就是让 Resolve 也参与（只影响查看器）。
- **tag 丢失**：素材/成片没有（或被忽略）色彩元数据，每端按自己的假设解释 → 同一文件在不同播放器亮度不同。

### 4.2 为什么会偏亮 / 偏灰 / 暗部抬升 **[推断]**

`v = L^(1/γ_enc)`，显示 `L' = v^(γ_disp)`：

| 情形 | 公式 | 观感 |
|---|---|---|
| 2.4 编码，被 1.96 解码（QuickTime/Apple 链路） | `L' = L^(1.96/2.4) = L^0.817` | **整体提亮、对比下降、暗部抬升 → 发灰** |
| 1.96（709-A）烘焙，被 2.4 解码（Windows/多数播放器/广播） | `L' = L^(2.4/1.96) = L^1.224` | **整体压暗、暗部发死** |
| 2.2 编码被 2.4 解码 | `L' = L^1.091` | 轻微压暗（温和得多） |

黑点仍是 0，所以不是「黑变灰」的字面意义，而是**暗部斜率变大**，观感「闷、没层次、发灰」。

### 4.3 症状 → 根因（完整表见 `src/06` §3）

| 症状 | 最可能根因 | 插件可读的判定条件 |
|---|---|---|
| Resolve 里对，QuickTime/预览里偏亮发灰 | 2.4 编码 + Apple 1.96 解释；查看器是否纳入 ColorSync | `darwin` + 2.4 类输出 + `EnableDisplayColorProfile` 状态 + 交付目标 |
| Mac 正常，iPhone/微信里偏暗 | 烘焙/标记了 709-A，接收端按 2.4 解释 | 输出空间或 gamma 匹配 `/709[\s-]*a/i` |
| 查看器本身就偏 | `Use Mac Display Color Profiles for Viewers` 开着且系统 ICC 是 Display P3 之类 | 只能读偏好文件/让用户确认 |
| 素材一进时间线就平/灰 | 非管理管线 + Log 素材无输入转换；或 `Input Color Space` 未标注 | `colorScienceMode=davinciYRGB` + clip `Input Color Space` 空/不符 |
| 项目设置对，某条时间线不对 | 时间线覆盖 `useCustomSettings=1` | 项目级 vs 时间线级 `colorSpace*` 对比 |
| 渲染出来发灰/发黑 | 渲染 `ColorSpaceTag/GammaTag` 与项目不符（无读回） | 写后 ffprobe 产物 |
| HDR 导出 SDR 爆/灰 | HDR 母版开 + 输出 SDR + tone/gamut mapping 都是 None | `hdrMasteringOn=1` + 输出非 PQ + `colorSpaceOutputToneMapping="None"` |
| 暗部高光同时失真 | 数据电平 Video/Full 不匹配 | `videoDataLevels` + clip `Data Level` |

### 4.4 macOS 正确管线（按交付目标选；没有唯一正确答案）

| 交付目标 | `colorScienceMode` | `separateColorSpaceAndGamma` | 输出空间 + 输出 gamma | 偏好设置 | 能自动写吗 |
|---|---|---|---|---|---|
| 广播/放映/Windows 为主的 SDR | YRGB 或 RCM | `1` | `Rec.709` + `Gamma 2.4` | 关 `Tag709ClipsAs709A` | 项目键可写（需确认）；偏好只能提示 |
| Mac 本机预览 = QuickTime（推荐 B1） | 任意 | `1` | `Rec.709 (Scene)` + （空/合并串） | 开 **Viewers match QuickTime player when using Rec.709 (Scene)** | 项目键可写；**偏好只能提示** |
| 只在交付层解决 Mac 一致性（B2） | 任意 | 不改 | 项目不动，渲染 `GammaTag = Rec.709-A` | — | 可写、**不可验证** |
| 跨平台自洽（web，画面烘死，B3） | 任意 | `1` | `Rec.709-A`（作为输出色彩空间） | — | 可写但改变画面，🟠 |
| Mac 屏所见即所得（ICC=Display P3） | 任意 | `1` | `P3-D65` + `sRGB` | 开 `EnableDisplayColorProfile` | 项目键可写；偏好只能提示 |
| HDR PQ | YRGB（RCM） | `1` | `Rec.2020` + `ST2084`/`Rec.2100 ST2084`；`hdrMasteringOn=1`；`hdrMasteringLuminanceMax` 与母版一致 | — | 项目键可写，🟠 |

> 依据：BMD《Colorist Guide to DaVinci Resolve 20》Appendix B（P3-D65 + sRGB、Gamma Tag 用 709-A、709-A 作为输出空间用于网络交付）；CineDream 文档（Resolve 21 时代两个 Mac 偏好开关、Rec.709 (Scene) ↔ Apple gamma 1.9）。链接见 `src/06` §6。

---

## 5. 诊断规则表（可直接落成数据表）

### 5.1 输入快照（`snapshot`）契约

```js
{
  platform: 'darwin' | 'win32' | 'linux',
  arch, osRelease, node,
  version: { product, version: [21,0,0,20,'b'], version_string: '21.0.0b.20' } | null,
  versionError: string | null,
  runtime: { success, determinable, running, headless, instances, database } | null,
  project: { name, id } | null,
  settings: { ok: true, value: { settings: {…约 160 键…} } } | { ok: false, error },
  timeline: {                    // ★ 新增，见 §7
    ok, error?,
    name,
    useCustomSettings: boolean,
    colorSpaceTimeline: string, colorSpaceOutput: string, colorSpaceTimelineGamma: string,
  },
  prefs: {                       // ★ 新增，darwin only，只读
    ok, path,
    enableDisplayColorProfile: boolean | null,   // null = 读不到，不是 false
    tag709ClipsAs709A: boolean | null,
  },
  clips: [{                      // ★ 可选：抽样，最多 N 条
    id, name, inputColorSpace, inputGamma, dataLevel, format, codec, bitDepth,
  }],
}
```

**缺失即未知**：任何一项读失败（`ok:false`）时，规则里必须走「无法判断」分支，不能当 `false`/空值处理。这是本功能最容易出「假诊断」的地方。

### 5.2 规则表

字段与 `diagnosePipeline()` 现有 finding 形状对齐：`{id, severity, title, detail, current, recommended, autoFix, manual?, risk}`。

| id | severity | 条件（快照） | title | recommended（写入形状） | autoFix | risk |
|---|---|---|---|---|---|---|
| `dl_resolve_not_running` | error | `runtime && runtime.running === false` | Resolve 未运行 | `null`（manual：先点「连接」） | false | — |
| `dl_no_project` | error | `!project` | 没有打开的项目 | `null` manual | false | — |
| `dl_settings_unreadable` | error | `!settings.ok` | 读不到项目设置 | `null` manual | false | — |
| `dl_unmanaged_pipeline` | warn | `colorScienceMode === 'davinciYRGB'` 且项目里已有调色片段（可选探测） | 项目使用非色彩管理管线（DaVinci YRGB） | `{name:'colorScienceMode', value:'davinciYRGBColorManagedv2'}` | **false（强建议人工）** | 🔴 |
| `dl_timeline_space_unset` | error | `colorSpaceTimeline` 为空且 `useCustomSettings!==true` | 时间线色彩空间未设置 | `{name:'colorSpaceTimeline', value:'Rec.709'}` | false（需人确认取哪套） | 🟠 |
| `dl_timeline_space_mismatch` | warn | `useCustomSettings==='1'` 且时间线 `colorSpaceTimeline` ≠ 项目 `colorSpaceTimeline` | 时间线覆盖了项目色彩空间 | `{name:'colorSpaceTimeline', value:<项目值>}`（写时间线，不是项目！） | false | 🟠 |
| `dl_gamma_family_mismatch` | error | 解析出的 时间线 gamma 家族 ≠ 输出 gamma 家族（见 5.3 解析） | 时间线 gamma 与输出 gamma 不一致 | `{name:'colorSpaceOutputGamma', value:'Gamma 2.4'}`（分离模式） | false | 🟠 |
| `dl_gamma_undeclared` | warn | `separateColorSpaceAndGamma==='0'` 且 `colorSpaceOutput` 不含 gamma 关键词 | 输出 gamma 未显式声明 | `{name:'separateColorSpaceAndGamma', value:'1'}` + gamma | false | 🟠 |
| `dl_mac_viewer_profile` | info/warn | `darwin`；`prefs.enableDisplayColorProfile===true`（偏亮/发灰风险）或 `null`（未知） | macOS 查看器会套用显示器色彩配置文件 | `null` manual（偏好设置项） | false | — |
| `dl_mac_709a_mismatch` | info | `darwin`；输出/时间线是 709-A 类，但交付目标是广播/SDR 标准（用户选择） | 管线使用 Rec.709-A（Apple 显示 gamma 变体） | `{name:'colorSpaceOutputGamma', value:'Gamma 2.4'}` | false | 🟠 |
| `dl_mac_709a_tag_off` | info | `darwin`；`prefs.tag709ClipsAs709A===false` 且工作流是 709 | 未自动把 Rec.709 素材标为 709-A | `null` manual | false | — |
| `dl_media_input_untagged` | warn | `clips[].inputColorSpace` 为空 **或** 与素材实际不符（如 `.log`/`.braw`/`.dng` 却标 `Rec.709 (Scene)`） | 素材输入色彩空间未标注/可能标错 | 无（按 clip 写未验证）manual | false | 🔴 |
| `dl_hdr_to_sdr` | error | `hdrMasteringOn==='1'` 且 输出 gamma 非 PQ/HLG 且 `colorSpaceOutputToneMapping==='None'` | HDR 项目直接输出 SDR（无 tone mapping） | `{name:'colorSpaceOutputToneMapping', value:'DaVinci'}`（值需实测验证） | false | 🔴 |
| `dl_hdr_working_sdr` | warn | `colorScienceMode==='davinciYRGB'` 且 `timelineWorkingLuminanceMode` 以 `HDR` 开头 | 非管理管线却设了 HDR 工作时间线亮度（配置矛盾） | `{name:'timelineWorkingLuminanceMode', value:'SDR'}`（值需实测） | false | 🟠 |
| `dl_aces_transforms_unset` | warn | `colorScienceMode` 含 `aces` 且 IDT/ODT 是 `No Input/Output Transform` | ACES 管线未选 IDT/ODT | `null` manual（API 会拒绝部分值） | false | 🔴 |
| `dl_data_levels_mismatch` | warn | `videoDataLevels==='Full'` 而交付目标是广播，或 clip `Data Level` 与项目不一致（`Auto` 除外） | 数据电平可能不匹配 | `{name:'videoDataLevels', value:'Video'}` | false | 🟠 |
| `dl_render_tag_unreadable` | info | 尝试 `render get_settings` 失败（21.0.0 必现） | 渲染色彩标签无法读回 | `null` manual/说明 | false | — |
| `dl_broadcast_safe_off` | info | `limitBroadcastSafeOn==='0'` 且交付目标是广播 | 未开启广播安全限制 | `{name:'limitBroadcastSafeOn', value:'1'}`（+levels） | false | 🟡 |
| `dl_all_good` | info | 以上都没命中 | 没有发现会直接导致预览错误的设置冲突 | `null` | false | — |

**`autoFix` 一律先设 `false`**：见 §8 的安全策略。`recommended` 非空 = 面板可以给「复制建议值/带确认的一键设置」按钮；`null` = 只能人工。

### 5.3 gamma 家族解析（关键工具函数）

```js
// 值可能来自：分离模式的 *Gamma 键、或合并串（"Rec.709 Gamma 2.4" / "Rec.709 (Scene)" / "Rec.709-A"）
function gammaFamily(value) {
  const t = String(value ?? '').toLowerCase()
  if (!t) return null
  if (/709[\s-]*a/.test(t)) return '709a'          // Rec.709-A
  if (/1\.96/.test(t)) return '1.96'
  if (/2\.4|gamma\s*2\.4/.test(t)) return '2.4'
  if (/2\.2|gamma\s*2\.2/.test(t)) return '2.2'
  if (/srgb/.test(t)) return 'srgb'
  if (/st\s*2084|pq/.test(t)) return 'pq'
  if (/hlg/.test(t)) return 'hlg'
  if (/scene/.test(t)) return '709scene'           // Rec.709 (Scene)：Apple 兼容线，不能当 2.4
  return 'other'
}

// 项目/时间线的"有效 gamma"：分离模式看 gamma 键，否则从合并串里取
function effectiveGamma({ separate, space, gamma }) {
  if (String(separate) === '1' && gamma) return gammaFamily(gamma)
  return gammaFamily(space)                       // 合并串里可能带 "Gamma 2.4"，也可能只有 "(Scene)"
}
```

> 注意 `Rec.709 (Scene)` 的家族是 `709scene`，**不要**把它归到 `2.4`，也不要在没开「Viewers match QuickTime」时当成 2.4 交付——这正是 709-A 类问题的近亲。

---

## 6. 修复动作清单（精确调用）

通用约定：**每一步都「写 → 单键读回 → 不一致即判失败」**；写失败时服务端对色彩键只会返回裸 `{success:false}`，降级文案由插件给（模板见 6.6）。

### 6.1 写项目色彩设置

```js
// 写
const res = await callTool(ctx, 'project_settings', {
  action: 'set_setting',
  params: { name: 'colorSpaceOutput', value: 'Rec.709' },
})
// 期望：{ success: true }
// 失败：{ success: false }            ← 色彩键没有 known_limitation
// 罕见：{ success:false, known_limitation:{symbol,reality,recommended,...} }  ← 只有 api_truth 精确命中的键（如 timelinePlaybackFrameRate）才有

// 立刻读回校验
const back = await callTool(ctx, 'project_settings', {
  action: 'get_setting',
  params: { name: 'colorSpaceOutput' },
})
// 期望：{ settings: 'Rec.709' }（单键时是字符串，不是对象！）
```

> 注意返回形状：`get_setting` **不传/传空 name** 时 `settings` 是 `{…约 160 键…}`；**传了具体 name** 时 `settings` 是**该键的裸值**（字符串/浮点）。项目级与时间线级走同一实现（`server.py:21803` / `:28251`）；时间线级单键返回字符串已实测，项目级同理。
> 数值型键读回会有格式化差（`timelineFrameRate` 读回 `24.0`），`src/utils/project_spec.py:_norm_setting_value` 就是为此写的——比较时做同样的归一化。

### 6.2 写时间线覆盖

```js
callTool(ctx, 'timeline', {
  action: 'set_setting',
  params: { name: 'colorSpaceTimeline', value: 'Rec.709' },
})
// 期望：{ success: true, setting_name, setting_value }（Timeline.SetSetting 的 bool）
// ★ 只在 useCustomSettings==='1' 时写，否则写的是无效覆盖
```

### 6.3 写渲染色彩标签（写得到、验不了）

```js
callTool(ctx, 'render', {
  action: 'set_settings',
  params: { settings: { GammaTag: 'Rec.709-A' } },   // 也可带 ColorSpaceTag
})
// 期望：{ success: true } 可能附 { ignored_settings: [...], warnings: [...] }
// 21.0.0 上无法读回；且 ColourSpaceTag/GammaTag 的合法取值未实测
// 建议同时传 from_preset 钉基线 → 用 render action='prepare_render_job' 的 from_preset 参数，
// 或先 render action='list_presets' 让用户选
```

⚠️ **`ColorSpaceTag` / `GammaTag` 的合法字符串本文档没有实测证据**。实现时：要么让用户在 UI 里选（选项用 Resolve 交付页的常见值，并允许自定义文本），要么先写、再用 `ffprobe` 产物看 `color_primaries/color_transfer` 是否落在预期（gamma 无法验证，见 §7.3）。

### 6.4 写素材输入色彩空间（未验证，谨慎）

```js
callTool(ctx, 'media_pool_item', {
  action: 'set_clip_property',
  params: { clip_id, key: 'Input Color Space', value: 'Rec.709' },
})
// 立即读回：
callTool(ctx, 'media_pool_item', {
  action: 'get_clip_property',
  params: { clip_id, key: 'Input Color Space' },   // 单键读取；缺键时 list 形式给 null
})
```

未实测能否写。**默认不要把 `autoFix` 打开**；最多做成「高级操作」。

### 6.5 打开项目设置 / 偏好设置：不存在这种调用

不要写「帮你打开项目设置」。文案只能写路径：
- 项目设置：`项目设置 → 色彩管理`（或 Project Settings → Color Management）
- 偏好设置：`Resolve → 偏好设置 → 系统/常规`（`Preferences → System → General`）
- 依据：api_truth `Resolve.GetUIManager / UIManager.OpenProjectSettings / OpenPreferences (do not exist)`。

### 6.6 降级文案模板（直接可用）

| 场景 | 文案 |
|---|---|
| 写失败（`{success:false}`） | 「Resolve 拒绝写入 `<键>` = `<值>`（没有给出原因）。可能是该版本不支持这个取值。请在 项目设置 → 色彩管理 里手动选择，插件会在你改完后再读一次。」 |
| 键可写但语义危险 | 「这会改变已调画面的解释。建议先导出当前项目 / 用一条副本时间线验证。确认要改吗？」 |
| 渲染标签设了但验不了 | 「已把渲染 Gamma 标签设为 `<值>`。注意：Resolve 不提供读回，成片元数据也无法证明显示 gamma，请用同一帧在改前/改后各导出一次对比。」 |
| 偏好设置 | 「这项只能在 Resolve 偏好设置里改：`<路径>`。当前插件读到的落盘值是 `<值/未知>`，改完需要重启 Resolve 生效。插件不会也不能替你改。」 |
| 读不到（不确定） | 「无法读取 `<项>`（<错误>），因此不做判断。」——**不要**写「未设置」 |

---

## 7. 「读快照」调用序列（可直接替换 `opPipelineSnapshot`）

### 7.1 最小快照（5 调用，覆盖所有现有诊断规则）

| # | 工具 | 参数（注意 `params`） | 期望返回 | 会拉起 Resolve？ | 失败时 |
|---|---|---|---|---|---|
| 1 | `resolve_control` | `{ action: 'runtime_mode' }` | `{success, running, headless, instances, database}` | **不会**（读进程） | `runtime:null`，后续调用仍可试 |
| 2 | `resolve_control` | `{ action: 'get_version' }` | `{product, version:[…], version_string, mcp}` | **会**（未运行则拉起） | 记 `versionError`，不要中断 |
| 3 | `project_settings` | `{ action: 'get_setting', params: { name: '' } }` | `{settings:{…约 160 键…}}` | **会** | 整个体检降级为「无法读取设置」 |
| 4 | `project_manager` | `{ action: 'get_current' }` | `{name, id}` | 会（已连接） | `project:null` |
| 5 | `timeline` | `{ action: 'get_current' }` | `{name, id, start_frame, end_frame, start_timecode}` | 会 | 跳过时间线覆盖检查 |

```js
async function opPipelineSnapshot(ctx, args, signal) {
  const [version, runtime, settings, project, timeline] = await Promise.all([
    settle(callTool(ctx, 'resolve_control', { action: 'get_version' }, signal)),
    settle(callTool(ctx, 'resolve_control', { action: 'runtime_mode' }, signal)),
    settle(callTool(ctx, 'project_settings', { action: 'get_setting', params: { name: '' } }, signal)),
    settle(callTool(ctx, 'project_manager', { action: 'get_current' }, signal)),
    settle(callTool(ctx, 'timeline', { action: 'get_current' }, signal)),
  ])
  // …再把 timeline 覆盖逐键读出来（7.2）
}
```

### 7.1.1 显式 keys 列表（不想一次拉全量时用）

一次 `get_setting` 拿全量最省调用，但如果要逐键读（例如面板只关心色彩），用这张表；全部已 **[实测]** 存在：

```js
const COLOR_PROJECT_KEYS = [
  'colorScienceMode', 'rcmPresetMode', 'isAutoColorManage', 'separateColorSpaceAndGamma',
  'colorSpaceInput', 'colorSpaceInputGamma',
  'colorSpaceTimeline', 'colorSpaceTimelineGamma',
  'colorSpaceOutput', 'colorSpaceOutputGamma',
  'colorSpaceOutputToneMapping', 'colorSpaceOutputToneLuminanceMax',
  'colorSpaceOutputGamutMapping',
  'colorAcesIDT', 'colorAcesODT', 'colorAcesNodeLUTProcessingSpace', 'colorAcesGamutCompressType',
  'inputDRT', 'outputDRT', 'useInverseDRT', 'useCATransform', 'useColorSpaceAwareGradingTools',
  'timelineWorkingLuminance', 'timelineWorkingLuminanceMode',
  'hdrMasteringOn', 'hdrMasteringLuminanceMax', 'hdrDolbyControlsOn', 'hdr10PlusControlsOn',
  'videoDataLevels', 'videoMonitorFormat', 'videoMonitorUseHDROverHDMI',
  'limitBroadcastSafeOn', 'limitBroadcastSafeLevels',
]
const COLOR_TIMELINE_KEYS = [
  'useCustomSettings', 'colorSpaceTimeline', 'colorSpaceOutput', 'colorSpaceTimelineGamma',
]
const COLOR_CLIP_KEYS = [
  'Input Color Space', 'Input Gamma', 'Input LUT', 'IDT', 'Mon Color Space', 'Monitor LUT',
  'Data Level', 'Format', 'Video Codec', 'Bit Depth', 'FPS',
]
```
（读单个键仍要 `{action:'get_setting', params:{name}}`；见 §2。）

> `get_version` / `get_setting` 会**拉起 Resolve**（MCP 的既定行为：工具连接时若没进程就启动，最长 60s）。面板首屏请沿用现有 `opStatus`（只 `runtime_mode`）不要拉起；用户点「体检」时再连接。

### 7.2 时间线覆盖（只有在拿到 timeline 后才做，4 次单键读）

```js
const tkeys = ['useCustomSettings', 'colorSpaceTimeline', 'colorSpaceOutput', 'colorSpaceTimelineGamma']
const timelineScope = {
  ok: true,
  ...(await Promise.all(tkeys.map(async (name) => {
    const r = await settle(callTool(ctx, 'timeline', { action: 'get_setting', params: { name } }, signal))
    return [name, r.ok ? r.value?.settings ?? null : null]
  }))).reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
}
```

### 7.3 可选增强（按需，别默认全开）

| 增强 | 调用 | 代价/风险 |
|---|---|---|
| 健康检查 | `project_manager {action:'lint'}` → `issues[]`（`color_science_unset` 等）**[实测可用]** | 低；可复用它的 `severity/code/message` 作为补充提示 |
| 渲染设置读回 | `render {action:'get_settings'}` | 21.0.0 **必失败**（`GetRenderSettings requires …`），不要当错误抛给用户，转成 `dl_render_tag_unreadable` |
| 素材抽样 | `media_pool {action:'probe_media_pool', params:{depth:2}}` → 取前 N 个 clip id → `media_pool_item {action:'get_clip_property', params:{clip_id}}` | 每次全量属性 200+ 键，**只取** `Input Color Space/Input Gamma/Data Level/Format/Video Codec/Bit Depth`；N≤5，且只读 |
| macOS 偏好 | 直接 `fs.readFile('~/Library/Preferences/Blackmagic Design/DaVinci Resolve/.config.data')` + 正则 `/^EnableDisplayColorProfile\s*=\s*(\d)/m`、`/^Tag709ClipsAs709A\s*=\s*(\d)/m` | 纯只读；**绝不写**；文件不存在→`null` |
| 帧证据 | `timeline_frame {action:'capture', params:{quality:'frame'}}` 或 `project_settings export_frame_as_still`；播放检测先做 | 切页/播放风险，只在用户点「看证据」时做 |

### 7.4 明确不要做的事

- ❌ 不要调 `render {action:'probe_render_settings'}` / `get_mode`：会切到 Deliver 页（api_truth）。
- ❌ 不要在播放中 `open_page`/抓帧（api_truth：会卡死 Resolve）。
- ❌ 不要把 `timeline.get_setting` 不传 name 当作「时间线设置」——它返回项目全量快照。
- ❌ 不要用 `Project.GetSetting('timelineColorSpace')` 之类的猜测键判断「未设置」（永远返回 None → 误报）。

---

## 8. 安全策略（写死进实现）

| 规则 | 理由 |
|---|---|
| 打开面板/自动诊断**绝不写入**；写入只发生在用户点「修复」且（危险项）二次确认后 | `SetSetting` 无法撤销，且会脏化用户项目 |
| `colorScienceMode`、`colorSpaceTimeline`、`colorAcesIDT/ODT`、`useColorSpaceAwareGradingTools`、`inputDRT/outputDRT` → **不提供一键自动改**，只给建议值 + 手动路径 | 会改变已调画面的解释；ACES 变换值还可能被静默拒绝 |
| 任何写入前保存旧值到返回体，并给「恢复原值」按钮 | 无 API undo；`GetSetting` 读旧值是唯一回退手段 |
| 写入后必须单键读回，不一致就报失败（不要报成功） | 服务端对色彩键不给失败原因 |
| 渲染 `GammaTag/ColorSpaceTag` 改了要提示「不可验证」 | 无 `GetRenderSettings`，ffprobe 也看不到 display gamma |
| Preferences（`.config.data`）只读不写 | 用户级配置、需重启、格式脆弱 |
| 项目有已调片段时，切换色彩管理模式要额外警告 | 同一 grade 在不同 color science 下看起来不同 |
| 诊断结果里区分 `unknown` 与 `false` | 读失败当 false 会制造假故障 |

---

## 9. 验收清单（实现完成后的自测）

1. [ ] 在 Resolve 21.0.0b.20 上跑一次 `pipeline.snapshot`：`settings.value.settings` 里 `colorScienceMode === 'davinciYRGB'`、`colorSpaceTimeline === 'Rec.709 (Scene)'`，且 `resolved` 的五项不再有 `null`（除非确实读失败）。
2. [ ] `pipeline.diagnose` 在**不写入**的前提下给出 ≥1 条 finding；每条 finding 都有 `id/severity/title/detail/current/recommended/autoFix`。
3. [ ] 在 `_mcp_` 前缀的临时项目里验证 `pipeline.fix({ids:['…'], dryRun:false})`：`set_setting` 带 `params` 后返回 `success:true`，且单键读回等于写入值。
4. [ ] 故意写一个非法值（如 `colorSpaceOutput: 'NOPE'`）：确认得到 `{success:false}` 时面板显示的是降级文案，而不是「已修复」。
5. [ ] macOS 分支：`.config.data` 存在时读到 `EnableDisplayColorProfile=1`；把文件临时改名后得到 `null`（不是 `false`），且不报错。
6. [ ] `render get_settings` 失败时不抛用户可见错误，而是 `dl_render_tag_unreadable`。
7. [ ] 播放中点「体检」不会切页、不会卡死（体检本身零切页）。

---

## 10. 未决问题 / 需实测（写代码时按「保守分支」实现）

1. **枚举值**：`colorSpaceOutput` / `colorSpaceOutputGamma` 的完整合法列表（尤其 `Rec.709-A` 到底写在空间键还是 gamma 键、字符串精确形态）。→ 保守做法：不在代码里硬编码为唯一真理，写入前用当前值 + 用户选择，写入后读回校验。
2. **`MediaPoolItem.SetClipProperty('Input Color Space', …)` 是否可写**、写后 clip 属性是否立即变。→ 保守：默认关闭自动修，做成高级操作 + 读回校验。
3. **`ColorSpaceTag` / `GammaTag` 的合法取值**与它们对成片元数据的影响（是否写 `color_transfer`）。→ 保守：允许自由文本 + 事后 ffprobe，不承诺。
4. **`timelineWorkingLuminanceMode` 的 SDR 合法值**（本机只见 `HDR 1000`；SDR 下该键可能是空或别的串）。
5. **Resolve 21.1+ 差异**：`Project.GetRenderSettings` 在 21.1 typed API 里仍未列出；`Resolve.*UserPreferencesPreset*` 在 21.0.4+ 出现——若未来用「偏好预设」曲线救国，必须按版本门控。
6. **`.config.data` 的跨版本稳定性**：21.1 是否新增「Viewers match QuickTime player when using Rec.709 (Scene)」的落盘键、`Tag709ClipsAs709A` 是否改名。→ 读不到就 `null`。
7. **Apple 显示 gamma 数值**：1.96（业界常见）vs 1.9（CineDream 对 Rec.709 (Scene) 的记录）。文案里写「≈1.96（部分资料记为 1.9）」，不要把数字写进判据。

---

## 11. 证据文件索引

| 文件 | 内容 |
|---|---|
| `docs/color-pipeline-notes-src/01-project-settings-snapshot.json` | 本机约 160 键快照的色彩/HDR/监看子集、时间线覆盖、素材级实测值、常见误猜键 |
| `docs/color-pipeline-notes-src/02-macos-prefs-keys.md` | `.config.data` 位置/格式/两个 Mac 偏好键、为什么不能写 |
| `docs/color-pipeline-notes-src/03-api-truth-citations.md` | api_truth 条目逐条摘录（UIManager、timelinePlaybackFrameRate、SetRenderSettings、AddRenderJob、GetCurrentRenderMode、OpenPage、ExportCurrentFrameAsStill）+ 21.1 changelog + known_limitation 机制源码 |
| `docs/color-pipeline-notes-src/04-live-probes.md` | 13 条只读探针的完整调用/参数/返回摘要，标注哪些会拉起 Resolve |
| `docs/color-pipeline-notes-src/05-mcp-arg-convention.md` | 「必须放 params」的源码链与实测证据 |
| `docs/color-pipeline-notes-src/06-709a-and-gamma-shift.md` | 709-A/gamma shift 的术语、数学、症状表、三种正确管线、ffprobe 验证极限、外部资料链接 |

### 主要源码/文档出处（便于复核）

- `~/Library/Application Support/davinci-resolve-mcp/src/server.py`
  - `:266` `mcp = ErrorFlaggingFastMCP(...)`；`:1680 _params`；`:1714 _guarded_params`；`:21803` / `:28251` 项目/时间线 `get_setting`；`:20389 _PROJECT_METHODS`；`:20414 _PROJECT_SETTING_PROBE_KEYS`；`:20555 _project_settings_snapshot`；`:20603 _probe_project_settings`；`:21723 _setting_limitation`；`:21757 project_settings`；`:21956 _RENDER_SETTING_KEYS`；`:22161 _render_settings_snapshot`；`:23150 render get_settings`
- `.../src/utils/project_lint.py:48`（`davinciYRGB` = unmanaged）；`.../src/utils/project_properties.py:32-40,399-500`（旧键表，勿照抄）；`.../src/utils/project_spec.py:31-61`（COLOR_PRESETS/SETTINGS_ORDER）；`.../src/utils/probe_catalogue.py:186`（`SetSetting('colorScienceMode','davinciYRGB')`）
- `.../docs/reference/resolve_scripting_api.txt:679-700`（GetSetting 空键取全量）
- `.../docs/reference/resolve_scripting_changelog_21.1.md`（`colorAcesODT` 修复记录）
- `.../resolve-advanced/server/deliverable-spec-bridge.mjs:133-177`（ffprobe 不表达 display gamma）
- `.../resolve-advanced/server/deliverable-qc.mjs:50`（`video.colorTransfer` 等 QC 字段）
- 第三方实测键表：`mhadifilms/dvr` 的 `dvr/spec.py`（COLOR_PRESETS / SETTINGS_ORDER / CAPTURED_SETTINGS，含 RCM 分离 gamma 键族、HDR 键族，以及「API 拒绝部分 IDT/ODT 字符串」的注释）
