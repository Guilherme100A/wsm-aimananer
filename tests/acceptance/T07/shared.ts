// Setup comum do T07: createApp(deps) com banco descartável migrado (T01), Redis local e token aleatório.
// Contrato de deps combinado no T03: { db: createDb(url), redis: ioredis, logger: pino, apiToken }.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, expect } from 'vitest'
import { createApp } from '@wsm/api'
import { createDb } from '@wsm/db'
import { captureLogger, closeQuietly, createRedis, type AppResponse } from '../helpers/app'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, lit, migrate, sqlOk, type TempDb } from '../helpers/pg'

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

export interface AppCtx {
  app: any
  token: string
  tempDb: TempDb
  db: any
  redis: any
}

export function useApp(): AppCtx {
  const ctx = {} as AppCtx
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t07')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    const { logger } = await captureLogger()
    ctx.token = `tok_${randomBytes(16).toString('hex')}`
    ctx.app = await (createApp as any)({ db: ctx.db, redis: ctx.redis, logger, apiToken: ctx.token })
  })
  afterAll(async () => {
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}

/** Só o banco (para o handler de opt-out e canMessage). */
export function useDb(): { tempDb: TempDb; db: any } {
  const ctx = {} as { tempDb: TempDb; db: any }
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t07')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
  })
  afterAll(async () => {
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}

/** Telefone fictício E.164 (com +), faixa não atribuída a pessoas reais nos testes. */
export const e164 = () => `+55999${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
export const jidOf = (phone: string) => `${phone.replace(/^\+/, '')}@s.whatsapp.net`

export const iso = (d: Date) => d.toISOString()

/** Envia corpo cru com content-type arbitrário (ex.: CSV). */
export async function callRaw(app: any, method: string, path: string, body: string, contentType: string, token?: string | null): Promise<AppResponse> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': contentType }
  if (token) headers.authorization = `Bearer ${token}`
  const res: Response = await app.request(`http://localhost${path}`, { method, headers, body })
  const text = await res.text()
  let parsed: any = text
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    /* corpo não-JSON */
  }
  return { status: res.status, headers: res.headers, body: parsed, text }
}

export function contactRow(url: string, phone: string): Record<string, any> | undefined {
  const rows = sqlOk(url, `SELECT row_to_json(c) FROM contacts c WHERE phone = ${lit(phone)};`)
  return rows[0] ? JSON.parse(rows[0][0]!) : undefined
}

export function auditRows(url: string): Record<string, any>[] {
  return sqlOk(url, 'SELECT row_to_json(a) FROM audit_logs a ORDER BY id;').map((r) => JSON.parse(r[0]!))
}

/** Lista de contatos da resposta de GET /api/contacts (array ou { items|data|contacts }). */
export function listOf(body: any): any[] {
  if (Array.isArray(body)) return body
  for (const k of ['items', 'data', 'contacts', 'results']) if (Array.isArray(body?.[k])) return body[k]
  throw new Error(`GET /api/contacts não devolveu lista: ${JSON.stringify(body).slice(0, 300)}`)
}

/** Objeto do contato na resposta (direto ou em { contact|data }). */
export function contactOf(body: any): any {
  return body?.contact ?? (body?.data && !Array.isArray(body.data) ? body.data : body)
}

export function expectSameInstant(actual: unknown, expected: string) {
  expect(actual, `timestamp ausente (esperado ${expected})`).toBeTruthy()
  expect(Date.parse(String(actual))).toBe(Date.parse(expected))
}

export async function waitFor<T>(fn: () => T | undefined, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout esperando ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
