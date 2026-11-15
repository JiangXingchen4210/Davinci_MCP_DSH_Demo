# api_truth 事实条目逐条摘录（本功能相关）

来源：`mcp__resolve__resolve_control action=api_truth`（静态知识库，**不需要** Resolve 运行；返回 `verified_on = DaVinci Resolve Studio 21.0.2`），以及同仓库落盘文件
`/Users/wupx/Library/Application Support/davinci-resolve-mcp/src/utils/api_truth.py` 与 `docs/reference/api-limitations.md`。

> 引用方式：主文档里写「api_truth · <symbol>」，读者可用 `resolve_control api_truth query="<关键词>"` 复现。

---

## 1. `Resolve.GetUIManager / UIManager.OpenProjectSettings / OpenPreferences (do not exist)`

- **object**: Resolve
- **reality（摘）**: 没有任何脚本调用能打开 Project Settings 或 Preferences 对话框；`dir(resolve)` 只有 23 个方法，没有 `GetUIManager`；`Fusion().UIManager` 也没有 `OpenProjectSettings/OpenPreferences`；21.1 typed API 同样没有。
- **recommended（摘）**: 不要承诺「帮你打开项目设置/偏好设置面板」。项目设置走 `Project.GetSetting/SetSetting`。
- **对本功能的意义**：所有 UI 级降级文案只能写「请打开 项目设置 → 色彩管理」，**不能**假装能自动跳转；Preferences 级（Use Mac Display Color Profiles / Tag Rec.709 clips as Rec.709-A）连读写通道都没有。

## 2. `Project.SetSetting('timelinePlaybackFrameRate')`

- **object**: Project
- **reality（摘）**: 对试过的所有值形态（string/int/float）都返回 `False`，有无时间线都一样 → 这个键根本无法通过 API 写入。
- **recommended（摘）**: 让用户在 Project Settings 里设，读回确认，不要凭调用成功就报告已设置。
- **对本功能的意义**：这是**唯一**被 api_truth 逐键记录为不可写的项目设置键；`project_settings set_setting` 的 `known_limitation` 字段只在「键名+对象」精确命中这类条目时才出现。色彩键没有这类条目 → **色彩键写失败时服务端只会返回 `{success:false}`，没有任何原因**，降级文案必须由插件自己给。

## 3. `Project.SetRenderSettings (inherits the loaded preset)`

- **object**: Project
- **reality（摘）**: `SetRenderSettings` 是在 Deliver 页当前状态（含已载入 preset）之上叠加，不是替换；一个 Audio Only preset 之后即使显式传 `ExportVideo=True` 也渲染出无视频流的 mp4，而且 `settings_success=True`、job 读回也正常。API 没有 `GetRenderSettings`，也没有 `GetCurrentRenderPresetName`，所以被继承的基线**读不出来**。
- **recommended（摘）**: 用 `prepare_render_job(from_preset=…)` 先把基线钉住，再叠显式键；验证产物（ffprobe），不要信 job 读回。
- **对本功能的意义**：渲染级 `ColorSpaceTag` / `GammaTag` 属于同一类「写进去但基线不可读」的键；改输出标签必须配 `from_preset` 或明确告知「会继承 Deliver 页当前预设」。

## 4. `Project.AddRenderJob (the only readback for render settings)`

- **object**: Project
- **reality（摘）**: 没有 `GetRenderSettings`；排一个 job 后 `GetRenderJobList` 能读到 TargetDir / OutputFilename / MarkIn / MarkOut / VideoFormat / VideoCodec / RenderMode / PresetName；**不含** ColorSpaceTag / GammaTag。
- **recommended（摘）**: 用「排 job → 读 → 删 job」的模式读渲染设置；CustomName 无法读也无法清。
- **对本功能的意义**：**渲染色彩标签没有读回通道**，只能写到输出文件后用 ffprobe 看 `color_primaries/color_transfer/color_matrix`（且见 07 文件里「display gamma 不是 ffprobe color_transfer」的限制）。

## 5. `Project.GetCurrentRenderMode (switches to the Deliver page)`

- **object**: Project
- **reality（摘）**: 这个 getter 会把 Resolve 切到 Deliver 页；`GetCurrentRenderFormatAndCodec/GetRenderFormats/GetRenderCodecs/GetRenderResolutions/GetRenderJobList/GetRenderPresetList/IsRenderingInProgress/Timeline.GetMarkInOut` 不会。
- **recommended（摘）**: 先读 `GetCurrentPage()`，读完 `OpenPage` 回去。
- **对本功能的意义**：色彩体检**不要**调 `render probe_render_settings`（它内部读 render mode，会切页）。要读渲染设置优先 `render get_settings`（21.0.0 上直接不可用，见 06 文件），否则放弃。

## 6. `Resolve.OpenPage (during playback)`

- **reality（摘）**: 播放中切到 Color 页 + 恢复页面会让 Resolve 主线程卡死，之后所有脚本调用（含新建连接）全部挂住；19.x 无 transport 控制，脚本既不能停播放也不能问是否在播。
- **recommended（摘）**: 连续读两次 `GetCurrentTimecode`（间隔 ~0.2 s）判断是否在播；播放中不要切页。
- **对本功能的意义**：任何「抓一帧做证据 / 切 Color 页验证」的动作必须先做播放检测；体检本身（GetSetting）不需要切页，保持零切页。

## 7. `Project.ExportCurrentFrameAsStill (frame-accurate capture)`

- **reality（摘）**: 逐帧精确、写查看器处理后的成品帧（含调色/Fusion/字幕轨不确定）、全分辨率、约 0.2 s、不切页、不动渲染设置。
- **recommended（摘）**: 作为帧证据首选。
- **对本功能的意义**: 「修复前后对比」用它出帧，再用 `resolve_advanced scope_read / deliverable_qc`（ffprobe）量化，而不是靠肉眼。

## 8. `Subtitle track styling and presets`（作为「无效键返回什么」的范例）

- **reality（摘）**: `Timeline.GetSetting()` / `Project.GetSetting()` 对不存在/不支持的键返回 `None`。
- **对本功能的意义**: 判断「本机是否有某个色彩键」的正确方式是读回值是否为空/None，而不是猜键名；官方 API 文档也明确写「invalid key 会返回 trivial result」。

## 9. 官方 API 文档（`docs/reference/resolve_scripting_api.txt` 行 679-700）

> 「To get a snapshot of all queryable properties (keys and values), you can call `Project:GetSetting` … without parameters (or with a NoneType or a blank property key).」

- 实测确认：`Project.GetSetting("")` 返回 约 160 键字典；`Timeline.GetSetting("")` 返回的是**项目级**全量快照（不是时间线专属键集合）。

## 10. `Project.SetSetting('colorAcesODT', value)`（21.1 changelog，不是 api_truth 条目）

文件：`docs/reference/resolve_scripting_changelog_21.1.md`

- 「**Addressed**（20.2.1）: `Project.SetSetting('colorAcesODT', value)` not working for some values.」
- 另据 `mhadifilms/dvr` 的实测注释（其 `spec.py` COLOR_PRESETS 上方）：Resolve 会**静默拒绝** HDR PQ 的 IDT/ODT 字符串（UI 标签、ACES 1.x `InvRRTODT.*`、ACES 2.0 `InvOutput.*`、内部二进制名都试过），因此 ACES 的 Input/Output Transform 必须在 UI 里选。
- 对本功能的意义：**ACES IDT/ODT 一律标为不可自动修复**，只给 UI 指引；`colorAcesODT` 的写入结果必须读回校验，且即便读回一致也不能保证画面正确（历史 bug 是「某些值不生效」）。

---

## 附：被引用到的 `known_limitation` 机制（源码级）

`src/server.py:21724 _setting_limitation(name, obj="Project")`：

- 只有当 api_truth 里存在 symbol 形如 `Project.SetSetting('<精确键名>')` 的条目时，`set_setting` 失败才会附带
  `{success:false, known_limitation:{symbol, reality, recommended, ledger_verified_on}}`。
- 目前色彩键**没有任何**这样的条目 → 失败就是裸 `{success:false}`。
