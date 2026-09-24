// Logger do worker (AC-T15-03): JSON, redação profunda de credenciais (T02), `service: worker` e `session_id` do contexto.
import { createServiceLogger, type Logger, type ServiceLoggerOptions } from '@wsm/core'

export function createWorkerLogger(opts: Omit<ServiceLoggerOptions, 'service'> = {}): Logger {
  return createServiceLogger({ service: 'worker', ...opts })
}
