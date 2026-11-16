# CHANGELOG

## 0.11.20 — Connection 准入 + icon 元信息修复

- **安全**：面板 `/davinci-panel/action` 与 `/davinci-panel/media` 接入 DSH `ctx.connection.requestRejection()`；未认证 → 401、来源不信任 → 403、认证服务不可用 → 503（fail closed，不再只靠回环地址与固定请求头）
- 新增 `lib/route_auth.mjs`（admissionStatus/admissionMessage）与 `route_auth.test.mjs`；实测无凭据 POST = 401，无凭据媒体 = 403
- `index.js` inject 增加 `connection`
- **icon 元信息**：移除 `exports["./icon"]`，改用顶层 `"icon": "icon.svg"`，修复 `@local` 软链安装时 DSH 报 `icon must remain inside its package directory`

## 0.11.19 — 剧情坐标 / 肤色选区 / 风格完成度 / Vision 测试降级（正式版）

- **剧情切点坐标统一**：运动采样不再加源偏移，保持镜头内相对秒（与 `placeUnit` 一致）；同一表演在源文件平移 40s，相对切点/理由/质量不变（新增 `story_offset.test.mjs`）
- **肤色选区共享**：#10 肤色保护与 #12 肤色提亮使用同一份色相窗口；无可靠肤色样本时 #12 保持中性并跳过局部提亮（节点注释说明）
- **面板风格完成度**：风格卡/一键风格显示「成片完成度」——必需效果缺失、颗粒/暗角未实现（需 Fusion/后期）分别列出
- **Vision 测试降级**：新增 `lib/vision_probe.mjs`；人脸/OCR/贴图测试在系统 Vision 不可用时打印 SKIP 并 0 退出，不再把环境问题报成失败

## 0.11.18 — 色彩科学 / 素材识别 / LUT 结果 / 剪辑取材（本地版）

- **DJI D-Log 修正**：按白皮书 `y = 0.256663*log10(0.9892x+0.0108)+0.584555`（18% 灰 = 0.398765）；解码同步改为白皮书反函数
- **Sony S-Log3 暗部连续**：低段改为 95→171.2102946929 的线性过渡（切点 0.011249→0.011250 不再跳变；18% 灰 = 0.410557）
- 新增 `lutgen_dji_sony.test.mjs`：官方参考值 + 三曲线 2001 点单调性 + cube 采样
- **素材识别**：S-Cinetone / Rec.709 / SDR 明确声明优先于机型；显式 LOG 曲线名（S-Log3/D-Log/V-Log…）优先于机型表；仅识别到机型时返回“需确认曲线”候选，不再直接认定 Log
- **元数据查询修正**：改用媒体池 clip id（此前误用时间线项 id），并把片段属性、项目输入/时间线/输出色彩空间纳入判断
- **LUT 业务结果**：`restore.apply` 与风格 Film LUT 统一解析 `false`/`{success:false}`，并读回节点 LUT；挂载失败不再报成功，`effects.missing` 会含 `filmLut`
- **剪辑取材**：源出点读取失败时用片段 `duration` 帧数回退（不再缩成 1 帧）；`scenes.scan` 输出帧时间戳，按时间线可用区间过滤代表帧，裁剪过的镜头用 `scenes.mjs metrics` 按交集重算指标
- **节奏报告**：刀/分钟改为按相邻镜头边界（N-1）计算，单镜头零切换不再显示 10 刀/分钟

## 0.11.17 — source 预览真机打通（本地版）

- 根因：宿主进程用 ffmpeg 解码任何视频文件都会卡住（图片正常；/tmp 小视频同样卡），与目录权限无关
- source 预览改为**完全绕开宿主 ffmpeg**：直接使用 Resolve 侧 `extract_frames` 抽出的 JPEG 回传（`method: mcp-frame-direct`）
- 真机验收（考试三_时间线 / Downloads 素材）：
  - `current` 0.3s ✅
  - `source` **1.3s ✅**（dataUrl 1.79MB，原图直传）
  - `source vs current` 分屏 **1.3s ✅**
- 分层预览仍按 `preview.capabilities` 置灰（MCP 不返回节点开关、节点列表 3/15）

## 0.11.16 — source 预览改走 Resolve 侧抽帧（本地版）

- 移除宿主 ffmpeg 直读原始素材的路径（实测宿主机调起后读任何视频文件都不返回；/tmp 小文件同样如此，排除 TCC 目录问题）
- source 预览改为 MCP `extract_frames` 在 Resolve 侧抽帧，再由宿主 ffmpeg 缩放
- 实测 MCP 抽帧本身 <1s，但经插件链路仍触发 25s 超时 → 下一步在 exportSourceFrame 内部逐步打点（captureSourceFrame / extract_frames / 缩放）
- 保留 25s / 45s 超时兜底

## 0.11.15 — source 预览诊断（本地版）

- 定位：宿主进程里 ffmpeg 路径正确（`/opt/homebrew/bin/ffmpeg`），但读取桌面 4K 源文件时调起后不返回；同一命令在终端 1s 完成
- 高度怀疑 macOS 隐私（TCC）对 DSH/子进程的「桌面/文件与文件夹」访问限制：`current` 预览只用 Resolve 导出的帧（可读），`source` 需要直读原始素材
- 仍保留 25s 超时兜底（不会卡死）
- 下一步：把素材拷到非受保护目录（如 `~/Movies` 或 `/tmp`）验证，或给 DSH 授予完全磁盘访问权限

## 0.11.14 — 预览超时兜底（本地版）

- `preview.live` 加 25s 超时、`preview.compare` 45s：超时返回可解释错误，不再让面板无限转圈
- 实测：`current` 0.3s 正常；`source` 25s 后返回 `timeout: true` + 提示（源素材抽帧在宿主进程里仍未完成，下一步单独定位）
- 分层预览继续按 `preview.capabilities` 置灰并说明原因

## 0.11.13 — 分层预览能力探测 / source 提速（本地版）

- **实测确认**：本机 MCP `probe_node_graph` 不返回 `enabled`，且只返回有工具的节点（15 个节点只读到 3 个）⇒ 没有可靠的分层预览前提
- 新增 `preview.capabilities`：报告 `layeredPreview` 是否可用、节点数/开关可读性/不完整原因
- **面板按能力禁用 L1–L3**并显示原因；`current` / `source` / 分屏（这两层）保留
- **source 预览提速**：改为对源文件 ffmpeg 精确定位抽 1 帧（30s 超时），失败才回退 MCP `extract_frames`（4K 素材上后者曾 >300s）

## 0.11.12 — 实时预览接线 + 风格必需效果验收（本地版）

- **实时预览真正接进 UI**：调色页新增「实时预览 / 分屏对比」卡片（现行/原素材/L1/L2/L3 + 左右分屏选择），调用 `preview.live` / `preview.compare`；客户端测试断言 op 已被调用，不再是 host 有实现、UI 无入口
- **风格必需效果验收**：新增 `lib/style_effects.mjs`（planStyleEffects / summarizeStyleEffects）
  - 颗粒/暗角：当前 Color API 无法落地，明确标为 `unsupported`，不计入成功，并在返回里给出替代方法
  - Film LUT / 柔光：作为 required，挂载失败 → `ok:false`、`effects.missing` 列出缺项
  - 一键风格把 `style.grain` 作为质感意图传给建图（节点 15 记录），但不再谎称"已加颗粒"

## 0.11.11 — 测试可复现性 / 数据目录 / 预览文件名（本地版）

- **`npm test` 可用**：`package.json` 增加 `"test": "node --test --test-concurrency=1"`，干净解包 31/31 通过；串行也避开 `overlay` 改 `vision.swift` mtime 与 `cutout` 重编的跨进程竞争
- **数据目录可覆盖**：新增 `DAVINCI_CONSOLE_DATA_DIR`（默认仍是 `~/Documents/resolve-console`）；Host 集成测试改用系统临时目录，不再写用户目录
- **cutout 测试在缺 Swift 工具链时 SKIP**：不再把"没装 Xcode"报成失败（插件运行用随包 `bin/davinci-vision`，不需要工具链）
- **预览文件名不再同秒覆盖**：`live-<秒>-<序号>.jpg` / `live-src-<秒>-<序号>.jpg`；测试断言同秒两次预览路径不同
- 测试断言：预览文件必须落在配置的数据目录内

## 0.11.10 — 第一批可信度修复（曲线 / 还原决策 / 剪辑入出点）· 本地版

- **Panasonic V-Log 曲线修正**：按官方公式 `V=c·log10(L+b)+d`（log 内是 L+b，不是 5.6L+b）；18% 灰 = 0.423311；黑位 0.125、分段点 0.181、线性 1.0 = 0.599118；解码与 .cube 采样用三线性核对
- **恒等用途分离**：`rec709-identity` 更名为「Linear → Rec.709 显示编码」，新增 `linear-identity`（逐通道不变，0.5→0.5）
- **还原决策改为元数据优先**：显式曲线/色域（LogC4/AWG4）先于机型；ARRI 拆成 LogC4 与 LogC3 两条，LogC4 不再拿 LogC3 LUT；项目 RCM 已接管输入时跳过技术 LUT；画面统计只用于提示冲突，低反差雾景/夜景不再被提前判"无需还原"
- **自动剪辑尊重源入出点**：新增 `lib/source_range.mjs`；扫描镜头与片段可用源区间取交集，区外镜头不入选；建线前把规划 in/out 夹回该区间；同一源文件多次使用按各自入点处理
- 新增测试：`lutgen_panasonic.test.mjs`、`restore_meta.test.mjs`、`source_range.test.mjs`

## 0.11.9 — 跨片段预览串帧修复（本地版）

- **共享播放头全局锁**：预览锁从「按 itemId」改为「按播放头」；`current` / `source` / 分层预览全部纳入同一把锁，覆盖「定位→读原状态→切层→抓帧→恢复」整段，跨片段不会再串帧
- 预览结果新增 `timecode` 字段（本次抓帧实际所在时间码）
- 移除跨请求的 `lastStageByItem` 状态复用：每次预览都切层并在结束后按原状态恢复
- **Host 集成测试同步点**：fake `export_frame_as_still` 显式发 `captureArrived` 信号；`testOverlappingPreviews` 等信号而非固定 tick 次数
- 新增 `testCrossClipPreviewTimecode`：A 在 00:00:00:00、B 在 00:00:02:00，断言两次抓帧时间码与最终节点状态

## 0.11.8 — 预览状态安全（Host 集成回归）· 本地版

- **节点写入按真实契约解析**：`parseNodeWriteResult` 支持布尔与 `{success}`；恢复返回 `false` 不再算成功
- **切换/抓帧/恢复统一组装**：不再在 try 内提前 return，`stageFailed` 与 `restore.failed` 都会到达调用方；两者都失败时 `ok:false`
- **重叠预览串行化**：同一片段从「定位→读原状态→切层→抓帧→恢复」整段加锁；交错请求不会再互改节点状态
- **读图失败不当成功**：`readLayeredNodes` 返回 `{ok, nodes, error}`；分层预览读图失败返回 `probe_failed`；`preview.compare` 校验两侧 ok/dataUrl，左恢复失败立即停止右侧
- **轨道读取错误保留**：`videoTrackCount`/`listVideoItemsSafe` 不再把失败当 0 条；`findItemAcrossTracks` 只有完整扫描后才报"找不到"
- 新增 **Host 集成测试** `test/host_integration.test.mjs`：从 `index.js apply(ctx)` 取面板工具，fake MCP 记录调用并模拟节点开关/抓帧；覆盖恢复返回 false、切换+恢复均失败、重叠预览锁、读图失败、分屏失败、轨数/单轨读取失败、V5 定位

## 0.11.7 — 预览状态安全 + 交付停止/回滚/比较规则 + 跨轨定位

- **分层预览改变原节点状态**：新增 `lib/preview_state.mjs`（normalizeNodes/planStageEnabled/planRestore/summarizeRestore）；节点状态未知时**零次写节点**并返回可解释错误；恢复按原始开关逐条写回；恢复失败在结果里给出节点编号
- **删除任务失败仍继续交付**：新增 `lib/delivery_rules.mjs` 的 `parseDeleteResult`（支持布尔与 {success}）；首个任务删除未确认成功即停止（不改项目、不再建任务、不启动），返回 jobId 与删除结果
- **回滚提示与真实状态不一致**：`summarizeRestore` 区分「未改动 / 已全部恢复 / 未完全恢复」，文案列出设置名、原值、读回值；所有失败出口复用同一结论，不再用已重置的 projectChanged 推断
- **帧率比较三处不一致**：`valuesEqual` 统一规则（帧率数值+容差、宽高整数、空值无效），用于任务规格核对、项目设置写后校验、回滚读回校验
- **指定高轨片段只查 V1**：新增 `lib/timeline_lookup.mjs`；`resolveItemContext`/`seekToItem` 指定 itemId 时按**实际视频轨数量**逐轨查找（空轨不提前结束），未指定时保留 V1 默认行为
- 新增回归测试：`preview_state.test.mjs`、`delivery_rules.test.mjs`、`timeline_lookup.test.mjs`

## 0.11.6 — 分层预览不再改原调色 + 交付回滚/校验加固

- **分层预览会改原调色节点**：预览前保存每个节点的原始开关，`finally` 里按原状态逐一还原（不再一律 L3 全开；抓帧失败也会还原）
- **工程回滚失败仍报"已恢复"**：恢复时逐项写回并读回校验；只有全部校验通过才 `restored: true`，否则列出失败项
- **旧项目值读不到仍改动工程**：改项目设置前要求三个旧值都可读，否则直接中止（删除刚建的任务）并如实报告
- **编码不一致仍启动**：规格核对加入 codec（H.264/H.265/HEVC/ProRes 归一化后比较）
- **帧率写法不同误判**：帧率改按数值比较（24 与 "24.000" 视为一致）
- **启动返回 false 仍报成功**：只有 `true` 或 `{success:true}` 才算启动成功，其余按失败处理并删任务/恢复工程
- **删任务失败仍提示已删除**：`delete_job` 结果参与判断，失败时提示"任务删除失败，可能仍在队列"

## 0.11.5 — 修复预览回归 + 交付成功条件收紧

### 高优先级
- **预览完成后抛 ReferenceError**：`status` 声明移出 `try` 块；`finally` 仍负责释放忙碌状态
- **建任务无 job_id 仍启动**：拿不到 `job_id` 立即中止，绝不向 `start` 传空列表
- **规格不符仍启动**：先建任务 → 读回 `list_jobs` 核对宽/高/帧率/容器，不符则删任务；必要时改项目设置（保存旧值）后重建并再核对；仍不符则删除任务、**恢复旧项目设置**、不启动
- **中止后工程被部分修改**：写项目设置前保存旧值，任一失败/不符即恢复
- **面板误报"已提交渲染"**：只有 `ok && jobId` 才显示已启动，否则显示后端错误
- **同名时间线串用令牌**：确认时按 `timelineId` 比对（无 id 才回退名称）

### 其它
- 一键风格：顶层 `ok` 与"已应用"数量要求 **grade + restore 同时成功**，失败项列在 `failed`
- 随包提供 `lib/fixtures/**`（干净解包可跑 24 个测试）
- 对白声轨测试：TTS 合成近静音时跳过对白断言并说明原因（不再误报）

## 0.11.4 — 交付链路修复（依据外部 MCP 复现报告）

### 高优先级修复
- **交付预检不再误放行**：读不到时间线 / 时间线为空 / 任意音视频轨有离线素材都会 `ok:false` 并列出 `blockedReasons`；预检同时检查**音频轨**（此前只查视频轨）
- **确认方案与渲染任务规格一致**：容器按用户选择走（mov/mp4，可 ProRes/H.265），码率随方案传入；分辨率/帧率写入项目设置后**读回校验**，任一失败即中止、不创建任务
- **确认令牌一次性 + 绑定项目/时间线**：令牌改为单次使用（确认即消费），确认时校验当前项目与时间线与方案一致；重复提交第二次直接报错
- **一键风格不再"丢 LUT 还报成功"**：手动 `lutPath` 时保存完整路径，节点图重建后用同一路径补挂；补挂失败会标记 `restore:false` 并给出错误

### 中优先级修复
- 预览建任务失败时 `renderInProgress` 卡住：改为 try/finally 清理，失败后 L1/L2/L3 预览不再被"渲染进行中"拦住
- `deps.check` 误报 Resolve 未安装：`fs.existsSync` 改从 `node:fs` 导入（之前用 promises 版，异常被当成不存在）
- 人脸/抠像模块优先使用随包 `bin/davinci-vision`；本机有编译产物时仍按源码时间戳重编（测试可验证）

### 测试
- 本地 24 个测试文件全部通过（修复 overlay 重编断言、face 二进制路径）

## 0.11.3

- 文档与版本对齐：README / USER_MANUAL 版本号更新到 0.11.3
- 邮箱工具增强：`mail_fetch.py read` 支持**一次读多封**（`read 2823 2825` 或 `--uids 2823,2825`）
- 发布链路：GitHub Actions → npm Trusted Publisher（OIDC + provenance）稳定可用

## 0.11.2（验证 npm 可信发布）

- 验证 GitHub Actions → npm Trusted Publisher（OIDC）发布链路
- publish workflow：恢复 release 触发，保留「版本已存在则跳过」守卫
- 无功能变更，仅发布链路验证

## 0.11.1（未发布 / 待 npm publish）

- 新增 `feedback.issue`：一键生成带环境与调试日志的预填 GitHub Issue，并保存本地草稿
- 面板「调试日志」新增 **反馈/报错** 按钮
- 新增仓库 Issue 模板（报错 / 功能请求）
- 包版本从 0.11.0 → 0.11.1（能力新增，不影响已有用法）

## 0.11.0（2026-11-16，DEMO 首发）

- 工程预检、灰片还原（机型/曲线 + 官方 LUT 匹配/下载/上传）
- 三层 15 节点调色图 + 逐节点报告
- 10 个带出处的风格库（配方逐组读回校验）
- 黑白柔、抠像、面部跟踪、遮罩校验、透视跟踪
- 场景扫描 / 剧情转写 / 按剧情剪辑
- 交付审批（长宽/帧率/码率 → 确认后渲染）
- 面板内中文调试日志 + 依赖自检
- 内置 DJI LUT 支持库清单（LUT 本体不随包）
