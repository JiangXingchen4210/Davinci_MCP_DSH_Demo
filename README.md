# davinci-console（0.11.4 · DEMO）

![npm](https://img.shields.io/npm/v/davinci-console-demo?label=npm)
![demo](https://img.shields.io/badge/status-DEMO-orange)

仓库：<https://github.com/JiangXingchen4210/Davinci_MCP_DSH_Demo>

DaVinci Resolve 的调色 / 剪辑控制台，作为 DSH Web 插件运行：在浏览器面板里完成「素材 → 还原 → 调色/风格 → 交付」的完整流程，所有动作通过 **Resolve MCP** 驱动本机 DaVinci Resolve Studio。

> ⚠️ 这是 **Demo 版（0.11.4）**：核心链路已可用，擦除（erase）等实验功能明确标记 DEMO/禁用；请在真实交付前自行复核画面。

## 功能

- **工程预检**：项目设置、色彩科学、离线素材一次性体检；缺素材会拦住风格与渲染
- **灰片还原**：先判断是否 LOG（画面统计）→ 读元数据识别机型/曲线 → 在 DaVinci 自带/官方库按曲线匹配；库里没有时给厂商官方页面，可粘贴直链自动下载安装（如 OPPO O-Log 已验证），或上传 `.cube`
- **三层 15 节点调色图**：每节点一个工具（还原/白平衡/曝光/对比/曲线/色相/饱和/分离色调/肤色键/背景键/风格 LUT/质感），`grade.nodeReport` 逐节点说明作用
- **风格库（10 个，带出处）**：青橙、漂白旁路、矩阵绿、银翼杀手 2049、夜魔侠暗黑、韦斯·安德森粉彩、月光蓝、疯狂麦克斯·铬版、教父琥珀、柯达 2383；一键应用，配方逐组写入并读回校验
- **质感**：黑柔/白柔（Fusion Glow）、颗粒意图、可选胶片模拟 LUT
- **局部**：抠像、面部跟踪、遮罩校验、透视跟踪、擦除（DEMO）
- **交付**：先选长宽/帧率/码率生成方案，**用户确认后才渲染**
- **调试日志**：面板内逐条中文显示「阶段 / 节点 / 工具 / 目的 / 参数」

## 环境要求

| 依赖 | 说明 |
|---|---|
| macOS | 当前仅支持 macOS（`osascript`/`sips`/预编译助手） |
| DaVinci Resolve Studio | 建议 21.2；需可被 Resolve MCP 连接 |
| Resolve MCP | 工具名 `resolve_*`（DSH 中启用对应 MCP 插件） |
| ffmpeg / ffprobe | `brew install ffmpeg`，用于分析/抽帧/导出 |

面板启动时会自动检测以上依赖，缺什么会在顶部提示。

## 安装

```bash
# DSH 市场/包安装
npm install davinci-console-demo@0.11.4
# 或在 DSH 的插件管理中按包名安装后启用
```

## 使用（三步）

1. **素材交接**：粘贴素材路径或选择文件，导入后自动体检色彩管线
2. **还原**：点「判断/匹配还原 LUT」；灰片才需还原，库里有同曲线多条时由你选；缺 LUT 按官方链接下载/上传
3. **调色/风格 → 交付**：在标签页调色或点「一键风格」，再到「交付」选参数并确认渲染

详细说明见 [USER_MANUAL.md](./USER_MANUAL.md)。

## 版本

- 0.11.0（Demo）：还原决策链路、15 节点图、风格库、交付审批、调试日志、依赖自检、内置 LUT 支持库（清单随包，LUT 本体因授权不随包发布）

## License

MIT


## 反馈 / 报错

- 面板底部「调试日志 → **反馈/报错**」：自动把环境（MCP/ffmpeg/Resolve 路径）、最近日志打包进预填 Issue，并保存一份到插件 data 目录；
- 也可以直接开 [Issue](https://github.com/JiangXingchen4210/Davinci_MCP_DSH_Demo/issues/new/choose)，附版本号与日志；
- 支持邮箱：2504836725@qq.com

## Star / 使用反馈

如果这个 DEMO 对你有用，欢迎 Star 仓库；遇到问题请提 Issue（附日志），我会按报错优先级修复并记录在 CHANGELOG。
