// Setup comum do T01: banco descartável por suíte, migrado pelo contrato `pnpm --filter @wsm/db migrate`.
import { afterAll, beforeAll } from 'vitest'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, migrate, type TempDb } from '../helpers/pg'

export function useMigratedDb(): { readonly db: TempDb } {
  const ctx = {} as { db: TempDb }
  beforeAll(() => {
    ctx.db = createTempDb()
    const r = migrate(ctx.db)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
  })
  afterAll(() => dropTempDb(ctx.db))
  return ctx
}

export const SESSION_STATUSES = ['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED'] as const
export const MESSAGE_STATUSES = ['queued', 'processing', 'sent', 'delivered', 'read', 'failed', 'retrying', 'cancelled'] as const
export const REQUIRED_TABLES = [
  'sessions',
  'session_credentials',
  'proxies',
  'contacts',
  'messages',
  'message_events',
  'health_events',
  'webhooks',
  'audit_logs',
] as const
