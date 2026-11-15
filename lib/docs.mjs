/**
 * 制作文档导入：剧本（台词）、分镜表、场记单。
 * 支持：纯文本 / 图片（Vision OCR）/ Excel（xlsx 用 unzip 解 XML；csv 直接解析）。
 *
 * 为什么需要：光靠 ASR 只能知道「说了什么」，不知道「应该说什么」——
 * 有了剧本可以校正听写、判断哪句台词是故意安排的；有了分镜表能按镜头意图排序；
 * 有了场记单能知道哪条是 OK/NG 条、服装道具是否连戏。
 *
 * 本模块只做「解析 + 归一化」；存储与业务集成在 host。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const VISION_BIN = (() => {
  const packaged = path.join(LIB_DIR, '..', 'bin', 'davinci-vision')
  return existsSync(packaged) ? packaged : path.join(LIB_DIR, '.build', 'vision')
})()

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, encoding: options.encoding ?? 'utf8' }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).trim().slice(-600) || `${command} 失败`))
      resolve(stdout)
    })
  })
}

// ---------------------------------------------------------------------------
// 剧本（纯文本 / OCR 文本）
// ---------------------------------------------------------------------------

const SCENE_HEADING = /^\s*(?:第?\s*(\d+)\s*[场集]?[.、:：]?\s*)?(内景|外景|内|外|INT\.?|EXT\.?)[\s　]*(.*?)(日|夜|晨|黄昏|清晨|白天|晚上|傍晩|傍晚)?\s*$/i
const SPEAKER_LINE = /^\s*([^\s：:]{1,8})\s*[（(][^）)]*[）)]?\s*[：:]\s*(.+)$|^\s*([^\s：:]{1,8})\s*[：:]\s*(.+)$/

/** 解析剧本文本：场景头 → 动作行 / 台词行。 */
export function parseScriptText(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const scenes = []
  let current = null
  let order = 0
  const pushScene = (heading, match) => {
    order += 1
    current = {
      index: order,
      heading: heading.trim(),
      sceneNo: match?.[1] ? Number(match[1]) : order,
      interior: /内|INT/i.test(match?.[2] ?? heading) ? true : /外|EXT/i.test(match?.[2] ?? heading) ? false : null,
      location: (match?.[3] ?? '').trim() || null,
      timeOfDay: match?.[4] ?? null,
      dialogue: [],
      action: [],
      raw: [],
    }
    scenes.push(current)
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const heading = SCENE_HEADING.exec(trimmed)
    if (heading && /内景|外景|内|外|INT|EXT/.test(trimmed) && !SPEAKER_LINE.test(trimmed)) {
      pushScene(trimmed, heading)
      continue
    }
    if (!current) {
      pushScene('（开场前）', null)
    }
    current.raw.push(trimmed)
    const speakerMatch = SPEAKER_LINE.exec(trimmed)
    if (speakerMatch) {
      const speaker = (speakerMatch[1] ?? speakerMatch[3] ?? '').trim()
      const dialogue = (speakerMatch[2] ?? speakerMatch[4] ?? '').trim()
      if (speaker && dialogue) {
        current.dialogue.push({ speaker, text: dialogue })
        continue
      }
    }
    current.action.push(trimmed)
  }
  return {
    kind: 'script',
    sceneCount: scenes.length,
    dialogueCount: scenes.reduce((acc, scene) => acc + scene.dialogue.length, 0),
    scenes,
  }
}

// ---------------------------------------------------------------------------
// 表格（分镜表 / 场记单）：csv 直接解析，xlsx 用 unzip 解 XML
// ---------------------------------------------------------------------------

export function parseCsv(text) {
  const rows = []
  const source = String(text ?? '')
  let row = []
  let cell = ''
  let inQuotes = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (inQuotes) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        inQuotes = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ',' || char === '\t') {
      row.push(cell.trim())
      cell = ''
    } else if (char === '\n') {
      row.push(cell.trim())
      rows.push(row)
      row = []
      cell = ''
    } else if (char !== '\r') {
      cell += char
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell.trim())
    rows.push(row)
  }
  return rows.filter((entry) => entry.some((value) => value !== ''))
}

function decodeXmlText(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

/** 读 xlsx（zip → sharedStrings + sheet1）。只支持 .xlsx；.xls 请另存为 xlsx/csv。 */
export async function readXlsxRows(filePath) {
  if (/\.xls$/i.test(filePath)) throw new Error('.xls（BIFF）不支持，请另存为 .xlsx 或 .csv')
  const sharedXml = await run('unzip', ['-p', filePath, 'xl/sharedStrings.xml']).catch(() => '')
  const shared = []
  for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const texts = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXmlText(item[1]))
    shared.push(texts.join(''))
  }
  const sheetXml = await run('unzip', ['-p', filePath, 'xl/worksheets/sheet1.xml']).catch(() => '')
  if (!sheetXml) throw new Error('读不到 xl/worksheets/sheet1.xml（可能不是标准 xlsx）')
  const rows = []
  for (const rowMatch of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = []
    // xlsx 会省略空单元格——必须按 r="C3" 的列号回填，否则整行会左移
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1]
      const body = cellMatch[2]
      const isShared = /t="s"/.test(attrs)
      const isInline = /t="(inlineStr|str)"/.test(attrs)
      const valueMatch = /<v>([\s\S]*?)<\/v>/.exec(body)
      let value = ''
      if (isShared && valueMatch) value = shared[Number(valueMatch[1])] ?? ''
      else if (isInline) value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((item) => decodeXmlText(item[1])).join('')
      else if (valueMatch) value = decodeXmlText(valueMatch[1])
      const refMatch = /r="([A-Z]+)\d+"/.exec(attrs)
      const colIndex = refMatch ? [...refMatch[1]].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1 : cells.length
      while (cells.length < colIndex) cells.push('')
      cells[colIndex] = String(value).trim()
    }
    rows.push(cells)
  }
  return rows.filter((row) => row.some((cell) => cell !== ''))
}

const HEADER_HINTS = {
  shot: ['镜号', '镜头', '序号', 'shot', 'no'],
  size: ['景别', 'shot size', 'size'],
  content: ['内容', '画面', '描述', '动作', 'content', 'description'],
  dialogue: ['台词', '对白', 'dialogue', 'line'],
  duration: ['时长', 'duration', 'sec'],
  lens: ['焦段', '镜头焦段', 'lens'],
  camera: ['机位', '运镜', 'camera', 'movement'],
  scene: ['场次', '场号', 'scene'],
  verdict: ['ok', 'ng', '状态', '是否', '备注', 'take'],
  costume: ['服装', '造型', 'costume'],
  props: ['道具', 'props'],
}

function findColumn(header, keys) {
  const normalised = header.map((cell) => String(cell ?? '').toLowerCase().replace(/\s/g, ''))
  for (const key of keys) {
    const index = normalised.findIndex((cell) => cell.includes(String(key).toLowerCase().replace(/\s/g, '')))
    if (index >= 0) return index
  }
  return -1
}

/** 从表格行里识别并解析分镜表。 */
export function parseShotList(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { kind: 'shotlist', shots: [], note: '空表' }
  const headerIndex = rows.findIndex((row) => findColumn(row, HEADER_HINTS.shot) >= 0 || findColumn(row, HEADER_HINTS.content) >= 0)
  const header = headerIndex >= 0 ? rows[headerIndex] : rows[0]
  const body = rows.slice(headerIndex >= 0 ? headerIndex + 1 : 1)
  const columns = {
    shot: findColumn(header, HEADER_HINTS.shot),
    size: findColumn(header, HEADER_HINTS.size),
    content: findColumn(header, HEADER_HINTS.content),
    dialogue: findColumn(header, HEADER_HINTS.dialogue),
    duration: findColumn(header, HEADER_HINTS.duration),
    lens: findColumn(header, HEADER_HINTS.lens),
    camera: findColumn(header, HEADER_HINTS.camera),
    scene: findColumn(header, HEADER_HINTS.scene),
  }
  const pick = (row, index) => (index >= 0 ? String(row[index] ?? '').trim() : '')
  const shots = body
    .map((row, order) => ({
      order: order + 1,
      shotNo: pick(row, columns.shot) || String(order + 1),
      scene: pick(row, columns.scene) || null,
      size: pick(row, columns.size) || null,
      content: pick(row, columns.content) || null,
      dialogue: pick(row, columns.dialogue) || null,
      durationText: pick(row, columns.duration) || null,
      lens: pick(row, columns.lens) || null,
      camera: pick(row, columns.camera) || null,
    }))
    .filter((shot) => shot.content || shot.dialogue || shot.shotNo)
  return { kind: 'shotlist', columns: Object.fromEntries(Object.entries(columns).filter(([, value]) => value >= 0)), shots, header: header }
}

/** 从表格行里识别并解析场记单（OK/NG、服装、道具连戏）。 */
export function parseContinuity(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { kind: 'continuity', entries: [], note: '空表' }
  const headerIndex = rows.findIndex((row) => findColumn(row, HEADER_HINTS.verdict) >= 0 || findColumn(row, HEADER_HINTS.costume) >= 0)
  const header = headerIndex >= 0 ? rows[headerIndex] : rows[0]
  const body = rows.slice(headerIndex >= 0 ? headerIndex + 1 : 1)
  const columns = {
    shot: findColumn(header, HEADER_HINTS.shot),
    scene: findColumn(header, HEADER_HINTS.scene),
    verdict: findColumn(header, HEADER_HINTS.verdict),
    costume: findColumn(header, HEADER_HINTS.costume),
    props: findColumn(header, HEADER_HINTS.props),
    note: findColumn(header, ['备注', 'note', 'comments']),
  }
  const pick = (row, index) => (index >= 0 ? String(row[index] ?? '').trim() : '')
  const entries = body
    .map((row) => ({
      shotNo: pick(row, columns.shot) || null,
      scene: pick(row, columns.scene) || null,
      verdict: pick(row, columns.verdict) || null,
      costume: pick(row, columns.costume) || null,
      props: pick(row, columns.props) || null,
      note: pick(row, columns.note) || null,
    }))
    .filter((entry) => entry.verdict || entry.costume || entry.props || entry.note)
  const okCount = entries.filter((entry) => /ok|过|好|可用/i.test(String(entry.verdict))).length
  const ngCount = entries.filter((entry) => /ng|废|重拍|不可用/i.test(String(entry.verdict))).length
  return { kind: 'continuity', entries, okCount, ngCount }
}

// ---------------------------------------------------------------------------
// OCR（图片剧本/分镜表拍照）
// ---------------------------------------------------------------------------

export async function ocrImage(filePath) {
  const stdout = await run(VISION_BIN, ['ocr', '--in', filePath], { timeoutMs: 180_000 })
  const payload = JSON.parse(stdout)
  if (!payload.ok) throw new Error(payload.error ?? 'OCR 失败')
  return { kind: 'ocr', text: payload.text, lines: payload.lines, lineCount: payload.lineCount }
}

/** 统一入口：按类型/扩展名解析文档。 */
export async function readDocument({ kind = 'script', path: filePath = null, text = null } = {}) {
  let sourceText = text
  let sourceKind = text ? 'text' : null
  if (!sourceText && filePath) {
    const ext = path.extname(filePath).toLowerCase()
    if (['.png', '.jpg', '.jpeg', '.heic', '.tiff', '.webp'].includes(ext)) {
      const ocr = await ocrImage(filePath)
      sourceText = ocr.text
      sourceKind = 'image-ocr'
    } else if (ext === '.xlsx' || ext === '.xls') {
      const rows = await readXlsxRows(filePath)
      return { ...(kind === 'shotlist' ? parseShotList(rows) : kind === 'continuity' ? parseContinuity(rows) : { kind, rows }), sourceKind: 'xlsx', rows_count: rows.length, sourcePath: filePath }
    } else if (ext === '.csv' || ext === '.tsv') {
      const raw = await fs.readFile(filePath, 'utf8')
      const rows = parseCsv(raw)
      return { ...(kind === 'shotlist' ? parseShotList(rows) : kind === 'continuity' ? parseContinuity(rows) : { kind, rows }), sourceKind: 'csv', rows_count: rows.length, sourcePath: filePath }
    } else {
      sourceText = await fs.readFile(filePath, 'utf8')
      sourceKind = 'text-file'
    }
  }
  if (!sourceText) throw new Error('没有可解析的内容：请传 text 或 path')
  const parsed = kind === 'shotlist'
    ? parseShotList(parseCsv(sourceText))
    : kind === 'continuity'
      ? parseContinuity(parseCsv(sourceText))
      : parseScriptText(sourceText)
  return { ...parsed, sourceKind, sourcePath: filePath ?? null, rawText: sourceText.slice(0, 20000) }
}
