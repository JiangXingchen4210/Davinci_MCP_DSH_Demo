/**
 * Connection 准入：面板的 HTTP 路由必须先通过 DSH Client-Connection 的认证。
 * 认证服务不可用时一律拒绝（fail closed），不能退回「只检查回环地址」。
 */
export function admissionStatus(connection, headers) {
  if (!connection || typeof connection.requestRejection !== 'function') return 503
  const rejection = connection.requestRejection({ headers })
  return rejection === 401 || rejection === 403 ? rejection : null
}

export function admissionMessage(status) {
  if (status === 401) return '未认证：请从 DSH 页面打开本面板（缺少有效的 Connection 凭据）'
  if (status === 403) return '认证被拒绝：请求来源不在受信任的 Host/Origin 内'
  if (status === 503) return '认证服务不可用：已拒绝请求（不会在无认证时执行 Resolve 操作）'
  return '已放行'
}
