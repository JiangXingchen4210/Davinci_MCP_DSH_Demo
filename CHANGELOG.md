# CHANGELOG

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
