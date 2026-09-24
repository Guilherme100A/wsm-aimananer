// Logs estruturados por serviço (T15, AC-T15-03): JSON, redação de credenciais do T02 e `session_id`
// injetado a partir do contexto assíncrono da requisição/tarefa.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DestinationStream, Logger } from 'pino'
import { createLogger } from '../logger'

export interface LogContext {
  session_id?: string
}

const storage = new AsyncLocalStorage<LogContext>()

/** Roda `fn` com o contexto de log (ex.: `{ session_id }`); logs dentro dele herdam os campos. */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn)
}

export function getLogContext(): LogContext | undefined {
  return storage.getStore()
}

/**
 * Mixin do pino: acrescenta o contexto atual (session_id) a cada linha, sem duplicar
 * campos já presentes na linha ou nos bindings do logger.
 */
export function logContextMixin(mergeObject: object, _level: number, logger?: Logger): Record<string, unknown> {
  const ctx = storage.getStore()
  if (!ctx?.session_id) return {}
  if ('session_id' in mergeObject) return {}
  const bound = logger?.bindings?.()
  if (bound && 'session_id' in bound) return {}
  return { session_id: ctx.session_id }
}

export interface ServiceLoggerOptions {
  service: string
  level?: string
  destination?: DestinationStream
}

/** Logger JSON do serviço: redação profunda (T02), `service` na base e `session_id` do contexto. */
export function createServiceLogger(opts: ServiceLoggerOptions): Logger {
  return createLogger({
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: opts.service },
    mixin: logContextMixin as never,
    ...(opts.destination ? { destination: opts.destination } : {}),
  })
}

/** Child logger com `session_id` fixo. */
export function withSessionLogger(logger: Logger, sessionId: string): Logger {
  return logger.child({ session_id: sessionId })
}
