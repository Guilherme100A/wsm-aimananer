// Setup comum do T17: createApp com login de administrador (deps.auth injetável: usuário/senha, segredo,
// TTL, relógio, limite de falhas) sobre banco descartável migrado + Redis, com logs capturados.
// Contrato combinado com o Operário (T17), além da SPEC:
//   deps.auth = { username?, password?, secret?, sessionTtlMs?, now?, loginMaxFailures?, loginWindowMs? }
//   precedência deps.auth > env (ADMIN_USERNAME, ADMIN_PASSWORD, AUTH_SECRET, AUTH_SESSION_TTL_MS) > default admin/nimda
//   warns (nível 40) mencionando 'ADMIN_PASSWORD' / 'AUTH_SECRET' quando usam default/segredo gerado
//   IP do rate limit: TRUST_PROXY=true → valor MAIS À DIREITA de x-forwarded-for (1 salto confiável);
//   desligado → IP da conexão (header ignorado) · audit_logs action 'auth.login' com detail {username, success}
import '../T05/env'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, expect } from 'vitest'
import { createApp } from '@wsm/api'
import { createDb } from '@wsm/db'
import { call, captureLogger, closeQuietly, createRedis, importFrom } from '../helpers/app'
import { tail } from '../helpers/exec'
import { createTempDb, dropTempDb, lit, migrate, sqlOk, type TempDb } from '../helpers/pg'

// Os testes controlam as credenciais: nada herdado do ambiente de quem roda.
for (const k of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'AUTH_SECRET', 'AUTH_SESSION_TTL_MS', 'TRUST_PROXY']) delete process.env[k]
// Padrão da suíte: TRUST_PROXY=true, para isolar o rate limit entre testes por x-forwarded-for (freshIp).
// O comportamento com TRUST_PROXY desligado (padrão do produto) é provado em login.test.ts com servidor HTTP real.
process.env.TRUST_PROXY = 'true'

/** Roda `fn` com as variáveis de ambiente dadas (undefined = remove) e restaura depois. */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Serve o app numa porta local de verdade (@hono/node-server), para a API ver o IP da conexão. */
export async function serveHttp(app: any): Promise<{ url: string; close(): Promise<void> }> {
  const mod = await importFrom<any>('apps/api', '@hono/node-server')
  const serve = mod.serve ?? mod.default?.serve
  let server: any
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: { port: number }) => resolve(info.port))
  })
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      }),
  }
}

/** POST /api/auth/login por HTTP real, com x-forwarded-for opcional. */
export async function loginHttp(base: string, username: string, password: string, xff?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (xff) headers['x-forwarded-for'] = xff
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username, password }) })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body, text }
}

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
export const HOUR = 3_600_000

export interface AuthCtx {
  tempDb: TempDb
  db: any
  redis: any
  apiToken: string
  offset: number
  now(): Date
  advance(ms: number): void
  /** Novo app (processo simulado) com as opções de auth dadas; logs capturados em `logs`. */
  makeApp(auth?: Record<string, unknown>): Promise<{ app: any; logs: string[] }>
}

export function useAuthApp(): AuthCtx {
  const ctx = { offset: 0 } as AuthCtx
  ctx.now = () => new Date(Date.now() + ctx.offset)
  ctx.advance = (ms) => {
    ctx.offset += ms
  }
  beforeAll(async () => {
    ctx.tempDb = createTempDb('wsm_t17')
    const r = migrate(ctx.tempDb)
    if (r.code !== 0) throw new Error(`migrate falhou\n${tail(r)}`)
    ctx.db = await (createDb as any)(ctx.tempDb.url)
    ctx.redis = await createRedis(REDIS_URL)
    ctx.apiToken = `tok_${randomBytes(16).toString('hex')}`
    ctx.makeApp = async (auth) => {
      const { logger, lines } = await captureLogger()
      const deps: Record<string, unknown> = { db: ctx.db, redis: ctx.redis, logger, apiToken: ctx.apiToken }
      if (auth) deps.auth = auth
      const app = await (createApp as any)(deps)
      return { app, logs: lines }
    }
  })
  afterAll(async () => {
    await closeQuietly(ctx.redis)
    await closeQuietly(ctx.db)
    dropTempDb(ctx.tempDb)
  })
  return ctx
}

let ipSeq = 0
/** IP de documentação (TEST-NET-2) único por chamada, para isolar o rate limit entre testes. */
export const freshIp = () => `198.51.100.${(++ipSeq % 250) + 1}`

export function login(app: any, username: string, password: string, ip = freshIp()) {
  return call(app, 'POST', '/api/auth/login', { body: { username, password }, headers: { 'x-forwarded-for': ip } })
}

/** Login que precisa dar certo; devolve o token. */
export async function loginOk(app: any, username = 'admin', password = 'nimda', ip?: string): Promise<string> {
  const res = await login(app, username, password, ip)
  expect(res.status, `POST /api/auth/login → ${res.text}`).toBe(200)
  expect(typeof res.body?.token).toBe('string')
  return res.body.token as string
}

export const authed = (app: any, token: string, method: string, path: string, body?: unknown) => call(app, method, path, { token, body })

export function auditRows(ctx: AuthCtx, action: string): Array<Record<string, any>> {
  return sqlOk(ctx.tempDb.url, `SELECT row_to_json(a)::text FROM audit_logs a WHERE action = ${lit(action)} ORDER BY id;`).map((r) => JSON.parse(r[0]!))
}

export const warnLines = (logs: string[], needle: string) =>
  logs.filter((l) => {
    try {
      const o = JSON.parse(l)
      return o.level === 40 && JSON.stringify(o).includes(needle)
    } catch {
      return false
    }
  })

/** Adultera um caractere do meio do token (mantendo o alfabeto base64url/hex). */
export function tamper(token: string): string {
  const i = Math.floor(token.length / 2)
  const c = token[i]!
  const alt = c === 'A' ? 'B' : c === 'a' ? 'b' : c === '0' ? '1' : 'A'
  return token.slice(0, i) + alt + token.slice(i + 1)
}
