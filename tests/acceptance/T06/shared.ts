// Setup comum do T06: app do T03 (banco descartável migrado + Redis) com CREDENTIALS_KEY definida,
// sessões criadas por INSERT direto (as rotas de sessão são do T05) e helpers de leitura crua.
import './env'
import { expect } from 'vitest'
import { call } from '../helpers/app'
import { insertRow, lit, sqlOk } from '../helpers/pg'
import { useApp, type AppCtx } from '../T03/shared'

export { useApp, type AppCtx }

let port = 20000
/** Host/porta fictícios e únicos (nada escuta: o checker real nunca é usado sem probe injetado). */
export const proxyUrl = (opts: { protocol?: string; user?: string | null; pass?: string | null } = {}) => {
  const protocol = opts.protocol ?? 'http'
  const user = opts.user === undefined ? 'wsmuser' : opts.user
  const pass = opts.pass === undefined ? `S3cr3t-${Math.random().toString(36).slice(2, 10)}` : opts.pass
  const auth = user ? `${user}${pass ? `:${pass}` : ''}@` : ''
  const p = ++port
  return { url: `${protocol}://${auth}10.255.0.${p % 250}:${p}`, protocol, user, pass, host: `10.255.0.${p % 250}`, port: p }
}

/** Cria um proxy pela API e devolve o corpo (falha o teste se não for 201). */
export async function createProxy(ctx: AppCtx, url: string, name?: string) {
  const res = await call(ctx.app, 'POST', '/api/proxies', { token: ctx.token, body: name ? { url, name } : { url } })
  expect(res.status, `POST /api/proxies → ${res.text}`).toBe(201)
  expect(res.body?.id, res.text).toBeTruthy()
  return res.body as Record<string, any>
}

/** Sessão criada direto no banco (estado padrão NEW, ou o informado). */
export function createSession(ctx: AppCtx, overrides: Record<string, string | null> = {}) {
  const phone = `+55999${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  return insertRow(ctx.tempDb.url, 'sessions', { phone, ...overrides }).id!
}

export function row(ctx: AppCtx, table: string, id: string): Record<string, any> {
  const r = sqlOk(ctx.tempDb.url, `SELECT row_to_json(t) FROM ${table} t WHERE id = ${lit(id)};`)[0]
  return r ? JSON.parse(r[0]!) : undefined
}

export const sessionRow = (ctx: AppCtx, id: string) => row(ctx, 'sessions', id)
export const proxyRow = (ctx: AppCtx, id: string) => row(ctx, 'proxies', id)

/** Lista de proxies aceitando array ou { items }. */
export const listOf = (body: any): any[] => (Array.isArray(body) ? body : (body?.items ?? body?.data ?? []))

/** Corpo serializado não pode conter a senha nem campos cifrados. */
export function expectNoSecrets(payload: unknown, password: string) {
  const text = JSON.stringify(payload)
  expect(text, 'resposta contém a senha em claro').not.toContain(password)
  expect(text.toLowerCase(), 'resposta expõe campo cifrado').not.toMatch(/ciphertext|auth_?tag|"iv"|password_iv|passwordiv/)
  expect(text.toLowerCase(), 'resposta expõe campo password').not.toMatch(/"password"\s*:/)
}

export const bindProxy = (ctx: AppCtx, proxyId: string, sessionId: string) =>
  call(ctx.app, 'PUT', `/api/proxies/${proxyId}/session`, { token: ctx.token, body: { sessionId } })

/** Carrega os exports de proxy do @wsm/core. */
export async function loadProxyCore() {
  const core: Record<string, any> = await import('@wsm/core')
  for (const name of ['createProxyChecker', 'resolveSessionProxy', 'connectSession'])
    if (typeof core[name] !== 'function') throw new Error(`@wsm/core não exporta ${name}`)
  return core as { createProxyChecker: (o: any) => any; resolveSessionProxy: (db: any, id: string) => Promise<{ proxyUrl?: string }>; connectSession: (o: any) => Promise<unknown>; FakeTransport: new (...a: any[]) => any }
}
