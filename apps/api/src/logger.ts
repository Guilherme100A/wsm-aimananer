// Logger pino da API (JSON). Nunca loga headers de autorização.
import { pino, type DestinationStream, type Logger } from 'pino'

export function createLogger(opts: { level?: string; destination?: DestinationStream } = {}): Logger {
  const options = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: 'api' },
    redact: {
      paths: ['authorization', '*.authorization', 'headers.authorization', 'req.headers.authorization', 'apiToken'],
      censor: '[REDACTED]',
    },
  }
  return opts.destination ? pino(options, opts.destination) : pino(options)
}
