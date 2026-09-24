// T17 — login de administrador do painel. Um AuthService por conjunto de deps (compartilhado entre middleware e rotas).
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { AppDeps, AppEnv } from '../types'
import { AuthService, type AuthOptions } from './service'

export * from './service'
export * from './token'

declare module '../types' {
  interface AppDeps {
    /** Login do painel (T17). Precedência: deps.auth > env (ADMIN_USERNAME, ADMIN_PASSWORD, AUTH_SECRET, AUTH_SESSION_TTL_MS) > default. */
    auth?: AuthOptions
  }
}

const services = new WeakMap<object, AuthService>()

/** AuthService das deps (criado na primeira chamada, no createApp: é quando saem os warns de configuração). */
export function authServiceFor(deps: Pick<AppDeps, 'auth' | 'logger'>): AuthService {
  let s = services.get(deps)
  if (!s) {
    s = new AuthService(deps.auth ?? {}, process.env, deps.logger)
    services.set(deps, s)
  }
  return s
}

/**
 * IP do cliente para o limite de tentativas de login.
 * - `trustProxy = false` (default): só o IP da conexão; `x-forwarded-for` é ignorado, porque o cliente controla
 *   esse header e poderia trocar o valor a cada tentativa para nunca levar 429.
 * - `trustProxy = true` (API atrás de um proxy reverso que SOBRESCREVE o header, ex.: o nginx do dashboard):
 *   o valor mais à direita de `x-forwarded-for`, que é o que o proxy de confiança escreveu.
 * Sem socket (app.request em testes) → 'unknown'.
 */
export function clientIp(c: Context<AppEnv>, trustProxy = false): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
    if (xff) return xff
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    // app.request (testes) não tem socket.
    return 'unknown'
  }
}
