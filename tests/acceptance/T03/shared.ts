// Setup comum do T03: createApp(deps) com deps reais (Postgres descartável migrado, Redis local,
// logger pino capturado e token aleatório). Contrato combinado com o Orquestrador:
// deps = { db: createDb(url) do @wsm/db, redis: ioredis, logger: pino, apiToken }.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import { createApp } from '@wsm/api'
import { createDb } from '@wsm/db'
import { captureLogger, closeQuietly, createRedis } from '../helpers/app'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, migrate, type TempDb } from '../helpers/pg'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

export interface AppCtx {
  app: any
  token: string
  tempDb: TempDb
  db: any
  redis: any
  logLines: string[]
}

export const newToken = () => `tok_${randomBytes(16).toString('hex')}`

export async function buildApp(deps: { db: any; redis: any; logger: any; apiToken: string }) {
  return await (createApp as any)(deps)
}

/** App com banco descartável migrado (contrato T01) e Redis local. */
export function useApp(): AppCtx {
  const ctx = {} as AppCtx
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t03')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    const { logger, lines } = await captureLogger()
    ctx.logLines = lines
    ctx.token = newToken()
    ctx.app = await buildApp({ db: ctx.db, redis: ctx.redis, logger, apiToken: ctx.token })
  })
  afterAll(async () => {
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}
