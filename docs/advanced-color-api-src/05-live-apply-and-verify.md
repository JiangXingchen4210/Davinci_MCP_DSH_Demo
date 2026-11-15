# 05 — 落地与验证：`safe_apply_drx` / readback / confirm_token（摘录）

源码：`PY` = `/Users/wupx/Library/Application Support/davinci-resolve-mcp/src/server.py`；
`CT` = `.../src/utils/confirm_tokens.py`；`S` = `resolve-advanced/server`。

## 1. `_safe_apply_drx`（`PY:30121-30166`）

```python
def _safe_apply_drx(proj, item, p):
    path = p.get("path")
    if not path:
        return _err("path is required", code="MISSING_PATH", category="invalid_input")
    if not os.path.isfile(path):
        return _err(f"DRX file not found: {path}", code="DRX_NOT_FOUND", category="invalid_input")
    if _coerce_bool(p.get("require_temp_path"), True) and not _grade_temp_path_ok(path):
        return _err("DRX path must be under the system temp directory unless require_temp_path=False",
                    code="DRX_PATH_NOT_TEMP", category="invalid_input")
    graph, source, err = _color_graph_from_params(proj, item, p)
    if err:
        return err
    if not _has_method(graph, "ApplyGradeFromDRX"):
        return _err(f"{source} graph does not expose ApplyGradeFromDRX",
                    code="APPLY_DRX_UNSUPPORTED", category="unsupported")
    refused = _refuse_empty_track_grade(path, source)
    if refused:
        return refused
    if _coerce_bool(p.get("dry_run")):
        return _ok(path=path, source=source, grade_mode=p.get("grade_mode", p.get("mode", 0)),
                   would_apply=True)
    # B2 — Whole-grade replacement is catastrophic; require confirmation.
    if "confirm_token" not in p and "confirmToken" not in p:
        if _confirm_token_required():
            preview = {"operation": "safe_apply_drx",
                       "warning": "REPLACES the target graph entirely. There is no append mode.",
                       "path": path, "source": source,
                       "grade_mode": p.get("grade_mode", p.get("mode", 0))}
            return _issue_confirm_token(action="safe_apply_drx", params=p, preview=preview)
    blocked = _consume_confirm_token(action="safe_apply_drx", params=p)
    if blocked:
        return blocked
    group = None
    if source in ("color_group_pre", "color_group_post"):
        group = next((g for g in proj.GetColorGroupsList() or [] if g.GetName() == p.get("group_name")), None)
    candidates = _drx_candidate_graphs(
        source, item=item, group=group,
        layer_index=p.get("layer_index") if source == "item" else None)
    return _apply_drx_with_readback(graph, source, path, p.get("grade_mode", p.get("mode", 0)), candidates)
```

## 2. 图源解析（`PY:29693-29712`）

```python
def _color_graph_from_params(proj, item, p):
    source = p.get("source", "item")
    if source == "item":
        graph = item.GetNodeGraph(p["layer_index"]) if "layer_index" in p else item.GetNodeGraph()
        return graph, "item", None
    if source == "timeline":
        _, tl, err = _get_tl()
        if err: return None, source, err
        return tl.GetNodeGraph(), "timeline", None
    if source in ("color_group_pre", "color_group_post"):
        group_name = p.get("group_name")
        if not group_name:
            return None, source, _err("group_name is required for color group graph sources")
        for group in proj.GetColorGroupsList() or []:
            if group.GetName() == group_name:
                graph = group.GetPreClipNodeGraph() if source == "color_group_pre" else group.GetPostClipNodeGraph()
                return graph, source, None
        return None, source, _err(f"Color group '{group_name}' not found")
    return None, source, _err(f"Unknown color graph source: {source}")
```

## 3. readback 与 verification（`PY:29808-29870`）

```python
def _apply_drx_with_readback(graph, source, path, grade_mode, candidates):
    before = {name: read(getter) for name, getter in candidates.items()}
    native = bool(graph.ApplyGradeFromDRX(path, grade_mode))
    after = {name: read(getter) for name, getter in candidates.items()}

    graphs = {}
    changed, unreadable = [], []
    for name in candidates:
        b, a = before[name], after[name]
        if b is None or a is None:
            unreadable.append(name); graphs[name] = {"readable": False}; continue
        graphs[name] = {"num_nodes_before": b["num_nodes"], "num_nodes_after": a["num_nodes"],
                        "changed": b != a}
        if b != a: changed.append(name)

    landed_elsewhere = bool(changed) and source not in changed
    verification = {"verified": source in changed, "contradiction": landed_elsewhere,
                    "method": "node count, labels and LUTs of each graph before and after"}
    result = {"success": native, "path": path, "source": source, "changed_graphs": changed,
              "graphs": graphs, "verification": verification}
    if unreadable: result["unreadable_graphs"] = unreadable
    if landed_elsewhere: return {**result, **_err(... code="DRX_APPLIED_TO_OTHER_GRAPH" ...), "success": False}
    if native and not changed:
        result["warning"] = ("No graph changed its node count, labels or LUTs. Either the grade has "
                             "the same node structure as before (only parameters changed, which the API "
                             "cannot read back) or nothing was applied; confirm with a rendered frame "
                             "or the scopes.")
    return result
```

`_graph_fingerprint`（`PY:29750-29770`）只取 `GetNumNodes` + 每节点 `GetNodeLabel`、`GetLUT`；
**参数值读不回来**，所以同结构 apply 只能给 warning。

## 4. timeline 空图守卫（`PY:29715-29745`）

```python
def _drx_track_grade_state(path) -> str:
    # 读 <pTrackVer>，看 <HasCorrection>：present / empty / missing / unreadable
def _refuse_empty_track_grade(path, source):
    if source != "timeline": return None
    state = _drx_track_grade_state(path)
    if state in ("missing", "empty"):
        return _err("This .drx carries no timeline grade (<pTrackVer> is ...). Applying it to the "
                    "timeline graph would change nothing and replace the existing timeline graph with "
                    "an empty one.", code="DRX_NO_TIMELINE_GRADE", category="invalid_input",
                    remediation="Apply it to a clip (source='item') instead, or ...")
```

## 5. temp 路径守卫（`PY:22010-22022`）

```python
def _render_temp_path_ok(path: str) -> bool:
    if not path: return False
    target = os.path.abspath(path)
    temp_roots = [os.path.abspath(tempfile.gettempdir()),
                  os.path.abspath("/private/tmp"), os.path.abspath("/tmp")]
    return any(os.path.commonpath([target, root]) == root for root in temp_roots)
```

macOS 上 `/tmp/...` 通过；项目目录下的 `.drx` 需要 `require_temp_path:false`。

## 6. confirm token（`CT:147-240`）

```python
def issue(self, *, action, params, preview):
    token = uuid.uuid4().hex
    self.tokens[token] = {"action": action, "fingerprint": self.fingerprint(action, params),
                          "expires_at": time.time() + self.ttl_seconds}
    body = self._err("This action is destructive. Re-call with confirm_token to proceed.",
                     code="CONFIRMATION_REQUIRED", category="pending_user_decision",
                     retryable=False, remediation=f"Re-call {action} with params.confirm_token={token!r}; ...")
    body.update({"status": "confirmation_required", "confirm_token": token,
                 "preview": preview, "expires_at_epoch": expires_at, "ttl_seconds": self.ttl_seconds})
    return body

def consume(self, *, action, params):
    # 无 token → None（调用方应先 issue）；token 无效/过期/跨进程 → CONFIRM_TOKEN_INVALID
    # action 不符 → CONFIRM_TOKEN_ACTION_MISMATCH
    # 参数指纹不符 → CONFIRM_TOKEN_FINGERPRINT_MISMATCH（第二次调用参数必须完全一致）
```

- 指纹 = `sha256({action, params})[:16]`，会剥离 `confirm_token`/`confirmToken` 两个键
  （`CT:104-127`）。
- `DEFAULT_TTL_SECONDS = 300`。
- 只在签发它的**进程**内有效（stdio 服务器与网络服务器不共享）。

## 7. `relayout` 后必须 reset 的原因（README + PY）

- `resolve-advanced/README.md:168`：
  “relayout ... live recipe: grab → relayout → reset grade → apply (**same-structure applies keep
  the old layout**)”
- `PY:675-677, 32003-32007` 同义：`graph.reset_all_grades -> safe_apply_drx`（同结构 apply 保留旧布局）。

## 8. 参数级回读（`.drp` → `drxContent` → verify_grade）

`S/tools/drp.mjs:270-288`：

```js
if (action === 'extract_node_graphs') {
  const index = await indexFn(p.drpPath);
  const graphs = [];
  for (const clip of index.clipsById.values()) {
    if (!clip.bodyHex) continue;
    const drxContent = `<?xml version="1.0" encoding="UTF-8"?>\n<Resolve_Color_Exchange>\n <Label>${xmlEscape(clip.mediaFilePath || clip.clipId)}</Label>\n <Width>1920</Width>\n <Height>1080</Height>\n <Body>${clip.bodyHex}</Body>\n</Resolve_Color_Exchange>\n`;
    graphs.push({ clipId, trackType, sequence, mediaFilePath, drxContent, ...(p.includeBodyHex ? { bodyHex } : {}) });
  }
  return { drpPath: p.drpPath, clipsWithGrade: graphs.length, totalClips: index.clipsById.size, graphs };
}
```

`verify_grade` 只依赖 `<Body>`（`S/verify-grade.mjs:43-47`），所以这个 `drxContent` 可直接作
`applied.content`。

组级更短：`grade_transfer {drpPath, group, which:'post', outPath}` → 组 grade 的 .drx。
