# macOS 709-A / gamma shift 的技术依据（供写诊断文案与规则）

标记：**[文档]** = 有公开资料/官方发行说明支撑；**[推导]** = 由 gamma 数学直接得出；**[实测]** = 本机 Resolve 21.0.0b.20 读到的状态。

---

## 1. 术语

| 术语 | 含义 | 备注 |
|---|---|---|
| **Rec.709 (2.4)** | 场景参考的 Rec.709 色度 + **显示 gamma 2.4**（BT.1886 类）编码。广播/蓝光/大多数剪辑交付的默认 | 画面「对」的前提是**接收端也按 2.4 显示** |
| **Rec.709-A** | Blackmagic 为 **QuickTime/Apple 兼容**加的 gamma 选项 [文档: BMD 16.2.2 发行说明 “Support for Rec.709-A gamma option for QuickTime player compatibility”]。作为**渲染 Gamma Tag** 时：把传输函数标记留空/不指定，交给 Apple 色彩管理去映射；作为**输出色彩空间**时：把 Apple 的显示 gamma **烘进信号** | 常见说法是 Apple 显示 gamma ≈ **1.96**（部分资料/管线写作 **1.9**）。本文件按 1.96 做数学，差异不影响结论方向 |
| **显示 gamma 1.96** | macOS/QuickTime 链路对「Apple 系」显示的假定 gamma。与 2.4 差 0.44 个指数 | 这是「同一文件在 Mac 上偏亮/偏灰」的数值根源 |
| **ICC / ColorSync** | macOS 的色彩管理：按显示器 ICC profile 把内容转到屏幕色域/gamma | Resolve 是第三方软件，**默认不参与** ColorSync，所以查看器与 QuickTime/Safari 会不一致 [文档] |
| **Use Mac Display Color Profiles for Viewers** | Resolve 偏好设置里的开关，把 Resolve 查看器纳入 ColorSync（按系统 ICC 显示）。**只影响查看器外观，不影响渲染** [文档]；Resolve 21 的存储键是 `EnableDisplayColorProfile` [实测] |
| **Tag Rec.709 clips as Rec.709-A** | Resolve 偏好设置开关：导入时自动把 Rec.709 素材标成 Rec.709-A [文档: BMD 16.2.2 “Preference to automatically tag Rec.709 clips as Rec.709-A”]；存储键 `Tag709ClipsAs709A` [实测] |
| **Rec.709 (Scene)** | Resolve 18+ 引入的**场景参考** Rec.709 选项（不是显示参考 2.4）。Resolve 21 里与偏好「Viewers match QuickTime player when using Rec.709 (Scene)」配套时，查看器会按 Apple 的 gamma 显示（资料给的对应值是 1.9）[文档] | 本机项目当前就是 `colorSpaceTimeline/Output = "Rec.709 (Scene)"` [实测] |
| **色彩空间标注 / tag 丢失** | 素材或成片没有写 color primaries/transfer/matrix 元数据，或写了但播放器忽略 → 每端按自己的假设解释 | ffprobe 能看到 `color_primaries/color_transfer/color_matrix`；**display gamma 名称不会变成 ffprobe 的 transfer 值**（见 §5） |

## 2. 为什么「同一素材在 Mac 上偏亮/偏灰/暗部抬升」[推导]

忽略 BT.1886 的 toe，信号编码：`v = L^(1/γ_enc)`；显示解码：`L' = v^(γ_disp)`。

| 情形 | 计算 | 结果 |
|---|---|---|
| 按 2.4 编码，被按 **1.96** 解码（QuickTime 链路） | `L' = (L^(1/2.4))^1.96 = L^(1.96/2.4) = L^0.817` | `L<1` 时 `L^0.817 > L` → **整体提亮、对比度下降、暗部抬升** → 观感「发灰/发白/黑不实」 |
| 按 **1.96** 烘焙（Rec.709-A 输出），被按 **2.4** 解码（Windows/多数播放器/广播链路） | `L' = L^(2.4/1.96) = L^1.224` | **整体压暗、暗部发死** |
| 按 **2.2** 编码被按 2.4 解码 | `L' = L^(2.4/2.2) = L^1.091` | 轻微压暗（比 1.96 情形温和得多） |

数值感受（`L` = 线性亮度）：`L=0.1` 时 1.96 解码给出 `0.1^0.817 ≈ 0.152`（相对 +52%）；`L=0.5` 时 `0.5^0.817 ≈ 0.567`。黑点仍是 0，所以不是「黑变灰」的字面意思，而是**暗部斜率变大**，观感是「发灰、闷、没层次」。

## 3. 症状 → 根因 对照表

| 症状 | 根因 | 判定条件（插件可读） |
|---|---|---|
| Resolve 查看器里正常，导出后在 QuickTime/预览/Safari 里**明显偏亮、发灰、暗部抬升** | 成片按 2.4 编码/标记，Apple 链路按 ≈1.96 解释；Resolve 查看器未纳入 ColorSync 或反之 | `process.platform==='darwin'` + 输出 gamma 是 2.4 类 + 交付目标是 QuickTime/网页；偏好 `EnableDisplayColorProfile`、`Tag709ClipsAs709A`（只读文件） |
| 导出后在 **iPhone/iPad/微信**里**偏暗、发闷**，Mac 上正常 | 成片烘焙了 Rec.709-A/1.96 gamma 或打了 709-A 标签，接收端按 2.4/BT.709 解释 | 输出色彩空间/gamma 是 `Rec.709-A` 类，而交付目标是手机/社交平台 |
| **查看器里就偏**（与导出无关） | 查看器受 `EnableDisplayColorProfile` 影响：开启时按系统 ICC（常见 Display P3）转换，关闭时按固定假设；两种状态观感不同 | mac + 该偏好开关状态（只能读文件/让用户确认） |
| 素材一进时间线就**发灰、平**，加对比也救不回 | 非色彩管理管线（`colorScienceMode = davinciYRGB`）+ Log/宽色域素材没有输入转换；或素材 `Input Color Space` 未标注/标错 | `colorScienceMode=davinciYRGB`；clip `Input Color Space`/`Input Gamma` 为空或是 `Rec.709 (Scene)` 而素材实际是 Log |
| 项目设置看着对，**某一条时间线就是不对** | 时间线级覆盖：`Timeline.GetSetting('useCustomSettings') = 1`，该时间线的 `colorSpaceTimeline/colorSpaceOutput` 与项目不同 | 项目级 `colorSpace*` ≠ 时间线级 `colorSpace*` |
| 调色台看对，**渲染出来的片子发灰/发黑** | 渲染层 `ColorSpaceTag/GammaTag` 与项目输出不一致；或 Deliver 页载入了别的 preset 把标签盖掉 | 无读回通道，只能写后 `ffprobe` 产物（§5） |
| **HDR 项目导出 SDR**：高光爆、颜色发灰或过饱和 | `hdrMasteringOn=1` / HDR 工作时间线 + 输出仍是 SDR，但 `colorSpaceOutputToneMapping="None"`、`colorSpaceOutputGamutMapping="None"` | 见主文档诊断 `DL_HDR_TO_SDR_UNTONEMAPPED` |
| 暗部/高光**同时**失真、黑位不黑 | 数据电平不匹配：项目 `videoDataLevels` 与素材/输出（Full vs Video）不一致 | `videoDataLevels`（`Video`/`Full`）+ clip `Data Level`（`Auto`/…） |

## 4. macOS 上「正确」的三种管线（按交付目标选，不存在唯一正确答案）

**A. 广播/院线 SDR（Rec.709 2.4）** —— 交付给电视台、放映、Windows 播放器为主
- 输出 = `Rec.709` + gamma `Gamma 2.4`（分离模式 `separateColorSpaceAndGamma=1` 时填 `colorSpaceOutputGamma`；合一时用合并串如 `Rec.709 Gamma 2.4`）
- **不要**开 `Tag709ClipsAs709A`
- 明确告诉用户：这条链路在 Mac 的 QuickTime 里本来就会显得亮一点，**不是 bug**

**B. Mac 本机预览与 QuickTime 一致（首选给「只用 Mac 看」的用户）**
- 方案 B1（最省事、可全 API 完成）：时间线/输出都设 `Rec.709 (Scene)`，并让用户打开偏好 **Viewers match QuickTime player when using Rec.709 (Scene)**（该偏好不可 API 改）
- 方案 B2（只在交付层解决）：渲染 `GammaTag = Rec.709-A`（标签留空，Apple 自己映射）
- 方案 B3（跨平台自洽，画面被烘死）：复制一条时间线，输出色彩空间改成 `Rec.709-A` 再渲染（BMD 官方建议的“web 交付”做法 [文档]），但**不适合广播/放映**

**C. 在 Mac 屏上「所见即所得」（显示器 ICC = Display P3 的 MacBook/iMac）**
- 打开偏好 `Use Mac Display Color Profiles for Viewers`（`EnableDisplayColorProfile=1`，不可 API 改）
- 项目里开启 `separateColorSpaceAndGamma=1`，输出 = `P3-D65` + gamma `sRGB`（BMD Colorist Guide Appendix B 的原话：Output Color Space 左参数 P3-D65、右参数 sRGB）[文档]
- 这样查看器（按 ICC 转换）与导出文件在 Apple 生态里一致

**D. HDR PQ 交付**
- `hdrMasteringOn=1` + `hdrMasteringLuminanceMax` 与母版一致（1000/4000）+ 输出 `Rec.2020` + gamma `ST2084`/`Rec.2100 ST2084`
- 若同时要 SDR 版本：另建 SDR 时间线或用输出 tone mapping（`colorSpaceOutputToneMapping` 非 `None`），**不要**在 HDR 项目里直接输出 SDR 标签

## 5. 验证的物理极限（必须写进 UI/文档，避免过度承诺）

- **ffprobe 只能验 三原色/矩阵 与 PQ/HLG 传输**：`color_primaries`、`color_matrix`、`color_transfer ∈ {bt709, smpte2084, arib-std-b67, …}`。
- **display gamma（2.4 / 2.2 / 1.96 / Rec.709-A）不会映射成 `color_transfer`**：仓库自己的实现里就是这么处理并显式放弃断言——`resolve-advanced/server/deliverable-spec-bridge.mjs:142-177`：
  > “Rec.709 Gamma 2.4 names a display gamma, which is not the same thing as the BT.709 OETF that ffprobe would report as color_transfer=bt709 … the transfer is deliberately left unmapped and reported.”
- 所以：**「输出 gamma 是否 709-A」这件事，插件能读项目设置/能写渲染标签，但无法从成片元数据反向证明**。声称验证过 = 撒谎。可做的替代：
  1. 读项目设置键（权威度：项目配置，不是成片）；
  2. 渲染同一帧两次（改前/改后各一帧），比较平均亮度/直方图（`Project.ExportCurrentFrameAsStill` 出帧 + 像素统计），证明「画面确实变了/变对了」；
  3. 用 `resolve_advanced scope_read`（离线读图片/帧）出黑位/白位/中灰统计，作为**行为证据**而不是元数据证据。

## 6. 资料来源

- Blackmagic《Colorist Guide to DaVinci Resolve 20》Appendix B — Setup and Delivery on Macs（iMaster 中译镜像）：<https://docs.imaster.org/colorist-guide-r20/appendix-b>
  - 「Use Mac Display Color Profile for Viewers」只影响查看器；Gamma Tag 改 Rec.709-A 时「把传输函数标记留空，Apple 应用按 Apple 色彩管理映射，其它设备按 BT.709 映射」；把 Rec.709-A 作为输出色彩空间会把 gamma 烘进信号（适合网络，不适合广播/放映）；Display P3 屏建议 P3-D65 + sRGB。
- CineDream 官方文档（Resolve 21 时代，2025-10）：<https://docs.cinedream.io/color-management/color-management-davinci-resolve.md>
  - Preferences→General 里两个 Mac 开关：「Use Mac display color profiles for viewers」≈ 显示器 ICC 开关；「Viewers match Quicktime player when using Rec.709 (Scene)」用于消除 Mac gamma shift，且只在 Timeline/Output = Rec.709 (Scene) 时生效；对应 Apple gamma 记为 **1.9**。
- Blackmagic Design 16.2.2 发行说明（Newsshooter 转载）：<https://www.newsshooter.com/2020/05/19/2davinci-resolve-16-2-2/>
  - “Support for Rec.709-A gamma option for QuickTime player compatibility.” / “Preference to automatically tag Rec.709 clips as Rec.709-A.”
- CineD《Quicktime Gamma Shift Bug》：<https://www.cined.com/quicktime-gamma-shift-bug-what-is-it-and-how-to-combat-it/>（背景科普，正文抓取被截断，仅作二源）
