/** 面板路由的 Connection 准入：认证不可用必须拒绝；401/403 原样返回。 */
import { admissionStatus, admissionMessage } from './route_auth.mjs'

let failures = 0
const assert = (cond, msg) => { if (!cond) { failures += 1; console.log(`  FAIL ${msg}`) } }

assert(admissionStatus(undefined, {}) === 503, '没有 connection 服务时必须 503（fail closed）')
assert(admissionStatus({}, {}) === 503, 'connection 缺少 requestRejection 时也必须 503')
assert(admissionStatus({ requestRejection: () => 401 }, {}) === 401, '认证缺失应返回 401')
assert(admissionStatus({ requestRejection: () => 403 }, {}) === 403, '来源不信任应返回 403')
assert(admissionStatus({ requestRejection: () => undefined }, {}) === null, '认证通过应放行')
assert(admissionStatus({ requestRejection: () => 999 }, {}) === null, '未知状态按放行交给后续校验（仅限本服务约定内的 401/403）')
assert(admissionMessage(503).includes('已拒绝'), '503 文案必须说明已拒绝')
assert(admissionMessage(401).includes('未认证'), '401 文案必须说明未认证')

if (failures) { console.error(`FAIL route_auth.test.mjs — ${failures} 项失败`); process.exitCode = 1 }
else console.log('PASS route_auth.test.mjs — 认证不可用 fail closed；401/403 透传；文案明确')
