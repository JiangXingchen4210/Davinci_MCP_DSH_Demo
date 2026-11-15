/**
 * Host 集成回归：从 index.js 的 apply(ctx) 取 davinci_panel 工具，经 tool.execute 走真实 op 代码，
 * 用 fake ctx.tools.execute 记录 MCP 调用并维护节点开关 / 队列状态。
 * 断言：调用次数、返回对象、最终状态（不只是 planner 计划）。
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { apply } from '../index.js'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise((res) => { resolve = res }); return { promise, resolve } }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function makeFake(state) {
  const calls = []
  const definitions = ['mcp__resolve__timeline', 'mcp__resolve__timeline_item', 'mcp__resolve__timeline_item_color', 'mcp__resolve__timeline_markers', 'mcp__resolve__graph', 'mcp__resolve__project_settings', 'mcp__resolve__project_manager', 'mcp__resolve__media_pool_item', 'mcp__resolve__render', 'mcp__resolve__resolve_control']
    .map((name) => ({ name }))
  const ctx = {
    effect(fn) { fn() },
    webServer: { register() { return () => {} } },
    tools: {
      definitions: () => definitions,
      register(tool) { state.tool = tool },
      async execute(batch) {
        const call = batch.calls[0]
        const payload = JSON.parse(call.arguments)
        calls.push({ name: call.name, action: payload.action, params: payload.params, calls: batch.calls.length })
        const value = await dispatch(call.name, payload, state)
        return { results: [{ result: { isError: false, value: { structuredContent: { result: value } } } }] }
      },
    },
  }
  return { ctx, calls }
}

async function dispatch(name, payload, state) {
  const action = payload.action
  const params = payload.params ?? {}
  if (name.endsWith('__project_manager') && action === 'get_current') return { name: 'fake-project', id: 'proj-1' }
  if (name.endsWith('__timeline') && action === 'get_current') return { name: 'fake-timeline', id: state.timelineId ?? 'tl-1', start_frame: 0 }
  if (name.endsWith('__timeline') && action === 'get_track_count') {
    if (state.trackCountError) throw new Error('track count boom')
    const value = { count: state.trackCount ?? 5 }
    return value
  }
  if (name.endsWith('__timeline') && action === 'get_items') {
    const idx = Number(params.track_index)
    if (state.trackItemsError?.includes(idx)) throw new Error(`V${idx} boom`)
    const items = (state.tracks?.[idx] ?? []).map((entry) => (typeof entry === 'string'
      ? { id: entry, kind: 'clip', start: 0 }
      : { id: entry.id, kind: 'clip', start: Number(entry.start) || 0 }))
    return { items }
  }
  if (name.endsWith('__timeline_item_color') && action === 'probe_node_graph') {
    if (state.probeError) throw new Error('probe boom')
    return { nodes: state.nodes.map((node) => ({ node_index: node.index, label: node.label, enabled: node.enabled })) }
  }
  if (name.endsWith('__graph') && action === 'set_node_enabled') {
    const index = Number(params.node_index)
    const enabled = Boolean(params.enabled)
    state.setNodeCalls.push({ index, enabled })
    const rule = state.setNodeResponse?.(index, enabled)
    if (rule === 'throw') throw new Error('set node boom')
    if (state.captureAtWrite) state.capturedStates.push({ index, enabled, at: 'write' })
    const node = state.nodes.find((item) => item.index === index)
    if (rule === true || rule === false) { if (rule) node.enabled = enabled; return rule }
    if (rule && typeof rule === 'object') { if (rule.success) node.enabled = enabled; return rule }
    node.enabled = enabled
    return { success: true }
  }
  if (name.endsWith('__project_settings') && action === 'export_frame_as_still') {
    state.captureArrived?.resolve?.()
    if (state.captureGate) await state.captureGate
    if (state.captureError) throw new Error('capture boom')
    await fs.writeFile(params.path, PNG)
    state.captures.push({ timecode: state.playhead, nodes: state.nodes.map((node) => ({ index: node.index, enabled: node.enabled })) })
    state.capturedStates.push({ at: 'capture', timecode: state.playhead, nodes: state.nodes.map((node) => ({ index: node.index, enabled: node.enabled })) })
    return { success: true }
  }
  if (name.endsWith('__timeline_markers') && action === 'set_current_timecode') {
    state.playhead = payload.params?.timecode ?? null
    state.seeks.push(state.playhead)
    return { success: true }
  }
  if (name.endsWith('__timeline_item') && action === 'get_media_pool_item') return { id: 'clip-1' }
  if (name.endsWith('__timeline_item') && ['get_source_start_frame', 'get_source_end_frame'].includes(action)) return { frame: 0 }
  if (name.endsWith('__media_pool_item') && action === 'get_clip_property') return { properties: { 'File Path': '/tmp/fake.mov' } }
  if (name.endsWith('__timeline_item') && action === 'get_source_start_frame') return { frame: 0 }
  return {}
}

async function setup(state) {
  state.setNodeCalls = []
  state.capturedStates = []
  state.captures = []
  state.seeks = []
  state.playhead = null
  const { ctx, calls } = makeFake(state)
  await apply(ctx)
  assert(Boolean(state.tool), '插件应注册 davinci_panel 工具')
  return { calls, tool: state.tool }
}

const runPreview = (tool, args) => tool.execute({ op: 'preview.live', args }, { signal: undefined })

async function testRestoreFalse() {
  const state = { nodes: [{ index: 10, label: 'L3 · 10 x', enabled: true }], tracks: { 1: ['clip'] } }
  state.setNodeResponse = (index, enabled) => (enabled === true ? false : { success: true }) // 恢复（true）返回布尔 false
  const { tool, calls } = await setup(state)
  const result = await runPreview(tool, { itemId: 'clip', stage: 'L1', width: 64 })
  assert(result?.ok === false, `恢复返回布尔 false 时结果必须 ok:false，实际 ${JSON.stringify({ ok: result?.ok })}`)
  assert(result?.restore?.restored === false && result.restore.failed.includes(10), '恢复失败必须带节点编号 10')
  assert(state.nodes[0].enabled === false, 'MCP 返回 false 时节点仍应保持关闭（模拟真实行为）')
  assert(calls.filter((c) => c.action === 'set_node_enabled').length === 2, '应只发生 2 次 set_node_enabled（切换+恢复）')
}

async function testStageAndRestoreFail() {
  const state = { nodes: [{ index: 10, label: 'L3 · 10 x', enabled: true }], tracks: { 1: ['clip'] } }
  state.setNodeResponse = () => ({ success: false })
  const { tool } = await setup(state)
  const result = await runPreview(tool, { itemId: 'clip', stage: 'L1', width: 64 })
  assert(result?.ok === false, '切换与恢复都失败时必须 ok:false')
  assert(result?.stageFailed?.includes(10), '必须报告切换失败的节点 10')
  assert(result?.restore?.restored === false && result.restore.failed.includes(10), '必须报告恢复失败的节点 10')
}

async function testOverlappingPreviews() {
  const state = { nodes: [{ index: 10, label: 'L3 · 10 x', enabled: true }], tracks: { 1: ['clip'] } }
  let releaseA
  state.captureGate = new Promise((resolve) => { releaseA = resolve })
  state.captureArrived = deferred()
  const { tool } = await setup(state)
  const a = runPreview(tool, { itemId: 'clip', stage: 'L1', width: 64 })
  // 等 A 明确到达抓帧（不靠 tick 次数猜测）
  await state.captureArrived.promise
  const b = runPreview(tool, { itemId: 'clip', stage: 'L3', width: 64 })
  await tick()
  // A 已进入抓帧；B 必须被共享播放头锁挡住，尚未写节点
  assert(state.setNodeCalls.length === 1, `B 不应在 A 完成前写节点，实际写入 ${state.setNodeCalls.length} 次`)
  state.captureGate = null
  releaseA()
  const [ra, rb] = await Promise.all([a, b])
  assert(ra?.ok === true, `A 应成功，实际 ${JSON.stringify(ra?.error)}`)
  assert(rb?.ok === true, `B 应成功，实际 ${JSON.stringify(rb?.error)}`)
  assert(state.nodes[0].enabled === true, `最终节点必须仍为开启，实际 ${state.nodes[0].enabled}`)
  assert(state.setNodeCalls.length === 4, `应有 4 次写入（A 切+还原，B 切+还原），实际 ${state.setNodeCalls.length}`)
  const captures = state.captures
  assert(captures.length === 2, '两次抓帧都应发生')
  assert(captures[1].nodes.find((n) => n.index === 10)?.enabled === true, 'B 抓帧时节点 10 应为开启（L3 stage）')
}

async function testCrossClipPreviewTimecode() {
  // A 在 00:00:00:00，B 在 00:00:02:00（24fps，start=48）；共享播放头必须串行
  const state = {
    nodes: [{ index: 10, label: 'L3 · 10 x', enabled: true }],
    tracks: { 1: [{ id: 'clipA', start: 0 }, { id: 'clipB', start: 48 }] },
  }
  let releaseA
  state.captureGate = new Promise((resolve) => { releaseA = resolve })
  state.captureArrived = deferred()
  const { tool } = await setup(state)
  const a = runPreview(tool, { itemId: 'clipA', stage: 'L1', width: 64 })
  await state.captureArrived.promise
  // A 暂停在抓帧前；此时发起 B（current 也会移动播放头）
  const b = runPreview(tool, { itemId: 'clipB', stage: 'current', width: 64 })
  await tick()
  assert(state.seeks.length === 1, `B 不应在 A 完成前移动播放头，实际 seek ${state.seeks.length} 次`)
  state.captureGate = null
  releaseA()
  const [ra, rb] = await Promise.all([a, b])
  assert(ra?.ok === true && rb?.ok === true, `两次预览都应成功：${ra?.error} / ${rb?.error}`)
  assert(state.captures.length === 2, `应有两次抓帧，实际 ${state.captures.length}`)
  assert(state.captures[0].timecode === '00:00:00:00', `A 抓帧时间码应为 00:00:00:00，实际 ${state.captures[0].timecode}`)
  assert(state.captures[1].timecode === '00:00:02:00', `B 抓帧时间码应为 00:00:02:00，实际 ${state.captures[1].timecode}`)
  assert(ra.timecode === '00:00:00:00' && rb.timecode === '00:00:02:00', `返回结果时间码不符：${ra.timecode} / ${rb.timecode}`)
  assert(state.nodes[0].enabled === true, `最终节点必须仍为开启，实际 ${state.nodes[0].enabled}`)
}

async function testProbeFailure() {
  const state = { nodes: [{ index: 10, label: 'L3 · 10 x', enabled: true }], tracks: { 1: ['clip'] }, probeError: true }
  const { tool, calls } = await setup(state)
  const result = await runPreview(tool, { itemId: 'clip', stage: 'L1', width: 64 })
  assert(result?.ok === false && result?.reason === 'probe_failed', `读图失败必须返回 probe_failed，实际 ${JSON.stringify(result)}`)
  assert(calls.filter((c) => c.action === 'set_node_enabled').length === 0, '读图失败不能写节点')
}

async function testCompareFailure() {
  const state = { nodes: [{ index: 10, label: 'L3 · 10 x', enabled: null }], tracks: { 1: ['clip'] } }
  const { tool } = await setup(state)
  const result = await tool.execute({ op: 'preview.compare', args: { itemId: 'clip', left: 'L1', right: 'L2', width: 64 } }, { signal: undefined })
  assert(result?.ok === false && result?.failedSide === 'left', `分屏左失败必须返回 ok:false/failedSide，实际 ${JSON.stringify(result)}`)
  assert(!result?.right, '左失败时不应继续右预览')
}

async function testTrackReadErrors() {
  // 轨数读取失败
  const s1 = { nodes: [], tracks: {}, trackCountError: true }
  const { tool: tool1 } = await setup(s1)
  let err1 = null
  try { await runPreview(tool1, { itemId: 'clip', stage: 'current', width: 64 }) } catch (error) { err1 = error }
  assert(err1 && /读取视频轨数量失败/.test(err1.message), `轨数失败应保留原始原因，实际 ${err1?.message}`)

  // 单轨读取失败（V4）
  const s2 = { nodes: [], tracks: { 1: ['clip'], 2: [], 3: [], 4: [], 5: [] }, trackCount: 5, trackItemsError: [4] }
  const { tool: tool2 } = await setup(s2)
  let err2 = null
  try { await runPreview(tool2, { itemId: 'missing', stage: 'current', width: 64 }) } catch (error) { err2 = error }
  assert(err2 && /读取 V4 失败/.test(err2.message), `单轨失败应保留轨道号与原因，实际 ${err2?.message}`)

  // 真实的空轨 + 扫描后确实不存在
  const s3 = { nodes: [], tracks: { 1: [], 2: [], 3: [], 4: [], 5: [] }, trackCount: 5 }
  const { tool: tool3 } = await setup(s3)
  let err3 = null
  try { await runPreview(tool3, { itemId: 'missing', stage: 'current', width: 64 }) } catch (error) { err3 = error }
  assert(err3 && err3.message.includes('missing'), `不存在时应包含目标 ID，实际 ${err3?.message}`)

  // 目标在 V5 正常定位
  const s4 = { nodes: [{ index: 10, label: 'L3 · 10 x', enabled: true }], tracks: { 1: [], 2: [], 3: [], 4: [], 5: ['clip'] }, trackCount: 5 }
  const { tool: tool4 } = await setup(s4)
  const ok = await runPreview(tool4, { itemId: 'clip', stage: 'current', width: 64 })
  assert(ok?.ok === true, `V5 上的目标应能预览，实际 ${JSON.stringify(ok)}`)
}

await testRestoreFalse()
await testStageAndRestoreFail()
await testOverlappingPreviews()
await testCrossClipPreviewTimecode()
await testProbeFailure()
await testCompareFailure()
await testTrackReadErrors()

if (failures) { console.error(`FAIL host_integration.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS host_integration.test.mjs — 恢复失败/false 返回值、重叠预览锁、读图失败、分屏失败、轨道读取错误均按预期')
