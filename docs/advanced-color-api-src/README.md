# advanced-color-api-src — 源码摘录与实测记录

本目录是 [`../advanced-color-api.md`](../advanced-color-api.md) 的**证据附录**：摘录关键源码片段
与实测脚本/输出，方便复核与后续更新。

> 基线版本：本机 `davinci-resolve-mcp`（resolve-advanced 0.0.0-dev），摘录时间 2026-11-13。
> 路径缩写：
> - `S` = `$HOME/Library/Application Support/davinci-resolve-mcp/resolve-advanced/server`
> - `V` = `.../resolve-advanced/vendor`
> - `PY` = `$HOME/Library/Application Support/davinci-resolve-mcp/src/server.py`

## 文件

| 文件 | 内容 | 对应正文 |
|---|---|---|
| `01-drx-tool-schemas.md` | `drx` 全部 zod schema + action 分派表 + 返回组装 | §3、§4、§5.1 |
| `02-scope-read-contract.md` | scope_read 的 ROI 实现、返回结构、信号判据 | §2 |
| `03-generator-qualifier-window.md` | `createNode` 编排、qualifier/window/custom+hsl 曲线 builder、R21 窗口、换算常数 | §5.2、§5.6、§5.7 |
| `04-merge-parse-pitfalls.md` | merger 的节点搬运逻辑、parser 的 node.params 边界、_raw、toolBreakdown | §3.1、§5.5 |
| `05-live-apply-and-verify.md` | `safe_apply_drx`、readback、confirm_token、temp 路径守卫 | §6 |
| `06-verified-runs.md` | 本次实际执行的离线脚本与实时 MCP 调用及输出 | §8 |

## 如何重新抽取（源码升级后核对）

```bash
S="$HOME/Library/Application Support/davinci-resolve-mcp/resolve-advanced/server"
V="$HOME/Library/Application Support/davinci-resolve-mcp/resolve-advanced/vendor"

sed -n '44,304p' "$S/tools/drx.mjs"            # 全部 schema
sed -n '687,987p' "$S/tools/drx.mjs"           # action 分派
sed -n '81,257p'  "$S/scope-read.mjs"          # ROI + 统计
sed -n '550,940p' "$V/drx-codec/drx-generator.js"     # createNode
sed -n '2660,2985p' "$V/drx-codec/drx-generator.js"   # qualifier + window builders
sed -n '108,273p' "$V/drx-codec/drx-merger.js"        # mergeNodes + generateMergedDRX
sed -n '608,880p' "$V/drx-codec/drx-parser.js"        # extractNodes / node.params
sed -n '30121,30166p' "$HOME/Library/Application Support/davinci-resolve-mcp/src/server.py"
```

## 一键自检（不需要 Resolve，5 条 curl 级命令）

```bash
cd "$HOME/Library/Application Support/davinci-resolve-mcp/resolve-advanced"
node -e "try{require('sharp');console.log('sharp OK')}catch{console.log('sharp MISSING')}"
node -e "console.log('native zstd:', typeof require('zlib').zstdCompressSync)"
which ffmpeg ffprobe
node /tmp/drx-test.cjs 2>/dev/null   # 多层节点图（脚本见 06-verified-runs.md）
```
