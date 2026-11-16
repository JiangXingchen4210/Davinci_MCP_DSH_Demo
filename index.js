/**
 * Resolve 控制台 — 插件入口（Host 半边）。
 *
 * 这里只做一件事：用带缓存破坏参数的动态 import 载入 ./host-impl.mjs 并交给它注册。
 * 好处是 host-impl.mjs / host-base.mjs 改动后，只要把插件行 disable → enable 一次
 * （插件行的 fiber 重启）就会加载最新代码，不必重启整个 Harness，也不必改包名。
 */

export const name = 'davinci-console'

/** webServer 注册面板路由，tools 让 Host 能调用已配置的 Resolve MCP 工具。 */
export const inject = ['webServer', 'tools', 'connection', 'clientModules']

/**
 * @param ctx - 已注入 webServer 与 tools 的 Host Context。
 */
export async function apply(ctx) {
  const revision = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const impl = await import(`./host-impl.mjs?rev=${revision}`)
  return impl.apply(ctx)
}
