/** 文档导入自检：剧本解析（含场景头/角色台词）、OCR 图片剧本、xlsx 分镜表、csv 场记单。 */
import { parseScriptText, parseShotList, parseContinuity, readDocument, ocrImage } from './docs.mjs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
let failures = 0
const assert = (condition, message) => { if (!condition) { failures += 1; console.log(`  FAIL ${message}`) } }

// 1) 纯文本剧本
const scriptText = `1. 内景 公路 日
两人站在白色 SUV 旁。
男：你好，我是 Deepseek，很高兴认识你。
女：很高兴认识你，你叫什么名字？
2. 外景 公路 夜
男人打开车门，坐进驾驶位。`
const script = parseScriptText(scriptText)
console.log('script:', script.sceneCount, 'scenes |', script.dialogueCount, 'dialogue lines')
assert(script.sceneCount === 2, `应解析出 2 场，实际 ${script.sceneCount}`)
assert(script.dialogueCount === 2, `应解析出 2 句台词，实际 ${script.dialogueCount}`)
assert(script.scenes[0].interior === true, '第 1 场应识别为内景')
assert(script.scenes[1].timeOfDay === '夜', `第 2 场时间应为夜，实际 ${script.scenes[1].timeOfDay}`)
assert(script.scenes[0].dialogue[0].speaker === '男', `说话人应为男，实际 ${script.scenes[0].dialogue[0].speaker}`)
assert(script.scenes[0].dialogue[0].text.includes('Deepseek'), '台词文本应完整')

// 2) OCR 图片剧本
const ocr = await ocrImage(path.join(LIB_DIR, 'fixtures', 'docs', 'script-photo.png'))
console.log('ocr lines:', ocr.lineCount, '| first:', (ocr.text.split('\n')[0] ?? '').slice(0, 30))
assert(ocr.lineCount >= 4, `OCR 应识别出多行，实际 ${ocr.lineCount}`)
assert(/内景|公路/.test(ocr.text), 'OCR 文本应包含场景关键词')
const scriptFromImage = parseScriptText(ocr.text)
assert(scriptFromImage.dialogueCount >= 1, 'OCR 文本应能解析出台词')

// 3) xlsx 分镜表
const shotList = await readDocument({ kind: 'shotlist', path: path.join(LIB_DIR, 'fixtures', 'docs', 'shotlist.xlsx') })
console.log('shotlist:', shotList.shots.length, 'shots | first:', JSON.stringify(shotList.shots[0]))
assert(shotList.shots.length === 3, `分镜表应解析出 3 行，实际 ${shotList.shots.length}`)
assert(shotList.shots[0].size === '全景', `景别列应解析，实际 ${shotList.shots[0].size}`)
assert(shotList.shots[1].dialogue.includes('Deepseek'), '台词列应解析')

// 4) csv 场记单
const csv = `镜号,状态,服装,道具,备注
1,OK,黑色大衣,车钥匙,
2,NG,黑色大衣,车钥匙,焦点虚
3,OK,黑色大衣,纸盒,`
const continuity = parseContinuity(csv.split('\n').map((line) => line.split(',')))
console.log('continuity:', continuity.entries.length, 'entries | ok', continuity.okCount, 'ng', continuity.ngCount)
assert(continuity.entries.length === 3, `场记单应解析 3 行，实际 ${continuity.entries.length}`)
assert(continuity.okCount === 2 && continuity.ngCount === 1, `OK/NG 计数应为 2/1，实际 ${continuity.okCount}/${continuity.ngCount}`)
assert(continuity.entries[0].costume === '黑色大衣', '服装列应解析')

if (failures > 0) { console.error(`FAIL docs.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log(`PASS docs.test.mjs — 剧本 2 场/2 句、OCR ${ocr.lineCount} 行、分镜 ${shotList.shots.length} 行、场记 OK/NG 计数正确`)
