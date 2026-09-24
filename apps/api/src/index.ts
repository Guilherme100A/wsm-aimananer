// @wsm/api — API pública do pacote. Importar este módulo NÃO sobe servidor nem lê env;
// o entrypoint HTTP fica em src/server.ts.
import { CORE_PACKAGE } from '@wsm/core'

export const API_PACKAGE = '@wsm/api'
export const dependsOn = [CORE_PACKAGE]

export { createApp, type App } from './app'
export type { AppDeps, AppEnv, AuditInfo, RedisLike } from './types'
export { ApiError, ERROR_STATUS, errorBody, toApiError, zodIssues, type ErrorBody, type ErrorCode, type ValidationIssue } from './errors'
export { validate } from './validate'
export { setAudit, deriveAudit, type AuditEntry } from './middleware/audit'
export { parseBearer, tokenMatches } from './middleware/auth'
export { createLogger } from './logger'
export { loadConfig, type ApiConfig } from './config'
