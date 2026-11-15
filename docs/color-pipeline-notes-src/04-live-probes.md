# 实测探针记录（全部只读）

时间：2026-11-13 02:00–02:10 (+08:00)
环境：macOS darwin/arm64 · DaVinci Resolve Studio **21.0.0b.20**（GUI，Disk DB「Local Database」，进程已在运行）· davinci-resolve-mcp **4.19.3**

> 说明：本次调研**没有写入任何项目设置**。唯一一次「写调用」是故意不带参数调 `set_setting`，服务端在写入前就拒绝（`set_setting requires name`），Resolve 侧没有任何 SetSetting 被执行。Resolve 在本轮开始前已经由别的会话启动，本轮没有新拉起进程。

| # | 调用 | 参数 | 结果摘要 | 会拉起 Resolve？ |
|---|---|---|---|---|
| 1 | `resolve_control` | `{action:"runtime_mode"}` | `{running:true, headless:false, instances:1, database:{DbType:"Disk",DbName:"Local Database"}, database_attached:true}` | **不会**（读进程 argv） |
| 2 | `resolve_control` | `{action:"get_version"}` | `{product:"DaVinci Resolve Studio", version:[21,0,0,20,"b"], version_string:"21.0.0b.20", mcp:{version:"4.19.3"}}`；`build.unavailable_on_this_build` 40 项，其中含 21.0.4+/21.1 才有的 `Resolve.*UserPreferencesPreset*`、`Timeline.GetSelectedClips`、`MediaPoolItem.GetTimeline` 等 | **会**（若未运行则拉起） |
| 3 | `project_settings` | `{action:"get_setting"}`（不传 name） | 返回 约 160 键字典，见 `01-project-settings-snapshot.json` | **会** |
| 4 | `timeline` | `{action:"get_setting", params:{name:"colorSpaceTimeline"}}` | `"Rec.709 (Scene)"`；`_operation.timeline = {name:"录屏", id:"a9e49eee-…"}` | 会（已连接） |
| 5 | `timeline` | `{action:"get_setting", params:{name:"useCustomSettings"}}` | `"0"`（该时间线继承项目设置） | 会 |
| 6 | `timeline` | `{action:"get_setting", params:{name:"colorSpaceOutput"}}` | `"Rec.709 (Scene)"` | 会 |
| 7 | `timeline` | `{action:"get_setting", params:{name:"colorSpaceTimelineGamma"}}` | `""`（分离色彩空间/gamma 未启用时为空） | 会 |
| 8 | `timeline` | `{action:"get_setting"}`（不传 name） | 返回**项目级**全量快照（与 #3 相同形状）→ 空键在 Timeline 上同样返回项目快照 | 会 |
| 9 | `project_manager` | `{action:"lint"}` | `{ok:true, counts:{error:0,warning:0,info:1}, issues:[{severity:"info", code:"color_science_unset", message:"Color science is unmanaged (DaVinci YRGB).", detail:"Set a managed/ACES mode if a color-managed pipeline is expected."}]}` | 会 |
| 10 | `render` | `{action:"get_settings"}` | **失败**：`{"error":{"message":"GetRenderSettings requires DaVinci Resolve unknown+","code":"UNSPECIFIED","category":"resolve_api_failed","retryable":true}}` → 本机 Resolve **没有** `Project.GetRenderSettings` | 会 |
| 11 | `media_pool` | `{action:"probe_media_pool", params:{depth:2}}` | Master 6 clip / 3 子文件夹（LUMIX 8、IQOO 44、Archive 0）；current_folder=Archive | 会 |
| 12 | `media_pool_item` | `{action:"get_clip_property", params:{clip_id:"6f3a1d1a-5532-4566-ac69-200cfbfe2c37"}}` | 200+ 键全量 clip 属性，**含** `Input Color Space:"Rec.709 (Scene)"`、`Input Gamma:"Rec.709"`、`Input LUT:""`、`IDT:""`、`Mon Color Space:""`、`Monitor LUT:""`、`Color Space Notes:""`、`Gamma Notes:""`、`Data Level:"Auto"` | 会 |
| 13 | `project_settings` | `{action:"set_setting"}`（故意不带 params） | **被拒**：`{"error":{"message":"set_setting requires name", …}}`。用来证明「顶层裸参数不会进 params」的后果 | 不写，仅报错 |

## 从探针得到的三条硬结论

1. **Resolve 21.0.0 全量项目设置键名以 #3 为准**：有 `colorSpaceTimeline/colorSpaceOutput/colorSpaceTimelineGamma/colorSpaceOutputGamma/separateColorSpaceAndGamma`，**没有** `timelineColorSpace/outputColorSpace/displayColorSpace/timelineGamma`。
2. **时间线级覆盖真实存在**（#4-#8）：`Timeline.GetSetting('useCustomSettings') + colorSpaceTimeline/colorSpaceOutput/…`。诊断必须同时读「项目级」和「当前时间线级」，否则会出现「项目设置看着没问题、画面就是不对」。
3. **渲染色彩标签没有读回**（#10）：`Project.GetRenderSettings` 在本机不存在 → `render.get_settings` 不可用；`ColorSpaceTag/GammaTag` 只能写、只能用 ffprobe 验产物。
