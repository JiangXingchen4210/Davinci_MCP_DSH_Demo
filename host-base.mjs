/**
 * DaVinci 控制面板 — Host 半边。
 *
 * 这半边只做两件事：
 *  1. 注册 /davinci-panel/action 这条同源 HTTP 路由，把面板按钮翻译成已经配置好的
 *     Resolve MCP 工具调用（工具名形如 mcp__resolve__timeline_item_color）。
 *  2. 注册 davinci_panel 工具，让模型走同一条 runOp 分派表操作同一套动作，
 *     UI 与工具共享一份实现（不存在两套逻辑）。
 *
 * 约定：不 import 任何 Harness 包。工具按后缀发现，因此 serverName 改成别的名字
 * 也能工作；找不到就以结构化错误返回，面板原样显示。
 */


const ROUTE_PATH = '/davinci-panel/action'
const MAX_BODY_BYTES = 64 * 1024
const CALL_TIMEOUT_MS = 180_000

let callSequence = 0

/** 只接受本机回环连接；跨站页面无法通过同源预检，也不会带 x-davinci-panel 头。 */
function isLoopback(request) {
  const address = request.socket?.remoteAddress ?? ''
  return (
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 在 ctx.tools 里按后缀发现一个 MCP 工具，优先 serverName 为 resolve 的那个，
 * 避免 resolve_advanced 里同名工具被误选。
 */
function resolveToolName(ctx, base) {
  let fallback = ''
  for (const definition of ctx.tools.definitions()) {
    const toolName = definition.name
    if (!toolName.endsWith(`__${base}`)) continue
    if (toolName.startsWith('mcp__resolve__')) return toolName
    if (!fallback) fallback = toolName
  }
  return fallback
}

/** 取工具返回值里的纯文本，用于把结构化失败翻译成人话。 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * MCP 工具的执行结果保留的是原始 CallToolResult（content + structuredContent），
 * 这里取服务器给的规范 JSON：优先 structuredContent.result，其次解析文本块。
 */
function unwrapMcpValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const structured = value.structuredContent
  if (structured && typeof structured === 'object') {
    return Object.hasOwn(structured, 'result') ? structured.result : structured
  }
  if (Array.isArray(value.content)) {
    const text = textOfContent(value.content)
    if (!text) return value
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return value
}

/**
 * 调用一个 MCP 工具，返回它的规范 JSON 值；MCP 侧报错则抛出带原文的 Error。
 *
 * 参数约定（实测踩过的坑，别退回扁平写法）：
 * - 两个 MCP 服务器的工具签名都是 `(action, <容器>)`，容器里的键才是业务参数；
 *   顶层多出来的键会被 pydantic 静默丢弃，`set_setting` 这类会直接报缺少 name。
 * - `mcp__resolve__*` 的容器叫 `params`；`mcp__resolve_advanced__*` 的容器叫 `args`。
 * 调用方可以继续写 `{ action, 扁平参数 }`，这里自动折进容器。
 */
async function callTool(ctx, base, args, signal) {
  const toolName = resolveToolName(ctx, base)
  if (!toolName) {
    throw new Error(
      `没有找到 MCP 工具 “${base}”。请确认当前 Profile 已启用 davinci-resolve MCP（mcp__resolve__*）。`,
    )
  }
  let payload = args ?? {}
  if (payload && typeof payload.action === 'string') {
    const { action, params, args: advancedArgs, ...rest } = payload
    const container = toolName.includes('resolve_advanced') ? advancedArgs : params
    const flat = Object.keys(rest).length > 0 ? rest : undefined
    const body = container ?? flat
    payload = body === undefined ? { action } : { action, [toolName.includes('resolve_advanced') ? 'args' : 'params']: body }
  }
  const batch = await ctx.tools.execute({
    calls: [
      {
        type: 'tool-call',
        id: `davinci_panel_${++callSequence}`,
        name: toolName,
        arguments: JSON.stringify(payload),
      },
    ],
    signal,
  })
  const outcome = batch.results[0]
  if (!outcome) throw new Error(`MCP 工具 ${base} 没有返回结果`)
  const result = outcome.result
  if (result.isError) {
    const detail = textOfContent(result.content)
    // MCP 侧报错的正文常是 "Error: {…json 信封…}"；把信封解析出来挂到 error.mcpValue，
    // 破坏性动作的 confirm_token 就在里面（safe_apply_drx / reset_all_grades 都靠它）。
    let envelope = null
    const jsonText = detail.replace(/^Error:\s*/i, '').trim()
    if (jsonText.startsWith('{')) {
      try {
        envelope = JSON.parse(jsonText)
      } catch {
        envelope = null
      }
    }
    const message = envelope?.error?.message ?? detail
    const error = new Error(message || `${base} 调用失败`)
    if (envelope) error.mcpValue = envelope
    throw error
  }
  // Resolve MCP 把业务失败也当作正常返回值：{"error": {message, code, ...}}。
  // 这里统一转成异常，并保留原始值，让调用方能看到 confirm_token 之类的附加字段。
  const value = unwrapMcpValue(result.value)
  if (value && typeof value === 'object' && value.error && typeof value.error.message === 'string') {
    const error = new Error(value.error.message)
    error.mcpValue = value
    throw error
  }
  return value
}

/** 吞掉单个子调用的失败，让面板能显示“哪些读到了、哪些没读到”。 */
async function settle(work) {
  try {
    return { ok: true, value: await work }
  } catch (error) {
    // 保留 MCP 的结构化返回值（如破坏性动作的 confirm_token），调用方要用它做二次确认。
    return { ok: false, error: messageOf(error), value: error?.mcpValue ?? null }
  }
}

function scopeOf(itemId) {
  return itemId ? { timeline_item_id: itemId } : {}
}

// ---------------------------------------------------------------------------
// 调色预设：全部折算成 ASC CDL（Offset=lift、Power=gamma、Slope=gain）。
// 一个预设 = 一次 safe_set_cdl，作用在 1 号节点上。
// ---------------------------------------------------------------------------

const IDENTITY_CDL = {
  Slope: [1, 1, 1],
  Offset: [0, 0, 0],
  Power: [1, 1, 1],
  Saturation: 1,
}

const LOOKS = {
  neutral: { label: '还原中性', cdl: IDENTITY_CDL },
  warm: {
    label: '暖阳',
    cdl: {
      Slope: [1.06, 1.0, 0.94],
      Offset: [0.012, 0.004, 0.0],
      Power: [1.02, 1.0, 0.98],
      Saturation: 1.06,
    },
  },
  cool: {
    label: '冷调',
    cdl: {
      Slope: [0.95, 1.0, 1.08],
      Offset: [-0.006, 0.0, 0.012],
      Power: [0.98, 1.0, 1.02],
      Saturation: 1.02,
    },
  },
  film: {
    label: '胶片',
    cdl: {
      Slope: [1.04, 1.0, 0.96],
      Offset: [0.014, 0.01, 0.008],
      Power: [0.97, 1.0, 1.03],
      Saturation: 0.9,
    },
  },
  contrast: {
    label: '高对比',
    cdl: {
      Slope: [1.14, 1.14, 1.14],
      Offset: [-0.022, -0.022, -0.022],
      Power: [0.96, 0.96, 0.96],
      Saturation: 1.04,
    },
  },
  fade: {
    label: '褪色',
    cdl: {
      Slope: [0.94, 0.94, 0.94],
      Offset: [0.032, 0.03, 0.034],
      Power: [1.06, 1.06, 1.06],
      Saturation: 0.82,
    },
  },
  bw: {
    label: '黑白',
    cdl: {
      Slope: [1.06, 1.06, 1.06],
      Offset: [0, 0, 0],
      Power: [1.0, 1.0, 1.0],
      Saturation: 0,
    },
  },
  teal: {
    label: '青橙',
    cdl: {
      Slope: [1.1, 1.0, 0.92],
      Offset: [-0.01, 0.0, 0.016],
      Power: [1.0, 1.0, 1.0],
      Saturation: 1.12,
    },
  },
}

// ---------------------------------------------------------------------------
// 动作分派表。每个动作对应面板上的一个按钮或一次表单提交。
// ---------------------------------------------------------------------------

/** 读运行状态：不连接 Resolve，因此打开面板不会把 Resolve 拉起来。 */
async function opStatus(ctx, args, signal) {
  const runtime = await callTool(ctx, 'resolve_control', { action: 'runtime_mode' }, signal)
  return { runtime }
}

/** 连接 Resolve（首次会拉起它，MCP 的既定行为）并读版本/项目。 */
async function opConnect(ctx, args, signal) {
  const version = await callTool(ctx, 'resolve_control', { action: 'get_version' }, signal)
  const project = await callTool(ctx, 'project_manager', { action: 'get_current' }, signal)
  const runtime = await callTool(ctx, 'resolve_control', { action: 'runtime_mode' }, signal)
  return { runtime, version, project }
}

async function opTimeline(ctx, args, signal) {
  return callTool(ctx, 'timeline', { action: 'get_current' }, signal)
}

/** 读播放头所在片段，以及它的调色/变换/裁剪/版本/节点/Fusion 现状。 */
async function opItem(ctx, args, signal) {
  const current = await callTool(ctx, 'timeline_markers', { action: 'get_current_video_item' }, signal)
  const itemId = current?.id ?? null
  if (!itemId) return { current, state: null }

  const scope = scopeOf(itemId)
  const transform = await settle(callTool(ctx, 'timeline_item', { action: 'get_transform', ...scope }, signal))
  const crop = await settle(callTool(ctx, 'timeline_item', { action: 'get_crop', ...scope }, signal))
  const composite = await settle(callTool(ctx, 'timeline_item', { action: 'get_composite', ...scope }, signal))
  const version = await settle(
    callTool(ctx, 'timeline_item_color', { action: 'get_current_version', ...scope }, signal),
  )
  const versions = await settle(
    callTool(ctx, 'timeline_item_color', { action: 'get_version_names', ...scope }, signal),
  )
  const nodes = await settle(
    callTool(ctx, 'timeline_item_color', { action: 'probe_node_graph', ...scope }, signal),
  )
  const comps = await settle(
    callTool(ctx, 'timeline_item_fusion', { action: 'get_comp_count', ...scope }, signal),
  )
  const colorGroup = await settle(
    callTool(ctx, 'timeline_item_color', { action: 'get_color_group', ...scope }, signal),
  )

  return {
    current,
    state: { transform, crop, composite, version, versions, nodes, comps, colorGroup },
  }
}

/** 应用一组 ASC CDL。cdl 里只带用户改过的通道也可以。 */
async function opCdl(ctx, args, signal) {
  const cdl = args.cdl && typeof args.cdl === 'object' ? args.cdl : {}
  const payload = {
    NodeIndex: 1,
    Slope: cdl.Slope ?? IDENTITY_CDL.Slope,
    Offset: cdl.Offset ?? IDENTITY_CDL.Offset,
    Power: cdl.Power ?? IDENTITY_CDL.Power,
    Saturation: cdl.Saturation ?? IDENTITY_CDL.Saturation,
  }
  return callTool(
    ctx,
    'timeline_item_color',
    { action: 'safe_set_cdl', cdl: payload, ...scopeOf(args.itemId) },
    signal,
  )
}

/** 应用一个命名 look。 */
async function opLook(ctx, args, signal) {
  const look = LOOKS[args.look]
  if (!look) throw new Error(`未知的调色预设：${String(args.look)}`)
  const result = await callTool(
    ctx,
    'timeline_item_color',
    {
      action: 'safe_set_cdl',
      cdl: { NodeIndex: 1, ...look.cdl },
      ...scopeOf(args.itemId),
    },
    signal,
  )
  return { look: args.look, label: look.label, cdl: look.cdl, result }
}

async function opSaveVersion(ctx, args, signal) {
  const versionName = typeof args.name === 'string' ? args.name.trim() : ''
  if (!versionName) throw new Error('请先填写版本名称')
  return callTool(
    ctx,
    'timeline_item_color',
    { action: 'add_version', name: versionName, ...scopeOf(args.itemId) },
    signal,
  )
}

async function opLoadVersion(ctx, args, signal) {
  const versionName = typeof args.name === 'string' ? args.name.trim() : ''
  if (!versionName) throw new Error('请先选择要载入的版本')
  return callTool(
    ctx,
    'timeline_item_color',
    { action: 'load_version', name: versionName, ...scopeOf(args.itemId) },
    signal,
  )
}

/** 把当前（或指定）片段的调色复制到目标片段。 */
async function opCopyGrade(ctx, args, signal) {
  const fromId = args.fromId
  const toId = args.toId
  if (!fromId || !toId) throw new Error('复制调色需要来源与目标两个片段 id')
  // safe_copy_grade 是破坏性动作（会整体替换目标节点图）：先把 confirm_token 翻成可二次确认的返回值，
  // 面板点确认后带 confirmToken 再调一次。MCP 侧 source 用 item_index/timeline_item_id 定位。
  const params = { action: 'safe_copy_grade', target_ids: [toId], ...scopeOf(fromId) }
  if (args.confirmToken) params.confirm_token = args.confirmToken
  if (args.dryRun) params.dry_run = true
  try {
    return await callTool(ctx, 'timeline_item_color', params, signal)
  } catch (error) {
    const body = error.mcpValue
    if (body && typeof body.confirm_token === 'string') {
      return {
        status: 'confirmation_required',
        confirm_token: body.confirm_token,
        preview: body.preview ?? null,
        ttlSeconds: body.ttl_seconds ?? null,
        warnings: body.known_limitation ? ['会整体替换目标片段的调色，且不自动建版本'] : [],
        remediation: body.error?.remediation ?? null,
      }
    }
    throw error
  }
}

/**
 * 清空调色。MCP 对破坏性动作会先返回 confirm_token，这里把它翻成
 * {status:'confirmation_required', confirm_token} 交给面板做二次确认。
 */
async function opResetGrade(ctx, args, signal) {
  const params = { action: 'reset_all_grades', source: 'item', ...scopeOf(args.itemId) }
  if (args.confirmToken) params.confirm_token = args.confirmToken
  try {
    return await callTool(ctx, 'graph', params, signal)
  } catch (error) {
    const body = error.mcpValue
    if (body && typeof body.confirm_token === 'string') {
      return {
        status: 'confirmation_required',
        confirm_token: body.confirm_token,
        preview: body.preview ?? null,
        ttlSeconds: body.ttl_seconds ?? null,
        remediation: body.error?.remediation ?? null,
      }
    }
    throw error
  }
}

async function opTransform(ctx, args, signal) {
  const props = args.props && typeof args.props === 'object' ? args.props : {}
  return callTool(
    ctx,
    'timeline_item',
    { action: 'set_transform', ...props, ...scopeOf(args.itemId) },
    signal,
  )
}

async function opCrop(ctx, args, signal) {
  const props = args.props && typeof args.props === 'object' ? args.props : {}
  return callTool(ctx, 'timeline_item', { action: 'set_crop', ...props, ...scopeOf(args.itemId) }, signal)
}

async function opComposite(ctx, args, signal) {
  const props = args.props && typeof args.props === 'object' ? args.props : {}
  return callTool(
    ctx,
    'timeline_item',
    { action: 'set_composite', ...props, ...scopeOf(args.itemId) },
    signal,
  )
}

/** 时间线 V1 上的片段清单，给“复制调色”当目标选择器。 */
async function opItems(ctx, args, signal) {
  const list = await callTool(
    ctx,
    'timeline',
    { action: 'get_items', track_type: 'video', track_index: Math.max(1, Number(args.trackIndex) || 1) },
    signal,
  )
  return list
}

/**
 * 给片段加一层 Fusion 模糊。
 * 结构步骤（加 comp / 加 Blur / 接线）必须先成功，参数写入才可能生效；
 * 因此这里逐步执行，并把每一步的结果原样带回面板。
 */
async function opBlur(ctx, args, signal) {
  const itemId = args.itemId
  if (!itemId) throw new Error('请先把播放头停在一个片段上')
  const size = Math.max(0, Number(args.size) || 0)
  const steps = []
  const run = async (label, base, params) => {
    const outcome = await settle(callTool(ctx, base, { ...params, ...scopeOf(itemId) }, signal))
    steps.push({ label, ...outcome })
    if (!outcome.ok) throw new Error(`${label}失败：${outcome.error}`)
    return outcome.value
  }

  const countValue = await run('读取 Fusion comp', 'timeline_item_fusion', { action: 'get_comp_count' })
  const compCount = Number(countValue?.count ?? 0)
  if (compCount < 1) {
    await run('新建 Fusion comp', 'timeline_item_fusion', { action: 'add_comp' })
  }

  const listValue = await run('读取工具列表', 'fusion_comp', { action: 'get_tool_list' })
  const tools = Array.isArray(listValue?.tools) ? listValue.tools : []
  const toolNameOf = (type) => {
    const hit = tools.find((tool) => String(tool.type ?? '').toLowerCase() === type.toLowerCase())
    return hit?.name
  }

  let blurName = toolNameOf('Blur')
  if (!blurName) {
    const added = await run('添加 Blur 工具', 'fusion_comp', { action: 'add_tool', tool_type: 'Blur' })
    blurName = added?.tool_name
  }
  if (!blurName) throw new Error('Blur 工具没有创建成功')

  const mediaIn = toolNameOf('MediaIn')
  const mediaOut = toolNameOf('MediaOut')
  if (mediaIn && mediaOut) {
    await run('接线 MediaIn → Blur', 'fusion_comp', {
      action: 'connect',
      target_tool: blurName,
      input_name: 'Input',
      source_tool: mediaIn,
    })
    await run('接线 Blur → MediaOut', 'fusion_comp', {
      action: 'connect',
      target_tool: mediaOut,
      input_name: 'Input',
      source_tool: blurName,
    })
  } else {
    steps.push({ label: '接线', ok: false, error: 'comp 里没有 MediaIn/MediaOut，模糊不会生效' })
  }

  await run('写入模糊强度', 'fusion_comp', {
    action: 'set_input',
    tool_name: blurName,
    input_name: 'XBlurSize',
    value: size,
  })
  await settle(
    callTool(
      ctx,
      'fusion_comp',
      { action: 'set_input', tool_name: blurName, input_name: 'YBlurSize', value: size, ...scopeOf(itemId) },
      signal,
    ),
  )

  return { tool: blurName, size, steps }
}

const OPS = {
  status: opStatus,
  connect: opConnect,
  timeline: opTimeline,
  item: opItem,
  cdl: opCdl,
  look: opLook,
  'version.save': opSaveVersion,
  'version.load': opLoadVersion,
  'grade.copy': opCopyGrade,
  'grade.reset': opResetGrade,
  transform: opTransform,
  crop: opCrop,
  composite: opComposite,
  items: opItems,
  blur: opBlur,
}

/** UI 与工具共用的执行入口。 */
async function runOp(ctx, op, args, signal) {
  const handler = OPS[op]
  if (typeof handler !== 'function') throw new Error(`未知动作：${String(op)}`)
  return handler(ctx, args ?? {}, signal)
}

export {
  OPS,
  callTool,
  settle,
  scopeOf,
  messageOf,
  sendJson,
  readBody,
  isLoopback,
  LOOKS,
  IDENTITY_CDL,
  ROUTE_PATH,
  MAX_BODY_BYTES,
  CALL_TIMEOUT_MS,
}
