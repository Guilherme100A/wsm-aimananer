// Configuração do processo worker a partir do ambiente (SPEC 3.5 + integração T16).
import { antibanModeFromEnv, type AntibanMode } from '@wsm/core'
import type { TransportKind } from '../sessions'

export interface WorkerConfig {
  databaseUrl: string
  redisUrl: string
  logLevel: string
  transport: TransportKind
  antibanMode: AntibanMode
  /** Porta do /health e /metrics (healthcheck do compose). */
  healthPort: number
  /** Porta do servidor interno (ponte API ↔ worker e controle do fake). */
  internalPort: number
  internalHost: string
  /** Token Bearer do servidor interno. */
  internalToken: string
  /** Prefixo das chaves do BullMQ/Redis. */
  queuePrefix: string
}

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerConfigError'
  }
}

const port = (raw: string | undefined, fallback: number, name: string) => {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new WorkerConfigError(`invalid ${name}: ${raw}`)
  return n
}

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const missing = ['DATABASE_URL', 'REDIS_URL', 'CREDENTIALS_KEY', 'INTERNAL_TOKEN'].filter((k) => !env[k]?.trim())
  if (missing.length) throw new WorkerConfigError(`missing worker configuration: ${missing.join(', ')}`)
  const transport = (env.WA_TRANSPORT?.trim().toLowerCase() || 'baileys') as TransportKind
  if (transport !== 'baileys' && transport !== 'fake') throw new WorkerConfigError(`invalid WA_TRANSPORT: ${env.WA_TRANSPORT} (use baileys or fake)`)
  return {
    databaseUrl: env.DATABASE_URL!,
    redisUrl: env.REDIS_URL!,
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    transport,
    antibanMode: antibanModeFromEnv(env),
    healthPort: port(env.WORKER_HEALTH_PORT, 9464, 'WORKER_HEALTH_PORT'),
    internalPort: port(env.WORKER_INTERNAL_PORT, 9465, 'WORKER_INTERNAL_PORT'),
    internalHost: env.WORKER_INTERNAL_HOST?.trim() || '0.0.0.0',
    internalToken: env.INTERNAL_TOKEN!,
    queuePrefix: env.QUEUE_PREFIX?.trim() || 'wsm',
  }
}
