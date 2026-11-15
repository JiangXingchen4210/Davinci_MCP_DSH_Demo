# CHANGELOG

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
