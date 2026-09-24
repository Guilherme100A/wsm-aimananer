// Logger da API (AC-T15-03): JSON, redação profunda de credenciais (T02), `service: api` e `session_id` do contexto.
import type { DestinationStream, Logger } from 'pino'
import { createServiceLogger } from '@wsm/core'

export function createApiLogger(opts: { level?: string; destination?: DestinationStream } = {}): Logger {
  return createServiceLogger({ service: 'api', ...opts })
}
