/**
 * 交付流程的纯规则（可单测）：删除结果解析、设置值比较、规格核对、回滚结果汇总。
 * 这些规则在 host 的交付链路里被复用，避免三处各写一套比较/提示。
 */

/** 解析 delete_job 的返回值：支持布尔值与 {success:boolean}。 */
export function parseDeleteResult(value) {
  if (typeof value === 'boolean') return { ok: value, raw: value }
  if (value && typeof value === 'object' && typeof value.success === 'boolean') return { ok: value.success, raw: value }
  return { ok: false, raw: value ?? null, reason: '删除结果无法判定' }
}

const FPS_FIELDS = new Set(['timelineFrameRate', 'fps'])
const INT_FIELDS = new Set(['timelineResolutionWidth', 'timelineResolutionHeight', 'width', 'height'])

const asValidNumber = (value) => {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!text) return null
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}
const asValidInt = (value) => {
  const num = asValidNumber(value)
  return num !== null && Number.isInteger(num) ? num : null
}

/** 同一字段的比较规则：帧率按数值+容差，宽高按整数，其它按去空白字符串。 */
export function valuesEqual(field, a, b) {
  if (FPS_FIELDS.has(field)) {
    const na = asValidNumber(a)
    const nb = asValidNumber(b)
    if (na === null || nb === null || na <= 0 || nb <= 0) return false
    return Math.abs(na - nb) <= 0.001
  }
  if (INT_FIELDS.has(field)) {
    const ia = asValidInt(a)
    const ib = asValidInt(b)
    if (ia === null || ib === null) return false
    return ia === ib
  }
  const sa = a === null || a === undefined ? '' : String(a).trim()
  const sb = b === null || b === undefined ? '' : String(b).trim()
  if (!sa || !sb) return false
  return sa === sb
}

const codecKey = (value) => {
  const n = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (n === 'HEVC' || n === 'H265') return 'H265'
  return n
}

/** 渲染任务读回是否与批准的方案一致（宽/高/帧率/容器/编码）。 */
export function specMatches(spec, plan) {
  if (!spec || !plan) return false
  return valuesEqual('width', spec.width, plan.width)
    && valuesEqual('height', spec.height, plan.height)
    && valuesEqual('fps', spec.fps, plan.fps)
    && String(spec.format ?? '').toLowerCase() === String(plan.format ?? '').toLowerCase()
    && codecKey(spec.codec) === codecKey(plan.codec)
}

/**
 * 回滚结论：区分「未改动」「已全部恢复」「未完全恢复」，并给出要展示给用户的文案。
 * changed：本次是否真的改过项目设置；details：[{name, expected, actual, ok}]
 */
export function summarizeRestore(changed, details) {
  const list = Array.isArray(details) ? details : []
  if (!changed) return { state: 'unchanged', restored: false, message: '未改动项目设置', details: list }
  const failed = list.filter((item) => !item.ok)
  if (!failed.length) return { state: 'restored', restored: true, message: '项目设置已全部恢复', details: list }
  const parts = failed.map((item) => `${item.name}（原值 ${item.expected ?? '未知'}，读回 ${item.actual ?? '读不到'}）`)
  return { state: 'partial', restored: false, message: `项目设置未完全恢复：${parts.join('；')}`, details: list }
}
