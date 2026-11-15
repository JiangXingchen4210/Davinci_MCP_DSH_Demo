/**
 * 面板渲染顺序自检：防止「const 在引用之后声明」造成的 TDZ 崩溃。
 * 这类错误只在浏览器渲染时炸（Cannot access 'x' before initialization），
 * node --check 查不出来，之前就是这样把面板整个搞崩的。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(dir, '..', 'client.js')
const lines = readFileSync(file, 'utf8').split('\n')

let failures = 0
const assert = (condition, message) => { if (!condition) { failures += 1; console.log(`  FAIL ${message}`) } }

// 组件体：从 DavinciPanel 定义开始，到文件末尾的 return 之前
const startIndex = lines.findIndex((line) => /function DavinciPanel|const DavinciPanel\s*=/.test(line))
assert(startIndex >= 0, '找不到 DavinciPanel 定义')

// 收集组件体内 6 空格缩进的 const 声明
const declarations = new Map()
for (let index = startIndex; index < lines.length; index += 1) {
  const match = /^ {6}const ([A-Za-z_$][\w$]*)\s*=/.exec(lines[index])
  if (match) declarations.set(match[1], index)
}

// 对每个声明，检查在它之前是否出现「作为标识符使用」（排除对象键 / 字符串 / 注释）
const problems = []
for (const [name, declIndex] of declarations) {
  const pattern = new RegExp(`(?<!['"\`\\w$.])${name.replace(/\$/g, '\\$')}\\b(?!\\s*:)(?!\\s*=)`, 'g')
  for (let index = startIndex; index < declIndex; index += 1) {
    const line = lines[index]
    if (/^\s*(\/\/|\*)/.test(line)) continue
    pattern.lastIndex = 0
    if (pattern.test(line)) {
      problems.push({ name, declLine: declIndex + 1, useLine: index + 1, snippet: line.trim().slice(0, 90) })
      break
    }
  }
}
for (const problem of problems) {
  console.log(`  TDZ: ${problem.name} 声明在第 ${problem.declLine} 行，但第 ${problem.useLine} 行就用了：${problem.snippet}`)
}
assert(problems.length === 0, `发现 ${problems.length} 处「先使用后声明」`)

// 面板注册的三件事必须在 apply 里（少了任何一个面板就不出现）
const source = lines.join('\n')
assert(/ctx\.slots\.register\(\s*\{\s*\n\s*name: 'main'/.test(source), '缺少 main 面板注册')
assert(/name: 'sidebar\.panellist'/.test(source), '缺少侧边栏注册')
assert(/id: '@local\/davinci-console'/.test(source), '客户端模块 id 必须等于包名')

if (failures > 0) { console.error(`FAIL client_order.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log(`PASS client_order.test.mjs — 组件内 ${declarations.size} 个声明无 TDZ 前向引用；main/侧边栏注册齐全；模块 id 与包名一致`)
