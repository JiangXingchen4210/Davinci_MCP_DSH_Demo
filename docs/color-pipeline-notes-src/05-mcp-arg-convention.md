# MCP 调用约定（最容易踩的一条坑）：参数必须放进 `params`

这条不是色彩问题，但会让「色彩体检/修复」整块静默失效，所以单列。

## 事实链（源码 + 实测）

1. 每个工具的签名都是 `def xxx(action: str, params: Optional[Dict[str, Any]] = None)`（例：`src/server.py:21758 project_settings(action, params)`）。
2. 服务端用的是 `mcp = ErrorFlaggingFastMCP(...)`（`src/server.py:266`，类在 `src/utils/mcp_error_flag.py:73`）。这个子类**只**覆盖 `call_tool` 给结果打 `isError` 标记，**没有**做任何「把顶层多余键并进 params」的兼容。
3. 底层 `mcp` SDK 1.30.0（`venv/.../mcp/server/fastmcp/utilities/func_metadata.py`）：
   - `arguments_model = create_model(f"{func.__name__}Arguments", __base__=ArgModelBase, **动态字段)`；
   - `ArgModelBase.model_config = ConfigDict(arbitrary_types_allowed=True)`（第 83 行），pydantic 默认 `extra="ignore"`；
   - `call_fn_with_arg_validation`：`arg_model.model_validate(arguments)` → `model_dump_one_level()` → `fn(**dict)`。
   → **schema 里没声明的顶层键会被静默丢弃**，不会报错、不会进 `**kwargs`。
4. 服务端的参数兜底也只认 `params`：`_guarded_params(args, kwargs)`（`src/server.py:1714`）只取 `kwargs["params"]` 或位置参数第 2 个 dict。

## 实测后果

```
调用 {action:"set_setting", name:"colorScienceMode", value:"..."}   ← 顶层裸参数（当前 host 写法）
→ 到达服务端时 params = None
→ {"error":{"message":"set_setting requires name","code":"UNSPECIFIED","category":"resolve_api_failed",...}}
```

（本仓库实测过，见 `04-live-probes.md` #13。）

更隐蔽的一种：`{action:"get_setting", name:"colorSpaceTimeline"}` 不会报错，而是返回**全量 约 160 键快照**——因为 `name` 被丢掉后走的是 `GetSetting("")` 默认行为。这种「看起来成功、其实读错了」比报错危险。

## 正确写法（本功能所有调用都按这个形状）

```js
// 读全量项目设置（等价 GetSetting('')）
callTool(ctx, 'project_settings', { action: 'get_setting', params: { name: '' } })

// 读单个键
callTool(ctx, 'project_settings', { action: 'get_setting', params: { name: 'colorScienceMode' } })

// 写单个键
callTool(ctx, 'project_settings', { action: 'set_setting', params: { name: 'colorSpaceOutput', value: 'Rec.709-A' } })

// 读时间线覆盖
callTool(ctx, 'timeline', { action: 'get_setting', params: { name: 'useCustomSettings' } })

// 读渲染设置（21.0.0 上会失败，见 06 文件）
callTool(ctx, 'render', { action: 'get_settings', params: {} })
```

## 对现有 Host 代码的具体影响（不改文件，只给结论）

- `host-impl.mjs opPipelineSnapshot`：
  - `{action:'get_setting', name:''}` → 靠默认值**碰巧**拿到全量快照，行为正确但建议显式写 `params:{name:''}`。
  - `resolve_control {action:'get_version'} / {action:'runtime_mode'}`、`project_manager {action:'get_current'}`：无参数动作，不受影响。
- `host-impl.mjs opPipelineFix`：`{action:'set_setting', ...finding.recommended}` **必然失败**（`finding.recommended` 被丢），必须改成
  `{ action:'set_setting', params: { ...finding.recommended } }`，`finding.recommended` 保持 `{name, value}` 形状。
- `host-base.mjs` 里同类 flat 写法（CDL / transform / crop 等）只要目标是「需要参数」的 action，同样会丢参数；这次不动，但改完 fix 之后建议顺手统一。
