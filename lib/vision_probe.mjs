/** Vision 可用性探针：测试里遇到系统 Vision 不可用时应 SKIP，而不是把环境问题报成功能失败。 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))

export function visionProbe() {
  const binary = [
    path.join(LIB_DIR, '..', 'bin', 'davinci-vision'),
    path.join(LIB_DIR, '.build', 'vision'),
  ].find((candidate) => { try { return existsSync(candidate) } catch { return false } })
  const fixture = path.join(LIB_DIR, 'fixtures', 'face', 'day-closeup.png')
  if (!binary) return Promise.resolve({ ok: false, error: '找不到 davinci-vision 可执行文件' })
  if (!existsSync(fixture)) return Promise.resolve({ ok: false, error: '找不到人脸样图' })
  return new Promise((resolve) => {
    execFile(binary, ['detect-face', '--in', fixture, '--max', '2'], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return resolve({ ok: false, error: String(stderr || error.message).trim().slice(-300) })
      try {
        const value = JSON.parse(String(stdout))
        resolve(value?.ok === false ? { ok: false, error: value.error ?? 'Vision 返回失败' } : { ok: true, value })
      } catch (cause) {
        resolve({ ok: false, error: `Vision 输出不可解析：${String(cause)}` })
      }
    })
  })
}
